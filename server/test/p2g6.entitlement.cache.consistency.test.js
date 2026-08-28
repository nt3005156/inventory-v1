import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import mongoose from 'mongoose';
import {clearDb, seedWorld, startTestApp, stopTestApp} from './helpers.js';
import {Restaurant} from '../src/models/operations.js';
import {Plan, SUBSCRIPTION_STATUSES, Subscription} from '../src/models/billing.js';
import {
  __entitlementCacheSize, invalidateEntitlements, resolveEntitlement
} from '../src/services/entitlements.js';
import {
  __handleStreamEvent,
  __handleStreamFailure,
  __resetBillingStreamStats,
  applyInvalidation,
  billingStreamActive,
  billingStreamStats,
  invalidationForEvent,
  restartBillingChangeStream,
  startBillingChangeStream,
  stopBillingChangeStream,
  WATCHED_COLLECTIONS
} from '../src/services/billingChangeStream.js';

/**
 * P2G.6 — cross-instance entitlement cache consistency.
 *
 * THE DEFECT THIS CLOSES, measured before the change stream existed:
 *
 *     tenant on maxUsers: 2
 *     plan updated to 5 directly in MongoDB (as another instance would)
 *     this process still answered 2
 *
 * Propagation was bounded only by the 30s TTL, in BOTH directions — an upgrade
 * took 30s to arrive, and a cancellation took 30s to bite.
 *
 * The cross-instance tests below drive a SECOND OS PROCESS. That is the point:
 * inside one process a "cache invalidation" could just be the same Map being
 * mutated, which proves nothing. `roleChangeStream.js` openly says its
 * multi-instance behaviour is "stated as designed, not as proven"; this phase
 * does not repeat that.
 */

const DAY = 86_400_000;
const INSTANCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'entitlementInstance.mjs'
);

let world;

before(async () => { await startTestApp(); });
after(async () => {
  await stopBillingChangeStream();
  await stopTestApp();
});

beforeEach(async () => {
  await stopBillingChangeStream();
  await clearDb();
  invalidateEntitlements();
  __resetBillingStreamStats();
  world = await seedWorld();
});

/** Settle time for a change stream round trip. */
const settle = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll until `predicate` holds, so the tests assert an OUTCOME rather than a
 * fixed sleep. Returns how long it took, which is itself the evidence that the
 * old 30s window is gone.
 */
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

async function tenantOnPlan(name, limits, {status = 'active', planCode} = {}) {
  const restaurant = await Restaurant.create({
    name, currency: 'NPR', timezone: 'Asia/Kathmandu'
  });
  const plan = await Plan.create({
    code: planCode || `p2g6-${Math.random().toString(36).slice(2, 8)}`,
    name: `${name} Plan`, active: true, currency: 'NPR',
    limits, features: {pos: true, inventory: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: restaurant._id, plan: plan._id, status,
    startDate: now, currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY),
    trialEnd: status === 'trialing' ? new Date(now.getTime() + 7 * DAY) : null
  });
  return {restaurant, plan};
}

// ── the routing rule, tested without a live stream ───────────────────────────

describe('P2G.6 · event routing decides the right invalidation scope', () => {
  it('watches exactly the subscriptions and plans collections', () => {
    assert.deepEqual([...WATCHED_COLLECTIONS].sort(), ['plans', 'subscriptions']);
  });

  it('scopes a subscription event to its own tenant', () => {
    const restaurantId = new mongoose.Types.ObjectId();
    const decision = invalidationForEvent(
      {ns: {coll: 'subscriptions'}, fullDocument: {restaurant: restaurantId}}
    );
    assert.equal(decision.scope, 'tenant');
    assert.equal(decision.restaurantId, String(restaurantId));
  });

  it('clears everything for a plan event, because tenants are not derivable', () => {
    // One plan backs many tenants and the event names none of them.
    const decision = invalidationForEvent(
      {ns: {coll: 'plans'}, fullDocument: {_id: new mongoose.Types.ObjectId()}}
    );
    assert.equal(decision.scope, 'all');
    assert.equal(decision.reason, 'plan');
  });

  it('clears everything when a subscription delete hides the tenant', () => {
    /**
     * A delete carries no `fullDocument`, and the document key is the
     * subscription's `_id`, NOT the restaurant. The tenant is genuinely
     * unknown, so invalidating nothing would be silently wrong.
     */
    const decision = invalidationForEvent({
      ns: {coll: 'subscriptions'},
      operationType: 'delete',
      documentKey: {_id: new mongoose.Types.ObjectId()}
    });
    assert.equal(decision.scope, 'all');
    assert.equal(decision.reason, 'subscription_unresolved');
  });

  it('applies a tenant-scoped drop without disturbing other tenants', async () => {
    const a = await tenantOnPlan('Scope A', {maxUsers: 2});
    const b = await tenantOnPlan('Scope B', {maxUsers: 7});
    await resolveEntitlement(a.restaurant._id);
    await resolveEntitlement(b.restaurant._id);
    assert.equal(__entitlementCacheSize(), 2);

    applyInvalidation(
      {ns: {coll: 'subscriptions'}, fullDocument: {restaurant: a.restaurant._id}}
    );
    assert.equal(__entitlementCacheSize(), 1, 'exactly one tenant should have been dropped');
    // And it is B that survived.
    assert.equal((await resolveEntitlement(b.restaurant._id)).limits.maxUsers, 7);
  });
});

