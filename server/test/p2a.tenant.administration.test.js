import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, User} from '../src/models/index.js';
import {Branch, Restaurant, TENANT_STATUSES} from '../src/models/operations.js';
import {ALL_PERMISSIONS, permissionsForBuiltin} from '../src/services/permissions.js';
import {
  PLATFORM_PERMISSIONS, PLATFORM_ROLES, hasPlatformPermission, isPlatformOperator,
  platformPermissionsFor
} from '../src/services/platformAccess.js';
import {isTenantOperational} from '../src/services/tenantAdmin.js';

/**
 * P2A — tenant administration and the platform boundary.
 *
 * The security question this phase exists to answer: a restaurant owner holds
 * `'*'` in the tenant catalogue, which `resolvePrincipal()` expands to every
 * permission. So "add a platform permission to the catalogue" would silently
 * hand every owner the power to suspend other restaurants.
 *
 * Most of what follows asserts that this did NOT happen.
 */

let world;
let rival;
let platformAdmin;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const admin = () => tokenFor(platformAdmin);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();

  // A second, complete tenant.
  const restaurant = await Restaurant.create({
    name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR', status: 'active'
  });
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: restaurant._id
  });
  rival = {restaurant, branch, owner: rivalOwner};

  /**
   * A platform operator. Note it is NOT attached to any restaurant: a platform
   * admin is not an employee of anybody. `platformRole` is set directly
   * because no endpoint may grant it — that is the point.
   */
  platformAdmin = await User.create({
    name: 'Platform Admin', email: 'platform@saas.test', password: 'x',
    role: 'owner', platformRole: 'platform_admin'
  });
});

// ── the boundary that makes P2A safe ─────────────────────────────────────────

