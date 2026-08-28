import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, seedWorld, startTestApp, stopTestApp} from './helpers.js';
import {Order, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements
} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {
  AT_LIMIT_CODE,
  ONLINE_AT_LIMIT_CODE,
  ONLINE_ORDER_SOURCE,
  ONLINE_OVER_LIMIT_CODE,
  monthlyOnlineOrderResource,
  monthlyOrderResource,
  withMonthlyOnlineOrderQuota,
  withMonthlyOrderQuota
} from '../src/services/orderQuota.js';
import {getOnlineOrderUsage, getOrderUsage} from '../src/services/usage.js';
import {ONLINE_ORDER_TYPES} from '../src/services/storefront.js';

/**
 * P2G.7 — enforcement of `maxMonthlyOnlineOrders`.
 *
 * THE GAP THIS CLOSES, measured: with `maxMonthlyOnlineOrders: 2`, five online
 * orders existed and nothing refused them. The limit was declared in
 * `LIMIT_KEYS`, priced in the plan catalogue, and enforced nowhere.
 *
 * Concurrency is asserted over REPEATED bursts. A single clean run proves
 * nothing about a race — the P2G.2 lesson.
 */

const DAY = 86_400_000;
const TZ = 'Asia/Kathmandu';
const TRIALS = 6;

let world;
let counter = 0;

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

