/**
 * P2C — THE authoritative entitlement resolver.
 *
 * One place answers "what may this restaurant do?". Everything else asks it.
 * The alternative — `if (plan === 'enterprise')` sprinkled through services —
 * is what the brief forbids and what makes a plan change a code change.
 *
 * RESOLUTION ORDER, AND WHY
 * -------------------------
 *   restaurant -> subscription -> plan -> {features, limits}
 *
 * Each step can fail, and each failure has a DIFFERENT correct answer:
 *
 *   restaurant suspended/cancelled  no entitlement at all. This already blocks
 *                                   at `loadPrincipal()`, so the resolver
 *                                   agreeing is defence in depth, not the
 *                                   control.
 *   no subscription                 RESTRICTED default, never "unlimited".
 *   subscription cancelled/expired  operationally off, but data still readable.
 *   plan inactive                   the plan was retired underneath a live
 *                                   tenant. They keep its entitlements until
 *                                   somebody moves them; silently downgrading a
 *                                   paying customer because marketing archived
 *                                   a SKU would be worse than the alternative.
 *
 * FAIL CLOSED
 * -----------
 * The dangerous default is "no plan found, so no limits configured, so allow
 * everything". Every absent case here resolves to `RESTRICTED_ENTITLEMENT`,
 * which grants nothing beyond the bare minimum needed to log in and see that
 * something is wrong.
 *
 * OPERATIONAL vs DATA ACCESS
 * --------------------------
 * The brief is explicit that an expired subscription must not destroy access to
 * historical data. So the resolver reports two distinct booleans:
 *
 *   `operational`  may CREATE and MUTATE — take orders, add branches, hire.
 *   `readOnly`     may still READ their own history, exports and reports.
 *
 * A cancelled tenant keeps `readOnly`. A suspended tenant does not, because
 * suspension is a platform sanction and is already enforced upstream.
 */
import mongoose from 'mongoose';
import {Restaurant} from '../models/operations.js';
import {
  FEATURE_KEYS, LIMIT_KEYS, OPERATIONAL_SUBSCRIPTION_STATUSES, Plan, Subscription
} from '../models/billing.js';
import {isTenantOperational} from './tenantAdmin.js';
import {BILLING_ERROR_CODES, codeForReason} from './featureCatalogue.js';

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * `null` means unlimited. Never `-1`, never a large sentinel: both take part
 * in arithmetic, so a forgotten guard turns "unlimited" into a real ceiling or
 * a negative. `null` makes the mistake visible instead.
 */
export function isUnlimited(limit) {
  return limit === null || limit === undefined;
}

/**
 * What a restaurant gets when there is no usable subscription.
 *
 * Everything off, and every limit zero — EXCEPT the two that would otherwise
 * lock the tenant out of their own account entirely. A restaurant with no
 * subscription is a commercial problem to be fixed by a human, not a reason to
 * make their existing branch and owner login disappear.
 *
 * Frozen so a caller cannot mutate the shared default and quietly widen it for
 * every other tenant in the process.
 */
export const RESTRICTED_ENTITLEMENT = Object.freeze({
  plan: null,
  planCode: null,
  planName: null,
  status: null,
  operational: false,
  readOnly: true,
  features: Object.freeze(Object.fromEntries(FEATURE_KEYS.map(key => [key, false]))),
  limits: Object.freeze({
    ...Object.fromEntries(LIMIT_KEYS.map(key => [key, 0])),
    maxBranches: 1,
    maxUsers: 1
  }),
  reason: 'no_subscription'
});

