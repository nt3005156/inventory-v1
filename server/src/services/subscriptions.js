/**
 * P2C — plan catalogue and subscription administration.
 *
 * AUTHORITY MODEL
 * ---------------
 * Every mutation here is PLATFORM-side. A restaurant owner cannot change their
 * own plan, start their own trial, or cancel their own subscription, because
 * self-service billing is a commercial design the architecture has not made
 * yet (no gateway, no dunning, no proration). Giving a tenant the ability to
 * move themselves to Enterprise for free would be exactly that design, made by
 * accident.
 *
 * Authorization is asserted at the SERVICE layer via `assertPlatform()` — the
 * same helper P2B uses — as well as at the route. P2B's mutation run proved a
 * check that exists only behind a route is a check no unit test exercises.
 *
 * EVERY MUTATION WRITES TWICE
 * ---------------------------
 *   1. `SubscriptionEvent` — the append-only commercial record, queryable per
 *      tenant. Immutable at the schema level.
 *   2. `Audit` — the platform-wide, hash-chained trail P2A/P2B established.
 *
 * That is not duplication for its own sake. `Audit` answers "who did what
 * across the platform" and is chained for tamper evidence; the event log
 * answers "what has this subscription been" without scanning the audit
 * collection by action name. Losing either would lose a real capability.
 */
import mongoose from 'mongoose';
import {Audit} from '../models/index.js';
import {Restaurant} from '../models/operations.js';
import {
  FEATURE_KEYS, LIMIT_KEYS, Plan, SUBSCRIPTION_EVENTS, SUBSCRIPTION_STATUSES,
  Subscription, SubscriptionEvent, canTransition
} from '../models/billing.js';
import {assertPlatform} from './platformAdmin.js';
import {resolveEntitlement, invalidateEntitlements} from './entitlements.js';
import {recordSubscriptionChange, subscriptionSnapshot} from './subscriptionLifecycle.js';
import {userRestaurantContext} from './supplierCatalog.js';

/**
 * The commercial write path is SHARED with the scheduler.
 *
 * `subscriptionLifecycle.js` owns it so the administrative path and the
 * automatic path cannot drift into writing different history. Aliased here to
 * keep the call sites below readable.
 */
const snapshot = subscriptionSnapshot;
const recordChange = recordSubscriptionChange;

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const DAY_MS = 86_400_000;

/** Add whole days to a date without touching the clock's local timezone. */
function addDays(date, days) {
  return new Date(new Date(date).getTime() + Math.trunc(days) * DAY_MS);
}

// ── projections ──────────────────────────────────────────────────────────────

/**
 * Hand-built so a schema addition cannot leak silently.
 *
 * Prices are reported as integer minor units under explicit `*Minor` names,
 * plus a formatted string. The client must never do float arithmetic on these,
 * and naming them `Minor` makes a misuse visible in review.
 */
export function planView(plan) {
  const limits = {};
  for (const key of LIMIT_KEYS) {
    limits[key] = plan.limits?.[key] === undefined ? null : plan.limits[key];
  }
  const features = {};
  for (const key of FEATURE_KEYS) features[key] = plan.features?.[key] === true;
  return {
    _id: plan._id,
    code: plan.code,
    name: plan.name,
    description: plan.description || null,
    active: plan.active !== false,
    displayOrder: plan.displayOrder ?? 0,
    monthlyPriceMinor: plan.monthlyPrice ?? 0,
    annualPriceMinor: plan.annualPrice ?? 0,
    currency: plan.currency || 'NPR',
    monthlyPriceDisplay: formatMinor(plan.monthlyPrice ?? 0, plan.currency || 'NPR'),
    annualPriceDisplay: formatMinor(plan.annualPrice ?? 0, plan.currency || 'NPR'),
    trialDays: plan.trialDays ?? 0,
    limits,
    features,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt
  };
}

/**
 * Integer minor units to a display string, using integer arithmetic only.
 *
 * `(minor / 100).toFixed(2)` would reintroduce the float this whole subsystem
 * exists to avoid. Division and remainder on integers cannot drift.
 */
