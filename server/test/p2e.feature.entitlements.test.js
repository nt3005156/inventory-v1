import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, MenuItem, User} from '../src/models/index.js';
import {Branch, Customer, Order, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {FEATURE_KEYS, Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {
  __resetBillingEnforcementProbe, assertFeature, hasFeature, invalidateEntitlements,
  resolveEntitlement
} from '../src/services/entitlements.js';
import {
  BILLING_ERROR_CODES, CATALOGUED_FEATURES, assertFeatureImplemented, describeFeature,
  isEnforceableFeature
} from '../src/services/featureCatalogue.js';
import {describeTenantFeatures, featureAvailable} from '../src/services/featureGuard.js';
import {ResourceCounter, readQuotaCounter} from '../src/services/quotaGuard.js';
import {createBranchWithinQuota} from '../src/services/tenantLimits.js';
import {getPublicMenu, priceCart, placePublicOrder} from '../src/services/storefront.js';
import {adjustLoyaltyPoints} from '../src/services/customers.js';

/**
 * P2E — feature entitlement ENFORCEMENT.
 *
 * The audit found `assertFeature()` had zero call sites: every feature was
 * resolvable and none was enforced. A plan saying `onlineOrdering: false`
 * gated nothing.
 *
 * These tests assert DATABASE STATE wherever a mutation is involved. A 402 that
 * still created the order would pass an HTTP-only assertion.
 */

const DAY = 86_400_000;

/** Restaurant A: online ordering + loyalty. B: neither. C: a third tenant. */
let world;   // A — enterprise
let rival;   // B — starter
let third;   // C — professional
let superAdmin;
let platformAdmin;

const ownerA = () => tokenFor(world.owner);
const ownerB = () => tokenFor(rival.owner);
const ownerC = () => tokenFor(third.owner);
const admin = () => tokenFor(platformAdmin);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

async function subscribe(restaurantId, code, overrides = {}) {
  const plan = await Plan.findOne({code});
  const now = new Date();
  const doc = await Subscription.create({
    restaurant: restaurantId, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY),
    ...overrides
  });
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  return doc;
}

beforeEach(async () => {
  await clearDb();
  invalidateEntitlements();
  __resetBillingEnforcementProbe();
  world = await seedWorld();

  const r2 = await Restaurant.create({
    name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR', status: 'active'
  });
  const b2 = await Branch.create({restaurant: r2._id, name: 'Rival Branch', code: 'RVL'});
  const o2 = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: r2._id
  });
  rival = {restaurant: r2, branch: b2, owner: o2};

  const r3 = await Restaurant.create({
    name: 'Third Thakali', slug: 'third-thakali', currency: 'NPR', status: 'active'
  });
  const b3 = await Branch.create({restaurant: r3._id, name: 'Third Branch', code: 'TRD'});
  const o3 = await User.create({
    name: 'Third Owner', email: 'thirdowner@test.com', password: 'x', role: 'owner',
    restaurantId: r3._id
  });
  third = {restaurant: r3, branch: b3, owner: o3};

  superAdmin = await User.create({
    name: 'Super Admin', email: 'super@saas.test', password: 'x',
    role: 'owner', platformRole: 'super_admin'
  });
  platformAdmin = await User.create({
    name: 'Platform Admin', email: 'platform@saas.test', password: 'x',
    role: 'owner', platformRole: 'platform_admin'
  });

  await seedPlans();
  await ResourceCounter.createIndexes();
  __resetBillingEnforcementProbe();

  // A gets everything, B gets the least, C sits in between.
  await subscribe(world.restaurant._id, 'enterprise');
  await subscribe(rival.restaurant._id, 'starter');
  await subscribe(third.restaurant._id, 'professional');
});

// ── 1. the catalogue ─────────────────────────────────────────────────────────

describe('P2E · feature catalogue', () => {
  it('describes only keys the plan catalogue can grant', () => {
    for (const key of CATALOGUED_FEATURES) {
      assert.ok(FEATURE_KEYS.includes(key), `${key} is not a grantable plan feature`);
    }
  });

  it('fails closed for an unknown feature', () => {
    assert.equal(describeFeature('telepathy'), null);
    assert.equal(describeFeature(''), null);
    assert.equal(describeFeature(null), null);
    assert.equal(isEnforceableFeature('telepathy'), false);
    assert.throws(() => assertFeatureImplemented('telepathy'), /Unknown feature/);
  });

  it('refuses to gate on a catalogued but UNIMPLEMENTED feature', () => {
    /**
     * `apiAccess` has no API-key subsystem anywhere in the repository. Gating a
     * route on it would produce an endpoint nobody could ever satisfy, and the
     * failure would look like a billing problem rather than a wiring mistake.
     */
    assert.equal(describeFeature('apiAccess').implemented, false);
    assert.throws(() => assertFeatureImplemented('apiAccess'), /not implemented/);
  });

  it('marks onlineOrdering and loyalty as implemented and enforceable', () => {
    for (const key of ['onlineOrdering', 'loyalty']) {
      assert.equal(isEnforceableFeature(key), true, `${key} should be enforceable`);
    }
  });
});

