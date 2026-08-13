import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {RestaurantTable, InventoryTransaction, Order, Payment} from '../src/models/operations.js';
import {Audit} from '../src/models/index.js';
import {money, shareForItems} from '../src/services/billing.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

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
});

function createOrder(qty = 2) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(world.branchA._id),
      type: 'dine-in',
      table: String(world.table._id),
      items: [{menuItem: String(world.menu._id), qty, notes: 'bill split'}]
    }
  });
}

function pay(orderId, amount, user = world.staffA, extras = {}) {
  return request('/api/orders/' + orderId + '/payments', {
    method: 'POST',
    token: tokenFor(user),
    body: {amount, method: extras.method || 'cash', ...extras.body}
  });
}

describe('money helpers', () => {
  it('rounds NPR to paisa and computes an item share with 13% VAT', () => {
    assert.equal(money(45.555), 45.56);
    const items = [
      {_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', qty: 2, unitPrice: 350},
      {_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', qty: 1, unitPrice: 100}
    ];
    items.id = id => items.find(i => i._id === id);
    const order = {items, subtotal: 800, total: 904, vatRate: 13};
    assert.equal(shareForItems(order, [{itemId: 'aaaaaaaaaaaaaaaaaaaaaaaa', qty: 1}]), 395.5);
  });
});

describe('multiple and partial payments', () => {
  it('records two partial payments and keeps the table occupied until the balance is cleared', async () => {
    const created = await createOrder(1);
    assert.equal(created.status, 201, created.body?.message);
    const first = await pay(created.body._id, 100);
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(first.body.order.status, 'pending');
    assert.equal(first.body.order.paidAmount, 100);
    assert.equal(first.body.order.dueAmount, money(created.body.total - 100));
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'occupied');

    const second = await pay(created.body._id, 50, world.manager, {method: 'esewa'});
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(second.body.order.paidAmount, 150);
    const listed = await request('/api/orders/' + created.body._id + '/payments', {token: tokenFor(world.owner)});
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 2);
    assert.equal(listed.body[0].method, 'cash');
    assert.equal(listed.body[1].method, 'esewa');
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'occupied');

    const close = await pay(created.body._id, money(created.body.total - 150));
    assert.equal(close.status, 201, close.body?.message);
    assert.equal(close.body.order.status, 'completed');
    assert.equal(close.body.order.dueAmount, 0);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
    const logs = await Audit.find({entity: 'order', entityId: created.body._id, action: 'payment'});
    assert.equal(logs.length, 3);
  });

  it('rejects overpay, cancelled orders, guests, and cross-branch staff', async () => {
    const created = await createOrder(1);
    assert.equal(created.status, 201, created.body?.message);
    assert.equal((await pay(created.body._id, created.body.total + 1)).status, 400);
    await request('/api/orders/' + created.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal((await pay(created.body._id, 10)).status, 409);
    assert.equal((await request('/api/orders/' + created.body._id + '/payments', {method: 'POST', body: {amount: 10, method: 'cash'}})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/orders/' + created.body._id + '/payments', {method: 'POST', token: guest, body: {amount: 10, method: 'cash'}})).status, 403);
    const other = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {branch: String(world.branchB._id), type: 'dine-in', table: String(world.tableB._id), items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(other.status, 201, other.body?.message);
    assert.equal((await pay(other.body._id, 10, world.staffA)).status, 403);
  });

  it('lets a guest pay only the selected item quantity', async () => {
    const created = await createOrder(2);
    assert.equal(created.status, 201, created.body?.message);
    const detail = await request('/api/orders/' + created.body._id, {token: tokenFor(world.owner)});
    const line = detail.body.items[0];
    const res = await request('/api/orders/' + created.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {method: 'cash', items: [{itemId: String(line._id), qty: 1}]}
    });
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.payment.amount, 395.5);
    assert.equal(res.body.order.status, 'pending');
    assert.equal(res.body.order.dueAmount, 395.5);
  });
});

describe('split items and close table after paid', () => {
  it('splits item quantities onto a second check without deducting stock again', async () => {
    const created = await createOrder(2);
    assert.equal(created.status, 201, created.body?.message);
    const beforeTx = await InventoryTransaction.countDocuments();
    const line = created.body.items[0];
    const res = await request('/api/orders/' + created.body._id + '/split', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {items: [{itemId: String(line._id), qty: 1}]}
    });
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.order.items[0].qty, 1);
    assert.equal(res.body.splitOrder.items[0].qty, 1);
    assert.equal(res.body.order.total, 395.5);
    assert.equal(res.body.splitOrder.total, 395.5);
    assert.equal(res.body.splitOrder.inventoryDeducted, true);
    assert.equal(res.body.splitOrder.table, created.body.table);
    assert.equal(await InventoryTransaction.countDocuments(), beforeTx);
    const floor = await request('/api/tables?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    const t1 = floor.body.find(t => t.name === 'T1');
    assert.equal(t1.status, 'occupied');
    assert.equal(t1.currentOrders.length, 2);

    const firstPay = await pay(res.body.order._id, res.body.order.dueAmount);
    assert.equal(firstPay.status, 201, firstPay.body?.message);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'occupied');
    const secondPay = await pay(res.body.splitOrder._id, res.body.splitOrder.dueAmount);
    assert.equal(secondPay.status, 201, secondPay.body?.message);
    assert.equal((await Order.findById(res.body.splitOrder._id)).status, 'completed');
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
    const logs = await Audit.find({action: 'bill_split'});
    assert.ok(logs.length >= 1);
  });

  it('rejects splitting every item and splitting more than the line quantity', async () => {
    const created = await createOrder(2);
    assert.equal(created.status, 201, created.body?.message);
    const line = created.body.items[0];
    const over = await request('/api/orders/' + created.body._id + '/split', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {items: [{itemId: String(line._id), qty: 9}]}
    });
    assert.equal(over.status, 409);
    const all = await request('/api/orders/' + created.body._id + '/split', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {items: [{itemId: String(line._id), qty: 2}]}
    });
    assert.equal(all.status, 409);
  });

  it('cancels only the split check recipe after a split', async () => {
    const created = await createOrder(2);
    assert.equal(created.status, 201, created.body?.message);
    const line = created.body.items[0];
    const split = await request('/api/orders/' + created.body._id + '/split', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {items: [{itemId: String(line._id), qty: 1}]}
    });
    assert.equal(split.status, 201, split.body?.message);
    const cancelled = await request('/api/orders/' + split.body.splitOrder._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, cancelled.body?.message);
    const reversals = await InventoryTransaction.find({type: 'RECIPE_REVERSAL'});
    assert.equal(reversals.length, 1);
    assert.equal(reversals[0].changeQty, 250);
    assert.equal((await Order.findById(created.body._id)).status, 'pending');
  });
});
