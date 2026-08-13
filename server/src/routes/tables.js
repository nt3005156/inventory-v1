import {Router} from 'express';
import mongoose from 'mongoose';
import {z} from 'zod';
import {auth} from '../middleware/auth.js';
import {Audit} from '../models/index.js';
import {Branch, RestaurantTable} from '../models/operations.js';
import {assertBranchAccess} from '../services/kitchen.js';
import {OPEN_ORDER_STATUSES, applyTableStatus, moveOrderToTable, mergeTableOrders} from '../services/tables.js';
import {Order} from '../models/operations.js';
import {publishKitchenOrder, publishTableEvent} from '../services/realtime.js';

const r = Router();
const roles = ['owner', 'manager', 'staff'];
const fail = (res, e) => res.status(e.status || 400).json({message: e.message || 'Request failed'});

const createSchema = z.object({
  branch: z.string(),
  name: z.string().min(1),
  area: z.string().optional(),
  seats: z.number().int().positive().optional(),
  status: z.enum(['available', 'reserved']).optional()
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  area: z.string().optional(),
  seats: z.number().int().positive().optional(),
  active: z.boolean().optional()
});

async function loadBranchTable(req) {
  const table = await RestaurantTable.findById(req.params.id);
  if (!table) {
    const err = new Error('Table not found');
    err.status = 404;
    throw err;
  }
  assertBranchAccess(req.user, table.branch);
  return table;
}

r.get('/tables', auth(roles), async (req, res) => {
  try {
    const branchId = req.query.branch;
    if (!branchId) throw Object.assign(new Error('Branch is required'), {status: 400});
    if (!mongoose.isValidObjectId(branchId)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    assertBranchAccess(req.user, branchId);
    const branch = await Branch.findById(branchId);
    if (!branch) throw Object.assign(new Error('Branch not found'), {status: 404});
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

r.post('/tables', auth(['owner', 'manager']), async (req, res) => {
  try {
    const x = createSchema.parse(req.body);
    if (!mongoose.isValidObjectId(x.branch)) throw Object.assign(new Error('Invalid branch'), {status: 400});
    assertBranchAccess(req.user, x.branch);
    const branch = await Branch.findById(x.branch);
    if (!branch) throw Object.assign(new Error('Branch not found'), {status: 404});
    const dup = await RestaurantTable.findOne({branch: x.branch, name: x.name});
    if (dup) throw Object.assign(new Error('Table name already exists at this branch'), {status: 409});
    const table = await RestaurantTable.create({...x, status: x.status || 'available', active: true});
    await Audit.create({entity: 'table', entityId: table._id, action: 'create', after: table, user: req.user.id});
    publishTableEvent(table.branch, {reason: 'create', tableIds: [String(table._id)]});
    res.status(201).json({...table.toJSON(), currentOrder: null});
  } catch (e) {
    fail(res, e);
  }
});

r.post('/tables/:id/move', auth(roles), async (req, res) => {
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

r.post('/tables/:id/merge', auth(roles), async (req, res) => {
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

r.patch('/tables/:id/status', auth(roles), async (req, res) => {
  try {
    const table = await loadBranchTable(req);
    await applyTableStatus(table, req.body.status, req.user);
    publishTableEvent(table.branch, {reason: 'status', tableIds: [String(table._id)]});
    res.json(table);
  } catch (e) {
    fail(res, e);
  }
});

r.patch('/tables/:id', auth(roles), async (req, res) => {
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
      if (meta.area !== undefined) table.area = meta.area;
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

export default r;
