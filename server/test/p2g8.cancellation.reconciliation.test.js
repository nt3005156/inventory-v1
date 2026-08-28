import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Order, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements
} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {
  monthlyOnlineOrderResource, monthlyOrderResource, reconcileMonthlyOrderQuota
} from '../src/services/orderQuota.js';
import {getOnlineOrderUsage, getOrderUsage} from '../src/services/usage.js';

/**
 * P2G.8 — monthly quota reconciliation on cancellation.
 *
 * THE DEFECT THIS CLOSES, measured end to end through the API:
 *
 *     maxMonthlyOrders = 2
 *     Order A -> 201, Order B -> 201, counter = 2
 *     Cancel A -> 200, countable orders = 1, counter STILL 2
 *     Order C -> 402   ("your plan allows 2 orders and 2 have been placed")
 *
 * The tenant had voided a ticket and could not replace it. `reconcileMonthly-
 * OrderQuota()` existed since P2G.7 but nothing called it.
 *
 * Concurrency is asserted over REPEATED trials — a single clean burst proves
 * nothing about a race.
 */

const DAY = 86_400_000;
const TZ = 'Asia/Kathmandu';
const TRIALS = 6;

let world;
let seq = 0;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  world = await seedWorld();
  await seedPlans();
  await ResourceCounter.createIndexes();
  await Order.syncIndexes();
  __resetBillingEnforcementProbe();
});

