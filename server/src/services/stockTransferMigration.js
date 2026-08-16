import mongoose from 'mongoose';
import { Branch } from '../models/operations.js';
import { StockTransfer } from '../models/operations.js';

const STOCK_TRANSFER_INDEXES = [
  {
    key: { restaurant: 1, requestKey: 1 },
    options: { unique: true, name: 'stock_transfer_restaurant_request', partialFilterExpression: { requestKey: { $type: 'string' } } }
  },
  {
    key: { restaurant: 1, fromBranch: 1, status: 1, createdAt: -1 },
    options: { name: 'stock_transfer_from_status' }
  },
  {
    key: { restaurant: 1, toBranch: 1, status: 1, createdAt: -1 },
    options: { name: 'stock_transfer_to_status' }
  }
];

async function ensureCollection(name) {
  const db = mongoose.connection.db;
  if (!db) return;
  const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext();
  if (exists) return;
  try {
    await db.createCollection(name);
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error;
  }
}

async function backfillStockTransfers() {
  const rows = await StockTransfer.collection.find(
    { restaurant: { $exists: false } },
    { projection: { _id: 1, fromBranch: 1 } }
  ).toArray();
  if (!rows.length) return 0;
  const branchIds = [...new Set(rows.map(row => String(row.fromBranch || '')).filter(Boolean))];
  const branches = branchIds.length
    ? await Branch.find({ _id: { $in: branchIds } }).select('_id restaurant').lean()
    : [];
  const restaurantByBranch = new Map(branches.map(b => [String(b._id), b.restaurant]));
  const operations = [];
  for (const row of rows) {
    const restaurant = restaurantByBranch.get(String(row.fromBranch));
    if (!restaurant) continue;
    operations.push({ updateOne: { filter: { _id: row._id }, update: { $set: { restaurant } } } });
  }
  if (operations.length) await StockTransfer.collection.bulkWrite(operations, { ordered: false });
  return operations.length;
}

export async function ensureStockTransferIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(StockTransfer.collection.collectionName);
  const migrated = await backfillStockTransfers();
  for (const index of STOCK_TRANSFER_INDEXES) {
    await StockTransfer.collection.createIndex(index.key, index.options);
  }
  return { migrated, stockTransferIndexes: STOCK_TRANSFER_INDEXES.map(i => i.options.name) };
}