export function formatMinor(minor, currency = 'NPR') {
  const value = Number(minor) || 0;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const major = Math.trunc(abs / 100);
  const cents = abs % 100;
  return `${sign}${currency} ${major.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

export function subscriptionView(subscription, plan = null) {
  return {
    _id: subscription._id,
    restaurant: subscription.restaurant,
    plan: plan ? planView(plan) : subscription.plan,
    status: subscription.status,
    startDate: subscription.startDate || null,
    trialStart: subscription.trialStart || null,
    trialEnd: subscription.trialEnd || null,
    currentPeriodStart: subscription.currentPeriodStart || null,
    currentPeriodEnd: subscription.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    cancelledAt: subscription.cancelledAt || null,
    endedAt: subscription.endedAt || null,
    note: subscription.note || null,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt
  };
}

// ── the shared write path ────────────────────────────────────────────────────

/**
 * Apply a status change through the explicit transition table.
 *
 * Centralised so no caller can invent a transition the machine forbids, and so
 * "already in that state" is reported uniformly as a no-op rather than as an
 * error or, worse, as a duplicate history row.
 */
function assertTransition(from, to) {
  if (from === to) return false;
  if (!canTransition(from, to)) {
    throw httpError(`A ${from} subscription cannot become ${to}`, 409);
  }
  return true;
}

// ── plan catalogue ───────────────────────────────────────────────────────────

function parseLimits(input) {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError('limits must be an object', 400);
  }
  const limits = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LIMIT_KEYS.includes(key)) throw httpError(`Unknown limit key: ${key}`, 400);
    if (value === null) { limits[key] = null; continue; }
    if (!Number.isSafeInteger(value) || value < 0) {
      throw httpError(`Limit ${key} must be a non-negative integer, or null for unlimited`, 400);
    }
    limits[key] = value;
  }
  return limits;
}

function parseFeatures(input) {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw httpError('features must be an object', 400);
  }
  const features = {};
  for (const [key, value] of Object.entries(input)) {
    if (!FEATURE_KEYS.includes(key)) throw httpError(`Unknown feature key: ${key}`, 400);
    if (typeof value !== 'boolean') throw httpError(`Feature ${key} must be true or false`, 400);
    features[key] = value;
  }
  return features;
}

function parseMinor(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(`${field} must be a non-negative integer in minor units (paisa)`, 400);
  }
  return value;
}

/**
 * The plan catalogue.
 *
 * Readable by any platform operator holding `platform.billing.view`, and — in
 * a deliberately narrower form — by tenants, who need to know what their own
 * plan includes. The tenant path goes through `getOwnSubscription()`, not here.
 */
export async function listPlans({user, includeInactive = false}) {
  await assertPlatform(user, 'platform.billing.view');
  const filter = includeInactive ? {} : {active: true};
  const plans = await Plan.find(filter).sort({displayOrder: 1, code: 1}).lean();

  // Tenant counts per plan: asked every time somebody considers editing one.
  const counts = await Subscription.aggregate([
    {$group: {_id: '$plan', n: {$sum: 1}}}
  ]);
  const countMap = new Map(counts.map(row => [String(row._id), row.n]));

  return {
    plans: plans.map(plan => ({
      ...planView(plan),
      subscriberCount: countMap.get(String(plan._id)) || 0
    })),
    limitKeys: [...LIMIT_KEYS],
    featureKeys: [...FEATURE_KEYS]
  };
}

export async function getPlan({user, planId}) {
  await assertPlatform(user, 'platform.billing.view');
  if (!mongoose.isValidObjectId(planId)) throw httpError('Plan not found', 404);
  const plan = await Plan.findById(planId).lean();
  if (!plan) throw httpError('Plan not found', 404);
  const subscriberCount = await Subscription.countDocuments({plan: plan._id});
  return {...planView(plan), subscriberCount};
}

export async function createPlan({user, input}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');

  const code = clean(input?.code).toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,38}[a-z0-9]$/.test(code)) {
    throw httpError('A plan code must be lowercase letters, numbers, hyphen or underscore', 400);
  }
  if (await Plan.findOne({code})) throw httpError('That plan code already exists', 409);

  const name = clean(input?.name);
  if (name.length < 2) throw httpError('A plan name is required', 400);

  const plan = await Plan.create({
    code,
    name,
    description: clean(input?.description) || undefined,
    active: input?.active !== false,
    displayOrder: Number.isInteger(input?.displayOrder) ? input.displayOrder : 0,
    monthlyPrice: parseMinor(input?.monthlyPriceMinor, 'monthlyPriceMinor') ?? 0,
    annualPrice: parseMinor(input?.annualPriceMinor, 'annualPriceMinor') ?? 0,
    currency: clean(input?.currency).toUpperCase() || 'NPR',
    trialDays: Number.isInteger(input?.trialDays) ? input.trialDays : 0,
    limits: parseLimits(input?.limits) ?? {},
    features: parseFeatures(input?.features) ?? {}
  });

  await Audit.create({
    entity: 'plan', entityId: plan._id, action: 'plan_created',
    after: {code: plan.code, name: plan.name, active: plan.active},
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });
  return planView(plan.toObject());
}

/**
 * Edit a plan.
 *
 * `code` is deliberately immutable: application code and support conversations
 * key off it, and renaming it would silently repoint every subscription's
 * meaning. Retire the plan and create a new one instead.
 *
 * A plan edit changes entitlements for EVERY tenant on it, so the entitlement
 * cache is cleared wholesale rather than per tenant.
 */
export async function updatePlan({user, planId, input}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');
  if (!mongoose.isValidObjectId(planId)) throw httpError('Plan not found', 404);
  if (input && 'code' in input) {
    throw httpError('A plan code cannot be changed; retire the plan and create a new one', 400);
  }

  const plan = await Plan.findById(planId);
  if (!plan) throw httpError('Plan not found', 404);

  const before = {
    name: plan.name, active: plan.active, monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice, trialDays: plan.trialDays,
    limits: {...(plan.limits || {})}, features: {...(plan.features || {})}
  };

  if (input?.name !== undefined) {
    const name = clean(input.name);
    if (name.length < 2) throw httpError('A plan name is required', 400);
    plan.name = name;
  }
  if (input?.description !== undefined) plan.description = clean(input.description) || undefined;
  if (input?.active !== undefined) plan.active = Boolean(input.active);
  if (input?.displayOrder !== undefined) {
    if (!Number.isInteger(input.displayOrder)) throw httpError('displayOrder must be an integer', 400);
    plan.displayOrder = input.displayOrder;
  }
  if (input?.monthlyPriceMinor !== undefined) {
    plan.monthlyPrice = parseMinor(input.monthlyPriceMinor, 'monthlyPriceMinor');
  }
  if (input?.annualPriceMinor !== undefined) {
    plan.annualPrice = parseMinor(input.annualPriceMinor, 'annualPriceMinor');
  }
  if (input?.currency !== undefined) plan.currency = clean(input.currency).toUpperCase() || 'NPR';
  if (input?.trialDays !== undefined) {
    if (!Number.isInteger(input.trialDays) || input.trialDays < 0 || input.trialDays > 365) {
      throw httpError('trialDays must be a whole number between 0 and 365', 400);
    }
    plan.trialDays = input.trialDays;
  }
  // Limits and features REPLACE wholesale rather than merging: a partial merge
  // makes "remove this limit" impossible to express.
  const limits = parseLimits(input?.limits);
  if (limits !== undefined) { plan.limits = limits; plan.markModified('limits'); }
  const features = parseFeatures(input?.features);
  if (features !== undefined) { plan.features = features; plan.markModified('features'); }

  await plan.save();

  await Audit.create({
    entity: 'plan', entityId: plan._id, action: 'plan_updated',
    before,
    after: {
      name: plan.name, active: plan.active, monthlyPrice: plan.monthlyPrice,
      annualPrice: plan.annualPrice, trialDays: plan.trialDays,
      limits: {...(plan.limits || {})}, features: {...(plan.features || {})}
    },
    user: actor._id, userName: actor.name, userRole: `platform:${actor.platformRole}`
  });

  // Every tenant on this plan now has different entitlements.
  invalidateEntitlements();
  return planView(plan.toObject());
}

// ── subscription administration ──────────────────────────────────────────────

async function loadRestaurant(restaurantId) {
  if (!mongoose.isValidObjectId(restaurantId)) throw httpError('Restaurant not found', 404);
  const restaurant = await Restaurant.findById(restaurantId).select('name status').lean();
  if (!restaurant) throw httpError('Restaurant not found', 404);
  return restaurant;
}

async function loadPlanByIdOrCode(planRef) {
  const ref = clean(planRef);
  if (!ref) throw httpError('A plan is required', 400);
  const plan = mongoose.isValidObjectId(ref)
    ? await Plan.findById(ref)
    : await Plan.findOne({code: ref.toLowerCase()});
  if (!plan) throw httpError('Plan not found', 404);
  return plan;
}

/** A restaurant's subscription, for the platform. */
export async function getSubscription({user, restaurantId}) {
  await assertPlatform(user, 'platform.billing.view');
  const restaurant = await loadRestaurant(restaurantId);

  const subscription = await Subscription.findOne({restaurant: restaurant._id}).lean();
  if (!subscription) {
    return {
      restaurant: {_id: restaurant._id, name: restaurant.name, status: restaurant.status},
      subscription: null,
      entitlement: await resolveEntitlement(restaurant._id, {fresh: true})
    };
  }
  const plan = await Plan.findById(subscription.plan).lean();
  return {
    restaurant: {_id: restaurant._id, name: restaurant.name, status: restaurant.status},
    subscription: subscriptionView(subscription, plan),
    entitlement: await resolveEntitlement(restaurant._id, {fresh: true})
  };
}

/**
 * Assign a plan, creating the subscription if there is none.
 *
 * ONE endpoint for "first assignment" and "plan change" because they are the
 * same commercial act from the operator's point of view, but they record
 * DIFFERENT events (`plan_assigned` vs `plan_changed`) so the history stays
 * precise.
 *
 * `startTrial` uses the plan's own `trialDays`. A trial is only offered on
 * FIRST assignment: re-trialling an existing subscriber is how a tenant gets
 * an unbounded free ride, one "plan change" at a time.
 */
export async function assignPlan({user, restaurantId, plan: planRef, reason, startTrial = false}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');
  const restaurant = await loadRestaurant(restaurantId);
  const plan = await loadPlanByIdOrCode(planRef);

  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to change a plan', 400);

  if (plan.active === false) {
    // Assigning somebody to a retired plan is almost always a mistake, and the
    // few legitimate cases (grandfathering) should be deliberate acts on an
    // active plan record rather than a quiet exception here.
    throw httpError('That plan is not active and cannot be assigned', 409);
  }

  const existing = await Subscription.findOne({restaurant: restaurant._id});

  if (!existing) {
    const now = new Date();
    const trialDays = startTrial ? Number(plan.trialDays || 0) : 0;
    const trialing = trialDays > 0;

    const created = await Subscription.create({
      restaurant: restaurant._id,
      plan: plan._id,
      status: trialing ? 'trialing' : 'active',
      startDate: now,
      trialStart: trialing ? now : null,
      trialEnd: trialing ? addDays(now, trialDays) : null,
      currentPeriodStart: now,
      // A month, for the operational period. No proration and no invoicing in
      // P2C — this is the window entitlement is evaluated against, not a bill.
      currentPeriodEnd: trialing ? addDays(now, trialDays) : addDays(now, 30),
      note: note || undefined
    });

    await recordChange({
      subscription: created, restaurantId: restaurant._id, actor,
      event: trialing ? 'trial_started' : 'plan_assigned',
      before: null, after: snapshot(created), reason: note
    });
    return subscriptionView(created.toObject(), plan);
  }

  if (String(existing.plan) === String(plan._id)) {
    return {...subscriptionView(existing.toObject(), plan), changed: false};
  }

  const before = snapshot(existing);
  const previousPlan = await Plan.findById(existing.plan).lean();

  existing.plan = plan._id;
  existing.note = note || undefined;
  /**
   * A plan change on a cancelled or expired subscription REACTIVATES it. The
   * operator's intent in moving a lapsed tenant onto a plan is plainly to sell
   * them that plan, and leaving it cancelled would produce a subscription that
   * claims a plan while granting nothing.
   */
  if (['cancelled', 'expired'].includes(existing.status)) {
    assertTransition(existing.status, 'active');
    existing.status = 'active';
    existing.cancelledAt = null;
    existing.endedAt = null;
    existing.cancelAtPeriodEnd = false;
    existing.currentPeriodStart = new Date();
    existing.currentPeriodEnd = addDays(new Date(), 30);
  }
  await existing.save();

  await recordChange({
    subscription: existing, restaurantId: restaurant._id, actor,
    event: 'plan_changed',
    before: {...before, planCode: previousPlan?.code || null},
    after: {...snapshot(existing), planCode: plan.code},
    reason: note
  });
  return {...subscriptionView(existing.toObject(), plan), changed: true};
}

/**
 * Extend a trial.
 *
 * Only meaningful while trialing — extending a converted subscription's trial
 * would be a silent free month. Bounded to 365 days per extension so a mistyped
 * value cannot create a decade-long trial.
 */
export async function extendTrial({user, restaurantId, days, reason}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');
  const restaurant = await loadRestaurant(restaurantId);

  const extraDays = Number(days);
  if (!Number.isInteger(extraDays) || extraDays < 1 || extraDays > 365) {
    throw httpError('Trial extension must be a whole number of days between 1 and 365', 400);
  }
  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to extend a trial', 400);

  const subscription = await Subscription.findOne({restaurant: restaurant._id});
  if (!subscription) throw httpError('This restaurant has no subscription', 404);
  if (subscription.status !== 'trialing') {
    throw httpError(`Only a trialing subscription can be extended (this one is ${subscription.status})`, 409);
  }

  const before = snapshot(subscription);
  // Extend from the CURRENT trial end when it is still in the future, or from
  // now when it has already lapsed. Extending a lapsed trial by 7 days should
  // give 7 days from today, not 7 days from a date that has passed.
  const base = subscription.trialEnd && new Date(subscription.trialEnd).getTime() > Date.now()
    ? new Date(subscription.trialEnd)
    : new Date();
  subscription.trialEnd = addDays(base, extraDays);
  subscription.currentPeriodEnd = subscription.trialEnd;
  subscription.note = note;
  await subscription.save();

  await recordChange({
    subscription, restaurantId: restaurant._id, actor,
    event: 'trial_extended', before, after: snapshot(subscription), reason: note
  });
  const plan = await Plan.findById(subscription.plan).lean();
  return subscriptionView(subscription.toObject(), plan);
}

/**
 * Cancel.
 *
 * Two shapes, and the difference is commercially important:
 *   `atPeriodEnd: true`  (default) the tenant keeps working until the period
 *                        ends. This is what "cancel my subscription" means.
 *   `atPeriodEnd: false` immediate. Entitlement stops now.
 *
 * Neither deletes anything. `readOnly` access to their own history survives —
 * see the entitlement resolver.
 */
export async function cancelSubscription({user, restaurantId, reason, atPeriodEnd = true}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');
  const restaurant = await loadRestaurant(restaurantId);

  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to cancel a subscription', 400);

  const subscription = await Subscription.findOne({restaurant: restaurant._id});
  if (!subscription) throw httpError('This restaurant has no subscription', 404);
  if (subscription.status === 'cancelled') {
    return {...subscriptionView(subscription.toObject()), changed: false};
  }

  const before = snapshot(subscription);
  const now = new Date();

  if (atPeriodEnd) {
    // Status stays as-is; the flag is what the sweep and the resolver read.
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelledAt = now;
  } else {
    assertTransition(subscription.status, 'cancelled');
    subscription.status = 'cancelled';
    subscription.cancelAtPeriodEnd = false;
    subscription.cancelledAt = now;
    subscription.endedAt = now;
  }
  subscription.note = note;
  await subscription.save();

  await recordChange({
    subscription, restaurantId: restaurant._id, actor,
    event: 'subscription_cancelled', before, after: snapshot(subscription), reason: note
  });
  return {...subscriptionView(subscription.toObject()), changed: true};
}

/** Reactivate a cancelled, expired or past-due subscription. */
export async function reactivateSubscription({user, restaurantId, reason}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');
  const restaurant = await loadRestaurant(restaurantId);

  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to reactivate a subscription', 400);

  const subscription = await Subscription.findOne({restaurant: restaurant._id});
  if (!subscription) throw httpError('This restaurant has no subscription', 404);

  const before = snapshot(subscription);

  // A scheduled cancellation that has not taken effect yet is simply undone.
  if (subscription.status !== 'cancelled' && subscription.cancelAtPeriodEnd) {
    subscription.cancelAtPeriodEnd = false;
    subscription.cancelledAt = null;
    subscription.note = note;
    await subscription.save();
    await recordChange({
      subscription, restaurantId: restaurant._id, actor,
      event: 'subscription_reactivated', before, after: snapshot(subscription), reason: note
    });
    return {...subscriptionView(subscription.toObject()), changed: true};
  }

  if (subscription.status === 'active') {
    return {...subscriptionView(subscription.toObject()), changed: false};
  }

  assertTransition(subscription.status, 'active');

  const plan = await Plan.findById(subscription.plan).lean();
  if (!plan) throw httpError('The plan on this subscription no longer exists; assign a plan first', 409);
  if (plan.active === false) {
    throw httpError('The plan on this subscription is retired; assign an active plan instead', 409);
  }

  const now = new Date();
  subscription.status = 'active';
  subscription.cancelAtPeriodEnd = false;
  subscription.cancelledAt = null;
  subscription.endedAt = null;
  subscription.currentPeriodStart = now;
  subscription.currentPeriodEnd = addDays(now, 30);
  subscription.note = note;
  await subscription.save();

  await recordChange({
    subscription, restaurantId: restaurant._id, actor,
    event: 'subscription_reactivated', before, after: snapshot(subscription), reason: note
  });
  return {...subscriptionView(subscription.toObject(), plan), changed: true};
}

/**
 * Mark past due.
 *
 * Set only by an explicit platform action. NOTHING in P2C decides on its own
 * that a payment failed, because no gateway exists to tell us — inventing that
 * signal would be fabricating a financial fact.
 */
export async function markPastDue({user, restaurantId, reason}) {
  const actor = await assertPlatform(user, 'platform.billing.manage');
  const restaurant = await loadRestaurant(restaurantId);

  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to mark a subscription past due', 400);

  const subscription = await Subscription.findOne({restaurant: restaurant._id});
  if (!subscription) throw httpError('This restaurant has no subscription', 404);
  if (subscription.status === 'past_due') {
    return {...subscriptionView(subscription.toObject()), changed: false};
  }

  const before = snapshot(subscription);
  assertTransition(subscription.status, 'past_due');
  subscription.status = 'past_due';
  subscription.note = note;
  await subscription.save();

  await recordChange({
    subscription, restaurantId: restaurant._id, actor,
    event: 'subscription_past_due', before, after: snapshot(subscription), reason: note
  });
  return {...subscriptionView(subscription.toObject()), changed: true};
}

/** The immutable history for one restaurant. */
export async function getSubscriptionHistory({user, restaurantId, page = 1, limit = 50}) {
  await assertPlatform(user, 'platform.billing.view');
  const restaurant = await loadRestaurant(restaurantId);

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const safePage = Math.max(1, Number(page) || 1);

  const [rows, total] = await Promise.all([
    SubscriptionEvent.find({restaurant: restaurant._id})
      .sort({at: -1, _id: -1}).skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    SubscriptionEvent.countDocuments({restaurant: restaurant._id})
  ]);

  return {
    events: rows.map(row => ({
      _id: row._id,
      event: row.event,
      at: row.at,
      before: row.before ?? null,
      after: row.after ?? null,
      reason: row.reason || null,
      actor: {id: row.actor || null, name: row.actorName || null, role: row.actorRole || null}
    })),
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    },
    eventTypes: [...SUBSCRIPTION_EVENTS]
  };
}

/** Every subscription, for the platform billing overview. */
export async function listSubscriptions({user, status, planCode, page = 1, limit = 25}) {
  await assertPlatform(user, 'platform.billing.view');

  const filter = {};
  if (clean(status)) {
    const wanted = String(status).split(',').map(clean).filter(Boolean);
    for (const value of wanted) {
      if (!SUBSCRIPTION_STATUSES.includes(value)) throw httpError(`Unknown status: ${value}`, 400);
    }
    if (wanted.length) filter.status = {$in: wanted};
  }
  if (clean(planCode)) {
    const plan = await Plan.findOne({code: clean(planCode).toLowerCase()}).select('_id').lean();
    // An unknown plan code yields an empty page rather than an error: it is a
    // filter, and the caller learns nothing useful from a 404 here.
    if (!plan) return {subscriptions: [], pagination: {page: 1, limit: 25, total: 0, pages: 1}};
    filter.plan = plan._id;
  }

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
  const safePage = Math.max(1, Number(page) || 1);

  const [rows, total] = await Promise.all([
    Subscription.find(filter).sort({createdAt: -1})
      .skip((safePage - 1) * safeLimit).limit(safeLimit).lean(),
    Subscription.countDocuments(filter)
  ]);

  const planIds = [...new Set(rows.map(row => String(row.plan)))];
  const restaurantIds = rows.map(row => row.restaurant);
  const [plans, restaurants] = await Promise.all([
    Plan.find({_id: {$in: planIds}}).select('code name').lean(),
    Restaurant.find({_id: {$in: restaurantIds}}).select('name slug status').lean()
  ]);
  const planMap = new Map(plans.map(row => [String(row._id), row]));
  const restaurantMap = new Map(restaurants.map(row => [String(row._id), row]));

  return {
    subscriptions: rows.map(row => ({
      _id: row._id,
      status: row.status,
      trialEnd: row.trialEnd || null,
      currentPeriodEnd: row.currentPeriodEnd || null,
      cancelAtPeriodEnd: Boolean(row.cancelAtPeriodEnd),
      plan: planMap.get(String(row.plan))
        ? {
          _id: row.plan,
          code: planMap.get(String(row.plan)).code,
          name: planMap.get(String(row.plan)).name
        }
        : null,
      restaurant: restaurantMap.get(String(row.restaurant))
        ? {
          _id: row.restaurant,
          name: restaurantMap.get(String(row.restaurant)).name,
          slug: restaurantMap.get(String(row.restaurant)).slug || null,
          status: restaurantMap.get(String(row.restaurant)).status || 'active'
        }
        : {_id: row.restaurant, name: null, slug: null, status: null}
    })),
    pagination: {
      page: safePage, limit: safeLimit, total,
      pages: Math.max(1, Math.ceil(total / safeLimit))
    }
  };
}

// ── tenant-facing read ───────────────────────────────────────────────────────

/**
 * The CALLER'S OWN subscription. Read-only, always.
 *
 * There is no id parameter, by design: the tenant comes from the authenticated
 * principal, so this cannot be aimed at another restaurant. A `restaurantId`
 * in the request body is ignored entirely — the P2A rule, restated because
 * this endpoint returns commercial data and is exactly the sort of thing
 * somebody would later "helpfully" parameterise.
 *
 * Carries no pricing and no other tenant's data. There is deliberately no
 * tenant-side WRITE anywhere in this module.
 */
export async function getOwnSubscription({user}) {
  const {restaurantId} = await userRestaurantContext(user);

  const entitlement = await resolveEntitlement(restaurantId, {fresh: true});
  const subscription = await Subscription.findOne({restaurant: restaurantId}).lean();
  const plan = subscription ? await Plan.findById(subscription.plan).lean() : null;

  return {
    subscription: subscription
      ? {
        status: subscription.status,
        startDate: subscription.startDate || null,
        trialStart: subscription.trialStart || null,
        trialEnd: subscription.trialEnd || null,
        currentPeriodStart: subscription.currentPeriodStart || null,
        currentPeriodEnd: subscription.currentPeriodEnd || null,
        cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd)
      }
      : null,
    plan: plan
      ? {
        code: plan.code,
        name: plan.name,
        description: plan.description || null,
        // The tenant may see what THEY are paying. Still integer minor units.
        monthlyPriceMinor: plan.monthlyPrice ?? 0,
        currency: plan.currency || 'NPR',
        monthlyPriceDisplay: formatMinor(plan.monthlyPrice ?? 0, plan.currency || 'NPR')
      }
      : null,
    entitlement: {
      operational: entitlement.operational,
      readOnly: entitlement.readOnly,
      reason: entitlement.reason,
      features: entitlement.features,
      limits: entitlement.limits
    }
  };
}
