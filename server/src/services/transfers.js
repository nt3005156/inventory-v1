import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Audit, Ingredient } from '../models/index.js';
import { Branch, InventoryBalance, InventoryTransaction, StockTransfer } from '../models/operations.js';
import { moveStock } from './inventoryLedger.js';
import { incomingBatchesFromMovements } from './inventoryBatches.js';
import { purchaseBranchContext } from './purchaseOrders.js';
import { userRestaurantContext } from './supplierCatalog.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clean = value => String(value ?? '').trim();

function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
    const normalized = canonical(value[key]);
    return normalized === undefined ? [] : [[key, normalized]];
  }));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizedTransferPayload({ fromBranch, toBranch, ingredient, qty, unit, restaurant }) {
  return {
    fromBranch: String(fromBranch),
    toBranch: String(toBranch),
    ingredient: String(ingredient),
    qty: Number(qty),
    unit: clean(unit),
    restaurant: String(restaurant)
  };
}

export const TRANSFER_TRANSITIONS = {
  requested: ['approved', 'cancelled'],
  approved: ['in_transit', 'cancelled'],
  in_transit: ['received'],
  received: [],
  cancelled: []
};

export const TRANSFER_POPULATE = [
  { path: 'ingredient', select: 'name code unit' },
  { path: 'fromBranch', select: 'name code' },
  { path: 'toBranch', select: 'name code' },
  { path: 'requestedBy', select: 'name role' },
  { path: 'approvedBy', select: 'name role' }
];

export function canTransitionTransfer(from, to) {
  return (TRANSFER_TRANSITIONS[from] || []).includes(to);
}

export function transferFilter(branchId) {
  if (!branchId) return {};
  return { $or: [{ fromBranch: branchId }, { toBranch: branchId }] };
}

export function resolveTransferBranch(user, branchId) {
  if (branchId) return String(branchId);
  if (user?.role !== 'owner' && user?.branch) return String(user.branch);
  return null;
}

async function sourceMovement(transfer, session) {
  return InventoryTransaction.findOne({
    referenceType: 'transfer',
    referenceId: transfer._id,
    type: 'TRANSFER_OUT'
  }).session(session || null);
}

async function sourceUnitCost(transfer, session) {
  const outTx = await sourceMovement(transfer, session);
  if (outTx) return Number(outTx.unitCost || 0);
  const source = await InventoryBalance.findOne({
    branch: transfer.fromBranch,
    ingredient: transfer.ingredient
  }).session(session || null);
  return Number(source?.averageCost || 0);
}

export async function listTransfers({ branchId, user }) {
  const identity = await userRestaurantContext(user);
  const branch = resolveTransferBranch({ ...user, role: identity.role, branch: identity.branchId }, branchId);
  let branchIds;
  if (branch) {
    const context = await purchaseBranchContext({ user, branchId: branch, allowInactive: true });
    branchIds = [context.branch._id];
  } else {
    branchIds = await Branch.find({ restaurant: identity.restaurantId }).distinct('_id');
  }
  return StockTransfer.find({ $or: [{ fromBranch: { $in: branchIds } }, { toBranch: { $in: branchIds } }] })
    .populate(TRANSFER_POPULATE)
    .sort({ createdAt: -1 });
}