/**
 * IS BILLING ENFORCEMENT ACTIVE ON THIS DEPLOYMENT?
 * ------------------------------------------------
 * This exists because of a defect the regression suite caught, and it is worth
 * stating plainly: the first implementation enforced limits unconditionally, so
 * a restaurant with no subscription could not create a menu item. That is
 * correct in steady state and CATASTROPHIC on deploy day — shipping P2C to the
 * existing platform would have bricked every tenant the instant the container
 * restarted, before anybody had a chance to run the migration.
 *
 * The rollout order has to be: deploy code -> seed plans -> backfill
 * subscriptions -> enforce. So enforcement is gated:
 *
 *   BILLING_ENFORCEMENT=off    never enforce. Entitlements are still computed
 *                              and reported honestly; nothing is refused.
 *   BILLING_ENFORCEMENT=on     always enforce, even with no plans seeded.
 *   unset / 'auto' (default)   enforce only once a plan catalogue EXISTS.
 *
 * `auto` is the safe default because an empty plan catalogue unambiguously
 * means "the commercial subsystem has not been provisioned on this
 * deployment". A platform that has never sold anything cannot sensibly refuse
 * anybody for not having bought it.
 *
 * This is NOT a security hole. Creating and editing plans requires
 * `platform.billing.manage`, and there is deliberately no delete-plan endpoint,
 * so a tenant cannot empty the catalogue to switch enforcement off. Once plans
 * exist, the only way back to unenforced is an operator setting the env var —
 * a visible, deliberate act.
 *
 * The check is cached with the same short TTL as entitlements, so it costs at
 * most one `countDocuments` every 30 seconds rather than one per request.
 */
let enforcementProbe = {value: null, expires: 0};

export function __resetBillingEnforcementProbe() {
  enforcementProbe = {value: null, expires: 0};
}

export async function billingEnforcementActive() {
  const mode = String(process.env.BILLING_ENFORCEMENT ?? 'auto').trim().toLowerCase();
  if (['off', 'false', '0', 'disabled'].includes(mode)) return false;
  if (['on', 'true', '1', 'enabled'].includes(mode)) return true;

  if (Date.now() < enforcementProbe.expires) return enforcementProbe.value;
  // A plan catalogue means the platform is selling something.
  const seeded = await Plan.estimatedDocumentCount().catch(() => 0);
  enforcementProbe = {value: seeded > 0, expires: Date.now() + CACHE_TTL_MS};
  return enforcementProbe.value;
}

/**
 * A short-lived cache.
 *
 * Entitlements are read on write-path requests, so an uncached resolver adds
 * two queries to every branch/user/menu creation. But caching authority is how
 * revocation stops working — the Phase 20 lesson, where a cached principal let
 * a deactivated employee keep trading.
 *
 * The compromise: a SHORT ttl, and explicit invalidation on every write that
 * could change the answer. The ttl is the backstop for a write path somebody
 * forgets to hook; it is not the mechanism. 30 seconds is short enough that a
 * missed invalidation is a nuisance rather than a security hole, and long
 * enough to absorb a burst of creates.
 *
 * Deliberately per-process. With ~100 tenants and a handful of instances this
 * costs a few hundred small objects; a shared cache would need Redis, which
 * the repository does not have and which this does not justify.
 */
const CACHE_TTL_MS = 30_000;
const cache = new Map();

export function invalidateEntitlements(restaurantId) {
  if (!restaurantId) return cache.clear();
  cache.delete(String(restaurantId));
}

/** Test seam: makes cache behaviour assertable without waiting 30 seconds. */
export function __entitlementCacheSize() {
  return cache.size;
}

function cached(restaurantId) {
  const hit = cache.get(String(restaurantId));
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    cache.delete(String(restaurantId));
    return null;
  }
  return hit.value;
}

function remember(restaurantId, value) {
  cache.set(String(restaurantId), {value, expires: Date.now() + CACHE_TTL_MS});
  return value;
}

/**
 * Merge a plan's stored maps over the full key set.
 *
 * A plan that omits a feature key is treated as NOT granting it — absent means
 * off, so adding a new feature to `FEATURE_KEYS` does not retroactively enable
 * it on every existing plan.
 *
 * An omitted LIMIT is `null` (unlimited), which is the opposite default and is
 * deliberate: a limit that was never configured has never been sold, and
 * silently enforcing 0 would break every existing tenant the moment a new limit
 * key is introduced. The platform UI shows which keys a plan leaves unset.
 */
