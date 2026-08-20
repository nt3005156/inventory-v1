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
export async function backfillAlertLifecycle({dryRun = false} = {}) {
  if (!mongoose.connection.db) return {updated: 0, dryRun};
  const collection = mongoose.connection.db.collection(Notification.collection.collectionName);
  const resolvedFilter = {status: {$exists: false}, read: true};
  const openFilter = {status: {$exists: false}};

  if (dryRun) {
    // Count the SAME filters the write would use, in the same order, so the
    // preview cannot drift from the execution.
    const wouldResolve = await collection.countDocuments(resolvedFilter);
    const wouldOpen = await collection.countDocuments(openFilter) - wouldResolve;
    return {
      dryRun: true,
      updated: wouldResolve + Math.max(0, wouldOpen),
      wouldMarkResolved: wouldResolve,
      wouldMarkOpen: Math.max(0, wouldOpen)
    };
  }

  const resolved = await collection.updateMany(resolvedFilter, {$set: {status: 'resolved', severity: 'info'}});
  const open = await collection.updateMany(openFilter, {$set: {status: 'open', severity: 'info'}});
  return {
    dryRun: false,
    updated: (resolved.modifiedCount || 0) + (open.modifiedCount || 0),
    markedResolved: resolved.modifiedCount || 0,
    markedOpen: open.modifiedCount || 0
  };
}

/**
 * Retires duplicate open alerts for one condition, keeping the newest.
 *
 * Report-and-repair rather than report-only: an alert is a notification, not a
 * financial document, so collapsing exact duplicates loses nothing an operator
 * needs. The survivor keeps its history; the rest are marked resolved rather
 * than deleted, so the trail of what was raised is preserved.
 */
export async function retireDuplicateAlerts({dryRun = false} = {}) {
  if (!mongoose.connection.db) return {retired: 0, dryRun};
  const collection = mongoose.connection.db.collection(Notification.collection.collectionName);
  const groups = await collection.aggregate([
    {$match: {status: {$in: ['open', 'acknowledged']}, referenceId: {$type: 'objectId'}, branch: {$type: 'objectId'}}},
    {$sort: {createdAt: -1}},
    {$group: {_id: {branch: '$branch', type: '$type', referenceId: '$referenceId'}, ids: {$push: '$_id'}, count: {$sum: 1}}},
    {$match: {count: {$gt: 1}}}
  ]).toArray();

  let retired = 0;
  const samples = [];
  for (const group of groups) {
    const [keep, ...duplicates] = group.ids;
    if (!duplicates.length) continue;
    if (samples.length < 20) {
      samples.push({
        branch: String(group._id.branch),
        type: group._id.type,
        referenceId: String(group._id.referenceId),
        duplicates: duplicates.length,
        keeping: String(keep)
      });
    }
    if (dryRun) {
      retired += duplicates.length;
      continue;
    }
    await collection.updateMany(
      {_id: {$in: duplicates}},
      {$set: {status: 'resolved', resolvedAt: new Date(), resolutionNote: 'Superseded by a newer alert for the same condition'}}
    );
    retired += duplicates.length;
  }
  return {retired, dryRun, samples};
}

/**
 * Reports what the migration would do, writing nothing.
 *
 * Deliberately reuses the same helpers in the same order as the real run, so
 * the preview cannot describe behaviour the execution does not have.
 */
export async function planAlertMigration() {
  if (!mongoose.connection.db) return null;
  const collection = mongoose.connection.db.collection(Notification.collection.collectionName);
  const [backfill, duplicates, total, missingStatus, alreadyValid] = await Promise.all([
    backfillAlertLifecycle({dryRun: true}),
    retireDuplicateAlerts({dryRun: true}),
    collection.countDocuments({}),
    collection.countDocuments({status: {$exists: false}}),
    collection.countDocuments({status: {$in: ['open', 'acknowledged', 'resolved']}})
  ]);
  return {
    dryRun: true,
    totalAlerts: total,
    missingStatus,
    alreadyValid,
    backfill,
    duplicates,
    indexes: ALERT_INDEXES.map(index => index.options.name),
    changesRequired: backfill.updated > 0 || duplicates.retired > 0
  };
}

export async function ensureAlertIndexes({dryRun = false} = {}) {
  if (!mongoose.connection.db) return null;
  if (dryRun) return planAlertMigration();
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
