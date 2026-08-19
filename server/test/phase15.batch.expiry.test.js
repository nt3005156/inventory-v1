/**
 * Phase 15 — lot / batch / expiry inventory.
 *
 * Most of this brief already shipped and is pinned by batchExpiry.test.js:
 * the InventoryBatch model carries batch number, supplier, received date,
 * expiry, quantity and unit cost; `removeBatchStock()` implements FEFO with
 * FIFO available; expired stock is already refused on a sale; and the alert
 * endpoints already report expired / expiring / fresh. None of that was
 * rebuilt.
 *
 * Auditing it against the running API found two real gaps, both reproduced
 * before any code was written:
 *
 *   1. ALERT TIERS WERE FLAT. Batches 2, 5 and 20 days from expiry all came
 *      back `severity: warning`, so a batch expiring tomorrow looked exactly
 *      as urgent as one expiring in three weeks. The brief asks for 7-day,
 *      3-day and expired tiers.
 *      Probe: B-2D severity=warning / B-5D severity=warning / B-20D severity=warning.
 *   2. THE EXPIRED-STOCK BLOCK WAS HARD-CODED. Refusing expired stock on a
 *      sale was correct, but a restaurant could neither relax it nor tighten
 *      the alert window. The brief asks for a configurable policy.
 *      Probe: Restaurant expiry policy fields -> ABSENT.
 *
 * Control from the same probe run (so the above are not overstated): consuming
 * expired-only stock on a RECIPE_DEDUCTION already answered
 * `409 Insufficient unexpired inventory`, and the balance did not drift.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryBatch, InventoryTransaction, Notification, Restaurant
} from '../src/models/operations.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {
  EXPIRY_TIERS, daysUntilExpiry, expiryState, expiryTier
} from '../src/services/inventoryBatches.js';
import {resolveExpiryPolicy} from '../src/services/expiryAlerts.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let rival;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();

  const restaurant = await Restaurant.create({name: 'Rival16', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival16 Branch', code: 'RV6', address: 'Jhamsikhel'
  });
  rival = {
    restaurant,
    branch,
    ingredient: await Ingredient.create({
      restaurant: restaurant._id, code: 'RV-ING', name: 'Rival Rice', unit: 'g'
    }),
    owner: await User.create({
      name: 'Rival16 Owner', email: 'rival16@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival16', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);

let keySeed = 0;
const KEY = () => `p15b-${Date.now()}-${++keySeed}`;
const day = n => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

/** Receive a lot with an explicit expiry, through the ledger. */
async function receive({
  days, qty = 1000, batchNumber = 'B1', unitCost = 0.05,
  branch = world.branchA, ingredient = world.ingredient, supplier, user = world.owner
} = {}) {
  return inTransaction(session => moveStock({
    branch: branch._id, ingredient: ingredient._id, qty, unit: 'g', type: 'PURCHASE',
    reason: `Received lot ${batchNumber}`, referenceType: 'goods_receipt',
    referenceId: new mongoose.Types.ObjectId(), user: user._id, idempotencyKey: KEY(), unitCost,
    incomingBatches: [{
      quantity: qty, batchNumber, unitCost,
      ...(days === null ? {} : {expiryDate: day(days)}),
      ...(supplier ? {supplier} : {}),
      sourceType: 'goods_receipt'
    }]
  }, session));
}

/** Consume through the ledger; returns 'ALLOWED' or the error message. */
async function consume(qty, {type = 'RECIPE_DEDUCTION', branch = world.branchA, ingredient = world.ingredient, extra = {}} = {}) {
  try {
    await inTransaction(session => moveStock({
      branch: branch._id, ingredient: ingredient._id, qty: -Math.abs(qty), unit: 'g', type,
      reason: 'Consumption under test', referenceType: 'order',
      referenceId: new mongoose.Types.ObjectId(), user: world.owner._id, idempotencyKey: KEY(),
      ...extra
    }, session));
    return 'ALLOWED';
  } catch (error) {
    return `BLOCKED: ${error.message}`;
  }
}

/** Drain the untracked opening lot so only lots under test remain. */
async function drainOpening(branch = world.branchA) {
  await consume(20000, {branch});
}

const lots = async (branch = world.branchA) => InventoryBatch
  .find({branch: branch._id, ingredient: world.ingredient._id})
  .sort({expiryDate: 1}).lean();

const balanceOf = async (branch = world.branchA) => (await InventoryBalance.findOne({
  branch: branch._id, ingredient: world.ingredient._id
}))?.quantity ?? 0;