async function planWith(limits) {
  const plan = await Plan.create({
    code: `p2g8-${Math.random().toString(36).slice(2, 8)}`,
    name: 'P2G8 Plan', active: true, currency: 'NPR',
    limits: {
      maxBranches: 9, maxUsers: 9, maxMenuItems: 99, maxTables: 99,
      maxCustomers: 999, maxStations: 9, ...limits
    },
    features: {pos: true, inventory: true, kds: true, tables: true, onlineOrdering: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: world.restaurant._id, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  return plan;
}

const ownerToken = () => tokenFor(world.owner);

const placeOrder = () => request('/api/orders', {
  method: 'POST',
  token: ownerToken(),
  body: {branch: String(world.branchA._id), items: [{menuItem: String(world.menu._id), qty: 1}]}
});

const cancelOrder = id => request(`/api/orders/${id}/status`, {
  method: 'PATCH', token: ownerToken(), body: {status: 'cancelled'}
});

/** Write an order row directly, for datasets the API would rate-limit. */
function insertOrder(restaurantId, source = 'pos', {status = 'completed', createdAt} = {}) {
  seq += 1;
  return Order.collection.insertOne({
    orderNo: `P8-${source}-${seq}-${Math.random().toString(36).slice(2, 7)}`,
    restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
    branch: world.branchA._id,
    status, source, createdAt: createdAt || new Date(), total: 100, items: []
  }).then(result => result.insertedId);
}

const overallCounter = (id = world.restaurant._id) =>
  readQuotaCounter(id, monthlyOrderResource(new Date(), TZ));
const onlineCounter = (id = world.restaurant._id) =>
  readQuotaCounter(id, monthlyOnlineOrderResource(new Date(), TZ));

// ── the customer-visible case ────────────────────────────────────────────────

describe('P2G8 · a cancelled order releases its monthly allowance', () => {
  it('THE BRIEF\'S CASE: A, B, cancel A, then C is allowed', async () => {
    await planWith({maxMonthlyOrders: 2});

    const a = await placeOrder();
    const b = await placeOrder();
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(await overallCounter(), 2);

    // Full: a third order is correctly refused.
    assert.equal((await placeOrder()).status, 402);

    assert.equal((await cancelOrder(a.body._id)).status, 200);
    assert.equal(
      await getOrderUsage(world.restaurant._id, {timezone: TZ}), 1,
      'the cancelled order should no longer be countable'
    );
    assert.equal(
      await overallCounter(), 1,
      'the counter did not follow the cancellation'
    );

    // The replacement the tenant paid for.
    assert.equal(
      (await placeOrder()).status, 201,
      'Order C was refused despite the tenant being under their allowance'
    );
  });

  it('leaves counter and reality equal after a cancellation', async () => {
    await planWith({maxMonthlyOrders: 5});
    const created = [];
    for (let i = 0; i < 4; i += 1) created.push((await placeOrder()).body._id);
    assert.equal(await overallCounter(), 4);

    await cancelOrder(created[0]);
    await cancelOrder(created[1]);

    const real = await getOrderUsage(world.restaurant._id, {timezone: TZ});
    assert.equal(real, 2);
    assert.equal(await overallCounter(), real, 'counter and reality diverged');
  });

  it('a POS cancellation touches the overall counter ONLY', async () => {
    await planWith({maxMonthlyOrders: 5, maxMonthlyOnlineOrders: 5});
    const first = (await placeOrder()).body._id;
    await placeOrder();
    // An online order exists too, so the online counter is non-null.
    await insertOrder(world.restaurant._id, 'online');
    await reconcileMonthlyOrderQuota({restaurantId: world.restaurant._id, timezone: TZ});
    const onlineBefore = await onlineCounter();

    await cancelOrder(first);

    assert.equal(await overallCounter(), 2, 'overall should have fallen to 2');
    assert.equal(
      await onlineCounter(), onlineBefore,
      'a POS cancellation moved the online counter'
    );
  });
});

// ── the online path ──────────────────────────────────────────────────────────

describe('P2G8 · rejecting an online order corrects BOTH counters', () => {
  /** Place a real storefront order and return its id. */
  async function placeOnline() {
    const branches = await request('/api/public/branches');
    const branch = (branches.body.branches || branches.body)[0];
    const menu = await request(`/api/public/menu?branch=${branch.id || branch._id}`);
    const item = menu.body.categories.flatMap(category => category.items)[0];
    seq += 1;
    const res = await request('/api/public/orders', {
      method: 'POST',
      body: {
        branch: String(branch.id || branch._id),
        type: 'takeaway',
        paymentMethod: 'cod',
        customer: {name: `Guest ${seq}`, phone: `98${String(10_000_000 + seq)}`},
        items: [{menuItem: String(item.id || item._id), qty: 1}]
      }
    });
    return res;
  }

  /**
   * The public checkout response carries `orderNo`, never `_id` — deliberate,
   * so a guest cannot enumerate internal ids. Staff endpoints take the id, so
   * the test resolves it the way the branch's own UI would: by looking the
   * order up within the tenant.
   */
  async function idOf(publicResponse) {
    const row = await Order.findOne({
      restaurant: world.restaurant._id, orderNo: publicResponse.body.orderNo
    }).select('_id').lean();
    assert.ok(row, `no order found for ${publicResponse.body.orderNo}`);
    return String(row._id);
  }

  it('THE BRIEF\'S EXAMPLE: overall 10/online 4 → 9/3 after one rejection', async () => {
    await planWith({maxMonthlyOrders: 50, maxMonthlyOnlineOrders: 20});
    const id = world.restaurant._id;

    // Six POS + four online = ten countable, four of them online.
    for (let i = 0; i < 6; i += 1) await insertOrder(id, 'pos');
    for (let i = 0; i < 3; i += 1) await insertOrder(id, 'online');
    const target = await insertOrder(id, 'online', {status: 'pending'});

    /**
     * Seed the counters through a real RESERVATION, not through
     * `reconcileMonthlyOrderQuota()`. Reconciliation can only ever LOWER an
     * existing counter — with no document it correctly does nothing, because
     * a tenant who has reserved nothing has nothing to give back. My first
     * version reconciled here and then asserted a counter of 9, getting
     * `null`; the fixture was wrong, not the code.
     */
    await placeOrder();
    assert.equal(await getOrderUsage(id, {timezone: TZ}), 11);
    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 4);
    assert.equal(await overallCounter(), 11, 'the reservation should have seeded the counter');
    // Give the online counter a document too, by placing a real online order.
    const seeded = await placeOnline();
    assert.equal(seeded.status, 201, seeded.body?.message);
    assert.equal(await onlineCounter(), 5);

    const rejected = await request(`/api/online-orders/${target}/reject`, {
      method: 'POST', token: ownerToken(), body: {reason: 'kitchen closed'}
    });
    assert.equal(rejected.status, 200, rejected.body?.message);

    // 12 countable before the rejection (10 seeded + 1 POS + 1 online), 5 online.
    assert.equal(await getOrderUsage(id, {timezone: TZ}), 11);
    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 4);
    assert.equal(await overallCounter(), 11, 'overall counter did not follow');
    assert.equal(await onlineCounter(), 4, 'online counter did not follow');
  });

  it('a rejected online order frees an ONLINE seat for a new storefront order', async () => {
    await planWith({maxMonthlyOrders: 50, maxMonthlyOnlineOrders: 2});

    const first = await placeOnline();
    const second = await placeOnline();
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);

    // Online allowance exhausted.
    const refused = await placeOnline();
    assert.equal(refused.status, 402, 'the online ceiling should be full');

    const rejected = await request(`/api/online-orders/${await idOf(first)}/reject`, {
      method: 'POST', token: ownerToken(), body: {reason: 'out of stock'}
    });
    assert.equal(rejected.status, 200, rejected.body?.message);
    assert.equal(await onlineCounter(), 1, 'the online counter did not follow the rejection');

    const replacement = await placeOnline();
    assert.equal(
      replacement.status, 201,
      'rejecting an online order did not return its online allowance'
    );
  });

  it('an online rejection also frees an OVERALL seat', async () => {
    await planWith({maxMonthlyOrders: 2, maxMonthlyOnlineOrders: 20});
    const online = await placeOnline();
    assert.equal(online.status, 201, online.body?.message);
    assert.equal((await placeOrder()).status, 201);
    // Overall allowance now full.
    assert.equal((await placeOrder()).status, 402);

    const rejectedOverall = await request(`/api/online-orders/${await idOf(online)}/reject`, {
      method: 'POST', token: ownerToken(), body: {reason: 'closed'}
    });
    assert.equal(rejectedOverall.status, 200, rejectedOverall.body?.message);

    assert.equal(await overallCounter(), 1);
    assert.equal(
      (await placeOrder()).status, 201,
      'the overall seat held by the rejected online order was not returned'
    );
  });
});

