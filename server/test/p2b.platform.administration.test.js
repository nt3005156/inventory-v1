import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {readFileSync} from 'node:fs';
import {requirePlatformPermission} from '../src/middleware/auth.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Role, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {ALL_PERMISSIONS, PERMISSION_CATALOG, permissionsForBuiltin} from '../src/services/permissions.js';
import {
  PLATFORM_PERMISSIONS, PLATFORM_ROLES, PLATFORM_ROLE_KEYS, canGrantPlatformRole,
  describePlatformSelf, hasPlatformPermission, isPlatformOperator, platformPermissionsFor,
  platformRank
} from '../src/services/platformAccess.js';
import {
  PLATFORM_AUDIT_ACTIONS, listPlatformUsers, platformDashboard, setPlatformRole,
  setPlatformUserActive
} from '../src/services/platformAdmin.js';

/**
 * P2B — platform administration.
 *
 * The question this phase has to keep answering: a restaurant owner holds
 * `'*'` in the tenant catalogue, which `resolvePrincipal()` expands to all 72
 * permissions. Any platform capability expressed in that catalogue is
 * therefore granted to every restaurant owner on the platform. Most of what
 * follows is proof that P2B did not undo P2A's separation while widening it.
 *
 * The second question, new to P2B: platform authority can now be GRANTED over
 * HTTP. Everything about that path is an escalation risk, so it is tested
 * from below (can a tenant reach it?), from the side (can a peer strip a
 * peer?) and from within (can an operator promote themselves?).
 */

let world;
let rival;
let superAdmin;
let platformAdmin;
let support;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const sup = () => tokenFor(superAdmin);
const admin = () => tokenFor(platformAdmin);
const helpdesk = () => tokenFor(support);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();

  const restaurant = await Restaurant.create({
    name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR', status: 'active'
  });
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: restaurant._id
  });
  const rivalStaff = await User.create({
    name: 'Rival Cashier', email: 'rivalstaff@test.com', password: 'x', role: 'staff',
    restaurantId: restaurant._id, branch: branch._id
  });
  rival = {restaurant, branch, owner: rivalOwner, staff: rivalStaff};

  /**
   * Platform operators. None is attached to a restaurant: a platform admin is
   * not an employee of anybody. `platformRole` is written directly because no
   * tenant endpoint may grant it — that is the point of the field.
   */
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
});

// ── 1. the boundary P2A established, still intact after widening ─────────────

describe('P2B · platform permissions stay outside tenant RBAC', () => {
  it('keeps every platform permission OUT of the tenant catalogue', () => {
    for (const permission of PLATFORM_PERMISSIONS) {
      assert.ok(!ALL_PERMISSIONS.includes(permission),
        `${permission} is in the tenant catalogue — every owner would inherit it`);
    }
    // The reason it matters, asserted rather than assumed.
    assert.equal(permissionsForBuiltin('owner').length, ALL_PERMISSIONS.length);
  });

  it('keeps the whole `platform.` NAMESPACE out, not just today\'s keys', () => {
    /**
     * A survivor from P2A's mutation run taught this: asserting only the five
     * keys that existed then would not have caught a sixth being added to the
     * catalogue later. P2B added five more keys, which is exactly the change
     * that assertion was too weak to police.
     */
    for (const key of ALL_PERMISSIONS) {
      assert.ok(!String(key).startsWith('platform.'),
        `${key} is a platform key living in the tenant catalogue`);
    }
    for (const entry of PERMISSION_CATALOG) {
      assert.ok(!String(entry.key).startsWith('platform.'));
    }
  });

  it('uses a key shape the tenant catalogue could not accept anyway', () => {
    // phase20.rbac.test.js enforces /^[a-z]+\.[a-z]+$/ on catalogue keys.
    // Three-segment platform keys are structurally incompatible — a second,
    // mechanical guarantee independent of anyone remembering the rule.
    for (const permission of PLATFORM_PERMISSIONS) {
      assert.equal(permission.split('.').length, 3, permission);
      assert.ok(!/^[a-z]+\.[a-z]+$/.test(permission), permission);
    }
  });

  it('grants a tenant user no platform permissions whatsoever', async () => {
    for (const user of [world.owner, world.manager, world.staffA, rival.owner]) {
      const stored = await User.findById(user._id).select('+platformRole').lean();
      assert.deepEqual(platformPermissionsFor(stored), []);
      assert.equal(isPlatformOperator(stored), false);
    }
  });
});

// ── 2. the role ladder ───────────────────────────────────────────────────────

