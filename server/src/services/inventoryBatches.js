import mongoose from 'mongoose';
import {Branch, InventoryBatch} from '../models/operations.js';

const EPSILON = 1e-9;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value || '').trim();
const sameDate = (left, right) => {
  const a = left ? new Date(left).toISOString().slice(0, 10) : '';
  const b = right ? new Date(right).toISOString().slice(0, 10) : '';
  return a === b;
};

export function normalizeBatchNumber(value) {
  return clean(value).replace(/\s+/g, ' ').toLocaleUpperCase('en');
}

export function kathmanduDateString(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(value);
  const read = type => parts.find(part => part.type === type)?.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

export function canonicalExpiryDate(value) {
  if (!value) return null;
  const text = typeof value === 'string' ? value.slice(0, 10) : new Date(value).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw httpError('Invalid expiry date', 400);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw httpError('Invalid expiry date', 400);
  }
  return parsed;
}

function datePlusDays(dateText, days) {
  const date = canonicalExpiryDate(dateText);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

export function expiryState(expiryDate, {asOf = new Date(), expiringDays = 30, quantity = 1} = {}) {
  if (!(Number(quantity) > EPSILON)) return 'depleted';
  if (!expiryDate) return 'no_expiry';
  const expiry = canonicalExpiryDate(expiryDate).toISOString().slice(0, 10);
  const today = kathmanduDateString(asOf);
  if (expiry < today) return 'expired';
  if (expiry <= datePlusDays(today, expiringDays)) return 'expiring';
  return 'fresh';
}

/** Whole days from today (Kathmandu) until a batch expires. Negative = past. */
export function daysUntilExpiry(expiryDate, asOf = new Date()) {
  if (!expiryDate) return null;
  const expiry = canonicalExpiryDate(expiryDate).getTime();
  const today = canonicalExpiryDate(kathmanduDateString(asOf)).getTime();
  return Math.floor((expiry - today) / 86400000);
}

/**
 * Phase 15 — alert tiers.
 *
 * The alert list previously reported one flat 'expiring' severity for
 * everything inside the window, so a batch with 20 days left looked exactly as
 * urgent as one with 2. The brief asks for 7-day, 3-day and expired tiers, and
 * they are configurable per restaurant.
 *
 *   expired  → critical, already unusable
 *   critical → inside expiryCriticalDays (default 3)
 *   warning  → inside expiryWarningDays  (default 7)
 *   notice   → inside the wider reporting window
 *   fresh / no_expiry → informational
 */
export const EXPIRY_TIERS = Object.freeze(['expired', 'critical', 'warning', 'notice', 'fresh', 'no_expiry', 'depleted']);

export function expiryTier(expiryDate, {
  asOf = new Date(),
  quantity = 1,
  expiringDays = 30,
  warningDays = 7,
  criticalDays = 3
} = {}) {
  const state = expiryState(expiryDate, {asOf, expiringDays, quantity});
  if (state !== 'expiring') return state;
  const days = daysUntilExpiry(expiryDate, asOf);
  if (days <= Number(criticalDays)) return 'critical';
  if (days <= Number(warningDays)) return 'warning';
  return 'notice';
}

export const EXPIRY_TIER_SEVERITY = Object.freeze({
  expired: 'critical',
  critical: 'critical',
  warning: 'warning',
  notice: 'info',
  fresh: 'info',
  no_expiry: 'info',
  depleted: 'info'
});

async function branchRestaurant(branchId, session) {
  const branch = await Branch.findById(branchId).select('_id restaurant').session(session || null);
  if (!branch) throw httpError('Branch not found', 404);
  if (!branch.restaurant) throw httpError('Branch is not assigned to a restaurant', 409);
  return branch.restaurant;
}

function movementView(batch, before, change) {
  return {
    batch: batch._id,
    batchNumber: batch.batchNumber || undefined,
    expiryDate: batch.expiryDate || undefined,
    previousQty: before,
    changeQty: change,
    newQty: before + change,
    unitCost: Number(batch.unitCost || 0)
  };
}

function lotKeyFor(entry, {branch, ingredient, sourceType, sourceId, fallback}) {
  if (entry.lotKey) return clean(entry.lotKey).slice(0, 300);
  const effectiveSourceId = entry.sourceId || sourceId;
  if (effectiveSourceId) {
    return `${entry.sourceType || sourceType || 'untracked'}:${effectiveSourceId}:${entry.sourceLine || fallback}`.slice(0, 300);
  }
  return `untracked:${branch}:${ingredient}:${fallback}`.slice(0, 300);
}

async function saveBatch(batch, session) {
  try {
    await batch.save({session: session || undefined, inventoryLedgerWrite: true});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Inventory batch changed; retry the operation', 409);
    throw error;
  }
}

export async function ensureBatchCoverage({balance, branch, ingredient, unit}, session) {
  const totalRows = await InventoryBatch.aggregate([
    {$match: {branch: new mongoose.Types.ObjectId(String(branch)), ingredient: new mongoose.Types.ObjectId(String(ingredient))}},
    {$group: {_id: null, quantity: {$sum: '$quantity'}}}
  ]).session(session || null);
  const tracked = Number(totalRows[0]?.quantity || 0);
  const expected = Number(balance?.quantity || 0);
  const missing = expected - tracked;
  if (Math.abs(missing) > EPSILON) {
    throw httpError('Inventory batch quantities do not match the aggregate ledger balance; run the inventory migration before posting movements',409);
  }
}

function normalizeIncoming(entry, defaults) {
  const batchNumber = clean(entry.batchNumber);
  const expiryDate = canonicalExpiryDate(entry.expiryDate);
  const quantity = Number(entry.quantity);
  if (!(quantity > EPSILON)) throw httpError('Inventory batch quantity must be positive', 400);
  return {
    quantity,
    batchNumber: batchNumber || undefined,
    batchNumberNormalized: batchNumber ? normalizeBatchNumber(batchNumber) : undefined,
    expiryDate: expiryDate || undefined,
    receivedAt: entry.receivedAt || defaults.receivedAt || new Date(),
    sourceType: entry.sourceType || defaults.sourceType || 'untracked',
    sourceId: entry.sourceId || defaults.sourceId,
    sourceLine: entry.sourceLine,
    supplier: entry.supplier || defaults.supplier,
    unit: entry.unit || defaults.unit,
    unitCost: Number(entry.unitCost ?? defaults.unitCost ?? 0),
    lotKey: lotKeyFor(entry, defaults)
  };
}

export async function addBatchStock({
  balance,
  branch,
  ingredient,
  quantity,
  unit,
  unitCost,
  incomingBatches,
  restoredMovements,
  sourceType,
  sourceId,
  supplier,
  receivedAt
}, session) {
  const amount = Number(quantity);
  if (!(amount > EPSILON)) return [];
  const restaurant = await branchRestaurant(branch, session);
  await ensureBatchCoverage({balance, branch, ingredient, unit}, session);

  if (restoredMovements?.length) {
    const requested = restoredMovements.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
    if (Math.abs(requested - amount) > EPSILON) throw httpError('Restored batch quantities do not match the stock movement', 409);
    const movements = [];
    for (const row of restoredMovements) {
      const restoreQty = Number(row.quantity || 0);
      if (!(restoreQty > EPSILON) || !mongoose.isValidObjectId(row.batch)) throw httpError('Invalid restored inventory batch', 409);
      const batch = await InventoryBatch.findOne({
        _id: row.batch,
        restaurant,
        branch,
        ingredient
      }).session(session || null);
      if (!batch) throw httpError('Original inventory batch is unavailable for reversal', 409);
      const before = Number(batch.quantity || 0);
      batch.quantity = before + restoreQty;
      await saveBatch(batch, session);
      movements.push(movementView(batch, before, restoreQty));
    }
    return movements;
  }

  const entries = incomingBatches?.length ? incomingBatches : [{quantity: amount}];
  const incomingTotal = entries.reduce((sum, row) => sum + Number(row.quantity || 0), 0);
  if (Math.abs(incomingTotal - amount) > EPSILON) throw httpError('Incoming batch quantities do not match the stock movement', 409);

  const defaults = {branch, ingredient, unit, unitCost, sourceType, sourceId, supplier, receivedAt, fallback: 0};
  const movements = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = normalizeIncoming(entries[index], {...defaults, fallback: index});
    let batch = await InventoryBatch.findOne({restaurant, branch, ingredient, lotKey: entry.lotKey}).session(session || null);
    if (batch) {
      if (normalizeBatchNumber(batch.batchNumber) !== normalizeBatchNumber(entry.batchNumber) || !sameDate(batch.expiryDate, entry.expiryDate)) {
        throw httpError('Inventory batch identity conflicts with an existing lot', 409);
      }
      const beforeInitial = Number(batch.initialQuantity || 0);
      const combined = beforeInitial + entry.quantity;
      batch.unitCost = combined > 0
        ? ((beforeInitial * Number(batch.unitCost || 0)) + (entry.quantity * entry.unitCost)) / combined
        : entry.unitCost;
      batch.initialQuantity = combined;
      const before = Number(batch.quantity || 0);
      batch.quantity = before + entry.quantity;
      await saveBatch(batch, session);
      movements.push(movementView(batch, before, entry.quantity));
    } else {
      batch = new InventoryBatch({restaurant, branch, ingredient, ...entry, initialQuantity: entry.quantity, quantity: entry.quantity});
      await saveBatch(batch, session);
      movements.push(movementView(batch, 0, entry.quantity));
    }
  }
  return movements;
}

