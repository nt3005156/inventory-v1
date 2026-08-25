import {Audit} from '../models/index.js';
import {Order, Payment} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {money} from './billing.js';
import {reverseOrderStock} from './inventoryLedger.js';
import {userRestaurantContext} from './supplierCatalog.js';

// Phase 4D — Payments: refunds.
//
// A refund reverses money that was actually taken, so it works against the
// order's settled payments rather than its total. Each reversal is written as
// its own Payment row with a negative amount, which keeps the payment ledger
// append-only: the original row is never rewritten, and the sum of all rows for
// an order always equals what the guest is currently out of pocket.

// A refund works against money that was actually taken, so any order holding a
// settled tender can be refunded. Phase 12 widened this from
// ['completed','refunded']: a part-paid ticket held cash that could not be
// given back through the refund path at all, which is how money got stranded
// when the ticket was then cancelled.
export const REFUNDABLE_STATUSES = Object.freeze([
  'draft', 'held', 'pending', 'confirmed', 'accepted', 'preparing', 'ready',
  'out_for_delivery', 'completed', 'refunded', 'cancelled'
]);

/** Statuses from which a full refund closes the ticket as 'refunded'. */
export const REFUND_CLOSES_FROM = Object.freeze(['completed', 'refunded']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

/**
 * Payments that represent money actually in the till.
 *
 * Excludes prior refund rows (negative), failed tenders, unconfirmed `pending`
 * gateway stubs, and — Phase 12 — REVERSED rows. A reversal means the tender
 * was never really taken; leaving it in made it refundable, so a cash payment
 * that had been reversed could still be handed back to the guest a second
 * time. Reproduced against the running API: a 300 cash + 491 khalti order with
 * the cash reversed reported 791 refundable while holding 491.
 */
const MONEY_IN_STATUSES = new Set(['paid', 'refunded']);

export function settledPayments(payments = []) {
  return payments.filter(p => Number(p.amount) > 0 && MONEY_IN_STATUSES.has(p.status || 'paid'));
}

/** What has already been refunded against an order. */
export function refundedTotal(payments = []) {
  return money(payments
    .filter(p => Number(p.amount) < 0)
    .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0));
}

/** What remains refundable: settled money in, less refunds already issued. */
export function refundableAmount(payments = []) {
  const taken = money(settledPayments(payments).reduce((sum, p) => sum + Number(p.amount), 0));
  return money(Math.max(0, taken - refundedTotal(payments)));
}

/**
 * Allocates a refund across the original payments, newest first.
 *
 * Refunding to the most recent tender matches how a till behaves in practice
 * and keeps each reversal traceable to the payment it reverses — important
 * when an order was settled partly in cash and partly by wallet, since the
 * money has to go back the way it came.
 */
export function allocateRefund(payments, amount) {
  const target = money(amount);
  if (!(target > 0)) throw httpError('Refund amount must be greater than zero', 400);

  // How much of each original payment is still un-refunded.
  const remaining = new Map();
  for (const payment of settledPayments(payments)) {
    remaining.set(String(payment._id), Number(payment.amount));
  }
  for (const reversal of payments.filter(p => Number(p.amount) < 0)) {
    const key = reversal.refundOf ? String(reversal.refundOf) : null;
    if (key && remaining.has(key)) {
      remaining.set(key, money(remaining.get(key) - Math.abs(Number(reversal.amount))));
    }
  }

  const available = money([...remaining.values()].reduce((sum, v) => sum + Math.max(0, v), 0));
  if (target > available) throw httpError('Refund exceeds the amount paid on this order', 400);

  const ordered = settledPayments(payments)
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const allocations = [];
  let outstanding = target;
  for (const payment of ordered) {
    if (outstanding <= 0) break;
    const left = money(remaining.get(String(payment._id)) || 0);
    if (left <= 0) continue;
    const take = money(Math.min(left, outstanding));
    allocations.push({payment, amount: take, method: payment.method});
    outstanding = money(outstanding - take);
  }
  if (outstanding > 0) throw httpError('Refund could not be allocated to the original payments', 409);
  return allocations;
}

/**
 * Issues a full or partial refund against an order.
 *
 * The order only becomes 'refunded' once every rupee taken has been returned;
 * a partial refund leaves it completed with a running refundAmount so the till
 * can still see what was settled.
 */
/**
 * Phase 12: refuse to close a ticket that is still holding the guest's money.
 *
 * Cancelling a part-paid order used to succeed and leave the cash banked with
 * no refund path left — `refundOrder()` then refused because the order was
 * cancelled. The money was stranded: not the restaurant's, not returned.
 * Refund first, then cancel.
 */