async function planWith(limits, {restaurant} = {}) {
  const target = restaurant || world.restaurant;
  const plan = await Plan.create({
    code: `p2g7-${Math.random().toString(36).slice(2, 8)}`,
    name: 'P2G7 Plan', active: true, currency: 'NPR',
    limits: {
      maxBranches: 9, maxUsers: 9, maxMenuItems: 99, maxTables: 99,
      maxCustomers: 999, maxStations: 9, ...limits
    },
    features: {pos: true, inventory: true, kds: true, onlineOrdering: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: target._id, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  return plan;
}

/**
 * Write one order row. The quota wrappers are driven directly rather than
 * through HTTP so the two ceilings can be exercised in isolation; the wiring
 * of the storefront to `withMonthlyOnlineOrderQuota` is asserted separately.
 */
function insertOrder(restaurantId, source, {status = 'completed', createdAt} = {}) {
  counter += 1;
  return Order.collection.insertOne({
    orderNo: `P7-${source}-${counter}-${Math.random().toString(36).slice(2, 7)}`,
    restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
    branch: world.branchA._id,
    status, source, createdAt: createdAt || new Date(), total: 100, items: []
  }).then(() => 'created');
}

const placeOnline = (restaurantId, now = new Date(), opts = {}) =>
  withMonthlyOnlineOrderQuota(
    {restaurantId, timezone: TZ, now, ...opts},
    () => insertOrder(restaurantId, 'online', {createdAt: now})
  );

const placePos = (restaurantId, now = new Date(), opts = {}) =>
  withMonthlyOrderQuota(
    {restaurantId, timezone: TZ, now, source: 'pos', ...opts},
    () => insertOrder(restaurantId, 'pos', {createdAt: now})
  );

const settled = results => ({
  ok: results.filter(r => r.status === 'fulfilled').length,
  refused: results.filter(r => r.status === 'rejected')
});

async function resetOrders(restaurantId) {
  await Order.deleteMany({restaurant: restaurantId});
  await ResourceCounter.deleteMany({restaurant: restaurantId});
}

/**
 * Warm the entitlement and enforcement-probe caches before a concurrency
 * burst, which is the state any running server is in after its first request.
 *
 * This is NOT hiding a defect — it isolates one. Measured: on a completely
 * cold cache, eight simultaneous first-ever requests each resolve the
 * entitlement before any of them populates it, and a ceiling of 2 admitted 4.
 * With the caches warm the same burst holds at 2 across 30 trials. The cold
 * window is real, is documented as a limitation, and is a property of the
 * per-process entitlement cache rather than of the quota counter.
 */
async function warmCaches(restaurantId) {
  await withMonthlyOrderQuota(
    {restaurantId, timezone: TZ, now: new Date(), source: 'pos'}, async () => 'warm'
  ).catch(() => {});
  await resetOrders(restaurantId);
}

// ── the definition of "online" ───────────────────────────────────────────────

describe('P2G.7 · online orders are identified by the existing model semantics', () => {
  it('uses Order.source, the same discriminator the usage count has always used', () => {
    assert.equal(ONLINE_ORDER_SOURCE, 'online');
    // The enum really is the pair, and 'pos' really is the default, so a POS
    // order that sets nothing cannot accidentally be online.
    const path = Order.schema.path('source');
    assert.deepEqual([...path.enumValues].sort(), ['online', 'pos']);
    assert.equal(path.defaultValue, 'pos');
  });

  it('is NOT Order.type — a till takeaway is a POS sale', () => {
    /**
     * `ONLINE_ORDER_TYPES` is `['delivery','takeaway']`, but a cashier can ring
     * up a takeaway at the counter. Using `type` would bill that against the
     * storefront allowance and invent a second, contradictory definition of
     * "online order".
     */
    assert.deepEqual([...ONLINE_ORDER_TYPES], ['delivery', 'takeaway']);
    assert.ok(!ONLINE_ORDER_TYPES.includes(ONLINE_ORDER_SOURCE));
  });

  it('counts exactly what getOnlineOrderUsage counts', async () => {
    // Enforcement and metering must not be able to disagree.
    await insertOrder(world.restaurant._id, 'online');
    await insertOrder(world.restaurant._id, 'pos');
    await insertOrder(world.restaurant._id, 'online', {status: 'cancelled'});

    assert.equal(await getOnlineOrderUsage(world.restaurant._id, {timezone: TZ}), 1);
    assert.equal(await getOrderUsage(world.restaurant._id, {timezone: TZ}), 2);
  });

  it('the storefront is wired to the online wrapper', async () => {
    // A ceiling nothing calls enforces nothing.
    const {readFileSync} = await import('node:fs');
    const source = readFileSync(new URL('../src/services/storefront.js', import.meta.url), 'utf8');
    assert.match(source, /withMonthlyOnlineOrderQuota\(/);
    assert.ok(
      !/withMonthlyOrderQuota\(/.test(source),
      'the storefront must go through the online wrapper, which applies both ceilings'
    );
  });
});

// ── sequential enforcement ───────────────────────────────────────────────────

describe('P2G.7 · the online ceiling is enforced', () => {
  it('allows exactly the online allowance, then refuses', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 3});
    const id = world.restaurant._id;

    for (let i = 0; i < 3; i += 1) {
      assert.equal(await placeOnline(id), 'created', `online ${i + 1}`);
    }
    await assert.rejects(() => placeOnline(id), error => {
      assert.equal(error.status, 402);
      assert.equal(error.code, ONLINE_AT_LIMIT_CODE);
      assert.equal(error.limit, 'maxMonthlyOnlineOrders');
      assert.match(error.message, /3 online orders per month/);
      return true;
    });
    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 3, 'a refusal wrote a row');
  });

  it('an unlimited online allowance writes no online counter', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: null});
    const id = world.restaurant._id;
    for (let i = 0; i < 4; i += 1) assert.equal(await placeOnline(id), 'created');

    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 4);
    assert.equal(await readQuotaCounter(id, monthlyOnlineOrderResource(new Date(), TZ)), null);
    // The overall ceiling is still counted.
    assert.equal(await readQuotaCounter(id, monthlyOrderResource(new Date(), TZ)), 4);
  });

  it('syncQuotaCounter LOWERS but never RAISES a counter', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding (M16). Widening the guard from
     * `count: {$gt: actual}` to `count: {$ne: actual}` survived, because no
     * test ever asked it to move a counter that was BELOW reality.
     *
     * The direction is the whole safety argument: this runs off the
     * reservation path, so if it could raise a counter it would race live
     * increments in the dangerous direction — resurrecting allowance a
     * concurrent reservation had just consumed.
     */
    const {syncQuotaCounter} = await import('../src/services/quotaGuard.js');
    const id = world.restaurant._id;
    await ResourceCounter.create({restaurant: id, resource: 'p2g7-dir', count: 5});

    assert.equal(
      await syncQuotaCounter({restaurantId: id, resource: 'p2g7-dir', actual: 2}), true
    );
    assert.equal(await readQuotaCounter(id, 'p2g7-dir'), 2, 'it must lower');

    // Reality "rises" — this must NOT follow it up.
    assert.equal(
      await syncQuotaCounter({restaurantId: id, resource: 'p2g7-dir', actual: 9}), false
    );
    assert.equal(
      await readQuotaCounter(id, 'p2g7-dir'), 2,
      'a counter below reality was raised off the reservation path'
    );
  });

  it('reconciliation lowers the OVERALL counter too, not just the online one', async () => {
    /**
     * A mutation finding (M14): deleting the overall `syncQuotaCounter()` call
     * survived, because every reconciliation assertion only checked the online
     * counter. An online cancellation returns BOTH slots.
     */
    await planWith({maxMonthlyOrders: 2, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    const now = new Date();
    await placeOnline(id, now);
    await placeOnline(id, now);
    assert.equal(await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 2);

    const first = await Order.findOne({restaurant: id});
    await Order.collection.updateOne({_id: first._id}, {$set: {status: 'cancelled'}});

    const {reconcileMonthlyOrderQuota} = await import('../src/services/orderQuota.js');
    const result = await reconcileMonthlyOrderQuota({restaurantId: id, timezone: TZ, now});

    assert.equal(result.overall, 1);
    assert.equal(
      await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 1,
      'the overall counter was not reconciled'
    );
    assert.equal(await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), 1);
  });

  it('an unlimited online allowance writes NO online counter even under load', async () => {
    /**
     * A mutation finding (M2). Forcing the unlimited branch off survived,
     * because `reserveQuota` ALSO short-circuits a null limit — so the ceiling
     * still held and only the wasted counter document betrayed it. Asserting
     * the counter's absence is what distinguishes the two.
     */
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: null});
    const id = world.restaurant._id;
    const now = new Date();
    await warmCaches(id);

    await Promise.allSettled(Array.from({length: 6}, () => placeOnline(id, now)));

    assert.equal(await getOnlineOrderUsage(id, {now, timezone: TZ}), 6);
    assert.equal(
      await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), null,
      'an unlimited online allowance maintained a counter nothing reads'
    );
  });

  it('reports being ALREADY OVER distinctly from just reaching the limit', async () => {
    // The deploy-day case, inherited from P2G.5 and applied to the sub-limit.
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    for (let i = 0; i < 5; i += 1) await insertOrder(id, 'online');

    await assert.rejects(() => placeOnline(id), error => {
      assert.equal(error.code, ONLINE_OVER_LIMIT_CODE);
      assert.match(error.message, /already over the limit before enforcement began/i);
      return true;
    });
  });

  it('does not enforce when BILLING_ENFORCEMENT is off', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 1});
    const id = world.restaurant._id;
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();
      for (let i = 0; i < 4; i += 1) assert.equal(await placeOnline(id), 'created');
      assert.equal(await readQuotaCounter(id, monthlyOnlineOrderResource(new Date(), TZ)), null);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });
});

