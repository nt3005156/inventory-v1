import mongoose from 'mongoose';
import { Ingredient } from '../models/index.js';
import { Branch, InventoryBalance, InventoryBatch, InventoryTransaction, Notification } from '../models/operations.js';
import { assertTenantBranchAccess } from './kitchen.js';
import { resolveDashboardBranch } from './dashboard.js';
import { kathmanduDateString, canonicalExpiryDate, expiryState } from './inventoryBatches.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function resolveBranch(user, branchId) {
  const branch = resolveDashboardBranch(user, branchId);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    await assertTenantBranchAccess(user, branch);
  }
  return branch;
}

async function resolveAlertScope(user, branchId) {
  const branch = await resolveBranch(user, branchId);
  // Need restaurant for expiry queries
  let restaurantId = user?.restaurantId;
  if (!restaurantId) {
    const { userRestaurantContext } = await import('./supplierCatalog.js');
    const ctx = await userRestaurantContext(user);
    restaurantId = ctx.restaurantId;
  }
  let branchIds;
  if (branch) {
    branchIds = [new mongoose.Types.ObjectId(branch)];
  } else {
    // owner without branch filter -> all restaurant branches
    const { userRestaurantContext } = await import('./supplierCatalog.js');
    const ctx = await userRestaurantContext(user);
    branchIds = await Branch.find({ restaurant: ctx.restaurantId }).distinct('_id');
  }
  return { branch, branchIds, restaurantId };
}

export const ALERT_TYPES = Object.freeze([
  'low_stock',
  'out_of_stock',
  'expiry_approaching',
  'expired',
  'unusual_consumption',
  'negative_inventory',
  // Phase 17: the one alert class the brief names that did not exist. Waste
  // was recorded and reportable, but nothing ever flagged that it had become
  // excessive relative to what the branch actually consumes.
  'high_waste'
]);

/** Share of consumption lost to waste before it is worth flagging. */
export const HIGH_WASTE_THRESHOLD = 0.1;

/** Minimum wasted quantity before the ratio means anything. */
const HIGH_WASTE_MIN_QTY = 1;

/**
 * High waste: waste as a proportion of everything consumed over a window.
 *
 * A ratio, not an absolute, because 2kg of rice wasted in a branch that used
 * 500kg is noise, while the same 2kg in a branch that used 6kg is a problem.
 * Very small absolute quantities are ignored so a single spill on a quiet day
 * does not read as a 100% waste rate.
 */
async function buildHighWasteAlerts({branchIds, restaurantId, days = 7, threshold = HIGH_WASTE_THRESHOLD}) {
  const window = Math.min(90, Math.max(1, Number(days) || 7));
  const since = new Date(Date.now() - window * 86400000);

  const rows = await InventoryTransaction.find({
    restaurant: restaurantId,
    branch: {$in: branchIds},
    type: {$in: ['WASTE', 'RECIPE_DEDUCTION', 'SALE']},
    createdAt: {$gte: since}
  }).select('branch ingredient type changeQty').lean();
  if (!rows.length) return [];

  const totals = new Map();
  for (const row of rows) {
    const key = `${row.branch}:${row.ingredient}`;
    const current = totals.get(key) || {waste: 0, consumed: 0};
    const qty = Math.abs(Number(row.changeQty || 0));
    if (row.type === 'WASTE') current.waste += qty;
    current.consumed += qty;
    totals.set(key, current);
  }

  const alerts = [];
  for (const [key, value] of totals) {
    if (value.consumed <= 1e-9) continue;
    if (value.waste < HIGH_WASTE_MIN_QTY) continue;
    const ratio = value.waste / value.consumed;
    if (ratio < threshold) continue;

    const [branchId, ingredientId] = key.split(':');
    const [ingredient, branch] = await Promise.all([
      Ingredient.findById(ingredientId).select('name code unit').lean().catch(() => null),
      Branch.findById(branchId).select('name code').lean().catch(() => null)
    ]);
    alerts.push({
      _id: new mongoose.Types.ObjectId(),
      type: 'high_waste',
      title: 'High waste',
      body: `${ingredient?.name || 'Ingredient'} — ${(ratio * 100).toFixed(1)}% of the last ${window}d consumption was wasted `
        + `(${value.waste.toLocaleString('en-NP')} of ${value.consumed.toLocaleString('en-NP')} ${ingredient?.unit || 'g'})`,
      read: false,
      branch: branchId,
      branchName: branch?.name || '',
      ingredientId,
      ingredientName: ingredient?.name || '',
      quantity: Number(value.waste.toFixed(3)),
      consumedQuantity: Number(value.consumed.toFixed(3)),
      wasteRatio: Number(ratio.toFixed(4)),
      wastePercent: Number((ratio * 100).toFixed(2)),
      threshold,
      days: window,
      createdAt: new Date(),
      source: 'computed',
      synthetic: true,
      severity: ratio >= threshold * 2 ? 'critical' : 'warning'
    });
  }
  return alerts.sort((left, right) => right.wasteRatio - left.wasteRatio);
}

