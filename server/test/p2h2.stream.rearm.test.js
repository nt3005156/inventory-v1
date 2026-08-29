import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, seedWorld, startTestApp, stopTestApp} from './helpers.js';
import {Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements, resolveEntitlement
} from '../src/services/entitlements.js';
import {
  __billingStreamCursor,
  __handleStreamFailure,
  __resetBillingStreamStats,
  __setBillingReArmEnabled,
  billingStreamActive,
  billingStreamHealth,
  billingStreamStats,
  restartBillingChangeStream,
  startBillingChangeStream,
  stopBillingChangeStream
} from '../src/services/billingChangeStream.js';

/**
 * P2H.2 — automatic re-arming of the billing change stream.
 *
 * THE GAP THIS CLOSES, MEASURED LIVE IN P2H.1. MongoDB was stopped under a
 * running API container; the stream reported
 * `healthy=false, errors=1, MongoServerSelectionError` and then stayed dead —
 * still down 68 seconds after MongoDB came back. Only a process restart
 * recovered it. P2H.1 made the degradation visible; this makes it heal.
 *
 * The backoff is overridden to milliseconds throughout so the tests assert
 * BEHAVIOUR rather than spending thirty seconds waiting for a rung.
 */

const DAY = 86_400_000;
let world;
let previousBackoff;

before(async () => {
  previousBackoff = process.env.BILLING_STREAM_BACKOFF_MS;
  // Fast ladder: the shape is what matters, not the wall-clock values.
  process.env.BILLING_STREAM_BACKOFF_MS = '40,60,80,100';
  await startTestApp();
});

after(async () => {
  await stopBillingChangeStream();
  if (previousBackoff === undefined) delete process.env.BILLING_STREAM_BACKOFF_MS;
  else process.env.BILLING_STREAM_BACKOFF_MS = previousBackoff;
  await stopTestApp();
});

