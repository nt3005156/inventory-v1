import mongoose from 'mongoose';
import {Expense} from '../models/index.js';
import {InventoryTransaction, Order} from '../models/operations.js';
import {expenseQuery, expenseScope, resolveExpenseContext} from './expenses.js';
import {buildPurchasingReport} from './purchasingReport.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createdAtRange(from, to, toExclusive) {
  if (!from && !to && !toExclusive) return {};
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (toExclusive) createdAt.$lt = new Date(toExclusive);
  else if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  return {createdAt};
}

export async function buildPnl({branchId, user, from, to, toExclusive}) {
  const scope = await resolveExpenseContext({user, branchId});
  const effectiveBranchId = scope.branch;
  const branchMatch = {branch: {$in: scope.branchIds.map(id => new mongoose.Types.ObjectId(id))}};
  const purchasing = await buildPurchasingReport({branchId: effectiveBranchId, user, from, to, toExclusive});
  const dates = createdAtRange(from, to, toExclusive);
  const orderMatch = {
    ...branchMatch,
    ...dates,
    status: {$nin: ['cancelled', 'refunded']}
  };

  const wasteMatch = {
    type: 'WASTE',
    ...branchMatch,
    ...dates
  };

  const [salesAgg, expenseRows, wasteRows] = await Promise.all([
    Order.aggregate([
      {$match: orderMatch},
      {$group: {
        _id: null,
        // Phase 4D: a partial refund leaves the order 'completed', so refunded
        // money must be netted out of revenue explicitly or it stays counted.
        revenue: {$sum: {$subtract: ['$total', {$ifNull: ['$refundAmount', 0]}]}},
        grossRevenue: {$sum: '$total'},
        refunds: {$sum: {$ifNull: ['$refundAmount', 0]}},
        orders: {$sum: 1},
        discounts: {$sum: '$discount'},
        vat: {$sum: '$vat'},
        cogs: {$sum: {$sum: {$map: {
          input: '$items',
          as: 'item',
          in: {$multiply: [{$ifNull: ['$$item.foodCost', 0]}, {$ifNull: ['$$item.qty', 0]}]}
        }}}}
      }}
    ]),
    Expense.find(expenseQuery({
      branchId: effectiveBranchId,
      branchIds: scope.branchIds,
      userIds: scope.userIds,
      from,
      to,
      toExclusive
    })),
    InventoryTransaction.find(wasteMatch)
  ]);

  const raw = salesAgg[0] || {revenue: 0, grossRevenue: 0, refunds: 0, orders: 0, discounts: 0, vat: 0, cogs: 0};
  const revenue = money(raw.revenue);
  const grossRevenue = money(raw.grossRevenue);
  const refunds = money(raw.refunds);
  const cogs = money(raw.cogs);
  const vat = money(raw.vat);
  const discounts = money(raw.discounts);
  const grossProfit = money(revenue - cogs);
  const expenseAmount = money(expenseRows.reduce((s, e) => s + Number(e.amount || 0), 0));
  const expenseVat = money(expenseRows.reduce((s, e) => s + Number(e.vat || 0), 0));
  const wasteAmount = money(wasteRows.reduce((s, t) => s + Number(t.totalCost || 0), 0));
  const purchases = purchasing.ledger.netStockValue;
  const netProfit = money(grossProfit - expenseAmount - wasteAmount);

  return {
    source: 'live',
    currency: 'NPR',
    vatRate: 13,
    branch: effectiveBranchId ? String(effectiveBranchId) : null,
    from: from || null,
    to: to || null,
    revenue,
    grossRevenue,
    refunds,
    cogs,
    grossProfit,
    purchases,
    waste: wasteAmount,
    expenses: expenseAmount,
    netProfit,
    sales: {
      orders: raw.orders || 0,
      revenue,
      grossRevenue,
      refunds,
      vat,
      discounts,
      cogs,
      grossProfit
    },
    purchasing: {
      acceptedValue: purchasing.receipts.acceptedValue,
      returnedValue: purchasing.returns.value,
      netStockValue: purchasing.ledger.netStockValue,
      invoiced: purchasing.invoices.invoiced,
      paid: purchasing.invoices.paid,
      due: purchasing.invoices.due,
      vat: purchasing.invoices.vat
    },
    expenseDetail: {
      amount: expenseAmount,
      vat: expenseVat,
      count: expenseRows.length,
      scope: expenseScope(expenseRows, effectiveBranchId)
    },
    wasteDetail: {
      amount: wasteAmount,
      count: wasteRows.length,
      scope: 'ledger'
    }
  };
}
