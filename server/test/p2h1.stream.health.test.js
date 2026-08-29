import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {User} from '../src/models/index.js';
import {Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements, resolveEntitlement
} from '../src/services/entitlements.js';
import {startRoleChangeStream, stopRoleChangeStream} from '../src/services/roleChangeStream.js';
import {
  __billingStreamCursor,
  __handleStreamEvent,
  __handleStreamFailure,
  __resetBillingStreamStats,
  billingStreamActive,
  billingStreamHealth,
  billingStreamStats,
  restartBillingChangeStream,
  startBillingChangeStream,
  stopBillingChangeStream
} from '../src/services/billingChangeStream.js';

/**
 * P2H.1 — change-stream health monitoring.
 *
 * THE BLIND SPOT THIS CLOSES, probed before the change: after a stream
 * failure the stats read `{errors: 1, ...}` and nothing else — no timestamp,
 * no state flag, no error detail. A process could sit degraded (silently
 * falling back to the 30s entitlement TTL) for hours and an operator had no
 * way to see it, or to tell it apart from a healthy but quiet stream.
 *
 * P2G.6's mutation run showed the failure path was under-tested, so the
 * failure and recovery transitions are driven explicitly here rather than
 * assumed.
 */

const DAY = 86_400_000;
let world;

before(async () => { await startTestApp(); });
after(async () => {
  await stopBillingChangeStream();
  await stopRoleChangeStream();
  await stopTestApp();
});

beforeEach(async () => {
  await stopBillingChangeStream();
  await stopRoleChangeStream();
  await clearDb();
  invalidateEntitlements();
  __resetBillingStreamStats();
  __resetBillingEnforcementProbe();
  world = await seedWorld();
});

const settle = (ms = 400) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, {timeout = 8000, interval = 50} = {}) {
  const started = Date.now();
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return Date.now() - started;
    if (Date.now() - started > timeout) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}

/** A platform administrator token, for the operational endpoint. */
async function platformToken(platformRole = 'platform_admin') {
  const user = await User.create({
    name: 'Ops', email: `ops-${Math.random().toString(36).slice(2)}@p2h1.test`,
    password: 'x', role: 'owner', restaurantId: world.restaurant._id, platformRole
  });
  return tokenFor(user);
}

const streamHealth = token => request('/api/platform/health/streams', {token});

// ── the state itself ─────────────────────────────────────────────────────────

describe('P2H1 · the health snapshot answers the operator\'s questions', () => {
  it('reports NOT healthy before the stream has ever started', async () => {
    /**
     * A process where `startBillingChangeStream()` was never called, or was
     * refused, has no cross-instance invalidation at all. That is exactly the
     * silent degradation this phase exists to surface, so "never started" is
     * not healthy.
     */
    const health = billingStreamHealth();
    assert.equal(health.running, false);
    assert.equal(health.healthy, false);
    assert.equal(health.startedAt, null);
    assert.equal(health.lastError, null);
    assert.equal(health.degradedForMs, null, 'nothing has failed yet, so nothing to time');
  });

  it('records the start and reports healthy', async () => {
    assert.equal(await startBillingChangeStream(), true);
    const health = billingStreamHealth();

    assert.equal(health.running, true);
    assert.equal(health.healthy, true);
    assert.ok(health.startedAt, 'startedAt was not recorded');
    assert.ok(!Number.isNaN(Date.parse(health.startedAt)), 'startedAt is not an instant');
    assert.equal(health.degradedForMs, null);
    assert.equal(health.restarts, 0);
    assert.equal(health.errors, 0);
  });

  it('a QUIET stream is still healthy — no heartbeat is invented', async () => {
    /**
     * Billing edits are rare. A stream that has seen no events for hours is
     * perfectly healthy if nobody changed a subscription, and inventing a
     * liveness requirement would manufacture false alarms.
     */
    await startBillingChangeStream();
    const health = billingStreamHealth({now: Date.now() + 6 * 60 * 60 * 1000});

    assert.equal(health.lastEventAt, null, 'no events have happened');
    assert.equal(health.healthy, true, 'a quiet stream must not be called unhealthy');
    assert.equal(health.degradedForMs, null);
  });

  it('records lastEventAt as context when events do arrive', async () => {
    await startBillingChangeStream();
    assert.equal(billingStreamHealth().lastEventAt, null);

    await Plan.create({
      code: `p2h1-${Math.random().toString(36).slice(2, 8)}`, name: 'Health',
      active: true, currency: 'NPR', limits: {maxUsers: 2}, features: {pos: true}
    });

    const took = await waitFor(() => billingStreamHealth().lastEventAt !== null);
    assert.notEqual(took, null, 'an event never updated lastEventAt');
    assert.ok(billingStreamHealth().events >= 1);
  });
});

