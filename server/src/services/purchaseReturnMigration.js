import mongoose from 'mongoose';
import {InventoryBatch, InventoryTransaction, PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt, PurchaseReturn, PurchaseReturnCounter} from '../models/purchasing.js';
import {purchaseReturnRequestFingerprint} from './returns.js';

const RETURN_INDEXES = [
  {
    key: {restaurant: 1, returnNo: 1},
    options: {unique: true, name: 'pr_restaurant_number_v2', partialFilterExpression: {numberVersion: 2}}
  },
  {
    key: {restaurant: 1, idempotencyKey: 1},
    options: {unique: true, name: 'pr_restaurant_idempotency_key', partialFilterExpression: {idempotencyKey: {$type: 'string'}}}
  },
  {
    key: {restaurant: 1, branch: 1, purchaseOrder: 1, createdAt: -1},
    options: {name: 'pr_restaurant_branch_po_created'}
  },
  {
    key: {restaurant: 1, branch: 1, supplier: 1, createdAt: -1},
    options: {name: 'pr_restaurant_branch_supplier_created'}
  },
  {
    key: {restaurant: 1, branch: 1, returnedAt: -1},
    options: {name: 'pr_restaurant_branch_returned_at'}
  }
];

const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

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

function migratedLine({oldItem, poLine, qty, batch, goodsReceipt, inventoryUnitCost}) {
  const supplierUnitCost = Number(poLine?.unitPrice ?? oldItem.unitCost ?? 0);
  const stockCost = Number(inventoryUnitCost ?? batch?.unitCost ?? supplierUnitCost);
  const vatRate = Number(poLine?.vatRate ?? 13);
  const subtotal = money(qty * supplierUnitCost);
  const vat = money(subtotal * vatRate / 100);
  const exactReceiptBatch = Boolean(goodsReceipt?._id);
  return {
    _id: new mongoose.Types.ObjectId(),
    poItem: oldItem.poItem || poLine?._id,
    ingredient: oldItem.ingredient || poLine?.ingredient,
    ...(exactReceiptBatch ? {goodsReceipt: goodsReceipt._id} : {}),
    ...(batch?._id ? {inventoryBatch: batch._id} : {}),
    allocationSource: exactReceiptBatch ? 'receipt_batch' : 'legacy_allocation',
    qty,
    unit: poLine?.unit || oldItem.unit || batch?.unit || 'unit',
    unitCost: supplierUnitCost,
    inventoryUnitCost: stockCost,
    stockValue: money(qty * stockCost),
    vatRate,
    subtotal,
    vat,
    total: money(subtotal + vat),
    ...(batch?.batchNumber || oldItem.batchNumber ? {batchNumber: batch?.batchNumber || oldItem.batchNumber} : {}),
    ...(batch?.expiryDate ? {expiryDate: batch.expiryDate} : {})
  };
}

function exactSourceReceipt({batch, receiptById, purchaseOrder, poLine, oldItem}) {
  if (batch?.sourceType !== 'goods_receipt' || !batch.sourceId || !purchaseOrder || !poLine) return null;
  const receipt = receiptById.get(String(batch.sourceId));
  if (!receipt || String(receipt.purchaseOrder) !== String(purchaseOrder._id)) return null;
  if (String(batch.restaurant || '') !== String(purchaseOrder.restaurant || '')
    || String(batch.branch || '') !== String(purchaseOrder.branch || '')) return null;
  if (receipt.restaurant && String(receipt.restaurant) !== String(purchaseOrder.restaurant)) return null;
  if (receipt.branch && String(receipt.branch) !== String(purchaseOrder.branch)) return null;
  if (oldItem.ingredient && String(oldItem.ingredient) !== String(poLine.ingredient)) return null;
  if (String(batch.ingredient || '') !== String(poLine.ingredient || '')) return null;
  if (batch.unit && poLine.unit && String(batch.unit).trim().toLowerCase() !== String(poLine.unit).trim().toLowerCase()) return null;
  if (batch.sourceLine && String(batch.sourceLine) !== String(poLine._id)) return null;
  const matchingReceiptLine = (receipt.items || []).some(item =>
    String(item.poItem) === String(poLine._id)
    && String(item.ingredient) === String(poLine.ingredient)
  );
  return matchingReceiptLine ? receipt : null;
}

