import mongoose from 'mongoose';
import {Branch, PurchaseOrder} from '../models/operations.js';
import {GoodsReceipt, GoodsReceiptCounter} from '../models/purchasing.js';
import {receiptRequestFingerprint} from './receiving.js';

const RECEIPT_INDEXES = [
  {
    key: {restaurant: 1, receiptNo: 1},
    options: {unique: true, name: 'gr_restaurant_number_v2', partialFilterExpression: {numberVersion: 2}}
  },
  {
    key: {restaurant: 1, idempotencyKey: 1},
    options: {unique: true, name: 'gr_restaurant_idempotency_key', partialFilterExpression: {idempotencyKey: {$type: 'string'}}}
  },
  {
    key: {restaurant: 1, branch: 1, purchaseOrder: 1, createdAt: -1},
    options: {name: 'gr_restaurant_branch_po_created'}
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

async function backfillGoodsReceipts() {
  const rows = await GoodsReceipt.collection.find({
    $or: [
      {restaurant: {$exists: false}},
      {branch: {$exists: false}},
      {supplier: {$exists: false}},
      {receivedAt: {$exists: false}},
      {receivedBy: {$exists: false}},
      {receivedValue: {$exists: false}},
      {acceptedValue: {$exists: false}},
      {damagedValue: {$exists: false}},
      {numberVersion: {$exists: false}},
      {$and: [{idempotencyKey: {$type: 'string'}}, {requestHash: {$exists: false}}]}
    ]
  }, {projection: {
    _id: 1, restaurant: 1, branch: 1, supplier: 1, purchaseOrder: 1, receivedBy: 1,
    receivedAt: 1, createdAt: 1, receivedValue: 1, acceptedValue: 1, damagedValue: 1,
    numberVersion: 1, idempotencyKey: 1, requestHash: 1, notes: 1, items: 1
  }}).toArray();
  if (!rows.length) return {migrated: 0, unresolved: 0};

  const poIds = [...new Set(rows.map(row => String(row.purchaseOrder || '')).filter(Boolean))];
  const purchaseOrders = await PurchaseOrder.find({_id: {$in: poIds}})
    .select('_id restaurant branch supplier createdBy updatedBy')
    .lean();
  const poById = new Map(purchaseOrders.map(po => [String(po._id), po]));
  const branchIds = [...new Set(rows.map(row => String(row.branch || poById.get(String(row.purchaseOrder))?.branch || '')).filter(Boolean))];
  const branches = await Branch.find({_id: {$in: branchIds}}).select('_id restaurant').lean();
  const restaurantByBranch = new Map(branches.map(branch => [String(branch._id), branch.restaurant]));

  const operations = [];
  let unresolved = 0;
  for (const row of rows) {
    const po = poById.get(String(row.purchaseOrder));
    const branch = row.branch || po?.branch;
    const restaurant = row.restaurant || po?.restaurant || restaurantByBranch.get(String(branch));
    const set = {};
    if (!row.restaurant && restaurant) set.restaurant = restaurant;
    if (!row.branch && branch) set.branch = branch;
    if (!row.supplier && po?.supplier) set.supplier = po.supplier;
    if (!row.receivedBy && (po?.updatedBy || po?.createdBy)) set.receivedBy = po.updatedBy || po.createdBy;
    if (!row.receivedAt) set.receivedAt = row.createdAt || new Date();
    if (row.numberVersion === undefined) set.numberVersion = 1;
    if (row.receivedValue === undefined) {
      set.receivedValue = money((row.items || []).reduce((sum, item) => sum + Number(item.receivedQty || 0) * Number(item.unitPrice || 0), 0));
    }
    if (row.acceptedValue === undefined) {
      set.acceptedValue = money((row.items || []).reduce((sum, item) => sum + Number(item.acceptedQty || 0) * Number(item.unitPrice || 0), 0));
    }
    if (row.damagedValue === undefined) {
      set.damagedValue = money((row.items || []).reduce((sum, item) => sum + Number(item.damagedQty || 0) * Number(item.unitPrice || 0), 0));
    }
    if (!row.requestHash && typeof row.idempotencyKey === 'string' && row.idempotencyKey.trim() && row.purchaseOrder) {
      set.requestHash = receiptRequestFingerprint({
        poId: row.purchaseOrder,
        notes: row.notes,
        items: (row.items || []).map(item => ({
          itemId: item.poItem,
          receivedQty: item.receivedQty,
          damagedQty: item.damagedQty,
          batchNumber: item.batchNumber,
          expiryDate: item.expiryDate
        }))
      });
    }
    if (!restaurant || !branch) unresolved += 1;
    if (Object.keys(set).length) operations.push({updateOne: {filter: {_id: row._id}, update: {$set: set}}});
  }
  if (operations.length) await GoodsReceipt.collection.bulkWrite(operations, {ordered: false});
  return {migrated: operations.length, unresolved};
}

async function dropLegacyIdempotencyIndexes() {
  const indexes = await GoodsReceipt.collection.indexes();
  const legacy = indexes.filter(index => index.unique && index.key?.idempotencyKey === 1 && Object.keys(index.key).length === 1);
  for (const index of legacy) await GoodsReceipt.collection.dropIndex(index.name);
  return legacy.map(index => index.name);
}

async function alignReceiptCounters() {
  const rows = await GoodsReceipt.collection.find({
    restaurant: {$type: 'objectId'},
    receiptNo: {$regex: /^GR-[A-Z0-9]{1,8}-\d{4}-\d{6}$/}
  }, {projection: {restaurant: 1, branch: 1, receiptNo: 1}}).toArray();
  let aligned = 0;
  for (const row of rows) {
    const match = /^GR-([A-Z0-9]{1,8})-(\d{4})-(\d{6})$/.exec(row.receiptNo);
    if (!match || !row.branch) continue;
    const [, branchCode, year, sequence] = match;
    const result = await GoodsReceiptCounter.updateOne(
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

export async function ensureGoodsReceivingIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(GoodsReceipt.collection.collectionName);
  await ensureCollection(GoodsReceiptCounter.collection.collectionName);
  const backfill = await backfillGoodsReceipts();
  const droppedIndexes = await dropLegacyIdempotencyIndexes();
  const countersAligned = await alignReceiptCounters();
  for (const index of RECEIPT_INDEXES) {
    await GoodsReceipt.collection.createIndex(index.key, index.options);
  }
  const currentCounterIndex = (await GoodsReceiptCounter.collection.indexes()).find(index => index.name === 'gr_counter_scope');
  if (currentCounterIndex && (
    currentCounterIndex.key?.restaurant !== 1
    || currentCounterIndex.key?.branchCode !== 1
    || currentCounterIndex.key?.year !== 1
    || Object.hasOwn(currentCounterIndex.key, 'branch')
  )) {
    await GoodsReceiptCounter.collection.dropIndex('gr_counter_scope');
  }
  await GoodsReceiptCounter.collection.createIndex(
    {restaurant: 1, branchCode: 1, year: 1},
    {unique: true, name: 'gr_counter_scope'}
  );
  return {
    ...backfill,
    droppedIndexes,
    countersAligned,
    receiptIndexes: RECEIPT_INDEXES.map(index => index.options.name),
    counterIndex: 'gr_counter_scope'
  };
}
