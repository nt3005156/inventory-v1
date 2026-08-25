import mongoose from 'mongoose';

const {Schema, model} = mongoose;
const oid = {type: Schema.Types.ObjectId};

/**
 * P2C — plans, subscriptions and the immutable commercial record.
 *
 * WHY A SEPARATE FILE, AND SEPARATE COLLECTIONS
 * ---------------------------------------------
 * Entitlement data must not live on `Restaurant`. `Restaurant.settings` is
 * Mixed and writable by any tenant holding `settings.manage` (that is
 * `PATCH /api/my/restaurant`), so a plan or feature list stored there would be
 * self-grantable: an owner could give themselves Enterprise by editing their
 * own settings. Commercial state therefore lives in collections no
 * tenant-facing endpoint writes.
 *
 * MONEY IS INTEGER MINOR UNITS
 * ----------------------------
 * The operational schemas use `money = {type: Number}`, which is a float.
 * That is tolerable for a Rs 350 biryani; it is not tolerable for a price
 * list, where `0.1 + 0.2 !== 0.3` becomes a billing dispute. Every amount in
 * this file is an integer count of the currency's minor unit — paisa for NPR —
 * validated as a safe integer. There is no float arithmetic anywhere in the
 * billing path.
 *
 * UNLIMITED IS `null`, NOT A MAGIC NUMBER
 * ---------------------------------------
 * `-1` and `999999` both participate in arithmetic and comparisons, so a
 * forgotten guard silently turns "unlimited" into "negative" or into a real
 * ceiling somebody eventually hits. `null` cannot be compared by accident:
 * `5 < null` is false, `5 > null` is true, and both are obviously wrong at a
 * glance, which forces the explicit `isUnlimited()` check the resolver uses.
 */

// ── plans ────────────────────────────────────────────────────────────────────

/**
 * The limit keys a plan may carry.
 *
 * Declared as a closed list so a typo in a seed file or an admin payload is a
 * validation error rather than a limit that silently never applies — a
 * misspelled `maxBranchs` would otherwise resolve to "no limit configured",
 * which fails OPEN. That is the failure mode this list exists to prevent.
 *
 * The commercial VALUES are not here. They live in the Plan documents, seeded
 * by `scripts/seed-plans.js` and editable through the platform API, because
 * nobody has given us real commercial numbers and inventing them in source
 * would bake a guess into the codebase.
 */
export const LIMIT_KEYS = Object.freeze([
  'maxBranches',
  'maxUsers',
  'maxManagers',
  'maxStaff',
  'maxRiders',
  'maxMenuItems',
  'maxCustomers',
  'maxTables',
  'maxStations',
  'maxMonthlyOrders',
  'maxMonthlyOnlineOrders'
]);

/**
 * Feature entitlement keys.
 *
 * Named for capabilities the product actually has today, so an entitlement
 * always corresponds to something real. `advancedReports`, `loyalty` and
 * `apiAccess` describe surfaces that exist in part; they are declared here so
 * plans can be modelled, and the enforcement points are added as those
 * surfaces are gated in later phases.
 */
export const FEATURE_KEYS = Object.freeze([
  'pos',
  'inventory',
  'purchasing',
  'kds',
  'tables',
  'delivery',
  'onlineOrdering',
  'reservations',
  'advancedReports',
  'loyalty',
  'supplierPerformance',
  'reorderAutomation',
  'multiBranch',
  'advancedAccounting',
  'apiAccess',
  // P2D — branding tiers. Enforced by services/branding.js, which decides
  // which fields are APPLIED; the values themselves are never destroyed on a
  // downgrade, so an upgrade restores them without re-entry.
  'advancedBranding',
  'whiteLabel',
  'customDomain'
]);

/** Integer minor units. Rejects floats, NaN, Infinity and negatives. */
const minorUnits = {
  type: Number,
  default: 0,
  min: 0,
  validate: {
    validator: Number.isSafeInteger,
    message: '{PATH} must be an integer number of minor units (paisa), never a float'
  }
};

/**
 * A limit value: a non-negative safe integer, or `null` meaning unlimited.
 * `undefined`/absent also means "not configured" and is treated as unlimited
 * by the resolver, which is why the resolver logs which keys a plan omits.
 */
function validLimit(value) {
  if (value === null || value === undefined) return true;
  return Number.isSafeInteger(value) && value >= 0;
}

