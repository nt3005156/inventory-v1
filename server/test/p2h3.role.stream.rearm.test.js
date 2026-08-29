import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Role, User} from '../src/models/index.js';
import {Restaurant} from '../src/models/operations.js';
import {
  __handleRoleStreamFailure,
  __resetRoleStreamStats,
  __roleStreamCursor,
  __setRoleReArmEnabled,
  roleStreamActive,
  roleStreamHealth,
  roleStreamStats,
  startRoleChangeStream,
  stopRoleChangeStream
} from '../src/services/roleChangeStream.js';
import {
  __resetBillingStreamStats, startBillingChangeStream, stopBillingChangeStream
} from '../src/services/billingChangeStream.js';
import {DEFAULT_BACKOFF_MS, createReArm, parseBackoff} from '../src/services/streamReArm.js';
import {invalidateAllRoles, withRoleCache} from '../src/services/principalCache.js';

/**
 * Read a role THROUGH the cache, exactly as `accessControl.js` does.
 *
 * `withRoleCache(restaurantId, roleKey, loader)` is the real API — my first
 * version invented a `resolveRoleDefinition()` that does not exist. Using the
 * production entry point is also the only way this test can prove the CACHE is
 * invalidated rather than merely that the database changed.
 */
const cachedRole = (restaurantId, key) => withRoleCache(
  restaurantId, key,
  async () => Role.findOne({restaurant: restaurantId, key}).lean()
);

/**
 * P2H.3 — automatic recovery for the ROLE change stream.
 *
 * THE GAP THIS CLOSES. P2H.2 gave the billing stream bounded re-arming and
 * proved it against a real MongoDB outage. The role stream had exactly the
 * same failure mode and none of the protection: a non-resumable error killed
 * the cursor for good, and the role/permission cache silently fell back to its
 * 5s TTL until somebody restarted the process.
 *
 * The machinery is SHARED (`services/streamReArm.js`) rather than copied — two
 * retry loops drift, and the P2H.2 cursor-leak fix would have had to be
 * remembered twice.
 */

let world;
let previousBackoff;

before(async () => {
  previousBackoff = process.env.ROLE_STREAM_BACKOFF_MS;
  // Fast ladder: the shape is what matters, not the wall-clock values.
  process.env.ROLE_STREAM_BACKOFF_MS = '40,60,80,100';
  await startTestApp();
});

after(async () => {
  await stopRoleChangeStream();
  await stopBillingChangeStream();
  if (previousBackoff === undefined) delete process.env.ROLE_STREAM_BACKOFF_MS;
  else process.env.ROLE_STREAM_BACKOFF_MS = previousBackoff;
  await stopTestApp();
});