// ── idempotency ──────────────────────────────────────────────────────────────

describe('P2G8 · repeated cancellation cannot double-adjust', () => {
  it('the API refuses a second cancellation, and the counter is unmoved', async () => {
    await planWith({maxMonthlyOrders: 5});
    const first = (await placeOrder()).body._id;
    await placeOrder();
    await placeOrder();

    assert.equal((await cancelOrder(first)).status, 200);
    assert.equal(await overallCounter(), 2);

    /**
     * `ALLOWED_TRANSITIONS.cancelled` is `[]`, so the existing API already
     * refuses this. That behaviour is PRESERVED, not replaced — the guard is
     * the primary defence and the reconciliation is idempotent underneath it.
     */
    for (let i = 0; i < 3; i += 1) {
      const again = await cancelOrder(first);
      assert.equal(again.status, 409, `attempt ${i + 1} should be refused`);
    }
    assert.equal(await overallCounter(), 2, 'a refused cancellation moved the counter');
    assert.equal(await getOrderUsage(world.restaurant._id, {timezone: TZ}), 2);
  });

  it('reconciliation itself is idempotent — running it repeatedly changes nothing', async () => {
    await planWith({maxMonthlyOrders: 5});
    const first = (await placeOrder()).body._id;
    await placeOrder();
    await cancelOrder(first);
    assert.equal(await overallCounter(), 1);

    for (let i = 0; i < 5; i += 1) {
      await reconcileMonthlyOrderQuota({restaurantId: world.restaurant._id, timezone: TZ});
    }
    assert.equal(await overallCounter(), 1, 'repeated reconciliation drifted the counter');
    assert.equal(await onlineCounter(), null, 'an online counter appeared from nowhere');
  });

  it('the guards themselves are load-bearing, not just the API 409', async () => {
    /**
     * WHY THIS EXISTS — three mutation findings (M2, M3, M8).
     *
     * Removing the `beforeStatus !== 'cancelled'` guard on the POS path, and
     * the `sourceStatus !== 'cancelled'` guard on the merge path, both
     * SURVIVED. So did widening the POS condition to reconcile on every status
     * change. All three survived for the same reason: the API's own
     * transition rules refuse a second cancellation with 409, so the guarded
     * code never runs twice through HTTP, and reconciliation is idempotent
     * anyway so a spurious extra call is invisible.
     *
     * That makes the guards defence-in-depth rather than the primary
     * protection — but they are not decoration, and their absence should not
     * be invisible. Asserted here at the level they actually operate: the
     * conditions in the source, plus the behaviour that justifies them.
     */
    const {readFileSync} = await import('node:fs');
    const ops = readFileSync(new URL('../src/routes/operations.js', import.meta.url), 'utf8');
    const tables = readFileSync(new URL('../src/services/tables.js', import.meta.url), 'utf8');

    // Only the transition INTO cancelled reconciles — not every kitchen tick.
    assert.match(
      ops, /status==='cancelled'&&beforeStatus!=='cancelled'\)await reconcileMonthlyOrderQuota/,
      'the POS path must reconcile only on the transition into cancelled'
    );
    // The merge path guards on the source order's previous status.
    assert.match(
      tables, /sourceStatus !== 'cancelled' && source\.restaurant/,
      'the merge path lost its already-cancelled guard'
    );

    /**
     * And the behavioural half: reconciling an ALREADY reconciled tenant is a
     * no-op, which is what makes the guards safe to be defence-in-depth
     * rather than load-bearing.
     */
    await planWith({maxMonthlyOrders: 5});
    const first = (await placeOrder()).body._id;
    await placeOrder();
    await cancelOrder(first);
    const settledCounter = await overallCounter();

    for (let i = 0; i < 4; i += 1) {
      await reconcileMonthlyOrderQuota({restaurantId: world.restaurant._id, timezone: TZ});
      assert.equal(
        await overallCounter(), settledCounter,
        `reconciliation ${i + 1} moved a counter that was already correct`
      );
    }
  });

  it('a sessionless reconciliation failure is swallowed, not thrown', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding (M15). Making `syncQuotaCounter`
     * always rethrow survived, because no test drove a FAILING sessionless
     * call.
     *
     * The asymmetry is deliberate and both halves matter:
     *   with a session -> rethrow, so `withTransaction` can retry a write
     *                     conflict (without this, 30 unhandled rejections
     *                     were measured across these tests)
     *   sessionless    -> swallow, because reconciliation is best-effort and
     *                     must never take down a caller that has already done
     *                     its real work
     */
    const {syncQuotaCounter, ResourceCounter: Counter} =
      await import('../src/services/quotaGuard.js');
    const id = world.restaurant._id;
    await Counter.create({restaurant: id, resource: 'p2g8-fail', count: 5});

    const original = Counter.updateOne.bind(Counter);
    Counter.updateOne = async function exploding() {
      throw new Error('write conflict');
    };
    try {
      let result;
      await assert.doesNotReject(
        async () => {
          result = await syncQuotaCounter({
            restaurantId: id, resource: 'p2g8-fail', actual: 2
          });
        },
        'a sessionless reconciliation failure must not propagate'
      );
      assert.equal(result, false, 'a failed sync should report false');
    } finally {
      Counter.updateOne = original;
    }

    // The counter is untouched — high rather than wrong-low.
    assert.equal(await readQuotaCounter(id, 'p2g8-fail'), 5);
  });

  it('reconciliation never RAISES a counter, so it cannot invent allowance', async () => {
    /**
     * The safety property that lets this run outside the reservation's atomic
     * write: `syncQuotaCounter` only writes when the counter is strictly above
     * reality. If it could raise, a reconciliation racing a live reservation
     * would hand back a seat that had just been taken.
     */
    await planWith({maxMonthlyOrders: 10});
    const id = world.restaurant._id;
    await placeOrder();
    assert.equal(await overallCounter(), 1);

    // Reality is well above the counter; reconciliation must not follow it up.
    for (let i = 0; i < 5; i += 1) await insertOrder(id, 'pos');
    assert.equal(await getOrderUsage(id, {timezone: TZ}), 6);

    await reconcileMonthlyOrderQuota({restaurantId: id, timezone: TZ});
    assert.equal(
      await overallCounter(), 1,
      'reconciliation raised the counter — it must only ever lower'
    );
  });
});

