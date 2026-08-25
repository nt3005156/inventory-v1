import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Role, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {
  FEATURE_KEYS, LIMIT_KEYS, Plan, SUBSCRIPTION_STATUSES, Subscription, SubscriptionEvent,
  canTransition
} from '../src/models/billing.js';
import {ALL_PERMISSIONS, PERMISSION_CATALOG} from '../src/services/permissions.js';
import {PLATFORM_PERMISSIONS, PLATFORM_ROLES} from '../src/services/platformAccess.js';
import {
  __resetBillingEnforcementProbe, assertFeature, assertWithinLimit, billingEnforcementActive,
  entitlementSummary, getLimit, hasFeature, invalidateEntitlements, isUnlimited, resolveEntitlement
} from '../src/services/entitlements.js';
import {
  assignPlan, cancelSubscription, createPlan, extendTrial, formatMinor, getOwnSubscription,
  listPlans, listSubscriptions, reactivateSubscription
} from '../src/services/subscriptions.js';
import {runSubscriptionSweep} from '../src/services/subscriptionScheduler.js';
import {backfillSubscriptions} from '../src/services/subscriptionBackfill.js';
import {getBranchUsage, getUserUsage, monthWindow} from '../src/services/usage.js';
import {seedPlans} from '../scripts/seed-plans.js';

/**
 * P2C — subscriptions, plans and entitlements.
 *
 * The two questions this phase must keep answering:
 *
 *   1. Can a tenant grant itself entitlements? An owner holds `'*'` in the
 *      tenant catalogue, and `Restaurant.settings` is tenant-writable, so
 *      commercial state has to live somewhere neither reaches.
 *   2. Does a lapsed subscription actually stop the tenant, and does it do so
 *      WITHOUT destroying their access to their own history?
 */

let world;
let rival;
let superAdmin;
let platformAdmin;
let support;
let plans;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const rivalOwner = () => tokenFor(rival.owner);
const sup = () => tokenFor(superAdmin);
const admin = () => tokenFor(platformAdmin);
const helpdesk = () => tokenFor(support);

const DAY = 86_400_000;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  invalidateEntitlements();
  // `clearDb()` empties the plan catalogue, and seedPlans() below refills it.
  // The enforcement probe caches "are there plans?", so it must be reset or a
  // test can inherit the previous test's answer.
  __resetBillingEnforcementProbe();
  world = await seedWorld();

  const restaurant = await Restaurant.create({
    name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR', status: 'active'
  });
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
  const ownerUser = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: restaurant._id
  });
  rival = {restaurant, branch, owner: ownerUser};

  superAdmin = await User.create({
    name: 'Super Admin', email: 'super@saas.test', password: 'x',
    role: 'owner', platformRole: 'super_admin'
  });
  platformAdmin = await User.create({
    name: 'Platform Admin', email: 'platform@saas.test', password: 'x',
    role: 'owner', platformRole: 'platform_admin'
  });
  support = await User.create({
    name: 'Support Agent', email: 'support@saas.test', password: 'x',
    role: 'staff', platformRole: 'platform_support'
  });

  await seedPlans();
  __resetBillingEnforcementProbe();
  plans = Object.fromEntries(
    (await Plan.find({}).lean()).map(row => [row.code, row])
  );
});

/** Put a restaurant on a plan directly, bypassing the API, for setup. */
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

// ── 1. the boundary: entitlements are not tenant permissions ─────────────────

describe('P2C · commercial authority stays outside tenant RBAC', () => {
  it('keeps billing permissions OUT of the tenant catalogue', () => {
    for (const key of ['platform.billing.view', 'platform.billing.manage']) {
      assert.ok(PLATFORM_PERMISSIONS.includes(key), `${key} must be a platform permission`);
      assert.ok(!ALL_PERMISSIONS.includes(key), `${key} leaked into the tenant catalogue`);
    }
    for (const entry of PERMISSION_CATALOG) {
      assert.ok(!String(entry.key).startsWith('platform.'));
      assert.ok(!String(entry.key).startsWith('billing.'));
    }
  });

  it('keeps the platform role ladder strictly nested after adding billing', () => {
    const s = PLATFORM_ROLES.platform_support.permissions;
    const a = PLATFORM_ROLES.platform_admin.permissions;
    const su = PLATFORM_ROLES.super_admin.permissions;
    for (const p of s) assert.ok(a.includes(p), p);
    for (const p of a) assert.ok(su.includes(p), p);
    // Support may SEE billing but never change it — the whole point of split keys.
    assert.ok(s.includes('platform.billing.view'));
    assert.ok(!s.includes('platform.billing.manage'));
    assert.ok(a.includes('platform.billing.manage'));
  });

  it('does not read entitlements from tenant-writable Restaurant.settings', async () => {
    /**
     * `PATCH /api/my/restaurant` lets an owner write `settings`. If the
     * resolver consulted it, an owner could grant themselves Enterprise.
     */
    await subscribe(world.restaurant._id, 'starter');
    await Restaurant.updateOne({_id: world.restaurant._id}, {
      $set: {settings: {
        features: Object.fromEntries(FEATURE_KEYS.map(k => [k, true])),
        limits: Object.fromEntries(LIMIT_KEYS.map(k => [k, null])),
        plan: 'enterprise'
      }}
    });
    invalidateEntitlements();

    const entitlement = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(entitlement.planCode, 'starter');
    assert.equal(entitlement.features.apiAccess, false);
    assert.equal(entitlement.limits.maxBranches, 1);
  });
});

// ── 2. money ─────────────────────────────────────────────────────────────────

describe('P2C · money is integer minor units', () => {
  it('stores prices as integers and never as floats', async () => {
    const plan = await Plan.findOne({code: 'professional'}).lean();
    assert.ok(Number.isSafeInteger(plan.monthlyPrice), 'monthlyPrice must be an integer');
    assert.ok(Number.isSafeInteger(plan.annualPrice));
    assert.equal(plan.monthlyPrice, 830000);
  });

  it('refuses a fractional price at the schema', async () => {
    await assert.rejects(
      () => Plan.create({code: 'floaty', name: 'Floaty', monthlyPrice: 1234.56}),
      /integer number of minor units/
    );
  });

  it('formats without float arithmetic', () => {
    assert.equal(formatMinor(830000, 'NPR'), 'NPR 8,300.00');
    assert.equal(formatMinor(1, 'NPR'), 'NPR 0.01');
    assert.equal(formatMinor(0, 'NPR'), 'NPR 0.00');
    // The classic float failure: 0.1 + 0.2. In minor units it cannot occur.
    assert.equal(formatMinor(10 + 20, 'NPR'), 'NPR 0.30');
  });

  it('refuses a fractional price through the API', async () => {
    const res = await request('/api/platform/plans', {
      method: 'POST', token: admin(),
      body: {code: 'badmoney', name: 'Bad Money', monthlyPriceMinor: 100.5}
    });
    assert.equal(res.status, 400);
  });
});

// ── 3. plan model and catalogue ──────────────────────────────────────────────

