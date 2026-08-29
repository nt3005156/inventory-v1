/**
 * P2H.3 — the shared automatic-recovery mechanism for MongoDB change streams.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * P2H.2 gave the billing change stream bounded automatic re-arming, and proved
 * it against a real MongoDB outage: dead at t+0, healthy again 7s later with no
 * intervention. The role change stream has exactly the same failure mode and
 * none of the protection.
 *
 * The obvious move — copy the ~130 lines into `roleChangeStream.js` — is the
 * wrong one. Two copies of a retry loop drift: a fix applied to one is silently
 * missing from the other, and the P2H.2 work included a subtle cursor-leak fix
 * that a copy would have to remember to carry. So the machinery is extracted
 * ONCE, here, and both streams use it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ----------------------------------
 * It does not own the cursor, the stats object, or the meaning of "healthy".
 * Those differ between the two streams — billing publishes a rich health
 * snapshot, roles keeps counters — and forcing them into one shape would be a
 * redesign rather than a recovery fix. This owns exactly one thing: WHEN to
 * try again, and the guarantee that only one attempt is ever in flight.
 *
 * THE LADDER, unchanged from P2H.2 because it was measured there:
 *
 *     1s, 2s, 5s, 10s, 30s, then 30s forever
 *
 * The first rungs absorb a momentary blip almost invisibly; the cap means a
 * long outage costs two attempts a minute, which keeps the logs readable and
 * never becomes a busy loop. Escalation that kept doubling would eventually
 * wait hours — indistinguishable from the defect being fixed.
 */

export const DEFAULT_BACKOFF_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

/**
 * Parse a comma-separated override, falling back to the default ladder.
 *
 * Exported so each stream can name its own environment variable while sharing
 * the parsing and the validation.
 */
export function parseBackoff(raw, fallback = DEFAULT_BACKOFF_MS) {
  const value = String(raw || '').trim();
  if (!value) return fallback;
  /**
   * EMPTY SEGMENTS ARE DISCARDED BEFORE CONVERSION.
   *
   * `Number('')` is 0, so a malformed override like `'nonsense,,x'` produced a
   * ladder of `[0]` — a zero-delay retry, i.e. exactly the tight loop the
   * bounded ladder exists to prevent. Measured while testing the parser.
   * Filtering blanks first means garbage falls back to the default instead of
   * silently configuring a busy loop.
   */
  const steps = value.split(',')
    .map(step => step.trim())
    .filter(step => step.length > 0)
    .map(step => Number(step))
    .filter(step => Number.isFinite(step) && step >= 0);
  return steps.length ? Object.freeze(steps) : fallback;
}

/**
 * Build a re-arm controller for one stream.
 *
 * `isHealthy()` reports whether the stream currently has a live cursor, and
 * `start()` attempts to open one and resolves truthy on success. Everything
 * else — the timer, the ladder position, the single-flight guarantee — lives
 * in here.
 */
export function createReArm({backoff, isHealthy, start, onScheduled, onAttempt, onRecovered}) {
  /**
   * Recovery state, deliberately singular.
   *
   * `timer` being non-null is the ONE thing that says "a recovery is already
   * scheduled". Every scheduling path checks it, which is what makes duplicate
   * retry loops impossible.
   */
  const state = {enabled: true, timer: null, attempt: 0, nextAt: null};

  function cancel() {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.nextAt = null;
  }

  /**
   * Forget the retry history after a successful start.
   *
   * Without this a stream that recovers, runs for a week and then fails once
   * would wait the maximum delay instead of retrying in a second.
   */
  function reset() {
    cancel();
    state.attempt = 0;
  }

  /**
   * Schedule ONE recovery attempt.
   *
   * THE DUPLICATE-STREAM GUARD. MongoDB flapping produces a burst of errors,
   * and every one reaches a failure handler. If each scheduled its own timer,
   * a ten-error burst would arm ten timers, all of which would later try to
   * open a cursor. A single timer slot makes every failure after the first a
   * no-op.
   *
   * The `isHealthy()` check matters just as much: a scheduling request while
   * the stream is already up must do nothing, or a stale-handle error would
   * tear down a working watcher to replace it.
   */
  function schedule() {
    if (!state.enabled) return false;
    if (state.timer || isHealthy()) return false;

    const ladder = typeof backoff === 'function' ? backoff() : backoff;
    const delay = ladder[Math.min(state.attempt, ladder.length - 1)];
    state.attempt += 1;
    state.nextAt = new Date(Date.now() + delay).toISOString();
    if (onScheduled) onScheduled();

    state.timer = setTimeout(() => {
      state.timer = null;
      state.nextAt = null;
      /**
       * `void` because a timer callback cannot await, and an unhandled
       * rejection from a recovery attempt must never reach the process.
       * `attempt()` swallows everything itself; this is belt and braces.
       */
      void attempt();
    }, delay);

    // Never hold the process open during shutdown — the convention
    // `subscriptionScheduler` already follows.
    if (typeof state.timer.unref === 'function') state.timer.unref();
    return true;
  }

  /**
   * One recovery attempt. Never throws, never blocks a request path.
   *
   * A failure queues the next rung, so a long outage keeps being retried
   * without ever spinning.
   */
  async function attempt() {
    if (!state.enabled || isHealthy()) return false;
    if (onAttempt) onAttempt();
    let started = false;
    try {
      started = await start();
    } catch {
      // `start` is expected to swallow and record its own failure; this is the
      // last line of defence so a timer can never crash the process.
      started = false;
    }
    if (started) {
      if (onRecovered) onRecovered();
      return true;
    }
    schedule();
    return false;
  }

  return {
    schedule,
    attempt,
    cancel,
    reset,
    setEnabled(value) {
      state.enabled = Boolean(value);
      if (!state.enabled) cancel();
      return state.enabled;
    },
    get enabled() { return state.enabled; },
    get pending() { return Boolean(state.timer); },
    get nextAt() { return state.nextAt; },
    get attempts() { return state.attempt; }
  };
}