beforeEach(async () => {
  await stopRoleChangeStream();
  /**
   * Let a closing cursor finish unwinding BEFORE the counters are zeroed.
   *
   * Closing a change stream can emit a final `error`, which the listener
   * records. Resetting first meant that stray error landed in the NEXT test's
   * counters — measured as 21 errors after a 20-failure burst. In isolation
   * the burst records exactly 20, so the extra one was cross-test bleed, not a
   * defect in the module.
   */
  await new Promise(resolve => setTimeout(resolve, 60));
  await clearDb();
  invalidateAllRoles();
  __resetRoleStreamStats();
  __resetBillingStreamStats();
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

const timerCount = () =>
  process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;

const networkFailure = (message = 'getaddrinfo ENOTFOUND mongo') =>
  Object.assign(new Error(message), {name: 'MongoServerSelectionError'});

/**
 * Simulate "MongoDB will not give us a cursor" for the duration of `body`.
 *
 * Patched on the MONGOOSE MODEL, not on `Role.collection`. My first version
 * patched the collection, and mongoose calls that inside its own async
 * `changeStreamThunk` — so the throw became a rejection raised from mongoose
 * internals, before any handler of ours could attach, and surfaced as an
 * unhandledRejection that failed the test. A probe against a REAL stopped
 * MongoDB produced zero unhandled rejections, confirming that was a harness
 * artefact rather than a production path.
 *
 * `Role.watch` is what the module actually calls, so refusing there models the
 * failure without reaching into mongoose's internals.
 */
async function whileWatchRefuses(body) {
  const realWatch = Role.watch.bind(Role);
  Role.watch = () => { throw networkFailure('connection refused'); };
  try {
    return await body();
  } finally {
    Role.watch = realWatch;
  }
}

let roleSeq = 0;
function makeRole(restaurantId, permissions, key) {
  roleSeq += 1;
  return Role.create({
    restaurant: restaurantId,
    key: key || `p2h3-role-${roleSeq}`,
    name: `P2H3 Role ${roleSeq}`,
    baseRole: 'staff',
    permissions
  });
}

// ── startup ──────────────────────────────────────────────────────────────────

describe('P2H3 · startup', () => {
  it('starts healthy with no recovery pending', async () => {
    assert.equal(await startRoleChangeStream(), true);
    const health = roleStreamHealth();

    assert.equal(health.running, true);
    assert.equal(health.healthy, true);
    assert.equal(health.recovering, false);
    assert.equal(health.nextRetryAt, null);
    assert.equal(health.retryAttempt, 0);
    assert.equal(health.reArmScheduled, 0);
    // The existing counters are preserved, not replaced.
    assert.equal(health.started, 1);
    assert.equal(health.fallback, 'role cache TTL (5s)');
  });

  it('a second start is still a no-op', async () => {
    assert.equal(await startRoleChangeStream(), true);
    assert.equal(await startRoleChangeStream(), false);
    assert.equal(roleStreamActive(), true);
  });
});

// ── failure detection and recovery ───────────────────────────────────────────

describe('P2H3 · failure schedules a bounded recovery', () => {
  it('marks the stream degraded AND recovering', async () => {
    await startRoleChangeStream();
    __handleRoleStreamFailure(null, networkFailure());
    const health = roleStreamHealth();

    assert.equal(health.healthy, false);
    assert.equal(health.running, false);
    assert.equal(health.recovering, true, 'the failure did not schedule a recovery');
    assert.ok(health.nextRetryAt, 'nextRetryAt was not published');
    assert.equal(health.errors, 1);
    assert.equal(health.reArmScheduled, 1);
  });

  it('recovers automatically without anybody calling restart', async () => {
    await startRoleChangeStream();
    __handleRoleStreamFailure(null, networkFailure());
    assert.equal(roleStreamHealth().healthy, false);

    const took = await waitFor(() => roleStreamHealth().healthy === true);
    assert.notEqual(took, null, 'the role stream never re-armed on its own');
    assert.ok(roleStreamStats.reArmRecoveries >= 1, 'the recovery was not counted');
    assert.equal(roleStreamHealth().recovering, false);
  });

  it('keeps retrying while MongoDB refuses, then heals when it returns', async () => {
    await startRoleChangeStream();
    await whileWatchRefuses(async () => {
      __handleRoleStreamFailure(null, networkFailure());
      const kept = await waitFor(() => roleStreamStats.reArmAttempts >= 3);
      assert.notEqual(kept, null, 'the retry gave up while the database was down');
      assert.equal(roleStreamHealth().healthy, false);
      assert.equal(roleStreamHealth().recovering, true);
    });

    const took = await waitFor(() => roleStreamHealth().healthy === true);
    assert.notEqual(took, null, 'it never recovered once the database returned');
  });

  it('never spins — attempts stay countable', async () => {
    await startRoleChangeStream();
    await whileWatchRefuses(async () => {
      __handleRoleStreamFailure(null, networkFailure());
      await settle(500);
      assert.ok(
        roleStreamStats.reArmAttempts < 30,
        `runaway retry: ${roleStreamStats.reArmAttempts} attempts in 500ms`
      );
      assert.ok(roleStreamStats.reArmAttempts >= 1, 'it did not retry at all');
    });
    await waitFor(() => roleStreamHealth().healthy === true);
  });

  it('escalates through the ladder rather than repeating the first rung', async () => {
    const previous = process.env.ROLE_STREAM_BACKOFF_MS;
    process.env.ROLE_STREAM_BACKOFF_MS = '30,300';
    try {
      await startRoleChangeStream();
      let firstGap;
      let secondGap;
      await whileWatchRefuses(async () => {
        __handleRoleStreamFailure(null, networkFailure());
        const armedAt1 = Date.now();
        firstGap = Date.parse(roleStreamHealth().nextRetryAt) - armedAt1;

        await waitFor(() => roleStreamStats.reArmScheduled >= 2, {timeout: 3000});
        const armedAt2 = Date.now();
        secondGap = Date.parse(roleStreamHealth().nextRetryAt) - armedAt2;
      });

      assert.ok(
        secondGap > firstGap + 100,
        `the ladder did not escalate: first ${firstGap}ms, second ${secondGap}ms`
      );
      await waitFor(() => roleStreamHealth().healthy === true, {timeout: 5000});
    } finally {
      if (previous === undefined) delete process.env.ROLE_STREAM_BACKOFF_MS;
      else process.env.ROLE_STREAM_BACKOFF_MS = previous;
    }
  });

  it('CAPS at the last rung instead of escalating past it', async () => {
    /**
     * A mutation finding (M17). Indexing the ladder without clamping —
     * `ladder[attempt] ?? 3_600_000` — survived, because the escalation test
     * only compares the first two rungs and the boundedness test tolerates any
     * delay under its ceiling.
     *
     * The cap is the entire safety argument: a ladder that keeps growing
     * eventually waits an hour, which is indistinguishable from the stream
     * staying dead. Driven through the shared controller so the clamp itself
     * is what is asserted, with more failures than the ladder has rungs.
     */
    const delays = [];
    const controller = createReArm({
      backoff: [20, 40],
      isHealthy: () => false,
      start: async () => false,
      onScheduled: () => { delays.push(Date.parse(controller.nextAt) - Date.now()); }
    });
    try {
      controller.schedule();
      await waitFor(() => delays.length >= 5, {timeout: 4000});
    } finally {
      controller.setEnabled(false);
    }

    assert.ok(delays.length >= 5, `only ${delays.length} attempts were scheduled`);
    // Beyond the ladder's length every delay must remain the LAST rung, not
    // grow. Generous slack for timer scheduling; the assertion is the clamp.
    for (const delay of delays.slice(2)) {
      assert.ok(
        delay <= 200,
        `the ladder escalated past its last rung: ${delay}ms (cap is 40ms)`
      );
    }
  });

  it('resets the ladder after a successful recovery', async () => {
    await startRoleChangeStream();
    __handleRoleStreamFailure(null, networkFailure());
    await waitFor(() => roleStreamHealth().healthy === true);
    assert.equal(roleStreamHealth().retryAttempt, 0, 'the ladder was not reset');

    __handleRoleStreamFailure(null, networkFailure());
    assert.equal(
      roleStreamHealth().retryAttempt, 1,
      'the second failure did not start from the bottom rung'
    );
    await waitFor(() => roleStreamHealth().healthy === true);
  });
});

// ── no duplicates ────────────────────────────────────────────────────────────

describe('P2H3 · never two role watchers', () => {
  it('twenty consecutive failures schedule exactly ONE retry', async () => {
    await startRoleChangeStream();
    const before = timerCount();

    for (let i = 0; i < 20; i += 1) {
      __handleRoleStreamFailure(null, networkFailure(`flap ${i}`));
    }

    assert.equal(
      roleStreamStats.reArmScheduled, 1,
      `${roleStreamStats.reArmScheduled} retries were scheduled for one outage`
    );
    assert.ok(timerCount() - before <= 1, 'the burst armed more than one timer');
    assert.equal(roleStreamStats.errors, 20, 'every error should still be recorded');

    await waitFor(() => roleStreamHealth().healthy === true);
    assert.ok(__roleStreamCursor(), 'exactly one cursor should be open');
  });

  it('CLOSES the abandoned cursor on every recovery', async () => {
    /**
     * The P2H.2 cursor leak, avoided here by construction rather than
     * rediscovered. `__handleRoleStreamFailure(null, err)` carries no handle,
     * so closing only `failed` would abandon a still-open cursor and each
     * recovery would stack another watcher.
     */
    await startRoleChangeStream();
    const cursors = [__roleStreamCursor()];

    for (let cycle = 0; cycle < 3; cycle += 1) {
      __handleRoleStreamFailure(null, networkFailure(`cycle ${cycle}`));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => roleStreamHealth().healthy === true);
      cursors.push(__roleStreamCursor());
    }

    assert.equal(new Set(cursors).size, 4, 'each recovery should produce a fresh cursor');
    for (const [index, cursor] of cursors.slice(0, -1).entries()) {
      assert.equal(
        cursor.closed, true,
        `abandoned cursor ${index} is still open and will keep delivering events`
      );
    }
    assert.equal(cursors.at(-1).closed, false, 'the current cursor should be open');
  });

  it('a role change is handled ONCE after repeated recoveries', async () => {
    // The behavioural statement of "no duplicate watchers".
    await startRoleChangeStream();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      __handleRoleStreamFailure(null, networkFailure());
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => roleStreamHealth().healthy === true);
    }

    const before = roleStreamStats.events;
    await makeRole(world.restaurant._id, ['menu.view']);
    await waitFor(() => roleStreamStats.events > before);
    await settle(300);

    assert.equal(
      roleStreamStats.events - before, 1,
      'one role insert produced more than one event — duplicate watchers'
    );
  });

  it('a stale-handle error neither kills nor replaces the live cursor', async () => {
    await startRoleChangeStream();
    const live = __roleStreamCursor();
    const scheduledBefore = roleStreamStats.reArmScheduled;

    __handleRoleStreamFailure({close() {}}, networkFailure('late from a stale handle'));

    assert.equal(live.closed, false, 'the live cursor was closed by a stale-handle error');
    assert.equal(roleStreamActive(), true);
    assert.equal(__roleStreamCursor(), live, 'the cursor should not have been replaced');
    assert.equal(
      roleStreamStats.reArmScheduled, scheduledBefore,
      'a stale-handle error scheduled an unnecessary recovery'
    );
    assert.equal(roleStreamHealth().healthy, true);

    // And it is genuinely still delivering.
    const before = roleStreamStats.events;
    await makeRole(world.restaurant._id, ['menu.view']);
    const delivered = await waitFor(() => roleStreamStats.events > before);
    assert.notEqual(delivered, null, 'the live cursor stopped delivering events');
  });

  it('a flapping database leaves ONE cursor, not a pile', async () => {
    await startRoleChangeStream();
    for (let cycle = 0; cycle < 5; cycle += 1) {
      __handleRoleStreamFailure(null, networkFailure(`cycle ${cycle}`));
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => roleStreamHealth().healthy === true);
    }
    assert.ok(__roleStreamCursor());
    assert.equal(roleStreamActive(), true);
  });
});