// ── the actual failure path ──────────────────────────────────────────────────

describe('P2H1 · a real stream failure is recorded', () => {
  it('marks the stream unhealthy, timestamps it, and starts the clock', async () => {
    await startBillingChangeStream();
    assert.equal(billingStreamHealth().healthy, true);

    __handleStreamFailure(null, Object.assign(new Error('connection reset by peer'), {
      name: 'MongoNetworkError', codeName: 'HostUnreachable'
    }));

    const health = billingStreamHealth();
    assert.equal(health.running, false);
    assert.equal(health.healthy, false);
    assert.ok(health.lastErrorAt, 'the failure was not timestamped');
    assert.equal(health.errors, 1);
    assert.ok(
      typeof health.degradedForMs === 'number' && health.degradedForMs >= 0,
      'degradedForMs must start counting the moment the stream dies'
    );
  });

  it('captures a diagnosable error WITHOUT dumping the exception', async () => {
    await startBillingChangeStream();
    const error = Object.assign(new Error('not authorized on admin to execute command'), {
      name: 'MongoServerError', codeName: 'Unauthorized', code: 13
    });
    error.stack = 'Error: secret internals\n    at /srv/app/src/services/secretThing.js:42';
    __handleStreamFailure(null, error);

    const {lastError} = billingStreamHealth();
    assert.equal(lastError.name, 'MongoServerError');
    assert.match(lastError.message, /not authorized/);
    assert.equal(lastError.code, 'Unauthorized');
    // Enough to diagnose, not enough to leak.
    assert.ok(!('stack' in lastError), 'the stack must never be retained');
    assert.ok(
      !JSON.stringify(lastError).includes('secretThing.js'),
      'internal paths leaked through the error'
    );
  });

  it('truncates an enormous driver message', async () => {
    await startBillingChangeStream();
    __handleStreamFailure(null, new Error('x'.repeat(5000)));
    assert.ok(
      billingStreamHealth().lastError.message.length <= 200,
      'an unbounded error string reached the health payload'
    );
  });

  it('tolerates a failure reported with no error object', async () => {
    // The driver does not always hand one over.
    await startBillingChangeStream();
    assert.doesNotThrow(() => __handleStreamFailure(null));
    const health = billingStreamHealth();
    assert.equal(health.healthy, false);
    assert.equal(health.lastError, null);
    assert.ok(health.lastErrorAt, 'the failure should still be timestamped');
  });

  it('a REFUSED start is recorded, not silently counted', async () => {
    /**
     * The most likely reason a deployment has no invalidation at all: MongoDB
     * refuses the watch. It must be visible in health, and it must not stop
     * the API booting.
     */
    const connection = mongoose.connection;
    const realWatch = connection.db.watch.bind(connection.db);
    connection.db.watch = () => {
      throw Object.assign(new Error('$changeStream is not supported'), {
        name: 'MongoServerError', codeName: 'IllegalOperation'
      });
    };
    try {
      assert.equal(await startBillingChangeStream(), false);
    } finally {
      connection.db.watch = realWatch;
    }

    const health = billingStreamHealth();
    assert.equal(health.healthy, false);
    assert.equal(health.errors, 1);
    assert.equal(health.lastError.code, 'IllegalOperation');
    assert.match(health.lastError.message, /changeStream is not supported/);
  });

  it('a deliberate stop anchors the degradation clock too', async () => {
    // Stopping is not an error, but it IS when invalidation ceased.
    await startBillingChangeStream();
    await stopBillingChangeStream();

    const health = billingStreamHealth();
    assert.equal(health.healthy, false);
    assert.ok(health.stoppedAt, 'stoppedAt was not recorded');
    assert.equal(health.lastError, null, 'a clean stop is not an error');
    assert.ok(typeof health.degradedForMs === 'number');
  });
});

// ── recovery ─────────────────────────────────────────────────────────────────

