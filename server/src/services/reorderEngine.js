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

/** Days of history required before a weekday profile means anything. */
export const MIN_DAYS_FOR_WEEKDAY = 21;
/** Days required before a trend is anything but noise. */
export const MIN_DAYS_FOR_TREND = 14;

/**
 * Optional refinements on top of the flat mean.
 *
 * Both are deliberately conservative. A restaurant with three weeks of history
 * has seen each weekday only three times, which is the bare minimum before a
 * "Saturdays are busy" claim is anything but noise — below that the weekday
 * profile is omitted entirely rather than reported with fake precision. The
 * flat average is always present and is what the reorder point uses unless a
 * caller opts into the weekday figure.
 */
export function refineUsage(dailyTotals = [], {start, asOf} = {}) {
  const days = dailyTotals.length;
  const result = {weekdayProfile: null, weekdayAverage: null, trend: null};
  if (!days) return result;

  if (days >= MIN_DAYS_FOR_WEEKDAY && start) {
    const buckets = Array.from({length: 7}, () => []);
    for (let index = 0; index < days; index += 1) {
      const date = new Date(new Date(start).getTime() + index * 86400000);
      buckets[date.getUTCDay()].push(dailyTotals[index]);
    }
    // Only publish the profile if every weekday was actually observed.
    if (buckets.every(bucket => bucket.length > 0)) {
      const profile = buckets.map(bucket =>
        Math.round((bucket.reduce((sum, value) => sum + value, 0) / bucket.length) * 1000) / 1000);
      result.weekdayProfile = profile;
      const today = asOf ? new Date(asOf).getUTCDay() : new Date().getUTCDay();
      result.weekdayAverage = profile[today];
    }
  }

  if (days >= MIN_DAYS_FOR_TREND) {
    // Compare the most recent half against the earlier half. Crude on purpose:
    // a least-squares slope on noisy daily kitchen data would look precise
    // without being more truthful.
    const half = Math.floor(days / 2);
    const earlier = dailyTotals.slice(0, half);
    const recent = dailyTotals.slice(days - half);
    const meanOf = rows => rows.reduce((sum, value) => sum + value, 0) / rows.length;
    const before = meanOf(earlier);
    const after = meanOf(recent);
    if (before > 1e-9) {
      const changePercent = Math.round(((after - before) / before) * 1000) / 10;
      result.trend = {
        direction: changePercent > 15 ? 'rising' : changePercent < -15 ? 'falling' : 'steady',
        changePercent,
        earlierAverage: Math.round(before * 1000) / 1000,
        recentAverage: Math.round(after * 1000) / 1000
      };
    }
  }
  return result;
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
  }).select('branch ingredient changeQty createdAt').lean();

  // Keyed by branch+ingredient: usage in one branch must never inflate the
  // reorder point of another.
  const byIngredient = new Map();
  for (const row of rows) {
    const key = `${row.branch}:${row.ingredient}`;
    const dayIndex = Math.floor((new Date(row.createdAt).getTime() - start.getTime()) / 86400000);
    if (dayIndex < 0 || dayIndex >= days) continue;
    const buckets = byIngredient.get(key) || new Array(days).fill(0);
    buckets[dayIndex] += Math.abs(Number(row.changeQty || 0));
    byIngredient.set(key, buckets);
  }

  const stats = new Map();
  for (const [ingredientId, buckets] of byIngredient) {
    stats.set(ingredientId, {
      ...usageStatistics(buckets),
      ...refineUsage(buckets, {start, asOf: end}),
      lookbackDays: days
    });
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
    }).select('branch items').lean(),
    dailyUsageByIngredient({branchIds: scope.branchIds, lookbackDays})
  ]);

  // Phase 16A: prefer a lead time MEASURED from real approve->receive history
  // over the supplier's declared figure. A chronically late supplier otherwise
  // looks punctual and the reorder point is computed against a fiction.
  // Suppliers without enough history are absent from the map and keep the
  // catalog value.
  const {measuredLeadTimes} = await import('./supplierPerformance.js');
  const measured = await measuredLeadTimes({
    restaurantId: scope.restaurantId, branchIds: scope.branchIds
  }).catch(() => new Map());

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
      const key = `${order.branch}:${item.ingredient}`;
      const outstanding = Math.max(0, Number(item.orderedQty || 0) - Number(item.receivedQty || 0));
      if (outstanding > 0) onOrder.set(key, (onOrder.get(key) || 0) + outstanding);
    }
  }

  // Phase 16A FIX — stock is held per BRANCH and must be evaluated per branch.
  //
  // This previously summed quantities across every branch in scope, so a
  // restaurant-wide plan compared one combined number against one reorder
  // level. Reproduced against the running API: branch A on 18000 against a
  // level of 19000 was masked by branch B's 20000, and an owner-wide sweep
  // evaluated 0 lines and raised no alert while a branch was genuinely short.
  // Keyed by branch+ingredient, a branch-scoped plan is unchanged (one branch)
  // and a restaurant-wide plan now reports each branch on its own merits.
  const stockByKey = new Map();
  const keyOf = (branch, ingredient) => `${branch}:${ingredient}`;
  for (const balance of balances) {
    const key = keyOf(String(balance.branch), String(balance.ingredient));
    stockByKey.set(key, {
      branch: String(balance.branch),
      ingredient: String(balance.ingredient),
      quantity: Number(balance.quantity || 0),
      staticLevel: Number(balance.reorderLevel || balance.minLevel || 0)
    });
  }
  // An ingredient with no balance row in a branch is out of stock there, not
  // absent from the plan.
  for (const branchId of scope.branchIds) {
    for (const ingredient of ingredients) {
      const key = keyOf(String(branchId), String(ingredient._id));
      if (!stockByKey.has(key)) {
        stockByKey.set(key, {
          branch: String(branchId), ingredient: String(ingredient._id),
          quantity: 0, staticLevel: 0
        });
      }
    }
  }

  const branchNameById = new Map(
    (await Branch.find({_id: {$in: scope.branchIds}}).select('name code').lean())
      .map(row => [String(row._id), row])
  );

  const lines = [];
  for (const [, stock] of stockByKey) {
    const ingredientId = stock.ingredient;
    const ingredient = ingredientById.get(ingredientId);
    if (!ingredient) continue;

    const ranked = rankCatalogOptions(catalogByIngredient.get(ingredientId) || [], {suppliersById});
    const preferred = ranked.preferred;
    const stats = usage.get(keyOf(stock.branch, ingredientId))
      || {average: 0, stdDev: 0, days: 0, total: 0, peak: 0, lookbackDays};
    const declaredLeadDays = Number(preferred?.leadDays ?? 0);
    const measuredLead = preferred?.supplier ? measured.get(String(preferred.supplier)) : null;
    const leadTimeDays = measuredLead ? Number(measuredLead.leadDays) : declaredLeadDays;

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
    const pending = round3(onOrder.get(keyOf(stock.branch, ingredientId)) || 0);
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
      branch: stock.branch,
      branchName: branchNameById.get(stock.branch)?.name || '',
      branchCode: branchNameById.get(stock.branch)?.code || '',
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
      declaredLeadDays,
      leadTimeSource: measuredLead ? 'measured' : 'catalog_declared',
      leadTimeSamples: measuredLead?.samples ?? 0,
      supplierOnTimeRate: measuredLead?.onTimeRate ?? null,
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
      supplierSku: preferred?.supplierSku || '',
      purchaseUnit: preferred?.purchaseUnit || null,
      minOrderQty: preferred?.minOrderQty ?? null,
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
    restaurantId: scope.restaurantId,
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
    // Phase 16A: the alert belongs to the branch that is actually short, not
    // to whatever branch happened to be requested. A restaurant-wide sweep
    // previously wrote `branch: null`, which is nobody's alert.
    const alertBranch = line.branch || plan.branch?._id;
    const existing = await Notification.findOne({
      branch: alertBranch,
      type,
      referenceId: line.ingredient,
      $or: [{status: {$in: ['open', 'acknowledged']}}, {status: {$exists: false}, createdAt: {$gte: new Date(Date.now() - 86400000)}}]
    }).lean();
    if (existing) continue;

    const [note] = await Notification.create([{
      branch: alertBranch,
      restaurant: plan.restaurantId,
      ingredient: line.ingredient,
      severity: type === 'out_of_stock' ? 'critical' : 'warning',
      status: 'open',
      context: {
        currentStock: line.currentStock,
        reorderPoint: line.reorderPoint,
        suggestedQty: line.suggestedQty,
        supplierName: line.supplierName
      },
      type,
      title: type === 'out_of_stock' ? 'Out of stock' : 'Below reorder point',
      body: `${line.ingredientName} — ${line.currentStock} ${line.unit} on hand against a reorder point of ${line.reorderPoint}`
        + (line.supplierName ? `; suggest ${line.suggestedQty} ${line.unit} from ${line.supplierName}` : '; no orderable supplier'),
      referenceId: line.ingredient
    }]);

    publishInventoryAlert(alertBranch, {
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
    raised.push({ingredient: line.ingredient, type, branch: String(alertBranch)});
  }

  return {raised: raised.length, alerts: raised, evaluated: plan.lines.length};
}