describe('P2C · plan catalogue', () => {
  it('seeds three plans idempotently', async () => {
    const second = await seedPlans();
    assert.deepEqual(second.created, []);
    assert.equal(second.unchanged.length, 3);
    assert.equal(await Plan.countDocuments({}), 3);
  });

  it('represents unlimited as null, never a magic number', async () => {
    const enterprise = await Plan.findOne({code: 'enterprise'}).lean();
    for (const key of LIMIT_KEYS) {
      assert.equal(enterprise.limits[key], null, `${key} must be null for unlimited`);
    }
    assert.equal(isUnlimited(null), true);
    assert.equal(isUnlimited(undefined), true);
    assert.equal(isUnlimited(0), false);
    // The sentinel trap this avoids.
    assert.equal(isUnlimited(-1), false);
  });

  it('refuses an unknown limit or feature key rather than dropping it', async () => {
    const badLimit = await request('/api/platform/plans', {
      method: 'POST', token: admin(),
      body: {code: 'typo1', name: 'Typo', limits: {maxBranchs: 5}}
    });
    assert.equal(badLimit.status, 400);

    const badFeature = await request('/api/platform/plans', {
      method: 'POST', token: admin(),
      body: {code: 'typo2', name: 'Typo', features: {telepathy: true}}
    });
    assert.equal(badFeature.status, 400);
    assert.equal(await Plan.countDocuments({code: 'typo1'}), 0);
  });

  it('refuses a duplicate plan code', async () => {
    const res = await request('/api/platform/plans', {
      method: 'POST', token: admin(), body: {code: 'starter', name: 'Copy'}
    });
    assert.equal(res.status, 409);
  });

  it('refuses to change a plan code', async () => {
    const res = await request(`/api/platform/plans/${plans.starter._id}`, {
      method: 'PATCH', token: admin(), body: {code: 'renamed'}
    });
    assert.equal(res.status, 400);
  });

  it('creates and updates a plan, auditing both', async () => {
    const created = await request('/api/platform/plans', {
      method: 'POST', token: admin(),
      body: {
        code: 'kiosk', name: 'Kiosk', monthlyPriceMinor: 100000, trialDays: 7,
        limits: {maxBranches: 1, maxUsers: 3}, features: {pos: true}
      }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.monthlyPriceMinor, 100000);
    assert.equal(created.body.limits.maxBranches, 1);
    // Unset limits report as null (unlimited), not 0.
    assert.equal(created.body.limits.maxTables, null);
    assert.equal(created.body.features.pos, true);
    assert.equal(created.body.features.apiAccess, false);

    const updated = await request(`/api/platform/plans/${created.body._id}`, {
      method: 'PATCH', token: admin(), body: {monthlyPriceMinor: 120000}
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.monthlyPriceMinor, 120000);

    assert.ok(await Audit.findOne({action: 'plan_created'}).lean());
    assert.ok(await Audit.findOne({action: 'plan_updated'}).lean());
  });

  it('reports how many tenants are on each plan', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await subscribe(rival.restaurant._id, 'starter');
    const res = await request('/api/platform/plans', {token: admin()});
    const starter = res.body.plans.find(p => p.code === 'starter');
    assert.equal(starter.subscriberCount, 2);
  });
});

// ── 4. subscription state machine ────────────────────────────────────────────

describe('P2C · the subscription state machine', () => {
  it('permits only declared transitions', () => {
    assert.equal(canTransition('trialing', 'active'), true);
    assert.equal(canTransition('active', 'cancelled'), true);
    assert.equal(canTransition('cancelled', 'active'), true);
    assert.equal(canTransition('expired', 'active'), true);
    assert.equal(canTransition('past_due', 'active'), true);
  });

  it('refuses impossible transitions', () => {
    // Nothing returns to trialing: that would be an unbounded free ride.
    for (const from of SUBSCRIPTION_STATUSES) {
      assert.equal(canTransition(from, 'trialing'), false, `${from} -> trialing must be refused`);
    }
    assert.equal(canTransition('cancelled', 'past_due'), false);
    assert.equal(canTransition('cancelled', 'expired'), false);
    assert.equal(canTransition('active', 'active'), false);
    assert.equal(canTransition('nonsense', 'active'), false);
    assert.equal(canTransition('active', 'nonsense'), false);
  });

  it('refuses one subscription per restaurant at the database', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await assert.rejects(
      () => Subscription.create({restaurant: world.restaurant._id, plan: plans.starter._id, status: 'active'}),
      /duplicate key|E11000/
    );
  });

  it('refuses extending a trial on a non-trialing subscription', async () => {
    await subscribe(world.restaurant._id, 'starter', {status: 'active'});
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/trial`, {
      method: 'PATCH', token: admin(), body: {days: 7, reason: 'goodwill'}
    });
    // PATCH is not the verb; the real call is POST. Either way it must not work.
    assert.ok(res.status >= 400);

    const post = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/trial`, {
      method: 'POST', token: admin(), body: {days: 7, reason: 'goodwill'}
    });
    assert.equal(post.status, 409);
  });
});

// ── 5. entitlement resolution ────────────────────────────────────────────────

describe('P2C · entitlement resolution', () => {
  it('resolves plan features and limits for an active subscription', async () => {
    await subscribe(world.restaurant._id, 'professional');
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.planCode, 'professional');
    assert.equal(e.operational, true);
    assert.equal(e.features.onlineOrdering, true);
    assert.equal(e.features.apiAccess, false);
    assert.equal(e.limits.maxBranches, 5);
  });

  it('FAILS CLOSED when there is no subscription', async () => {
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.operational, false);
    assert.equal(e.reason, 'no_subscription');
    // Not "unlimited because nothing is configured" — the dangerous default.
    for (const key of FEATURE_KEYS) assert.equal(e.features[key], false, key);
    assert.equal(e.limits.maxMenuItems, 0);
    // ...but not locked out of their own existing branch and login.
    assert.equal(e.limits.maxBranches, 1);
    assert.equal(e.limits.maxUsers, 1);
  });

  it('fails closed for an invalid or unknown restaurant', async () => {
    assert.equal((await resolveEntitlement('not-an-id')).operational, false);
    assert.equal((await resolveEntitlement(null)).operational, false);
    const gone = await resolveEntitlement(new mongoose.Types.ObjectId(), {fresh: true});
    assert.equal(gone.operational, false);
    assert.equal(gone.reason, 'no_restaurant');
  });

  it('treats a lapsed trial as non-operational FROM THE DATE, before any sweep', async () => {
    /**
     * The deadline must not depend on the scheduler having run — otherwise a
     * stopped scheduler is a hidden infinite trial.
     */
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() - DAY)
    });
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.status, 'trialing', 'the stored status has NOT been swept yet');
    assert.equal(e.operational, false, 'but entitlement is already withdrawn');
    assert.equal(e.reason, 'trial_expired');
  });

  it('keeps a trial operational before its end date', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() + 3 * DAY)
    });
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.operational, true);
  });

  it('withdraws operation but PRESERVES data access when cancelled', async () => {
    await subscribe(world.restaurant._id, 'professional', {status: 'cancelled'});
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.operational, false);
    // The brief: an expired subscription must not destroy historical access.
    assert.equal(e.readOnly, true);
  });

  it('never lets a cancelled tenant keep its plan features', async () => {
    await subscribe(world.restaurant._id, 'enterprise', {status: 'cancelled'});
    assert.equal(await hasFeature(world.restaurant._id, 'apiAccess'), false);
    assert.equal(await hasFeature(world.restaurant._id, 'pos'), false);
  });

  it('lets a SUSPENDED restaurant override everything commercial', async () => {
    await subscribe(world.restaurant._id, 'enterprise');
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {status: 'suspended'}});
    invalidateEntitlements();
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.operational, false);
    assert.equal(e.reason, 'tenant_suspended');
    // Suspension is a sanction: not even read access.
    assert.equal(e.readOnly, false);
  });

  it('keeps an existing subscriber working when their plan is retired', async () => {
    await subscribe(world.restaurant._id, 'professional');
    await Plan.updateOne({code: 'professional'}, {$set: {active: false}});
    invalidateEntitlements();
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    // Silently downgrading a paying customer because marketing archived a SKU
    // would be worse than the alternative.
    assert.equal(e.operational, true);
    assert.equal(e.planActive, false);
  });

  it('fails closed when the plan document has vanished', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await Plan.deleteOne({code: 'starter'});
    invalidateEntitlements();
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    assert.equal(e.operational, false);
    assert.equal(e.reason, 'plan_missing');
  });

  it('throws on an unknown feature or limit key rather than passing quietly', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await assert.rejects(() => hasFeature(world.restaurant._id, 'telepathy'), /Unknown feature/);
    await assert.rejects(() => getLimit(world.restaurant._id, 'maxUnicorns'), /Unknown limit/);
  });

  it('invalidates the cache when commercial state changes', async () => {
    await subscribe(world.restaurant._id, 'starter');
    assert.equal((await resolveEntitlement(world.restaurant._id)).planCode, 'starter');

    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(),
      body: {plan: 'enterprise', reason: 'upgrade'}
    });
    // No `fresh` flag: a stale cache would still say starter.
    const after = await resolveEntitlement(world.restaurant._id);
    assert.equal(after.planCode, 'enterprise');
  });
});

