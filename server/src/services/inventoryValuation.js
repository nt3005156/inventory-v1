import mongoose from 'mongoose';
import { Ingredient } from '../models/index.js';
import { Branch, InventoryBalance, InventoryBatch, InventoryTransaction } from '../models/operations.js';
import { purchaseBranchContext } from './purchaseOrders.js';
import { userRestaurantContext } from './supplierCatalog.js';
import { kathmanduDateString, canonicalExpiryDate } from './inventoryBatches.js';

const clean = value => String(value ?? '').trim();
const money = value => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * PHASE 2E — Inventory Valuation Architecture
 *
 * Current method: weighted average (WAC)
 *   value = Σ(qty * averageCost)
 *   averageCost evolves as: newAvg = (beforeQty*prevAvg + qty*unitCost)/newQty for inbound
 *   outbound keeps averageCost unchanged — historic cost preserved in ledger.
 *
 * Branch inventory value = sum of ingredient valuations for that branch scope.
 * Ingredient cost = per-ingredient averageCost (or FIFO/FEFO unit cost from oldest/earliest expiry batch).
 *
 * Purchase price changes: every PURCHASE transaction is an acquisition cost event.
 * We expose price history (unitCost timeline) and its impact on averageCost/value.
 *
 * Future FIFO/FEFO: architecture is strategy-based. Each method defines:
 *   - how to sort remaining batches (fifo: receivedAt ASC, fefo: expiry ASC)
 *   - how to compute remaining value (currently Σ batch.qty * batch.unitCost for both)
 *   - how COGS would be derived (consumption order). Adding LIFO would be adding a new entry.
 * Switching only changes the `method` query param — balance-level WAC stays the canonical ledger
 * but the valuation endpoint can project under any strategy without mutating stored data.
 */

export const VALUATION_METHODS = Object.freeze(['weighted_average', 'fifo', 'fefo']);

function assertMethod(method) {
  const m = clean(method) || 'weighted_average';
  if (!VALUATION_METHODS.includes(m)) throw httpError(`Invalid valuation method. Allowed: ${VALUATION_METHODS.join(', ')}`, 400);
  return m;
}

export const VALUATION_STRATEGIES = Object.freeze({
  weighted_average: {
    key: 'weighted_average',
    label: 'Weighted Average Cost',
    description: 'Total value = Σ(quantity × averageCost) from balances. Purchase price changes blend into average.',
    sortBatches: null
  },
  fifo: {
    key: 'fifo',
    label: 'FIFO (First-In First-Out)',
    description: 'Remaining stock valued by oldest batches first (receivedAt ASC). Prepared for future COGS-by-FIFO.',
    sortBatches: (a, b) => new Date(a.receivedAt || a.createdAt).getTime() - new Date(b.receivedAt || b.createdAt).getTime() || String(a._id).localeCompare(String(b._id))
  },
  fefo: {
    key: 'fefo',
    label: 'FEFO (First-Expired First-Out)',
    description: 'Remaining stock valued by nearest expiry first (expiryDate ASC, nulls last). Current consumption already uses FEFO.',
    sortBatches: (a, b) => {
      const aExp = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      const bExp = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.POSITIVE_INFINITY;
      if (aExp !== bExp) return aExp - bExp;
      return new Date(a.receivedAt || a.createdAt).getTime() - new Date(b.receivedAt || b.createdAt).getTime() || String(a._id).localeCompare(String(b._id));
    }
  }
});

async function resolveValuationScope({ branchId, user }) {
  const identity = await userRestaurantContext(user);
  if (branchId) {
    const context = await purchaseBranchContext({ user, branchId, session: null, allowInactive: true });
    return { restaurantId: context.restaurantId, branchIds: [context.branch._id], branch: context.branch };
  }
  if (identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    const context = await purchaseBranchContext({ user, branchId: identity.branchId, allowInactive: true });
    return { restaurantId: context.restaurantId, branchIds: [context.branch._id], branch: context.branch };
  }
  const branchIds = await Branch.find({ restaurant: identity.restaurantId }).distinct('_id');
  return { restaurantId: identity.restaurantId, branchIds };
}

