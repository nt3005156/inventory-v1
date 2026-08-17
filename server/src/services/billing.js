import {Audit} from '../models/index.js';
import {Order, Payment} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {OPEN_ORDER_STATUSES, releaseTable} from './tables.js';
import {computeOrderTotals, priceLine} from './pos.js';

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
  const lines = (order.items || []).map(item => priceLine({
    unitPrice: item.unitPrice,
    qty: item.qty,
    vatInclusive: item.vatInclusive === true,
    vatRate
  }));
  (order.items || []).forEach((item, i) => {
    item.lineNet = lines[i].lineNet;
    item.lineVat = lines[i].lineVat;
    item.lineTotal = lines[i].lineGross;
  });
  const totals = computeOrderTotals({
    lines,
    discount: order.discount || 0,
    serviceChargeRate: order.serviceChargeRate || 0,
    deliveryFee: order.deliveryFee || 0,
    vatRate
  });
  order.subtotal = totals.subtotal;
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
  assertBranchAccess(user, order.branch);
  return order;
}

export async function applyPayment({orderId, amount, method, transactionId, items, user, session}) {
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
  const payment = (await Payment.create([{
    order: order._id,
    amount: payAmount,
    method,
    transactionId,
    cashier: user.id,
    status: 'paid'
  }], {session: session || undefined}))[0];
  order.paidAmount = money(Number(order.paidAmount || 0) + payAmount);
  order.dueAmount = money(Math.max(0, Number(order.total || 0) - order.paidAmount));
  const justClosed = order.dueAmount <= 0;
  if (justClosed) {
    order.dueAmount = 0;
    order.status = 'completed';
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
    }
  }
  await parent.save({session: session || undefined});
  await child.save({session: session || undefined});
  if (parent.dueAmount <= 0 && OPEN_ORDER_STATUSES.includes(parent.status)) {
    parent.status = 'completed';
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
