import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Audit, Expense, MonthlySnapshot, Supplier, User} from '../src/models/index.js';
import {Branch, InventoryTransaction, Order, Restaurant, SupplierInvoice} from '../src/models/operations.js';
import {monthRange} from '../src/services/monthClose.js';
import {ensureMonthCloseIndexes} from '../src/services/monthCloseMigration.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

const MONTH = '2020-01';
let world;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  const opening = await InventoryTransaction.findOne({
    restaurant: world.restaurant._id,
    branch: world.branchA._id,
    ingredient: world.ingredient._id,
    type: 'OPENING'
  }).lean();
  const openingAt = new Date('2019-12-31T18:15:00.000Z');
  await InventoryTransaction.collection.updateOne(
    {_id: opening._id},
    {$set: {createdAt: openingAt, updatedAt: openingAt}}
  );
});

async function addClosedOrder(overrides = {}) {
  return Order.create({
    orderNo: 'ORD-CLOSE-1',
    branch: world.branchA._id,
    type: 'counter',
    status: 'completed',
    items: [{menuItem: world.menu._id, name: world.menu.name, qty: 2, unitPrice: 350, foodCost: 11.25}],
    subtotal: 700,
    vatRate: 13,
    vat: 91,
    total: 791,
    dueAmount: 0,
    paidAmount: 791,
    inventoryDeducted: true,
    createdBy: world.owner._id,
    createdAt: new Date('2020-01-15T06:15:00.000Z'),
    updatedAt: new Date('2020-01-15T06:15:00.000Z'),
    ...overrides
  });
}

async function addExpense(amount = 100) {
  return Expense.create({
    category: 'rent',
    description: 'January rent',
    amount,
    vat: amount * 0.13,
    branch: world.branchA._id,
    createdBy: world.manager._id,
    date: new Date('2020-01-10T06:15:00.000Z')
  });
}

function close(body = {}, token = tokenFor(world.owner)) {
  return request('/api/month-close', {
    method: 'POST',
    token,
    body: {month: MONTH, branch: String(world.branchA._id), notes: 'Reconciled', ...body}
  });
}

describe('Nepal accounting month', () => {
  it('uses midnight in Asia/Kathmandu for exact boundaries', () => {
    const range = monthRange(MONTH);
    assert.equal(range.from.toISOString(), '2019-12-31T18:15:00.000Z');
    assert.equal(range.toExclusive.toISOString(), '2020-01-31T18:15:00.000Z');
    assert.equal(range.to.toISOString(), '2020-01-31T18:14:59.999Z');
  });
});

describe('GET /api/month-close/preview', () => {
  it('reconciles branch P&L, quantity-aware COGS and historical inventory', async () => {
    await addClosedOrder();
    await addExpense();
    const preview = await request(`/api/month-close/preview?month=${MONTH}&branch=${world.branchA._id}`, {
      token: tokenFor(world.manager)
    });
    assert.equal(preview.status, 200, preview.body?.message);
    assert.equal(preview.body.timezone, 'Asia/Kathmandu');
    assert.equal(preview.body.ready, true);
    assert.equal(preview.body.pnl.revenue, 791);
    assert.equal(preview.body.pnl.cogs, 22.5);
    assert.equal(preview.body.pnl.grossProfit, 768.5);
    assert.equal(preview.body.pnl.expenses, 100);
    assert.equal(preview.body.pnl.netProfit, 668.5);
    assert.equal(preview.body.inventory.opening.value, 0);
    assert.equal(preview.body.inventory.closing.value, 900);
    assert.equal(preview.body.reconciliation.openOrders, 0);
  });

  it('blocks open tickets and protects branch and role access', async () => {
    await addClosedOrder({orderNo: 'ORD-OPEN', status: 'pending'});
    const preview = await request(`/api/month-close/preview?month=${MONTH}&branch=${world.branchA._id}`, {
      token: tokenFor(world.manager)
    });
    assert.equal(preview.status, 200, preview.body?.message);
    assert.equal(preview.body.ready, false);
    assert.equal(preview.body.reconciliation.openOrders, 1);
    assert.match(preview.body.blockers[0], /open order/);

    assert.equal((await request(`/api/month-close/preview?month=${MONTH}&branch=${world.branchB._id}`, {
      token: tokenFor(world.manager)
    })).status, 403);
    assert.equal((await request(`/api/month-close/preview?month=${MONTH}&branch=${world.branchA._id}`, {
      token: tokenFor(world.staffA)
    })).status, 403);
    assert.equal((await request(`/api/month-close/preview?month=${MONTH}&branch=${world.branchA._id}`)).status, 401);
  });
});

