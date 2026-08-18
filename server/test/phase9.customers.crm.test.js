/**
 * Phase 9 — Customer management & CRM.
 *
 * The central decision under test: customers are RESTAURANT-WIDE, with the
 * branch retained only as a home/attribution field. The tests therefore push
 * hard on two things that the old branch-scoped model got wrong — one person
 * ordering at two branches must be ONE profile, and the tenant boundary must
 * be the restaurant rather than the branch.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, MenuItem, User} from '../src/models/index.js';
import {Branch, Customer, Order, Payment, Restaurant} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {normalizePhone, tierFor, recalculateCustomerStats} from '../src/services/customers.js';
import {migrateCustomers} from '../src/services/customerMigration.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Customer.init();
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const BRANCH = () => String(world.branchA._id);
const BRANCH_B = () => String(world.branchB._id);

const createCustomer = (body, token = manager()) =>
  request('/api/customers', {method: 'POST', token, body});

/** A second restaurant, for isolation probes. */
async function seedRival() {
  const restaurant = await Restaurant.create({name: 'Rival Kitchen', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL', address: 'Thamel'
  });
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rival@test.com', password: 'x', role: 'owner',
    restaurant: 'Rival Kitchen', restaurantId: restaurant._id
  });
  return {restaurant, branch, owner: rivalOwner};
}