describe('P2E · assertFeature refuses unknown keys before anything else', () => {
  it('throws for a key outside the plan catalogue', async () => {
    await assert.rejects(
      () => assertFeature(world.restaurant._id, 'notARealFeature'),
      error => {
        assert.equal(error.code, BILLING_ERROR_CODES.FEATURE_UNKNOWN);
        return true;
      }
    );
  });

  it('refuses an unknown key even when enforcement is OFF', async () => {
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();
      // A typo must be a loud failure, never excused by the rollout gate.
      await assert.rejects(
        () => assertFeature(world.restaurant._id, 'nonsense'), /Unknown feature/);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });
});

// ── 2. online ordering (the largest gap) ─────────────────────────────────────

describe('P2E · online ordering is enforced', () => {
  const cart = branchId => ({
    branchId, type: 'pickup',
    items: [{menuItem: null, qty: 1}]
  });

  it('A (entitled) may read the public menu; B (not entitled) may not', async () => {
    const menu = await getPublicMenu({branchId: world.branchA._id});
    assert.ok(menu, 'entitled tenant was refused');

    await assert.rejects(
      () => getPublicMenu({branchId: rival.branch._id}),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED);
        return true;
      }
    );
  });

  it('refuses over HTTP with a stable code', async () => {
    const res = await request(`/api/public/menu?branch=${rival.branch._id}`);
    assert.equal(res.status, 402);
    assert.equal(res.body.code, BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED);
  });

  it('refuses a quote for a tenant without the feature', async () => {
    const res = await request('/api/public/quote', {
      method: 'POST',
      body: {
        // `takeaway`, not `pickup`: ONLINE_ORDER_TYPES is
        // ['delivery','takeaway'], and a wrong type is refused by the schema
        // (400) before the entitlement check is ever reached. My first probe
        // used `pickup` and measured the schema, not the gate.
        branch: String(rival.branch._id), type: 'takeaway',
        items: [{menuItem: String(new mongoose.Types.ObjectId()), qty: 1}]
      }
    });
    assert.equal(res.status, 402, `expected a billing refusal, got ${res.status}`);
    assert.equal(res.body.code, BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED);
  });

  it('refuses ORDER CREATION and writes NOTHING to the database', async () => {
    const before = await Order.countDocuments({restaurant: rival.restaurant._id});
    const res = await request('/api/public/orders', {
      method: 'POST',
      body: {
        branch: String(rival.branch._id), type: 'takeaway',
        customer: {name: 'Guest', phone: '9800000000'},
        items: [{menuItem: String(new mongoose.Types.ObjectId()), qty: 1}],
        // `paymentMethod` is required by checkoutSchema; omitting it produced
        // a 400 from validation before the entitlement gate was reached.
        paymentMethod: 'cod'
      }
    });
    assert.equal(res.status, 402, `expected a billing refusal, got ${res.status}`);
    // The assertion that matters: no order exists.
    assert.equal(await Order.countDocuments({restaurant: rival.restaurant._id}), before);
  });

  it('fails closed at the SERVICE layer, with no route in the way', async () => {
    await assert.rejects(
      () => placePublicOrder({
        input: {
          branch: String(rival.branch._id), type: 'takeaway',
          customer: {name: 'G', phone: '9800000000'},
          items: [{menuItem: String(new mongoose.Types.ObjectId()), qty: 1}]
        }
      }),
      error => {
        assert.equal(error.status, 402);
        return true;
      }
    );
    assert.equal(await Order.countDocuments({restaurant: rival.restaurant._id}), 0);
  });

  it('keeps ORDER TRACKING reachable — a guest must find an existing order', async () => {
    /**
     * Deliberately exempt. An order placed while the feature was live must
     * stay traceable if the plan later lapses; stranding a guest who is
     * waiting for food would be worse than the revenue the gate protects.
     */
    const res = await request('/api/public/orders/track?orderNo=NOPE&phone=9800000000');
    assert.notEqual(res.status, 402, 'tracking must not be gated');
  });

  it('keeps PUBLIC BRANDING reachable — public identity is not the paid feature', async () => {
    const res = await request(`/api/public/branding?branch=${rival.branch._id}`);
    assert.equal(res.status, 200);
  });

  it('disabled → enabled restores ordering', async () => {
    await assert.rejects(() => getPublicMenu({branchId: rival.branch._id}), /not included/);
    await Subscription.deleteMany({restaurant: rival.restaurant._id});
    await subscribe(rival.restaurant._id, 'professional');
    const menu = await getPublicMenu({branchId: rival.branch._id});
    assert.ok(menu, 'an upgrade did not restore online ordering');
  });

  it('enabled → disabled withdraws ordering but keeps historical orders', async () => {
    const order = await Order.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, orderNo: 'HIST-1',
      type: 'online', source: 'online', status: 'completed',
      items: [{name: 'Momo', qty: 1, unitPrice: 100, lineNet: 100, lineVat: 13, lineTotal: 113}],
      subtotal: 100, vat: 13, total: 113
    });

    await Subscription.deleteMany({restaurant: world.restaurant._id});
    await subscribe(world.restaurant._id, 'starter');

    await assert.rejects(() => getPublicMenu({branchId: world.branchA._id}), /not included/);
    // Historical data must survive an entitlement change.
    const still = await Order.findById(order._id).lean();
    assert.ok(still, 'a historical order disappeared when the feature was withdrawn');
    assert.equal(still.total, 113);

    // ...and staff can still read it through legitimate routes.
    const res = await request('/api/orders', {token: ownerA()});
    assert.equal(res.status, 200);
  });

  it('refuses a SUSPENDED tenant even on an entitled plan', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {status: 'suspended'}});
    invalidateEntitlements();
    await assert.rejects(
      () => getPublicMenu({branchId: world.branchA._id}),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, BILLING_ERROR_CODES.TENANT_SUSPENDED);
        return true;
      }
    );
  });

  it('refuses a CANCELLED subscription even on an entitled plan', async () => {
    await Subscription.updateOne(
      {restaurant: world.restaurant._id}, {$set: {status: 'cancelled'}});
    invalidateEntitlements();
    await assert.rejects(
      () => getPublicMenu({branchId: world.branchA._id}),
      error => {
        assert.equal(error.code, BILLING_ERROR_CODES.SUBSCRIPTION_INACTIVE);
        return true;
      }
    );
  });

  it('answers 404 — not 402 — for an unknown branch, so plans cannot be probed', async () => {
    const res = await request(
      `/api/public/menu?branch=${new mongoose.Types.ObjectId()}`);
    assert.equal(res.status, 404, 'a 402 here would confirm the branch exists');
  });

  it('answers 404 for an inactive branch', async () => {
    await Branch.updateOne({_id: world.branchA._id}, {$set: {active: false}});
    const res = await request(`/api/public/menu?branch=${world.branchA._id}`);
    assert.equal(res.status, 404);
  });
});

