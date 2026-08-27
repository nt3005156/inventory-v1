import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {MenuItem, User} from '../src/models/index.js';
import {Branch, InventoryBalance, Order, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements, resolveEntitlement
} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {
  AT_LIMIT_CODE, OVER_LIMIT_CODE, classifyUsage, monthlyOrderResource, withMonthlyOrderQuota
} from '../src/services/orderQuota.js';
import {getOrderUsage, monthKey} from '../src/services/usage.js';
import {buildOrderQuotaReport} from '../scripts/order-quota-dry-run.js';

/**
 * P2G.5 — enforcement of the monthly order allowance.
 *
 * P2G.4 fixed the COUNT and enforced nothing; this makes the count refuse.
 *
 * Every concurrency assertion runs SEVERAL trials. A single clean burst is not
 * evidence — the lesson from P2G.2, where a one-shot probe hid the race.
 * Every assertion counts DOCUMENTS IN THE DATABASE.
 */

const DAY = 86_400_000;
const TRIALS = 6;

let world;

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

/** Put the seeded world on a plan with the given monthly ceiling. */
async function planWith(limits, {timezone} = {}) {
  if (timezone) {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {timezone}});
  }
  const plan = await Plan.create({
    code: `p2g5-${Math.random().toString(36).slice(2, 8)}`,
    name: 'P2G5 Plan', active: true, currency: 'NPR',
    limits: {
      maxBranches: 9, maxUsers: 9, maxMenuItems: 99, maxTables: 99,
      maxCustomers: 999, maxStations: 9, ...limits
    },
    features: {pos: true, inventory: true, kds: true, tables: true}
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

function orderBody() {
  return {
    branch: String(world.branchA._id),
    items: [{menuItem: String(world.menu._id), qty: 1}]
  };
}

const placeOrder = token => request('/api/orders', {
  method: 'POST', token: token || ownerToken(), body: orderBody()
});

/** Countable orders actually written for the seeded tenant. */
function countableOrders(restaurantId = world.restaurant._id) {
  return Order.countDocuments({
    restaurant: restaurantId, status: {$nin: ['cancelled']}
  });
}

/**
 * The seeded world already opens with 20,000g of stock per branch and each
 * test order consumes 250g, so no restocking is needed for the volumes here.
 *
 * Two earlier fixture attempts were WRONG and are worth recording. Setting
 * `InventoryBalance.quantity` directly was refused by the ledger guard
 * ("may only be changed by the inventory ledger service"); forcing it through
 * with `inventoryLedgerWrite` then desynchronised the batch ledger
 * ("batch quantities do not match the aggregate balance"). Both guards are
 * correct and the fixture was the problem, so it stops fighting them.
 */
async function restock() {}

async function resetOrders() {
  await Order.deleteMany({restaurant: world.restaurant._id});
  await ResourceCounter.deleteMany({restaurant: world.restaurant._id});
  await restock();
}

// ── the hot-path lookup ──────────────────────────────────────────────────────

describe('P2G.5 · the order path performs no extra Restaurant lookup', () => {
  it('carries the tenant timezone on the cached entitlement', async () => {
    await planWith({maxMonthlyOrders: 100}, {timezone: 'America/New_York'});
    const entitlement = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(entitlement.timezone, 'America/New_York');
  });

  it('reports the timezone even for a tenant with no subscription', async () => {
    // The restricted entitlement is returned before any plan is read, and the
    // order path still needs a zone to name the right month.
    await Restaurant.updateOne(
      {_id: world.restaurant._id}, {$set: {timezone: 'Europe/London'}}
    );
    invalidateEntitlements();
    const entitlement = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(entitlement.operational, false);
    assert.equal(entitlement.timezone, 'Europe/London');
  });

  it('MEASURED: creating an order costs ZERO Restaurant reads for quota', async () => {
    /**
     * P2G.4 left `getOrderUsage()` doing its own `Restaurant.findById` to
     * resolve the zone — one extra query on the hottest write in the product.
     *
     * Calls are attributed BY CALLER rather than counted in bulk. A first
     * probe simply counted them, saw 2, and looked like a failure; the two
     * were `loadPrincipal` (authentication) and `moveStock` (inventory
     * costing), both pre-existing and nothing to do with quotas. Counting
     * without attributing measured the wrong thing.
     */
    await planWith({maxMonthlyOrders: 5000});
    await restock();
    await placeOrder();          // warm the entitlement cache
    await resolveEntitlement(world.restaurant._id);

    const byCaller = {};
    const original = Restaurant.findById.bind(Restaurant);
    Restaurant.findById = function counted(...args) {
      const frame = new Error().stack.split('\n')[2] || '';
      const match = frame.match(/at (?:async )?([\w.]+) \(/);
      const key = match ? match[1] : 'unknown';
      byCaller[key] = (byCaller[key] || 0) + 1;
      return original(...args);
    };
    try {
      const res = await placeOrder();
      assert.equal(res.status, 201, res.body?.message);
    } finally {
      Restaurant.findById = original;
    }

    assert.equal(
      byCaller.resolveEntitlement || 0, 0,
      `the entitlement resolver re-read the restaurant: ${JSON.stringify(byCaller)}`
    );
    assert.equal(
      byCaller.restaurantTimezone || 0, 0,
      'the P2G.4 hot-path timezone lookup is still present'
    );
  });

  it('getOrderUsage issues no Restaurant read when the timezone is supplied', async () => {
    let reads = 0;
    const original = Restaurant.findById.bind(Restaurant);
    Restaurant.findById = function counted(...args) {
      reads += 1;
      return original(...args);
    };
    try {
      await getOrderUsage(world.restaurant._id, {
        now: new Date(), timezone: 'Asia/Kathmandu'
      });
    } finally {
      Restaurant.findById = original;
    }
    assert.equal(reads, 0);
  });
});

// ── enforcement, and its concurrency ─────────────────────────────────────────

describe('P2G.5 · maxMonthlyOrders is enforced', () => {
  it('allows up to the ceiling then refuses, sequentially', async () => {
    await planWith({maxMonthlyOrders: 3});
    await restock();

    for (let i = 0; i < 3; i += 1) {
      const res = await placeOrder();
      assert.equal(res.status, 201, `order ${i + 1}: ${res.body?.message}`);
    }
    const refused = await placeOrder();
    assert.equal(refused.status, 402);
    assert.match(refused.body.message, /orders per month/i);
    assert.equal(await countableOrders(), 3, 'a refused order must not be written');
  });

  it(`holds a ceiling of 2 across ${TRIALS} bursts of 6 concurrent creates`, async () => {
    await planWith({maxMonthlyOrders: 2});

    const perTrial = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetOrders();
      const responses = await Promise.all(
        Array.from({length: 6}, () => placeOrder())
      );
      const created = await countableOrders();
      perTrial.push(created);

      const accepted = responses.filter(r => r.status === 201).length;
      assert.equal(accepted, created, `trial ${trial}: ${accepted} × 201 but ${created} rows`);
      for (const refusal of responses.filter(r => r.status !== 201)) {
        assert.equal(
          refusal.status, 402, `unexpected ${refusal.status}: ${refusal.body?.message}`
        );
      }
    }

    assert.deepEqual(
      perTrial.filter(n => n > 2), [],
      `quota bypassed — orders per trial on a limit of 2: ${perTrial.join(',')}`
    );
    assert.deepEqual(perTrial.filter(n => n < 1), [], `nothing created: ${perTrial.join(',')}`);
  });

  it('ONE SEAT REMAINING, 10 concurrent: exactly 1 succeeds and 9 are refused', async () => {
    await planWith({maxMonthlyOrders: 5});

    for (let trial = 0; trial < TRIALS; trial += 1) {
      await resetOrders();
      // Consume four of five, leaving exactly one.
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await placeOrder()).status, 201);
      }

      const responses = await Promise.all(
        Array.from({length: 10}, () => placeOrder())
      );
      const accepted = responses.filter(r => r.status === 201).length;
      const refused = responses.filter(r => r.status === 402).length;

      assert.equal(accepted, 1, `trial ${trial}: ${accepted} succeeded, expected 1`);
      assert.equal(refused, 9, `trial ${trial}: ${refused} refused, expected 9`);
      // The final usage must match reality, not just the response tally.
      assert.equal(await countableOrders(), 5, `trial ${trial}: usage diverged`);
      assert.equal(
        await getOrderUsage(world.restaurant._id, {timezone: 'Asia/Kathmandu'}), 5
      );
    }
  });

  it('an unlimited plan refuses nobody and writes no counter', async () => {
    await planWith({maxMonthlyOrders: null});
    await restock();
    for (let i = 0; i < 4; i += 1) {
      assert.equal((await placeOrder()).status, 201);
    }
    assert.equal(await countableOrders(), 4);
    assert.equal(
      await readQuotaCounter(world.restaurant._id, monthlyOrderResource()), null
    );
  });

  it('a failed order does not consume the allowance', async () => {
    // The reservation is inside the route's transaction, so an aborted order
    // rolls the increment back with it.
    await planWith({maxMonthlyOrders: 3});
    await restock();
    assert.equal((await placeOrder()).status, 201);

    const original = Order.prototype.save;
    let armed = true;
    Order.prototype.save = async function patched(...args) {
      if (armed) {
        armed = false;
        throw new Error('save exploded');
      }
      return original.apply(this, args);
    };
    try {
      const failed = await placeOrder();
      /**
       * NOT 201 — the assertion is that the order did not succeed. My first
       * version expected 500 and got 400; that was a wrong assertion, not a
       * defect. The status depends on which error mapper is in front of the
       * route, which is incidental to what this test is about: whether the
       * reservation survived a failed write.
       */
      assert.notEqual(failed.status, 201, 'the order should not have been created');
    } finally {
      Order.prototype.save = original;
    }

    assert.equal(await countableOrders(), 1);
    assert.equal(
      await readQuotaCounter(world.restaurant._id, monthlyOrderResource()), 1,
      'the aborted order leaked a reservation'
    );
    // Both remaining orders are still available.
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 402);
  });
});