// Build synthetic expiry alerts from batches (quantity per batch + expiry)
async function buildExpiryAlerts({ branchIds, restaurantId, expiringDays = 30 }) {
  const days = Math.min(365, Math.max(1, Number(expiringDays) || 30));
  const todayText = kathmanduDateString();
  const today = canonicalExpiryDate(todayText);
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + days);

  const batches = await InventoryBatch.find({
    restaurant: restaurantId,
    branch: { $in: branchIds },
    quantity: { $gt: 1e-9 },
    expiryDate: { $exists: true, $ne: null }
  })
    .populate('ingredient', 'name code unit')
    .populate('branch', 'name code')
    .lean();

  const alerts = [];
  for (const b of batches) {
    const state = expiryState(b.expiryDate, { expiringDays: days, quantity: b.quantity });
    if (state !== 'expired' && state !== 'expiring') continue;
    const isExpired = state === 'expired';
    const expDate = b.expiryDate ? new Date(b.expiryDate) : null;
    const daysUntil = expDate ? Math.floor((new Date(expDate).setUTCHours(0,0,0,0) - new Date(today).setUTCHours(0,0,0,0)) / 86400000) : null;
    alerts.push({
      _id: new mongoose.Types.ObjectId(), // synthetic, not persisted
      type: isExpired ? 'expired' : 'expiry_approaching',
      title: isExpired ? 'Expired stock' : 'Expiry approaching',
      body: isExpired
        ? `${b.ingredient?.name || 'Ingredient'} — ${b.batchNumber || 'lot'} expired ${Math.abs(daysUntil||0)}d ago • ${Number(b.quantity||0).toLocaleString('en-NP')} ${b.unit || b.ingredient?.unit || 'g'} @ ${b.expiryDate ? new Date(b.expiryDate).toISOString().slice(0,10) : '—'}`
        : `${b.ingredient?.name || 'Ingredient'} — ${b.batchNumber || 'lot'} expires in ${daysUntil}d • ${Number(b.quantity||0).toLocaleString('en-NP')} ${b.unit || b.ingredient?.unit || 'g'} @ ${b.expiryDate ? new Date(b.expiryDate).toISOString().slice(0,10) : '—'}`,
      read: false,
      branch: b.branch?._id || b.branch,
      branchName: b.branch?.name || '',
      ingredientId: b.ingredient?._id || b.ingredient,
      ingredientName: b.ingredient?.name || '',
      batchId: b._id,
      batchNumber: b.batchNumber || '',
      expiryDate: b.expiryDate || null,
      quantity: Number(b.quantity || 0),
      unitCost: Number(b.unitCost || 0),
      createdAt: b.updatedAt || b.createdAt || new Date(),
      source: 'computed',
      synthetic: true,
      severity: isExpired ? 'critical' : 'warning',
      daysUntilExpiry: daysUntil
    });
  }
  // Sort: expired first (most overdue), then nearest expiry
  alerts.sort((a,b)=>{
    if(a.type!==b.type) return a.type==='expired' ? -1 : 1;
    const aExp = a.expiryDate ? new Date(a.expiryDate).getTime() : Number.POSITIVE_INFINITY;
    const bExp = b.expiryDate ? new Date(b.expiryDate).getTime() : Number.POSITIVE_INFINITY;
    return aExp - bExp;
  });
  return alerts;
}