describe('P2H1 · recovery is visible', () => {
  it('restarting clears the failure and increments the restart count', async () => {
    await startBillingChangeStream();
    __handleStreamFailure(null, new Error('boom'));
    assert.equal(billingStreamHealth().healthy, false);

    assert.equal(await restartBillingChangeStream(), true);
    const health = billingStreamHealth();

    assert.equal(health.healthy, true);
    assert.equal(health.running, true);
    assert.equal(health.restarts, 1, 'the recovery was not counted');
    assert.equal(health.degradedForMs, null, 'the degradation clock should stop');
    assert.equal(health.lastError, null, 'a recovered stream still reports an error');
    assert.equal(health.lastErrorAt, null);
    // History is preserved even though the current state is healthy.
    assert.equal(health.errors, 1, 'the error history was erased');
  });

  it('survives repeated failure/recovery cycles with an accurate count', async () => {
    await startBillingChangeStream();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      __handleStreamFailure(null, new Error(`cycle ${cycle}`));
      assert.equal(billingStreamHealth().healthy, false, `cycle ${cycle}: not marked down`);
      await restartBillingChangeStream();
      assert.equal(billingStreamHealth().healthy, true, `cycle ${cycle}: not recovered`);
    }
    const health = billingStreamHealth();
    assert.equal(health.errors, 3);
    assert.equal(health.restarts, 3);
    assert.equal(health.healthy, true);
  });

  it('restarting after a clean STOP clears the degradation too', async () => {
    /**
     * WHY THIS EXISTS — mutation findings M8 and M12.
     *
     * Every recovery test went through a FAILURE, so `stoppedAt` was always
     * null and two mutants survived: not clearing `stoppedAt` on start, and
     * reporting `degradedForMs` even while running. Both only bite on the
     * stop -> restart path, which an operator uses during a rolling deploy.
     */
    await startBillingChangeStream();
    await stopBillingChangeStream();
    const down = billingStreamHealth();
    assert.ok(down.stoppedAt, 'a clean stop should be timestamped');
    assert.ok(down.degradedForMs >= 0);

    assert.equal(await startBillingChangeStream(), true);
    const up = billingStreamHealth();

    assert.equal(up.healthy, true);
    assert.equal(
      up.stoppedAt, null,
      'a restarted stream still reports the time it was stopped'
    );
    assert.equal(
      up.degradedForMs, null,
      'a running stream must never report a degradation duration'
    );
  });

  it('a RUNNING stream never reports degradedForMs, even after past failures', async () => {
    // History must not masquerade as current degradation.
    await startBillingChangeStream();
    __handleStreamFailure(null, new Error('transient'));
    await restartBillingChangeStream();

    const health = billingStreamHealth({now: Date.now() + 60 * 60 * 1000});
    assert.equal(health.running, true);
    assert.equal(health.degradedForMs, null);
    assert.equal(health.errors, 1, 'the history should still be there');
  });

  it('a LATE error from a stale handle does not fake degradation', async () => {
    /**
     * WHY THIS EXISTS — mutation finding M12, and it is a genuine gap rather
     * than an equivalent mutant. I first reasoned it was equivalent, because
     * start and restart both null `stoppedAt` and `lastErrorAt`, so a running
     * stream should never have a `since`. Probing found the one state that
     * breaks that reasoning.
     *
     * P2G.6 deliberately allows a late error from an ALREADY-REPLACED cursor
     * to be recorded without killing the healthy one. That leaves
     * `running === true` while `lastErrorAt` is set — exactly the combination
     * where `running || !since` and `!since` diverge. Without the `running`
     * guard a perfectly healthy stream would report a growing degradation
     * clock, which is a false alarm of the kind this phase must not create.
     */
    await startBillingChangeStream();
    __handleStreamFailure({close() {}}, new Error('late error from a stale handle'));

    const health = billingStreamHealth({now: Date.now() + 60 * 60 * 1000});
    assert.equal(health.running, true, 'a stale handle must not kill the live cursor');
    assert.ok(health.lastErrorAt, 'the late error should still be recorded');
    assert.equal(
      health.degradedForMs, null,
      'a running stream reported degradation because of a stale-handle error'
    );
    assert.equal(health.healthy, true);
  });

  it('__resetBillingStreamStats clears timestamps, not just counters', async () => {
    /**
     * A mutation finding (M17). The reset is a test seam, and one that left
     * stale timestamps behind would make every later test read another test's
     * failure — the kind of thing that produces an unreproducible red build.
     */
    await startBillingChangeStream();
    __handleStreamFailure(null, new Error('dirty state'));
    assert.ok(billingStreamStats.lastErrorAt);
    assert.ok(billingStreamStats.lastError);

    __resetBillingStreamStats();

    for (const [key, value] of Object.entries(billingStreamStats)) {
      if (typeof value === 'number') assert.equal(value, 0, `${key} was not reset`);
      else assert.equal(value, null, `${key} kept a stale value`);
    }
  });

  it('the REAL cursor listener carries error detail into health', async () => {
    /**
     * A mutation finding (M16): dropping the error argument from the module's
     * own `stream.on('error', ...)` listener survived, because every failure
     * test called `__handleStreamFailure` directly.
     *
     * My first attempt to close this built a separate watcher and attached its
     * own listener — which asserted the test's wiring, not the module's, and
     * the mutant survived again. This emits on the ACTUAL cursor the module
     * holds, so only the module's own listener can carry the error.
     */
    await startBillingChangeStream();
    const cursor = __billingStreamCursor();
    assert.ok(cursor, 'the module should be holding a live cursor');
    assert.equal(billingStreamHealth().lastError, null);

    cursor.emit('error', Object.assign(new Error('resume token no longer in the oplog'), {
      name: 'MongoServerError', codeName: 'ChangeStreamHistoryLost'
    }));
    await settle(60);

    const health = billingStreamHealth();
    assert.equal(
      health.lastError?.name, 'MongoServerError',
      'the error emitted by the cursor never reached health'
    );
    assert.equal(health.lastError.code, 'ChangeStreamHistoryLost');
    assert.match(health.lastError.message, /resume token/);
    assert.equal(health.healthy, false, 'the cursor error should mark the stream down');
  });

  it('a recovered stream ACTUALLY invalidates again', async () => {
    /**
     * The health flag must not be able to say "healthy" while the thing it
     * describes is doing nothing. This asserts the behaviour behind the flag.
     */
    const restaurant = await Restaurant.create({name: 'Recover Co', currency: 'NPR'});
    const plan = await Plan.create({
      code: `p2h1-rec-${Math.random().toString(36).slice(2, 6)}`, name: 'Rec',
      active: true, currency: 'NPR', limits: {maxUsers: 2}, features: {pos: true}
    });
    const now = new Date();
    await Subscription.create({
      restaurant: restaurant._id, plan: plan._id, status: 'active', startDate: now,
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
    });

    await startBillingChangeStream();
    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);

    __handleStreamFailure(null, new Error('dropped'));
    await restartBillingChangeStream();
    assert.equal(billingStreamHealth().healthy, true);

    await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 9}});
    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).limits.maxUsers === 9);
    assert.notEqual(
      took, null,
      'health reported healthy but invalidation was not actually working'
    );
  });
});

