import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {Order, Payment} from '../models/operations.js';
import {assertTenantBranchAccess} from '../services/kitchen.js';
import {applyPayment, splitOrder, quoteEqualSplit, buildTableBill} from '../services/billing.js';
import {refundOrder, reversePayment, summarisePayments} from '../services/refunds.js';
import {refreshCustomerStatsSafe} from '../services/customers.js';
import {getReceipt, renderReceiptHtml} from '../services/receipts.js';
import {publishKitchenOrder, publishOrderEvent, publishPaymentEvent, publishTableEvent} from '../services/realtime.js';

const r = Router();
const roles = ['owner', 'manager', 'staff'];
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

const paySchema = z.object({
  amount: z.number().positive().optional(),
  method: z.enum(['cash', 'card', 'esewa', 'khalti', 'wallet', 'online']),
  transactionId: z.string().optional(),
  items: z.array(z.object({itemId: z.string(), qty: z.number().positive()})).optional()
}).refine(x => x.amount || (x.items && x.items.length), {message: 'Payment amount or items are required'});

const refundSchema = z.object({
  amount: z.number().positive().optional(),
  reason: z.string().trim().max(300).optional()
}).strict();

const splitSchema = z.object({
  items: z.array(z.object({itemId: z.string(), qty: z.number().positive()})).min(1)
});

r.get('/orders/:id', requirePermission('orders.view'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('table', 'name area seats status').populate('customer', 'name phone');
    if (!order) return res.status(404).json({message: 'Order not found'});
    await assertTenantBranchAccess(req.user, order.branch);
    const payments = await Payment.find({order: order._id}).sort({createdAt: 1});
    res.json({...order.toJSON(), payments});
  } catch (e) {
    fail(res, e);
  }
});

