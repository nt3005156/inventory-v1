import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Role, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {
  ALL_PERMISSIONS, BUILTIN_ROLES, PERMISSION_CATALOG, assertPermissionKeys,
  grants, permissionsForBuiltin
} from '../src/services/permissions.js';
import {resolvePrincipal} from '../src/services/accessControl.js';

/**
 * Phase 20 — configurable roles and permissions.
 *
 * The security question this suite exists to answer is not "does the happy
 * path work" but "can somebody get access they should not hold". So it leans
 * on: deactivation taking effect immediately, custom roles failing closed,
 * privilege escalation being refused, and the built-in roles being immutable.
 */

let world;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

/** Create a custom role and a user holding it. */
async function withRole({key, name, baseRole = 'staff', permissions, email}) {
  const created = await request('/api/roles', {
    method: 'POST', token: owner(), body: {key, name, baseRole, permissions}
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const user = await User.create({
    name: name, email: email || `${key}@test.com`, password: 'x',
    role: baseRole, roleKey: created.body.key,
    restaurantId: world.restaurant._id, branch: world.branchA._id
  });
  return {role: created.body, user, token: tokenFor(user)};
}

// ── the catalogue ────────────────────────────────────────────────────────────

describe('Phase 20 · permission catalogue', () => {
  it('exposes every permission the brief names', () => {
    for (const key of [
      'orders.create', 'orders.refund', 'inventory.adjust', 'inventory.count',
      'inventory.approve', 'purchase.create', 'purchase.approve', 'reports.view',
      'users.manage'
    ]) {
      assert.ok(ALL_PERMISSIONS.includes(key), `missing permission ${key}`);
    }
  });

  it('keeps the catalogue internally consistent', () => {
    // Every entry has a key, label and group, and no key is duplicated.
    const seen = new Set();
    for (const entry of PERMISSION_CATALOG) {
      assert.match(entry.key, /^[a-z]+\.[a-z]+$/, `${entry.key} must be resource.action`);
      assert.ok(entry.label && entry.group, `${entry.key} needs a label and group`);
      assert.ok(!seen.has(entry.key), `duplicate permission ${entry.key}`);
      seen.add(entry.key);
    }
    assert.equal(seen.size, ALL_PERMISSIONS.length);
  });

  it('refuses unknown permission keys', () => {
    assert.throws(() => assertPermissionKeys(['orders.create', 'orders.teleport']), /Unknown permission/);
    // Control: a valid list passes and is normalised.
    assert.deepEqual(assertPermissionKeys(['orders.view', 'orders.create', 'orders.view']),
      ['orders.create', 'orders.view']);
  });

  it('grants an owner everything, including permissions added later', () => {
    const ownerPrincipal = {baseRole: 'owner', permissions: new Set()};
    for (const key of ALL_PERMISSIONS) assert.ok(grants(ownerPrincipal, key));
    // A permission that does not exist yet must also resolve for an owner, or
    // every future phase needs a migration.
    assert.ok(grants(ownerPrincipal, 'somethingnew.invented'));
  });

  it('gives the built-in roles the reach they had before Phase 20', () => {
    // Compatibility floor. A manager ran inventory, purchasing, refunds and
    // reports; staff ran the floor but never refunds or purchase approval.
    const mgr = permissionsForBuiltin('manager');
    for (const key of ['inventory.adjust', 'purchase.approve', 'orders.refund', 'reports.view']) {
      assert.ok(mgr.includes(key), `manager lost ${key}`);
    }
    const stf = permissionsForBuiltin('staff');
    assert.ok(stf.includes('orders.create'));
    assert.ok(!stf.includes('orders.refund'), 'staff must not gain refunds');
    assert.ok(!stf.includes('purchase.approve'), 'staff must not gain PO approval');
    assert.ok(!stf.includes('users.manage'), 'staff must not gain user admin');
    // A rider is the least-privileged principal in the system.
    assert.deepEqual(permissionsForBuiltin('rider'), ['deliveries.ride']);
  });
});

// ── deactivation: the defect this phase fixes ────────────────────────────────

describe('Phase 20 · deactivation takes effect immediately', () => {
  it('refuses an existing token the moment the account is deactivated', async () => {
    // THE DEFECT. Reproduced against the running API before the fix: an owner
    // deactivated a manager, login was correctly refused, and the manager's
    // existing token still posted an inventory adjustment (201) and created
    // an order (201). A fired employee could move stock and take money for up
    // to twelve hours — the remaining life of their JWT.
    const token = manager();

    // Control: the token works while the account is live.
    assert.equal((await request('/api/accounts', {token})).status, 200);

    await User.updateOne({_id: world.manager._id}, {$set: {active: false}});

    const roster = await request('/api/accounts', {token});
    assert.equal(roster.status, 401);
    assert.match(roster.body.message, /deactivated/i);

    // The two mutations that made this severe rather than cosmetic.
    const adjustment = await request('/api/inventory/adjustments', {
      method: 'POST', token, headers: {'Idempotency-Key': 'deactivated-probe'},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: -100, reason: 'deactivated employee'
      }
    });
    assert.equal(adjustment.status, 401, 'a deactivated manager must not move stock');

    const order = await request('/api/orders', {
      method: 'POST', token,
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(order.status, 401, 'a deactivated manager must not take money');
  });

  it('restores access when the account is reactivated', async () => {
    // Control for the test above: the refusal is about activation state, not
    // a token that has been permanently poisoned.
    const token = manager();
    await User.updateOne({_id: world.manager._id}, {$set: {active: false}});
    assert.equal((await request('/api/accounts', {token})).status, 401);
    await User.updateOne({_id: world.manager._id}, {$set: {active: true}});
    assert.equal((await request('/api/accounts', {token})).status, 200);
  });

  it('still refuses a token whose role no longer matches storage', async () => {
    // Pre-existing behaviour that must survive the refactor.
    const token = manager();
    await User.updateOne({_id: world.manager._id}, {$set: {role: 'staff'}});
    const res = await request('/api/accounts', {token});
    assert.equal(res.status, 401);
    assert.match(res.body.message, /sign in again/i);
  });

  it('refuses a token for an account that no longer exists', async () => {
    const token = manager();
    await User.deleteOne({_id: world.manager._id});
    assert.equal((await request('/api/accounts', {token})).status, 401);
  });

  it('keeps a disallowed role a 403, not a 401', async () => {
    // Status codes carry meaning: 401 means "your session is over, sign in
    // again", 403 means "you are who you say you are, but no". Forty-one
    // existing assertions depend on this distinction and it must not drift.
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request(`/api/kitchen/board?branch=${world.branchA._id}`, {token: guest})).status, 403);
    assert.equal((await request('/api/reports/pnl', {token: staff()})).status, 403);
  });
});

// ── custom roles ─────────────────────────────────────────────────────────────

describe('Phase 20 · custom roles', () => {
  it('creates a Cashier that can take orders but nothing else', async () => {
    const {token} = await withRole({
      key: 'cashier', name: 'Cashier',
      permissions: ['orders.view', 'orders.create', 'payments.take', 'menu.view']
    });

    // Has the permission.
    const order = await request('/api/orders', {
      method: 'POST', token,
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(order.status, 201);

    // Lacks the rest, even though the base role is `staff` and several of
    // these endpoints admit staff.
    for (const [path, options] of [
      ['/api/inventory/adjustments', {
        method: 'POST', headers: {'Idempotency-Key': 'cashier-try'},
        body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: -5, reason: 'nope'}
      }],
      ['/api/waste/record', {
        method: 'POST',
        body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: 1, reason: 'spoiled'}
      }],
      ['/api/reports/pnl', {}]
    ]) {
      const res = await request(path, {token, ...options});
      assert.equal(res.status, 403, `${path} must refuse a cashier`);
    }
  });

  it('does NOT inherit the base role bundle', async () => {
    // The trap this design exists to avoid: a Cashier built on `staff` must
    // not receive every staff permission. `inventory.count` is a staff
    // permission the Cashier was not granted.
    const {token} = await withRole({
      key: 'cashier2', name: 'Cashier Two', permissions: ['orders.view', 'orders.create']
    });
    const res = await request('/api/stock-counts', {
      method: 'POST', token, headers: {'Idempotency-Key': 'cashier-count'},
      body: {branch: String(world.branchA._id), scope: 'full', notes: 'cashier attempt'}
    });
    assert.equal(res.status, 403);

    // Control: a plain staff account, which DOES hold inventory.count,
    // succeeds on the same call. Without this the assertion above could be
    // passing because the request is malformed.
    const control = await request('/api/stock-counts', {
      method: 'POST', token: staff(), headers: {'Idempotency-Key': 'staff-count'},
      body: {branch: String(world.branchA._id), scope: 'full', notes: 'staff baseline'}
    });
    assert.equal(control.status, 201, JSON.stringify(control.body));
  });

  it('fails closed on endpoints that still carry only a legacy role list', async () => {
    // A custom role is admitted ONLY through requirePermission(). An endpoint
    // still guarded by a bare role list has not been classified, so it refuses
    // custom roles rather than letting them in on their base role. The
    // conservative direction: too little access is visible and reportable,
    // too much is a breach.
    const {token} = await withRole({
      key: 'storekeeper', name: 'Storekeeper',
      permissions: ['inventory.view', 'inventory.count', 'inventory.adjust']
    });
    // `/api/tables` is auth(['owner','manager','staff']) — no permission yet.
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token})).status, 403);
    // But a classified endpoint they DO hold works.
    const adjust = await request('/api/inventory/adjustments', {
      method: 'POST', token, headers: {'Idempotency-Key': 'store-adjust'},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: 25, reason: 'storekeeper receipt'
      }
    });
    assert.equal(adjust.status, 201, JSON.stringify(adjust.body));
  });

  it('ends the session when the holder\'s role is deleted or switched off', async () => {
    const {token, user} = await withRole({
      key: 'kitchen', name: 'Kitchen', permissions: ['kds.view', 'orders.view']
    });
    assert.equal((await request('/api/me/permissions', {token})).status, 200);

    // Switching the role off must not fall back to the base role's full
    // bundle — that would WIDEN access at the moment access was withdrawn.
    await Role.updateOne({restaurant: world.restaurant._id, key: 'kitchen'}, {$set: {active: false}});
    const res = await request('/api/me/permissions', {token});
    assert.equal(res.status, 401);
    assert.match(res.body.message, /no longer available/i);

    await Role.deleteOne({restaurant: world.restaurant._id, key: 'kitchen'});
    assert.equal((await request('/api/me/permissions', {token})).status, 401);
    assert.ok(user);
  });

  it('resolves a role only inside the holder\'s own restaurant', async () => {
    // A role key must not be borrowed across tenants.
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVL'});
    await Role.create({
      restaurant: rival._id, key: 'superuser', name: 'Super',
      baseRole: 'staff', permissions: [...ALL_PERMISSIONS]
    });
    const intruder = await User.create({
      name: 'Intruder', email: 'intruder@test.com', password: 'x', role: 'staff',
      roleKey: 'superuser', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    // The role exists, but not in THIS restaurant, so it must not resolve.
    const res = await request('/api/me/permissions', {token: tokenFor(intruder)});
    assert.equal(res.status, 401);
    assert.ok(rivalBranch);
  });

  it('refuses a custom role whose base role disagrees with the user record', async () => {
    // Defence in depth against an out-of-band write to either field.
    await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {key: 'drift', name: 'Drift', baseRole: 'staff', permissions: ['orders.view']}
    });
    const user = await User.create({
      name: 'Drifted', email: 'drift@test.com', password: 'x',
      role: 'manager', roleKey: 'drift',
      restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    assert.equal((await request('/api/me/permissions', {token: tokenFor(user)})).status, 401);
  });
});