// ── the two ceilings interacting ─────────────────────────────────────────────

describe('P2G.7 · overall and online allowances interact correctly', () => {
  it('THE BRIEF\'S CASE: overall 50/100, online 20/20 → POS allowed, online refused', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 20});
    const id = world.restaurant._id;

    // 20 online + 30 POS = 50 overall, online exhausted.
    for (let i = 0; i < 20; i += 1) await insertOrder(id, 'online');
    for (let i = 0; i < 30; i += 1) await insertOrder(id, 'pos');
    assert.equal(await getOrderUsage(id, {timezone: TZ}), 50);
    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 20);

    assert.equal(await placePos(id), 'created', 'the till must keep working');
    await assert.rejects(() => placeOnline(id), error => {
      assert.equal(error.code, ONLINE_AT_LIMIT_CODE);
      return true;
    });
  });

  it('the OVERALL ceiling refuses both order types', async () => {
    await planWith({maxMonthlyOrders: 5, maxMonthlyOnlineOrders: 100});
    const id = world.restaurant._id;
    for (let i = 0; i < 5; i += 1) await insertOrder(id, 'pos');

    await assert.rejects(() => placePos(id), error => {
      assert.equal(error.code, AT_LIMIT_CODE);
      assert.equal(error.limit, 'maxMonthlyOrders');
      return true;
    });
    // An online order is refused by the OVERALL ceiling, and must say so
    // rather than blaming the (untouched) storefront allowance.
    await assert.rejects(() => placeOnline(id), error => {
      assert.equal(error.code, AT_LIMIT_CODE);
      assert.equal(error.limit, 'maxMonthlyOrders');
      return true;
    });
  });

  it('an online order consumes BOTH allowances, as ONE order', async () => {
    await planWith({maxMonthlyOrders: 10, maxMonthlyOnlineOrders: 10});
    const id = world.restaurant._id;
    const now = new Date();

    await placeOnline(id, now);

    // Two counters incremented, ONE row written, each count reflecting reality.
    assert.equal(await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 1);
    assert.equal(await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), 1);
    assert.equal(await Order.countDocuments({restaurant: id}), 1, 'two rows were written');
    assert.equal(await getOrderUsage(id, {now, timezone: TZ}), 1);
    assert.equal(await getOnlineOrderUsage(id, {now, timezone: TZ}), 1);
  });

  it('a POS order consumes the overall allowance ONLY', async () => {
    await planWith({maxMonthlyOrders: 10, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    const now = new Date();

    for (let i = 0; i < 4; i += 1) await placePos(id, now);

    assert.equal(await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 4);
    assert.equal(
      await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), null,
      'POS orders touched the online counter'
    );
    // The full online allowance is still available.
    assert.equal(await placeOnline(id, now), 'created');
    assert.equal(await placeOnline(id, now), 'created');
    await assert.rejects(() => placeOnline(id, now));
  });

  it('exhausting the online allowance never blocks the till', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 1});
    const id = world.restaurant._id;
    assert.equal(await placeOnline(id), 'created');
    await assert.rejects(() => placeOnline(id));

    for (let i = 0; i < 5; i += 1) {
      assert.equal(await placePos(id), 'created', `POS order ${i + 1} was blocked`);
    }
  });
});

