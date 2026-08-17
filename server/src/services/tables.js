import {Audit} from '../models/index.js';
import {Branch, Order, Payment, RestaurantTable} from '../models/operations.js';
import {assertBranchAccess, assertTenantBranchAccess} from './kitchen.js';
import {userRestaurantContext} from './supplierCatalog.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Branch access **and** tenant ownership.
 *
 * assertBranchAccess() returns early for any owner, which is correct for
 * branch-vs-branch checks inside one restaurant but does not stop an owner of
 * a different restaurant reading this one's floor. Table endpoints are
 * tenant-scoped data, so the branch must be confirmed to belong to the
 * caller's restaurant as well.
 */
export async function assertTableBranchAccess(user, branchId, {session} = {}) {
  assertBranchAccess(user, branchId);
  const branch = await Branch.findById(branchId).select('restaurant').session(session || null).lean();
  if (!branch) throw httpError('Branch not found', 404);
  const {restaurantId} = await userRestaurantContext(user, {session});
  if (!restaurantId || String(branch.restaurant) !== String(restaurantId)) {
    throw httpError('Branch access denied', 403);
  }
  return branch;
}

// Phase 6A — floor & capacity.
export const DEFAULT_AREA = 'Main Floor';
// A dining table seats a party; 40 covers even a large banquet table while
// still rejecting typos like 99999.
export const MAX_SEATS = 40;

/** Trims a floor area to a usable label, falling back to the default. */
export function normalizeArea(value) {
  const area = String(value ?? '').trim().replace(/\s+/g, ' ');
  return area || DEFAULT_AREA;
}

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

function copyInventoryRequirements(line) {
  return (line.inventoryRequirements || []).map(requirement => ({
    ingredient: requirement.ingredient,
    qty: requirement.qty,
    unit: requirement.unit
  }));
}

function requirementSignature(line) {
  return copyInventoryRequirements(line)
    .map(requirement => `${requirement.ingredient}:${Number(requirement.qty || 0)}:${requirement.unit || ''}`)
    .sort()
    .join('|');
}

// Two lines of the same dish are only the same line if the guest asked for the
// same modifiers and the same special instructions. Without this, moving a
// table would merge "extra cheese" into a plain one and lose the request.
function modifierSignature(line) {
  const mods = (line.modifiers || [])
    .map(m => `${m.groupKey || ''}:${m.optionKey || m.name || ''}:${Number(m.price || 0)}`)
    .sort()
    .join('|');
  return `${mods}#${String(line.specialInstructions || '').trim()}#${Number(line.unitPrice || 0)}`;
}

function lineSignature(line) {
  return `${requirementSignature(line)}~${modifierSignature(line)}`;
}

export function combineItems(destItems = [], sourceItems = []) {
  const list = destItems.map(i => ({
    menuItem: i.menuItem,
    name: i.name,
    qty: i.qty,
    unitPrice: i.unitPrice,
    basePrice: i.basePrice,
    foodCost: i.foodCost,
    notes: i.notes,
    specialInstructions: i.specialInstructions,
    modifiers: i.modifiers,
    inventoryRequirements: copyInventoryRequirements(i)
  }));
  for (const line of sourceItems) {
    const signature = lineSignature(line);
    const match = list.find(i =>
      String(i.menuItem) === String(line.menuItem) && lineSignature(i) === signature
    );
    if (match) {
      match.qty += line.qty;
      if (line.notes && line.notes !== match.notes) {
        match.notes = [match.notes, line.notes].filter(Boolean).join(' · ');
      }
    } else {
      list.push({
        menuItem: line.menuItem,
        name: line.name,
        qty: line.qty,
        unitPrice: line.unitPrice,
        basePrice: line.basePrice,
        foodCost: line.foodCost,
        notes: line.notes,
        specialInstructions: line.specialInstructions,
        modifiers: line.modifiers,
        inventoryRequirements: copyInventoryRequirements(line)
      });
    }
  }
  return list;
}

function recountOrder(order) {
  order.subtotal = (order.items || []).reduce((s, i) => s + Number(i.qty || 0) * Number(i.unitPrice || 0), 0);
  const discount = Number(order.discount || 0);
  const vatRate = Number(order.vatRate ?? 13);
  order.vat = (order.subtotal - discount) * vatRate / 100;
  order.total = order.subtotal - discount + order.vat + Number(order.serviceCharge || 0) + Number(order.deliveryFee || 0);
  order.dueAmount = Math.max(0, order.total - Number(order.paidAmount || 0));
  return order;
}