// ── subscription semantics must be respected ─────────────────────────────────

describe('P2G.5 · existing billing-enforcement semantics are preserved', () => {
  it('does not enforce when BILLING_ENFORCEMENT is off', async () => {
    await planWith({maxMonthlyOrders: 1});
    await restock();
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();
      for (let i = 0; i < 4; i += 1) {
        assert.equal((await placeOrder()).status, 201, `order ${i + 1}`);
      }
      assert.equal(await countableOrders(), 4);
      assert.equal(
        await readQuotaCounter(world.restaurant._id, monthlyOrderResource()), null,
        'a counter was written while enforcement was off'
      );
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });

  it('does not enforce when no plan catalogue exists', async () => {
    // Deploy-day safety: an unprovisioned deployment behaves as before.
    await Plan.deleteMany({});
    __resetBillingEnforcementProbe();
    invalidateEntitlements();
    await restock();
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await placeOrder()).status, 201, `order ${i + 1}`);
    }
    assert.equal(await countableOrders(), 3);
  });
});

// ── the over-limit path ──────────────────────────────────────────────────────

describe('P2G.5 · over-limit tenants get a distinct, legible refusal', () => {
  it('classifies usage against the limit', () => {
    assert.equal(classifyUsage(5, 10), 'OK');
    assert.equal(classifyUsage(10, 10), 'AT_LIMIT');
    assert.equal(classifyUsage(11, 10), 'OVER');
    assert.equal(classifyUsage(99999, null), 'UNLIMITED');
  });

  it('AT the limit refuses with the at-limit code', async () => {
    await planWith({maxMonthlyOrders: 2});
    await restock();
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 201);

    const refused = await placeOrder();
    assert.equal(refused.status, 402);
    assert.match(refused.body.message, /Your plan allows 2 orders per month/);
  });

  it('ALREADY OVER the limit says so, rather than a bare "limit reached"', async () => {
    /**
     * The deploy-day case. A tenant who wrote 5 orders while the ceiling of 2
     * was unenforced must not have their next request fail with an
     * unexplained generic error — support has to be able to tell "you just hit
     * your limit" from "you were already past it when this was switched on".
     */
    await planWith({maxMonthlyOrders: 2});
    await restock();

    // Five orders written directly, as if placed before enforcement existed.
    const rows = Array.from({length: 5}, (unused, i) => ({
      orderNo: `PRE-${i}`, restaurant: world.restaurant._id, branch: world.branchA._id,
      status: 'completed', source: 'pos', createdAt: new Date(), total: 100, items: []
    }));
    await Order.collection.insertMany(rows);

    const refused = await placeOrder();
    assert.equal(refused.status, 402);
    assert.match(
      refused.body.message, /already over the limit before enforcement began/i,
      `got: ${refused.body?.message}`
    );
    // No order was written by the refused attempt.
    assert.equal(await countableOrders(), 5);
  });

  it('exposes the two codes distinctly at the service layer', async () => {
    await planWith({maxMonthlyOrders: 1});
    const timezone = 'Asia/Kathmandu';
    const args = {restaurantId: world.restaurant._id, timezone, source: 'pos'};

    await Order.collection.insertOne({
      orderNo: 'AT-1', restaurant: world.restaurant._id, branch: world.branchA._id,
      status: 'completed', source: 'pos', createdAt: new Date(), total: 100, items: []
    });
    await assert.rejects(
      () => withMonthlyOrderQuota(args, async () => 'created'),
      error => {
        assert.equal(error.code, AT_LIMIT_CODE);
        assert.equal(error.status, 402);
        return true;
      }
    );

    await ResourceCounter.deleteMany({restaurant: world.restaurant._id});
    await Order.collection.insertMany([2, 3].map(i => ({
      orderNo: `OVER-${i}`, restaurant: world.restaurant._id, branch: world.branchA._id,
      status: 'completed', source: 'pos', createdAt: new Date(), total: 100, items: []
    })));
    await assert.rejects(
      () => withMonthlyOrderQuota(args, async () => 'created'),
      error => {
        assert.equal(error.code, OVER_LIMIT_CODE);
        return true;
      }
    );
  });
});

