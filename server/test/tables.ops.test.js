import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {RestaurantTable, InventoryTransaction, Order, Payment, Customer} from '../src/models/operations.js';
import {Audit} from '../src/models/index.js';
import {combineItems} from '../src/services/tables.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let table2;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  table2 = await RestaurantTable.create({branch: world.branchA._id, name: 'T2', area: 'Main Hall', seats: 4});
});

function createLinkedOrder(table = world.table, extras = {}) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(world.branchA._id),
      type: 'dine-in',
      table: String(table._id),
      items: [{menuItem: String(world.menu._id), qty: 1, notes: extras.notes || 'table ticket'}],
      ...extras.body
    }
  });
}

function move(from, to, user = world.staffA) {
  return request('/api/tables/' + from._id + '/move', {
    method: 'POST',
    token: tokenFor(user),
    body: {toTable: String(to._id)}
  });
}

function merge(from, into, user = world.staffA) {
  return request('/api/tables/' + from._id + '/merge', {
    method: 'POST',
    token: tokenFor(user),
    body: {intoTable: String(into._id)}
  });
}

describe('combineItems', () => {
  it('sums quantities for the same menu item so later cancel reverses once', () => {
    const id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const merged = combineItems(
      [{menuItem: id, name: 'Chicken Biryani', qty: 1, unitPrice: 350, foodCost: 11.25, notes: 'less spicy'}],
      [{menuItem: id, name: 'Chicken Biryani', qty: 2, unitPrice: 350, foodCost: 11.25, notes: 'no onion'}]
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].qty, 3);
    assert.match(merged[0].notes, /less spicy/);
    assert.match(merged[0].notes, /no onion/);
  });
});