export async function claimTableForOrder({tableId, branchId, orderId, userId, session}) {
  const table = await RestaurantTable.findById(tableId).session(session || null);
  if (!table) throw httpError('Table not found', 404);
  if (String(table.branch) !== String(branchId)) throw httpError('Table is not at this branch', 409);
  if (table.active === false || table.status === 'disabled') throw httpError('Table is out of service', 409);
  if (!['available', 'reserved', 'occupied'].includes(table.status)) throw httpError(`Table is ${table.status}`, 409);
  const existing = await findOpenTableOrder(tableId, session, orderId);
  if (existing) throw httpError('Table already has an open order', 409);
  if (table.status === 'occupied') return table;
  return occupyTable({tableId, branchId, orderId, userId, session});
}

async function loadPair(fromTableId, toTableId, user, session) {
  if (!toTableId) throw httpError('Destination table is required', 400);
  if (String(fromTableId) === String(toTableId)) throw httpError('Source and destination tables must differ', 409);
  const from = await RestaurantTable.findById(fromTableId).session(session || null);
  const to = await RestaurantTable.findById(toTableId).session(session || null);
  if (!from || !to) throw httpError('Table not found', 404);
  if (String(from.branch) !== String(to.branch)) throw httpError('Tables must be at the same branch', 409);
  await assertTenantBranchAccess(user, from.branch, {session});
  await assertTenantBranchAccess(user, to.branch, {session});
  return {from, to};
}

export async function moveOrderToTable({fromTableId, toTableId, user, session}) {
  const {from, to} = await loadPair(fromTableId, toTableId, user, session);
  const order = await findOpenTableOrder(from._id, session);
  if (!order) throw httpError('Source table has no open order', 409);
  await claimTableForOrder({tableId: to._id, branchId: from.branch, orderId: order._id, userId: user.id, session});
  const previousTable = order.table;
  order.table = to._id;
  await order.save({session: session || undefined});
  await releaseTable({tableId: from._id, userId: user.id, session, exceptOrderId: order._id});
  await Audit.create([{
    entity: 'order',
    entityId: order._id,
    action: 'table_move',
    before: {table: previousTable},
    after: {table: to._id},
    user: user.id
  }], {session: session || undefined});
  return {order, fromTable: await RestaurantTable.findById(from._id).session(session || null), toTable: await RestaurantTable.findById(to._id).session(session || null)};
}

export async function mergeTableOrders({fromTableId, intoTableId, user, session}) {
  const {from, to} = await loadPair(fromTableId, intoTableId, user, session);
  const source = await findOpenTableOrder(from._id, session);
  const dest = await findOpenTableOrder(to._id, session);
  if (!source) throw httpError('Source table has no open order', 409);
  if (!dest) throw httpError('Destination table has no open order to merge into', 409);

  dest.items = combineItems(dest.items, source.items);
  const inventorySources = [
    ...(dest.inventorySourceOrders?.length
      ? dest.inventorySourceOrders
      : [dest.inventorySourceOrder || dest._id]),
    ...(source.inventorySourceOrders?.length
      ? source.inventorySourceOrders
      : [source.inventorySourceOrder || source._id])
  ];
  dest.inventorySourceOrders = [...new Map(
    inventorySources.map(sourceId => [String(sourceId), sourceId])
  ).values()];
  dest.discount = Number(dest.discount || 0) + Number(source.discount || 0);
  dest.serviceCharge = Number(dest.serviceCharge || 0) + Number(source.serviceCharge || 0);
  dest.deliveryFee = Number(dest.deliveryFee || 0) + Number(source.deliveryFee || 0);
  dest.paidAmount = Number(dest.paidAmount || 0) + Number(source.paidAmount || 0);
  if (!dest.customer && source.customer) dest.customer = source.customer;
  dest.inventoryDeducted = Boolean(dest.inventoryDeducted || source.inventoryDeducted);
  recountOrder(dest);
  await dest.save({session: session || undefined});

  await Payment.updateMany({order: source._id}, {$set: {order: dest._id}}, {session: session || undefined});

  const sourceStatus = source.status;
  source.status = 'cancelled';
  source.inventoryReversed = true;
  source.dueAmount = 0;
  await source.save({session: session || undefined});

  await releaseTable({tableId: from._id, userId: user.id, session, exceptOrderId: source._id});
  await Audit.create([{
    entity: 'order',
    entityId: dest._id,
    action: 'table_merge',
    before: {fromOrder: source._id, fromTable: from._id, fromStatus: sourceStatus},
    after: {order: dest._id, table: to._id, items: dest.items.length, total: dest.total, paidAmount: dest.paidAmount, customer: dest.customer},
    user: user.id
  }], {session: session || undefined});
  await Audit.create([{
    entity: 'order',
    entityId: source._id,
    action: 'table_merge',
    before: {status: sourceStatus, table: from._id},
    after: {status: 'cancelled', mergedInto: dest._id},
    user: user.id
  }], {session: session || undefined});

  return {
    order: dest,
    mergedOrder: source,
    fromTable: await RestaurantTable.findById(from._id).session(session || null),
    intoTable: await RestaurantTable.findById(to._id).session(session || null)
  };
}