// ── the dry run ──────────────────────────────────────────────────────────────

describe('P2G.5 · the dry run identifies who enforcement would affect', () => {
  it('classifies OK, AT LIMIT and OVER across tenants', async () => {
    const plan = await Plan.create({
      code: `dry-${Math.random().toString(36).slice(2, 8)}`, name: 'Dry', active: true,
      currency: 'NPR', limits: {maxMonthlyOrders: 3}, features: {pos: true}
    });
    const now = new Date();

    const make = async (name, orders) => {
      const restaurant = await Restaurant.create({
        name, currency: 'NPR', timezone: 'Asia/Kathmandu'
      });
      await Subscription.create({
        restaurant: restaurant._id, plan: plan._id, status: 'active', startDate: now,
        currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
      });
      if (orders) {
        await Order.collection.insertMany(Array.from({length: orders}, (unused, i) => ({
          orderNo: `${name}-${i}`, restaurant: restaurant._id, branch: world.branchA._id,
          status: 'completed', source: 'pos', createdAt: now, total: 100, items: []
        })));
      }
      return restaurant;
    };

    await make('Dry A', 1);   // OK
    await make('Dry B', 3);   // AT_LIMIT
    await make('Dry C', 7);   // OVER

    const report = await buildOrderQuotaReport({now});
    const byName = Object.fromEntries(report.rows.map(row => [row.name, row]));

    assert.equal(byName['Dry A'].status, 'OK');
    assert.equal(byName['Dry A'].usage, 1);
    assert.equal(byName['Dry B'].status, 'AT_LIMIT');
    assert.equal(byName['Dry C'].status, 'OVER');
    assert.equal(byName['Dry C'].usage, 7);
    assert.equal(byName['Dry C'].limit, 3);

    assert.equal(report.over, 1);
    assert.equal(report.atLimit, 1);
    assert.equal(report.affected, 2);
  });

  it('excludes cancelled orders and reports the tenant\'s own month', async () => {
    const plan = await Plan.create({
      code: `dry2-${Math.random().toString(36).slice(2, 8)}`, name: 'Dry2', active: true,
      currency: 'NPR', limits: {maxMonthlyOrders: 10}, features: {pos: true}
    });
    const now = new Date('2026-08-15T12:00:00Z');
    const restaurant = await Restaurant.create({
      name: 'Dry NYC', currency: 'NPR', timezone: 'America/New_York'
    });
    await Subscription.create({
      restaurant: restaurant._id, plan: plan._id, status: 'active', startDate: now,
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
    });
    await Order.collection.insertMany([
      {orderNo: 'D1', restaurant: restaurant._id, branch: world.branchA._id,
        status: 'completed', createdAt: new Date('2026-08-10T06:00:00Z'), total: 1, items: []},
      {orderNo: 'D2', restaurant: restaurant._id, branch: world.branchA._id,
        status: 'cancelled', createdAt: new Date('2026-08-11T06:00:00Z'), total: 1, items: []},
      // Still JULY in New York.
      {orderNo: 'D3', restaurant: restaurant._id, branch: world.branchA._id,
        status: 'completed', createdAt: new Date('2026-08-01T02:00:00Z'), total: 1, items: []}
    ]);

    const report = await buildOrderQuotaReport({now});
    const row = report.rows.find(entry => entry.name === 'Dry NYC');
    assert.equal(row.usage, 1, 'cancelled and out-of-month orders must not be counted');
    assert.equal(row.timezone, 'America/New_York');
    assert.equal(row.month, monthKey(now, 'America/New_York'));
  });

  it('reports a tenant with no subscription without crashing', async () => {
    await Restaurant.create({name: 'Dry NoSub', currency: 'NPR'});
    const report = await buildOrderQuotaReport({now: new Date()});
    const row = report.rows.find(entry => entry.name === 'Dry NoSub');
    assert.equal(row.status, 'NO_SUBSCRIPTION');
    assert.equal(row.limit, null);
  });

  it('MUTATES NOTHING — no counters written, no orders touched', async () => {
    await planWith({maxMonthlyOrders: 1});
    await restock();
    assert.equal((await placeOrder()).status, 201);

    const countersBefore = await ResourceCounter.find({}).lean();
    const ordersBefore = await Order.find({}).select('_id status').lean();

    await buildOrderQuotaReport({now: new Date()});

    const countersAfter = await ResourceCounter.find({}).lean();
    const ordersAfter = await Order.find({}).select('_id status').lean();

    assert.equal(countersAfter.length, countersBefore.length, 'the dry run wrote a counter');
    assert.deepEqual(
      countersAfter.map(c => [c.resource, c.count]).sort(),
      countersBefore.map(c => [c.resource, c.count]).sort()
    );
    assert.deepEqual(
      ordersAfter.map(o => String(o._id)).sort(),
      ordersBefore.map(o => String(o._id)).sort()
    );
  });

  it('does not refuse orders — a dry run is not enforcement', async () => {
    await planWith({maxMonthlyOrders: 2});
    await restock();
    await buildOrderQuotaReport({now: new Date()});
    // The tenant is nowhere near their ceiling; the report must not have
    // consumed any of it.
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 201);
  });
});

