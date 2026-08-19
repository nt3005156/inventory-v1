/**
 * Phase 12 — refunds, voiding and financial controls.
 *
 * The refund engine itself shipped in Phase 4D and was hardened in 11F; this
 * phase does not rebuild it. What is new here, and what these tests pin, are
 * the four defects found by probing the running API:
 *
 *   1. Cancelling a PART-PAID order succeeded and stranded the guest's money:
 *      the cash stayed banked and refundOrder() then refused because the order
 *      was cancelled. Verified against the API before the fix, with a passing
 *      control (cancelling an UNPAID order still works).
 *   2. A FULL refund voided the sale but left the ingredients deducted. Only
 *      the cancel path called reverseOrderStock(); refunding did not.
 *   3. A refund could be issued with NO reason at all, so the audit row carried
 *      nothing an auditor could act on.
 *   4. A settled Payment row could be silently rewritten — `payment.amount = 1;
 *      payment.save()` succeeded and the money simply changed. The append-only
 *      ledger was a convention, not a constraint.
 *
 * Every assertion checks MongoDB state, not just the HTTP status.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Order, Payment, Restaurant
} from '../src/models/operations.js';
import {REFUNDABLE_STATUSES, REFUND_CLOSES_FROM, refundableAmount} from '../src/services/refunds.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let rival;
let keySeed = 0;
const KEY = () => `p12r-${Date.now()}-${++keySeed}`;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  keySeed = 0;
  world = await seedWorld();
  await Payment.init();

  const restaurant = await Restaurant.create({name: 'Rival12', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival12 Branch', code: 'RV2', address: 'Patan'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival12 Owner', email: 'rival12r@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival12', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const MENU = () => String(world.menu._id);
const BRANCH = () => String(world.branchA._id);

async function newOrder(qty = 1, token = manager()) {
  const res = await request('/api/orders', {
    method: 'POST', token,
    body: {branch: BRANCH(), type: 'counter', items: [{menuItem: MENU(), qty}]}
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const pay = (id, amount, token = manager(), method = 'cash') =>
  request(`/api/orders/${id}/payments`, {
    method: 'POST', token, headers: {'Idempotency-Key': KEY()}, body: {amount, method}
  });

const refund = (id, body, token = manager(), key = KEY()) =>
  request(`/api/orders/${id}/refunds`, {
    method: 'POST', token, ...(key ? {headers: {'Idempotency-Key': key}} : {}), body
  });

const setStatus = (id, status, token = manager()) =>
  request(`/api/orders/${id}/status`, {method: 'PATCH', token, body: {status}});

const summaryOf = (id, token = manager()) =>
  request(`/api/orders/${id}/payment-summary`, {token});

async function settled(qty = 1) {
  const order = await newOrder(qty);
  const paid = await pay(order._id, order.total);
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  return order;
}

const stockOf = async () => (await InventoryBalance.findOne({
  branch: world.branchA._id, ingredient: world.ingredient._id
})).quantity;

// ═══════════════════════════════════════════════════════════════════════════
// Partial refunds
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — partial refunds', () => {
  it('leaves the remaining paid amount behind (1000 less 300 leaves 700)', async () => {
    // The brief's arithmetic, priced with a real order rather than a fixture.
    const order = await newOrder(3);
    await pay(order._id, 1000);

    const res = await refund(order._id, {amount: 300, reason: 'One dish returned'});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, 700, 'remaining paid must be 700');
    assert.equal(stored.refundAmount, 300);
    assert.equal((await summaryOf(order._id)).body.refundable, 700);
  });

  it('does not move the order to refunded', async () => {
    const order = await settled(2);
    await refund(order._id, {amount: 100, reason: 'Cold naan'});
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'completed', 'a partial refund does not void the sale');
    assert.equal(stored.refundAmount, 100);
  });

  it('is money only and restores no inventory', async () => {
    const order = await settled(1);
    const before = await stockOf();
    await refund(order._id, {amount: 50, reason: 'Goodwill'});
    assert.equal(await stockOf(), before, 'the food still left the kitchen');
    assert.equal(await InventoryTransaction.countDocuments({
      referenceId: order._id, type: 'REVERSAL'
    }), 0);
    assert.equal((await Order.findById(order._id)).inventoryReversed, false);
  });

  it('accumulates until fully refunded, then closes the ticket', async () => {
    const order = await settled(1);
    assert.equal((await refund(order._id, {amount: 200, reason: 'First'})).status, 201);
    const last = await refund(order._id, {amount: order.total - 200, reason: 'Rest'});
    assert.equal(last.status, 201, JSON.stringify(last.body));

    const stored = await Order.findById(order._id);
    assert.equal(stored.refundAmount, order.total);
    assert.equal(stored.paidAmount, 0);
    assert.equal(stored.status, 'refunded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Full refunds — status and inventory
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — full refunds', () => {
  it('moves completed to refunded only when every rupee has gone back', async () => {
    const order = await settled(2);
    await refund(order._id, {amount: order.total - 1, reason: 'Nearly all'});
    assert.equal((await Order.findById(order._id)).status, 'completed',
      'one rupee outstanding is not a full refund');

    await refund(order._id, {amount: 1, reason: 'The last rupee'});
    assert.equal((await Order.findById(order._id)).status, 'refunded');
  });

  it('restores the ingredients through the ledger, not by writing balances', async () => {
    const order = await settled(1);          // 1 plate = 250g of rice
    const afterSale = await stockOf();
    assert.equal(afterSale, 20000 - 250, 'control: the sale deducted 250g');

    const res = await refund(order._id, {reason: 'Whole order returned'});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.inventoryReversed, true);
    assert.equal(await stockOf(), 20000, 'a full refund puts the stock back');

    // Through the ledger: a REVERSAL row exists and its arithmetic is sound.
    const reversal = await InventoryTransaction.findOne({
      referenceId: order._id, type: 'REVERSAL'
    });
    assert.ok(reversal, 'the restoration must be a ledger movement');
    assert.equal(reversal.changeQty, 250);
    assert.equal(reversal.newQty, reversal.previousQty + reversal.changeQty);
    assert.equal((await Order.findById(order._id)).inventoryReversed, true);
  });

  it('restores the stock exactly once across a partial-then-full sequence', async () => {
    const order = await settled(1);
    await refund(order._id, {amount: 100, reason: 'Partial first'});
    assert.equal(await stockOf(), 19750, 'a partial refund restores nothing');

    await refund(order._id, {reason: 'Now the rest'});
    assert.equal(await stockOf(), 20000);
    assert.equal(await InventoryTransaction.countDocuments({
      referenceId: order._id, type: 'REVERSAL'
    }), 1, 'double restoration would invent stock');
  });

  it('does not restore stock twice when the order is then marked refunded again', async () => {
    const order = await settled(1);
    await refund(order._id, {reason: 'Full'});
    // The order is already 'refunded'; the transition guard refuses a repeat,
    // and either way the stock must not move again.
    await setStatus(order._id, 'refunded');
    assert.equal(await stockOf(), 20000);
    assert.equal(await InventoryTransaction.countDocuments({
      referenceId: order._id, type: 'REVERSAL'
    }), 1);
  });

  it('refunding a deposit on a live ticket keeps it live and moves no stock', async () => {
    // The kitchen is still cooking. Handing back a deposit reopens the balance
    // but must not void the sale or return ingredients that are in a pan.
    const order = await newOrder(2);
    await pay(order._id, 100);
    const before = await stockOf();

    const res = await refund(order._id, {reason: 'Deposit returned'});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'pending', 'a live ticket does not close as refunded');
    assert.equal(stored.paidAmount, 0);
    assert.equal(stored.dueAmount, order.total);
    assert.equal(await stockOf(), before, 'the food is still being cooked');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stranded money on the void path
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — voiding cannot strand the guest money', () => {
  it('control: an unpaid order still cancels', async () => {
    const order = await newOrder(1);
    assert.equal((await setStatus(order._id, 'cancelled')).status, 200);
    assert.equal((await Order.findById(order._id)).status, 'cancelled');
  });

  it('refuses to cancel a part-paid order and names the amount held', async () => {
    const order = await newOrder(1);
    await pay(order._id, 100);

    const res = await setStatus(order._id, 'cancelled');
    assert.equal(res.status, 409, 'cancelling would keep money that is not ours');
    assert.match(res.body.message, /100/);
    assert.equal((await Order.findById(order._id)).status, 'pending', 'nothing moved');
    assert.equal((await Order.findById(order._id)).paidAmount, 100);
  });

  it('allows the cancel once the money has been given back', async () => {
    const order = await newOrder(1);
    await pay(order._id, 100);
    assert.equal((await refund(order._id, {amount: 100, reason: 'Guest left'})).status, 201);

    const res = await setStatus(order._id, 'cancelled');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await Order.findById(order._id)).status, 'cancelled');
  });

  it('refuses to reject a prepaid web order while it still holds the money', async () => {
    const order = await Order.create({
      orderNo: 'WEB-12R', branch: world.branchA._id, source: 'online', status: 'pending',
      type: 'delivery', items: [], subtotal: 100, total: 100, paidAmount: 100, dueAmount: 0
    });
    await Payment.create({order: order._id, amount: 100, method: 'esewa', status: 'paid'});

    const res = await request(`/api/online-orders/${order._id}/reject`, {
      method: 'POST', token: manager(), body: {reason: 'Kitchen at capacity'}
    });
    assert.equal(res.status, 409);
    assert.equal((await Order.findById(order._id)).status, 'pending');
  });

  it('leaves a cancelled order with nothing refundable', async () => {
    const order = await newOrder(1);
    await pay(order._id, 100);
    await refund(order._id, {amount: 100, reason: 'Guest left'});
    await setStatus(order._id, 'cancelled');

    const payments = await Payment.find({order: order._id});
    assert.equal(refundableAmount(payments), 0);
    assert.equal((await refund(order._id, {amount: 10, reason: 'Again'})).status, 409);
  });

  it('can still repay a legacy order cancelled while holding money', async () => {
    // Rows cancelled before the guard existed can be holding the guest's cash.
    // The refund path must be able to reach them; the cancel guard is what
    // stops NEW ones being created, so both are needed.
    const order = await newOrder(1);
    await pay(order._id, 100);
    await Order.updateOne({_id: order._id}, {$set: {status: 'cancelled', inventoryReversed: true}});

    const res = await refund(order._id, {amount: 100, reason: 'Legacy cleanup'});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, 0);
    assert.equal(stored.refundAmount, 100);
    assert.equal(stored.status, 'cancelled', 'a cancelled ticket does not reopen as refunded');
    // The row is flagged as already reversed, so the refund must not write a
    // second restoration on top of it.
    assert.equal(await InventoryTransaction.countDocuments({
      referenceId: order._id, type: 'REVERSAL'
    }), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Newest-first allocation across tenders
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — payment allocation', () => {
  it('exhausts the newest tender before touching an older one', async () => {
    const order = await newOrder(2);           // 791
    await pay(order._id, 300, manager(), 'cash');
    await pay(order._id, 491, manager(), 'khalti');

    const res = await refund(order._id, {amount: 600, reason: 'Most of it back'});
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const rows = await Payment.find({order: order._id, amount: {$lt: 0}});
    const byMethod = Object.fromEntries(rows.map(r => [r.method, Math.abs(r.amount)]));
    assert.equal(byMethod.khalti, 491, 'the newest tender goes back first');
    assert.equal(byMethod.cash, 109);
    // Money goes back the way it came, and each reversal names its original.
    for (const row of rows) {
      const original = await Payment.findById(row.refundOf);
      assert.ok(original, 'every reversal points at the payment it reverses');
      assert.equal(original.method, row.method);
    }
  });

  it('does not treat a reversed tender as refundable money', async () => {
    // Found by probing the running API: 300 cash + 491 khalti with the cash
    // REVERSED still reported 791 refundable while the till held 491, so the
    // reversed 300 could be handed to the guest a second time.
    const order = await newOrder(2);                       // 791
    await pay(order._id, 300, manager(), 'cash');
    await pay(order._id, 491, manager(), 'khalti');

    const cash = await Payment.findOne({order: order._id, method: 'cash', amount: {$gt: 0}});
    assert.equal((await request(`/api/payments/${cash._id}/reverse`, {
      method: 'POST', token: owner(), body: {reason: 'Wrong tender at the till'}
    })).status, 200);

    const summary = (await summaryOf(order._id)).body;
    assert.equal(summary.taken, 491, 'a reversed tender was never really taken');
    assert.equal(summary.refundable, 491);

    // And the ceiling must actually bite.
    assert.equal((await refund(order._id, {amount: 600, reason: 'Over'})).status, 400);
    assert.equal((await refund(order._id, {amount: 491, reason: 'All of it'})).status, 201);
    assert.equal((await Order.findById(order._id)).refundAmount, 491);
  });

  it('marks an original refunded only once it is fully reversed', async () => {
    const order = await newOrder(2);
    await pay(order._id, 300, manager(), 'cash');
    await pay(order._id, 491, manager(), 'khalti');
    await refund(order._id, {amount: 491, reason: 'Wallet back'});

    const cash = await Payment.findOne({order: order._id, method: 'cash', amount: {$gt: 0}});
    const khalti = await Payment.findOne({order: order._id, method: 'khalti', amount: {$gt: 0}});
    assert.equal(khalti.status, 'refunded');
    assert.equal(cash.status, 'paid', 'the untouched tender is still live money');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Over-refund and duplicate protection
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — over-refund and duplicates', () => {
  it('refuses more than remains refundable and banks nothing', async () => {
    const order = await settled(1);
    const before = await Payment.countDocuments({order: order._id});

    assert.equal((await refund(order._id, {amount: order.total + 1, reason: 'Too much'})).status, 400);
    assert.equal((await refund(order._id, {amount: -5, reason: 'Negative'})).status, 400);
    assert.equal((await refund(order._id, {amount: 0, reason: 'Zero'})).status, 400);

    assert.equal(await Payment.countDocuments({order: order._id}), before, 'no row was written');
    assert.equal((await Order.findById(order._id)).refundAmount, 0);
  });

  it('refuses a second refund that would exceed what is left', async () => {
    const order = await settled(1);
    await refund(order._id, {amount: 300, reason: 'First'});
    const over = await refund(order._id, {amount: 300, reason: 'Second'});
    assert.ok([400, 409].includes(over.status), `got ${over.status}`);
    assert.equal((await Order.findById(order._id)).refundAmount, 300);
  });

  it('banks a replayed refund key exactly once', async () => {
    const order = await settled(2);
    const key = KEY();
    assert.equal((await refund(order._id, {amount: 50, reason: 'Dup'}, manager(), key)).status, 201);
    assert.equal((await refund(order._id, {amount: 50, reason: 'Dup'}, manager(), key)).status, 200);

    assert.equal((await Order.findById(order._id)).refundAmount, 50);
    assert.equal(await Payment.countDocuments({order: order._id, amount: {$lt: 0}}), 1);
  });

  it('refuses to refund an order that was never paid', async () => {
    const order = await newOrder(1);
    assert.equal((await refund(order._id, {amount: 10, reason: 'Nothing to give'})).status, 409);
    assert.equal(await Payment.countDocuments({order: order._id}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorisation
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — refund authorisation', () => {
  it('is manager and owner only; hiding a button is not the control', async () => {
    const order = await settled(2);

    assert.equal((await refund(order._id, {amount: 10, reason: 'Nope'}, staff())).status, 403);
    assert.equal((await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', body: {amount: 10, reason: 'Anonymous'}
    })).status, 401);
    assert.equal((await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: 'not.a.jwt', body: {amount: 10, reason: 'Forged'}
    })).status, 401);
    assert.equal((await Order.findById(order._id)).refundAmount, 0, 'nothing left the till');

    assert.equal((await refund(order._id, {amount: 10, reason: 'Manager may'}, manager())).status, 201);
    assert.equal((await refund(order._id, {amount: 10, reason: 'Owner may'}, owner())).status, 201);
  });

  it('refuses a refund across the restaurant boundary', async () => {
    const order = await settled(1);
    const res = await refund(order._id, {amount: 10, reason: 'Theft'}, tokenFor(rival.owner));
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);
    assert.equal((await Order.findById(order._id)).refundAmount, 0);
  });

  it('refuses a manager refunding a branch they are not assigned to', async () => {
    const other = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchB._id), type: 'counter', items: [{menuItem: MENU(), qty: 1}]}
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    await pay(other.body._id, other.body.total, owner());

    // world.manager is bound to branch A.
    assert.equal((await refund(other.body._id, {amount: 10, reason: 'Wrong branch'}, manager())).status, 403);
    assert.equal((await Order.findById(other.body._id)).refundAmount, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reason and audit
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — reason and audit trail', () => {
  it('requires a reason of real substance', async () => {
    const order = await settled(1);
    for (const body of [{amount: 10}, {amount: 10, reason: ''}, {amount: 10, reason: '  '}, {amount: 10, reason: 'x'}]) {
      const res = await refund(order._id, body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status}`);
    }
    assert.equal((await Order.findById(order._id)).refundAmount, 0);
    assert.equal(await Payment.countDocuments({order: order._id, amount: {$lt: 0}}), 0);
  });

  it('writes the reason onto both the audit row and the reversal', async () => {
    const order = await settled(1);
    await refund(order._id, {amount: 50, reason: 'Hair in the curry'});

    const entry = await Audit.findOne({
      entity: 'order', entityId: order._id, action: 'order_refund'
    }).lean();
    assert.ok(entry, 'a refund must be auditable');
    assert.equal(entry.reason, 'Hair in the curry');
    assert.equal(entry.after.amount, 50);
    assert.equal(String(entry.user), String(world.manager._id));
    assert.equal(entry.after.methods[0].method, 'cash');

    const reversal = await Payment.findOne({order: order._id, amount: {$lt: 0}});
    assert.equal(reversal.reason, 'Hair in the curry');
    assert.equal(String(reversal.cashier), String(world.manager._id));
  });

  it('records whether the refund was full and whether stock came back', async () => {
    const order = await settled(1);
    await refund(order._id, {reason: 'Everything back'});
    const entry = await Audit.findOne({
      entity: 'order', entityId: order._id, action: 'order_refund'
    }).lean();
    assert.equal(entry.after.fullyRefunded, true);
    assert.equal(entry.after.inventoryReversed, true);
    assert.equal(entry.after.status, 'refunded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The original payment is immutable
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — the payment ledger is append-only', () => {
  it('refuses to rewrite the amount or tender of a settled payment', async () => {
    const order = await settled(1);
    const payment = await Payment.findOne({order: order._id, amount: {$gt: 0}});

    payment.amount = 1;
    payment.method = 'card';
    await assert.rejects(payment.save(), /cannot be rewritten/);

    const stored = await Payment.findById(payment._id);
    assert.equal(stored.amount, order.total, 'the money must not have changed');
    assert.equal(stored.method, 'cash');
  });

  it('refuses the same rewrite through a bare query update', async () => {
    const order = await settled(1);
    const payment = await Payment.findOne({order: order._id, amount: {$gt: 0}});

    await assert.rejects(
      Payment.updateOne({_id: payment._id}, {$set: {amount: 1}}),
      /cannot be rewritten/
    );
    await assert.rejects(
      Payment.findOneAndUpdate({_id: payment._id}, {$set: {method: 'card'}}),
      /cannot be rewritten/
    );
    await assert.rejects(
      Payment.updateMany({order: order._id}, {$inc: {amount: -100}}),
      /cannot be rewritten/
    );

    const stored = await Payment.findById(payment._id);
    assert.equal(stored.amount, order.total);
    assert.equal(stored.method, 'cash');
  });

  it('allows a table merge to re-parent a tender but not to change the money', async () => {
    // Merging two checks moves payments onto the surviving order. That is the
    // ONE sanctioned exception, and it must stay narrow.
    const order = await settled(1);
    const other = await newOrder(1);
    const payment = await Payment.findOne({order: order._id, amount: {$gt: 0}});

    await Payment.updateMany(
      {_id: payment._id}, {$set: {order: other._id}}, {reparentPayments: true}
    );
    assert.equal(String((await Payment.findById(payment._id)).order), String(other._id));

    // The escape hatch must not smuggle an amount change through with it.
    await assert.rejects(
      Payment.updateMany(
        {_id: payment._id},
        {$set: {order: order._id, amount: 1}},
        {reparentPayments: true}
      ),
      /cannot be rewritten \(amount\)/
    );
    assert.equal((await Payment.findById(payment._id)).amount, order.total);
  });

  it('still allows the status transitions the refund path depends on', async () => {
    // Control: the guard must not be so broad that refunding breaks.
    const order = await settled(1);
    const res = await refund(order._id, {reason: 'Full refund'});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const original = await Payment.findOne({order: order._id, amount: {$gt: 0}});
    assert.equal(original.status, 'refunded', 'a status change is not a rewrite');
    assert.equal(original.amount, order.total, 'but the amount is untouched');
  });

  it('leaves the original row intact after a reversal', async () => {
    const order = await settled(1);
    const payment = await Payment.findOne({order: order._id, amount: {$gt: 0}});
    const res = await request(`/api/payments/${payment._id}/reverse`, {
      method: 'POST', token: owner(), body: {reason: 'Wrong tender at the till'}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await Payment.findById(payment._id);
    assert.equal(stored.amount, order.total, 'a reversal never deletes or rewrites');
    assert.equal(stored.status, 'reversed');
    assert.ok(stored.reversedAt);
    assert.equal(stored.reversalReason, 'Wrong tender at the till');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment history
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — payment history', () => {
  it('shows the original and its reversal as separate rows in order', async () => {
    const order = await settled(2);
    await refund(order._id, {amount: 100, reason: 'One dish'});

    const res = await request(`/api/orders/${order._id}/payments`, {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.equal(res.body[0].amount, order.total);
    assert.equal(res.body[1].amount, -100);
    assert.equal(String(res.body[1].refundOf), String(res.body[0]._id));
    assert.equal(res.body[1].reason, 'One dish');
    // The history must not leak the idempotency key.
    assert.equal(res.body[1].idempotencyKey, undefined);
  });

  it('sums the history to the same figures the summary reports', async () => {
    const order = await newOrder(2);
    await pay(order._id, 300, manager(), 'cash');
    await pay(order._id, 491, manager(), 'khalti');
    await refund(order._id, {amount: 200, reason: 'Partial'});

    const summary = (await summaryOf(order._id)).body;
    const rows = await Payment.find({order: order._id});
    const net = rows.reduce((sum, r) => sum + Number(r.amount), 0);

    assert.equal(summary.taken, 791);
    assert.equal(summary.refunded, 200);
    assert.equal(summary.refundable, 591);
    assert.equal(Math.round(net * 100) / 100, 591, 'the ledger must agree with the summary');
    assert.equal(summary.count, 3);
  });

  it('keeps the history readable across a full refund', async () => {
    const order = await settled(1);
    await refund(order._id, {reason: 'All of it'});
    const rows = await Payment.find({order: order._id}).sort({createdAt: 1});
    assert.equal(rows.length, 2);
    assert.equal(rows[0].status, 'refunded');
    assert.equal(rows[1].amount, -order.total);
    assert.equal((await summaryOf(order._id)).body.refundable, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrency — driven through overlapping sessions, not HTTP
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — concurrent refunds cannot over-refund', () => {
  it('two overlapping refunds of the full amount settle to one', async () => {
    // Express serialises HTTP requests, so an HTTP "concurrency" test proves
    // nothing here. These drive the service through two real sessions.
    const {refundOrder} = await import('../src/services/refunds.js');
    const order = await settled(1);
    const user = {id: String(world.manager._id), role: 'manager', branch: String(world.branchA._id)};

    const attempt = async () => {
      const session = await mongoose.startSession();
      try {
        let out;
        await session.withTransaction(async () => {
          out = await refundOrder({
            orderId: order._id, amount: order.total, reason: 'Race', user, session
          });
        });
        return {ok: true, out};
      } catch (e) {
        return {ok: false, message: e.message};
      } finally {
        session.endSession();
      }
    };

    const results = await Promise.all([attempt(), attempt()]);
    const winners = results.filter(r => r.ok);
    assert.ok(winners.length >= 1, 'at least one refund must succeed');

    const stored = await Order.findById(order._id);
    assert.equal(stored.refundAmount, order.total, 'the guest is repaid exactly once');
    assert.equal(stored.paidAmount, 0);
    const out = await Payment.aggregate([
      {$match: {order: stored._id, amount: {$lt: 0}}},
      {$group: {_id: null, total: {$sum: '$amount'}}}
    ]);
    assert.equal(Math.abs(out[0].total), order.total, 'no rupee left twice');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Contract surface
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — refundable statuses', () => {
  it('admits a cancelled order only so stranded legacy money can be repaid', () => {
    // It is refundable, but REFUND_CLOSES_FROM must never reopen it, and no
    // stock may be returned a second time.
    assert.equal(REFUNDABLE_STATUSES.includes('cancelled'), true);
    assert.equal(REFUND_CLOSES_FROM.includes('cancelled'), false);
  });

  it('admits live tickets so a deposit can always be given back', () => {
    for (const status of ['pending', 'confirmed', 'preparing', 'ready', 'completed']) {
      assert.ok(REFUNDABLE_STATUSES.includes(status), `${status} must be refundable`);
    }
  });
});