describe('P2B · platform role model', () => {
  it('defines three roles with a real authorization difference', () => {
    assert.deepEqual([...PLATFORM_ROLE_KEYS].sort(),
      ['platform_admin', 'platform_support', 'super_admin']);

    const support = PLATFORM_ROLES.platform_support.permissions;
    const admin = PLATFORM_ROLES.platform_admin.permissions;
    const superRole = PLATFORM_ROLES.super_admin.permissions;

    // Support is strictly read-only: nothing that mutates.
    for (const permission of support) {
      assert.ok(/\.(view)$/.test(permission), `${permission} is not read-only`);
    }
    // Each rung is a strict superset of the one below — otherwise "rank" is a
    // lie and a demotion could grant something.
    for (const permission of support) assert.ok(admin.includes(permission), permission);
    for (const permission of admin) assert.ok(superRole.includes(permission), permission);
    assert.ok(admin.length > support.length);
    assert.ok(superRole.length > admin.length);
  });

  it('withholds admin-minting from platform_admin — the escalation path', () => {
    /**
     * The difference that justifies super_admin existing at all. An operator
     * who can suspend every restaurant on the platform still cannot create a
     * second operator or promote themselves, so a compromised admin account
     * cannot make itself permanent.
     */
    assert.ok(!PLATFORM_ROLES.platform_admin.permissions.includes('platform.admins.manage'));
    assert.ok(!PLATFORM_ROLES.platform_support.permissions.includes('platform.admins.manage'));
    assert.ok(PLATFORM_ROLES.super_admin.permissions.includes('platform.admins.manage'));
  });

  it('refuses authority to an unknown or empty platform role', () => {
    assert.deepEqual(platformPermissionsFor({platformRole: 'platfrom_admin'}), []);
    assert.deepEqual(platformPermissionsFor({platformRole: ''}), []);
    assert.deepEqual(platformPermissionsFor({platformRole: null}), []);
    assert.deepEqual(platformPermissionsFor({}), []);
    assert.deepEqual(platformPermissionsFor(null), []);
    // Control: a real key does grant.
    assert.ok(platformPermissionsFor({platformRole: 'super_admin'}).length > 0);
  });

  it('strips all platform authority from a DEACTIVATED operator', () => {
    assert.deepEqual(platformPermissionsFor({platformRole: 'super_admin', active: false}), []);
    assert.equal(hasPlatformPermission({platformRole: 'super_admin', active: false},
      'platform.restaurants.view'), false);
    // Control: `active` absent (legacy rows) and `active: true` both grant.
    assert.ok(platformPermissionsFor({platformRole: 'super_admin'}).length > 0);
    assert.ok(platformPermissionsFor({platformRole: 'super_admin', active: true}).length > 0);
  });

  it('never lets anyone grant above their own rank', () => {
    assert.equal(canGrantPlatformRole('super_admin', 'super_admin'), true);
    assert.equal(canGrantPlatformRole('super_admin', 'platform_admin'), true);
    assert.equal(canGrantPlatformRole('platform_admin', 'super_admin'), false);
    assert.equal(canGrantPlatformRole('platform_support', 'platform_admin'), false);
    assert.equal(canGrantPlatformRole('platform_support', 'platform_support'), true);
    // A tenant user has no rank at all, so grants nothing.
    assert.equal(canGrantPlatformRole(null, 'platform_support'), false);
    assert.equal(canGrantPlatformRole('owner', 'platform_support'), false);
    assert.equal(platformRank('owner'), 0);
    assert.equal(platformRank(null), 0);
  });

  it('describes a caller\'s own platform standing honestly', () => {
    assert.deepEqual(describePlatformSelf({platformRole: null}),
      {platform: false, platformRole: null, platformRoleName: null, rank: 0, permissions: []});
    const described = describePlatformSelf({platformRole: 'platform_support'});
    assert.equal(described.platform, true);
    assert.equal(described.rank, 1);
    assert.ok(!described.permissions.includes('platform.restaurants.suspend'));
  });
});

// ── 3. adversarial matrix: who may reach the platform surface ────────────────

/**
 * Every platform endpoint, so a new one cannot be added without appearing in
 * the refusal matrix below.
 */
const PLATFORM_ENDPOINTS = [
  {method: 'GET', path: '/api/platform/dashboard'},
  {method: 'GET', path: '/api/platform/restaurants'},
  {method: 'GET', path: '/api/platform/users'},
  {method: 'GET', path: '/api/platform/admins'},
  {method: 'GET', path: '/api/platform/audit'},
  {method: 'POST', path: '/api/platform/restaurants', body: {name: 'Sneaky Kitchen'}}
];

describe('P2B · platform authorization refuses every tenant principal', () => {
  it('answers 401 to an anonymous caller on every endpoint', async () => {
    for (const {method, path, body} of PLATFORM_ENDPOINTS) {
      const res = await request(path, {method, body});
      assert.equal(res.status, 401, `${method} ${path}`);
    }
  });

  it('answers 403 to owner, manager and staff on every endpoint', async () => {
    for (const token of [owner(), manager(), staff()]) {
      for (const {method, path, body} of PLATFORM_ENDPOINTS) {
        const res = await request(path, {method, token, body});
        assert.equal(res.status, 403, `${method} ${path}`);
        // Identical message for everyone: the surface must not describe
        // itself differently to different callers.
        assert.match(res.body.message, /not available to this account/);
      }
    }
  });

  it('answers 403 to a RIDER', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider-p2b@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: false}
    });
    for (const {method, path, body} of PLATFORM_ENDPOINTS) {
      const res = await request(path, {method, token: tokenFor(rider), body});
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });

  it('answers 403 to a CUSTOM tenant role, however it is configured', async () => {
    /**
     * A tenant can define its own roles. It must not be able to define one
     * that reaches the platform — including by naming a platform key
     * directly, which the catalogue validator should reject outright.
     */
    await Role.create({
      restaurant: world.restaurant._id, key: 'superuser', name: 'Superuser',
      baseRole: 'manager', permissions: ['users.manage', 'settings.manage'], active: true
    });
    const custom = await User.create({
      name: 'Custom', email: 'custom-p2b@test.com', password: 'x', role: 'manager',
      roleKey: 'superuser', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    for (const {method, path, body} of PLATFORM_ENDPOINTS) {
      const res = await request(path, {method, token: tokenFor(custom), body});
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });

  it('cannot be reached by a tenant role that names a platform permission', async () => {
    // The catalogue validator refuses unknown keys, and every platform key is
    // unknown to it by construction.
    const res = await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {name: 'Platform Sneak', baseRole: 'manager', permissions: ['platform.restaurants.suspend']}
    });
    assert.ok(res.status >= 400, `expected refusal, got ${res.status}`);
  });
});

describe('P2B · forged and stale credentials grant nothing', () => {
  it('ignores a forged platformRole claim in an otherwise VALID token', async () => {
    /**
     * The token is correctly signed with the server's secret — this is not a
     * signature test. It simply asserts a claim the server must never read.
     */
    const forged = tokenFor(world.owner, {
      platformRole: 'super_admin',
      platformPermissions: [...PLATFORM_PERMISSIONS]
    });
    for (const {method, path, body} of PLATFORM_ENDPOINTS) {
      const res = await request(path, {method, token: forged, body});
      assert.equal(res.status, 403, `${method} ${path} accepted a forged claim`);
    }
    // Control: the same account WITH the role in storage is admitted, so the
    // refusal above is about the claim and not about the endpoint being dead.
    await User.updateOne({_id: world.owner._id}, {$set: {platformRole: 'super_admin'}});
    const after = await request('/api/platform/dashboard', {token: tokenFor(world.owner)});
    assert.equal(after.status, 200);
  });

  it('never lets a forged platformRole claim reach req.user', async () => {
    /**
     * `req.user` is a spread of the token payload, so without an explicit
     * delete an attacker-controlled `platformRole` would sit on the object
     * ~135 call sites read. Probed through an endpoint that echoes principal
     * facts back.
     */
    const forged = tokenFor(world.owner, {platformRole: 'super_admin'});
    const res = await request('/api/platform/me', {token: forged});
    assert.equal(res.status, 200);
    assert.equal(res.body.platform, false);
    assert.equal(res.body.platformRole, null);
    assert.deepEqual(res.body.permissions, []);
  });

  it('refuses a token signed with the WRONG secret', async () => {
    const bogus = jwt.sign(
      {id: String(superAdmin._id), role: 'owner', platformRole: 'super_admin'},
      'not-the-real-secret', {expiresIn: '1h'}
    );
    const res = await request('/api/platform/dashboard', {token: bogus});
    assert.equal(res.status, 401);
  });

  it('stops access the moment the platform role is removed from the DATABASE', async () => {
    const token = sup();
    assert.equal((await request('/api/platform/dashboard', {token})).status, 200);

    await User.updateOne({_id: superAdmin._id}, {$set: {platformRole: null}});

    // Same token, same second. Authority is read from storage every request.
    const after = await request('/api/platform/dashboard', {token});
    assert.equal(after.status, 403);
  });

  it('stops access when the operator account is DEACTIVATED', async () => {
    const token = sup();
    assert.equal((await request('/api/platform/dashboard', {token})).status, 200);
    await User.updateOne({_id: superAdmin._id}, {$set: {active: false}});
    const after = await request('/api/platform/dashboard', {token});
    // 401 from the principal loader: a deactivated account ends the session.
    assert.ok([401, 403].includes(after.status), `got ${after.status}`);
  });

  it('stops access when the operator account is DELETED', async () => {
    const token = sup();
    await User.deleteOne({_id: superAdmin._id});
    const res = await request('/api/platform/dashboard', {token});
    assert.equal(res.status, 401);
  });
});