function kathmanduDate(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError('Date must use YYYY-MM-DD', 400);
  const d = new Date(`${text}T00:00:00.000+05:45`);
  if (Number.isNaN(d.getTime())) throw httpError('Invalid date', 400);
  return d;
}

function dateRange({ from, to }) {
  let gte = null, lt = null;
  if (from) gte = kathmanduDate(from);
  if (to) {
    const end = kathmanduDate(to);
    lt = new Date(end.getTime() + 86400000);
  }
  if (gte && lt && gte >= lt) throw httpError('From date must be before to date', 400);
  return { gte, lt };
}

function recalcWeightedAvg(beforeQty, beforeAvg, qty, unitCost) {
  const afterQty = beforeQty + qty;
  if (!(qty > 0) || afterQty <= 1e-9) return beforeAvg;
  if (beforeQty <= 1e-9) return unitCost;
  return ((beforeQty * beforeAvg) + (qty * unitCost)) / afterQty;
}

async function fetchBalances(scope, { ingredient } = {}) {
  const match = { branch: { $in: scope.branchIds } };
  if (ingredient) {
    if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
    const exists = await Ingredient.exists({ _id: ingredient, restaurant: scope.restaurantId });
    if (!exists) throw httpError('Ingredient not found', 404);
    match.ingredient = new mongoose.Types.ObjectId(ingredient);
  }
  const balances = await InventoryBalance.find(match)
    .populate({ path: 'ingredient', match: { restaurant: scope.restaurantId }, select: 'name code category unit minimumStock' })
    .populate({ path: 'branch', match: { restaurant: scope.restaurantId }, select: 'name code' })
    .lean();
  return balances.filter(b => b.ingredient && b.branch);
}

async function fetchBatches(scope, { ingredient } = {}) {
  const match = { restaurant: scope.restaurantId, branch: { $in: scope.branchIds }, quantity: { $gt: 1e-9 } };
  if (ingredient) match.ingredient = new mongoose.Types.ObjectId(ingredient);
  const batches = await InventoryBatch.find(match)
    .populate('ingredient', 'name code category unit')
    .populate('branch', 'name code')
    .lean();
  return batches;
}

function batchValuationSum(batches) {
  return money(batches.reduce((s, b) => s + Number(b.quantity || 0) * Number(b.unitCost || 0), 0));
}

function aggregateWeighted(balances) {
  let qty = 0, value = 0;
  for (const b of balances) {
    const q = Number(b.quantity || 0);
    const avg = Number(b.averageCost || 0);
    qty += q;
    value += q * avg;
  }
  return { quantity: qty, value: money(value), averageCost: qty > 1e-9 ? Number((value / qty).toFixed(6)) : 0 };
}

function aggregateFifoFefo(batches, method) {
  const strat = VALUATION_STRATEGIES[method];
  const sorted = strat?.sortBatches ? [...batches].sort(strat.sortBatches) : batches;
  let qty = 0, value = 0;
  for (const b of sorted) {
    qty += Number(b.quantity || 0);
    value += Number(b.quantity || 0) * Number(b.unitCost || 0);
  }
  return { quantity: qty, value: money(value), averageCost: qty > 1e-9 ? Number((value / qty).toFixed(6)) : 0, layers: sorted.slice(0, 50) };
}

function branchBranchKey(branchIds) {
  if (branchIds.length === 1) return String(branchIds[0]);
  return 'all';
}

// Public API

