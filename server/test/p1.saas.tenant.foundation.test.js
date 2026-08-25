import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor, makeOrder} from './helpers.js';
import {Ingredient, MenuItem, Supplier, User} from '../src/models/index.js';
import {
  Branch, Customer, Order, Payment, Restaurant, RestaurantTable, TENANT_STATUSES
} from '../src/models/operations.js';
import {
  backfillOrderTenants, backfillPaymentTenants, backfillTenantOwnership, verifyTenantOwnership
} from '../src/services/tenantBackfill.js';

/**
 * P1 — SaaS architecture and tenant foundation.
 *
 * Three things under test:
 *
 *   P1A  the Restaurant record can describe a TENANT, not just a restaurant.
 *   P1B  Order and Payment carry their tenant DIRECTLY, rather than depending
 *        on a two- or three-hop join that every future query must remember.
 *   P1C  the backfill is idempotent, restartable, and never invents a tenant.
 *   P1D  isolation holds for every role, including the new direct field.
 */

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

// ── P1A · the tenant record ──────────────────────────────────────────────────

describe('P1A · Restaurant is a tenant record', () => {
  it('carries the fields a SaaS tenant needs', async () => {
    const tenant = await Restaurant.create({
      name: 'Newari Kitchen', slug: 'newari-kitchen', legalName: 'Newari Kitchen Pvt Ltd',
      pan: '301234567', status: 'trial', timezone: 'Asia/Kathmandu', currency: 'NPR',
      settings: {theme: {primary: '#c0392b'}, features: {delivery: true}}
    });
    assert.equal(tenant.slug, 'newari-kitchen');
    assert.equal(tenant.legalName, 'Newari Kitchen Pvt Ltd');
    assert.equal(tenant.status, 'trial');
    assert.equal(tenant.timezone, 'Asia/Kathmandu');
    assert.deepEqual(tenant.settings.theme, {primary: '#c0392b'});
  });

  it('defaults an existing tenant to active in Kathmandu', async () => {
    // Every restaurant created before P1 must keep working untouched.
    const legacy = await Restaurant.create({name: 'Legacy Co'});
    assert.equal(legacy.status, 'active', 'an existing tenant must not become suspended');
    assert.equal(legacy.timezone, 'Asia/Kathmandu');
    assert.deepEqual(legacy.settings, {});
  });

  it('models the subscription lifecycle', () => {
    assert.deepEqual([...TENANT_STATUSES], ['trial', 'active', 'suspended', 'cancelled']);
  });

  it('refuses a status outside the lifecycle', async () => {
    await assert.rejects(
      () => Restaurant.create({name: 'Bad Status', status: 'deleted'}),
      /not a valid enum value for path `status`/
    );
  });

  it('keeps a slug unique across the platform', async () => {
    /**
     * The slug will address a tenant (subdomain, public ordering page). Two
     * tenants claiming the same handle is a routing collision, so the database
     * refuses it rather than trusting the application to check.
     */
    await Restaurant.create({name: 'First', slug: 'momo-house'});
    await assert.rejects(
      () => Restaurant.create({name: 'Second', slug: 'momo-house'}),
      /duplicate key|E11000/i
    );
    // ...but many tenants may have NO slug, which is the state every existing
    // restaurant is in. A plain unique index would collide them all on null.
    // Counted as a DELTA: the harness world already contains a restaurant
    // without a slug, which is precisely the legacy state being protected.
    const before = await Restaurant.countDocuments({slug: {$exists: false}});
    await Restaurant.create({name: 'No Slug A'});
    await Restaurant.create({name: 'No Slug B'});
    assert.equal(await Restaurant.countDocuments({slug: {$exists: false}}), before + 2,
      'many tenants may have no slug — a plain unique index would collide them');
  });
});

// ── P1B · direct tenant ownership ────────────────────────────────────────────

