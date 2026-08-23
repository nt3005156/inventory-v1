import mongoose from 'mongoose';
import {recordAudit} from './auditTrail.js';
import {Ingredient} from '../models/index.js';
import {Branch, InventoryBalance, InventoryBatch, InventoryTransaction} from '../models/operations.js';
import {inventoryMovementId, moveStock} from './inventoryLedger.js';
import {money} from './statements.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {canonicalExpiryDate, expiryState, kathmanduDateString} from './inventoryBatches.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value || '').trim();
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function stockStatus(qty, minimum) {
  const onHand = Number(qty || 0);
  const min = Number(minimum || 0);
  if (onHand <= 0) return 'negative';
  if (min > 0 && onHand <= min) return 'reorder';
  return 'ok';
}

async function inventoryScope({branchId, user, session}) {
  const identity = await userRestaurantContext(user, {session});
  if (branchId) {
    const context = await purchaseBranchContext({user, branchId, session, allowInactive: true});
    return {...identity, branchIds: [context.branch._id], branch: context.branch};
  }
  if (identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    const context = await purchaseBranchContext({user, branchId: identity.branchId, session, allowInactive: true});
    return {...identity, branchIds: [context.branch._id], branch: context.branch};
  }
  const branchIds = await Branch.find({restaurant: identity.restaurantId}).distinct('_id').session(session || null);
  return {...identity, branchIds};
}

function branchMatch(scope) {
  return scope.branchIds.length === 1 ? {branch: scope.branchIds[0]} : {branch: {$in: scope.branchIds}};
}

async function batchSummaryByBalance(scope) {
  const today = canonicalExpiryDate(kathmanduDateString());
  const noExpirySentinel = new Date('9999-12-31T00:00:00.000Z');
  const rows = await InventoryBatch.aggregate([
    {$match: {restaurant: scope.restaurantId, ...branchMatch(scope), quantity: {$gt: 1e-9}}},
    {$group: {
      _id: {branch: '$branch', ingredient: '$ingredient'},
      batchCount: {$sum: 1},
      expiredQty: {$sum: {$cond: [{$and: [{$ne: [{$ifNull: ['$expiryDate', null]}, null]}, {$lt: ['$expiryDate', today]}]}, '$quantity', 0]}},
      nearestExpiry: {$min: {$cond: [{$and: [{$gt: ['$quantity', 1e-9]}, {$gte: ['$expiryDate', today]}]}, '$expiryDate', noExpirySentinel]}}
    }}
  ]);
  return new Map(rows.map(row => [`${row._id.branch}:${row._id.ingredient}`, {
    ...row,
    nearestExpiry: row.nearestExpiry?.getUTCFullYear?.() === 9999 ? null : row.nearestExpiry
  }]));
}

export async function listLiveInventory({branchId, user}) {
  const scope = await inventoryScope({branchId, user});
  const [balances, batches] = await Promise.all([
    InventoryBalance.find(branchMatch(scope))
      .populate({path: 'ingredient', match: {restaurant: scope.restaurantId}, select: 'name code category unit minimumStock'})
      .populate({path: 'branch', match: {restaurant: scope.restaurantId}, select: 'name code'})
      .sort({createdAt: 1}),
    batchSummaryByBalance(scope)
  ]);

  return balances.filter(balance => balance.ingredient && balance.branch).map(b => {
    const qty = Number(b.quantity || 0);
    const avg = Number(b.averageCost || 0);
    const min = Number(b.reorderLevel || b.minLevel || b.ingredient?.minimumStock || 0);
    const summary = batches.get(`${b.branch?._id || b.branch}:${b.ingredient?._id || b.ingredient}`) || {};
    const expiredQty = Number(summary.expiredQty || 0);
    const usableQty = Math.max(0, qty - expiredQty);
    return {
      _id: b._id,
      ingredientId: b.ingredient?._id || b.ingredient,
      name: b.ingredient?.name || 'Ingredient',
      code: b.ingredient?.code || '',
      category: b.ingredient?.category || '',
      unit: b.ingredient?.unit || b.unit || 'g',
      stockQty: qty,
      averageCost: avg,
      stockValue: money(qty * avg),
      minimumStock: min,
      status: stockStatus(usableQty, min),
      branch: b.branch?._id || b.branch,
      branchName: b.branch?.name || '',
      batchCount: Number(summary.batchCount || 0),
      expiredQty,
      usableQty,
      nearestExpiry: summary.nearestExpiry || null,
      source: 'live'
    };
  });
}

export async function listInventoryBalanceDocuments({branchId, user}) {
  const scope = await inventoryScope({branchId, user});
  return InventoryBalance.find(branchMatch(scope))
    .populate({path: 'ingredient', match: {restaurant: scope.restaurantId}, select: 'name code category unit minimumStock'})
    .populate({path: 'branch', match: {restaurant: scope.restaurantId}, select: 'name code'})
    .sort({createdAt: 1})
    .then(rows => rows.filter(row => row.ingredient && row.branch));
}

