import mongoose from 'mongoose';
import {InventoryBalance} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {buildPnl} from './pnl.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function resolveDashboardBranch(user, branchId) {
  if (branchId) return String(branchId);
  if (user?.role !== 'owner' && user?.branch) return String(user.branch);
  return null;
}

export async function buildDashboard({branchId, user}) {
  const branch = resolveDashboardBranch(user, branchId);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const pnl = await buildPnl({branchId: branch, user, from: start.toISOString()});

  const balances = await InventoryBalance.find(branch ? {branch} : {}).populate('ingredient', 'name code minimumStock');
  const inventoryValue = money(balances.reduce((s, b) => s + Number(b.quantity || 0) * Number(b.averageCost || 0), 0));
  const lowStock = balances.filter(b => {
    const qty = Number(b.quantity || 0);
    const min = Number(b.reorderLevel || b.minLevel || b.ingredient?.minimumStock || 0);
    return min > 0 && qty <= min;
  }).map(b => ({
    _id: b.ingredient?._id || b._id,
    name: b.ingredient?.name || 'Ingredient',
    code: b.ingredient?.code,
    stockQty: b.quantity,
    minimumStock: b.reorderLevel || b.minLevel || b.ingredient?.minimumStock || 0,
    averageCost: b.averageCost
  }));

  return {
    source: 'live',
    branch: branch || null,
    revenue: pnl.revenue,
    cogs: pnl.cogs,
    expense: pnl.expenses,
    waste: pnl.waste,
    profit: pnl.netProfit,
    orders: pnl.sales.orders,
    inventoryValue,
    lowStock,
    vat: pnl.sales.vat,
    purchases: pnl.purchases
  };
}