function materialise(plan) {
  const features = {};
  for (const key of FEATURE_KEYS) features[key] = plan?.features?.[key] === true;
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const value = plan?.limits?.[key];
    limits[key] = value === undefined ? null : value;
  }
  return {features, limits};
}

/**
 * Resolve the effective entitlement for a restaurant.
 *
 * `restaurantId` must come from the authenticated principal or from an
 * explicitly permission-checked platform call — never from a request body.
 * This function does not authorize; it reports. Callers authorize.
 */
export async function resolveEntitlement(restaurantId, {fresh = false} = {}) {
  if (!restaurantId || !mongoose.isValidObjectId(restaurantId)) {
    return {...RESTRICTED_ENTITLEMENT, reason: 'invalid_restaurant'};
  }
  if (!fresh) {
    const hit = cached(restaurantId);
    if (hit) return hit;
  }

  const restaurant = await Restaurant.findById(restaurantId).select('status timezone').lean();
  if (!restaurant) {
    return remember(restaurantId, {...RESTRICTED_ENTITLEMENT, reason: 'no_restaurant'});
  }

  /**
   * Tenant lifecycle wins over everything commercial.
   *
   * A suspended restaurant on a paid Enterprise plan is still suspended. This
   * duplicates the check in `loadPrincipal()` on purpose: that one guards HTTP
   * requests, this one guards any service that resolves entitlements directly,
   * including background jobs that have no principal at all.
   */
  if (!isTenantOperational(restaurant.status)) {
    return remember(restaurantId, {
      ...RESTRICTED_ENTITLEMENT,
      readOnly: false,
      reason: restaurant.status === 'suspended' ? 'tenant_suspended' : 'tenant_cancelled',
      timezone: restaurant.timezone || null
    });
  }

  const subscription = await Subscription.findOne({restaurant: restaurantId}).lean();
  if (!subscription) {
    return remember(restaurantId, {
      ...RESTRICTED_ENTITLEMENT, reason: 'no_subscription', timezone: restaurant.timezone || null
    });
  }

  const plan = await Plan.findById(subscription.plan).lean();
  if (!plan) {
    // The plan document is gone but the subscription still points at it. That
    // is a data-integrity fault, not a commercial state, so it fails closed
    // and is named distinctly enough to be searchable in a log.
    return remember(restaurantId, {
      ...RESTRICTED_ENTITLEMENT, reason: 'plan_missing', timezone: restaurant.timezone || null
    });
  }

  const {features, limits} = materialise(plan);

  /**
   * A trial that has run out is not operational, even if the sweep has not
   * relabelled it yet.
   *
   * The scheduler moves `trialing -> expired`, but it runs on an interval. If
   * entitlement depended solely on the stored status, every tenant would get
   * free access for up to one sweep interval past their trial end — a "hidden
   * infinite trial" if the scheduler were ever switched off. Computing expiry
   * from the DATE makes the deadline deterministic and independent of whether
   * the job ran.
   */
  const now = Date.now();
  const trialLapsed = subscription.status === 'trialing'
    && subscription.trialEnd
    && new Date(subscription.trialEnd).getTime() <= now;

  const periodLapsed = subscription.status === 'active'
    && subscription.currentPeriodEnd
    && new Date(subscription.currentPeriodEnd).getTime() <= now;

  const statusOperational = OPERATIONAL_SUBSCRIPTION_STATUSES.includes(subscription.status);
  const operational = statusOperational && !trialLapsed && !periodLapsed;

  let reason = 'ok';
  if (trialLapsed) reason = 'trial_expired';
  else if (periodLapsed) reason = 'period_ended';
  else if (!statusOperational) reason = `subscription_${subscription.status}`;

  return remember(restaurantId, {
    plan: plan._id,
    planCode: plan.code,
    planName: plan.name,
    status: subscription.status,
    subscriptionId: subscription._id,
    operational,
    // Data access survives commercial lapse. Losing yesterday's sales report
    // because a card expired would be punitive and, for a VAT-registered
    // business in Nepal, a compliance problem.
    readOnly: true,
    trialEnd: subscription.trialEnd || null,
    currentPeriodEnd: subscription.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd),
    // An inactive plan keeps working for tenants already on it — see header.
    planActive: plan.active !== false,
    /**
     * P2G.5 — the tenant's IANA timezone, carried on the CACHED entitlement.
     *
     * The monthly order quota needs the tenant's zone to know which billing
     * month an order falls in. P2G.4 resolved that with its own
     * `Restaurant.findById` per call, which is one extra query on the order
     * hot path — the busiest write in the product.
     *
     * This resolver ALREADY loads the restaurant row and is already cached for
     * 30s, so widening its projection by one field makes the timezone free at
     * the point of use. `null` when unknown; callers normalise.
     */
    timezone: restaurant.timezone || null,
    features,
    limits,
    reason
  });
}