const LEDGER_POPULATE = [
  {path: 'ingredient', select: 'name code unit'},
  {path: 'branch', select: 'name code'},
  {path: 'user', select: 'name role'}
];

export async function listInventoryLedger({branchId, user, type, limit = 200}) {
  const scope = await inventoryScope({branchId, user});
  const allowedTypes = InventoryTransaction.schema.path('type').enumValues;
  if (type && !allowedTypes.includes(type)) throw httpError('Invalid inventory transaction type', 400);
  const match = {restaurant:scope.restaurantId,...branchMatch(scope), ...(type ? {type} : {})};
  const rows = await InventoryTransaction.find(match)
    .populate(LEDGER_POPULATE)
    .populate('batchMovements.batch', 'batchNumber expiryDate')
    .sort({createdAt: -1})
    .limit(Math.min(500, Math.max(1, Number(limit) || 200)));

  return rows.filter(row => row.ingredient && row.branch).map(t => ({
    _id: t._id,
    restaurant: t.restaurant,
    type: t.type,
    ingredientId: t.ingredient?._id || t.ingredient,
    name: t.ingredient?.name || 'Ingredient',
    code: t.ingredient?.code || '',
    unit: t.unit || t.ingredient?.unit || 'g',
    previousQty: t.previousQty,
    changeQty: t.changeQty,
    newQty: t.newQty,
    unitCost: t.unitCost,
    totalCost: money(t.totalCost),
    reason: t.reason,
    referenceType: t.referenceType,
    referenceId: t.referenceId,
    reference: {type:t.referenceType,id:t.referenceId},
    branch: t.branch?._id || t.branch,
    branchName: t.branch?.name || '',
    userId: t.user?._id || t.user,
    userName: t.user?.name || '',
    userRole: t.user?.role || '',
    user: {id:t.user?._id || t.user,name:t.user?.name || '',role:t.user?.role || ''},
    idempotencyKey: t.idempotencyKey,
    batchMovements: (t.batchMovements || []).map(row => ({
      batchId: row.batch?._id || row.batch,
      batchNumber: row.batchNumber || row.batch?.batchNumber || '',
      expiryDate: row.expiryDate || row.batch?.expiryDate || null,
      previousQty: row.previousQty,
      changeQty: row.changeQty,
      newQty: row.newQty,
      unitCost: row.unitCost
    })),
    createdAt: t.createdAt,
    timestamp: t.createdAt,
    source: 'live'
  }));
}

function batchStatusMatch(status, today, horizon) {
  if (!status) return {quantity: {$gt: 1e-9}};
  if (status === 'depleted') return {quantity: {$lte: 1e-9}};
  if (status === 'expired') return {quantity: {$gt: 1e-9}, expiryDate: {$lt: today}};
  if (status === 'expiring') return {quantity: {$gt: 1e-9}, expiryDate: {$gte: today, $lte: horizon}};
  if (status === 'fresh') return {quantity: {$gt: 1e-9}, expiryDate: {$gt: horizon}};
  if (status === 'no_expiry') return {quantity: {$gt: 1e-9}, $or: [{expiryDate: {$exists: false}}, {expiryDate: null}]};
  throw httpError('Invalid batch status', 400);
}

