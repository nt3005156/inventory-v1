/**
 * POS 11F — split payments, refunds and reversal.
 *
 * Multiple tenders, partial payment, running balance, overpayment refusal and
 * the refund rules all shipped in Phase 4D and are pinned here rather than
 * rebuilt. The audit found three genuine gaps, each verified against the
 * running API before anything changed:
 *
 *   1. A double-clicked payment banked TWICE. Goods receiving and supplier
 *      payments both require an Idempotency-Key; the customer till, which is
 *      the one a cashier actually hammers, ignored it.
 *   2. A retried refund paid the guest back twice for the same intent.
 *   3. There was no way to reverse a payment taken by mistake. The only
 *      correction was a refund, which misrepresents a till error as money
 *      returned to a customer.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Audit} from '../src/models/index.js';
import {Order, Payment} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let keySeed = 0;
const KEY = () => `11f-${Date.now()}-${++keySeed}`;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  keySeed = 0;
  world = await seedWorld();
  await Payment.init();
});

const manager = () => tokenFor(world.manager);
const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);

async function newOrder(qty = 2) {
  const res = await request('/api/orders', {
    method: 'POST', token: manager(),
    body: {
      branch: String(world.branchA._id), type: 'counter',
      items: [{menuItem: String(world.menu._id), qty}]
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const pay = (orderId, body, key, token = manager()) =>
  request(`/api/orders/${orderId}/payments`, {
    method: 'POST', token, ...(key ? {headers: {'Idempotency-Key': key}} : {}), body
  });

const refund = (orderId, body, key, token = manager()) =>
  request(`/api/orders/${orderId}/refunds`, {
    method: 'POST', token, ...(key ? {headers: {'Idempotency-Key': key}} : {}), body
  });

const reverse = (paymentId, reason, token = owner()) =>
  request(`/api/payments/${paymentId}/reverse`, {method: 'POST', token, body: {reason}});

const settledPaymentFor = orderId =>
  Payment.findOne({order: orderId, status: 'paid', refundOf: null});

// ═══════════════════════════════════════════════════════════════════════════
// Split payment across tenders
// ═══════════════════════════════════════════════════════════════════════════

describe('11F — multiple payment methods', () => {
  it('splits one bill across cash, card and a wallet, tracking the balance down', async () => {
    const order = await newOrder(2);
    const total = order.total;

    assert.equal((await pay(order._id, {amount: 200, method: 'cash'})).status, 201);
    assert.equal((await Order.findById(order._id)).dueAmount, Math.round((total - 200) * 100) / 100);

    assert.equal((await pay(order._id, {amount: 100, method: 'card'})).status, 201);
    const afterTwo = await Order.findById(order._id);
    assert.equal(afterTwo.dueAmount, Math.round((total - 300) * 100) / 100);
    assert.notEqual(afterTwo.status, 'completed', 'a part-paid bill is not settled');

    assert.equal((await pay(order._id, {amount: afterTwo.dueAmount, method: 'esewa'})).status, 201);
    const settled = await Order.findById(order._id);
    assert.equal(settled.dueAmount, 0);
    assert.equal(settled.paidAmount, total);
    assert.equal(settled.status, 'completed');
    assert.ok(settled.completedAt instanceof Date, 'settlement is a completion path');

    const rows = await Payment.find({order: order._id});
    assert.deepEqual(rows.map(r => r.method).sort(), ['card', 'cash', 'esewa']);
    assert.equal(rows.reduce((sum, r) => sum + r.amount, 0), total);
  });

  it('refuses to take more than the outstanding balance', async () => {
    const order = await newOrder(1);
    const over = await pay(order._id, {amount: order.total + 1000, method: 'cash'});
    assert.ok([400, 409].includes(over.status), `got ${over.status}`);
    assert.equal(await Payment.countDocuments({order: order._id}), 0, 'nothing banked');
    assert.equal((await Order.findById(order._id)).paidAmount, 0);
  });

  it('refuses a negative or zero payment', async () => {
    const order = await newOrder(1);
    assert.equal((await pay(order._id, {amount: -50, method: 'cash'})).status, 400);
    assert.equal((await pay(order._id, {amount: 0, method: 'cash'})).status, 400);
    assert.equal(await Payment.countDocuments({order: order._id}), 0);
  });

  it('refuses payment on an already settled order', async () => {
    const order = await newOrder(1);
    await pay(order._id, {amount: order.total, method: 'cash'});
    const extra = await pay(order._id, {amount: 10, method: 'cash'});
    assert.ok([400, 409].includes(extra.status));
    assert.equal((await Order.findById(order._id)).paidAmount, order.total);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency — the defect
// ═══════════════════════════════════════════════════════════════════════════

describe('11F — payment idempotency', () => {
  it('banks a double-clicked payment exactly once', async () => {
    // Before this, the second click took the money again.
    const order = await newOrder(1);
    const key = KEY();

    const first = await pay(order._id, {amount: 100, method: 'cash'}, key);
    const replay = await pay(order._id, {amount: 100, method: 'cash'}, key);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 200, 'a replay is acknowledged, not reprocessed');
    assert.equal(await Payment.countDocuments({order: order._id, status: 'paid'}), 1);
    assert.equal(
      (await Order.findById(order._id)).paidAmount, 100,
      'the guest is charged once'
    );
  });

  it('holds under concurrent submissions of the same key', async () => {
    const order = await newOrder(1);
    const key = KEY();
    const attempts = await Promise.all(
      [1, 2, 3, 4].map(() => pay(order._id, {amount: 50, method: 'cash'}, key))
    );
    assert.ok(attempts.every(r => [200, 201].includes(r.status)), 'every caller gets an answer');
    assert.equal(await Payment.countDocuments({order: order._id, status: 'paid'}), 1);
    assert.equal((await Order.findById(order._id)).paidAmount, 50);
  });

  it('still accepts genuinely separate payments under different keys', async () => {
    const order = await newOrder(2);
    assert.equal((await pay(order._id, {amount: 100, method: 'cash'}, KEY())).status, 201);
    assert.equal((await pay(order._id, {amount: 100, method: 'card'}, KEY())).status, 201);
    assert.equal(await Payment.countDocuments({order: order._id, status: 'paid'}), 2);
    assert.equal((await Order.findById(order._id)).paidAmount, 200);
  });

  it('remains backward compatible when no key is supplied', async () => {
    // The key is an improvement, not a new requirement: existing till clients
    // must keep working.
    const order = await newOrder(1);
    assert.equal((await pay(order._id, {amount: 50, method: 'cash'})).status, 201);
  });

  it('enforces single-use at the database, not only in application code', async () => {
    const order = await newOrder(2);
    const key = KEY();
    await pay(order._id, {amount: 100, method: 'cash'}, key);

    await assert.rejects(
      Payment.create({
        order: order._id, amount: 100, method: 'card', status: 'paid', idempotencyKey: key
      }),
      error => error.code === 11000,
      'the unique {order, idempotencyKey} index is the guarantee'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Refunds
// ═══════════════════════════════════════════════════════════════════════════

describe('11F — refunds', () => {
  async function paidOrder(qty = 2) {
    const order = await newOrder(qty);
    await pay(order._id, {amount: order.total, method: 'cash'});
    return order;
  }

  it('refunds partially and then fully, moving the order to refunded', async () => {
    const order = await paidOrder(2);

    assert.equal((await refund(order._id, {amount: 100, reason: 'Cold food'})).status, 201);
    let stored = await Order.findById(order._id);
    assert.equal(stored.refundAmount, 100);
    assert.equal(stored.status, 'completed', 'a partial refund does not void the sale');

    assert.equal((await refund(order._id, {amount: order.total - 100, reason: 'Rest'})).status, 201);
    stored = await Order.findById(order._id);
    assert.equal(stored.refundAmount, order.total);
    assert.equal(stored.status, 'refunded');
  });

  it('refuses to refund more than was taken', async () => {
    const order = await paidOrder(1);
    const over = await refund(order._id, {amount: order.total + 500, reason: 'Too much'});
    assert.ok([400, 409].includes(over.status));
    assert.equal((await Order.findById(order._id)).refundAmount, 0);

    assert.equal((await refund(order._id, {amount: -10, reason: 'Negative'})).status, 400);
  });

  it('banks a replayed refund exactly once', async () => {
    const order = await paidOrder(2);
    const key = KEY();

    const first = await refund(order._id, {amount: 50, reason: 'Duplicate test'}, key);
    const replay = await refund(order._id, {amount: 50, reason: 'Duplicate test'}, key);

    assert.equal(first.status, 201);
    assert.equal(replay.status, 200);
    assert.equal(
      (await Order.findById(order._id)).refundAmount, 50,
      'a retried refund must not pay the guest twice'
    );
  });

  it('reserves refunds for supervisors', async () => {
    const order = await paidOrder(1);
    assert.equal((await refund(order._id, {amount: 10, reason: 'x'}, undefined, staff())).status, 403);
    assert.equal((await Order.findById(order._id)).refundAmount, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment reversal — the missing capability
// ═══════════════════════════════════════════════════════════════════════════

describe('11F — payment reversal', () => {
  async function paidOrder(qty = 1) {
    const order = await newOrder(qty);
    await pay(order._id, {amount: order.total, method: 'cash'});
    return order;
  }

  it('reverses a mistyped tender and reopens the balance', async () => {
    const order = await paidOrder(1);
    assert.equal((await Order.findById(order._id)).status, 'completed');
    const payment = await settledPaymentFor(order._id);

    const res = await reverse(payment._id, 'Charged to cash by mistake');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, 0);
    assert.equal(stored.dueAmount, order.total, 'the bill is payable again');
    assert.equal(stored.status, 'confirmed', 'it must not still read as settled');

    const reversed = await Payment.findById(payment._id);
    assert.equal(reversed.status, 'reversed');
    assert.ok(reversed.reversedAt instanceof Date);
    assert.equal(reversed.reversalReason, 'Charged to cash by mistake');
    assert.ok(reversed.reversedBy, 'the supervisor who reversed it is recorded');
  });

  it('lets the correct tender be taken afterwards', async () => {
    const order = await paidOrder(1);
    const payment = await settledPaymentFor(order._id);
    await reverse(payment._id, 'Wrong tender');

    assert.equal((await pay(order._id, {amount: order.total, method: 'card'})).status, 201);
    const stored = await Order.findById(order._id);
    assert.equal(stored.dueAmount, 0);
    assert.equal(stored.status, 'completed');
  });

  it('cannot be applied twice', async () => {
    const order = await paidOrder(1);
    const payment = await settledPaymentFor(order._id);
    assert.equal((await reverse(payment._id, 'First')).status, 200);

    const again = await reverse(payment._id, 'Second');
    assert.equal(again.status, 409, 'a double reversal would credit the balance twice');
    assert.equal((await Order.findById(order._id)).dueAmount, order.total);
  });

  it('refuses to reverse money that was genuinely refunded', async () => {
    // A refund is not a mistake, and rewriting it as one would misstate the
    // books.
    const order = await newOrder(2);
    await pay(order._id, {amount: order.total, method: 'cash'});
    await refund(order._id, {amount: order.total, reason: 'Customer returned it'});

    const payment = await Payment.findOne({order: order._id, refundOf: null, amount: {$gt: 0}});
    const res = await reverse(payment._id, 'Trying to undo a refund');
    assert.equal(res.status, 409);
  });

  it('refuses to reverse a partly refunded tender', async () => {
    const order = await newOrder(2);
    await pay(order._id, {amount: order.total, method: 'cash'});
    await refund(order._id, {amount: 50, reason: 'Partial'});

    const payment = await Payment.findOne({order: order._id, refundOf: null, amount: {$gt: 0}});
    const res = await reverse(payment._id, 'Ambiguous');
    assert.equal(res.status, 409, 'the remaining amount would be ambiguous');
  });

  it('requires a reason and reserves reversal for owners', async () => {
    const order = await paidOrder(1);
    const payment = await settledPaymentFor(order._id);

    assert.equal((await reverse(payment._id, 'x')).status, 400, 'a real reason is required');
    assert.equal((await reverse(payment._id, 'Wrong tender', manager())).status, 403);
    assert.equal((await reverse(payment._id, 'Wrong tender', staff())).status, 403);
    assert.equal((await Payment.findById(payment._id)).status, 'paid', 'nothing changed');
  });

  it('audits the reversal', async () => {
    const order = await paidOrder(1);
    const payment = await settledPaymentFor(order._id);
    await reverse(payment._id, 'Wrong tender at the till');

    const entry = await Audit.findOne({action: 'payment_reversed', entityId: payment._id}).lean();
    assert.ok(entry, 'reversing money must be auditable');
    assert.equal(String(entry.user), String(world.owner._id));
    assert.equal(entry.after.reason, 'Wrong tender at the till');
    assert.equal(entry.before.amount, order.total);
  });
});