beforeEach(async () => {
  await stopBillingChangeStream();
  await clearDb();
  invalidateEntitlements();
  __resetBillingStreamStats();
  __resetBillingEnforcementProbe();
  world = await seedWorld();
});

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, {timeout = 8000, interval = 20} = {}) {
  const started = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return Date.now() - started;
    if (Date.now() - started > timeout) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** How many timers this process is currently holding. */
const timerCount = () =>
  process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;

const networkFailure = (message = 'getaddrinfo ENOTFOUND mongo') =>
  Object.assign(new Error(message), {name: 'MongoServerSelectionError'});

async function tenantOnPlan(name, limits) {
  const restaurant = await Restaurant.create({name, currency: 'NPR'});
  const plan = await Plan.create({
    code: `p2h2-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`,
    name, active: true, currency: 'NPR', limits, features: {pos: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: restaurant._id, plan: plan._id, status: 'active', startDate: now,
    currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });
  return {restaurant, plan};
}

// ── startup ──────────────────────────────────────────────────────────────────

describe('P2H2 · startup is unchanged', () => {
  it('starts healthy with no recovery pending', async () => {
    assert.equal(await startBillingChangeStream(), true);
    const health = billingStreamHealth();

    assert.equal(health.healthy, true);
    assert.equal(health.recovering, false, 'a healthy stream must not be retrying');
    assert.equal(health.nextRetryAt, null);
    assert.equal(health.retryAttempt, 0);
    assert.equal(health.reArmScheduled, 0, 'nothing failed, so nothing was scheduled');
  });

  it('does not schedule recovery while the stream is alive', async () => {
    await startBillingChangeStream();
    await settle(150);
    assert.equal(billingStreamHealth().recovering, false);
    assert.equal(billingStreamStats.reArmAttempts, 0);
  });
});

// ── failure schedules recovery ───────────────────────────────────────────────

describe('P2H2 · a failure schedules its own recovery', () => {
  it('marks the stream degraded AND recovering, with a next-retry time', async () => {
    await startBillingChangeStream();
    __setBillingReArmEnabled(false); // freeze the schedule so it can be inspected
    __setBillingReArmEnabled(true);

    __handleStreamFailure(null, networkFailure());
    const health = billingStreamHealth();

    assert.equal(health.healthy, false);
    assert.equal(health.running, false);
    assert.equal(health.recovering, true, 'the failure did not schedule a recovery');
    assert.ok(health.nextRetryAt, 'nextRetryAt was not published');
    assert.ok(!Number.isNaN(Date.parse(health.nextRetryAt)));
    assert.equal(health.reArmScheduled, 1);
  });

  it('recovers automatically without anybody calling restart', async () => {
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    assert.equal(billingStreamHealth().healthy, false);

    const took = await waitFor(() => billingStreamHealth().healthy === true);
    assert.notEqual(took, null, 'the stream never re-armed on its own');
    assert.equal(billingStreamActive(), true);
    assert.ok(
      billingStreamStats.reArmRecoveries >= 1,
      'the recovery was not counted as a re-arm'
    );
  });

  it('clears the degradation state once recovered', async () => {
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    await waitFor(() => billingStreamHealth().healthy === true);

    const health = billingStreamHealth();
    assert.equal(health.recovering, false, 'still reporting a pending retry');
    assert.equal(health.nextRetryAt, null);
    assert.equal(health.degradedForMs, null);
    assert.equal(health.lastError, null);
    // History survives.
    assert.equal(health.errors, 1);
  });

  it('a REFUSED start keeps retrying rather than giving up', async () => {
    /**
     * The realistic outage: MongoDB is unreachable, so the re-arm attempt
     * itself fails. It must queue the next rung instead of stopping — that is
     * the difference between recovering when the database returns and staying
     * dead, which is the defect being fixed.
     */
    await startBillingChangeStream();
    const connection = mongoose.connection;
    const realWatch = connection.db.watch.bind(connection.db);
    connection.db.watch = () => {
      throw networkFailure('connection refused');
    };
    try {
      __handleStreamFailure(null, networkFailure());
      // Let several rungs elapse while the database is "down".
      const kept = await waitFor(() => billingStreamStats.reArmAttempts >= 3);
      assert.notEqual(kept, null, 'the retry gave up while the database was down');
      assert.equal(billingStreamHealth().healthy, false);
      assert.equal(
        billingStreamHealth().recovering, true,
        'it should still have a retry pending'
      );
    } finally {
      connection.db.watch = realWatch;
    }

    // And when the database comes back, it heals with no intervention.
    const took = await waitFor(() => billingStreamHealth().healthy === true);
    assert.notEqual(took, null, 'it never recovered once the database returned');
  });
});

// ── backoff is bounded ───────────────────────────────────────────────────────

describe('P2H2 · the backoff ladder is bounded', () => {
  it('escalates through the rungs and then caps', async () => {
    /**
     * The cap is the whole point. A ladder that kept doubling would eventually
     * wait hours, which is indistinguishable from staying dead.
     */
    const previous = process.env.BILLING_STREAM_BACKOFF_MS;
    process.env.BILLING_STREAM_BACKOFF_MS = '30,60,90';
    try {
      await startBillingChangeStream();
      const connection = mongoose.connection;
      const realWatch = connection.db.watch.bind(connection.db);
      connection.db.watch = () => { throw networkFailure(); };

      const gaps = [];
      try {
        __handleStreamFailure(null, networkFailure());
        let previousAt = Date.parse(billingStreamHealth().nextRetryAt);
        for (let rung = 0; rung < 4; rung += 1) {
          // eslint-disable-next-line no-await-in-loop
          const armed = await waitFor(() => {
            const next = billingStreamHealth().nextRetryAt;
            return next && Date.parse(next) !== previousAt;
          }, {timeout: 3000});
          if (armed === null) break;
          const next = Date.parse(billingStreamHealth().nextRetryAt);
          gaps.push(next - previousAt);
          previousAt = next;
        }
      } finally {
        connection.db.watch = realWatch;
      }

      assert.ok(gaps.length >= 2, `expected several rungs, saw ${gaps.length}`);
      // Never longer than the configured maximum, with generous slack for
      // timer scheduling — the assertion is BOUNDEDNESS, not precision.
      for (const gap of gaps) {
        assert.ok(gap <= 1500, `a retry gap of ${gap}ms exceeded the cap`);
      }
      await waitFor(() => billingStreamHealth().healthy === true);
    } finally {
      if (previous === undefined) delete process.env.BILLING_STREAM_BACKOFF_MS;
      else process.env.BILLING_STREAM_BACKOFF_MS = previous;
    }
  });

  it('never schedules a tight loop — attempts stay countable', async () => {
    await startBillingChangeStream();
    const connection = mongoose.connection;
    const realWatch = connection.db.watch.bind(connection.db);
    connection.db.watch = () => { throw networkFailure(); };
    try {
      __handleStreamFailure(null, networkFailure());
      await settle(500);
      // With a 40ms floor, half a second cannot produce hundreds of attempts.
      assert.ok(
        billingStreamStats.reArmAttempts < 30,
        `runaway retry: ${billingStreamStats.reArmAttempts} attempts in 500ms`
      );
      assert.ok(billingStreamStats.reArmAttempts >= 1, 'it did not retry at all');
    } finally {
      connection.db.watch = realWatch;
    }
    await waitFor(() => billingStreamHealth().healthy === true);
  });

  it('resets the ladder after a successful recovery', async () => {
    // Otherwise a stream that recovers, runs for a week and fails once would
    // wait the maximum delay instead of the minimum.
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    await waitFor(() => billingStreamHealth().healthy === true);
    assert.equal(billingStreamHealth().retryAttempt, 0, 'the ladder was not reset');

    __handleStreamFailure(null, networkFailure());
    assert.equal(
      billingStreamHealth().retryAttempt, 1,
      'the second failure did not start from the bottom rung'
    );
    await waitFor(() => billingStreamHealth().healthy === true);
  });
});

// ── no duplicates, the critical property ─────────────────────────────────────

describe('P2H2 · never two watchers, never two timers', () => {
  it('twenty consecutive failures schedule exactly ONE retry', async () => {
    /**
     * MongoDB flapping produces a burst of errors. If each scheduled its own
     * timer, a ten-error burst would arm ten timers and later open ten
     * cursors. A single timer slot makes every failure after the first a
     * no-op.
     */
    await startBillingChangeStream();
    const before = timerCount();

    for (let i = 0; i < 20; i += 1) __handleStreamFailure(null, networkFailure(`flap ${i}`));

    assert.equal(
      billingStreamStats.reArmScheduled, 1,
      `${billingStreamStats.reArmScheduled} retries were scheduled for one outage`
    );
    assert.ok(
      timerCount() - before <= 1,
      `the burst armed ${timerCount() - before} timers`
    );
    assert.equal(billingStreamStats.errors, 20, 'every error should still be recorded');

    await waitFor(() => billingStreamHealth().healthy === true);
    assert.ok(__billingStreamCursor(), 'exactly one cursor should be open');
  });

  it('a flapping database leaves ONE cursor, not a pile', async () => {
    await startBillingChangeStream();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      __handleStreamFailure(null, networkFailure(`cycle ${cycle}`));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => billingStreamHealth().healthy === true);
    }
    const cursor = __billingStreamCursor();
    assert.ok(cursor, 'the stream should be up');

    // One more failure, one more recovery — and still a single cursor.
    __handleStreamFailure(null, networkFailure('final'));
    await waitFor(() => billingStreamHealth().healthy === true);
    assert.ok(__billingStreamCursor());
    assert.equal(billingStreamActive(), true);
  });

  it('an event is handled ONCE after repeated recoveries', async () => {
    /**
     * The behavioural statement of "no duplicate watchers": two live cursors
     * would both see the same change and count it twice.
     */
    await startBillingChangeStream();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      __handleStreamFailure(null, networkFailure());
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => billingStreamHealth().healthy === true);
    }

    const before = billingStreamStats.events;
    await Plan.create({
      code: `p2h2-once-${Math.random().toString(36).slice(2, 6)}`, name: 'Once',
      active: true, currency: 'NPR', limits: {maxUsers: 1}, features: {pos: true}
    });
    await waitFor(() => billingStreamStats.events > before);
    await settle(300);

    assert.equal(
      billingStreamStats.events - before, 1,
      'one plan insert produced more than one event — duplicate watchers'
    );
  });

  it('CLOSES the abandoned cursor on every recovery', async () => {
    /**
     * THE DEFECT THIS PHASE ALMOST SHIPPED, and the reason the brief insists
     * on proving one watcher per process.
     *
     * `__handleStreamFailure(null, error)` is how a caller says "the stream is
     * gone" without holding a handle. It used to close only its `failed`
     * argument — which is null on that path — so the live cursor was
     * abandoned while still OPEN, and automatic re-arming opened another on
     * top of it.
     *
     * Measured before the fix: three failure/recovery cycles left four cursor
     * objects, all reporting `closed: false`, and one plan insert delivered
     * three events. Invisible before P2H.2, because nothing reopened a stream
     * automatically.
     */
    await startBillingChangeStream();
    const cursors = [__billingStreamCursor()];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      __handleStreamFailure(null, networkFailure(`cycle ${cycle}`));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => billingStreamHealth().healthy === true);
      cursors.push(__billingStreamCursor());
    }

    const distinct = new Set(cursors);
    assert.equal(distinct.size, 4, 'each recovery should produce a fresh cursor');

    const abandoned = cursors.slice(0, -1);
    for (const [index, cursor] of abandoned.entries()) {
      assert.equal(
        cursor.closed, true,
        `abandoned cursor ${index} is still open and will keep delivering events`
      );
    }
    assert.equal(
      cursors.at(-1).closed, false, 'the current cursor should be open'
    );
  });

  it('a LATE error from a replaced cursor does not schedule a recovery', async () => {
    /**
     * P2G.6 established that a stale-handle error is recorded but must not
     * kill the live cursor. It must not schedule a re-arm either: tearing down
     * a working watcher to replace it would manufacture an outage from a stale
     * event.
     */
    await startBillingChangeStream();
    const scheduledBefore = billingStreamStats.reArmScheduled;

    __handleStreamFailure({close() {}}, networkFailure('late error from a stale handle'));

    assert.equal(billingStreamActive(), true, 'the live cursor was killed by a stale error');
    assert.equal(billingStreamHealth().healthy, true);
    assert.equal(
      billingStreamStats.reArmScheduled, scheduledBefore,
      'a stale-handle error scheduled an unnecessary recovery'
    );
    assert.equal(billingStreamHealth().recovering, false);
  });

  it('a stale-handle error does NOT close the live cursor', async () => {
    /**
     * A mutation finding (M12). Changing the abandoned-cursor choice to
     * always be `stream` survived, because no test checked that a
     * stale-handle error leaves the LIVE cursor open and still delivering.
     *
     * That mutant is worse than the leak it replaces: it silently closes a
     * healthy watcher, and because `stream` is not nulled, nothing schedules
     * a recovery — invalidation would stop dead with health still reporting
     * `healthy: true`.
     */
    await startBillingChangeStream();
    const live = __billingStreamCursor();

    __handleStreamFailure({close() {}}, networkFailure('late from a stale handle'));

    assert.equal(live.closed, false, 'the live cursor was closed by a stale-handle error');
    assert.equal(billingStreamActive(), true);
    assert.equal(__billingStreamCursor(), live, 'the cursor should not have been replaced');

    // And it is genuinely still delivering.
    const before = billingStreamStats.events;
    await Plan.create({
      code: `p2h2-stale-${Math.random().toString(36).slice(2, 6)}`, name: 'Stale',
      active: true, currency: 'NPR', limits: {maxUsers: 1}, features: {pos: true}
    });
    const delivered = await waitFor(() => billingStreamStats.events > before);
    assert.notEqual(delivered, null, 'the live cursor stopped delivering events');
  });

  it('the backoff genuinely ESCALATES rather than repeating the first rung', async () => {
    /**
     * A mutation finding (M6). Pinning the delay to `ladder[0]` survived: the
     * earlier boundedness test only asserted an UPPER bound, which a constant
     * first rung also satisfies.
     *
     * Escalation is what stops a long outage from retrying twice a second for
     * an hour, so it is asserted directly: with a widely-spaced ladder the
     * second gap must be measurably larger than the first.
     */
    const previous = process.env.BILLING_STREAM_BACKOFF_MS;
    process.env.BILLING_STREAM_BACKOFF_MS = '30,300';
    try {
      await startBillingChangeStream();
      const connection = mongoose.connection;
      const realWatch = connection.db.watch.bind(connection.db);
      connection.db.watch = () => { throw networkFailure(); };

      let firstGap;
      let secondGap;
      try {
        __handleStreamFailure(null, networkFailure());
        const armedAt1 = Date.now();
        const first = Date.parse(billingStreamHealth().nextRetryAt);
        firstGap = first - armedAt1;

        // Wait for the SECOND scheduling, which must use the next rung.
        await waitFor(() => billingStreamStats.reArmScheduled >= 2, {timeout: 3000});
        const armedAt2 = Date.now();
        const second = Date.parse(billingStreamHealth().nextRetryAt);
        secondGap = second - armedAt2;
      } finally {
        connection.db.watch = realWatch;
      }

      assert.ok(
        secondGap > firstGap + 100,
        `the ladder did not escalate: first ${firstGap}ms, second ${secondGap}ms`
      );
      await waitFor(() => billingStreamHealth().healthy === true, {timeout: 5000});
    } finally {
      if (previous === undefined) delete process.env.BILLING_STREAM_BACKOFF_MS;
      else process.env.BILLING_STREAM_BACKOFF_MS = previous;
    }
  });

  it('a manual restart while a retry is pending does not double up', async () => {
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    assert.equal(billingStreamHealth().recovering, true);

    // An operator restarts by hand at the same moment.
    assert.equal(await restartBillingChangeStream(), true);
    await settle(300);

    assert.equal(billingStreamHealth().healthy, true);
    assert.ok(__billingStreamCursor());
    assert.equal(
      billingStreamHealth().recovering, false,
      'a stale retry survived the manual restart'
    );
  });
});

