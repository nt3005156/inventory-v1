import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth, requirePermission} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {Branch, RestaurantTable} from '../models/operations.js';
import {assertBranchAccess} from '../services/kitchen.js';
import {OPEN_ORDER_STATUSES, applyTableStatus, moveOrderToTable, mergeTableOrders, assertTableBranchAccess, normalizeArea, buildFloorPlan, archiveTable, reopenOrder, getTableHistory, getTableSettlement, MAX_SEATS} from '../services/tables.js';
import {Order} from '../models/operations.js';
import {publishKitchenOrder, publishTableEvent, publishOrderEvent} from '../services/realtime.js';
import {fail as safeFail} from '../services/httpErrors.js';
import {createTableWithinQuota} from '../services/tenantLimits.js';

const r = Router();
const roles = ['owner', 'manager', 'staff'];
// Phase 25: shared safe error mapper. The local one echoed any error
// verbatim with a 400, leaking driver text and mislabelling server faults.
const fail = safeFail;

const createSchema = z.object({
  branch: z.string(),
  name: z.string().trim().min(1).max(40),
  // A floor area groups tables on the plan; blank or novel-length values make
  // the plan unusable, so it is trimmed and bounded.
  area: z.string().trim().min(1).max(60).optional(),
  // Capacity is the point of a table. It was optional and defaulted to 0,
  // producing tables that could seat nobody.
  seats: z.number().int().min(1).max(MAX_SEATS),
  status: z.enum(['available', 'reserved']).optional()
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  area: z.string().trim().min(1).max(60).optional(),
  seats: z.number().int().min(1).max(MAX_SEATS).optional(),
  active: z.boolean().optional()
});

async function loadBranchTable(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid table'), {status: 400});
  const table = await RestaurantTable.findById(req.params.id);
  if (!table) {
    const err = new Error('Table not found');
    err.status = 404;
    throw err;
  }
  await assertTableBranchAccess(req.user, table.branch);
  return table;
}