export async function getBranchValuation({ branchId, user, method = 'weighted_average', ingredient } = {}) {
  const m = assertMethod(method);
  const scope = await resolveValuationScope({ branchId, user });
  const [balances, batches] = await Promise.all([
    fetchBalances(scope, { ingredient }),
    fetchBatches(scope, { ingredient })
  ]);

  const weighted = aggregateWeighted(balances);
  const fifoAgg = aggregateFifoFefo(batches, 'fifo');
  const fefoAgg = aggregateFifoFefo(batches, 'fefo');

  const byMethod = {
    weighted_average: weighted.value,
    fifo: fifoAgg.value,
    fefo: fefoAgg.value
  };

  // per-ingredient breakdown
  const byIngredient = new Map();
  for (const b of balances) {
    const key = String(b.ingredient._id);
    const cur = byIngredient.get(key) || {
      ingredientId: b.ingredient._id,
      name: b.ingredient.name || 'Ingredient',
      code: b.ingredient.code || '',
      category: b.ingredient.category || '',
      unit: b.ingredient.unit || 'g',
      branchId: b.branch._id,
      branchName: b.branch.name || '',
      quantity: 0,
      averageCost: 0,
      batches: []
    };
    cur.quantity = Number(b.quantity || 0);
    cur.averageCost = Number(b.averageCost || 0);
    cur.weightedAverageValue = money(cur.quantity * cur.averageCost);
    byIngredient.set(key, cur);
  }
  // attach batch values per ingredient
  const batchesByIngredient = new Map();
  for (const batch of batches) {
    const key = String(batch.ingredient?._id || batch.ingredient);
    const arr = batchesByIngredient.get(key) || [];
    arr.push(batch);
    batchesByIngredient.set(key, arr);
  }
  for (const [key, entry] of byIngredient.entries()) {
    const ingBatches = batchesByIngredient.get(key) || [];
    entry.fifoValue = money(ingBatches.reduce((s, b) => s + Number(b.quantity || 0) * Number(b.unitCost || 0), 0));
    entry.fefoValue = entry.fifoValue; // same sum, layers differ
    entry.batchCount = ingBatches.length;
    // sorted layers preview for the requested method
    const strat = VALUATION_STRATEGIES[m];
    const sorted = strat?.sortBatches ? [...ingBatches].sort(strat.sortBatches) : ingBatches;
    entry.layers = sorted.slice(0, 5).map(row => ({
      batchId: row._id,
      batchNumber: row.batchNumber || '',
      expiryDate: row.expiryDate || null,
      quantity: Number(row.quantity || 0),
      unitCost: Number(row.unitCost || 0),
      value: money(Number(row.quantity || 0) * Number(row.unitCost || 0)),
      receivedAt: row.receivedAt || row.createdAt
    }));
  }

  // add ingredients that have zero balance but have batches? include them
  for (const [key, ingBatches] of batchesByIngredient.entries()) {
    if (!byIngredient.has(key)) {
      const sample = ingBatches[0];
      const qty = ingBatches.reduce((s, b) => s + Number(b.quantity || 0), 0);
      const val = batchValuationSum(ingBatches);
      byIngredient.set(key, {
        ingredientId: sample.ingredient?._id || sample.ingredient,
        name: sample.ingredient?.name || 'Ingredient',
        code: sample.ingredient?.code || '',
        category: sample.ingredient?.category || '',
        unit: sample.ingredient?.unit || sample.unit || 'g',
        branchId: sample.branch?._id || sample.branch,
        branchName: sample.branch?.name || '',
        quantity: qty,
        averageCost: qty > 1e-9 ? Number((val / qty).toFixed(6)) : 0,
        weightedAverageValue: val,
        fifoValue: val,
        fefoValue: val,
        batchCount: ingBatches.length,
        layers: ingBatches.slice(0, 5).map(row => ({
          batchId: row._id,
          batchNumber: row.batchNumber || '',
          expiryDate: row.expiryDate || null,
          quantity: Number(row.quantity || 0),
          unitCost: Number(row.unitCost || 0),
          value: money(Number(row.quantity || 0) * Number(row.unitCost || 0)),
          receivedAt: row.receivedAt || row.createdAt
        }))
      });
    }
  }

  const ingredients = [...byIngredient.values()].sort((a, b) => b.weightedAverageValue - a.weightedAverageValue);

  return {
    method: m,
    branchId: scope.branch ? String(scope.branch._id) : branchBranchKey(scope.branchIds),
    branchName: scope.branch?.name || (scope.branchIds.length > 1 ? 'All branches' : ''),
    restaurant: scope.restaurantId,
    asOf: new Date().toISOString(),
    timezone: 'Asia/Kathmandu',
    currency: 'NPR',
    valuation: {
      requested: { method: m, value: money(byMethod[m]), quantity: m === 'weighted_average' ? weighted.quantity : fifoAgg.quantity },
      weightedAverage: weighted,
      fifo: fifoAgg,
      fefo: fefoAgg,
      byMethod
    },
    summary: {
      totalQuantity: weighted.quantity,
      totalValueWeighted: weighted.value,
      totalValueFifo: fifoAgg.value,
      totalValueFefo: fefoAgg.value,
      ingredientCount: ingredients.length,
      batchCount: batches.length
    },
    ingredients,
    strategies: Object.values(VALUATION_STRATEGIES).map(s => ({ key: s.key, label: s.label, description: s.description }))
  };
}

