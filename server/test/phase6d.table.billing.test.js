import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {User} from '../src/models/index.js';
import {Branch, Order, Payment, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {equalShares, money} from '../src/services/billing.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

// Phase 6D — table billing.
//
// split bill / item share / partial payment / multiple methods / settlement
// already existed and are guarded below as regressions. The new work is the
// equal split (with exact paisa reconciliation) and the table bill view.

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

/** A dine-in check on the seeded table. qty 4 => total 1740.20. */
async function seat(qty = 4, tableId = world.table._id) {
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

const pay = (orderId, body, token = staff()) =>
  request(`/api/orders/${orderId}/payments`, {method: 'POST', token, body});

const splitEqual = (orderId, ways, token = staff()) =>
  request(`/api/orders/${orderId}/split-equal`, {method: 'POST', token, body: {ways}});

const tableBill = (tableId, token = staff()) =>
  request(`/api/tables/${tableId}/bill`, {token});

// ── Equal split arithmetic ───────────────────────────────────────────────────
describe('Phase 6D — equal split arithmetic', () => {
  it('divides evenly when the amount allows', () => {
    assert.deepEqual(equalShares(100, 4), [25, 25, 25, 25]);
    assert.deepEqual(equalShares(10, 2), [5, 5]);
  });

  it('reconciles to the paisa when it does not divide evenly', () => {
    // 1740.20 / 3 = 580.0666... Three shares of 580.07 would collect 1740.21.
    const shares = equalShares(1740.2, 3);
    assert.deepEqual(shares, [580.07, 580.07, 580.06]);
    assert.equal(money(shares.reduce((a, b) => a + b, 0)), 1740.2, 'must sum back exactly');
  });

  it('never loses or invents a paisa across many divisors', () => {
    for (const total of [100, 1740.2, 0.05, 33.33, 999.99, 1, 12345.67]) {
      for (let ways = 2; ways <= 12; ways += 1) {
        const shares = equalShares(total, ways);
        assert.equal(shares.length, ways);
        assert.equal(money(shares.reduce((a, b) => a + b, 0)), money(total),
          `${total} split ${ways} ways did not reconcile`);
        // The spread between the largest and smallest share is at most 1 paisa.
        assert.ok(Math.max(...shares) - Math.min(...shares) <= 0.01 + 1e-9);
      }
    }
  });

  it('gives the extra paisa to the earliest shares', () => {
    assert.deepEqual(equalShares(100, 3), [33.34, 33.33, 33.33]);
    assert.deepEqual(equalShares(0.05, 3), [0.02, 0.02, 0.01]);
  });

  it('rejects impossible divisions', () => {
    assert.throws(() => equalShares(100, 1), /between 2 and 50/);
    assert.throws(() => equalShares(100, 0), /between 2 and 50/);
    assert.throws(() => equalShares(100, 2.5), /between 2 and 50/);
    assert.throws(() => equalShares(100, 51), /between 2 and 50/);
    assert.throws(() => equalShares(0, 2), /Nothing left to split/);
  });
});

// ── Equal split over the API ─────────────────────────────────────────────────
describe('Phase 6D — equal split', () => {
  it('quotes an n-way split of the outstanding balance', async () => {
    const order = await seat(4);
    const res = await splitEqual(order._id, 3);
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.due, 1740.2);
    assert.equal(res.body.ways, 3);
    assert.deepEqual(res.body.shares, [580.07, 580.07, 580.06]);
    assert.equal(res.body.sharesTotal, 1740.2, 'the quote proves it reconciles');
    assert.equal(res.body.orderNo, order.orderNo);
  });

  it('is a quote only — it takes no money and closes nothing', async () => {
    const order = await seat(4);
    await splitEqual(order._id, 3);
    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, 0, 'quoting must not collect');
    assert.equal(stored.status, 'pending');
    assert.equal(await Payment.countDocuments({order: order._id}), 0);
  });

  it('settles exactly when every share is paid', async () => {
    const order = await seat(4);
    const quote = await splitEqual(order._id, 3);
    for (const share of quote.body.shares) {
      const res = await pay(order._id, {amount: share, method: 'cash'});
      assert.equal(res.status, 201, res.body?.message);
    }
    const stored = await Order.findById(order._id);
    assert.equal(stored.dueAmount, 0, 'no paisa left owing');
    assert.equal(stored.paidAmount, 1740.2);
    assert.equal(stored.status, 'completed');
  });

  it('divides only the remainder after a partial payment', async () => {
    const order = await seat(4);
    assert.equal((await pay(order._id, {amount: 740.2, method: 'cash'})).status, 201);
    const res = await splitEqual(order._id, 2);
    assert.equal(res.body.due, 1000);
    assert.deepEqual(res.body.shares, [500, 500]);
    assert.equal(res.body.paid, 740.2);
  });

  it('lets each guest pay their share with a different method', async () => {
    const order = await seat(4);
    const quote = await splitEqual(order._id, 3);
    const methods = ['cash', 'card', 'esewa'];
    for (const [i, share] of quote.body.shares.entries()) {
      assert.equal((await pay(order._id, {amount: share, method: methods[i]})).status, 201);
    }
    const summary = await request(`/api/orders/${order._id}/payment-summary`, {token: owner()});
    assert.equal(summary.body.due, 0);
    assert.equal(summary.body.byMethod.cash, 580.07);
    assert.equal(summary.body.byMethod.card, 580.07);
    assert.equal(summary.body.byMethod.esewa, 580.06);
  });

  it('refuses to split a settled, cancelled or refunded check', async () => {
    const settled = await seat(1);
    await pay(settled._id, {amount: settled.total, method: 'cash'});
    assert.equal((await splitEqual(settled._id, 2)).status, 409);

    // The settled check left the table in 'cleaning'; turn it over first.
    const cleared = await request(`/api/tables/${world.table._id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'available'}
    });
    assert.equal(cleared.status, 200, cleared.body?.message);
    const cancelled = await seat(1, world.table._id);
    await request(`/api/orders/${cancelled._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'cancelled'}
    });
    assert.equal((await splitEqual(cancelled._id, 2)).status, 409);
  });

  it('validates the request', async () => {
    const order = await seat(2);
    assert.equal((await splitEqual(order._id, 1)).status, 400);
    assert.equal((await splitEqual(order._id, 0)).status, 400);
    assert.equal((await splitEqual(order._id, 99)).status, 400);
    assert.equal((await request(`/api/orders/${order._id}/split-equal`, {
      method: 'POST', token: staff(), body: {ways: 3, bogus: 1}
    })).status, 400);
    assert.equal((await request(`/api/orders/${new mongoose.Types.ObjectId()}/split-equal`, {
      method: 'POST', token: staff(), body: {ways: 2}
    })).status, 404);
  });
});