async function backfillPurchaseReturns() {
  const rows = await PurchaseReturn.collection.find({
    $or: [
      {restaurant: {$exists: false}},
      {branch: {$exists: false}},
      {supplier: {$exists: false}},
      {returnedAt: {$exists: false}},
      {returnedBy: {$exists: false}},
      {status: {$exists: false}},
      {subtotal: {$exists: false}},
      {vat: {$exists: false}},
      {total: {$exists: false}},
      {numberVersion: {$exists: false}},
      {requestHashVersion: {$ne: 2}},
      {'items': {$elemMatch: {allocationSource: {$exists: false}}}}
    ]
  }).toArray();
  if (!rows.length) return {migrated: 0, unresolved: 0};

  const poIds = [...new Set(rows.map(row => String(row.purchaseOrder || '')).filter(Boolean))];
  const purchaseOrders = await PurchaseOrder.find({_id: {$in: poIds}})
    .select('_id restaurant branch supplier createdBy updatedBy items')
    .lean();
  const poById = new Map(purchaseOrders.map(po => [String(po._id), po]));
  const returnIds = rows.map(row => row._id);
  const transactions = await InventoryTransaction.find({
    type: 'RETURN',
    referenceType: 'purchase_return',
    referenceId: {$in: returnIds}
  }).select('referenceId ingredient changeQty unitCost batchMovements').lean();
  const transactionsByReturn = new Map();
  const batchIds = new Set();
  for (const transaction of transactions) {
    const key = String(transaction.referenceId);
    if (!transactionsByReturn.has(key)) transactionsByReturn.set(key, []);
    transactionsByReturn.get(key).push(transaction);
    for (const movement of transaction.batchMovements || []) {
      if (movement.batch) batchIds.add(String(movement.batch));
    }
  }
  const batches = await InventoryBatch.find({_id: {$in: [...batchIds]}}).lean();
  const batchById = new Map(batches.map(batch => [String(batch._id), batch]));
  const sourceReceiptIds = [...new Set(batches
    .filter(batch => batch.sourceType === 'goods_receipt' && batch.sourceId)
    .map(batch => String(batch.sourceId)))];
  const sourceReceipts = sourceReceiptIds.length
    ? await GoodsReceipt.find({_id: {$in: sourceReceiptIds}})
      .select('_id restaurant branch purchaseOrder items.poItem items.ingredient')
      .lean()
    : [];
  const receiptById = new Map(sourceReceipts.map(receipt => [String(receipt._id), receipt]));

  const operations = [];
  let unresolved = 0;
  for (const row of rows) {
    const po = poById.get(String(row.purchaseOrder));
    const originalItems = row.items || [];
    const txRows = transactionsByReturn.get(String(row._id)) || [];
    const migratedItems = [];
    for (const oldItem of originalItems) {
      const poLine = (po?.items || []).find(line => String(line._id) === String(oldItem.poItem));
      const transaction = txRows.find(tx => String(tx.ingredient) === String(oldItem.ingredient || poLine?.ingredient));
      let remaining = Number(oldItem.qty || 0);
      const movements = transaction?.batchMovements || [];
      for (const movement of movements) {
        if (!(remaining > 0)) break;
        const movementQty = Math.abs(Number(movement.changeQty || 0));
        if (!(movementQty > 0)) continue;
        const qty = Math.min(remaining, movementQty);
        const batch = batchById.get(String(movement.batch));
        const goodsReceipt = exactSourceReceipt({batch, receiptById, purchaseOrder: po, poLine, oldItem});
        migratedItems.push(migratedLine({
          oldItem,
          poLine,
          qty,
          batch,
          goodsReceipt,
          inventoryUnitCost: movement.unitCost ?? transaction.unitCost
        }));
        remaining -= qty;
      }
      if (remaining > 1e-9 || !movements.length) {
        const qty = movements.length ? remaining : Number(oldItem.qty || 0);
        if (qty > 0) migratedItems.push(migratedLine({oldItem, poLine, qty, inventoryUnitCost: transaction?.unitCost}));
      }
    }

    const subtotal = money(migratedItems.reduce((sum, item) => sum + item.subtotal, 0));
    const vat = money(migratedItems.reduce((sum, item) => sum + item.vat, 0));
    const set = {
      items: migratedItems,
      returnedAt: row.returnedAt || row.createdAt || new Date(),
      status: row.status || 'posted',
      subtotal,
      vat,
      total: money(subtotal + vat),
      numberVersion: row.numberVersion ?? 1,
      requestHashVersion: 2,
      requestHash: purchaseReturnRequestFingerprint({
        poId: row.purchaseOrder,
        reason: row.reason,
        notes: row.notes,
        items: originalItems.map(item => ({
          itemId: item.poItem,
          qty: item.qty,
          batchNumber: item.batchNumber
        }))
      })
    };
    if (!row.restaurant && po?.restaurant) set.restaurant = po.restaurant;
    if (!row.branch && po?.branch) set.branch = po.branch;
    if (!row.supplier && po?.supplier) set.supplier = po.supplier;
    if (!row.returnedBy && (po?.updatedBy || po?.createdBy)) set.returnedBy = po.updatedBy || po.createdBy;
    if (!po || !set.restaurant && !row.restaurant || !set.branch && !row.branch || !set.returnedBy && !row.returnedBy) unresolved += 1;
    operations.push({updateOne: {filter: {_id: row._id}, update: {$set: set}}});
  }
  if (operations.length) await PurchaseReturn.collection.bulkWrite(operations, {ordered: false});
  return {migrated: operations.length, unresolved};
}