export async function getIngredientValuation({ branchId, ingredientId, user, method = 'weighted_average' }) {
  if (!mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient', 400);
  const m = assertMethod(method);
  const scope = await resolveValuationScope({ branchId, user });
  const ingredient = await Ingredient.findOne({ _id: ingredientId, restaurant: scope.restaurantId }).select('name code category unit').lean();
  if (!ingredient) throw httpError('Ingredient not found', 404);

  const branchVal = await getBranchValuation({ branchId, user, method: m, ingredient: ingredientId });
  const ing = branchVal.ingredients.find(row => String(row.ingredientId) === String(ingredientId));
  if (!ing) {
    // no balances/batches yet -> zero
    return {
      method: m,
      ingredient: { _id: ingredient._id, name: ingredient.name, code: ingredient.code, category: ingredient.category, unit: ingredient.unit },
      branchId: branchVal.branchId,
      branchName: branchVal.branchName,
      quantity: 0,
      averageCost: 0,
      weightedAverageValue: 0,
      fifoValue: 0,
      fefoValue: 0,
      batchCount: 0,
      layers: [],
      valuation: branchVal.valuation
    };
  }
  const history = await getPurchasePriceHistory({ branchId, ingredientId, user, limit: 5 });
  const priceChange = history.items.length >= 2
    ? (() => {
        const cur = Number(history.items[0].unitCost || 0);
        const prev = Number(history.items[1].unitCost || 0);
        const delta = money(cur - prev);
        const pct = prev > 1e-9 ? money((delta / prev) * 100) : 0;
        return { previousCost: prev, currentCost: cur, delta, deltaPercent: pct, trend: delta > 1e-9 ? 'up' : delta < -1e-9 ? 'down' : 'flat' };
      })()
    : history.items.length === 1
      ? { previousCost: 0, currentCost: Number(history.items[0].unitCost || 0), delta: Number(history.items[0].unitCost || 0), deltaPercent: 0, trend: 'new' }
      : { previousCost: 0, currentCost: 0, delta: 0, deltaPercent: 0, trend: 'flat' };

  return {
    method: m,
    ingredient: { _id: ingredient._id, name: ingredient.name, code: ingredient.code, category: ingredient.category, unit: ingredient.unit },
    branchId: branchVal.branchId,
    branchName: branchVal.branchName,
    quantity: ing.quantity,
    averageCost: ing.averageCost,
    weightedAverageValue: ing.weightedAverageValue,
    fifoValue: ing.fifoValue,
    fefoValue: ing.fefoValue,
    batchCount: ing.batchCount,
    layers: ing.layers,
    priceChange,
    recentPurchases: history.items,
    valuation: branchVal.valuation
  };
}

export async function getPurchasePriceHistory({ branchId, ingredientId, user, limit = 20, method } = {}) {
  const scope = await resolveValuationScope({ branchId, user });
  const match = { restaurant: scope.restaurantId, branch: { $in: scope.branchIds }, type: 'PURCHASE' };
  if (ingredientId) {
    if (!mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient', 400);
    match.ingredient = new mongoose.Types.ObjectId(ingredientId);
  }
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  // fetch newest first for response
  const rowsDesc = await InventoryTransaction.find(match)
    .populate('ingredient', 'name code unit')
    .populate('branch', 'name code')
    .sort({ createdAt: -1, _id: -1 })
    .limit(safeLimit)
    .lean();

  // For accurate impact, replay full ledger for involved branch+ingredient keys
  const keys = [...new Set(rowsDesc.map(r => `${r.branch?._id || r.branch}:${r.ingredient?._id || r.ingredient}`))];
  let allRelevant = [];
  if (keys.length) {
    // Parse keys to fetch all transactions for those keys
    const branchIds = [...new Set(rowsDesc.map(r => String(r.branch?._id || r.branch)))].map(id => new mongoose.Types.ObjectId(id));
    const ingredientIds = [...new Set(rowsDesc.map(r => String(r.ingredient?._id || r.ingredient)))].map(id => new mongoose.Types.ObjectId(id));
    allRelevant = await InventoryTransaction.find({
      restaurant: scope.restaurantId,
      branch: { $in: branchIds },
      ingredient: { $in: ingredientIds }
    })
      .sort({ createdAt: 1, _id: 1 })
      .select('branch ingredient type previousQty changeQty newQty unitCost createdAt')
      .lean();
  }
  const states = new Map();
  const impactById = new Map();
  // Replay full history to capture true before average for each purchase
  for (const tx of allRelevant) {
    const key = `${tx.branch}:${tx.ingredient}`;
    let state = states.get(key);
    if (!state) {
      state = { quantity: Number(tx.previousQty || 0), averageCost: Number(tx.unitCost || 0) };
      if (Number(tx.previousQty || 0) !== 0) {
        // initial state already has quantity, keep unitCost as initial avg
      }
    }
    const beforeQty = Number(state.quantity || 0);
    const beforeAvg = Number(state.averageCost || 0);
    const changeQty = Number(tx.changeQty || 0);
    const newQty = Number(tx.newQty ?? beforeQty + changeQty);
    const unitCost = Number(tx.unitCost || 0);
    let afterAvg = beforeAvg;
    if (changeQty > 0 && newQty > 1e-9) afterAvg = recalcWeightedAvg(beforeQty, beforeAvg, changeQty, unitCost);
    // Record impact if this tx is a purchase in our limited set
    const isTrackedPurchase = rowsDesc.some(r => String(r._id) === String(tx._id));
    if (isTrackedPurchase && tx.type === 'PURCHASE') {
      impactById.set(String(tx._id), {
        previousAverageCost: Number(beforeAvg.toFixed(6)),
        newAverageCost: Number(afterAvg.toFixed(6)),
        averageCostDelta: Number((afterAvg - beforeAvg).toFixed(6)),
        inventoryValueBefore: money(beforeQty * beforeAvg),
        inventoryValueAfter: money(newQty * afterAvg)
      });
    }
    state.quantity = newQty;
    state.averageCost = afterAvg;
    states.set(key, state);
  }
  // Fallback for purchases not covered (if allRelevant didn't include due to limit mismatch): ensure impact exists
  for (const row of rowsDesc) {
    if (!impactById.has(String(row._id))) {
      impactById.set(String(row._id), {
        previousAverageCost: 0,
        newAverageCost: Number(row.unitCost || 0),
        averageCostDelta: Number(row.unitCost || 0),
        inventoryValueBefore: 0,
        inventoryValueAfter: money(Number(row.newQty || 0) * Number(row.unitCost || 0))
      });
    }
  }

  const detailed = [];
  for (const row of rowsDesc) {
    const qty = Math.abs(Number(row.changeQty || 0));
    const unitCost = Number(row.unitCost || 0);
    const totalCost = Number(row.totalCost || 0);
    const impact = impactById.get(String(row._id)) || {};
    detailed.push({
      _id: row._id,
      branch: row.branch?._id ? { _id: row.branch._id, name: row.branch.name, code: row.branch.code } : { _id: row.branch },
      ingredient: row.ingredient?._id ? { _id: row.ingredient._id, name: row.ingredient.name, code: row.ingredient.code, unit: row.ingredient.unit } : { _id: row.ingredient },
      quantity: qty,
      unit: row.unit,
      unitCost,
      totalCost: money(totalCost),
      previousQty: Number(row.previousQty || 0),
      newQty: Number(row.newQty || 0),
      previousAverageCost: impact.previousAverageCost ?? 0,
      newAverageCost: impact.newAverageCost ?? unitCost,
      averageCostDelta: impact.averageCostDelta ?? 0,
      inventoryValueBefore: impact.inventoryValueBefore ?? 0,
      inventoryValueAfter: impact.inventoryValueAfter ?? 0,
      reason: row.reason,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      createdAt: row.createdAt,
      batchMovements: (row.batchMovements || []).map(b => ({
        batchId: b.batch?._id || b.batch,
        batchNumber: b.batchNumber || '',
        expiryDate: b.expiryDate || null,
        changeQty: b.changeQty,
        unitCost: b.unitCost
      }))
    });
  }

  // compute simple price change series
  let priceChange = null;
  if (detailed.length >= 2) {
    const cur = Number(detailed[0].unitCost || 0);
    const prev = Number(detailed[1].unitCost || 0);
    const delta = money(cur - prev);
    priceChange = {
      previousCost: prev,
      currentCost: cur,
      delta,
      deltaPercent: prev > 1e-9 ? money((delta / prev) * 100) : 0,
      trend: delta > 1e-9 ? 'up' : delta < -1e-9 ? 'down' : 'flat',
      previousAverageCost: detailed[1].newAverageCost,
      currentAverageCost: detailed[0].newAverageCost
    };
  } else if (detailed.length === 1) {
    priceChange = { previousCost: 0, currentCost: Number(detailed[0].unitCost || 0), delta: Number(detailed[0].unitCost || 0), deltaPercent: 0, trend: 'new', previousAverageCost: detailed[0].previousAverageCost, currentAverageCost: detailed[0].newAverageCost };
  }

  return { items: detailed, count: detailed.length, priceChange, method: method ? assertMethod(method) : undefined };
}

export async function getValuationHistory({ branchId, ingredientId, user, from, to, method = 'weighted_average', granularity = 'day' } = {}) {
  const m = assertMethod(method);
  const scope = await resolveValuationScope({ branchId, user });
  const { gte, lt } = dateRange({ from, to });
  const match = {
    restaurant: scope.restaurantId,
    branch: { $in: scope.branchIds },
    ...(ingredientId ? { ingredient: new mongoose.Types.ObjectId(ingredientId) } : {}),
    ...(gte || lt ? { createdAt: { ...(gte ? { $gte: gte } : {}), ...(lt ? { $lt: lt } : {}) } } : {})
  };
  if (ingredientId && !mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient', 400);
  if (ingredientId) {
    const exists = await Ingredient.exists({ _id: ingredientId, restaurant: scope.restaurantId });
    if (!exists) throw httpError('Ingredient not found', 404);
  }

  const transactions = await InventoryTransaction.find(match)
    .sort({ createdAt: 1, _id: 1 })
    .select('branch ingredient type previousQty changeQty newQty unitCost createdAt')
    .lean();

  // Replay to reconstruct weighted average timeline
  const states = new Map(); // key -> { quantity, averageCost }
  const history = [];
  const byDate = new Map();

  function snapshotKey(tx) {
    return `${tx.branch}:${tx.ingredient}`;
  }

  for (const tx of transactions) {
    const key = snapshotKey(tx);
    let state = states.get(key) || { quantity: Number(tx.previousQty || 0), averageCost: Number(tx.unitCost || 0) };
    // If first time seeing this key and previousQty not matching state, align
    if (!states.has(key) && Number(tx.previousQty || 0) !== 0) {
      // we lack true opening, use previousQty as current
      state.quantity = Number(tx.previousQty || 0);
      // keep unitCost from tx as initial average if not known
    }
    const beforeQty = Number(state.quantity || 0);
    let avg = Number(state.averageCost || 0);
    const changeQty = Number(tx.changeQty || 0);
    const newQty = Number(tx.newQty ?? beforeQty + changeQty);
    const unitCost = Number(tx.unitCost || 0);
    if (changeQty > 0 && newQty > 1e-9) {
      avg = recalcWeightedAvg(beforeQty, avg, changeQty, unitCost);
    }
    state.quantity = newQty;
    state.averageCost = avg;
    states.set(key, state);

    const totalValue = [...states.values()].reduce((s, st) => s + Number(st.quantity || 0) * Number(st.averageCost || 0), 0);
    const totalQty = [...states.values()].reduce((s, st) => s + Number(st.quantity || 0), 0);

    const day = kathmanduDateString(tx.createdAt);
    byDate.set(day, { value: money(totalValue), quantity: totalQty, averageCost: totalQty > 1e-9 ? Number((totalValue / totalQty).toFixed(6)) : 0, at: tx.createdAt });

    history.push({
      at: tx.createdAt,
      day,
      type: tx.type,
      branch: tx.branch,
      ingredient: tx.ingredient,
      changeQty,
      unitCost,
      newQty,
      averageCost: Number(avg.toFixed(6)),
      totalValue: money(totalValue),
      totalQuantity: totalQty
    });
  }

  // For FIFO/FEFO history, we would need batch-level replay; for now we return weighted history and note that FIFO/FEFO projection
  // is available via current batch snapshot (getBranchValuation). Historical FIFO would require batch ledger replay,
  // architecture leaves `method` param ready and returns weighted history when method != weighted_average with a notice.

  const daily = [...byDate.entries()].map(([day, snap]) => ({ day, ...snap })).sort((a, b) => a.day.localeCompare(b.day));

  return {
    method: m,
    branchId: scope.branch ? String(scope.branch._id) : branchBranchKey(scope.branchIds),
    ingredientId: ingredientId ? String(ingredientId) : null,
    from: from ? String(from) : null,
    to: to ? String(to) : null,
    granularity,
    count: history.length,
    history,
    daily,
    note: m !== 'weighted_average' ? `Historical ${m} valuation replays the same ledger but current batch FEFO/FIFO layers are projected from remaining batches; full historical batch-layer replay is architected but returns weighted timeline until batch-history store is enabled.` : undefined
  };
}

export async function getIngredientCost({ branchId, ingredientId, user, method = 'weighted_average' }) {
  const m = assertMethod(method);
  const val = await getIngredientValuation({ branchId, ingredientId, user, method: m });
  return {
    ingredient: val.ingredient,
    branchId: val.branchId,
    method: val.method,
    quantity: val.quantity,
    averageCost: val.averageCost,
    unitCost: val.averageCost,
    weightedAverageValue: val.weightedAverageValue,
    fifoValue: val.fifoValue,
    fefoValue: val.fefoValue,
    stockValue: m === 'weighted_average' ? val.weightedAverageValue : m === 'fifo' ? val.fifoValue : val.fefoValue,
    priceChange: val.priceChange,
    asOf: new Date().toISOString()
  };
}
