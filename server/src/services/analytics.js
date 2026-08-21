import mongoose from 'mongoose';
import {Ingredient, MenuItem} from '../models/index.js';
import {
  Branch, Customer, InventoryBalance, InventoryTransaction, Order, Payment
} from '../models/operations.js';
import {StockCount} from '../models/operations.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {money} from './statements.js';
import {expiryState} from './inventoryBatches.js';

/**
 * Phase 18 — reporting and business intelligence.
 *
 * Everything here READS. No analytics endpoint may write, and none of them
 * introduce a second source of truth: sales come from `Order`, stock from the
 * inventory ledger and balances, purchasing from the existing
 * `buildPurchasingReport()`, kitchen timings from `buildKitchenPerformance()`.
 *
 * A note on the brief's premise, recorded because it turned out to be wrong:
 * `/api/reports/pnl` was said to run on legacy `Purchase`/`Sale` collections.
 * It does not — verified by planting a legacy `Sale` of 99,999 and a legacy
 * `Purchase` of 77,777 and observing P&L report 0 for both. It already reads
 * `Order`, `InventoryTransaction` and the purchasing report. What P&L *was*
 * missing is a flat `vat`, `discounts` and `inventoryValue` at the top level,
 * which is fixed rather than rewritten.
 */

const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Kathmandu calendar day for a timestamp. Reporting is local-day based. */
export function kathmanduDay(value = new Date()) {
  return new Date(new Date(value).getTime() + KATHMANDU_OFFSET_MS).toISOString().slice(0, 10);
}

/** ISO week key (YYYY-Www) for weekly grouping. */
export function isoWeek(value) {
  const date = new Date(new Date(value).getTime() + KATHMANDU_OFFSET_MS);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // ISO weeks run Monday–Sunday and belong to the year containing the Thursday.
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7
  );
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function kathmanduMonth(value) {
  return kathmanduDay(value).slice(0, 7);
}

export const SALES_GRANULARITIES = Object.freeze(['daily', 'weekly', 'monthly']);

function bucketFor(granularity, date) {
  if (granularity === 'weekly') return isoWeek(date);
  if (granularity === 'monthly') return kathmanduMonth(date);
  return kathmanduDay(date);
}

/**
 * Resolves the reporting scope. A branch manager is pinned to their branch; an
 * owner may span the restaurant. Reuses the same guards purchasing uses, so
 * analytics cannot become a tenancy back door.
 */
export async function analyticsScope({branchId, user}) {
  const identity = await userRestaurantContext(user);
  if (branchId) {
    const context = await purchaseBranchContext({user, branchId, allowInactive: true});
    return {restaurantId: context.restaurantId, branchIds: [context.branch._id], branch: context.branch};
  }
  if (identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    const context = await purchaseBranchContext({user, branchId: identity.branchId, allowInactive: true});
    return {restaurantId: context.restaurantId, branchIds: [context.branch._id], branch: context.branch};
  }
  const branchIds = await Branch.find({restaurant: identity.restaurantId}).distinct('_id');
  return {restaurantId: identity.restaurantId, branchIds, branch: null};
}

/** Inclusive-from, exclusive-to window in Kathmandu local time. */
export function reportingPeriod({from, to} = {}) {
  const parse = (value, label) => {
    if (!value) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw httpError(`${label} must use YYYY-MM-DD`, 400);
    return new Date(`${value}T00:00:00.000+05:45`);
  };
  const fromDate = parse(from, 'from');
  const toDate = parse(to, 'to');
  const toExclusive = toDate ? new Date(toDate.getTime() + 86400000) : null;
  if (fromDate && toExclusive && fromDate >= toExclusive) {
    throw httpError('from must not be after to', 400);
  }
  return {from: from || null, to: to || null, fromDate, toExclusive};
}

function dateMatch(field, period) {
  if (!period.fromDate && !period.toExclusive) return {};
  return {
    [field]: {
      ...(period.fromDate ? {$gte: period.fromDate} : {}),
      ...(period.toExclusive ? {$lt: period.toExclusive} : {})
    }
  };
}

/**
 * Orders that count as revenue.
 *
 * Cancelled orders never counted. A REFUNDED order is excluded from order
 * counts but its money is still netted through `refundAmount` on partially
 * refunded orders, matching how P&L already treats it — analytics must not
 * disagree with the P&L for the same period.
 */
