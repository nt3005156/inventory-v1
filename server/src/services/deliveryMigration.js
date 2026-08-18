/**
 * Delivery migration to the Phase 10 model.
 *
 * Pre-Phase-10 deliveries had no branch or restaurant of their own (tenancy
 * was joined through the order every time) and used the status values
 * 'available' and 'picking_up'. Both are repaired here so the new indexes and
 * the new state machine apply to historical rows.
 *
 * Idempotent: converges and then does nothing.
 */
import mongoose from 'mongoose';
import {Branch, Delivery, Order} from '../models/operations.js';

const LEGACY_STATUS = {available: 'pending', picking_up: 'picked_up'};

// A partial index cannot use $ne, so the non-cancelled statuses are listed.
// Must stay identical to the deliverySchema index in models/operations.js.
const NON_CANCELLED_STATUSES = Object.freeze([
  'pending', 'assigned', 'picked_up', 'out_for_delivery', 'delivered', 'failed'
]);

const DELIVERY_INDEXES = [
  {key: {order: 1}, options: {unique: true, name: 'delivery_order_unique'}},
  {key: {restaurant: 1, branch: 1, status: 1, createdAt: -1}, options: {name: 'delivery_scope_status'}},
  {key: {rider: 1, status: 1, createdAt: -1}, options: {name: 'delivery_rider_queue'}}
];

export async function migrateDeliveries() {
  if (!mongoose.connection.db) return {scanned: 0, backfilled: 0, deduped: 0};

  // Drop the unique index first: duplicates from the old model would make the
  // backfill fail on the very rows this migration exists to clean up.
  await Delivery.collection.dropIndex('delivery_order_unique').catch(() => null);

  const deliveries = await Delivery.find({}).lean();
  const branches = await Branch.find({}).select('_id restaurant').lean();
  const restaurantByBranch = new Map(branches.map(b => [String(b._id), b.restaurant]));

  let backfilled = 0;
  const seenOrders = new Map();
  const duplicates = [];

  for (const delivery of deliveries) {
    const update = {};

    if (!delivery.branch || !delivery.restaurant) {
      const order = await Order.findById(delivery.order).select('branch').lean();
      if (order?.branch) {
        if (!delivery.branch) update.branch = order.branch;
        const restaurantId = restaurantByBranch.get(String(order.branch));
        if (!delivery.restaurant && restaurantId) update.restaurant = restaurantId;
      }
    }

    const mapped = LEGACY_STATUS[delivery.status];
    if (mapped) update.status = mapped;

    // Backfill lifecycle stamps from what we can infer, so historical rows do
    // not read as though they were never delivered.
    const status = mapped || delivery.status;
    if (status === 'delivered' && !delivery.deliveredAt) {
      update.deliveredAt = delivery.updatedAt || delivery.createdAt;
    }
    if (delivery.rider && !delivery.assignedAt) {
      update.assignedAt = delivery.createdAt;
    }

    if (Object.keys(update).length) {
      await Delivery.collection.updateOne({_id: delivery._id}, {$set: update});
      backfilled += 1;
    }

    // The old model allowed several deliveries per order.
    const key = String(delivery.order);
    if (seenOrders.has(key)) duplicates.push(delivery);
    else seenOrders.set(key, delivery);
  }

  // Retire duplicates rather than deleting them: they are real history, and a
  // cancelled row is honest where a missing row is not.
  for (const duplicate of duplicates) {
    await Delivery.collection.updateOne(
      {_id: duplicate._id},
      {$set: {status: 'cancelled', cancelledAt: new Date(),
        failureReason: 'Duplicate dispatch retired by the Phase 10 migration'}}
    );
  }

  // Duplicates still hold the same `order` value, so a unique index on order
  // alone would fail. Constrain only the rows that are not retired.
  for (const {key, options} of DELIVERY_INDEXES) {
    const opts = options.name === 'delivery_order_unique'
      ? {...options, partialFilterExpression: {status: {$in: NON_CANCELLED_STATUSES}}}
      : options;
    try {
      await Delivery.collection.createIndex(key, opts);
    } catch (error) {
      if ([85, 86].includes(error?.code) || error?.codeName === 'IndexOptionsConflict') {
        await Delivery.collection.dropIndex(opts.name).catch(() => null);
        await Delivery.collection.createIndex(key, opts);
      } else {
        throw error;
      }
    }
  }

  return {scanned: deliveries.length, backfilled, deduped: duplicates.length};
}

export async function ensureDeliveryIndexes() {
  return migrateDeliveries();
}
