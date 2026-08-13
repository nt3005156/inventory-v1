import mongoose from 'mongoose';
import {Audit, Ingredient} from '../models/index.js';
import {Branch, InventoryBalance, InventoryTransaction, StockTransfer} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {moveStock} from './inventoryLedger.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export const TRANSFER_TRANSITIONS = {
  requested: ['approved', 'cancelled'],
  approved: ['in_transit', 'cancelled'],
  in_transit: ['received'],
  received: [],
  cancelled: []
};

export const TRANSFER_POPULATE = [
  {path: 'ingredient', select: 'name code unit'},
  {path: 'fromBranch', select: 'name code'},
  {path: 'toBranch', select: 'name code'},
  {path: 'requestedBy', select: 'name role'},
  {path: 'approvedBy', select: 'name role'}
];

export function canTransitionTransfer(from, to) {
  return (TRANSFER_TRANSITIONS[from] || []).includes(to);
}

export function transferFilter(branchId) {
  if (!branchId) return {};
  return {$or: [{fromBranch: branchId}, {toBranch: branchId}]};
}

export function resolveTransferBranch(user, branchId) {
  if (branchId) return String(branchId);
  if (user?.role !== 'owner' && user?.branch) return String(user.branch);
  return null;
}

async function sourceUnitCost(transfer, session) {
  const outTx = await InventoryTransaction.findOne({
    referenceType: 'transfer',
    referenceId: transfer._id,
    type: 'TRANSFER_OUT'
  }).session(session || null);
  if (outTx) return Number(outTx.unitCost || 0);
  const source = await InventoryBalance.findOne({
    branch: transfer.fromBranch,
    ingredient: transfer.ingredient
  }).session(session || null);
  return Number(source?.averageCost || 0);
}

export async function listTransfers({branchId, user}) {
  const branch = resolveTransferBranch(user, branchId);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
  }
  return StockTransfer.find(transferFilter(branch))
    .populate(TRANSFER_POPULATE)
    .sort({createdAt: -1});
}

export async function createTransfer({fromBranch, toBranch, ingredient, qty, unit, user}) {
  if (!mongoose.isValidObjectId(fromBranch) || !mongoose.isValidObjectId(toBranch)) {
    throw httpError('Invalid branch', 400);
  }
  if (String(fromBranch) === String(toBranch)) throw httpError('Source and destination must differ', 400);
  if (!mongoose.isValidObjectId(ingredient)) throw httpError('Invalid ingredient', 400);
  const amount = Number(qty);
  if (!(amount > 0)) throw httpError('Quantity must be positive', 400);
  assertBranchAccess(user, fromBranch);

  const [source, dest, item] = await Promise.all([
    Branch.findById(fromBranch),
    Branch.findById(toBranch),
    Ingredient.findById(ingredient)
  ]);
  if (!source || !dest) throw httpError('Branch not found', 404);
  if (!item) throw httpError('Ingredient not found', 404);

  const saved = await StockTransfer.create({
    fromBranch,
    toBranch,
    ingredient,
    qty: amount,
    unit: unit || item.unit || 'g',
    status: 'requested',
    requestedBy: user.id
  });
  return StockTransfer.findById(saved._id).populate(TRANSFER_POPULATE);
}

export async function transitionTransfer({transferId, status, user, session}) {
  if (!mongoose.isValidObjectId(transferId)) throw httpError('Invalid transfer', 400);
  if (!status) throw httpError('Status is required', 400);

  const transfer = await StockTransfer.findById(transferId).session(session || null);
  if (!transfer) throw httpError('Transfer not found', 404);
  if (!canTransitionTransfer(transfer.status, status)) {
    throw httpError(`Invalid transfer transition from ${transfer.status} to ${status}`, 409);
  }

  const accessBranch = status === 'received' ? transfer.toBranch : transfer.fromBranch;
  assertBranchAccess(user, accessBranch);

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
      user: user.id,
      idempotencyKey: `transfer-out:${transfer._id}`
    }, session);
  }

  if (status === 'received') {
    const unitCost = await sourceUnitCost(transfer, session);
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
      user: user.id,
      idempotencyKey: `transfer-in:${transfer._id}`
    }, session);
  }

  const before = {status: transfer.status, approvedBy: transfer.approvedBy};
  transfer.status = status;
  if (status === 'approved') transfer.approvedBy = user.id;
  await transfer.save({session: session || undefined});
  await Audit.create([{
    entity: 'stock_transfer',
    entityId: transfer._id,
    action: 'transfer_status',
    before,
    after: {status: transfer.status, approvedBy: transfer.approvedBy},
    user: user.id
  }], {session: session || undefined});

  return StockTransfer.findById(transfer._id).populate(TRANSFER_POPULATE).session(session || null);
}
