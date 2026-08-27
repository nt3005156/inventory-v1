import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, seedWorld, startTestApp, stopTestApp} from './helpers.js';
import {Order, Restaurant} from '../src/models/operations.js';
import {
  DEFAULT_TIMEZONE,
  QUOTA_COUNTABLE_ORDER_STATUSES,
  QUOTA_EXCLUDED_ORDER_STATUSES,
  getOnlineOrderUsage,
  getOrderUsage,
  getUsageSummary,
  monthWindow,
  normalizeTimezone,
  restaurantTimezone
} from '../src/services/usage.js';

/**
 * P2G.4 — correct monthly order counting. COUNTING ONLY; nothing is enforced.
 *
 * THE THREE DEFECTS THIS CLOSES, all measured against this path:
 *
 *   1. `offsetMinutes = 345` was hardcoded while `Restaurant.timezone` already
 *      existed and was ignored. A tenant set to `America/New_York` still had
 *      their billing month start at 2026-07-31T18:15Z — 20:15 on July 31st in
 *      their own city.
 *   2. cancelled orders counted: a dataset of two live and two cancelled
 *      orders reported 4.
 *   3. the count won with `IXSCAN restaurant_1`, then FETCHED every order the
 *      tenant had ever placed and filtered dates in memory.
 */

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Order.syncIndexes();
});