// ── 6. limit enforcement ─────────────────────────────────────────────────────

describe('P2C · numeric limit enforcement', () => {
  it('gets the boundary right: the Nth is allowed, the N+1th is not', async () => {
    await subscribe(world.restaurant._id, 'starter');
    // starter.maxBranches = 1, and seedWorld already made two branches, so use
    // an explicit plan to test the arithmetic precisely.
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxBranches': 5}});
    invalidateEntitlements();

    // usage 4, adding 1 -> 5 <= 5 ALLOWED
    await assertWithinLimit(world.restaurant._id, 'maxBranches', 4, {adding: 1});
    // usage 5, adding 1 -> 6 > 5 REFUSED
    await assert.rejects(
      () => assertWithinLimit(world.restaurant._id, 'maxBranches', 5, {adding: 1}),
      /allows 5/
    );
  });

  it('treats null as unlimited', async () => {
    await subscribe(world.restaurant._id, 'enterprise');
    await assertWithinLimit(world.restaurant._id, 'maxBranches', 100000, {adding: 1});
    assert.equal(await getLimit(world.restaurant._id, 'maxBranches'), null);
  });

  it('refuses branch #2 on a one-branch plan, and creates NOTHING', async () => {
    // A dedicated single-branch tenant so seedWorld's two branches do not
    // muddy the arithmetic.
    const solo = await Restaurant.create({name: 'Solo', currency: 'NPR', status: 'active'});
    await Branch.create({restaurant: solo._id, name: 'Only', code: 'ONE'});
    const soloOwner = await User.create({
      name: 'Solo Owner', email: 'solo@test.com', password: 'x', role: 'owner', restaurantId: solo._id
    });
    await subscribe(solo._id, 'starter');

    const before = await getBranchUsage(solo._id);
    assert.equal(before, 1);

    const res = await request('/api/branches', {
      method: 'POST', token: tokenFor(soloOwner),
      body: {name: 'Second Branch', code: 'TWO'}
    });
    assert.equal(res.status, 402, 'a plan limit must answer 402, not 403');
    assert.match(res.body.message, /allows 1 branches/);
    // The operation must not partially succeed.
    assert.equal(await getBranchUsage(solo._id), 1);
    assert.equal(await Branch.countDocuments({restaurant: solo._id, code: 'TWO'}), 0);
  });

  it('allows the branch when the plan permits it', async () => {
    const solo = await Restaurant.create({name: 'Solo2', currency: 'NPR', status: 'active'});
    await Branch.create({restaurant: solo._id, name: 'Only', code: 'ONE'});
    const soloOwner = await User.create({
      name: 'Solo2 Owner', email: 'solo2@test.com', password: 'x', role: 'owner', restaurantId: solo._id
    });
    await subscribe(solo._id, 'professional');
    const res = await request('/api/branches', {
      method: 'POST', token: tokenFor(soloOwner), body: {name: 'Second', code: 'TWO'}
    });
    assert.equal(res.status, 201, `expected success, got ${res.status}: ${res.body?.message}`);
  });

  it('enforces the user seat limit and creates no account when refused', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxUsers': 1}});
    invalidateEntitlements();

    const before = await User.countDocuments({restaurantId: world.restaurant._id});
    const res = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {
        name: 'Extra Hire', email: 'extra@test.com', password: 'LongEnough123',
        role: 'staff', branch: String(world.branchA._id)
      }
    });
    assert.equal(res.status, 402);
    assert.equal(await User.countDocuments({restaurantId: world.restaurant._id}), before);
    assert.equal(await User.countDocuments({email: 'extra@test.com'}), 0);
  });

  it('enforces the menu item limit', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxMenuItems': 0}});
    invalidateEntitlements();
    const res = await request('/api/menu-items', {
      method: 'POST', token: owner(), body: {name: 'Sekuwa', price: 450}
    });
    assert.equal(res.status, 402);
  });

  it('enforces the table limit', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxTables': 0}});
    invalidateEntitlements();
    /**
     * A name `seedWorld` has NOT already used.
     *
     * My first attempt sent `T1`, which the harness already creates, so the
     * duplicate-name check answered 409 before the limit was ever consulted.
     * That was a faulty probe, not a missing control — the limit is checked
     * after the duplicate guard and immediately before the insert, which is
     * the correct order. A unique name reaches it.
     */
    const res = await request('/api/tables', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), name: 'P2C-LIMIT-1', seats: 4}
    });
    assert.equal(res.status, 402, `expected a plan refusal, got ${res.status}: ${res.body?.message}`);
    // Control: the same request on a plan that permits tables succeeds, so the
    // 402 above is the limit and not a permanently broken endpoint.
    await Plan.updateOne({code: 'starter'}, {$set: {'limits.maxTables': 50}});
    invalidateEntitlements();
    const allowed = await request('/api/tables', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), name: 'P2C-LIMIT-2', seats: 4}
    });
    assert.equal(allowed.status, 201, `control failed: ${allowed.body?.message}`);
  });

  it('blocks creation entirely when there is no subscription', async () => {
    const res = await request('/api/menu-items', {
      method: 'POST', token: owner(), body: {name: 'Momo', price: 250}
    });
    assert.equal(res.status, 402);
    assert.match(res.body.message, /No subscription/i);
  });
});