// ── Table bill ───────────────────────────────────────────────────────────────
describe('Phase 6D — table bill', () => {
  it('aggregates every check on the table', async () => {
    const order = await seat(4);
    const split = await request(`/api/orders/${order._id}/split`, {
      method: 'POST', token: staff(), body: {items: [{itemId: String(order.items[0]._id), qty: 2}]}
    });
    assert.equal(split.status, 201, split.body?.message);

    const res = await tableBill(world.table._id);
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.table.name, 'T1');
    assert.equal(res.body.summary.checks, 2, 'both halves of the split are listed');
    assert.equal(res.body.summary.total, 1740.2);
    assert.equal(res.body.summary.due, 1740.2);
    assert.equal(res.body.summary.settled, false);
  });

  it('tracks payments across checks and tenders', async () => {
    const order = await seat(4);
    await pay(order._id, {amount: 200, method: 'esewa'});
    await pay(order._id, {amount: 300, method: 'cash'});

    const res = await tableBill(world.table._id);
    assert.equal(res.body.summary.paid, 500);
    assert.equal(res.body.summary.due, 1240.2);
    assert.equal(res.body.summary.byMethod.esewa, 200);
    assert.equal(res.body.summary.byMethod.cash, 300);
    assert.equal(res.body.checks[0].payments.length, 2);
  });

  it('reports the table as settled once everything is paid', async () => {
    const order = await seat(2);
    await pay(order._id, {amount: order.total, method: 'cash'});
    const res = await tableBill(world.table._id);
    assert.equal(res.body.summary.due, 0);
    assert.equal(res.body.summary.settled, true);
    assert.equal(res.body.summary.openChecks, 0);
    assert.equal(res.body.checks[0].settled, true);
  });

  it('returns an empty but well-formed bill for a free table', async () => {
    const fresh = await request('/api/tables', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), name: 'Empty-1', seats: 2}
    });
    const res = await tableBill(fresh.body._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.checks, 0);
    assert.equal(res.body.summary.total, 0);
    assert.equal(res.body.summary.due, 0);
    assert.equal(res.body.summary.settled, true, 'a table with nothing owing is settled');
  });

  it('validates the table', async () => {
    assert.equal((await tableBill('not-an-id')).status, 400);
    assert.equal((await tableBill(new mongoose.Types.ObjectId())).status, 404);
  });
});