// ── subscription invalidation, in-process ────────────────────────────────────

describe('P2G.6 · a subscription change invalidates the entitlement cache', () => {
  it('starts and reports itself active', async () => {
    assert.equal(await startBillingChangeStream(), true);
    assert.equal(billingStreamActive(), true);
    // A second start is a no-op, matching the role-stream contract.
    assert.equal(await startBillingChangeStream(), false);
  });

  it('propagates every real lifecycle transition', async () => {
    /**
     * The statuses come from `SUBSCRIPTION_STATUSES` in the repository —
     * trialing, active, past_due, cancelled, expired — rather than invented
     * ones.
     */
    const {restaurant} = await tenantOnPlan('Lifecycle', {maxUsers: 3});
    await startBillingChangeStream();

    assert.equal((await resolveEntitlement(restaurant._id)).operational, true);

    // active -> past_due
    await Subscription.updateOne({restaurant: restaurant._id}, {$set: {status: 'past_due'}});
    let took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).operational === false);
    assert.notEqual(took, null, 'past_due never propagated');
    assert.equal((await resolveEntitlement(restaurant._id)).reason, 'subscription_past_due');

    // past_due -> active again
    await Subscription.updateOne({restaurant: restaurant._id}, {$set: {status: 'active'}});
    took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).operational === true);
    assert.notEqual(took, null, 'reactivation never propagated');

    // active -> cancelled
    await Subscription.updateOne({restaurant: restaurant._id}, {$set: {status: 'cancelled'}});
    took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).reason === 'subscription_cancelled');
    assert.notEqual(took, null, 'cancellation never propagated');

    // cancelled -> expired
    await Subscription.updateOne({restaurant: restaurant._id}, {$set: {status: 'expired'}});
    took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).reason === 'subscription_expired');
    assert.notEqual(took, null, 'expiry never propagated');

    // expired -> active
    await Subscription.updateOne({restaurant: restaurant._id}, {$set: {status: 'active'}});
    took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).operational === true);
    assert.notEqual(took, null, 'expired -> active never propagated');
  });

  it('every status in the schema enum is exercised by the transition test', () => {
    // Guards the test above against a future status being added and silently
    // going unpropagated.
    assert.deepEqual(
      [...SUBSCRIPTION_STATUSES].sort(),
      ['active', 'cancelled', 'expired', 'past_due', 'trialing']
    );
  });

  it('propagates a PLAN SWAP on the subscription (plan A -> plan B)', async () => {
    const {restaurant} = await tenantOnPlan('Swap', {maxUsers: 2}, {planCode: 'p2g6-swap-a'});
    const planB = await Plan.create({
      code: 'p2g6-swap-b', name: 'B', active: true, currency: 'NPR',
      limits: {maxUsers: 11}, features: {pos: true}
    });
    await startBillingChangeStream();

    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);
    await Subscription.updateOne({restaurant: restaurant._id}, {$set: {plan: planB._id}});

    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).limits.maxUsers === 11);
    assert.notEqual(took, null, 'a plan swap never propagated');
    assert.equal((await resolveEntitlement(restaurant._id)).planCode, 'p2g6-swap-b');
  });

  it('propagates a brand-new subscription for a previously unsubscribed tenant', async () => {
    const restaurant = await Restaurant.create({name: 'Late Sub', currency: 'NPR'});
    const plan = await Plan.create({
      code: 'p2g6-late', name: 'Late', active: true, currency: 'NPR',
      limits: {maxUsers: 4}, features: {pos: true}
    });
    await startBillingChangeStream();

    // Cached as non-operational.
    assert.equal((await resolveEntitlement(restaurant._id)).reason, 'no_subscription');

    const now = new Date();
    await Subscription.create({
      restaurant: restaurant._id, plan: plan._id, status: 'active', startDate: now,
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
    });
    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).operational === true);
    assert.notEqual(took, null, 'a new subscription never propagated');
  });
});