describe('P2A · platform authority is separate from tenant RBAC', () => {
  it('keeps platform permissions OUT of the tenant catalogue', () => {
    /**
     * THE CENTRAL ASSERTION OF THIS PHASE.
     *
     * An owner's permission set is materialised from the whole catalogue, so
     * anything added there is granted to every restaurant owner on the
     * platform. Platform authority must therefore live somewhere else.
     */
    for (const permission of PLATFORM_PERMISSIONS) {
      assert.ok(!ALL_PERMISSIONS.includes(permission),
        `${permission} is in the tenant catalogue — every owner would inherit it`);
    }
    // ...and an owner really does hold the entire tenant catalogue, which is
    // why the rule above matters rather than being theoretical.
    assert.equal(permissionsForBuiltin('owner').length, ALL_PERMISSIONS.length);

    /**
     * Mutation testing caught this gap: checking only the five CURRENT
     * platform keys let a newly-added `platform.*` key slip into the tenant
     * catalogue unnoticed. The rule is about the NAMESPACE, so assert on it.
     */
    const leaked = ALL_PERMISSIONS.filter(key => key.startsWith('platform.'));
    assert.deepEqual(leaked, [],
      'no platform-namespaced key may exist in the tenant catalogue — owners hold *');
  });

  it('grants no platform permission to any tenant role', async () => {
    for (const [label, user] of [
      ['owner', world.owner], ['manager', world.manager], ['staff', world.staffA]
    ]) {
      const stored = await User.findById(user._id).select('+platformRole').lean();
      assert.deepEqual(platformPermissionsFor(stored), [],
        `${label} holds platform authority`);
      assert.equal(isPlatformOperator(stored), false);
    }
  });

  it('reads platform authority from storage, never from a claim', async () => {
    // A forged `platformRole` in a token must grant nothing: the service loads
    // the stored row with `+platformRole`.
    const forged = tokenFor(world.owner, {platformRole: 'platform_admin'});
    const res = await request('/api/platform/restaurants', {token: forged});
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('ignores an unknown platform role', () => {
    assert.deepEqual(platformPermissionsFor({platformRole: 'god_mode'}), []);
    assert.deepEqual(platformPermissionsFor({platformRole: ''}), []);
    assert.deepEqual(platformPermissionsFor({}), []);
    assert.deepEqual(platformPermissionsFor(null), []);
  });

  it('describes exactly the authority it enforces', () => {
    assert.deepEqual(
      [...PLATFORM_ROLES.platform_admin.permissions].sort(),
      [...PLATFORM_PERMISSIONS].sort()
    );
    assert.ok(hasPlatformPermission({platformRole: 'platform_admin'}, 'platform.restaurants.suspend'));
    assert.ok(!hasPlatformPermission({platformRole: 'platform_admin'}, 'platform.billing.refund'),
      'an unimplemented permission must not be granted');
  });

  it('does not expose platformRole in a normal user read', async () => {
    // `select: false` — it must not ride along in a casual projection.
    const casual = await User.findById(platformAdmin._id).lean();
    assert.equal(casual.platformRole, undefined, 'platformRole leaked into a default read');
    const explicit = await User.findById(platformAdmin._id).select('+platformRole').lean();
    assert.equal(explicit.platformRole, 'platform_admin');
  });
});

// ── access control on the platform surface ───────────────────────────────────

describe('P2A · who may reach platform administration', () => {
  const platformPaths = () => [
    ['GET', '/api/platform/restaurants', undefined],
    ['GET', `/api/platform/restaurants/${rival.restaurant._id}`, undefined],
    ['POST', '/api/platform/restaurants', {name: 'Sneaky Co'}],
    ['PATCH', `/api/platform/restaurants/${rival.restaurant._id}`, {name: 'Renamed'}],
    ['POST', `/api/platform/restaurants/${rival.restaurant._id}/status`,
      {action: 'suspend', reason: 'unauthorised attempt'}]
  ];

  it('anonymous -> 401', async () => {
    for (const [method, path, body] of platformPaths()) {
      const res = await request(path, {method, ...(body ? {body} : {})});
      assert.equal(res.status, 401, `${method} ${path} -> ${res.status}`);
    }
  });

  it('staff -> 403', async () => {
    for (const [method, path, body] of platformPaths()) {
      const res = await request(path, {method, token: staff(), ...(body ? {body} : {})});
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
    }
  });

  it('manager -> 403', async () => {
    for (const [method, path, body] of platformPaths()) {
      const res = await request(path, {method, token: manager(), ...(body ? {body} : {})});
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
    }
  });

  it('a RESTAURANT OWNER -> 403 on every platform route', async () => {
    /**
     * The headline requirement: "Do not simply give existing owner unlimited
     * cross-tenant access." An owner is the most privileged tenant principal
     * and holds every tenant permission, so this is the case that would break
     * if platform authority had been modelled inside the tenant catalogue.
     */
    for (const [method, path, body] of platformPaths()) {
      const res = await request(path, {method, token: owner(), ...(body ? {body} : {})});
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
    }
    // ...and nothing happened as a side effect.
    assert.equal(await Restaurant.countDocuments({name: 'Sneaky Co'}), 0);
    assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).name, 'Rival Momo');
    assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).status, 'active');
  });

  it('a rider -> 403', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider2a@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: true}
    });
    const res = await request('/api/platform/restaurants', {token: tokenFor(rider)});
    assert.equal(res.status, 403);
  });

  it('a custom role holding every tenant permission -> still 403', async () => {
    // Permissions are not a platform bypass.
    const created = await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {key: 'superrole', name: 'Super', baseRole: 'manager', permissions: [...ALL_PERMISSIONS]}
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const powerful = await User.create({
      name: 'Power', email: 'power2a@test.com', password: 'x', role: 'manager',
      roleKey: 'superrole', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    const res = await request('/api/platform/restaurants', {token: tokenFor(powerful)});
    assert.equal(res.status, 403, JSON.stringify(res.body));
  });

  it('the platform admin CAN reach it — the control', async () => {
    // Without this, every 403 above could be a broken route rather than a
    // working boundary.
    const res = await request('/api/platform/restaurants', {token: admin()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.restaurants.length >= 2, 'sees both tenants');
  });
});

// ── restaurant administration ────────────────────────────────────────────────

describe('P2A · restaurant administration', () => {
  it('lists restaurants with the counts an operator needs', async () => {
    const res = await request('/api/platform/restaurants', {token: admin()});
    assert.equal(res.status, 200);
    const ours = res.body.restaurants.find(row => row.name === 'Mittho Test');
    assert.ok(ours, 'the seeded tenant is listed');
    assert.equal(ours.branchCount, 2, 'branch count');
    assert.ok(ours.userCount >= 4, 'user count');
    assert.ok(ours.owner?.email, 'the owner is identified');
    assert.ok(ours.createdAt && ours.updatedAt, 'timestamps');
    assert.ok(ours.status, 'status');
  });

  it('filters by status and searches by name', async () => {
    await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    const suspended = await request('/api/platform/restaurants?status=suspended', {token: admin()});
    assert.equal(suspended.body.restaurants.length, 1);
    assert.equal(suspended.body.restaurants[0].name, 'Rival Momo');

    const search = await request('/api/platform/restaurants?q=Mittho', {token: admin()});
    assert.equal(search.body.restaurants.length, 1);
    assert.equal(search.body.restaurants[0].name, 'Mittho Test');
  });

  it('treats a search term as text, not a pattern', async () => {
    const res = await request(`/api/platform/restaurants?q=${encodeURIComponent('.*')}`, {token: admin()});
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurants.length, 0, 'a regex metacharacter must not match everything');
  });

  it('rejects an unknown status filter', async () => {
    const res = await request('/api/platform/restaurants?status=deleted', {token: admin()});
    assert.equal(res.status, 400);
  });

  it('creates a restaurant', async () => {
    const res = await request('/api/platform/restaurants', {
      method: 'POST', token: admin(),
      body: {name: 'Newari Kitchen', slug: 'newari-kitchen', legalName: 'Newari Pvt Ltd', pan: '301234567'}
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.slug, 'newari-kitchen');
    assert.equal(res.body.status, 'trial', 'a new tenant starts on trial');
    assert.equal(res.body.branchCount, 0);
    assert.equal(res.body.userCount, 0);

    const stored = await Restaurant.findById(res.body._id).lean();
    assert.equal(stored.legalName, 'Newari Pvt Ltd');
  });

  it('refuses a duplicate or malformed slug', async () => {
    const dup = await request('/api/platform/restaurants', {
      method: 'POST', token: admin(), body: {name: 'Copycat', slug: 'rival-momo'}
    });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));

    // 'UPPER' is deliberately NOT here: the service lowercases before
    // validating, so an uppercase slug is NORMALISED rather than refused.
    // That is the correct behaviour for a URL handle, and asserted below.
    for (const slug of ['Has Spaces', 'trailing-', 'has_underscore', 'a']) {
      const res = await request('/api/platform/restaurants', {
        method: 'POST', token: admin(), body: {name: 'Bad Slug Co', slug}
      });
      assert.equal(res.status, 400, `${slug} was accepted`);
    }
    assert.equal(await Restaurant.countDocuments({name: 'Bad Slug Co'}), 0);

    // An uppercase slug is normalised, not rejected — a URL handle is
    // case-insensitive, so refusing it would be pedantry rather than safety.
    const normalised = await request('/api/platform/restaurants', {
      method: 'POST', token: admin(), body: {name: 'Upper Co', slug: 'UPPER-CASE'}
    });
    assert.equal(normalised.status, 201, JSON.stringify(normalised.body));
    assert.equal(normalised.body.slug, 'upper-case', 'the slug must be normalised to lowercase');
  });

  it('updates a restaurant profile', async () => {
    const res = await request(`/api/platform/restaurants/${rival.restaurant._id}`, {
      method: 'PATCH', token: admin(), body: {legalName: 'Rival Momo Pvt Ltd', phone: '01-5551234'}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const stored = await Restaurant.findById(rival.restaurant._id).lean();
    assert.equal(stored.legalName, 'Rival Momo Pvt Ltd');
    assert.equal(stored.phone, '01-5551234');
  });

  it('refuses to change status through the profile endpoint', async () => {
    /**
     * Lifecycle is a separate, separately-permissioned, separately-audited
     * act. Letting it ride along in a profile edit would mean a rename and a
     * suspension were the same kind of decision.
     */
    const res = await request(`/api/platform/restaurants/${rival.restaurant._id}`, {
      method: 'PATCH', token: admin(), body: {status: 'suspended'}
    });
    assert.ok([400, 403].includes(res.status), `-> ${res.status}`);
    assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).status, 'active');
  });
});

