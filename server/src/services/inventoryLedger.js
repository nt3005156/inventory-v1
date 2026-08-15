import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Ingredient, MenuItem} from '../models/index.js';
import {InventoryBalance, InventoryTransaction, Notification, Order} from '../models/operations.js';
import {addBatchStock, removeBatchStock} from './inventoryBatches.js';

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

function movementFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

function assertIdempotentReplay(prior, hash, input) {
  const sameLegacyShape = String(prior.branch) === String(input.branch)
    && String(prior.ingredient) === String(input.ingredient)
    && Number(prior.changeQty) === Number(input.qty)
    && prior.type === input.type
    && String(prior.referenceId || '') === String(input.referenceId || '');
  if ((prior.idempotencyHash && prior.idempotencyHash !== hash) || (!prior.idempotencyHash && !sameLegacyShape)) {
    throw Object.assign(new Error('Idempotency key was already used for a different inventory movement'), {status: 409});
  }
}

/** Atomic, auditable aggregate and batch stock movement. Call inside a transaction for multi-item workflows. */
export async function moveStock({
  branch,
  ingredient,
  qty,
  type,
  reason,
  referenceType,
  referenceId,
  user,
  idempotencyKey,
  unit,
  unitCost = 0,
  incomingBatches,
  restoredMovements,
  batchId,
  batchNumber,
  allowExpired
}, session) {
  const idempotencyHash = movementFingerprint({
    branch,
    ingredient,
    qty: Number(qty),
    type,
    reason,
    referenceType,
    referenceId,
    user,
    unit,
    unitCost: Number(unitCost || 0),
    incomingBatches,
    restoredMovements,
    batchId,
    batchNumber,
    allowExpired
  });
  const transactionId = idempotencyKey
    ? new mongoose.Types.ObjectId(movementFingerprint({branch, idempotencyKey}).slice(0, 24))
    : new mongoose.Types.ObjectId();
  if (idempotencyKey) {
    const prior = await InventoryTransaction.findOne({branch, idempotencyKey}).session(session || null);
    if (prior) {
      assertIdempotentReplay(prior, idempotencyHash, {branch, ingredient, qty, type, referenceId});
      return prior;
    }
  }

  let balance = await InventoryBalance.findOne({branch, ingredient}).session(session || null);
  if (!balance) {
    if (qty < 0) throw Object.assign(new Error('Insufficient inventory'), {status: 409});
    balance = new InventoryBalance({branch, ingredient, quantity: 0, averageCost: unitCost, unit});
  }

  const before = Number(balance.quantity || 0);
  const amount = Number(qty);
  const after = before + amount;
  if (after < -1e-9) throw Object.assign(new Error('Insufficient inventory for this order'), {status: 409});

  let batchMovements;
  if (amount < 0) {
    batchMovements = await removeBatchStock({
      balance,
      branch,
      ingredient,
      quantity: Math.abs(amount),
      unit,
      batchId,
      batchNumber,
      allowExpired: allowExpired ?? ['WASTE', 'ADJUSTMENT', 'RETURN'].includes(type)
    }, session);
  } else if (amount > 0) {
    let restore = restoredMovements;
    if (type === 'RECIPE_REVERSAL' && !restore?.length && !incomingBatches?.length && referenceId) {
      const originals = await InventoryTransaction.find({
        branch,
        ingredient,
        referenceId,
        type: 'RECIPE_DEDUCTION'
      }).select('batchMovements').session(session || null);
      restore = originals.flatMap(row => (row.batchMovements || []).map(movement => ({
        batch: movement.batch,
        quantity: Math.abs(Number(movement.changeQty || 0))
      })));
      const restoreTotal = restore.reduce((sum, row) => sum + row.quantity, 0);
      if (Math.abs(restoreTotal - amount) > 1e-9) {
        throw Object.assign(new Error('Original batch allocation is unavailable for reversal'), {status: 409});
      }
    }
    batchMovements = await addBatchStock({
      balance,
      branch,
      ingredient,
      quantity: amount,
      unit,
      unitCost,
      incomingBatches,
      restoredMovements: restore,
      sourceType: referenceType === 'goods_receipt'
        ? 'goods_receipt'
        : type === 'TRANSFER_IN'
          ? 'transfer'
          : type === 'RECIPE_REVERSAL'
            ? 'reversal'
            : type === 'OPENING'
              ? 'opening'
              : type === 'ADJUSTMENT'
                ? 'adjustment'
                : 'untracked',
      sourceId: referenceId || transactionId,
      receivedAt: new Date()
    }, session);
  }

  if (amount > 0 && unitCost) balance.averageCost = after
    ? ((before * Number(balance.averageCost || 0)) + (amount * unitCost)) / after
    : unitCost;
  balance.quantity = Math.max(0, after);
  await balance.save({session: session || undefined});

  const effectiveUnitCost = Number(unitCost || balance.averageCost || 0);
  const tx = (await InventoryTransaction.create([{
    _id: transactionId,
    branch,
    ingredient,
    type,
    previousQty: before,
    changeQty: amount,
    newQty: Math.max(0, after),
    unit,
    unitCost: effectiveUnitCost,
    totalCost: Math.abs(amount) * effectiveUnitCost,
    reason,
    referenceType,
    referenceId,
    user,
    batchMovements,
    idempotencyKey,
    idempotencyHash
  }], {session: session || undefined}))[0];

  if (after <= Number(balance.reorderLevel || 0)) {
    const ing = await Ingredient.findById(ingredient).session(session || null);
    const name = ing?.name || 'Ingredient';
    await Notification.create([{
      branch,
      type: after <= 0 ? 'out_of_stock' : 'low_stock',
      title: after <= 0 ? 'Out of stock' : 'Low stock',
      body: `${name} is ${after <= 0 ? 'out of stock' : 'at reorder level'}`,
      referenceId: ingredient
    }], {session: session || undefined});
  }
  return tx;
}

