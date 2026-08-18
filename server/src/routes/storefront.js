import {Router} from 'express';
import mongoose from 'mongoose';
import {createRateLimiter} from '../services/rateLimiting.js';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {Order} from '../models/operations.js';
import {assertTenantBranchAccess} from '../services/kitchen.js';
import {publishKitchenOrder, publishInventoryEvent} from '../services/realtime.js';
import {moveStock} from '../services/inventoryLedger.js';
import {
  ONLINE_PAYMENT_METHODS,
  ONLINE_ORDER_TYPES,
  getPublicMenu,
  listPublicBranches,
  findByRequestKey,
  placePublicOrder,
  priceCart,
  trackPublicOrder
} from '../services/storefront.js';

const r = Router();

/**
 * Hardening for the public surface.
 *
 * CORS itself is governed globally by CLIENT_URL, which production refuses to
 * start without (see services/startup.js), so the wildcard fallback only ever
 * applies in development. These headers add defence in depth for the endpoints
 * an anonymous visitor can reach: menu and order responses are per-guest and
 * must never be cached by a shared proxy, and none of them should ever be
 * framed, sniffed, or leaked via a referrer.
 */
r.use('/public', (_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});
/**
 * Public error responder.
 *
 * Anonymous callers get a safe, useful message and nothing else. Zod dumps its
 * internal error array (codes, paths, "inclusive"/"exact" flags) into
 * error.message, and Mongo/Mongoose errors carry query and schema detail —
 * neither belongs on a public endpoint.
 */
