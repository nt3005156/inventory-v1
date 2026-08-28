import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, seedWorld, startTestApp, stopTestApp} from './helpers.js';
import {Order, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {
  __resetBillingEnforcementProbe, invalidateEntitlements
} from '../src/services/entitlements.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {
  ONLINE_ORDER_SOURCE,
  monthlyOnlineOrderResource,
  withMonthlyOnlineOrderQuota
} from '../src/services/orderQuota.js';
import {getOnlineOrderUsage, getOrderUsage, monthKey} from '../src/services/usage.js';
import {buildOrderQuotaReport, render} from '../scripts/order-quota-dry-run.js';

/**
 * P2G.9 — the dry run reports the ONLINE ceiling too.
 *
 * THE GAP THIS CLOSES. P2G.7 shipped `maxMonthlyOnlineOrders` as a second,
 * independently enforceable limit, but the dry run built in P2G.5 only knew
 * about `maxMonthlyOrders`. An operator preparing to enable enforcement had no
 * way to see who was over their storefront allowance — which is precisely the
 * blindness the dry run exists to prevent.
 *
 * The central property asserted here is AGREEMENT: the report must produce the
 * same numbers as enforcement, on the same fixture. A dry run that quietly
 * counts something slightly different is worse than none, because it is
 * trusted.
 */

const DAY = 86_400_000;
let world;
let seq = 0;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  world = await seedWorld();
  await ResourceCounter.createIndexes();
  await Order.syncIndexes();
  __resetBillingEnforcementProbe();
});

