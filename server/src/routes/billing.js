import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Order, Payment} from '../models/operations.js';
import {assertBranchAccess} from '../services/kitchen.js';
import {applyPayment, splitOrder} from '../services/billing.js';
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

const splitSchema = z.object({
  items: z.array(z.object({itemId: z.string(), qty: z.number().positive()})).min(1)
});

r.get('/orders/:id', auth(roles), async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate('table', 'name area seats status').populate('customer', 'name phone');
    if (!order) return res.status(404).json({message: 'Order not found'});
    assertBranchAccess(req.user, order.branch);
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
    assertBranchAccess(req.user, order.branch);
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