r.get('/orders/:id/payments', requirePermission('orders.view'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({message: 'Order not found'});
    await assertTenantBranchAccess(req.user, order.branch);
    res.json(await Payment.find({order: order._id}).sort({createdAt: 1}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/orders/:id/payments', requirePermission('payments.take'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = paySchema.parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await applyPayment({
        orderId: req.params.id,
        amount: body.amount,
        method: body.method,
        transactionId: body.transactionId,
        items: body.items,
        user: req.user,
        session,
        idempotencyKey: req.headers['idempotency-key']
      });
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    // Phase 22: money moving is broadcast. The idempotency key doubles as the
    // event id, so a retried request republishes the SAME event id and a
    // client that already applied it discards the duplicate.
    publishPaymentEvent(result.order?.branch, {
      reason: 'payment',
      order: String(result.order?._id || ''),
      orderNo: result.order?.orderNo || null,
      amount: body.amount,
      method: body.method,
      paidAmount: result.order?.paidAmount ?? null,
      dueAmount: result.order?.dueAmount ?? null,
      settled: Number(result.order?.dueAmount || 0) <= 0
    }, {idempotencyKey: req.headers['idempotency-key']});
    if (result.order?.table) publishTableEvent(result.order.branch, {reason: 'payment', tableIds: [String(result.order.table)]});
    // Phase 9: CRM rollups refresh after the money is committed, never inside
    // the transaction — a reporting figure must not be able to fail a sale.
    await refreshCustomerStatsSafe(result.order?.customer);
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

// Refunds move money out of the till, so they are a supervisor action.
r.post('/orders/:id/refunds', requirePermission('orders.refund'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = refundSchema.parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await refundOrder({
        orderId: req.params.id,
        amount: body.amount,
        reason: body.reason,
        user: req.user,
        session,
        idempotencyKey: req.headers['idempotency-key']
      });
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    publishPaymentEvent(result.order?.branch, {
      reason: 'refund',
      order: String(result.order?._id || ''),
      orderNo: result.order?.orderNo || null,
      amount: body.amount,
      refundAmount: result.order?.refundAmount ?? null,
      status: result.order?.status || null
    }, {idempotencyKey: req.headers['idempotency-key']});
    publishOrderEvent(result.order?.branch, {
      reason: 'refund', order: String(result.order?._id || ''), status: result.order?.status || null
    }, {idempotencyKey: req.headers['idempotency-key']});
    if (result.order?.table) {
      publishTableEvent(result.order.branch, {reason: 'refund', tableIds: [String(result.order.table)]});
    }
    // A refund changes lifetime spend, so the profile must not keep showing
    // revenue the restaurant gave back.
    await refreshCustomerStatsSafe(result.order?.customer);
    res.status(result.replayed ? 200 : 201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

/**
 * 11F: reverse a payment taken by mistake (wrong tender, wrong amount).
 *
 * Owner-only, and deliberately distinct from a refund: a refund is money
 * genuinely returned to a guest and stays on the record, whereas a reversal
 * corrects a till error and reopens the balance. The original row is kept and
 * marked, never deleted.
 */
r.post('/payments/:id/reverse', requirePermission('payments.reverse'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = z.object({reason: z.string().trim().min(3).max(300)}).strict().parse(req.body || {});
    let result;
    await session.withTransaction(async () => {
      result = await reversePayment({
        paymentId: req.params.id, reason: body.reason, user: req.user, session
      });
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    publishPaymentEvent(result.order?.branch, {
      reason: 'reversal',
      order: String(result.order?._id || ''),
      orderNo: result.order?.orderNo || null,
      payment: String(req.params.id),
      dueAmount: result.order?.dueAmount ?? null
    });
    await refreshCustomerStatsSafe(result.order?.customer);
    res.json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.get('/orders/:id/payment-summary', requirePermission('orders.view'), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({message: 'Order not found'});
    await assertTenantBranchAccess(req.user, order.branch);
    const payments = await Payment.find({order: order._id}).sort({createdAt: 1});
    res.json(summarisePayments(order, payments));
  } catch (e) {
    fail(res, e);
  }
});

// Receipt / tax invoice. `issue=true` (or format=html) allocates the invoice
// number on first print and records the reprint count.
r.get('/orders/:id/receipt', requirePermission('invoices.issue'), async (req, res) => {
  const wantsHtml = String(req.query.format || '').toLowerCase() === 'html';
  const issue = wantsHtml || String(req.query.issue || '') === 'true';
  const session = await mongoose.startSession();
  try {
    let receipt;
    if (issue) {
      await session.withTransaction(async () => {
        receipt = await getReceipt({orderId: req.params.id, user: req.user, issue: true, session});
      });
    } else {
      receipt = await getReceipt({orderId: req.params.id, user: req.user, issue: false});
    }
    if (wantsHtml) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      return res.send(renderReceiptHtml(receipt));
    }
    res.json(receipt);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

// Quotes an n-way split of the outstanding balance. This is a calculation, not
// a mutation: the till shows each guest their share, then takes payments
// through the existing payments endpoint so there is one payment code path.
r.post('/orders/:id/split-equal', requirePermission('orders.create'), async (req, res) => {
  try {
    const body = z.object({ways: z.number().int().min(2).max(50)}).strict().parse(req.body);
    res.json(await quoteEqualSplit({orderId: req.params.id, ways: body.ways, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

// Combined billing position for a table, which may carry several checks.
r.get('/tables/:id/bill', requirePermission('tables.view'), async (req, res) => {
  try {
    res.json(await buildTableBill({tableId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/orders/:id/split', requirePermission('orders.create'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = splitSchema.parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await splitOrder({orderId: req.params.id, items: body.items, user: req.user, session});
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    await publishKitchenOrder(result.splitOrder, 'kitchen:new-order');
    publishOrderEvent(result.order?.branch, {
      reason: 'split',
      order: String(result.order?._id || ''),
      splitOrder: String(result.splitOrder?._id || '')
    });
    if (result.order?.table) publishTableEvent(result.order.branch, {reason: 'split', tableIds: [String(result.order.table)]});
    res.status(201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

export default r;