/** A tenant with its own plan, in its own timezone. */
async function tenant(name, limits, {timezone = 'Asia/Kathmandu', subscribe = true} = {}) {
  const restaurant = await Restaurant.create({name, currency: 'NPR', timezone});
  if (!subscribe) return {restaurant, plan: null};
  const plan = await Plan.create({
    code: `p2g9-${Math.random().toString(36).slice(2, 8)}`,
    name: `${name} Plan`, active: true, currency: 'NPR',
    limits, features: {pos: true, onlineOrdering: true}
  });
  const now = new Date();
  await Subscription.create({
    restaurant: restaurant._id, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now,
    currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  return {restaurant, plan};
}

function insertOrder(restaurantId, source, {status = 'completed', createdAt} = {}) {
  seq += 1;
  return Order.collection.insertOne({
    orderNo: `P9-${seq}-${Math.random().toString(36).slice(2, 7)}`,
    restaurant: new mongoose.Types.ObjectId(String(restaurantId)),
    branch: world.branchA._id,
    status, source, createdAt: createdAt || new Date(), total: 100, items: []
  });
}

const rowFor = (report, name) => report.rows.find(row => row.name === name);

// ── the online ceiling is reported at all ────────────────────────────────────

describe('P2G9 · the dry run reports the online sub-allowance', () => {
  it('THE BRIEF\'S EXAMPLE: 24 online against a ceiling of 20 → OVER, overage 4', async () => {
    const {restaurant, plan} = await tenant('Starter Co', {
      maxMonthlyOrders: 1000, maxMonthlyOnlineOrders: 20
    });
    for (let i = 0; i < 24; i += 1) await insertOrder(restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Starter Co');

    assert.equal(row.online.usage, 24);
    assert.equal(row.online.limit, 20);
    assert.equal(row.online.overage, 4);
    assert.equal(row.online.status, 'OVER');
    // Reported per tenant, with the plan named, as the brief asks.
    assert.equal(row.planCode, plan.code);
    assert.equal(report.onlineOver, 1);
    assert.equal(report.affected, 1, 'an online-only breach must count as affected');
  });

  it('surfaces a tenant who is fine overall but exhausted online', async () => {
    /**
     * The case the old report could not show at all: plenty of overall
     * allowance left, storefront completely full.
     */
    const {restaurant} = await tenant('Web Full', {
      maxMonthlyOrders: 500, maxMonthlyOnlineOrders: 3
    });
    for (let i = 0; i < 3; i += 1) await insertOrder(restaurant._id, 'online');
    for (let i = 0; i < 10; i += 1) await insertOrder(restaurant._id, 'pos');

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Web Full');

    assert.equal(row.overall.status, 'OK', 'the till is nowhere near its ceiling');
    assert.equal(row.online.status, 'AT_LIMIT');
    assert.equal(report.affected, 1);
  });

  it('keeps the pre-P2G.9 flat fields, so existing callers do not break', async () => {
    // `--json` is a machine interface and the P2G.5 tests read these.
    const {restaurant} = await tenant('Compat', {
      maxMonthlyOrders: 5, maxMonthlyOnlineOrders: 2
    });
    for (let i = 0; i < 6; i += 1) await insertOrder(restaurant._id, 'pos');

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Compat');

    assert.equal(row.usage, row.overall.usage);
    assert.equal(row.limit, row.overall.limit);
    assert.equal(row.status, row.overall.status);
    assert.equal(row.status, 'OVER');
    // `over`/`atLimit` still mean the OVERALL figures.
    assert.equal(report.over, 1);
    assert.equal(report.onlineOver, 0);
  });

  it('reports an unsubscribed tenant on both ceilings without crashing', async () => {
    await tenant('No Sub', {}, {subscribe: false});
    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'No Sub');

    assert.equal(row.overall.status, 'NO_SUBSCRIPTION');
    assert.equal(row.online.status, 'NO_SUBSCRIPTION');
    assert.equal(row.online.limit, null);
    // Not "affected" — there is no ceiling to be over.
    assert.equal(report.affected, 0);
  });

  it('reports an unlimited online allowance as UNLIMITED, never as a breach', async () => {
    const {restaurant} = await tenant('Unlimited Web', {
      maxMonthlyOrders: null, maxMonthlyOnlineOrders: null
    });
    for (let i = 0; i < 9; i += 1) await insertOrder(restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Unlimited Web');
    assert.equal(row.online.status, 'UNLIMITED');
    assert.equal(row.online.overage, 0);
    assert.equal(report.affected, 0);
  });
});

// ── at-limit vs over-limit ───────────────────────────────────────────────────

describe('P2G9 · AT LIMIT and OVER are distinguishable', () => {
  it('distinguishes usage == limit from usage > limit', async () => {
    /**
     * The documented semantics, matching enforcement exactly:
     *
     *   usage <  limit   OK        trading normally
     *   usage == limit   AT_LIMIT  the NEXT order is refused
     *   usage >  limit   OVER      already past it, with an overage to clear
     *
     * Both are "affected" — an at-limit tenant is refused on their very next
     * storefront order — but they need different conversations, so they are
     * never collapsed into one label.
     */
    const at = await tenant('At Exactly', {maxMonthlyOrders: 99, maxMonthlyOnlineOrders: 4});
    const over = await tenant('Past It', {maxMonthlyOrders: 99, maxMonthlyOnlineOrders: 4});
    const under = await tenant('Room Left', {maxMonthlyOrders: 99, maxMonthlyOnlineOrders: 4});

    for (let i = 0; i < 4; i += 1) await insertOrder(at.restaurant._id, 'online');
    for (let i = 0; i < 7; i += 1) await insertOrder(over.restaurant._id, 'online');
    for (let i = 0; i < 1; i += 1) await insertOrder(under.restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});

    assert.equal(rowFor(report, 'At Exactly').online.status, 'AT_LIMIT');
    assert.equal(rowFor(report, 'At Exactly').online.overage, 0, 'at-limit has no overage');
    assert.equal(rowFor(report, 'Past It').online.status, 'OVER');
    assert.equal(rowFor(report, 'Past It').online.overage, 3);
    assert.equal(rowFor(report, 'Room Left').online.status, 'OK');

    assert.equal(report.onlineAtLimit, 1);
    assert.equal(report.onlineOver, 1);
    assert.equal(report.affected, 2, 'both need action before enforcement');
  });

  it('an AT_LIMIT tenant really is refused their next online order', async () => {
    // Proves the label is not cosmetic: the dry run's warning is accurate.
    const {restaurant} = await tenant('Verify At Limit', {
      maxMonthlyOrders: 99, maxMonthlyOnlineOrders: 2
    });
    for (let i = 0; i < 2; i += 1) await insertOrder(restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});
    assert.equal(rowFor(report, 'Verify At Limit').online.status, 'AT_LIMIT');

    await assert.rejects(
      () => withMonthlyOnlineOrderQuota(
        {restaurantId: restaurant._id, timezone: 'Asia/Kathmandu'},
        async () => insertOrder(restaurant._id, 'online')
      ),
      error => {
        assert.equal(error.status, 402);
        return true;
      },
      'the dry run said AT_LIMIT but enforcement allowed the order'
    );
  });
});

// ── agreement with enforcement ───────────────────────────────────────────────

describe('P2G9 · dry-run usage === enforcement usage', () => {
  it('agrees with getOnlineOrderUsage across a mixed fixture', async () => {
    /**
     * The fixture the brief asks for, in one tenant: POS orders, online
     * orders, cancelled online orders, current-month and previous-month rows.
     */
    const now = new Date('2026-08-15T12:00:00Z');
    const thisMonth = new Date('2026-08-10T06:00:00Z');
    const lastMonth = new Date('2026-07-10T06:00:00Z');
    const {restaurant} = await tenant('Mixed', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 10
    });
    const id = restaurant._id;

    for (let i = 0; i < 4; i += 1) await insertOrder(id, 'pos', {createdAt: thisMonth});
    for (let i = 0; i < 5; i += 1) await insertOrder(id, 'online', {createdAt: thisMonth});
    for (let i = 0; i < 3; i += 1) {
      await insertOrder(id, 'online', {createdAt: thisMonth, status: 'cancelled'});
    }
    for (let i = 0; i < 6; i += 1) await insertOrder(id, 'online', {createdAt: lastMonth});
    await insertOrder(id, 'pos', {createdAt: thisMonth, status: 'cancelled'});

    const report = await buildOrderQuotaReport({now});
    const row = rowFor(report, 'Mixed');

    const enforcementOnline = await getOnlineOrderUsage(id, {
      now, timezone: 'Asia/Kathmandu'
    });
    const enforcementOverall = await getOrderUsage(id, {now, timezone: 'Asia/Kathmandu'});

    assert.equal(row.online.usage, enforcementOnline, 'online usage disagrees');
    assert.equal(row.overall.usage, enforcementOverall, 'overall usage disagrees');
    // And the expected absolute numbers, so a shared bug in both cannot hide.
    assert.equal(row.online.usage, 5, 'cancelled and previous-month online rows leaked in');
    assert.equal(row.overall.usage, 9);
  });

  it('agrees for a tenant with NO online orders at all', async () => {
    const {restaurant} = await tenant('POS Only', {
      maxMonthlyOrders: 50, maxMonthlyOnlineOrders: 5
    });
    for (let i = 0; i < 7; i += 1) await insertOrder(restaurant._id, 'pos');

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'POS Only');
    assert.equal(row.online.usage, 0);
    assert.equal(
      row.online.usage,
      await getOnlineOrderUsage(restaurant._id, {timezone: 'Asia/Kathmandu'})
    );
    assert.equal(row.online.status, 'OK');
  });

  it('uses Order.source, NOT Order.type', async () => {
    /**
     * The definition the brief singles out. `ONLINE_ORDER_TYPES` is
     * `['delivery','takeaway']`, and a cashier can ring up a takeaway at the
     * till — a POS sale. Counting by `type` would bill it to the storefront.
     */
    assert.equal(ONLINE_ORDER_SOURCE, 'online');
    const {restaurant} = await tenant('Type Trap', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 2
    });
    // Two POS takeaways...
    await Order.collection.insertMany([1, 2].map(i => ({
      orderNo: `TT-${i}-${Math.random().toString(36).slice(2, 6)}`,
      restaurant: restaurant._id, branch: world.branchA._id,
      status: 'completed', source: 'pos', type: 'takeaway',
      createdAt: new Date(), total: 1, items: []
    })));
    // ...and one genuine storefront order.
    await insertOrder(restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Type Trap');
    assert.equal(
      row.online.usage, 1,
      'till takeaways were billed against the storefront allowance'
    );
    assert.equal(row.online.status, 'OK');
  });

  it('the report and the counter agree after real enforced orders', async () => {
    // End to end: reserve through enforcement, then report.
    const {restaurant} = await tenant('Enforced', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 4
    });
    const id = restaurant._id;
    for (let i = 0; i < 3; i += 1) {
      await withMonthlyOnlineOrderQuota(
        {restaurantId: id, timezone: 'Asia/Kathmandu'},
        async () => insertOrder(id, 'online')
      );
    }

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Enforced');
    assert.equal(row.online.usage, 3);
    assert.equal(
      await readQuotaCounter(id, monthlyOnlineOrderResource(new Date(), 'Asia/Kathmandu')),
      row.online.usage,
      'the counter and the report disagree'
    );
  });
});