// ── the endpoint ─────────────────────────────────────────────────────────────

describe('P2H1 · the operational endpoint', () => {
  it('serves the health snapshot to a platform administrator', async () => {
    await startBillingChangeStream();
    await startRoleChangeStream();
    const res = await streamHealth(await platformToken());

    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.billing.running, true);
    assert.equal(res.body.billing.healthy, true);
    /**
     * P2H.3 UPDATE: the top-level `healthy` now covers BOTH streams, so this
     * test starts the role stream too. Asserting `true` while only the billing
     * stream was running encoded the old single-stream assumption — a dead
     * role stream must not be hidden behind a healthy billing one.
     */
    assert.equal(res.body.roles.healthy, true);
    assert.equal(res.body.healthy, true);
    assert.ok(res.body.checkedAt);
    // Per-process, and says so rather than implying a cluster-wide verdict.
    assert.equal(res.body.scope, 'this-instance');
    assert.ok(res.body.roles, 'the role stream should be reported alongside');
  });

  it('reflects a failure and then a recovery', async () => {
    const token = await platformToken();
    await startBillingChangeStream();
    // P2H.3: overall health covers both streams.
    await startRoleChangeStream();
    assert.equal((await streamHealth(token)).body.healthy, true);

    __handleStreamFailure(null, Object.assign(new Error('cursor killed'), {
      name: 'MongoCursorExhaustedError'
    }));
    const down = await streamHealth(token);
    assert.equal(down.body.healthy, false);
    assert.equal(down.body.billing.lastError.name, 'MongoCursorExhaustedError');
    assert.ok(down.body.billing.degradedForMs >= 0);

    await restartBillingChangeStream();
    const up = await streamHealth(token);
    assert.equal(up.body.healthy, true);
    assert.equal(up.body.billing.restarts, 1);
    assert.equal(up.body.billing.lastError, null);
  });

  it('LEAKS NO TENANT, SUBSCRIPTION OR PLAN DATA', async () => {
    /**
     * The stream watches `subscriptions` and `plans`. The endpoint that
     * describes it must not become a side channel into them.
     */
    const restaurant = await Restaurant.create({
      name: 'Very Secret Restaurant', currency: 'NPR'
    });
    const plan = await Plan.create({
      code: 'p2h1-secret-plan', name: 'Secret Plan', active: true, currency: 'NPR',
      monthlyPrice: 999_00, limits: {maxUsers: 7}, features: {pos: true}
    });
    const now = new Date();
    await Subscription.create({
      restaurant: restaurant._id, plan: plan._id, status: 'past_due', startDate: now,
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
    });
    await startBillingChangeStream();
    await settle(300);

    const res = await streamHealth(await platformToken());
    const body = JSON.stringify(res.body);

    for (const secret of [
      'Very Secret Restaurant', 'p2h1-secret-plan', 'Secret Plan',
      'past_due', String(restaurant._id), String(plan._id), '99900', 'maxUsers'
    ]) {
      assert.ok(!body.includes(secret), `the health payload leaked "${secret}"`);
    }
    // What it DOES carry is counts and flags only.
    assert.equal(typeof res.body.billing.events, 'number');
  });

  it('requires a platform permission', async () => {
    await startBillingChangeStream();

    // An ordinary tenant owner is not a platform operator.
    const owner = tokenFor(world.owner);
    assert.equal((await streamHealth(owner)).status, 403);

    // And it is not public.
    const anonymous = await request('/api/platform/health/streams');
    assert.equal(anonymous.status, 401);
  });

  it('is readable by support, the lowest platform role', async () => {
    // Diagnosing a degraded stream should not require super_admin.
    await startBillingChangeStream();
    const res = await streamHealth(await platformToken('platform_support'));
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.billing.healthy, true);
  });

  it('still answers while the stream is down', async () => {
    // A health endpoint that fails when the thing is unhealthy is useless.
    const token = await platformToken();
    const res = await streamHealth(token);
    assert.equal(res.status, 200);
    assert.equal(res.body.healthy, false);
    assert.equal(res.body.billing.running, false);
  });
});

