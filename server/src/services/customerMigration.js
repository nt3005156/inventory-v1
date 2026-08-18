/**
 * Customer migration to the Phase 9 restaurant-wide model.
 *
 * Before Phase 9 a Customer had only `branch`, and the storefront deduplicated
 * on {branch, phone}. So a chain could hold several records for one person —
 * one per branch — and no record carried a `restaurant` at all.
 *
 * This migration:
 *   1. Backfills `restaurant` from the home branch.
 *   2. Backfills `phoneKey` using the same normalisation the CRM uses.
 *   3. Merges duplicates that the old model created, keeping the richest
 *      record and repointing every order at it.
 *   4. Only then creates the unique index, which would otherwise fail against
 *      existing duplicates.
 *
 * Safe to run repeatedly; it converges and does nothing on a clean database.
 */
import mongoose from 'mongoose';
import {Branch, Customer, Order} from '../models/operations.js';
import {normalizePhone} from './customers.js';

const CUSTOMER_INDEXES = [
  {
    key: {restaurant: 1, phoneKey: 1},
    options: {
      unique: true,
      name: 'customer_restaurant_phone',
      partialFilterExpression: {phoneKey: {$type: 'string'}}
    }
  },
  {key: {restaurant: 1, name: 1}, options: {name: 'customer_restaurant_name'}},
  {key: {restaurant: 1, email: 1}, options: {name: 'customer_restaurant_email'}},
  {
    key: {restaurant: 1, active: 1, 'stats.lastOrderAt': -1},
    options: {name: 'customer_restaurant_recent'}
  }
];

/** How complete a profile is — used to choose which duplicate survives. */
function richness(customer) {
  let score = 0;
  if (customer.name) score += 1;
  if (customer.email) score += 1;
  if (customer.notes) score += 1;
  score += (customer.addresses || []).length;
  score += Number(customer.totalSpend || 0) > 0 ? 2 : 0;
  return score;
}

export async function migrateCustomers() {
  if (!mongoose.connection.db) return {scanned: 0, backfilled: 0, merged: 0};

  // The unique index may already exist — Mongoose autoIndex builds it as soon
  // as the model is used, and a re-run always finds it. Backfilling phoneKey
  // would then hit E11000 on the very duplicates this migration exists to
  // merge, so the constraint is dropped first and rebuilt at the end once the
  // data is clean.
  await Customer.collection.dropIndex('customer_restaurant_phone').catch(() => null);

  const branches = await Branch.find({}).select('_id restaurant').lean();
  const restaurantByBranch = new Map(branches.map(b => [String(b._id), b.restaurant]));

  const customers = await Customer.find({}).lean();
  let backfilled = 0;

  // 1 + 2: give every record a restaurant and a normalised phone key.
  for (const customer of customers) {
    const update = {};
    if (!customer.restaurant) {
      const restaurantId = restaurantByBranch.get(String(customer.branch));
      // A customer whose branch no longer exists cannot be placed in a
      // restaurant; leave it untouched rather than guessing.
      if (restaurantId) update.restaurant = restaurantId;
    }
    const phoneKey = normalizePhone(customer.phone);
    if (phoneKey && customer.phoneKey !== phoneKey) update.phoneKey = phoneKey;
    if (!phoneKey && customer.phoneKey) update.$unset = {phoneKey: ''};

    if (Object.keys(update).length) {
      const {$unset, ...set} = update;
      const operation = {};
      if (Object.keys(set).length) operation.$set = set;
      if ($unset) operation.$unset = $unset;
      await Customer.collection.updateOne({_id: customer._id}, operation);
      backfilled += 1;
    }
  }

  // 3: merge duplicates the branch-scoped model created.
  const reloaded = await Customer.find({
    restaurant: {$ne: null}, phoneKey: {$type: 'string'}
  }).lean();

  const groups = new Map();
  for (const customer of reloaded) {
    const key = `${customer.restaurant}:${customer.phoneKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(customer);
  }

  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // Keep the richest; oldest wins a tie so the original record survives.
    group.sort((a, b) => richness(b) - richness(a)
      || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    const [survivor, ...duplicates] = group;

    const addresses = [...(survivor.addresses || [])];
    let email = survivor.email;
    let notes = survivor.notes;
    let points = Number(survivor.loyaltyPoints || survivor.loyalty?.points || 0);

    for (const duplicate of duplicates) {
      await Order.updateMany({customer: duplicate._id}, {$set: {customer: survivor._id}});
      for (const address of duplicate.addresses || []) {
        if (!addresses.some(a => String(a.address).trim() === String(address.address).trim())) {
          addresses.push(address);
        }
      }
      if (!email && duplicate.email) email = duplicate.email;
      if (!notes && duplicate.notes) notes = duplicate.notes;
      points += Number(duplicate.loyaltyPoints || duplicate.loyalty?.points || 0);

      // Retire the duplicate and release its phone key.
      await Customer.collection.updateOne(
        {_id: duplicate._id},
        {
          $set: {
            active: false,
            mergedInto: survivor._id,
            deactivatedAt: new Date(),
            deactivationReason: `Merged into ${survivor._id} by Phase 9 migration`
          },
          $unset: {phoneKey: ''}
        }
      );
      merged += 1;
    }

    await Customer.collection.updateOne(
      {_id: survivor._id},
      {$set: {addresses, email, notes, 'loyalty.points': points, loyaltyPoints: points}}
    );
  }

  // 4: only now is the unique index guaranteed to build.
  for (const {key, options} of CUSTOMER_INDEXES) {
    try {
      await Customer.collection.createIndex(key, options);
    } catch (error) {
      // An index with the same name but different options survives from an
      // earlier shape; replace it rather than leaving the wrong constraint.
      if (error?.codeName === 'IndexOptionsConflict' || error?.code === 85 || error?.code === 86) {
        await Customer.collection.dropIndex(options.name).catch(() => null);
        await Customer.collection.createIndex(key, options);
      } else {
        throw error;
      }
    }
  }

  return {scanned: customers.length, backfilled, merged};
}

export async function ensureCustomerIndexes() {
  return migrateCustomers();
}