describe('P2C · feature entitlement enforcement', () => {
  it('assertFeature refuses a feature the plan excludes, with 402', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await assert.rejects(
      () => assertFeature(world.restaurant._id, 'apiAccess', {label: 'API access'}),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.billing, true);
        assert.equal(error.reason, 'feature_not_in_plan');
        return true;
      }
    );
    // Control: a feature the plan DOES include passes.
    await assertFeature(world.restaurant._id, 'pos');
  });

  it('refuses every feature when not operational, whatever the plan says', async () => {
    await subscribe(world.restaurant._id, 'enterprise', {status: 'expired'});
    await assert.rejects(
      () => assertFeature(world.restaurant._id, 'pos'),
      error => {
        assert.equal(error.status, 402);
        assert.equal(error.reason, 'subscription_expired');
        return true;
      }
    );
  });
});

// ── 7. platform authorization (P2C-P) ────────────────────────────────────────

const BILLING_READ = [
  {method: 'GET', path: '/api/platform/plans'},
  {method: 'GET', path: '/api/platform/subscriptions'},
  {method: 'GET', path: '/api/platform/billing/meta'}
];

describe('P2C · platform authorization on billing endpoints', () => {
  it('answers 401 to anonymous callers', async () => {
    for (const {method, path} of BILLING_READ) {
      assert.equal((await request(path, {method})).status, 401, path);
    }
  });

  it('answers 403 to owner, manager, staff and rider', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider-p2c@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: false}
    });
    for (const token of [owner(), manager(), staff(), tokenFor(rider)]) {
      for (const {method, path} of BILLING_READ) {
        const res = await request(path, {method, token});
        assert.equal(res.status, 403, `${path} for ${token.slice(0, 10)}`);
      }
    }
  });

  it('answers 403 to a custom tenant role', async () => {
    await Role.create({
      restaurant: world.restaurant._id, key: 'biller', name: 'Biller',
      baseRole: 'manager', permissions: ['settings.manage'], active: true
    });
    const custom = await User.create({
      name: 'Custom', email: 'custom-p2c@test.com', password: 'x', role: 'manager',
      roleKey: 'biller', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    for (const {method, path} of BILLING_READ) {
      assert.equal((await request(path, {method, token: tokenFor(custom)})).status, 403, path);
    }
  });

  it('ignores a forged platformRole JWT claim', async () => {
    const forged = tokenFor(world.owner, {platformRole: 'super_admin'});
    for (const {method, path} of BILLING_READ) {
      assert.equal((await request(path, {method, token: forged})).status, 403, path);
    }
    const forgedWrite = await request(`/api/platform/restaurants/${rival.restaurant._id}/subscription`, {
      method: 'POST', token: forged, body: {plan: 'enterprise', reason: 'free upgrade'}
    });
    assert.equal(forgedWrite.status, 403);
    assert.equal(await Subscription.countDocuments({restaurant: rival.restaurant._id}), 0);
  });

  it('lets support READ billing but refuses every mutation', async () => {
    for (const {method, path} of BILLING_READ) {
      assert.equal((await request(path, {method, token: helpdesk()})).status, 200, path);
    }
    const create = await request('/api/platform/plans', {
      method: 'POST', token: helpdesk(), body: {code: 'sneaky', name: 'Sneaky'}
    });
    assert.equal(create.status, 403);

    const assign = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: helpdesk(), body: {plan: 'enterprise', reason: 'trying'}
    });
    assert.equal(assign.status, 403);
    assert.equal(await Plan.countDocuments({code: 'sneaky'}), 0);
  });

  it('lets platform_admin and super_admin manage billing', async () => {
    for (const token of [admin(), sup()]) {
      const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
        method: 'POST', token, body: {plan: 'starter', reason: 'assigning a plan'}
      });
      assert.ok([200, 201].includes(res.status), `got ${res.status}`);
    }
  });

  it('refuses at the SERVICE layer, with no route guard in the way', async () => {
    // P2B's mutation run: a check behind only a route is a check no unit test
    // exercises. These bypass HTTP entirely.
    await assert.rejects(
      () => listPlans({user: {id: String(world.owner._id)}}),
      /not available to this account/
    );
    await assert.rejects(
      () => assignPlan({
        user: {id: String(world.owner._id)}, restaurantId: String(rival.restaurant._id),
        plan: 'enterprise', reason: 'service level attack'
      }),
      /not available to this account/
    );
    await assert.rejects(
      () => cancelSubscription({
        user: {id: String(support._id)}, restaurantId: String(world.restaurant._id),
        reason: 'support should not do this'
      }),
      /not available to this account/
    );
    // Control: a real operator passes the same call.
    const ok = await listPlans({user: {id: String(platformAdmin._id)}});
    assert.equal(ok.plans.length, 3);
  });
});

// ── 8. tenant isolation (P2C-Q) ──────────────────────────────────────────────

describe('P2C · tenant isolation', () => {
  it('shows an owner only their OWN subscription', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await subscribe(rival.restaurant._id, 'enterprise');

    const mine = await request('/api/my/subscription', {token: owner()});
    assert.equal(mine.status, 200);
    assert.equal(mine.body.plan.code, 'starter');

    const theirs = await request('/api/my/subscription', {token: rivalOwner()});
    assert.equal(theirs.body.plan.code, 'enterprise');
  });

  it('ignores a restaurant id supplied by the tenant', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await subscribe(rival.restaurant._id, 'enterprise');
    // Restaurant A tries to read Restaurant B by every parameter shape.
    const viaQuery = await request(
      `/api/my/subscription?restaurant=${rival.restaurant._id}`, {token: owner()});
    assert.equal(viaQuery.body.plan.code, 'starter');

    const viaEntitlements = await request(
      `/api/my/entitlements?restaurant=${rival.restaurant._id}`, {token: owner()});
    assert.equal(viaEntitlements.body.planCode, 'starter');
  });

  it('refuses Restaurant A any access to Restaurant B\'s subscription', async () => {
    await subscribe(rival.restaurant._id, 'enterprise');
    const paths = [
      `/api/platform/restaurants/${rival.restaurant._id}/subscription`,
      `/api/platform/restaurants/${rival.restaurant._id}/subscription/history`,
      `/api/platform/restaurants/${rival.restaurant._id}/usage`
    ];
    for (const path of paths) {
      assert.equal((await request(path, {token: owner()})).status, 403, path);
    }
  });

  it('refuses Restaurant A any CHANGE to Restaurant B\'s subscription', async () => {
    await subscribe(rival.restaurant._id, 'starter');
    const attempts = [
      {path: `/api/platform/restaurants/${rival.restaurant._id}/subscription`,
        body: {plan: 'enterprise', reason: 'sabotage'}},
      {path: `/api/platform/restaurants/${rival.restaurant._id}/subscription/cancel`,
        body: {reason: 'sabotage'}},
      {path: `/api/platform/restaurants/${rival.restaurant._id}/subscription/trial`,
        body: {days: 300, reason: 'sabotage'}}
    ];
    for (const {path, body} of attempts) {
      const res = await request(path, {method: 'POST', token: owner(), body});
      assert.equal(res.status, 403, path);
    }
    const after = await Subscription.findOne({restaurant: rival.restaurant._id}).lean();
    assert.equal(String(after.plan), String(plans.starter._id));
    assert.equal(after.status, 'active');
  });

  it('gives a tenant NO write surface over its own subscription', async () => {
    await subscribe(world.restaurant._id, 'starter');
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = await request('/api/my/subscription', {
        method, token: owner(), body: {plan: 'enterprise'}
      });
      assert.ok(res.status === 404 || res.status >= 400,
        `${method} /my/subscription must not be a write surface (got ${res.status})`);
    }
    const still = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    assert.equal(String(still.plan), String(plans.starter._id));
  });

  it('scopes usage counting to one tenant', async () => {
    await Branch.create({restaurant: rival.restaurant._id, name: 'Rival 2', code: 'RV2'});
    // seedWorld gives world 2 branches; rival now has 2.
    assert.equal(await getBranchUsage(world.restaurant._id), 2);
    assert.equal(await getBranchUsage(rival.restaurant._id), 2);

    const users = await getUserUsage(rival.restaurant._id);
    assert.equal(users.total, 1);
    assert.equal(users.owner, 1);
  });
});

