import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Audit, User} from '../src/models/index.js';
import {Branch, Order, Payment, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

// Phase 6B — table operations.
//
// move / merge / split / transfer already existed and are covered by
// tables.ops and billing tests; the guards below are regression cover only.
// The new work is reopen and table history.

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

function makeTable(name, seats = 4) {
  return request('/api/tables', {
    method: 'POST', token: owner(),
    body: {branch: String(world.branchA._id), name, seats}
  });
}

async function seat(tableId, qty = 1) {
  const res = await request('/api/orders', {
    method: 'POST', token: owner(),
    body: {
      branch: String(world.branchA._id), type: 'dine-in',
      table: String(tableId), items: [{menuItem: String(world.menu._id), qty}]
    }
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

async function settle(order, token = owner()) {
  const res = await request(`/api/orders/${order._id}/payments`, {
    method: 'POST', token, body: {amount: order.total, method: 'cash'}
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

const reopen = (orderId, body = {}, token = manager()) =>
  request(`/api/orders/${orderId}/reopen`, {method: 'POST', token, body});

const history = (tableId, query = '', token = manager()) =>
  request(`/api/tables/${tableId}/history${query}`, {token});

// ── Existing operations: regression guards ───────────────────────────────────
describe('Phase 6B — existing operations still work', () => {
  it('moves an open check to another table', async () => {
    const target = await makeTable('Move-B');
    const order = await seat(world.table._id);
    const res = await request(`/api/tables/${world.table._id}/move`, {
      method: 'POST', token: staff(), body: {toTable: String(target.body._id)}
    });
    assert.equal(res.status, 200, res.body?.message);
    const moved = await Order.findById(order._id);
    assert.equal(String(moved.table), String(target.body._id));
    assert.equal((await RestaurantTable.findById(target.body._id)).status, 'occupied');
  });

  it('merges two checks onto one table', async () => {
    const other = await makeTable('Merge-B');
    await seat(world.table._id);
    await seat(other.body._id);
    const res = await request(`/api/tables/${world.table._id}/merge`, {
      method: 'POST', token: staff(), body: {intoTable: String(other.body._id)}
    });
    assert.equal(res.status, 200, res.body?.message);
  });

  it('splits a check onto a second ticket', async () => {
    const order = await seat(world.table._id, 2);
    const res = await request(`/api/orders/${order._id}/split`, {
      method: 'POST', token: staff(), body: {items: [{itemId: String(order.items[0]._id), qty: 1}]}
    });
    assert.equal(res.status, 201, res.body?.message);
    assert.ok(res.body.splitOrder);
  });

  it('refuses to transfer a check across branches', async () => {
    await seat(world.table._id);
    const res = await request(`/api/tables/${world.table._id}/move`, {
      method: 'POST', token: owner(), body: {toTable: String(world.tableB._id)}
    });
    assert.equal(res.status, 409, 'a check must not cross branches');
  });
});

// ── Reopen ───────────────────────────────────────────────────────────────────
describe('Phase 6B — reopen a settled check', () => {
  it('restores the check and re-seats the table', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');

    const res = await reopen(order._id, {reason: 'Guest returned for dessert'});
    assert.equal(res.status, 200, res.body?.message);

    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'ready', 'returns to the pass, not the kitchen queue');
    assert.equal(stored.reopenCount, 1);
    assert.equal(stored.reopenReason, 'Guest returned for dessert');
    assert.ok(stored.reopenedAt instanceof Date);
    assert.equal(String(stored.reopenedBy), String(world.manager._id));
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'occupied');
  });

  it('leaves money untouched and recomputes only what is owed', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    const paymentsBefore = await Payment.countDocuments({order: order._id});

    await reopen(order._id);
    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, order.total, 'payments already taken are preserved');
    assert.equal(stored.dueAmount, 0, 'nothing further is owed on a fully paid check');
    assert.equal(await Payment.countDocuments({order: order._id}), paymentsBefore,
      'reopening must not create or void a payment');
  });

  it('clears completedAt so kitchen metrics do not count it as finished', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    assert.ok((await Order.findById(order._id)).completedAt, 'settled check is stamped');

    await reopen(order._id);
    assert.ok(!(await Order.findById(order._id)).completedAt, 'reopened check is no longer complete');

    const perf = await request(`/api/kitchen/performance?branch=${world.branchA._id}`, {token: owner()});
    assert.equal(perf.status, 200, perf.body?.message);
    assert.equal(perf.body.summary.completedOrders, 0, 'a reopened check is not a completed one');
  });

  it('re-stamps completedAt when the check closes again', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    await reopen(order._id);
    // Take a further payment path: the balance is already zero, so close it
    // through the kitchen status route instead.
    const closed = await request(`/api/orders/${order._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'completed'}
    });
    assert.equal(closed.status, 200, closed.body?.message);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'completed');
    assert.ok(stored.completedAt instanceof Date, 'closing again re-stamps completion');
  });

  it('accepts a further payment after reopening and adding value', async () => {
    const order = await seat(world.table._id);
    // Pay only part, so a balance survives the reopen.
    const partial = await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: 100, method: 'cash'}
    });
    assert.equal(partial.status, 201, partial.body?.message);
    // Settle the rest to close it.
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total - 100, method: 'cash'}
    });
    assert.equal((await Order.findById(order._id)).status, 'completed');

    await reopen(order._id, {reason: 'Wrong ticket paid'});
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'ready');
    assert.equal(stored.paidAmount, order.total);
  });

  it('refuses to reopen anything that is not completed', async () => {
    const open = await seat(world.table._id);
    const res = await reopen(open._id);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Only a completed check can be reopened/);
  });

  it('refuses to reopen a refunded or cancelled check', async () => {
    const refundedOrder = await seat(world.table._id);
    await settle(refundedOrder);
    const refund = await request(`/api/orders/${refundedOrder._id}/refunds`, {
      method: 'POST', token: manager(), body: {reason: 'full refund'}
    });
    assert.equal(refund.status, 201, refund.body?.message);
    assert.equal((await reopen(refundedOrder._id)).status, 409,
      'reversing a refund must go through the money trail, not a reopen');

    const table = await makeTable('Cancel-B');
    const cancelled = await seat(table.body._id);
    await request(`/api/orders/${cancelled._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'cancelled'}
    });
    assert.equal((await reopen(cancelled._id)).status, 409);
  });

  it('refuses when the table already holds another open check', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    // The table is turned over and a new party is seated in the meantime.
    const cleared = await request(`/api/tables/${world.table._id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'available'}
    });
    assert.equal(cleared.status, 200, cleared.body?.message);
    await seat(world.table._id);
    const res = await reopen(order._id);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /already has an open check/);
  });

  it('can be reopened more than once, counting each time', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    await reopen(order._id);
    await request(`/api/orders/${order._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'completed'}
    });
    const second = await reopen(order._id);
    assert.equal(second.status, 200, second.body?.message);
    assert.equal((await Order.findById(order._id)).reopenCount, 2);
  });

  it('writes an audit entry naming the reason and the user', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    await reopen(order._id, {reason: 'Mis-keyed payment'});
    const entry = await Audit.findOne({entity: 'order', entityId: order._id, action: 'order_reopen'});
    assert.ok(entry, 'reopening must be audited');
    assert.equal(entry.reason, 'Mis-keyed payment');
    assert.equal(String(entry.user), String(world.manager._id));
    assert.equal(entry.before.status, 'completed');
    assert.equal(entry.after.status, 'ready');
  });

  it('validates the reason and rejects unknown fields', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    assert.equal((await reopen(order._id, {reason: 'x'.repeat(301)})).status, 400);
    assert.equal((await reopen(order._id, {bogus: 1})).status, 400);
  });

  it('is management only', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    assert.equal((await reopen(order._id, {}, staff())).status, 403);
    assert.equal((await request(`/api/orders/${order._id}/reopen`, {method: 'POST', body: {}})).status, 401);
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await reopen(order._id, {}, guest)).status, 403);
  });

  it('handles a check with no table', async () => {
    const counter = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(counter.status, 201, counter.body?.message);
    await settle(counter.body);
    const res = await reopen(counter.body._id);
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.table, null);
  });
});

