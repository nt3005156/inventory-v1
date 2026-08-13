import {Audit} from '../models/index.js';
import {Order, RestaurantTable} from '../models/operations.js';

export const TABLE_STATUSES = ['available', 'occupied', 'reserved', 'cleaning', 'disabled'];
export const OPEN_ORDER_STATUSES = ['held', 'pending', 'confirmed', 'accepted', 'preparing', 'ready', 'out_for_delivery'];

export const TABLE_TRANSITIONS = {
  available: ['occupied', 'reserved', 'cleaning', 'disabled'],
  reserved: ['occupied', 'available', 'disabled'],
  occupied: ['cleaning', 'available'],
  cleaning: ['available', 'disabled'],
  disabled: ['available']
};

export function canTransitionTable(from, to) {
  if (!from || !to) return false;
  return (TABLE_TRANSITIONS[from] || []).includes(to);
}

export function assertTableTransition(from, to, user) {
  if (!to) {
    const err = new Error('Status is required');
    err.status = 400;
    throw err;
  }
  if (!TABLE_STATUSES.includes(to)) {
    const err = new Error(`Invalid table status ${to}`);
    err.status = 400;
    throw err;
  }
  if (!canTransitionTable(from, to)) {
    const err = new Error(`Invalid table transition from ${from} to ${to}`);
    err.status = 409;
    throw err;
  }
  if ((to === 'disabled' || from === 'disabled') && user && !['owner', 'manager'].includes(user.role)) {
    const err = new Error('Only owner or manager can change out-of-service status');
    err.status = 403;
    throw err;
  }
}

export function openOrderFilter(tableId, exceptOrderId) {
  return {
    table: tableId,
    status: {$in: OPEN_ORDER_STATUSES},
    ...(exceptOrderId ? {_id: {$ne: exceptOrderId}} : {})
  };
}

export async function findOpenTableOrder(tableId, session, exceptOrderId) {
  return Order.findOne(openOrderFilter(tableId, exceptOrderId)).session(session || null);
}

export async function occupyTable({tableId, branchId, orderId, userId, session}) {
  const table = await RestaurantTable.findById(tableId).session(session || null);
  if (!table) {
    const err = new Error('Table not found');
    err.status = 404;
    throw err;
  }
  if (String(table.branch) !== String(branchId)) {
    const err = new Error('Table is not at this branch');
    err.status = 409;
    throw err;
  }
  if (table.active === false || table.status === 'disabled') {
    const err = new Error('Table is out of service');
    err.status = 409;
    throw err;
  }
  if (!['available', 'reserved'].includes(table.status)) {
    const err = new Error(`Table is ${table.status}`);
    err.status = 409;
    throw err;
  }
  const existing = await findOpenTableOrder(tableId, session, orderId);
  if (existing) {
    const err = new Error('Table already has an open order');
    err.status = 409;
    throw err;
  }
  const before = table.status;
  table.status = 'occupied';
  await table.save({session: session || undefined});
  await Audit.create([{
    entity: 'table',
    entityId: table._id,
    action: 'status',
    before: {status: before},
    after: {status: 'occupied', order: orderId},
    user: userId
  }], {session: session || undefined});
  return table;
}

export async function releaseTable({tableId, userId, session, nextStatus = 'cleaning', exceptOrderId}) {
  if (!tableId) return null;
  const table = await RestaurantTable.findById(tableId).session(session || null);
  if (!table || table.status !== 'occupied') return table;
  const open = await findOpenTableOrder(tableId, session, exceptOrderId);
  if (open) return table;
  const before = table.status;
  table.status = nextStatus;
  await table.save({session: session || undefined});
  await Audit.create([{
    entity: 'table',
    entityId: table._id,
    action: 'status',
    before: {status: before},
    after: {status: nextStatus},
    user: userId
  }], {session: session || undefined});
  return table;
}

export async function applyTableStatus(table, status, user, session) {
  assertTableTransition(table.status, status, user);
  if (status !== 'occupied') {
    const open = await findOpenTableOrder(table._id, session);
    if (open) {
      const err = new Error('Table has an open order');
      err.status = 409;
      throw err;
    }
  }
  const before = table.status;
  table.status = status;
  if (status === 'disabled') table.active = false;
  if (before === 'disabled' && status === 'available') table.active = true;
  await table.save({session: session || undefined});
  await Audit.create([{
    entity: 'table',
    entityId: table._id,
    action: 'status',
    before: {status: before},
    after: {status},
    user: user.id
  }], {session: session || undefined});
  return table;
}