// ── concurrency ──────────────────────────────────────────────────────────────

describe('P2G8 · concurrent create and cancel stay consistent', () => {
  it(`create and cancel racing, ${TRIALS} trials, counter never below reality`, async () => {
    await planWith({maxMonthlyOrders: 20});
    const id = world.restaurant._id;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await Order.deleteMany({restaurant: id});
      await ResourceCounter.deleteMany({restaurant: id});

      // Four existing orders, two of which will be cancelled mid-burst.
      const existing = [];
      for (let i = 0; i < 4; i += 1) existing.push((await placeOrder()).body._id);

      await Promise.allSettled([
        cancelOrder(existing[0]),
        cancelOrder(existing[1]),
        placeOrder(),
        placeOrder(),
        placeOrder()
      ]);

      const real = await getOrderUsage(id, {timezone: TZ});
      const counter = await overallCounter();
      /**
       * The counter may legitimately sit ABOVE reality for an instant — a
       * reservation raises it before its order row commits, and a
       * reconciliation that ran a moment earlier will not have seen it. It
       * must NEVER sit below, which would hand out allowance that is already
       * spent.
       */
      assert.ok(
        counter >= real,
        `trial ${trial}: counter ${counter} BELOW reality ${real} — allowance was invented`
      );
      assert.ok(
        counter - real <= 3,
        `trial ${trial}: counter ${counter} far above reality ${real}`
      );
    }
  });

  it(`concurrent cancellation of several orders, ${TRIALS} trials`, async () => {
    await planWith({maxMonthlyOrders: 20});
    const id = world.restaurant._id;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await Order.deleteMany({restaurant: id});
      await ResourceCounter.deleteMany({restaurant: id});

      const created = [];
      for (let i = 0; i < 5; i += 1) created.push((await placeOrder()).body._id);
      assert.equal(await overallCounter(), 5);

      // Cancel four of the five at once.
      const results = await Promise.allSettled(created.slice(0, 4).map(cancelOrder));
      const accepted = results.filter(
        r => r.status === 'fulfilled' && r.value.status === 200
      ).length;
      assert.equal(accepted, 4, `trial ${trial}: only ${accepted} cancellations succeeded`);

      const real = await getOrderUsage(id, {timezone: TZ});
      assert.equal(real, 1, `trial ${trial}: expected one live order`);
      assert.equal(
        await overallCounter(), 1,
        `trial ${trial}: concurrent cancellations left the counter wrong`
      );
    }
  });

  it('the ceiling still holds under a cancel/create burst', async () => {
    // The counter being corrected must not become a way to exceed the plan.
    await planWith({maxMonthlyOrders: 3});
    const id = world.restaurant._id;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await Order.deleteMany({restaurant: id});
      await ResourceCounter.deleteMany({restaurant: id});

      const first = (await placeOrder()).body._id;
      await Promise.allSettled([
        cancelOrder(first),
        ...Array.from({length: 6}, () => placeOrder())
      ]);

      const real = await getOrderUsage(id, {timezone: TZ});
      assert.ok(real <= 3, `trial ${trial}: ceiling breached, ${real} countable orders`);
    }
  });
});