describe('P2B · a platform operator is refused what their rank excludes', () => {
  it('lets support READ but refuses every mutation', async () => {
    assert.equal((await request('/api/platform/dashboard', {token: helpdesk()})).status, 200);
    assert.equal((await request('/api/platform/restaurants', {token: helpdesk()})).status, 200);
    assert.equal((await request('/api/platform/users', {token: helpdesk()})).status, 200);
    assert.equal((await request('/api/platform/audit', {token: helpdesk()})).status, 200);

    const create = await request('/api/platform/restaurants', {
      method: 'POST', token: helpdesk(), body: {name: 'Support Kitchen'}
    });
    assert.equal(create.status, 403);

    const suspend = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: helpdesk(), body: {action: 'suspend', reason: 'testing'}
    });
    assert.equal(suspend.status, 403);

    const deactivate = await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: helpdesk(), body: {active: false, reason: 'testing'}
    });
    assert.equal(deactivate.status, 403);
  });

  it('refuses platform_admin the power to mint another operator', async () => {
    const res = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: admin(),
      body: {platformRole: 'platform_support', reason: 'recruiting'}
    });
    assert.equal(res.status, 403);
    const stored = await User.findById(world.manager._id).select('+platformRole').lean();
    assert.equal(stored.platformRole, null);

    // Control: a super admin doing the same thing succeeds.
    const allowed = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'platform_support', reason: 'legitimate hire'}
    });
    assert.equal(allowed.status, 200);
  });

  it('refuses platform_admin an attempt to promote THEMSELVES', async () => {
    const res = await request(`/api/platform/users/${platformAdmin._id}/platform-role`, {
      method: 'PATCH', token: admin(),
      body: {platformRole: 'super_admin', reason: 'promoting myself'}
    });
    assert.equal(res.status, 403);
    const stored = await User.findById(platformAdmin._id).select('+platformRole').lean();
    assert.equal(stored.platformRole, 'platform_admin');
  });
});

// ── 4. restaurant management ─────────────────────────────────────────────────