// ── 3. loyalty ───────────────────────────────────────────────────────────────

describe('P2E · loyalty is enforced', () => {
  async function customerFor(tenant, branch) {
    return Customer.create({
      restaurant: tenant._id, branch: branch._id, name: 'Guest',
      phone: `98${Math.floor(Math.random() * 100000000)}`,
      phoneKey: `k${Math.random()}`,
      loyalty: {points: 100, tier: 'bronze', lifetimePoints: 100, joinedAt: new Date()}
    });
  }

  it('allows a point adjustment for an entitled tenant', async () => {
    const customer = await customerFor(world.restaurant, world.branchA);
    const result = await adjustLoyaltyPoints({
      user: {id: String(world.owner._id), role: 'owner'},
      customerId: String(customer._id), delta: 50, reason: 'goodwill'
    });
    assert.equal(result.loyalty.points, 150);
    // Database state, not the return value.
    assert.equal((await Customer.findById(customer._id)).loyalty.points, 150);
  });

  it('refuses a point adjustment for a tenant without the feature, and does NOT change the balance', async () => {
    const customer = await customerFor(rival.restaurant, rival.branch);
    await assert.rejects(
      () => adjustLoyaltyPoints({
        user: {id: String(rival.owner._id), role: 'owner'},
        customerId: String(customer._id), delta: 500
      }),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.code, BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED);
        return true;
      }
    );
    assert.equal((await Customer.findById(customer._id)).loyalty.points, 100,
      'points were awarded despite the refusal');
  });

  it('refuses over HTTP and leaves the stored balance untouched', async () => {
    const customer = await customerFor(rival.restaurant, rival.branch);
    const res = await request(`/api/customers/${customer._id}/loyalty`, {
      method: 'POST', token: ownerB(), body: {delta: 999, reason: 'free points'}
    });
    assert.equal(res.status, 402);
    assert.equal((await Customer.findById(customer._id)).loyalty.points, 100);
  });

  it('keeps an existing balance READABLE when the feature is withdrawn', async () => {
    const customer = await customerFor(world.restaurant, world.branchA);
    await Subscription.deleteMany({restaurant: world.restaurant._id});
    await subscribe(world.restaurant._id, 'starter');

    const res = await request(`/api/customers/${customer._id}`, {token: ownerA()});
    assert.equal(res.status, 200, 'reading a customer must not be gated');
    assert.equal((await Customer.findById(customer._id)).loyalty.points, 100,
      'points were destroyed when the feature lapsed');
  });

  it('does not let one tenant spend another tenant\'s loyalty entitlement', async () => {
    // B has no loyalty. A does. B aims at its OWN customer using A's... it
    // cannot: the tenant comes from the stored customer document.
    const customerB = await customerFor(rival.restaurant, rival.branch);
    await assert.rejects(
      () => adjustLoyaltyPoints({
        user: {id: String(world.owner._id), role: 'owner'},
        customerId: String(customerB._id), delta: 10
      }),
      // A cannot even see B's customer — 404 before any entitlement question.
      error => {
        assert.ok([403, 404].includes(error.status), `got ${error.status}`);
        return true;
      }
    );
    assert.equal((await Customer.findById(customerB._id)).loyalty.points, 100);
  });
});