// Unusual consumption: compare today vs last 14 days avg per ingredient
async function buildUnusualConsumptionAlerts({ branchIds, restaurantId }) {
  const consumptionTypes = ['RECIPE_DEDUCTION', 'WASTE'];
  const now = new Date();
  const todayText = kathmanduDateString(now);
  const todayStart = new Date(`${todayText}T00:00:00.000+05:45`);
  const todayEnd = new Date(todayStart.getTime() + 86400000);
  const fourteenDaysAgo = new Date(todayStart.getTime() - 14*86400000);
  const thirtyDaysAgo = new Date(todayStart.getTime() - 30*86400000);

  // Fetch 30 days of consumption
  const rows = await InventoryTransaction.find({
    restaurant: restaurantId,
    branch: { $in: branchIds },
    type: { $in: consumptionTypes },
    createdAt: { $gte: thirtyDaysAgo, $lt: todayEnd }
  }).select('branch ingredient changeQty createdAt').lean();

  if (!rows.length) return [];

  // Group by branch+ingredient -> daily totals
  const byKey = new Map(); // key -> Map(day -> total)
  for (const r of rows) {
    const key = `${r.branch}:${r.ingredient}`;
    const day = kathmanduDateString(r.createdAt);
    const map = byKey.get(key) || new Map();
    map.set(day, (map.get(day) || 0) + Math.abs(Number(r.changeQty||0)));
    byKey.set(key, map);
  }

  const alerts = [];
  for (const [key, dayMap] of byKey.entries()) {
    const todayQty = dayMap.get(todayText) || 0;
    if (todayQty <= 1e-9) continue; // no consumption today
    // Build array of last 14 days excluding today
    const history = [];
    for (let i=1;i<=14;i++) {
      const d = new Date(todayStart.getTime() - i*86400000);
      const dayText = kathmanduDateString(d);
      history.push(dayMap.get(dayText) || 0);
    }
    const nonZeroHistory = history.filter(v=>v>1e-9);
    if (nonZeroHistory.length < 3) continue; // need at least 3 days of history
    const mean = nonZeroHistory.reduce((s,v)=>s+v,0)/nonZeroHistory.length;
    const variance = nonZeroHistory.reduce((s,v)=>s+ Math.pow(v-mean,2),0)/nonZeroHistory.length;
    const std = Math.sqrt(variance);
    const threshold1 = mean + 2*std;
    const threshold2 = mean * 1.8;
    const isUnusual = todayQty > threshold1 && todayQty > threshold2;
    // also flag if today > 2.5 * mean even if std is 0
    const isUnusual2 = std < 1e-9 && todayQty > mean * 2.0;
    if (!isUnusual && !isUnusual2) continue;

    const [branchId, ingredientId] = key.split(':');
    const ingredient = await Ingredient.findById(ingredientId).select('name code unit').lean().catch(()=>null);
    const branch = await Branch.findById(branchId).select('name code').lean().catch(()=>null);
    alerts.push({
      _id: new mongoose.Types.ObjectId(),
      type: 'unusual_consumption',
      title: 'Unusual consumption',
      body: `${ingredient?.name || 'Ingredient'} consumed ${todayQty.toLocaleString('en-NP')} ${ingredient?.unit || 'g'} today vs avg ${mean.toFixed(1)} (σ ${std.toFixed(1)}) over last 14d`,
      read: false,
      branch: branchId,
      branchName: branch?.name || '',
      ingredientId: ingredientId,
      ingredientName: ingredient?.name || '',
      quantity: todayQty,
      averageConsumption: Number(mean.toFixed(2)),
      stdDev: Number(std.toFixed(2)),
      threshold: Number(threshold1.toFixed(2)),
      createdAt: now,
      source: 'computed',
      synthetic: true,
      severity: 'warning',
      days: 14
    });
  }
  return alerts.sort((a,b)=> b.quantity - a.quantity);
}