// ── shutdown safety ──────────────────────────────────────────────────────────

describe('P2H3 · shutdown is not undone by a pending retry', () => {
  it('stopping cancels the scheduled recovery', async () => {
    await startRoleChangeStream();
    __handleRoleStreamFailure(null, networkFailure());
    assert.equal(roleStreamHealth().recovering, true);

    await stopRoleChangeStream();
    assert.equal(roleStreamHealth().recovering, false, 'the retry survived shutdown');

    await settle(400);
    assert.equal(
      roleStreamHealth().healthy, false,
      'a timer resurrected the stream after shutdown'
    );
  });

  it('re-arming can be switched off entirely', async () => {
    await startRoleChangeStream();
    __setRoleReArmEnabled(false);
    try {
      __handleRoleStreamFailure(null, networkFailure());
      assert.equal(roleStreamHealth().recovering, false);
      assert.equal(roleStreamHealth().reArmEnabled, false);
      await settle(400);
      assert.equal(roleStreamHealth().healthy, false, 'recovery ran while disabled');
    } finally {
      __setRoleReArmEnabled(true);
    }
  });
});

// ── the point: invalidation resumes ──────────────────────────────────────────

describe('P2H3 · role invalidation resumes after an automatic recovery', () => {
  it('a permission change propagates once the stream has re-armed itself', async () => {
    /**
     * THE MOST IMPORTANT TEST. `running === true` proves a cursor exists; it
     * does not prove the cache it protects is being invalidated. This asserts
     * the role definition actually changes.
     */
    const restaurant = world.restaurant._id;
    const role = await makeRole(restaurant, ['menu.view'], 'p2h3-invalidate');
    await startRoleChangeStream();

    // Warm the cache with the original permissions.
    const before = await cachedRole(restaurant, 'p2h3-invalidate');
    assert.ok(before, 'the role should resolve');
    assert.ok(before.permissions.includes('menu.view'));
    assert.ok(!before.permissions.includes('menu.manage'));

    // The stream dies and heals itself — no manual restart anywhere.
    __handleRoleStreamFailure(null, networkFailure());
    assert.equal(roleStreamHealth().healthy, false);
    const recovered = await waitFor(() => roleStreamHealth().healthy === true);
    assert.notEqual(recovered, null, 'the stream never re-armed');

    // Now change the role OUT OF BAND, as another instance would.
    await Role.updateOne(
      {_id: role._id}, {$set: {permissions: ['menu.view', 'menu.manage']}}
    );

    const took = await waitFor(async () => {
      const current = await cachedRole(restaurant, 'p2h3-invalidate');
      return Boolean(current?.permissions?.includes('menu.manage'));
    });
    assert.notEqual(
      took, null,
      'the stream reported healthy but role invalidation did not resume'
    );
  });

  it('tenant isolation survives an automatic recovery', async () => {
    const other = await Restaurant.create({name: 'P2H3 Other', currency: 'NPR'});
    const a = await makeRole(world.restaurant._id, ['menu.view'], 'p2h3-iso');
    await makeRole(other._id, ['orders.view'], 'p2h3-iso');
    await startRoleChangeStream();

    const beforeB = await cachedRole(other._id, 'p2h3-iso');
    assert.deepEqual(beforeB.permissions, ['orders.view']);

    __handleRoleStreamFailure(null, networkFailure());
    await waitFor(() => roleStreamHealth().healthy === true);

    await Role.updateOne({_id: a._id}, {$set: {permissions: ['menu.view', 'menu.manage']}});
    const took = await waitFor(async () => {
      const current = await cachedRole(world.restaurant._id, 'p2h3-iso');
      return Boolean(current?.permissions?.includes('menu.manage'));
    });
    assert.notEqual(took, null, 'tenant A never propagated');

    const afterB = await cachedRole(other._id, 'p2h3-iso');
    assert.deepEqual(
      afterB.permissions, ['orders.view'],
      'the other tenant\'s role was disturbed'
    );
  });

  it('the 5s TTL still backstops while the stream is down', async () => {
    // Recovery must not have replaced the safety net.
    const restaurant = world.restaurant._id;
    const role = await makeRole(restaurant, ['menu.view'], 'p2h3-ttl');
    await startRoleChangeStream();
    await cachedRole(restaurant, 'p2h3-ttl');

    __setRoleReArmEnabled(false);
    try {
      __handleRoleStreamFailure(null, networkFailure());
      await Role.updateOne({_id: role._id}, {$set: {permissions: ['menu.view', 'kds.view']}});
      // The failure handler drops the cache, so the very next read is correct
      // even with no stream at all — the database remains the source of truth.
      const current = await cachedRole(restaurant, 'p2h3-ttl');
      assert.ok(
        current.permissions.includes('kds.view'),
        'the database is still authoritative while degraded'
      );
    } finally {
      __setRoleReArmEnabled(true);
    }
  });
});

