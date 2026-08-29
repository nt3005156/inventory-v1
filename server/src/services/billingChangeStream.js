import mongoose from 'mongoose';
import {Plan, Subscription} from '../models/billing.js';
import {invalidateEntitlements} from './entitlements.js';
import {createReArm, parseBackoff} from './streamReArm.js';

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

/**
 * P2H.2 — AUTOMATIC RE-ARMING, on the shared controller.
 *
 * THE GAP THIS CLOSES, MEASURED LIVE. P2H.1 stopped MongoDB under a running
 * API container: the stream reported `healthy=false, errors=1,
 * MongoServerSelectionError` and then stayed dead — still down 68 seconds
 * after MongoDB returned. The driver resumes transparently across brief blips,
 * but a server-selection failure kills the cursor for good.
 *
 * P2H.3 moved the machinery into `services/streamReArm.js` so the role stream
 * shares it rather than carrying a second copy of the same retry loop. The
 * bounded ladder, the single-flight guarantee and the `unref`'d timer are
 * unchanged — that module explains why the backoff is capped rather than
 * doubling forever.
 */
const reArm = createReArm({
  backoff: () => parseBackoff(process.env.BILLING_STREAM_BACKOFF_MS),
  isHealthy: () => Boolean(stream),
  start: () => startBillingChangeStream(),
  onScheduled: () => { billingStreamStats.reArmScheduled += 1; },
  onAttempt: () => { billingStreamStats.reArmAttempts += 1; },
  onRecovered: () => { billingStreamStats.reArmRecoveries += 1; }
});

/** Test/ops seam: turn automatic recovery off without touching the stream. */
export function __setBillingReArmEnabled(value) {
  return reArm.setEnabled(value);
}

const scheduleReArm = () => reArm.schedule();

const MAX_ERROR_LENGTH = 200;

function describeStreamError(error) {
  if (!error) return null;
  const name = typeof error.name === 'string' ? error.name : 'Error';
  const message = String(error.message ?? error).slice(0, MAX_ERROR_LENGTH);
  // `codeName` is MongoDB's stable, non-sensitive classification.
  const code = error.codeName || (typeof error.code === 'number' ? error.code : null);
  return {name, message, ...(code ? {code: String(code)} : {})};
}

/**
 * P2H.1 — counters PLUS the state and timestamps an operator needs.
 *
 * The counters alone could not answer "is it running?" or "how long has it
 * been down?" — probed before this change: after a failure the stats read
 * `errors: 1` and nothing else, with no timestamp and no state.
 *
 * Deliberately carries NO tenant, subscription or plan data. This is process
 * health, and the endpoint that exposes it must not become a side channel
 * into the billing collections it watches.
 */
export const billingStreamStats = {
  started: 0,
  events: 0,
  subscriptionEvents: 0,
  planEvents: 0,
  errors: 0,
  closed: 0,
  restarts: 0,
  /** P2H.2 — automatic recovery activity, distinct from manual restarts. */
  reArmScheduled: 0,
  reArmAttempts: 0,
  reArmRecoveries: 0,
  /** ISO instants, or null when the thing has never happened. */
  startedAt: null,
  lastEventAt: null,
  lastErrorAt: null,
  stoppedAt: null,
  /** Sanitised — see `describeStreamError`. Never a stack. */
  lastError: null
};

export function billingStreamActive() {
  return Boolean(stream);
}

/**
 * Test seam: the live cursor, so a test can emit on the listener the driver
 * actually wired up.
 *
 * Added because a mutation survived that dropped the error argument from
 * `stream.on('error', ...)`. My first attempt to kill it built a SEPARATE
 * watcher and attached its own listener — which tested the test, not the
 * module. Reaching the real cursor is the only honest way to assert that
 * wiring.
 */
export function __billingStreamCursor() {
  return stream;
}

/** Test seam: makes the counters assertable from a clean slate. */
export function __resetBillingStreamStats() {
  for (const key of Object.keys(billingStreamStats)) {
    billingStreamStats[key] = typeof billingStreamStats[key] === 'number' ? 0 : null;
  }
  // P2H.2 — a leftover retry timer from one test firing inside another is
  // exactly the kind of thing that produces an unreproducible red build.
  reArm.reset();
  reArm.setEnabled(true);
}

