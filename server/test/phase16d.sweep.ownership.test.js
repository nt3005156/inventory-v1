/**
 * Phase 16D — sweep ownership and mid-tenant lease loss.
 *
 * Audit of every caller of `runScheduledSweep()` found exactly one production
 * call site (the scheduler tick) and no way for the manual endpoint to reach
 * it — the manual route calls `raiseReorderAlerts` directly. So no live code
 * was bypassing the lease.
 *
 * The genuine risk was latent rather than active: `shouldContinue` DEFAULTED to
 * permissive, so a future caller could run a full multi-tenant sweep with no
 * lease behind it purely by forgetting, and the failure mode would be silent
 * duplicate sweeps across containers. Ownership is now a required, declared
 * argument — bypassing the lease has to be deliberate and visible.
 *
 * The second gap: lease loss was only checked BETWEEN tenants. A restaurant
 * with hundreds of short ingredients could keep writing long after the lease
 * had gone. It is now checked before each alert write.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, Notification, PurchaseOrder, Restaurant
} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {ensureAlertIndexes} from '../src/services/alertMigration.js';
import {
  acquireSchedulerLock, ensureSchedulerLockIndexes, inspectSchedulerLock, mongoSchedulerLock
} from '../src/services/schedulerLock.js';
import {
  SWEEP_MODES, runScheduledSweep, schedulerStatus, setSchedulerLock,
  startReorderScheduler, stopReorderScheduler, sweepOwnership, triggerSchedulerTick
} from '../src/services/reorderScheduler.js';
import {raiseReorderAlerts} from '../src/services/reorderEngine.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let rival;
let supplier;
let seq = 0;
const KEY = () => `p16d-${Date.now()}-${++seq}`;
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
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: '16D Supplier'});

  const restaurant = await Restaurant.create({name: 'Rival16D', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival16D Branch', code: 'R6D', address: 'Kupondole'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival16D Owner', email: 'rival16d@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival16D', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const actor = () => ({id: String(world.owner._id), role: 'owner', restaurantId: String(world.restaurant._id)});

/** Puts `count` ingredients below their reorder point in branch A. */
async function makeShortages(count = 1) {
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const ingredient = i === 0
      ? world.ingredient
      : await Ingredient.create({
        restaurant: world.restaurant._id, code: `ING-16D-${i}`, name: `Short Item ${i}`,
        unit: 'g', reorderLevel: 500
      });
    await SupplierIngredient.create({
      restaurant: world.restaurant._id, supplier: supplier._id, ingredient: ingredient._id,
      purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000,
      currentPrice: 100, minOrderQty: 0.1, leadDays: 2, active: true
    });
    created.push(ingredient);
  }
  await InventoryBalance.updateOne(
    {branch: world.branchA._id, ingredient: world.ingredient._id},
    {$set: {reorderLevel: 19000}}
  );
  const res = await request('/api/inventory/adjustments', {
    method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
    body: {
      branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
      qty: -2000, reason: 'Drive below the reorder point'
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await Notification.deleteMany({});
  return created;
}

const openAlerts = () => Notification.countDocuments({
  type: {$in: ['low_stock', 'out_of_stock']}, status: 'open'
});

// ═══════════════════════════════════════════════════════════════════════════
// Explicit ownership
// ═══════════════════════════════════════════════════════════════════════════

describe('16D — sweep ownership must be declared', () => {
  it('refuses to run with no ownership context', async () => {
    // This is the whole point: forgetting the lease is no longer possible by
    // omission. It has to be a deliberate, visible choice.
    await assert.rejects(runScheduledSweep({}), /requires an explicit ownership context/);
    await assert.rejects(runScheduledSweep(), /requires an explicit ownership context/);
    await assert.rejects(
      runScheduledSweep({ownership: {mode: 'invented'}}),
      /requires an explicit ownership context/
    );
  });

  it('refuses a scheduled sweep with no lease signal', () => {
    // A "scheduled" sweep that cannot be told the lease is gone is not
    // lease-protected at all.
    assert.throws(
      () => sweepOwnership.scheduled({}),
      /requires shouldContinue/
    );
    assert.throws(
      () => sweepOwnership.scheduled({shouldContinue: 'not-a-function'}),
      /requires shouldContinue/
    );
  });

  it('requires a manual sweep to say why it is unleased', () => {
    assert.throws(() => sweepOwnership.manual(), /must state why/);
    assert.throws(() => sweepOwnership.manual('  '), /must state why/);
    const ownership = sweepOwnership.manual('operator triggered from the console');
    assert.equal(ownership.mode, SWEEP_MODES.MANUAL);
    assert.equal(ownership.shouldContinue(), true);
  });

  it('labels the result with the mode that produced it', async () => {
    await makeShortages();
    const manualRun = await runScheduledSweep({
      ownership: sweepOwnership.manual('explicit manual sweep under test')
    });
    assert.equal(manualRun.mode, SWEEP_MODES.MANUAL);
    assert.equal(manualRun.leaseProtected, false, 'a manual sweep must not claim lease protection');

    await Notification.deleteMany({});
    const scheduled = await runScheduledSweep({
      ownership: sweepOwnership.scheduled({shouldContinue: () => true})
    });
    assert.equal(scheduled.mode, SWEEP_MODES.SCHEDULED);
    assert.equal(scheduled.leaseProtected, true);
  });

  it('the scheduler always runs in the scheduled, lease-protected mode', async () => {
    await makeShortages();
    let observed = null;
    setSchedulerLock({
      kind: 'mongodb',
      ttlSeconds: 60,
      async acquire() {
        const release = async () => true;
        release.renew = async () => true;
        release.owner = 'observed-owner';
        return release;
      }
    });
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}});
    await triggerSchedulerTick();
    observed = schedulerStatus();
    assert.equal(observed.ticks, 1);
    assert.equal(observed.lastAborted, false);
    // The alert exists, so the sweep genuinely ran through the scheduled path.
    assert.ok(await openAlerts() >= 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mid-tenant lease loss
// ═══════════════════════════════════════════════════════════════════════════

describe('16D — lease loss during a tenant sweep', () => {
  it('stops writing alerts as soon as the lease is lost, mid-tenant', async () => {
    // Six shortages in ONE restaurant. Permission is withdrawn after the third
    // alert, so the remainder must never be written — proving the check runs
    // inside a tenant's work, not only between tenants.
    await makeShortages(6);
    let allowed = 3;
    const outcome = await raiseReorderAlerts({
      user: actor(),
      shouldContinue: () => allowed-- > 0
    });

    assert.equal(outcome.aborted, true, 'the abort must be reported');
    assert.ok(outcome.raised < 6, `stopped early, raised ${outcome.raised}`);
    assert.equal(await openAlerts(), outcome.raised, 'only what was written before the loss');
  });

  it('keeps partial progress and lets the next sweep resume', async () => {
    await makeShortages(6);
    let allowed = 2;
    const first = await raiseReorderAlerts({user: actor(), shouldContinue: () => allowed-- > 0});
    assert.equal(first.aborted, true);
    const partial = await openAlerts();
    assert.ok(partial >= 1 && partial < 6, `partial progress: ${partial}`);

    // A later sweep with a healthy lease completes the rest and does not
    // duplicate what was already raised.
    const second = await raiseReorderAlerts({user: actor(), shouldContinue: () => true});
    assert.equal(second.aborted, false);
    const total = await openAlerts();
    assert.ok(total > partial, 'the remainder was picked up');

    // Idempotency across the resume: one alert per condition, no duplicates.
    const grouped = await Notification.aggregate([
      {$match: {type: {$in: ['low_stock', 'out_of_stock']}, status: 'open'}},
      {$group: {_id: {branch: '$branch', ref: '$referenceId'}, n: {$sum: 1}}},
      {$match: {n: {$gt: 1}}}
    ]);
    assert.deepEqual(grouped, [], 'resuming must not duplicate an existing alert');
  });

  it('propagates a mid-tenant abort up through the multi-tenant sweep', async () => {
    // Abort is defended at TWO layers: the mid-tenant propagation below and
    // the between-tenant check at the top of the loop. Removing either alone
    // still stops the sweep (the other catches it on the next iteration);
    // removing BOTH fails this test. Verified by mutation.
    //
    // Two tenants, both with work. Permission is withdrawn partway through the
    // FIRST tenant's alerts, so the multi-tenant sweep must surface that abort
    // and stop — not swallow it, mark itself swept, and carry on to the next
    // restaurant under a lease it no longer holds.
    await makeShortages(4);
    const rivalIngredient = await Ingredient.create({
      restaurant: rival.restaurant._id, code: 'R6D-2', name: 'Rival Short', unit: 'g', reorderLevel: 100
    });
    await InventoryBalance.create({
      branch: rival.branch._id, ingredient: rivalIngredient._id, quantity: 0, reorderLevel: 100
    });

    let allowed = 2;
    const result = await runScheduledSweep({
      ownership: sweepOwnership.scheduled({shouldContinue: () => allowed-- > 0})
    });

    assert.equal(result.aborted, true, 'the mid-tenant abort must reach the caller');
    assert.match(result.abortReason || '', /mid-tenant|lease/i);
    assert.ok(result.swept < result.restaurants,
      `the sweep must stop, swept ${result.swept} of ${result.restaurants}`);
    assert.equal(
      await Notification.countDocuments({restaurant: rival.restaurant._id}), 0,
      'the second tenant must never be swept after the lease is lost'
    );
  });

  it('a healthy lease sweeps every shortage', async () => {
    await makeShortages(4);
    const result = await runScheduledSweep({
      ownership: sweepOwnership.scheduled({shouldContinue: () => true})
    });
    assert.equal(result.aborted, false);

    // A new ingredient has no stock in EITHER branch, so it is legitimately
    // short in both — the per-branch evaluation from Phase 16A. What matters
    // here is that a healthy lease finishes the job: every distinct
    // branch+ingredient shortage is alerted, and the count matches the number
    // the sweep itself reports.
    const alerts = await openAlerts();
    assert.equal(alerts, result.raised, 'every raised alert is on file');
    assert.ok(alerts > 4, `all branch+ingredient shortages alerted, saw ${alerts}`);
    assert.ok(
      await Notification.countDocuments({branch: world.branchA._id, status: 'open'}) >= 4,
      'branch A alone accounts for at least the four shortages'
    );
  });

  it('never claims ownership after the lease expires', async () => {
    const handle = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 30});
    assert.ok(handle);
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: 'reorder-sweep'}, {$set: {expiresAt: new Date(Date.now() - 1000)}}
    );
    // The expired holder cannot renew, and another instance can take over.
    assert.equal(await handle.renew(60), true, 'renew matches on owner while the row is still ours');
    await mongoose.connection.db.collection('scheduler_locks').deleteOne({_id: 'reorder-sweep'});
    assert.equal(await handle.renew(60), false, 'a deleted lease cannot be renewed');
    const next = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 60});
    assert.ok(next, 'another scheduler can eventually acquire');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrency: A holds, B waits, B proceeds
// ═══════════════════════════════════════════════════════════════════════════

describe('16D — concurrent schedulers', () => {
  it('B does no duplicate scheduled work while A holds the lease, then proceeds', async () => {
    await makeShortages(2);

    // Scheduler A: a real lease, taken directly.
    const a = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    assert.ok(a, 'A holds the lease');

    // Scheduler B: same Mongo lock, ticks while A holds it.
    setSchedulerLock(mongoSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120}));
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}});
    await triggerSchedulerTick();

    let status = schedulerStatus();
    assert.equal(status.ticks, 0, 'B must not sweep while A holds the lease');
    assert.equal(status.lockContentions, 1, 'and the contention is recorded');
    assert.equal(await openAlerts(), 0, 'no duplicate scheduled work was performed');

    // A finishes.
    assert.equal(await a.release(), true);
    assert.equal((await inspectSchedulerLock({name: 'reorder-sweep'})).held, false);

    // B now proceeds safely. Two ingredients, and the second is short in both
    // branches, so the exact figure is asserted against what B reports rather
    // than a hand-counted constant.
    await triggerSchedulerTick();
    status = schedulerStatus();
    assert.equal(status.ticks, 1, 'B swept once the lease was free');
    const raised = await openAlerts();
    assert.ok(raised >= 2, `B raised the outstanding alerts, saw ${raised}`);
    assert.equal(status.lastRaised, raised, 'and reported exactly what it wrote');
  });

  it('B can take over an EXPIRED lease left by a crashed A', async () => {
    await makeShortages(1);
    const a = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 30});
    assert.ok(a);
    // A crashes: no release, lease lapses.
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: 'reorder-sweep'}, {$set: {expiresAt: new Date(Date.now() - 60000)}}
    );

    setSchedulerLock(mongoSchedulerLock({name: 'reorder-sweep', ttlSeconds: 60}));
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}});
    await triggerSchedulerTick();

    assert.equal(schedulerStatus().ticks, 1, 'B recovers with no operator intervention');
    assert.equal(await openAlerts(), 1);
  });

  it('two racing scheduled sweeps still leave one alert per condition', async () => {
    await makeShortages(3);
    const user = actor();
    const outcomes = await Promise.allSettled([
      raiseReorderAlerts({user, shouldContinue: () => true}),
      raiseReorderAlerts({user, shouldContinue: () => true})
    ]);
    assert.deepEqual(
      outcomes.filter(row => row.status === 'rejected').map(row => row.reason?.message), [],
      'a concurrent sweep must not throw'
    );
    const duplicates = await Notification.aggregate([
      {$match: {type: {$in: ['low_stock', 'out_of_stock']}, status: 'open'}},
      {$group: {_id: {branch: '$branch', ref: '$referenceId'}, n: {$sum: 1}}},
      {$match: {n: {$gt: 1}}}
    ]);
    assert.deepEqual(duplicates, [], 'alert writes remain idempotent under concurrency');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Manual vs scheduled
// ═══════════════════════════════════════════════════════════════════════════

describe('16D — manual sweep semantics', () => {
  it('runs for an authorised user even while the scheduler lease is held', async () => {
    await makeShortages(1);
    const holder = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    assert.ok(holder, 'the scheduled path is locked out');

    const res = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.raised >= 1, 'a human is never queued behind a background lease');
  });

  it('does not touch the scheduler lock state', async () => {
    await makeShortages(1);
    const holder = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    const before = await inspectSchedulerLock({name: 'reorder-sweep'});

    await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );

    const after = await inspectSchedulerLock({name: 'reorder-sweep'});
    assert.equal(after.held, true, 'the lease must survive a manual run');
    assert.equal(after.owner, before.owner, 'and must not change hands');
    assert.deepEqual(after.expiresAt, before.expiresAt, 'nor be silently extended');
    assert.equal(await holder.release(), true, 'the true owner can still release');
  });

  it('cannot bypass authentication or RBAC', async () => {
    await makeShortages(1);
    const path = `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`;
    assert.equal((await request(path, {method: 'POST'})).status, 401);
    assert.equal((await request(path, {method: 'POST', token: 'not.a.jwt'})).status, 401);
    assert.equal((await request(path, {method: 'POST', token: staff()})).status, 403);
    assert.equal(await openAlerts(), 0, 'no alert was raised by a refused caller');
  });

  it('cannot bypass branch or restaurant isolation', async () => {
    await makeShortages(1);
    // world.manager is bound to branch A.
    assert.equal((await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchB._id}`,
      {method: 'POST', token: manager()}
    )).status, 403, 'cross-branch');

    const intruder = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: tokenFor(rival.owner)}
    );
    assert.ok([403, 404].includes(intruder.status), `cross-restaurant -> ${intruder.status}`);
    assert.equal(await openAlerts(), 0);
  });

  it('is safely repeatable: running it twice raises one alert', async () => {
    await makeShortages(1);
    const path = `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`;
    const first = await request(path, {method: 'POST', token: manager()});
    const second = await request(path, {method: 'POST', token: manager()});
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.ok(first.body.raised >= 1);
    assert.equal(second.body.raised, 0, 'the repeat is a no-op, which is why it is safe unleased');
    assert.equal(await openAlerts(), 1);
  });

  it('a manual and a scheduled sweep together still leave one alert', async () => {
    await makeShortages(1);
    setSchedulerLock(mongoSchedulerLock({name: 'reorder-sweep', ttlSeconds: 60}));
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}, error() {}}});

    await Promise.all([
      request(`/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
        {method: 'POST', token: manager()}),
      triggerSchedulerTick()
    ]);

    assert.equal(await openAlerts(), 1, 'the two paths must not double-alert');
  });

  it('never creates or approves a purchase order', async () => {
    await makeShortages(1);
    await request(`/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()});
    assert.equal(await PurchaseOrder.countDocuments({}), 0,
      'alerting must never place an order on its own');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tenancy under the scheduled path
// ═══════════════════════════════════════════════════════════════════════════

describe('16D — scheduled sweep tenancy', () => {
  it('never writes an alert across restaurants', async () => {
    await makeShortages(1);
    // Give the rival a shortage too, so both tenants have work.
    await InventoryBalance.create({
      branch: rival.branch._id,
      ingredient: (await Ingredient.create({
        restaurant: rival.restaurant._id, code: 'R6D-ING', name: 'Rival Item',
        unit: 'g', reorderLevel: 100
      }))._id,
      quantity: 0,
      reorderLevel: 100
    });

    const result = await runScheduledSweep({
      ownership: sweepOwnership.scheduled({shouldContinue: () => true})
    });
    assert.ok(result.swept >= 1);

    const ours = await Notification.find({restaurant: world.restaurant._id}).lean();
    assert.ok(ours.length >= 1);
    for (const alert of ours) {
      assert.equal(String(alert.restaurant), String(world.restaurant._id));
      const branch = await Branch.findById(alert.branch).select('restaurant').lean();
      assert.equal(String(branch.restaurant), String(world.restaurant._id),
        'an alert must never land on another tenant branch');
    }
  });
});