// ── timezone ─────────────────────────────────────────────────────────────────

describe('P2G9 · tenant-local month boundaries', () => {
  it('counts the online allowance in the TENANT\'S month, not Kathmandu\'s', async () => {
    /**
     * `2026-08-01T02:00Z` is already August in Kathmandu but still July in
     * New York. A hardcoded `offsetMinutes = 345` would put the New York
     * tenant's July orders into August.
     */
    const now = new Date('2026-08-15T12:00:00Z');
    const boundary = new Date('2026-08-01T02:00:00Z');

    const ktm = await tenant('KTM Web', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 10
    }, {timezone: 'Asia/Kathmandu'});
    const nyc = await tenant('NYC Web', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 10
    }, {timezone: 'America/New_York'});

    await insertOrder(ktm.restaurant._id, 'online', {createdAt: boundary});
    await insertOrder(nyc.restaurant._id, 'online', {createdAt: boundary});

    const report = await buildOrderQuotaReport({now});

    assert.equal(rowFor(report, 'KTM Web').online.usage, 1, 'August in Kathmandu');
    assert.equal(rowFor(report, 'NYC Web').online.usage, 0, 'still July in New York');
    assert.equal(rowFor(report, 'NYC Web').month, monthKey(now, 'America/New_York'));
    assert.equal(rowFor(report, 'NYC Web').timezone, 'America/New_York');
  });

  it('a New York tenant\'s July orders are reported in July', async () => {
    const nyc = await tenant('NYC July', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 10
    }, {timezone: 'America/New_York'});
    await insertOrder(nyc.restaurant._id, 'online', {
      createdAt: new Date('2026-08-01T02:00:00Z')
    });

    const july = await buildOrderQuotaReport({now: new Date('2026-07-20T12:00:00Z')});
    assert.equal(rowFor(july, 'NYC July').online.usage, 1);
  });

  it('falls back to the schema default for an unusable timezone', async () => {
    const broken = await Restaurant.create({
      name: 'Broken Zone', currency: 'NPR', timezone: 'Mars/Olympus'
    });
    await insertOrder(broken._id, 'online');
    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Broken Zone');
    assert.equal(row.timezone, 'Asia/Kathmandu', 'a bad zone must not break the run');
    assert.equal(row.online.usage, 1);
  });
});