async function orderRequirements(order, restaurantId, session) {
  const requirements = new Map();
  for (const line of order.items || []) {
    let rows = line.inventoryRequirements || [];
    if (!rows.length) {
      const menuItem = await MenuItem.findById(line.menuItem).populate('recipe.ingredient').session(session || null);
      if (!menuItem) throw Object.assign(new Error('Original order recipe is unavailable for reversal'), {status: 409});
      rows = menuItem.recipe || [];
    }
    for (const row of rows) {
      const ingredient = row.ingredient?._id || row.ingredient;
      if (!ingredient) throw Object.assign(new Error('Original order recipe is incomplete'), {status: 409});
      const key = String(ingredient);
      const current = requirements.get(key) || {ingredient, quantity: 0, unit: row.unit};
      current.quantity += Number(row.qty || 0) * Number(line.qty || 0);
      requirements.set(key, current);
    }
  }
  const ids = [...requirements.values()].map(row => row.ingredient);
  const valid = ids.length ? await Ingredient.countDocuments({_id: {$in: ids}, restaurant: restaurantId}).session(session || null) : 0;
  if (valid !== ids.length) throw Object.assign(new Error('Order inventory allocation does not belong to this restaurant'), {status: 409});
  return requirements;
}

function originalBatchAvailability(originals, reversals) {
  const batches = new Map();
  for (const transaction of originals) {
    for (const movement of transaction.batchMovements || []) {
      const key = String(movement.batch);
      const current = batches.get(key) || {batch: movement.batch, quantity: 0};
      current.quantity += Math.abs(Number(movement.changeQty || 0));
      batches.set(key, current);
    }
  }
  for (const transaction of reversals) {
    for (const movement of transaction.batchMovements || []) {
      const current = batches.get(String(movement.batch));
      if (current) current.quantity -= Math.max(0, Number(movement.changeQty || 0));
    }
  }
  return [...batches.values()].map(row => ({...row, quantity: Math.max(0, row.quantity)}));
}

