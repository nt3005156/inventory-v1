import {Audit} from '../models/index.js';
import {Order} from '../models/operations.js';

// Phase 5D audit — backfill of historical completedAt.
//
// Before completion stamping was added to the payment and delivery paths, an
// order could reach 'completed' with no completedAt, which silently removed it
// from completion and service-time metrics.
//
// The audit log is a reliable source for these: every settlement writes an
// `payment` entry carrying `after.status`, and every kitchen transition writes
// a `kitchen_status` entry carrying `after.status`, each with a trustworthy
// `at` timestamp. Where such an entry exists, the completion instant is known
// exactly and is not being invented.
//
// Rules this migration holds to:
//   * never overwrite an existing completedAt
//   * only ever use a real recorded timestamp, never "now" and never a guess
//   * skip any order with no audit evidence, leaving completedAt null
//   * idempotent: a second run changes nothing

const COMPLETION_ACTIONS = ['payment', 'kitchen_status'];

/**
 * Finds the audit entry that first recorded an order as completed.
 * Returns null when the log holds no such evidence.
 */
export async function findCompletionEvidence(orderId, {session} = {}) {
  const entries = await Audit.find({
    entity: 'order',
    entityId: orderId,
    action: {$in: COMPLETION_ACTIONS}
  }).sort({at: 1}).session(session || null).lean();

  for (const entry of entries) {
    if (entry?.after?.status === 'completed' && entry.at) {
      return {at: new Date(entry.at), action: entry.action, auditId: entry._id};
    }
  }
  return null;
}

/**
 * Backfills completedAt for completed orders that are missing it.
 *
 * @param {boolean} dryRun report what would change without writing
 */
export async function backfillCompletedAt({dryRun = false, branchId = null, session} = {}) {
  const match = {
    status: 'completed',
    $or: [{completedAt: null}, {completedAt: {$exists: false}}]
  };
  if (branchId) match.branch = branchId;

  const candidates = await Order.find(match).select('_id orderNo branch readyAt').session(session || null);

  const result = {
    scanned: candidates.length,
    backfilled: 0,
    skippedNoEvidence: 0,
    dryRun,
    samples: []
  };

  for (const order of candidates) {
    const evidence = await findCompletionEvidence(order._id, {session});
    if (!evidence) {
      // No recorded completion instant. Leaving it null is correct: an
      // invented timestamp would corrupt the very metrics this exists to feed.
      result.skippedNoEvidence += 1;
      continue;
    }
    if (result.samples.length < 10) {
      result.samples.push({orderNo: order.orderNo, at: evidence.at, source: evidence.action});
    }
    if (!dryRun) {
      // The guard on completedAt keeps this idempotent and prevents a
      // concurrent writer's valid value from being clobbered.
      const update = await Order.updateOne(
        {_id: order._id, $or: [{completedAt: null}, {completedAt: {$exists: false}}]},
        {$set: {completedAt: evidence.at}},
        {session: session || undefined, timestamps: false}
      );
      if (update.modifiedCount) result.backfilled += 1;
    } else {
      result.backfilled += 1;
    }
  }
  return result;
}