describe('month close revisions', () => {
  it('locks figures, requires owner reopen reason, and preserves revisions', async () => {
    await addClosedOrder();
    const expense = await addExpense();
    const first = await close();
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(first.body.status, 'closed');
    assert.equal(first.body.revision, 1);
    assert.equal(first.body.cogs, 22.5);
    assert.equal(first.body.netProfit, 668.5);
    assert.equal(first.body.closingInventory, 900);
    assert.equal(first.body.closedBy.name, 'Owner');

    await Expense.updateOne({_id: expense._id}, {$set: {amount: 250, vat: 32.5}});
    const duplicate = await close();
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.body.message, /already closed/);
    const locked = await MonthlySnapshot.findById(first.body._id);
    assert.equal(locked.expenses, 100);
    assert.equal(locked.netProfit, 668.5);

    assert.equal((await request(`/api/month-close/${first.body._id}/reopen`, {
      method: 'POST', token: tokenFor(world.manager), body: {reason: 'Correction'}
    })).status, 403);
    assert.equal((await request(`/api/month-close/${first.body._id}/reopen`, {
      method: 'POST', token: tokenFor(world.owner), body: {reason: 'x'}
    })).status, 400);

    const reopened = await request(`/api/month-close/${first.body._id}/reopen`, {
      method: 'POST', token: tokenFor(world.owner), body: {reason: 'Correct late rent entry'}
    });
    assert.equal(reopened.status, 200, reopened.body?.message);
    assert.equal(reopened.body.status, 'reopened');
    assert.equal(reopened.body.expenses, 100);

    const second = await close({notes: 'Reconciled after correction'});
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(second.body.revision, 2);
    assert.equal(second.body.status, 'closed');
    assert.equal(second.body.expenses, 250);
    assert.equal(second.body.netProfit, 518.5);

    const history = await request(`/api/month-close?branch=${world.branchA._id}`, {token: tokenFor(world.manager)});
    assert.equal(history.status, 200, history.body?.message);
    assert.equal(history.body.length, 2);
    assert.deepEqual(history.body.map(x => x.revision), [2, 1]);
    assert.deepEqual(history.body.map(x => x.status), ['closed', 'reopened']);
    assert.equal(await Audit.countDocuments({entity: 'monthly_snapshot', action: 'close'}), 2);
    assert.equal(await Audit.countDocuments({entity: 'monthly_snapshot', action: 'reopen'}), 1);
  });

  it('allows managers to preview but only owners to close', async () => {
    assert.equal((await close({}, tokenFor(world.manager))).status, 403);
    const now = new Date(Date.now() + (5 * 60 + 45) * 60000);
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const current = await close({month: thisMonth});
    assert.equal(current.status, 409);
    assert.match(current.body.message, /current month/i);
  });
});

