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
import {releaseQuota, syncQuotaCounter, withQuota} from './quotaGuard.js';
import {
  DEFAULT_TIMEZONE, getOnlineOrderUsage, getOrderUsage, monthKey, normalizeTimezone
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
 * P2G.7 — the ONLINE sub-allowance counter, scoped the same way.
 *
 * A separate document from the overall one, so the two ceilings are contended
 * independently and an online order taking its online seat cannot disturb a
 * concurrent POS order taking an overall seat.
 */
export function monthlyOnlineOrderResource(now = new Date(), timezone = DEFAULT_TIMEZONE) {
  return `orders:online:${monthKey(now, timezone)}`;
}

/**
 * P2G.7 — WHAT COUNTS AS AN ONLINE ORDER.
 *
 * `Order.source`, an indexed enum of `['pos','online']` defaulting to `'pos'`.
 * Exactly one code path writes `'online'`: `storefront.js` guest checkout. The
 * POS route sets no `source` at all and takes the schema default.
 *
 * This is the SAME discriminator `getOnlineOrderUsage()` has used since P2G.4,
 * so enforcement and metering cannot disagree about what they are counting —
 * no second definition of "online" is introduced. In particular it is NOT
 * `Order.type`: `ONLINE_ORDER_TYPES` is `['delivery','takeaway']`, and a
 * cashier can ring up a takeaway at the till, which is a POS sale.
 */
export const ONLINE_ORDER_SOURCE = 'online';

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

/**
 * P2G.7 — the online sub-allowance uses its OWN codes.
 *
 * A guest refused because the restaurant's storefront allowance is exhausted
 * is a different operational situation from the restaurant being unable to
 * take any order at all: the till still works, and only the storefront needs
 * closing or the plan raising. Reusing the overall codes would make the two
 * indistinguishable to a client or a support engineer.
 */
export const ONLINE_OVER_LIMIT_CODE = 'MONTHLY_ONLINE_ORDER_LIMIT_EXCEEDED';
export const ONLINE_AT_LIMIT_CODE = 'MONTHLY_ONLINE_ORDER_LIMIT_REACHED';

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
    /**
     * The reservation only ever RAISES the counter. A monthly allowance is a
     * flow and must be able to fall, but lowering it here races live
     * increments: an earlier version reconciled downward immediately before
     * reserving and was measured breaking this ceiling (limit 2, 8 concurrent,
     * ten trials: 4,4,2,3,3,3,4,3,2,4). The downward move is
     * `reconcileMonthlyOrderQuota()`, off the reservation path.
     */
    session
  }, create).catch(error => {
    throw rebadge(error, {
      limit, source, limitKey: 'maxMonthlyOrders',
      atCode: AT_LIMIT_CODE, overCode: OVER_LIMIT_CODE, noun: 'orders'
    });
  });
}

/**
 * Turn `quotaGuard`'s generic 402 into one an operator can act on.
 *
 * Shared by both ceilings so the "already over before enforcement began"
 * distinction from P2G.5 applies identically to the online sub-allowance.
 */
function rebadge(error, {limit, source, limitKey, atCode, overCode, noun}) {
  if (error?.code !== 'RESOURCE_LIMIT_REACHED') return error;
  const used = Number(error.used ?? 0);
  const overBefore = used > limit;
  error.code = overBefore ? overCode : atCode;
  error.limit = limitKey;
  error.source = source;
  error.message = overBefore
    ? `This restaurant has ${used} ${noun} this month against a plan allowance of `
      + `${limit}, so it was already over the limit before enforcement began. `
      + 'Upgrade the plan to continue taking orders.'
    : `Your plan allows ${limit} ${noun} per month and ${used} have been placed. `
      + 'Upgrade the plan to take more orders this month.';
  return error;
}

/**
 * P2G.7 — create an ONLINE order under BOTH monthly ceilings.
 *
 * An online order consumes the overall allowance AND the online sub-allowance;
 * both must hold. A POS order consumes only the overall one, which is why the
 * two entry points are separate rather than a flag on one.
 *
 * WHY NOT `withCompoundQuota`
 * ---------------------------
 * That primitive exists for exactly this shape and was the first thing I
 * reached for, but it cannot express THIS operation safely, for one measured
 * reason: its `unwind()` calls `releaseQuota()` WITHOUT a session.
 *
 * Both order paths run inside a transaction. P2G.3 established that a
 * reservation taken inside a transaction must NOT also be compensated by hand
 * — the abort already rolls the `$inc` back, so an explicit release decrements
 * a second time and leaves the counter BELOW reality, which silently gifts
 * allowance. `withCompoundQuota` would do precisely that on every failed
 * online order. Extending it to thread a session was the alternative, but its
 * only caller today (`staffAccounts.js`) is sessionless, and changing its
 * unwind semantics risks a module this phase has no business touching.
 *
 * So this NESTS the existing `withQuota` primitive — no new quota primitive is
 * introduced, the atomic conditional write is unchanged, and each ceiling
 * keeps the session behaviour P2G.5 already proved correct.
 *
 * ORDERING: overall first, then online. The overall ceiling is the one that
 * refuses everybody, so checking it first means a tenant who is globally out
 * of allowance gets the message about their overall plan rather than a
 * confusing storefront-specific one.
 *
 * NO DOUBLE COUNTING. Two counters are incremented but ONE order row is
 * written, and the counters measure different things — `getOrderUsage()`
 * counts every countable order, `getOnlineOrderUsage()` the subset with
 * `source: 'online'`. Both reconcile against those real counts, so an online
 * order is +1 in each because it genuinely IS one of each, never +2 in either.
 */
