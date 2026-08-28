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
  restaurantId, resource, limit, countActual, label, adding = 1, session = null,
  reconcile = 'raise'
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

  /**
   * TWO RECONCILIATION MODES, because stocks and flows differ.
   *
   * `raise` (default, and what P2G.1–P2G.3 use) applies `$max`: the counter is
   * only ever pulled UP to reality. That is essential for seats, menu items
   * and stations, where a concurrent reservation may legitimately have
   * incremented past the count we just observed and must not be rolled back.
   *
   * `sync` (P2G.5, monthly orders) applies `$set` when reality is LOWER.
   * A monthly allowance is a flow whose usage can genuinely fall: cancelling
   * an order removes it from the count, and the tenant should get that
   * allowance back. Under `$max` the counter would stay at its high-water mark
   * for the rest of the month, so a cancelled order silently kept consuming a
   * slot. Measured: two orders on a ceiling of two, cancel one, real usage 1,
   * counter still 2, next order refused.
   *
   * `sync` is only safe because the source of truth here is a COUNT of orders
   * that already exist. The window between reading `actual` and the
   * conditional `$inc` below can let a racing writer's increment be
   * overwritten — but that writer's order is itself in the collection, so the
   * next reservation's count includes it. The ceiling is still enforced by the
   * conditional write; the risk is bounded to briefly under-counting during a
   * burst, never over-admitting beyond `limit` at the moment of the write.
   */
  /**
   * SETTLE THE DOCUMENT FIRST, then reconcile with `$max` ONLY.
   *
   * TWO RACES WERE MEASURED HERE, and the second corrects a defect I shipped
   * in P2G.5.
   *
   * 1. DOCUMENT CREATION. With no counter row yet — the first reservation of a
   *    new month — concurrent upserts each concluded the count was 0 and each
   *    passed the ceiling. A bare `$setOnInsert` settles the row once, before
   *    any arithmetic, so contenders meet a document that already exists.
   *
   * 2. `$set` RECONCILIATION. P2G.5 introduced a `sync` mode that wrote
   *    `{$set: {count: actual}}` so a cancelled order could return its slot.
   *    That is correct sequentially and WRONG under load: between reading
   *    `actual` and writing it, concurrent reservations have already
   *    incremented the counter and the `$set` discards their increments.
   *    Measured on the overall monthly quota, `limit = 2`, 8 concurrent, ten
   *    trials: 4,4,2,3,3,3,4,3,2,4. My P2G.5 tests used six-way bursts, which
   *    were not wide enough to expose it, and I reported that quota as holding.
   *    It did not.
   *
   * So the reservation path now reconciles UPWARD ONLY, for every resource.
   * `$max` can never discard a concurrent increment, which is precisely the
   * property the ceiling depends on.
   *
   * Downward reconciliation still has to happen — a monthly allowance is a
   * flow and a cancelled order must give its slot back — but it cannot happen
   * here, racing against live increments. `syncQuotaCounter()` below does it
   * as a separate, deliberate step off the reservation path.
   */
  await ResourceCounter.updateOne(
    scope, {$setOnInsert: {...scope, count: 0}}, {upsert: true, session}
  );

  await ResourceCounter.updateOne(
    scope,
    // `$max` so a concurrent reservation that has already incremented past
    // the observed count is never rolled backwards by this reconciliation.
    {$max: {count: actual}, $setOnInsert: scope, $set: {reconciledAt: new Date()}},
    {upsert: true, session}
  );

  /**
   * THE ATOMIC STEP. `count: {$lt: limit}` is evaluated by MongoDB in the same
   * operation as `$inc`, against one document, so concurrent callers serialise
   * and exactly `limit` of them can succeed.
   */
  const updated = await ResourceCounter.findOneAndUpdate(
    {...scope, count: {$lte: limit - adding}},
    {$inc: {count: adding}},
    {new: true, session}
  );

  if (!updated) {
    const current = await ResourceCounter.findOne(scope).session(session).lean();
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
 * Pull a counter DOWN to reality, when reality has genuinely fallen.
 *
 * Separate from `reserveQuota()` on purpose. Downward reconciliation and a
 * live ceiling check cannot share a code path: a `$set` issued next to a
 * conditional `$inc` discards concurrent increments and breaks the ceiling
 * (measured — see the header of `reserveQuota`). So the reservation path only
 * ever raises, and lowering is an explicit act performed when something has
 * actually reduced usage.
 *
 * Guarded by `count: {$gt: actual}`, so it can only ever lower and never
 * resurrect a slot a concurrent reservation just took. Best-effort: a failure
 * leaves the counter high, which refuses a little too much rather than
 * admitting too much, and the next call repairs it.
 *
 * Used for FLOW quotas (monthly orders), where cancelling an order must return
 * its allowance. Stock quotas do not call it — a deactivated station releases
 * explicitly and a deleted row is handled by its own path.
 */
export async function syncQuotaCounter({restaurantId, resource, actual, session = null}) {
  const settled = Number(actual);
  if (!Number.isFinite(settled) || settled < 0) return false;
  try {
    const result = await ResourceCounter.updateOne(
      {
        restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
        resource,
        count: {$gt: settled}
      },
      {$set: {count: settled, reconciledAt: new Date()}},
      {session}
    );
    return (result?.modifiedCount ?? 0) > 0;
  } catch (error) {
    /**
     * P2G.8 — INSIDE A TRANSACTION THE ERROR MUST PROPAGATE.
     *
     * Swallowing is right for a sessionless call: reconciliation is
     * best-effort, and a failure leaves the counter high, which refuses a
     * little too much rather than admitting too much.
     *
     * It is WRONG inside a session. Two concurrent cancellations contend on
     * the same counter document and MongoDB raises a write conflict; the
     * transaction is already doomed at that point. Swallowing it lets the
     * caller carry on issuing operations against a dead session, which
     * surfaces as "Transaction has been aborted" from somewhere else entirely
     * — measured as 30 unhandled rejections across the cancellation tests.
     *
     * Rethrowing hands the conflict to `session.withTransaction()`, which
     * retries the whole cancellation. That is exactly the mechanism the
     * driver provides for this, and it is why concurrent cancellations now
     * settle correctly instead of leaking async failures.
     */
    if (session) throw error;
    console.error('Quota sync failed', {resource, message: error?.message});
    return false;
  }
}

/**
 * Hand a reservation back when the create fails after reserving.
 *
 * Best-effort and floored at zero. A lost release is self-correcting: the next
 * reservation reconciles against the real count. A release that drove the
 * counter negative would not be.
 */
export async function releaseQuota({restaurantId, resource, adding = 1, session = null}) {
  try {
    await ResourceCounter.updateOne(
      {
        restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
        resource,
        count: {$gte: adding}
      },
      {$inc: {count: -adding}},
      {session}
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
  restaurantId, resource, limit, countActual, label, adding = 1, session = null,
  reconcile = 'raise'
}, create) {
  const reservation = await reserveQuota({
    restaurantId, resource, limit, countActual, label, adding, session, reconcile
  });
  try {
    return await create();
  } catch (error) {
    /**
     * P2G.3 — DO NOT COMPENSATE A RESERVATION THAT THE TRANSACTION WILL UNDO.
     *
     * When a `session` is supplied the `$inc` above is part of the caller's
     * transaction. If the create then throws, the transaction aborts and
     * MongoDB rolls the increment back for us. Issuing an explicit release as
     * well would decrement a second time — the counter would end up BELOW
     * reality, and reconciliation only ever raises a counter (`$max`), so that
     * drift would not self-heal. Measured before this branch existed: a
     * failed station create left the counter one lower than the true count.
     *
     * The sessionless paths (branches, tables, customers, menu items) still
     * compensate explicitly, because nothing else will.
     */
    if (!reservation.unlimited && !session) {
      await releaseQuota({restaurantId, resource, adding});
    }
    throw error;
  }
}

/**
 * P2G.1 — reserve SEVERAL quotas as one all-or-nothing step.
 *
 * WHY THIS EXISTS
 * ---------------
 * Creating a staff account consumes two separate ceilings: the overall seat
 * count (`maxUsers`) and the per-role count (`maxStaff`). A plan may sell
 * "10 users, of whom 5 may be staff", so both have to hold.
 *
 * `withQuota()` reserves exactly one resource. Calling it twice in sequence is
 * NOT equivalent: if the second reservation is refused, the first has already
 * been consumed, and the caller has leaked a seat that nothing releases until
 * the next reconciliation. Under a burst of concurrent creates that leak is
 * the difference between a plan limit and a suggestion.
 *
 * So the reservations are taken in order and, the moment one is refused, every
 * reservation already taken in this call is handed back before the refusal is
 * rethrown. The caller either holds all of them or none.
 *
 * WHY NOT A TRANSACTION
 * ---------------------
 * Each reservation is already a single-document atomic conditional write, and
 * they touch different documents. Wrapping them in a multi-document
 * transaction would serialise every seat creation on the platform through the
 * transaction machinery to buy a guarantee that compensating release already
 * provides. The failure mode without a transaction is a briefly-held
 * reservation that is then released — which is exactly what the code does
 * explicitly, and what reconciliation would repair anyway.
 *
 * DELIBERATELY NOT CHANGING `withQuota`/`reserveQuota`. Station creation and
 * the branch/table/customer paths already work and are covered by P2E tests;
 * this is additive so none of their behaviour moves.
 */
export async function withCompoundQuota(reservations, create) {
  const taken = [];

  /** Hand back everything reserved so far. Best-effort, never throws. */
  const unwind = async () => {
    for (const held of taken.reverse()) {
      await releaseQuota({
        restaurantId: held.restaurantId, resource: held.resource, adding: held.adding ?? 1
      });
    }
  };

  for (const spec of reservations) {
    try {
      const reservation = await reserveQuota(spec);
      // An unlimited resource writes no counter, so there is nothing to give
      // back and it must not be added to the unwind list.
      if (!reservation.unlimited) {
        taken.push({
          restaurantId: spec.restaurantId, resource: spec.resource, adding: spec.adding ?? 1
        });
      }
    } catch (error) {
      // THE POINT OF THIS FUNCTION: a later refusal must not leave an earlier
      // reservation consumed.
      await unwind();
      throw error;
    }
  }

  try {
    return await create();
  } catch (error) {
    // The create itself failed after every reservation succeeded.
    await unwind();
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
