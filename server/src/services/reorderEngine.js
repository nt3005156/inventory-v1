import mongoose from 'mongoose';
import {Ingredient} from '../models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Notification, PurchaseOrder
} from '../models/operations.js';
import {SupplierIngredient} from '../models/supplierCatalog.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {rankCatalogOptions} from './procurement.js';

/**
 * Phase 17 — reorder point engine.
 *
 * Phase 16 added reorder SUGGESTIONS, but they restored stock to a static
 * level someone had typed in. That ignores how fast an ingredient actually
 * moves: a static level of 2kg is far too low for something the kitchen burns
 * 3kg of a day, and far too high for something used twice a month.
 *
 * This computes the reorder point the way the brief states:
 *
 *     reorderPoint = averageDailyUsage × leadTimeDays + safetyStock
 *
 * `averageDailyUsage` is measured from the consumption ledger over a lookback
 * window. `leadTimeDays` comes from the preferred supplier's catalog entry (or
 * the supplier's default). `safetyStock` covers demand variability during the
 * lead time — computed from the standard deviation of daily usage rather than
 * guessed, so a volatile ingredient carries more cover than a steady one.
 */

const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const round3 = value => Math.round((Number(value || 0) + Number.EPSILON) * 1000) / 1000;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Movement types that represent stock genuinely leaving for service. */
export const CONSUMPTION_TYPES = ['RECIPE_DEDUCTION', 'SALE', 'WASTE'];

/** Default lookback for the usage average, in days. */
export const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Service level → z-score, for the safety-stock term.
 *
 * 95% is the usual retail/food default: cover all but roughly one stockout in
 * twenty replenishment cycles. Exposed so it can be reasoned about rather than
 * being an unexplained 1.65 in the arithmetic.
 */
export const SERVICE_LEVEL_Z = Object.freeze({90: 1.28, 95: 1.65, 97: 1.88, 99: 2.33});

/**
 * Safety stock for demand variability over the lead time.
 *
 *     safetyStock = z × stdDevDailyUsage × sqrt(leadTimeDays)
 *
 * The square root is not decoration: variance accumulates linearly over
 * independent days, so the standard deviation grows with the square root of
 * the lead time. Multiplying by leadTime instead would massively overstock.
 */
export function safetyStockFor({stdDevDailyUsage, leadTimeDays, serviceLevel = 95}) {
  const z = SERVICE_LEVEL_Z[serviceLevel] ?? SERVICE_LEVEL_Z[95];
  const lead = Math.max(0, Number(leadTimeDays || 0));
  const sd = Math.max(0, Number(stdDevDailyUsage || 0));
  return round3(z * sd * Math.sqrt(lead));
}

/**
 * The brief's formula, isolated so it can be tested directly.
 */
export function reorderPointFor({averageDailyUsage, leadTimeDays, safetyStock = 0}) {
  const usage = Math.max(0, Number(averageDailyUsage || 0));
  const lead = Math.max(0, Number(leadTimeDays || 0));
  return round3(usage * lead + Math.max(0, Number(safetyStock || 0)));
}

/** Mean and population standard deviation over a fixed set of daily totals. */
export function usageStatistics(dailyTotals = []) {
  if (!dailyTotals.length) return {average: 0, stdDev: 0, days: 0, total: 0, peak: 0};
  const total = dailyTotals.reduce((sum, value) => sum + value, 0);
  const average = total / dailyTotals.length;
  const variance = dailyTotals.reduce((sum, value) => sum + (value - average) ** 2, 0) / dailyTotals.length;
  return {
    average: round3(average),
    stdDev: round3(Math.sqrt(variance)),
    days: dailyTotals.length,
    total: round3(total),
    peak: round3(Math.max(...dailyTotals))
  };
}

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

/**
 * Daily consumption per ingredient over the lookback window.
 *
 * Days with no consumption count as ZERO rather than being dropped. Averaging
 * only the days something moved would overstate demand for anything used
 * intermittently — a spice used once a week would look like a daily staple.
 */