export async function withMonthlyOnlineOrderQuota({
  restaurantId, timezone, now = new Date(), session = null
}, create) {
  // Deploy-day safety, identical to every other quota.
  if (!await billingEnforcementActive()) return create();

  const onlineLimit = await getLimit(restaurantId, 'maxMonthlyOnlineOrders');
  const zone = normalizeTimezone(timezone);

  // Delegating keeps ONE implementation of the overall allowance rather than a
  // second copy that could drift from it.
  const withOverall = inner => withMonthlyOrderQuota(
    {restaurantId, timezone: zone, now, session, source: ONLINE_ORDER_SOURCE}, inner
  );

  // An unlimited online sub-allowance means the overall ceiling is the only
  // constraint; skip the second counter rather than maintain a document
  // nothing reads.
  /**
   * Skip the second counter entirely for an unlimited online allowance.
   *
   * Strictly REDUNDANT — `reserveQuota()` also returns early on a null limit,
   * before it touches any document — so a mutant removing this branch is
   * equivalent and no test can distinguish it. Kept because it makes the
   * intent explicit at the call site and avoids computing a resource name and
   * a usage count that would then be discarded.
   */
  if (isUnlimited(onlineLimit)) return withOverall(create);

  const onlineResource = monthlyOnlineOrderResource(now, zone);

  return withOverall(async () => {
    /**
     * The inner reservation. If THIS is refused, the outer `withQuota` sees the
     * throw and unwinds the overall seat — by transaction rollback when a
     * session is present, or by its own compensating release when not. That is
     * the P2G.3 rule rather than a hand-rolled compensation.
     */
    try {
      return await withQuota({
        restaurantId,
        resource: onlineResource,
        limit: onlineLimit,
        countActual: () => getOnlineOrderUsage(restaurantId, {now, timezone: zone}),
        label: 'online orders this month',
        session
      }, create);
    } catch (error) {
      throw rebadge(error, {
        limit: onlineLimit,
        source: ONLINE_ORDER_SOURCE,
        limitKey: 'maxMonthlyOnlineOrders',
        atCode: ONLINE_AT_LIMIT_CODE,
        overCode: ONLINE_OVER_LIMIT_CODE,
        noun: 'online orders'
      });
    }
  });
}

/**
 * P2G.7 — return monthly allowance after orders stop being countable.
 *
 * WHY THIS IS A SEPARATE, EXPLICIT CALL. The counter must be able to fall — a
 * cancelled order should give its slot back — but lowering it cannot happen on
 * the reservation path. Measured: syncing immediately before reserving lowers
 * the counter while concurrent reservations are raising it, and a burst of six
 * against a ceiling of two produced 2,2,4,2,2,3,4,3,4,2. Removing that call
 * returned the same burst to 2,2,2,2,2,2,2,2,2,2.
 *
 * So reservations only ever raise, and this is invoked when usage has actually
 * fallen. It can only lower (`count: {$gt: actual}`), and refusing one order
 * too many for an instant is the correct direction for a ceiling to err.
 *
 * NOT wired into the cancellation path in this phase — that is order-lifecycle
 * work beyond this brief. The honest consequence is that after a cancellation
 * the counter sits ABOVE reality until this runs, refusing slightly early.
 */
export async function reconcileMonthlyOrderQuota({
  restaurantId, timezone, now = new Date(), session = null
}) {
  const zone = normalizeTimezone(timezone);
  const [overall, online] = await Promise.all([
    getOrderUsage(restaurantId, {now, timezone: zone}),
    getOnlineOrderUsage(restaurantId, {now, timezone: zone})
  ]);
  await syncQuotaCounter({
    restaurantId, resource: monthlyOrderResource(now, zone), actual: overall, session
  });
  await syncQuotaCounter({
    restaurantId, resource: monthlyOnlineOrderResource(now, zone), actual: online, session
  });
  return {overall, online};
}

/**
 * Release an online seat reserved OUTSIDE a transaction. With a session the
 * transaction owns the rollback and calling this as well is the P2G.3
 * double-release defect.
 */
export async function releaseOnlineOrderSeat({restaurantId, now = new Date(), timezone}) {
  await releaseQuota({
    restaurantId,
    resource: monthlyOnlineOrderResource(now, normalizeTimezone(timezone))
  });
}