// ── role administration ──────────────────────────────────────────────────────

describe('Phase 20 · role administration', () => {
  it('lists built-in and custom roles with assignment counts', async () => {
    await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.create']});
    const res = await request('/api/roles', {token: owner()});
    assert.equal(res.status, 200);

    const byKey = Object.fromEntries(res.body.roles.map(role => [role.key, role]));
    assert.equal(byKey.owner.builtin, true);
    assert.equal(byKey.owner.unrestricted, true);
    assert.equal(byKey.cashier.builtin, false);
    assert.equal(byKey.cashier.assignedCount, 1);
    // seedWorld makes one manager and two staff.
    assert.equal(byKey.manager.assignedCount, 1);
    assert.equal(byKey.staff.assignedCount, 2);
    assert.ok(res.body.permissions.length > 0);
    assert.ok(res.body.templates.some(template => template.key === 'cashier'));
  });

  it('refuses to modify or delete a built-in role', async () => {
    // The built-ins are the floor the system is tested against and the last
    // resort when a tenant breaks its own roles.
    for (const key of ['owner', 'manager', 'staff', 'rider']) {
      assert.equal((await request(`/api/roles/${key}`, {
        method: 'PATCH', token: owner(), body: {permissions: []}
      })).status, 403, `${key} must not be editable`);
      assert.equal((await request(`/api/roles/${key}`, {
        method: 'DELETE', token: owner()
      })).status, 403, `${key} must not be deletable`);
    }
    // And a custom role cannot shadow a built-in key.
    const clash = await request('/api/roles', {
      method: 'POST', token: owner(), body: {key: 'manager', name: 'Fake Manager'}
    });
    assert.equal(clash.status, 409);
  });

  it('refuses an owner-based custom role', async () => {
    // An owner-based role would hold every permission implicitly, which is
    // exactly the escalation this module exists to prevent.
    //
    // DEFENCE IN DEPTH, verified. Two layers refuse this: the zod enum on the
    // route and the explicit whitelist in createRole(). Removing either alone
    // leaves this test green; removing BOTH was confirmed to fail it. The
    // service check is kept because createRole() is callable from a script or
    // a future route that has no zod schema in front of it.
    const res = await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {key: 'shadow', name: 'Shadow', baseRole: 'owner', permissions: []}
    });
    assert.equal(res.status, 400);

    // The service must refuse it directly, not only behind the route schema.
    const {createRole} = await import('../src/services/roles.js');
    await assert.rejects(
      () => createRole({
        user: {id: world.owner._id, role: 'owner'},
        principal: {baseRole: 'owner', permissions: new Set()},
        input: {key: 'shadow2', name: 'Shadow Two', baseRole: 'owner', permissions: []}
      }),
      /Base role must be manager, staff or rider/
    );
  });

  it('refuses unknown permissions and duplicate keys', async () => {
    const bad = await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {key: 'bogus', name: 'Bogus', permissions: ['orders.teleport']}
    });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /Unknown permission/);

    await withRole({key: 'dupe', name: 'Dupe', permissions: ['orders.view']});
    const again = await request('/api/roles', {
      method: 'POST', token: owner(), body: {key: 'dupe', name: 'Dupe Again'}
    });
    assert.equal(again.status, 409);
  });

  it('will not delete or deactivate a role somebody still holds', async () => {
    const {user} = await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.create']});
    const deletion = await request('/api/roles/cashier', {method: 'DELETE', token: owner()});
    assert.equal(deletion.status, 409);
    assert.match(deletion.body.message, /still hold this role/);

    const deactivation = await request('/api/roles/cashier', {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.equal(deactivation.status, 409);

    // Once reassigned, it can go.
    await request(`/api/users/${user._id}/role`, {
      method: 'PATCH', token: owner(), body: {role: 'staff'}
    });
    assert.equal((await request('/api/roles/cashier', {method: 'DELETE', token: owner()})).status, 200);
  });

  it('will not let a role change its base role after creation', async () => {
    // Changing it would silently move every holder between tenancy regimes
    // with no per-user audit of who was affected.
    await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.create']});
    const res = await request('/api/roles/cashier', {
      method: 'PATCH', token: owner(), body: {baseRole: 'manager'}
    });
    assert.equal(res.status, 409);
  });

  it('edits permissions on a custom role and the change applies at once', async () => {
    const {token} = await withRole({
      key: 'storekeeper', name: 'Storekeeper', permissions: ['inventory.view']
    });
    const before = await request('/api/waste/record', {
      method: 'POST', token, headers: {'Idempotency-Key': 'store-waste-before'},
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: 1, reason: 'spoiled'}
    });
    assert.equal(before.status, 403);

    await request('/api/roles/storekeeper', {
      method: 'PATCH', token: owner(),
      body: {permissions: ['inventory.view', 'inventory.waste']}
    });

    // No re-login: permissions resolve from storage on every request.
    const after = await request('/api/waste/record', {
      method: 'POST', token, headers: {'Idempotency-Key': 'store-waste-after'},
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: 1, reason: 'spoiled'}
    });
    assert.equal(after.status, 201, JSON.stringify(after.body));
  });
});