r.get('/tables', requirePermission('tables.view'), async (req, res) => {
  try {
    const branchId = req.query.branch;
    if (!branchId) throw Object.assign(new Error('Branch is required'), {status: 400});
    if (!mongoose.isValidObjectId(branchId)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    await assertTableBranchAccess(req.user, branchId);
    const tables = await RestaurantTable.find({branch: branchId}).sort({area: 1, name: 1});
    const open = await Order.find({
      branch: branchId,
      table: {$in: tables.map(t => t._id)},
      status: {$in: OPEN_ORDER_STATUSES}
    }).select('orderNo status type total paidAmount dueAmount table createdAt items._id items.name items.qty items.unitPrice items.notes').sort({createdAt: 1});
    const byTable = new Map();
    for (const o of open) {
      const key = String(o.table);
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push(o);
    }
    res.json(tables.map(t => {
      const currentOrders = byTable.get(String(t._id)) || [];
      return {...t.toJSON(), currentOrders, currentOrder: currentOrders[0] || null};
    }));
  } catch (e) {
    fail(res, e);
  }
});

// Declared before /tables/:id so the literal path is not captured as an id.
r.get('/tables/floor', requirePermission('tables.view'), async (req, res) => {
  try {
    const branchId = req.query.branch;
    if (!branchId) throw Object.assign(new Error('Branch is required'), {status: 400});
    if (!mongoose.isValidObjectId(branchId)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    await assertTableBranchAccess(req.user, branchId);

    const includeRetired = String(req.query.includeRetired || '') === 'true';
    const match = {branch: branchId};
    if (!includeRetired) match.active = {$ne: false};
    const tables = await RestaurantTable.find(match).sort({area: 1, name: 1});

    const open = await Order.find({
      branch: branchId,
      table: {$in: tables.map(t => t._id)},
      status: {$in: OPEN_ORDER_STATUSES}
    }).select('orderNo total table').sort({createdAt: 1});
    const byTable = new Map();
    for (const order of open) {
      const key = String(order.table);
      if (!byTable.has(key)) byTable.set(key, []);
      byTable.get(key).push(order);
    }
    res.json({branch: String(branchId), ...buildFloorPlan(tables, byTable)});
  } catch (e) {
    fail(res, e);
  }
});

r.post('/tables', requirePermission('tables.configure'), async (req, res) => {
  try {
    const x = createSchema.parse(req.body);
    if (!mongoose.isValidObjectId(x.branch)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    await assertTableBranchAccess(req.user, x.branch);
    // Case-insensitive: "T9" and "t9" are the same table to a host.
    const dup = await RestaurantTable.findOne({
      branch: x.branch,
      name: {$regex: `^${x.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i'}
    });
    if (dup) throw Object.assign(new Error('Table name already exists at this branch'), {status: 409});
    // P2C — plan limit, checked immediately before the insert so a refusal
    // cannot leave a half-created table. The tenant is resolved from the
    // branch, which `assertTableBranchAccess` has already proven belongs to
    // the caller.
    // P2E: atomic reservation + insert, so a burst of creates cannot exceed
    // the plan's table quota.
    const table = await createTableWithinQuota(x.branch, () => RestaurantTable.create({
      ...x, area: normalizeArea(x.area), status: x.status || 'available', active: true
    }));
    await Audit.create({entity: 'table', entityId: table._id, action: 'create', after: table, user: req.user.id});
    publishTableEvent(table.branch, {reason: 'create', tableIds: [String(table._id)]});
    res.status(201).json({...table.toJSON(), currentOrder: null});
  } catch (e) {
    fail(res, e);
  }
});

r.post('/tables/:id/move', requirePermission('tables.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const toTable = z.object({toTable: z.string().min(1)}).parse(req.body).toTable;
    let result;
    await session.withTransaction(async () => {
      result = await moveOrderToTable({fromTableId: req.params.id, toTableId: toTable, user: req.user, session});
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    publishTableEvent(result.order.branch, {reason: 'move', tableIds: [String(result.fromTable._id), String(result.toTable._id)]});
    res.json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.post('/tables/:id/merge', requirePermission('tables.manage'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const intoTable = z.object({intoTable: z.string().min(1)}).parse(req.body).intoTable;
    let result;
    await session.withTransaction(async () => {
      result = await mergeTableOrders({fromTableId: req.params.id, intoTableId: intoTable, user: req.user, session});
    });
    await publishKitchenOrder(result.mergedOrder, 'kitchen:status');
    await publishKitchenOrder(result.order, 'kitchen:status');
    publishTableEvent(result.order.branch, {reason: 'merge', tableIds: [String(result.fromTable._id), String(result.intoTable._id)]});
    res.json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

// What the whole table owes across every check seated there.
r.get('/tables/:id/settlement', requirePermission('tables.view'), async (req, res) => {
  try {
    res.json(await getTableSettlement({tableId: req.params.id, user: req.user}));
  } catch (e) {
    fail(res, e);
  }
});

// Table activity: audit trail correlated with the orders seated there.
r.get('/tables/:id/history', requirePermission('tables.configure'), async (req, res) => {
  try {
    res.json(await getTableHistory({
      tableId: req.params.id, user: req.user,
      from: req.query.from, to: req.query.to, limit: req.query.limit
    }));
  } catch (e) {
    fail(res, e);
  }
});

// Reopening a settled check moves money-affecting state, so it is a
// supervisor action.
r.post('/orders/:id/reopen', requirePermission('orders.reopen'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const body = z.object({reason: z.string().trim().max(300).optional()}).strict().parse(req.body ?? {});
    let result;
    await session.withTransaction(async () => {
      result = await reopenOrder({orderId: req.params.id, reason: body.reason, user: req.user, session});
    });
    await publishKitchenOrder(result.order, 'kitchen:status');
    publishOrderEvent(result.order?.branch, {
      reason: 'reopen', order: String(result.order?._id || ''), status: result.order?.status || null
    });
    if (result.table) {
      publishTableEvent(result.table.branch, {reason: 'reopen', tableIds: [String(result.table._id)]});
    }
    res.json(result);
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

r.patch('/tables/:id/status', requirePermission('tables.manage'), async (req, res) => {
  try {
    const table = await loadBranchTable(req);
    await applyTableStatus(table, req.body.status, req.user);
    publishTableEvent(table.branch, {reason: 'status', tableIds: [String(table._id)]});
    res.json(table);
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/tables/:id', requirePermission('tables.manage'), async (req, res) => {
  try {
    const table = await loadBranchTable(req);
    if (req.body.status && req.body.status !== table.status) {
      await applyTableStatus(table, req.body.status, req.user);
    }
    const meta = updateSchema.parse(req.body);
    const hasMeta = meta.name !== undefined || meta.area !== undefined || meta.seats !== undefined || meta.active !== undefined;
    if (hasMeta) {
      if (!['owner', 'manager'].includes(req.user.role)) {
        const err = new Error('Insufficient permission');
        err.status = 403;
        throw err;
      }
      const before = {name: table.name, area: table.area, seats: table.seats, active: table.active};
      if (meta.name !== undefined) table.name = meta.name;
      if (meta.area !== undefined) table.area = normalizeArea(meta.area);
      if (meta.seats !== undefined) table.seats = meta.seats;
      if (meta.active !== undefined) table.active = meta.active;
      await table.save();
      await Audit.create({entity: 'table', entityId: table._id, action: 'update', before, after: meta, user: req.user.id});
    }
    res.json(table);
  } catch (e) {
    fail(res, e);
  }
});

r.delete('/tables/:id', requirePermission('tables.configure'), async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const table = await loadBranchTable(req);
    let archived;
    await session.withTransaction(async () => {
      archived = await archiveTable({table, user: req.user, session});
    });
    publishTableEvent(archived.branch, {reason: 'archive', tableIds: [String(archived._id)]});
    res.json({archived: true, table: archived});
  } catch (e) {
    fail(res, e);
  } finally {
    session.endSession();
  }
});

export default r;