// ── 4. adversarial: forged input cannot grant a feature ──────────────────────

describe('P2E · entitlement comes only from trusted server state', () => {
  it('ignores a feature/entitlement claim in the request body', async () => {
    const res = await request('/api/public/quote', {
      method: 'POST',
      body: {
        branch: String(rival.branch._id), type: 'takeaway',
        items: [{menuItem: String(new mongoose.Types.ObjectId()), qty: 1}],
        // The exact payload the brief names.
        feature: 'onlineOrdering', enabled: true,
        entitlement: {onlineOrdering: true}, plan: 'enterprise'
      }
    });
    // Either the strict schema refuses the unknown fields, or they are ignored
    // and the entitlement check refuses. Both are correct; granting is not.
    assert.ok([400, 402].includes(res.status), `got ${res.status}`);
  });

  it('ignores a forged JWT entitlement claim', async () => {
    const forged = tokenFor(rival.owner, {
      features: {loyalty: true, onlineOrdering: true},
      plan: 'enterprise', entitlement: {loyalty: true}
    });
    const customer = await Customer.create({
      restaurant: rival.restaurant._id, branch: rival.branch._id, name: 'G',
      phone: '9811111111', phoneKey: 'k-forged',
      loyalty: {points: 10, tier: 'bronze', lifetimePoints: 10, joinedAt: new Date()}
    });
    const res = await request(`/api/customers/${customer._id}/loyalty`, {
      method: 'POST', token: forged, body: {delta: 100}
    });
    assert.equal(res.status, 402);
    assert.equal((await Customer.findById(customer._id)).loyalty.points, 10);
  });

  it('cannot be granted through tenant-writable Restaurant.settings', async () => {
    /**
     * `PATCH /api/my/restaurant/settings` is tenant-writable. If the resolver
     * consulted it, an owner could enable paid features for free.
     */
    await Restaurant.updateOne({_id: rival.restaurant._id}, {
      $set: {settings: {
        features: Object.fromEntries(FEATURE_KEYS.map(k => [k, true])),
        onlineOrdering: true, loyalty: true, plan: 'enterprise'
      }}
    });
    invalidateEntitlements();
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), false);
    assert.equal(await hasFeature(rival.restaurant._id, 'loyalty'), false);
    await assert.rejects(() => getPublicMenu({branchId: rival.branch._id}), /not included/);
  });

  it('does not let a tenant edit its own plan to gain a feature', async () => {
    const plan = await Plan.findOne({code: 'starter'});
    const res = await request(`/api/platform/plans/${plan._id}`, {
      method: 'PATCH', token: ownerB(),
      body: {features: {onlineOrdering: true}}
    });
    assert.equal(res.status, 403);
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), false);
  });

  it('does not let a tenant assign itself a richer plan', async () => {
    const res = await request(
      `/api/platform/restaurants/${rival.restaurant._id}/subscription`, {
        method: 'POST', token: ownerB(),
        body: {plan: 'enterprise', reason: 'self upgrade'}
      });
    assert.equal(res.status, 403);
    const sub = await Subscription.findOne({restaurant: rival.restaurant._id}).lean();
    const starter = await Plan.findOne({code: 'starter'}).lean();
    assert.equal(String(sub.plan), String(starter._id));
  });

  it('refuses A\'s token against B\'s resources and vice versa', async () => {
    const customerA = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, name: 'A cust',
      phone: '9822222222', phoneKey: 'k-a',
      loyalty: {points: 5, tier: 'bronze', lifetimePoints: 5, joinedAt: new Date()}
    });
    // B (no loyalty) aims at A's customer.
    const res = await request(`/api/customers/${customerA._id}/loyalty`, {
      method: 'POST', token: ownerB(), body: {delta: 100}
    });
    assert.ok([402, 403, 404].includes(res.status), `got ${res.status}`);
    assert.equal((await Customer.findById(customerA._id)).loyalty.points, 5);
  });
});

// ── 5. resource limits + concurrency ─────────────────────────────────────────