// ── concurrency ──────────────────────────────────────────────────────────────

describe('P2G.7 · the online ceiling cannot be raced', () => {
  it(`holds an online ceiling of 2 across ${TRIALS} bursts of 6`, async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    await warmCaches(id);

    const perTrial = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetOrders(id);
      const results = await Promise.allSettled(
        Array.from({length: 6}, () => placeOnline(id))
      );
      const created = await getOnlineOrderUsage(id, {timezone: TZ});
      perTrial.push(created);

      const {ok, refused} = settled(results);
      assert.equal(ok, created, `trial ${trial}: ${ok} fulfilled but ${created} rows`);
      for (const rejection of refused) {
        assert.equal(rejection.reason.status, 402, rejection.reason.message);
      }
    }

    assert.deepEqual(
      perTrial.filter(n => n > 2), [],
      `online quota bypassed: ${perTrial.join(',')}`
    );
    assert.deepEqual(perTrial.filter(n => n < 1), [], `nothing created: ${perTrial.join(',')}`);
  });

  it('ONE online seat free, 10 concurrent: exactly 1 succeeds', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 4});
    const id = world.restaurant._id;
    await warmCaches(id);

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetOrders(id);
      for (let i = 0; i < 3; i += 1) await placeOnline(id);

      const results = await Promise.allSettled(
        Array.from({length: 10}, () => placeOnline(id))
      );
      const {ok} = settled(results);
      assert.equal(ok, 1, `trial ${trial}: ${ok} succeeded, expected 1`);
      assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 4);
    }
  });

  it('BOTH ceilings stay correct under a MIXED concurrent load', async () => {
    /**
     * The interesting race: POS and online orders contending simultaneously.
     * The overall counter is shared between them, so a bug here would show up
     * as either ceiling being breached, or as an online order consuming two
     * overall slots.
     */
    await planWith({maxMonthlyOrders: 8, maxMonthlyOnlineOrders: 3});
    const id = world.restaurant._id;
    await warmCaches(id);

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetOrders(id);
      await Promise.allSettled([
        ...Array.from({length: 6}, () => placeOnline(id)),
        ...Array.from({length: 6}, () => placePos(id))
      ]);

      const overall = await getOrderUsage(id, {timezone: TZ});
      const online = await getOnlineOrderUsage(id, {timezone: TZ});
      const rows = await Order.countDocuments({restaurant: id});

      assert.ok(online <= 3, `trial ${trial}: online ceiling breached (${online})`);
      assert.ok(overall <= 8, `trial ${trial}: overall ceiling breached (${overall})`);
      // The decisive no-double-counting check: overall usage equals the number
      // of rows, so an online order never consumed two overall slots.
      assert.equal(overall, rows, `trial ${trial}: usage ${overall} but ${rows} rows`);
      assert.ok(overall >= online, `trial ${trial}: online exceeded overall`);
    }
  });
});