// ── P2G.4 behaviour must be preserved ────────────────────────────────────────

describe('P2G.5 · P2G.4 counting semantics are unchanged', () => {
  it('enforces in the TENANT\'S timezone, not UTC', async () => {
    /**
     * The tenant is in New York. An order placed at 2026-08-01T02:00Z is still
     * JULY for them, so it must not consume the August allowance.
     */
    await planWith({maxMonthlyOrders: 2}, {timezone: 'America/New_York'});
    await restock();

    await Order.collection.insertMany([1, 2].map(i => ({
      orderNo: `JUL-${i}`, restaurant: world.restaurant._id, branch: world.branchA._id,
      status: 'completed', source: 'pos',
      createdAt: new Date('2026-08-01T02:00:00Z'), total: 100, items: []
    })));

    // Those two are July in New York, so August is still empty.
    const august = new Date('2026-08-15T12:00:00Z');
    assert.equal(
      await getOrderUsage(world.restaurant._id, {
        now: august, timezone: 'America/New_York'
      }), 0
    );
    // And a Kathmandu tenant would have counted them as August.
    assert.equal(
      await getOrderUsage(world.restaurant._id, {
        now: august, timezone: 'Asia/Kathmandu'
      }), 2
    );
  });

  it('ENFORCES against the tenant\'s own month, not the default zone', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding (M5).
     *
     * Replacing `normalizeTimezone(timezone)` with the hardcoded default
     * survived, because although a New York tenant appears above, that test
     * asserts `getOrderUsage()` DIRECTLY. Nothing drove the ENFORCEMENT path
     * with a non-default zone, so the wrong zone reached the same counter name
     * and the same answer.
     *
     * Here the two zones genuinely disagree about which month it is, so the
     * counter name and the ceiling decision must follow the tenant.
     */
    await planWith({maxMonthlyOrders: 2}, {timezone: 'America/New_York'});

    // 02:00Z on 1 August is still JULY in New York.
    const instant = new Date('2026-08-01T02:00:00Z');
    const args = {
      restaurantId: world.restaurant._id,
      timezone: 'America/New_York',
      now: instant,
      source: 'pos'
    };

    // Two orders timestamped in the tenant's JULY fill July's allowance.
    await Order.collection.insertMany([1, 2].map(i => ({
      orderNo: `TZE-${i}`, restaurant: world.restaurant._id, branch: world.branchA._id,
      status: 'completed', source: 'pos', createdAt: instant, total: 100, items: []
    })));

    await assert.rejects(
      () => withMonthlyOrderQuota(args, async () => 'created'),
      error => {
        assert.equal(error.status, 402);
        return true;
      },
      'July is full for this tenant and the third order must be refused'
    );

    // The counter it contended on must be JULY's, named in the tenant's zone.
    assert.equal(
      await readQuotaCounter(world.restaurant._id, 'orders:2026-07'), 2,
      'enforcement used the wrong month — the default zone would have said 2026-08'
    );
    assert.equal(
      await readQuotaCounter(world.restaurant._id, 'orders:2026-08'), null
    );

    // And the tenant's AUGUST is untouched and still sellable.
    const august = await withMonthlyOrderQuota(
      {...args, now: new Date('2026-08-20T12:00:00Z')}, async () => 'created'
    );
    assert.equal(august, 'created');
    assert.equal(await readQuotaCounter(world.restaurant._id, 'orders:2026-08'), 1);
  });

  it('uses a per-month counter, so the allowance resets', async () => {
    const august = monthlyOrderResource(new Date('2026-08-15T12:00:00Z'), 'Asia/Kathmandu');
    const september = monthlyOrderResource(new Date('2026-09-15T12:00:00Z'), 'Asia/Kathmandu');
    assert.equal(august, 'orders:2026-08');
    assert.equal(september, 'orders:2026-09');
    assert.notEqual(august, september, 'the allowance would never reset');
  });

  it('two tenants in different zones name different months for one instant', async () => {
    const instant = new Date('2026-08-01T02:00:00Z');
    assert.equal(monthlyOrderResource(instant, 'Asia/Kathmandu'), 'orders:2026-08');
    assert.equal(monthlyOrderResource(instant, 'America/New_York'), 'orders:2026-07');
  });

  it('cancelled orders do not consume the allowance', async () => {
    await planWith({maxMonthlyOrders: 2});
    await restock();
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 402);

    // Void one. The allowance must come back, because the count excludes it.
    const first = await Order.findOne({restaurant: world.restaurant._id});
    await Order.collection.updateOne({_id: first._id}, {$set: {status: 'cancelled'}});

    assert.equal(
      await getOrderUsage(world.restaurant._id, {timezone: 'Asia/Kathmandu'}), 1
    );
    assert.equal(
      (await placeOrder()).status, 201, 'cancelling did not return the allowance'
    );
  });

  it('draft and held STILL COUNT — unchanged from P2G.4', async () => {
    // Explicitly pinned. Pricing policy may change this later; P2G.5 must not.
    await planWith({maxMonthlyOrders: 3});
    await restock();
    await Order.collection.insertMany([
      {orderNo: 'DR-1', restaurant: world.restaurant._id, branch: world.branchA._id,
        status: 'draft', createdAt: new Date(), total: 1, items: []},
      {orderNo: 'HE-1', restaurant: world.restaurant._id, branch: world.branchA._id,
        status: 'held', createdAt: new Date(), total: 1, items: []}
    ]);

    assert.equal(
      await getOrderUsage(world.restaurant._id, {timezone: 'Asia/Kathmandu'}), 2
    );
    // One seat left of three.
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 402, 'draft/held stopped counting');
  });

  it('refunded still counts, so refunding is not an unlimited-orders loophole', async () => {
    await planWith({maxMonthlyOrders: 2});
    await restock();
    assert.equal((await placeOrder()).status, 201);
    const order = await Order.findOne({restaurant: world.restaurant._id});
    await Order.collection.updateOne({_id: order._id}, {$set: {status: 'refunded'}});

    assert.equal(
      await getOrderUsage(world.restaurant._id, {timezone: 'Asia/Kathmandu'}), 1
    );
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 402);
  });
});