describe('POST /api/tables/:id/move', () => {
  it('moves an open order to another table and leaves items, payments and customer intact', async () => {
    const customer = await Customer.create({branch: world.branchA._id, name: 'Asha', phone: '9801111111'});
    const created = await createLinkedOrder(world.table, {body: {customer: String(customer._id)}});
    assert.equal(created.status, 201, created.body?.message);
    const paid = await request('/api/orders/' + created.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {amount: 100, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    const beforeTx = await InventoryTransaction.countDocuments();

    const res = await move(world.table, table2);
    assert.equal(res.status, 200, res.body?.message);
    const order = await Order.findById(created.body._id);
    assert.equal(String(order.table), String(table2._id));
    assert.equal(order.status, 'pending');
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].name, 'Chicken Biryani');
    assert.equal(order.paidAmount, 100);
    assert.equal(String(order.customer), String(customer._id));
    assert.equal(order.inventoryDeducted, true);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
    assert.equal((await RestaurantTable.findById(table2._id)).status, 'occupied');
    assert.equal(await InventoryTransaction.countDocuments(), beforeTx);
    assert.equal(await Payment.countDocuments({order: order._id}), 1);

    const listed = await request('/api/tables?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    const t1 = listed.body.find(t => t.name === 'T1');
    const t2 = listed.body.find(t => t.name === 'T2');
    assert.equal(t1.currentOrder, null);
    assert.equal(t2.currentOrder.orderNo, created.body.orderNo);
  });

  it('writes a table_move audit record', async () => {
    const created = await createLinkedOrder();
    assert.equal(created.status, 201, created.body?.message);
    const res = await move(world.table, table2, world.manager);
    assert.equal(res.status, 200, res.body?.message);
    const logs = await Audit.find({entity: 'order', entityId: created.body._id, action: 'table_move'});
    assert.equal(logs.length, 1);
    assert.equal(String(logs[0].before.table), String(world.table._id));
    assert.equal(String(logs[0].after.table), String(table2._id));
  });

  it('rejects same table, occupied destination, other branch, and missing order', async () => {
    const created = await createLinkedOrder(world.table);
    assert.equal(created.status, 201, created.body?.message);
    const other = await createLinkedOrder(table2);
    assert.equal(other.status, 201, other.body?.message);
    assert.equal((await move(world.table, world.table)).status, 409);
    assert.equal((await move(world.table, table2)).status, 409);
    assert.equal((await move(world.table, world.tableB)).status, 409);
    await RestaurantTable.findByIdAndUpdate(table2._id, {status: 'available'});
    await Order.findByIdAndUpdate(other.body._id, {status: 'cancelled', inventoryReversed: true});
    await RestaurantTable.findByIdAndUpdate(world.tableB._id, {status: 'disabled', active: false});
    const empty = await RestaurantTable.create({branch: world.branchA._id, name: 'T8', area: 'Garden', seats: 2});
    assert.equal((await move(empty, table2)).status, 409);
  });

  it('rejects missing token, guest role, and cross-branch staff', async () => {
    const created = await createLinkedOrder();
    assert.equal(created.status, 201, created.body?.message);
    assert.equal((await request('/api/tables/' + world.table._id + '/move', {method: 'POST', body: {toTable: String(table2._id)}})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request('/api/tables/' + world.table._id + '/move', {method: 'POST', token: guest, body: {toTable: String(table2._id)}})).status, 403);
    assert.equal((await move(world.table, table2, world.staffB)).status, 403);
  });
});

describe('POST /api/tables/:id/merge', () => {
  it('merges items, payments and customer onto the destination order without extra stock movement', async () => {
    const guest = await Customer.create({branch: world.branchA._id, name: 'Bikash', phone: '9802222222'});
    const keeper = await Customer.create({branch: world.branchA._id, name: 'Asha', phone: '9803333333'});
    const source = await createLinkedOrder(world.table, {body: {customer: String(guest._id)}, notes: 'no onion'});
    const dest = await createLinkedOrder(table2, {body: {customer: String(keeper._id)}, notes: 'less spicy'});
    assert.equal(source.status, 201, source.body?.message);
    assert.equal(dest.status, 201, dest.body?.message);
    const paid = await request('/api/orders/' + source.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {amount: 50, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    const beforeTx = await InventoryTransaction.countDocuments();
    const deducted = await InventoryTransaction.countDocuments({type: 'RECIPE_DEDUCTION'});

    const res = await merge(world.table, table2);
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(await InventoryTransaction.countDocuments(), beforeTx);
    assert.equal(await InventoryTransaction.countDocuments({type: 'REVERSAL'}), 0);

    const surviving = await Order.findById(dest.body._id);
    const closed = await Order.findById(source.body._id);
    assert.equal(surviving.items.length, 1);
    assert.equal(surviving.items[0].qty, 2);
    assert.equal(String(surviving.customer), String(keeper._id));
    assert.equal(surviving.paidAmount, 50);
    assert.ok(surviving.total > dest.body.total);
    assert.equal(Number(surviving.dueAmount.toFixed(2)), Number((surviving.total - 50).toFixed(2)));
    assert.equal(surviving.inventoryDeducted, true);
    assert.equal(surviving.inventorySourceOrders.length, 2);
    assert.deepEqual(
      surviving.inventorySourceOrders.map(String).sort(),
      [source.body._id, dest.body._id].map(String).sort()
    );
    assert.equal(surviving.status, 'pending');
    assert.equal(closed.status, 'cancelled');
    assert.equal(closed.inventoryReversed, true);
    assert.equal(await Payment.countDocuments({order: surviving._id}), 1);
    assert.equal(await Payment.countDocuments({order: closed._id}), 0);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
    assert.equal((await RestaurantTable.findById(table2._id)).status, 'occupied');
    assert.equal(deducted, 2);

    const logs = await Audit.find({action: 'table_merge'});
    assert.ok(logs.length >= 2);
  });

  it('lets a later destination cancel reverse the combined recipe once', async () => {
    const source = await createLinkedOrder(world.table);
    const dest = await createLinkedOrder(table2);
    assert.equal(source.status, 201, source.body?.message);
    assert.equal(dest.status, 201, dest.body?.message);
    const merged = await merge(world.table, table2, world.manager);
    assert.equal(merged.status, 200, merged.body?.message);
    const before = await InventoryTransaction.countDocuments();
    const cancelled = await request('/api/orders/' + dest.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, cancelled.body?.message);
    assert.equal(await InventoryTransaction.countDocuments({type: 'REVERSAL'}), 1);
    assert.equal(await InventoryTransaction.countDocuments(), before + 1);
    const reversal = await InventoryTransaction.findOne({type: 'REVERSAL', referenceId: dest.body._id});
    assert.equal(reversal.changeQty, 500);
  });

  it('rejects same table, empty destination, and other-branch merge', async () => {
    const source = await createLinkedOrder(world.table);
    assert.equal(source.status, 201, source.body?.message);
    assert.equal((await merge(world.table, world.table)).status, 409);
    assert.equal((await merge(world.table, table2)).status, 409);
    assert.equal((await merge(world.table, world.tableB)).status, 409);
  });

  it('rejects missing token and unauthorized roles', async () => {
    const source = await createLinkedOrder(world.table);
    const dest = await createLinkedOrder(table2);
    assert.equal(source.status, 201, source.body?.message);
    assert.equal(dest.status, 201, dest.body?.message);
    assert.equal((await request('/api/tables/' + world.table._id + '/merge', {method: 'POST', body: {intoTable: String(table2._id)}})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request('/api/tables/' + world.table._id + '/merge', {method: 'POST', token: guest, body: {intoTable: String(table2._id)}})).status, 403);
    assert.equal((await merge(world.table, table2, world.staffB)).status, 403);
  });
});