describe('P1B · Order and Payment own their tenant directly', () => {
  it('stamps the tenant on an order created through the POS', async () => {
    const res = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    // DATABASE, not the response shape.
    const stored = await Order.findById(res.body._id).lean();
    assert.ok(stored.restaurant, 'the order carries no tenant');
    assert.equal(String(stored.restaurant), String(world.restaurant._id));
    // The branch is still there: it is the operational scope, not the tenancy.
    assert.equal(String(stored.branch), String(world.branchA._id));
  });

  it('stamps the tenant on a payment', async () => {
    const order = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    const paid = await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: tokenFor(world.manager),
      headers: {'Idempotency-Key': `p1-${Date.now()}`},
      body: {amount: order.body.total, method: 'cash'}
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    const payment = await Payment.findById(paid.body.payment._id).lean();
    assert.ok(payment.restaurant, 'the payment carries no tenant');
    assert.equal(String(payment.restaurant), String(world.restaurant._id));
    assert.equal(String(payment.branch), String(world.branchA._id));
  });

  it('stamps the tenant on a refund', async () => {
    // A refund is money leaving; it must be attributable to a tenant too.
    const order = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: tokenFor(world.manager),
      headers: {'Idempotency-Key': `p1-pay-${Date.now()}`},
      body: {amount: order.body.total, method: 'cash'}
    });
    const refund = await request(`/api/orders/${order.body._id}/refunds`, {
      method: 'POST', token: tokenFor(world.owner),
      headers: {'Idempotency-Key': `p1-ref-${Date.now()}`},
      body: {amount: 10, reason: 'p1 verification'}
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));

    const refunds = await Payment.find({order: order.body._id, amount: {$lt: 0}}).lean();
    assert.ok(refunds.length, 'no refund row written');
    for (const row of refunds) {
      assert.equal(String(row.restaurant), String(world.restaurant._id),
        'a refund must carry the tenant');
    }
  });

  it('propagates the tenant to a split check', async () => {
    const order = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 2}]}
    });
    const parent = await Order.findById(order.body._id).lean();
    const split = await request(`/api/orders/${order.body._id}/split`, {
      method: 'POST', token: tokenFor(world.manager),
      body: {items: [{itemId: String(parent.items[0]._id), qty: 1}]}
    });
    assert.equal(split.status, 201, JSON.stringify(split.body));

    const children = await Order.find({_id: {$ne: parent._id}}).lean();
    assert.ok(children.length, 'no child order created');
    for (const child of children) {
      assert.equal(String(child.restaurant), String(world.restaurant._id),
        'a split check must inherit its parent tenant');
    }
  });

  it('answers "whose money is this?" in one query, with no joins', async () => {
    /**
     * The whole point of P1B. Before it, this question needed
     * Payment -> Order -> Branch -> Restaurant. A single forgotten join in any
     * of ~90 query sites was a cross-tenant leak in the money collection.
     */
    const order = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: tokenFor(world.manager),
      headers: {'Idempotency-Key': `p1-direct-${Date.now()}`},
      body: {amount: order.body.total, method: 'cash'}
    });

    const mine = await Payment.find({restaurant: world.restaurant._id}).lean();
    assert.ok(mine.length >= 1, 'a direct tenant query returns nothing');

    const other = new mongoose.Types.ObjectId();
    assert.equal((await Payment.find({restaurant: other}).lean()).length, 0,
      'another tenant sees none of it');
  });
});

// ── P1C · the migration ──────────────────────────────────────────────────────

