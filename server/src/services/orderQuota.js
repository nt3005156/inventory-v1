/**
 * P2G.5 — enforcement of the monthly order allowance.
 *
 * P2G.4 made the COUNT correct (tenant timezone, cancellations excluded) and
 * deliberately enforced nothing. This turns that count into a refusal, and the
 * two were split so a metering change could never brick order creation on
 * deploy day.
 *
 * WHY THIS IS NOT JUST ANOTHER `withQuota` CALL
 * ---------------------------------------------
 * P2G.1–P2G.3 govern STOCKS: seats, menu items, stations. A stock has one
 * ceiling and one counter for the life of the tenant, and deleting a row hands
 * the seat back.
 *
 * A monthly order allowance is a FLOW. It refills every local month, it is
 * never handed back (a cancelled order stops counting because the count
 * excludes it, not because anything is released), and "which month" depends on
 * the tenant's own timezone. So the counter document is scoped by
 * `orders:<YYYY-MM>` in tenant-local time: September contends on a different
 * document from August and the allowance resets by construction, with no sweep
 * job that has to fire on time in eleven timezones.
 *
 * The atomic primitive is unchanged — the same single-document conditional
 * write from `quotaGuard`, so this is consistent with the established
 * architecture rather than a second mechanism.
 */
import {billingEnforcementActive, getLimit, isUnlimited} from './entitlements.js';
import {withQuota} from './quotaGuard.js';
import {
  DEFAULT_TIMEZONE, getOrderUsage, monthKey, normalizeTimezone
} from './usage.js';

/**
 * The counter document key for a tenant's current local month.
 *
 * Exported because the dry run and the tests both need to name the same
 * document the enforcement path will contend on.
 */
export function monthlyOrderResource(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  return `orders:${monthKey(now, timezone)}`;
}

/**
 * How an already-over-limit tenant is treated when enforcement switches on.
 *
 * THE PROBLEM THIS NAMES. A tenant who has already written 1,248 orders
 * against a ceiling of 1,000 — because the ceiling was never enforced until
 * now — would otherwise have their very next request fail with a bare
 * "limit reached". That is a support call at the till, mid-service, with no
 * explanation of what changed.
 *
 * THE CHOSEN BEHAVIOUR, and it is a deliberate product decision rather than an
 * accident of the code:
 *
 *   usage <  limit   ALLOW. Ordinary trading.
 *   usage == limit   REFUSE the next order. The plan said N and they have N.
 *   usage >  limit   REFUSE, but with a DISTINCT code and message that says
 *                    they were already past the allowance before enforcement
 *                    began, so support can tell "you just hit your limit"
 *                    apart from "you were over it when we turned this on".
 *
 * The alternative — grandfathering over-limit tenants for the remainder of the
 * month — was rejected because it silently sells a month of unlimited orders
 * to exactly the tenants who most need to upgrade, and because it cannot be
 * expressed atomically: a conditional write can refuse at a ceiling, but
 * "refuse unless you were already over it" needs the pre-enforcement figure
 * remembered somewhere, which is state nothing else needs.
 *
 * What makes this SAFE rather than harsh is the dry run
 * (`scripts/order-quota-dry-run.js`) plus `BILLING_ENFORCEMENT`: an operator is
 * expected to list the affected tenants and raise their plans BEFORE enabling
 * enforcement. The distinct code exists so that if somebody skips that step,
 * the failure is legible instead of mysterious.
 */
export const OVER_LIMIT_CODE = 'MONTHLY_ORDER_LIMIT_EXCEEDED';
export const AT_LIMIT_CODE = 'MONTHLY_ORDER_LIMIT_REACHED';

/** Classification shared by the dry run and the enforcement path. */
export function classifyUsage(usage, limit) {
  if (isUnlimited(limit)) return 'UNLIMITED';
  if (usage > limit) return 'OVER';
  if (usage === limit) return 'AT_LIMIT';
  return 'OK';
}

/**
 * Create an order under the monthly allowance.
 *
 * `timezone` is passed IN, never looked up here. The callers already hold a
 * resolved entitlement (which carries the tenant's zone since P2G.5) or the
 * branch's tenant context, so re-reading `Restaurant` would add a query to the
 * hottest write path in the product for information the caller already has.
 *
 * `session` is forwarded so the reservation joins the caller's transaction —
 * both order paths already run in one. An aborted order therefore rolls the
 * increment back with it, and `withQuota` knows not to also compensate (the
 * P2G.3 double-release lesson).
 */
export async function withMonthlyOrderQuota({
  restaurantId, timezone, now = new Date(), session = null, source
}, create) {
  // Deploy-day safety, identical to every other quota: a deployment with no
  // plan catalogue must behave exactly as it did before.
  if (!await billingEnforcementActive()) return create();

  const limit = await getLimit(restaurantId, 'maxMonthlyOrders');
  // Unlimited plans skip the counter entirely rather than maintaining a
  // document nothing reads.
  if (isUnlimited(limit)) return create();

  const zone = normalizeTimezone(timezone);
  const resource = monthlyOrderResource(now, zone);

  /**
   * `countActual` reconciles the counter against the REAL count before the
   * ceiling is tested — the same contract every other quota uses. It matters
   * more here than anywhere else:
   *
   *   - the counter for a month starts absent, so the first order of the month
   *     seeds it from the true figure rather than from zero. Without this,
   *     enabling enforcement mid-month would hand every tenant a fresh full
   *     allowance.
   *   - a cancelled order stops counting immediately, because the count
   *     excludes cancellations and the next reservation re-reads it.
   *
   * The timezone is threaded through so this does NOT perform the
   * `Restaurant` lookup that P2G.4 left on the path.
   */
  return withQuota({
    restaurantId,
    resource,
    limit,
    countActual: () => getOrderUsage(restaurantId, {now, timezone: zone}),
    label: 'orders this month',
    session,
    /**
     * `sync`, not the default `raise`. A monthly allowance is a FLOW: usage
     * legitimately falls when an order is cancelled, and the tenant must get
     * that slot back. Under `$max` the counter would hold its high-water mark
     * for the rest of the month. Measured before this: two orders on a ceiling
     * of two, cancel one, real usage 1, counter still 2, next order refused.
     */
    reconcile: 'sync'
  }, create).catch(error => {
    // Re-badge the generic refusal so an operator can tell the two situations
    // apart. Everything else about the error is preserved.
    if (error?.code === 'RESOURCE_LIMIT_REACHED') {
      const used = Number(error.used ?? 0);
      const overBefore = used > limit;
      error.code = overBefore ? OVER_LIMIT_CODE : AT_LIMIT_CODE;
      error.limit = 'maxMonthlyOrders';
      error.source = source;
      error.message = overBefore
        ? `This restaurant has ${used} orders this month against a plan allowance of `
          + `${limit}, so it was already over the limit before enforcement began. `
          + 'Upgrade the plan to continue taking orders.'
        : `Your plan allows ${limit} orders per month and ${used} have been placed. `
          + 'Upgrade the plan to take more orders this month.';
    }
    throw error;
  });
}