// ── the check API every caller uses ──────────────────────────────────────────

/**
 * Is a feature available to this restaurant?
 *
 * Requires BOTH the plan grant and operational standing. A cancelled tenant on
 * Enterprise holds `features.pos === true` in their plan and must still not be
 * able to ring up a sale.
 */
export async function hasFeature(restaurantId, feature) {
  if (!FEATURE_KEYS.includes(feature)) {
    // An unknown key is a programming error and must never quietly pass.
    throw httpError(`Unknown feature: ${feature}`, 500);
  }
  const entitlement = await resolveEntitlement(restaurantId);
  return entitlement.operational && entitlement.features[feature] === true;
}

/** The numeric ceiling for a resource, or `null` for unlimited. */
export async function getLimit(restaurantId, limitKey) {
  if (!LIMIT_KEYS.includes(limitKey)) {
    throw httpError(`Unknown limit: ${limitKey}`, 500);
  }
  const entitlement = await resolveEntitlement(restaurantId);
  return entitlement.limits[limitKey];
}

/**
 * Refuse unless the feature is available.
 *
 * 402 Payment Required, not 403. The distinction matters operationally: 403
 * means "your role does not allow this" and sends an owner hunting a
 * permission misconfiguration, while 402 means "your plan does not include
 * this" and points at the actual fix. The client can tell them apart and say
 * something useful.
 */
export async function assertFeature(restaurantId, feature, {label} = {}) {
  /**
   * P2E — an unknown key is refused BEFORE the enforcement gate.
   *
   * `FEATURE_KEYS` is the closed set of things a plan can grant, so a key
   * outside it can never be true. Refusing here rather than falling through
   * means a typo in a route is a loud failure instead of a silent hole, and
   * it cannot be excused by `BILLING_ENFORCEMENT=off`.
   */
  if (!FEATURE_KEYS.includes(feature)) {
    throw Object.assign(
      httpError(`Unknown feature: ${feature}`, 500),
      {billing: true, reason: 'unknown_feature', code: BILLING_ERROR_CODES.FEATURE_UNKNOWN, feature}
    );
  }

  const entitlement = await resolveEntitlement(restaurantId);
  // Not provisioned for billing yet: report, never refuse. See
  // `billingEnforcementActive()` for why this gate exists.
  if (!await billingEnforcementActive()) return entitlement;

  if (!entitlement.operational) {
    throw Object.assign(
      httpError(subscriptionMessage(entitlement), 402),
      {
        billing: true,
        reason: entitlement.reason,
        // Stable and machine-readable: the client must be able to tell
        // "buy an upgrade" from "settle your invoice" from "call support"
        // without parsing English prose.
        code: codeForReason(entitlement.reason)
      }
    );
  }
  if (entitlement.features[feature] !== true) {
    throw Object.assign(
      httpError(`${label || feature} is not included in the ${entitlement.planName || 'current'} plan`, 402),
      {
        billing: true, reason: 'feature_not_in_plan',
        code: BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED, feature
      }
    );
  }
  return entitlement;
}