/**
 * A health snapshot for operators.
 *
 * WHY "QUIET" IS NOT "UNHEALTHY". A stream that has seen no events for two
 * hours is perfectly healthy if nobody edited a subscription for two hours —
 * billing changes are rare by nature. Inventing a heartbeat requirement would
 * manufacture false alarms and teach an operator to ignore this.
 *
 * So the health signal is the one that actually matters: IS THE CURSOR OPEN.
 * `lastEventAt` is reported for context, never as a liveness test.
 *
 * `degradedForMs` is the useful derived number — how long the process has been
 * falling back to the 30s TTL — and is null while healthy.
 */
export function billingStreamHealth({now = Date.now()} = {}) {
  const running = billingStreamActive();
  const since = billingStreamStats.stoppedAt || billingStreamStats.lastErrorAt;
  return {
    running,
    /**
     * `healthy` is true when the stream is open. A process that never started
     * one — a deployment where `startBillingChangeStream()` was never called,
     * or refused — is NOT healthy, because its entitlement invalidation is
     * silently TTL-bound.
     */
    healthy: running,
    startedAt: billingStreamStats.startedAt,
    lastEventAt: billingStreamStats.lastEventAt,
    lastErrorAt: billingStreamStats.lastErrorAt,
    stoppedAt: billingStreamStats.stoppedAt,
    lastError: billingStreamStats.lastError,
    restarts: billingStreamStats.restarts,
    errors: billingStreamStats.errors,
    events: billingStreamStats.events,
    subscriptionEvents: billingStreamStats.subscriptionEvents,
    planEvents: billingStreamStats.planEvents,
    /** Milliseconds since the stream stopped or failed; null while running. */
    degradedForMs: running || !since ? null : Math.max(0, now - Date.parse(since)),
    /**
     * P2H.2 — is the process trying to fix itself, and when next?
     *
     * `recovering` distinguishes "degraded and working on it" from "degraded
     * and giving up", which is the difference between an operator watching and
     * an operator intervening.
     */
    recovering: reArm.pending,
    nextRetryAt: reArm.nextAt,
    retryAttempt: reArm.attempts,
    reArmEnabled: reArm.enabled,
    reArmScheduled: billingStreamStats.reArmScheduled,
    reArmAttempts: billingStreamStats.reArmAttempts,
    reArmRecoveries: billingStreamStats.reArmRecoveries,
    /**
     * What a degraded process actually falls back to, stated so an operator
     * reading this does not have to know the internals to judge severity.
     */
    fallback: 'entitlement cache TTL (30s)'
  };
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
export function __handleStreamFailure(failed, error) {
  billingStreamStats.errors += 1;
  // P2H.1 — WHEN it failed and WHY, so a degraded process is diagnosable
  // without attaching a debugger to it.
  billingStreamStats.lastErrorAt = new Date().toISOString();
  billingStreamStats.lastError = describeStreamError(error);

  // Only surrender the module handle if the failing stream is the current one;
  // a late error from an already-replaced stream must not kill a healthy one.
  const wasCurrent = !failed || failed === stream;

  /**
   * P2H.2 — CLOSE THE CURSOR WE ARE ABANDONING, not just the one we were
   * handed.
   *
   * A REAL DEFECT, MEASURED. This previously closed only `failed`. Called as
   * `__handleStreamFailure(null, error)` — which is how a caller reports "the
   * stream is gone" without a handle — `failed` is null, so NOTHING was
   * closed while `stream` was still set to a live cursor. Automatic re-arming
   * then opened a second one on top of it.
   *
   * Probed across three failure/recovery cycles: four distinct cursor objects,
   * every one reporting `closed: false`, and a single plan insert delivered
   * THREE events. Before re-arming existed the leak was invisible, because
   * nothing reopened a stream automatically.
   *
   * Closing the abandoned cursor is what makes "one process, one watcher"
   * true.
   */
  const abandoned = wasCurrent ? (failed || stream) : failed;
  try { abandoned?.close?.(); } catch { /* already gone */ }

  if (wasCurrent) stream = null;
  try { invalidateEntitlements(); } catch { /* nothing to drop */ }

  /**
   * P2H.2 — only a failure that actually took the live cursor down schedules
   * recovery.
   *
   * A LATE ERROR FROM AN ALREADY-REPLACED CURSOR must not. P2G.6 established
   * that such an error is recorded but does not kill the healthy stream, and
   * scheduling a re-arm for it would tear down a working watcher to replace
   * it — manufacturing an outage out of a stale event.
   */
  if (wasCurrent) scheduleReArm();
}

/**
 * Route one change event to the cache, never letting a handler throw.
 *
 * A throwing listener would take the watcher down with it, so one bad event
 * would degrade every future invalidation instead of just its own.
 */
export function __handleStreamEvent(event) {
  billingStreamStats.events += 1;
  // Context only. Deliberately NOT a liveness signal — see
  // `billingStreamHealth()` on why a quiet stream is not an unhealthy one.
  billingStreamStats.lastEventAt = new Date().toISOString();
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
    /**
     * P2H.1 — RECOVERY IS RECORDED, not just failure. `startedAt` moves to the
     * new start and the previous failure is cleared, so the snapshot reads as
     * healthy again while `errors`/`restarts` preserve the history.
     */
    billingStreamStats.startedAt = new Date().toISOString();
    billingStreamStats.stoppedAt = null;
    billingStreamStats.lastError = null;
    billingStreamStats.lastErrorAt = null;
    // P2H.2 — recovery succeeded, so the ladder starts from the bottom next
    // time. Without this a stream that recovers and later fails once would
    // wait the maximum delay instead of one second.
    reArm.reset();

    const watched = stream;
    /**
     * P2H.3 — the cursor's construction can reject ASYNCHRONOUSLY.
     *
     * Measured on the role stream while building automatic recovery: when the
     * driver cannot reach MongoDB the failure does not throw out of `watch()`,
     * it surfaces later as an unhandled rejection the surrounding try/catch
     * never sees — one per retry under re-arming, and an unhandled rejection
     * can terminate a production process. The billing stream had the same
     * latent flaw; attaching a catch routes it into the normal failure path.
     */
    if (typeof watched?.catch === 'function') {
      watched.catch(error => __handleStreamFailure(watched, error));
    }
    stream.on('change', __handleStreamEvent);

    // RECOVERY. See `__handleStreamFailure` — the handle is surrendered so a
    // restart can rebuild it, and the cache is dropped because changes made
    // while the stream is down are never delivered.
    stream.on('error', error => __handleStreamFailure(watched, error));

    /**
     * A fresh watcher has no idea what changed while it was not running —
     * across a restart, a reconnect, or a previous stream error. Clearing on
     * start makes the first post-start read authoritative instead of
     * potentially serving something cached before the gap.
     */
    invalidateEntitlements();
    return true;
  } catch (error) {
    // A watch() MongoDB refuses (not a replica set, no permission) is the most
    // likely reason a deployment silently has no invalidation at all, so it is
    // recorded rather than merely counted.
    billingStreamStats.errors += 1;
    billingStreamStats.lastErrorAt = new Date().toISOString();
    billingStreamStats.lastError = describeStreamError(error);
    stream = null;
    return false;
  } finally {
    starting = false;
  }
}

export async function stopBillingChangeStream() {
  /**
   * P2H.2 — a DELIBERATE stop cancels any pending recovery.
   *
   * Called from the shutdown path. Without this, a process that failed and
   * then began shutting down would have a timer fire mid-teardown and open a
   * fresh cursor against a connection that is closing — resurrecting the very
   * thing shutdown just stopped. The timer is `unref`'d so it cannot hold the
   * process open, but it can still fire before the event loop drains.
   *
   * Done BEFORE the `!stream` early return, so a stop issued while degraded
   * (no cursor, retry pending) still cancels the retry.
   */
  reArm.reset();

  if (!stream) return false;
  const current = stream;
  stream = null;
  billingStreamStats.closed += 1;
  // A deliberate stop is not an error, but it IS the moment the process
  // stopped invalidating, so it anchors `degradedForMs` as a failure does.
  billingStreamStats.stoppedAt = new Date().toISOString();
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