describe('P2B · platform restaurant management', () => {
  it('lists every tenant with branch and user counts, and no secrets', async () => {
    const res = await request('/api/platform/restaurants', {token: admin()});
    assert.equal(res.status, 200);
    assert.equal(res.body.restaurants.length, 2);
    const serialised = JSON.stringify(res.body);
    for (const forbidden of ['password', 'hash', 'secret', 'token']) {
      assert.ok(!serialised.toLowerCase().includes(forbidden), `leaked ${forbidden}`);
    }
    const found = res.body.restaurants.find(row => row.slug === 'rival-momo');
    assert.equal(found.branchCount, 1);
    assert.equal(found.userCount, 2);
    assert.equal(found.status, 'active');
  });

  it('filters by status and searches by name', async () => {
    await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    const suspended = await request('/api/platform/restaurants?status=suspended', {token: admin()});
    assert.equal(suspended.body.restaurants.length, 1);
    assert.equal(suspended.body.restaurants[0].slug, 'rival-momo');

    const searched = await request('/api/platform/restaurants?q=Rival', {token: admin()});
    assert.equal(searched.body.restaurants.length, 1);
  });

  it('requires a reason to suspend, and audits the transition', async () => {
    const noReason = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend'}
    });
    assert.equal(noReason.status, 400);
    // A blank-ish reason is refused too, not just an absent one.
    const blank = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: '  x '}
    });
    assert.equal(blank.status, 400);
    assert.equal((await Restaurant.findById(rival.restaurant._id)).status, 'active');

    const ok = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'Non-payment, 60 days'}
    });
    assert.equal(ok.status, 200);
    assert.equal((await Restaurant.findById(rival.restaurant._id)).status, 'suspended');

    const row = await Audit.findOne({
      restaurant: rival.restaurant._id, action: 'platform_restaurant_suspend'
    }).lean();
    assert.ok(row);
    assert.equal(row.before.status, 'active');
    assert.equal(row.after.status, 'suspended');
    assert.equal(row.reason, 'Non-payment, 60 days');
    assert.equal(String(row.user), String(platformAdmin._id));
    // Chained like every other audit row.
    assert.ok(row.hash);
    assert.ok(row.sequence >= 1);
  });

  it('audits activation as well as suspension', async () => {
    await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    const res = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'activate'}
    });
    assert.equal(res.status, 200);
    const row = await Audit.findOne({action: 'platform_restaurant_activate'}).lean();
    assert.ok(row, 'activation must be audited');
    assert.equal(row.before.status, 'suspended');
    assert.equal(row.after.status, 'active');
  });

  it('gives 404 — never 400 — for a malformed or unknown restaurant id', async () => {
    const malformed = await request('/api/platform/restaurants/not-an-objectid', {token: admin()});
    assert.equal(malformed.status, 404);
    const missing = await request(
      `/api/platform/restaurants/${new mongoose.Types.ObjectId()}`, {token: admin()});
    assert.equal(missing.status, 404);
    // Identical body: no oracle distinguishing "not an id" from "no such id".
    assert.deepEqual(malformed.body, missing.body);
  });

  it('refuses an owner trying to suspend ANOTHER restaurant', async () => {
    const res = await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: owner(), body: {action: 'suspend', reason: 'eliminating the competition'}
    });
    assert.equal(res.status, 403);
    assert.equal((await Restaurant.findById(rival.restaurant._id)).status, 'active');
  });

  it('refuses an owner trying to suspend their OWN restaurant', async () => {
    // Un-suspending yourself is the attack; suspending yourself is the same
    // endpoint. A tenant has no lifecycle authority at all.
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/status`, {
      method: 'POST', token: owner(), body: {action: 'suspend', reason: 'whatever'}
    });
    assert.equal(res.status, 403);
  });

  it('does not duplicate another tenant\'s data when creating a restaurant', async () => {
    const res = await request('/api/platform/restaurants', {
      method: 'POST', token: admin(),
      body: {name: 'Fresh Kitchen', slug: 'fresh-kitchen'}
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.branchCount, 0);
    assert.equal(res.body.userCount, 0);
    assert.equal(res.body.status, 'trial');
    // Nothing was cloned from an existing tenant.
    assert.equal(await Branch.countDocuments({restaurant: res.body._id}), 0);
    assert.equal(await User.countDocuments({restaurantId: res.body._id}), 0);
  });

  it('refuses a duplicate slug', async () => {
    const res = await request('/api/platform/restaurants', {
      method: 'POST', token: admin(), body: {name: 'Copycat', slug: 'rival-momo'}
    });
    assert.equal(res.status, 409);
  });
});

// ── 5. cross-tenant user management ──────────────────────────────────────────

describe('P2B · cross-tenant user administration', () => {
  it('finds users across every tenant, with membership and no password', async () => {
    const res = await request('/api/platform/users', {token: admin()});
    assert.equal(res.status, 200);
    const emails = res.body.users.map(row => row.email);
    assert.ok(emails.includes('rivalstaff@test.com'));
    assert.ok(emails.includes(world.owner.email));

    const cashier = res.body.users.find(row => row.email === 'rivalstaff@test.com');
    assert.equal(cashier.restaurant.name, 'Rival Momo');
    assert.equal(cashier.branch.code, 'RVL');
    assert.equal(cashier.role, 'staff');
    assert.equal(cashier.active, true);
    assert.equal(cashier.password, undefined);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('password'));
  });

  it('filters by restaurant, so one tenant\'s roster can be isolated', async () => {
    const res = await request(`/api/platform/users?restaurant=${rival.restaurant._id}`, {token: admin()});
    assert.equal(res.status, 200);
    assert.equal(res.body.users.length, 2);
    for (const row of res.body.users) {
      assert.equal(String(row.restaurant._id), String(rival.restaurant._id));
    }
  });

  it('returns an empty page — not an error — for a malformed restaurant filter', async () => {
    const res = await request('/api/platform/users?restaurant=nonsense', {token: admin()});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.users, []);
  });

  it('gives 404 for a malformed or unknown user id, identically', async () => {
    const malformed = await request('/api/platform/users/not-an-id', {token: admin()});
    const missing = await request(
      `/api/platform/users/${new mongoose.Types.ObjectId()}`, {token: admin()});
    assert.equal(malformed.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(malformed.body, missing.body);
  });

  it('deactivates a user in ANOTHER tenant, with a reason, and audits it', async () => {
    const res = await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: admin(),
      body: {active: false, reason: 'Abuse report #442'}
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.changed, true);
    assert.equal((await User.findById(rival.staff._id)).active, false);

    const row = await Audit.findOne({action: 'platform_user_deactivated'}).lean();
    assert.ok(row);
    assert.equal(String(row.entityId), String(rival.staff._id));
    // Stamped under the TARGET's restaurant, so the tenant's own chain records
    // that the platform acted on one of its people.
    assert.equal(String(row.restaurant), String(rival.restaurant._id));
    assert.equal(row.reason, 'Abuse report #442');
    assert.equal(row.before.active, true);
    assert.equal(row.after.active, false);
    assert.ok(!JSON.stringify(row).toLowerCase().includes('password'));
  });

  it('requires a reason to change an account status', async () => {
    const res = await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: false}
    });
    assert.equal(res.status, 400);
    assert.equal((await User.findById(rival.staff._id)).active, true);
  });

  it('reactivates, and audits that too', async () => {
    await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: false, reason: 'investigation'}
    });
    const res = await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: true, reason: 'cleared'}
    });
    assert.equal(res.status, 200);
    assert.equal((await User.findById(rival.staff._id)).active, true);
    assert.ok(await Audit.findOne({action: 'platform_user_reactivated'}).lean());
  });

  it('refuses an operator switching off THEMSELVES or a peer', async () => {
    const self = await request(`/api/platform/users/${platformAdmin._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: false, reason: 'oops'}
    });
    assert.equal(self.status, 409);

    // A second platform_admin: equal rank, so off limits.
    const peer = await User.create({
      name: 'Peer Admin', email: 'peer@saas.test', password: 'x', role: 'owner',
      platformRole: 'platform_admin'
    });
    const lateral = await request(`/api/platform/users/${peer._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: false, reason: 'internal politics'}
    });
    assert.equal(lateral.status, 403);
    assert.equal((await User.findById(peer._id)).active, true);

    // Control: a super admin outranks them and may.
    const allowed = await request(`/api/platform/users/${peer._id}/active`, {
      method: 'PATCH', token: sup(), body: {active: false, reason: 'offboarding'}
    });
    assert.equal(allowed.status, 200);
  });

  it('refuses a tenant owner managing a user in ANOTHER restaurant', async () => {
    const res = await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false, reason: 'sabotage'}
    });
    assert.equal(res.status, 403);
    assert.equal((await User.findById(rival.staff._id)).active, true);

    // ...and the tenant-side account endpoint cannot reach them either.
    const tenantSide = await request(`/api/accounts/${rival.staff._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.equal(tenantSide.status, 404);
    assert.equal((await User.findById(rival.staff._id)).active, true);
  });
});

// ── 6. the two authority systems never bleed into each other ─────────────────