export async function assertNoStrandedMoney(order, {session} = {}) {
  const payments = await Payment.find({order: order._id}).session(session || null);
  const outstanding = refundableAmount(payments);
  if (outstanding > 0) {
    throw httpError(
      `This order still holds ${outstanding} of the guest's money; refund it before closing the ticket`,
      409
    );
  }
  return outstanding;
}

export async function refundOrder({orderId, amount, reason, user, session, idempotencyKey}) {
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  await assertTenantBranchAccess(user, order.branch, {session});

  // A cancelled ticket normally has nothing to refund: assertNoStrandedMoney()
  // now blocks the cancel while money is still held, and its stock was already
  // reversed by the cancel. Rows cancelled BEFORE that guard existed can still
  // be holding the guest's cash, so a cancelled order is refundable rather
  // than a dead end — money only, since REFUND_CLOSES_FROM excludes it and the
  // stock reversal has already happened. An order with nothing left to refund
  // still fails below on `refundable <= 0`.
  if (!REFUNDABLE_STATUSES.includes(order.status)) {
    throw httpError('This order cannot be refunded', 409);
  }

  const payments = await Payment.find({order: order._id}).sort({createdAt: 1}).session(session || null);
  const refundable = refundableAmount(payments);
  if (refundable <= 0) throw httpError('This order has nothing left to refund', 409);

  // Phase 12: money leaving the till must always name a why. Previously a
  // reason was optional, so a refund could be issued with no explanation at
  // all and the audit row carried nothing an auditor could act on. Checked
  // after the state guards so an unrefundable order still answers 409.
  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to refund a payment', 400);

  // No amount means refund whatever is left.
  const target = amount === undefined || amount === null ? refundable : money(amount);
  if (!(target > 0)) throw httpError('Refund amount must be greater than zero', 400);
  if (target > refundable) throw httpError('Refund exceeds the amount paid on this order', 400);

  // 11F: a replayed refund key returns the original rows instead of refunding
  // again. Without this a retried request paid the guest back twice.
  const key = String(idempotencyKey || '').trim();
  if (key) {
    const existing = await Payment.find({order: order._id, idempotencyKey: key})
      .session(session || null);
    if (existing.length) {
      return {order, refunds: existing, replayed: true};
    }
  }

  const allocations = allocateRefund(payments, target);

  const created = [];
  for (const allocation of allocations) {
    const [row] = await Payment.create([{
      order: order._id,
      // P1B: a refund is money too, and carries the same tenant as its order.
      restaurant: order.restaurant,
      branch: order.branch,
      amount: money(-allocation.amount),
      method: allocation.method,
      status: 'refunded',
      refundOf: allocation.payment._id,
      reason: note || undefined,
      cashier: user.id,
      ...(key ? {idempotencyKey: key} : {})
    }], {session: session || undefined});
    created.push(row);
    // Mark the original as refunded only once it is fully reversed.
    const reversedSoFar = money(refundedAgainst(payments, allocation.payment._id) + allocation.amount);
    if (reversedSoFar >= money(allocation.payment.amount)) {
      await Payment.updateOne({_id: allocation.payment._id}, {$set: {status: 'refunded'}}, {session: session || undefined});
    }
  }

  const beforeStatus = order.status;
  const totalRefunded = money(refundedTotal(payments) + target);
  order.refundAmount = totalRefunded;
  order.paidAmount = money(Math.max(0, Number(order.paidAmount || 0) - target));
  order.dueAmount = money(Math.max(0, Number(order.total || 0) - order.paidAmount));

  // "Fully refunded" means every rupee still refundable has gone back. Stated
  // against `refundable` rather than `paidAmount` because that is what the
  // payment rows actually say; the two agree, and pinning it to one of them
  // keeps a single source of truth.
  const fullyRefunded = money(refundable - target) <= 0;
  // Only a settled ticket closes as refunded. Refunding a deposit on a ticket
  // the kitchen is still cooking leaves it live with the balance owing again.
  const closes = fullyRefunded && REFUND_CLOSES_FROM.includes(beforeStatus);
  if (closes) order.status = 'refunded';

  // Phase 12: a FULL refund voids the sale, so the ingredients go back the way
  // a cancellation returns them — through reverseOrderStock(), which reverses
  // the immutable RECIPE_DEDUCTION rows against their original batches. A
  // PARTIAL refund is money only: the food still left the kitchen.
  let inventoryReversed = false;
  if (closes && order.inventoryDeducted && !order.inventoryReversed) {
    const context = await userRestaurantContext(user, {session});
    await reverseOrderStock({
      order, status: 'refunded', user: context.userId, restaurantId: context.restaurantId
    }, session);
    order.inventoryReversed = true;
    inventoryReversed = true;
  }
  await order.save({session: session || undefined});

  await Audit.create([{
    entity: 'order',
    entityId: order._id,
    branch: order.branch,
    action: 'order_refund',
    before: {status: beforeStatus, paidAmount: money(Number(order.paidAmount) + target)},
    after: {
      amount: target,
      refundAmount: order.refundAmount,
      paidAmount: order.paidAmount,
      status: order.status,
      fullyRefunded,
      inventoryReversed,
      methods: allocations.map(a => ({method: a.method, amount: a.amount}))
    },
    reason: note,
    user: user.id
  }], {session: session || undefined});

  return {
    order,
    refunds: created,
    amount: target,
    fullyRefunded,
    inventoryReversed,
    remainingRefundable: money(refundable - target)
  };
}