function publicFail(res, e) {
  const status = e?.status || (e?.name === 'ZodError' ? 400 : 400);
  let message = e?.message || 'Request failed';

  if (e?.name === 'ZodError' || /^\[\s*\{/.test(message)) {
    // Surface the first human-readable validation problem, not the array.
    const issue = Array.isArray(e?.issues) ? e.issues[0] : null;
    const field = issue?.path?.length ? issue.path.join('.') : null;
    message = field ? `Invalid ${field}` : 'Some details are missing or invalid';
  } else if (e?.name === 'MongoServerError' || e?.name === 'ValidationError' || e?.name === 'CastError') {
    message = 'We could not process that request';
  } else if (status >= 500) {
    message = 'Something went wrong. Please try again.';
  }
  // Never let a stack trace or internal path reach a guest.
  return res.status(status).json({message: String(message).slice(0, 200)});
}

const fail = (res, e) => publicFail(res, e);

// This is the only unauthenticated write path in the system, so it carries its
// own abuse controls. Reads are looser than writes; placing an order is the
// expensive operation and is limited hardest.
//
// Buckets are keyed by req.ip, which honours the audited `trust proxy` setting
// (services/deployment.js). Counters are per API instance — correct for the
// single-instance Compose deployment, and documented in README as requiring a
// shared store before running multiple API containers.
//
// Limits are disabled under NODE_ENV=test: a suite legitimately places dozens
// of orders in seconds, and throttling it would test the limiter rather than
// the behaviour. The limiter itself is covered by dedicated tests that build
// their own limited app. The predicate runs per request, not at module load:
// ES imports are hoisted, so a harness setting NODE_ENV cannot win that race.
const limiter = (name, options) =>
  createRateLimiter({name, ...options, enabled: () => process.env.NODE_ENV !== 'test'});

export const PUBLIC_RATE_LIMITS = Object.freeze({
  browse: {windowMs: 60_000, max: 120},
  quote: {windowMs: 60_000, max: 30},
  order: {windowMs: 15 * 60_000, max: 8},
  track: {windowMs: 60_000, max: 20}
});

const browseLimit = limiter('public:browse', PUBLIC_RATE_LIMITS.browse);
const quoteLimit = limiter('public:quote', PUBLIC_RATE_LIMITS.quote);
const orderLimit = limiter('public:order', PUBLIC_RATE_LIMITS.order);
const trackLimit = limiter('public:track', PUBLIC_RATE_LIMITS.track);


const clean = value => String(value ?? '').trim();

/**
 * The only order shape a guest ever sees. Centralised so a replayed request
 * returns exactly what the original did, and so no internal field can leak in
 * by accident.
 */
function publicOrderView(order, {paymentMethod, replayed = false} = {}) {
  const method = paymentMethod || order.paymentMethod || 'cod';
  return {
    orderNo: order.orderNo,
    status: order.status,
    total: order.total,
    paymentMethod: method,
    paymentStatus: method === 'cod' ? 'due_on_delivery' : 'awaiting_payment',
    placedAt: order.createdAt,
    ...(replayed ? {replayed: true} : {})
  };
}

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
  coupon: z.string().trim().max(40).optional(),
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
      address: z.string().trim().max(500).optional(),
      coupon: z.string().trim().max(40).optional()
    }).strict().parse(req.body);

    const {totals, lines, branch, couponAmount} = await priceCart({
      branchId: body.branch, type: body.type, items: body.items,
      deliveryAddress: body.address, couponCode: body.coupon
    });
    res.json({
      branch: {id: branch._id, name: branch.name},
      currency: 'NPR',
      lines: lines.map(l => ({
        name: l.name, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal,
        modifiers: (l.modifiers || []).map(m => m.name)
      })),
      subtotal: totals.subtotal,
      discount: totals.discount || 0,
      couponDiscount: couponAmount || 0,
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
    // A double-click or a retry after a network timeout must not buy twice.
    const requestKey = clean(req.get('Idempotency-Key')).slice(0, 120) || undefined;

    if (requestKey) {
      const existing = await findByRequestKey(requestKey);
      if (existing) return res.status(200).json(publicOrderView(existing, {replayed: true}));
    }

    let result;
    try {
      await session.withTransaction(async () => {
        result = await placePublicOrder({input, requestKey, session});
      });
    } catch (error) {
      // Two concurrent submissions raced; the unique index rejected the loser.
      // Return the order that won, so the guest still sees one order.
      if (error?.code === 11000 && requestKey) {
        const winner = await findByRequestKey(requestKey);
        if (winner) return res.status(200).json(publicOrderView(winner, {replayed: true}));
      }
      throw error;
    }
    // The kitchen sees it immediately, but as an unconfirmed ticket.
    await publishKitchenOrder(result.order, 'kitchen:new-order');
    res.status(201).json(publicOrderView(result.order, {paymentMethod: input.paymentMethod}));
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
      // Acceptance is the commitment point: this is where the branch takes
      // responsibility, so this is where stock actually moves. Inside the
      // transaction, so a concurrent accept cannot oversell.
      if (!order.inventoryDeducted) {
        const {InventoryBalance} = await import('../models/operations.js');
        const required = new Map();
        for (const line of order.items || []) {
          for (const requirement of line.inventoryRequirements || []) {
            const key = String(requirement.ingredient);
            const current = required.get(key) || {ingredient: requirement.ingredient, unit: requirement.unit, qty: 0};
            current.qty += Number(requirement.qty || 0) * Number(line.qty || 0);
            required.set(key, current);
          }
        }
        for (const need of required.values()) {
          const balance = await InventoryBalance.findOne({branch: order.branch, ingredient: need.ingredient}).session(session);
          if (!balance || Number(balance.quantity || 0) + 1e-9 < need.qty) {
            throw Object.assign(new Error('Insufficient stock to accept this order'), {status: 409});
          }
        }
        for (const need of required.values()) {
          if (Math.abs(need.qty) <= 1e-9) continue;
          await moveStock({
            branch: order.branch, ingredient: need.ingredient, qty: -need.qty, unit: need.unit,
            type: 'RECIPE_DEDUCTION', reason: `${order.orderNo} accepted online`,
            referenceType: 'order', referenceId: order._id, user: req.user.id,
            idempotencyKey: `online:${order._id}:${need.ingredient}`
          }, session);
        }
        order.inventoryDeducted = true;
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
    publishInventoryEvent(order.branch, {reason: 'online_order_accepted', orderId: String(order._id)});
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