// ═══════════════════════════════════════════════════════════════════════════
// Phone normalisation — the foundation of deduplication
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — phone normalisation', () => {
  it('treats every way of writing one Nepali number as the same person', () => {
    const expected = '9800000001';
    for (const written of [
      '9800000001', '+977 9800000001', '977-9800-000001', '09800000001',
      '  9800 000 001  ', '00977 9800000001', '+9779800000001'
    ]) {
      assert.equal(normalizePhone(written), expected, `${written} must normalise`);
    }
  });

  it('keeps genuinely different numbers apart', () => {
    assert.notEqual(normalizePhone('9800000001'), normalizePhone('9800000002'));
    assert.equal(normalizePhone(''), '');
    assert.equal(normalizePhone(null), '');
    assert.equal(normalizePhone('not a phone'), '');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Create
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — create', () => {
  it('creates a profile with preferences, notes and tags', async () => {
    const res = await createCustomer({
      name: 'Sita Sharma',
      phone: '9800000010',
      email: 'sita@example.com',
      branch: BRANCH(),
      addresses: [{label: 'Home', address: 'Jhamsikhel, Lalitpur', default: true}],
      notes: 'Always calls ahead. Difficult stairs.',
      preferences: {dietary: 'vegetarian', spiceLevel: 'hot', allergies: ['peanut']},
      tags: ['VIP', 'Regular']
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Sita Sharma');
    assert.equal(res.body.preferences.dietary, 'vegetarian');
    assert.deepEqual(res.body.tags, ['vip', 'regular'], 'tags normalise to lowercase');
    assert.equal(res.body.loyalty.tier, 'bronze');
    assert.equal(res.body.active, true);

    const stored = await Customer.findById(res.body._id);
    assert.equal(String(stored.restaurant), String(world.restaurant._id),
      'the profile belongs to the restaurant, not only a branch');
    assert.equal(stored.phoneKey, '9800000010');
  });

  it('audits creation', async () => {
    const res = await createCustomer({name: 'Ram', phone: '9800000011', branch: BRANCH()});
    const entry = await Audit.findOne({action: 'customer_created', entityId: res.body._id}).lean();
    assert.ok(entry, 'creating a customer must be audited');
  });

  it('rejects a profile with no usable phone number', async () => {
    const res = await createCustomer({name: 'Ghost', phone: 'abcdefg', branch: BRANCH()});
    assert.equal(res.status, 400);
  });

  it('rejects unknown fields rather than silently dropping them', async () => {
    const res = await createCustomer({
      name: 'Ram', phone: '9800000012', branch: BRANCH(), loyaltyPoints: 99999
    });
    assert.equal(res.status, 400, 'loyalty balances are derived, never client-supplied');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Duplicate protection
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — duplicate protection', () => {
  it('refuses a second profile for the same phone, and names the original', async () => {
    const first = await createCustomer({name: 'Sita', phone: '9800000020', branch: BRANCH()});
    assert.equal(first.status, 201);

    const second = await createCustomer({name: 'Sita S.', phone: '+977 9800000020', branch: BRANCH()});
    assert.equal(second.status, 409, 'a formatted variant is the same person');
    assert.equal(second.body.existingCustomerId, String(first.body._id),
      'the UI needs the existing id so it can open that profile');
    assert.equal(await Customer.countDocuments({phoneKey: '9800000020'}), 1);
  });

  it('deduplicates one person across two branches of the same restaurant', async () => {
    // This is exactly what the pre-Phase-9 branch-scoped model got wrong.
    const first = await createCustomer({name: 'Hari', phone: '9800000021', branch: BRANCH()});
    assert.equal(first.status, 201);
    const second = await createCustomer({name: 'Hari', phone: '9800000021', branch: BRANCH_B()}, owner());
    assert.equal(second.status, 409, 'a chain guest is one person, not one per branch');
    assert.equal(await Customer.countDocuments({restaurant: world.restaurant._id}), 1);
  });

  it('lets two different restaurants each hold the same phone number', async () => {
    const rival = await seedRival();
    await createCustomer({name: 'Shared', phone: '9800000022', branch: BRANCH()});
    const theirs = await createCustomer(
      {name: 'Shared', phone: '9800000022', branch: String(rival.branch._id)},
      tokenFor(rival.owner)
    );
    assert.equal(theirs.status, 201, 'tenants are independent');
    assert.equal(await Customer.countDocuments({phoneKey: '9800000022'}), 2);
  });

  it('enforces uniqueness at the database, not just in application code', async () => {
    await createCustomer({name: 'Ram', phone: '9800000023', branch: BRANCH()});
    await assert.rejects(
      Customer.create({
        restaurant: world.restaurant._id, branch: world.branchA._id,
        name: 'Duplicate', phone: '9800000023', phoneKey: '9800000023'
      }),
      error => error.code === 11000,
      'the unique index is the real guarantee'
    );
  });

  it('converges the public storefront on the same profile', async () => {
    const staffMade = await createCustomer({name: 'Gita', phone: '9800000024', branch: BRANCH()});
    assert.equal(staffMade.status, 201);

    // A guest orders online with the same number, formatted differently.
    const online = await request('/api/public/orders', {
      method: 'POST',
      body: {
        branch: BRANCH(), type: 'takeaway',
        items: [{menuItem: String(world.menu._id), qty: 1}],
        customer: {name: 'Gita', phone: '+977-9800000024'},
        paymentMethod: 'cod'
      }
    });
    assert.equal(online.status, 201, JSON.stringify(online.body));
    assert.equal(await Customer.countDocuments({restaurant: world.restaurant._id}), 1,
      'the storefront must reuse the CRM profile, not fork a new one');

    const order = await Order.findOne({orderNo: online.body.orderNo});
    assert.equal(String(order.customer), String(staffMade.body._id));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Update
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — update', () => {
  it('updates contact details, notes and preferences', async () => {
    const created = await createCustomer({name: 'Bikash', phone: '9800000030', branch: BRANCH()});
    const res = await request(`/api/customers/${created.body._id}`, {
      method: 'PATCH', token: manager(),
      body: {
        name: 'Bikash Rai', email: 'bikash@example.com',
        notes: 'Prefers window seat', preferences: {spiceLevel: 'mild'}, tags: ['Corporate']
      }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Bikash Rai');
    assert.equal(res.body.preferences.spiceLevel, 'mild');
    assert.equal(res.body.preferences.dietary, 'none', 'unspecified preferences survive');
    assert.deepEqual(res.body.tags, ['corporate']);
  });

  it('allows a phone change but not onto another customer\'s number', async () => {
    const a = await createCustomer({name: 'A', phone: '9800000031', branch: BRANCH()});
    const b = await createCustomer({name: 'B', phone: '9800000032', branch: BRANCH()});

    const moved = await request(`/api/customers/${a.body._id}`, {
      method: 'PATCH', token: manager(), body: {phone: '9800000099'}
    });
    assert.equal(moved.status, 200);
    assert.equal((await Customer.findById(a.body._id)).phoneKey, '9800000099');

    const clash = await request(`/api/customers/${a.body._id}`, {
      method: 'PATCH', token: manager(), body: {phone: '9800000032'}
    });
    assert.equal(clash.status, 409, 'two profiles may not share a number');
    assert.match(clash.body.message, /already uses this phone/);
  });

  it('refuses client-supplied lifetime statistics', async () => {
    const created = await createCustomer({name: 'C', phone: '9800000033', branch: BRANCH()});
    const res = await request(`/api/customers/${created.body._id}`, {
      method: 'PATCH', token: manager(),
      body: {stats: {totalSpend: 999999}}
    });
    assert.equal(res.status, 400, 'spend is derived from orders and must not be typed in');
  });

  it('audits an update with a before image', async () => {
    const created = await createCustomer({name: 'D', phone: '9800000034', branch: BRANCH()});
    await request(`/api/customers/${created.body._id}`, {
      method: 'PATCH', token: manager(), body: {name: 'D Updated'}
    });
    const entry = await Audit.findOne({action: 'customer_updated'}).lean();
    assert.ok(entry);
    assert.equal(entry.before.name, 'D');
    assert.equal(entry.after.name, 'D Updated');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Search
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — search', () => {
  beforeEach(async () => {
    await createCustomer({
      name: 'Anita Gurung', phone: '9801111111', email: 'anita@example.com', branch: BRANCH()
    });
    await createCustomer({
      name: 'Binod Thapa', phone: '9802222222', email: 'binod@example.com', branch: BRANCH_B()
    }, owner());
  });

  it('finds by full and partial phone, however it is typed', async () => {
    for (const term of ['9801111111', '+977 9801111111', '98011']) {
      const res = await request(`/api/customers/search?q=${encodeURIComponent(term)}`, {token: staff()});
      assert.equal(res.status, 200);
      assert.equal(res.body.customers.length, 1, `"${term}" must find Anita`);
      assert.equal(res.body.customers[0].name, 'Anita Gurung');
    }
  });

  it('finds by name, case-insensitively and partially', async () => {
    const res = await request('/api/customers/search?q=gurung', {token: staff()});
    assert.equal(res.body.customers.length, 1);
    assert.equal(res.body.customers[0].name, 'Anita Gurung');
  });

  it('finds by email', async () => {
    const res = await request('/api/customers/search?q=binod@example.com', {token: staff()});
    assert.equal(res.body.customers.length, 1);
    assert.equal(res.body.customers[0].name, 'Binod Thapa');
  });

  it('finds by customer id', async () => {
    const anita = await Customer.findOne({phoneKey: '9801111111'});
    const res = await request(`/api/customers/search?q=${anita._id}`, {token: staff()});
    assert.equal(res.body.customers.length, 1);
    assert.equal(res.body.customers[0].name, 'Anita Gurung');
  });

  it('searches the whole restaurant, across branches, by default', async () => {
    const res = await request('/api/customers/search', {token: owner()});
    assert.equal(res.body.total, 2, 'both branches are one customer base');
    assert.equal(res.body.scope, 'restaurant');
  });

  it('can still narrow to a home branch when asked', async () => {
    const res = await request(`/api/customers/search?branch=${BRANCH_B()}`, {token: owner()});
    assert.equal(res.body.total, 1);
    assert.equal(res.body.customers[0].name, 'Binod Thapa');
  });

  it('treats a search term as data, not as a regular expression', async () => {
    const res = await request('/api/customers/search?q=' + encodeURIComponent('.*'), {token: staff()});
    assert.equal(res.status, 200);
    assert.equal(res.body.customers.length, 0, 'an injected wildcard must not match everyone');
  });

  it('hides deactivated customers unless they are asked for', async () => {
    const anita = await Customer.findOne({phoneKey: '9801111111'});
    await request(`/api/customers/${anita._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.equal((await request('/api/customers/search', {token: staff()})).body.total, 1);
    assert.equal(
      (await request('/api/customers/search?includeInactive=true', {token: staff()})).body.total, 2
    );
  });

  it('paginates', async () => {
    const res = await request('/api/customers/search?limit=1&page=2', {token: owner()});
    assert.equal(res.body.customers.length, 1);
    assert.equal(res.body.page, 2);
    assert.equal(res.body.pages, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorization and privacy
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — authorization and privacy', () => {
  it('exposes nothing to an unauthenticated caller', async () => {
    const created = await createCustomer({name: 'Private', phone: '9800000040', branch: BRANCH()});
    for (const [path, options] of [
      ['/api/customers/search?q=9800000040', {}],
      ['/api/customers/summary', {}],
      [`/api/customers/${created.body._id}`, {}],
      [`/api/customers/${created.body._id}/history`, {}],
      ['/api/customers', {method: 'POST', body: {name: 'X', phone: '9', branch: BRANCH()}}]
    ]) {
      const res = await request(path, options);
      assert.equal(res.status, 401, `${path} must require authentication`);
    }
  });

  it('keeps customer data out of every public storefront response', async () => {
    await createCustomer({
      name: 'Private Person', phone: '9800000041', email: 'private@example.com', branch: BRANCH()
    });
    const order = await request('/api/public/orders', {
      method: 'POST',
      body: {
        branch: BRANCH(), type: 'takeaway',
        items: [{menuItem: String(world.menu._id), qty: 1}],
        customer: {name: 'Private Person', phone: '9800000041'},
        paymentMethod: 'cod'
      }
    });
    assert.equal(order.status, 201);
    // The public order confirmation must not echo the CRM profile back.
    const serialised = JSON.stringify(order.body);
    assert.doesNotMatch(serialised, /private@example\.com|loyalty|totalSpend|notes/i);

    const tracked = await request(
      `/api/public/orders/track?orderNo=${order.body.orderNo}&phone=9800000041`
    );
    assert.equal(tracked.status, 200);
    assert.doesNotMatch(JSON.stringify(tracked.body), /private@example\.com|loyalty|totalSpend/i);
  });

  it('lets staff serve a guest but reserves supervisor actions', async () => {
    const created = await createCustomer({name: 'E', phone: '9800000042', branch: BRANCH()}, staff());
    assert.equal(created.status, 201, 'staff must be able to add a walk-in');
    assert.equal(
      (await request(`/api/customers/${created.body._id}`, {token: staff()})).status, 200
    );

    // Loyalty and deactivation are not counter-staff decisions.
    assert.equal((await request(`/api/customers/${created.body._id}/loyalty`, {
      method: 'POST', token: staff(), body: {delta: 500}
    })).status, 403);
    assert.equal((await request(`/api/customers/${created.body._id}/active`, {
      method: 'PATCH', token: staff(), body: {active: false}
    })).status, 403);
    assert.equal((await request(`/api/customers/${created.body._id}/active`, {
      method: 'PATCH', token: manager(), body: {active: false}
    })).status, 403, 'deactivation is an owner action');
  });

  it('never leaks another restaurant\'s customers', async () => {
    const rival = await seedRival();
    const theirs = await createCustomer(
      {name: 'Their Guest', phone: '9805555555', branch: String(rival.branch._id)},
      tokenFor(rival.owner)
    );
    assert.equal(theirs.status, 201);

    // Not in our search…
    const search = await request('/api/customers/search?q=9805555555', {token: owner()});
    assert.equal(search.body.customers.length, 0);

    // …and not readable by direct id. 404, not 403: a 403 would confirm it exists.
    for (const path of [
      `/api/customers/${theirs.body._id}`,
      `/api/customers/${theirs.body._id}/history`
    ]) {
      const res = await request(path, {token: owner()});
      assert.equal(res.status, 404, `${path} must not reveal a rival record`);
    }

    // …and not writable.
    assert.equal((await request(`/api/customers/${theirs.body._id}`, {
      method: 'PATCH', token: owner(), body: {name: 'Hijacked'}
    })).status, 404);
    assert.equal((await Customer.findById(theirs.body._id)).name, 'Their Guest');
  });

  it('refuses to create a customer against another restaurant\'s branch', async () => {
    const rival = await seedRival();
    const res = await createCustomer(
      {name: 'Trespass', phone: '9806666666', branch: String(rival.branch._id)},
      owner()
    );
    assert.ok([403, 404].includes(res.status), `expected a refusal, got ${res.status}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Order history and derived statistics
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — history and statistics', () => {
  /** Place a counter order, settle it, and return the order. */
  async function completedOrder(customerId, qty = 1) {
    const created = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'counter', customer: String(customerId),
        items: [{menuItem: String(world.menu._id), qty}]
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const paid = await request(`/api/orders/${created.body._id}/payments`, {
      method: 'POST', token: manager(),
      body: {amount: created.body.total, method: 'cash'}
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    return created.body;
  }

  it('derives lifetime figures from real orders', async () => {
    const customer = await createCustomer({name: 'Regular', phone: '9800000050', branch: BRANCH()});
    const id = customer.body._id;

    const first = await completedOrder(id, 1);
    const second = await completedOrder(id, 2);

    const res = await request(`/api/customers/${id}`, {token: manager()});
    const stats = res.body.stats;
    assert.equal(stats.totalOrders, 2);
    assert.equal(stats.completedOrders, 2);
    assert.equal(stats.totalSpend, first.total + second.total);
    assert.equal(stats.averageOrderValue, (first.total + second.total) / 2);
    assert.ok(stats.firstOrderAt, 'first order is recorded');
    assert.ok(stats.lastOrderAt, 'last order is recorded');
    assert.ok(new Date(stats.lastOrderAt) >= new Date(stats.firstOrderAt));
  });

  it('subtracts refunds from lifetime spend', async () => {
    const customer = await createCustomer({name: 'Refunded', phone: '9800000051', branch: BRANCH()});
    const id = customer.body._id;
    const order = await completedOrder(id, 2);

    const before = (await request(`/api/customers/${id}`, {token: manager()})).body.stats;
    assert.equal(before.totalSpend, order.total);

    const refund = await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: manager(), body: {amount: 100, reason: 'Wrong item'}
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));

    const after = (await request(`/api/customers/${id}`, {token: manager()})).body.stats;
    assert.equal(after.totalRefunded, 100);
    assert.equal(after.totalSpend, order.total - 100,
      'money given back is not lifetime spend');
  });

  it('excludes cancelled orders from spend but still counts them', async () => {
    const customer = await createCustomer({name: 'Canceller', phone: '9800000052', branch: BRANCH()});
    const id = customer.body._id;
    await completedOrder(id, 1);

    const doomed = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'counter', customer: String(id),
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    await Order.updateOne({_id: doomed.body._id}, {$set: {status: 'cancelled'}});
    await recalculateCustomerStats(id);

    const stats = (await request(`/api/customers/${id}`, {token: manager()})).body.stats;
    assert.equal(stats.totalOrders, 2);
    assert.equal(stats.completedOrders, 1);
    assert.equal(stats.cancelledOrders, 1);
    assert.equal(stats.totalSpend, stats.averageOrderValue, 'only the settled order counts');
  });

  it('returns a full relationship history', async () => {
    const customer = await createCustomer({name: 'Historic', phone: '9800000053', branch: BRANCH()});
    const id = customer.body._id;
    const order = await completedOrder(id, 1);

    const res = await request(`/api/customers/${id}/history`, {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.orders.length, 1);
    assert.equal(res.body.orders[0].orderNo, order.orderNo);
    assert.equal(res.body.orders[0].payments.length, 1);
    assert.equal(res.body.orders[0].payments[0].method, 'cash');
    assert.ok(Array.isArray(res.body.refunds));
    assert.ok(Array.isArray(res.body.cancellations));
    assert.ok(Array.isArray(res.body.deliveries));
    assert.equal(res.body.orders[0].itemCount, 1);
  });

  it('aggregates history across branches for one person', async () => {
    const customer = await createCustomer({name: 'Roamer', phone: '9800000054', branch: BRANCH()});
    const id = customer.body._id;
    await completedOrder(id, 1);

    // Same guest, other branch.
    const atB = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: BRANCH_B(), type: 'counter', customer: String(id),
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(atB.status, 201, JSON.stringify(atB.body));
    await request(`/api/orders/${atB.body._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: atB.body.total, method: 'cash'}
    });

    const history = await request(`/api/customers/${id}/history`, {token: owner()});
    assert.equal(history.body.orders.length, 2, 'one profile spans both branches');
    const stats = (await request(`/api/customers/${id}`, {token: owner()})).body.stats;
    assert.equal(stats.completedOrders, 2, 'chain-wide spend aggregates');
  });

  it('promotes a loyalty tier from real spend, not from a typed value', () => {
    assert.equal(tierFor(0), 'bronze');
    assert.equal(tierFor(14999), 'bronze');
    assert.equal(tierFor(15000), 'silver');
    assert.equal(tierFor(50000), 'gold');
    assert.equal(tierFor(100000), 'platinum');
  });

  it('adjusts loyalty points only with an audit trail', async () => {
    const customer = await createCustomer({name: 'Loyal', phone: '9800000055', branch: BRANCH()});
    const id = customer.body._id;

    const added = await request(`/api/customers/${id}/loyalty`, {
      method: 'POST', token: manager(), body: {delta: 250, reason: 'Service recovery'}
    });
    assert.equal(added.status, 200);
    assert.equal(added.body.loyalty.points, 250);

    const overdrawn = await request(`/api/customers/${id}/loyalty`, {
      method: 'POST', token: manager(), body: {delta: -400}
    });
    assert.equal(overdrawn.status, 400, 'points cannot go negative');

    const entry = await Audit.findOne({action: 'customer_loyalty_adjusted'}).lean();
    assert.ok(entry);
    assert.equal(entry.before.points, 0);
    assert.equal(entry.after.points, 250);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deactivation and merging
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — deactivation and merge', () => {
  it('deactivates rather than deleting, preserving order history', async () => {
    const customer = await createCustomer({name: 'Leaving', phone: '9800000060', branch: BRANCH()});
    const id = customer.body._id;
    const order = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'counter', customer: String(id),
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(order.status, 201);

    const hardDelete = await request(`/api/customers/${id}`, {method: 'DELETE', token: owner()});
    assert.equal(hardDelete.status, 405, 'a hard delete would orphan financial history');

    const deactivated = await request(`/api/customers/${id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false, reason: 'Requested removal'}
    });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.active, false);
    assert.equal(deactivated.body.deactivationReason, 'Requested removal');

    // The record and its order both survive.
    assert.ok(await Customer.findById(id));
    assert.ok(await Order.findById(order.body._id));

    const reactivated = await request(`/api/customers/${id}/active`, {
      method: 'PATCH', token: owner(), body: {active: true}
    });
    assert.equal(reactivated.body.active, true);
    assert.equal(reactivated.body.deactivatedAt, null);
  });

  it('audits deactivation', async () => {
    const customer = await createCustomer({name: 'Gone', phone: '9800000061', branch: BRANCH()});
    await request(`/api/customers/${customer.body._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.ok(await Audit.findOne({action: 'customer_deactivated'}).lean());
  });

  it('merges a duplicate, moving its orders to the survivor', async () => {
    // Two profiles for one person, as historic data contains.
    const keep = await createCustomer({name: 'Real Person', phone: '9800000062', branch: BRANCH()});
    const dupe = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchB._id,
      name: 'Real Persn', phone: '9800000063', phoneKey: '9800000063',
      addresses: [{label: 'Office', address: 'Durbarmarg', default: false}],
      loyalty: {points: 40}
    });
    const order = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: BRANCH(), type: 'counter', customer: String(dupe._id),
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(order.status, 201);

    const merged = await request('/api/customers/merge', {
      method: 'POST', token: manager(),
      body: {source: String(dupe._id), target: String(keep.body._id)}
    });
    assert.equal(merged.status, 200, JSON.stringify(merged.body));

    // The order now belongs to the survivor.
    const moved = await Order.findById(order.body._id);
    assert.equal(String(moved.customer), String(keep.body._id));

    // Addresses and points came across.
    const survivor = await Customer.findById(keep.body._id);
    assert.ok(survivor.addresses.some(a => a.address === 'Durbarmarg'));
    assert.equal(survivor.loyalty.points, 40);

    // The duplicate becomes a tombstone pointing at the survivor.
    const tombstone = await Customer.findById(dupe._id);
    assert.equal(tombstone.active, false);
    assert.equal(String(tombstone.mergedInto), String(keep.body._id));
    assert.ok(!tombstone.phoneKey, 'the merged number is released');
  });

  it('refuses to merge a customer into itself', async () => {
    const customer = await createCustomer({name: 'Self', phone: '9800000064', branch: BRANCH()});
    const res = await request('/api/customers/merge', {
      method: 'POST', token: manager(),
      body: {source: String(customer.body._id), target: String(customer.body._id)}
    });
    assert.equal(res.status, 400);
  });

  it('refuses to merge across restaurants', async () => {
    const rival = await seedRival();
    const ours = await createCustomer({name: 'Ours', phone: '9800000065', branch: BRANCH()});
    const theirs = await createCustomer(
      {name: 'Theirs', phone: '9800000066', branch: String(rival.branch._id)},
      tokenFor(rival.owner)
    );
    const res = await request('/api/customers/merge', {
      method: 'POST', token: owner(),
      body: {source: String(theirs.body._id), target: String(ours.body._id)}
    });
    assert.equal(res.status, 404, 'a rival record is not visible, let alone mergeable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration from the pre-Phase-9 model
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — migration', () => {
  it('backfills restaurant and phone key, and merges per-branch duplicates', async () => {
    // Exactly the shape the old branch-scoped model produced: one person,
    // two records, no restaurant, no normalised key, differently formatted.
    const legacyA = await Customer.collection.insertOne({
      branch: world.branchA._id, name: 'Legacy Guest', phone: '9807777777',
      addresses: [{label: 'Home', address: 'Kalanki'}],
      loyaltyPoints: 10, totalSpend: 500, createdAt: new Date('2024-01-01'), updatedAt: new Date()
    });
    const legacyB = await Customer.collection.insertOne({
      branch: world.branchB._id, name: 'Legacy Guest', phone: '+977 9807777777',
      addresses: [{label: 'Office', address: 'Patan'}],
      loyaltyPoints: 25, totalSpend: 300, createdAt: new Date('2024-06-01'), updatedAt: new Date()
    });
    const order = await Order.create({
      orderNo: 'LEG-1', branch: world.branchB._id, customer: legacyB.insertedId,
      status: 'completed', total: 300, items: []
    });

    const result = await migrateCustomers();
    assert.ok(result.backfilled >= 2);
    assert.equal(result.merged, 1, 'the two records are one person');

    const survivor = await Customer.findById(legacyA.insertedId);
    assert.equal(String(survivor.restaurant), String(world.restaurant._id));
    assert.equal(survivor.phoneKey, '9807777777');
    assert.equal(survivor.loyaltyPoints, 35, 'points are combined, not lost');
    assert.ok(survivor.addresses.some(a => a.address === 'Patan'), 'addresses are unioned');

    const retired = await Customer.findById(legacyB.insertedId);
    assert.equal(retired.active, false);
    assert.equal(String(retired.mergedInto), String(legacyA.insertedId));

    // The order followed the survivor, so no history was stranded.
    assert.equal(String((await Order.findById(order._id)).customer), String(legacyA.insertedId));

    // And the unique index now exists and holds.
    await assert.rejects(
      Customer.create({
        restaurant: world.restaurant._id, name: 'Another', phone: '9807777777', phoneKey: '9807777777'
      }),
      error => error.code === 11000
    );
  });

  it('is safe to run twice', async () => {
    await Customer.collection.insertOne({
      branch: world.branchA._id, name: 'Once', phone: '9808888888', createdAt: new Date()
    });
    await migrateCustomers();
    const second = await migrateCustomers();
    assert.equal(second.merged, 0, 'a converged database needs no further merging');
    assert.equal(await Customer.countDocuments({phoneKey: '9808888888'}), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════

describe('9 — CRM summary', () => {
  it('reports restaurant-wide aggregates for the workspace header', async () => {
    await createCustomer({name: 'One', phone: '9800000070', branch: BRANCH()});
    await createCustomer({name: 'Two', phone: '9800000071', branch: BRANCH_B()}, owner());

    const res = await request('/api/customers/summary', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.customers, 2);
    assert.equal(res.body.totalSpend, 0);
    assert.equal(res.body.repeatCustomers, 0);
    assert.ok('activeLast30Days' in res.body);
  });

  it('is not available to counter staff', async () => {
    assert.equal((await request('/api/customers/summary', {token: staff()})).status, 403);
  });
});