function refundedAgainst(payments, paymentId) {
  return money(payments
    .filter(p => Number(p.amount) < 0 && String(p.refundOf || '') === String(paymentId))
    .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0));
}

/** Payment summary for an order: what was taken, by which tender, and what is left. */
/**
 * 11F: reverse a payment that should never have been recorded.
 *
 * Distinct from a refund. A refund is money genuinely returned to a guest and
 * must remain on the record for reconciliation. A reversal corrects a till
 * MISTAKE — wrong tender, wrong amount, wrong order — and puts the balance
 * back so the correct payment can be taken.
 *
 * Deliberately narrow: owners only, never a payment that has already been
 * refunded, and never on a settled-and-closed order that has moved on. The
 * original row is kept and marked, so the correction is auditable rather than
 * erased.
 */
export async function reversePayment({paymentId, reason, user, session}) {
  const note = clean(reason);
  if (note.length < 3) throw httpError('A reason is required to reverse a payment', 400);

  const payment = await Payment.findById(paymentId).session(session || null);
  if (!payment) throw httpError('Payment not found', 404);
  if (payment.amount < 0 || payment.refundOf) {
    throw httpError('A refund row cannot be reversed', 409);
  }
  if (payment.reversedAt) throw httpError('This payment is already reversed', 409);
  if (payment.status === 'refunded') {
    throw httpError('A refunded payment cannot be reversed; it was money genuinely returned', 409);
  }

  const order = await Order.findById(payment.order).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  await assertTenantBranchAccess(user, order.branch, {session});

  // Anything already given back against this tender makes a reversal
  // ambiguous, so it is refused rather than guessed at.
  const siblings = await Payment.find({order: order._id}).session(session || null);
  if (refundedAgainst(siblings, payment._id) > 0) {
    throw httpError('This payment has been partly refunded and cannot be reversed', 409);
  }

  payment.reversedAt = new Date();
  payment.reversedBy = user.id;
  payment.reversalReason = note;
  payment.status = 'reversed';
  await payment.save({session: session || undefined});

  const amount = money(payment.amount);
  order.paidAmount = money(Math.max(0, Number(order.paidAmount || 0) - amount));
  order.dueAmount = money(Math.max(0, Number(order.total || 0) - Number(order.paidAmount)));
  // The bill is open again, so it must not still read as settled.
  if (order.dueAmount > 0 && order.status === 'completed') {
    order.status = 'confirmed';
    order.completedAt = null;
  }
  await order.save({session: session || undefined});

  await Audit.create([{
    entity: 'payment', entityId: payment._id, branch: order.branch,
    action: 'payment_reversed',
    before: {amount, method: payment.method, status: 'paid'},
    after: {reason: note, dueAmount: order.dueAmount},
    user: user.id
  }], {session: session || undefined});

  return {payment, order};
}

export function summarisePayments(order, payments = []) {
  const byMethod = {};
  for (const payment of payments) {
    const key = payment.method || 'cash';
    byMethod[key] = money((byMethod[key] || 0) + Number(payment.amount));
  }
  const taken = money(settledPayments(payments).reduce((sum, p) => sum + Number(p.amount), 0));
  const refunded = refundedTotal(payments);
  return {
    total: money(order.total),
    paid: money(order.paidAmount),
    due: money(order.dueAmount),
    taken,
    refunded,
    refundable: money(Math.max(0, taken - refunded)),
    // Whether the check is square. Previously absent, so callers reading
    // `settled` silently got undefined.
    settled: money(order.dueAmount) <= 0,
    byMethod,
    count: payments.length
  };
}