const REVENUE_STATUSES = {$nin: ['cancelled', 'refunded', 'draft', 'held']};

/**
 * Sales analytics: totals plus breakdowns by period, branch, item, category
 * and payment method.
 */
export async function buildSalesReport({branchId, user, from, to, granularity = 'daily'}) {
  const scope = await analyticsScope({branchId, user});
  const period = reportingPeriod({from, to});
  const bucket = String(granularity || 'daily').toLowerCase();
  if (!SALES_GRANULARITIES.includes(bucket)) {
    throw httpError(`granularity must be one of ${SALES_GRANULARITIES.join(', ')}`, 400);
  }

  const match = {
    branch: {$in: scope.branchIds},
    status: REVENUE_STATUSES,
    ...dateMatch('createdAt', period)
  };

  const orders = await Order.find(match)
    .select('branch createdAt total subtotal vat discountTotal discount refundAmount serviceCharge items type paymentMethod customer')
    .lean();

  const zero = () => ({
    orders: 0, grossRevenue: 0, refunds: 0, netRevenue: 0,
    discounts: 0, vat: 0, serviceCharge: 0, cogs: 0, grossProfit: 0
  });
  const add = (target, order) => {
    const gross = Number(order.total || 0);
    const refunded = Number(order.refundAmount || 0);
    const cogs = (order.items || []).reduce(
      (sum, item) => sum + Number(item.foodCost || 0) * Number(item.qty || 0), 0
    );
    target.orders += 1;
    target.grossRevenue += gross;
    target.refunds += refunded;
    target.netRevenue += gross - refunded;
    target.discounts += Number(order.discountTotal || order.discount || 0);
    target.vat += Number(order.vat || 0);
    target.serviceCharge += Number(order.serviceCharge || 0);
    target.cogs += cogs;
    target.grossProfit += (gross - refunded) - cogs;
    return target;
  };
  const finish = row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, key === 'orders' ? value : money(value)])
  );

  const totals = zero();
  const byPeriod = new Map();
  const byBranch = new Map();
  const byType = new Map();
  const byPaymentMethod = new Map();
  const byItem = new Map();
  const menuItemIds = new Set();

  for (const order of orders) {
    add(totals, order);

    const key = bucketFor(bucket, order.createdAt);
    byPeriod.set(key, add(byPeriod.get(key) || zero(), order));

    const branchKey = String(order.branch);
    byBranch.set(branchKey, add(byBranch.get(branchKey) || zero(), order));

    const typeKey = order.type || 'counter';
    byType.set(typeKey, add(byType.get(typeKey) || zero(), order));

    for (const line of order.items || []) {
      if (!line.menuItem) continue;
      const itemKey = String(line.menuItem);
      menuItemIds.add(itemKey);
      const row = byItem.get(itemKey) || {qty: 0, revenue: 0, cogs: 0, orders: 0, name: line.name};
      row.qty += Number(line.qty || 0);
      row.revenue += Number(line.lineTotal ?? line.lineNet ?? 0);
      row.cogs += Number(line.foodCost || 0) * Number(line.qty || 0);
      row.orders += 1;
      byItem.set(itemKey, row);
    }
  }

  // Payment method comes from the PAYMENT rows, not the order: an order can be
  // settled across several tenders, and attributing all of it to one method
  // would misstate the split.
  const payments = orders.length
    ? await Payment.find({
      order: {$in: orders.map(order => order._id)},
      amount: {$gt: 0},
      status: {$in: ['paid', 'refunded']}
    }).select('method amount').lean()
    : [];
  for (const payment of payments) {
    const key = payment.method || 'cash';
    const row = byPaymentMethod.get(key) || {method: key, count: 0, amount: 0};
    row.count += 1;
    row.amount += Number(payment.amount || 0);
    byPaymentMethod.set(key, row);
  }

  // Category needs the menu item; join once rather than per line.
  const menuItems = menuItemIds.size
    ? await MenuItem.find({_id: {$in: [...menuItemIds]}, restaurant: scope.restaurantId})
      .select('name category').lean()
    : [];
  const menuById = new Map(menuItems.map(row => [String(row._id), row]));
  const byCategory = new Map();
  for (const [itemId, row] of byItem) {
    const item = menuById.get(itemId);
    const category = item?.category || 'Uncategorised';
    const current = byCategory.get(category) || {category, qty: 0, revenue: 0, cogs: 0};
    current.qty += row.qty;
    current.revenue += row.revenue;
    current.cogs += row.cogs;
    byCategory.set(category, current);
  }

  const branches = await Branch.find({_id: {$in: scope.branchIds}}).select('name code').lean();
  const branchById = new Map(branches.map(row => [String(row._id), row]));

  return {
    generatedAt: new Date(),
    currency: 'NPR',
    scope: scope.branch ? 'branch' : 'restaurant',
    branch: scope.branch ? {_id: scope.branch._id, name: scope.branch.name, code: scope.branch.code} : null,
    period: {...period, granularity: bucket},
    totals: {
      ...finish(totals),
      averageOrderValue: totals.orders ? money(totals.netRevenue / totals.orders) : 0
    },
    byPeriod: [...byPeriod.entries()]
      .map(([key, row]) => ({period: key, ...finish(row)}))
      .sort((a, b) => a.period.localeCompare(b.period)),
    byBranch: [...byBranch.entries()].map(([id, row]) => ({
      branch: id,
      branchName: branchById.get(id)?.name || '',
      branchCode: branchById.get(id)?.code || '',
      ...finish(row)
    })).sort((a, b) => b.netRevenue - a.netRevenue),
    byOrderType: [...byType.entries()].map(([type, row]) => ({type, ...finish(row)}))
      .sort((a, b) => b.netRevenue - a.netRevenue),
    byItem: [...byItem.entries()].map(([id, row]) => ({
      menuItem: id,
      name: menuById.get(id)?.name || row.name || 'Item',
      category: menuById.get(id)?.category || 'Uncategorised',
      qty: money(row.qty),
      revenue: money(row.revenue),
      cogs: money(row.cogs),
      grossProfit: money(row.revenue - row.cogs)
    })).sort((a, b) => b.revenue - a.revenue),
    byCategory: [...byCategory.values()].map(row => ({
      category: row.category,
      qty: money(row.qty),
      revenue: money(row.revenue),
      cogs: money(row.cogs),
      grossProfit: money(row.revenue - row.cogs)
    })).sort((a, b) => b.revenue - a.revenue),
    byPaymentMethod: [...byPaymentMethod.values()].map(row => ({
      method: row.method, count: row.count, amount: money(row.amount)
    })).sort((a, b) => b.amount - a.amount)
  };
}