export async function listAlerts({ branchId, user, unread = true, type, expiringDays = 30 }) {
  const scope = await resolveAlertScope(user, branchId);
  const branch = scope.branch;
  const match = {
    ...(branch ? { branch: new mongoose.Types.ObjectId(branch) } : scope.branchIds.length ? { branch: { $in: scope.branchIds } } : {}),
    ...(unread ? { read: false } : {}),
    ...(type && ALERT_TYPES.includes(type) ? { type } : {})
  };

  // Stored alerts: low_stock, out_of_stock, negative_inventory (and maybe others persisted)
  let stored = [];
  try {
    const rows = await Notification.find(match).sort({ createdAt: -1 }).limit(200).populate('branch', 'name code');
    const ids = [...new Set(rows.map(n => n.referenceId).filter(Boolean).map(String))];
    const ingredients = ids.length ? await Ingredient.find({ _id: { $in: ids } }).select('name code unit') : [];
    const byId = Object.fromEntries(ingredients.map(i => [String(i._id), i]));
    stored = rows.map(n => {
      const ing = n.referenceId ? byId[String(n.referenceId)] : null;
      return {
        _id: n._id,
        type: n.type,
        title: n.title,
        body: n.body,
        read: !!n.read,
        branch: n.branch?._id || n.branch,
        branchName: n.branch?.name || '',
        ingredientId: ing?._id || n.referenceId || null,
        ingredientName: ing?.name || '',
        createdAt: n.createdAt,
        source: 'live',
        synthetic: false,
        severity: n.type === 'out_of_stock' ? 'critical' : n.type === 'negative_inventory' ? 'critical' : n.type === 'low_stock' ? 'warning' : 'info'
      };
    });
  } catch {}

  // Computed expiry alerts
  let expiryAlerts = [];
  if (!type || ['expiry_approaching','expired'].includes(type)) {
    try {
      const wantExpired = !type || type === 'expired';
      const wantApproaching = !type || type === 'expiry_approaching';
      const allExpiry = await buildExpiryAlerts({ branchIds: scope.branchIds, restaurantId: scope.restaurantId, expiringDays });
      expiryAlerts = allExpiry.filter(a => (wantExpired && a.type==='expired') || (wantApproaching && a.type==='expiry_approaching') || (!type));
      if (unread) {
        // computed alerts are always unread (not dismissable via stored read flag)
        // we could filter by read? they are always unread
      }
    } catch {}
  }

  // Computed unusual consumption
  let unusual = [];
  if (!type || type === 'unusual_consumption') {
    try {
      unusual = await buildUnusualConsumptionAlerts({ branchIds: scope.branchIds, restaurantId: scope.restaurantId });
    } catch {}
  }

  // Computed high waste
  let highWaste = [];
  if (!type || type === 'high_waste') {
    try {
      highWaste = await buildHighWasteAlerts({ branchIds: scope.branchIds, restaurantId: scope.restaurantId });
    } catch {}
  }

  // Negative inventory attempts that are stored are already in stored.
  // If we want to also include synthetic negative from recent failures, stored already covers.

  const combined = [...stored, ...expiryAlerts, ...unusual, ...highWaste];

  // Optional type filter for synthetic (if type provided, filter again)
  const filtered = type ? combined.filter(a => a.type === type) : combined;

  // Sort: critical first, then by createdAt desc
  const severityOrder = { critical: 0, warning: 1, info: 2 };
  filtered.sort((a,b)=>{
    const sA = severityOrder[a.severity] ?? 2;
    const sB = severityOrder[b.severity] ?? 2;
    if(sA!==sB) return sA-sB;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // Limit 200 total
  return filtered.slice(0,200);
}

export async function markAlertRead({ alertId, user }) {
  if (!mongoose.isValidObjectId(alertId)) throw httpError('Invalid alert', 400);
  const alert = await Notification.findById(alertId);
  if (!alert) throw httpError('Alert not found', 404);
  if (alert.branch) await assertTenantBranchAccess(user, alert.branch);
  alert.read = true;
  await alert.save();
  return alert;
}

export async function markAlertsRead({ branchId, user }) {
  const branch = await resolveBranch(user, branchId);
  const match = { read: false, ...(branch ? { branch: new mongoose.Types.ObjectId(branch) } : {}) };
  const result = await Notification.updateMany(match, { $set: { read: true } });
  return { updated: result.modifiedCount || 0, branch: branch || null };
}

// Helper to record a negative inventory attempt (outside transaction so it persists)
export async function recordNegativeInventoryAlert({ branch, ingredient, attemptedQty, availableQty, userId, restaurantId }) {
  try {
    const ingredientDoc = await Ingredient.findById(ingredient).select('name').lean().catch(()=>null);
    const name = ingredientDoc?.name || 'Ingredient';
    await Notification.create({
      branch,
      type: 'negative_inventory',
      title: 'Negative inventory blocked',
      body: `${name} — attempted ${Number(attemptedQty||0).toLocaleString('en-NP')} but only ${Number(availableQty||0).toLocaleString('en-NP')} available (FEFO)`,
      referenceId: ingredient,
      read: false
    });
  } catch {}
}

export async function recordUnusualConsumptionAlertIfNeeded() {
  // placeholder for future scheduled job
}


// ═══════════════════════════════════════════════════════════════════════════
// Phase 16A — alert lifecycle
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Persist an actionable alert, refusing a duplicate for the same unresolved
 * condition.
 *
 * The unique partial index on {branch, type, referenceId} scoped to
 * open/acknowledged is the real guarantee; the pre-check below only avoids a
 * pointless write in the common case. On a genuine race the index raises
 * E11000 and the existing alert is returned, which is the correct answer.
 */
export async function persistAlert({
  branch, restaurant, type, title, body, severity = 'warning',
  ingredient, referenceId, context, session
}) {
  if (!ALERT_TYPES.includes(type)) throw httpError(`Unknown alert type: ${type}`, 400);
  const reference = referenceId || ingredient || null;
  const filter = {
    branch, type, referenceId: reference, status: {$in: ['open', 'acknowledged']}
  };
  const existing = await Notification.findOne(filter).session(session || null);
  if (existing) return {alert: existing, created: false};

  try {
    const [alert] = await Notification.create([{
      branch, restaurant, type, title, body, severity,
      ingredient: ingredient || undefined,
      referenceId: reference || undefined,
      status: 'open',
      context
    }], {session: session || undefined});
    return {alert, created: true};
  } catch (error) {
    if (error?.code === 11000) {
      const winner = await Notification.findOne(filter).session(session || null);
      if (winner) return {alert: winner, created: false};
    }
    throw error;
  }
}

async function scopedAlert({alertId, user}) {
  if (!mongoose.isValidObjectId(alertId)) throw httpError('Invalid alert', 400);
  const alert = await Notification.findById(alertId);
  if (!alert) throw httpError('Alert not found', 404);
  // Tenancy: an alert without a branch is restaurant-wide and is refused to
  // anyone outside the restaurant by the branch guard below where present.
  if (alert.branch) await assertTenantBranchAccess(user, alert.branch);
  else throw httpError('Alert is not branch scoped', 409);
  return alert;
}

/** Acknowledge an alert: somebody has seen it and owns it. */
export async function acknowledgeAlert({alertId, user, note}) {
  const alert = await scopedAlert({alertId, user});
  if (alert.status === 'resolved') throw httpError('A resolved alert cannot be acknowledged', 409);
  if (alert.status === 'acknowledged') return alert;
  alert.status = 'acknowledged';
  alert.acknowledgedAt = new Date();
  alert.acknowledgedBy = user.id;
  if (note !== undefined) alert.resolutionNote = String(note ?? '').trim() || undefined;
  alert.read = true;
  await alert.save();
  return alert;
}

/**
 * Resolve an alert: the underlying condition has been dealt with.
 *
 * Resolution frees the unique index, so the same condition can raise a fresh
 * alert if it recurs — which is what an operator expects after restocking.
 */
export async function resolveAlert({alertId, user, note}) {
  const alert = await scopedAlert({alertId, user});
  if (alert.status === 'resolved') return alert;
  alert.status = 'resolved';
  alert.resolvedAt = new Date();
  alert.resolvedBy = user.id;
  if (note !== undefined) alert.resolutionNote = String(note ?? '').trim() || undefined;
  alert.read = true;
  await alert.save();
  return alert;
}


/**
 * Persists the computed alert classes (high waste, unusual consumption) so
 * they can be acknowledged like any other actionable alert.
 *
 * They remain computed on read for the live list — that behaviour is
 * unchanged — but a sweep can now durably record them. Duplicate suppression
 * is the same unique index every other alert uses.
 */
export async function persistComputedAlerts({branchId, user, restaurantId}) {
  const scope = await resolveAlertScope(user, branchId);
  const [waste, unusual] = await Promise.all([
    buildHighWasteAlerts({branchIds: scope.branchIds, restaurantId: restaurantId || scope.restaurantId}).catch(() => []),
    buildUnusualConsumptionAlerts({branchIds: scope.branchIds, restaurantId: restaurantId || scope.restaurantId}).catch(() => [])
  ]);

  const persisted = [];
  for (const alert of [...waste, ...unusual]) {
    if (!alert.branch || !alert.ingredientId) continue;
    const outcome = await persistAlert({
      branch: alert.branch,
      restaurant: restaurantId || scope.restaurantId,
      type: alert.type,
      title: alert.title,
      body: alert.body,
      severity: alert.severity,
      ingredient: alert.ingredientId,
      referenceId: alert.ingredientId,
      context: {
        quantity: alert.quantity,
        ...(alert.wastePercent !== undefined ? {wastePercent: alert.wastePercent} : {}),
        ...(alert.averageConsumption !== undefined ? {averageConsumption: alert.averageConsumption} : {})
      }
    });
    if (outcome.created) persisted.push({type: alert.type, ingredient: String(alert.ingredientId)});
  }
  return {persisted: persisted.length, alerts: persisted};
}