// ── transaction behaviour ────────────────────────────────────────────────────

describe('P2G8 · reconciliation joins the cancellation transaction', () => {
  it('counts INSIDE the session, seeing the uncommitted cancellation', async () => {
    /**
     * The whole reason `getOrderUsage` gained an optional `session`. A
     * sessionless count would read the pre-cancellation figure and "correct"
     * the counter to the wrong number.
     */
    await planWith({maxMonthlyOrders: 5});
    const id = world.restaurant._id;
    await insertOrder(id, 'pos');
    await insertOrder(id, 'pos');
    await insertOrder(id, 'pos');

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const order = await Order.findOne({restaurant: id}).session(session);
        order.status = 'cancelled';
        await order.save({session});

        const inside = await getOrderUsage(id, {timezone: TZ, session});
        const outside = await getOrderUsage(id, {timezone: TZ});
        assert.equal(inside, 2, 'the session count did not see its own cancellation');
        assert.equal(outside, 3, 'the sessionless count saw an uncommitted change');
      });
    } finally {
      await session.endSession();
    }
  });

  it('a failed cancellation rolls the counter correction back with it', async () => {
    await planWith({maxMonthlyOrders: 5});
    const id = world.restaurant._id;
    const first = (await placeOrder()).body._id;
    await placeOrder();
    assert.equal(await overallCounter(), 2);

    // Make the audit write fail, aborting the whole cancellation transaction.
    const {Audit} = await import('../src/models/index.js');
    const original = Audit.create.bind(Audit);
    let armed = true;
    Audit.create = async function patched(...args) {
      if (armed) {
        armed = false;
        throw new Error('audit exploded');
      }
      return original(...args);
    };
    let failed;
    try {
      failed = await cancelOrder(first);
    } finally {
      Audit.create = original;
    }

    assert.notEqual(failed.status, 200, 'the cancellation should have failed');
    // The order is still live...
    const order = await Order.findById(first);
    assert.notEqual(order.status, 'cancelled', 'the cancellation was not rolled back');
    // ...so the counter must NOT have been lowered.
    assert.equal(
      await overallCounter(), 2,
      'the counter was lowered by a cancellation that never committed'
    );
    assert.equal(await getOrderUsage(id, {timezone: TZ}), 2);
  });

  it('does not reconcile on non-cancelling status changes', async () => {
    // Reconciliation costs two counts; it must not run on every kitchen tick.
    await planWith({maxMonthlyOrders: 5});
    const id = (await placeOrder()).body._id;

    for (const status of ['confirmed', 'preparing', 'ready', 'completed']) {
      const res = await request(`/api/orders/${id}/status`, {
        method: 'PATCH', token: ownerToken(), body: {status}
      });
      assert.equal(res.status, 200, `${status}: ${res.body?.message}`);
    }
    // Still exactly one countable order and one counted seat.
    assert.equal(await getOrderUsage(world.restaurant._id, {timezone: TZ}), 1);
    assert.equal(await overallCounter(), 1);
  });
});