describe('P1C · tenant backfill', () => {
  /** Write a pre-P1B row: no `restaurant`, exactly as legacy data looks. */
  async function legacyOrder(branchId, overrides = {}) {
    const [row] = await Order.collection.insertMany([{
      orderNo: 'LEGACY-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      branch: branchId, type: 'counter', status: 'completed',
      items: [], subtotal: 100, vatRate: 13, vat: 13, total: 113,
      paidAmount: 113, dueAmount: 0, createdAt: new Date(), updatedAt: new Date(),
      ...overrides
    }]).then(r => Object.values(r.insertedIds));
    return row;
  }
  async function legacyPayment(orderId, overrides = {}) {
    const [row] = await Payment.collection.insertMany([{
      order: orderId, amount: 113, method: 'cash', status: 'paid',
      createdAt: new Date(), updatedAt: new Date(), ...overrides
    }]).then(r => Object.values(r.insertedIds));
    return row;
  }

  it('backfills orders from branch -> restaurant', async () => {
    const a = await legacyOrder(world.branchA._id);
    const b = await legacyOrder(world.branchB._id);
    assert.equal((await Order.findById(a).lean()).restaurant, undefined, 'fixture really is legacy');

    const result = await backfillOrderTenants({log: () => {}});
    assert.equal(result.updated, 2);
    assert.equal(result.unresolved.length, 0);

    assert.equal(String((await Order.findById(a).lean()).restaurant), String(world.restaurant._id));
    assert.equal(String((await Order.findById(b).lean()).restaurant), String(world.restaurant._id));
  });

  it('backfills payments from order -> restaurant, including the branch', async () => {
    const orderId = await legacyOrder(world.branchA._id);
    const paymentId = await legacyPayment(orderId);

    await backfillOrderTenants({log: () => {}});
    const result = await backfillPaymentTenants({log: () => {}});
    assert.equal(result.updated, 1);

    const payment = await Payment.findById(paymentId).lean();
    assert.equal(String(payment.restaurant), String(world.restaurant._id));
    assert.equal(String(payment.branch), String(world.branchA._id),
      'the branch is copied too, so a payment is directly branch-scoped');
  });

  it('is IDEMPOTENT — a second run changes nothing', async () => {
    await legacyOrder(world.branchA._id);
    await legacyPayment(await legacyOrder(world.branchA._id));

    const first = await backfillTenantOwnership({log: () => {}});
    assert.ok(first.orders.updated > 0);

    const second = await backfillTenantOwnership({log: () => {}});
    assert.equal(second.orders.updated, 0, 'a second run must be a no-op');
    assert.equal(second.payments.updated, 0);
    assert.equal(second.orders.scanned, 0, 'already-tagged rows are not even scanned');
  });

  it('DRY RUN reports without writing', async () => {
    const id = await legacyOrder(world.branchA._id);

    const preview = await backfillTenantOwnership({dryRun: true, log: () => {}});
    assert.equal(preview.dryRun, true);
    assert.equal(preview.orders.updated, 1, 'the dry run reports what it would do');

    // ...and nothing actually changed.
    assert.equal((await Order.findById(id).lean()).restaurant, undefined,
      'a dry run must not write');

    // The real run then does the work.
    const real = await backfillTenantOwnership({log: () => {}});
    assert.equal(real.orders.updated, 1);
    assert.ok((await Order.findById(id).lean()).restaurant);
  });

  it('NEVER invents a tenant id for an unresolvable row', async () => {
    /**
     * The most important rule in this migration. An order whose branch is
     * missing, or whose branch belongs to no restaurant, is reported and left
     * alone. Guessing would silently move somebody's money between tenants —
     * far worse than an unmigrated row that shows up in a report.
     */
    const orphanBranch = await Branch.create({name: 'Orphan', code: 'ORP'}); // no restaurant
    const noBranch = await legacyOrder(null);
    const danglingBranch = await legacyOrder(new mongoose.Types.ObjectId());
    const branchNoTenant = await legacyOrder(orphanBranch._id);
    const good = await legacyOrder(world.branchA._id);

    const result = await backfillOrderTenants({log: () => {}});

    assert.equal(result.updated, 1, 'only the resolvable row is written');
    assert.equal(result.unresolved.length, 3);
    for (const id of [noBranch, danglingBranch, branchNoTenant]) {
      assert.equal((await Order.findById(id).lean()).restaurant, undefined,
        'an unresolvable row must be left untouched, not guessed');
    }
    assert.ok((await Order.findById(good).lean()).restaurant);

    // Each unresolved row explains itself, so a human can act on it.
    const reasons = result.unresolved.map(row => row.reason).sort();
    assert.deepEqual(reasons, [
      'branch has no restaurant', 'branch has no restaurant', 'order has no branch'
    ].sort());
  });

  it('refuses to migrate a payment whose order is still unmigrated', async () => {
    // Ordering matters: payments read the tenant that the order stage wrote.
    const orderId = await legacyOrder(world.branchA._id);
    const paymentId = await legacyPayment(orderId);

    const payments = await backfillPaymentTenants({log: () => {}});
    assert.equal(payments.updated, 0);
    assert.equal(payments.unresolved.length, 1);
    assert.match(payments.unresolved[0].reason, /run the order backfill first/);
    assert.equal((await Payment.findById(paymentId).lean()).restaurant, undefined);
  });

  it('reports a payment whose order no longer exists', async () => {
    await legacyPayment(new mongoose.Types.ObjectId());
    const result = await backfillPaymentTenants({log: () => {}});
    assert.equal(result.updated, 0);
    assert.match(result.unresolved[0].reason, /order not found/);
  });

  it('is RESTARTABLE — a partial run resumes cleanly', async () => {
    /**
     * Simulated by running with a tiny batch size, which forces several
     * passes, and asserting the outcome matches a single large run. There is
     * no cross-batch state to lose, which is what makes a kill safe.
     */
    for (let i = 0; i < 12; i += 1) await legacyOrder(world.branchA._id);

    // First pass: one small batch only, as if the process died after it.
    const partial = await backfillOrderTenants({batchSize: 5, log: () => {}});
    assert.equal(partial.updated, 12, 'batching still completes the set');

    // Everything ended up tagged exactly once.
    assert.equal(await Order.countDocuments({restaurant: {$exists: false}}), 0);
    assert.equal(await Order.countDocuments({restaurant: world.restaurant._id}), 12);
  });

  it('verifies the platform is fully migrated', async () => {
    const orderId = await legacyOrder(world.branchA._id);
    await legacyPayment(orderId);

    const before = await verifyTenantOwnership();
    assert.equal(before.ok, false);
    assert.ok(before.ordersWithoutTenant >= 1);
    assert.ok(before.paymentsWithoutTenant >= 1);

    await backfillTenantOwnership({log: () => {}});

    const after = await verifyTenantOwnership();
    assert.equal(after.ok, true, JSON.stringify(after));
    assert.equal(after.ordersWithoutTenant, 0);
    assert.equal(after.paymentsWithoutTenant, 0);
  });

  it('reports ok=false while anything is unresolved', async () => {
    await legacyOrder(null);
    const summary = await backfillTenantOwnership({log: () => {}});
    assert.equal(summary.ok, false, 'a partial migration must not report success');
    assert.equal(summary.unresolvedCount, 1);
  });
});