const planSchema = new Schema({
  code: {
    type: String, required: true, trim: true, lowercase: true, maxlength: 40,
    // Stable machine identifier. Application code keys off this, never off
    // `name`, so a marketing rename cannot change behaviour.
    match: [/^[a-z][a-z0-9_-]{1,38}[a-z0-9]$/, 'A plan code must be lowercase letters, numbers, hyphen or underscore']
  },
  name: {type: String, required: true, trim: true, maxlength: 80},
  description: {type: String, trim: true, maxlength: 500},
  active: {type: Boolean, default: true, index: true},
  displayOrder: {type: Number, default: 0},

  // Money — integer minor units only. See the header.
  monthlyPrice: minorUnits,
  annualPrice: minorUnits,
  currency: {type: String, trim: true, uppercase: true, maxlength: 8, default: 'NPR'},

  trialDays: {type: Number, default: 0, min: 0, max: 365, validate: {
    validator: Number.isInteger, message: 'trialDays must be a whole number of days'
  }},

  /**
   * Limits, as a plain sub-document keyed by LIMIT_KEYS.
   *
   * `Mixed` rather than a strict sub-schema because the key set will grow, and
   * a strict schema would silently DROP an unknown key (Mongoose `strict: true`
   * strips unknown paths — the P1 finding). Validated explicitly below instead,
   * which fails loudly rather than quietly discarding a limit.
   */
  limits: {type: Schema.Types.Mixed, default: () => ({})},

  /** Features, keyed by FEATURE_KEYS, boolean. Same reasoning as `limits`. */
  features: {type: Schema.Types.Mixed, default: () => ({})}
}, {timestamps: true, minimize: false});

planSchema.path('limits').validate(function validateLimits(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, limit] of Object.entries(value)) {
    if (!LIMIT_KEYS.includes(key)) {
      this.invalidate('limits', `Unknown limit key: ${key}`);
      return false;
    }
    if (!validLimit(limit)) {
      this.invalidate('limits', `Limit ${key} must be a non-negative integer, or null for unlimited`);
      return false;
    }
  }
  return true;
});

planSchema.path('features').validate(function validateFeatures(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [key, enabled] of Object.entries(value)) {
    if (!FEATURE_KEYS.includes(key)) {
      this.invalidate('features', `Unknown feature key: ${key}`);
      return false;
    }
    if (typeof enabled !== 'boolean') {
      this.invalidate('features', `Feature ${key} must be true or false`);
      return false;
    }
  }
  return true;
});

// One plan per code. Unique so a duplicate `starter` cannot exist and make
// resolution ambiguous.
planSchema.index({code: 1}, {unique: true, name: 'plan_code'});
// The catalogue listing: active plans in display order.
planSchema.index({active: 1, displayOrder: 1}, {name: 'plan_catalogue'});

export const Plan = model('Plan', planSchema);

// ── subscriptions ────────────────────────────────────────────────────────────

/**
 * Subscription lifecycle.
 *
 * `trialing` and `active` are the two states that may trade. `past_due` is
 * modelled because a real billing cycle needs somewhere to put "we invoiced
 * and were not paid", but P2C never sets it automatically — no gateway exists,
 * so nothing here can know a payment failed. It is reachable only by an
 * explicit platform action.
 */
export const SUBSCRIPTION_STATUSES = Object.freeze([
  'trialing', 'active', 'past_due', 'cancelled', 'expired'
]);

/** Statuses that entitle a tenant to OPERATE. */
export const OPERATIONAL_SUBSCRIPTION_STATUSES = Object.freeze(['trialing', 'active']);

/**
 * The explicit transition table.
 *
 * Anything not listed is impossible and is refused. Stated as data rather than
 * as scattered `if`s so the machine can be read, tested and reasoned about in
 * one place — and so an impossible transition fails identically wherever it is
 * attempted.
 *
 * Notable choices:
 *   - `cancelled -> active` is allowed (reactivation is a real support act);
 *   - `expired -> active` is allowed for the same reason;
 *   - nothing returns to `trialing`: a trial is a once-per-subscription state,
 *     otherwise "extend the trial" and "restart the trial" become the same
 *     operation and a tenant could be trialled indefinitely;
 *   - a terminal state cannot transition to itself, so a repeated cancel is
 *     reported as a no-op by the service rather than writing a second event.
 */
export const SUBSCRIPTION_TRANSITIONS = Object.freeze({
  trialing: Object.freeze(['active', 'past_due', 'cancelled', 'expired']),
  active: Object.freeze(['past_due', 'cancelled', 'expired']),
  past_due: Object.freeze(['active', 'cancelled', 'expired']),
  cancelled: Object.freeze(['active']),
  expired: Object.freeze(['active'])
});

export function canTransition(from, to) {
  if (!SUBSCRIPTION_STATUSES.includes(from) || !SUBSCRIPTION_STATUSES.includes(to)) return false;
  return SUBSCRIPTION_TRANSITIONS[from].includes(to);
}