describe('P2B · tenant role changes never confer platform authority', () => {
  it('does not grant platformRole when a user becomes a tenant OWNER', async () => {
    /**
     * `role: 'owner'` and `platformRole: 'platform_admin'` are separate
     * authority systems. Promoting somebody to owner of their restaurant must
     * not make them an operator of the SaaS.
     */
    await User.updateOne({_id: world.manager._id}, {$set: {role: 'owner'}});
    const stored = await User.findById(world.manager._id).select('+platformRole').lean();
    assert.equal(stored.platformRole, null);
    assert.deepEqual(platformPermissionsFor(stored), []);

    const promoted = await User.findById(world.manager._id);
    const res = await request('/api/platform/dashboard', {token: tokenFor(promoted)});
    assert.equal(res.status, 403);
  });

  it('ignores platformRole submitted to the tenant ROLE-ASSIGNMENT endpoint', async () => {
    const res = await request(`/api/users/${world.staffA._id}/role`, {
      method: 'PATCH', token: owner(),
      body: {role: 'manager', platformRole: 'super_admin'}
    });
    // Either the strict schema refuses the unknown field, or it is ignored.
    // Both are acceptable; silently APPLYING it is not.
    const stored = await User.findById(world.staffA._id).select('+platformRole role').lean();
    assert.equal(stored.platformRole, null, `platformRole was set (status ${res.status})`);
  });

  it('ignores platformRole submitted to account CREATION', async () => {
    const res = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {
        name: 'Trojan', email: 'trojan@test.com', password: 'LongEnough123',
        role: 'staff', branch: String(world.branchA._id), platformRole: 'super_admin'
      }
    });
    const created = await User.findOne({email: 'trojan@test.com'}).select('+platformRole').lean();
    if (created) {
      assert.equal(created.platformRole, null, `platformRole was set (status ${res.status})`);
    }
  });

  it('ignores platformRole submitted to the tenant restaurant-profile endpoint', async () => {
    const res = await request('/api/my/restaurant', {
      method: 'PATCH', token: owner(),
      body: {name: 'Renamed', platformRole: 'super_admin'}
    });
    assert.equal(res.status, 400, 'the strict schema must refuse an unknown field');
    const stored = await User.findById(world.owner._id).select('+platformRole').lean();
    assert.equal(stored.platformRole, null);
  });

  it('never exposes platformRole through a TENANT-facing projection', async () => {
    await User.updateOne({_id: world.manager._id}, {$set: {platformRole: 'super_admin'}});
    const roster = await request('/api/accounts', {token: owner()});
    assert.equal(roster.status, 200);
    assert.ok(!JSON.stringify(roster.body).includes('platformRole'),
      'the tenant roster leaked platform authority');

    const me = await request('/api/me/permissions', {token: manager()});
    assert.ok(!JSON.stringify(me.body).includes('platformRole'));
  });

  it('keeps branch-scoped permissions branch-scoped for an embedded operator', async () => {
    /**
     * An operator who is ALSO a restaurant employee gets platform authority
     * across tenants and their ordinary, branch-limited tenant authority
     * inside their own restaurant. Platform rank must not widen the latter.
     */
    const embedded = await User.create({
      name: 'Embedded', email: 'embedded@saas.test', password: 'x', role: 'staff',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      platformRole: 'super_admin'
    });
    const token = tokenFor(embedded);
    // Platform surface: open.
    assert.equal((await request('/api/platform/dashboard', {token})).status, 200);
    // Tenant surface: still just a cashier. `users.manage` is not theirs.
    assert.equal((await request('/api/accounts', {token})).status, 403);
  });
});

// ── 7. dashboard ─────────────────────────────────────────────────────────────

describe('P2B · platform dashboard', () => {
  it('aggregates restaurants, branches and users correctly', async () => {
    const res = await request('/api/platform/dashboard', {token: admin()});
    assert.equal(res.status, 200);

    assert.equal(res.body.restaurants.total, await Restaurant.countDocuments({}));
    assert.equal(res.body.branches.total, await Branch.countDocuments({}));
    assert.equal(res.body.users.total, await User.countDocuments({}));
    assert.equal(res.body.users.platformOperators, 3);
    assert.equal(res.body.restaurants.active + res.body.restaurants.trial,
      res.body.restaurants.operational);
  });

  it('moves a tenant between status buckets when it is suspended', async () => {
    const before = await request('/api/platform/dashboard', {token: admin()});
    await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    const after = await request('/api/platform/dashboard', {token: admin()});

    assert.equal(after.body.restaurants.suspended, before.body.restaurants.suspended + 1);
    assert.equal(after.body.restaurants.active, before.body.restaurants.active - 1);
    assert.equal(after.body.restaurants.total, before.body.restaurants.total);
    assert.equal(after.body.restaurants.operational, before.body.restaurants.operational - 1);
  });

  it('counts a legacy restaurant with NO status as active', async () => {
    // Written straight to the collection so the schema default is bypassed,
    // exactly as a pre-P1 row looks.
    await mongoose.connection.db.collection('restaurants').insertOne({
      name: 'Legacy Bhojanalaya', currency: 'NPR', createdAt: new Date(), updatedAt: new Date()
    });
    const res = await request('/api/platform/dashboard', {token: admin()});
    assert.equal(res.body.restaurants.total, await Restaurant.countDocuments({}));
    // Agrees with the list screen, which also reports a missing status as active.
    const list = await request('/api/platform/restaurants?status=active', {token: admin()});
    assert.equal(res.body.restaurants.active, list.body.pagination.total + 1,
      'aggregation and list must not disagree about legacy rows');
  });

  it('counts inactive users separately from active ones', async () => {
    await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: false, reason: 'investigation'}
    });
    const res = await request('/api/platform/dashboard', {token: admin()});
    assert.equal(res.body.users.inactive, 1);
    assert.equal(res.body.users.active, res.body.users.total - 1);
  });

  it('exposes NO tenant financial data', async () => {
    const res = await request('/api/platform/dashboard', {token: admin()});
    const serialised = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['revenue', 'sales', 'profit', 'payment', 'invoice', 'vat', 'cogs']) {
      assert.ok(!serialised.includes(forbidden), `dashboard leaked ${forbidden}`);
    }
  });
});

// ── 8. platform audit ────────────────────────────────────────────────────────

