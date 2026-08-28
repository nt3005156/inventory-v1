import mongoose from 'mongoose';
import {Plan, Subscription} from '../models/billing.js';
import {invalidateEntitlements} from './entitlements.js';

/**
 * P2G.6 — cross-instance entitlement invalidation via MongoDB change streams.
 *
 * THE DEFECT THIS CLOSES, MEASURED
 * --------------------------------
 * The entitlement cache is per-process with a 30s TTL. A subscription or plan
 * edit applied on instance A was invisible to instance B until its TTL lapsed.
 * Probed directly: a tenant on `maxUsers: 2`, plan updated to 5 out of band,
 * and the process still answered 2 afterwards.
 *
 * That window is not merely stale data. It spans BOTH directions:
 *   • an upgrade a tenant has paid for does not take effect for 30s, and
 *   • a suspension or cancellation keeps working for 30s.
 * The second is the one that matters commercially.
 *
 * WHY CHANGE STREAMS, AND WHY NO NEW INFRASTRUCTURE
 * -------------------------------------------------
 * `services/roleChangeStream.js` already established this exact pattern for
 * the role cache, and change streams require a replica set which this
 * deployment ALREADY mandates — `verifyTransactionCapableDatabase()` refuses
 * to boot without one, because purchasing uses transactions. So the seam is
 * already a hard dependency and no Redis is introduced.
 *
 * This module deliberately mirrors `roleChangeStream.js` in shape (module-level
 * handle, `starting` guard, stats object, swallowed failures) so there is ONE
 * change-stream idiom in the codebase rather than two competing ones.
 *
 * THE ONE REAL DESIGN PROBLEM: PLAN → TENANTS
 * -------------------------------------------
 * The entitlement cache is keyed by RESTAURANT. A `Subscription` event names
 * its restaurant directly, so that invalidation is precise. A `Plan` event does
 * not — one plan backs many tenants, and the changed document knows nothing
 * about who is on it.
 *
 * Two options were considered:
 *   (a) query `Subscription.find({plan})` on every plan event and invalidate
 *       exactly those restaurants;
 *   (b) clear the whole entitlement cache.
 *
 * (b) is chosen. Plan edits are RARE (a platform administrator changing
 * commercial terms), the cache is bounded by tenant count (~100), and a clear
 * costs one cheap re-resolve per active tenant instead of an indexed query
 * issued from a stream callback where a failure is easy to lose. Precision
 * here would buy nothing and could be incomplete; clearing cannot be.
 * `subscriptions.js` already makes the same call for the same reason.
 *
 * HONEST SCOPE
 * ------------
 * Best-effort, exactly like the role stream. If the stream drops, the 30s TTL
 * remains the backstop and correctness still holds — propagation simply
 * returns to being TTL-bounded rather than near-immediate. It is an
 * optimisation of INVALIDATION, not a new source of truth, and the cache it
 * guards is unchanged.
 */

let stream = null;
let starting = false;

export const billingStreamStats = {
  started: 0,
  events: 0,
  subscriptionEvents: 0,
  planEvents: 0,
  errors: 0,
  closed: 0,
  restarts: 0
};

export function billingStreamActive() {
  return Boolean(stream);
}

/** Test seam: makes the counters assertable from a clean slate. */
export function __resetBillingStreamStats() {
  for (const key of Object.keys(billingStreamStats)) billingStreamStats[key] = 0;
}

/**
 * Decide what a single change event should invalidate.
 *
 * Pure and exported so the mapping can be tested directly, without a live
 * stream — the routing rule is the part most likely to be got wrong, and it
 * should not need a replica set to assert.
 *
 * Returns `{scope: 'tenant', restaurantId}` or `{scope: 'all'}`.
 */
export function invalidationForEvent(event, {collection} = {}) {
  const source = collection || event?.ns?.coll;

  /**
   * A PLAN event invalidates everything — see the header. The restaurants
   * affected are not derivable from the event, and a plan's commercial terms
   * change for every tenant on it at once.
   */
  if (source === 'plans') return {scope: 'all', reason: 'plan'};

  /**
   * A SUBSCRIPTION event names its own tenant, so invalidation is precise and
   * one tenant's billing change cannot disturb another's cache.
   *
   * `fullDocument` is absent on a delete, and `updateLookup` also yields null
   * if the document was removed between the event and the lookup. The
   * document KEY is still present, but it is the subscription's `_id`, not the
   * restaurant — so the tenant is genuinely unknown and the safe answer is to
   * clear everything rather than silently invalidate nothing.
   */
  const restaurantId = event?.fullDocument?.restaurant;
  if (restaurantId) {
    return {scope: 'tenant', restaurantId: String(restaurantId), reason: 'subscription'};
  }
  return {scope: 'all', reason: 'subscription_unresolved'};
}