describe('P2E · resource limits hold under concurrency', () => {
  it('MEASURED FIX: concurrent branch creates cannot exceed the quota', async () => {
    /**
     * Before P2E this was measured letting 5 concurrent requests past a limit
     * of 2, producing 6 branches. Check-then-act: all five read usage 1, all
     * five passed, all five inserted.
     */
    const solo = await Restaurant.create({name: 'Solo', currency: 'NPR', status: 'active'});
    await Branch.create({restaurant: solo._id, name: 'First', code: 'ONE'});
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxBranches': 2}});
    await subscribe(solo._id, 'starter');

    const attempts = await Promise.allSettled(
      Array.from({length: 6}, (_, i) => createBranchWithinQuota(
        solo._id,
        () => Branch.create({restaurant: solo._id, name: `X${i}`, code: `X${i}`})
      ))
    );

    const created = await Branch.countDocuments({restaurant: solo._id});
    assert.equal(created, 2, `quota bypassed: ${created} branches exist on a limit of 2`);
    assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
    // The refusals carry the stable code.
    const refused = attempts.find(a => a.status === 'rejected');
    assert.equal(refused.reason.code, BILLING_ERROR_CODES.RESOURCE_LIMIT_REACHED);
  });

  it('allows exactly up to the limit, then refuses', async () => {
    const solo = await Restaurant.create({name: 'Solo2', currency: 'NPR', status: 'active'});
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxBranches': 3}});
    await subscribe(solo._id, 'starter');

    for (let i = 0; i < 3; i += 1) {
      await createBranchWithinQuota(solo._id,
        () => Branch.create({restaurant: solo._id, name: `B${i}`, code: `B${i}`}));
    }
    assert.equal(await Branch.countDocuments({restaurant: solo._id}), 3);

    await assert.rejects(
      () => createBranchWithinQuota(solo._id,
        () => Branch.create({restaurant: solo._id, name: 'B4', code: 'B4'})),
      /allows 3/
    );
    assert.equal(await Branch.countDocuments({restaurant: solo._id}), 3);
  });

  it('releases the reservation when the create itself fails', async () => {
    const solo = await Restaurant.create({name: 'Solo3', currency: 'NPR', status: 'active'});
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxBranches': 2}});
    await subscribe(solo._id, 'starter');

    await assert.rejects(
      () => createBranchWithinQuota(solo._id, () => {
        throw new Error('simulated insert failure');
      }),
      /simulated insert failure/
    );
    // The failed attempt must not have consumed quota permanently.
    await createBranchWithinQuota(solo._id,
      () => Branch.create({restaurant: solo._id, name: 'OK1', code: 'OK1'}));
    await createBranchWithinQuota(solo._id,
      () => Branch.create({restaurant: solo._id, name: 'OK2', code: 'OK2'}));
    assert.equal(await Branch.countDocuments({restaurant: solo._id}), 2);
  });

  it('reconciles a drifted counter against reality instead of trusting it', async () => {
    const solo = await Restaurant.create({name: 'Solo4', currency: 'NPR', status: 'active'});
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxBranches': 3}});
    await subscribe(solo._id, 'starter');
    await createBranchWithinQuota(solo._id,
      () => Branch.create({restaurant: solo._id, name: 'B1', code: 'B1'}));

    // Corrupt the counter downwards, as a restore or a stray delete would.
    await ResourceCounter.updateOne(
      {restaurant: solo._id, resource: 'branches'}, {$set: {count: 0}});

    // Two more creates: reconciliation must notice the real count is 1.
    await createBranchWithinQuota(solo._id,
      () => Branch.create({restaurant: solo._id, name: 'B2', code: 'B2'}));
    await createBranchWithinQuota(solo._id,
      () => Branch.create({restaurant: solo._id, name: 'B3', code: 'B3'}));
    await assert.rejects(
      () => createBranchWithinQuota(solo._id,
        () => Branch.create({restaurant: solo._id, name: 'B4', code: 'B4'})),
      /allows 3/
    );
    assert.equal(await Branch.countDocuments({restaurant: solo._id}), 3);
    assert.equal(await readQuotaCounter(solo._id, 'branches'), 3);
  });

  it('treats an unlimited plan as unlimited and keeps no counter', async () => {
    // Enterprise sets every limit to null.
    for (let i = 0; i < 4; i += 1) {
      await createBranchWithinQuota(world.restaurant._id,
        () => Branch.create({restaurant: world.restaurant._id, name: `U${i}`, code: `U${i}`}));
    }
    assert.ok(await Branch.countDocuments({restaurant: world.restaurant._id}) >= 4);
    assert.equal(await readQuotaCounter(world.restaurant._id, 'branches'), null,
      'an unlimited plan should not maintain a counter document');
  });

  it('enforces maxCustomers, which P2C declared but never checked', async () => {
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxCustomers': 1}});
    invalidateEntitlements();
    __resetBillingEnforcementProbe();

    const first = await request('/api/customers', {
      method: 'POST', token: ownerB(), body: {name: 'One', phone: '9800000001'}
    });
    assert.equal(first.status, 201, first.body?.message);

    const second = await request('/api/customers', {
      method: 'POST', token: ownerB(), body: {name: 'Two', phone: '9800000002'}
    });
    assert.equal(second.status, 402);
    assert.equal(await Customer.countDocuments({restaurant: rival.restaurant._id}), 1);
  });

  it('keeps quota counters tenant-scoped', async () => {
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxBranches': 2}});
    invalidateEntitlements();
    await createBranchWithinQuota(rival.restaurant._id,
      () => Branch.create({restaurant: rival.restaurant._id, name: 'R2', code: 'R2'}));

    // C's quota is untouched by B's consumption.
    assert.equal(await readQuotaCounter(third.restaurant._id, 'branches'), null);
    const counters = await ResourceCounter.find({resource: 'branches'}).lean();
    for (const counter of counters) {
      assert.ok(counter.restaurant, 'a counter exists with no tenant scope');
    }
  });
});

// ── 6. cache behaviour ───────────────────────────────────────────────────────