// ── lifecycle ────────────────────────────────────────────────────────────────

describe('P2A · tenant lifecycle', () => {
  it('reuses the P1 status enum rather than inventing one', () => {
    assert.deepEqual([...TENANT_STATUSES], ['trial', 'active', 'suspended', 'cancelled']);
    assert.equal(isTenantOperational('trial'), true);
    assert.equal(isTenantOperational('active'), true);
    assert.equal(isTenantOperational('suspended'), false);
    assert.equal(isTenantOperational('cancelled'), false);
  });

  it('moves a restaurant through its lifecycle, auditing each step', async () => {
    for (const [action, expected] of [
      ['suspend', 'suspended'], ['activate', 'active'], ['cancel', 'cancelled'], ['trial', 'trial']
    ]) {
      const res = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
        method: 'POST', token: admin(),
        body: {action, reason: 'lifecycle verification'}
      });
      assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.restaurant.status, expected);
      assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).status, expected);

      const audited = await Audit.findOne({
        entityId: rival.restaurant._id, action: `platform_restaurant_${action}`
      }).lean();
      assert.ok(audited, `${action} was not audited`);
      assert.equal(audited.after.status, expected);
    }
  });

  it('requires a reason to suspend or cancel', async () => {
    for (const action of ['suspend', 'cancel']) {
      const res = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
        method: 'POST', token: admin(), body: {action}
      });
      assert.equal(res.status, 400, `${action} without a reason was accepted`);
    }
    assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).status, 'active');
  });

  it('is idempotent', async () => {
    const first = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    assert.equal(first.body.changed, true);
    const second = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.changed, false, 're-suspending must be a no-op, not an error');
  });

  it('rejects an unknown lifecycle action', async () => {
    const res = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'delete', reason: 'x'}
    });
    assert.equal(res.status, 400);
  });
});

