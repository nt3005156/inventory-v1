import {Audit} from '../models/index.js';
import {Order, Payment} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {OPEN_ORDER_STATUSES, releaseTable} from './tables.js';
import {computeOrderTotals, priceLine} from './pos.js';
import {stampStage} from './kds.js';

const CLOSED = ['completed', 'cancelled', 'refunded'];

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function money(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Re-prices an order after its lines change (split, void, quantity edit).
// Mirrors the Phase 4A POS engine so a split check totals exactly like the
// original ticket: VAT-inclusive lines keep the tax inside the menu price, and
// the dine-in service charge is recomputed from its stored rate.
export function recountOrder(order) {
  const vatRate = Number(order.vatRate ?? 13);
  const lines = (order.items || []).map(item => {
    const line = priceLine({
      unitPrice: item.unitPrice,
      qty: item.qty,
      vatInclusive: item.vatInclusive === true,
      vatRate
    });
    // Phase 4C: a line's own discount survives splits and re-counts. It is
    // rescaled with the quantity so half a discounted line carries half the
    // discount rather than the whole of it.
    const stored = Number(item.discount || 0);
    if (stored <= 0) return {...line, discount: 0, discountedNet: line.lineNet};
    const discount = item.discountKind === 'percentage'
      ? money(line.lineNet * Number(item.discountValue || 0) / 100)
      : money(Math.min(stored, line.lineNet));
    return {...line, discount, discountedNet: money(line.lineNet - discount)};
  });
  (order.items || []).forEach((item, i) => {
    item.lineNet = lines[i].lineNet;
    item.lineVat = lines[i].lineVat;
    item.lineTotal = lines[i].lineGross;
    if (Number(item.discount || 0) > 0) item.discount = lines[i].discount;
  });
  const totals = computeOrderTotals({
    lines,
    discount: order.discount || 0,
    serviceChargeRate: order.serviceChargeRate || 0,
    deliveryFee: order.deliveryFee || 0,
    vatRate
  });
  order.subtotal = totals.subtotal;
  order.itemDiscount = totals.itemDiscount;
  order.discountTotal = totals.discountTotal;
  order.vat = totals.vat;
  order.serviceCharge = totals.serviceCharge;
  order.total = totals.total;
  order.dueAmount = money(Math.max(0, order.total - Number(order.paidAmount || 0)));
  return order;
}

export function shareForItems(order, picks) {
  const subtotal = (order.items || []).reduce((s, i) => s + Number(i.qty || 0) * Number(i.unitPrice || 0), 0);
  if (subtotal <= 0) throw httpError('Order has no billable items', 409);
  let net = 0;
  for (const pick of picks) {
    const line = order.items.id(pick.itemId);
    if (!line) throw httpError('Split item not found on this order', 404);
    const qty = Number(pick.qty);
    if (!(qty > 0) || qty > line.qty) throw httpError('Split quantity exceeds the line quantity', 409);
    net += qty * Number(line.unitPrice || 0);
  }
  return money((net / subtotal) * Number(order.total || 0));
}

async function loadOpenOrder(orderId, user, session) {
  const order = await Order.findById(orderId).session(session || null);
  if (!order) throw httpError('Order not found', 404);
  await assertTenantBranchAccess(user, order.branch, {session});
  return order;
}

export async function applyPayment({orderId, amount, method, transactionId, items, user, session, idempotencyKey}) {
  const order = await loadOpenOrder(orderId, user, session);
  if (CLOSED.includes(order.status) && Number(order.dueAmount || 0) <= 0) {
    throw httpError('Order is already closed', 409);
  }
  if (['cancelled', 'refunded'].includes(order.status)) throw httpError('Cannot pay a cancelled order', 409);
  let payAmount = amount == null ? null : money(amount);
  if (items?.length) {
    const share = shareForItems(order, items);
    if (payAmount == null) payAmount = share;
  }
  if (!(payAmount > 0)) throw httpError('Payment amount is required', 400);
  const due = money(order.dueAmount);
  if (payAmount > due) throw httpError('Payment exceeds due amount', 400);
  // 11F: a replayed key returns the original payment rather than banking a
  // second one. A cashier double-clicking "Pay" on a slow connection took the
  // money twice before this existed.
  const key = String(idempotencyKey || '').trim();
  if (key) {
    const existing = await Payment.findOne({order: order._id, idempotencyKey: key})
      .session(session || null);
    if (existing) return {payment: existing, order, replayed: true};
  }

  let payment;
  try {
    payment = (await Payment.create([{
      order: order._id,
      amount: payAmount,
      method,
      transactionId,
      cashier: user.id,
      status: 'paid',
      ...(key ? {idempotencyKey: key} : {})
    }], {session: session || undefined}))[0];
  } catch (error) {
    // Two concurrent requests with the same key: the unique index refuses the
    // loser, whose correct answer is the winner's payment.
    if (error?.code === 11000 && key) {
      const winner = await Payment.findOne({order: order._id, idempotencyKey: key})
        .session(session || null);
      if (winner) return {payment: winner, order, replayed: true};
    }
    throw error;
  }
  order.paidAmount = money(Number(order.paidAmount || 0) + payAmount);
  order.dueAmount = money(Math.max(0, Number(order.total || 0) - order.paidAmount));
  const justClosed = order.dueAmount <= 0;
  if (justClosed) {
    order.dueAmount = 0;
    order.status = 'completed';
    // Settlement is a completion path too; without this the ticket has no
    // completedAt and drops out of every kitchen performance metric.
    stampStage(order, 'completed');
  }
  await order.save({session: session || undefined});
  if (justClosed && order.table) {
    await releaseTable({tableId: order.table, userId: user.id, session, exceptOrderId: order._id});
  }
  await Audit.create([{
    entity: 'order',
    entityId: order._id,
    action: 'payment',
    before: {due},
    after: {amount: payAmount, method, paidAmount: order.paidAmount, dueAmount: order.dueAmount, status: order.status},
    user: user.id
  }], {session: session || undefined});
  return {payment, order};
}

export async function splitOrder({orderId, items, user, session}) {
  const parent = await loadOpenOrder(orderId, user, session);
  if (!OPEN_ORDER_STATUSES.includes(parent.status)) throw httpError('Only an open check can be split', 409);
  if (!items?.length) throw httpError('Split items are required', 400);

  const childItems = [];
  let remainingLines = 0;
  for (const line of parent.items) {
    const pick = items.find(i => String(i.itemId) === String(line._id));
    const take = pick ? Number(pick.qty) : 0;
    if (take < 0 || take > line.qty) throw httpError('Split quantity exceeds the line quantity', 409);
    if (take > 0) {
      childItems.push({
        menuItem: line.menuItem,
        name: line.name,
        qty: take,
        unitPrice: line.unitPrice,
        vatInclusive: line.vatInclusive === true,
        discount: line.discount,
        discountKind: line.discountKind,
        discountValue: line.discountValue,
        discountReason: line.discountReason,
        foodCost: line.foodCost,
        notes: line.notes,
        basePrice: line.basePrice,
        specialInstructions: line.specialInstructions,
        modifiers: line.modifiers,
        inventoryRequirements: line.inventoryRequirements
      });
      line.qty = money(line.qty - take);
    }
    if (line.qty > 0) remainingLines += 1;
  }
  if (!childItems.length) throw httpError('Select at least one item quantity to split', 400);
  if (!remainingLines) throw httpError('Split must leave at least one item on the original check', 409);
  parent.items = parent.items.filter(i => Number(i.qty) > 0);

  const priorPaid = money(parent.paidAmount);
  recountOrder(parent);
  if (priorPaid > parent.total) {
    parent.paidAmount = parent.total;
    parent.dueAmount = 0;
  } else {
    parent.paidAmount = priorPaid;
    parent.dueAmount = money(Math.max(0, parent.total - parent.paidAmount));
  }

  const child = new Order({
    orderNo: `${parent.orderNo}-${Date.now().toString().slice(-4)}`,
    branch: parent.branch,
    customer: parent.customer,
    table: parent.table,
    type: parent.type,
    status: parent.status,
    items: childItems,
    vatRate: parent.vatRate ?? 13,
    discount: 0,
    // A split check keeps the parent's channel, so it keeps that channel's
    // service charge; recountOrder recomputes the amount from this rate.
    serviceChargeRate: parent.serviceChargeRate || 0,
    serviceCharge: 0,
    deliveryFee: 0,
    paidAmount: 0,
    inventoryDeducted: parent.inventoryDeducted,
    inventoryReversed: false,
    inventorySourceOrder: parent.inventorySourceOrder || parent._id,
    inventorySourceOrders: parent.inventorySourceOrders?.length
      ? parent.inventorySourceOrders
      : [parent.inventorySourceOrder || parent._id],
    createdBy: user.id
  });
  recountOrder(child);
  const overflow = money(priorPaid - parent.paidAmount);
  if (overflow > 0) {
    child.paidAmount = Math.min(overflow, child.total);
    child.dueAmount = money(Math.max(0, child.total - child.paidAmount));
    if (child.dueAmount <= 0) {
      child.dueAmount = 0;
      child.status = 'completed';
      stampStage(child, 'completed');
    }
  }
  await parent.save({session: session || undefined});
  await child.save({session: session || undefined});
  if (parent.dueAmount <= 0 && OPEN_ORDER_STATUSES.includes(parent.status)) {
    parent.status = 'completed';
    stampStage(parent, 'completed');
    await parent.save({session: session || undefined});
  }
  if ((parent.status === 'completed' || child.status === 'completed') && parent.table) {
    await releaseTable({tableId: parent.table, userId: user.id, session});
  }
  await Audit.create([{
    entity: 'order',
    entityId: parent._id,
    action: 'bill_split',
    before: {orderNo: parent.orderNo},
    after: {child: child._id, childOrderNo: child.orderNo, parentTotal: parent.total, childTotal: child.total},
    user: user.id
  }], {session: session || undefined});
  return {order: parent, splitOrder: child};
}


/**
 * Divides an amount into `ways` shares that sum EXACTLY back to it.
 *
 * Naive division loses or invents paisa: 1740.20 / 3 = 580.0666..., and three
 * rounded shares of 580.07 collect 1740.21. Each share is floored to paisa and
 * the remainder is distributed one paisa at a time across the earliest shares,
 * so the split always reconciles to the cent.
 */
export function equalShares(total, ways) {
  const amount = money(total);
  const n = Number(ways);
  if (!Number.isInteger(n) || n < 2) throw httpError('Split must be between 2 and 50 ways', 400);
  if (n > 50) throw httpError('Split must be between 2 and 50 ways', 400);
  if (!(amount > 0)) throw httpError('Nothing left to split on this check', 409);

  const paisa = Math.round(amount * 100);
  const base = Math.floor(paisa / n);
  const remainder = paisa - base * n;
  return Array.from({length: n}, (_, i) => money((base + (i < remainder ? 1 : 0)) / 100));
}

/**
 * Quotes an equal split of what is still owed on a check.
 *
 * This is a calculation, not a mutation: the till shows the guests what each
 * owes, then takes payments against it with the existing payment endpoint. The
 * shares are computed from the OUTSTANDING balance, so a split after a partial
 * payment divides only what remains.
 */
export async function quoteEqualSplit({orderId, ways, user, session}) {
  const order = await loadOpenOrder(orderId, user, session);
  if (['cancelled', 'refunded'].includes(order.status)) {
    throw httpError('Cannot split a cancelled or refunded check', 409);
  }
  const due = money(order.dueAmount);
  if (!(due > 0)) throw httpError('This check is already settled', 409);

  const shares = equalShares(due, ways);
  return {
    order: order._id,
    orderNo: order.orderNo,
    total: money(order.total),
    paid: money(order.paidAmount),
    due,
    ways: shares.length,
    shares,
    // Proof the division reconciles; asserted by tests and useful on a receipt.
    sharesTotal: money(shares.reduce((sum, v) => sum + v, 0)),
    perShare: shares[0],
    currency: 'NPR'
  };
}

/**
 * The combined billing position for a table.
 *
 * A table can carry several checks once a bill has been split, and no single
 * order shows what the table as a whole still owes. This aggregates the open
 * and recently settled checks so a host can close the table confidently.
 */
export async function buildTableBill({tableId, user, session}) {
  const mongooseLib = (await import('mongoose')).default;
  const {RestaurantTable} = await import('../models/operations.js');
  if (!mongooseLib.isValidObjectId(tableId)) throw httpError('Invalid table', 400);
  const table = await RestaurantTable.findById(tableId).session(session || null);
  if (!table) throw httpError('Table not found', 404);
  await assertTenantBranchAccess(user, table.branch, {session});

  const orders = await Order.find({
    table: table._id,
    status: {$in: [...OPEN_ORDER_STATUSES, 'completed']}
  }).sort({createdAt: 1}).session(session || null).lean();

  const orderIds = orders.map(o => o._id);
  const payments = orderIds.length
    ? await Payment.find({order: {$in: orderIds}}).sort({createdAt: 1}).session(session || null).lean()
    : [];

  const byOrder = new Map();
  for (const payment of payments) {
    const key = String(payment.order);
    if (!byOrder.has(key)) byOrder.set(key, []);
    byOrder.get(key).push(payment);
  }

  const byMethod = {};
  for (const payment of payments) {
    const key = payment.method || 'cash';
    byMethod[key] = money((byMethod[key] || 0) + Number(payment.amount));
  }

  const checks = orders.map(order => {
    const rows = byOrder.get(String(order._id)) || [];
    return {
      id: order._id,
      orderNo: order.orderNo,
      status: order.status,
      total: money(order.total),
      paid: money(order.paidAmount),
      due: money(order.dueAmount),
      settled: money(order.dueAmount) <= 0,
      itemCount: (order.items || []).reduce((sum, i) => sum + Number(i.qty || 0), 0),
      payments: rows.map(p => ({method: p.method, amount: money(p.amount), at: p.createdAt}))
    };
  });

  const open = checks.filter(c => !['completed'].includes(c.status));
  return {
    table: {
      id: table._id, name: table.name, area: table.area,
      seats: table.seats, status: table.status
    },
    checks,
    summary: {
      checks: checks.length,
      openChecks: open.length,
      total: money(checks.reduce((sum, c) => sum + c.total, 0)),
      paid: money(checks.reduce((sum, c) => sum + c.paid, 0)),
      due: money(checks.reduce((sum, c) => sum + c.due, 0)),
      settled: checks.every(c => c.settled),
      byMethod
    }
  };
}