/** A human-readable explanation of why a tenant is not operational. */
function subscriptionMessage(entitlement) {
  switch (entitlement.reason) {
    case 'trial_expired':
      return 'Your trial has ended. Contact the platform administrator to choose a plan.';
    case 'period_ended':
      return 'Your subscription period has ended. Contact the platform administrator.';
    case 'subscription_cancelled':
      return 'Your subscription has been cancelled. Contact the platform administrator to reactivate.';
    case 'subscription_expired':
      return 'Your subscription has expired. Contact the platform administrator.';
    case 'subscription_past_due':
      return 'Your subscription is past due. Contact the platform administrator.';
    case 'tenant_suspended':
      return 'This restaurant is suspended. Contact the platform administrator.';
    case 'no_subscription':
      return 'No subscription is attached to this restaurant. Contact the platform administrator.';
    default:
      return 'Your subscription does not permit this action. Contact the platform administrator.';
  }
}

/**
 * Refuse unless adding `adding` more of a resource stays within the plan limit.
 *
 * `currentUsage` is supplied by the caller rather than computed here, because
 * the caller already knows which query answers it and often has it in hand.
 * Passing it in also keeps this function synchronous in its logic and trivially
 * testable at the boundary — the off-by-one is the whole risk.
 *
 * THE BOUNDARY: usage 4, limit 5, adding 1 -> 5 <= 5, ALLOWED (the fifth).
 *               usage 5, limit 5, adding 1 -> 6 >  5, REFUSED (the sixth).
 * A plan that says "5 branches" must permit exactly five.
 */
export async function assertWithinLimit(restaurantId, limitKey, currentUsage, {
  adding = 1, label
} = {}) {
  const entitlement = await resolveEntitlement(restaurantId);
  if (!await billingEnforcementActive()) return entitlement;

  if (!entitlement.operational) {
    throw Object.assign(
      httpError(subscriptionMessage(entitlement), 402),
      {billing: true, reason: entitlement.reason, code: codeForReason(entitlement.reason)}
    );
  }

  const limit = entitlement.limits[limitKey];
  if (isUnlimited(limit)) return entitlement;

  const used = Number(currentUsage) || 0;
  if (used + adding > limit) {
    throw Object.assign(
      httpError(
        `The ${entitlement.planName || 'current'} plan allows ${limit} ${label || limitKey} `
        + `(${used} in use). Upgrade the plan to add more.`,
        402
      ),
      {
        billing: true, reason: 'limit_reached',
        code: BILLING_ERROR_CODES.RESOURCE_LIMIT_REACHED,
        limit: limitKey, allowed: limit, used
      }
    );
  }
  return entitlement;
}

/**
 * A client-safe summary. Used by the tenant subscription screen and by
 * `/api/my/entitlements`.
 *
 * Carries no plan pricing: what a tenant pays is a commercial matter between
 * them and the platform, and the operational client has no use for it.
 */
export function entitlementSummary(entitlement) {
  return {
    planCode: entitlement.planCode,
    planName: entitlement.planName,
    status: entitlement.status,
    operational: entitlement.operational,
    readOnly: entitlement.readOnly,
    reason: entitlement.reason,
    trialEnd: entitlement.trialEnd || null,
    currentPeriodEnd: entitlement.currentPeriodEnd || null,
    cancelAtPeriodEnd: Boolean(entitlement.cancelAtPeriodEnd),
    features: {...entitlement.features},
    limits: {...entitlement.limits}
  };
}