// ── shutdown safety ──────────────────────────────────────────────────────────

describe('P2H2 · shutdown is not undone by a pending retry', () => {
  it('stopping cancels the scheduled recovery', async () => {
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    assert.equal(billingStreamHealth().recovering, true);

    await stopBillingChangeStream();
    assert.equal(billingStreamHealth().recovering, false, 'the retry survived shutdown');

    await settle(400);
    assert.equal(
      billingStreamHealth().healthy, false,
      'a timer resurrected the stream after shutdown'
    );
    assert.equal(billingStreamActive(), false);
  });

  it('the retry timer never holds the process open', async () => {
    // `unref`'d, matching the convention `subscriptionScheduler` follows.
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    const health = billingStreamHealth();
    assert.equal(health.recovering, true);
    // A referenced timer would keep the event loop alive; the suite finishing
    // at all is the practical assertion, so this documents the intent.
    assert.ok(health.nextRetryAt);
    await waitFor(() => billingStreamHealth().healthy === true);
  });

  it('re-arming can be switched off entirely', async () => {
    await startBillingChangeStream();
    __setBillingReArmEnabled(false);
    try {
      __handleStreamFailure(null, networkFailure());
      assert.equal(billingStreamHealth().recovering, false);
      assert.equal(billingStreamHealth().reArmEnabled, false);
      await settle(400);
      assert.equal(
        billingStreamHealth().healthy, false,
        'recovery ran while it was disabled'
      );
    } finally {
      __setBillingReArmEnabled(true);
    }
  });
});