const alerts = (query = '', token = manager()) =>
  request(`/api/inventory/expiry-alerts?branch=${world.branchA._id}${query}`, {token});

const setPolicy = patch => Restaurant.updateOne({_id: world.restaurant._id}, {$set: patch});

// ═══════════════════════════════════════════════════════════════════════════
// Batch receiving
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — batch receiving', () => {
  it('records every attribute the brief lists', async () => {
    const supplier = await mongoose.model('Supplier').create({
      restaurant: world.restaurant._id, name: 'Himalayan Foods'
    });
    await receive({days: 30, qty: 500, batchNumber: 'LOT-A', unitCost: 0.07, supplier: supplier._id});

    const lot = await InventoryBatch.findOne({batchNumber: 'LOT-A'});
    assert.ok(lot, 'the lot must exist');
    assert.equal(lot.batchNumber, 'LOT-A');
    assert.equal(String(lot.supplier), String(supplier._id));
    assert.ok(lot.receivedAt, 'received date');
    assert.equal(lot.expiryDate.toISOString().slice(0, 10), day(30));
    assert.equal(lot.quantity, 500);
    assert.equal(lot.initialQuantity, 500);
    assert.equal(lot.unitCost, 0.07);
    assert.equal(String(lot.branch), String(world.branchA._id));
  });

  it('keeps two receipts of the same ingredient as separate lots', async () => {
    await drainOpening();
    await receive({days: 10, qty: 100, batchNumber: 'LOT-1'});
    await receive({days: 20, qty: 200, batchNumber: 'LOT-2'});

    // A drained lot stays on file at zero quantity, so count the live ones.
    const rows = (await lots()).filter(l => l.quantity > 0);
    assert.equal(rows.length, 2, 'lots must not be merged');
    assert.equal(await balanceOf(), 300, 'the aggregate balance is the sum of the lots');
  });

  it('accepts a lot with no expiry date', async () => {
    await receive({days: null, qty: 250, batchNumber: 'LOT-DRY'});
    const lot = await InventoryBatch.findOne({batchNumber: 'LOT-DRY'});
    assert.equal(lot.expiryDate, undefined);
    assert.equal(expiryState(lot.expiryDate, {quantity: lot.quantity}), 'no_expiry');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Expiry statuses
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — expiry statuses', () => {
  it('classifies fresh, expiring and expired', () => {
    assert.equal(expiryState(day(60), {}), 'fresh');
    assert.equal(expiryState(day(10), {}), 'expiring');
    assert.equal(expiryState(day(-1), {}), 'expired');
    assert.equal(expiryState(day(0), {}), 'expiring', 'today is not yet expired');
    assert.equal(expiryState(null, {}), 'no_expiry');
    assert.equal(expiryState(day(5), {quantity: 0}), 'depleted');
  });

  it('counts whole days remaining', () => {
    assert.equal(daysUntilExpiry(day(3)), 3);
    assert.equal(daysUntilExpiry(day(0)), 0);
    assert.equal(daysUntilExpiry(day(-2)), -2);
    assert.equal(daysUntilExpiry(null), null);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Alert tiers — 7 days, 3 days, expired
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — alert tiers', () => {
  it('grades a batch by how close it actually is', () => {
    assert.equal(expiryTier(day(-1)), 'expired');
    assert.equal(expiryTier(day(0)), 'critical');
    assert.equal(expiryTier(day(3)), 'critical', '3 days remaining is the critical tier');
    assert.equal(expiryTier(day(4)), 'warning');
    assert.equal(expiryTier(day(7)), 'warning', '7 days remaining is the warning tier');
    assert.equal(expiryTier(day(8)), 'notice');
    assert.equal(expiryTier(day(60)), 'fresh');
    assert.equal(expiryTier(null), 'no_expiry');
    for (const tier of ['expired', 'critical', 'warning', 'notice', 'fresh', 'no_expiry']) {
      assert.ok(EXPIRY_TIERS.includes(tier));
    }
  });

  it('reports distinct severities through the API', async () => {
    // The defect: these three all came back `warning`.
    await drainOpening();
    await receive({days: 2, qty: 100, batchNumber: 'B-2D'});
    await receive({days: 5, qty: 100, batchNumber: 'B-5D'});
    await receive({days: 20, qty: 100, batchNumber: 'B-20D'});

    const res = await alerts();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const byBatch = Object.fromEntries(res.body.alerts.map(a => [a.batchNumber, a]));

    assert.equal(byBatch['B-2D'].tier, 'critical');
    assert.equal(byBatch['B-2D'].severity, 'critical');
    assert.equal(byBatch['B-5D'].tier, 'warning');
    assert.equal(byBatch['B-5D'].severity, 'warning');
    assert.equal(byBatch['B-20D'].tier, 'notice');
    assert.equal(byBatch['B-20D'].severity, 'info');
    assert.notEqual(byBatch['B-2D'].severity, byBatch['B-20D'].severity,
      'a batch expiring in 2 days must not look like one expiring in 20');
  });

  it('marks expired stock critical and counts each tier', async () => {
    await drainOpening();
    await receive({days: -3, qty: 100, batchNumber: 'B-GONE'});
    await receive({days: 1, qty: 100, batchNumber: 'B-TOMORROW'});

    const res = await alerts();
    const byBatch = Object.fromEntries(res.body.alerts.map(a => [a.batchNumber, a]));
    assert.equal(byBatch['B-GONE'].tier, 'expired');
    assert.equal(byBatch['B-GONE'].severity, 'critical');
    assert.equal(byBatch['B-GONE'].daysUntilExpiry, -3);
    assert.equal(res.body.tierCounts.expired, 1);
    assert.equal(res.body.tierCounts.critical, 1);
  });

  it('honours per-restaurant tier configuration', async () => {
    await drainOpening();
    await receive({days: 10, qty: 100, batchNumber: 'B-10D'});

    assert.equal((await alerts()).body.alerts[0].tier, 'notice');

    await setPolicy({expiryWarningDays: 14, expiryCriticalDays: 12});
    const widened = await alerts();
    assert.equal(widened.body.policy.warningDays, 14);
    assert.equal(widened.body.alerts[0].tier, 'critical', '10 days is inside a 12-day critical window');
  });

  it('clamps a critical window wider than the warning window', async () => {
    // Otherwise 'warning' becomes unreachable and the tier is a lie.
    await setPolicy({expiryWarningDays: 5, expiryCriticalDays: 30});
    const policy = await resolveExpiryPolicy(world.restaurant._id);
    assert.equal(policy.warningDays, 5);
    assert.equal(policy.criticalDays, 5);
  });

  it('defaults to the brief thresholds', async () => {
    const policy = await resolveExpiryPolicy(world.restaurant._id);
    assert.equal(policy.warningDays, 7);
    assert.equal(policy.criticalDays, 3);
    assert.equal(policy.policy, 'block');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FEFO
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — FEFO consumption', () => {
  it('takes the nearest expiry first, regardless of receipt order', async () => {
    await drainOpening();
    await receive({days: 30, qty: 100, batchNumber: 'B-FAR'});
    await receive({days: 3, qty: 100, batchNumber: 'B-NEAR'});
    await receive({days: 10, qty: 100, batchNumber: 'B-MID'});

    assert.equal(await consume(150), 'ALLOWED');

    const byBatch = Object.fromEntries((await lots()).map(l => [l.batchNumber, l.quantity]));
    assert.equal(byBatch['B-NEAR'], 0, 'the soonest to expire is emptied first');
    assert.equal(byBatch['B-MID'], 50, 'then the next soonest');
    assert.equal(byBatch['B-FAR'], 100, 'the furthest is untouched');
    assert.equal(await balanceOf(), 150, 'the aggregate agrees with the lots');
  });

  it('spans exactly as many lots as it needs', async () => {
    await drainOpening();
    await receive({days: 1, qty: 50, batchNumber: 'L1'});
    await receive({days: 2, qty: 50, batchNumber: 'L2'});
    await receive({days: 3, qty: 50, batchNumber: 'L3'});

    assert.equal(await consume(120), 'ALLOWED');
    const byBatch = Object.fromEntries((await lots()).map(l => [l.batchNumber, l.quantity]));
    assert.deepEqual([byBatch.L1, byBatch.L2, byBatch.L3], [0, 0, 30]);
  });

  it('places undated lots last, so dated stock moves first', async () => {
    await drainOpening();
    await receive({days: null, qty: 100, batchNumber: 'B-NODATE'});
    await receive({days: 40, qty: 100, batchNumber: 'B-DATED'});

    assert.equal(await consume(100), 'ALLOWED');
    const byBatch = Object.fromEntries((await lots()).map(l => [l.batchNumber, l.quantity]));
    assert.equal(byBatch['B-DATED'], 0, 'a dated lot is consumed before an undated one');
    assert.equal(byBatch['B-NODATE'], 100);
  });

  it('supports FIFO explicitly without changing the FEFO default', async () => {
    await drainOpening();
    await receive({days: 30, qty: 100, batchNumber: 'F-FIRST'});
    await receive({days: 2, qty: 100, batchNumber: 'F-SECOND'});

    await inTransaction(session => moveStock({
      branch: world.branchA._id, ingredient: world.ingredient._id, qty: -100, unit: 'g',
      type: 'RECIPE_DEDUCTION', reason: 'FIFO run', referenceType: 'order',
      referenceId: new mongoose.Types.ObjectId(), user: world.owner._id,
      idempotencyKey: KEY(), consumptionStrategy: 'fifo'
    }, session));

    const byBatch = Object.fromEntries((await lots()).map(l => [l.batchNumber, l.quantity]));
    assert.equal(byBatch['F-FIRST'], 0, 'FIFO takes the earliest received');
    assert.equal(byBatch['F-SECOND'], 100);
  });

  it('keeps the ledger and the lots reconciled', async () => {
    await drainOpening();
    await receive({days: 5, qty: 300, batchNumber: 'R1'});
    await consume(120);

    const lotTotal = (await lots()).reduce((sum, l) => sum + l.quantity, 0);
    assert.equal(lotTotal, await balanceOf(), 'lot sum must equal the aggregate balance');

    const rows = await InventoryTransaction.find({
      branch: world.branchA._id, ingredient: world.ingredient._id
    }).sort({createdAt: 1, _id: 1}).lean();
    for (let i = 1; i < rows.length; i += 1) {
      assert.equal(rows[i].previousQty, rows[i - 1].newQty, `ledger chain broken at ${i}`);
      assert.equal(rows[i].newQty, rows[i].previousQty + rows[i].changeQty);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Expired stock policy
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — expired stock policy', () => {
  it('blocks a sale from expired stock by default', async () => {
    await drainOpening();
    await receive({days: -5, qty: 500, batchNumber: 'B-OLD'});

    const result = await consume(50);
    assert.match(result, /BLOCKED/);
    assert.match(result, /Insufficient unexpired inventory/);
    assert.equal(await balanceOf(), 500, 'nothing moved');
    // Index by batch number: the drained opening lot remains on file at zero.
    const stored = (await lots()).find(l => l.batchNumber === 'B-OLD');
    assert.equal(stored.quantity, 500, 'the expired lot is untouched');
  });

  it('allows the sale under the warn policy and raises a notification', async () => {
    await drainOpening();
    await receive({days: -5, qty: 500, batchNumber: 'B-WARN'});
    await setPolicy({expiryPolicy: 'warn'});

    assert.equal(await consume(50), 'ALLOWED');
    assert.equal(await balanceOf(), 450);

    const note = await Notification.findOne({type: 'expired_stock_consumed', branch: world.branchA._id});
    assert.ok(note, 'using expired stock must not be silent');
    assert.match(note.body, /expired batch/i);
  });

  it('allows it silently under the allow policy', async () => {
    await drainOpening();
    await receive({days: -5, qty: 500, batchNumber: 'B-ALLOW'});
    await setPolicy({expiryPolicy: 'allow'});

    assert.equal(await consume(50), 'ALLOWED');
    assert.equal(await Notification.countDocuments({type: 'expired_stock_consumed'}), 0);
  });

  it('never blocks waste, adjustment or return, whatever the policy', async () => {
    // Writing off what has gone bad is exactly what these movements are for.
    await drainOpening();
    await receive({days: -5, qty: 500, batchNumber: 'B-WASTE'});
    await setPolicy({expiryPolicy: 'block'});

    assert.equal(await consume(20, {type: 'ADJUSTMENT'}), 'ALLOWED');
    assert.equal(await consume(20, {type: 'RETURN'}), 'ALLOWED');
    assert.equal(await balanceOf(), 460);
  });

  it('still blocks when only part of the stock is expired', async () => {
    await drainOpening();
    await receive({days: -2, qty: 100, batchNumber: 'B-BAD'});
    await receive({days: 30, qty: 100, batchNumber: 'B-GOOD'});
    await setPolicy({expiryPolicy: 'block'});

    // 100 good units are available, so 80 succeeds from the good lot only.
    assert.equal(await consume(80), 'ALLOWED');
    const byBatch = Object.fromEntries((await lots()).map(l => [l.batchNumber, l.quantity]));
    assert.equal(byBatch['B-BAD'], 100, 'expired stock is skipped, not consumed');
    assert.equal(byBatch['B-GOOD'], 20);

    // Asking for more than the good stock is refused rather than dipping in.
    assert.match(await consume(50), /BLOCKED/);
    assert.equal((await lots()).find(l => l.batchNumber === 'B-BAD').quantity, 100);
  });

  it('rejects an unknown policy value at the schema', async () => {
    await assert.rejects(
      Restaurant.updateOne({_id: world.restaurant._id}, {$set: {expiryPolicy: 'ignore'}}, {runValidators: true}),
      /validation|enum/i
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Waste and returns against lots
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — waste and returns', () => {
  it('writes waste off a specific expired lot', async () => {
    await drainOpening();
    await receive({days: -1, qty: 200, batchNumber: 'W-EXPIRED'});
    const lot = await InventoryBatch.findOne({batchNumber: 'W-EXPIRED'});

    const res = await request('/api/waste/record', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: 200, reason: 'expired', batchId: String(lot._id),
        notes: 'Expired stock discarded at close'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    assert.equal((await InventoryBatch.findById(lot._id)).quantity, 0, 'the expired lot is emptied');
    assert.equal(await balanceOf(), 0);
    const movement = await InventoryTransaction.findOne({type: 'WASTE', ingredient: world.ingredient._id});
    assert.equal(movement.changeQty, -200);
    assert.equal(movement.newQty, movement.previousQty + movement.changeQty);
  });

  it('a return takes stock back out without touching unrelated lots', async () => {
    await drainOpening();
    await receive({days: 5, qty: 100, batchNumber: 'RET-NEAR'});
    await receive({days: 50, qty: 100, batchNumber: 'RET-FAR'});

    assert.equal(await consume(60, {type: 'RETURN'}), 'ALLOWED');
    const byBatch = Object.fromEntries((await lots()).map(l => [l.batchNumber, l.quantity]));
    assert.equal(byBatch['RET-NEAR'], 40);
    assert.equal(byBatch['RET-FAR'], 100);
    assert.equal(await balanceOf(), 140);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Branch and tenant isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — branch and tenant isolation', () => {
  it('consumes only from the branch that holds the lot', async () => {
    await drainOpening(world.branchA);
    await drainOpening(world.branchB);
    await receive({days: 5, qty: 100, batchNumber: 'A-ONLY', branch: world.branchA});

    // Branch B has no stock, so it cannot borrow branch A's lot.
    const result = await consume(50, {branch: world.branchB});
    assert.match(result, /BLOCKED/);
    assert.equal(await balanceOf(world.branchA), 100, "branch A's lot is untouched");

    const bLots = await InventoryBatch.countDocuments({
      branch: world.branchB._id, ingredient: world.ingredient._id, quantity: {$gt: 0}
    });
    assert.equal(bLots, 0);
  });

  it('scopes the alert list to the requested branch', async () => {
    await drainOpening(world.branchA);
    await drainOpening(world.branchB);
    await receive({days: 2, qty: 100, batchNumber: 'A-NEAR', branch: world.branchA});
    await receive({days: 2, qty: 100, batchNumber: 'B-NEAR', branch: world.branchB, user: world.owner});

    const res = await alerts('', owner());
    const numbers = res.body.alerts.map(a => a.batchNumber);
    assert.ok(numbers.includes('A-NEAR'));
    assert.ok(!numbers.includes('B-NEAR'), 'a branch-scoped query must not leak another branch');
  });

  it('never leaks lots across restaurants', async () => {
    await receive({days: 3, qty: 100, batchNumber: 'OURS'});

    const intruder = tokenFor(rival.owner);
    const res = await request(`/api/inventory/expiry-alerts?branch=${world.branchA._id}`, {token: intruder});
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);

    // And their own scan sees nothing of ours.
    const theirs = await request('/api/inventory/expiry-alerts', {token: intruder});
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.body.alerts.length, 0);
  });

  it('applies each restaurant policy independently', async () => {
    await setPolicy({expiryPolicy: 'allow'});
    const ours = await resolveExpiryPolicy(world.restaurant._id);
    const theirs = await resolveExpiryPolicy(rival.restaurant._id);
    assert.equal(ours.policy, 'allow');
    assert.equal(theirs.policy, 'block', 'another tenant keeps the safe default');
  });

  it('refuses anonymous and forged tokens on the alert endpoints', async () => {
    for (const path of [
      `/api/inventory/expiry-alerts?branch=${world.branchA._id}`,
      `/api/inventory/expiry-summary?branch=${world.branchA._id}`
    ]) {
      assert.equal((await request(path)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {token: 'not.a.jwt'})).status, 401, `${path} forged`);
    }
  });
});
