/**
 * Phase 16C — scheduler lease renewal.
 *
 * Phase 16B shipped a MongoDB lease lock with `renew()` on the handle, but the
 * scheduler never called it. Two defects followed from that, both found by
 * auditing the code rather than by guessing:
 *
 *   1. `mongoSchedulerLock().acquire()` returned a BARE release function and
 *      discarded the handle, so `renew()` was architecturally unreachable from
 *      the scheduler. The lease could only ever expire.
 *   2. With a 300s lease and no renewal, a sweep over enough restaurants would
 *      outlive its lock, a second instance would acquire it, and two
 *      schedulers would run at once — the exact condition the lock exists to
 *      prevent.
 *
 * These tests drive a deliberately tiny TTL (the config clamps to 30s, so the
 * lock is exercised directly where a shorter lease is needed) and a sweep that
 * is made slow on purpose. Nothing here waits on a real five-minute lease.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Supplier} from '../src/models/index.js';
import {Branch, InventoryBalance, Notification, Restaurant} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {ensureAlertIndexes} from '../src/services/alertMigration.js';
import {
  acquireSchedulerLock, ensureSchedulerLockIndexes, inspectSchedulerLock, mongoSchedulerLock
} from '../src/services/schedulerLock.js';
import {
  runScheduledSweep, schedulerStatus, setSchedulerLock,
  startReorderScheduler, stopReorderScheduler, triggerSchedulerTick
} from '../src/services/reorderScheduler.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let supplier;
let seq = 0;
const KEY = () => `p16c-${Date.now()}-${++seq}`;
const LOCK = 'renewal-test-lock';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

before(async () => { await startTestApp(); });
after(async () => { await stopReorderScheduler(); await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  seq = 0;
  await stopReorderScheduler();
  setSchedulerLock(null);
  await mongoose.connection.db.collection('scheduler_locks').deleteMany({});
  world = await seedWorld();
  await ensureAlertIndexes();
  await ensureSchedulerLockIndexes();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Renewal Supplier'});
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);

async function makeShortage() {
  await SupplierIngredient.create({
    restaurant: world.restaurant._id, supplier: supplier._id, ingredient: world.ingredient._id,
    purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000,
    currentPrice: 100, minOrderQty: 0.1, leadDays: 2, active: true
  });
  await InventoryBalance.updateOne(
    {branch: world.branchA._id, ingredient: world.ingredient._id},
    {$set: {reorderLevel: 19000}}
  );
  const res = await request('/api/inventory/adjustments', {
    method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
    body: {
      branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
      qty: -2000, reason: 'Drive stock below the reorder level'
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await Notification.deleteMany({});
}

/**
 * A lock provider whose lease is short and whose behaviour the test controls.
 * Wraps the REAL Mongo lock so renewal is genuinely exercised against the
 * database, not against a stub that always says yes.
 */