// ── plan invalidation ────────────────────────────────────────────────────────

describe('P2G.6 · a plan change invalidates cached entitlements', () => {
  it('THE MEASURED CASE: maxUsers 2 -> 5 without the subscription changing', async () => {
    const {restaurant, plan} = await tenantOnPlan('Plan Edit', {maxUsers: 2});
    await startBillingChangeStream();

    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);
    // Only the PLAN document moves; the subscription is untouched.
    await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 5}});

    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).limits.maxUsers === 5);
    assert.notEqual(took, null, 'a stale plan stayed cached because the subscription did not change');
  });

  it('invalidates EVERY tenant on a shared plan', async () => {
    const shared = await Plan.create({
      code: 'p2g6-shared', name: 'Shared', active: true, currency: 'NPR',
      limits: {maxUsers: 2}, features: {pos: true}
    });
    const now = new Date();
    const tenants = [];
    for (const name of ['Shared A', 'Shared B', 'Shared C']) {
      const restaurant = await Restaurant.create({name, currency: 'NPR'});
      await Subscription.create({
        restaurant: restaurant._id, plan: shared._id, status: 'active', startDate: now,
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
      });
      tenants.push(restaurant);
    }
    await startBillingChangeStream();

    for (const tenant of tenants) {
      assert.equal((await resolveEntitlement(tenant._id)).limits.maxUsers, 2);
    }
    await Plan.updateOne({_id: shared._id}, {$set: {'limits.maxUsers': 8}});

    const took = await waitFor(async () => {
      const values = await Promise.all(
        tenants.map(async t => (await resolveEntitlement(t._id)).limits.maxUsers)
      );
      return values.every(value => value === 8);
    });
    assert.notEqual(took, null, 'not every tenant on the shared plan was invalidated');
  });

  it('propagates a feature grant as well as a limit', async () => {
    const {restaurant, plan} = await tenantOnPlan('Feature Edit', {maxUsers: 2});
    await startBillingChangeStream();
    assert.equal((await resolveEntitlement(restaurant._id)).features.delivery, false);

    await Plan.updateOne({_id: plan._id}, {$set: {'features.delivery': true}});
    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).features.delivery === true);
    assert.notEqual(took, null, 'a feature grant never propagated');
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe('P2G.6 · tenant isolation', () => {
  it('a subscription change for A does not alter B\'s entitlement', async () => {
    const a = await tenantOnPlan('Iso A', {maxUsers: 2});
    const b = await tenantOnPlan('Iso B', {maxUsers: 7});
    await startBillingChangeStream();

    const before = await resolveEntitlement(b.restaurant._id);
    assert.equal(before.operational, true);
    assert.equal(before.limits.maxUsers, 7);

    await Subscription.updateOne({restaurant: a.restaurant._id}, {$set: {status: 'cancelled'}});
    await waitFor(async () =>
      (await resolveEntitlement(a.restaurant._id)).operational === false);

    // B is untouched in VALUE...
    const after = await resolveEntitlement(b.restaurant._id);
    assert.equal(after.operational, true);
    assert.equal(after.limits.maxUsers, 7);
    assert.equal(after.planCode, b.plan.code);
  });

  it('a subscription change for A leaves B\'s cache ENTRY in place', async () => {
    /**
     * Stronger than the value check above: a tenant-scoped event must drop one
     * key, not clear the map. If it cleared, B's value would still be correct
     * but every tenant would be re-resolving on every billing event anywhere
     * on the platform.
     */
    const a = await tenantOnPlan('Entry A', {maxUsers: 2});
    const b = await tenantOnPlan('Entry B', {maxUsers: 7});
    await startBillingChangeStream();
    await resolveEntitlement(a.restaurant._id);
    await resolveEntitlement(b.restaurant._id);
    assert.equal(__entitlementCacheSize(), 2);

    await Subscription.updateOne({restaurant: a.restaurant._id}, {$set: {status: 'past_due'}});
    const took = await waitFor(async () => __entitlementCacheSize() === 1);
    assert.notEqual(
      took, null,
      `expected exactly one entry to be dropped, size is ${__entitlementCacheSize()}`
    );
  });
});

