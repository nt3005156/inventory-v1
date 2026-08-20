import crypto from 'node:crypto';
import mongoose from 'mongoose';

/**
 * Phase 16B — MongoDB-backed distributed scheduler lock.
 *
 * Phase 16A left the scheduler in-process and documented that honestly: with
 * several API containers every container ticks. Alert *correctness* survived
 * because of the unique alert index, but the duplicated read load was real.
 *
 * WHY MONGODB AND NOT REDIS
 * The repository already requires a replica set — `verifyTransactionCapableDatabase()`
 * refuses to start otherwise — so MongoDB gives us a linearizable primary and
 * atomic `findOneAndUpdate`. That is everything a lease-based lock needs.
 * Introducing Redis would add an operational dependency the architecture does
 * not otherwise need, so it is deliberately not used.
 *
 * HOW IT IS SAFE
 *   * ACQUISITION IS ATOMIC. A single `findOneAndUpdate` with `upsert` either
 *     creates the lock document or steals an expired one. Two instances racing
 *     both issue the same command; MongoDB serialises them on the primary and
 *     the loser gets a duplicate-key error (11000) because the `_id` already
 *     exists and its filter did not match. Verified against the running
 *     database before this was written.
 *   * THE LOCK IS A LEASE, NOT A FLAG. It carries `expiresAt`. A process that
 *     crashes mid-sweep cannot block the scheduler forever: once the lease
 *     lapses the next instance takes it. There is no manual cleanup step.
 *   * RELEASE VERIFIES OWNERSHIP. `release()` deletes only when the stored
 *     `owner` token still matches, so a slow instance whose lease already
 *     expired and was taken by another cannot delete the new holder's lock.
 *   * A TTL INDEX IS A BACKSTOP, NOT THE MECHANISM. Mongo's TTL monitor only
 *     runs about once a minute, which is far too coarse to rely on for
 *     correctness. Expiry is enforced by the `expiresAt <= now` term in the
 *     acquisition filter; the TTL index merely stops dead rows accumulating.
 */

const DEFAULT_COLLECTION = 'scheduler_locks';
const DEFAULT_TTL_SECONDS = 300;

/** Generates an unguessable owner token for this acquisition. */
function newOwnerToken() {
  return `${process.pid}:${crypto.randomUUID()}`;
}

function lockCollection(name = DEFAULT_COLLECTION) {
  if (!mongoose.connection?.db) {
    throw Object.assign(new Error('MongoDB is not connected; the scheduler lock is unavailable'), {status: 503});
  }
  return mongoose.connection.db.collection(name);
}

/**
 * Builds the TTL index. Safe to call repeatedly.
 *
 * `expireAfterSeconds: 0` means "delete when expiresAt is in the past", which
 * is the standard Mongo idiom for a lease document.
 */
export async function ensureSchedulerLockIndexes({collection = DEFAULT_COLLECTION} = {}) {
  if (!mongoose.connection?.db) return null;
  const rows = lockCollection(collection);
  await rows.createIndex({expiresAt: 1}, {name: 'scheduler_lock_ttl', expireAfterSeconds: 0});
  return {indexes: ['scheduler_lock_ttl']};
}

/**
 * Attempts to take the lock.
 *
 * Returns a release function on success, or `null` when another live instance
 * holds it. Never throws for the ordinary "somebody else has it" case — that
 * is an expected outcome, not an error.
 */
export async function acquireSchedulerLock({
  name = 'reorder-sweep',
  ttlSeconds = DEFAULT_TTL_SECONDS,
  collection = DEFAULT_COLLECTION,
  owner = newOwnerToken()
} = {}) {
  const rows = lockCollection(collection);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + Math.max(1, Number(ttlSeconds) || DEFAULT_TTL_SECONDS) * 1000);

  try {
    // Matches only when the lock does not exist (upsert) or its lease has
    // lapsed. A live lease fails the filter, the upsert then collides on the
    // unique _id, and Mongo raises 11000 — which is the "somebody else holds
    // it" signal, not a failure.
    await rows.findOneAndUpdate(
      {_id: name, expiresAt: {$lte: now}},
      {$set: {owner, expiresAt, acquiredAt: now}},
      {upsert: true, returnDocument: 'after'}
    );
  } catch (error) {
    if (error?.code === 11000) return null;
    throw error;
  }

  return {
    owner,
    expiresAt,
    /** Extends the lease. For a sweep that legitimately runs long. */
    async renew(extraSeconds = ttlSeconds) {
      const next = new Date(Date.now() + Math.max(1, Number(extraSeconds)) * 1000);
      const result = await rows.updateOne({_id: name, owner}, {$set: {expiresAt: next}});
      return result.matchedCount === 1;
    },
    /**
     * Releases the lock, but ONLY if we still own it. A process whose lease
     * expired and was taken over must not delete the new holder's lock.
     */
    async release() {
      const result = await rows.deleteOne({_id: name, owner});
      return result.deletedCount === 1;
    }
  };
}

/** Inspects the current lock holder. Read-only, for diagnostics. */
export async function inspectSchedulerLock({name = 'reorder-sweep', collection = DEFAULT_COLLECTION} = {}) {
  const row = await lockCollection(collection).findOne({_id: name});
  if (!row) return {held: false};
  const expired = new Date(row.expiresAt).getTime() <= Date.now();
  return {
    held: !expired,
    expired,
    owner: row.owner,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt
  };
}

/**
 * Adapter matching the `setSchedulerLock()` seam the scheduler already exposes.
 *
 * The scheduler expects `acquire()` to return a release function or a falsy
 * value; this bridges the richer handle above onto that contract without
 * changing the scheduler's interface.
 */
export function mongoSchedulerLock({name = 'reorder-sweep', ttlSeconds = DEFAULT_TTL_SECONDS} = {}) {
  return {
    kind: 'mongodb',
    name,
    ttlSeconds,
    async acquire() {
      const handle = await acquireSchedulerLock({name, ttlSeconds});
      if (!handle) return null;
      return () => handle.release();
    }
  };
}
