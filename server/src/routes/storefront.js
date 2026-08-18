import {Router} from 'express';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {Order} from '../models/operations.js';
import {assertTenantBranchAccess} from '../services/kitchen.js';
import {publishKitchenOrder} from '../services/realtime.js';
import {
  ONLINE_PAYMENT_METHODS,
  ONLINE_ORDER_TYPES,
  getPublicMenu,
  listPublicBranches,
  placePublicOrder,
  priceCart,
  trackPublicOrder
} from '../services/storefront.js';

const r = Router();
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

// This is the only unauthenticated write path in the system, so it carries its
// own abuse controls. Reads are looser than writes; placing an order is the
// expensive operation and is limited hardest.
//
// Limits are disabled under NODE_ENV=test: a suite legitimately places dozens
// of orders in seconds, and throttling it would test the limiter rather than
// the behaviour. The limiter itself is covered by a dedicated test that builds
// its own limited app.
// The env var is read per request, not at module load: ES imports are hoisted,
// so a test harness that sets NODE_ENV cannot win a load-time race.
const limiter = options => {
  const live = rateLimit({standardHeaders: true, legacyHeaders: false, ...options});
  return (req, res, next) => (process.env.NODE_ENV === 'test' ? next() : live(req, res, next));
};

export const PUBLIC_RATE_LIMITS = Object.freeze({
  browse: {windowMs: 60_000, max: 120},
  quote: {windowMs: 60_000, max: 30},
  order: {windowMs: 15 * 60_000, max: 8},
  track: {windowMs: 60_000, max: 20}
});

const browseLimit = limiter(PUBLIC_RATE_LIMITS.browse);
const quoteLimit = limiter(PUBLIC_RATE_LIMITS.quote);
const orderLimit = limiter(PUBLIC_RATE_LIMITS.order);
const trackLimit = limiter(PUBLIC_RATE_LIMITS.track);

const modifierSchema = z.object({
  group: z.string().min(1).max(40),
  option: z.string().min(1).max(40)
}).strict();

const cartLineSchema = z.object({
  menuItem: z.string().min(1),
  qty: z.number().int().min(1).max(20),
  modifiers: z.array(modifierSchema).max(30).optional(),
  specialInstructions: z.string().trim().max(500).optional()
}).strict();

const checkoutSchema = z.object({
  branch: z.string().min(1),
  type: z.enum(ONLINE_ORDER_TYPES),
  items: z.array(cartLineSchema).min(1).max(30),
  customer: z.object({
    name: z.string().trim().min(2).max(120),
    phone: z.string().trim().min(7).max(30),
    email: z.string().trim().max(160).optional()
  }).strict(),
  address: z.string().trim().max(500).optional(),
  paymentMethod: z.enum(ONLINE_PAYMENT_METHODS),
  notes: z.string().trim().max(500).optional()
}).strict();

// ── Public (no authentication) ───────────────────────────────────────────────

r.get('/public/branches', browseLimit, async (_req, res) => {
  try {
    res.json({branches: await listPublicBranches()});
  } catch (e) {
    fail(res, e);
  }
});

r.get('/public/menu', browseLimit, async (req, res) => {
  try {
    res.json(await getPublicMenu({branchId: req.query.branch}));
  } catch (e) {
    fail(res, e);
  }
});

/** Prices a cart without placing it, so the storefront can show a live total. */
r.post('/public/quote', quoteLimit, async (req, res) => {
  try {
    const body = z.object({
      branch: z.string().min(1),
      type: z.enum(ONLINE_ORDER_TYPES),
      items: z.array(cartLineSchema).min(1).max(30),
      address: z.string().trim().max(500).optional()
    }).strict().parse(req.body);

    const {totals, lines, branch} = await priceCart({
      branchId: body.branch, type: body.type, items: body.items, deliveryAddress: body.address
    });
    res.json({
      branch: {id: branch._id, name: branch.name},
      currency: 'NPR',
      lines: lines.map(l => ({
        name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal,
        modifiers: (l.modifiers || []).map(m => m.name)
      })),
      subtotal: totals.subtotal,
      vatRate: totals.vatRate,
      vat: totals.vat,
      deliveryFee: totals.deliveryFee,
      total: totals.total
    });
  } catch (e) {
    fail(res, e);
  }
});