// ── privilege escalation ─────────────────────────────────────────────────────

describe('Phase 20 · privilege escalation', () => {
  it('stops a delegated administrator granting more than they hold', async () => {
    // A manager given users.manage/roles.manage must not be able to mint
    // "Manager Plus" holding monthclose.manage and assign it to themselves.
    const {token} = await withRole({
      key: 'hradmin', name: 'HR Admin', baseRole: 'manager',
      permissions: ['users.manage', 'roles.manage', 'orders.view']
    });
    const escalate = await request('/api/roles', {
      method: 'POST', token,
      body: {key: 'superplus', name: 'Super Plus', permissions: ['monthclose.manage', 'orders.view']}
    });
    assert.equal(escalate.status, 403);
    assert.match(escalate.body.message, /cannot grant permissions you do not hold/i);

    // Control: granting a subset they DO hold is allowed, so the refusal is
    // about escalation and not a blanket denial.
    const allowed = await request('/api/roles', {
      method: 'POST', token, body: {key: 'viewer', name: 'Viewer', permissions: ['orders.view']}
    });
    assert.equal(allowed.status, 201);
  });

  it('stops a delegated administrator assigning a stronger role', async () => {
    await withRole({
      key: 'powerful', name: 'Powerful', baseRole: 'manager',
      permissions: ['monthclose.manage', 'orders.refund'], email: 'powerful@test.com'
    });
    const {token} = await withRole({
      key: 'hradmin', name: 'HR Admin', baseRole: 'manager',
      permissions: ['users.manage', 'orders.view'], email: 'hr@test.com'
    });
    const target = await User.findOne({email: 'staffa@test.com'});
    const res = await request(`/api/users/${target._id}/role`, {
      method: 'PATCH', token, body: {role: 'powerful'}
    });
    assert.equal(res.status, 403);
  });

  it('never mints an owner through role assignment', async () => {
    const target = await User.findOne({email: 'staffa@test.com'});
    const res = await request(`/api/users/${target._id}/role`, {
      method: 'PATCH', token: owner(), body: {role: 'owner'}
    });
    assert.equal(res.status, 403);
    assert.equal((await User.findById(target._id)).role, 'staff');
  });

  it('will not demote the last owner', async () => {
    const res = await request(`/api/users/${world.owner._id}/role`, {
      method: 'PATCH', token: owner(), body: {role: 'manager'}
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /last owner/i);
  });

  it('refuses role administration to those without the permission', async () => {
    for (const token of [manager(), staff()]) {
      assert.equal((await request('/api/roles', {
        method: 'POST', token, body: {key: 'x', name: 'Ex'}
      })).status, 403);
      assert.equal((await request('/api/permissions', {token})).status, 403);
    }
    // A manager holds users.manage, so the roster is readable...
    assert.equal((await request('/api/roles', {token: manager()})).status, 200);
    // ...but staff hold neither.
    assert.equal((await request('/api/roles', {token: staff()})).status, 403);
  });

  it('cannot be reached without authentication', async () => {
    for (const path of ['/api/roles', '/api/permissions', '/api/me/permissions', '/api/rbac/audit']) {
      assert.equal((await request(path)).status, 401, `${path} must require a token`);
    }
  });
});

// ── branch assignment ────────────────────────────────────────────────────────

describe('Phase 20 · branch assignment', () => {
  it('moves a user to another branch and the new scope takes effect', async () => {
    const target = await User.findOne({email: 'staffa@test.com'});
    const res = await request(`/api/users/${target._id}/role`, {
      method: 'PATCH', token: owner(), body: {branch: String(world.branchB._id)}
    });
    assert.equal(res.status, 200);
    assert.equal(String(res.body.branch), String(world.branchB._id));

    // The moved user now sees branch B and is refused branch A.
    const moved = tokenFor(await User.findById(target._id));
    assert.equal((await request(`/api/tables?branch=${world.branchB._id}`, {token: moved})).status, 200);
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token: moved})).status, 403);
  });

  it('refuses a branch from another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'R', code: 'RVL'});
    const target = await User.findOne({email: 'staffa@test.com'});
    assert.equal((await request(`/api/users/${target._id}/role`, {
      method: 'PATCH', token: owner(), body: {branch: String(rivalBranch._id)}
    })).status, 404);
  });

  it('refuses to leave a non-owner without a branch', async () => {
    const target = await User.findOne({email: 'staffa@test.com'});
    const res = await request(`/api/users/${target._id}/role`, {
      method: 'PATCH', token: owner(), body: {branch: null}
    });
    assert.equal(res.status, 400);
  });

  it('will not touch a user in another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const outsider = await User.create({
      name: 'Outsider', email: 'outsider@test.com', password: 'x',
      role: 'staff', restaurantId: rival._id
    });
    assert.equal((await request(`/api/users/${outsider._id}/role`, {
      method: 'PATCH', token: owner(), body: {role: 'manager'}
    })).status, 404);
  });
});

