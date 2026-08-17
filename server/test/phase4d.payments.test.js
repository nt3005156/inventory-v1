import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Audit} from '../src/models/index.js';
import {Payment} from '../src/models/operations.js';
import {
  allocateRefund,
  refundableAmount,
  refundedTotal,
  settledPayments,
  summarisePayments
} from '../src/services/refunds.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

// seedWorld menu: Chicken Biryani 350, vatInclusive false. Counter order of 1
// totals 395.50 (350 + 13% VAT).
async function makeOrder(qty = 1, extra = {}) {
  const res = await request('/api/orders', {
    method: 'POST',
    token: owner(),
    body: {
      branch: String(world.branchA._id),
      type: 'counter',
      items: [{menuItem: String(world.menu._id), qty}],
      ...extra
    }
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

function pay(orderId, body, token = staff()) {
  return request(`/api/orders/${orderId}/payments`, {method: 'POST', token, body});
}

function refund(orderId, body = {}, token = manager()) {
  return request(`/api/orders/${orderId}/refunds`, {method: 'POST', token, body});
}

describe('Phase 4D — payment tender methods', () => {
  it('accepts cash, card, eSewa and Khalti', async () => {
    for (const method of ['cash', 'card', 'esewa', 'khalti']) {
      const order = await makeOrder();
      const res = await pay(order._id, {amount: order.total, method, transactionId: `TXN-${method}`});
      assert.equal(res.status, 201, res.body?.message);
      assert.equal(res.body.payment.method, method);
      assert.equal(res.body.payment.status, 'paid');
      assert.equal(res.body.payment.transactionId, `TXN-${method}`);
      assert.equal(res.body.order.status, 'completed');
      assert.equal(res.body.order.dueAmount, 0);
    }
  });

  it('rejects an unsupported tender', async () => {
    const order = await makeOrder();
    assert.equal((await pay(order._id, {amount: 10, method: 'crypto'})).status, 400);
    assert.equal((await pay(order._id, {amount: 10, method: ''})).status, 400);
  });
});

describe('Phase 4D — partial and multiple payments', () => {
  it('settles a ticket across several tenders', async () => {
    const order = await makeOrder(); // 395.50
    const first = await pay(order._id, {amount: 100, method: 'cash'});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(first.body.order.paidAmount, 100);
    assert.equal(first.body.order.dueAmount, 295.5);
    assert.equal(first.body.order.status, 'pending', 'still open while a balance remains');

    const second = await pay(order._id, {amount: 195.5, method: 'esewa'});
    assert.equal(second.body.order.dueAmount, 100);

    const third = await pay(order._id, {amount: 100, method: 'khalti'});
    assert.equal(third.body.order.dueAmount, 0);
    assert.equal(third.body.order.status, 'completed');

    const summary = await request(`/api/orders/${order._id}/payment-summary`, {token: owner()});
    assert.equal(summary.status, 200);
    assert.equal(summary.body.taken, 395.5);
    assert.equal(summary.body.count, 3);
    assert.equal(summary.body.byMethod.cash, 100);
    assert.equal(summary.body.byMethod.esewa, 195.5);
    assert.equal(summary.body.byMethod.khalti, 100);
  });

  it('refuses to take more than the balance due', async () => {
    const order = await makeOrder();
    assert.equal((await pay(order._id, {amount: order.total + 1, method: 'cash'})).status, 400);
    assert.equal((await pay(order._id, {amount: order.total, method: 'cash'})).status, 201);
    // Nothing left to pay.
    assert.equal((await pay(order._id, {amount: 1, method: 'cash'})).status, 409);
  });
});

describe('Phase 4D — split payment', () => {
  it('pays only the selected item quantity', async () => {
    const order = await makeOrder(2); // 791
    const line = order.items[0];
    const res = await pay(order._id, {method: 'card', items: [{itemId: String(line._id), qty: 1}]});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.payment.amount, 395.5);
    assert.equal(res.body.order.dueAmount, 395.5);
    assert.equal(res.body.order.status, 'pending');
  });

  it('splits a check onto a second ticket that can be settled separately', async () => {
    const order = await makeOrder(2);
    const line = order.items[0];
    const split = await request(`/api/orders/${order._id}/split`, {
      method: 'POST', token: staff(), body: {items: [{itemId: String(line._id), qty: 1}]}
    });
    assert.equal(split.status, 201, split.body?.message);
    assert.equal(split.body.order.total, 395.5);
    assert.equal(split.body.splitOrder.total, 395.5);

    const payChild = await pay(split.body.splitOrder._id, {amount: 395.5, method: 'khalti'});
    assert.equal(payChild.body.order.status, 'completed');
    // The parent check is untouched by the child's payment.
    const parent = await request(`/api/orders/${order._id}`, {token: owner()});
    assert.equal(parent.body.dueAmount, 395.5);
  });
});

describe('Phase 4D — refund allocation', () => {
  const rows = [
    {_id: 'a', amount: 100, method: 'cash', status: 'paid', createdAt: new Date('2020-01-01T10:00:00Z')},
    {_id: 'b', amount: 200, method: 'esewa', status: 'paid', createdAt: new Date('2020-01-01T11:00:00Z')}
  ];

  it('summarises settled, refunded and refundable money', () => {
    assert.equal(settledPayments(rows).length, 2);
    assert.equal(refundableAmount(rows), 300);
    const withRefund = [...rows, {_id: 'r', amount: -50, method: 'esewa', status: 'refunded', refundOf: 'b'}];
    assert.equal(refundedTotal(withRefund), 50);
    assert.equal(refundableAmount(withRefund), 250);
  });

  it('refunds against the newest tender first', () => {
    // 120 fits inside the newest tender, so it is a single allocation.
    const one = allocateRefund(rows, 120);
    assert.equal(one.length, 1);
    assert.equal(one[0].method, 'esewa'); // newest first
    assert.equal(one[0].amount, 120);
    const exact = allocateRefund(rows, 200);
    assert.equal(exact.length, 1);
    assert.equal(exact[0].method, 'esewa');
    // Spilling past the newest payment reaches the older one.
    const spill = allocateRefund(rows, 250);
    assert.equal(spill.length, 2);
    assert.equal(spill[0].amount, 200);
    assert.equal(spill[1].amount, 50);
    assert.equal(spill[1].method, 'cash');
  });

  it('refuses to allocate more than was taken', () => {
    assert.throws(() => allocateRefund(rows, 301), /exceeds the amount paid/);
    assert.throws(() => allocateRefund(rows, 0), /greater than zero/);
  });

  it('reports a payment summary for an order', () => {
    const summary = summarisePayments({total: 300, paidAmount: 300, dueAmount: 0}, rows);
    assert.equal(summary.taken, 300);
    assert.equal(summary.refunded, 0);
    assert.equal(summary.refundable, 300);
    assert.equal(summary.byMethod.cash, 100);
  });
});

describe('Phase 4D — refunds on POST /api/orders/:id/refunds', () => {
  async function settled(qty = 1, method = 'cash') {
    const order = await makeOrder(qty);
    const paid = await pay(order._id, {amount: order.total, method});
    assert.equal(paid.status, 201, paid.body?.message);
    return paid.body.order;
  }

  it('issues a full refund and closes the order as refunded', async () => {
    const order = await settled();
    const res = await refund(order._id, {reason: 'Guest complaint'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.amount, 395.5);
    assert.equal(res.body.fullyRefunded, true);
    assert.equal(res.body.order.status, 'refunded');
    assert.equal(res.body.order.refundAmount, 395.5);
    assert.equal(res.body.order.paidAmount, 0);

    // The reversal is its own negative row; the original is left intact.
    const payments = await Payment.find({order: order._id}).sort({createdAt: 1});
    assert.equal(payments.length, 2);
    assert.equal(payments[0].amount, 395.5);
    assert.equal(payments[0].status, 'refunded');
    assert.equal(payments[1].amount, -395.5);
    assert.equal(payments[1].method, 'cash', 'money goes back the way it came');
    assert.equal(String(payments[1].refundOf), String(payments[0]._id));
    assert.equal(payments[1].reason, 'Guest complaint');
  });

  it('issues a partial refund and keeps the order settled', async () => {
    const order = await settled();
    const res = await refund(order._id, {amount: 100, reason: 'One dish returned'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.amount, 100);
    assert.equal(res.body.fullyRefunded, false);
    assert.equal(res.body.remainingRefundable, 295.5);
    assert.equal(res.body.order.status, 'completed', 'a partial refund does not void the ticket');
    assert.equal(res.body.order.refundAmount, 100);
    assert.equal(res.body.order.paidAmount, 295.5);
    // The original payment is only marked refunded once fully reversed.
    const original = await Payment.findOne({order: order._id, amount: {$gt: 0}});
    assert.equal(original.status, 'paid');
  });

  it('accumulates partial refunds until the order is fully refunded', async () => {
    const order = await settled();
    assert.equal((await refund(order._id, {amount: 200})).status, 201);
    const second = await refund(order._id, {amount: 195.5});
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(second.body.fullyRefunded, true);
    assert.equal(second.body.order.status, 'refunded');
    assert.equal(second.body.order.refundAmount, 395.5);
    // Nothing left.
    assert.equal((await refund(order._id, {amount: 1})).status, 409);
  });

  it('refunds a multi-tender order back across its tenders', async () => {
    const order = await makeOrder(2); // 791
    await pay(order._id, {amount: 300, method: 'cash'});
    await pay(order._id, {amount: 491, method: 'khalti'});

    const res = await refund(order._id, {amount: 600});
    assert.equal(res.status, 201, res.body?.message);
    // Newest tender (khalti 491) is exhausted first, then 109 from cash.
    assert.equal(res.body.refunds.length, 2);
    const byMethod = Object.fromEntries(res.body.refunds.map(r => [r.method, Math.abs(r.amount)]));
    assert.equal(byMethod.khalti, 491);
    assert.equal(byMethod.cash, 109);
    assert.equal(res.body.order.paidAmount, 191);
  });

  it('refunds the remaining balance when no amount is given', async () => {
    const order = await settled();
    assert.equal((await refund(order._id, {amount: 95.5})).status, 201);
    const rest = await refund(order._id, {});
    assert.equal(rest.status, 201, rest.body?.message);
    assert.equal(rest.body.amount, 300);
    assert.equal(rest.body.order.status, 'refunded');
  });

  it('refuses to over-refund or refund an unpaid order', async () => {
    const order = await settled();
    assert.equal((await refund(order._id, {amount: 1000})).status, 400);
    assert.equal((await refund(order._id, {amount: -5})).status, 400);

    const unpaid = await makeOrder();
    // Nothing has been tendered, so there is nothing to give back.
    assert.equal((await refund(unpaid._id, {amount: 10})).status, 409);
  });

  it('refuses to refund a cancelled order', async () => {
    const order = await makeOrder();
    const cancelled = await request(`/api/orders/${order._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, cancelled.body?.message);
    assert.equal((await refund(order._id, {amount: 10})).status, 409);
  });

  it('lets a partially refunded order be topped up again', async () => {
    const order = await settled();
    assert.equal((await refund(order._id, {amount: 100})).status, 201);
    // The ticket now shows a balance owing, which can be settled afresh.
    const again = await pay(order._id, {amount: 100, method: 'card'});
    assert.equal(again.status, 201, again.body?.message);
    assert.equal(again.body.order.dueAmount, 0);
    assert.equal(again.body.order.status, 'completed');
  });

  it('writes an audit entry naming the amount, reason and user', async () => {
    const order = await settled();
    const res = await refund(order._id, {amount: 50, reason: 'Cold food'}, manager());
    assert.equal(res.status, 201, res.body?.message);
    const entry = await Audit.findOne({entity: 'order', entityId: order._id, action: 'order_refund'});
    assert.ok(entry, 'expected a refund audit entry');
    assert.equal(entry.after.amount, 50);
    assert.equal(entry.reason, 'Cold food');
    assert.equal(String(entry.user), String(world.manager._id));
    assert.equal(entry.after.methods[0].method, 'cash');
  });

  it('leaves no reversal behind when a refund fails', async () => {
    const order = await settled();
    const before = await Payment.countDocuments({order: order._id});
    assert.equal((await refund(order._id, {amount: 9999})).status, 400);
    assert.equal(await Payment.countDocuments({order: order._id}), before);
    const unchanged = await request(`/api/orders/${order._id}`, {token: owner()});
    assert.equal(unchanged.body.status, 'completed');
    assert.equal(unchanged.body.refundAmount ?? 0, 0);
  });
});

describe('Phase 4D — refunds and revenue', () => {
  it('nets a partial refund out of P&L revenue', async () => {
    const order = await makeOrder(); // 395.50
    await pay(order._id, {amount: order.total, method: 'cash'});

    const before = await request(`/api/reports/pnl?branch=${world.branchA._id}`, {token: owner()});
    assert.equal(before.status, 200, before.body?.message);
    assert.equal(before.body.revenue, 395.5);

    assert.equal((await refund(order._id, {amount: 100})).status, 201);

    const after = await request(`/api/reports/pnl?branch=${world.branchA._id}`, {token: owner()});
    // The order is still 'completed', so without netting refunds this would
    // wrongly stay at 395.50.
    assert.equal(after.body.revenue, 295.5);
    assert.equal(after.body.grossRevenue, 395.5);
    assert.equal(after.body.refunds, 100);
  });

  it('drops a fully refunded order out of revenue entirely', async () => {
    const order = await makeOrder();
    await pay(order._id, {amount: order.total, method: 'cash'});
    assert.equal((await refund(order._id, {})).status, 201);
    const pnl = await request(`/api/reports/pnl?branch=${world.branchA._id}`, {token: owner()});
    assert.equal(pnl.body.revenue, 0);
  });
});

describe('Phase 4D — refund authorization', () => {
  it('restricts refunds to managers and owners', async () => {
    const order = await makeOrder();
    await pay(order._id, {amount: order.total, method: 'cash'});

    assert.equal((await refund(order._id, {amount: 10}, staff())).status, 403);
    assert.equal((await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', body: {amount: 10}
    })).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await refund(order._id, {amount: 10}, guest)).status, 403);

    assert.equal((await refund(order._id, {amount: 10}, manager())).status, 201);
    assert.equal((await refund(order._id, {amount: 10}, owner())).status, 201);
  });

  it('stops a manager refunding another branch', async () => {
    const other = await request('/api/orders', {
      method: 'POST',
      token: owner(),
      body: {branch: String(world.branchB._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(other.status, 201, other.body?.message);
    await pay(other.body._id, {amount: other.body.total, method: 'cash'}, owner());
    // world.manager is assigned to branch A.
    assert.equal((await refund(other.body._id, {amount: 10}, manager())).status, 403);
  });
});