export async function dailyUsageByIngredient({branchIds, lookbackDays = DEFAULT_LOOKBACK_DAYS, asOf = new Date()}) {
  const days = Math.min(365, Math.max(1, Number(lookbackDays) || DEFAULT_LOOKBACK_DAYS));
  const end = new Date(asOf);
  const start = new Date(end.getTime() - days * 86400000);

  const rows = await InventoryTransaction.find({
    branch: {$in: branchIds},
    type: {$in: CONSUMPTION_TYPES},
    createdAt: {$gte: start, $lt: end}
  }).select('ingredient changeQty createdAt').lean();

  const byIngredient = new Map();
  for (const row of rows) {
    const key = String(row.ingredient);
    const dayIndex = Math.floor((new Date(row.createdAt).getTime() - start.getTime()) / 86400000);
    if (dayIndex < 0 || dayIndex >= days) continue;
    const buckets = byIngredient.get(key) || new Array(days).fill(0);
    buckets[dayIndex] += Math.abs(Number(row.changeQty || 0));
    byIngredient.set(key, buckets);
  }

  const stats = new Map();
  for (const [ingredientId, buckets] of byIngredient) {
    stats.set(ingredientId, {...usageStatistics(buckets), lookbackDays: days});
  }
  return stats;
}

/**
 * Builds a suggested purchase order per supplier.
 *
 * A suggestion is raised when on-hand (plus what is already on order) has
 * fallen to or below the computed reorder point. The quantity ordered is
 * enough to reach the reorder point plus one lead time of cover, rounded up to
 * the supplier's minimum order quantity in base units.
 */