// ── audit ────────────────────────────────────────────────────────────────────

describe('Phase 20 · audit logging', () => {
  it('records role creation, edits, deletion and assignment', async () => {
    const {user} = await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    await request('/api/roles/cashier', {
      method: 'PATCH', token: owner(), body: {permissions: ['orders.view', 'orders.create']}
    });
    await request(`/api/users/${user._id}/role`, {
      method: 'PATCH', token: owner(), body: {role: 'staff'}
    });
    await request('/api/roles/cashier', {method: 'DELETE', token: owner()});

    const actions = (await Audit.find({entity: {$in: ['role', 'user']}}).lean()).map(row => row.action);
    for (const action of ['role_created', 'role_updated', 'user_role_assigned', 'role_deleted']) {
      assert.ok(actions.includes(action), `missing audit action ${action}`);
    }

    // The edit must record what actually changed, both sides.
    const edit = await Audit.findOne({action: 'role_updated'}).lean();
    assert.deepEqual(edit.before.permissions, ['orders.view']);
    assert.deepEqual(edit.after.permissions, ['orders.create', 'orders.view']);
    assert.equal(String(edit.user), String(world.owner._id));
  });

  it('serves the access-control trail, newest first, scoped to the tenant', async () => {
    await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    const res = await request('/api/rbac/audit', {token: owner()});
    assert.equal(res.status, 200);
    assert.ok(res.body.events.length >= 1);
    assert.equal(res.body.events[0].action, 'role_created');
    // The actor is resolved, so the trail names a person rather than an id.
    assert.equal(res.body.events[0].user.email, 'owner@test.com');
  });
});