export async function createTransfer({ fromBranch, toBranch, ingredient, qty, unit, user, idempotencyKey, session }) {
  if (!mongoose.isValidObjectId(fromBranch) || !mongoose.isValidObjectId(toBranch)) {
    throw httpError('Invalid branch', 400);
  }
  if (String(fromBranch) === String(toBranch)) throw httpError('Source and destination must differ', 400);
  if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
  const amount = Number(qty);
  if (!(amount > 0) || !Number.isFinite(amount)) throw httpError('Quantity must be positive', 400);
  const key = clean(idempotencyKey);
  if (key && (key.length < 3 || key.length > 200)) throw httpError('A valid Idempotency-Key is required', 400);

  const context = await purchaseBranchContext({ user, branchId: fromBranch, session, allowInactive: true });
  const [dest, item] = await Promise.all([
    Branch.findOne({ _id: toBranch, restaurant: context.restaurantId }).session(session || null),
    Ingredient.findOne({ _id: ingredient, restaurant: context.restaurantId }).session(session || null)
  ]);
  if (!dest) throw httpError('Destination branch not found', 404);
  if (!item) throw httpError('Ingredient not found', 404);
  const normalizedUnit = clean(unit || item.unit || 'g');
  if (!normalizedUnit || normalizedUnit.length > 30) throw httpError('Transfer unit is required', 400);

  const payload = normalizedTransferPayload({
    fromBranch,
    toBranch,
    ingredient,
    qty: amount,
    unit: normalizedUnit,
    restaurant: context.restaurantId
  });
  const hash = fingerprint({ version: 1, ...payload });

  if (key) {
    const prior = await StockTransfer.findOne({ restaurant: context.restaurantId, requestKey: key })
      .select('+requestKey +requestHash')
      .session(session || null);
    if (prior) {
      if (prior.requestHash !== hash) throw httpError('Idempotency key was already used for a different transfer', 409);
      const populated = await StockTransfer.findById(prior._id).populate(TRANSFER_POPULATE).session(session || null);
      if (populated) populated.$locals.idempotentReplay = true;
      return populated;
    }
  }

  const doc = {
    restaurant: context.restaurantId,
    fromBranch,
    toBranch,
    ingredient,
    qty: amount,
    unit: normalizedUnit,
    status: 'requested',
    requestedBy: context.userId || user.id,
    ...(key ? { requestKey: key, requestHash: hash } : {})
  };

  let saved;
  try {
    const created = await StockTransfer.create([doc], { session: session || undefined });
    saved = created[0];
  } catch (error) {
    if (error?.code === 11000 && key) {
      const prior = await StockTransfer.findOne({ restaurant: context.restaurantId, requestKey: key })
        .select('+requestKey +requestHash')
        .session(session || null);
      if (prior) {
        if (prior.requestHash !== hash) throw httpError('Idempotency key was already used for a different transfer', 409);
        const populated = await StockTransfer.findById(prior._id).populate(TRANSFER_POPULATE).session(session || null);
        if (populated) populated.$locals.idempotentReplay = true;
        return populated;
      }
    }
    throw error;
  }

  const populated = await StockTransfer.findById(saved._id).populate(TRANSFER_POPULATE).session(session || null);
  if (populated && key) populated.$locals.idempotentReplay = false;
  return populated;
}

export async function replayTransferCreate({ fromBranch, toBranch, ingredient, qty, unit, user, idempotencyKey }) {
  const key = clean(idempotencyKey);
  if (!key || key.length < 3 || key.length > 200) throw httpError('A valid Idempotency-Key is required', 400);
  if (!mongoose.isValidObjectId(fromBranch) || !mongoose.isValidObjectId(toBranch)) throw httpError('Invalid branch', 400);
  if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
  const amount = Number(qty);
  if (!(amount > 0) || !Number.isFinite(amount)) throw httpError('Quantity must be positive', 400);
  const context = await purchaseBranchContext({ user, branchId: fromBranch, allowInactive: true });
  const prior = await StockTransfer.findOne({ restaurant: context.restaurantId, requestKey: key }).select('+requestKey +requestHash');
  if (!prior) throw httpError('Idempotent transfer not found; retry the original request', 409);
  const normalizedUnit = clean(unit || 'g');
  // Need ingredient unit for accurate hash when unit was defaulted; fetch ingredient for validation
  const item = await Ingredient.findOne({ _id: ingredient, restaurant: context.restaurantId }).select('unit');
  const effectiveUnit = clean(unit || item?.unit || 'g');
  const payload = normalizedTransferPayload({
    fromBranch,
    toBranch,
    ingredient,
    qty: amount,
    unit: effectiveUnit,
    restaurant: context.restaurantId
  });
  const hash = fingerprint({ version: 1, ...payload });
  if (prior.requestHash !== hash) throw httpError('Idempotency key was already used for a different transfer', 409);
  return StockTransfer.findById(prior._id).populate(TRANSFER_POPULATE);
}