describe('P2E · entitlement cache', () => {
  it('reflects a plan change made through the API immediately', async () => {
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), false);

    const plan = await Plan.findOne({code: 'starter'});
    const res = await request(`/api/platform/plans/${plan._id}`, {
      method: 'PATCH', token: admin(), body: {features: {onlineOrdering: true, pos: true}}
    });
    assert.equal(res.status, 200, res.body?.message);

    // No explicit invalidation here: the API path must do it.
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), true);
  });

  it('reflects a subscription change made through the API immediately', async () => {
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), false);
    const res = await request(
      `/api/platform/restaurants/${rival.restaurant._id}/subscription`, {
        method: 'POST', token: admin(), body: {plan: 'professional', reason: 'upgrade'}
      });
    assert.equal(res.status, 200);
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), true);
  });

  it('never grants a feature after a known revocation', async () => {
    // One subscription per restaurant is a unique index, so the existing one
    // must go before a new one is created.
    await Subscription.deleteMany({restaurant: rival.restaurant._id});
    await subscribe(rival.restaurant._id, 'professional');
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), true);

    const res = await request(
      `/api/platform/restaurants/${rival.restaurant._id}/subscription/cancel`, {
        method: 'POST', token: admin(),
        body: {reason: 'non-payment', atPeriodEnd: false}
      });
    assert.equal(res.status, 200);
    // Cached or not, a revoked tenant must not keep the feature.
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), false);
    await assert.rejects(
      () => getPublicMenu({branchId: rival.branch._id}),
      error => {
        assert.equal(error.status, 402);
        return true;
      }
    );
  });

  it('fails closed for missing or unknown data', async () => {
    assert.equal(await hasFeature(new mongoose.Types.ObjectId(), 'onlineOrdering'), false);
    assert.equal(await hasFeature('not-an-id', 'onlineOrdering'), false);
    assert.equal(await hasFeature(null, 'onlineOrdering'), false);
  });
});

// ── 7. lifecycle ─────────────────────────────────────────────────────────────

describe('P2E · subscription lifecycle governs features', () => {
  const states = [
    {status: 'trialing', trialEnd: new Date(Date.now() + 5 * DAY), expect: true},
    {status: 'active', expect: true},
    {status: 'past_due', expect: false},
    {status: 'cancelled', expect: false},
    {status: 'expired', expect: false}
  ];

  for (const state of states) {
    it(`${state.status} → feature ${state.expect ? 'available' : 'refused'}`, async () => {
      await Subscription.deleteMany({restaurant: third.restaurant._id});
      await subscribe(third.restaurant._id, 'professional', {
        status: state.status, ...(state.trialEnd ? {trialEnd: state.trialEnd} : {})
      });
      assert.equal(await hasFeature(third.restaurant._id, 'onlineOrdering'), state.expect);
    });
  }

  it('treats a LAPSED trial as unavailable before any sweep runs', async () => {
    await Subscription.deleteMany({restaurant: third.restaurant._id});
    await subscribe(third.restaurant._id, 'professional', {
      status: 'trialing', trialEnd: new Date(Date.now() - DAY)
    });
    assert.equal(await hasFeature(third.restaurant._id, 'onlineOrdering'), false);
  });

  it('never deletes tenant data when an entitlement disappears', async () => {
    const customer = await Customer.create({
      restaurant: third.restaurant._id, branch: third.branch._id, name: 'Keep me',
      phone: '9833333333', phoneKey: 'k-keep',
      loyalty: {points: 250, tier: 'silver', lifetimePoints: 250, joinedAt: new Date()}
    });
    const menuCount = await MenuItem.countDocuments({restaurant: third.restaurant._id});

    await Subscription.deleteMany({restaurant: third.restaurant._id});
    await subscribe(third.restaurant._id, 'starter');

    assert.ok(await Customer.findById(customer._id), 'a customer was deleted');
    assert.equal((await Customer.findById(customer._id)).loyalty.points, 250);
    assert.equal(await MenuItem.countDocuments({restaurant: third.restaurant._id}), menuCount);
  });
});

// ── 8. platform authority ────────────────────────────────────────────────────