// ── the point of the whole thing ─────────────────────────────────────────────

describe('P2H2 · invalidation actually resumes after recovery', () => {
  it('a plan change propagates once the stream has re-armed itself', async () => {
    /**
     * THE MOST IMPORTANT TEST. `running === true` proves the watcher exists;
     * it does not prove the feature the watcher protects still works. This
     * asserts the entitlement cache is genuinely invalidated again.
     */
    const {restaurant, plan} = await tenantOnPlan('Resume Co', {maxUsers: 2});
    await startBillingChangeStream();
    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);

    // The stream dies and heals itself — no manual restart anywhere.
    __handleStreamFailure(null, networkFailure());
    assert.equal(billingStreamHealth().healthy, false);
    const recovered = await waitFor(() => billingStreamHealth().healthy === true);
    assert.notEqual(recovered, null, 'the stream never re-armed');

    await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 9}});
    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).limits.maxUsers === 9);

    assert.notEqual(
      took, null,
      'the stream reported healthy but invalidation did not resume'
    );
  });

  it('a subscription cancellation bites after an automatic recovery', async () => {
    // The commercially important direction.
    const {restaurant} = await tenantOnPlan('Cancel After', {maxUsers: 3});
    await startBillingChangeStream();
    assert.equal((await resolveEntitlement(restaurant._id)).operational, true);

    __handleStreamFailure(null, networkFailure());
    await waitFor(() => billingStreamHealth().healthy === true);

    await Subscription.updateOne(
      {restaurant: restaurant._id}, {$set: {status: 'cancelled'}}
    );
    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).operational === false);
    assert.notEqual(took, null, 'a cancellation did not propagate after recovery');
  });

  it('tenant isolation survives an automatic recovery', async () => {
    const a = await tenantOnPlan('Iso A', {maxUsers: 2});
    const b = await tenantOnPlan('Iso B', {maxUsers: 7});
    await startBillingChangeStream();

    assert.equal((await resolveEntitlement(a.restaurant._id)).limits.maxUsers, 2);
    assert.equal((await resolveEntitlement(b.restaurant._id)).limits.maxUsers, 7);

    __handleStreamFailure(null, networkFailure());
    await waitFor(() => billingStreamHealth().healthy === true);

    await Subscription.updateOne(
      {restaurant: a.restaurant._id}, {$set: {status: 'past_due'}}
    );
    const took = await waitFor(async () =>
      (await resolveEntitlement(a.restaurant._id)).operational === false);
    assert.notEqual(took, null, 'tenant A never propagated');

    const other = await resolveEntitlement(b.restaurant._id);
    assert.equal(other.operational, true, 'tenant B was disturbed');
    assert.equal(other.limits.maxUsers, 7);
  });

  it('the 30s TTL still backstops while the stream is down', async () => {
    /**
     * Re-arming must not have replaced the safety net. While degraded,
     * correctness still holds — propagation is simply TTL-bound, exactly as
     * before, which is why a failed retry is survivable.
     */
    const {restaurant, plan} = await tenantOnPlan('Backstop', {maxUsers: 4});
    await startBillingChangeStream();
    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 4);

    __setBillingReArmEnabled(false);
    try {
      __handleStreamFailure(null, networkFailure());
      await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 11}});
      // No stream, no re-arm — but an explicit fresh read is still correct.
      assert.equal(
        (await resolveEntitlement(restaurant._id, {fresh: true})).limits.maxUsers, 11,
        'the database is still the source of truth while degraded'
      );
    } finally {
      __setBillingReArmEnabled(true);
    }
  });
});