// ── the shared controller ────────────────────────────────────────────────────

describe('P2H3 · both streams share one recovery mechanism', () => {
  it('parses a backoff override and falls back safely', () => {
    assert.deepEqual([...parseBackoff('10,20,30')], [10, 20, 30]);
    assert.deepEqual([...parseBackoff('')], [...DEFAULT_BACKOFF_MS]);
    assert.deepEqual([...parseBackoff(undefined)], [...DEFAULT_BACKOFF_MS]);
    // Garbage must not produce an EMPTY ladder — `ladder[...]` would then be
    // undefined and `setTimeout(fn, undefined)` fires immediately, which is
    // the tight loop the cap exists to prevent.
    assert.deepEqual([...parseBackoff('nonsense,,x')], [...DEFAULT_BACKOFF_MS]);
    assert.deepEqual([...parseBackoff('-5')], [...DEFAULT_BACKOFF_MS]);
    // Negative rungs are dropped, valid ones kept.
    assert.deepEqual([...parseBackoff('10,-5,20')], [10, 20]);
    /**
     * `'0'` is honoured rather than rejected: zero is a legitimate delay for a
     * test that wants an immediate retry, and it is still a BOUNDED ladder of
     * one rung rather than an empty one.
     */
    assert.deepEqual([...parseBackoff('0')], [0]);
  });

  it('the controller schedules exactly one attempt at a time', async () => {
    let healthy = false;
    let starts = 0;
    const controller = createReArm({
      backoff: [10],
      isHealthy: () => healthy,
      start: async () => { starts += 1; healthy = true; return true; }
    });

    // Ten scheduling requests, one timer.
    for (let i = 0; i < 10; i += 1) controller.schedule();
    assert.equal(controller.pending, true);
    await settle(120);
    assert.equal(starts, 1, `the controller started ${starts} times for one outage`);
    assert.equal(controller.pending, false);
  });

  it('refuses to schedule while the stream is already healthy', async () => {
    const controller = createReArm({
      backoff: [10], isHealthy: () => true, start: async () => true
    });
    assert.equal(controller.schedule(), false);
    assert.equal(controller.pending, false);
  });

  it('a failing start keeps queueing the next rung', async () => {
    let attempts = 0;
    const controller = createReArm({
      backoff: [10, 10, 10],
      isHealthy: () => false,
      start: async () => { attempts += 1; return false; }
    });
    controller.schedule();
    await waitFor(() => attempts >= 3, {timeout: 2000});
    assert.ok(attempts >= 3, 'the controller gave up while still unhealthy');
    controller.setEnabled(false);
  });

  it('a throwing start is swallowed, not propagated', async () => {
    let attempts = 0;
    const controller = createReArm({
      backoff: [10],
      isHealthy: () => false,
      start: async () => { attempts += 1; throw new Error('boom'); }
    });
    await assert.doesNotReject(() => controller.attempt());
    assert.equal(attempts, 1);
    controller.setEnabled(false);
  });

  it('the billing stream still recovers on the shared controller', async () => {
    // The refactor must not have moved billing's behaviour.
    const previous = process.env.BILLING_STREAM_BACKOFF_MS;
    process.env.BILLING_STREAM_BACKOFF_MS = '40';
    try {
      const {
        __handleStreamFailure, billingStreamHealth
      } = await import('../src/services/billingChangeStream.js');
      await startBillingChangeStream();
      assert.equal(billingStreamHealth().healthy, true);
      __handleStreamFailure(null, networkFailure());
      assert.equal(billingStreamHealth().healthy, false);
      const took = await waitFor(() => billingStreamHealth().healthy === true);
      assert.notEqual(took, null, 'the billing stream stopped recovering after the refactor');
    } finally {
      await stopBillingChangeStream();
      if (previous === undefined) delete process.env.BILLING_STREAM_BACKOFF_MS;
      else process.env.BILLING_STREAM_BACKOFF_MS = previous;
    }
  });
});