describe('P2B · platform audit trail', () => {
  it('reuses the existing hash-chained Audit collection', async () => {
    await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    const rows = await Audit.find({action: 'platform_restaurant_suspend'}).lean();
    assert.equal(rows.length, 1);
    // Chained like everything else — not a second, unrelated log.
    assert.ok(rows[0].hash);
    assert.ok(rows[0].sequence >= 1);
    assert.equal(mongoose.connection.collections.audits.collectionName, 'audits');
  });

  it('returns platform actions across tenants', async () => {
    await request(`/api/platform/restaurants/${rival.restaurant._id}/status`, {
      method: 'POST', token: admin(), body: {action: 'suspend', reason: 'non-payment'}
    });
    await request(`/api/platform/users/${rival.staff._id}/active`, {
      method: 'PATCH', token: admin(), body: {active: false, reason: 'abuse'}
    });

    const res = await request('/api/platform/audit', {token: admin()});
    assert.equal(res.status, 200);
    const actions = res.body.events.map(row => row.action);
    assert.ok(actions.includes('platform_restaurant_suspend'));
    assert.ok(actions.includes('platform_user_deactivated'));
    const suspension = res.body.events.find(row => row.action === 'platform_restaurant_suspend');
    assert.equal(suspension.restaurant.name, 'Rival Momo');
    assert.equal(suspension.actor.name, 'Platform Admin');
    assert.equal(suspension.reason, 'non-payment');
  });

  it('is a WHITELIST — it never exposes a tenant\'s operational history', async () => {
    /**
     * Without the action whitelist this endpoint would be a cross-tenant
     * window onto every refund, price change and failed login on the
     * platform. That is the "avoid exposing operational restaurant data
     * unnecessarily" rule, violated in one query.
     */
    await Audit.create({
      entity: 'order', entityId: new mongoose.Types.ObjectId(),
      restaurant: rival.restaurant._id, action: 'order_refund',
      after: {amount: 4500}, user: rival.owner._id
    });
    await Audit.create({
      entity: 'auth', restaurant: rival.restaurant._id, action: 'login_failed',
      reference: 'victim@rival.test'
    });

    const res = await request('/api/platform/audit', {token: admin()});
    const actions = res.body.events.map(row => row.action);
    assert.ok(!actions.includes('order_refund'));
    assert.ok(!actions.includes('login_failed'));
    for (const action of actions) {
      assert.ok(PLATFORM_AUDIT_ACTIONS.includes(action), `${action} is not a platform action`);
    }
    // Control: the refund row really is in the collection, so the absence
    // above is filtering and not an empty database.
    assert.ok(await Audit.findOne({action: 'order_refund'}).lean());
  });

  it('refuses a non-platform action as a filter', async () => {
    const res = await request('/api/platform/audit?action=order_refund', {token: admin()});
    assert.equal(res.status, 400);
  });

  it('records a platform role grant on the GLOBAL chain, not a tenant\'s', async () => {
    await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'platform_support', reason: 'new support hire'}
    });
    const row = await Audit.findOne({action: 'platform_admin_created'}).lean();
    assert.ok(row);
    /**
     * An UNSET Mongoose path reads back `undefined`, not `null` — my first
     * assertion here got that wrong and the "failure" was a faulty probe, not
     * a defect. What actually matters is that the row carries no tenant, so
     * that is what is asserted, both ways.
     */
    assert.ok(row.restaurant === null || row.restaurant === undefined,
      'platform authority is not a tenant fact and must not enter a tenant chain');
    // The row lands on the global chain, alongside other untenanted rows.
    const globalRows = await Audit.find({
      restaurant: null, action: 'platform_admin_created'
    }).lean();
    assert.equal(globalRows.length, 1);
    assert.equal(row.before.platformRole, null);
    assert.equal(row.after.platformRole, 'platform_support');
    assert.equal(row.reason, 'new support hire');
    assert.ok(!JSON.stringify(row).toLowerCase().includes('password'));
  });
});

// ── 9. platform role provisioning ────────────────────────────────────────────