/** Reverse the immutable allocation recorded for an order, including split and merged checks. */
export async function reverseOrderStock({order, status, user, restaurantId}, session) {
  const sourceOrders = order.inventorySourceOrders?.length
    ? order.inventorySourceOrders
    : [order.inventorySourceOrder || order._id];
  const requirements = await orderRequirements(order, restaurantId, session);
  if (!requirements.size) return [];
  const relatedOrders = await Order.find({
    $or: [
      {_id: {$in: sourceOrders}},
      {inventorySourceOrder: {$in: sourceOrders}},
      {inventorySourceOrders: {$in: sourceOrders}}
    ]
  }).select('_id').session(session || null);
  const relatedIds = relatedOrders.map(row => row._id);
  const [originals, reversals] = await Promise.all([
    InventoryTransaction.find({branch: order.branch, referenceId: {$in: sourceOrders}, type: 'RECIPE_DEDUCTION'}).sort({createdAt: 1, _id: 1}).session(session || null),
    InventoryTransaction.find({branch: order.branch, referenceId: {$in: relatedIds}, type: 'RECIPE_REVERSAL'}).session(session || null)
  ]);
  if (!originals.length) {
    const legacyResults = [];
    for (const requirement of requirements.values()) {
      legacyResults.push(await moveStock({
        branch: order.branch,
        ingredient: requirement.ingredient,
        qty: requirement.quantity,
        unit: requirement.unit,
        type: 'RECIPE_REVERSAL',
        reason: `${status} ${order.orderNo} (legacy allocation)`,
        referenceType: 'order_reversal',
        referenceId: order._id,
        user,
        idempotencyKey: `reverse:${order._id}:${requirement.ingredient}`,
        incomingBatches: [{quantity: requirement.quantity, sourceType: 'reversal', sourceId: order._id}]
      }, session));
    }
    return legacyResults;
  }

  const results = [];
  for (const requirement of requirements.values()) {
    const matchingOriginals = originals.filter(row => String(row.ingredient) === String(requirement.ingredient));
    const matchingReversals = reversals.filter(row => String(row.ingredient) === String(requirement.ingredient));
    const originalTotal = matchingOriginals.reduce((sum, row) => sum + Math.abs(Number(row.changeQty || 0)), 0);
    const reversedTotal = matchingReversals.reduce((sum, row) => sum + Math.max(0, Number(row.changeQty || 0)), 0);
    if (!(requirement.quantity > 0) || reversedTotal + requirement.quantity > originalTotal + 1e-9) {
      throw Object.assign(new Error('Order reversal exceeds its original inventory allocation'), {status: 409});
    }

    const availableBatches = originalBatchAvailability(matchingOriginals, matchingReversals);
    const documentedTotal = availableBatches.reduce((sum, row) => sum + row.quantity, 0);
    let restoredMovements;
    let incomingBatches;
    if (documentedTotal > 1e-9) {
      if (documentedTotal + 1e-9 < requirement.quantity) {
        throw Object.assign(new Error('Original batch allocation is incomplete for reversal'), {status: 409});
      }
      let remaining = requirement.quantity;
      restoredMovements = [];
      for (const row of availableBatches) {
        if (!(remaining > 1e-9)) break;
        const quantity = Math.min(row.quantity, remaining);
        if (quantity > 1e-9) restoredMovements.push({batch: row.batch, quantity});
        remaining -= quantity;
      }
    } else {
      incomingBatches = [{
        quantity: requirement.quantity,
        sourceType: 'reversal',
        sourceId: order._id
      }];
    }

    results.push(await moveStock({
      branch: order.branch,
      ingredient: requirement.ingredient,
      qty: requirement.quantity,
      unit: requirement.unit,
      type: 'RECIPE_REVERSAL',
      reason: `${status} ${order.orderNo}`,
      referenceType: 'order_reversal',
      referenceId: order._id,
      user,
      idempotencyKey: `reverse:${order._id}:${requirement.ingredient}`,
      restoredMovements,
      incomingBatches
    }, session));
  }
  return results;
}
