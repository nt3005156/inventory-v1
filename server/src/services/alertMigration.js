import mongoose from 'mongoose';
import {Notification} from '../models/operations.js';

/**
 * Phase 16A — alert lifecycle indexes.
 *
 * Duplicate suppression for reorder alerts was an application-level
 * "find one from the last 24h" check. That is a read-then-write race: two
 * sweeps (or a sweep and a live ledger alert) running concurrently both read
 * nothing and both insert. The unique partial index makes the database the
 * arbiter, exactly as the payment and stock-count idempotency indexes do.
 *
 * Scoped to UNRESOLVED alerts only, so the same condition can legitimately
 * raise a fresh alert once the previous one has been resolved.
 */
const ALERT_INDEXES = [
  {
    key: {branch: 1, type: 1, referenceId: 1},
    options: {
      unique: true,
      name: 'alert_open_condition',
      partialFilterExpression: {
        status: {$in: ['open', 'acknowledged']},
        referenceId: {$type: 'objectId'},
        branch: {$type: 'objectId'}
      }
    }
  },
  {
    key: {restaurant: 1, branch: 1, status: 1, createdAt: -1},
    options: {name: 'alert_branch_status_created'}
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

/**
 * Backfills `status` onto historical rows before the partial index is built.
 *
 * Legacy notifications have no status at all. Left as-is they would sit
 * outside the partial filter and never be de-duplicated; worse, a mix of
 * read/unread rows for one condition could collide once status was added.
 * A row already marked read is treated as resolved, which is what "read"
 * meant operationally.
 */
export async function backfillAlertLifecycle() {
  if (!mongoose.connection.db) return {updated: 0};
  const collection = mongoose.connection.db.collection(Notification.collection.collectionName);
  const resolved = await collection.updateMany(
    {status: {$exists: false}, read: true},
    {$set: {status: 'resolved', severity: 'info'}}
  );
  const open = await collection.updateMany(
    {status: {$exists: false}},
    {$set: {status: 'open', severity: 'info'}}
  );
  return {updated: (resolved.modifiedCount || 0) + (open.modifiedCount || 0)};
}

/**
 * Retires duplicate open alerts for one condition, keeping the newest.
 *
 * Report-and-repair rather than report-only: an alert is a notification, not a
 * financial document, so collapsing exact duplicates loses nothing an operator
 * needs. The survivor keeps its history; the rest are marked resolved rather
 * than deleted, so the trail of what was raised is preserved.
 */
export async function retireDuplicateAlerts() {
  if (!mongoose.connection.db) return {retired: 0};
  const collection = mongoose.connection.db.collection(Notification.collection.collectionName);
  const groups = await collection.aggregate([
    {$match: {status: {$in: ['open', 'acknowledged']}, referenceId: {$type: 'objectId'}, branch: {$type: 'objectId'}}},
    {$sort: {createdAt: -1}},
    {$group: {_id: {branch: '$branch', type: '$type', referenceId: '$referenceId'}, ids: {$push: '$_id'}, count: {$sum: 1}}},
    {$match: {count: {$gt: 1}}}
  ]).toArray();

  let retired = 0;
  for (const group of groups) {
    const [, ...duplicates] = group.ids;
    if (!duplicates.length) continue;
    await collection.updateMany(
      {_id: {$in: duplicates}},
      {$set: {status: 'resolved', resolvedAt: new Date(), resolutionNote: 'Superseded by a newer alert for the same condition'}}
    );
    retired += duplicates.length;
  }
  return {retired};
}

export async function ensureAlertIndexes() {
  if (!mongoose.connection.db) return null;
  await ensureCollection(Notification.collection.collectionName);
  const backfilled = await backfillAlertLifecycle();
  const deduped = await retireDuplicateAlerts();
  for (const index of ALERT_INDEXES) {
    await Notification.collection.createIndex(index.key, index.options);
  }
  return {
    ...backfilled,
    ...deduped,
    indexes: ALERT_INDEXES.map(index => index.options.name)
  };
}