describe('P2B · platform operator provisioning', () => {
  it('grants, then revokes, with audit rows for both', async () => {
    const grant = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'platform_admin', reason: 'promotion'}
    });
    assert.equal(grant.status, 200);
    assert.equal(grant.body.changed, true);
    assert.equal(
      (await User.findById(world.manager._id).select('+platformRole').lean()).platformRole,
      'platform_admin');

    const revoke = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: null, reason: 'left the company'}
    });
    assert.equal(revoke.status, 200);
    assert.equal(
      (await User.findById(world.manager._id).select('+platformRole').lean()).platformRole,
      null);
    assert.ok(await Audit.findOne({action: 'platform_admin_revoked'}).lean());
  });

  it('requires a reason', async () => {
    const res = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(), body: {platformRole: 'platform_support'}
    });
    assert.equal(res.status, 400);
    assert.equal(
      (await User.findById(world.manager._id).select('+platformRole').lean()).platformRole, null);
  });

  it('refuses an unknown platform role', async () => {
    const res = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'god_mode', reason: 'why not'}
    });
    assert.equal(res.status, 400);
  });

  it('refuses a super admin changing their OWN authority', async () => {
    const res = await request(`/api/platform/users/${superAdmin._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'platform_support', reason: 'stepping down'}
    });
    assert.equal(res.status, 409);
    assert.equal(
      (await User.findById(superAdmin._id).select('+platformRole').lean()).platformRole,
      'super_admin');
  });

  it('refuses granting authority to a DEACTIVATED account', async () => {
    await User.updateOne({_id: world.manager._id}, {$set: {active: false}});
    const res = await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'platform_admin', reason: 'dormant authority'}
    });
    assert.equal(res.status, 409);
  });

  it('never removes the LAST active super administrator', async () => {
    // A second super admin, then demote the first: allowed.
    const second = await User.create({
      name: 'Second Super', email: 'second@saas.test', password: 'x',
      role: 'owner', platformRole: 'super_admin'
    });
    const ok = await request(`/api/platform/users/${superAdmin._id}/platform-role`, {
      method: 'PATCH', token: tokenFor(second),
      body: {platformRole: 'platform_admin', reason: 'role change'}
    });
    assert.equal(ok.status, 200);

    // Now `second` is the last one. A third super admin tries to demote them.
    const third = await User.create({
      name: 'Third Super', email: 'third@saas.test', password: 'x',
      role: 'owner', platformRole: 'super_admin'
    });
    // With `third` present there are two, so this succeeds...
    const stillFine = await request(`/api/platform/users/${second._id}/platform-role`, {
      method: 'PATCH', token: tokenFor(third),
      body: {platformRole: 'platform_support', reason: 'reorg'}
    });
    assert.equal(stillFine.status, 200);

    // ...and now `third` is alone and cannot be demoted by anyone.
    const restored = await User.findByIdAndUpdate(
      superAdmin._id, {$set: {platformRole: 'super_admin'}}, {new: true});
    await User.updateOne({_id: superAdmin._id}, {$set: {active: false}});
    const lastOne = await request(`/api/platform/users/${third._id}/platform-role`, {
      method: 'PATCH', token: tokenFor(restored), body: {platformRole: null, reason: 'cleanup'}
    });
    // The actor is deactivated, so they are refused before the count matters.
    assert.ok([401, 403].includes(lastOne.status), `got ${lastOne.status}`);
    assert.equal(
      (await User.findById(third._id).select('+platformRole').lean()).platformRole, 'super_admin');
  });

  it('revokes the target\'s sessions when authority changes', async () => {
    const before = (await User.findById(world.manager._id).lean()).sessionVersion || 0;
    await request(`/api/platform/users/${world.manager._id}/platform-role`, {
      method: 'PATCH', token: sup(),
      body: {platformRole: 'platform_support', reason: 'new hire'}
    });
    const after = (await User.findById(world.manager._id).lean()).sessionVersion || 0;
    assert.ok(after > before, 'sessions must be revoked when platform authority changes');
  });

  it('lists operators with their roles, for a support agent too', async () => {
    const res = await request('/api/platform/admins', {token: helpdesk()});
    assert.equal(res.status, 200);
    assert.equal(res.body.admins.length, 3);
    assert.deepEqual(res.body.roles.map(row => row.key).sort(),
      ['platform_admin', 'platform_support', 'super_admin']);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('password'));
  });
});

// ── 10. service-layer authority (route guard removed) ────────────────────────

describe('P2B · the service refuses on its own, without the route guard', () => {
  /**
   * P2A's mutation run produced three survivors that all had the same cause:
   * a check that existed only behind a route was a check no unit test
   * exercised, and deleting it left the suite green. These call the services
   * directly so the route guard is not in the picture at all.
   */
  it('refuses a tenant owner at the service layer', async () => {
    await assert.rejects(
      () => platformDashboard({user: {id: String(world.owner._id)}}),
      /not available to this account/);
    await assert.rejects(
      () => listPlatformUsers({user: {id: String(world.owner._id)}}),
      /not available to this account/);
    await assert.rejects(
      () => setPlatformUserActive({
        user: {id: String(world.owner._id)}, targetId: String(rival.staff._id),
        active: false, reason: 'sabotage'
      }),
      /not available to this account/);
    // Control: a real operator is admitted through the same call.
    const dashboard = await platformDashboard({user: {id: String(platformAdmin._id)}});
    assert.ok(dashboard.restaurants.total >= 2);
  });

  it('refuses support a mutation at the service layer', async () => {
    await assert.rejects(
      () => setPlatformUserActive({
        user: {id: String(support._id)}, targetId: String(rival.staff._id),
        active: false, reason: 'not my job'
      }),
      /not available to this account/);
  });

  it('refuses platform_admin an admin grant at the service layer', async () => {
    await assert.rejects(
      () => setPlatformRole({
        user: {id: String(platformAdmin._id)}, targetId: String(world.manager._id),
        platformRole: 'super_admin', reason: 'escalation attempt'
      }),
      /not available to this account/);
  });

  it('refuses an unauthenticated or nonsense actor', async () => {
    await assert.rejects(() => platformDashboard({user: {}}), /Authentication required/);
    await assert.rejects(() => platformDashboard({user: {id: 'not-an-id'}}), /Authentication required/);
    await assert.rejects(
      () => platformDashboard({user: {id: String(new mongoose.Types.ObjectId())}}),
      /Authentication required/);
  });
});

// ── 11. the ROUTE GUARD in isolation ─────────────────────────────────────────

describe('P2B · requirePlatformPermission, with no service behind it', () => {
  /**
   * WHY THIS BLOCK EXISTS — a mutation-testing finding.
   *
   * Three mutants SURVIVED the first run:
   *   M1  `const allowed = true` in the route guard
   *   M2  stop deleting a forged `platformRole` claim from `req.user`
   *   M3  read platform authority from the TOKEN when the claim is present
   *
   * None of them was a hole: every platform service re-asserts the permission
   * against storage, so an unauthorized caller was still refused and every
   * endpoint still returned 403. That is defence in depth doing exactly its
   * job — and it is also why the tests could not see the difference. Every
   * assertion I had went through a route that had a service behind it, so it
   * was measuring the SERVICE's refusal and silently attributing it to the
   * guard.
   *
   * A guard whose removal changes nothing observable is a guard no test
   * covers. So these mount the middleware in front of a handler that does
   * nothing but return 200. There is no second line of defence here: if the
   * guard lets somebody through, the test sees a 200.
   */
  let guardServer;
  let guardUrl;

  before(async () => {
    const app = express();
    app.use(express.json());
    // The handler is deliberately trivial and unguarded. The middleware is
    // the entire subject under test.
    app.get('/guarded/view',
      requirePlatformPermission('platform.restaurants.view'),
      (req, res) => res.json({
        reached: true,
        // Echoed so a forged claim leaking into req.user is visible.
        platformRoleOnRequest: req.user?.platformRole ?? null,
        resolvedPermissions: req.platformPermissions || []
      }));
    app.get('/guarded/admins',
      requirePlatformPermission('platform.admins.manage'),
      (req, res) => res.json({reached: true}));
    guardServer = http.createServer(app);
    await new Promise(resolve => guardServer.listen(0, '127.0.0.1', resolve));
    guardUrl = `http://127.0.0.1:${guardServer.address().port}`;
  });

  after(async () => {
    if (guardServer) await new Promise(resolve => guardServer.close(resolve));
  });

  const hit = async (path, token) => {
    const res = await fetch(guardUrl + path, {
      headers: token ? {Authorization: `Bearer ${token}`} : {}
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return {status: res.status, body};
  };

  it('refuses an anonymous caller with 401', async () => {
    const res = await hit('/guarded/view', null);
    assert.equal(res.status, 401);
    assert.notEqual(res.body?.reached, true);
  });

  it('refuses a tenant OWNER — the guard alone, nothing behind it', async () => {
    // Kills M1: with `allowed = true` this reaches the handler and returns 200.
    const res = await hit('/guarded/view', owner());
    assert.equal(res.status, 403);
    assert.notEqual(res.body?.reached, true);
  });

  it('refuses manager, staff and rider through the guard alone', async () => {
    const rider = await User.create({
      name: 'Guard Rider', email: 'guardrider@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: false}
    });
    for (const token of [manager(), staff(), tokenFor(rider)]) {
      const res = await hit('/guarded/view', token);
      assert.equal(res.status, 403);
      assert.notEqual(res.body?.reached, true);
    }
  });

  it('admits a genuine operator — the control that proves the guard is not just closed', async () => {
    const res = await hit('/guarded/view', admin());
    assert.equal(res.status, 200);
    assert.equal(res.body.reached, true);
    assert.ok(res.body.resolvedPermissions.includes('platform.restaurants.view'));
  });

  it('refuses a FORGED platformRole claim at the guard', async () => {
    // Kills M3: reading authority from the token admits this caller.
    const forged = tokenFor(world.owner, {platformRole: 'super_admin'});
    const res = await hit('/guarded/view', forged);
    assert.equal(res.status, 403);
    assert.notEqual(res.body?.reached, true);
  });

  it('has no path by which a token claim could reach the authority lookup', () => {
    /**
     * A mutant that made the guard read `req.user.platformRole` when present,
     * falling back to the database otherwise, SURVIVED — and it is an
     * EQUIVALENT mutant, proven rather than assumed.
     *
     * Why it survives: `authenticate()` deletes `req.user.platformRole`
     * before any guard runs, so the mutated branch reads `undefined` and
     * always falls through to the database read. Behaviour is unchanged.
     *
     * PROOF, not inference: combining that mutation with the removal of the
     * delete (M2+M3 together) IS killed by this suite. So the delete is
     * exactly what neutralises it, and the two lines are one control with two
     * halves. M2 alone is killed by the test below.
     *
     * This assertion pins the ordering the equivalence depends on, because it
     * is a property of the SOURCE, not of any single request: if the delete
     * is ever moved after the guard, or removed, this fails.
     */
    const source = readFileSync(
      new URL('../src/middleware/auth.js', import.meta.url), 'utf8');
    const deleteAt = source.indexOf('delete req.user.platformRole');
    const guardAt = source.indexOf('export const requirePlatformPermission');
    assert.ok(deleteAt > 0, 'the forged-claim delete has gone missing');
    assert.ok(guardAt > 0);
    assert.ok(deleteAt < guardAt,
      'the platformRole claim must be deleted BEFORE the platform guard can read it');
    // And it happens inside authenticate(), which every guard calls first.
    const authenticateAt = source.indexOf('async function authenticate(req)');
    assert.ok(authenticateAt > 0 && authenticateAt < deleteAt,
      'the delete must live inside authenticate(), not in one guard');
  });

  it('strips a forged platformRole claim from req.user', async () => {
    /**
     * Kills M2. An operator's request is used so the handler is actually
     * REACHED — otherwise the assertion passes vacuously on a 403 body, which
     * is precisely the sort of hollow test that let M2 survive. The token
     * claims `super_admin`; storage says `platform_admin`. The request object
     * must carry neither — the field is deleted outright.
     */
    const forged = tokenFor(platformAdmin, {platformRole: 'super_admin'});
    const res = await hit('/guarded/view', forged);
    assert.equal(res.status, 200, 'this caller is a genuine operator and must reach the handler');
    assert.equal(res.body.reached, true);
    assert.equal(res.body.platformRoleOnRequest, null,
      'a token-supplied platformRole must never appear on req.user');
    // And the authority actually used is the STORED one, not the claim.
    assert.ok(!res.body.resolvedPermissions.includes('platform.admins.manage'),
      'authority came from the forged claim rather than the database');
  });

  it('enforces the specific permission, not merely "is an operator"', async () => {
    // A platform_admin is a real operator but lacks platform.admins.manage.
    const res = await hit('/guarded/admins', admin());
    assert.equal(res.status, 403);
    assert.notEqual(res.body?.reached, true);
    // Control: a super admin holds it.
    const allowed = await hit('/guarded/admins', sup());
    assert.equal(allowed.status, 200);
  });

  it('stops admitting an operator the moment storage changes', async () => {
    const token = admin();
    assert.equal((await hit('/guarded/view', token)).status, 200);
    await User.updateOne({_id: platformAdmin._id}, {$set: {platformRole: null}});
    const after = await hit('/guarded/view', token);
    assert.equal(after.status, 403, 'the guard must re-read authority from the database');
  });
});

// ── 12. the rank ceiling on granting ─────────────────────────────────────────

describe('P2B · the grant rank-ceiling', () => {
  it('is UNREACHABLE with today\'s roles, and that is documented not accidental', () => {
    /**
     * A mutant that deleted the ceiling in `setPlatformRole()` SURVIVED, and
     * unlike M1–M3 this one is a genuinely equivalent mutant today.
     *
     * Proof: the ceiling can only reject when an actor holding
     * `platform.admins.manage` tries to grant a role ABOVE their own rank.
     * Exactly one role holds that permission — `super_admin` — and it sits at
     * the top of the ladder, so there is no role above it to grant. The
     * branch cannot fire.
     *
     * It is kept deliberately: the moment a mid-rank role is given
     * `platform.admins.manage` (a plausible "regional admin who may hire
     * support staff"), the ceiling becomes the only thing stopping them from
     * minting a super_admin. Removing it now would leave a trap for that
     * change.
     *
     * This test pins the reasoning. If somebody adds `platform.admins.manage`
     * to a non-top role, the assertion below fails and tells them to add the
     * escalation test the ceiling now needs.
     */
    const granters = PLATFORM_ROLE_KEYS.filter(key =>
      PLATFORM_ROLES[key].permissions.includes('platform.admins.manage'));
    assert.deepEqual(granters, ['super_admin']);

    const topRank = Math.max(...PLATFORM_ROLE_KEYS.map(platformRank));
    for (const granter of granters) {
      assert.equal(platformRank(granter), topRank,
        `${granter} can grant platform roles but is not top rank — the rank ceiling in ` +
        'setPlatformRole() is now REACHABLE and needs a direct escalation test');
    }
  });

  it('rejects an over-rank grant at the function that decides it', () => {
    // The ceiling's logic is exercised directly, since the ladder currently
    // gives no way to reach it through the endpoint.
    assert.equal(canGrantPlatformRole('platform_admin', 'super_admin'), false);
    assert.equal(canGrantPlatformRole('platform_support', 'super_admin'), false);
    assert.equal(canGrantPlatformRole('platform_support', 'platform_admin'), false);
    // Control.
    assert.equal(canGrantPlatformRole('super_admin', 'super_admin'), true);
  });
});