/** Apply one event to the cache. Separated so tests can drive it directly. */
export function applyInvalidation(event, options = {}) {
  const decision = invalidationForEvent(event, options);
  if (decision.scope === 'tenant') invalidateEntitlements(decision.restaurantId);
  else invalidateEntitlements();
  return decision;
}

/**
 * Handle a stream failure: drop the handle so a restart can rebuild it, and
 * clear the cache because edits may have happened that this process never saw.
 *
 * Exported as a test seam. A real `error` event on a live change stream is
 * very hard to provoke deterministically, and a mutation run proved the point:
 * removing the cache clear and removing the handle drop BOTH survived, because
 * nothing ever drove this path. Making it callable means the recovery contract
 * is asserted rather than assumed.
 */
export function __handleStreamFailure(failed) {
  billingStreamStats.errors += 1;
  try { failed?.close?.(); } catch { /* already gone */ }
  // Only surrender the module handle if the failing stream is the current one;
  // a late error from an already-replaced stream must not kill a healthy one.
  if (!failed || failed === stream) stream = null;
  try { invalidateEntitlements(); } catch { /* nothing to drop */ }
}

/**
 * Route one change event to the cache, never letting a handler throw.
 *
 * A throwing listener would take the watcher down with it, so one bad event
 * would degrade every future invalidation instead of just its own.
 */
export function __handleStreamEvent(event) {
  billingStreamStats.events += 1;
  const collection = event?.ns?.coll;
  if (collection === 'plans') billingStreamStats.planEvents += 1;
  else billingStreamStats.subscriptionEvents += 1;
  try {
    applyInvalidation(event, {collection});
    return true;
  } catch {
    billingStreamStats.errors += 1;
    return false;
  }
}

/**
 * Begin watching `subscriptions` and `plans`.
 *
 * Safe to call repeatedly; a failure is logged by the caller and swallowed
 * here, because losing an optimisation must never stop the API booting. That
 * is the same contract `startRoleChangeStream()` has.
 */
export async function startBillingChangeStream() {
  if (stream || starting) return false;
  starting = true;
  try {
    const connection = mongoose.connection;
    if (!connection?.db) return false;

    /**
     * ONE stream over both collections rather than two.
     *
     * Watching the database with a `$match` on the two collection names costs
     * a single cursor and a single resume point, instead of two of each. It
     * also means the pair cannot half-fail — a state where subscription
     * invalidation works and plan invalidation silently does not would be very
     * hard to notice.
     */
    stream = connection.db.watch(
      [{$match: {'ns.coll': {$in: ['subscriptions', 'plans']}}}],
      {fullDocument: 'updateLookup'}
    );
    billingStreamStats.started += 1;
    if (billingStreamStats.started > 1) billingStreamStats.restarts += 1;

    const watched = stream;
    stream.on('change', __handleStreamEvent);

    // RECOVERY. See `__handleStreamFailure` — the handle is surrendered so a
    // restart can rebuild it, and the cache is dropped because changes made
    // while the stream is down are never delivered.
    stream.on('error', () => __handleStreamFailure(watched));

    /**
     * A fresh watcher has no idea what changed while it was not running —
     * across a restart, a reconnect, or a previous stream error. Clearing on
     * start makes the first post-start read authoritative instead of
     * potentially serving something cached before the gap.
     */
    invalidateEntitlements();
    return true;
  } catch {
    billingStreamStats.errors += 1;
    stream = null;
    return false;
  } finally {
    starting = false;
  }
}

export async function stopBillingChangeStream() {
  if (!stream) return false;
  const current = stream;
  stream = null;
  billingStreamStats.closed += 1;
  try { await current.close(); } catch { /* already closed */ }
  return true;
}

/**
 * Restart after a failure. Exposed so an operator or a future supervisor can
 * recover without a process bounce; `startBillingChangeStream()` alone is a
 * no-op while a (possibly dead) handle is still held.
 */
export async function restartBillingChangeStream() {
  await stopBillingChangeStream();
  return startBillingChangeStream();
}

/** Models referenced so the collection names above stay honest if they move. */
export const WATCHED_COLLECTIONS = Object.freeze([
  Subscription.collection.name,
  Plan.collection.name
]);