export async function buildReorderPlan({
  branchId, user, lookbackDays = DEFAULT_LOOKBACK_DAYS, serviceLevel = 95, includeAll = false
}) {
  const scope = await resolveScope({branchId, user});
  const level = SERVICE_LEVEL_Z[serviceLevel] ? Number(serviceLevel) : 95;

  const [balances, ingredients, catalog, openOrders, usage] = await Promise.all([
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
    }).select('items').lean(),
    dailyUsageByIngredient({branchIds: scope.branchIds, lookbackDays})
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

  const onOrder = new Map();
  for (const order of openOrders) {
    for (const item of order.items || []) {
      const key = String(item.ingredient);
      const outstanding = Math.max(0, Number(item.orderedQty || 0) - Number(item.receivedQty || 0));
      if (outstanding > 0) onOrder.set(key, (onOrder.get(key) || 0) + outstanding);
    }
  }

  const stockByIngredient = new Map();
  for (const balance of balances) {
    const key = String(balance.ingredient);
    const current = stockByIngredient.get(key) || {quantity: 0, staticLevel: 0};
    current.quantity += Number(balance.quantity || 0);
    current.staticLevel = Math.max(current.staticLevel, Number(balance.reorderLevel || balance.minLevel || 0));
    stockByIngredient.set(key, current);
  }
  for (const ingredient of ingredients) {
    const key = String(ingredient._id);
    if (!stockByIngredient.has(key)) stockByIngredient.set(key, {quantity: 0, staticLevel: 0});
  }

  const lines = [];
  for (const [ingredientId, stock] of stockByIngredient) {
    const ingredient = ingredientById.get(ingredientId);
    if (!ingredient) continue;

    const ranked = rankCatalogOptions(catalogByIngredient.get(ingredientId) || [], {suppliersById});
    const preferred = ranked.preferred;
    const stats = usage.get(ingredientId) || {average: 0, stdDev: 0, days: 0, total: 0, peak: 0, lookbackDays};
    const leadTimeDays = Number(preferred?.leadDays ?? 0);

    const safetyStock = safetyStockFor({
      stdDevDailyUsage: stats.stdDev, leadTimeDays, serviceLevel: level
    });
    const computedPoint = reorderPointFor({
      averageDailyUsage: stats.average, leadTimeDays, safetyStock
    });
    // A configured static level is a floor, never a ceiling: an operator who
    // insists on holding 5kg is not overridden by a formula that says 2kg.
    const staticLevel = Number(stock.staticLevel || ingredient.reorderLevel || ingredient.minimumStock || 0);
    const reorderPoint = round3(Math.max(computedPoint, staticLevel));

    const onHand = round3(stock.quantity);
    const pending = round3(onOrder.get(ingredientId) || 0);
    const available = round3(onHand + pending);
    const belowPoint = reorderPoint > 0 && available <= reorderPoint;
    if (!belowPoint && !includeAll) continue;

    // Order up to the reorder point plus one lead time of cover, so the next
    // delivery does not arrive exactly as stock hits the trigger again.
    const orderUpTo = round3(reorderPoint + stats.average * Math.max(leadTimeDays, 1));
    let suggestedQty = round3(Math.max(0, orderUpTo - available));
    if (preferred && preferred.minOrderQtyBase > 0 && suggestedQty > 0) {
      const multiples = Math.ceil(suggestedQty / preferred.minOrderQtyBase);
      suggestedQty = round3(multiples * preferred.minOrderQtyBase);
    }

    lines.push({
      ingredient: ingredient._id,
      ingredientName: ingredient.name,
      ingredientCode: ingredient.code || '',
      unit: ingredient.unit,
      currentStock: onHand,
      onOrder: pending,
      available,
      // The formula, exposed term by term so a manager can check the number.
      averageDailyUsage: stats.average,
      usageStdDev: stats.stdDev,
      usagePeak: stats.peak,
      lookbackDays: stats.lookbackDays ?? lookbackDays,
      leadTimeDays,
      safetyStock,
      computedReorderPoint: computedPoint,
      configuredReorderLevel: round3(staticLevel),
      reorderPoint,
      reorderPointBasis: computedPoint >= staticLevel
        ? 'usage x lead time + safety stock'
        : 'configured minimum (higher than the computed point)',
      orderUpTo,
      suggestedQty,
      supplier: preferred?.supplier || null,
      supplierName: preferred?.supplierName || null,
      unitCost: preferred ? preferred.effectiveUnitCost : null,
      expectedCost: preferred ? money(suggestedQty * preferred.effectiveUnitCost) : null,
      urgency: onHand <= 0 ? 'critical' : available <= reorderPoint ? 'reorder' : 'ok',
      daysOfCoverRemaining: stats.average > 0 ? round3(onHand / stats.average) : null,
      actionable: Boolean(preferred) && suggestedQty > 0,
      blockedReason: preferred ? null : 'No orderable supplier lists this ingredient'
    });
  }

  lines.sort((left, right) => {
    const rank = {critical: 0, reorder: 1, ok: 2};
    if (rank[left.urgency] !== rank[right.urgency]) return rank[left.urgency] - rank[right.urgency];
    const leftCover = left.daysOfCoverRemaining ?? Infinity;
    const rightCover = right.daysOfCoverRemaining ?? Infinity;
    if (leftCover !== rightCover) return leftCover - rightCover;
    return String(left.ingredientName).localeCompare(String(right.ingredientName));
  });

  // Group the actionable lines into one suggested PO per supplier, which is
  // the unit a manager actually approves.
  const bySupplier = new Map();
  for (const line of lines) {
    if (!line.actionable) continue;
    const key = String(line.supplier);
    const group = bySupplier.get(key) || {
      supplier: line.supplier, supplierName: line.supplierName,
      lineCount: 0, expectedCost: 0, items: []
    };
    group.lineCount += 1;
    group.expectedCost = money(group.expectedCost + Number(line.expectedCost || 0));
    group.items.push({
      ingredient: line.ingredient,
      ingredientName: line.ingredientName,
      unit: line.unit,
      currentStock: line.currentStock,
      reorderPoint: line.reorderPoint,
      suggestedQty: line.suggestedQty,
      unitCost: line.unitCost,
      expectedCost: line.expectedCost
    });
    bySupplier.set(key, group);
  }

  return {
    branch: scope.branch
      ? {_id: scope.branch._id, name: scope.branch.name, code: scope.branch.code}
      : null,
    scope: scope.branch ? 'branch' : 'restaurant',
    generatedAt: new Date(),
    currency: 'NPR',
    formula: 'reorderPoint = averageDailyUsage x leadTimeDays + safetyStock',
    parameters: {lookbackDays, serviceLevel: level, z: SERVICE_LEVEL_Z[level]},
    counts: {
      total: lines.length,
      critical: lines.filter(row => row.urgency === 'critical').length,
      reorder: lines.filter(row => row.urgency === 'reorder').length,
      actionable: lines.filter(row => row.actionable).length,
      blocked: lines.filter(row => !row.actionable).length
    },
    expectedTotal: money(lines.reduce((sum, row) => sum + Number(row.expectedCost || 0), 0)),
    suggestedOrders: [...bySupplier.values()].sort((a, b) => b.expectedCost - a.expectedCost),
    lines
  };
}