describe('month-close tenant identity', () => {
  async function foreignWorld() {
    const restaurant = await Restaurant.create({name: 'Foreign Month Close'});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Foreign Branch', code: 'FMC'});
    const owner = await User.create({
      name: 'Foreign Owner', email: 'foreign-close@test.com', password: 'x', role: 'owner', restaurantId: restaurant._id
    });
    return {restaurant, branch, owner};
  }

  it('migrates legacy snapshots to a restaurant-scoped identity and hardened indexes', async () => {
    const indexes = await MonthlySnapshot.collection.indexes();
    for (const index of indexes) if (index.name !== '_id_') await MonthlySnapshot.collection.dropIndex(index.name);
    const legacyId = (await MonthlySnapshot.collection.insertOne({
      month: '2019-12',
      branch: world.branchA._id,
      scopeKey: String(world.branchA._id),
      revision: 1,
      status: 'closed',
      closedBy: world.owner._id,
      createdAt: new Date(),
      updatedAt: new Date()
    })).insertedId;
    const result = await ensureMonthCloseIndexes();
    assert.equal(result.migrated, 1);
    const migrated = await MonthlySnapshot.findById(legacyId).lean();
    assert.equal(String(migrated.restaurant), String(world.restaurant._id));
    const names = new Set((await MonthlySnapshot.collection.indexes()).map(index => index.name));
    assert.ok(names.has('monthly_snapshot_restaurant_revision'));
    assert.ok(names.has('monthly_snapshot_restaurant_status'));
  });

  it('allows the same month/scope revision per restaurant but hides and protects foreign snapshots', async () => {
    await ensureMonthCloseIndexes();
    const foreign = await foreignWorld();
    const local = await MonthlySnapshot.create({
      restaurant: world.restaurant._id,
      month: '2019-12', scopeKey: 'all', revision: 1, status: 'closed', closedBy: world.owner._id
    });
    const foreignSnapshot = await MonthlySnapshot.create({
      restaurant: foreign.restaurant._id,
      month: '2019-12', scopeKey: 'all', revision: 1, status: 'closed', closedBy: foreign.owner._id
    });
    const history = await request('/api/month-close', {token: tokenFor(world.owner)});
    assert.equal(history.status, 200, history.body?.message);
    assert.deepEqual(history.body.map(row => row._id), [String(local._id)]);
    const reopenForeign = await request(`/api/month-close/${foreignSnapshot._id}/reopen`, {
      method: 'POST', token: tokenFor(world.owner), body: {reason: 'Cross tenant attempt'}
    });
    assert.equal(reopenForeign.status, 404);
    assert.equal((await MonthlySnapshot.findById(foreignSnapshot._id)).status, 'closed');
  });

  it('keeps all-branch invoice, order, expense and inventory reconciliation inside the owner restaurant', async () => {
    const foreign = await foreignWorld();
    const localSupplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Local Close Supplier'});
    const foreignSupplier = await Supplier.create({restaurant: foreign.restaurant._id, name: 'Foreign Close Supplier'});
    const invoiceDate = new Date('2020-01-10T00:00:00.000Z');
    const base = {
      invoiceDate,
      priceIncludesVat: false,
      vatRate: 13,
      subtotal: 100,
      vat: 13,
      total: 113,
      paidAmount: 0,
      status: 'unpaid',
      matching: {status: 'unlinked', matchedAt: invoiceDate},
      createdAt: invoiceDate,
      updatedAt: invoiceDate
    };
    await SupplierInvoice.create({
      ...base,
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      supplier: localSupplier._id,
      invoiceNo: 'LOCAL-CLOSE-1',
      invoiceNoNormalized: 'LOCAL-CLOSE-1',
      createdBy: world.owner._id,
      updatedBy: world.owner._id
    });
    await SupplierInvoice.create({
      ...base,
      restaurant: foreign.restaurant._id,
      branch: foreign.branch._id,
      supplier: foreignSupplier._id,
      invoiceNo: 'FOREIGN-CLOSE-1',
      invoiceNoNormalized: 'FOREIGN-CLOSE-1',
      createdBy: foreign.owner._id,
      updatedBy: foreign.owner._id
    });
    const baseline = await request(`/api/month-close/preview?month=${MONTH}`, {token: tokenFor(world.owner)});
    assert.equal(baseline.status, 200, baseline.body?.message);
    assert.equal(baseline.body.reconciliation.unpaidInvoices, 1);

    await Order.create({
      orderNo: 'FOREIGN-OPEN-1',
      branch: foreign.branch._id,
      status: 'pending',
      items: [{name: 'Foreign item', qty: 1, unitPrice: 999, foodCost: 10}],
      total: 999,
      createdBy: foreign.owner._id,
      createdAt: invoiceDate,
      updatedAt: invoiceDate
    });
    await Expense.create({
      category: 'foreign rent', amount: 777, vat: 101.01,
      createdBy: foreign.owner._id, date: invoiceDate
    });
    await new InventoryTransaction({
      restaurant: foreign.restaurant._id,
      branch: foreign.branch._id,
      ingredient: world.ingredient._id,
      type: 'WASTE',
      previousQty: 100,
      changeQty: -1,
      newQty: 99,
      unit: 'g',
      unitCost: 10,
      totalCost: 10,
      reason: 'Foreign tenant waste fixture',
      referenceType: 'test_fixture',
      referenceId: foreign.branch._id,
      user: foreign.owner._id,
      idempotencyKey: 'foreign-month-close-waste',
      idempotencyHash: 'f'.repeat(64),
      idempotencyHashVersion: 2,
      createdAt: invoiceDate,
      updatedAt: invoiceDate
    }).save({inventoryLedgerWrite: true});
    const preview = await request(`/api/month-close/preview?month=${MONTH}`, {token: tokenFor(world.owner)});
    assert.equal(preview.status, 200, preview.body?.message);
    assert.equal(preview.body.reconciliation.unpaidInvoices, baseline.body.reconciliation.unpaidInvoices);
    assert.equal(preview.body.reconciliation.openOrders, baseline.body.reconciliation.openOrders);
    assert.deepEqual(preview.body.inventory, baseline.body.inventory);
    assert.equal(preview.body.pnl.revenue, baseline.body.pnl.revenue);
    assert.equal(preview.body.pnl.expenses, baseline.body.pnl.expenses);
    assert.equal(preview.body.pnl.waste, baseline.body.pnl.waste);
  });
});