function sortFefo(left, right) {
  const leftExpiry = left.expiryDate ? new Date(left.expiryDate).getTime() : Number.POSITIVE_INFINITY;
  const rightExpiry = right.expiryDate ? new Date(right.expiryDate).getTime() : Number.POSITIVE_INFINITY;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
  const received = new Date(left.receivedAt || left.createdAt).getTime() - new Date(right.receivedAt || right.createdAt).getTime();
  return received || String(left._id).localeCompare(String(right._id));
}

function sortFifo(left, right) {
  const leftReceived = new Date(left.receivedAt || left.createdAt).getTime();
  const rightReceived = new Date(right.receivedAt || right.createdAt).getTime();
  if (leftReceived !== rightReceived) return leftReceived - rightReceived;
  return String(left._id).localeCompare(String(right._id));
}

export const BATCH_CONSUMPTION_STRATEGIES = Object.freeze({
  fefo: { key: 'fefo', label: 'FEFO — First Expired First Out', description: 'Consumes the batch whose expiry is nearest (nulls last). Current production strategy.', sort: sortFefo },
  fifo: { key: 'fifo', label: 'FIFO — First In First Out', description: 'Consumes by earliest receivedAt. Ready via ?strategy=fifo without data migration.', sort: sortFifo }
});

export function consumptionSortFor(strategy = 'fefo') {
  const key = String(strategy || 'fefo').toLowerCase();
  return BATCH_CONSUMPTION_STRATEGIES[key]?.sort || sortFefo;
}

