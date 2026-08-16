import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Order, InventoryTransaction, InventoryBalance} from '../src/models/operations.js';
import {Audit} from '../src/models/index.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, makeOrder, tokenFor} from './helpers.js';

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

describe('GET /api/kitchen/orders', () => {
  it('returns only the requested branch queue', async () => {
    const local = await makeOrder(world, {orderNo: 'ORD-A1', branch: world.branchA._id});
    await makeOrder(world, {orderNo: 'ORD-B1', branch: world.branchB._id, table: undefined});
    await makeOrder(world, {orderNo: 'ORD-DONE', branch: world.branchA._id, status: 'completed'});
    const res = await request('/api/kitchen/orders?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].orderNo, 'ORD-A1');
    assert.equal(String(res.body[0]._id), String(local._id));
    assert.equal(res.body[0].table?.name, 'T1');
  });

  it('does not expose another branch’s orders', async () => {
    await makeOrder(world, {orderNo: 'ORD-A1', branch: world.branchA._id});
    await makeOrder(world, {orderNo: 'ORD-B1', branch: world.branchB._id, table: undefined});
    const res = await request('/api/kitchen/orders?branch=' + world.branchB._id, {token: tokenFor(world.owner)});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map(o => o.orderNo), ['ORD-B1']);
  });

  it('rejects missing and invalid tokens', async () => {
    const missing = await request('/api/kitchen/orders?branch=' + world.branchA._id);
    assert.equal(missing.status, 401);
    const invalid = await request('/api/kitchen/orders?branch=' + world.branchA._id, {token: 'not-a-jwt'});
    assert.equal(invalid.status, 401);
  });

  it('rejects unauthorized roles and cross-branch staff', async () => {
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    const forbiddenRole = await request('/api/kitchen/orders?branch=' + world.branchA._id, {token: guest});
    assert.equal(forbiddenRole.status, 403);

    const cross = await request('/api/kitchen/orders?branch=' + world.branchB._id, {token: tokenFor(world.staffA)});
    assert.equal(cross.status, 403);

    const missingBranch = await request('/api/kitchen/orders', {token: tokenFor(world.owner)});
    assert.equal(missingBranch.status, 400);
  });
});

describe('PATCH /api/orders/:id/status kitchen flow', () => {
  async function patch(order, status, user = world.staffA) {
    return request('/api/orders/' + order._id + '/status', {method: 'PATCH', token: tokenFor(user), body: {status}});
  }

  it('pending -> accepted and persists in MongoDB', async () => {
    const order = await makeOrder(world);
    const res = await patch(order, 'accepted');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'accepted');
    const saved = await Order.findById(order._id);
    assert.equal(saved.status, 'accepted');
  });

  it('accepted -> preparing and persists in MongoDB', async () => {
    const order = await makeOrder(world, {status: 'accepted'});
    const res = await patch(order, 'preparing');
    assert.equal(res.status, 200);
    assert.equal((await Order.findById(order._id)).status, 'preparing');
  });

  it('preparing -> ready and persists in MongoDB', async () => {
    const order = await makeOrder(world, {status: 'preparing'});
    const res = await patch(order, 'ready');
    assert.equal(res.status, 200);
    assert.equal((await Order.findById(order._id)).status, 'ready');
  });

  it('ready -> completed and persists in MongoDB', async () => {
    const order = await makeOrder(world, {status: 'ready'});
    const res = await patch(order, 'completed');
    assert.equal(res.status, 200);
    assert.equal((await Order.findById(order._id)).status, 'completed');
  });

  it('pending -> cancelled and persists in MongoDB', async () => {
    const order = await makeOrder(world);
    const res = await patch(order, 'cancelled', world.manager);
    assert.equal(res.status, 200);
    assert.equal((await Order.findById(order._id)).status, 'cancelled');
  });

  it('rejects invalid transitions with 409', async () => {
    const completed = await makeOrder(world, {status: 'completed'});
    const ready = await makeOrder(world, {status: 'ready'});
    const cancelled = await makeOrder(world, {status: 'cancelled'});
    const pending = await makeOrder(world, {status: 'pending'});
    assert.equal((await patch(completed, 'preparing')).status, 409);
    assert.equal((await patch(ready, 'accepted')).status, 409);
    assert.equal((await patch(cancelled, 'preparing')).status, 409);
    assert.equal((await patch(pending, 'completed')).status, 409);
    assert.equal((await Order.findById(completed._id)).status, 'completed');
    assert.equal((await Order.findById(ready._id)).status, 'ready');
    assert.equal((await Order.findById(cancelled._id)).status, 'cancelled');
  });

  it('does not increase InventoryTransaction count on KDS status updates', async () => {
    const order = await makeOrder(world);
    const before = await InventoryTransaction.countDocuments();
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      const res = await patch(order, status);
      assert.equal(res.status, 200, status);
    }
    assert.equal(await InventoryTransaction.countDocuments(), before);
  });

  it('leaves inventoryDeducted unchanged after KDS status updates', async () => {
    const order = await makeOrder(world, {inventoryDeducted: true});
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      const res = await patch(order, status);
      assert.equal(res.status, 200);
    }
    const saved = await Order.findById(order._id);
    assert.equal(saved.inventoryDeducted, true);
    assert.equal(saved.inventoryReversed, false);
  });

  it('writes an audit record for kitchen status changes', async () => {
    const order = await makeOrder(world);
    await patch(order, 'accepted');
    const logs = await Audit.find({entity: 'order', entityId: order._id, action: 'kitchen_status'});
    assert.equal(logs.length, 1);
    assert.equal(logs[0].before.status, 'pending');
    assert.equal(logs[0].after.status, 'accepted');
  });

  it('blocks staff from updating another branch order', async () => {
    const order = await makeOrder(world, {branch: world.branchB._id, table: undefined});
    const res = await patch(order, 'accepted', world.staffA);
    assert.equal(res.status, 403);
    assert.equal((await Order.findById(order._id)).status, 'pending');
  });
});

describe('order cancellation inventory reversal', () => {
  it('reverses recipe stock once when a deducted order is cancelled', async () => {
    const created = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(world.branchA._id),
        type: 'dine-in',
        table: String(world.table._id),
        items: [{menuItem: String(world.menu._id), qty: 2, notes: 'no onion'}]
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.inventoryDeducted, true);
    const deducted = await InventoryTransaction.countDocuments({type: 'RECIPE_DEDUCTION', referenceId: created.body._id});
    assert.ok(deducted >= 1);
    const beforeCancel = await InventoryTransaction.countDocuments();
    const balanceBefore = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});

    const cancelled = await request('/api/orders/' + created.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, cancelled.body?.message);
    const saved = await Order.findById(created.body._id);
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.inventoryDeducted, true);
    assert.equal(saved.inventoryReversed, true);
    assert.equal(await InventoryTransaction.countDocuments(), beforeCancel + deducted);
    assert.equal(await InventoryTransaction.countDocuments({type: 'REVERSAL', referenceId: created.body._id}), deducted);

    const again = await request('/api/orders/' + created.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(again.status, 409);
    assert.equal(await InventoryTransaction.countDocuments({type: 'REVERSAL', referenceId: created.body._id}), deducted);

    const balanceAfter = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(balanceAfter.quantity, balanceBefore.quantity + 500);
  });
});
