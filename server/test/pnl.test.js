import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Supplier, Expense, Sale, Purchase} from '../src/models/index.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let supplier;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Kathmandu Food Suppliers', contact: '9800000000'});
});

async function createApprovedPo(orderedQty = 1000) {
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(world.manager),
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty, unit: 'g', unitPrice: 0.05}],
      total: orderedQty * 0.05
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  await request('/api/purchase-orders/' + created.body._id + '/status', {
    method: 'PATCH', token: tokenFor(world.manager), body: {status: 'pending'}
  });
  const approved = await request('/api/purchase-orders/' + created.body._id + '/status', {
    method: 'PATCH', token: tokenFor(world.owner), body: {status: 'approved'}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return approved.body;
}

function createLiveOrder(branch = world.branchA) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(branch._id),
      type: 'counter',
      items: [{menuItem: String(world.menu._id), qty: 1}]
    }
  });
}

describe('GET /api/reports/pnl', () => {
  it('builds P&L from live orders, ledger purchases and restaurant expenses', async () => {
    const sold = await createLiveOrder();
    assert.equal(sold.status, 201, sold.body?.message);
    assert.equal(sold.body.total, 395.5);
    assert.equal(sold.body.items[0].foodCost, 11.25);

    const cancelled = await createLiveOrder();
    assert.equal(cancelled.status, 201, cancelled.body?.message);
    const stop = await request('/api/orders/' + cancelled.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(stop.status, 200, stop.body?.message);

    const other = await createLiveOrder(world.branchB);
    assert.equal(other.status, 201, other.body?.message);

    const po = await createApprovedPo(1000);
    const rec = await request('/api/purchase-orders/' + po._id + '/receive', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'pnl-gr'},
      body: {items: [{itemId: String(po.items[0]._id), receivedQty: 400, damagedQty: 50, unitPrice: 0.05}]}
    });
    assert.equal(rec.status, 201, rec.body?.message);
    const ret = await request('/api/purchase-orders/' + po._id + '/returns', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'pnl-pr'},
      body: {items: [{itemId: String(po.items[0]._id), qty: 100}]}
    });
    assert.equal(ret.status, 201, ret.body?.message);

    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), supplier: String(supplier._id), invoiceNo: 'INV-PNL', subtotal: 1000, vat: 130, total: 1130}
    });
    await Expense.create({category: 'rent', description: 'Kalanki shop', amount: 500, vat: 0, date: new Date()});
    await Sale.create({items: [{name: 'Legacy', qty: 1, unitPrice: 999, foodCost: 1}], subtotal: 999, vat: 0, total: 999, cogs: 1, grossProfit: 998});
    await Purchase.create({qty: 1, total: 888, unitPrice: 888, invoiceNo: 'OLD'});

    const pnl = await request('/api/reports/pnl?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(pnl.status, 200, pnl.body?.message);
    assert.equal(pnl.body.source, 'live');
    assert.equal(pnl.body.currency, 'NPR');
    assert.equal(pnl.body.revenue, 395.5);
    assert.equal(pnl.body.cogs, 11.25);
    assert.equal(pnl.body.grossProfit, 384.25);
    assert.equal(pnl.body.sales.orders, 1);
    assert.equal(pnl.body.sales.vat, 45.5);
    assert.equal(pnl.body.purchases, 12.5);
    assert.equal(pnl.body.purchasing.acceptedValue, 17.5);
    assert.equal(pnl.body.purchasing.returnedValue, 5);
    assert.equal(pnl.body.purchasing.invoiced, 1130);
    assert.equal(pnl.body.purchasing.vat, 130);
    assert.equal(pnl.body.expenses, 500);
    assert.equal(pnl.body.waste, 0);
    assert.equal(pnl.body.netProfit, -115.75);
    assert.equal(pnl.body.expenseDetail.scope, 'restaurant');
  });

  it('subtracts branch waste from net profit and ignores other-branch write-offs', async () => {
    const sold = await createLiveOrder();
    assert.equal(sold.status, 201, sold.body?.message);
    const waste = await request('/api/waste/record', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: 1000, reason: 'spoiled'}
    });
    assert.equal(waste.status, 201, waste.body?.message);
    assert.equal(waste.body.totalCost, 45);
    const other = await request('/api/waste/record', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {branch: String(world.branchB._id), ingredient: String(world.ingredient._id), qty: 2000, reason: 'expired'}
    });
    assert.equal(other.status, 201, other.body?.message);

    const pnl = await request('/api/reports/pnl?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(pnl.status, 200, pnl.body?.message);
    assert.equal(pnl.body.revenue, 395.5);
    assert.equal(pnl.body.cogs, 11.25);
    assert.equal(pnl.body.grossProfit, 384.25);
    assert.equal(pnl.body.waste, 45);
    assert.equal(pnl.body.wasteDetail.count, 1);
    assert.equal(pnl.body.expenses, 0);
    assert.equal(pnl.body.netProfit, 339.25);
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    assert.equal((await request('/api/reports/pnl?branch=' + world.branchA._id, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request('/api/reports/pnl?branch=' + world.branchA._id)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/reports/pnl?branch=' + world.branchA._id, {token: guest})).status, 403);
    assert.equal((await request('/api/reports/pnl?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});