// ── Existing billing: regression guards ──────────────────────────────────────
describe('Phase 6D — existing billing still works', () => {
  it('splits a bill onto a separate check', async () => {
    const order = await seat(4);
    const res = await request(`/api/orders/${order._id}/split`, {
      method: 'POST', token: staff(), body: {items: [{itemId: String(order.items[0]._id), qty: 2}]}
    });
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.order.total, 870.1);
    assert.equal(res.body.splitOrder.total, 870.1);
  });

  it('pays only a chosen item share', async () => {
    const order = await seat(4);
    const res = await pay(order._id, {method: 'card', items: [{itemId: String(order.items[0]._id), qty: 1}]});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.payment.amount, 435.05, 'one of four covers pays a quarter');
    assert.equal(res.body.order.dueAmount, 1305.15);
  });

  it('accepts a partial payment and keeps the check open', async () => {
    const order = await seat(4);
    const res = await pay(order._id, {amount: 100, method: 'cash'});
    assert.equal(res.body.order.paidAmount, 100);
    assert.equal(res.body.order.dueAmount, 1640.2);
    assert.equal(res.body.order.status, 'pending');
  });

  it('refuses to take more than the balance', async () => {
    const order = await seat(1);
    assert.equal((await pay(order._id, {amount: order.total + 1, method: 'cash'})).status, 400);
  });

  it('settles the check and releases the table', async () => {
    const order = await seat(1);
    const res = await pay(order._id, {amount: order.total, method: 'khalti'});
    assert.equal(res.body.order.status, 'completed');
    assert.equal(res.body.order.dueAmount, 0);
    assert.equal((await RestaurantTable.findById(world.table._id)).status, 'cleaning');
  });
});

// ── Authorization and tenant isolation ───────────────────────────────────────
describe('Phase 6D — authorization and tenant isolation', () => {
  it('lets floor staff quote a split and read the table bill', async () => {
    const order = await seat(2);
    assert.equal((await splitEqual(order._id, 2, staff())).status, 200);
    assert.equal((await tableBill(world.table._id, staff())).status, 200);
  });

  it('rejects anonymous and guest access', async () => {
    const order = await seat(2);
    assert.equal((await request(`/api/orders/${order._id}/split-equal`, {
      method: 'POST', body: {ways: 2}
    })).status, 401);
    assert.equal((await request(`/api/tables/${world.table._id}/bill`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await splitEqual(order._id, 2, guest)).status, 403);
    assert.equal((await tableBill(world.table._id, guest)).status, 403);
  });

  it('blocks another restaurant', async () => {
    const restaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival', code: 'RVL'});
    const rival = await User.create({
      name: 'Rival Owner', email: 'rival6d@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
    });
    const token = tokenFor(rival);
    const order = await seat(2);

    assert.ok([403, 404].includes((await splitEqual(order._id, 2, token)).status));
    assert.ok([403, 404].includes((await tableBill(world.table._id, token)).status));
    assert.ok([403, 404].includes((await pay(order._id, {amount: 10, method: 'cash'}, token)).status));
    assert.equal((await Order.findById(order._id)).paidAmount, 0, 'no money moved');
  });

  it('confines a manager to their own branch', async () => {
    const otherTable = await RestaurantTable.findOne({branch: world.branchB._id});
    assert.equal((await tableBill(otherTable._id, manager())).status, 403);
  });
});
