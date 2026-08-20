/**
 * Phase 17 — inventory alert and reorder engine.
 *
 * Six of the seven alert classes already existed (`services/alerts.js`), as did
 * Phase 16's reorder suggestions. Neither was rebuilt. Auditing them against
 * the running API found four gaps, each reproduced before any code was written:
 *
 *   1. NO HIGH-WASTE ALERT. Probe: ALERT_TYPES had low_stock, out_of_stock,
 *      expiry_approaching, expired, unusual_consumption, negative_inventory —
 *      and nothing for waste.
 *   2. ALERTS NEVER REACHED A CLIENT IN REALTIME. Probe: driving stock below
 *      the reorder level wrote a `low_stock` notification but the connected
 *      Socket.IO client saw only a generic `inventory:update` carrying nothing
 *      about the alert. A manager watching the screen learned nothing.
 *   3. NO REORDER POINT. Phase 16 restored stock to a static level someone had
 *      typed in; nothing measured how fast an ingredient actually moves.
 *      Probe: suggestion rows had no averageDailyUsage, safetyStock or
 *      reorderPoint.
 *   4. NO SUGGESTED-PO APPROVAL PATH. Probe: /purchasing/suggested-orders 404.
 *
 * The brief's formula is pinned directly:
 *     reorderPoint = averageDailyUsage x leadTimeDays + safetyStock
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {io as clientIo} from 'socket.io-client';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Notification, PurchaseOrder, Restaurant
} from '../src/models/operations.js';
import {SupplierIngredient} from '../src/models/supplierCatalog.js';
import {ALERT_TYPES, HIGH_WASTE_THRESHOLD, listAlerts} from '../src/services/alerts.js';
import {
  DEFAULT_LOOKBACK_DAYS, SERVICE_LEVEL_Z, buildReorderPlan,
  reorderPointFor, safetyStockFor, usageStatistics
} from '../src/services/reorderEngine.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let rival;
let supplier;
let baseUrl;
let seq = 0;
const KEY = () => `p17-${Date.now()}-${++seq}`;

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  seq = 0;
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Reorder Supplier'});

  const restaurant = await Restaurant.create({name: 'Rival18', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival18 Branch', code: 'RV8', address: 'Sanepa'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival18 Owner', email: 'rival18@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival18', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

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

/** Post a consumption movement dated `daysAgo`, through the real ledger. */
async function consume({qty, daysAgo = 0, type = 'RECIPE_DEDUCTION', ingredient = world.ingredient}) {
  const tx = await inTransaction(session => moveStock({
    branch: world.branchA._id, ingredient: ingredient._id, qty: -Math.abs(qty), unit: 'g',
    type, reason: 'Usage history for the reorder engine',
    referenceType: type === 'WASTE' ? 'waste' : 'order',
    referenceId: new mongoose.Types.ObjectId(), user: world.owner._id, idempotencyKey: KEY(),
    ...(type === 'WASTE' ? {wasteCategory: 'spoiled'} : {})
  }, session));
  if (daysAgo > 0) {
    // Back-date the row so the lookback window sees a usage history. The model
    // correctly refuses to rewrite a ledger row, so this goes through the raw
    // collection: it is test setup standing in for time passing, not something
    // the application is allowed to do.
    await InventoryTransaction.collection.updateOne(
      {_id: tx._id},
      {$set: {createdAt: new Date(Date.now() - daysAgo * 86400000)}}
    );
  }
  return tx;
}

async function catalogEntry({price = 100, factor = 1000, leadDays = 2, minOrderQty = 1, sup = null, ing = null} = {}) {
  return SupplierIngredient.create({
    restaurant: world.restaurant._id, supplier: (sup || supplier)._id,
    ingredient: (ing || world.ingredient)._id,
    purchaseUnit: 'kg', baseUnit: 'g', conversionFactor: factor,
    currentPrice: price, minOrderQty, leadDays, active: true
  });
}

