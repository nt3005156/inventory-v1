import mongoose from 'mongoose';
import {Ingredient} from '../models/index.js';
import {InventoryBalance, InventoryTransaction} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {resolveDashboardBranch} from './dashboard.js';
import {moveStock} from './inventoryLedger.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function stockStatus(qty, minimum) {
  const onHand = Number(qty || 0);
  const min = Number(minimum || 0);
  if (onHand <= 0) return 'negative';
  if (min > 0 && onHand <= min) return 'reorder';
  return 'ok';
}

export async function listLiveInventory({branchId, user}) {
  const branch = resolveDashboardBranch(user, branchId);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
  }

  const balances = await InventoryBalance.find(branch ? {branch} : {})
    .populate('ingredient', 'name code category unit minimumStock')
    .populate('branch', 'name code')
    .sort({createdAt: 1});

  return balances.map(b => {
    const qty = Number(b.quantity || 0);
    const avg = Number(b.averageCost || 0);
    const min = Number(b.reorderLevel || b.minLevel || b.ingredient?.minimumStock || 0);
    const status = stockStatus(qty, min);
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
      status,
      branch: b.branch?._id || b.branch,
      branchName: b.branch?.name || '',
      batchNumber: b.batchNumber || '',
      expiryDate: b.expiryDate || null,
      source: 'live'
    };
  });
}

const LEDGER_POPULATE = [
  {path: 'ingredient', select: 'name code unit'},
  {path: 'branch', select: 'name code'},
  {path: 'user', select: 'name role'}
];

export async function listInventoryLedger({branchId, user, type, limit = 200}) {
  const branch = resolveDashboardBranch(user, branchId);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
  }

  const match = {
    ...(branch ? {branch} : {}),
    ...(type ? {type} : {})
  };
  const rows = await InventoryTransaction.find(match)
    .populate(LEDGER_POPULATE)
    .sort({createdAt: -1})
    .limit(Math.min(500, Math.max(1, Number(limit) || 200)));

  return rows.map(t => ({
    _id: t._id,
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
    reason: t.reason || '',
    referenceType: t.referenceType || '',
    referenceId: t.referenceId || null,
    branch: t.branch?._id || t.branch,
    branchName: t.branch?.name || '',
    userName: t.user?.name || '',
    createdAt: t.createdAt,
    source: 'live'
  }));
}

export async function adjustStock({branch, ingredient, qty, reason, unit, user, session, idempotencyKey}) {
  if (!mongoose.isValidObjectId(branch) || !mongoose.isValidObjectId(ingredient)) {
    throw httpError('Invalid branch or ingredient', 400);
  }
  assertBranchAccess(user, branch);
  const amount = Number(qty);
  if (!amount || amount === 0) throw httpError('Adjustment quantity cannot be zero', 400);
  const note = String(reason || '').trim();
  if (note.length < 3) throw httpError('Reason is required', 400);
  const item = await Ingredient.findById(ingredient).session(session || null);
  if (!item) throw httpError('Ingredient not found', 404);

  return moveStock({
    branch,
    ingredient,
    qty: amount,
    unit: unit || item.unit || 'g',
    type: 'ADJUSTMENT',
    reason: note,
    referenceType: 'adjustment',
    user: user.id,
    idempotencyKey
  }, session);
}