r.post('/public/orders', orderLimit, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const input = checkoutSchema.parse(req.body);
    let result;
    await session.withTransaction(async () => {
      result = await placePublicOrder({input, session});
    });
    // The kitchen sees it immediately, but as an unconfirmed ticket.
    await publishKitchenOrder(result.order, 'kitchen:new-order');
    res.status(201).json({
      orderNo: result.order.orderNo,
      status: result.order.status,
      total: result.order.total,
      paymentMethod: input.paymentMethod,
      // Honest about what has and has not happened with money.
      paymentStatus: input.paymentMethod === 'cod' ? 'due_on_delivery' : 'awaiting_payment',
      placedAt: result.order.createdAt
    });
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

/** Order tracking. Requires the phone too, so orders are not enumerable. */
r.get('/public/orders/track', trackLimit, async (req, res) => {
  try {
    res.json(await trackPublicOrder({orderNo: req.query.orderNo, phone: req.query.phone}));
  } catch (e) {
    fail(res, e);
  }
});

// ── Staff side of online ordering (authenticated) ────────────────────────────

/** The queue of web orders awaiting a decision. */
r.get('/online-orders', auth(['owner', 'manager', 'staff']), async (req, res) => {
  try {
    const branchId = req.query.branch;
    if (!branchId) throw Object.assign(new Error('Branch is required'), {status: 400});
    await assertTenantBranchAccess(req.user, branchId);
    const match = {branch: branchId, source: 'online'};
    if (req.query.pending === 'true') match.status = 'pending';
    const orders = await Order.find(match)
      .sort({createdAt: -1}).limit(100)
      .populate('customer', 'name phone')
      .lean();
    res.json({
      branch: String(branchId),
      pending: orders.filter(o => o.status === 'pending').length,
      orders
    });
  } catch (e) {
    fail(res, e);
  }
});

/**
 * Accepting a web order is what commits it: only here does the branch take
 * responsibility, so this is where the ticket enters the kitchen properly.
 */
r.post('/online-orders/:id/accept', auth(['owner', 'manager', 'staff']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    let order;
    await session.withTransaction(async () => {
      order = await Order.findById(req.params.id).session(session);
      if (!order) throw Object.assign(new Error('Order not found'), {status: 404});
      if (order.source !== 'online') throw Object.assign(new Error('Not an online order'), {status: 409});
      await assertTenantBranchAccess(req.user, order.branch, {session});
      if (order.status !== 'pending') {
        throw Object.assign(new Error(`This order is already ${order.status}`), {status: 409});
      }
      order.status = 'confirmed';
      order.acceptedOnlineAt = new Date();
      await order.save({session});
      await Audit.create([{
        entity: 'order', entityId: order._id, branch: order.branch,
        action: 'online_order_accepted', after: {status: 'confirmed'}, user: req.user.id
      }], {session});
    });
    await publishKitchenOrder(order, 'kitchen:status');
    res.json(order);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.post('/online-orders/:id/reject', auth(['owner', 'manager']), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = z.object({reason: z.string().trim().max(300).optional()}).strict().parse(req.body ?? {});
    let order;
    await session.withTransaction(async () => {
      order = await Order.findById(req.params.id).session(session);
      if (!order) throw Object.assign(new Error('Order not found'), {status: 404});
      if (order.source !== 'online') throw Object.assign(new Error('Not an online order'), {status: 409});
      await assertTenantBranchAccess(req.user, order.branch, {session});
      if (order.status !== 'pending') {
        throw Object.assign(new Error(`This order is already ${order.status}`), {status: 409});
      }
      // No stock was deducted for an unaccepted order, so nothing to reverse.
      order.status = 'cancelled';
      order.rejectedOnlineAt = new Date();
      order.rejectionReason = body.reason;
      await order.save({session});
      await Audit.create([{
        entity: 'order', entityId: order._id, branch: order.branch,
        action: 'online_order_rejected', after: {status: 'cancelled'},
        reason: body.reason, user: req.user.id
      }], {session});
    });
    await publishKitchenOrder(order, 'kitchen:status');
    res.json(order);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

export default r;
