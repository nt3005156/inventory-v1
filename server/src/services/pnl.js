import mongoose from 'mongoose';
import {Expense} from '../models/index.js';
import {InventoryTransaction, Order} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {expenseQuery, expenseScope} from './expenses.js';
import {buildPurchasingReport} from './purchasingReport.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function createdAtRange(from, to) {
  if (!from && !to) return {};
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  return {createdAt};
}

export async function buildPnl({branchId, user, from, to}) {
  if (branchId) {
    if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branchId);
  }

  const purchasing = await buildPurchasingReport({branchId, user, from, to});
  const dates = createdAtRange(from, to);
  const orderMatch = {
    ...(branchId ? {branch: new mongoose.Types.ObjectId(branchId)} : {}),
    ...dates,
    status: {$nin: ['cancelled', 'refunded']}
  };

  const wasteMatch = {
    type: 'WASTE',
    ...(branchId ? {branch: new mongoose.Types.ObjectId(branchId)} : {}),
    ...dates
  };

  const [salesAgg, expenseRows, wasteRows] = await Promise.all([
    Order.aggregate([
      {$match: orderMatch},
      {$group: {
        _id: null,
        revenue: {$sum: '$total'},
        orders: {$sum: 1},
        discounts: {$sum: '$discount'},
        vat: {$sum: '$vat'},
        cogs: {$sum: {$sum: '$items.foodCost'}}
      }}
    ]),
    Expense.find(expenseQuery({branchId, from, to})),
    InventoryTransaction.find(wasteMatch)
  ]);

  const raw = salesAgg[0] || {revenue: 0, orders: 0, discounts: 0, vat: 0, cogs: 0};
  const revenue = money(raw.revenue);
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
    branch: branchId || null,
    from: from || null,
    to: to || null,
    revenue,
    cogs,
    grossProfit,
    purchases,
    waste: wasteAmount,
    expenses: expenseAmount,
    netProfit,
    sales: {
      orders: raw.orders || 0,
      revenue,
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
      scope: expenseScope(expenseRows, branchId)
    },
    wasteDetail: {
      amount: wasteAmount,
      count: wasteRows.length,
      scope: 'ledger'
    }
  };
}
