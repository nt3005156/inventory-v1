import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Order, Payment} from '../models/operations.js';
import {assertTenantBranchAccess} from '../services/kitchen.js';
import {applyPayment, splitOrder} from '../services/billing.js';
import {refundOrder, summarisePayments} from '../services/refunds.js';
import {getReceipt, renderReceiptHtml} from '../services/receipts.js';
import {publishKitchenOrder, publishTableEvent} from '../services/realtime.js';

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

r.get('/orders/:id', auth(roles), async (req, res) => {
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

r.get('/orders/:id/payments', auth(roles), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({message: 'Order not found'});
    await assertTenantBranchAccess(req.user, order.branch);
    res.json(await Payment.find({order: order._id}).sort({createdAt: 1}));
  } catch (e) {
    fail(res, e);
  }
});

r.post('/orders/:id/payments', auth(roles), async (req, res) => {
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
        session
      });
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    if (result.order?.table) publishTableEvent(result.order.branch, {reason: 'payment', tableIds: [String(result.order.table)]});
    res.status(201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

// Refunds move money out of the till, so they are a supervisor action.
r.post('/orders/:id/refunds', auth(['owner', 'manager']), async (req, res) => {
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
        session
      });
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    if (result.order?.table) {
      publishTableEvent(result.order.branch, {reason: 'refund', tableIds: [String(result.order.table)]});
    }
    res.status(201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.get('/orders/:id/payment-summary', auth(roles), async (req, res) => {
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
r.get('/orders/:id/receipt', auth(roles), async (req, res) => {
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

r.post('/orders/:id/split', auth(roles), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = splitSchema.parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await splitOrder({orderId: req.params.id, items: body.items, user: req.user, session});
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    await publishKitchenOrder(result.splitOrder, 'kitchen:new-order');
    if (result.order?.table) publishTableEvent(result.order.branch, {reason: 'split', tableIds: [String(result.order.table)]});
    res.status(201).json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

export default r;
