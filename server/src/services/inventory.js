import mongoose from 'mongoose';
import {InventoryBalance} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {resolveDashboardBranch} from './dashboard.js';
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
