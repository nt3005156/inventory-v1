import mongoose from 'mongoose';
import { Ingredient } from '../models/index.js';
import { Branch, InventoryBatch, InventoryBalance } from '../models/operations.js';
import { purchaseBranchContext } from './purchaseOrders.js';
import { userRestaurantContext } from './supplierCatalog.js';
import { kathmanduDateString, canonicalExpiryDate, expiryState, expiryTier, EXPIRY_TIER_SEVERITY } from './inventoryBatches.js';
import { Restaurant } from '../models/operations.js';

const clean = v => String(v ?? '').trim();
function httpError(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }
const money = v => Math.round((Number(v||0)+Number.EPSILON)*100)/100;

/**
 * Phase 15 — the alert tiers are per-restaurant, defaulting to the brief's
 * 7-day and 3-day thresholds.
 */
export async function resolveExpiryPolicy(restaurantId, session) {
  const row = await Restaurant.findById(restaurantId)
    .select('expiryPolicy expiryWarningDays expiryCriticalDays')
    .session(session || null).lean();
  const warningDays = Number(row?.expiryWarningDays ?? 7);
  const criticalDays = Number(row?.expiryCriticalDays ?? 3);
  return {
    policy: clean(row?.expiryPolicy) || 'block',
    warningDays,
    // A critical window wider than the warning window would make 'warning'
    // unreachable; clamp rather than emit a tier nothing can ever match.
    criticalDays: Math.min(criticalDays, warningDays)
  };
}

async function resolveScope({ branchId, user }) {
  const identity = await userRestaurantContext(user);
  if (branchId) {
    const ctx = await purchaseBranchContext({ user, branchId, allowInactive: true });
    return { restaurantId: ctx.restaurantId, branchIds: [ctx.branch._id], branch: ctx.branch };
  }
  if (identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    const ctx = await purchaseBranchContext({ user, branchId: identity.branchId, allowInactive: true });
    return { restaurantId: ctx.restaurantId, branchIds: [ctx.branch._id], branch: ctx.branch };
  }
  const branchIds = await Branch.find({ restaurant: identity.restaurantId }).distinct('_id');
  return { restaurantId: identity.restaurantId, branchIds };
}

function daysUntilExpiry(expiryDate, asOf = new Date()) {
  if (!expiryDate) return null;
  const exp = canonicalExpiryDate(expiryDate);
  const today = canonicalExpiryDate(kathmanduDateString(asOf));
  const diffMs = exp.getTime() - today.getTime();
  return Math.floor(diffMs / 86400000);
}

/**
 * FEFO-ready architecture note:
 * Batches are consumed via inventoryBatches.removeBatchStock using BATCH_CONSUMPTION_STRATEGIES.fefo (expiry ASC).
 * This service only reads and projects expiry risk without mutating batches.
 */