// ── suspended / cancelled tenant behaviour ───────────────────────────────────

describe('P2A · a suspended tenant cannot trade', () => {
  it('refuses every operational request from a suspended restaurant', async () => {
    /**
     * P1 added the status field; nothing read it. Without this the lifecycle
     * would be decoration — a suspended restaurant would keep taking orders.
     */
    const before = await request('/api/branches', {token: owner()});
    assert.equal(before.status, 200, 'the control: it works while active');

    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });

    for (const [method, path, body] of [
      ['GET', '/api/branches', undefined],
      ['GET', `/api/orders?branch=${world.branchA._id}`, undefined],
      ['GET', '/api/menu-items', undefined],
      ['POST', '/api/orders', {branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]}]
    ]) {
      const res = await request(path, {method, token: owner(), ...(body ? {body} : {})});
      assert.equal(res.status, 403, `${method} ${path} -> ${res.status}`);
      assert.match(res.body.message, /suspended/i);
    }
  });

  it('refuses a cancelled restaurant too', async () => {
    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'cancel', reason: 'left the platform'}
    });
    const res = await request('/api/branches', {token: owner()});
    assert.equal(res.status, 403);
    assert.match(res.body.message, /no longer active/i);
  });

  it('lets a trial restaurant trade normally', async () => {
    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'trial'}
    });
    const res = await request('/api/branches', {token: owner()});
    assert.equal(res.status, 200, 'a trial tenant must be able to use the product');
  });

  it('restores access when the restaurant is reactivated', async () => {
    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    assert.equal((await request('/api/branches', {token: owner()})).status, 403);

    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'activate'}
    });
    assert.equal((await request('/api/branches', {token: owner()})).status, 200,
      'suspension must be reversible');
  });

  it('exempts a platform operator who IS attached to a suspended tenant', async () => {
    /**
     * Mutation testing caught this: inverting the exemption survived, because
     * the platform admin in the other tests belongs to NO restaurant, so the
     * tenant-status branch never ran for them. This covers the real case — an
     * operator who also holds a tenant account.
     */
    const embedded = await User.create({
      name: 'Embedded Admin', email: 'embedded@saas.test', password: 'x', role: 'owner',
      restaurantId: world.restaurant._id, platformRole: 'platform_admin'
    });
    assert.equal((await request('/api/branches', {token: tokenFor(embedded)})).status, 200,
      'the control: works while the tenant is active');

    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });

    const res = await request('/api/branches', {token: tokenFor(embedded)});
    assert.equal(res.status, 200,
      'a platform operator must not be locked out by a tenant suspension');

    // ...while an ordinary owner of the same tenant IS locked out.
    assert.equal((await request('/api/branches', {token: owner()})).status, 403);
  });

  it('still lets the platform admin administer a suspended tenant', async () => {
    // Otherwise suspension would be irreversible from the platform side.
    await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}`, {token: admin()});
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'suspended');
  });
});

// ── tenant self-service ──────────────────────────────────────────────────────

describe('P2A · a restaurant manages itself only', () => {
  it('shows a tenant its own restaurant', async () => {
    const res = await request('/api/my/restaurant', {token: owner()});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.name, 'Mittho Test');
    assert.equal(String(res.body._id), String(world.restaurant._id));
    assert.equal(res.body.branchCount, 2);
  });

  it('never returns another tenant, whatever the request says', async () => {
    /**
     * There is no id parameter by design. Supplying one anyway must not
     * redirect the read — the tenant comes from the token.
     */
    for (const query of [
      `?restaurant=${rival.restaurant._id}`,
      `?id=${rival.restaurant._id}`,
      `?restaurantId=${rival.restaurant._id}`
    ]) {
      const res = await request(`/api/my/restaurant${query}`, {token: owner()});
      assert.equal(res.status, 200);
      assert.equal(String(res.body._id), String(world.restaurant._id),
        `${query} redirected the read`);
      assert.ok(!JSON.stringify(res.body).includes('Rival'));
    }
  });

  it('lets an owner edit their own profile', async () => {
    const res = await request('/api/my/restaurant', {
      method: 'PATCH', token: owner(), body: {legalName: 'Mittho Foods Pvt Ltd'}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await Restaurant.findById(world.restaurant._id).lean()).legalName, 'Mittho Foods Pvt Ltd');
    // ...and the rival is untouched.
    assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).legalName, undefined);
  });

  it('refuses a manager and staff the profile edit', async () => {
    // `settings.manage` is owner-only in the built-in bundles.
    for (const [label, token] of [['manager', manager()], ['staff', staff()]]) {
      const res = await request('/api/my/restaurant', {
        method: 'PATCH', token, body: {name: 'Renamed by ' + label}
      });
      assert.equal(res.status, 403, `${label} -> ${res.status}`);
    }
    assert.equal((await Restaurant.findById(world.restaurant._id).lean()).name, 'Mittho Test');
  });

  it('ignores a restaurantId supplied to the self-service edit', async () => {
    /**
     * Mutation testing caught this: making the service fall back to a
     * caller-supplied `restaurantId` survived every test, because nothing
     * exercised the service directly with one. The route has no `:id`, so
     * this is tested at the SERVICE layer where the parameter exists.
     */
    const {updateRestaurant} = await import('../src/services/tenantAdmin.js');
    await updateRestaurant({
      user: {id: world.owner._id, role: 'owner'},
      restaurantId: rival.restaurant._id,      // another tenant — must be ignored
      input: {legalName: 'Hijacked Ltd'},
      viaPlatform: false
    });

    assert.equal((await Restaurant.findById(rival.restaurant._id).lean()).legalName, undefined,
      'a tenant self-edit wrote into another tenant');
    assert.equal((await Restaurant.findById(world.restaurant._id).lean()).legalName, 'Hijacked Ltd',
      'the edit must apply to the caller\'s own restaurant');
  });

  it('refuses a status change at the SERVICE layer too, not only the schema', async () => {
    // Mutation testing caught this: the route schema rejects `status`, so
    // removing the service-level guard survived. Both layers are load-bearing
    // — the service is reachable from onboarding and future callers.
    const {updateRestaurant} = await import('../src/services/tenantAdmin.js');
    await assert.rejects(
      () => updateRestaurant({
        user: {id: world.owner._id, role: 'owner'},
        input: {status: 'active'}, viaPlatform: false
      }),
      /lifecycle endpoints/
    );
    await assert.rejects(
      () => updateRestaurant({
        user: {id: platformAdmin._id, role: 'owner'},
        restaurantId: rival.restaurant._id,
        input: {status: 'suspended'}, viaPlatform: true
      }),
      /lifecycle endpoints/
    );
  });

  it('does not let a tenant change its own lifecycle status', async () => {
    /**
     * A suspended restaurant must not be able to un-suspend itself by editing
     * its profile. The strict schema rejects the field outright.
     */
    const res = await request('/api/my/restaurant', {
      method: 'PATCH', token: owner(), body: {status: 'active'}
    });
    assert.ok([400, 403].includes(res.status), `-> ${res.status}`);
  });

  it('keeps slug uniqueness across tenants on the self-service path', async () => {
    const res = await request('/api/my/restaurant', {
      method: 'PATCH', token: owner(), body: {slug: 'rival-momo'}
    });
    assert.equal(res.status, 409, 'a tenant claimed another tenant\'s slug');
    assert.equal((await Restaurant.findById(world.restaurant._id).lean()).slug, undefined);
  });

  it('audits a tenant editing itself, distinctly from a platform edit', async () => {
    await request('/api/my/restaurant', {
      method: 'PATCH', token: owner(), body: {phone: '01-4270001'}
    });
    const row = await Audit.findOne({
      entityId: world.restaurant._id, action: 'restaurant_profile_updated'
    }).lean();
    assert.ok(row, 'a tenant self-edit must be audited');
    assert.equal(String(row.user), String(world.owner._id));
  });
});

// ── enumeration resistance and bad input ─────────────────────────────────────

describe('P2A · enumeration resistance', () => {
  it('answers a real, a missing and a malformed id identically to a tenant user', async () => {
    /**
     * An owner probing the platform surface must not be able to tell which
     * restaurant ids exist. All three must be the same 403 — the boundary is
     * checked BEFORE the lookup.
     */
    const real = await request(`/api/platform/restaurants/${rival.restaurant._id}`, {token: owner()});
    const missing = await request(`/api/platform/restaurants/${new mongoose.Types.ObjectId()}`, {token: owner()});
    const malformed = await request('/api/platform/restaurants/not-an-id', {token: owner()});

    assert.equal(real.status, 403);
    assert.equal(missing.status, 403);
    assert.equal(malformed.status, 403);
    assert.deepEqual(real.body, missing.body);
    assert.deepEqual(real.body, malformed.body);
  });

  it('answers a missing and a malformed id identically to a platform admin', async () => {
    const missing = await request(`/api/platform/restaurants/${new mongoose.Types.ObjectId()}`, {token: admin()});
    const malformed = await request('/api/platform/restaurants/not-an-id', {token: admin()});
    assert.equal(missing.status, 404);
    assert.equal(malformed.status, 404, 'a malformed id must not be a distinguishable 400');
    assert.deepEqual(missing.body, malformed.body);
  });

  it('leaks nothing about another tenant in an error body', async () => {
    const res = await request(`/api/platform/restaurants/${rival.restaurant._id}`, {token: owner()});
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes('Rival'), 'the refusal named the tenant');
    assert.ok(!/Cast to ObjectId|MongoServerError/.test(body), 'internals leaked');
  });

  it('rejects an unknown field on the profile schemas', async () => {
    for (const [path, token] of [
      ['/api/my/restaurant', owner()],
      [`/api/platform/restaurants/${rival.restaurant._id}`, admin()]
    ]) {
      const res = await request(path, {
        method: 'PATCH', token, body: {name: 'Fine', platformRole: 'platform_admin'}
      });
      assert.equal(res.status, 400, `${path} accepted an unknown field`);
    }
    // The critical one: nobody promoted themselves.
    const stored = await User.findById(world.owner._id).select('+platformRole').lean();
    assert.equal(stored.platformRole, null);
  });
});

// ── cross-tenant, via the new surface ────────────────────────────────────────

describe('P2A · cross-tenant isolation through the new endpoints', () => {
  it('an owner cannot see another tenant\'s branches or users', async () => {
    for (const path of [
      `/api/branches?restaurant=${rival.restaurant._id}`,
      `/api/accounts?restaurant=${rival.restaurant._id}`
    ]) {
      const res = await request(path, {token: owner()});
      if (res.status === 200) {
        const body = JSON.stringify(res.body);
        assert.ok(!body.includes('Rival'), `${path} leaked another tenant`);
        assert.ok(!body.includes('rivalowner@test.com'), `${path} leaked another tenant's users`);
      }
    }
  });

  it('the rival owner sees only their own restaurant', async () => {
    const res = await request('/api/my/restaurant', {token: tokenFor(rival.owner)});
    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'Rival Momo');
    assert.equal(res.body.branchCount, 1);
  });

  it('a platform admin sees both, and the counts are per tenant', async () => {
    const res = await request('/api/platform/restaurants', {token: admin()});
    const byName = Object.fromEntries(res.body.restaurants.map(row => [row.name, row]));
    assert.equal(byName['Mittho Test'].branchCount, 2);
    assert.equal(byName['Rival Momo'].branchCount, 1);
    assert.notEqual(byName['Mittho Test'].owner.email, byName['Rival Momo'].owner.email);
  });
});