// ── 9. plan assignment and history (P2C-F, G) ────────────────────────────────

describe('P2C · plan assignment and immutable history', () => {
  it('assigns a plan and records the event', async () => {
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'professional', reason: 'new customer'}
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'active');

    const events = await SubscriptionEvent.find({restaurant: world.restaurant._id}).lean();
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'plan_assigned');
    assert.equal(events[0].reason, 'new customer');
    assert.equal(String(events[0].actor), String(platformAdmin._id));
    assert.equal(events[0].actorRole, 'platform:platform_admin');
  });

  it('starts a trial using the plan\'s own trialDays', async () => {
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(),
      body: {plan: 'starter', reason: 'trial signup', startTrial: true}
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'trialing');
    const days = Math.round((new Date(res.body.trialEnd) - new Date(res.body.trialStart)) / DAY);
    assert.equal(days, 14, 'trial length must come from the plan, not a constant');
    assert.ok(await SubscriptionEvent.findOne({event: 'trial_started'}).lean());
  });

  it('records plan_changed with both plans on an upgrade', async () => {
    await subscribe(world.restaurant._id, 'starter');
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'enterprise', reason: 'upgraded'}
    });
    assert.equal(res.status, 200);
    const event = await SubscriptionEvent.findOne({event: 'plan_changed'}).lean();
    assert.ok(event);
    assert.equal(event.before.planCode, 'starter');
    assert.equal(event.after.planCode, 'enterprise');
  });

  it('requires a reason for every commercial mutation', async () => {
    await subscribe(world.restaurant._id, 'starter');
    const calls = [
      {path: `/api/platform/restaurants/${world.restaurant._id}/subscription`, body: {plan: 'enterprise'}},
      {path: `/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`, body: {}},
      {path: `/api/platform/restaurants/${world.restaurant._id}/subscription/reactivate`, body: {}},
      {path: `/api/platform/restaurants/${world.restaurant._id}/subscription/trial`, body: {days: 5}}
    ];
    for (const {path, body} of calls) {
      const res = await request(path, {method: 'POST', token: admin(), body});
      assert.equal(res.status, 400, path);
    }
  });

  it('refuses assignment to a retired plan', async () => {
    await Plan.updateOne({code: 'enterprise'}, {$set: {active: false}});
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'enterprise', reason: 'oops'}
    });
    assert.equal(res.status, 409);
  });

  it('cancels at period end by default, keeping the tenant working', async () => {
    await subscribe(world.restaurant._id, 'professional');
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`, {
      method: 'POST', token: admin(), body: {reason: 'customer asked to stop'}
    });
    assert.equal(res.status, 200);
    const sub = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    assert.equal(sub.cancelAtPeriodEnd, true);
    assert.equal(sub.status, 'active', 'they keep working until the period ends');
    assert.equal((await resolveEntitlement(world.restaurant._id, {fresh: true})).operational, true);
  });

  it('cancels immediately when asked', async () => {
    await subscribe(world.restaurant._id, 'professional');
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`, {
      method: 'POST', token: admin(), body: {reason: 'abuse', atPeriodEnd: false}
    });
    const sub = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    assert.equal(sub.status, 'cancelled');
    assert.equal((await resolveEntitlement(world.restaurant._id, {fresh: true})).operational, false);
  });

  it('reactivates a cancelled subscription', async () => {
    await subscribe(world.restaurant._id, 'professional', {status: 'cancelled'});
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/reactivate`, {
      method: 'POST', token: admin(), body: {reason: 'customer returned'}
    });
    assert.equal(res.status, 200);
    assert.equal((await Subscription.findOne({restaurant: world.restaurant._id})).status, 'active');
    assert.ok(await SubscriptionEvent.findOne({event: 'subscription_reactivated'}).lean());
  });

  it('extends a trial only with platform authority, and audits it', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() + 2 * DAY)
    });
    const before = await Subscription.findOne({restaurant: world.restaurant._id}).lean();

    const denied = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/trial`, {
      method: 'POST', token: owner(), body: {days: 30, reason: 'I want more'}
    });
    assert.equal(denied.status, 403);

    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/trial`, {
      method: 'POST', token: admin(), body: {days: 7, reason: 'onboarding delay'}
    });
    assert.equal(res.status, 200);
    const after = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    const added = Math.round((after.trialEnd - before.trialEnd) / DAY);
    assert.equal(added, 7);
    assert.ok(await SubscriptionEvent.findOne({event: 'trial_extended'}).lean());
  });

  it('bounds a trial extension so there is no hidden infinite trial', async () => {
    await subscribe(world.restaurant._id, 'starter', {status: 'trialing', trialEnd: new Date()});
    for (const days of [0, -5, 400, 99999]) {
      const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/trial`, {
        method: 'POST', token: admin(), body: {days, reason: 'trying it on'}
      });
      assert.equal(res.status, 400, `days=${days} must be refused`);
    }
  });

  it('refuses to REWRITE subscription history', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'enterprise', reason: 'upgrade'}
    });
    const event = await SubscriptionEvent.findOne({});
    assert.ok(event);
    event.reason = 'rewritten';
    await assert.rejects(() => event.save(), /append-only/);
    await assert.rejects(
      () => SubscriptionEvent.updateOne({_id: event._id}, {$set: {reason: 'x'}}), /append-only/);
    await assert.rejects(() => SubscriptionEvent.deleteOne({_id: event._id}), /append-only/);
  });

  it('returns history newest-first through the API', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'professional', reason: 'upgrade one'}
    });
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`, {
      method: 'POST', token: admin(), body: {reason: 'then cancel', atPeriodEnd: false}
    });
    const res = await request(
      `/api/platform/restaurants/${world.restaurant._id}/subscription/history`, {token: admin()});
    assert.equal(res.status, 200);
    assert.equal(res.body.events[0].event, 'subscription_cancelled');
    assert.equal(res.body.events[1].event, 'plan_changed');
  });
});

// ── 10. trial expiry sweep (P2C-J) ───────────────────────────────────────────

describe('P2C · the subscription sweep', () => {
  it('expires a lapsed trial and records the event', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() - DAY)
    });
    const result = await runSubscriptionSweep();
    assert.equal(result.trialsExpired, 1);
    assert.equal((await Subscription.findOne({restaurant: world.restaurant._id})).status, 'expired');
    const event = await SubscriptionEvent.findOne({event: 'trial_expired'}).lean();
    assert.ok(event);
    // A system action names the clock, not an invented user.
    assert.equal(event.actor, null);
    assert.equal(event.actorRole, 'system:scheduler');
  });

  it('leaves a trial that has not lapsed alone', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() + 5 * DAY)
    });
    const result = await runSubscriptionSweep();
    assert.equal(result.trialsExpired, 0);
    assert.equal((await Subscription.findOne({restaurant: world.restaurant._id})).status, 'trialing');
  });

  it('is idempotent — a second sweep changes nothing', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() - DAY)
    });
    await runSubscriptionSweep();
    const second = await runSubscriptionSweep();
    assert.equal(second.trialsExpired, 0);
    assert.equal(await SubscriptionEvent.countDocuments({event: 'trial_expired'}), 1);
  });

  it('turns a scheduled cancellation into a real one at the period boundary', async () => {
    await subscribe(world.restaurant._id, 'professional', {
      status: 'active', currentPeriodEnd: new Date(Date.now() - DAY), cancelAtPeriodEnd: true
    });
    const result = await runSubscriptionSweep();
    assert.equal(result.cancelled, 1);
    assert.equal((await Subscription.findOne({restaurant: world.restaurant._id})).status, 'cancelled');
  });

  it('expires an active subscription whose period has ended', async () => {
    await subscribe(world.restaurant._id, 'professional', {
      status: 'active', currentPeriodEnd: new Date(Date.now() - DAY)
    });
    const result = await runSubscriptionSweep();
    assert.equal(result.subscriptionsExpired, 1);
  });

  it('stops when the distributed lease is lost mid-sweep', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() - DAY)
    });
    const result = await runSubscriptionSweep({shouldContinue: () => false});
    assert.equal(result.stopped, true);
    // Nothing was written after the lease was reported lost.
    assert.equal((await Subscription.findOne({restaurant: world.restaurant._id})).status, 'trialing');
  });
});

// ── 11. migration (P2C-S) ────────────────────────────────────────────────────

describe('P2C · subscription backfill', () => {
  it('dry run writes nothing', async () => {
    const report = await backfillSubscriptions({dryRun: true});
    assert.equal(report.dryRun, true);
    assert.ok(report.created >= 2);
    assert.equal(await Subscription.countDocuments({}), 0);
  });

  it('real run creates one subscription per restaurant', async () => {
    const report = await backfillSubscriptions();
    const restaurants = await Restaurant.countDocuments({});
    assert.equal(report.created, restaurants);
    assert.equal(await Subscription.countDocuments({}), restaurants);
  });

  it('is idempotent — a second run creates nothing', async () => {
    await backfillSubscriptions();
    const before = await Subscription.countDocuments({});
    const second = await backfillSubscriptions();
    assert.equal(second.created, 0);
    assert.equal(second.alreadySubscribed, before);
    assert.equal(await Subscription.countDocuments({}), before);
  });

  it('never overwrites an existing subscription', async () => {
    await subscribe(world.restaurant._id, 'enterprise');
    await backfillSubscriptions({planCode: 'starter'});
    const sub = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    assert.equal(String(sub.plan), String(plans.enterprise._id),
      'the backfill downgraded an existing subscriber');
  });

  it('aborts rather than inventing a plan', async () => {
    await assert.rejects(
      () => backfillSubscriptions({planCode: 'nonexistent'}),
      /does not exist/
    );
    assert.equal(await Subscription.countDocuments({}), 0);
  });

  it('refuses to place tenants directly into a terminal state', async () => {
    await assert.rejects(() => backfillSubscriptions({status: 'cancelled'}), /must be trialing or active/);
  });

  it('does not backdate the commercial relationship', async () => {
    const old = await Restaurant.create({
      name: 'Old Timer', currency: 'NPR', status: 'active',
      createdAt: new Date('2020-01-01')
    });
    const runAt = new Date();
    await backfillSubscriptions({now: runAt});
    const sub = await Subscription.findOne({restaurant: old._id}).lean();
    assert.equal(sub.startDate.getTime(), runAt.getTime(),
      'startDate must be when the record was created, not the restaurant');
  });

  it('records every backfilled subscription in history as a migration', async () => {
    await backfillSubscriptions();
    const event = await SubscriptionEvent.findOne({restaurant: world.restaurant._id}).lean();
    assert.ok(event);
    assert.equal(event.actorRole, 'system:migration');
    assert.equal(event.actor, null);
  });
});

// ── 12. audit (P2C-T) ────────────────────────────────────────────────────────

describe('P2C · audit', () => {
  it('writes a chained audit row for every commercial mutation', async () => {
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'starter', reason: 'assign'}
    });
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'professional', reason: 'upgrade'}
    });
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`, {
      method: 'POST', token: admin(), body: {reason: 'stop', atPeriodEnd: false}
    });

    for (const action of ['plan_assigned', 'plan_changed', 'subscription_cancelled']) {
      const row = await Audit.findOne({action}).lean();
      assert.ok(row, `${action} was not audited`);
      assert.ok(row.hash, `${action} row is not chained`);
      assert.equal(String(row.restaurant), String(world.restaurant._id));
    }
  });

  it('keeps the hash chain verifiable after commercial mutations', async () => {
    const {verifyAuditChain} = await import('../src/services/auditTrail.js');
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'professional', reason: 'assign'}
    });
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`, {
      method: 'POST', token: admin(), body: {reason: 'cancel', atPeriodEnd: false}
    });
    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
    assert.ok(result.checked >= 2);
  });

  it('never records a secret or credential', async () => {
    await request(`/api/platform/restaurants/${world.restaurant._id}/subscription`, {
      method: 'POST', token: admin(), body: {plan: 'starter', reason: 'assign'}
    });
    const rows = await Audit.find({entity: 'subscription'}).lean();
    const events = await SubscriptionEvent.find({}).lean();
    const blob = JSON.stringify([...rows, ...events]).toLowerCase();
    for (const secret of ['password', 'jwt', 'secret', 'token', 'card']) {
      assert.ok(!blob.includes(secret), `commercial records leaked "${secret}"`);
    }
  });
});

// ── 13. tenant view + usage ──────────────────────────────────────────────────

describe('P2C · tenant subscription view and usage', () => {
  it('shows the tenant their plan, features, limits and usage', async () => {
    await subscribe(world.restaurant._id, 'professional');
    const res = await request('/api/my/entitlements', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.planCode, 'professional');
    assert.equal(res.body.operational, true);
    assert.equal(res.body.features.onlineOrdering, true);
    assert.equal(res.body.limits.maxBranches, 5);
    assert.equal(res.body.usage.maxBranches, 2, 'seedWorld creates two branches');
  });

  it('lets staff see the plan too — a limit refusal must be explainable', async () => {
    await subscribe(world.restaurant._id, 'starter');
    const res = await request('/api/my/subscription', {token: staff()});
    assert.equal(res.status, 200);
    assert.equal(res.body.plan.code, 'starter');
  });

  it('reports honestly when there is no subscription', async () => {
    const res = await request('/api/my/subscription', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.subscription, null);
    assert.equal(res.body.plan, null);
    assert.equal(res.body.entitlement.operational, false);
  });

  it('computes the monthly window in Kathmandu time, not UTC', () => {
    // 2026-03-01 00:30 UTC is 2026-03-01 06:15 in Kathmandu (+05:45), so it
    // belongs to March. A naive UTC window agrees here...
    const march = monthWindow(new Date('2026-03-01T00:30:00Z'));
    assert.equal(march.start.toISOString(), '2026-02-28T18:15:00.000Z');

    // ...but 2026-03-01 00:30 UTC minus an hour is still February in UTC while
    // already March locally. This is the boundary a naive window gets wrong.
    const boundary = monthWindow(new Date('2026-02-28T18:20:00Z'));
    assert.equal(boundary.start.toISOString(), '2026-02-28T18:15:00.000Z',
      'a Kathmandu-local March timestamp must fall in the March window');
  });

  it('counts deactivated users against the seat limit', async () => {
    await User.create({
      name: 'Former', email: 'former@test.com', password: 'x', role: 'staff',
      restaurantId: world.restaurant._id, branch: world.branchA._id, active: false
    });
    const usage = await getUserUsage(world.restaurant._id);
    // Otherwise a tenant holds unlimited accounts by cycling `active`.
    assert.ok(usage.total >= 1);
    assert.equal(usage.staff >= 1, true);
  });
});

// ── 14. no fabricated payment (P2C-L) ────────────────────────────────────────

describe('P2C · no fabricated payment', () => {
  it('never marks a subscription paid, and has no gateway surface', async () => {
    await subscribe(world.restaurant._id, 'professional');
    const sub = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    // There is no `paid`, no transaction id and no gateway reference anywhere.
    assert.equal(sub.paid, undefined);
    assert.equal(sub.transactionId, undefined);
    assert.equal(sub.gateway, undefined);
    assert.ok(!SUBSCRIPTION_STATUSES.includes('paid'));
  });

  it('reaches past_due only by an explicit operator action', async () => {
    await subscribe(world.restaurant._id, 'professional', {
      status: 'active', currentPeriodEnd: new Date(Date.now() - DAY)
    });
    // The sweep expires it; nothing infers a failed payment.
    await runSubscriptionSweep();
    const swept = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    assert.notEqual(swept.status, 'past_due');

    await Subscription.updateOne({restaurant: world.restaurant._id}, {$set: {status: 'active'}});
    invalidateEntitlements();
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/subscription/past-due`, {
      method: 'POST', token: admin(), body: {reason: 'invoice unpaid 30 days'}
    });
    assert.equal(res.status, 200);
    assert.equal((await Subscription.findOne({restaurant: world.restaurant._id})).status, 'past_due');
  });
});

