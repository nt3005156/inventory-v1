/**
 * P2E — quota enforcement that survives concurrency.
 *
 * THE DEFECT THIS FIXES, MEASURED
 * -------------------------------
 * The P2C guards are check-then-act: read the usage count, compare it to the
 * plan limit, then insert. Correct sequentially, defenceless in parallel.
 * Probed against a limit of 2 with one branch already present:
 *
 *     5 simultaneous create attempts
 *     allowed through: 5 | branches now: 6   -> BYPASSED
 *
 * Every request read usage `1`, every one passed the check, every one
 * inserted. A tenant on a one-branch plan can hold as many branches as they
 * can open browser tabs.
 *
 * THE FIX, AND WHY THIS SHAPE
 * ---------------------------
 * A per-tenant, per-resource counter document updated with a CONDITIONAL
 * write. MongoDB applies `findOneAndUpdate` atomically to a single document,
 * so the increment and the ceiling test happen together and exactly one of two
 * racing writers can win:
 *
 *     findOneAndUpdate(
 *       {restaurant, resource, count: {$lt: limit}},   // the condition
 *       {$inc: {count: 1}}                             // the effect
 *     )
 *
 * If the filter no longer matches — because a competitor got there first — the
 * update returns null and the caller is refused. No transaction, no lock, no
 * new infrastructure.
 *
 * WHAT WAS REJECTED, AND WHY
 * --------------------------
 *   `$expr` against a limit stored on the tenant — the limit lives on the
 *   PLAN, which the counter document does not join to, and denormalising it
 *   onto every counter creates a second thing to invalidate on every plan
 *   edit.
 *
 *   A multi-document transaction reading usage and inserting — correct, but it
 *   makes every create a distributed transaction on the hot path, for a
 *   guarantee a single-document conditional write already provides.
 *
 *   Redis — not in this architecture, and the brief is explicit about not
 *   adding it reflexively.
 *
 * RECONCILIATION, NOT A SOURCE OF TRUTH
 * -------------------------------------
 * The counter can drift: a create that fails AFTER reserving, a row deleted by
 * a path that does not release, a restore from backup. So the counter is a
 * CONCURRENCY GATE, never the authority on how much a tenant has. Every
 * reservation reconciles against the real `countDocuments()` first, and a
 * counter found to be behind reality is corrected before the ceiling is
 * tested. Drift therefore self-heals on the next create instead of
 * accumulating into a wrong answer.
 */
import mongoose from 'mongoose';
import {isUnlimited} from './entitlements.js';

const {Schema, model} = mongoose;

/**
 * One document per (restaurant, resource).
 *
 * Deliberately tiny and separate from `Restaurant`: this row is written on
 * every create of a limited resource, and putting a hot counter inside the
 * tenant document would contend with every other tenant write.
 */
const resourceCounterSchema = new Schema({
  restaurant: {type: Schema.Types.ObjectId, ref: 'Restaurant', required: true},
  resource: {type: String, required: true, trim: true, maxlength: 40},
  count: {type: Number, default: 0, min: 0},
  // Set whenever the counter is reconciled against reality, for diagnostics.
  reconciledAt: {type: Date, default: null}
}, {timestamps: true});

// The uniqueness that makes the conditional write meaningful: exactly one
// counter per tenant per resource, so two writers contend on ONE document.
resourceCounterSchema.index(
  {restaurant: 1, resource: 1}, {unique: true, name: 'resource_counter_scope'}
);

export const ResourceCounter = model('ResourceCounter', resourceCounterSchema);

function httpError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), {status, ...extra});
}

/**
 * Reserve one unit of a limited resource, atomically.
 *
 * `countActual` is an async function returning the true current usage. It is
 * called to seed and to reconcile the counter, so the gate can never drift
 * into granting more than the plan allows.
 *
 * Returns `{reserved: true, count}` or throws 402.
 */
export async function reserveQuota({
  restaurantId, resource, limit, countActual, label, adding = 1
}) {
  // No ceiling to enforce: skip the counter entirely rather than maintaining
  // a document nothing reads.
  if (isUnlimited(limit)) return {reserved: true, unlimited: true};

  const scope = {restaurant: new mongoose.Types.ObjectId(String(restaurantId)), resource};

  /**
   * Reconcile FIRST.
   *
   * The counter is a gate, not the truth. Seeding it from the real count on
   * every reservation costs one indexed count — the same query the previous
   * implementation already ran — and means a drifted counter cannot silently
   * admit or refuse the wrong number of creates.
   */
  const actual = Number(await countActual()) || 0;
  await ResourceCounter.updateOne(
    scope,
    // `$max` so a concurrent reservation that has already incremented past
    // the observed count is never rolled backwards by this reconciliation.
    {$max: {count: actual}, $setOnInsert: scope, $set: {reconciledAt: new Date()}},
    {upsert: true}
  );

  /**
   * THE ATOMIC STEP. `count: {$lt: limit}` is evaluated by MongoDB in the same
   * operation as `$inc`, against one document, so concurrent callers serialise
   * and exactly `limit` of them can succeed.
   */
  const updated = await ResourceCounter.findOneAndUpdate(
    {...scope, count: {$lte: limit - adding}},
    {$inc: {count: adding}},
    {new: true}
  );

  if (!updated) {
    const current = await ResourceCounter.findOne(scope).lean();
    throw httpError(
      `Your plan allows ${limit} ${label || resource} (${current?.count ?? actual} in use). `
      + 'Upgrade the plan to add more.',
      402,
      {
        billing: true, reason: 'limit_reached', code: 'RESOURCE_LIMIT_REACHED',
        limit: resource, allowed: limit, used: current?.count ?? actual
      }
    );
  }
  return {reserved: true, count: updated.count};
}

/**
 * Hand a reservation back when the create fails after reserving.
 *
 * Best-effort and floored at zero. A lost release is self-correcting: the next
 * reservation reconciles against the real count. A release that drove the
 * counter negative would not be.
 */
export async function releaseQuota({restaurantId, resource, adding = 1}) {
  try {
    await ResourceCounter.updateOne(
      {
        restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
        resource,
        count: {$gte: adding}
      },
      {$inc: {count: -adding}}
    );
  } catch (error) {
    // Never let bookkeeping fail the caller's error path.
    console.error('Quota release failed', {resource, message: error?.message});
  }
}

/**
 * Reserve, run the create, release on failure.
 *
 * The wrapper exists so no call site has to remember the release. A create
 * that throws after reserving would otherwise leak a unit of quota until the
 * next reconciliation.
 */
export async function withQuota({
  restaurantId, resource, limit, countActual, label, adding = 1
}, create) {
  const reservation = await reserveQuota({
    restaurantId, resource, limit, countActual, label, adding
  });
  try {
    return await create();
  } catch (error) {
    if (!reservation.unlimited) {
      await releaseQuota({restaurantId, resource, adding});
    }
    throw error;
  }
}

/** Test/ops seam: read a counter without mutating it. */
export async function readQuotaCounter(restaurantId, resource) {
  const row = await ResourceCounter.findOne({
    restaurant: new mongoose.Types.ObjectId(String(restaurantId)), resource
  }).lean();
  return row ? row.count : null;
}