export async function listInventoryBatches({
  branchId,
  user,
  status,
  ingredient,
  q,
  expiringDays = 30,
  page = 1,
  limit = 100
}) {
  const scope = await inventoryScope({branchId, user});
  const days = Math.min(365, Math.max(1, Number(expiringDays) || 30));
  const todayText = kathmanduDateString();
  const today = canonicalExpiryDate(todayText);
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + days);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
  const base = {restaurant: scope.restaurantId, ...branchMatch(scope)};
  const match = {...base, ...batchStatusMatch(clean(status), today, horizon)};

  if (ingredient) {
    if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
    const exists = await Ingredient.exists({_id: ingredient, restaurant: scope.restaurantId});
    if (!exists) throw httpError('Ingredient not found', 404);
    match.ingredient = new mongoose.Types.ObjectId(ingredient);
  }
  const term = clean(q);
  if (term) {
    const regex = new RegExp(escapeRegex(term), 'i');
    const ingredientIds = await Ingredient.find({restaurant: scope.restaurantId, $or: [{name: regex}, {code: regex}]}).distinct('_id');
    match.$and = [...(match.$and || []), {$or: [{batchNumber: regex}, {lotKey: regex}, {ingredient: {$in: ingredientIds}}]}];
  }

  const [rows, total, summaryRows] = await Promise.all([
    InventoryBatch.find(match)
      .populate('ingredient', 'name code category unit')
      .populate('branch', 'name code')
      .populate('supplier', 'name')
      .sort({expiryDate: 1, receivedAt: 1, _id: 1})
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    InventoryBatch.countDocuments(match),
    InventoryBatch.aggregate([
      {$match: base},
      {$group: {
        _id: null,
        totalLots: {$sum: 1},
        activeLots: {$sum: {$cond: [{$gt: ['$quantity', 1e-9]}, 1, 0]}},
        totalQty: {$sum: '$quantity'},
        expiredQty: {$sum: {$cond: [{$and: [{$gt: ['$quantity', 1e-9]}, {$ne: [{$ifNull: ['$expiryDate', null]}, null]}, {$lt: ['$expiryDate', today]}]}, '$quantity', 0]}},
        expiringQty: {$sum: {$cond: [{$and: [{$gt: ['$quantity', 1e-9]}, {$gte: ['$expiryDate', today]}, {$lte: ['$expiryDate', horizon]}]}, '$quantity', 0]}},
        noExpiryQty: {$sum: {$cond: [{$and: [{$gt: ['$quantity', 1e-9]}, {$eq: [{$ifNull: ['$expiryDate', null]}, null]}]}, '$quantity', 0]}}
      }}
    ])
  ]);
  const summary = summaryRows[0] || {totalLots: 0, activeLots: 0, totalQty: 0, expiredQty: 0, expiringQty: 0, noExpiryQty: 0};

  return {
    items: rows.filter(row => row.ingredient && row.branch).map(row => ({
      _id: row._id,
      restaurant: row.restaurant,
      branch: row.branch?._id || row.branch,
      branchName: row.branch?.name || '',
      ingredient: row.ingredient?._id || row.ingredient,
      ingredientName: row.ingredient?.name || 'Ingredient',
      ingredientCode: row.ingredient?.code || '',
      unit: row.unit || row.ingredient?.unit || 'g',
      batchNumber: row.batchNumber || '',
      expiryDate: row.expiryDate || null,
      status: expiryState(row.expiryDate, {expiringDays: days, quantity: row.quantity}),
      quantity: Number(row.quantity || 0),
      initialQuantity: Number(row.initialQuantity || 0),
      unitCost: Number(row.unitCost || 0),
      stockValue: money(Number(row.quantity || 0) * Number(row.unitCost || 0)),
      receivedAt: row.receivedAt,
      sourceType: row.sourceType,
      sourceId: row.sourceId || null,
      supplier: row.supplier ? {_id: row.supplier._id, name: row.supplier.name} : null
    })),
    pagination: {page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit))},
    asOf: todayText,
    expiringDays: days,
    summary: {
      totalLots: Number(summary.totalLots || 0),
      activeLots: Number(summary.activeLots || 0),
      totalQty: Number(summary.totalQty || 0),
      expiredQty: Number(summary.expiredQty || 0),
      expiringQty: Number(summary.expiringQty || 0),
      noExpiryQty: Number(summary.noExpiryQty || 0)
    }
  };
}

export async function adjustStock({branch, ingredient, qty, reason, unit, user, req, session, idempotencyKey, batchNumber, expiryDate}) {
  if (!mongoose.isValidObjectId(branch) || !mongoose.isValidObjectId(ingredient)) {
    throw httpError('Invalid branch or ingredient', 400);
  }
  const context = await purchaseBranchContext({user, branchId: branch, session, allowInactive: true});
  const amount = Number(qty);
  if (!amount || amount === 0) throw httpError('Adjustment quantity cannot be zero', 400);
  const note = clean(reason);
  if (note.length < 3) throw httpError('Reason is required', 400);
  const item = await Ingredient.findOne({_id: ingredient, restaurant: context.restaurantId}).session(session || null);
  if (!item) throw httpError('Ingredient not found', 404);
  if (expiryDate && !clean(batchNumber)) throw httpError('Batch number is required when an expiry date is recorded', 400);

  const movement = await moveStock({
    branch,
    ingredient,
    qty: amount,
    unit: unit || item.unit || 'g',
    type: 'ADJUSTMENT',
    reason: note,
    referenceType: 'adjustment',
    referenceId: inventoryMovementId({restaurant: context.restaurantId, branch, idempotencyKey}),
    user: context.userId,
    idempotencyKey,
    ...(amount > 0 ? {
      incomingBatches: [{quantity: amount, batchNumber: clean(batchNumber) || undefined, expiryDate: expiryDate || undefined, sourceType: 'adjustment'}]
    } : {batchNumber: clean(batchNumber) || undefined})
  }, session);

  /**
   * Phase 21: a manual stock adjustment is now audited.
   *
   * The inventory LEDGER already recorded the movement, but the ledger is a
   * stock record, not a compliance record: it does not carry the actor's name
   * or the request IP, and a compliance search by user or by date cannot read
   * it. An adjustment is the single easiest way to make stock discrepancies
   * disappear, so it belongs in the audit trail as well as the ledger.
   *
   * Before/after are the real balances taken from the movement, so the row
   * answers "what did this change" without a join.
   */
  await recordAudit({
    req,
    user,
    entity: 'inventory',
    entityId: item._id,
    restaurant: context.restaurantId,
    branch: context.branch?._id || branch,
    action: 'stock_adjustment',
    before: {quantity: movement?.previousQty ?? null},
    after: {
      quantity: movement?.newQty ?? null,
      changeQty: amount,
      unit: unit || item.unit || 'g',
      batchNumber: clean(batchNumber) || null
    },
    reason: note,
    reference: item.code || item.name,
    session
  });

  return movement;
}