export async function transitionTransfer({ transferId, status, user, session, idempotencyKey }) {
  if (!mongoose.isValidObjectId(transferId)) throw httpError('Invalid transfer', 400);
  if (!status) throw httpError('Status is required', 400);
  const key = clean(idempotencyKey);
  if (key && (key.length < 3 || key.length > 200)) throw httpError('A valid Idempotency-Key is required', 400);

  const transfer = await StockTransfer.findById(transferId).session(session || null);
  if (!transfer) throw httpError('Transfer not found', 404);

  // Idempotent replay: already at target status
  if (String(transfer.status) === String(status)) {
    const populated = await StockTransfer.findById(transfer._id).populate(TRANSFER_POPULATE).session(session || null);
    if (populated) populated.$locals.idempotentReplay = true;
    return populated;
  }

  if (!canTransitionTransfer(transfer.status, status)) {
    throw httpError(`Invalid transfer transition from ${transfer.status} to ${status}`, 409);
  }

  const accessBranch = status === 'received' ? transfer.toBranch : transfer.fromBranch;
  const context = await purchaseBranchContext({ user, branchId: accessBranch, session, allowInactive: true });
  const [sourceBranch, destinationBranch, ingredient] = await Promise.all([
    Branch.exists({ _id: transfer.fromBranch, restaurant: context.restaurantId }).session(session || null),
    Branch.exists({ _id: transfer.toBranch, restaurant: context.restaurantId }).session(session || null),
    Ingredient.exists({ _id: transfer.ingredient, restaurant: context.restaurantId }).session(session || null)
  ]);
  if (!sourceBranch || !destinationBranch || !ingredient) throw httpError('Transfer references do not belong to the user restaurant', 409);

  if (status === 'in_transit') {
    const unitCost = await sourceUnitCost(transfer, session);
    await moveStock({
      branch: transfer.fromBranch,
      ingredient: transfer.ingredient,
      qty: -transfer.qty,
      unit: transfer.unit,
      unitCost,
      type: 'TRANSFER_OUT',
      reason: `Transfer ${transfer._id} in transit`,
      referenceType: 'transfer',
      referenceId: transfer._id,
      user: context.userId || user.id,
      idempotencyKey: `transfer-out:${transfer._id}`
    }, session);
  }

  if (status === 'received') {
    const outTx = await sourceMovement(transfer, session);
    if (!outTx) throw httpError('Transfer source movement is unavailable', 409);
    const unitCost = Number(outTx.unitCost || 0);
    const incomingBatches = incomingBatchesFromMovements(outTx.batchMovements, {
      sourceType: 'transfer',
      sourceId: transfer._id,
      unitCost,
      receivedAt: new Date()
    });
    await moveStock({
      branch: transfer.toBranch,
      ingredient: transfer.ingredient,
      qty: transfer.qty,
      unit: transfer.unit,
      unitCost,
      type: 'TRANSFER_IN',
      reason: `Transfer ${transfer._id} received`,
      referenceType: 'transfer',
      referenceId: transfer._id,
      user: context.userId || user.id,
      idempotencyKey: `transfer-in:${transfer._id}`,
      incomingBatches
    }, session);
  }

  const before = { status: transfer.status, approvedBy: transfer.approvedBy };
  transfer.status = status;
  if (status === 'approved') transfer.approvedBy = context.userId || user.id;
  try {
    await transfer.save({ session: session || undefined });
  } catch (error) {
    if (error?.name === 'VersionError') {
      // Concurrent modification: check if another transaction already moved to target
      const fresh = await StockTransfer.findById(transferId).session(session || null);
      if (fresh && String(fresh.status) === String(status)) {
        const populated = await StockTransfer.findById(fresh._id).populate(TRANSFER_POPULATE).session(session || null);
        if (populated) populated.$locals.idempotentReplay = true;
        return populated;
      }
      throw httpError('Transfer changed; refresh before continuing', 409);
    }
    if (error?.code === 11000) throw httpError('Transfer update conflict; retry the operation', 409);
    throw error;
  }
  await Audit.create([{
    entity: 'stock_transfer',
    entityId: transfer._id,
    action: 'transfer_status',
    before,
    after: { status: transfer.status, approvedBy: transfer.approvedBy },
    user: context.userId || user.id
  }], { session: session || undefined });

  const result = await StockTransfer.findById(transfer._id).populate(TRANSFER_POPULATE).session(session || null);
  if (result && key) result.$locals.idempotentReplay = false;
  return result;
}
