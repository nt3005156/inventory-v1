import mongoose from 'mongoose';
import {Ingredient, Supplier} from '../models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, PurchaseOrder, SupplierInvoice
} from '../models/operations.js';
import {SupplierIngredient} from '../models/supplierCatalog.js';
import {GoodsReceipt} from '../models/purchasing.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';

/**
 * Phase 16 — procurement intelligence.
 *
 * The purchasing engine (orders, receiving, returns, invoices, payments,
 * statements) already existed. What was missing was everything that helps a
 * buyer decide WHAT to order, from WHOM, and at WHAT price:
 *
 *   * reorder suggestions   — nothing existed; a buyer read the low-stock
 *                             alert and worked out quantities by hand
 *   * preferred supplier    — no concept; the catalog listed every supplier
 *                             for an ingredient with no ranking
 *   * price comparison      — no endpoint (probe: 404)
 *   * purchase history      — per-ingredient ledger history existed, but not
 *                             per supplier/ingredient pair for negotiation
 *   * purchase-by-supplier / by-branch / price-change / unpaid-invoice
 *                             reports — all 404
 */

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Resolve the branch scope: one branch, or every branch for an owner. */
async function resolveScope({branchId, user}) {
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

/** Suppliers that may be ordered from. On-hold and blacklisted ones may not. */
const ORDERABLE_SUPPLIER_STATUSES = ['active'];

/**
 * Ranks the catalog entries for one ingredient.
 *
 * "Preferred" is derived rather than a flag someone has to remember to set:
 * the cheapest effective price per BASE unit from an orderable supplier wins,
 * with the shorter lead time breaking a tie. Comparing headline prices would
 * be wrong — one supplier quotes per kg VAT-exclusive, another per 500g
 * VAT-inclusive.
 */
export function rankCatalogOptions(entries, {suppliersById} = {}) {
  const options = entries.map(entry => {
    const supplier = suppliersById?.get(String(entry.supplier?._id || entry.supplier)) || entry.supplier || {};
    const factor = Number(entry.conversionFactor || 1) || 1;
    const price = Number(entry.currentPrice || 0);
    // Normalise to a comparable number: VAT-inclusive quotes are stripped back
    // to net, then divided by how many base units the purchase unit holds.
    const netPrice = entry.priceIncludesVat
      ? price / (1 + Number(entry.vatRate || 0) / 100)
      : price;
    const status = clean(supplier.status) || (supplier.active === false ? 'inactive' : 'active');
    const leadDays = Number(entry.leadDays ?? supplier.leadTimeDays ?? 0);
    return {
      catalogItem: entry._id,
      supplier: supplier._id || entry.supplier,
      supplierName: supplier.name || 'Supplier',
      supplierStatus: status,
      orderable: ORDERABLE_SUPPLIER_STATUSES.includes(status) && entry.active !== false,
      supplierSku: entry.supplierSku || '',
      purchaseUnit: entry.purchaseUnit,
      baseUnit: entry.baseUnit,
      conversionFactor: factor,
      currentPrice: money(price),
      previousPrice: money(entry.previousPrice || 0),
      priceIncludesVat: Boolean(entry.priceIncludesVat),
      vatRate: Number(entry.vatRate || 0),
      effectiveUnitCost: money(netPrice / factor),
      // minOrderQty is expressed in PURCHASE units (e.g. 2 kg), so the base-unit
      // equivalent is what a base-unit shortfall must be rounded against.
      minOrderQty: Number(entry.minOrderQty || 0),
      minOrderQtyBase: money(Number(entry.minOrderQty || 0) * factor),
      leadDays
    };
  });

  options.sort((left, right) => {
    // An unorderable supplier is never preferred, however cheap.
    if (left.orderable !== right.orderable) return left.orderable ? -1 : 1;
    if (left.effectiveUnitCost !== right.effectiveUnitCost) {
      return left.effectiveUnitCost - right.effectiveUnitCost;
    }
    if (left.leadDays !== right.leadDays) return left.leadDays - right.leadDays;
    return String(left.supplierName).localeCompare(String(right.supplierName));
  });

  const preferred = options.find(option => option.orderable) || null;
  const cheapest = preferred;
  const baseline = preferred?.effectiveUnitCost ?? 0;
  return {
    options: options.map(option => ({
      ...option,
      preferred: preferred ? String(option.catalogItem) === String(preferred.catalogItem) : false,
      // How much more this supplier costs than the preferred one, per base
      // unit — the number a buyer actually negotiates with.
      premiumPerUnit: baseline > 0 ? money(option.effectiveUnitCost - baseline) : 0,
      premiumPercent: baseline > 0
        ? money(((option.effectiveUnitCost - baseline) / baseline) * 100)
        : 0
    })),
    preferred,
    cheapest
  };
}

/**
 * Price comparison for one ingredient across every supplier that lists it.
 */
export async function compareIngredientPrices({ingredientId, user}) {
  if (!mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient', 400);
  const identity = await userRestaurantContext(user);
  const ingredient = await Ingredient.findOne({_id: ingredientId, restaurant: identity.restaurantId})
    .select('name code unit').lean();
  if (!ingredient) throw httpError('Ingredient not found', 404);

  const entries = await SupplierIngredient.find({
    restaurant: identity.restaurantId, ingredient: ingredient._id
  }).populate('supplier', 'name status active leadTimeDays creditLimit').lean();

  const suppliersById = new Map(
    entries.filter(row => row.supplier?._id).map(row => [String(row.supplier._id), row.supplier])
  );
  const ranked = rankCatalogOptions(entries, {suppliersById});

  return {
    ingredient: {
      _id: ingredient._id, name: ingredient.name, code: ingredient.code || '', unit: ingredient.unit
    },
    supplierCount: ranked.options.length,
    orderableCount: ranked.options.filter(option => option.orderable).length,
    preferredSupplier: ranked.preferred,
    options: ranked.options,
    // Stated so a buyer can see the comparison is not naive.
    basis: 'Effective cost per base unit, VAT-exclusive, after purchase-unit conversion'
  };
}

/**
 * Reorder suggestions.
 *
 * A line is suggested when on-hand is at or below the reorder level. The
 * quantity is whatever brings stock back to the target (reorder level plus
 * the configured reorder quantity), rounded up to the preferred supplier's
 * minimum order quantity. Stock already on an open purchase order is
 * subtracted, so a buyer who ordered yesterday is not told to order again.
 */
export async function buildReorderSuggestions({branchId, user, includeAll = false}) {
  const scope = await resolveScope({branchId, user});

  const [balances, ingredients, catalog, openOrders] = await Promise.all([
    InventoryBalance.find({branch: {$in: scope.branchIds}})
      .select('branch ingredient quantity reorderLevel minLevel').lean(),
    Ingredient.find({restaurant: scope.restaurantId, active: {$ne: false}})
      .select('name code unit minimumStock reorderQty reorderLevel').lean(),
    SupplierIngredient.find({restaurant: scope.restaurantId, active: {$ne: false}})
      .populate('supplier', 'name status active leadTimeDays').lean(),
    PurchaseOrder.find({
      restaurant: scope.restaurantId,
      branch: {$in: scope.branchIds},
      status: {$in: ['draft', 'pending', 'approved', 'sent', 'partially_received']}
    }).select('items status').lean()
  ]);

  const ingredientById = new Map(ingredients.map(row => [String(row._id), row]));
  const suppliersById = new Map(
    catalog.filter(row => row.supplier?._id).map(row => [String(row.supplier._id), row.supplier])
  );
  const catalogByIngredient = new Map();
  for (const entry of catalog) {
    const key = String(entry.ingredient);
    if (!catalogByIngredient.has(key)) catalogByIngredient.set(key, []);
    catalogByIngredient.get(key).push(entry);
  }

  // Quantity already ordered but not yet received, per ingredient.
  const onOrder = new Map();
  for (const order of openOrders) {
    for (const item of order.items || []) {
      const key = String(item.ingredient);
      const outstanding = Math.max(0, Number(item.orderedQty || 0) - Number(item.receivedQty || 0));
      if (outstanding > 0) onOrder.set(key, (onOrder.get(key) || 0) + outstanding);
    }
  }

  const byIngredient = new Map();
  for (const balance of balances) {
    const key = String(balance.ingredient);
    const current = byIngredient.get(key) || {quantity: 0, reorderLevel: 0};
    current.quantity += Number(balance.quantity || 0);
    current.reorderLevel = Math.max(
      current.reorderLevel,
      Number(balance.reorderLevel || balance.minLevel || 0)
    );
    byIngredient.set(key, current);
  }
  // An ingredient with no balance row at all is out of stock, not absent.
  for (const ingredient of ingredients) {
    const key = String(ingredient._id);
    if (!byIngredient.has(key)) byIngredient.set(key, {quantity: 0, reorderLevel: 0});
  }

  const suggestions = [];
  for (const [ingredientId, stock] of byIngredient) {
    const ingredient = ingredientById.get(ingredientId);
    if (!ingredient) continue;

    const reorderLevel = Number(stock.reorderLevel || ingredient.reorderLevel || ingredient.minimumStock || 0);
    const onHand = money(stock.quantity);
    const pending = money(onOrder.get(ingredientId) || 0);
    const belowLevel = reorderLevel > 0 && onHand <= reorderLevel;
    if (!belowLevel && !includeAll) continue;

    const target = reorderLevel + Number(ingredient.reorderQty || 0);
    // Anything already on order counts towards the target.
    const shortfall = money(Math.max(0, target - onHand - pending));

    const ranked = rankCatalogOptions(catalogByIngredient.get(ingredientId) || [], {suppliersById});
    const preferred = ranked.preferred;
    let suggestedQty = shortfall;
    if (preferred && preferred.minOrderQtyBase > 0 && suggestedQty > 0) {
      // Round up to a whole multiple of the supplier's minimum, converted into
      // the base unit the shortfall is measured in. Comparing a gram shortfall
      // against a kilogram minimum would understate the order by 1000x.
      const multiples = Math.ceil(suggestedQty / preferred.minOrderQtyBase);
      suggestedQty = money(multiples * preferred.minOrderQtyBase);
    }

    suggestions.push({
      ingredient: ingredient._id,
      ingredientName: ingredient.name,
      ingredientCode: ingredient.code || '',
      unit: ingredient.unit,
      onHand,
      onOrder: pending,
      reorderLevel: money(reorderLevel),
      reorderQty: money(ingredient.reorderQty || 0),
      target: money(target),
      shortfall,
      suggestedQty,
      // Why this line is here, in words a buyer can check.
      reason: onHand <= 0
        ? 'Out of stock'
        : belowLevel
          ? `On hand ${onHand} is at or below the reorder level ${money(reorderLevel)}`
          : 'Above reorder level (listed because includeAll was requested)',
      urgency: onHand <= 0 ? 'critical' : belowLevel ? 'reorder' : 'ok',
      alreadyCovered: belowLevel && shortfall <= 0,
      preferredSupplier: preferred,
      estimatedCost: preferred ? money(suggestedQty * preferred.effectiveUnitCost) : null,
      leadDays: preferred?.leadDays ?? null,
      supplierOptions: ranked.options.length,
      // A line with no orderable supplier cannot be actioned; say so rather
      // than emitting a suggestion nobody can fulfil.
      actionable: Boolean(preferred) && suggestedQty > 0
    });
  }

  suggestions.sort((left, right) => {
    const rank = {critical: 0, reorder: 1, ok: 2};
    if (rank[left.urgency] !== rank[right.urgency]) return rank[left.urgency] - rank[right.urgency];
    return String(left.ingredientName).localeCompare(String(right.ingredientName));
  });

  return {
    branch: scope.branch ? {_id: scope.branch._id, name: scope.branch.name, code: scope.branch.code} : null,
    scope: scope.branch ? 'branch' : 'restaurant',
    generatedAt: new Date(),
    currency: 'NPR',
    counts: {
      total: suggestions.length,
      critical: suggestions.filter(row => row.urgency === 'critical').length,
      reorder: suggestions.filter(row => row.urgency === 'reorder').length,
      actionable: suggestions.filter(row => row.actionable).length,
      blocked: suggestions.filter(row => !row.preferredSupplier).length
    },
    estimatedTotal: money(suggestions.reduce((sum, row) => sum + Number(row.estimatedCost || 0), 0)),
    suggestions
  };
}

/**
 * Purchase history for an ingredient, optionally narrowed to one supplier.
 *
 * Read from the goods-receipt ledger rather than from purchase orders, so it
 * reflects what was actually delivered and charged, not what was ordered.
 */
export async function getIngredientPurchaseHistory({ingredientId, supplierId, branchId, user, limit = 50}) {
  if (!mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient', 400);
  const scope = await resolveScope({branchId, user});
  const ingredient = await Ingredient.findOne({_id: ingredientId, restaurant: scope.restaurantId})
    .select('name code unit').lean();
  if (!ingredient) throw httpError('Ingredient not found', 404);

  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const match = {
    branch: {$in: scope.branchIds},
    ingredient: ingredient._id,
    type: 'PURCHASE',
    referenceType: 'goods_receipt'
  };

  const rows = await InventoryTransaction.find(match)
    .sort({createdAt: -1, _id: -1})
    .limit(safeLimit)
    .populate('branch', 'name code')
    .lean();

  // The goods receipt carries the supplier and the originating PO directly,
  // so the history is joined on the receipt rather than guessed from the order.
  const receiptIds = rows.map(row => row.referenceId).filter(Boolean);
  const receipts = receiptIds.length
    ? await GoodsReceipt.find({restaurant: scope.restaurantId, _id: {$in: receiptIds}})
      .select('supplier purchaseOrder receiptNo')
      .populate('supplier', 'name')
      .populate('purchaseOrder', 'poNo')
      .lean()
    : [];
  const supplierByReceipt = new Map(
    receipts.map(receipt => [String(receipt._id), {
      supplier: receipt.supplier,
      order: receipt.purchaseOrder,
      receiptNo: receipt.receiptNo
    }])
  );

  let history = rows.map(row => {
    const link = supplierByReceipt.get(String(row.referenceId));
    return {
      _id: row._id,
      at: row.createdAt,
      branch: row.branch?._id || row.branch,
      branchName: row.branch?.name || '',
      quantity: money(row.changeQty),
      unit: row.unit,
      unitCost: money(row.unitCost),
      lineValue: money(Math.abs(Number(row.changeQty || 0)) * Number(row.unitCost || 0)),
      supplier: link?.supplier?._id || null,
      supplierName: link?.supplier?.name || null,
      poNo: link?.order?.poNo || null,
      receiptNo: link?.receiptNo || null,
      batchNumber: (row.batchMovements || [])[0]?.batchNumber || null
    };
  });

  if (supplierId) {
    if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
    history = history.filter(row => String(row.supplier || '') === String(supplierId));
  }

  const costs = history.map(row => row.unitCost).filter(value => value > 0);
  const latest = costs[0] ?? 0;
  const previous = costs[1] ?? 0;
  return {
    ingredient: {
      _id: ingredient._id, name: ingredient.name, code: ingredient.code || '', unit: ingredient.unit
    },
    count: history.length,
    priceTrend: {
      latest: money(latest),
      previous: money(previous),
      delta: money(latest - previous),
      deltaPercent: previous > 0 ? money(((latest - previous) / previous) * 100) : 0,
      lowest: costs.length ? money(Math.min(...costs)) : 0,
      highest: costs.length ? money(Math.max(...costs)) : 0,
      average: costs.length ? money(costs.reduce((sum, value) => sum + value, 0) / costs.length) : 0
    },
    history
  };
}

/**
 * Unpaid supplier invoices, aged. Answers "what do we owe, and how late is it".
 */
export async function listUnpaidInvoices({branchId, supplierId, user, asOf = new Date()}) {
  const scope = await resolveScope({branchId, user});
  const match = {
    restaurant: scope.restaurantId,
    branch: {$in: scope.branchIds},
    status: {$in: ['unpaid', 'partially_paid', 'partial']}
  };
  if (supplierId) {
    if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
    match.supplier = new mongoose.Types.ObjectId(String(supplierId));
  }

  const invoices = await SupplierInvoice.find(match)
    .sort({dueDate: 1, invoiceDate: 1})
    .populate('supplier', 'name status creditLimit paymentTermsDays')
    .populate('branch', 'name code')
    .lean();

  const now = asOf instanceof Date ? asOf : new Date(asOf);
  const buckets = {current: 0, days1To30: 0, days31To60: 0, days61To90: 0, over90: 0};

  const rows = invoices.map(invoice => {
    const outstanding = money(Number(invoice.total || 0) - Number(invoice.paidAmount || 0));
    const due = invoice.dueDate ? new Date(invoice.dueDate) : null;
    const daysOverdue = due ? Math.floor((now - due) / 86400000) : 0;
    const bucket = !due || daysOverdue <= 0 ? 'current'
      : daysOverdue <= 30 ? 'days1To30'
      : daysOverdue <= 60 ? 'days31To60'
      : daysOverdue <= 90 ? 'days61To90'
      : 'over90';
    buckets[bucket] = money(buckets[bucket] + outstanding);
    return {
      _id: invoice._id,
      invoiceNo: invoice.invoiceNo,
      supplier: invoice.supplier?._id || invoice.supplier,
      supplierName: invoice.supplier?.name || 'Supplier',
      branch: invoice.branch?._id || invoice.branch,
      branchName: invoice.branch?.name || '',
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate || null,
      total: money(invoice.total),
      paidAmount: money(invoice.paidAmount || 0),
      outstanding,
      daysOverdue: Math.max(0, daysOverdue),
      overdue: daysOverdue > 0,
      bucket,
      status: invoice.status
    };
  }).filter(row => row.outstanding > 0.009);

  return {
    asOf: now,
    scope: scope.branch ? 'branch' : 'restaurant',
    count: rows.length,
    totalOutstanding: money(rows.reduce((sum, row) => sum + row.outstanding, 0)),
    overdueCount: rows.filter(row => row.overdue).length,
    overdueOutstanding: money(rows.filter(row => row.overdue).reduce((sum, row) => sum + row.outstanding, 0)),
    aging: buckets,
    invoices: rows
  };
}

/**
 * Purchases grouped by supplier or by branch, from received goods.
 */
export async function purchaseSummary({groupBy = 'supplier', branchId, user, from, to}) {
  const dimension = clean(groupBy) || 'supplier';
  if (!['supplier', 'branch'].includes(dimension)) {
    throw httpError('groupBy must be supplier or branch', 400);
  }
  const scope = await resolveScope({branchId, user});
  const range = {};
  if (from) range.$gte = new Date(`${from}T00:00:00.000+05:45`);
  if (to) range.$lt = new Date(new Date(`${to}T00:00:00.000+05:45`).getTime() + 86400000);

  const orders = await PurchaseOrder.find({
    restaurant: scope.restaurantId,
    branch: {$in: scope.branchIds},
    status: {$in: ['approved', 'sent', 'partially_received', 'received', 'closed_short']},
    ...(Object.keys(range).length ? {orderDate: range} : {})
  })
    .populate('supplier', 'name status')
    .populate('branch', 'name code')
    .lean();

  const groups = new Map();
  for (const order of orders) {
    const target = dimension === 'supplier' ? order.supplier : order.branch;
    const key = String(target?._id || target || 'unknown');
    const group = groups.get(key) || {
      _id: target?._id || null,
      name: target?.name || 'Unknown',
      ...(dimension === 'branch' ? {code: target?.code || ''} : {status: target?.status || 'active'}),
      orderCount: 0,
      orderedValue: 0,
      receivedValue: 0,
      orderedQty: 0,
      receivedQty: 0
    };
    group.orderCount += 1;
    group.orderedValue = money(group.orderedValue + Number(order.total || 0));
    for (const item of order.items || []) {
      const ordered = Number(item.orderedQty || 0);
      const received = Number(item.receivedQty || 0);
      group.orderedQty = money(group.orderedQty + ordered);
      group.receivedQty = money(group.receivedQty + received);
      group.receivedValue = money(group.receivedValue + received * Number(item.unitPrice || 0));
    }
    groups.set(key, group);
  }

  const rows = [...groups.values()].sort((left, right) => right.orderedValue - left.orderedValue);
  return {
    groupBy: dimension,
    scope: scope.branch ? 'branch' : 'restaurant',
    from: from || null,
    to: to || null,
    count: rows.length,
    totals: {
      orderCount: rows.reduce((sum, row) => sum + row.orderCount, 0),
      orderedValue: money(rows.reduce((sum, row) => sum + row.orderedValue, 0)),
      receivedValue: money(rows.reduce((sum, row) => sum + row.receivedValue, 0))
    },
    rows
  };
}

/**
 * Ingredient purchase prices and how they have moved.
 *
 * Compares the most recent received unit cost against the one before it, per
 * ingredient, so a buyer sees which inputs are drifting up.
 */
export async function ingredientPriceReport({branchId, user, limit = 200}) {
  const scope = await resolveScope({branchId, user});
  const rows = await InventoryTransaction.find({
    branch: {$in: scope.branchIds},
    type: 'PURCHASE',
    referenceType: 'goods_receipt'
  }).sort({createdAt: -1, _id: -1}).limit(Math.min(2000, Math.max(1, Number(limit) * 10 || 2000))).lean();

  const byIngredient = new Map();
  for (const row of rows) {
    const key = String(row.ingredient);
    if (!byIngredient.has(key)) byIngredient.set(key, []);
    byIngredient.get(key).push(row);
  }

  const ingredients = await Ingredient.find({
    _id: {$in: [...byIngredient.keys()]}, restaurant: scope.restaurantId
  }).select('name code unit').lean();
  const ingredientById = new Map(ingredients.map(row => [String(row._id), row]));

  const report = [];
  for (const [ingredientId, movements] of byIngredient) {
    const ingredient = ingredientById.get(ingredientId);
    if (!ingredient) continue;
    const costs = movements.map(row => Number(row.unitCost || 0)).filter(value => value > 0);
    if (!costs.length) continue;
    const latest = costs[0];
    const previous = costs[1] ?? 0;
    const delta = money(latest - previous);
    report.push({
      ingredient: ingredient._id,
      ingredientName: ingredient.name,
      ingredientCode: ingredient.code || '',
      unit: ingredient.unit,
      purchases: movements.length,
      latestCost: money(latest),
      previousCost: money(previous),
      delta,
      deltaPercent: previous > 0 ? money((delta / previous) * 100) : 0,
      trend: previous <= 0 ? 'new' : delta > 0.009 ? 'up' : delta < -0.009 ? 'down' : 'flat',
      lowest: money(Math.min(...costs)),
      highest: money(Math.max(...costs)),
      average: money(costs.reduce((sum, value) => sum + value, 0) / costs.length),
      lastPurchasedAt: movements[0].createdAt
    });
  }

  report.sort((left, right) => Math.abs(right.deltaPercent) - Math.abs(left.deltaPercent));
  const capped = report.slice(0, Math.min(500, Math.max(1, Number(limit) || 200)));
  return {
    scope: scope.branch ? 'branch' : 'restaurant',
    count: capped.length,
    increases: capped.filter(row => row.trend === 'up').length,
    decreases: capped.filter(row => row.trend === 'down').length,
    rows: capped
  };
}