// ── P1D · tenant isolation, every role ───────────────────────────────────────

describe('P1D · isolation holds for every role', () => {
  let rival;

  beforeEach(async () => {
    const restaurant = await Restaurant.create({name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR'});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
    const owner = await User.create({
      name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
      restaurantId: restaurant._id
    });
    const ingredient = await Ingredient.create({
      restaurant: restaurant._id, code: 'RV-1', name: 'RIVAL-SECRET-SPICE', unit: 'g'
    });
    const menu = await MenuItem.create({
      restaurant: restaurant._id, name: 'RIVAL-SECRET-DISH', price: 900,
      recipe: [{ingredient: ingredient._id, qty: 10, unit: 'g'}]
    });
    const table = await RestaurantTable.create({branch: branch._id, name: 'RV1', seats: 4});
    const customer = await Customer.create({
      restaurant: restaurant._id, branch: branch._id, name: 'RIVAL-SECRET-CUSTOMER',
      phone: '9779000111', phoneKey: '9779000111'
    });
    const order = await Order.create({
      orderNo: 'RIVAL-SECRET-ORD', restaurant: restaurant._id, branch: branch._id,
      table: table._id, type: 'dine-in', status: 'completed',
      items: [{menuItem: menu._id, name: 'RIVAL-SECRET-DISH', qty: 1, unitPrice: 900}],
      subtotal: 900, vatRate: 13, vat: 117, total: 1017, paidAmount: 1017, dueAmount: 0,
      createdBy: owner._id
    });
    const payment = await Payment.create({
      order: order._id, restaurant: restaurant._id, branch: branch._id,
      amount: 1017, method: 'cash', status: 'paid', cashier: owner._id
    });
    await Supplier.create({restaurant: restaurant._id, name: 'RIVAL-SECRET-SUPPLIER'});
    rival = {restaurant, branch, owner, menu, ingredient, table, customer, order, payment};
  });

  /** Every role in the platform, including the least and most privileged. */
  const actors = () => [
    ['owner', tokenFor(world.owner)],
    ['manager', tokenFor(world.manager)],
    ['staff (cashier)', tokenFor(world.staffA)],
    ['staff (other branch)', tokenFor(world.staffB)]
  ];

  it('no role can READ another tenant', async () => {
    const leaks = [];
    for (const [role, token] of actors()) {
      for (const path of [
        `/api/orders/${rival.order._id}`,
        `/api/orders/${rival.order._id}/payments`,
        `/api/orders?branch=${rival.branch._id}`,
        `/api/menu-items/${rival.menu._id}`,
        `/api/customers/${rival.customer._id}`,
        `/api/tables?branch=${rival.branch._id}`,
        `/api/inventory/balances?branch=${rival.branch._id}`,
        `/api/dashboard?branch=${rival.branch._id}`,
        `/api/reports/pnl?branch=${rival.branch._id}`
      ]) {
        const res = await request(path, {token});
        const body = JSON.stringify(res.body ?? '');
        if (/RIVAL-SECRET/.test(body)) leaks.push(`${role} read ${path}`);
        if ([200, 201].includes(res.status) && /\/api\/(orders|menu-items|customers)\/[a-f0-9]{24}/.test(path)) {
          leaks.push(`${role} got ${res.status} on ${path}`);
        }
      }
    }
    assert.deepEqual(leaks, [], 'cross-tenant read');
  });

  it('no role can MODIFY or DELETE another tenant', async () => {
    const breaches = [];
    for (const [role, token] of actors()) {
      const attempts = [
        ['PATCH', `/api/orders/${rival.order._id}/status`, {status: 'cancelled'}],
        ['POST', `/api/orders/${rival.order._id}/payments`, {amount: 1, method: 'cash'}],
        ['POST', `/api/orders/${rival.order._id}/refunds`, {amount: 1, reason: 'breach test'}],
        ['PATCH', `/api/menu-items/${rival.menu._id}`, {price: 1}],
        ['PATCH', `/api/customers/${rival.customer._id}`, {name: 'pwned'}],
        ['DELETE', `/api/tables/${rival.table._id}`, undefined]
      ];
      for (const [method, path, body] of attempts) {
        const res = await request(path, {method, token, ...(body ? {body} : {})});
        if ([200, 201, 204].includes(res.status)) breaches.push(`${role} ${method} ${path} -> ${res.status}`);
      }
    }
    assert.deepEqual(breaches, [], 'cross-tenant write');

    // DATABASE: the rival's records are byte-for-byte unchanged.
    const order = await Order.findById(rival.order._id).lean();
    assert.equal(order.status, 'completed');
    assert.equal(order.total, 1017);
    assert.equal((await MenuItem.findById(rival.menu._id).lean()).price, 900);
    assert.equal((await Customer.findById(rival.customer._id).lean()).name, 'RIVAL-SECRET-CUSTOMER');
    assert.ok(await RestaurantTable.findById(rival.table._id).lean(), 'the rival table still exists');
  });

  it('a rider is confined to their own tenant', async () => {
    // The least-privileged principal, checked separately because its guard
    // path (requireSelfScopedPermission) differs from the staff roles.
    const rider = await User.create({
      name: 'Our Rider', email: 'ourrider@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: true}
    });
    for (const path of [
      `/api/orders/${rival.order._id}`,
      `/api/deliveries?branch=${rival.branch._id}`,
      '/api/notifications/mine'
    ]) {
      const res = await request(path, {token: tokenFor(rider)});
      assert.ok(!JSON.stringify(res.body ?? '').includes('RIVAL-SECRET'),
        `a rider read ${path}`);
    }
  });

  it('a custom role cannot escape its tenant', async () => {
    /**
     * A custom role is defined per tenant. Granting it every permission in the
     * catalogue must widen it INSIDE its own restaurant only — permissions are
     * not a tenancy bypass.
     */
    const {ALL_PERMISSIONS} = await import('../src/services/permissions.js');
    const created = await request('/api/roles', {
      method: 'POST', token: tokenFor(world.owner),
      body: {key: 'superstaff', name: 'Super Staff', baseRole: 'manager', permissions: [...ALL_PERMISSIONS]}
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));

    const powerful = await User.create({
      name: 'Power User', email: 'power@test.com', password: 'x', role: 'manager',
      roleKey: 'superstaff', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    const res = await request(`/api/orders/${rival.order._id}`, {token: tokenFor(powerful)});
    assert.ok(![200, 201].includes(res.status), `a custom role read another tenant: ${res.status}`);
    assert.ok(!JSON.stringify(res.body ?? '').includes('RIVAL-SECRET'));
  });

  it('an anonymous request reaches nothing', async () => {
    for (const path of [
      `/api/orders/${rival.order._id}`,
      `/api/orders?branch=${rival.branch._id}`,
      '/api/menu-items',
      '/api/customers'
    ]) {
      const res = await request(path);
      assert.equal(res.status, 401, `${path} -> ${res.status}`);
    }
  });

  it('the direct tenant field cannot be used to reach across', async () => {
    /**
     * P1B added a field a caller might try to steer. Supplying another
     * tenant's id as a query parameter must not widen the scope — the tenant
     * comes from the token, never the request.
     */
    for (const query of [
      `restaurant=${rival.restaurant._id}`,
      `restaurant[$ne]=${world.restaurant._id}`,
      `tenant=${rival.restaurant._id}`
    ]) {
      const res = await request(`/api/orders?${query}`, {token: tokenFor(world.owner)});
      assert.ok(!JSON.stringify(res.body ?? '').includes('RIVAL-SECRET'),
        `${query} widened the tenant scope`);
    }
  });

  it('CONTROL: the rival owner reaches their own data', async () => {
    // Without this, every refusal above could be a broken fixture.
    const token = tokenFor(rival.owner);
    const order = await request(`/api/orders/${rival.order._id}`, {token});
    assert.equal(order.status, 200, JSON.stringify(order.body));
    assert.equal(order.body.orderNo, 'RIVAL-SECRET-ORD');

    const menu = await request(`/api/menu-items/${rival.menu._id}`, {token});
    assert.equal(menu.status, 200);
    assert.equal(menu.body.name, 'RIVAL-SECRET-DISH');
  });

  it('a direct tenant query returns only that tenant, at the data layer', async () => {
    // The property P1B exists to give: no join, no leak.
    await makeOrder(world);
    const ours = await Order.find({restaurant: world.restaurant._id}).lean();
    const theirs = await Order.find({restaurant: rival.restaurant._id}).lean();

    assert.ok(ours.length >= 1);
    assert.equal(theirs.length, 1);
    assert.ok(ours.every(o => String(o.restaurant) === String(world.restaurant._id)));
    assert.ok(!ours.some(o => o.orderNo === 'RIVAL-SECRET-ORD'));

    const money = await Payment.find({restaurant: rival.restaurant._id}).lean();
    assert.equal(money.length, 1);
    assert.equal(String(money[0].restaurant), String(rival.restaurant._id));
  });
});