/** An order row written straight to the collection, so `createdAt` is exact. */
async function orderAt(restaurantId, createdAt, {status = 'completed', source = 'pos'} = {}) {
  await Order.collection.insertOne({
    orderNo: `T-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
    branch: world.branchA._id,
    status, source, createdAt, total: 100, items: []
  });
}

async function tenantIn(timezone, name = `TZ ${timezone}`) {
  return Restaurant.create({name, currency: 'NPR', timezone});
}

// ── the timezone actually comes from the tenant ──────────────────────────────

describe('P2G.4 · Restaurant.timezone determines the billing month', () => {
  it('resolves each tenant\'s own zone, not a hardcoded Kathmandu offset', async () => {
    const ktm = await tenantIn('Asia/Kathmandu');
    const nyc = await tenantIn('America/New_York');
    const lon = await tenantIn('Europe/London');

    assert.equal(await restaurantTimezone(ktm._id), 'Asia/Kathmandu');
    assert.equal(await restaurantTimezone(nyc._id), 'America/New_York');
    assert.equal(await restaurantTimezone(lon._id), 'Europe/London');
  });

  it('produces a DIFFERENT window per zone for the same instant', async () => {
    const now = new Date('2026-08-15T12:00:00Z');

    // Kathmandu +05:45 — the month begins 5h45m before midnight UTC.
    assert.equal(
      monthWindow(now, 'Asia/Kathmandu').start.toISOString(), '2026-07-31T18:15:00.000Z'
    );
    // New York is -04:00 in August (EDT), so the month begins AFTER midnight UTC.
    assert.equal(
      monthWindow(now, 'America/New_York').start.toISOString(), '2026-08-01T04:00:00.000Z'
    );
    // London is +01:00 in August (BST).
    assert.equal(
      monthWindow(now, 'Europe/London').start.toISOString(), '2026-07-31T23:00:00.000Z'
    );
    assert.equal(monthWindow(now, 'UTC').start.toISOString(), '2026-08-01T00:00:00.000Z');
  });

  it('honours DST — the same zone has different offsets in winter and summer', async () => {
    /**
     * The old fixed-offset design could not express this at all. New York is
     * UTC-5 in February and UTC-4 in August, so a constant would be wrong for
     * half the year.
     */
    assert.equal(
      monthWindow(new Date('2026-02-15T12:00:00Z'), 'America/New_York').start.toISOString(),
      '2026-02-01T05:00:00.000Z', 'February is EST (-05:00)'
    );
    assert.equal(
      monthWindow(new Date('2026-08-15T12:00:00Z'), 'America/New_York').start.toISOString(),
      '2026-08-01T04:00:00.000Z', 'August is EDT (-04:00)'
    );
  });

  it('handles a month that CONTAINS a DST transition', async () => {
    // US DST begins 2026-03-08. The month still starts at the March-1 offset
    // (EST, -05:00) and ends at the April-1 offset (EDT, -04:00).
    const march = monthWindow(new Date('2026-03-20T12:00:00Z'), 'America/New_York');
    assert.equal(march.start.toISOString(), '2026-03-01T05:00:00.000Z');
    assert.equal(march.end.toISOString(), '2026-04-01T04:00:00.000Z');
  });

  it('handles a 45-minute zone and rolls December into January', async () => {
    const dec = monthWindow(new Date('2026-12-20T12:00:00Z'), 'Asia/Kathmandu');
    assert.equal(dec.start.toISOString(), '2026-11-30T18:15:00.000Z');
    // The year must advance, not wrap to month 13.
    assert.equal(dec.end.toISOString(), '2026-12-31T18:15:00.000Z');
  });

  it('re-resolves the offset AT the boundary, not at today\'s offset', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding (M8).
     *
     * `startOfMonthUtc` makes two passes: guess the instant using the offset at
     * naive UTC midnight, then re-read the offset AT that guess and recompute.
     * Deleting the second pass survived every other test, because for almost
     * every zone and month the two passes agree.
     *
     * They disagree where a zone's offset changes across its own month
     * boundary. Searched 2024-2028 across eight zones for such a case and
     * found exactly one: Lord Howe Island, October 2028, where the island
     * shifts by 30 minutes. One pass yields 13:00Z, two passes 13:30Z.
     *
     * Lord Howe is a real IANA zone and a legitimate value for
     * `Restaurant.timezone`, so this is a correctness bug, not a curiosity.
     */
    const window = monthWindow(new Date('2028-10-15T00:00:00Z'), 'Australia/Lord_Howe');
    assert.equal(
      window.start.toISOString(), '2028-09-30T13:30:00.000Z',
      'the month boundary used the wrong side of a DST shift'
    );
  });

  it('reads the CURRENT month in the tenant\'s zone, not in UTC', async () => {
    /**
     * WHY THIS EXISTS — a mutation finding (M16).
     *
     * `localParts(now, zone)` decides WHICH month to bound. Changing it to
     * `localParts(now, 'UTC')` survived, because every other test picks a
     * mid-month `now` where the UTC and local calendar months agree.
     *
     * They diverge when `now` itself sits near a boundary — which is exactly
     * when a monthly quota rolls over, and therefore exactly when it matters.
     * 2026-08-01T02:00:00Z is already August in Kathmandu but still July in
     * New York.
     */
    const instant = new Date('2026-08-01T02:00:00Z');

    // Kathmandu: local time is 07:45 on Aug 1 -> the AUGUST window.
    assert.equal(
      monthWindow(instant, 'Asia/Kathmandu').start.toISOString(), '2026-07-31T18:15:00.000Z'
    );
    // New York: local time is 22:00 on Jul 31 -> the JULY window. Reading the
    // month in UTC would wrongly return August.
    assert.equal(
      monthWindow(instant, 'America/New_York').start.toISOString(), '2026-07-01T04:00:00.000Z',
      'the current month was determined in UTC rather than the tenant zone'
    );

    // And end-to-end through the counting path.
    const nyc = await tenantIn('America/New_York', 'Now At Boundary');
    await orderAt(nyc._id, new Date('2026-07-20T12:00:00Z'));
    assert.equal(
      await getOrderUsage(nyc._id, {now: instant}), 1,
      'a July order must be in the current month for a New York tenant at this instant'
    );
  });

  it('falls back to the schema default instead of throwing on a bad zone', async () => {
    // A typo in one tenant record must not take the billing screen down.
    assert.equal(normalizeTimezone('Not/AZone'), DEFAULT_TIMEZONE);
    assert.equal(normalizeTimezone(''), DEFAULT_TIMEZONE);
    assert.equal(normalizeTimezone(null), DEFAULT_TIMEZONE);
    assert.equal(normalizeTimezone(undefined), DEFAULT_TIMEZONE);

    const broken = await Restaurant.create({
      name: 'Broken TZ', currency: 'NPR', timezone: 'Mars/Olympus'
    });
    assert.equal(await restaurantTimezone(broken._id), DEFAULT_TIMEZONE);
    // And it still counts rather than erroring.
    assert.equal(await getOrderUsage(broken._id, {now: new Date('2026-08-15T12:00:00Z')}), 0);
  });

  it('a tenant with no timezone keeps the pre-P2G.4 Kathmandu behaviour', async () => {
    // Explicitly unset, as a row predating the field would be.
    const legacy = await Restaurant.create({name: 'Legacy TZ', currency: 'NPR'});
    await Restaurant.collection.updateOne(
      {_id: legacy._id}, {$unset: {timezone: ''}}
    );
    assert.equal(await restaurantTimezone(legacy._id), 'Asia/Kathmandu');
  });
});

// ── the month boundary, which is where the money is ──────────────────────────

describe('P2G.4 · month boundaries in local time', () => {
  it('places July 31 23:59:59 and August 1 00:00:00 LOCAL on opposite sides', async () => {
    const ktm = await tenantIn('Asia/Kathmandu');

    // 2026-07-31 23:59:59 Kathmandu == 2026-07-31T18:14:59Z
    await orderAt(ktm._id, new Date('2026-07-31T18:14:59Z'));
    // 2026-08-01 00:00:00 Kathmandu == 2026-07-31T18:15:00Z
    await orderAt(ktm._id, new Date('2026-07-31T18:15:00Z'));

    const august = await getOrderUsage(ktm._id, {now: new Date('2026-08-15T12:00:00Z')});
    assert.equal(august, 1, 'exactly the order on or after local midnight belongs to August');

    const july = await getOrderUsage(ktm._id, {now: new Date('2026-07-15T12:00:00Z')});
    assert.equal(july, 1, 'and the other belongs to July');
  });

  it('THE SAME UTC INSTANT falls in different months for different tenants', async () => {
    /**
     * This is the case the hardcoded offset could never get right, and the
     * clearest statement of why the zone has to come from the tenant.
     *
     * 2026-08-01T02:00:00Z is:
     *   Kathmandu (+05:45)  -> 2026-08-01 07:45  AUGUST
     *   New York  (-04:00)  -> 2026-07-31 22:00  JULY
     */
    const instant = new Date('2026-08-01T02:00:00Z');
    const ktm = await tenantIn('Asia/Kathmandu', 'Boundary KTM');
    const nyc = await tenantIn('America/New_York', 'Boundary NYC');

    await orderAt(ktm._id, instant);
    await orderAt(nyc._id, instant);

    const midAugust = new Date('2026-08-15T12:00:00Z');
    const midJuly = new Date('2026-07-20T12:00:00Z');

    assert.equal(await getOrderUsage(ktm._id, {now: midAugust}), 1, 'August in Kathmandu');
    assert.equal(await getOrderUsage(ktm._id, {now: midJuly}), 0, 'not July in Kathmandu');

    assert.equal(await getOrderUsage(nyc._id, {now: midJuly}), 1, 'July in New York');
    assert.equal(await getOrderUsage(nyc._id, {now: midAugust}), 0, 'not August in New York');
  });

  it('is half-open: the end instant belongs to the NEXT month, not this one', async () => {
    const ktm = await tenantIn('Asia/Kathmandu', 'HalfOpen');
    const {end} = monthWindow(new Date('2026-08-15T12:00:00Z'), 'Asia/Kathmandu');

    await orderAt(ktm._id, new Date(end.getTime() - 1));
    await orderAt(ktm._id, end);

    assert.equal(await getOrderUsage(ktm._id, {now: new Date('2026-08-15T12:00:00Z')}), 1);
    assert.equal(await getOrderUsage(ktm._id, {now: new Date('2026-09-15T12:00:00Z')}), 1);
  });

  it('excludes orders from adjacent months entirely', async () => {
    const ktm = await tenantIn('Asia/Kathmandu', 'Adjacent');
    await orderAt(ktm._id, new Date('2026-07-15T06:00:00Z'));
    await orderAt(ktm._id, new Date('2026-08-10T06:00:00Z'));
    await orderAt(ktm._id, new Date('2026-08-20T06:00:00Z'));
    await orderAt(ktm._id, new Date('2026-09-05T06:00:00Z'));

    assert.equal(await getOrderUsage(ktm._id, {now: new Date('2026-08-15T12:00:00Z')}), 2);
  });
});

// ── cancelled orders must not be billed ──────────────────────────────────────

describe('P2G.4 · cancelled orders do not consume monthly quota', () => {
  it('THE MEASURED DATASET: two countable + two cancelled = 2, not 4', async () => {
    const ktm = await tenantIn('Asia/Kathmandu', 'Cancelled Set');
    const when = new Date('2026-08-10T06:00:00Z');

    await orderAt(ktm._id, when, {status: 'completed'});
    await orderAt(ktm._id, when, {status: 'pending'});
    await orderAt(ktm._id, when, {status: 'cancelled'});
    await orderAt(ktm._id, when, {status: 'cancelled'});

    assert.equal(
      await getOrderUsage(ktm._id, {now: new Date('2026-08-15T12:00:00Z')}), 2,
      'cancelled orders were billed'
    );
  });

  it('counts every non-cancelled status in the enum, refunded included', async () => {
    /**
     * `refunded` counts on purpose. It is only reachable FROM `completed`
     * (`ALLOWED_TRANSITIONS.completed === ['refunded']`), so the order was
     * cooked, printed and carried. Excluding it would also be an unlimited
     * orders loophole: complete, refund, repeat.
     */
    const ktm = await tenantIn('Asia/Kathmandu', 'All Statuses');
    const when = new Date('2026-08-10T06:00:00Z');
    for (const status of QUOTA_COUNTABLE_ORDER_STATUSES) {
      await orderAt(ktm._id, when, {status});
    }
    for (const status of QUOTA_EXCLUDED_ORDER_STATUSES) {
      await orderAt(ktm._id, when, {status});
    }

    assert.equal(
      await getOrderUsage(ktm._id, {now: new Date('2026-08-15T12:00:00Z')}),
      QUOTA_COUNTABLE_ORDER_STATUSES.length
    );
  });

  it('the countable and excluded sets exactly partition the schema enum', async () => {
    // Guards against a future status being added to the model and silently
    // falling into neither list.
    const declared = [...QUOTA_COUNTABLE_ORDER_STATUSES, ...QUOTA_EXCLUDED_ORDER_STATUSES];
    const schemaEnum = Order.schema.path('status').enumValues;

    assert.deepEqual(
      [...declared].sort(), [...schemaEnum].sort(),
      'the quota status lists have drifted from Order.status'
    );
    assert.deepEqual([...QUOTA_EXCLUDED_ORDER_STATUSES], ['cancelled']);
    // No status invented: every one is a real member of the enum.
    for (const status of declared) assert.ok(schemaEnum.includes(status), status);
  });

  it('applies the same exclusion to the ONLINE monthly count', async () => {
    const ktm = await tenantIn('Asia/Kathmandu', 'Online Cancelled');
    const when = new Date('2026-08-10T06:00:00Z');

    await orderAt(ktm._id, when, {status: 'completed', source: 'online'});
    await orderAt(ktm._id, when, {status: 'cancelled', source: 'online'});
    await orderAt(ktm._id, when, {status: 'completed', source: 'pos'});

    const now = new Date('2026-08-15T12:00:00Z');
    assert.equal(await getOnlineOrderUsage(ktm._id, {now}), 1, 'cancelled online order billed');
    // The overall count still includes the POS order.
    assert.equal(await getOrderUsage(ktm._id, {now}), 2);
  });

  it('a cancellation AFTER the fact removes the order from the count', async () => {
    // The count is derived, not a stored tally, so voiding a ticket refunds
    // the allowance immediately.
    const ktm = await tenantIn('Asia/Kathmandu', 'Late Cancel');
    const when = new Date('2026-08-10T06:00:00Z');
    const now = new Date('2026-08-15T12:00:00Z');
    await orderAt(ktm._id, when, {status: 'completed'});
    await orderAt(ktm._id, when, {status: 'completed'});
    assert.equal(await getOrderUsage(ktm._id, {now}), 2);

    await Order.collection.updateOne(
      {restaurant: new mongoose.Types.ObjectId(String(ktm._id))},
      {$set: {status: 'cancelled'}}
    );
    assert.equal(await getOrderUsage(ktm._id, {now}), 1);
  });
});

// ── tenant scoping ───────────────────────────────────────────────────────────

describe('P2G.4 · monthly counts stay inside one tenant', () => {
  it('does not count another restaurant\'s orders', async () => {
    const a = await tenantIn('Asia/Kathmandu', 'Count A');
    const b = await tenantIn('Asia/Kathmandu', 'Count B');
    const when = new Date('2026-08-10T06:00:00Z');

    await orderAt(a._id, when);
    for (let i = 0; i < 5; i += 1) await orderAt(b._id, when);

    const now = new Date('2026-08-15T12:00:00Z');
    assert.equal(await getOrderUsage(a._id, {now}), 1);
    assert.equal(await getOrderUsage(b._id, {now}), 5);
  });
});

// ── the usage summary ────────────────────────────────────────────────────────

describe('P2G.4 · the subscription summary reports the corrected figures', () => {
  it('reports monthly counts in the tenant\'s zone with cancellations removed', async () => {
    const nyc = await tenantIn('America/New_York', 'Summary NYC');
    // 2026-08-01T02:00Z is still JULY in New York, so it must not appear in
    // an August summary.
    await orderAt(nyc._id, new Date('2026-08-01T02:00:00Z'));
    await orderAt(nyc._id, new Date('2026-08-10T06:00:00Z'));
    await orderAt(nyc._id, new Date('2026-08-11T06:00:00Z'), {status: 'cancelled'});
    await orderAt(nyc._id, new Date('2026-08-12T06:00:00Z'), {source: 'online'});

    const summary = await getUsageSummary(nyc._id);
    // Two countable August orders in New York: the 10th and the 12th.
    assert.equal(summary.maxMonthlyOrders, 2);
    assert.equal(summary.maxMonthlyOnlineOrders, 1);
  });
});

// ── the index, verified by the planner rather than by assertion ──────────────

describe('P2G.4 · the monthly count uses the compound index', () => {
  it('declares {restaurant, createdAt} on the model, IN THAT ORDER', async () => {
    const byName = Order.schema.indexes()
      .find(([, options]) => options?.name === 'order_restaurant_created');
    assert.ok(byName, 'order_restaurant_created is not declared');
    assert.deepEqual(byName[0], {restaurant: 1, createdAt: 1});
    /**
     * Key ORDER, asserted explicitly — a mutation finding (M15).
     *
     * `deepEqual` on an object does not constrain key order, so reversing the
     * index to `{createdAt, restaurant}` kept the same name and the same key
     * set and survived. It is measurably worse: the equality field must lead,
     * or the tenant filter cannot bound the scan (measured 400 keys examined
     * versus 200 for the same count).
     */
    assert.deepEqual(
      Object.keys(byName[0]), ['restaurant', 'createdAt'],
      'the equality field must lead the compound key'
    );
  });

  it('WINS THE PLAN at realistic scale, and stops scanning the whole tenant', async () => {
    /**
     * The planner must be verified, not assumed — and it must be verified with
     * enough data to be meaningful.
     *
     * A four-document probe chose `status_1` and proved nothing; MongoDB's
     * cost model is free to pick anything when every plan is trivially cheap.
     * With a year of trading the difference is the whole point of the index:
     * `restaurant_1` examines every order the tenant has EVER placed to count
     * one month.
     */
    const tenant = await tenantIn('Asia/Kathmandu', 'Planner');
    const other = await tenantIn('Asia/Kathmandu', 'Planner Other');

    const rows = [];
    for (let month = 0; month < 12; month += 1) {
      for (let i = 0; i < 200; i += 1) {
        const at = new Date(Date.UTC(2025, 8 + month, 1 + (i % 27), i % 23, 0, 0));
        rows.push({
          orderNo: `P-${month}-${i}`, restaurant: tenant._id, branch: world.branchA._id,
          status: i % 7 === 0 ? 'cancelled' : 'completed', createdAt: at, total: 100, items: []
        });
        // A second tenant, so the index has to discriminate on `restaurant`.
        rows.push({
          orderNo: `Q-${month}-${i}`, restaurant: other._id, branch: world.branchA._id,
          status: 'completed', createdAt: at, total: 100, items: []
        });
      }
    }
    await Order.collection.insertMany(rows);

    const {start, end} = monthWindow(new Date('2026-08-15T06:00:00Z'), 'Asia/Kathmandu');
    const filter = {
      restaurant: tenant._id,
      createdAt: {$gte: start, $lt: end},
      status: {$nin: [...QUOTA_EXCLUDED_ORDER_STATUSES]}
    };

    const plan = await Order.collection.find(filter).explain('executionStats');
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    assert.match(
      winning, /"indexName":"order_restaurant_created"/,
      `the planner did not choose the compound index: ${winning.slice(0, 200)}`
    );

    // The date range is served by index BOUNDS, not by a residual filter: keys
    // examined must track one month, not the tenant's whole history (2400).
    const stats = plan.executionStats;
    assert.ok(
      stats.totalKeysExamined <= 400,
      `range not pushed into the index: ${stats.totalKeysExamined} keys examined`
    );

    // And the old index really is worse — the comparison that justifies this.
    const legacy = await Order.collection.find(filter).hint('restaurant_1')
      .explain('executionStats');
    assert.ok(
      legacy.executionStats.totalKeysExamined > stats.totalKeysExamined * 3,
      'the compound index is not measurably better than restaurant_1'
    );

    /**
     * The key ORDER is load-bearing, measured rather than argued (M15).
     *
     * A `{createdAt, restaurant}` index has the same name and the same fields,
     * so a name assertion alone cannot tell it apart. Built here alongside and
     * compared: leading with the range field forces every key in the month to
     * be examined for BOTH tenants, then discarded.
     */
    await Order.collection.createIndex(
      {createdAt: 1, restaurant: 1}, {name: 'p2g4_probe_reversed'}
    );
    try {
      const reversed = await Order.collection.find(filter).hint('p2g4_probe_reversed')
        .explain('executionStats');
      assert.ok(
        reversed.executionStats.totalKeysExamined > stats.totalKeysExamined,
        'leading with the range field should examine strictly more keys '
        + `(reversed ${reversed.executionStats.totalKeysExamined} vs `
        + `${stats.totalKeysExamined})`
      );
    } finally {
      await Order.collection.dropIndex('p2g4_probe_reversed');
    }
  });

  it('counts correctly at that scale — the index did not change the answer', async () => {
    // An index that is fast and wrong is worse than a slow one.
    const tenant = await tenantIn('Asia/Kathmandu', 'Scale Count');
    const rows = [];
    // 30 August orders, 6 of them cancelled, plus 40 in adjacent months.
    for (let i = 0; i < 30; i += 1) {
      rows.push({
        orderNo: `A-${i}`, restaurant: tenant._id, branch: world.branchA._id,
        status: i % 5 === 0 ? 'cancelled' : 'completed',
        createdAt: new Date(Date.UTC(2026, 7, 5 + (i % 20), 6, 0, 0)), total: 100, items: []
      });
    }
    for (let i = 0; i < 40; i += 1) {
      rows.push({
        orderNo: `B-${i}`, restaurant: tenant._id, branch: world.branchA._id,
        status: 'completed',
        createdAt: new Date(Date.UTC(2026, i % 2 ? 6 : 8, 10, 6, 0, 0)), total: 100, items: []
      });
    }
    await Order.collection.insertMany(rows);

    assert.equal(
      await getOrderUsage(tenant._id, {now: new Date('2026-08-15T12:00:00Z')}), 24
    );
  });
});

// ── enforcement must NOT have arrived ────────────────────────────────────────

describe('P2G.4 · the monthly quota is measured but NOT enforced', () => {
  it('lets a tenant exceed maxMonthlyOrders without being refused', async () => {
    /**
     * P2G.4 is a counting fix. Enforcement is P2G.5, deliberately separated so
     * a counting change cannot brick order creation on deploy day.
     */
    const {Plan, Subscription} = await import('../src/models/billing.js');
    const {
      invalidateEntitlements, __resetBillingEnforcementProbe
    } = await import('../src/services/entitlements.js');

    const tenant = await tenantIn('Asia/Kathmandu', 'Unenforced');
    const plan = await Plan.create({
      code: `p2g4-${Math.random().toString(36).slice(2, 8)}`, name: 'Tiny', active: true,
      currency: 'NPR', limits: {maxMonthlyOrders: 1, maxMonthlyOnlineOrders: 1},
      features: {pos: true}
    });
    const now = new Date();
    await Subscription.create({
      restaurant: tenant._id, plan: plan._id, status: 'active', startDate: now,
      currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * 86_400_000)
    });
    invalidateEntitlements();
    __resetBillingEnforcementProbe();

    // Five orders against a ceiling of one. The count must SEE them...
    for (let i = 0; i < 5; i += 1) await orderAt(tenant._id, now);
    assert.equal(await getOrderUsage(tenant._id, {now}), 5);

    // ...and nothing anywhere may have started refusing on that basis.
    const usage = await getUsageSummary(tenant._id);
    assert.equal(usage.maxMonthlyOrders, 5, 'reporting is the whole job this phase');
  });

  it('no quota counter document is written for monthly orders', async () => {
    // The P2G.1-3 resources reserve seats. Monthly orders are counted from the
    // order collection and must not have acquired a reservation counter here.
    const {ResourceCounter} = await import('../src/services/quotaGuard.js');
    const tenant = await tenantIn('Asia/Kathmandu', 'No Counter');
    await orderAt(tenant._id, new Date('2026-08-10T06:00:00Z'));
    await getOrderUsage(tenant._id, {now: new Date('2026-08-15T12:00:00Z')});

    const counters = await ResourceCounter.find({restaurant: tenant._id}).lean();
    assert.deepEqual(counters.map(c => c.resource), []);
  });
});