// ── the merge path ───────────────────────────────────────────────────────────

describe('P2G8 · merging tables cancels a check and returns its seat', () => {
  it('a merged-away order stops consuming monthly allowance', async () => {
    /**
     * `mergeTableOrders()` is one of only three places that write
     * `Order.status = 'cancelled'`, and it is easy to miss because it lives in
     * the table service rather than an order route. Missing it would let a
     * busy dining room silently erode its own monthly allowance by merging
     * checks.
     */
    await planWith({maxMonthlyOrders: 3});
    const id = world.restaurant._id;

    const second = await RestaurantTable.create({
      branch: world.branchA._id, name: 'P2G8-Merge', area: 'Main Hall', seats: 4
    });

    // Two dine-in checks, one per table. `type: 'dine-in'` matters — a table
    // order without it is refused.
    const seat = async table => {
      const res = await request('/api/orders', {
        method: 'POST', token: ownerToken(),
        body: {
          branch: String(world.branchA._id), type: 'dine-in', table: String(table),
          items: [{menuItem: String(world.menu._id), qty: 1}]
        }
      });
      assert.equal(res.status, 201, res.body?.message);
      return res.body;
    };
    await seat(world.table._id);
    await seat(second._id);
    assert.equal(await overallCounter(), 2);

    const merged = await request(`/api/tables/${world.table._id}/merge`, {
      method: 'POST', token: ownerToken(), body: {intoTable: String(second._id)}
    });
    assert.equal(merged.status, 200, merged.body?.message);

    const real = await getOrderUsage(id, {timezone: TZ});
    assert.equal(real, 1, 'the merged-away check should no longer be countable');
    assert.equal(
      await overallCounter(), real,
      'merging a table did not return the cancelled check\'s allowance'
    );

    // And the freed seat is genuinely spendable.
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 402);
  });
});

// ── the reservation path must not have moved ─────────────────────────────────

describe('P2G8 · the $set reservation race is NOT reintroduced', () => {
  it('the reservation path still reconciles upward only', async () => {
    /**
     * P2G.7 removed an unconditional `$set` from the reservation path because
     * it discarded concurrent increments and broke the ceiling. This phase
     * adds downward reconciliation on a DIFFERENT path (cancellation), and
     * must not have put it back on the hot one.
     */
    const {readFileSync} = await import('node:fs');
    const guard = readFileSync(
      new URL('../src/services/quotaGuard.js', import.meta.url), 'utf8'
    );
    const reserve = guard.slice(
      guard.indexOf('export async function reserveQuota'),
      guard.indexOf('export async function syncQuotaCounter')
    );
    /**
     * Only the EXECUTABLE lines are scanned. My first version matched the
     * whole slice and failed on the block comment that explains the removed
     * `$set` — a faulty assertion, not a regression. `$set: {reconciledAt}` is
     * also fine: it writes a diagnostic timestamp, never the count.
     */
    const code = reserve
      .split('\n')
      .filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .join('\n');
    assert.ok(
      !/\$set:\s*\{\s*count:/.test(code),
      `an unconditional $set of the count is back on the reservation path:\n${code}`
    );
    assert.match(code, /\$max: \{count: actual\}/);
  });

  it('a wide cold burst still holds the ceiling exactly', async () => {
    await planWith({maxMonthlyOrders: 2});
    const id = world.restaurant._id;

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await Order.deleteMany({restaurant: id});
      await ResourceCounter.deleteMany({restaurant: id});
      invalidateEntitlements();
      __resetBillingEnforcementProbe();

      await Promise.allSettled(Array.from({length: 8}, () => placeOrder()));
      assert.equal(
        await getOrderUsage(id, {timezone: TZ}), 2,
        `trial ${trial}: ceiling breached`
      );
    }
  });
});