export async function removeBatchStock({
  balance,
  branch,
  ingredient,
  quantity,
  unit,
  batchId,
  batchNumber,
  allowExpired = false,
  asOf = new Date(),
  strategy = 'fefo'
}, session) {
  const amount = Math.abs(Number(quantity));
  if (!(amount > EPSILON)) return [];
  const restaurant = await branchRestaurant(branch, session);
  await ensureBatchCoverage({balance, branch, ingredient, unit}, session);

  const match = {restaurant, branch, ingredient, quantity: {$gt: EPSILON}};
  if (batchId) {
    if (!mongoose.isValidObjectId(batchId)) throw httpError('Invalid inventory batch', 400);
    match._id = batchId;
  }
  if (batchNumber) match.batchNumberNormalized = normalizeBatchNumber(batchNumber);
  if (!allowExpired) {
    const today = canonicalExpiryDate(kathmanduDateString(asOf));
    match.$or = [{expiryDate: {$exists: false}}, {expiryDate: null}, {expiryDate: {$gte: today}}];
  }

  const batches = await InventoryBatch.find(match).session(session || null);
  batches.sort(consumptionSortFor(strategy));
  const available = batches.reduce((sum, batch) => sum + Number(batch.quantity || 0), 0);
  if (available + EPSILON < amount) {
    throw httpError(allowExpired ? 'Insufficient inventory in the selected batch' : 'Insufficient unexpired inventory', 409);
  }

  let remaining = amount;
  const movements = [];
  for (const batch of batches) {
    if (!(remaining > EPSILON)) break;
    const before = Number(batch.quantity || 0);
    const take = Math.min(before, remaining);
    batch.quantity = before - take;
    await saveBatch(batch, session);
    movements.push(movementView(batch, before, -take));
    remaining -= take;
  }
  return movements;
}

export function incomingBatchesFromMovements(movements, {sourceType, sourceId, unitCost, receivedAt} = {}) {
  return (movements || []).filter(row => Number(row.changeQty) < 0).map(row => ({
    quantity: Math.abs(Number(row.changeQty)),
    batchNumber: row.batchNumber,
    expiryDate: row.expiryDate,
    unitCost: Number(unitCost ?? row.unitCost ?? 0),
    sourceType,
    sourceId,
    sourceLine: row.batch,
    lotKey: `${sourceType}:${sourceId}:${row.batch}`,
    receivedAt
  }));
}
