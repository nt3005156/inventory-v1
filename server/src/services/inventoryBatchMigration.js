import mongoose from 'mongoose';
import {Ingredient} from '../models/index.js';
import {Branch, InventoryBalance, InventoryBatch, InventoryTransaction, Order} from '../models/operations.js';

const BATCH_INDEXES = [
  {
    key: {restaurant: 1, branch: 1, ingredient: 1, lotKey: 1},
    options: {unique: true, name: 'inventory_batch_lot_key'}
  },
  {
    key: {restaurant: 1, branch: 1, expiryDate: 1, quantity: 1},
    options: {name: 'inventory_batch_expiry_quantity'}
  },
  {
    key: {restaurant: 1, branch: 1, ingredient: 1, batchNumberNormalized: 1, quantity: 1},
    options: {name: 'inventory_batch_lookup'}
  }
];

async function ensureCollection(name) {
  const db = mongoose.connection.db;
  if (!db) return;
  const exists = await db.listCollections({name}, {nameOnly: true}).hasNext();
  if (exists) return;
  try {
    await db.createCollection(name);
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error;
  }
}

async function backfillCurrentBalances() {
  const balances = await InventoryBalance.collection.find(
    {quantity: {$gte: 0}},
    {projection: {_id: 1, branch: 1, ingredient: 1, quantity: 1, averageCost: 1, batchNumber: 1, expiryDate: 1, createdAt: 1}}
  ).toArray();
  if (!balances.length) {
    const removed = await InventoryBalance.collection.updateMany(
      {$or: [{batchNumber: {$exists: true}}, {expiryDate: {$exists: true}}]},
      {$unset: {batchNumber: '', expiryDate: ''}}
    );
    return {backfilled: 0, unresolved: 0, singletonFieldsRemoved: removed.modifiedCount};
  }

  const branchIds = [...new Set(balances.map(row => String(row.branch || '')).filter(Boolean))];
  const ingredientIds = [...new Set(balances.map(row => String(row.ingredient || '')).filter(Boolean))];
  const [branches, ingredients, tracked] = await Promise.all([
    Branch.find({_id: {$in: branchIds}}).select('_id restaurant').lean(),
    Ingredient.find({_id: {$in: ingredientIds}}).select('_id unit').lean(),
    InventoryBatch.aggregate([
      {$match: {branch: {$in: branchIds.map(id => new mongoose.Types.ObjectId(id))}}},
      {$group: {_id: {branch: '$branch', ingredient: '$ingredient'}, quantity: {$sum: '$quantity'}}}
    ])
  ]);
  const restaurantByBranch = new Map(branches.map(branch => [String(branch._id), branch.restaurant]));
  const unitByIngredient = new Map(ingredients.map(item => [String(item._id), item.unit || 'g']));
  const trackedByBalance = new Map(tracked.map(row => [`${row._id.branch}:${row._id.ingredient}`, Number(row.quantity || 0)]));

  let backfilled = 0;
  let unresolved = 0;
  for (const balance of balances) {
    const restaurant = restaurantByBranch.get(String(balance.branch));
    if (!restaurant || !balance.ingredient) {
      unresolved += 1;
      continue;
    }
    const lotKey = `legacy:${balance._id}`;
    const existingLegacy = await InventoryBatch.findOne({
      restaurant,
      branch: balance.branch,
      ingredient: balance.ingredient,
      lotKey
    });
    const trackedQty = trackedByBalance.get(`${balance.branch}:${balance.ingredient}`) || 0;
    const legacyQty = Number(existingLegacy?.quantity || 0);
    const nonLegacyQty = trackedQty - legacyQty;
    const aggregateQty = Number(balance.quantity || 0);
    if (nonLegacyQty > aggregateQty + 1e-9) {
      throw new Error(`Batch migration cannot reconcile balance ${balance._id}: durable non-legacy lots exceed aggregate stock`);
    }
    const desiredLegacyQty = Math.max(0, aggregateQty - nonLegacyQty);
    if (Math.abs(legacyQty - desiredLegacyQty) <= 1e-9) continue;

    if (existingLegacy) {
      existingLegacy.quantity = desiredLegacyQty;
      existingLegacy.initialQuantity = Math.max(Number(existingLegacy.initialQuantity || 0), desiredLegacyQty);
      await existingLegacy.save();
      backfilled += 1;
      continue;
    }
    if (!(desiredLegacyQty > 1e-9)) continue;
    await InventoryBatch.create({
      restaurant,
      branch: balance.branch,
      ingredient: balance.ingredient,
      lotKey,
      receivedAt: balance.createdAt || new Date(),
      sourceType: 'legacy',
      unit: unitByIngredient.get(String(balance.ingredient)) || 'g',
      unitCost: Number(balance.averageCost || 0),
      initialQuantity: desiredLegacyQty,
      quantity: desiredLegacyQty
    });
    backfilled += 1;
  }

  const removed = await InventoryBalance.collection.updateMany(
    {$or: [{batchNumber: {$exists: true}}, {expiryDate: {$exists: true}}]},
    {$unset: {batchNumber: '', expiryDate: ''}}
  );
  return {backfilled, unresolved, singletonFieldsRemoved: removed.modifiedCount};
}

async function ensureInventoryTransactionIndexes() {
  await ensureCollection(InventoryTransaction.collection.collectionName);
  const indexes = await InventoryTransaction.collection.indexes();
  const obsolete = indexes.filter(index => {
    const keys = Object.keys(index.key || {});
    return keys.length === 1 && keys[0] === 'idempotencyKey';
  });
  for (const index of obsolete) await InventoryTransaction.collection.dropIndex(index.name);
  const idempotencyIndex = await InventoryTransaction.collection.createIndex(
    {branch: 1, idempotencyKey: 1},
    {
      unique: true,
      partialFilterExpression: {idempotencyKey: {$type: 'string'}},
      name: 'inventory_transaction_branch_idempotency'
    }
  );
  const purchasingReportIndex = await InventoryTransaction.collection.createIndex(
    {branch: 1, type: 1, referenceType: 1, createdAt: -1},
    {name: 'inventory_transaction_purchasing_report'}
  );
  return [idempotencyIndex, purchasingReportIndex];
}

export async function ensureInventoryBatchIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(InventoryBatch.collection.collectionName);
  const backfill = await backfillCurrentBalances();
  for (const index of BATCH_INDEXES) await InventoryBatch.collection.createIndex(index.key, index.options);
  const transactionIndexes = await ensureInventoryTransactionIndexes();
  await ensureCollection(Order.collection.collectionName);
  const orderSourceIndex = await Order.collection.createIndex(
    {inventorySourceOrders: 1},
    {name: 'order_inventory_source_orders'}
  );
  return {...backfill, indexes: [...BATCH_INDEXES.map(index => index.options.name), ...transactionIndexes, orderSourceIndex]};
}