// ── tenant isolation ─────────────────────────────────────────────────────────

describe('P2G.5 · one tenant cannot consume another\'s monthly allowance', () => {
  it('keeps separate counters and separate ceilings', async () => {
    await planWith({maxMonthlyOrders: 2});
    await restock();

    // A second tenant with its own plan, branch, menu and owner.
    const other = await Restaurant.create({
      name: 'Iso Other', currency: 'NPR', timezone: 'Asia/Kathmandu'
    });
    const plan = await Plan.create({
      code: `iso-${Math.random().toString(36).slice(2, 8)}`, name: 'Iso', active: true,
      currency: 'NPR', limits: {maxMonthlyOrders: 5}, features: {pos: true}
    });
    const now = new Date();
    await Subscription.create({
      restaurant: other._id, plan: plan._id, status: 'active', startDate: now,
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
    });
    await Order.collection.insertMany(Array.from({length: 5}, (unused, i) => ({
      orderNo: `ISO-${i}`, restaurant: other._id, branch: world.branchA._id,
      status: 'completed', createdAt: now, total: 1, items: []
    })));
    invalidateEntitlements();

    // The other tenant is at its own ceiling; ours is untouched.
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 201);
    assert.equal((await placeOrder()).status, 402);

    assert.equal(await countableOrders(world.restaurant._id), 2);
    assert.equal(await countableOrders(other._id), 5);
    assert.equal(await readQuotaCounter(world.restaurant._id, monthlyOrderResource()), 2);
  });
});