/**
 * Turns one supplier's suggestion into a real DRAFT purchase order.
 *
 * Deliberately a draft: the brief says a manager approves. Creating anything
 * already approved would let a computed number commit the restaurant's money
 * with no human in the loop. The existing PO approval chain is reused
 * unchanged — this only opens the draft.
 */
export async function createSuggestedPurchaseOrder({
  branchId, supplierId, user, lookbackDays = DEFAULT_LOOKBACK_DAYS, serviceLevel = 95,
  idempotencyKey, session
}) {
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  const plan = await buildReorderPlan({branchId, user, lookbackDays, serviceLevel});
  const group = plan.suggestedOrders.find(row => String(row.supplier) === String(supplierId));
  if (!group) throw httpError('No reorder suggestion is outstanding for this supplier', 409);

  const {createPurchaseOrder} = await import('./purchaseOrders.js');
  const result = await createPurchaseOrder({
    input: {
      branch: String(branchId),
      supplier: String(supplierId),
      notes: `Generated from the reorder engine (${plan.formula})`,
      items: group.items.map(item => ({
        ingredient: String(item.ingredient),
        orderedQty: item.suggestedQty
      }))
    },
    user,
    requestKey: idempotencyKey,
    session
  });

  return {
    purchaseOrder: result.purchaseOrder,
    duplicate: Boolean(result.duplicate),
    suggestion: group,
    // Stated back to the caller so nobody assumes this is ready to send.
    status: result.purchaseOrder?.status,
    requiresApproval: true
  };
}

/**
 * Evaluates every reorder line and raises an alert for anything at or below
 * its reorder point, pushing it to the branch in realtime.
 *
 * Idempotent per ingredient per day: re-running does not spam the same alert.
 */
export async function raiseReorderAlerts({branchId, user, lookbackDays = DEFAULT_LOOKBACK_DAYS}) {
  const plan = await buildReorderPlan({branchId, user, lookbackDays});
  const {publishInventoryAlert} = await import('./realtime.js');
  const raised = [];

  for (const line of plan.lines) {
    if (line.urgency === 'ok') continue;
    const type = line.currentStock <= 0 ? 'out_of_stock' : 'low_stock';
    const since = new Date(Date.now() - 86400000);
    const existing = await Notification.findOne({
      branch: plan.branch?._id, type, referenceId: line.ingredient, createdAt: {$gte: since}
    }).lean();
    if (existing) continue;

    const [note] = await Notification.create([{
      branch: plan.branch?._id,
      type,
      title: type === 'out_of_stock' ? 'Out of stock' : 'Below reorder point',
      body: `${line.ingredientName} — ${line.currentStock} ${line.unit} on hand against a reorder point of ${line.reorderPoint}`
        + (line.supplierName ? `; suggest ${line.suggestedQty} ${line.unit} from ${line.supplierName}` : '; no orderable supplier'),
      referenceId: line.ingredient
    }]);

    publishInventoryAlert(plan.branch?._id, {
      alertId: String(note._id),
      type,
      severity: type === 'out_of_stock' ? 'critical' : 'warning',
      ingredient: String(line.ingredient),
      ingredientName: line.ingredientName,
      currentStock: line.currentStock,
      reorderPoint: line.reorderPoint,
      suggestedQty: line.suggestedQty,
      supplierName: line.supplierName,
      expectedCost: line.expectedCost
    });
    raised.push({ingredient: line.ingredient, type});
  }

  return {raised: raised.length, alerts: raised, evaluated: plan.lines.length};
}
