import {Audit} from '../models/index.js';
import {Order, Payment} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {money} from './billing.js';

// Phase 4D — Payments: refunds.
//
// A refund reverses money that was actually taken, so it works against the
// order's settled payments rather than its total. Each reversal is written as
// its own Payment row with a negative amount, which keeps the payment ledger
// append-only: the original row is never rewritten, and the sum of all rows for
// an order always equals what the guest is currently out of pocket.

export const REFUNDABLE_STATUSES = Object.freeze(['completed', 'refunded']);

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

/** Payments that represent money in (excludes prior refund rows). */
export function settledPayments(payments = []) {
  return payments.filter(p => Number(p.amount) > 0 && p.status !== 'failed');
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
export async function refundOrder({orderId, amount, reason, user, session}) {
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  await assertTenantBranchAccess(user, order.branch, {session});

  if (order.status === 'cancelled') throw httpError('A cancelled order cannot be refunded', 409);
  if (!REFUNDABLE_STATUSES.includes(order.status)) {
    throw httpError('Only a settled order can be refunded', 409);
  }

  const payments = await Payment.find({order: order._id}).sort({createdAt: 1}).session(session || null);
  const refundable = refundableAmount(payments);
  if (refundable <= 0) throw httpError('This order has nothing left to refund', 409);

  // No amount means refund whatever is left.
  const target = amount === undefined || amount === null ? refundable : money(amount);
  if (!(target > 0)) throw httpError('Refund amount must be greater than zero', 400);
  if (target > refundable) throw httpError('Refund exceeds the amount paid on this order', 400);

  const allocations = allocateRefund(payments, target);
  const note = clean(reason);

  const created = [];
  for (const allocation of allocations) {
    const [row] = await Payment.create([{
      order: order._id,
      amount: money(-allocation.amount),
      method: allocation.method,
      status: 'refunded',
      refundOf: allocation.payment._id,
      reason: note || undefined,
      cashier: user.id
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
  const fullyRefunded = order.paidAmount <= 0;
  if (fullyRefunded) order.status = 'refunded';
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
      methods: allocations.map(a => ({method: a.method, amount: a.amount}))
    },
    reason: note || undefined,
    user: user.id
  }], {session: session || undefined});

  return {
    order,
    refunds: created,
    amount: target,
    fullyRefunded,
    remainingRefundable: money(refundable - target)
  };
}

function refundedAgainst(payments, paymentId) {
  return money(payments
    .filter(p => Number(p.amount) < 0 && String(p.refundOf || '') === String(paymentId))
    .reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0));
}

/** Payment summary for an order: what was taken, by which tender, and what is left. */
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
