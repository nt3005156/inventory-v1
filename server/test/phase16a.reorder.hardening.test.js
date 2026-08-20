/**
 * Phase 16A — production hardening for reorder alerts.
 *
 * The reorder engine, alert list, PO workflow, tenancy guards and Socket.IO
 * infrastructure all already existed and were NOT replaced. Auditing them
 * against the running API found one real defect and four missing capabilities:
 *
 *   DEFECT — a restaurant-wide reorder plan SUMMED stock across branches, so a
 *   branch that was genuinely short was masked by a well-stocked sibling.
 *   Reproduced: branch A on 18000 against a reorder level of 19000, branch B on
 *   20000; the branch-scoped plan reported 1 line, the owner-wide plan reported
 *   0 and the sweep raised nothing. Any alert it did raise carried
 *   `branch: null` — nobody's alert.
 *
 *   MISSING — scheduled sweep, alert lifecycle (acknowledge/resolve) with
 *   database-level duplicate suppression, supplier performance measured from
 *   real history, and refinement of the flat 30-day usage mean.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Notification, PurchaseOrder, Restaurant
} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {ensureAlertIndexes, retireDuplicateAlerts} from '../src/services/alertMigration.js';
import {
  MIN_DAYS_FOR_TREND, MIN_DAYS_FOR_WEEKDAY, buildReorderPlan, raiseReorderAlerts, refineUsage
} from '../src/services/reorderEngine.js';
import {
  MIN_SAMPLES_FOR_LEAD_TIME, medianOf, summariseDeliveries
} from '../src/services/supplierPerformance.js';
import {
  resolveSchedulerConfig, runScheduledSweep, schedulerStatus, setSchedulerLock,
  startReorderScheduler, stopReorderScheduler, triggerSchedulerTick
} from '../src/services/reorderScheduler.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let rival;
let supplier;
let seq = 0;
const KEY = () => `p16a-${Date.now()}-${++seq}`;

before(async () => { await startTestApp(); });
after(async () => { await stopReorderScheduler(); await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  seq = 0;
  await stopReorderScheduler();
  setSchedulerLock(null);
  world = await seedWorld();
  await ensureAlertIndexes();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Hardening Supplier'});

  const restaurant = await Restaurant.create({name: 'Rival16A', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival16A Branch', code: 'R6A', address: 'Lazimpat'
  });
  rival = {
    restaurant,
    branch,
    ingredient: await Ingredient.create({
      restaurant: restaurant._id, code: 'R6A-ING', name: 'Rival Flour', unit: 'g', reorderLevel: 100
    }),
    owner: await User.create({
      name: 'Rival16A Owner', email: 'rival16a@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival16A', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const actor = user => ({id: String(user._id), role: user.role, restaurantId: String(world.restaurant._id)});

async function inTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let out;
    await session.withTransaction(async () => { out = await fn(session); });
    return out;
  } finally {
    await session.endSession();
  }
}

async function catalogEntry({leadDays = 2, price = 100, sup = null, ing = null} = {}) {
  return SupplierIngredient.create({
    restaurant: world.restaurant._id, supplier: (sup || supplier)._id,
    ingredient: (ing || world.ingredient)._id,
    purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000,
    currentPrice: price, minOrderQty: 0.1, leadDays, active: true
  });
}

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
      qty: delta, reason: 'Set stock for the hardening test'
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
}

const setLevel = (branch, level) => InventoryBalance.updateOne(
  {branch: branch._id, ingredient: world.ingredient._id}, {$set: {reorderLevel: level}}
);

// ═══════════════════════════════════════════════════════════════════════════
// The per-branch defect
// ═══════════════════════════════════════════════════════════════════════════

describe('16A — per-branch evaluation', () => {
  it('does not let a well-stocked branch mask a short one', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setLevel(world.branchB, 4000);
    await setStock(world.branchA, 18000);
    await setStock(world.branchB, 20000);

    const scoped = await buildReorderPlan({branchId: String(world.branchA._id), user: world.owner});
    assert.equal(scoped.lines.length, 1, 'control: the branch-scoped plan already saw it');

    const wide = await buildReorderPlan({user: world.owner});
    const line = wide.lines.find(row => String(row.branch) === String(world.branchA._id));
    assert.ok(line, 'a restaurant-wide plan must still see the short branch');
    assert.equal(line.currentStock, 18000, 'stock must not be summed across branches');
    assert.equal(line.branchCode, 'KTM');
    assert.equal(line.urgency, 'reorder');
  });

  it('reports each branch on its own merits', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setLevel(world.branchB, 19000);
    await setStock(world.branchA, 18000);
    await setStock(world.branchB, 18500);

    const wide = await buildReorderPlan({user: world.owner});
    const byBranch = Object.fromEntries(
      wide.lines.filter(l => String(l.ingredient) === String(world.ingredient._id))
        .map(l => [l.branchCode, l.currentStock])
    );
    assert.equal(byBranch.KTM, 18000);
    assert.equal(byBranch.LTP, 18500);
  });

  it('attributes the alert to the branch that is short', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 18000);
    await Notification.deleteMany({});

    const result = await raiseReorderAlerts({user: actor(world.owner)});
    assert.ok(result.raised >= 1, JSON.stringify(result));

    const alerts = await Notification.find({type: {$in: ['low_stock', 'out_of_stock']}}).lean();
    assert.ok(alerts.length >= 1);
    for (const alert of alerts) {
      assert.ok(alert.branch, 'an alert with no branch belongs to nobody');
      assert.equal(String(alert.branch), String(world.branchA._id));
      assert.equal(String(alert.restaurant), String(world.restaurant._id));
      assert.equal(alert.status, 'open');
      assert.equal(alert.severity, 'warning');
      assert.ok(alert.context?.reorderPoint !== undefined, 'the alert carries its evidence');
    }
  });

  it('keeps usage and on-order per branch', async () => {
    await catalogEntry();
    // Consume only in branch A.
    const tx = await inTransaction(session => moveStock({
      branch: world.branchA._id, ingredient: world.ingredient._id, qty: -500, unit: 'g',
      type: 'RECIPE_DEDUCTION', reason: 'Branch A usage only', referenceType: 'order',
      referenceId: new mongoose.Types.ObjectId(), user: world.owner._id, idempotencyKey: KEY()
    }, session));
    await InventoryTransaction.collection.updateOne(
      {_id: tx._id}, {$set: {createdAt: new Date(Date.now() - 2 * 86400000)}}
    );
    await setLevel(world.branchA, 19000);
    await setLevel(world.branchB, 19000);
    await setStock(world.branchA, 100);
    await setStock(world.branchB, 100);

    const wide = await buildReorderPlan({user: world.owner});
    const a = wide.lines.find(l => l.branchCode === 'KTM' && String(l.ingredient) === String(world.ingredient._id));
    const b = wide.lines.find(l => l.branchCode === 'LTP' && String(l.ingredient) === String(world.ingredient._id));
    assert.ok(a.averageDailyUsage > 0, 'branch A consumed');
    assert.equal(b.averageDailyUsage, 0, "branch B's average must not inherit branch A's usage");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Alert persistence and lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe('16A — alert lifecycle', () => {
  async function openAlert() {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 18000);
    await Notification.deleteMany({});
    await raiseReorderAlerts({user: actor(world.owner)});
    const alert = await Notification.findOne({branch: world.branchA._id, type: 'low_stock'});
    assert.ok(alert, 'an alert must have been raised');
    return alert;
  }

  it('persists the alert with its lifecycle fields', async () => {
    const alert = await openAlert();
    assert.equal(alert.status, 'open');
    assert.equal(alert.acknowledgedAt, undefined);
    assert.ok(alert.createdAt);
    assert.ok(alert.ingredient);
  });

  it('acknowledges with the actor and timestamp', async () => {
    const alert = await openAlert();
    const res = await request(`/api/alerts/${alert._id}/acknowledge`, {
      method: 'POST', token: manager(), body: {note: 'Ordering this afternoon'}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await Notification.findById(alert._id);
    assert.equal(stored.status, 'acknowledged');
    assert.ok(stored.acknowledgedAt);
    assert.equal(String(stored.acknowledgedBy), String(world.manager._id));
    assert.equal(stored.resolutionNote, 'Ordering this afternoon');
    assert.equal(stored.read, true, 'acknowledging also clears the unread flag');
  });

  it('resolves, and only then allows the condition to alert again', async () => {
    const alert = await openAlert();
    // While open, a re-sweep must not duplicate it.
    const again = await raiseReorderAlerts({user: actor(world.owner)});
    assert.equal(again.raised, 0, 'an open alert must not be raised twice');
    assert.equal(await Notification.countDocuments({branch: world.branchA._id, type: 'low_stock'}), 1);

    const res = await request(`/api/alerts/${alert._id}/resolve`, {
      method: 'POST', token: manager(), body: {note: 'Restocked'}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = await Notification.findById(alert._id);
    assert.equal(stored.status, 'resolved');
    assert.ok(stored.resolvedAt);

    // Resolved frees the condition, so a recurrence is reported.
    const third = await raiseReorderAlerts({user: actor(world.owner)});
    assert.equal(third.raised, 1, 'a recurrence after resolution must alert again');
    assert.equal(await Notification.countDocuments({branch: world.branchA._id, type: 'low_stock'}), 2);
  });

  it('refuses to acknowledge a resolved alert', async () => {
    const alert = await openAlert();
    await request(`/api/alerts/${alert._id}/resolve`, {method: 'POST', token: manager(), body: {}});
    const res = await request(`/api/alerts/${alert._id}/acknowledge`, {
      method: 'POST', token: manager(), body: {}
    });
    assert.equal(res.status, 409);
  });

  it('prevents duplicates at the DATABASE, not only in application code', async () => {
    const alert = await openAlert();
    // Bypass the service entirely: the index must still refuse.
    await assert.rejects(
      Notification.create({
        branch: alert.branch, restaurant: world.restaurant._id, type: 'low_stock',
        title: 'Duplicate', body: 'Duplicate', referenceId: alert.referenceId, status: 'open'
      }),
      /E11000|duplicate key/i
    );
    assert.equal(await Notification.countDocuments({branch: world.branchA._id, type: 'low_stock'}), 1);
  });

  it('restricts acknowledgement to management and to the tenant', async () => {
    const alert = await openAlert();
    assert.equal((await request(`/api/alerts/${alert._id}/acknowledge`, {
      method: 'POST', token: staff(), body: {}
    })).status, 403);
    assert.equal((await request(`/api/alerts/${alert._id}/acknowledge`, {method: 'POST', body: {}})).status, 401);
    const cross = await request(`/api/alerts/${alert._id}/acknowledge`, {
      method: 'POST', token: tokenFor(rival.owner), body: {}
    });
    assert.ok([403, 404].includes(cross.status), `got ${cross.status}`);
    assert.equal((await Notification.findById(alert._id)).status, 'open', 'nothing changed');
  });

  it('retires legacy duplicates before the index is built', async () => {
    // Drop the index first: this reproduces a PRE-migration database, which is
    // the only state in which these duplicates can exist.
    await Notification.collection.dropIndex('alert_open_condition').catch(() => {});
    const ingredient = world.ingredient._id;
    await Notification.collection.insertMany([
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(Date.now() - 2000)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date(Date.now() - 1000)},
      {branch: world.branchA._id, type: 'low_stock', referenceId: ingredient, status: 'open', createdAt: new Date()}
    ]);
    const result = await retireDuplicateAlerts();
    assert.equal(result.retired, 2, 'only the newest survives as open');
    assert.equal(await Notification.countDocuments({
      branch: world.branchA._id, type: 'low_stock', status: 'open'
    }), 1);
    assert.equal(await Notification.countDocuments({
      branch: world.branchA._id, type: 'low_stock', status: 'resolved'
    }), 2, 'the others are resolved, not deleted');

    // And the index builds cleanly once the duplicates are retired.
    const built = await ensureAlertIndexes();
    assert.ok(built.indexes.includes('alert_open_condition'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Scheduler
// ═══════════════════════════════════════════════════════════════════════════

describe('16A — scheduler', () => {
  it('is disabled unless explicitly enabled', () => {
    assert.equal(resolveSchedulerConfig({}).enabled, false);
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_ENABLED: 'true'}).enabled, true);
    const started = startReorderScheduler({env: {}});
    assert.equal(started.started, false);
    assert.equal(schedulerStatus().running, false);
  });

  it('clamps the interval to a sane range', () => {
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_INTERVAL_MINUTES: '0'}).intervalMinutes, 1);
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_INTERVAL_MINUTES: '99999'}).intervalMinutes, 1440);
    assert.equal(resolveSchedulerConfig({REORDER_SCHEDULER_INTERVAL_MINUTES: 'nonsense'}).intervalMinutes, 60);
    assert.equal(resolveSchedulerConfig({}).intervalMinutes, 60);
  });

  it('never starts a second timer however many modules initialise it', () => {
    const env = {REORDER_SCHEDULER_ENABLED: '1', REORDER_SCHEDULER_INTERVAL_MINUTES: '5'};
    const first = startReorderScheduler({env, logger: {log() {}}});
    assert.equal(first.started, true);
    const second = startReorderScheduler({env, logger: {log() {}}});
    assert.equal(second.started, false);
    assert.match(second.reason, /already running/);
    assert.equal(schedulerStatus().running, true);
  });

  it('sweeps every restaurant as its own owner, without crossing tenants', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 18000);
    // The rival is short too, and must be swept under its own ownership.
    await Notification.deleteMany({});

    const result = await runScheduledSweep({lookbackDays: 30});
    assert.ok(result.restaurants >= 2, 'both restaurants exist');
    assert.ok(result.swept >= 1);
    assert.deepEqual(result.errors, [], JSON.stringify(result.errors));

    const ours = await Notification.find({restaurant: world.restaurant._id}).lean();
    assert.ok(ours.length >= 1, 'our shortage was alerted');
    for (const alert of ours) {
      assert.equal(String(alert.restaurant), String(world.restaurant._id));
    }
    const leaked = await Notification.find({
      restaurant: world.restaurant._id, branch: rival.branch._id
    }).lean();
    assert.equal(leaked.length, 0, 'no alert may span restaurants');
  });

  it('skips a restaurant with no active owner rather than borrowing privileges', async () => {
    await User.updateMany({restaurantId: rival.restaurant._id, role: 'owner'}, {$set: {active: false}});
    const result = await runScheduledSweep({});
    const skipped = result.skipped.find(row => row.restaurant === String(rival.restaurant._id));
    assert.ok(skipped, 'it must be reported, not silently ignored');
    assert.match(skipped.reason, /No active owner/);
  });

  it('a failing sweep is caught, logged and never crashes the tick', async () => {
    const env = {REORDER_SCHEDULER_ENABLED: '1'};
    const logs = [];
    const started = startReorderScheduler({
      env, logger: {log() {}, warn: (...a) => logs.push(a), error: (...a) => logs.push(a)}
    });
    assert.equal(started.started, true);

    // Break the sweep by disconnecting nothing but pointing at a bad state:
    // an exception inside the tick must be swallowed.
    const original = Restaurant.find;
    Restaurant.find = () => { throw new Error('simulated database failure'); };
    try {
      await triggerSchedulerTick();
    } finally {
      Restaurant.find = original;
    }
    const status = schedulerStatus();
    assert.equal(status.running, true, 'the scheduler survives a failed sweep');
    assert.ok(status.lastError, 'and records why it failed');
  });

  it('reports honest telemetry after a real tick', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 18000);
    await Notification.deleteMany({});

    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}}});
    await triggerSchedulerTick();
    const status = schedulerStatus();
    assert.equal(status.ticks, 1);
    assert.ok(status.lastRunAt);
    assert.equal(status.inFlight, false);
    // Phase 16B installs a MongoDB lease lock by default, so the scope is now
    // reported as distributed rather than in-process. The assertion is
    // strengthened rather than dropped: whichever mode is active must be
    // reported truthfully.
    assert.equal(status.scope, 'distributed-lock');
    assert.equal(status.distributed, true);
    assert.equal(status.lockKind, 'mongodb');
  });

  it('honours an external distributed lock when one is supplied', async () => {
    let acquired = 0;
    setSchedulerLock({
      acquire: async () => { acquired += 1; return null; } // Another instance holds it.
    });
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}}});
    await triggerSchedulerTick();
    assert.equal(acquired, 1, 'the lock was consulted');
    assert.equal(schedulerStatus().ticks, 0, 'the losing instance did no work');
    assert.equal(await Notification.countDocuments({type: 'low_stock'}), 0);
  });

  it('stops cleanly and is safe to stop twice', async () => {
    startReorderScheduler({env: {REORDER_SCHEDULER_ENABLED: '1'}, logger: {log() {}}});
    assert.equal((await stopReorderScheduler()).stopped, true);
    assert.equal((await stopReorderScheduler()).stopped, false);
    assert.equal(schedulerStatus().running, false);
  });

  it('exposes its status to management only', async () => {
    const res = await request('/api/purchasing/reorder-scheduler', {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.running, false);
    assert.equal((await request('/api/purchasing/reorder-scheduler', {token: staff()})).status, 403);
    assert.equal((await request('/api/purchasing/reorder-scheduler')).status, 401);
  });

  it('leaves the manual endpoint working', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 18000);
    await Notification.deleteMany({});
    const res = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.raised >= 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Supplier performance
// ═══════════════════════════════════════════════════════════════════════════

describe('16A — supplier performance', () => {
  it('computes median correctly for odd and even samples', () => {
    assert.equal(medianOf([3, 1, 2]), 2);
    assert.equal(medianOf([4, 1, 3, 2]), 2.5);
    assert.equal(medianOf([]), null);
  });

  it('reports insufficient data rather than inventing a number', () => {
    const result = summariseDeliveries([
      {actualLeadDays: 2, promisedLeadDays: 2},
      {actualLeadDays: 3, promisedLeadDays: 2}
    ]);
    assert.equal(result.insufficientData, true);
    assert.equal(result.averageLeadDays, null);
    assert.equal(result.onTimeRate, null);
    assert.match(result.reason, /2 completed deliveries/);
    assert.equal(MIN_SAMPLES_FOR_LEAD_TIME, 3);
  });

  it('measures average, median, late count and on-time rate', () => {
    const result = summariseDeliveries([
      {actualLeadDays: 2, promisedLeadDays: 3},
      {actualLeadDays: 4, promisedLeadDays: 3},
      {actualLeadDays: 6, promisedLeadDays: 3},
      {actualLeadDays: 8, promisedLeadDays: 3}
    ]);
    assert.equal(result.insufficientData, false);
    assert.equal(result.samples, 4);
    assert.equal(result.averageLeadDays, 5);
    assert.equal(result.medianLeadDays, 5);
    assert.equal(result.minLeadDays, 2);
    assert.equal(result.maxLeadDays, 8);
    assert.equal(result.lateCount, 3, '4, 6 and 8 all exceed the promised 3');
    assert.equal(result.onTimeRate, 25);
  });

  it('does not judge punctuality with no promised date', () => {
    const result = summariseDeliveries([
      {actualLeadDays: 2, promisedLeadDays: null},
      {actualLeadDays: 4, promisedLeadDays: null},
      {actualLeadDays: 6, promisedLeadDays: null}
    ]);
    assert.equal(result.averageLeadDays, 4, 'lead time is still measurable');
    assert.equal(result.onTimeRate, null, 'but punctuality is not');
    assert.match(result.onTimeBasis, /cannot be judged/);
  });

  it('returns insufficient data for a supplier with no history, via the API', async () => {
    const res = await request(`/api/suppliers/${supplier._id}/performance`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.insufficientData, true);
    assert.equal(res.body.averageLeadDays, null);
    assert.equal(res.body.leadTimeSource, 'catalog_declared');
    assert.equal(res.body.samples, 0);
  });

  it('measures real lead time from approve to receipt', async () => {
    // Three genuine PO -> approve -> receive cycles.
    for (let i = 0; i < 3; i += 1) {
      const created = await request('/api/purchase-orders', {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          branch: String(world.branchA._id), supplier: String(supplier._id),
          items: [{ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1, vatRate: 13}]
        }
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
        method: 'PATCH', token: manager(), body: {status: 'pending', expectedVersion: created.body.__v}
      });
      const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
        method: 'PATCH', token: owner(), body: {status: 'approved', expectedVersion: pending.body.__v}
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      // Back-date the approval so the receipt is N days later.
      await PurchaseOrder.collection.updateOne(
        {_id: new mongoose.Types.ObjectId(String(created.body._id))},
        {$set: {approvedAt: new Date(Date.now() - (i + 2) * 86400000)}}
      );
      const received = await request(`/api/purchase-orders/${created.body._id}/receive`, {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          expectedVersion: approved.body.__v,
          items: [{itemId: String(approved.body.items[0]._id), receivedQty: 100, damagedQty: 0}]
        }
      });
      assert.equal(received.status, 201, JSON.stringify(received.body));
    }

    const res = await request(`/api/suppliers/${supplier._id}/performance`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.insufficientData, false);
    assert.equal(res.body.samples, 3);
    assert.equal(res.body.leadTimeSource, 'measured');
    // Approvals were 2, 3 and 4 days before their receipts.
    assert.equal(res.body.averageLeadDays, 3);
    assert.equal(res.body.medianLeadDays, 3);
    assert.equal(res.body.deliveries.length, 3);
    assert.ok(res.body.deliveries[0].poNo);
  });

  it('feeds the measured lead time into the reorder point', async () => {
    // Declared lead time is 2 days; real history will be 5. The reorder point
    // must be computed from what the supplier ACTUALLY does.
    await catalogEntry({leadDays: 2});
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
        {$set: {approvedAt: new Date(Date.now() - 5 * 86400000)}}
      );
      await request(`/api/purchase-orders/${created.body._id}/receive`, {
        method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
        body: {
          expectedVersion: approved.body.__v,
          items: [{itemId: String(approved.body.items[0]._id), receivedQty: 100, damagedQty: 0}]
        }
      });
    }

    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 100);
    const res = await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const line = res.body.lines.find(l => String(l.ingredient) === String(world.ingredient._id));
    assert.equal(line.leadTimeSource, 'measured', 'real history must beat the catalog claim');
    assert.equal(line.declaredLeadDays, 2);
    assert.equal(line.leadTimeDays, 5, 'the supplier actually takes 5 days');
    assert.equal(line.leadTimeSamples, 3);
  });

  it('is management only and tenant scoped', async () => {
    assert.equal((await request(`/api/suppliers/${supplier._id}/performance`, {token: staff()})).status, 403);
    assert.equal((await request(`/api/suppliers/${supplier._id}/performance`)).status, 401);
    const cross = await request(`/api/suppliers/${supplier._id}/performance`, {token: tokenFor(rival.owner)});
    assert.equal(cross.status, 404, 'another tenant cannot read our supplier performance');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Usage refinement
// ═══════════════════════════════════════════════════════════════════════════

describe('16A — usage calculation', () => {
  const start = new Date('2026-01-04T00:00:00.000Z'); // a Sunday

  it('omits a weekday profile without enough history', () => {
    const result = refineUsage([1, 2, 3, 4, 5], {start});
    assert.equal(result.weekdayProfile, null, 'five days cannot describe a week');
    assert.equal(MIN_DAYS_FOR_WEEKDAY, 21);

    // Exactly one day short of the threshold is still refused: the boundary
    // must bite, not merely the obviously-too-small case.
    const nearly = refineUsage(new Array(MIN_DAYS_FOR_WEEKDAY - 1).fill(4), {start});
    assert.equal(nearly.weekdayProfile, null, `${MIN_DAYS_FOR_WEEKDAY - 1} days is not enough`);
    const enough = refineUsage(new Array(MIN_DAYS_FOR_WEEKDAY).fill(4), {start, asOf: start});
    assert.ok(enough.weekdayProfile, `${MIN_DAYS_FOR_WEEKDAY} days is`);
    assert.equal(enough.weekdayProfile.length, 7);
  });

  it('builds a weekday profile from a deterministic dataset', () => {
    // 28 days: 10 on weekends (Sun=0, Sat=6), 2 on weekdays.
    const daily = Array.from({length: 28}, (_, index) => {
      const weekday = new Date(start.getTime() + index * 86400000).getUTCDay();
      return weekday === 0 || weekday === 6 ? 10 : 2;
    });
    const result = refineUsage(daily, {start, asOf: start});
    assert.ok(result.weekdayProfile, 'four full weeks is enough');
    assert.equal(result.weekdayProfile[0], 10, 'Sunday');
    assert.equal(result.weekdayProfile[6], 10, 'Saturday');
    assert.equal(result.weekdayProfile[3], 2, 'Wednesday');
    assert.equal(result.weekdayAverage, 10, 'asOf is a Sunday');
  });

  it('detects a rising and a falling trend, and calls flat data steady', () => {
    const rising = refineUsage(Array.from({length: 20}, (_, i) => (i < 10 ? 10 : 20)), {start});
    assert.equal(rising.trend.direction, 'rising');
    assert.equal(rising.trend.changePercent, 100);

    const falling = refineUsage(Array.from({length: 20}, (_, i) => (i < 10 ? 20 : 10)), {start});
    assert.equal(falling.trend.direction, 'falling');

    const steady = refineUsage(new Array(20).fill(10), {start});
    assert.equal(steady.trend.direction, 'steady');
    assert.equal(steady.trend.changePercent, 0);
  });

  it('omits a trend without enough history', () => {
    assert.equal(refineUsage([5, 5, 5], {start}).trend, null);
    assert.equal(MIN_DAYS_FOR_TREND, 14);
  });

  it('surfaces the supplier SKU and purchase unit the UI displays', async () => {
    await SupplierIngredient.create({
      restaurant: world.restaurant._id, supplier: supplier._id, ingredient: world.ingredient._id,
      supplierSku: 'SKU-RICE-25', purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: 1000,
      currentPrice: 100, minOrderQty: 0.5, leadDays: 2, active: true
    });
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 100);
    const res = await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`, {token: manager()});
    const line = res.body.lines.find(l => String(l.ingredient) === String(world.ingredient._id));
    assert.equal(line.supplierSku, 'SKU-RICE-25', 'a blank SKU column would be a lie');
    assert.equal(line.purchaseUnit, 'kg');
    assert.equal(line.minOrderQty, 0.5);
  });

  it('keeps the flat average working and configurable', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 100);
    const res = await request(
      `/api/purchasing/reorder-plan?branch=${world.branchA._id}&lookbackDays=7`,
      {token: manager()}
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.parameters.lookbackDays, 7, 'the lookback is configurable');
    assert.ok(res.body.lines.length >= 1);
    assert.ok(res.body.lines[0].averageDailyUsage !== undefined, 'the simple average is still reported');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Production safety
// ═══════════════════════════════════════════════════════════════════════════

describe('16A — production safety', () => {
  it('a reorder plan never modifies inventory', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 18000);

    const before = await InventoryBalance.find({}).sort({_id: 1}).lean();
    const ledgerBefore = await InventoryTransaction.countDocuments({});

    await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`, {token: manager()});
    await raiseReorderAlerts({user: actor(world.owner)});

    const after = await InventoryBalance.find({}).sort({_id: 1}).lean();
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i += 1) {
      assert.equal(after[i].quantity, before[i].quantity, 'planning must not move stock');
      assert.equal(after[i].ledgerVersion, before[i].ledgerVersion);
    }
    assert.equal(await InventoryTransaction.countDocuments({}), ledgerBefore, 'and must post no ledger row');
  });

  it('creating a PO from a suggestion does not receive stock', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 100);

    const balanceBefore = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    const ledgerBefore = await InventoryTransaction.countDocuments({});

    const res = await request('/api/purchasing/suggested-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(world.branchA._id), supplier: String(supplier._id)}
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.purchaseOrder.status, 'draft');

    const balanceAfter = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.equal(balanceAfter, balanceBefore, 'ordering is not receiving');
    assert.equal(await InventoryTransaction.countDocuments({}), ledgerBefore);
  });

  it('a suggested PO cannot skip approval, and receiving still moves stock once', async () => {
    await catalogEntry();
    await setLevel(world.branchA, 19000);
    await setStock(world.branchA, 100);

    const created = await request('/api/purchasing/suggested-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(world.branchA._id), supplier: String(supplier._id)}
    });
    const po = created.body.purchaseOrder;

    // Receiving a draft must be refused: approval cannot be bypassed.
    const early = await request(`/api/purchase-orders/${po._id}/receive`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        expectedVersion: po.__v,
        items: [{itemId: String(po.items[0]._id), receivedQty: 10, damagedQty: 0}]
      }
    });
    assert.equal(early.status, 409, 'a draft order cannot be received');

    const pending = await request(`/api/purchase-orders/${po._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'pending', expectedVersion: po.__v}
    });
    const approved = await request(`/api/purchase-orders/${po._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'approved', expectedVersion: pending.body.__v}
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const before = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    const RECEIVE_KEY = KEY();
    const receipt = await request(`/api/purchase-orders/${po._id}/receive`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': RECEIVE_KEY},
      body: {
        expectedVersion: approved.body.__v,
        items: [{itemId: String(approved.body.items[0]._id), receivedQty: 500, damagedQty: 0}]
      }
    });
    assert.equal(receipt.status, 201, JSON.stringify(receipt.body));
    const after = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.equal(after, before + 500, 'receiving is the only stock-in path');

    // A replayed receipt must not move stock a second time.
    const replay = await request(`/api/purchase-orders/${po._id}/receive`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': RECEIVE_KEY},
      body: {
        expectedVersion: approved.body.__v,
        items: [{itemId: String(approved.body.items[0]._id), receivedQty: 500, damagedQty: 0}]
      }
    });
    assert.ok([200, 201].includes(replay.status), `got ${replay.status}`);
    const final = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.equal(final, before + 500, 'no double stock movement');
  });
});
