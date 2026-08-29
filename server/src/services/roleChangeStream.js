import mongoose from 'mongoose';
import {Role} from '../models/index.js';
import {invalidateAllRoles, invalidateRole} from './principalCache.js';
import {createReArm, parseBackoff} from './streamReArm.js';

/**
 * Cross-instance role-cache invalidation via a MongoDB change stream.
 *
 * The role cache is per-process, so an edit made on instance A would otherwise
 * take up to one TTL (5s) to be noticed by instance B. This closes that
 * window WITHOUT adding infrastructure:
 *
 *   • Change streams need a replica set or sharded cluster.
 *   • This deployment already REQUIRES one — `verifyTransactionCapableDatabase()`
 *     refuses to start otherwise, because purchasing uses transactions.
 *
 * So the seam already exists and is already a hard dependency; no Redis is
 * introduced to paper over the problem. Every API instance watches the `roles`
 * collection and drops its cached copy when a role document changes anywhere.
 *
 * HONEST SCOPE — what this does and does not guarantee:
 *
 *   • It covers ROLE DEFINITION changes only, which is all that is cached.
 *     User state (active, role, sessionVersion) is read live on every request
 *     and was never cached, so it needs no propagation.
 *   • It is best-effort. If the stream drops, the 5-second TTL remains the
 *     backstop and correctness still holds — propagation just returns to
 *     being TTL-bounded rather than immediate.
 *   • Cross-instance behaviour is NOT verified by the test suite: the harness
 *     runs a single API process against a single-node replica set. What IS
 *     tested is that the watcher starts, that an out-of-band role write
 *     invalidates this process's cache through the stream, and that it shuts
 *     down cleanly. The multi-instance claim is therefore stated as designed,
 *     not as proven.
 */

let stream = null;
let starting = false;

/**
 * P2H.3 — recovery counters alongside the originals.
 *
 * The role stream had exactly the failure mode P2H.2 fixed for billing: a
 * non-resumable MongoDB error killed the cursor permanently, and the only
 * recovery was a process restart. Meanwhile the role cache silently fell back
 * to its 5s TTL, so a permission change on one instance took a TTL to reach
 * the others instead of milliseconds.
 */
export const roleStreamStats = {
  started: 0,
  events: 0,
  errors: 0,
  closed: 0,
  reArmScheduled: 0,
  reArmAttempts: 0,
  reArmRecoveries: 0
};

export function roleStreamActive() {
  return Boolean(stream);
}

/**
 * Automatic recovery, on the SAME controller the billing stream uses.
 *
 * Deliberately not a second retry implementation — `services/streamReArm.js`
 * owns the bounded ladder, the single-flight guarantee and the `unref`'d
 * timer, so a fix to one stream's recovery is a fix to both.
 */
const reArm = createReArm({
  backoff: () => parseBackoff(process.env.ROLE_STREAM_BACKOFF_MS),
  isHealthy: () => Boolean(stream),
  start: () => startRoleChangeStream(),
  onScheduled: () => { roleStreamStats.reArmScheduled += 1; },
  onAttempt: () => { roleStreamStats.reArmAttempts += 1; },
  onRecovered: () => { roleStreamStats.reArmRecoveries += 1; }
});

/** Test/ops seam: turn automatic recovery off without touching the stream. */
export function __setRoleReArmEnabled(value) {
  return reArm.setEnabled(value);
}

/** Test seam: the live cursor, so a test can drive the real error listener. */
export function __roleStreamCursor() {
  return stream;
}

/** Test seam: a clean slate for counters and pending recovery. */
export function __resetRoleStreamStats() {
  for (const key of Object.keys(roleStreamStats)) roleStreamStats[key] = 0;
  reArm.reset();
  reArm.setEnabled(true);
}

/**
 * Health for operators, mirroring the billing snapshot's shape.
 *
 * A QUIET STREAM IS NOT AN UNHEALTHY ONE — role edits are rare, so the verdict
 * is whether the cursor is open, exactly as P2H.1 argued for billing.
 */
export function roleStreamHealth() {
  const running = Boolean(stream);
  return {
    running,
    healthy: running,
    recovering: reArm.pending,
    nextRetryAt: reArm.nextAt,
    retryAttempt: reArm.attempts,
    reArmEnabled: reArm.enabled,
    ...roleStreamStats,
    fallback: 'role cache TTL (5s)'
  };
}