// ── cancellation semantics ───────────────────────────────────────────────────

describe('P2G9 · cancellation semantics match enforcement', () => {
  it('excludes cancelled online orders, exactly as the usage count does', async () => {
    const {restaurant} = await tenant('Cancelled Web', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 5
    });
    const id = restaurant._id;
    for (let i = 0; i < 2; i += 1) await insertOrder(id, 'online');
    for (let i = 0; i < 4; i += 1) await insertOrder(id, 'online', {status: 'cancelled'});

    const report = await buildOrderQuotaReport({now: new Date()});
    const row = rowFor(report, 'Cancelled Web');
    assert.equal(row.online.usage, 2, 'cancelled online orders were counted');
    assert.equal(
      row.online.usage,
      await getOnlineOrderUsage(id, {timezone: 'Asia/Kathmandu'})
    );
  });

  it('still counts every other status, including refunded and held', async () => {
    // Not an independent decision — inherited from `getOnlineOrderUsage`.
    const {restaurant} = await tenant('Statuses', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 20
    });
    const id = restaurant._id;
    for (const status of ['completed', 'refunded', 'held', 'draft', 'pending']) {
      await insertOrder(id, 'online', {status});
    }
    await insertOrder(id, 'online', {status: 'cancelled'});

    const report = await buildOrderQuotaReport({now: new Date()});
    assert.equal(rowFor(report, 'Statuses').online.usage, 5);
  });
});

