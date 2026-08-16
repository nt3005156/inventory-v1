import mongoose from 'mongoose';
import {StockCount} from '../models/operations.js';

const STOCK_COUNT_INDEXES = [
  {
    key: {restaurant: 1, countNo: 1},
    options: {unique: true, name: 'stock_count_restaurant_number'}
  },
  {
    key: {restaurant: 1, branch: 1, requestKey: 1},
    options: {unique: true, name: 'stock_count_request_key'}
  },
  {
    key: {restaurant: 1, activeKey: 1},
    options: {
      unique: true,
      name: 'stock_count_active_branch',
      partialFilterExpression: {activeKey: {$type: 'string'}}
    }
  },
  {
    key: {restaurant: 1, branch: 1, status: 1, createdAt: -1},
    options: {name: 'stock_count_branch_status_created'}
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

export async function ensureStockCountIndexes() {
  if (!mongoose.connection.db) return;
  await ensureCollection(StockCount.collection.collectionName);
  for (const index of STOCK_COUNT_INDEXES) {
    await StockCount.collection.createIndex(index.key, index.options);
  }
  return {stockCountIndexes: STOCK_COUNT_INDEXES.map(index => index.options.name)};
}