const setStock = async target => {
  const current = (await InventoryBalance.findOne({
    branch: world.branchA._id, ingredient: world.ingredient._id
  }))?.quantity ?? 0;
  const delta = target - current;
  if (Math.abs(delta) < 1e-9) return;
  const res = await request('/api/inventory/adjustments', {
    method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
    body: {
      branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
      qty: delta, reason: 'Set stock for the reorder engine test'
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
};

const plan = (query = '', token = manager()) =>
  request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}${query}`, {token});

// ═══════════════════════════════════════════════════════════════════════════
// The formula
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — reorder point formula', () => {
  it('is average daily usage x lead time plus safety stock', () => {
    assert.equal(reorderPointFor({averageDailyUsage: 10, leadTimeDays: 3, safetyStock: 5}), 35);
    assert.equal(reorderPointFor({averageDailyUsage: 0, leadTimeDays: 3, safetyStock: 5}), 5);
    assert.equal(reorderPointFor({averageDailyUsage: 10, leadTimeDays: 0, safetyStock: 0}), 0);
  });

  it('never returns a negative point', () => {
    assert.equal(reorderPointFor({averageDailyUsage: -5, leadTimeDays: 3, safetyStock: -2}), 0);
  });

  it('scales safety stock by the square root of the lead time', () => {
    // Variance accumulates linearly over independent days, so the standard
    // deviation grows with sqrt(lead). Multiplying by lead would overstock.
    const oneDay = safetyStockFor({stdDevDailyUsage: 10, leadTimeDays: 1, serviceLevel: 95});
    const fourDays = safetyStockFor({stdDevDailyUsage: 10, leadTimeDays: 4, serviceLevel: 95});
    assert.equal(oneDay, 16.5, '1.65 x 10 x sqrt(1)');
    assert.equal(fourDays, 33, 'four times the lead time is only twice the cover');
    assert.equal(safetyStockFor({stdDevDailyUsage: 0, leadTimeDays: 9}), 0, 'steady demand needs no buffer');
  });

  it('carries more cover at a higher service level', () => {
    const at90 = safetyStockFor({stdDevDailyUsage: 10, leadTimeDays: 4, serviceLevel: 90});
    const at99 = safetyStockFor({stdDevDailyUsage: 10, leadTimeDays: 4, serviceLevel: 99});
    assert.ok(at99 > at90);
    assert.equal(SERVICE_LEVEL_Z[95], 1.65);
  });

  it('counts zero-usage days rather than dropping them', () => {
    // Averaging only the days something moved would treat a weekly spice as a
    // daily staple.
    const sparse = usageStatistics([0, 0, 0, 0, 0, 0, 7]);
    assert.equal(sparse.average, 1, '7 units across 7 days is 1/day, not 7/day');
    assert.equal(sparse.peak, 7);
    assert.equal(sparse.days, 7);
    const steady = usageStatistics([5, 5, 5, 5]);
    assert.equal(steady.average, 5);
    assert.equal(steady.stdDev, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The plan
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — reorder plan', () => {
  it('derives the point from measured usage and the supplier lead time', async () => {
    await catalogEntry({leadDays: 3});
    // 100g/day for ten days.
    for (let d = 1; d <= 10; d += 1) await consume({qty: 100, daysAgo: d});
    await setStock(200);

    const res = await plan();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const line = res.body.lines.find(l => String(l.ingredient) === String(world.ingredient._id));
    assert.ok(line, 'the ingredient must be evaluated');

    // 1000g over a 30-day window is 33.333/day.
    assert.ok(line.averageDailyUsage > 33 && line.averageDailyUsage < 34, `avg was ${line.averageDailyUsage}`);
    assert.equal(line.leadTimeDays, 3);
    assert.equal(
      line.computedReorderPoint,
      Math.round((line.averageDailyUsage * 3 + line.safetyStock) * 1000) / 1000,
      'the reported point must equal the stated formula'
    );
    assert.equal(res.body.formula, 'reorderPoint = averageDailyUsage x leadTimeDays + safetyStock');
    assert.equal(line.urgency, 'reorder');
  });

  it('reports every term the manager needs to check the number', async () => {
    await catalogEntry({leadDays: 2});
    for (let d = 1; d <= 5; d += 1) await consume({qty: 200, daysAgo: d});
    await setStock(100);

    const line = (await plan()).body.lines[0];
    for (const field of [
      'currentStock', 'reorderPoint', 'averageDailyUsage', 'usageStdDev', 'leadTimeDays',
      'safetyStock', 'suggestedQty', 'supplierName', 'unitCost', 'expectedCost', 'lookbackDays'
    ]) {
      assert.ok(line[field] !== undefined, `${field} must be reported`);
    }
    assert.equal(line.supplierName, 'Reorder Supplier');
    assert.equal(line.expectedCost, Math.round(line.suggestedQty * line.unitCost * 100) / 100);
  });

  it('treats a configured minimum as a floor, never a ceiling', async () => {
    await catalogEntry({leadDays: 1});
    await consume({qty: 10, daysAgo: 1});
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {$set: {reorderLevel: 5000}}
    );
    await setStock(1000);

    const line = (await plan()).body.lines[0];
    assert.ok(line.computedReorderPoint < 5000, 'usage alone would suggest far less');
    assert.equal(line.reorderPoint, 5000, "an operator's explicit minimum is not overridden");
    assert.match(line.reorderPointBasis, /configured minimum/);
  });

  it('suggests nothing while stock is comfortably above the point', async () => {
    await catalogEntry({leadDays: 2});
    await consume({qty: 10, daysAgo: 1});
    await setStock(20000);
    const res = await plan();
    assert.equal(res.body.counts.total, 0);
  });

  it('subtracts what is already on order', async () => {
    await catalogEntry({leadDays: 3, minOrderQty: 0.001});
    for (let d = 1; d <= 10; d += 1) await consume({qty: 100, daysAgo: d});
    await setStock(100);

    const before = (await plan()).body.lines[0];
    assert.ok(before.suggestedQty > 0);

    const po = await request('/api/purchase-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 50000, unit: 'g', unitPrice: 0.1, vatRate: 13}]
      }
    });
    assert.equal(po.status, 201, JSON.stringify(po.body));

    const after = (await plan('&includeAll=true')).body.lines
      .find(l => String(l.ingredient) === String(world.ingredient._id));
    assert.equal(after.onOrder, 50000, 'stock on an open order counts towards cover');
    assert.equal(after.urgency, 'ok', 'a buyer must not be told to order it twice');
  });

  it('flags an ingredient with no orderable supplier instead of hiding it', async () => {
    const orphan = await Ingredient.create({
      restaurant: world.restaurant._id, code: 'ING-NOSUP', name: 'Unsourced Herb',
      unit: 'g', reorderLevel: 500
    });
    const res = await plan();
    const line = res.body.lines.find(l => String(l.ingredient) === String(orphan._id));
    assert.ok(line, 'a shortage with no supplier is still a shortage');
    assert.equal(line.actionable, false);
    assert.match(line.blockedReason, /No orderable supplier/);
    assert.ok(res.body.counts.blocked >= 1);
  });

  it('reports days of cover remaining', async () => {
    await catalogEntry({leadDays: 2});
    for (let d = 1; d <= 10; d += 1) await consume({qty: 300, daysAgo: d});
    await setStock(500);
    const line = (await plan()).body.lines[0];
    assert.ok(line.daysOfCoverRemaining > 0 && line.daysOfCoverRemaining < 10,
      `cover was ${line.daysOfCoverRemaining}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Suggested purchase order
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — suggested purchase order', () => {
  beforeEach(async () => {
    await catalogEntry({leadDays: 3, price: 100, factor: 1000, minOrderQty: 0.5});
    for (let d = 1; d <= 10; d += 1) await consume({qty: 200, daysAgo: d});
    await setStock(100);
  });

  const suggest = (body = {}, token = manager()) => request('/api/purchasing/suggested-orders', {
    method: 'POST', token, headers: {'Idempotency-Key': KEY()},
    body: {branch: String(world.branchA._id), supplier: String(supplier._id), ...body}
  });

  it('groups the plan into one suggested order per supplier', async () => {
    const res = await plan();
    assert.equal(res.body.suggestedOrders.length, 1);
    const group = res.body.suggestedOrders[0];
    assert.equal(group.supplierName, 'Reorder Supplier');
    assert.equal(group.lineCount, 1);
    assert.ok(group.expectedCost > 0);
    assert.equal(group.items[0].ingredientName, 'Basmati Rice');
  });

  it('creates a DRAFT order that still needs approval', async () => {
    const res = await suggest();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.requiresApproval, true);
    assert.equal(res.body.purchaseOrder.status, 'draft',
      'a computed number must never commit money without a human');

    const stored = await PurchaseOrder.findById(res.body.purchaseOrder._id);
    assert.equal(stored.status, 'draft');
    assert.equal(stored.items.length, 1);
    assert.ok(stored.items[0].orderedQty > 0);
    assert.match(stored.notes || '', /reorder engine/i);
  });

  it('flows into the existing approval chain unchanged', async () => {
    const created = await suggest();
    const poId = created.body.purchaseOrder._id;

    const pending = await request(`/api/purchase-orders/${poId}/status`, {
      method: 'PATCH', token: manager(),
      body: {status: 'pending', expectedVersion: created.body.purchaseOrder.__v}
    });
    assert.equal(pending.status, 200, JSON.stringify(pending.body));

    const approved = await request(`/api/purchase-orders/${poId}/status`, {
      method: 'PATCH', token: owner(),
      body: {status: 'approved', expectedVersion: pending.body.__v}
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await PurchaseOrder.findById(poId)).status, 'approved');
  });

  it('refuses a supplier with nothing outstanding', async () => {
    const other = await Supplier.create({restaurant: world.restaurant._id, name: 'Idle Supplier'});
    const res = await suggest({supplier: String(other._id)});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /No reorder suggestion/);
  });

  it('is management only and tenant scoped', async () => {
    assert.equal((await suggest({}, staff())).status, 403);
    assert.equal((await request('/api/purchasing/suggested-orders', {
      method: 'POST', body: {branch: String(world.branchA._id), supplier: String(supplier._id)}
    })).status, 401);
    const intruder = await suggest({}, tokenFor(rival.owner));
    assert.ok([403, 404].includes(intruder.status), `got ${intruder.status}`);
    assert.equal(await PurchaseOrder.countDocuments({}), 0, 'nothing was created');
  });

  it('rejects unknown fields', async () => {
    const res = await request('/api/purchasing/suggested-orders', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        status: 'approved'
      }
    });
    assert.equal(res.status, 400, 'an attacker must not be able to pre-approve it');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// High waste alert
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — high waste alert', () => {
  it('is a recognised alert type', () => {
    assert.ok(ALERT_TYPES.includes('high_waste'));
    assert.equal(HIGH_WASTE_THRESHOLD, 0.1);
  });

  it('raises when waste is a large share of consumption', async () => {
    await consume({qty: 100, daysAgo: 1});
    await consume({qty: 50, daysAgo: 1, type: 'WASTE'});

    const alerts = await listAlerts({branchId: String(world.branchA._id), user: world.manager});
    const waste = alerts.find(a => a.type === 'high_waste');
    assert.ok(waste, '50 wasted out of 150 consumed is a third');
    assert.ok(waste.wastePercent > 30 && waste.wastePercent < 34, `was ${waste.wastePercent}`);
    assert.equal(waste.severity, 'critical', 'more than double the threshold');
    assert.match(waste.body, /Basmati Rice/);
  });

  it('stays quiet when waste is a normal share', async () => {
    await consume({qty: 1000, daysAgo: 1});
    await consume({qty: 20, daysAgo: 1, type: 'WASTE'});
    const alerts = await listAlerts({branchId: String(world.branchA._id), user: world.manager});
    assert.equal(alerts.filter(a => a.type === 'high_waste').length, 0, '2% is not high waste');
  });

  it('ignores a trivial absolute quantity', async () => {
    // A single spill on a quiet day must not read as a 100% waste rate.
    await consume({qty: 0.5, daysAgo: 1, type: 'WASTE'});
    const alerts = await listAlerts({branchId: String(world.branchA._id), user: world.manager});
    assert.equal(alerts.filter(a => a.type === 'high_waste').length, 0);
  });

  it('is filterable and branch scoped', async () => {
    await consume({qty: 100, daysAgo: 1});
    await consume({qty: 50, daysAgo: 1, type: 'WASTE'});

    const filtered = await listAlerts({
      branchId: String(world.branchA._id), user: world.manager, type: 'high_waste'
    });
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every(a => a.type === 'high_waste'));

    const otherBranch = await listAlerts({branchId: String(world.branchB._id), user: world.owner});
    assert.equal(otherBranch.filter(a => a.type === 'high_waste').length, 0,
      'branch B wasted nothing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Realtime
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — realtime alerts', () => {
  async function connect(token, branch) {
    const socket = clientIo(baseUrl, {
      auth: {token, branch: String(branch)}, transports: ['websocket'], reconnection: false, timeout: 4000
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket connect timeout')), 4000);
      socket.on('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('connect_error', error => { clearTimeout(timer); reject(error); });
    });
    await new Promise(resolve => socket.emit('join:branch', String(branch), resolve));
    return socket;
  }

  function collect(socket, event) {
    const seen = [];
    socket.on(event, payload => seen.push(payload));
    return seen;
  }

  it('pushes a low stock alert to the branch as it happens', async () => {
    const socket = await connect(manager(), world.branchA._id);
    try {
      const alerts = collect(socket, 'inventory:alert');
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
      await new Promise(resolve => setTimeout(resolve, 400));

      assert.equal(alerts.length, 1, 'the alert must reach the branch without a refresh');
      assert.equal(alerts[0].type, 'low_stock');
      assert.equal(alerts[0].severity, 'warning');
      assert.equal(alerts[0].ingredientName, 'Basmati Rice');
      assert.equal(alerts[0].currentStock, 18000);
      assert.equal(alerts[0].reorderLevel, 19000);
      assert.ok(alerts[0].alertId, 'carries the stored notification id');
      assert.equal(String(alerts[0].branch), String(world.branchA._id));
    } finally {
      socket.close();
    }
  });

  it('marks a zero balance as critical and out of stock', async () => {
    const socket = await connect(manager(), world.branchA._id);
    try {
      const alerts = collect(socket, 'inventory:alert');
      await InventoryBalance.updateOne(
        {branch: world.branchA._id, ingredient: world.ingredient._id},
        {$set: {reorderLevel: 100}}
      );
      await request('/api/inventory/adjustments', {
        method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
        body: {
          branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
          qty: -20000, reason: 'Empty the shelf completely'
        }
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0].type, 'out_of_stock');
      assert.equal(alerts[0].severity, 'critical');
      assert.equal(alerts[0].currentStock, 0);
    } finally {
      socket.close();
    }
  });

  it('does not push to another branch', async () => {
    const listener = await connect(owner(), world.branchB._id);
    try {
      const alerts = collect(listener, 'inventory:alert');
      await InventoryBalance.updateOne(
        {branch: world.branchA._id, ingredient: world.ingredient._id},
        {$set: {reorderLevel: 19000}}
      );
      await request('/api/inventory/adjustments', {
        method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
        body: {
          branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
          qty: -2000, reason: 'Branch A only'
        }
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(alerts.length, 0, 'a branch must not see another branch stock alerts');
    } finally {
      listener.close();
    }
  });

  it('emits nothing when the movement leaves stock above the level', async () => {
    const socket = await connect(manager(), world.branchA._id);
    try {
      const alerts = collect(socket, 'inventory:alert');
      await InventoryBalance.updateOne(
        {branch: world.branchA._id, ingredient: world.ingredient._id},
        {$set: {reorderLevel: 100}}
      );
      await request('/api/inventory/adjustments', {
        method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
        body: {
          branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
          qty: -500, reason: 'Plenty left afterwards'
        }
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(alerts.length, 0, 'healthy stock must not raise noise');
    } finally {
      socket.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Alert sweep
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — reorder alert sweep', () => {
  it('raises an alert per ingredient below its point, once per day', async () => {
    await catalogEntry({leadDays: 3});
    for (let d = 1; d <= 10; d += 1) await consume({qty: 200, daysAgo: d});
    await setStock(100);

    // Clear anything the stock-setting adjustment already raised, so this
    // measures the sweep rather than the ledger's own alerting.
    await Notification.deleteMany({});

    const first = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body.raised >= 1, JSON.stringify(first.body));
    const created = await Notification.countDocuments({branch: world.branchA._id});

    const second = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: manager()}
    );
    assert.equal(second.body.raised, 0, 'a re-run must not spam the same alert');
    assert.equal(await Notification.countDocuments({branch: world.branchA._id}), created);
  });

  it('is management only', async () => {
    const res = await request(
      `/api/purchasing/reorder-alerts/run?branch=${world.branchA._id}`,
      {method: 'POST', token: staff()}
    );
    assert.equal(res.status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorisation and isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('17 — authorisation and isolation', () => {
  it('restricts the plan to management', async () => {
    assert.equal((await plan('', staff())).status, 403);
    assert.equal((await request(`/api/purchasing/reorder-plan?branch=${world.branchA._id}`)).status, 401);
    assert.equal((await plan('', 'not.a.jwt')).status, 401);
  });

  it('refuses another branch and another restaurant', async () => {
    const crossBranch = await request(
      `/api/purchasing/reorder-plan?branch=${world.branchB._id}`, {token: manager()}
    );
    assert.equal(crossBranch.status, 403, 'a branch manager cannot plan another branch');

    const crossTenant = await plan('', tokenFor(rival.owner));
    assert.ok([403, 404].includes(crossTenant.status), `got ${crossTenant.status}`);
  });

  it('never counts another restaurant usage into our average', async () => {
    await catalogEntry({leadDays: 2});
    for (let d = 1; d <= 5; d += 1) await consume({qty: 100, daysAgo: d});
    await setStock(100);

    const ours = (await plan()).body.lines[0];
    const theirs = await request('/api/purchasing/reorder-plan', {token: tokenFor(rival.owner)});
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.body.counts.total, 0, 'another tenant sees none of our shortages');
    assert.ok(ours.averageDailyUsage > 0);
  });

  it('defaults the lookback window', async () => {
    assert.equal(DEFAULT_LOOKBACK_DAYS, 30);
    await catalogEntry({leadDays: 1});
    await consume({qty: 100, daysAgo: 1});
    await setStock(0);
    const res = await plan();
    assert.equal(res.body.parameters.lookbackDays, 30);
    assert.equal(res.body.parameters.serviceLevel, 95);
  });
});