async function dropLegacyIndexes() {
  const indexes = await PurchaseReturn.collection.indexes();
  const obsoleteNames = new Set(['returnNo_1', 'purchaseOrder_1', 'branch_1']);
  const legacy = indexes.filter(index =>
    (index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1)
    || obsoleteNames.has(index.name)
  );
  for (const index of legacy) await PurchaseReturn.collection.dropIndex(index.name);
  return legacy.map(index => index.name);
}

async function repairReturnIndexes() {
  const existing = await PurchaseReturn.collection.indexes();
  const repaired = [];
  for (const specification of RETURN_INDEXES) {
    const current = existing.find(index => index.name === specification.options.name);
    if (!current) continue;
    const sameKey = JSON.stringify(current.key) === JSON.stringify(specification.key);
    const sameUnique = Boolean(current.unique) === Boolean(specification.options.unique);
    const samePartial = JSON.stringify(current.partialFilterExpression || null)
      === JSON.stringify(specification.options.partialFilterExpression || null);
    if (sameKey && sameUnique && samePartial) continue;
    await PurchaseReturn.collection.dropIndex(current.name);
    repaired.push(current.name);
  }
  return repaired;
}

async function alignReturnCounters() {
  const rows = await PurchaseReturn.collection.find({
    restaurant: {$type: 'objectId'},
    returnNo: {$regex: /^PR-[A-Z0-9]{1,8}-\d{4}-\d{6}$/}
  }, {projection: {restaurant: 1, branch: 1, returnNo: 1}}).toArray();
  let aligned = 0;
  for (const row of rows) {
    const match = /^PR-([A-Z0-9]{1,8})-(\d{4})-(\d{6})$/.exec(row.returnNo);
    if (!match || !row.branch) continue;
    const [, branchCode, year, sequence] = match;
    const result = await PurchaseReturnCounter.updateOne(
      {restaurant: row.restaurant, branchCode, year: Number(year)},
      {
        $max: {value: Number(sequence)},
        $setOnInsert: {restaurant: row.restaurant, branch: row.branch, branchCode, year: Number(year)}
      },
      {upsert: true, setDefaultsOnInsert: true}
    );
    if (result.upsertedCount || result.modifiedCount) aligned += 1;
  }
  return aligned;
}

export async function ensurePurchaseReturnIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(PurchaseReturn.collection.collectionName);
  await ensureCollection(PurchaseReturnCounter.collection.collectionName);
  const backfill = await backfillPurchaseReturns();
  const droppedIndexes = await dropLegacyIndexes();
  const repairedIndexes = await repairReturnIndexes();
  const countersAligned = await alignReturnCounters();
  for (const index of RETURN_INDEXES) await PurchaseReturn.collection.createIndex(index.key, index.options);
  const currentCounterIndex = (await PurchaseReturnCounter.collection.indexes()).find(index => index.name === 'pr_counter_scope');
  if (currentCounterIndex && (
    currentCounterIndex.key?.restaurant !== 1
    || currentCounterIndex.key?.branchCode !== 1
    || currentCounterIndex.key?.year !== 1
    || Object.hasOwn(currentCounterIndex.key, 'branch')
    || currentCounterIndex.unique !== true
  )) {
    await PurchaseReturnCounter.collection.dropIndex('pr_counter_scope');
  }
  await PurchaseReturnCounter.collection.createIndex(
    {restaurant: 1, branchCode: 1, year: 1},
    {unique: true, name: 'pr_counter_scope'}
  );
  return {
    ...backfill,
    droppedIndexes,
    repairedIndexes,
    countersAligned,
    returnIndexes: RETURN_INDEXES.map(index => index.options.name),
    counterIndex: 'pr_counter_scope'
  };
}
