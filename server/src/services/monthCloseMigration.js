import mongoose from 'mongoose';
import {User} from '../models/index.js';
import {Branch} from '../models/operations.js';
import {MonthlySnapshot} from '../models/index.js';

function id(value) {
  return value ? String(value) : null;
}

/**
 * Adds restaurant ownership to legacy month-close snapshots before replacing
 * the old globally-scoped indexes. Ambiguous ownership aborts startup rather
 * than making historical financial records visible to another tenant.
 */
export async function ensureMonthCloseIndexes() {
  try {
    await MonthlySnapshot.createCollection();
  } catch (e) {
    if (e?.codeName !== 'NamespaceExists' && e?.code !== 48) throw e;
  }
  const collection = MonthlySnapshot.collection;
  const legacy = await collection.find({restaurant: {$exists: false}}).toArray();
  const updates = [];
  for (const row of legacy) {
    let branchRestaurant = null;
    if (row.branch) branchRestaurant = id((await Branch.findById(row.branch).select('restaurant').lean())?.restaurant);
    const actorIds = [row.closedBy, row.reopenedBy].filter(Boolean);
    const actorRestaurants = actorIds.length
      ? [...new Set((await User.find({_id: {$in: actorIds}}).select('restaurantId').lean()).map(user => id(user.restaurantId)).filter(Boolean))]
      : [];
    const candidates = [...new Set([branchRestaurant, ...actorRestaurants].filter(Boolean))];
    if (candidates.length !== 1) {
      throw new Error(`Cannot safely determine restaurant ownership for monthly snapshot ${row._id}`);
    }
    updates.push({
      updateOne: {
        filter: {_id: row._id, restaurant: {$exists: false}},
        update: {$set: {
          restaurant: new mongoose.Types.ObjectId(candidates[0]),
          scopeKey: row.scopeKey || (row.branch ? id(row.branch) : 'all'),
          revision: Number(row.revision || 1),
          status: row.status || 'closed'
        }}
      }
    });
  }
  if (updates.length) await collection.bulkWrite(updates, {ordered: true});

  const indexes = await collection.indexes();
  for (const index of indexes) {
    if (index.name === '_id_') continue;
    const keys = Object.keys(index.key || {});
    const obsolete = index.name === 'month_1'
      || (keys.includes('scopeKey') && !keys.includes('restaurant'));
    if (obsolete) await collection.dropIndex(index.name);
  }
  await collection.createIndex(
    {restaurant: 1, scopeKey: 1, month: 1, revision: 1},
    {unique: true, name: 'monthly_snapshot_restaurant_revision'}
  );
  await collection.createIndex(
    {restaurant: 1, scopeKey: 1, month: 1, status: 1},
    {name: 'monthly_snapshot_restaurant_status'}
  );
  return {migrated: updates.length};
}