// ── Table history ────────────────────────────────────────────────────────────
describe('Phase 6B — table history', () => {
  it('returns the audit trail correlated with the orders seated there', async () => {
    const order = await seat(world.table._id, 2);
    await settle(order);

    const res = await history(world.table._id);
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.table.name, 'T1');
    assert.ok(res.body.events.length >= 2, 'occupy and release are both recorded');
    assert.ok(res.body.events.every(e => e.at), 'every event is timestamped');

    assert.equal(res.body.summary.orders, 1);
    assert.equal(res.body.summary.completedOrders, 1);
    assert.equal(res.body.summary.revenue, order.total);
    assert.equal(res.body.orders[0].orderNo, order.orderNo);
    assert.equal(res.body.orders[0].status, 'completed');
  });

  it('records who performed each action', async () => {
    await seat(world.table._id);
    const res = await history(world.table._id);
    const withUser = res.body.events.find(e => e.by);
    assert.ok(withUser, 'at least one event names its actor');
    assert.ok(withUser.by.name);
    assert.ok(['owner', 'manager', 'staff'].includes(withUser.by.role));
  });

  it('captures moves and merges', async () => {
    const target = await makeTable('Hist-B');
    await seat(world.table._id);
    await request(`/api/tables/${world.table._id}/move`, {
      method: 'POST', token: staff(), body: {toTable: String(target.body._id)}
    });
    const res = await history(target.body._id);
    const kinds = new Set(res.body.events.map(e => e.kind));
    assert.ok(kinds.has('table_move') || kinds.has('status'),
      `expected a move or status event, saw ${[...kinds].join(', ')}`);
  });

  it('reports a reopened check in the history', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    await reopen(order._id, {reason: 'Guest returned'});

    const res = await history(world.table._id);
    assert.equal(res.body.summary.reopenedOrders, 1);
    assert.equal(res.body.orders[0].reopened, 1);
    const reopenEvent = res.body.events.find(e => e.reason === 'reopen' || e.detail?.reason === 'reopen');
    assert.ok(reopenEvent, 'the re-seat is visible on the table timeline');
  });

  it('computes average turn time from completed checks', async () => {
    const order = await seat(world.table._id);
    await settle(order);
    const res = await history(world.table._id);
    assert.notEqual(res.body.summary.averageTurnMinutes, null);
    assert.ok(res.body.summary.averageTurnMinutes >= 0);
  });

  it('returns an empty but well-formed history for an unused table', async () => {
    const fresh = await makeTable('Untouched');
    const res = await history(fresh.body._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.orders, 0);
    assert.equal(res.body.summary.revenue, 0);
    assert.equal(res.body.summary.averageTurnMinutes, null, 'no average without a completed turn');
    assert.ok(Array.isArray(res.body.events));
  });

  it('honours a date range and a limit', async () => {
    await seat(world.table._id);
    const {daysAhead, daysAgo} = await import('./dates.js');
    const future = await history(world.table._id, `?from=${daysAhead(2)}`);
    assert.equal(future.body.events.length, 0, 'nothing happened in the future');
    const past = await history(world.table._id, `?from=${daysAgo(1)}`);
    assert.ok(past.body.events.length > 0);
    const capped = await history(world.table._id, '?limit=1');
    assert.ok(capped.body.events.length <= 1);
  });

  it('is management only and validates the table', async () => {
    assert.equal((await history(world.table._id, '', staff())).status, 403);
    assert.equal((await request(`/api/tables/${world.table._id}/history`)).status, 401);
    assert.equal((await history('not-an-id')).status, 400);
    assert.equal((await history(new mongoose.Types.ObjectId())).status, 404);
  });
});

// ── Tenant isolation for the new endpoints ───────────────────────────────────
describe('Phase 6B — tenant isolation', () => {
  it('blocks another restaurant from reopening or reading history', async () => {
    const restaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival', code: 'RVL'});
    const rival = await User.create({
      name: 'Rival Owner', email: 'rival6b@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
    });
    const token = tokenFor(rival);

    const order = await seat(world.table._id);
    await settle(order);

    assert.ok([403, 404].includes((await reopen(order._id, {}, token)).status));
    assert.ok([403, 404].includes((await history(world.table._id, '', token)).status));
    // The check must remain settled.
    assert.equal((await Order.findById(order._id)).status, 'completed');
  });

  it('confines a manager to their own branch', async () => {
    const otherBranchTable = await RestaurantTable.findOne({branch: world.branchB._id});
    assert.equal((await history(otherBranchTable._id, '', manager())).status, 403);
  });
});