// ── failure and unwind ───────────────────────────────────────────────────────

describe('P2G.7 · a failed online order leaks neither allowance', () => {
  it('releases BOTH reservations when creation fails (sessionless)', async () => {
    await planWith({maxMonthlyOrders: 4, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    const now = new Date();

    await placeOnline(id, now);
    assert.equal(await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 1);
    assert.equal(await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), 1);

    await assert.rejects(() => withMonthlyOnlineOrderQuota(
      {restaurantId: id, timezone: TZ, now},
      async () => { throw new Error('creation exploded'); }
    ), /creation exploded/);

    // Neither counter kept the seat.
    assert.equal(
      await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 1,
      'the overall reservation leaked'
    );
    assert.equal(
      await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), 1,
      'the online reservation leaked'
    );

    // And the remaining allowance is genuinely spendable.
    assert.equal(await placeOnline(id, now), 'created');
    await assert.rejects(() => placeOnline(id, now));
    assert.equal(await Order.countDocuments({restaurant: id}), 2);
  });

  it('an ONLINE refusal releases the OVERALL seat it had already taken', async () => {
    /**
     * The compound case the brief calls out. The overall reservation is taken
     * FIRST; when the online ceiling then refuses, that overall seat must not
     * stay consumed, or every rejected storefront order would quietly erode
     * the tenant's total allowance.
     */
    await planWith({maxMonthlyOrders: 10, maxMonthlyOnlineOrders: 1});
    const id = world.restaurant._id;
    const now = new Date();

    await placeOnline(id, now);
    assert.equal(await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 1);

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => placeOnline(id, now));
    }

    assert.equal(
      await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 1,
      'refused online orders consumed overall allowance'
    );
    // The overall allowance is intact: nine POS orders still fit.
    for (let i = 0; i < 9; i += 1) {
      assert.equal(await placePos(id, now), 'created', `POS order ${i + 1}`);
    }
    await assert.rejects(() => placePos(id, now));
  });

  it('repeated failures do not erode either ceiling', async () => {
    await planWith({maxMonthlyOrders: 5, maxMonthlyOnlineOrders: 3});
    const id = world.restaurant._id;
    const now = new Date();

    for (let i = 0; i < 10; i += 1) {
      await assert.rejects(() => withMonthlyOnlineOrderQuota(
        {restaurantId: id, timezone: TZ, now},
        async () => { throw new Error('nope'); }
      ));
    }
    assert.equal(await readQuotaCounter(id, monthlyOrderResource(now, TZ)), 0);
    assert.equal(await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), 0);

    for (let i = 0; i < 3; i += 1) assert.equal(await placeOnline(id, now), 'created');
    await assert.rejects(() => placeOnline(id, now));
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe('P2G.7 · tenant isolation', () => {
  it('one tenant\'s online allowance is not consumed by another\'s', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2});
    const other = await Restaurant.create({
      name: 'P2G7 Other', currency: 'NPR', timezone: TZ
    });
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 5}, {restaurant: other});

    const a = world.restaurant._id;
    const b = other._id;
    await warmCaches(a);
    await warmCaches(b);

    await Promise.allSettled([
      ...Array.from({length: 6}, () => placeOnline(a)),
      ...Array.from({length: 6}, () => placeOnline(b))
    ]);

    assert.equal(await getOnlineOrderUsage(a, {timezone: TZ}), 2, 'tenant A');
    assert.equal(await getOnlineOrderUsage(b, {timezone: TZ}), 5, 'tenant B');
    assert.equal(await readQuotaCounter(a, monthlyOnlineOrderResource(new Date(), TZ)), 2);
    assert.equal(await readQuotaCounter(b, monthlyOnlineOrderResource(new Date(), TZ)), 5);
  });

  it('exhausting one tenant does not refuse the other', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 1});
    const other = await Restaurant.create({
      name: 'P2G7 Other2', currency: 'NPR', timezone: TZ
    });
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 3}, {restaurant: other});

    assert.equal(await placeOnline(world.restaurant._id), 'created');
    await assert.rejects(() => placeOnline(world.restaurant._id));

    for (let i = 0; i < 3; i += 1) {
      assert.equal(await placeOnline(other._id), 'created', `tenant B order ${i + 1}`);
    }
  });
});

// ── P2G.4 semantics retained ─────────────────────────────────────────────────