// ── self description ─────────────────────────────────────────────────────────

describe('Phase 20 · /me/permissions', () => {
  it('tells an owner they are unrestricted', async () => {
    const res = await request('/api/me/permissions', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.unrestricted, true);
    assert.equal(res.body.permissions.length, ALL_PERMISSIONS.length);
  });

  it('reports a custom role by name with its exact permissions', async () => {
    const {token} = await withRole({
      key: 'cashier', name: 'Cashier', permissions: ['orders.create', 'orders.view']
    });
    const res = await request('/api/me/permissions', {token});
    assert.equal(res.body.roleName, 'Cashier');
    assert.equal(res.body.custom, true);
    assert.equal(res.body.role, 'staff');
    assert.deepEqual(res.body.permissions, ['orders.create', 'orders.view']);
  });

  it('is readable by every principal including a rider', async () => {
    // A rider must be able to learn what they may do; it discloses nothing
    // they could not find by trying an endpoint.
    const rider = await User.create({
      name: 'Rider', email: 'rider20@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true}
    });
    const res = await request('/api/me/permissions', {token: tokenFor(rider)});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.permissions, ['deliveries.ride']);
  });

  it('ends the session for a rider stood down on the profile flag alone', async () => {
    // A rider carries TWO switches: the account-level `active` and the
    // embedded `rider.active` that dispatch uses. Standing a rider down
    // through the rider workspace sets only the second, so checking `active`
    // alone would leave their token live.
    //
    // DEFENCE IN DEPTH, verified: with the account-level check still in
    // place, removing the rider-profile check alone left this suite green
    // (the paths that matter also refuse elsewhere). Removing BOTH checks was
    // confirmed to fail. This test pins the rider-specific layer directly so
    // it can no longer be deleted silently.
    const rider = await User.create({
      name: 'Stood Down', email: 'stood@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      active: true, rider: {active: false, available: false}
    });
    const res = await request('/api/me/permissions', {token: tokenFor(rider)});
    assert.equal(res.status, 401, 'a stood-down rider must lose their session');
    assert.match(res.body.message, /deactivated/i);

    // Control: the same account with the profile flag on resolves fine, so
    // the refusal is that flag and not the account being malformed.
    await User.updateOne({_id: rider._id}, {$set: {'rider.active': true}});
    assert.equal((await request('/api/me/permissions', {token: tokenFor(rider)})).status, 200);
  });
});

