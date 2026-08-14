import {MonthlySnapshot} from '../models/index.js';

/** Upgrade the original restaurant-wide `month_1` unique index in place. */
export async function ensureMonthCloseIndexes() {
  try {
    await MonthlySnapshot.createCollection();
  } catch (e) {
    if (e?.codeName !== 'NamespaceExists' && e?.code !== 48) throw e;
  }
  const collection = MonthlySnapshot.collection;
  await collection.updateMany(
    {scopeKey: {$exists: false}},
    {$set: {scopeKey: 'all', revision: 1, status: 'closed'}}
  );
  const indexes = await collection.indexes();
  const legacy = indexes.find(index => index.name === 'month_1' && index.unique);
  if (legacy) await collection.dropIndex(legacy.name);
  await collection.createIndex({scopeKey: 1, month: 1, revision: 1}, {unique: true});
  await collection.createIndex({scopeKey: 1, month: 1, status: 1});
}