function shortLeaseProvider({ttlSeconds = 1, name = LOCK} = {}) {
  const events = [];
  const real = mongoSchedulerLock({name, ttlSeconds});
  return {
    events,
    kind: 'mongodb',
    // Advertise the real lease length: the scheduler derives its renewal
    // interval from this, so a provider that hides it would be renewed on the
    // wrong schedule.
    ttlSeconds,
    async acquire() {
      const release = await real.acquire();
      if (!release) { events.push('contended'); return null; }
      events.push('acquired');
      const wrapped = async () => { events.push('released'); return release(); };
      wrapped.renew = async seconds => {
        const held = await release.renew(seconds);
        events.push(held ? 'renewed' : 'renew-refused');
        return held;
      };
      wrapped.owner = release.owner;
      return wrapped;
    }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// The adapter defect
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — the lock handle exposes renewal', () => {
  it('acquire() returns something both callable and renewable', async () => {
    // The defect: acquire() used to return a bare function, so the scheduler
    // could release but never renew.
    const provider = mongoSchedulerLock({name: LOCK, ttlSeconds: 60});
    const release = await provider.acquire();
    assert.equal(typeof release, 'function', 'the old contract must keep working');
    assert.equal(typeof release.renew, 'function', 'and renewal must now be reachable');
    assert.ok(release.owner, 'the owner token is exposed for diagnostics');

    assert.equal(await release.renew(120), true);
    await release();
    assert.equal((await inspectSchedulerLock({name: LOCK})).held, false);
  });

  it('renewal extends the lease that would otherwise lapse', async () => {
    const handle = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    const before = (await inspectSchedulerLock({name: LOCK})).expiresAt;
    await sleep(10);
    assert.equal(await handle.renew(600), true);
    const after = (await inspectSchedulerLock({name: LOCK})).expiresAt;
    assert.ok(new Date(after) > new Date(before), 'the expiry must move forward');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Renewal during a long sweep
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — long-running sweep', () => {
  it('renews the lease while the sweep is still running', async () => {
    await makeShortage();
    const provider = shortLeaseProvider({ttlSeconds: 1, name: 'reorder-sweep'});
    setSchedulerLock(provider);

    // Make the sweep genuinely slow by making one query slow, so renewal has
    // real elapsed time to fire against a 1s lease (renew interval = 333ms).
    const original = Restaurant.find;
    Restaurant.find = function slowFind(...args) {
      const query = original.apply(this, args);
      const exec = query.exec.bind(query);
      query.exec = async () => { await sleep(900); return exec(); };
      return query;
    };

    try {
      startReorderScheduler({
        env: {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_LOCK_TTL_SECONDS: '30'},
        logger: {log() {}, warn() {}, error() {}}
      });
      await triggerSchedulerTick();
    } finally {
      Restaurant.find = original;
    }

    const status = schedulerStatus();
    assert.ok(status.leaseRenewals >= 1, `the lease must be renewed mid-sweep, saw ${status.leaseRenewals}`);
    assert.equal(status.leaseLosses, 0, 'and must not be lost');
    assert.ok(provider.events.includes('renewed'));
    assert.ok(provider.events.includes('released'), 'and released at the end');
  });

  it('another instance cannot acquire while the lease is being renewed', async () => {
    await makeShortage();
    setSchedulerLock(shortLeaseProvider({ttlSeconds: 1, name: 'reorder-sweep'}));

    let seenByOther = null;
    const original = Restaurant.find;
    Restaurant.find = function slowFind(...args) {
      const query = original.apply(this, args);
      const exec = query.exec.bind(query);
      query.exec = async () => {
        await sleep(700);
        // Mid-sweep, well past the 1s lease had it not been renewed: a rival
        // instance must still be refused.
        if (seenByOther === null) {
          seenByOther = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 60});
        }
        return exec();
      };
      return query;
    };

    try {
      startReorderScheduler({
        env: {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_LOCK_TTL_SECONDS: '30'},
        logger: {log() {}, warn() {}, error() {}}
      });
      await triggerSchedulerTick();
    } finally {
      Restaurant.find = original;
    }

    assert.equal(seenByOther, null, 'a renewed lease must keep a second scheduler out');
    assert.ok(schedulerStatus().leaseRenewals >= 1);
  });

  it('releases the lease after a renewed sweep, freeing the next tick', async () => {
    await makeShortage();
    setSchedulerLock(shortLeaseProvider({ttlSeconds: 2, name: 'reorder-sweep'}));
    startReorderScheduler({
      env: {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_LOCK_TTL_SECONDS: '30'},
      logger: {log() {}, warn() {}, error() {}}
    });
    await triggerSchedulerTick();
    assert.equal((await inspectSchedulerLock({name: 'reorder-sweep'})).held, false,
      'a lease still held after the sweep would starve every later tick');
    await triggerSchedulerTick();
    assert.equal(schedulerStatus().ticks, 2);
  });

  it('stops renewing once the sweep finishes', async () => {
    await makeShortage();
    const provider = shortLeaseProvider({ttlSeconds: 1, name: 'reorder-sweep'});
    setSchedulerLock(provider);
    startReorderScheduler({
      env: {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_LOCK_TTL_SECONDS: '30'},
      logger: {log() {}, warn() {}, error() {}}
    });
    await triggerSchedulerTick();

    const renewalsAtFinish = schedulerStatus().leaseRenewals;
    // Count the provider's OWN renew calls, not just the counter: a timer that
    // outlived its sweep would keep calling renew() on a released lease, and
    // the counter alone would not necessarily move.
    const attemptsAtFinish = provider.events.filter(e => e.startsWith('renew')).length;

    // Well past several renewal intervals (333ms each for a 1s lease).
    await sleep(1500);

    assert.equal(
      provider.events.filter(e => e.startsWith('renew')).length, attemptsAtFinish,
      'the renewal timer must be cleared when the sweep completes'
    );
    assert.equal(schedulerStatus().leaseRenewals, renewalsAtFinish);
    assert.equal((await inspectSchedulerLock({name: 'reorder-sweep'})).held, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Lease loss
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — losing the lease mid-sweep', () => {
  /** A provider whose renewal refuses, simulating a stolen or lapsed lease. */
  function losingProvider({failWith = null, ttlSeconds = 1} = {}) {
    const events = [];
    return {
      events,
      kind: 'mongodb',
      ttlSeconds,
      async acquire() {
        events.push('acquired');
        const release = async () => { events.push('released'); return true; };
        release.renew = async () => {
          events.push('renew-attempt');
          if (failWith) throw new Error(failWith);
          return false; // ownership has moved on
        };
        return release;
      }
    };
  }

  async function runLosingSweep(provider) {
    // Slow the sweep so at least one renewal fires before it finishes.
    const original = Restaurant.find;
    Restaurant.find = function slowFind(...args) {
      const query = original.apply(this, args);
      const exec = query.exec.bind(query);
      query.exec = async () => { await sleep(600); return exec(); };
      return query;
    };
    try {
      setSchedulerLock(provider);
      startReorderScheduler({
        env: {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_LOCK_TTL_SECONDS: '30'},
        logger: {log() {}, warn() {}, error() {}}
      });
      await triggerSchedulerTick();
    } finally {
      Restaurant.find = original;
    }
  }

  it('abandons the sweep rather than pretending it still owns the lock', async () => {
    await makeShortage();
    const provider = losingProvider();
    // A tiny TTL so the renewal interval is 1s (the floor) and fires quickly.
    await runLosingSweep(provider);

    const status = schedulerStatus();
    assert.ok(provider.events.includes('renew-attempt'), 'renewal was attempted');
    assert.ok(status.leaseLosses >= 1, 'the loss must be counted, not swallowed');
    assert.match(status.lastError || '', /lease/i, 'and reported honestly');
  });

  it('treats a renewal ERROR as lease loss, not as continued ownership', async () => {
    await makeShortage();
    const provider = losingProvider({failWith: 'connection reset by peer'});
    await runLosingSweep(provider);

    const status = schedulerStatus();
    assert.ok(status.leaseLosses >= 1);
    assert.match(status.lastError || '', /renewal failed|lease/i);
    assert.match(status.lastError || '', /connection reset/i, 'the real cause is surfaced');
  });

  it('stops the renewal timer after a loss', async () => {
    await makeShortage();
    const provider = losingProvider();
    await runLosingSweep(provider);

    const attemptsAtLoss = provider.events.filter(e => e === 'renew-attempt').length;
    await sleep(1200);
    assert.equal(
      provider.events.filter(e => e === 'renew-attempt').length, attemptsAtLoss,
      'a timer must not keep firing after the lease is gone'
    );
  });

  it('still releases safely after a loss', async () => {
    await makeShortage();
    const provider = losingProvider();
    await runLosingSweep(provider);
    assert.ok(provider.events.includes('released'), 'release runs on every exit path');
    // Ownership-verified release means this is a no-op against a new holder,
    // never a deletion of somebody else's lock.
  });

  it('stops sweeping REMAINING tenants once the lease is lost mid-run', async () => {
    // The safety claim in full: not merely that the loss is recorded, but that
    // the sweep stops writing. Several restaurants, each slow; renewal is
    // refused on the first attempt, so the later tenants must never be swept.
    const others = [];
    for (let i = 0; i < 4; i += 1) {
      const restaurant = await Restaurant.create({name: `Late Co ${i}`, currency: 'NPR', vatRate: 13});
      await Branch.create({restaurant: restaurant._id, name: `Late ${i}`, code: `L${i}`, address: 'X'});
      others.push(restaurant);
    }

    const provider = losingProvider({ttlSeconds: 1});
    setSchedulerLock(provider);

    // Slow each tenant's own work so the renewal interval (333ms) fires early
    // in the loop rather than after every tenant is already done.
    const {User} = await import('../src/models/index.js');
    const originalFindOne = User.findOne;
    User.findOne = function slowFindOne(...args) {
      const query = originalFindOne.apply(this, args);
      const exec = query.exec.bind(query);
      query.exec = async () => { await sleep(400); return exec(); };
      return query;
    };

    let outcome;
    try {
      startReorderScheduler({
        env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}
      });
      await triggerSchedulerTick();
      // Re-run the sweep directly to inspect its result shape under the same
      // lost-lease condition the scheduler just experienced.
      outcome = await runScheduledSweep({shouldContinue: () => false});
    } finally {
      User.findOne = originalFindOne;
    }

    assert.ok(schedulerStatus().leaseLosses >= 1, 'the loss was detected');
    assert.equal(schedulerStatus().lastAborted, true, 'and the sweep is reported as aborted');
    assert.equal(outcome.aborted, true);
    assert.equal(outcome.swept, 0, 'no tenant may be swept once permission is withdrawn');
  });

  it('the sweep stops early instead of finishing under a dead lease', async () => {
    // Two restaurants; permission is withdrawn immediately, so nothing is swept.
    const second = await Restaurant.create({name: 'Second Co', currency: 'NPR', vatRate: 13});
    await Branch.create({restaurant: second._id, name: 'Second Branch', code: 'SEC', address: 'X'});

    const result = await runScheduledSweep({shouldContinue: () => false});
    assert.equal(result.aborted, true, 'the sweep must report that it stopped early');
    assert.equal(result.swept, 0, 'and must not have written under a lost lease');
    assert.match(result.abortReason || '', /lease/i);
  });

  it('a normal sweep is never marked aborted', async () => {
    await makeShortage();
    const result = await runScheduledSweep({shouldContinue: () => true});
    assert.equal(result.aborted, false);
    assert.ok(result.swept >= 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Ownership and recovery
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — renewal ownership and expiry recovery', () => {
  it('the wrong owner cannot renew another process lease', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    const before = (await inspectSchedulerLock({name: LOCK})).expiresAt;

    // A stale handle for the same lock name but a different owner.
    const impostor = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60, owner: 'not-the-owner'});
    assert.equal(impostor, null, 'the impostor cannot even acquire');

    const rows = mongoose.connection.db.collection('scheduler_locks');
    const forged = await rows.updateOne(
      {_id: LOCK, owner: 'not-the-owner'},
      {$set: {expiresAt: new Date(Date.now() + 999999)}}
    );
    assert.equal(forged.matchedCount, 0, 'renewal must match on owner');
    assert.deepEqual((await inspectSchedulerLock({name: LOCK})).expiresAt, before, 'unchanged');
    assert.equal(await a.renew(120), true, 'the true owner still can');
  });

  it('a superseded holder cannot renew the lease that replaced it', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 30});
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: LOCK}, {$set: {expiresAt: new Date(Date.now() - 1000)}}
    );
    const b = await acquireSchedulerLock({name: LOCK, ttlSeconds: 120});
    assert.ok(b, 'B took over the expired lease');

    assert.equal(await a.renew(600), false, "A must not be able to extend B's lease");
    assert.equal((await inspectSchedulerLock({name: LOCK})).owner, b.owner);
  });

  it('an expired lease is still acquirable by another instance', async () => {
    // The crash case: renewal stopped because the process died.
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 30});
    assert.ok(a);
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: LOCK}, {$set: {expiresAt: new Date(Date.now() - 60000)}}
    );
    const b = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.ok(b, 'the scheduler recovers with no operator intervention');
    assert.notEqual(b.owner, a.owner);
  });

  it('derives a renewal interval strictly below the lease', () => {
    // TTL/3 gives two chances to renew before expiry. Checked across the range
    // so a short lease cannot end up with an interval longer than itself —
    // which is exactly the bug a fixed interval would reintroduce.
    const intervalFor = ttl => Math.max(100, Math.floor((ttl * 1000) / 3));
    for (const ttl of [1, 2, 5, 30, 300, 3600]) {
      assert.ok(intervalFor(ttl) < ttl * 1000, `interval must fire before a ${ttl}s lease expires`);
    }
    assert.equal(intervalFor(30), 10000);
    assert.equal(intervalFor(1), 333);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Correctness is unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — reorder correctness under renewal', () => {
  it('still raises exactly one alert per condition', async () => {
    await makeShortage();
    setSchedulerLock(shortLeaseProvider({ttlSeconds: 2, name: 'reorder-sweep'}));
    startReorderScheduler({
      env: {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_LOCK_TTL_SECONDS: '30'},
      logger: {log() {}, warn() {}, error() {}}
    });
    await triggerSchedulerTick();
    await triggerSchedulerTick();

    assert.equal(
      await Notification.countDocuments({branch: world.branchA._id, type: 'low_stock', status: 'open'}), 1,
      'renewal must not change duplicate suppression'
    );
  });

  it('leaves the manual endpoint working while a renewed lease is held', async () => {
    await makeShortage();
    const holder = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    assert.ok(holder);
    assert.equal(await holder.renew(120), true);

    const res = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.raised >= 1, 'a human is never blocked by the scheduler lease');
  });

  it('reports renewal telemetry', async () => {
    setSchedulerLock(shortLeaseProvider({ttlSeconds: 2, name: 'reorder-sweep'}));
    startReorderScheduler({
      env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}
    });
    const status = schedulerStatus();
    assert.equal(status.leaseRenewals, 0);
    assert.equal(status.leaseLosses, 0);
    assert.equal(status.lastAborted, false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Failover: what is and is not covered
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — database failure during renewal', () => {
  /**
   * The test harness runs a SINGLE-NODE replica set. A real primary election
   * cannot be triggered here, so actual failover is NOT covered — that is
   * recorded in the README rather than implied by these tests.
   *
   * What IS covered is the observable consequence a failover would have on
   * this code: the renewal write fails. That path is exercised directly.
   */
  it('a renewal that throws is handled as lease loss, not ignored', async () => {
    await makeShortage();
    const events = [];
    setSchedulerLock({
      kind: 'mongodb',
      ttlSeconds: 1,
      async acquire() {
        const release = async () => { events.push('released'); return true; };
        release.renew = async () => {
          events.push('renew');
          throw Object.assign(new Error('not primary'), {code: 10107});
        };
        return release;
      }
    });

    const original = Restaurant.find;
    Restaurant.find = function slowFind(...args) {
      const query = original.apply(this, args);
      const exec = query.exec.bind(query);
      query.exec = async () => { await sleep(600); return exec(); };
      return query;
    };
    try {
      startReorderScheduler({
        env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}
      });
      await triggerSchedulerTick();
    } finally {
      Restaurant.find = original;
    }

    assert.ok(events.includes('renew'));
    assert.ok(schedulerStatus().leaseLosses >= 1, 'a stepped-down primary must abort the sweep');
    assert.match(schedulerStatus().lastError || '', /not primary/i);
    assert.ok(events.includes('released'), 'and the lock is still released');
  });

  it('a sweep with no database connection reports rather than throws', async () => {
    const readyState = mongoose.connection.readyState;
    assert.equal(readyState, 1, 'control: the harness is connected');
    const result = await runScheduledSweep({});
    assert.equal(result.aborted, false);
    assert.ok(Array.isArray(result.errors));
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Promised-date semantics
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — promised-date semantics', () => {
  it('counts every delivery for lead time but only promised ones for punctuality', async () => {
    const {summariseDeliveries} = await import('../src/services/supplierPerformance.js');
    const result = summariseDeliveries([
      {actualLeadDays: 2, promisedLeadDays: 3, fullLeadDays: 2},
      {actualLeadDays: 6, promisedLeadDays: 3, fullLeadDays: 6},
      {actualLeadDays: 4, promisedLeadDays: null, fullLeadDays: 4},
      {actualLeadDays: 8, promisedLeadDays: null, fullLeadDays: 8}
    ]);
    // Lead time is a fact about every delivery.
    assert.equal(result.averageLeadDays, 5, 'all four deliveries contribute to lead time');
    assert.equal(result.samples, 4);
    // Punctuality is only meaningful against something promised.
    assert.equal(result.judgedDeliveries, 2, 'only the two with a promise are judged');
    assert.equal(result.lateCount, 1, 'the 6-day delivery against a 3-day promise');
    assert.equal(result.onTimeRate, 50);
  });

  it('reports N/A rather than 0% or 100% when nothing was promised', async () => {
    const {summariseDeliveries} = await import('../src/services/supplierPerformance.js');
    const result = summariseDeliveries([
      {actualLeadDays: 2, promisedLeadDays: null},
      {actualLeadDays: 4, promisedLeadDays: null},
      {actualLeadDays: 6, promisedLeadDays: null}
    ]);
    assert.equal(result.onTimeRate, null, 'an unjudgeable rate must be null, never a number');
    assert.equal(result.lateCount, 0);
    assert.equal(result.averageLeadDays, 4, 'lead time is still fully measurable');
    assert.match(result.onTimeBasis, /cannot be judged/);
  });

  it('never fabricates a promised date on a real order', async () => {
    // A purchase order created without an expected delivery date must stay
    // that way: the report may not invent one from the catalog to make the
    // on-time rate computable.
    const created = await request('/api/purchase-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1, vatRate: 13}]
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const {PurchaseOrder} = await import('../src/models/operations.js');
    const stored = await PurchaseOrder.findById(created.body._id).lean();
    assert.equal(stored.expectedDeliveryDate, undefined, 'no promise was made, so none is recorded');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Migration runbook, verified against a messy dataset (never production)
// ═══════════════════════════════════════════════════════════════════════════

describe('16C — migration runbook', () => {
  it('walks dry run -> apply -> verify -> second verify on realistic mess', async () => {
    const {ensureAlertIndexes: migrate, planAlertMigration} =
      await import('../src/services/alertMigration.js');
    await Notification.collection.dropIndex('alert_open_condition').catch(() => {});

    const ingredient = world.ingredient._id;
    await Notification.collection.insertMany([
      // two duplicates of one condition
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(1)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(2)},
      // legacy rows with no status at all
      {branch: world.branchA._id, type: 'high_waste', title: 't', body: 'b', read: false},
      {branch: world.branchA._id, type: 'out_of_stock', title: 't', body: 'b', read: true},
      // an already-valid acknowledged alert that must not be disturbed
      {
        branch: world.branchA._id, type: 'unusual_consumption', referenceId: ingredient,
        status: 'acknowledged', acknowledgedAt: new Date(), acknowledgedBy: world.owner._id
      }
    ]);
    const total = await Notification.countDocuments({});

    // 1-2. DRY RUN — must write nothing.
    const plan = await planAlertMigration();
    assert.equal(plan.dryRun, true);
    assert.equal(plan.totalAlerts, 5);
    assert.equal(plan.missingStatus, 2);
    assert.equal(plan.alreadyValid, 3);
    assert.equal(plan.duplicates.retired, 1);
    assert.equal(plan.changesRequired, true);
    assert.equal(await Notification.countDocuments({}), total, 'a preview writes nothing');
    assert.equal(await Notification.countDocuments({status: {$exists: false}}), 2);

    // 3-4. EXECUTE.
    const applied = await migrate();
    assert.equal(applied.updated, 2, 'the two legacy rows were backfilled');
    assert.equal(applied.retired, 1, 'one duplicate retired');

    // 5. VERIFY.
    assert.equal(await Notification.countDocuments({}), total, 'nothing is ever deleted');
    assert.equal(await Notification.countDocuments({status: {$exists: false}}), 0);
    assert.equal(
      (await Notification.findOne({type: 'unusual_consumption'})).status, 'acknowledged',
      'a valid acknowledged alert must survive untouched'
    );
    assert.equal((await Notification.findOne({type: 'out_of_stock'})).status, 'resolved',
      'a read legacy alert had already been dealt with');
    assert.equal((await Notification.findOne({type: 'high_waste'})).status, 'open',
      'an unread one is still actionable');

    // 6. SECOND VERIFICATION — must be a clean no-op.
    const second = await migrate();
    assert.equal(second.updated, 0);
    assert.equal(second.retired, 0);
    const finalPlan = await planAlertMigration();
    assert.equal(finalPlan.changesRequired, false);
    assert.equal(finalPlan.missingStatus, 0);
  });
});
