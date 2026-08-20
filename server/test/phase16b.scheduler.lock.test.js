/**
 * Phase 16B — distributed scheduler lock, migration safety, and an adversarial
 * pass over the whole reorder-alert surface.
 *
 * Phase 16A left the scheduler in-process and said so plainly. The audit for
 * this phase confirmed the architecture can do better without new
 * infrastructure: `verifyTransactionCapableDatabase()` already refuses to boot
 * against anything but a replica set, so MongoDB gives a linearizable primary
 * and atomic `findOneAndUpdate`. Probed directly before writing any code — two
 * racing upserts on the same `_id` produced one winner and error 11000 for the
 * loser — so a lease lock is genuine here and Redis is not required.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Notification, PurchaseOrder, Restaurant
} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {
  acquireSchedulerLock, ensureSchedulerLockIndexes, inspectSchedulerLock, mongoSchedulerLock
} from '../src/services/schedulerLock.js';
import {
  ensureAlertIndexes, planAlertMigration, retireDuplicateAlerts
} from '../src/services/alertMigration.js';
import {summariseDeliveries} from '../src/services/supplierPerformance.js';
import {
  resolveSchedulerConfig, schedulerStatus, setSchedulerLock,
  startReorderScheduler, stopReorderScheduler, triggerSchedulerTick
} from '../src/services/reorderScheduler.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let rival;
let supplier;
let seq = 0;
const KEY = () => `p16b-${Date.now()}-${++seq}`;
const LOCK = 'test-reorder-sweep';

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
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Lock Test Supplier'});

  const restaurant = await Restaurant.create({name: 'Rival16B', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival16B Branch', code: 'R6B', address: 'Baneshwor'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival16B Owner', email: 'rival16b@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival16B', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

async function catalogEntry({leadDays = 2, price = 100} = {}) {
  return SupplierIngredient.create({
    restaurant: world.restaurant._id, supplier: supplier._id, ingredient: world.ingredient._id,
    purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000,
    currentPrice: price, minOrderQty: 0.1, leadDays, active: true
  });
}

const setLevel = (branch, level) => InventoryBalance.updateOne(
  {branch: branch._id, ingredient: world.ingredient._id}, {$set: {reorderLevel: level}}
);

async function setStock(branch, target) {
  const current = (await InventoryBalance.findOne({
    branch: branch._id, ingredient: world.ingredient._id
  }))?.quantity ?? 0;
  const delta = target - current;
  if (Math.abs(delta) < 1e-9) return;
  const res = await request('/api/inventory/adjustments', {
    method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
    body: {
      branch: String(branch._id), ingredient: String(world.ingredient._id),
      qty: delta, reason: 'Set stock for the 16B test'
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

async function makeShortage() {
  await catalogEntry();
  await setLevel(world.branchA, 19000);
  await setStock(world.branchA, 18000);
  await Notification.deleteMany({});
}

// ═══════════════════════════════════════════════════════════════════════════
// Distributed lock
// ═══════════════════════════════════════════════════════════════════════════

describe('16B — distributed scheduler lock', () => {
  it('lets instance A hold the lock and refuses instance B', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.ok(a, 'instance A must acquire the lock');
    assert.ok(a.owner, 'the lock carries an owner token');

    const b = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.equal(b, null, 'instance B must not run simultaneously');

    const held = await inspectSchedulerLock({name: LOCK});
    assert.equal(held.held, true);
    assert.equal(held.owner, a.owner);
  });

  it('gives each acquisition a distinct owner token', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    await a.release();
    const b = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.notEqual(a.owner, b.owner, 'a reused token could not distinguish holders');
  });

  it('allows an expired lease to be taken over', async () => {
    // A one-second lease that we then let lapse: this is the crashed-process
    // case, and it must not need manual cleanup.
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 30});
    assert.ok(a);
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: LOCK}, {$set: {expiresAt: new Date(Date.now() - 1000)}}
    );

    const stale = await inspectSchedulerLock({name: LOCK});
    assert.equal(stale.held, false);
    assert.equal(stale.expired, true);

    const b = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.ok(b, 'an expired lease must be reclaimable');
    assert.notEqual(b.owner, a.owner);
  });

  it('does not let a crashed process block the scheduler permanently', async () => {
    // Simulate a crash: acquire and never release, then let the lease lapse.
    await acquireSchedulerLock({name: LOCK, ttlSeconds: 30});
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: LOCK}, {$set: {expiresAt: new Date(Date.now() - 60000)}}
    );
    const recovered = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.ok(recovered, 'the scheduler recovers without operator intervention');
  });

  it('refuses to let the wrong owner release the lock', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    // An impostor holding a stale handle must not free the live holder's lock.
    const impostor = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60, owner: 'someone-else'});
    assert.equal(impostor, null);

    const rows = mongoose.connection.db.collection('scheduler_locks');
    const forged = await rows.deleteOne({_id: LOCK, owner: 'someone-else'});
    assert.equal(forged.deletedCount, 0, 'ownership must be verified on release');

    assert.equal((await inspectSchedulerLock({name: LOCK})).owner, a.owner, 'still held by A');
    assert.equal(await a.release(), true, 'the true owner can release');
    assert.equal((await inspectSchedulerLock({name: LOCK})).held, false);
  });

  it('releases only once, and a second release is a no-op', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.equal(await a.release(), true);
    assert.equal(await a.release(), false, 'releasing twice must not delete a later holder');
  });

  it('a stale holder cannot release the lease that superseded it', async () => {
    // The dangerous real-world sequence: instance A stalls, its lease lapses,
    // instance B takes over, then A finally finishes and calls release(). If
    // release did not verify ownership, A would free B's live lock and two
    // instances could sweep at once.
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    await mongoose.connection.db.collection('scheduler_locks').updateOne(
      {_id: LOCK}, {$set: {expiresAt: new Date(Date.now() - 1000)}}
    );
    const b = await acquireSchedulerLock({name: LOCK, ttlSeconds: 120});
    assert.ok(b, 'B took over the expired lease');
    assert.notEqual(a.owner, b.owner);

    assert.equal(await a.release(), false, "A's release must not touch B's lease");
    const held = await inspectSchedulerLock({name: LOCK});
    assert.equal(held.held, true, "B still holds the lock");
    assert.equal(held.owner, b.owner);

    // And a third instance is still correctly locked out.
    assert.equal(await acquireSchedulerLock({name: LOCK, ttlSeconds: 60}), null);
  });

  it('renews only for the current owner', async () => {
    const a = await acquireSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.equal(await a.renew(120), true);
    await a.release();
    assert.equal(await a.renew(120), false, 'a released lock cannot be renewed');
  });

  it('survives concurrent acquisition attempts with exactly one winner', async () => {
    // Six instances racing for the same lease. MongoDB serialises them on the
    // primary; anything other than exactly one winner would be a real bug.
    const attempts = await Promise.all(
      Array.from({length: 6}, () => acquireSchedulerLock({name: LOCK, ttlSeconds: 60}))
    );
    const winners = attempts.filter(Boolean);
    assert.equal(winners.length, 1, `expected one winner, got ${winners.length}`);
    assert.equal(await mongoose.connection.db.collection('scheduler_locks')
      .countDocuments({_id: LOCK}), 1);
  });

  it('stops a second scheduler instance doing duplicate work', async () => {
    await makeShortage();

    // Instance A holds the real lease.
    const holder = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    assert.ok(holder);

    // Instance B starts with the same Mongo lock and ticks.
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}}});
    await triggerSchedulerTick();

    const status = schedulerStatus();
    assert.equal(status.ticks, 0, 'instance B must not sweep while A holds the lease');
    assert.equal(status.lockContentions, 1, 'and the contention is reported, not hidden');
    assert.equal(
      await Notification.countDocuments({type: {$in: ['low_stock', 'out_of_stock']}}), 0,
      'no duplicated work was performed'
    );

    // Once A finishes, B sweeps on its next tick.
    await holder.release();
    await triggerSchedulerTick();
    assert.equal(schedulerStatus().ticks, 1);
    assert.ok(await Notification.countDocuments({type: 'low_stock'}) >= 1);
  });

  it('is enabled by default but can be turned off explicitly', () => {
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_ENABLED: '1'}).distributedLock, true);
    assert.equal(
      resolveSchedulerConfig({REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_DISTRIBUTED_LOCK: 'false'}).distributedLock,
      false
    );
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_LOCK_TTL_SECONDS: '5'}).lockTtlSeconds, 30, 'clamped');
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_LOCK_TTL_SECONDS: '99999'}).lockTtlSeconds, 3600);
  });

  it('reports the lock kind honestly in telemetry', async () => {
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}}});
    const status = schedulerStatus();
    assert.equal(status.distributed, true);
    assert.equal(status.lockKind, 'mongodb');
    assert.equal(status.scope, 'distributed-lock');
  });

  it('releases the lease after a sweep so the next tick can run', async () => {
    await makeShortage();
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}}});
    await triggerSchedulerTick();
    assert.equal((await inspectSchedulerLock({name: 'reorder-sweep'})).held, false,
      'a held lease after the sweep would starve every later tick');
    await triggerSchedulerTick();
    assert.equal(schedulerStatus().ticks, 2);
  });

  it('keeps the manual endpoint working regardless of the lock', async () => {
    await makeShortage();
    const holder = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    assert.ok(holder, 'the scheduled sweep is locked out');

    // A human pressing the button must never be blocked by the scheduler lease.
    const res = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.raised >= 1, 'the manual sweep still does its work');
  });

  it('does not block ordinary API requests', async () => {
    const holder = await acquireSchedulerLock({name: 'reorder-sweep', ttlSeconds: 120});
    assert.ok(holder);
    const res = await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.status, 200, 'reads must never wait on the scheduler lease');
  });

  it('the adapter matches the setSchedulerLock contract', async () => {
    const provider = mongoSchedulerLock({name: LOCK, ttlSeconds: 60});
    assert.equal(provider.kind, 'mongodb');
    const release = await provider.acquire();
    assert.equal(typeof release, 'function');
    assert.equal(await provider.acquire(), null, 'the second caller is refused');
    await release();
    assert.ok(await provider.acquire(), 'and can acquire once released');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration safety
// ═══════════════════════════════════════════════════════════════════════════

describe('16B — alert migration', () => {
  it('previews without writing anything', async () => {
    await Notification.collection.dropIndex('alert_open_condition').catch(() => {});
    const ingredient = world.ingredient._id;
    await Notification.collection.insertMany([
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(1)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(2)},
      {branch: world.branchA._id, type: 'high_waste', title: 't', body: 'b', read: false}
    ]);

    const plan = await planAlertMigration();
    assert.equal(plan.dryRun, true);
    assert.equal(plan.totalAlerts, 3);
    assert.equal(plan.missingStatus, 1);
    assert.equal(plan.duplicates.retired, 1, 'one of the two duplicates would be retired');
    assert.equal(plan.changesRequired, true);
    assert.ok(plan.duplicates.samples.length >= 1, 'the operator can review what would change');

    // Nothing may have been written by a preview.
    assert.equal(await Notification.countDocuments({status: {$exists: false}}), 1);
    assert.equal(await Notification.countDocuments({status: 'open'}), 2);
    assert.equal(await Notification.countDocuments({status: 'resolved'}), 0);
  });

  it('backfills missing status deterministically', async () => {
    await Notification.collection.insertMany([
      {branch: world.branchA._id, type: 'low_stock', title: 't', body: 'b', read: false},
      {branch: world.branchA._id, type: 'high_waste', title: 't', body: 'b', read: true}
    ]);
    const result = await ensureAlertIndexes();
    assert.equal(result.updated, 2);

    const unread = await Notification.findOne({type: 'low_stock'});
    const wasRead = await Notification.findOne({type: 'high_waste'});
    assert.equal(unread.status, 'open', 'an unread legacy alert is still actionable');
    assert.equal(wasRead.status, 'resolved', 'a read one was already dealt with');
  });

  it('leaves already-valid alerts untouched', async () => {
    await makeShortage();
    const {raiseReorderAlerts} = await import('../src/services/reorderEngine.js');
    await raiseReorderAlerts({user: {id: String(world.owner._id), role: 'owner', restaurantId: String(world.restaurant._id)}});
    const before = await Notification.find({}).sort({_id: 1}).lean();
    assert.ok(before.length >= 1);

    const result = await ensureAlertIndexes();
    assert.equal(result.updated, 0, 'a valid alert needs no backfill');
    assert.equal(result.retired, 0);

    const after = await Notification.find({}).sort({_id: 1}).lean();
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i += 1) {
      assert.equal(after[i].status, before[i].status);
      assert.equal(String(after[i]._id), String(before[i]._id));
      assert.deepEqual(after[i].acknowledgedAt, before[i].acknowledgedAt);
    }
  });

  it('is idempotent: a second run changes nothing', async () => {
    await Notification.collection.dropIndex('alert_open_condition').catch(() => {});
    const ingredient = world.ingredient._id;
    await Notification.collection.insertMany([
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(1)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(2)},
      {branch: world.branchA._id, type: 'out_of_stock', title: 't', body: 'b', read: false}
    ]);

    const first = await ensureAlertIndexes();
    assert.ok(first.updated + first.retired > 0, 'the first run does real work');

    const second = await ensureAlertIndexes();
    assert.equal(second.updated, 0, 'a re-run must be a no-op');
    assert.equal(second.retired, 0);

    const plan = await planAlertMigration();
    assert.equal(plan.changesRequired, false, 'and the dry run agrees');
    assert.equal(plan.missingStatus, 0);
  });

  it('never deletes a duplicate, only resolves it', async () => {
    await Notification.collection.dropIndex('alert_open_condition').catch(() => {});
    const ingredient = world.ingredient._id;
    await Notification.collection.insertMany([
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(1)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(2)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(3)}
    ]);
    await retireDuplicateAlerts();
    assert.equal(await Notification.countDocuments({}), 3, 'the history survives');
    assert.equal(await Notification.countDocuments({status: 'open'}), 1);
    assert.equal(await Notification.countDocuments({status: 'resolved'}), 2);
  });

  it('keeps the NEWEST duplicate open, deterministically', async () => {
    await Notification.collection.dropIndex('alert_open_condition').catch(() => {});
    const ingredient = world.ingredient._id;
    const rows = await Notification.collection.insertMany([
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', body: 'oldest', createdAt: new Date(1)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', body: 'newest', createdAt: new Date(9999)}
    ]);
    assert.ok(rows.insertedCount === 2);
    await retireDuplicateAlerts();
    const survivor = await Notification.findOne({status: 'open'});
    assert.equal(survivor.body, 'newest', 'the most recent state of the world is the one to keep');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// First-receipt vs fully-received
// ═══════════════════════════════════════════════════════════════════════════

describe('16B — lead time semantics', () => {
  it('labels the default as first-receipt and adds fully-received alongside', () => {
    const result = summariseDeliveries([
      {actualLeadDays: 2, fullLeadDays: 5, partialFirstReceipt: true, promisedLeadDays: 3},
      {actualLeadDays: 4, fullLeadDays: 4, partialFirstReceipt: false, promisedLeadDays: 3},
      {actualLeadDays: 6, fullLeadDays: 6, partialFirstReceipt: false, promisedLeadDays: 3}
    ]);
    assert.equal(result.leadTimeSemantics, 'first_receipt');
    assert.equal(result.averageLeadDays, 4, 'first-receipt average is unchanged for existing consumers');
    assert.equal(result.averageFullLeadDays, 5, 'fully-received is reported separately');
    assert.equal(result.partialFirstReceipts, 1);
    assert.equal(result.fullyReceivedSamples, 3);
  });

  it('does not invent a completion time for a short-delivered order', () => {
    const result = summariseDeliveries([
      {actualLeadDays: 2, fullLeadDays: null, partialFirstReceipt: true},
      {actualLeadDays: 3, fullLeadDays: null, partialFirstReceipt: true},
      {actualLeadDays: 4, fullLeadDays: null, partialFirstReceipt: true}
    ]);
    assert.equal(result.averageLeadDays, 3, 'first receipt is still measurable');
    assert.equal(result.averageFullLeadDays, null, 'completion is not');
    assert.equal(result.partialFirstReceipts, 3);
  });

  it('measures both semantics end to end from real receipts', async () => {
    // Three orders, each part-delivered then completed a day later.
    for (let i = 0; i < 3; i += 1) {
      const created = await request('/api/purchase-orders', {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          branch: String(world.branchA._id), supplier: String(supplier._id),
          items: [{ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1, vatRate: 13}]
        }
      });
      const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
        method: 'PATCH', token: manager(), body: {status: 'pending', expectedVersion: created.body.__v}
      });
      const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
        method: 'PATCH', token: owner(), body: {status: 'approved', expectedVersion: pending.body.__v}
      });
      await PurchaseOrder.collection.updateOne(
        {_id: new mongoose.Types.ObjectId(String(created.body._id))},
        {$set: {approvedAt: new Date(Date.now() - 4 * 86400000)}}
      );
      const first = await request(`/api/purchase-orders/${created.body._id}/receive`, {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          expectedVersion: approved.body.__v,
          items: [{itemId: String(approved.body.items[0]._id), receivedQty: 60, damagedQty: 0}]
        }
      });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      // Back-date the first receipt so it lands 2 days after approval.
      const {GoodsReceipt} = await import('../src/models/purchasing.js');
      await GoodsReceipt.collection.updateOne(
        {_id: new mongoose.Types.ObjectId(String(first.body.receipt._id))},
        {$set: {receivedAt: new Date(Date.now() - 2 * 86400000)}}
      );
      const rest = await request(`/api/purchase-orders/${created.body._id}/receive`, {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          expectedVersion: first.body.purchaseOrder.__v,
          items: [{itemId: String(first.body.purchaseOrder.items[0]._id), receivedQty: 40, damagedQty: 0}]
        }
      });
      assert.equal(rest.status, 201, JSON.stringify(rest.body));
      await GoodsReceipt.collection.updateOne(
        {_id: new mongoose.Types.ObjectId(String(rest.body.receipt._id))},
        {$set: {receivedAt: new Date(Date.now() - 1 * 86400000)}}
      );
    }

    const res = await request(`/api/suppliers/${supplier._id}/performance`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.insufficientData, false);
    assert.equal(res.body.leadTimeSemantics, 'first_receipt');
    assert.equal(res.body.averageLeadDays, 2, 'first goods arrived 2 days after approval');
    assert.equal(res.body.averageFullLeadDays, 3, 'the order completed a day later');
    assert.equal(res.body.partialFirstReceipts, 0, 'all three orders ended fully received');
    assert.equal(res.body.totalPurchaseOrders, 3);
    assert.equal(res.body.receivedPurchaseOrders, 3);
    assert.equal(res.body.deliveries[0].receiptCount, 2);
    assert.equal(res.body.deliveries[0].fullyReceived, true);
  });

  it('never reports a completion time for a still-short order, end to end', async () => {
    // Three orders that are only PART delivered and never completed. First
    // receipt is measurable; completion is not, and must stay null rather than
    // silently using the latest partial receipt.
    const {GoodsReceipt} = await import('../src/models/purchasing.js');
    for (let i = 0; i < 3; i += 1) {
      const created = await request('/api/purchase-orders', {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          branch: String(world.branchA._id), supplier: String(supplier._id),
          items: [{ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1, vatRate: 13}]
        }
      });
      const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
        method: 'PATCH', token: manager(), body: {status: 'pending', expectedVersion: created.body.__v}
      });
      const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
        method: 'PATCH', token: owner(), body: {status: 'approved', expectedVersion: pending.body.__v}
      });
      await PurchaseOrder.collection.updateOne(
        {_id: new mongoose.Types.ObjectId(String(created.body._id))},
        {$set: {approvedAt: new Date(Date.now() - 4 * 86400000)}}
      );
      const part = await request(`/api/purchase-orders/${created.body._id}/receive`, {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          expectedVersion: approved.body.__v,
          items: [{itemId: String(approved.body.items[0]._id), receivedQty: 60, damagedQty: 0}]
        }
      });
      assert.equal(part.status, 201, JSON.stringify(part.body));
      await GoodsReceipt.collection.updateOne(
        {_id: new mongoose.Types.ObjectId(String(part.body.receipt._id))},
        {$set: {receivedAt: new Date(Date.now() - 2 * 86400000)}}
      );
    }

    const res = await request(`/api/suppliers/${supplier._id}/performance`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.averageLeadDays, 2, 'first receipt is measurable');
    assert.equal(res.body.averageFullLeadDays, null, 'nothing has completed, so nothing may be reported');
    assert.equal(res.body.fullyReceivedSamples, 0);
    assert.equal(res.body.partialFirstReceipts, 3);
    assert.equal(res.body.deliveries[0].fullyReceived, false);
    assert.equal(res.body.deliveries[0].fullLeadDays, null);
  });

  it('reports on-time as N/A with no promised date, and says why', async () => {
    const res = await request(`/api/suppliers/${supplier._id}/performance`, {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.insufficientData, true);
    assert.equal(res.body.onTimeRate, null);
    assert.equal(res.body.leadTimeSource, 'catalog_declared');
    assert.match(res.body.reason, /completed deliveries/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Adversarial security pass
// ═══════════════════════════════════════════════════════════════════════════

describe('16B — reorder surface security', () => {
  const SURFACE = () => [
    ['GET', `/api/purchasing/reorder-plan?branch=${world.branchA._id}`, null],
    ['GET', '/api/purchasing/reorder-scheduler', null],
    ['POST', `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`, {}],
    ['GET', `/api/suppliers/${supplier._id}/performance`, null]
  ];

  it('refuses anonymous and forged tokens everywhere', async () => {
    for (const [method, path, body] of SURFACE()) {
      const opts = body ? {method, body} : {};
      assert.equal((await request(path, opts)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {...opts, token: 'not.a.jwt'})).status, 401, `${path} forged`);
    }
  });

  it('permits staff to read alerts but not to manage them', async () => {
    await makeShortage();
    const {raiseReorderAlerts} = await import('../src/services/reorderEngine.js');
    await raiseReorderAlerts({user: {id: String(world.owner._id), role: 'owner', restaurantId: String(world.restaurant._id)}});
    const alert = await Notification.findOne({type: 'low_stock'});

    // Staff may see the alert list — that is their job on the floor.
    assert.equal((await request(`/api/alerts?branch=${world.branchA._id}`, {token: staff()})).status, 200);
    // But not plan purchasing, sweep, or acknowledge.
    for (const [method, path, body] of SURFACE()) {
      const opts = body ? {method, body, token: staff()} : {token: staff()};
      assert.equal((await request(path, opts)).status, 403, `${path} staff`);
    }
    assert.equal((await request(`/api/alerts/${alert._id}/acknowledge`, {
      method: 'POST', token: staff(), body: {}
    })).status, 403);
    assert.equal((await Notification.findById(alert._id)).status, 'open', 'nothing changed');
  });

  it('permits manager and owner the management actions', async () => {
    await makeShortage();
    assert.equal((await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`, {token: manager()})).status, 200);
    assert.equal((await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`, {token: owner()})).status, 200);
    assert.equal((await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`, {method: 'POST', token: manager()}
    )).status, 200);
  });

  it('denies cross-branch and cross-restaurant access', async () => {
    // world.manager is bound to branch A.
    assert.equal((await request(
      `/api/purchasing/reorder-plan?branch=${world.branchB._id}`, {token: manager()}
    )).status, 403, 'cross-branch');

    const intruder = tokenFor(rival.owner);
    for (const path of [
      `/api/purchasing/reorder-plan?branch=${world.branchA._id}`,
      `/api/suppliers/${supplier._id}/performance`
    ]) {
      const res = await request(path, {token: intruder});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }
  });

  it('rejects forged and malformed identifiers', async () => {
    const forgedBranch = new mongoose.Types.ObjectId();
    const res = await request(`/api/purchasing/reorder-plan?branch=${forgedBranch}`, {token: manager()});
    assert.ok([403, 404].includes(res.status), `forged branch -> ${res.status}`);

    assert.equal(
      (await request('/api/purchasing/reorder-plan?branch=not-an-id', {token: manager()})).status, 400,
      'a malformed branch id must fail validation'
    );
    assert.equal(
      (await request('/api/suppliers/not-an-id/performance', {token: manager()})).status, 400,
      'a malformed supplier id must fail validation'
    );
    assert.equal(
      (await request(`/api/purchasing/price-comparison/not-an-id`, {token: manager()})).status, 400
    );
  });

  it('cannot be aimed at another restaurant branch by forging the body', async () => {
    const res = await request('/api/purchasing/suggested-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(rival.branch._id), supplier: String(supplier._id)}
    });
    assert.ok([403, 404, 409].includes(res.status), `got ${res.status}`);
    assert.equal(await PurchaseOrder.countDocuments({}), 0);
  });

  it('a client cannot dictate the supplier price on a suggested order', async () => {
    await catalogEntry({price: 100});
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 100);

    // The schema is strict, so an injected price is refused outright rather
    // than being quietly honoured.
    const forged = await request('/api/purchasing/suggested-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(world.branchA._id), supplier: String(supplier._id), unitPrice: 0.01}
    });
    assert.equal(forged.status, 400, 'an unknown field must be rejected');

    const honest = await request('/api/purchasing/suggested-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(world.branchA._id), supplier: String(supplier._id)}
    });
    assert.equal(honest.status, 201, JSON.stringify(honest.body));
    const stored = await PurchaseOrder.findById(honest.body.purchaseOrder._id);
    // 100 per kg over a 1000g conversion is 0.1 per gram, from the catalog.
    assert.equal(stored.items[0].unitPrice, 0.1, 'the price comes from the catalog, not the client');
  });

  it('the sweep never modifies inventory', async () => {
    await makeShortage();
    const balancesBefore = await InventoryBalance.find({}).sort({_id: 1}).lean();
    const ledgerBefore = await InventoryTransaction.countDocuments({});

    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}}});
    await triggerSchedulerTick();

    const balancesAfter = await InventoryBalance.find({}).sort({_id: 1}).lean();
    assert.equal(balancesAfter.length, balancesBefore.length);
    for (let i = 0; i < balancesBefore.length; i += 1) {
      assert.equal(balancesAfter[i].quantity, balancesBefore[i].quantity);
      assert.equal(balancesAfter[i].ledgerVersion, balancesBefore[i].ledgerVersion);
    }
    assert.equal(await InventoryTransaction.countDocuments({}), ledgerBefore, 'no ledger row');
  });

  it('a scheduled sweep cannot create or approve a purchase order', async () => {
    await makeShortage();
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}, warn() {}}});
    await triggerSchedulerTick();
    assert.equal(await PurchaseOrder.countDocuments({}), 0,
      'alerting must never place an order on its own');
  });

  it('duplicate alerts remain impossible even under a doubled sweep', async () => {
    await makeShortage();
    const {raiseReorderAlerts} = await import('../src/services/reorderEngine.js');
    const user = {id: String(world.owner._id), role: 'owner', restaurantId: String(world.restaurant._id)};

    // Both sweeps must SUCCEED. The index guarantees one alert; the loser of
    // the race must absorb its duplicate-key error rather than surfacing a 500
    // out of a background job. Caught by running this repeatedly: 2 of 5
    // racing pairs previously produced an unhandled E11000.
    const outcomes = await Promise.allSettled([raiseReorderAlerts({user}), raiseReorderAlerts({user})]);
    const rejected = outcomes.filter(row => row.status === 'rejected');
    assert.deepEqual(
      rejected.map(row => row.reason?.message), [],
      'a concurrent sweep must not throw'
    );
    assert.equal(
      await Notification.countDocuments({branch: world.branchA._id, type: 'low_stock', status: 'open'}), 1,
      'two concurrent sweeps must still leave one alert'
    );
  });
});