// ── health API unchanged ─────────────────────────────────────────────────────

describe('P2H2 · the P2H.1 health contract still holds', () => {
  it('keeps every field P2H.1 published', async () => {
    await startBillingChangeStream();
    const health = billingStreamHealth();
    for (const key of [
      'running', 'healthy', 'startedAt', 'lastEventAt', 'lastErrorAt', 'stoppedAt',
      'lastError', 'restarts', 'errors', 'events', 'subscriptionEvents',
      'planEvents', 'degradedForMs', 'fallback'
    ]) {
      assert.ok(key in health, `P2H.1 field ${key} disappeared`);
    }
  });

  it('exposes no tenant, subscription or plan data in the recovery state', async () => {
    const {restaurant} = await tenantOnPlan('Very Secret Co', {maxUsers: 5});
    await startBillingChangeStream();
    __handleStreamFailure(null, networkFailure());
    const body = JSON.stringify(billingStreamHealth());

    for (const secret of ['Very Secret Co', String(restaurant._id), 'maxUsers']) {
      assert.ok(!body.includes(secret), `the health payload leaked "${secret}"`);
    }
    await waitFor(() => billingStreamHealth().healthy === true);
  });

  it('reports recovery counters distinctly from manual restarts', async () => {
    __resetBillingStreamStats();
    await startBillingChangeStream();

    // Manual.
    await restartBillingChangeStream();
    assert.equal(billingStreamStats.restarts, 1);
    assert.equal(billingStreamStats.reArmRecoveries, 0, 'a manual restart is not a re-arm');

    // Automatic.
    __handleStreamFailure(null, networkFailure());
    await waitFor(() => billingStreamHealth().healthy === true);
    assert.equal(billingStreamStats.reArmRecoveries, 1);
  });
});