/**
 * Groups a branch's tables into a floor plan with occupancy.
 *
 * Areas are the floor sections a host thinks in; each carries its own capacity
 * and status counts so a full floor can be read at a glance without the caller
 * re-aggregating the table list.
 */
export function buildFloorPlan(tables, openOrdersByTable = new Map()) {
  const areas = new Map();
  const statusTotals = {available: 0, occupied: 0, reserved: 0, cleaning: 0, disabled: 0};

  for (const table of tables) {
    const area = normalizeArea(table.area);
    if (!areas.has(area)) {
      areas.set(area, {
        area, tables: [], seats: 0, tableCount: 0,
        statuses: {available: 0, occupied: 0, reserved: 0, cleaning: 0, disabled: 0},
        seatedCapacity: 0
      });
    }
    const bucket = areas.get(area);
    const orders = openOrdersByTable.get(String(table._id)) || [];
    const seats = Number(table.seats || 0);
    const status = table.active === false ? 'disabled' : table.status;

    bucket.tables.push({
      id: table._id,
      name: table.name,
      seats,
      status,
      active: table.active !== false,
      openOrders: orders.length,
      currentOrder: orders[0] ? {id: orders[0]._id, orderNo: orders[0].orderNo, total: orders[0].total} : null
    });
    bucket.tableCount += 1;
    bucket.seats += seats;
    bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
    if (status === 'occupied') bucket.seatedCapacity += seats;
    statusTotals[status] = (statusTotals[status] || 0) + 1;
  }

  const list = [...areas.values()].sort((a, b) => a.area.localeCompare(b.area));
  for (const bucket of list) bucket.tables.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, {numeric: true}));

  const totalSeats = list.reduce((sum, a) => sum + a.seats, 0);
  const seatedCapacity = list.reduce((sum, a) => sum + a.seatedCapacity, 0);
  const serviceable = statusTotals.available + statusTotals.occupied + statusTotals.reserved + statusTotals.cleaning;

  return {
    areas: list,
    summary: {
      areaCount: list.length,
      tableCount: tables.length,
      totalSeats,
      seatedCapacity,
      statuses: statusTotals,
      // Share of in-service tables currently seated.
      occupancyRate: serviceable ? Math.round((statusTotals.occupied / serviceable) * 10000) / 100 : 0,
      seatOccupancyRate: totalSeats ? Math.round((seatedCapacity / totalSeats) * 10000) / 100 : 0
    }
  };
}

/**
 * Retires a table. Tables are deactivated rather than deleted because orders,
 * audit history and past receipts still reference them.
 */
export async function archiveTable({table, user, session}) {
  const open = await findOpenTableOrder(table._id, session);
  if (open) throw httpError('Cannot retire a table with an open order', 409);
  if (table.status === 'occupied') throw httpError('Cannot retire an occupied table', 409);
  const before = {active: table.active, status: table.status};
  table.active = false;
  table.status = 'disabled';
  await table.save({session: session || undefined});
  await Audit.create([{
    entity: 'table', entityId: table._id, branch: table.branch,
    action: 'archive', before, after: {active: false, status: 'disabled'}, user: user.id
  }], {session: session || undefined});
  return table;
}