// ── the operational endpoint ─────────────────────────────────────────────────

describe('P2H3 · the health endpoint reports role recovery', () => {
  async function platformToken() {
    const user = await User.create({
      name: 'Ops', email: `ops-${Math.random().toString(36).slice(2)}@p2h3.test`,
      password: 'x', role: 'owner', restaurantId: world.restaurant._id,
      platformRole: 'platform_admin'
    });
    return tokenFor(user);
  }

  it('publishes the role stream\'s recovery state', async () => {
    await startRoleChangeStream();
    const res = await request('/api/platform/health/streams', {token: await platformToken()});

    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.roles.running, true);
    assert.equal(res.body.roles.healthy, true);
    assert.equal(res.body.roles.recovering, false);
    assert.equal(res.body.roles.fallback, 'role cache TTL (5s)');
  });

  it('reports overall health as unhealthy when the ROLE stream is down', async () => {
    await startBillingChangeStream();
    await startRoleChangeStream();
    __setRoleReArmEnabled(false);
    try {
      __handleRoleStreamFailure(null, networkFailure());
      const res = await request(
        '/api/platform/health/streams', {token: await platformToken()}
      );
      assert.equal(res.body.roles.healthy, false);
      assert.equal(
        res.body.healthy, false,
        'a dead role stream must not be hidden by a healthy billing stream'
      );
    } finally {
      __setRoleReArmEnabled(true);
      await stopBillingChangeStream();
    }
  });

  it('leaks no role, permission or tenant data', async () => {
    await makeRole(world.restaurant._id, ['menu.manage'], 'p2h3-secret-role');
    await startRoleChangeStream();
    await settle(200);

    const res = await request('/api/platform/health/streams', {token: await platformToken()});
    const body = JSON.stringify(res.body);
    for (const secret of [
      'p2h3-secret-role', 'menu.manage', String(world.restaurant._id)
    ]) {
      assert.ok(!body.includes(secret), `the health payload leaked "${secret}"`);
    }
  });
});