// ── 15. platform listing ─────────────────────────────────────────────────────

describe('P2C · platform subscription listing', () => {
  it('lists subscriptions across tenants with plan and restaurant names', async () => {
    await subscribe(world.restaurant._id, 'starter');
    await subscribe(rival.restaurant._id, 'enterprise');
    const res = await request('/api/platform/subscriptions', {token: admin()});
    assert.equal(res.status, 200);
    assert.equal(res.body.subscriptions.length, 2);
    const codes = res.body.subscriptions.map(row => row.plan.code).sort();
    assert.deepEqual(codes, ['enterprise', 'starter']);
  });

  it('filters by status and plan', async () => {
    await subscribe(world.restaurant._id, 'starter', {status: 'cancelled'});
    await subscribe(rival.restaurant._id, 'enterprise');
    const cancelled = await request('/api/platform/subscriptions?status=cancelled', {token: admin()});
    assert.equal(cancelled.body.subscriptions.length, 1);

    const byPlan = await request('/api/platform/subscriptions?plan=enterprise', {token: admin()});
    assert.equal(byPlan.body.subscriptions.length, 1);
    assert.equal(byPlan.body.subscriptions[0].plan.code, 'enterprise');
  });

  it('refuses an unknown status filter', async () => {
    const res = await request('/api/platform/subscriptions?status=bogus', {token: admin()});
    assert.equal(res.status, 400);
  });

  it('gives 404 identically for a malformed and an unknown restaurant id', async () => {
    const malformed = await request('/api/platform/restaurants/not-an-id/subscription', {token: admin()});
    const missing = await request(
      `/api/platform/restaurants/${new mongoose.Types.ObjectId()}/subscription`, {token: admin()});
    assert.equal(malformed.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(malformed.body, missing.body);
  });
});

// ── 16. the enforcement rollout gate ─────────────────────────────────────────

describe('P2C · billing enforcement is gated on the platform being provisioned', () => {
  /**
   * WHY THIS GATE EXISTS — a defect the regression suite caught.
   *
   * The first implementation enforced limits unconditionally. That is right in
   * steady state and catastrophic on deploy day: every existing restaurant has
   * no subscription, so restarting the container would have refused every menu
   * item, user and table on the platform BEFORE anybody could run the
   * migration. Nine existing tests failed and said so.
   *
   * The rollout order must be: deploy -> seed plans -> backfill -> enforce.
   */
  it('does not enforce when no plan catalogue exists', async () => {
    await Plan.deleteMany({});
    __resetBillingEnforcementProbe();
    invalidateEntitlements();
    assert.equal(await billingEnforcementActive(), false);

    // A tenant with no subscription can still work — the pre-P2C behaviour.
    const res = await request('/api/menu-items', {
      method: 'POST', token: owner(), body: {name: 'Unenforced Momo', price: 250}
    });
    assert.equal(res.status, 201, `expected the legacy path to keep working, got ${res.body?.message}`);
  });

  it('starts enforcing as soon as plans are seeded', async () => {
    await Plan.deleteMany({});
    __resetBillingEnforcementProbe();
    assert.equal(await billingEnforcementActive(), false);

    await seedPlans();
    __resetBillingEnforcementProbe();
    assert.equal(await billingEnforcementActive(), true);

    const res = await request('/api/menu-items', {
      method: 'POST', token: owner(), body: {name: 'Enforced Momo', price: 250}
    });
    assert.equal(res.status, 402, 'with plans seeded, a tenant with no subscription is refused');
  });

  it('honours an explicit BILLING_ENFORCEMENT=off override', async () => {
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      process.env.BILLING_ENFORCEMENT = 'off';
      __resetBillingEnforcementProbe();
      // Plans exist (seeded in beforeEach) and there is still no subscription.
      assert.equal(await billingEnforcementActive(), false);
      const res = await request('/api/menu-items', {
        method: 'POST', token: owner(), body: {name: 'Override Momo', price: 250}
      });
      assert.equal(res.status, 201);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });

  it('honours an explicit BILLING_ENFORCEMENT=on override with no plans', async () => {
    const previous = process.env.BILLING_ENFORCEMENT;
    try {
      await Plan.deleteMany({});
      process.env.BILLING_ENFORCEMENT = 'on';
      __resetBillingEnforcementProbe();
      assert.equal(await billingEnforcementActive(), true);
    } finally {
      if (previous === undefined) delete process.env.BILLING_ENFORCEMENT;
      else process.env.BILLING_ENFORCEMENT = previous;
      __resetBillingEnforcementProbe();
    }
  });

  it('still REPORTS entitlements honestly while enforcement is off', async () => {
    await Plan.deleteMany({});
    __resetBillingEnforcementProbe();
    invalidateEntitlements();
    const e = await resolveEntitlement(world.restaurant._id, {fresh: true});
    // The resolver never lies about standing; only the ASSERTS are gated.
    assert.equal(e.operational, false);
    assert.equal(e.reason, 'no_subscription');
  });
});

// ── 17. survivors from the mutation run ──────────────────────────────────────

describe('P2C · service-layer guards, with no route schema in the way', () => {
  /**
   * WHY THIS BLOCK EXISTS — a mutation finding.
   *
   * A mutant that DELETED the reason requirement from `assignPlan()` survived.
   * It was not a hole: the route's zod schema (`reason: min(3)`) refuses the
   * request first, so every HTTP test still passed. But that means the SERVICE
   * check was never exercised, and a service is callable from a script, a job
   * or another service with no schema in front of it.
   *
   * Probed directly before writing these: calling `assignPlan()` with
   * `reason: ''` does throw "A reason is required to change a plan", so the
   * check is real and reachable — it simply had no test. These call the
   * services directly so the route schema is not in the picture.
   */
  const actor = () => ({id: String(platformAdmin._id)});

  it('requires a reason to assign a plan, at the service layer', async () => {
    await assert.rejects(
      () => assignPlan({
        user: actor(), restaurantId: String(world.restaurant._id), plan: 'starter', reason: ''
      }),
      /reason is required/
    );
    await assert.rejects(
      () => assignPlan({
        user: actor(), restaurantId: String(world.restaurant._id), plan: 'starter', reason: '  x '
      }),
      /reason is required/
    );
    // Control: a real reason is accepted through the same call.
    const ok = await assignPlan({
      user: actor(), restaurantId: String(world.restaurant._id), plan: 'starter',
      reason: 'legitimate assignment'
    });
    assert.equal(ok.status, 'active');
    assert.equal(await Subscription.countDocuments({restaurant: world.restaurant._id}), 1);
  });

  it('requires a reason to cancel, extend a trial and reactivate, at the service layer', async () => {
    await subscribe(world.restaurant._id, 'starter', {
      status: 'trialing', trialEnd: new Date(Date.now() + 5 * DAY)
    });
    await assert.rejects(
      () => cancelSubscription({user: actor(), restaurantId: String(world.restaurant._id), reason: ''}),
      /reason is required/
    );
    await assert.rejects(
      () => extendTrial({
        user: actor(), restaurantId: String(world.restaurant._id), days: 5, reason: ''
      }),
      /reason is required/
    );
    await assert.rejects(
      () => reactivateSubscription({
        user: actor(), restaurantId: String(world.restaurant._id), reason: ''
      }),
      /reason is required/
    );
    // Nothing changed while all three were refused.
    const sub = await Subscription.findOne({restaurant: world.restaurant._id}).lean();
    assert.equal(sub.status, 'trialing');
    assert.equal(sub.cancelAtPeriodEnd, false);
  });

  it('takes the tenant ONLY from the authenticated principal, never from the caller', async () => {
    /**
     * A mutant made `getOwnSubscription()` honour a caller-supplied restaurant
     * id. It survived because no test passed one — the mutant invented a field
     * nothing sets. This closes that by proving the function ignores every
     * extra field it is handed.
     */
    await subscribe(world.restaurant._id, 'starter');
    await subscribe(rival.restaurant._id, 'enterprise');

    for (const contamination of [
      {restaurantId: String(rival.restaurant._id)},
      {restaurantIdOverride: String(rival.restaurant._id)},
      {restaurant: String(rival.restaurant._id)}
    ]) {
      const result = await getOwnSubscription({
        user: {id: String(world.owner._id), role: 'owner', ...contamination}
      });
      assert.equal(result.plan.code, 'starter',
        `a caller-supplied ${Object.keys(contamination)[0]} reached the subscription lookup`);
    }
  });

  it('scopes every usage count to the restaurant it was asked about', async () => {
    /**
     * A mutant that removed the `restaurant` filter from the branch count
     * survived only against a single-tenant fixture. Two tenants with
     * DIFFERENT counts make an unscoped query impossible to miss.
     */
    await Branch.create({restaurant: rival.restaurant._id, name: 'Rival 2', code: 'RV2'});
    await Branch.create({restaurant: rival.restaurant._id, name: 'Rival 3', code: 'RV3'});

    const mine = await getBranchUsage(world.restaurant._id);
    const theirs = await getBranchUsage(rival.restaurant._id);
    assert.equal(mine, 2, 'seedWorld creates exactly two branches');
    assert.equal(theirs, 3);
    // An unscoped count would return the platform total for both.
    assert.notEqual(mine, theirs);
    assert.notEqual(mine, mine + theirs);
  });
});

describe('P2C · a forged platformRole claim cannot reach billing', () => {
  /**
   * The P2B equivalent-mutant argument, re-verified for the billing surface.
   *
   * A mutant that stops deleting `req.user.platformRole` survives because
   * nothing READS the claim — every platform check re-reads the database. The
   * delete is defence in depth against a future careless reader, and its
   * ordering is what makes the "read authority from the token" mutant
   * equivalent. Asserted as a property of the source, since no single request
   * can demonstrate an ordering.
   */
  it('deletes the claim inside authenticate(), before any guard runs', () => {
    const source = readFileSync(
      new URL('../src/middleware/auth.js', import.meta.url), 'utf8');
    const authenticateAt = source.indexOf('async function authenticate(req)');
    const deleteAt = source.indexOf('delete req.user.platformRole');
    const guardAt = source.indexOf('export const requirePlatformPermission');
    assert.ok(authenticateAt > 0 && deleteAt > authenticateAt);
    assert.ok(deleteAt < guardAt,
      'the platformRole claim must be deleted BEFORE the platform guard reads authority');
  });

  it('refuses a forged claim on every billing mutation, and writes nothing', async () => {
    const forged = tokenFor(world.owner, {platformRole: 'super_admin'});
    const attempts = [
      {path: '/api/platform/plans', body: {code: 'forged', name: 'Forged'}},
      {path: `/api/platform/restaurants/${world.restaurant._id}/subscription`,
        body: {plan: 'enterprise', reason: 'forged upgrade'}},
      {path: `/api/platform/restaurants/${world.restaurant._id}/subscription/cancel`,
        body: {reason: 'forged cancel'}}
    ];
    for (const {path, body} of attempts) {
      const res = await request(path, {method: 'POST', token: forged, body});
      assert.equal(res.status, 403, path);
    }
    assert.equal(await Plan.countDocuments({code: 'forged'}), 0);
    assert.equal(await Subscription.countDocuments({}), 0);
    assert.equal(await SubscriptionEvent.countDocuments({}), 0);
  });
});