/**
 * Inventory analytics: value on hand, movement, waste, adjustments, count
 * variance and expiry exposure.
 */
export async function buildInventoryReport({branchId, user, from, to}) {
  const scope = await analyticsScope({branchId, user});
  const period = reportingPeriod({from, to});

  const [balances, movements, counts, batches] = await Promise.all([
    InventoryBalance.find({branch: {$in: scope.branchIds}})
      .select('branch ingredient quantity averageCost reorderLevel minLevel').lean(),
    InventoryTransaction.find({
      branch: {$in: scope.branchIds},
      ...dateMatch('createdAt', period)
    }).select('branch ingredient type changeQty totalCost unitCost createdAt reason').lean(),
    StockCount.find({
      restaurant: scope.restaurantId,
      branch: {$in: scope.branchIds},
      status: 'approved',
      ...dateMatch('approvedAt', period)
    }).select('countNo branch scope approvedAt lines varianceLineCount totalVarianceValue').lean(),
    mongoose.model('InventoryBatch').find({
      restaurant: scope.restaurantId,
      branch: {$in: scope.branchIds},
      quantity: {$gt: 1e-9}
    }).select('ingredient quantity unitCost expiryDate').lean()
  ]);

  const ingredientIds = [...new Set([
    ...balances.map(row => String(row.ingredient)),
    ...movements.map(row => String(row.ingredient))
  ])];
  const ingredients = ingredientIds.length
    ? await Ingredient.find({_id: {$in: ingredientIds}, restaurant: scope.restaurantId})
      .select('name code unit category').lean()
    : [];
  const ingredientById = new Map(ingredients.map(row => [String(row._id), row]));

  // Stock value.
  let stockValue = 0;
  const valueByIngredient = new Map();
  for (const balance of balances) {
    const value = Number(balance.quantity || 0) * Number(balance.averageCost || 0);
    stockValue += value;
    const key = String(balance.ingredient);
    const row = valueByIngredient.get(key) || {quantity: 0, value: 0};
    row.quantity += Number(balance.quantity || 0);
    row.value += value;
    valueByIngredient.set(key, row);
  }

  // Movement, waste and adjustments from the ledger — the single source of
  // truth for stock. Nothing here recomputes stock independently.
  const byType = new Map();
  let wasteValue = 0;
  let wasteQty = 0;
  let adjustmentValue = 0;
  let adjustmentQty = 0;
  const wasteByIngredient = new Map();
  for (const row of movements) {
    const type = row.type;
    const current = byType.get(type) || {type, count: 0, quantity: 0, value: 0};
    current.count += 1;
    current.quantity += Math.abs(Number(row.changeQty || 0));
    current.value += Math.abs(Number(row.totalCost || 0));
    byType.set(type, current);

    if (type === 'WASTE') {
      wasteValue += Math.abs(Number(row.totalCost || 0));
      wasteQty += Math.abs(Number(row.changeQty || 0));
      const key = String(row.ingredient);
      const w = wasteByIngredient.get(key) || {quantity: 0, value: 0};
      w.quantity += Math.abs(Number(row.changeQty || 0));
      w.value += Math.abs(Number(row.totalCost || 0));
      wasteByIngredient.set(key, w);
    }
    if (type === 'ADJUSTMENT') {
      adjustmentValue += Math.abs(Number(row.totalCost || 0));
      adjustmentQty += Math.abs(Number(row.changeQty || 0));
    }
  }

  // Count variance, from approved physical counts only. A submitted or stale
  // count is not evidence of anything.
  let varianceValue = 0;
  let varianceLines = 0;
  const countRows = counts.map(count => {
    varianceValue += Number(count.totalVarianceValue || 0);
    varianceLines += Number(count.varianceLineCount || 0);
    return {
      countNo: count.countNo,
      branch: String(count.branch),
      scope: count.scope,
      approvedAt: count.approvedAt,
      varianceLines: Number(count.varianceLineCount || 0),
      varianceValue: money(count.totalVarianceValue || 0)
    };
  });

  // Expiry exposure, graded with the same helper the alerts use so the two
  // cannot disagree.
  const expiry = {expired: {count: 0, quantity: 0, value: 0}, expiring: {count: 0, quantity: 0, value: 0}, fresh: {count: 0, quantity: 0, value: 0}};
  for (const batch of batches) {
    const state = expiryState(batch.expiryDate, {quantity: batch.quantity});
    const target = state === 'expired' ? expiry.expired
      : state === 'expiring' ? expiry.expiring
      : expiry.fresh;
    target.count += 1;
    target.quantity += Number(batch.quantity || 0);
    target.value += Number(batch.quantity || 0) * Number(batch.unitCost || 0);
  }

  const named = (map, extra = () => ({})) => [...map.entries()].map(([id, row]) => ({
    ingredient: id,
    name: ingredientById.get(id)?.name || 'Ingredient',
    code: ingredientById.get(id)?.code || '',
    unit: ingredientById.get(id)?.unit || '',
    quantity: money(row.quantity),
    value: money(row.value),
    ...extra(row)
  }));

  return {
    generatedAt: new Date(),
    currency: 'NPR',
    scope: scope.branch ? 'branch' : 'restaurant',
    branch: scope.branch ? {_id: scope.branch._id, name: scope.branch.name, code: scope.branch.code} : null,
    period,
    stockValue: money(stockValue),
    valuationBasis: 'quantity x weighted average cost, from InventoryBalance',
    topValue: named(valueByIngredient).sort((a, b) => b.value - a.value).slice(0, 50),
    movement: {
      transactions: movements.length,
      byType: [...byType.values()].map(row => ({
        type: row.type, count: row.count, quantity: money(row.quantity), value: money(row.value)
      })).sort((a, b) => b.value - a.value)
    },
    waste: {
      value: money(wasteValue),
      quantity: money(wasteQty),
      events: byType.get('WASTE')?.count || 0,
      byIngredient: named(wasteByIngredient).sort((a, b) => b.value - a.value).slice(0, 25)
    },
    adjustments: {
      value: money(adjustmentValue),
      quantity: money(adjustmentQty),
      events: byType.get('ADJUSTMENT')?.count || 0
    },
    countVariance: {
      counts: countRows.length,
      varianceLines,
      varianceValue: money(varianceValue),
      recent: countRows.sort((a, b) => new Date(b.approvedAt) - new Date(a.approvedAt)).slice(0, 20)
    },
    expiry: {
      expired: {count: expiry.expired.count, quantity: money(expiry.expired.quantity), value: money(expiry.expired.value)},
      expiring: {count: expiry.expiring.count, quantity: money(expiry.expiring.quantity), value: money(expiry.expiring.value)},
      fresh: {count: expiry.fresh.count, quantity: money(expiry.fresh.quantity), value: money(expiry.fresh.value)}
    }
  };
}