// ── the guard itself ─────────────────────────────────────────────────────────

describe('Phase 20 · guard integrity', () => {
  it('resolves permissions from the database, never from the token', async () => {
    // A forged token claiming extra permissions must gain nothing: the guard
    // reads storage. This is the property the whole phase rests on.
    const forged = jwt.sign(
      {
        id: world.staffA._id, name: 'Staff A', role: 'staff',
        restaurantId: world.restaurant._id, branch: world.branchA._id,
        permissions: [...ALL_PERMISSIONS], roleKey: 'owner'
      },
      process.env.JWT_SECRET
    );
    assert.equal((await request('/api/reports/pnl', {token: forged})).status, 403);
    assert.equal((await request('/api/roles', {method: 'POST', token: forged, body: {key: 'x', name: 'Ex'}})).status, 403);

    const principal = await resolvePrincipal({id: world.staffA._id, role: 'staff'});
    assert.equal(principal.baseRole, 'staff');
    assert.ok(!principal.permissions.has('reports.view'));
  });

  it('has no bare auth() anywhere in the routes', async () => {
    // Pre-existing invariant: a bare auth() means "any authenticated
    // principal", which includes riders.
    const {readdir, readFile} = await import('node:fs/promises');
    const directory = new URL('../src/routes/', import.meta.url);
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.js')) continue;
      const source = await readFile(new URL(name, directory), 'utf8');
      assert.doesNotMatch(source, /[^a-zA-Z]auth\(\)/, `${name} must not use a bare auth()`);
    }
  });

  it('keeps every requirePermission argument a real permission', async () => {
    // A typo in a permission name would silently make an endpoint
    // unreachable by everyone except owners, who bypass the set entirely.
    const {readdir, readFile} = await import('node:fs/promises');
    const directory = new URL('../src/routes/', import.meta.url);
    let checked = 0;
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.js')) continue;
      const source = await readFile(new URL(name, directory), 'utf8');
      for (const match of source.matchAll(/requirePermission\(([^)]*)\)/g)) {
        for (const raw of match[1].split(',')) {
          const key = raw.trim().replace(/^['"]|['"]$/g, '');
          if (!key || key.includes('.map') || key.startsWith('...')) continue;
          assert.ok(ALL_PERMISSIONS.includes(key), `${name}: unknown permission ${key}`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 10, `expected several classified endpoints, saw ${checked}`);
  });

  it('leaves the built-in roles behaving exactly as before', async () => {
    // Regression net for the compatibility promise: no existing deployment
    // changes on the day this ships.
    assert.equal((await request('/api/reports/pnl', {token: manager()})).status, 200);
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token: staff()})).status, 200);
    assert.equal((await request('/api/reports/pnl', {token: staff()})).status, 403);
    const refund = await request('/api/orders/000000000000000000000000/refunds', {
      method: 'POST', token: staff(), body: {amount: 1, reason: 'test refund'}
    });
    assert.equal(refund.status, 403, 'staff must still not refund');
    assert.ok(BUILTIN_ROLES.owner);
  });
});