// ── nothing else moved ───────────────────────────────────────────────────────

describe('P2H1 · P2G.6 invalidation behaviour is unchanged', () => {
  it('a subscription change still invalidates precisely one tenant', async () => {
    const make = async name => {
      const restaurant = await Restaurant.create({name, currency: 'NPR'});
      const plan = await Plan.create({
        // Plan codes allow no spaces — 'Inv A' lowercases to 'inv a', which the
        // schema correctly refuses. The FIXTURE was wrong, not the validator.
        code: `p2h1-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 6)}`,
        name, active: true, currency: 'NPR', limits: {maxUsers: 3}, features: {pos: true}
      });
      const now = new Date();
      await Subscription.create({
        restaurant: restaurant._id, plan: plan._id, status: 'active', startDate: now,
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
      });
      return restaurant;
    };
    const a = await make('Inv A');
    const b = await make('Inv B');
    await startBillingChangeStream();

    assert.equal((await resolveEntitlement(a._id)).operational, true);
    assert.equal((await resolveEntitlement(b._id)).operational, true);

    await Subscription.updateOne({restaurant: a._id}, {$set: {status: 'cancelled'}});
    const took = await waitFor(async () =>
      (await resolveEntitlement(a._id)).operational === false);
    assert.notEqual(took, null, 'invalidation stopped working');
    assert.equal((await resolveEntitlement(b._id)).operational, true, 'tenant B was disturbed');
  });

  it('event routing and counters still work', async () => {
    __resetBillingStreamStats();
    await startBillingChangeStream();

    assert.equal(__handleStreamEvent({ns: {coll: 'plans'}, fullDocument: {}}), true);
    assert.equal(__handleStreamEvent({
      ns: {coll: 'subscriptions'}, fullDocument: {restaurant: new mongoose.Types.ObjectId()}
    }), true);

    assert.equal(billingStreamStats.planEvents, 1);
    assert.equal(billingStreamStats.subscriptionEvents, 1);
    assert.equal(billingStreamStats.events, 2);
    assert.equal(billingStreamActive(), true, 'handling events must not disturb the cursor');
  });

  it('a throwing handler is still contained', async () => {
    await startBillingChangeStream();
    const handled = __handleStreamEvent({
      ns: {coll: 'subscriptions'},
      fullDocument: {restaurant: {toString() { throw new Error('bad id'); }}}
    });
    assert.equal(handled, false);
    assert.equal(billingStreamActive(), true, 'one bad event killed the stream');
    // It counts as an error but does NOT mark the cursor down, because the
    // cursor is fine — only that one event failed.
    assert.equal(billingStreamHealth().healthy, true);
  });
});