/**
 * Customer analytics: repeat rate, average order value, top customers.
 */
export async function buildCustomerReport({branchId, user, from, to, limit = 20}) {
  const scope = await analyticsScope({branchId, user});
  const period = reportingPeriod({from, to});
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 20));

  const orders = await Order.find({
    branch: {$in: scope.branchIds},
    status: REVENUE_STATUSES,
    ...dateMatch('createdAt', period)
  }).select('customer total refundAmount createdAt').lean();

  let identifiedRevenue = 0;
  let anonymousOrders = 0;
  let anonymousRevenue = 0;
  const byCustomer = new Map();

  for (const order of orders) {
    const net = Number(order.total || 0) - Number(order.refundAmount || 0);
    if (!order.customer) {
      anonymousOrders += 1;
      anonymousRevenue += net;
      continue;
    }
    identifiedRevenue += net;
    const key = String(order.customer);
    const row = byCustomer.get(key) || {orders: 0, revenue: 0, first: order.createdAt, last: order.createdAt};
    row.orders += 1;
    row.revenue += net;
    if (new Date(order.createdAt) < new Date(row.first)) row.first = order.createdAt;
    if (new Date(order.createdAt) > new Date(row.last)) row.last = order.createdAt;
    byCustomer.set(key, row);
  }

  const customerIds = [...byCustomer.keys()];
  const customers = customerIds.length
    ? await Customer.find({_id: {$in: customerIds}, restaurant: scope.restaurantId})
      .select('name phone tier lifetimeSpend').lean()
    : [];
  const customerById = new Map(customers.map(row => [String(row._id), row]));

  // A repeat customer is one with more than one order IN THIS PERIOD. Stated
  // explicitly because "repeat" is otherwise ambiguous against lifetime data.
  const repeat = [...byCustomer.values()].filter(row => row.orders > 1);
  const identifiedOrders = orders.length - anonymousOrders;

  return {
    generatedAt: new Date(),
    currency: 'NPR',
    scope: scope.branch ? 'branch' : 'restaurant',
    branch: scope.branch ? {_id: scope.branch._id, name: scope.branch.name, code: scope.branch.code} : null,
    period,
    totals: {
      orders: orders.length,
      identifiedOrders,
      anonymousOrders,
      customers: byCustomer.size,
      repeatCustomers: repeat.length,
      repeatRate: byCustomer.size ? money((repeat.length / byCustomer.size) * 100) : 0,
      repeatBasis: 'More than one order within the reporting period',
      revenue: money(identifiedRevenue + anonymousRevenue),
      identifiedRevenue: money(identifiedRevenue),
      anonymousRevenue: money(anonymousRevenue),
      averageOrderValue: orders.length
        ? money((identifiedRevenue + anonymousRevenue) / orders.length) : 0,
      averageIdentifiedOrderValue: identifiedOrders
        ? money(identifiedRevenue / identifiedOrders) : 0
    },
    topCustomers: [...byCustomer.entries()].map(([id, row]) => ({
      customer: id,
      name: customerById.get(id)?.name || 'Customer',
      phone: customerById.get(id)?.phone || '',
      tier: customerById.get(id)?.tier || null,
      orders: row.orders,
      revenue: money(row.revenue),
      averageOrderValue: money(row.revenue / row.orders),
      firstOrderAt: row.first,
      lastOrderAt: row.last,
      repeat: row.orders > 1
    })).sort((a, b) => b.revenue - a.revenue).slice(0, safeLimit)
  };
}