// ── cross-instance, with a genuinely separate process ────────────────────────

describe('P2G.6 · cross-instance propagation (second OS process)', () => {
  /** Spawn the helper instance and give it a request/response interface. */
  async function spawnInstance() {
    const child = spawn(process.execPath, [INSTANCE], {
      env: {...process.env, MONGODB_URI: mongoose.connection.client.s.url
        || mongoose.connection.client.options?.srvHost
        || process.env.MONGODB_URI},
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const pending = new Map();
    let ready;
    const readyPromise = new Promise(resolve => { ready = resolve; });
    let buffer = '';
    let nextId = 1;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          const message = JSON.parse(line);
          if (message.ready) ready(message);
          else if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
          }
        }
        index = buffer.indexOf('\n');
      }
    });

    const call = (cmd, extra = {}) => new Promise((resolve, reject) => {
      const id = nextId += 1;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({cmd, id, ...extra})}\n`);
      setTimeout(() => reject(new Error(`instance timed out on ${cmd}`)), 15_000).unref();
    });

    const started = await Promise.race([
      readyPromise,
      new Promise((resolve, reject) => setTimeout(
        () => reject(new Error('instance never became ready')), 20_000
      ))
    ]);
    return {child, call, started};
  }

  it('BOTH instances stop serving a stale entitlement after a plan change', async () => {
    const {restaurant, plan} = await tenantOnPlan('Cross Plan', {maxUsers: 2});
    await startBillingChangeStream();

    const instance = await spawnInstance();
    try {
      assert.equal(instance.started.streamActive, true, 'instance B stream did not start');

      // 1. Both cache the SAME entitlement.
      assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);
      const first = await instance.call('resolve', {restaurantId: String(restaurant._id)});
      assert.equal(first.entitlement.maxUsers, 2, 'instance B disagreed at the start');

      // 2. The plan changes — written by neither instance's service layer.
      await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 5}});

      // 3/4/5. Both observe the new state, well inside the old 30s window.
      const tookA = await waitFor(async () =>
        (await resolveEntitlement(restaurant._id)).limits.maxUsers === 5);
      const tookB = await waitFor(async () => {
        const res = await instance.call('resolve', {restaurantId: String(restaurant._id)});
        return res.entitlement.maxUsers === 5;
      });

      assert.notEqual(tookA, null, 'instance A stayed stale');
      assert.notEqual(tookB, null, 'instance B stayed stale — the 30s window is still there');
      assert.ok(
        tookB < 10_000,
        `instance B took ${tookB}ms, which is not meaningfully better than the TTL`
      );

      const stats = await instance.call('stats');
      assert.ok(stats.stats.events >= 1, 'instance B saw no change events');
      assert.ok(stats.stats.planEvents >= 1);
    } finally {
      await instance.call('exit').catch(() => {});
      instance.child.kill();
    }
  });

  it('BOTH instances stop honouring a cancelled subscription', async () => {
    // The commercially important direction: a cancellation must BITE quickly,
    // not keep working for a TTL.
    const {restaurant} = await tenantOnPlan('Cross Cancel', {maxUsers: 3});
    await startBillingChangeStream();

    const instance = await spawnInstance();
    try {
      assert.equal((await resolveEntitlement(restaurant._id)).operational, true);
      const first = await instance.call('resolve', {restaurantId: String(restaurant._id)});
      assert.equal(first.entitlement.operational, true);

      await Subscription.updateOne(
        {restaurant: restaurant._id}, {$set: {status: 'cancelled'}}
      );

      const tookB = await waitFor(async () => {
        const res = await instance.call('resolve', {restaurantId: String(restaurant._id)});
        return res.entitlement.operational === false;
      });
      assert.notEqual(tookB, null, 'instance B kept serving a cancelled subscription');

      const res = await instance.call('resolve', {restaurantId: String(restaurant._id)});
      assert.equal(res.entitlement.reason, 'subscription_cancelled');
    } finally {
      await instance.call('exit').catch(() => {});
      instance.child.kill();
    }
  });

  it('a second instance does not have another tenant\'s cache disturbed', async () => {
    const a = await tenantOnPlan('Cross Iso A', {maxUsers: 2});
    const b = await tenantOnPlan('Cross Iso B', {maxUsers: 9});
    await startBillingChangeStream();

    const instance = await spawnInstance();
    try {
      await instance.call('resolve', {restaurantId: String(a.restaurant._id)});
      const bBefore = await instance.call('resolve', {restaurantId: String(b.restaurant._id)});
      assert.equal(bBefore.entitlement.maxUsers, 9);

      await Subscription.updateOne(
        {restaurant: a.restaurant._id}, {$set: {status: 'past_due'}}
      );
      await waitFor(async () => {
        const res = await instance.call('resolve', {restaurantId: String(a.restaurant._id)});
        return res.entitlement.operational === false;
      });

      const bAfter = await instance.call('resolve', {restaurantId: String(b.restaurant._id)});
      assert.equal(bAfter.entitlement.maxUsers, 9, 'tenant B was corrupted on instance B');
      assert.equal(bAfter.entitlement.operational, true);
    } finally {
      await instance.call('exit').catch(() => {});
      instance.child.kill();
    }
  });
});

// ── failure and recovery ─────────────────────────────────────────────────────

describe('P2G.6 · the stream recovers rather than staying stale forever', () => {
  it('stops cleanly and reports it', async () => {
    await startBillingChangeStream();
    assert.equal(await stopBillingChangeStream(), true);
    assert.equal(billingStreamActive(), false);
    // A second stop is a no-op rather than an error.
    assert.equal(await stopBillingChangeStream(), false);
  });

  it('falls back to the TTL while down, and resumes when restarted', async () => {
    /**
     * The requirement in one test: a temporary failure must not leave the
     * application silently stale forever.
     */
    const {restaurant, plan} = await tenantOnPlan('Recovery', {maxUsers: 2});
    await startBillingChangeStream();
    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);

    // The stream goes away — a dropped connection, a stepdown, anything.
    await stopBillingChangeStream();
    assert.equal(billingStreamActive(), false);

    // A change made while it is down is NOT propagated. Stated honestly: this
    // is the degraded window the TTL still backstops.
    await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 6}});
    await settle(600);
    assert.equal(
      (await resolveEntitlement(restaurant._id)).limits.maxUsers, 2,
      'expected the value to be stale while the stream is down'
    );

    // Restarting clears the cache, so the very next read is authoritative
    // rather than waiting out the TTL.
    assert.equal(await restartBillingChangeStream(), true);
    assert.equal(
      (await resolveEntitlement(restaurant._id)).limits.maxUsers, 6,
      'restarting did not recover the missed change'
    );

    // And invalidation is live again afterwards.
    await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 12}});
    const took = await waitFor(async () =>
      (await resolveEntitlement(restaurant._id)).limits.maxUsers === 12);
    assert.notEqual(took, null, 'the restarted stream is not invalidating');
  });

  it('clears the cache on start, so a restart cannot serve pre-gap data', async () => {
    const {restaurant} = await tenantOnPlan('Start Clear', {maxUsers: 2});
    await resolveEntitlement(restaurant._id);
    assert.ok(__entitlementCacheSize() >= 1);

    await startBillingChangeStream();
    assert.equal(
      __entitlementCacheSize(), 0,
      'a newly started stream must not trust entries cached before it existed'
    );
  });

  it('counts a restart, so degradation is observable', async () => {
    __resetBillingStreamStats();
    await startBillingChangeStream();
    assert.equal(billingStreamStats.started, 1);
    assert.equal(billingStreamStats.restarts, 0);

    await restartBillingChangeStream();
    assert.equal(billingStreamStats.started, 2);
    assert.equal(billingStreamStats.restarts, 1, 'a restart should be visible in the stats');
    assert.equal(billingStreamStats.closed, 1);
  });

  it('survives a malformed event without killing the stream', async () => {
    // A handler that throws must not take the watcher down with it, or one bad
    // event degrades every future invalidation.
    await startBillingChangeStream();
    assert.doesNotThrow(() => applyInvalidation(null));
    assert.doesNotThrow(() => applyInvalidation({}));
    assert.doesNotThrow(() => applyInvalidation({ns: {}}));
    assert.equal(billingStreamActive(), true);
  });

  it('AN ACTUAL STREAM ERROR drops the handle and clears the cache', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding. Removing the cache clear on error
     * (M9) and removing the handle drop (M10) BOTH survived, because no test
     * ever drove a real failure: a live change-stream `error` event is hard to
     * provoke deterministically, so the recovery path was asserted nowhere.
     *
     * The failure handler is now callable directly, which is the honest way to
     * test it — the alternative is faking an error on the driver and asserting
     * against a mock rather than against the contract.
     */
    const {restaurant} = await tenantOnPlan('Error Path', {maxUsers: 2});
    await startBillingChangeStream();
    await resolveEntitlement(restaurant._id);
    assert.ok(__entitlementCacheSize() >= 1);
    assert.equal(billingStreamActive(), true);

    const before = billingStreamStats.errors;
    __handleStreamFailure(null);

    assert.equal(billingStreamStats.errors, before + 1, 'the error was not counted');
    assert.equal(
      billingStreamActive(), false,
      'the handle survived the error, so no restart could ever rebuild it'
    );
    assert.equal(
      __entitlementCacheSize(), 0,
      'entries cached before the failure would be served stale until their TTL'
    );

    // And recovery is possible precisely because the handle was surrendered.
    assert.equal(await startBillingChangeStream(), true);
  });

  it('a late error from a replaced stream does not kill the healthy one', async () => {
    // Guards the `failed === stream` check: an error arriving from an old
    // handle after a restart must not take the current watcher down.
    await startBillingChangeStream();
    const stale = {close() {}};
    __handleStreamFailure(stale);
    assert.equal(
      billingStreamActive(), true,
      'an error from a stale handle disabled the live stream'
    );
  });

  it('a throwing event handler is contained rather than killing the stream', async () => {
    /**
     * Also a mutation finding (M15). If a listener throws, the watcher dies
     * and every future invalidation is lost — far worse than dropping one.
     */
    await startBillingChangeStream();
    const before = billingStreamStats.errors;

    // `applyInvalidation` throws on this because the id is unusable.
    const handled = __handleStreamEvent({
      ns: {coll: 'subscriptions'},
      fullDocument: {restaurant: {toString() { throw new Error('bad id'); }}}
    });

    assert.equal(handled, false, 'the failure should be reported, not thrown');
    assert.equal(billingStreamStats.errors, before + 1);
    assert.equal(billingStreamActive(), true, 'one bad event killed the stream');

    // Still invalidating afterwards.
    assert.equal(__handleStreamEvent({ns: {coll: 'plans'}, fullDocument: {}}), true);
  });

  it('counts plan and subscription events separately', async () => {
    __resetBillingStreamStats();
    __handleStreamEvent({ns: {coll: 'plans'}, fullDocument: {}});
    __handleStreamEvent({
      ns: {coll: 'subscriptions'}, fullDocument: {restaurant: new mongoose.Types.ObjectId()}
    });
    assert.equal(billingStreamStats.planEvents, 1);
    assert.equal(billingStreamStats.subscriptionEvents, 1);
    assert.equal(billingStreamStats.events, 2);
  });

  it('the application starts and stops the stream in its lifecycle', async () => {
    /**
     * Mutation findings M17/M18: deleting the `startBillingChangeStream()`
     * call from `index.js`, or the `stopBillingChangeStream()` from shutdown,
     * both survived — the tests drove the module directly and never checked
     * that the application actually wires it up. A change stream nobody starts
     * invalidates nothing in production, which is the entire feature.
     *
     * Asserted against the source because `index.js` binds a port and connects
     * on import, so it cannot be imported into this harness.
     */
    const {readFileSync} = await import('node:fs');
    const source = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

    assert.match(
      source, /startBillingChangeStream\(\)/,
      'index.js never starts the billing change stream'
    );
    assert.match(
      source, /await stopBillingChangeStream\(\);/,
      'index.js never stops the billing change stream on shutdown'
    );
    // Started alongside the role stream, after the database is connected.
    assert.ok(
      source.indexOf('startBillingChangeStream()') > source.indexOf('mongoose.connect'),
      'the stream must start after the database connection'
    );
  });

  it('returns false when the connection has no database yet', async () => {
    // The pre-flight guard: called before mongoose has finished connecting.
    const connection = mongoose.connection;
    const realDb = connection.db;
    Object.defineProperty(connection, 'db', {value: undefined, configurable: true});
    try {
      assert.equal(await startBillingChangeStream(), false);
      assert.equal(billingStreamActive(), false);
    } finally {
      Object.defineProperty(connection, 'db', {value: realDb, configurable: true});
    }
  });

  it('SWALLOWS a watch() failure so the API can still boot', async () => {
    /**
     * WHY THIS IS SEPARATE — a mutation finding (M16).
     *
     * Making the catch rethrow survived, because the only failure test above
     * exits through the early `return false` guard and never reaches the
     * `try` body at all. The genuine failure — MongoDB refusing the watch,
     * e.g. on a node that is not a replica-set member — has to come from
     * `db.watch()` itself.
     *
     * It must degrade to `false`, not throw: `index.js` starts this during
     * boot, and an exception there would take the API down over the loss of a
     * cache optimisation the TTL already backstops.
     */
    const connection = mongoose.connection;
    const realWatch = connection.db.watch.bind(connection.db);
    connection.db.watch = () => {
      throw new Error('$changeStream is not supported on this deployment');
    };
    const before = billingStreamStats.errors;
    try {
      let result;
      await assert.doesNotReject(
        async () => { result = await startBillingChangeStream(); },
        'a watch failure must not propagate — the API would fail to boot'
      );
      assert.equal(result, false);
      assert.equal(billingStreamActive(), false);
      assert.equal(billingStreamStats.errors, before + 1, 'the failure went uncounted');
    } finally {
      connection.db.watch = realWatch;
    }

    // Recoverable afterwards, once the deployment supports it.
    assert.equal(await startBillingChangeStream(), true);
  });
});

// ── the cache itself must be unchanged ───────────────────────────────────────

describe('P2G.6 · the existing entitlement cache still behaves as before', () => {
  it('still caches — a second read does not re-query', async () => {
    const {restaurant} = await tenantOnPlan('Still Cached', {maxUsers: 2});
    invalidateEntitlements();
    assert.equal(__entitlementCacheSize(), 0);

    await resolveEntitlement(restaurant._id);
    assert.equal(__entitlementCacheSize(), 1, 'the cache was removed rather than improved');

    let reads = 0;
    const original = Plan.findById.bind(Plan);
    Plan.findById = function counted(...args) {
      reads += 1;
      return original(...args);
    };
    try {
      await resolveEntitlement(restaurant._id);
      await resolveEntitlement(restaurant._id);
    } finally {
      Plan.findById = original;
    }
    assert.equal(reads, 0, 'a cache hit went to the database');
  });

  it('still honours {fresh: true}', async () => {
    const {restaurant, plan} = await tenantOnPlan('Fresh', {maxUsers: 2});
    await resolveEntitlement(restaurant._id);
    await Plan.updateOne({_id: plan._id}, {$set: {'limits.maxUsers': 4}});
    // No stream running, so only an explicit fresh read should see it.
    assert.equal((await resolveEntitlement(restaurant._id)).limits.maxUsers, 2);
    assert.equal((await resolveEntitlement(restaurant._id, {fresh: true})).limits.maxUsers, 4);
  });

  it('still resolves the same entitlement content as before the change', async () => {
    const {restaurant} = await tenantOnPlan('Content', {maxUsers: 3, maxMenuItems: 40});
    await startBillingChangeStream();
    const entitlement = await resolveEntitlement(restaurant._id);

    assert.equal(entitlement.operational, true);
    assert.equal(entitlement.reason, 'ok');
    assert.equal(entitlement.limits.maxUsers, 3);
    assert.equal(entitlement.limits.maxMenuItems, 40);
    assert.equal(entitlement.features.pos, true);
    // P2G.5 put the timezone here; it must survive.
    assert.equal(entitlement.timezone, 'Asia/Kathmandu');
  });

  it('leaves the explicit service-layer invalidations working', async () => {
    // `subscriptions.js` and `subscriptionLifecycle.js` still call
    // `invalidateEntitlements()` directly. The stream supplements them; it
    // does not replace them, so a single-node deployment behaves as before.
    const {restaurant} = await tenantOnPlan('Explicit', {maxUsers: 2});
    await resolveEntitlement(restaurant._id);
    assert.equal(__entitlementCacheSize(), 1);
    invalidateEntitlements(restaurant._id);
    assert.equal(__entitlementCacheSize(), 0);
  });
});