describe('P2E · only the platform may change what a tenant is entitled to', () => {
  it('lets a platform admin change a plan\'s features, and audits it', async () => {
    const plan = await Plan.findOne({code: 'starter'});
    const res = await request(`/api/platform/plans/${plan._id}`, {
      method: 'PATCH', token: admin(), body: {features: {onlineOrdering: true}}
    });
    assert.equal(res.status, 200);
    const row = await Audit.findOne({action: 'plan_updated'}).lean();
    assert.ok(row, 'a plan feature change was not audited');
    assert.ok(row.hash, 'the audit row is not chained');
    assert.equal(row.hashVersion, 2, 'the new writer did not use the P2D.1 canonicaliser');
  });

  it('refuses every tenant role', async () => {
    const plan = await Plan.findOne({code: 'starter'});
    for (const token of [ownerA(), ownerB(), ownerC(), tokenFor(world.manager)]) {
      const res = await request(`/api/platform/plans/${plan._id}`, {
        method: 'PATCH', token, body: {features: {onlineOrdering: true}}
      });
      assert.equal(res.status, 403);
    }
  });

  it('refuses a forged platformRole claim', async () => {
    const forged = tokenFor(rival.owner, {platformRole: 'super_admin'});
    const plan = await Plan.findOne({code: 'starter'});
    const res = await request(`/api/platform/plans/${plan._id}`, {
      method: 'PATCH', token: forged, body: {features: {onlineOrdering: true}}
    });
    assert.equal(res.status, 403);
    assert.equal(await hasFeature(rival.restaurant._id, 'onlineOrdering'), false);
  });

  it('keeps the audit chain verifiable after entitlement changes', async () => {
    const {verifyAuditChain} = await import('../src/services/auditTrail.js');
    await request(`/api/platform/restaurants/${rival.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'professional', reason: 'upgrade'}
    });
    const result = await verifyAuditChain({user: {id: String(rival.owner._id), role: 'owner'}});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
  });
});

// ── 9. tenant feature reporting ──────────────────────────────────────────────

describe('P2E · the tenant feature endpoint', () => {
  it('reports available / not_in_plan / not_implemented distinctly', async () => {
    const res = await request('/api/my/features', {token: ownerB()});
    assert.equal(res.status, 200);
    const byKey = Object.fromEntries(res.body.features.map(f => [f.key, f]));

    assert.equal(byKey.onlineOrdering.state, 'not_in_plan');
    assert.equal(byKey.loyalty.state, 'not_in_plan');
    // apiAccess has no implementation, and says so rather than pretending.
    assert.equal(byKey.apiAccess.state, 'not_implemented');
    assert.equal(byKey.apiAccess.implemented, false);
  });

  it('reports available for an entitled tenant', async () => {
    const res = await request('/api/my/features', {token: ownerA()});
    const byKey = Object.fromEntries(res.body.features.map(f => [f.key, f]));
    assert.equal(byKey.onlineOrdering.state, 'available');
    assert.equal(byKey.loyalty.state, 'available');
  });

  it('distinguishes a lapsed subscription from a plan that lacks the feature', async () => {
    await Subscription.updateOne(
      {restaurant: world.restaurant._id}, {$set: {status: 'past_due'}});
    invalidateEntitlements();
    const features = await describeTenantFeatures(world.restaurant._id);
    const online = features.find(f => f.key === 'onlineOrdering');
    assert.equal(online.state, 'subscription_inactive');
    // The plan DOES include it — the subscription is the blocker.
    assert.equal(online.inPlan, true);
  });

  it('is tenant-isolated and leaks no other tenant\'s plan', async () => {
    const res = await request('/api/my/features', {token: ownerB()});
    const blob = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['enterprise', 'mittho test', 'third thakali', 'rival momo']) {
      assert.ok(!blob.includes(forbidden), `leaked "${forbidden}"`);
    }
  });

  it('requires authentication', async () => {
    assert.equal((await request('/api/my/features')).status, 401);
  });
});

// ── 10. the rollout gate ─────────────────────────────────────────────────────

describe('P2E · enforcement respects the P2C rollout gate', () => {
  it('does not gate features when no plan catalogue exists', async () => {
    /**
     * The P2C lesson: unconditional enforcement would have bricked every
     * tenant on deploy day. P2E gates the busiest public surface in the
     * product, so it must honour the same gate or the same disaster follows.
     */
    await Plan.deleteMany({});
    await Subscription.deleteMany({});
    invalidateEntitlements();
    __resetBillingEnforcementProbe();

    const menu = await getPublicMenu({branchId: rival.branch._id});
    assert.ok(menu, 'online ordering was gated on an unprovisioned deployment');
    assert.equal(await featureAvailable(rival.restaurant._id, 'onlineOrdering'), true);
  });

  it('starts enforcing once plans are seeded', async () => {
    await Plan.deleteMany({});
    __resetBillingEnforcementProbe();
    assert.ok(await getPublicMenu({branchId: rival.branch._id}));

    await seedPlans();
    __resetBillingEnforcementProbe();
    invalidateEntitlements();
    /**
     * The subscriptions were deleted alongside the plans, so the refusal is
     * `no_subscription` ("does not permit this action"), not
     * `feature_not_in_plan`. Both are correct refusals; asserting the specific
     * prose of one was my mistake. What matters is that it IS refused with 402
     * once the catalogue exists.
     */
    await assert.rejects(
      () => getPublicMenu({branchId: rival.branch._id}),
      error => {
        assert.equal(error.status, 402);
        return true;
      }
    );
  });
});

// ── 11. gaps found by mutation testing ───────────────────────────────────────

describe('P2E · gaps found by mutation testing', () => {
  /**
   * Three mutants survived the first run. None was equivalent; all three were
   * REAL TEST GAPS, closed here.
   */

  it('M14: refuses a NEW online payment when the feature is withdrawn', async () => {
    /**
     * The payment-intent gate had ZERO coverage — `grep` for
     * `createPaymentIntent|public/payments` in this file returned 0. Removing
     * the guard changed nothing observable because nothing looked.
     *
     * Asserted through the service so the ownership checks (order number +
     * phone) are satisfied and the entitlement gate is actually reached.
     */
    const {createPaymentIntent} = await import('../src/services/onlinePayments.js');

    const customer = await Customer.create({
      restaurant: rival.restaurant._id, branch: rival.branch._id,
      name: 'Payer', phone: '9844444444', phoneKey: 'k-pay'
    });
    const order = await Order.create({
      restaurant: rival.restaurant._id, branch: rival.branch._id, orderNo: 'PAY-1',
      type: 'takeaway', source: 'online', status: 'pending', customer: customer._id,
      items: [{name: 'Momo', qty: 1, unitPrice: 100, lineNet: 100, lineVat: 13, lineTotal: 113}],
      subtotal: 100, vat: 13, total: 113
    });

    // B has no onlineOrdering: starting a payment must be refused.
    await assert.rejects(
      () => createPaymentIntent({
        orderNo: order.orderNo, phone: '9844444444', provider: 'esewa',
        env: {PAYMENT_MODE: 'sandbox', ESEWA_MERCHANT_CODE: 'X', KHALTI_PUBLIC_KEY: 'Y'}
      }),
      error => {
        assert.equal(error.status, 402, `expected a billing refusal, got ${error.status}`);
        assert.equal(error.code, BILLING_ERROR_CODES.FEATURE_NOT_ENTITLED);
        return true;
      }
    );

    // Nothing was written: no payment, no settlement on the order.
    const after = await Order.findById(order._id).lean();
    assert.equal(Number(after.paidAmount || 0), 0);
    assert.equal(after.paymentSettledAt ?? null, null);
  });

  it('M14 control: an ENTITLED tenant is not blocked by the payment gate', async () => {
    /**
     * Without this control the test above would also pass if the payment path
     * were simply broken for everybody.
     */
    const {createPaymentIntent} = await import('../src/services/onlinePayments.js');
    const customer = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: 'Payer A', phone: '9855555555', phoneKey: 'k-pay-a'
    });
    const order = await Order.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, orderNo: 'PAY-A1',
      type: 'takeaway', source: 'online', status: 'pending', customer: customer._id,
      items: [{name: 'Momo', qty: 1, unitPrice: 100, lineNet: 100, lineVat: 13, lineTotal: 113}],
      subtotal: 100, vat: 13, total: 113
    });

    let refusedForBilling = false;
    try {
      await createPaymentIntent({
        orderNo: order.orderNo, phone: '9855555555', provider: 'esewa',
        env: {PAYMENT_MODE: 'sandbox', ESEWA_MERCHANT_CODE: 'EPAYTEST', ESEWA_SECRET: 's'}
      });
    } catch (error) {
      // A gateway/config failure is acceptable here — the point is that the
      // refusal is NOT a billing refusal for an entitled tenant.
      refusedForBilling = error.status === 402;
    }
    assert.equal(refusedForBilling, false, 'an entitled tenant was refused for billing');
  });

  it('M8: an unknown feature is refused even with enforcement OFF', async () => {
    /**
     * The unknown-key check survived because, with enforcement ON, the
     * fall-through (`features[unknown] !== true`) refuses anyway. The check
     * exists for the enforcement-OFF path, where the fall-through is skipped
     * entirely — that is where a typo would silently PASS.
     */
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();

      // Control: a real feature is allowed through when enforcement is off.
      await assertFeature(rival.restaurant._id, 'onlineOrdering');

      // ...but a typo must still be a loud failure, not a silent pass.
      await assert.rejects(
        () => assertFeature(rival.restaurant._id, 'onlineOrderingg'),
        error => {
          assert.equal(error.code, BILLING_ERROR_CODES.FEATURE_UNKNOWN);
          assert.equal(error.status, 500);
          return true;
        }
      );
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });

  it('M9: the public guard refuses a branch that resolves to no tenant', async () => {
    /**
     * `assertPublicFeature` re-checks `branch.restaurant` after resolution.
     * The mutant removed it and survived, because `resolvePublicBranch()`
     * already throws 404 first. This asserts the guard's OWN check by
     * injecting a resolver that returns a tenant-less branch — which is what a
     * future caller passing a different resolver could produce.
     */
    const {assertPublicFeature} = await import('../src/services/featureGuard.js');

    await assert.rejects(
      () => assertPublicFeature({
        branchId: 'anything', feature: 'onlineOrdering',
        resolveBranch: async () => ({_id: 'x', name: 'orphan'})   // no restaurant
      }),
      error => {
        assert.equal(error.status, 404);
        return true;
      }
    );

    // Control: a resolver returning a real tenant reaches the entitlement
    // check and refuses for BILLING, not for a missing branch.
    await assert.rejects(
      () => assertPublicFeature({
        branchId: 'anything', feature: 'onlineOrdering',
        resolveBranch: async () => ({_id: 'x', restaurant: rival.restaurant._id})
      }),
      error => {
        assert.equal(error.status, 402);
        return true;
      }
    );
  });
});