export async function getExpirySummary({ branchId, user, expiringDays = 30 } = {}) {
  const scope = await resolveScope({ branchId, user });
  const days = Math.min(365, Math.max(1, Number(expiringDays) || 30));
  const todayText = kathmanduDateString();
  const today = canonicalExpiryDate(todayText);
  const horizon = new Date(today); horizon.setUTCDate(horizon.getUTCDate() + days);

  const baseMatch = { restaurant: scope.restaurantId, branch: { $in: scope.branchIds }, quantity: { $gt: 1e-9 } };

  const [agg] = await InventoryBatch.aggregate([
    { $match: baseMatch },
    {
      $facet: {
        totals: [{ $group: { _id: null, totalBatches: { $sum: 1 }, totalQty: { $sum: '$quantity' }, totalValue: { $sum: { $multiply: ['$quantity', '$unitCost'] } } } }],
        expired: [
          { $match: { expiryDate: { $lt: today } } },
          { $group: { _id: null, count: { $sum: 1 }, qty: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$unitCost'] } } } }
        ],
        expiring: [
          { $match: { expiryDate: { $gte: today, $lte: horizon } } },
          { $group: { _id: null, count: { $sum: 1 }, qty: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$unitCost'] } } } }
        ],
        fresh: [
          { $match: { $or: [{ expiryDate: { $gt: horizon } }, { expiryDate: null }, { expiryDate: { $exists: false } }] } },
          { $group: { _id: null, count: { $sum: 1 }, qty: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$unitCost'] } } } }
        ],
        noExpiry: [
          { $match: { $or: [{ expiryDate: null }, { expiryDate: { $exists: false } }] } },
          { $group: { _id: null, count: { $sum: 1 }, qty: { $sum: '$quantity' } } }
        ],
        byIngredientExpired: [
          { $match: { expiryDate: { $lt: today } } },
          { $group: { _id: '$ingredient', qty: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$unitCost'] } }, batches: { $sum: 1 } } },
          { $sort: { qty: -1 } }
        ],
        byIngredientExpiring: [
          { $match: { expiryDate: { $gte: today, $lte: horizon } } },
          { $group: { _id: '$ingredient', qty: { $sum: '$quantity' }, value: { $sum: { $multiply: ['$quantity', '$unitCost'] } }, batches: { $sum: 1 } } },
          { $sort: { qty: -1 } }
        ]
      }
    }
  ]);

  const totals = agg?.totals?.[0] || { totalBatches: 0, totalQty: 0, totalValue: 0 };
  const expired = agg?.expired?.[0] || { count: 0, qty: 0, value: 0 };
  const expiring = agg?.expiring?.[0] || { count: 0, qty: 0, value: 0 };
  const fresh = agg?.fresh?.[0] || { count: 0, qty: 0, value: 0 };
  const noExpiry = agg?.noExpiry?.[0] || { count: 0, qty: 0 };

  // enrich ingredient names for top lists
  const ids = [...new Set([...(agg.byIngredientExpired||[]).map(r=>String(r._id)), ...(agg.byIngredientExpiring||[]).map(r=>String(r._id))])].filter(Boolean);
  const ingredients = ids.length ? await Ingredient.find({ _id: { $in: ids }, restaurant: scope.restaurantId }).select('name code unit').lean() : [];
  const byId = new Map(ingredients.map(i=>[String(i._id), i]));
  function enrich(rows){ return rows.map(r=>({ ingredientId: r._id, name: byId.get(String(r._id))?.name || 'Ingredient', code: byId.get(String(r._id))?.code || '', unit: byId.get(String(r._id))?.unit || 'g', batches: r.batches, quantity: r.qty, value: money(r.value) })); }

  return {
    asOf: todayText,
    expiringDays: days,
    branchId: scope.branch ? String(scope.branch._id) : (scope.branchIds.length===1? String(scope.branchIds[0]): 'all'),
    branchName: scope.branch?.name || (scope.branchIds.length>1 ? 'All branches' : ''),
    restaurant: scope.restaurantId,
    currency: 'NPR',
    totals: { batches: totals.totalBatches || 0, quantity: totals.totalQty || 0, value: money(totals.totalValue || 0) },
    expired: { count: expired.count || 0, quantity: expired.qty || 0, value: money(expired.value || 0) },
    expiring: { count: expiring.count || 0, quantity: expiring.qty || 0, value: money(expiring.value || 0) },
    fresh: { count: fresh.count || 0, quantity: fresh.qty || 0, value: money(fresh.value || 0) },
    noExpiry: { count: noExpiry.count || 0, quantity: noExpiry.qty || 0 },
    byIngredient: { expired: enrich(agg.byIngredientExpired||[]), expiring: enrich(agg.byIngredientExpiring||[]) },
    fefoReady: true,
    strategy: 'fefo'
  };
}

export async function listExpiryAlerts({ branchId, user, expiringDays = 30, status, ingredient, page = 1, limit = 50, sort = 'expiry' } = {}) {
  const scope = await resolveScope({ branchId, user });
  const days = Math.min(365, Math.max(1, Number(expiringDays) || 30));
  const todayText = kathmanduDateString();
  const today = canonicalExpiryDate(todayText);
  const horizon = new Date(today); horizon.setUTCDate(horizon.getUTCDate() + days);
  const safePage = Math.max(1, Number(page)||1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit)||50));

  const base = { restaurant: scope.restaurantId, branch: { $in: scope.branchIds }, quantity: { $gt: 1e-9 } };

  let match;
  const wanted = clean(status);
  if (wanted === 'expired') match = { ...base, expiryDate: { $lt: today } };
  else if (wanted === 'expiring') match = { ...base, expiryDate: { $gte: today, $lte: horizon } };
  else if (wanted === 'fresh') match = { ...base, $or: [{ expiryDate: { $gt: horizon } }, { expiryDate: null }, { expiryDate: { $exists: false } }] };
  else if (wanted === 'no_expiry') match = { ...base, $or: [{ expiryDate: null }, { expiryDate: { $exists: false } }] };
  else if (wanted && wanted !== 'all') throw httpError('Invalid expiry alert status. Allowed: expired, expiring, fresh, no_expiry, all', 400);
  else {
    // default alerts: expired + expiring
    match = { ...base, $or: [{ expiryDate: { $lt: today } }, { expiryDate: { $gte: today, $lte: horizon } }] };
  }

  if (ingredient) {
    if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
    const exists = await Ingredient.exists({ _id: ingredient, restaurant: scope.restaurantId });
    if (!exists) throw httpError('Ingredient not found', 404);
    match.ingredient = new mongoose.Types.ObjectId(ingredient);
  }

  const sortMap = {
    expiry: { expiryDate: 1, receivedAt: 1 },
    quantity: { quantity: -1 },
    value: { unitCost: -1 }
  };
  const sortStage = sortMap[clean(sort)] || sortMap.expiry;

  const policy = await resolveExpiryPolicy(scope.restaurantId);

  const [rows, total, summary] = await Promise.all([
    InventoryBatch.find(match)
      .populate('ingredient', 'name code unit category')
      .populate('branch', 'name code')
      .sort(sortStage)
      .skip((safePage-1)*safeLimit)
      .limit(safeLimit)
      .lean(),
    InventoryBatch.countDocuments(match),
    getExpirySummary({ branchId, user, expiringDays: days })
  ]);

  const alerts = rows.map(row => {
    const state = expiryState(row.expiryDate, { expiringDays: days, quantity: row.quantity });
    const daysUntil = daysUntilExpiry(row.expiryDate);
    const isExpired = state === 'expired';
    const isExpiring = state === 'expiring';
    // Phase 15: a flat 'expiring' severity made a 20-day batch look as urgent
    // as a 2-day one. Tiers are graded and configurable.
    const tier = expiryTier(row.expiryDate, {
      quantity: row.quantity,
      expiringDays: days,
      warningDays: policy.warningDays,
      criticalDays: policy.criticalDays
    });
    return {
      _id: row._id,
      type: isExpired ? 'expired_stock' : isExpiring ? 'near_expiry_stock' : state,
      tier,
      severity: EXPIRY_TIER_SEVERITY[tier] || 'info',
      title: isExpired
        ? 'Expired stock'
        : tier === 'critical' ? `Critical — expires in ${daysUntil}d`
        : tier === 'warning' ? `Expiring in ${daysUntil}d`
        : isExpiring ? `Expiring in ${daysUntil}d`
        : 'Batch status',
      branch: row.branch?._id || row.branch,
      branchName: row.branch?.name || '',
      ingredient: row.ingredient?._id || row.ingredient,
      ingredientName: row.ingredient?.name || 'Ingredient',
      ingredientCode: row.ingredient?.code || '',
      unit: row.unit || row.ingredient?.unit || 'g',
      batchNumber: row.batchNumber || '',
      batchNumberNormalized: row.batchNumberNormalized || '',
      lotKey: row.lotKey,
      quantity: Number(row.quantity || 0),
      initialQuantity: Number(row.initialQuantity || 0),
      unitCost: Number(row.unitCost || 0),
      stockValue: money(Number(row.quantity || 0) * Number(row.unitCost || 0)),
      expiryDate: row.expiryDate || null,
      expiryDateText: row.expiryDate ? new Date(row.expiryDate).toISOString().slice(0,10) : null,
      status: state,
      daysUntilExpiry: daysUntil,
      receivedAt: row.receivedAt,
      sourceType: row.sourceType,
      sourceId: row.sourceId || null,
      fefoOrder: row.expiryDate ? new Date(row.expiryDate).getTime() : Number.POSITIVE_INFINITY,
      quantityPerBatch: Number(row.quantity || 0)
    };
  });

  return {
    asOf: todayText,
    expiringDays: days,
    branchId: scope.branch ? String(scope.branch._id) : (scope.branchIds.length===1? String(scope.branchIds[0]): 'all'),
    branchName: scope.branch?.name || (scope.branchIds.length>1 ? 'All branches' : ''),
    filter: wanted || 'expired+expiring',
    pagination: { page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total/safeLimit)) },
    summary: summary,
    policy: {
      expiryPolicy: policy.policy,
      warningDays: policy.warningDays,
      criticalDays: policy.criticalDays
    },
    tierCounts: alerts.reduce((acc, alert) => {
      acc[alert.tier] = (acc[alert.tier] || 0) + 1;
      return acc;
    }, {}),
    alerts,
    fefoReady: true,
    consumptionStrategy: 'fefo'
  };
}

export async function listExpiredStock(opts) {
  return listExpiryAlerts({ ...opts, status: 'expired' });
}

export async function listNearExpiryStock({ branchId, user, days = 30, expiringDays, ...rest } = {}) {
  const d = days || expiringDays;
  return listExpiryAlerts({ branchId, user, expiringDays: d, status: 'expiring', ...rest });
}

export async function getBatchQuantityPerBatch({ branchId, user, ingredient } = {}) {
  const scope = await resolveScope({ branchId, user });
  const match = { restaurant: scope.restaurantId, branch: { $in: scope.branchIds }, quantity: { $gt: 1e-9 } };
  if (ingredient) {
    if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
    match.ingredient = new mongoose.Types.ObjectId(ingredient);
  }
  const rows = await InventoryBatch.find(match)
    .populate('ingredient', 'name code unit')
    .populate('branch', 'name code')
    .sort({ expiryDate: 1, receivedAt: 1 })
    .lean();
  return rows.map(row => ({
    _id: row._id,
    branch: row.branch?._id || row.branch,
    branchName: row.branch?.name || '',
    ingredient: row.ingredient?._id || row.ingredient,
    ingredientName: row.ingredient?.name || 'Ingredient',
    batchNumber: row.batchNumber || '',
    expiryDate: row.expiryDate || null,
    status: expiryState(row.expiryDate, { quantity: row.quantity }),
    quantity: Number(row.quantity || 0),
    initialQuantity: Number(row.initialQuantity || 0),
    unitCost: Number(row.unitCost || 0),
    stockValue: money(Number(row.quantity || 0) * Number(row.unitCost || 0)),
    receivedAt: row.receivedAt,
    lotKey: row.lotKey
  }));
}