const subscriptionSchema = new Schema({
  /**
   * ONE subscription per restaurant, enforced by a unique index below.
   *
   * A restaurant with two subscriptions has no defined entitlement, and the
   * resolver would have to pick one — silently, and differently depending on
   * sort order. The database refuses the situation instead.
   */
  restaurant: {...oid, ref: 'Restaurant', required: true},
  plan: {...oid, ref: 'Plan', required: true},

  status: {type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: 'trialing'},

  startDate: {type: Date, default: Date.now},
  trialStart: {type: Date, default: null},
  trialEnd: {type: Date, default: null},
  currentPeriodStart: {type: Date, default: null},
  currentPeriodEnd: {type: Date, default: null},

  /**
   * A scheduled cancellation. The tenant keeps working until the period ends,
   * which is what "cancel" means commercially — immediate cutoff is a
   * suspension and is a different, platform-side act.
   */
  cancelAtPeriodEnd: {type: Boolean, default: false},
  cancelledAt: {type: Date, default: null},
  endedAt: {type: Date, default: null},

  /** Free-text note from the last administrative action. Never a credential. */
  note: {type: String, trim: true, maxlength: 300}
}, {timestamps: true});

subscriptionSchema.index({restaurant: 1}, {unique: true, name: 'subscription_restaurant'});
// The trial-expiry sweep and the platform list both filter on status.
subscriptionSchema.index({status: 1, currentPeriodEnd: 1}, {name: 'subscription_status_period'});
// The sweep's hot query: trials whose end date has passed.
subscriptionSchema.index({status: 1, trialEnd: 1}, {name: 'subscription_status_trial'});
// "How many tenants are on this plan?" — asked whenever a plan is edited.
subscriptionSchema.index({plan: 1}, {name: 'subscription_plan'});

export const Subscription = model('Subscription', subscriptionSchema);

// ── immutable history ────────────────────────────────────────────────────────

export const SUBSCRIPTION_EVENTS = Object.freeze([
  'subscription_created',
  'plan_assigned',
  'plan_changed',
  'trial_started',
  'trial_extended',
  'trial_expired',
  'subscription_cancelled',
  'subscription_reactivated',
  'subscription_expired',
  'subscription_past_due'
]);

/**
 * The commercial record.
 *
 * `Subscription` holds CURRENT state and is overwritten in place; that is what
 * makes it cheap to read on every request. This collection is what makes the
 * overwriting safe: every change appends a row carrying the state before and
 * after, so the commercial history survives even though the subscription
 * document does not remember it.
 *
 * Append-only, enforced the same way the audit trail is: every path is
 * `immutable`, and update/delete hooks refuse outright. This is deliberately
 * NOT a second audit system — the tamper-evident hash chain in `Audit` still
 * receives a row for every one of these events. The two answer different
 * questions: `Audit` is "who did what across the whole platform", this is "what
 * has this subscription been", queryable per tenant without filtering the
 * entire audit collection by action name.
 */
const subscriptionEventSchema = new Schema({
  restaurant: {...oid, ref: 'Restaurant', required: true, immutable: true},
  subscription: {...oid, ref: 'Subscription', required: true, immutable: true},
  event: {type: String, enum: SUBSCRIPTION_EVENTS, required: true, immutable: true},

  // The states either side of the change. Plain sub-objects rather than refs,
  // so the row stays readable after a plan is renamed or deleted.
  before: {type: Schema.Types.Mixed, immutable: true},
  after: {type: Schema.Types.Mixed, immutable: true},

  reason: {type: String, trim: true, maxlength: 300, immutable: true},

  /** The platform operator responsible, when there is one. */
  actor: {...oid, ref: 'User', default: null, immutable: true},
  actorName: {type: String, trim: true, maxlength: 120, immutable: true},
  actorRole: {type: String, trim: true, maxlength: 60, immutable: true},

  at: {type: Date, default: Date.now, immutable: true}
}, {minimize: false});

subscriptionEventSchema.index({restaurant: 1, at: -1}, {name: 'subevent_restaurant_recent'});
subscriptionEventSchema.index({subscription: 1, at: -1}, {name: 'subevent_subscription_recent'});

/** Append-only, enforced at every Mongoose mutation path. */
subscriptionEventSchema.pre('save', function refuseRewrite(next) {
  if (!this.isNew) {
    return next(Object.assign(
      new Error('Subscription history is append-only and cannot be modified'), {status: 409}));
  }
  next();
});
for (const hook of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
  subscriptionEventSchema.pre(hook, function refuseUpdate(next) {
    next(Object.assign(
      new Error('Subscription history is append-only and cannot be modified'), {status: 409}));
  });
}
for (const hook of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove']) {
  subscriptionEventSchema.pre(hook, function refuseDelete(next) {
    next(Object.assign(
      new Error('Subscription history is append-only and cannot be deleted'), {status: 409}));
  });
}

export const SubscriptionEvent = model('SubscriptionEvent', subscriptionEventSchema);
