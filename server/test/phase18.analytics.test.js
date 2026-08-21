/**
 * Phase 18 — reporting and business intelligence.
 *
 * AUDIT FIRST, and one brief premise turned out to be wrong. The brief states
 * that `/api/reports/pnl` runs on "legacy Purchase/Sale/Expense data" and must
 * be moved onto the modern purchasing/ledger architecture. It does not. Proven
 * against the running API before writing any code: a legacy `Sale` of 99,999
 * and a legacy `Purchase` of 77,777 were planted, and P&L reported
 * `revenue: 0` and `purchases: 0`. It already reads `Order`,
 * `InventoryTransaction` and `buildPurchasingReport()`. That test is kept below
 * as a regression guard so nobody reintroduces the legacy read.
 *
 * What P&L was genuinely missing: flat `vat`, `discounts` and `inventoryValue`
 * at the top level — a caller reading them got `undefined`. Fixed additively;
 * the nested `sales` block is untouched.
 *
 * Kitchen analytics (prep time, delayed orders, station performance) already
 * existed at `/api/kitchen/performance` and is audited here, not rebuilt.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, MenuItem, Purchase, Sale, Supplier, User} from '../src/models/index.js';
import {
  Branch, Customer, InventoryBalance, InventoryTransaction, Order, Restaurant
} from '../src/models/operations.js';
import {
  SALES_GRANULARITIES, buildCustomerReport, buildInventoryReport, buildSalesReport,
  isoWeek, kathmanduDay, kathmanduMonth, reportingPeriod
} from '../src/services/analytics.js';
import {
  clearDb, makeOrder, request, seedWorld, startTestApp, stopTestApp, tokenFor
} from './helpers.js';

let world;
let rival;
let seq = 0;
const KEY = () => `p18-${Date.now()}-${++seq}`;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  seq = 0;
  world = await seedWorld();

  const restaurant = await Restaurant.create({name: 'Rival18', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival18 Branch', code: 'R18', address: 'Maharajgunj'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival18 Owner', email: 'rival18@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival18', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

/** Places an order and settles it, so it counts as revenue. */
async function soldOrder({qty = 2, method = 'cash', customer, branch = world.branchA} = {}) {
  const res = await request('/api/orders', {
    method: 'POST', token: owner(),
    body: {
      branch: String(branch._id), type: 'counter',
      items: [{menuItem: String(world.menu._id), qty}],
      ...(customer ? {customer: String(customer._id)} : {})
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const paid = await request(`/api/orders/${res.body._id}/payments`, {
    method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
    body: {amount: res.body.total, method}
  });
  assert.equal(paid.status, 201, JSON.stringify(paid.body));
  return res.body;
}

const salesReport = (query = '', token = manager()) =>
  request(`/api/reports/sales?branch=${world.branchA._id}${query}`, {token});
const inventoryReport = (query = '', token = manager()) =>
  request(`/api/reports/inventory?branch=${world.branchA._id}${query}`, {token});
const customerReport = (query = '', token = manager()) =>
  request(`/api/reports/customers?branch=${world.branchA._id}${query}`, {token});
const pnl = (token = owner()) =>
  request(`/api/reports/pnl?branch=${world.branchA._id}`, {token});

// ═══════════════════════════════════════════════════════════════════════════
// The brief's P&L premise
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — P&L runs on the modern architecture', () => {
  it('ignores legacy Purchase and Sale collections entirely', async () => {
    // The regression guard for the brief's premise. If anyone reintroduces a
    // legacy read, these planted rows will show up and fail the test.
    await Sale.create({
      date: new Date(), total: 99999, cogs: 5000, vat: 1300, subtotal: 88699, items: []
    });
    await Purchase.create({date: new Date(), total: 77777, qty: 1, unitPrice: 77777});

    const res = await pnl();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.revenue, 0, 'a legacy Sale must not become revenue');
    assert.equal(res.body.purchases, 0, 'a legacy Purchase must not become a purchase');
    assert.equal(res.body.cogs, 0);
    assert.equal(res.body.source, 'live');
  });

  it('reports a real order from the Order collection', async () => {
    const order = await soldOrder({qty: 2});
    const res = await pnl();
    assert.equal(res.body.revenue, order.total, 'revenue comes from the modern order');
    assert.ok(res.body.cogs > 0, 'and COGS from the recipe food cost');
  });

  it('surfaces vat, discounts and inventoryValue at the top level', async () => {
    // These existed only under `sales`, so a caller reading the top level got
    // undefined. inventoryValue was absent entirely, so P&L and the dashboard
    // disagreed about what stock the business was holding.
    await soldOrder({qty: 2});
    const res = await pnl();
    assert.equal(typeof res.body.vat, 'number');
    assert.equal(typeof res.body.discounts, 'number');
    assert.equal(typeof res.body.inventoryValue, 'number');
    assert.equal(res.body.vat, res.body.sales.vat, 'flat and nested must agree');
    assert.equal(res.body.discounts, res.body.sales.discounts);
    assert.ok(res.body.inventoryValue > 0, 'the seeded opening stock has value');
  });

  it('agrees with the dashboard on the same period', async () => {
    await soldOrder({qty: 2});
    const [report, dashboard] = await Promise.all([
      pnl(),
      request(`/api/dashboard?branch=${world.branchA._id}`, {token: owner()})
    ]);
    assert.equal(dashboard.status, 200, JSON.stringify(dashboard.body));
    // Two views of one truth must not diverge.
    assert.equal(dashboard.body.revenue, report.body.revenue);
    assert.equal(dashboard.body.inventoryValue, report.body.inventoryValue);
    assert.equal(dashboard.body.grossRevenue, report.body.grossRevenue);
    assert.equal(dashboard.body.refunds, report.body.refunds);
    assert.equal(dashboard.body.grossProfit, report.body.grossProfit);
    assert.equal(dashboard.body.discounts, report.body.sales.discounts);
  });

  it('exposes every dashboard field the brief lists', async () => {
    await soldOrder({qty: 2});
    const res = await request(`/api/dashboard?branch=${world.branchA._id}`, {token: owner()});
    for (const field of [
      'sales', 'purchases', 'grossRevenue', 'discounts', 'refunds',
      'vat', 'cogs', 'grossProfit', 'waste', 'inventoryValue'
    ]) {
      assert.ok(res.body[field] !== undefined, `dashboard must report ${field}`);
    }
  });

  it('nets a refund out of revenue', async () => {
    const order = await soldOrder({qty: 2});
    const refund = await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {amount: 100, reason: 'Partial refund for analytics'}
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));

    const res = await pnl();
    assert.equal(res.body.grossRevenue, order.total);
    assert.equal(res.body.refunds, 100);
    assert.equal(res.body.revenue, order.total - 100, 'refunded money is not revenue');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Date helpers
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — reporting periods', () => {
  it('buckets by the Kathmandu calendar day, not UTC', () => {
    // 23:00 UTC is already the next day in Kathmandu (+05:45). Reporting on the
    // UTC day would put an evening sale in the wrong day's takings.
    assert.equal(kathmanduDay('2026-08-19T23:00:00Z'), '2026-08-20');
    assert.equal(kathmanduDay('2026-08-19T10:00:00Z'), '2026-08-19');
  });

  it('computes ISO weeks and months', () => {
    assert.equal(isoWeek('2026-01-05T06:00:00Z'), '2026-W02');
    assert.equal(kathmanduMonth('2026-08-19T10:00:00Z'), '2026-08');
  });

  it('builds an inclusive-from, exclusive-to window', () => {
    const period = reportingPeriod({from: '2026-08-01', to: '2026-08-31'});
    assert.equal(period.from, '2026-08-01');
    // The window must include all of 31 August and end at the start of
    // 1 September KATHMANDU time. Asserted through kathmanduDay() rather than a
    // raw UTC slice, because 1 Sep 00:00 +05:45 is 31 Aug 18:15 UTC — slicing
    // the UTC string would check the wrong calendar.
    assert.equal(kathmanduDay(period.toExclusive), '2026-09-01');
    assert.equal(kathmanduDay(period.fromDate), '2026-08-01');
    // A sale at 23:30 on 31 August must fall inside the window.
    const lateSale = new Date('2026-08-31T23:30:00+05:45');
    assert.ok(lateSale >= period.fromDate && lateSale < period.toExclusive,
      'the last evening of the range is included');
  });

  it('rejects a malformed or inverted range', () => {
    assert.throws(() => reportingPeriod({from: '19-08-2026'}), /YYYY-MM-DD/);
    assert.throws(() => reportingPeriod({from: '2026-08-31', to: '2026-08-01'}), /must not be after/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Sales
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — sales report', () => {
  it('totals revenue, VAT, COGS and gross profit', async () => {
    const first = await soldOrder({qty: 2});
    const second = await soldOrder({qty: 1});

    const res = await salesReport();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.orders, 2);
    assert.equal(res.body.totals.grossRevenue, first.total + second.total);
    assert.equal(res.body.totals.netRevenue, first.total + second.total);
    assert.ok(res.body.totals.vat > 0);
    assert.ok(res.body.totals.cogs > 0);
    assert.equal(
      res.body.totals.grossProfit,
      Math.round((res.body.totals.netRevenue - res.body.totals.cogs) * 100) / 100
    );
    assert.equal(
      res.body.totals.averageOrderValue,
      Math.round((res.body.totals.netRevenue / 2) * 100) / 100
    );
  });

  it('groups daily, weekly and monthly', async () => {
    await soldOrder({qty: 1});
    for (const granularity of SALES_GRANULARITIES) {
      const res = await salesReport(`&granularity=${granularity}`);
      assert.equal(res.status, 200, granularity);
      assert.equal(res.body.period.granularity, granularity);
      assert.equal(res.body.byPeriod.length, 1, `${granularity} produced one bucket`);
      const key = res.body.byPeriod[0].period;
      if (granularity === 'daily') assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
      if (granularity === 'weekly') assert.match(key, /^\d{4}-W\d{2}$/);
      if (granularity === 'monthly') assert.match(key, /^\d{4}-\d{2}$/);
    }
  });

  it('rejects an unknown granularity', async () => {
    const res = await salesReport('&granularity=hourly');
    assert.equal(res.status, 400);
  });

  it('breaks down by item and category', async () => {
    const drink = await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Masala Tea', category: 'Beverages',
      price: 80, vatInclusive: false, active: true
    });
    await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 2}, {menuItem: String(drink._id), qty: 3}]
      }
    });

    const res = await salesReport();
    const rice = res.body.byItem.find(row => row.name === 'Chicken Biryani');
    const tea = res.body.byItem.find(row => row.name === 'Masala Tea');
    assert.ok(rice, 'the seeded menu item appears');
    assert.equal(tea.qty, 3);

    const beverages = res.body.byCategory.find(row => row.category === 'Beverages');
    assert.ok(beverages, 'categories are grouped');
    assert.equal(beverages.qty, 3);
  });

  it('splits by payment method from the payment rows, not the order', async () => {
    // An order settled across two tenders must be reported as two tenders.
    const order = await soldOrder({qty: 2, method: 'cash'});
    const split = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 2}]}
    });
    await request(`/api/orders/${split.body._id}/payments`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {amount: 300, method: 'cash'}
    });
    await request(`/api/orders/${split.body._id}/payments`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {amount: split.body.total - 300, method: 'khalti'}
    });

    const res = await salesReport();
    const byMethod = Object.fromEntries(res.body.byPaymentMethod.map(row => [row.method, row]));
    assert.ok(byMethod.cash, 'cash tender');
    assert.ok(byMethod.khalti, 'the second tender is reported separately');
    assert.equal(byMethod.khalti.amount, split.body.total - 300);
    assert.equal(byMethod.cash.amount, order.total + 300);
  });

  it('nets a refund out of net revenue but keeps gross intact', async () => {
    const order = await soldOrder({qty: 2});
    const refund = await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {amount: 100, reason: 'Sales report refund'}
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));

    const res = await salesReport();
    assert.equal(res.body.totals.grossRevenue, order.total, 'gross is what was rung up');
    assert.equal(res.body.totals.refunds, 100);
    assert.equal(res.body.totals.netRevenue, order.total - 100, 'net excludes money given back');
    assert.equal(
      res.body.totals.averageOrderValue, Math.round((order.total - 100) * 100) / 100,
      'AOV is based on net revenue'
    );
    // The period bucket must agree with the totals.
    assert.equal(res.body.byPeriod[0].netRevenue, order.total - 100);
    assert.equal(res.body.byPeriod[0].refunds, 100);
  });

  it('excludes a reversed tender from the payment split', async () => {
    // A reversed payment was never really taken; counting it would overstate
    // what came in through that method.
    const order = await soldOrder({qty: 2, method: 'cash'});
    const {Payment} = await import('../src/models/operations.js');
    const payment = await Payment.findOne({order: order._id, amount: {$gt: 0}});
    const reversed = await request(`/api/payments/${payment._id}/reverse`, {
      method: 'POST', token: owner(), body: {reason: 'Wrong tender at the till'}
    });
    assert.equal(reversed.status, 200, JSON.stringify(reversed.body));

    const res = await salesReport();
    const cash = res.body.byPaymentMethod.find(row => row.method === 'cash');
    assert.equal(cash, undefined, 'a reversed tender must not be reported as money taken');
    assert.equal(res.body.byPaymentMethod.length, 0);
  });

  it('excludes cancelled orders from revenue', async () => {
    const order = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    const cancelled = await request(`/api/orders/${order.body._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));

    const res = await salesReport();
    assert.equal(res.body.totals.orders, 0, 'a cancelled order is not a sale');
    assert.equal(res.body.totals.grossRevenue, 0);
  });

  it('reports each branch separately for an owner', async () => {
    await soldOrder({qty: 1, branch: world.branchA});
    await soldOrder({qty: 1, branch: world.branchB});

    const res = await request('/api/reports/sales', {token: owner()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.byBranch.length, 2);
    const codes = res.body.byBranch.map(row => row.branchCode).sort();
    assert.deepEqual(codes, ['KTM', 'LTP']);
  });

  it('honours a date window', async () => {
    await soldOrder({qty: 1});
    const today = kathmanduDay();
    const inRange = await salesReport(`&from=${today}&to=${today}`);
    assert.equal(inRange.body.totals.orders, 1);

    const past = await salesReport('&from=2020-01-01&to=2020-01-31');
    assert.equal(past.body.totals.orders, 0, 'an out-of-range sale must not appear');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inventory
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — inventory report', () => {
  it('values stock on hand from balances', async () => {
    const res = await inventoryReport();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // Seeded: 20000g at 0.045 = 900.
    assert.equal(res.body.stockValue, 900);
    assert.match(res.body.valuationBasis, /weighted average/i);
    assert.ok(res.body.topValue.length >= 1);
    assert.equal(res.body.topValue[0].name, 'Basmati Rice');
  });

  it('reports movement grouped by ledger type', async () => {
    await soldOrder({qty: 2});
    const res = await inventoryReport();
    const byType = Object.fromEntries(res.body.movement.byType.map(row => [row.type, row]));
    assert.ok(byType.RECIPE_DEDUCTION, 'the sale deducted stock');
    assert.ok(byType.RECIPE_DEDUCTION.quantity > 0);
    assert.ok(res.body.movement.transactions >= 1);
  });

  it('reports waste separately with its value', async () => {
    const res = await request('/api/waste/record', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: 100, reason: 'spoiled', notes: 'Spoiled overnight'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const report = await inventoryReport();
    assert.ok(report.body.waste.value > 0, 'waste carries a cost');
    assert.equal(report.body.waste.quantity, 100);
    assert.equal(report.body.waste.events, 1);
    assert.equal(report.body.waste.byIngredient[0].name, 'Basmati Rice');
  });

  it('reports adjustments separately from waste', async () => {
    await request('/api/inventory/adjustments', {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: -50, reason: 'Counted short at the shelf'
      }
    });
    const res = await inventoryReport();
    assert.equal(res.body.adjustments.quantity, 50);
    assert.equal(res.body.adjustments.events, 1);
    assert.equal(res.body.waste.events, 0, 'an adjustment is not waste');
  });

  it('reports count variance from approved counts only', async () => {
    const {ensureStockCountIndexes} = await import('../src/services/stockCountMigration.js');
    await ensureStockCountIndexes();

    const created = await request('/api/stock-counts', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(world.branchA._id), scope: 'full', notes: 'Analytics count'}
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const patched = await request(`/api/stock-counts/${created.body._id}`, {
      method: 'PATCH', token: manager(),
      body: {
        expectedVersion: created.body.__v,
        lines: created.body.lines.map(line => ({lineId: String(line._id), physicalQty: 19500}))
      }
    });
    const submitted = await request(`/api/stock-counts/${created.body._id}/submit`, {
      method: 'POST', token: manager(), body: {expectedVersion: patched.body.__v}
    });

    // Submitted but not approved: it must NOT count as variance yet.
    const before = await inventoryReport();
    assert.equal(before.body.countVariance.counts, 0, 'an unapproved count is not evidence');

    const approved = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {expectedVersion: submitted.body.__v, note: 'Approved for analytics'}
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const after = await inventoryReport();
    assert.equal(after.body.countVariance.counts, 1);
    assert.ok(after.body.countVariance.varianceLines >= 1);
    assert.ok(after.body.countVariance.recent[0].countNo);
  });

  it('reports expiry exposure by tier', async () => {
    const res = await inventoryReport();
    const {expired, expiring, fresh} = res.body.expiry;
    for (const tier of [expired, expiring, fresh]) {
      assert.equal(typeof tier.count, 'number');
      assert.equal(typeof tier.value, 'number');
    }
    // The seeded opening lot has no expiry date, so it is not expiring.
    assert.equal(expired.count, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Customers
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — customer report', () => {
  async function customer(name, phone) {
    return Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, name, phone
    });
  }

  it('measures repeat customers, AOV and the top list', async () => {
    const regular = await customer('Regular Guest', '9800000101');
    const oneOff = await customer('One Off', '9800000102');
    await soldOrder({qty: 2, customer: regular});
    await soldOrder({qty: 2, customer: regular});
    await soldOrder({qty: 1, customer: oneOff});

    const res = await customerReport();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.totals.customers, 2);
    assert.equal(res.body.totals.repeatCustomers, 1, 'only the two-order guest repeats');
    assert.equal(res.body.totals.repeatRate, 50);
    assert.match(res.body.totals.repeatBasis, /within the reporting period/);

    const top = res.body.topCustomers[0];
    assert.equal(top.name, 'Regular Guest');
    assert.equal(top.orders, 2);
    assert.equal(top.repeat, true);
    assert.equal(top.averageOrderValue, Math.round((top.revenue / 2) * 100) / 100);
  });

  it('separates anonymous walk-in revenue from identified customers', async () => {
    const known = await customer('Known Guest', '9800000103');
    await soldOrder({qty: 2, customer: known});
    await soldOrder({qty: 2}); // no customer

    const res = await customerReport();
    assert.equal(res.body.totals.orders, 2);
    assert.equal(res.body.totals.identifiedOrders, 1);
    assert.equal(res.body.totals.anonymousOrders, 1);
    assert.ok(res.body.totals.anonymousRevenue > 0, 'walk-in money is still revenue');
    assert.equal(
      res.body.totals.revenue,
      Math.round((res.body.totals.identifiedRevenue + res.body.totals.anonymousRevenue) * 100) / 100
    );
  });

  it('nets a refund out of a customer total', async () => {
    const guest = await customer('Refunded Guest', '9800000104');
    const order = await soldOrder({qty: 2, customer: guest});
    await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {amount: 100, reason: 'Analytics refund'}
    });

    const res = await customerReport();
    const row = res.body.topCustomers.find(item => item.name === 'Refunded Guest');
    assert.equal(row.revenue, order.total - 100, 'a refund reduces what the guest spent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Kitchen — audited, already present
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — kitchen analytics (existing endpoint)', () => {
  it('reports prep time, delayed orders and station performance', async () => {
    const res = await request(`/api/kitchen/performance?branch=${world.branchA._id}`, {token: manager()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The brief's three kitchen requirements, all already served here.
    assert.ok('averagePrepMinutes' in res.body.summary, 'prep time');
    assert.ok('delayedOrders' in res.body.summary, 'delayed orders');
    assert.ok(Array.isArray(res.body.stations), 'station performance');
    assert.ok('onTimeRate' in res.body.summary);
    assert.ok(Array.isArray(res.body.slowestTickets));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Purchasing — audited, already present and integrated
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — purchasing analytics (existing endpoints)', () => {
  it('still serves the purchasing report family', async () => {
    for (const path of [
      `/api/reports/purchasing?branch=${world.branchA._id}`,
      `/api/reports/purchase-by-supplier?branch=${world.branchA._id}`,
      `/api/reports/purchase-by-branch?branch=${world.branchA._id}`,
      `/api/reports/ingredient-purchase-prices?branch=${world.branchA._id}`,
      `/api/reports/unpaid-invoices?branch=${world.branchA._id}`
    ]) {
      const res = await request(path, {token: manager()});
      assert.equal(res.status, 200, `${path} -> ${res.status}`);
    }
  });

  it('P&L integrates the purchasing report rather than recomputing it', async () => {
    const res = await pnl();
    assert.ok(res.body.purchasing, 'the purchasing block is present');
    for (const field of ['acceptedValue', 'returnedValue', 'netStockValue', 'invoiced', 'paid', 'due']) {
      assert.ok(field in res.body.purchasing, `purchasing.${field}`);
    }
    assert.equal(res.body.purchases, res.body.purchasing.netStockValue,
      'the headline purchases figure is the purchasing ledger value');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorisation and tenancy
// ═══════════════════════════════════════════════════════════════════════════

describe('18 — authorisation and tenancy', () => {
  const PATHS = () => [
    `/api/reports/sales?branch=${world.branchA._id}`,
    `/api/reports/inventory?branch=${world.branchA._id}`,
    `/api/reports/customers?branch=${world.branchA._id}`
  ];

  it('refuses anonymous and forged tokens', async () => {
    for (const path of PATHS()) {
      assert.equal((await request(path)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {token: 'not.a.jwt'})).status, 401, `${path} forged`);
    }
  });

  it('is management only', async () => {
    for (const path of PATHS()) {
      assert.equal((await request(path, {token: staff()})).status, 403, `${path} staff`);
    }
  });

  it('refuses a branch the manager is not assigned to', async () => {
    // world.manager is bound to branch A.
    for (const path of [
      `/api/reports/sales?branch=${world.branchB._id}`,
      `/api/reports/inventory?branch=${world.branchB._id}`,
      `/api/reports/customers?branch=${world.branchB._id}`
    ]) {
      assert.equal((await request(path, {token: manager()})).status, 403, path);
    }
  });

  it('never leaks another restaurant figures', async () => {
    await soldOrder({qty: 2});
    const intruder = tokenFor(rival.owner);

    for (const path of PATHS()) {
      const res = await request(path, {token: intruder});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }

    // And their own restaurant-wide report sees none of our sales.
    const theirs = await request('/api/reports/sales', {token: intruder});
    assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
    assert.equal(theirs.body.totals.orders, 0, 'another tenant sees none of our revenue');
    assert.equal(theirs.body.totals.grossRevenue, 0);

    const theirInventory = await request('/api/reports/inventory', {token: intruder});
    assert.equal(theirInventory.body.stockValue, 0, 'nor our stock');
  });

  it('rejects a forged branch id', async () => {
    const forged = new mongoose.Types.ObjectId();
    const res = await request(`/api/reports/sales?branch=${forged}`, {token: manager()});
    assert.ok([403, 404].includes(res.status), `got ${res.status}`);
    assert.equal(
      (await request('/api/reports/sales?branch=not-an-id', {token: manager()})).status, 400,
      'a malformed branch id must fail validation'
    );
  });

  it('never writes: a report leaves the database untouched', async () => {
    await soldOrder({qty: 2});
    const before = {
      orders: await Order.countDocuments({}),
      ledger: await InventoryTransaction.countDocuments({}),
      balances: await InventoryBalance.find({}).sort({_id: 1}).lean()
    };

    await salesReport();
    await inventoryReport();
    await customerReport();
    await pnl();

    assert.equal(await Order.countDocuments({}), before.orders);
    assert.equal(await InventoryTransaction.countDocuments({}), before.ledger, 'analytics must post no ledger row');
    const after = await InventoryBalance.find({}).sort({_id: 1}).lean();
    for (let i = 0; i < before.balances.length; i += 1) {
      assert.equal(after[i].quantity, before.balances[i].quantity, 'reading must not move stock');
      assert.equal(after[i].ledgerVersion, before.balances[i].ledgerVersion);
    }
  });
});