/**
 * Handle a failure of the role cursor.
 *
 * Exported as a test seam for the same reason billing needed one: a real
 * `error` event is hard to provoke deterministically, and P2G.6 proved that an
 * untested failure path is an unprotected one.
 */
export function __handleRoleStreamFailure(failed, error) {
  roleStreamStats.errors += 1;

  // A late error from an ALREADY-REPLACED cursor must not kill the live one.
  const wasCurrent = !failed || failed === stream;

  /**
   * Close the cursor being ABANDONED, not merely the one handed in.
   *
   * This is the P2H.2 cursor leak, avoided here rather than rediscovered.
   * Called as `__handleRoleStreamFailure(null, err)` the `failed` argument is
   * null, so closing only that would abandon a still-open cursor and automatic
   * re-arming would stack a second watcher on top of it.
   */
  const abandoned = wasCurrent ? (failed || stream) : failed;
  try { abandoned?.close?.(); } catch { /* already gone */ }

  if (wasCurrent) stream = null;

  /**
   * Drop the cache on the way down. While the stream is dead this process
   * cannot hear about role edits elsewhere, so anything cached before the
   * failure may already be stale; the 5s TTL then governs, as it always did.
   */
  try { invalidateAllRoles(); } catch { /* nothing to drop */ }

  // Only a failure that actually took the live cursor down schedules recovery.
  if (wasCurrent) reArm.schedule();
}

/**
 * Begin watching. Safe to call more than once; a failure is logged and
 * swallowed, because losing the optimisation must never stop the API booting.
 */
export async function startRoleChangeStream() {
  if (stream || starting) return false;
  starting = true;
  try {
    const connection = mongoose.connection;
    if (!connection?.db) return false;
    // A single-node replica set supports change streams, so this works in the
    // test harness as well as in production.
    stream = Role.watch([], {fullDocument: 'updateLookup'});
    const watched = stream;
    /**
     * P2H.3 — `Role.watch()` returns a cursor whose construction can reject
     * ASYNCHRONOUSLY.
     *
     * Measured: when the driver cannot reach MongoDB, the failure does not
     * throw out of this call — it surfaces later as an unhandled rejection on
     * the cursor, which the surrounding try/catch never sees. Under automatic
     * re-arming that produced one unhandled rejection PER retry, and in a
     * production process an unhandled rejection can terminate the API.
     *
     * Attaching a catch converts it into the ordinary failure path, so the
     * retry ladder handles it like any other error.
     */
    if (typeof watched?.catch === 'function') {
      watched.catch(error => __handleRoleStreamFailure(watched, error));
    }
    roleStreamStats.started += 1;
    // P2H.3 — recovery succeeded, so the ladder starts from the bottom next
    // time. Without this a stream that recovers, runs for a week and fails
    // once would wait the maximum delay instead of one second.
    reArm.reset();

    stream.on('change', event => {
      roleStreamStats.events += 1;
      const doc = event.fullDocument;
      const restaurant = doc?.restaurant ?? event.documentKey?.restaurant;
      const key = doc?.key;
      // A delete carries no fullDocument, so the specific key is unknown and
      // the whole (bounded) cache is cleared instead. Clearing is cheap and
      // cannot be incomplete, which matters more than precision here.
      if (restaurant && key) invalidateRole(restaurant, key);
      else invalidateAllRoles();
    });

    // P2H.3 — the failure path now records, closes the abandoned cursor and
    // schedules a bounded recovery. `watched` is captured so a late error from
    // this cursor cannot kill whatever replaced it.
    stream.on('error', error => __handleRoleStreamFailure(watched, error));

    return true;
  } catch {
    // A watch() MongoDB refuses (not a replica set, no permission) is the most
    // likely reason a deployment has no role invalidation at all.
    roleStreamStats.errors += 1;
    stream = null;
    return false;
  } finally {
    starting = false;
  }
}

export async function stopRoleChangeStream() {
  /**
   * P2H.3 — a DELIBERATE stop cancels any pending recovery.
   *
   * Called from the shutdown path. Without this a process that failed and then
   * began shutting down would have a timer fire mid-teardown and open a fresh
   * cursor against a closing connection — resurrecting what shutdown just
   * stopped. Done BEFORE the early return so a stop issued while degraded
   * still cancels the retry.
   */
  reArm.reset();

  if (!stream) return false;
  const current = stream;
  stream = null;
  roleStreamStats.closed += 1;
  try { await current.close(); } catch { /* already closed */ }
  return true;
}
