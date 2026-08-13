import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {RestaurantTable, InventoryTransaction} from '../src/models/operations.js';
import {Audit} from '../src/models/index.js';
import {canTransitionTable, assertTableTransition, TABLE_STATUSES} from '../src/services/tables.js';
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

function listTables(user, branch = world.branchA) {
  return request('/api/tables?branch=' + branch._id, {token: tokenFor(user)});
}

function setStatus(table, status, user = world.staffA) {
  return request('/api/tables/' + table._id + '/status', {method: 'PATCH', token: tokenFor(user), body: {status}});
}

async function createLinkedOrder(table = world.table, branch = world.branchA) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(branch._id),
      type: 'dine-in',
      table: String(table._id),
      items: [{menuItem: String(world.menu._id), qty: 1, notes: 'table ticket'}]
    }
  });
}

describe('table transition matrix', () => {
  it('allows the floor happy path and out-of-service loop', () => {
    assert.equal(canTransitionTable('available', 'occupied'), true);
    assert.equal(canTransitionTable('available', 'reserved'), true);
    assert.equal(canTransitionTable('reserved', 'occupied'), true);
    assert.equal(canTransitionTable('occupied', 'cleaning'), true);
    assert.equal(canTransitionTable('cleaning', 'available'), true);
    assert.equal(canTransitionTable('available', 'disabled'), true);
    assert.equal(canTransitionTable('disabled', 'available'), true);
  });

  it('rejects illegal table moves', () => {
    assert.equal(canTransitionTable('disabled', 'occupied'), false);
    assert.equal(canTransitionTable('occupied', 'reserved'), false);
    assert.equal(canTransitionTable('cleaning', 'occupied'), false);
    assert.equal(canTransitionTable('reserved', 'cleaning'), false);
    assert.throws(() => assertTableTransition('disabled', 'occupied'), e => e.status === 409);
    assert.throws(() => assertTableTransition('available', 'disabled', {role: 'staff'}), e => e.status === 403);
  });

  it('keeps the documented status set', () => {
    assert.deepEqual(TABLE_STATUSES, ['available', 'occupied', 'reserved', 'cleaning', 'disabled']);
  });
});

describe('GET /api/tables', () => {
  it('returns only the requested branch and attaches the open order', async () => {
    const created = await createLinkedOrder();
    assert.equal(created.status, 201, created.body?.message);
    const res = await listTables(world.owner);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map(t => t.name).sort(), ['T1']);
    const t1 = res.body.find(t => t.name === 'T1');
    assert.equal(t1.status, 'occupied');
    assert.equal(t1.currentOrder.orderNo, created.body.orderNo);
    const other = await listTables(world.owner, world.branchB);
    assert.deepEqual(other.body.map(t => t.name), ['L1']);
    assert.equal(other.body[0].currentOrder, null);
  });

  it('rejects missing token, guest role, and cross-branch staff', async () => {
    assert.equal((await request('/api/tables?branch=' + world.branchA._id)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/tables?branch=' + world.branchA._id, {token: guest})).status, 403);
    assert.equal((await listTables(world.staffA, world.branchB)).status, 403);
    assert.equal((await request('/api/tables', {token: tokenFor(world.owner)})).status, 400);
  });
});

describe('table status API', () => {
  it('persists available -> reserved -> occupied -> cleaning -> available', async () => {
    for (const status of ['reserved', 'occupied', 'cleaning', 'available']) {
      const res = await setStatus(world.table, status);
      assert.equal(res.status, 200, res.body?.message);
      assert.equal((await RestaurantTable.findById(world.table._id)).status, status);
    }
  });

  it('rejects invalid transitions with 409', async () => {
    await RestaurantTable.findByIdAndUpdate(world.table._id, {status: 'disabled', active: false});
    assert.equal((await setStatus(world.table, 'occupied', world.manager)).status, 409);
    await RestaurantTable.findByIdAndUpdate(world.table._id, {status: 'occupied', active: true});
    assert.equal((await setStatus(world.table, 'reserved')).status, 409);
    await RestaurantTable.findByIdAndUpdate(world.table._id, {status: 'cleaning'});
    assert.equal((await setStatus(world.table, 'occupied')).status, 409);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
  });

  it('blocks staff from enabling or disabling a table', async () => {
    assert.equal((await setStatus(world.table, 'disabled', world.staffA)).status, 403);
    await RestaurantTable.findByIdAndUpdate(world.table._id, {status: 'disabled', active: false});
    assert.equal((await setStatus(world.table, 'available', world.staffA)).status, 403);
    const ok = await setStatus(world.table, 'available', world.manager);
    assert.equal(ok.status, 200, ok.body?.message);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'available');
  });

  it('writes an audit record for table status changes', async () => {
    const res = await setStatus(world.table, 'reserved', world.manager);
    assert.equal(res.status, 200);
    const logs = await Audit.find({entity: 'table', entityId: world.table._id, action: 'status'});
    assert.equal(logs.length, 1);
    assert.equal(logs[0].before.status, 'available');
    assert.equal(logs[0].after.status, 'reserved');
  });
});

describe('tables connected to orders', () => {
  it('occupies a table when an order is created against it', async () => {
    const created = await createLinkedOrder();
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(String(created.body.table), String(world.table._id));
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'occupied');
  });

  it('rejects seating a disabled table or a table from another branch', async () => {
    await RestaurantTable.findByIdAndUpdate(world.table._id, {status: 'disabled', active: false});
    assert.equal((await createLinkedOrder()).status, 409);
    const cross = await createLinkedOrder(world.tableB, world.branchA);
    assert.equal(cross.status, 409);
  });

  it('rejects a second open order on the same table', async () => {
    const first = await createLinkedOrder();
    assert.equal(first.status, 201, first.body?.message);
    const second = await createLinkedOrder();
    assert.equal(second.status, 409);
    assert.match(second.body.message, /occupied|already has an open order/i);
  });

  it('moves the table to cleaning when the order is completed or cancelled', async () => {
    const created = await createLinkedOrder();
    assert.equal(created.status, 201, created.body?.message);
    const cancelled = await request('/api/orders/' + created.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, cancelled.body?.message);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');

    await RestaurantTable.findByIdAndUpdate(world.table._id, {status: 'available', active: true});
    const paid = await createLinkedOrder();
    assert.equal(paid.status, 201, paid.body?.message);
    const payment = await request('/api/orders/' + paid.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {amount: paid.body.total, method: 'cash'}
    });
    assert.equal(payment.status, 201, payment.body?.message);
    assert.equal(payment.body.order.status, 'completed');
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
  });

  it('does not create inventory ledger rows for table status changes', async () => {
    const before = await InventoryTransaction.countDocuments();
    assert.equal((await setStatus(world.table, 'reserved')).status, 200);
    assert.equal((await setStatus(world.table, 'occupied')).status, 200);
    assert.equal((await setStatus(world.table, 'cleaning')).status, 200);
    assert.equal(await InventoryTransaction.countDocuments(), before);
  });

  it('lets owner/manager create a table and forbids staff', async () => {
    const created = await request('/api/tables', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), name: 'T9', area: 'Garden', seats: 2}
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.name, 'T9');
    const forbidden = await request('/api/tables', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {branch: String(world.branchA._id), name: 'T8', area: 'Garden', seats: 2}
    });
    assert.equal(forbidden.status, 403);
  });
});