// ── the run must stay read-only ──────────────────────────────────────────────

describe('P2G9 · the dry run changes nothing', () => {
  it('writes no counters and touches no orders', async () => {
    const {restaurant} = await tenant('ReadOnly', {
      maxMonthlyOrders: 3, maxMonthlyOnlineOrders: 1
    });
    const id = restaurant._id;
    await withMonthlyOnlineOrderQuota(
      {restaurantId: id, timezone: 'Asia/Kathmandu'},
      async () => insertOrder(id, 'online')
    );

    const countersBefore = await ResourceCounter.find({}).lean();
    const ordersBefore = await Order.find({}).select('_id status').lean();

    await buildOrderQuotaReport({now: new Date()});

    const countersAfter = await ResourceCounter.find({}).lean();
    const ordersAfter = await Order.find({}).select('_id status').lean();

    assert.deepEqual(
      countersAfter.map(c => [c.resource, c.count]).sort(),
      countersBefore.map(c => [c.resource, c.count]).sort(),
      'the dry run mutated a quota counter'
    );
    assert.deepEqual(
      ordersAfter.map(o => `${o._id}:${o.status}`).sort(),
      ordersBefore.map(o => `${o._id}:${o.status}`).sort()
    );
  });

  it('does not consume the online allowance it is reporting on', async () => {
    const {restaurant} = await tenant('Not Consumed', {
      maxMonthlyOrders: 10, maxMonthlyOnlineOrders: 2
    });
    const id = restaurant._id;

    await buildOrderQuotaReport({now: new Date()});
    await buildOrderQuotaReport({now: new Date()});

    // Both seats must still be spendable.
    for (let i = 0; i < 2; i += 1) {
      await withMonthlyOnlineOrderQuota(
        {restaurantId: id, timezone: 'Asia/Kathmandu'},
        async () => insertOrder(id, 'online')
      );
    }
    assert.equal(await getOnlineOrderUsage(id, {timezone: 'Asia/Kathmandu'}), 2);
  });
});

// ── the rendered output ──────────────────────────────────────────────────────

describe('P2G9 · the operator-facing table', () => {
  it('shows both ceilings, the overage, and both statuses', async () => {
    const {restaurant} = await tenant('Print Me', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 20
    });
    for (let i = 0; i < 24; i += 1) await insertOrder(restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});
    const text = render(report);

    assert.match(text, /Online/, 'the online column is missing');
    assert.match(text, /24\/20 \(\+4\)/, 'usage/limit and overage are not shown');
    assert.match(text, /OVER/);
    assert.match(text, /online: 1 OVER, 0 AT LIMIT/);
    // The operational nuance an operator needs.
    assert.match(text, /till\s+keeps working|blocks storefront orders only/);
  });

  it('--only-affected shows an online-only breach', async () => {
    // The old filter keyed off the overall status; an online-only breach would
    // have been filtered out of the very view an operator uses.
    const fine = await tenant('All Good', {maxMonthlyOrders: 99, maxMonthlyOnlineOrders: 99});
    const webOver = await tenant('Web Over', {maxMonthlyOrders: 99, maxMonthlyOnlineOrders: 1});
    await insertOrder(fine.restaurant._id, 'pos');
    for (let i = 0; i < 5; i += 1) await insertOrder(webOver.restaurant._id, 'online');

    const report = await buildOrderQuotaReport({now: new Date()});
    const text = render(report, {onlyAffected: true});

    assert.match(text, /Web Over/);
    assert.ok(!text.includes('All Good'), 'an unaffected tenant was listed');
  });

  it('says plainly when nobody would be blocked', async () => {
    const {restaurant} = await tenant('Calm', {
      maxMonthlyOrders: 100, maxMonthlyOnlineOrders: 100
    });
    await insertOrder(restaurant._id, 'online');
    const report = await buildOrderQuotaReport({now: new Date()});
    assert.equal(report.affected, 0);
    assert.match(render(report), /No tenant would be blocked/);
  });
});