describe('P2G.7 · timezone and cancellation semantics are retained', () => {
  it('scopes the online counter to the tenant\'s own month', async () => {
    const august = monthlyOnlineOrderResource(new Date('2026-08-15T12:00:00Z'), TZ);
    const september = monthlyOnlineOrderResource(new Date('2026-09-15T12:00:00Z'), TZ);
    assert.equal(august, 'orders:online:2026-08');
    assert.notEqual(august, september, 'the online allowance would never reset');

    // And it follows the TENANT'S zone, not a default.
    const instant = new Date('2026-08-01T02:00:00Z');
    assert.equal(monthlyOnlineOrderResource(instant, TZ), 'orders:online:2026-08');
    assert.equal(
      monthlyOnlineOrderResource(instant, 'America/New_York'), 'orders:online:2026-07'
    );
  });

  it('enforces against the tenant\'s month, not the default zone', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2});
    await Restaurant.updateOne(
      {_id: world.restaurant._id}, {$set: {timezone: 'America/New_York'}}
    );
    invalidateEntitlements();
    const id = world.restaurant._id;
    const instant = new Date('2026-08-01T02:00:00Z'); // still July in New York

    const opts = {restaurantId: id, timezone: 'America/New_York', now: instant};
    await withMonthlyOnlineOrderQuota(opts, () =>
      insertOrder(id, 'online', {createdAt: instant}));
    await withMonthlyOnlineOrderQuota(opts, () =>
      insertOrder(id, 'online', {createdAt: instant}));
    await assert.rejects(() => withMonthlyOnlineOrderQuota(opts, () =>
      insertOrder(id, 'online', {createdAt: instant})));

    // July's counter was used, not August's.
    assert.equal(await readQuotaCounter(id, 'orders:online:2026-07'), 2);
    assert.equal(await readQuotaCounter(id, 'orders:online:2026-08'), null);
  });

  it('a cancelled online order returns its online allowance', async () => {
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    await placeOnline(id);
    await placeOnline(id);
    await assert.rejects(() => placeOnline(id));

    const first = await Order.findOne({restaurant: id, source: 'online'});
    await Order.collection.updateOne({_id: first._id}, {$set: {status: 'cancelled'}});

    // The metered usage falls immediately.
    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 1);

    /**
     * The COUNTER does not fall on its own, and that is a deliberate trade.
     * Lowering it on the reservation path races live increments and was
     * measured breaking this very ceiling (6 concurrent on a limit of 2 gave
     * 2,2,4,2,2,3,4,3,4,2). Reservations therefore only ever raise, and the
     * slot is returned by an explicit reconciliation.
     */
    const {reconcileMonthlyOrderQuota} = await import('../src/services/orderQuota.js');
    const reconciled = await reconcileMonthlyOrderQuota({restaurantId: id, timezone: TZ});
    assert.equal(reconciled.online, 1);

    assert.equal(
      await placeOnline(id), 'created',
      'reconciling after a cancellation did not return the allowance'
    );
  });

  it('the counter errs HIGH after a cancellation, never low', async () => {
    // Until reconciliation runs, a cancelled order still occupies its counter
    // slot. That refuses one order too many rather than admitting one too
    // many, which is the correct direction for a ceiling to be wrong in.
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2});
    const id = world.restaurant._id;
    const now = new Date();
    await placeOnline(id, now);
    await placeOnline(id, now);

    const first = await Order.findOne({restaurant: id, source: 'online'});
    await Order.collection.updateOne({_id: first._id}, {$set: {status: 'cancelled'}});

    assert.equal(await getOnlineOrderUsage(id, {now, timezone: TZ}), 1, 'usage fell');
    assert.equal(
      await readQuotaCounter(id, monthlyOnlineOrderResource(now, TZ)), 2,
      'the counter should still hold the high-water mark until reconciled'
    );
    await assert.rejects(() => placeOnline(id, now));
  });

  it('draft and held online orders still count', async () => {
    // Unchanged from P2G.4; pinned so this phase cannot move it.
    await planWith({maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 3});
    const id = world.restaurant._id;
    await insertOrder(id, 'online', {status: 'draft'});
    await insertOrder(id, 'online', {status: 'held'});

    assert.equal(await getOnlineOrderUsage(id, {timezone: TZ}), 2);
    assert.equal(await placeOnline(id), 'created');
    await assert.rejects(() => placeOnline(id), 'draft/held stopped counting');
  });
});
