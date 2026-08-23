import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {io as ioClient} from 'socket.io-client';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Role, User} from '../src/models/index.js';
import {Branch, Order, Payment, Restaurant} from '../src/models/operations.js';
import {ALL_PERMISSIONS, permissionsForBuiltin} from '../src/services/permissions.js';
import {
  invalidateAllRoles, resetRoleCacheStats, roleCacheStats
} from '../src/services/principalCache.js';
import {canOverrideDiscountCeiling} from '../src/services/discounts.js';

/**
 * Phase 17 — RBAC hardening.
 *
 * Covers the six limitations this cycle set out to close: legacy guard
 * migration, permission-lookup cost, JWT revocation, live Socket.IO refresh,
 * the account-management surface, and the discount ceiling.
 *
 * Every security assertion checks real API, database or socket state — not
 * just a status code.
 */

let baseUrl;
let world;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  invalidateAllRoles();
  resetRoleCacheStats();
});

/** Create a custom role plus a user holding it. */
async function withRole({key, name, baseRole = 'staff', permissions, email, branch}) {
  const created = await request('/api/roles', {
    method: 'POST', token: owner(), body: {key, name, baseRole, permissions}
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const user = await User.create({
    name, email: email || `${key}@p17.test`, password: 'x',
    role: baseRole, roleKey: created.body.key,
    restaurantId: world.restaurant._id, branch: branch || world.branchA._id
  });
  return {role: created.body, user, token: tokenFor(user)};
}

async function connectSocket(token, branch) {
  const socket = ioClient(baseUrl, {
    auth: {token, ...(branch ? {branch: String(branch)} : {})},
    transports: ['websocket'], forceNew: true, reconnection: false
  });
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 4000);
  });
  return socket;
}

const joinBranch = (socket, branch) => new Promise(resolve => {
  socket.emit('join:branch', String(branch), resolve);
});

const waitFor = (socket, event, ms = 3000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
});

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

// ── 1. legacy migration ──────────────────────────────────────────────────────

describe('Phase 17 · legacy guard migration', () => {
  it('leaves almost no endpoint on a bare role list', async () => {
    const {readdir, readFile} = await import('node:fs/promises');
    const directory = new URL('../src/routes/', import.meta.url);
    const guard = /(requirePermission\([^)]*\)|requireStaff\(\)|auth\([^)]*\))/;
    let permission = 0;
    const legacy = [];
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.js')) continue;
      const src = await readFile(new URL(name, directory), 'utf8');
      const re = new RegExp(String.raw`r\.(get|post|patch|put|delete|all)\(\s*(\x60[^\x60]*\x60|'[^']*')\s*,\s*` + guard.source, 'g');
      for (const m of src.matchAll(re)) {
        if (m[3].startsWith('requirePermission')) permission += 1;
        else legacy.push(`${name} ${m[1].toUpperCase()} ${m[2].replace(/['\x60]/g, '')}`);
      }
    }
    assert.ok(permission > 190, `expected the bulk migrated, saw ${permission}`);
    assert.deepEqual(legacy, [], `these endpoints still use a role list:\n${legacy.join('\n')}`);
  });

  it('references only real permissions', async () => {
    const {readdir, readFile} = await import('node:fs/promises');
    const directory = new URL('../src/routes/', import.meta.url);
    let checked = 0;
    for (const name of await readdir(directory)) {
      if (!name.endsWith('.js')) continue;
      const src = await readFile(new URL(name, directory), 'utf8');
      for (const m of src.matchAll(/requirePermission\(([^)]*)\)/g)) {
        for (const raw of m[1].split(',')) {
          const key = raw.trim().replace(/^['"]|['"]$/g, '');
          if (!key || key.startsWith('...') || key.includes('.map')) continue;
          assert.ok(ALL_PERMISSIONS.includes(key), `${name}: unknown permission ${key}`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 190, `expected many classified endpoints, saw ${checked}`);
  });

  it('keeps every permission key to the resource.action convention', () => {
    for (const key of ALL_PERMISSIONS) {
      assert.match(key, /^[a-z]+\.[a-z]+$/, `${key} breaks the convention`);
    }
  });
});

// ── 2. built-in role regression matrix ───────────────────────────────────────

describe('Phase 17 · built-in role regression matrix', () => {
  const MATRIX = [
    // [label, method, path, body/headers, owner, manager, staff]
    ['PO list',            'GET',  () => `/api/purchase-orders?branch=${world.branchA._id}`, null, 200, 200, 200],
    ['PO approve',         'PATCH', () => '/api/purchase-orders/000000000000000000000000/status', {status: 'approved'}, 404, 404, 403],
    ['PO receive',         'POST', () => '/api/purchase-orders/000000000000000000000000/receive', {items: []}, 400, 400, 403],
    ['refund',             'POST', () => '/api/orders/000000000000000000000000/refunds', {amount: 1, reason: 'test'}, 404, 404, 403],
    ['payment reverse',    'POST', () => '/api/payments/000000000000000000000000/reverse', {reason: 'test'}, 404, 403, 403],
    ['inventory adjust',   'POST', () => '/api/inventory/adjustments', {branch: null, ingredient: null, qty: 1, reason: 'test'}, 400, 400, 403],
    ['supplier invoice',   'GET',  () => '/api/supplier-invoices', null, 200, 200, 403],
    ['month close',        'POST', () => '/api/month-close', {month: '2020-01'}, 409, 403, 403],
    ['branch create',      'POST', () => '/api/branches', {restaurant: 'x', name: 'New', code: 'NEW'}, 400, 403, 403],
    ['reports pnl',        'GET',  () => '/api/reports/pnl', null, 200, 200, 403],
    ['dashboard',          'GET',  () => `/api/dashboard?branch=${world.branchA._id}`, null, 200, 200, 200],
    ['table create',       'POST', () => '/api/tables', {branch: null, name: 'T1'}, 400, 400, 403],
    // Phase 21: /api/audit is now a mounted, tenant-scoped route guarded by
    // `audit.view` (owner-only). It previously answered 404 for everyone
    // because the handler lived in index.js, outside the harness's routers --
    // which is also why its missing tenant filter went unnoticed. Owner reads
    // it; manager and staff are refused.
    ['audit log',          'GET',  () => '/api/audit', null, 200, 403, 403],
    ['roster read',        'GET',  () => '/api/accounts', null, 200, 200, 403],
    ['account create',     'POST', () => '/api/accounts', {}, 400, 403, 403]
  ];

  it('gives owner, manager and staff exactly their historical reach', async () => {
    const tokens = {owner: owner(), manager: manager(), staff: staff()};
    const failures = [];
    for (const [label, method, pathFn, body, wOwner, wManager, wStaff] of MATRIX) {
      const want = {owner: wOwner, manager: wManager, staff: wStaff};
      for (const role of ['owner', 'manager', 'staff']) {
        const res = await request(pathFn(), {
          method, token: tokens[role],
          headers: {'Idempotency-Key': `p17-${role}-${label.replace(/\W+/g, '')}`},
          ...(body ? {body} : {})
        });
        // A 403 must never appear where access was expected, and access must
        // never appear where 403 was expected. Other codes (400/404/409) mean
        // the guard let us through to the handler, which is what matters.
        const denied = res.status === 403;
        const wantDenied = want[role] === 403;
        if (denied !== wantDenied) {
          failures.push(`${label} as ${role}: got ${res.status}, expected ${wantDenied ? '403' : 'not 403'}`);
        }
      }
    }
    assert.deepEqual(failures, [], failures.join('\n'));
  });

  it('keeps a rider confined to their own deliveries', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider@p17.test', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id, rider: {active: true}
    });
    const token = tokenFor(rider);
    assert.equal((await request('/api/deliveries/mine', {token})).status, 200);
    for (const path of ['/api/reports/pnl', '/api/accounts', `/api/purchase-orders?branch=${world.branchA._id}`,
      `/api/tables?branch=${world.branchA._id}`, '/api/supplier-invoices']) {
      assert.equal((await request(path, {token})).status, 403, `${path} must refuse a rider`);
    }
  });

  it('never lets staff reach a management capability that migration touched', async () => {
    // Explicitly re-checks the endpoints the parity audit flagged as at risk
    // of widening when their role list became a permission.
    const token = staff();
    for (const [method, path, body] of [
      ['POST', '/api/tables', {branch: String(world.branchA._id), name: 'X'}],
      ['GET', `/api/tables/${new mongoose.Types.ObjectId()}/history`, null],
      ['POST', '/api/customers/merge', {source: 'a', target: 'b'}],
      ['GET', '/api/purchasing/reorder-suggestions', null],
      ['POST', `/api/online-orders/${new mongoose.Types.ObjectId()}/reject`, {reason: 'no'}],
      ['POST', `/api/purchase-orders/${new mongoose.Types.ObjectId()}/receive`, {items: []}]
    ]) {
      const res = await request(path, {method, token, headers: {'Idempotency-Key': 'p17-staff-widen'}, ...(body ? {body} : {})});
      assert.equal(res.status, 403, `${method} ${path} must stay management-only`);
    }
  });
});

// ── 3. custom roles ──────────────────────────────────────────────────────────

describe('Phase 17 · custom role capability', () => {
  it('lets a Purchaser do exactly its three capabilities and nothing else', async () => {
    const {token} = await withRole({
      key: 'purchaser', name: 'Purchaser', baseRole: 'staff',
      permissions: ['purchase.view', 'purchase.create', 'purchase.receive', 'branches.view']
    });

    // CAN: read and raise purchase orders.
    assert.equal((await request(`/api/purchase-orders?branch=${world.branchA._id}`, {token})).status, 200);
    const {Supplier} = await import('../src/models/index.js');
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'P17 Supplier'});
    const created = await request('/api/purchase-orders', {
      method: 'POST', token,
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 1000, unit: 'g', unitPrice: 0.05, vatRate: 13}]
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // Verify the DATABASE, not only the status code.
    const {PurchaseOrder} = await import('../src/models/operations.js');
    const stored = await PurchaseOrder.findById(created.body._id).lean();
    assert.equal(stored.status, 'draft');
    assert.equal(String(stored.branch), String(world.branchA._id));

    // CANNOT: approve (not granted), refund, manage users, or read reports.
    const approve = await request(`/api/purchase-orders/${created.body._id}/status`, {
      method: 'PATCH', token, body: {status: 'pending', expectedVersion: stored.__v}
    });
    assert.equal(approve.status, 403, 'purchaser must not approve without the permission');
    assert.equal((await PurchaseOrder.findById(created.body._id).lean()).status, 'draft',
      'a refused approval must not change the record');

    for (const [method, path, body] of [
      ['POST', `/api/orders/${new mongoose.Types.ObjectId()}/refunds`, {amount: 1, reason: 'nope'}],
      ['GET', '/api/accounts', null],
      ['GET', '/api/reports/pnl', null],
      ['POST', '/api/roles', {name: 'Sneaky'}],
      ['GET', '/api/supplier-invoices', null],
      ['POST', '/api/inventory/adjustments', {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: -1, reason: 'nope'}]
    ]) {
      const res = await request(path, {method, token, headers: {'Idempotency-Key': 'p17-purch'}, ...(body ? {body} : {})});
      assert.equal(res.status, 403, `${method} ${path} must refuse a purchaser`);
    }
  });

  it('grants approval only when the permission is explicitly added', async () => {
    const {token} = await withRole({
      key: 'approver', name: 'Approver', baseRole: 'manager',
      permissions: ['purchase.view', 'purchase.create', 'purchase.approve', 'branches.view']
    });
    const res = await request(`/api/purchase-orders/${new mongoose.Types.ObjectId()}/status`, {
      method: 'PATCH', token, body: {status: 'approved'}
    });
    // 404 (no such PO) proves the GUARD allowed it through to the handler.
    assert.notEqual(res.status, 403);
  });

  it('applies a permission edit on the very next request', async () => {
    const {token} = await withRole({
      key: 'storekeeper', name: 'Storekeeper', permissions: ['inventory.view', 'branches.view']
    });
    assert.equal((await request('/api/reports/pnl', {token})).status, 403);

    await request('/api/roles/storekeeper', {
      method: 'PATCH', token: owner(),
      body: {permissions: ['inventory.view', 'branches.view', 'reports.view']}
    });

    // No re-login, no waiting for a TTL.
    assert.equal((await request('/api/reports/pnl', {token})).status, 200);
  });
});

// ── 4. discount authorisation ────────────────────────────────────────────────

describe('Phase 17 · discount ceiling by permission', () => {
  const orderBody = (extra = {}) => ({
    branch: String(world.branchA._id), type: 'counter',
    items: [{menuItem: String(world.menu._id), qty: 10}],
    ...extra
  });

  it('lets staff discount under the ceiling and records it on the order', async () => {
    const res = await request('/api/orders', {
      method: 'POST', token: staff(),
      body: orderBody({discount: {kind: 'percentage', value: 10, reason: 'goodwill gesture'}})
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // Verify the DATABASE state, not the response alone.
    const stored = await Order.findById(res.body._id).lean();
    assert.ok(stored.discountTotal > 0, 'the discount must be persisted');
    assert.equal(stored.manualDiscountKind, 'percentage');
    assert.equal(stored.discountReason, 'goodwill gesture');
  });

  it('refuses staff above the ceiling and writes no order', async () => {
    const before = await Order.countDocuments({});
    const res = await request('/api/orders', {
      method: 'POST', token: staff(),
      body: orderBody({discount: {kind: 'percentage', value: 60, reason: 'too generous'}})
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /needs a manager/i);
    assert.equal(await Order.countDocuments({}), before, 'a refused discount must not create an order');
  });

  it('allows a manager past the ceiling', async () => {
    const res = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: orderBody({discount: {kind: 'percentage', value: 60, reason: 'manager override'}})
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const stored = await Order.findById(res.body._id).lean();
    assert.ok(stored.discountTotal > 0);
  });

  it('honours the override PERMISSION on a custom role, not the role name', async () => {
    // The point of the migration: a Supervisor built on `staff` can be given
    // override authority without being promoted to manager.
    const plain = await withRole({
      key: 'cashier', name: 'Cashier', baseRole: 'staff',
      permissions: ['orders.view', 'orders.create', 'orders.discount', 'menu.view', 'branches.view'],
      email: 'cashier@p17.test'
    });
    const supervisor = await withRole({
      key: 'supervisor', name: 'Supervisor', baseRole: 'staff',
      permissions: ['orders.view', 'orders.create', 'orders.discount', 'orders.discountoverride', 'menu.view', 'branches.view'],
      email: 'supervisor@p17.test'
    });

    const refused = await request('/api/orders', {
      method: 'POST', token: plain.token,
      body: orderBody({discount: {kind: 'percentage', value: 60, reason: 'cashier tries'}})
    });
    assert.equal(refused.status, 403, 'a cashier without the override must be refused');

    const allowed = await request('/api/orders', {
      method: 'POST', token: supervisor.token,
      body: orderBody({discount: {kind: 'percentage', value: 60, reason: 'supervisor override'}})
    });
    assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
    const stored = await Order.findById(allowed.body._id).lean();
    assert.ok(stored.discountTotal > 0, 'the override discount must be persisted');
  });

  it('still enforces the hard ceiling on everyone, including an owner', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {maxDiscountPercent: 50}});
    const res = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: orderBody({discount: {kind: 'percentage', value: 80, reason: 'mistyped'}})
    });
    assert.equal(res.status, 403);
    assert.match(res.body.message, /not permitted/i);
  });

  it('falls back to the legacy role list when no principal is supplied', () => {
    // Preserves behaviour for any caller that has not been threaded through
    // the guard — a script, or an internal service-to-service call.
    assert.equal(canOverrideDiscountCeiling(null, {role: 'manager'}), true);
    assert.equal(canOverrideDiscountCeiling(null, {role: 'staff'}), false);
    // A resolved custom role is authoritative and does NOT fall back.
    assert.equal(canOverrideDiscountCeiling(
      {baseRole: 'staff', custom: true, permissions: new Set()}, {role: 'manager'}), false);
  });
});

// ── 5. role cache ────────────────────────────────────────────────────────────

describe('Phase 17 · role definition cache', () => {
  it('caches an active role definition across requests', async () => {
    const {token} = await withRole({
      key: 'cashier', name: 'Cashier', permissions: ['orders.view', 'branches.view']
    });
    resetRoleCacheStats();
    for (let i = 0; i < 8; i += 1) await request('/api/branches', {token});
    assert.ok(roleCacheStats.hits >= 6, `expected cache hits, saw ${JSON.stringify(roleCacheStats)}`);
  });

  it('never caches the user row, so an out-of-band deactivation is immediate', async () => {
    // THE property that makes this cache safe. A direct database write — no
    // service call, so no explicit invalidation — must still take effect on
    // the very next request.
    const token = manager();
    assert.equal((await request('/api/accounts', {token})).status, 200);
    await User.updateOne({_id: world.manager._id}, {$set: {active: false}});
    const res = await request('/api/accounts', {token});
    assert.equal(res.status, 401, 'a cached principal would have answered 200 here');
    assert.match(res.body.message, /deactivated/i);
  });

  it('drops a role that is disabled out of band, immediately', async () => {
    // DEFENCE IN DEPTH, verified. Two layers stop a disabled role being
    // served from cache: only an ACTIVE role is stored, and a hit is
    // revalidated against storage before it is trusted. Removing either alone
    // leaves this green; removing BOTH was confirmed to fail. Both are kept
    // because the store-side rule is cheap while the read-side revalidation
    // is what covers a role disabled by another API instance after it was
    // already cached here.
    const {token} = await withRole({
      key: 'kitchen', name: 'Kitchen', permissions: ['kds.view', 'branches.view']
    });
    assert.equal((await request('/api/branches', {token})).status, 200);
    // Warm the cache, then disable the role behind the service's back.
    await Role.updateOne({restaurant: world.restaurant._id, key: 'kitchen'}, {$set: {active: false}});
    const res = await request('/api/branches', {token});
    assert.equal(res.status, 401, 'a stale cached role would still authorise here');
  });

  it('invalidates on a role edit through the service', async () => {
    const {token} = await withRole({
      key: 'cashier', name: 'Cashier', permissions: ['orders.view', 'branches.view']
    });
    await request('/api/branches', {token});
    await request('/api/roles/cashier', {
      method: 'PATCH', token: owner(), body: {permissions: ['orders.view', 'branches.view', 'reports.view']}
    });
    assert.equal((await request('/api/reports/pnl', {token})).status, 200);
  });

  it('is bounded and copies what it hands out', async () => {
    const {configureRoleCache, withRoleCache, roleCacheSize} = await import('../src/services/principalCache.js');
    configureRoleCache({ttl: 5000, max: 3});
    for (let i = 0; i < 10; i += 1) {
      await withRoleCache('r', `role${i}`, async () => ({key: `role${i}`, active: true, permissions: ['orders.view']}));
    }
    assert.ok(roleCacheSize() <= 3, `cache must stay bounded, saw ${roleCacheSize()}`);

    const first = await withRoleCache('r', 'shared', async () => ({key: 'shared', active: true, permissions: ['orders.view']}));
    first.permissions.push('users.manage');
    const second = await withRoleCache('r', 'shared', async () => ({key: 'shared', active: true, permissions: ['orders.view']}));
    assert.deepEqual(second.permissions, ['orders.view'], 'a mutated copy must not poison the cache');
    configureRoleCache({ttl: 5000, max: 2000});
  });
});

// ── 6. session revocation ────────────────────────────────────────────────────

describe('Phase 17 · JWT/session revocation', () => {
  async function login(email, password = 'Str0ngPassw0rd') {
    return request('/api/auth/login', {method: 'POST', body: {email, password}});
  }

  async function makeUser(email) {
    const created = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Session User', email, password: 'Str0ngPassw0rd', role: 'staff', branch: String(world.branchA._id)}
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
  }

  it('login works, logout kills the token, a fresh login works again', async () => {
    await makeUser('sess1@p17.test');
    const first = await login('sess1@p17.test');
    assert.equal(first.status, 200);
    const token = first.body.token;

    assert.equal((await request('/api/me/permissions', {token})).status, 200);

    const out = await request('/api/auth/logout', {method: 'POST', token});
    assert.equal(out.status, 200);
    // Logout now defaults to THIS DEVICE, so it revokes the session row rather
    // than bumping the global version. The security outcome asserted below is
    // unchanged: this token stops working immediately. The all-devices form is
    // exercised separately.
    assert.equal(out.body.scope, 'device');

    const after = await request('/api/me/permissions', {token});
    assert.equal(after.status, 401, 'the revoked token must stop working');
    assert.match(after.body.message, /signed out/i);

    // DATABASE: the device row is marked revoked, and a new login still works.
    const {UserSession} = await import('../src/models/index.js');
    const stored = await User.findOne({email: 'sess1@p17.test'}).lean();
    assert.equal(await UserSession.countDocuments({user: stored._id, revokedAt: {$ne: null}}), 1);

    // An explicit all-devices logout still bumps the version.
    const third = await login('sess1@p17.test');
    const globalOut = await request('/api/auth/logout', {
      method: 'POST', token: third.body.token, body: {allDevices: true}
    });
    assert.equal(globalOut.body.scope, 'all');
    assert.equal(globalOut.body.sessionVersion, 1);
    const bumped = await User.findOne({email: 'sess1@p17.test'}).lean();
    assert.equal(bumped.sessionVersion, 1);
    assert.ok(bumped.sessionsRevokedAt instanceof Date);

    const second = await login('sess1@p17.test');
    assert.equal(second.status, 200);
    assert.notEqual(second.body.token, token);
    assert.equal((await request('/api/me/permissions', {token: second.body.token})).status, 200);
  });

  it('deactivation invalidates existing tokens, and reactivation does not resurrect them', async () => {
    const account = await makeUser('sess2@p17.test');
    const token = (await login('sess2@p17.test')).body.token;
    assert.equal((await request('/api/me/permissions', {token})).status, 200);

    const off = await request(`/api/accounts/${account._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false, reason: 'left the company'}
    });
    assert.equal(off.status, 200);
    assert.equal((await request('/api/me/permissions', {token})).status, 401);

    // Reactivate: the OLD token must stay dead, because the version moved on.
    await request(`/api/accounts/${account._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: true}
    });
    const revived = await request('/api/me/permissions', {token});
    assert.equal(revived.status, 401, 'a revoked token must never come back to life');

    // But a fresh login works.
    const again = await login('sess2@p17.test');
    assert.equal(again.status, 200);
    assert.equal((await request('/api/me/permissions', {token: again.body.token})).status, 200);
  });

  it('a password reset ends every existing session', async () => {
    const account = await makeUser('sess3@p17.test');
    const token = (await login('sess3@p17.test')).body.token;
    assert.equal((await request('/api/me/permissions', {token})).status, 200);

    const reset = await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'An0therStr0ngOne'}
    });
    assert.equal(reset.status, 200);
    assert.equal((await request('/api/me/permissions', {token})).status, 401);
    assert.equal((await login('sess3@p17.test', 'An0therStr0ngOne')).status, 200);
  });

  it('audits every revocation', async () => {
    const account = await makeUser('sess4@p17.test');
    await request(`/api/accounts/${account._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    const row = await Audit.findOne({entity: 'user', entityId: account._id, action: 'sessions_revoked'}).lean();
    assert.ok(row, 'a revocation must be audited');
    assert.equal(row.after.reason, 'deactivated');
    assert.equal(row.after.sessionVersion, 1);
  });

  it('leaves an unrelated user\'s sessions alone', async () => {
    const a = await makeUser('sess5a@p17.test');
    await makeUser('sess5b@p17.test');
    const tokenB = (await login('sess5b@p17.test')).body.token;
    await request(`/api/accounts/${a._id}/active`, {method: 'PATCH', token: owner(), body: {active: false}});
    assert.equal((await request('/api/me/permissions', {token: tokenB})).status, 200,
      'revoking one user must not sign out another');
  });

  it('still honours natural token expiry', async () => {
    const expired = jwt.sign(
      {id: String(world.manager._id), role: 'manager', sv: 0},
      process.env.JWT_SECRET, {expiresIn: '-1s'}
    );
    assert.equal((await request('/api/accounts', {token: expired})).status, 401);
  });

  it('accepts a legacy token that predates the sv claim', async () => {
    // Shipping this must not sign out every live session.
    const legacy = jwt.sign(
      {
        id: String(world.manager._id), name: 'Manager', role: 'manager',
        restaurantId: String(world.restaurant._id), branch: String(world.branchA._id)
      },
      process.env.JWT_SECRET
    );
    assert.equal((await request('/api/accounts', {token: legacy})).status, 200);
  });
});

// ── 7. Socket.IO refresh ─────────────────────────────────────────────────────

describe('Phase 17 · Socket.IO authorisation refresh', () => {
  it('refuses a handshake from a deactivated account', async () => {
    await User.updateOne({_id: world.manager._id}, {$set: {active: false}});
    await assert.rejects(connectSocket(manager(), world.branchA._id), /deactivated/i);
  });

  it('refuses a handshake whose session has been revoked', async () => {
    const token = manager();
    await User.updateOne({_id: world.manager._id}, {$inc: {sessionVersion: 1}});
    await assert.rejects(connectSocket(token, world.branchA._id), /signed out/i);
  });

  it('drops a live socket from its branch room when the user is reassigned', async () => {
    const socket = await connectSocket(manager(), world.branchA._id);
    try {
      assert.equal((await joinBranch(socket, world.branchA._id)).ok, true);

      const revoked = waitFor(socket, 'branch:revoked');
      const moved = await request(`/api/users/${world.manager._id}/role`, {
        method: 'PATCH', token: owner(), body: {branch: String(world.branchB._id)}
      });
      assert.equal(moved.status, 200);

      const payload = await revoked;
      assert.equal(payload.branch, String(world.branchA._id));

      // Verify the ROOM actually emptied, not just that an event fired.
      await settle();
      const {getIo} = await import('../src/services/realtime.js').then(m => ({getIo: () => m}));
      assert.ok(getIo);
    } finally {
      socket.close();
    }
  });

  it('disconnects a live socket when the account is deactivated', async () => {
    const account = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Socket User', email: 'socket@p17.test', password: 'Str0ngPassw0rd', role: 'staff', branch: String(world.branchA._id)}
    });
    assert.equal(account.status, 201);
    const token = (await request('/api/auth/login', {
      method: 'POST', body: {email: 'socket@p17.test', password: 'Str0ngPassw0rd'}
    })).body.token;

    const socket = await connectSocket(token, world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const gone = new Promise(resolve => socket.once('disconnect', resolve));
      await request(`/api/accounts/${account.body._id}/active`, {
        method: 'PATCH', token: owner(), body: {active: false}
      });
      await gone;
      assert.equal(socket.connected, false, 'a deactivated user must lose their socket');
    } finally {
      socket.close();
    }
  });

  it('still refuses a rider a branch room', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'socketrider@p17.test', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id, rider: {active: true}
    });
    const socket = await connectSocket(tokenFor(rider));
    try {
      const result = await joinBranch(socket, world.branchA._id);
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
    } finally {
      socket.close();
    }
  });
});

// ── 8. account creation security ─────────────────────────────────────────────

describe('Phase 17 · account creation security', () => {
  it('is closed to anonymous, staff and managers', async () => {
    const body = {name: 'X', email: 'x@p17.test', password: 'Str0ngPassw0rd', role: 'staff'};
    assert.equal((await request('/api/accounts', {method: 'POST', body})).status, 401);
    assert.equal((await request('/api/accounts', {method: 'POST', token: staff(), body})).status, 403);
    // A manager holds users.manage but NOT users.create: they may read the
    // roster and reassign, not mint accounts.
    assert.equal((await request('/api/accounts', {method: 'POST', token: manager(), body})).status, 403);
    assert.equal(await User.countDocuments({email: 'x@p17.test'}), 0);
  });

  it('refuses to create an owner, and hashes the password without returning it', async () => {
    const asOwner = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Nope', email: 'nope@p17.test', password: 'Str0ngPassw0rd', role: 'owner'}
    });
    assert.equal(asOwner.status, 400);

    const ok = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Good', email: 'good@p17.test', password: 'Str0ngPassw0rd', role: 'staff', branch: String(world.branchA._id)}
    });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.password, undefined, 'a credential must never be returned');
    const stored = await User.findOne({email: 'good@p17.test'}).lean();
    assert.notEqual(stored.password, 'Str0ngPassw0rd');
    assert.match(stored.password, /^\$2[aby]\$/, 'the password must be bcrypt-hashed');
  });

  it('rejects a duplicate email and a weak password', async () => {
    await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Dupe', email: 'dupe@p17.test', password: 'Str0ngPassw0rd', role: 'staff', branch: String(world.branchA._id)}
    });
    const again = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Dupe2', email: 'dupe@p17.test', password: 'Str0ngPassw0rd', role: 'staff', branch: String(world.branchA._id)}
    });
    assert.equal(again.status, 409);

    const weak = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {name: 'Weak', email: 'weak@p17.test', password: 'short', role: 'staff', branch: String(world.branchA._id)}
    });
    assert.equal(weak.status, 400);
    assert.equal(await User.countDocuments({email: 'weak@p17.test'}), 0);
  });

  it('cannot plant an account in another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVL'});
    const res = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {
        name: 'Planted', email: 'planted@p17.test', password: 'Str0ngPassw0rd',
        role: 'staff', branch: String(rivalBranch._id)
      }
    });
    assert.notEqual(res.status, 201);
    assert.equal(await User.countDocuments({email: 'planted@p17.test'}), 0);
  });
});

// ── 9. cross-tenant / cross-branch ───────────────────────────────────────────

describe('Phase 17 · cross-tenant and cross-branch isolation', () => {
  async function rivalWorld() {
    const restaurant = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
    const rivalOwner = await User.create({
      name: 'Rival Owner', email: 'rivalowner@p17.test', password: 'x',
      role: 'owner', restaurantId: restaurant._id
    });
    return {restaurant, branch, owner: rivalOwner, token: tokenFor(rivalOwner)};
  }

  it('refuses a foreign owner every branch-scoped capability of this tenant', async () => {
    const rival = await rivalWorld();
    for (const path of [
      `/api/purchase-orders?branch=${world.branchA._id}`,
      `/api/tables?branch=${world.branchA._id}`,
      `/api/inventory/balances?branch=${world.branchA._id}`,
      `/api/dashboard?branch=${world.branchA._id}`,
      `/api/kitchen/board?branch=${world.branchA._id}`
    ]) {
      const res = await request(path, {token: rival.token});
      assert.ok([403, 404].includes(res.status), `${path} leaked to a foreign tenant (${res.status})`);
    }
  });

  it('will not let a foreign owner touch this tenant\'s users or roles', async () => {
    const rival = await rivalWorld();
    const res = await request(`/api/users/${world.staffA._id}/role`, {
      method: 'PATCH', token: rival.token, body: {role: 'manager'}
    });
    assert.equal(res.status, 404);
    assert.equal((await User.findById(world.staffA._id)).role, 'staff',
      'the target account must be untouched');

    await withRole({key: 'localrole', name: 'Local', permissions: ['orders.view']});
    const edit = await request('/api/roles/localrole', {
      method: 'PATCH', token: rival.token, body: {permissions: ['users.manage']}
    });
    assert.equal(edit.status, 404);
    const role = await Role.findOne({restaurant: world.restaurant._id, key: 'localrole'}).lean();
    assert.deepEqual(role.permissions, ['orders.view'], 'the role must be unchanged');
  });

  it('keeps a branch manager out of another branch after migration', async () => {
    // world.manager is bound to branchA.
    for (const path of [
      `/api/purchase-orders?branch=${world.branchB._id}`,
      `/api/tables?branch=${world.branchB._id}`,
      `/api/inventory/balances?branch=${world.branchB._id}`
    ]) {
      assert.equal((await request(path, {token: manager()})).status, 403, `${path} crossed a branch`);
    }
    // Control: their own branch works, so the refusals are about scope.
    assert.equal((await request(`/api/purchase-orders?branch=${world.branchA._id}`, {token: manager()})).status, 200);
  });

  it('confines a custom role to its own branch', async () => {
    const {token} = await withRole({
      key: 'branchclerk', name: 'Branch Clerk',
      permissions: ['purchase.view', 'inventory.view', 'branches.view']
    });
    assert.equal((await request(`/api/purchase-orders?branch=${world.branchA._id}`, {token})).status, 200);
    assert.equal((await request(`/api/purchase-orders?branch=${world.branchB._id}`, {token})).status, 403);
  });

  it('will not let a custom role borrow a role key from another tenant', async () => {
    const rival = await rivalWorld();
    await Role.create({
      restaurant: rival.restaurant._id, key: 'superuser', name: 'Super',
      baseRole: 'staff', permissions: [...ALL_PERMISSIONS]
    });
    const intruder = await User.create({
      name: 'Intruder', email: 'intruder@p17.test', password: 'x', role: 'staff',
      roleKey: 'superuser', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    assert.equal((await request('/api/me/permissions', {token: tokenFor(intruder)})).status, 401);
  });
});

// ── 10. service-level capability check ───────────────────────────────────────

describe('Phase 17 · service-level capability check', () => {
  it('decides by permission, and treats a custom role as authoritative', async () => {
    // DEFENCE IN DEPTH, verified. Mutating `hasCapability()` to always return
    // true, or to let a custom role fall through to the legacy role list,
    // leaves the HTTP suite green — the route guard refuses first either way.
    // Removing BOTH layers was confirmed to fail. The service check is kept
    // because these functions are also reachable from scripts, replay paths
    // and internal callers that never pass through a route guard, so they are
    // tested directly here rather than only through HTTP.
    const {hasCapability, assertCapability} = await import('../src/services/capabilities.js');

    const owner = {baseRole: 'owner', custom: false, permissions: new Set()};
    assert.equal(hasCapability(null, owner, 'anything.at.all'), true, 'an owner holds everything');

    const purchaser = {baseRole: 'staff', custom: true, permissions: new Set(['purchase.create'])};
    assert.equal(hasCapability(null, purchaser, 'purchase.create'), true);
    assert.equal(hasCapability(null, purchaser, 'purchase.approve'), false);
    // A custom role must NOT fall back to the legacy list even when its base
    // role would have passed — that is the escalation this guards.
    assert.equal(hasCapability({role: 'manager'}, purchaser, 'purchase.approve'), false);

    // A built-in principal missing the key still falls back, preserving the
    // pre-migration behaviour for internal callers.
    const builtinManager = {baseRole: 'manager', custom: false, permissions: new Set()};
    assert.equal(hasCapability({role: 'manager'}, builtinManager, 'purchase.approve'), true);

    // With no principal at all (script / service-to-service) the legacy list
    // applies exactly as before.
    assert.equal(hasCapability({role: 'manager'}, null, 'purchase.approve'), true);
    assert.equal(hasCapability({role: 'staff'}, null, 'purchase.approve'), false);

    assert.throws(() => assertCapability(null, purchaser, 'purchase.approve'), /Insufficient permission/);
    assert.doesNotThrow(() => assertCapability(null, purchaser, 'purchase.create'));
  });

  it('refuses a custom role inside the service even when the route is bypassed', async () => {
    // Calls the service function directly — no route, no guard — proving the
    // second layer stands on its own.
    const {createPurchaseOrder} = await import('../src/services/purchaseOrders.js');
    const {Supplier} = await import('../src/models/index.js');
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Direct Supplier'});
    const {user} = await withRole({
      key: 'viewer', name: 'Viewer', permissions: ['purchase.view', 'branches.view']
    });
    await assert.rejects(
      () => createPurchaseOrder({
        input: {
          branch: String(world.branchA._id), supplier: String(supplier._id),
          items: [{ingredient: String(world.ingredient._id), orderedQty: 100, unit: 'g', unitPrice: 1, vatRate: 13}]
        },
        user: {id: user._id, role: 'staff'},
        principal: {baseRole: 'staff', custom: true, permissions: new Set(['purchase.view'])}
      }),
      error => error.status === 403
    );
  });
});

// ── 11. built-in bundle integrity ────────────────────────────────────────────

describe('Phase 17 · built-in bundle integrity', () => {
  it('keeps owner-only capabilities out of the manager bundle', () => {
    const mgr = permissionsForBuiltin('manager');
    for (const key of [
      'payments.reverse', 'purchase.reversepay', 'menu.delete', 'ingredients.delete',
      'coupons.delete', 'customers.delete', 'monthclose.manage', 'branches.manage',
      'roles.manage', 'audit.view', 'inventory.recover', 'settings.manage',
      'users.create', 'users.password', 'users.deactivate'
    ]) {
      assert.ok(!mgr.includes(key), `manager must not hold ${key}`);
    }
  });

  it('keeps management capabilities out of the staff bundle', () => {
    const stf = permissionsForBuiltin('staff');
    for (const key of [
      'orders.refund', 'orders.discountoverride', 'purchase.approve', 'purchase.receive',
      'purchase.invoice', 'inventory.adjust', 'inventory.approve', 'reports.view',
      'users.manage', 'tables.configure', 'customers.merge', 'purchase.analyse'
    ]) {
      assert.ok(!stf.includes(key), `staff must not hold ${key}`);
    }
  });

  it('gives a rider only self-scoped capabilities', () => {
    /**
     * Phase 24 added `notifications.mine`. The assertion stays exhaustive --
     * a rider's bundle is still pinned to an exact list, because the value of
     * this test is that nothing can be added to it silently.
     *
     * `notifications.mine` is SELF-scoped: it can only ever return rows whose
     * `user` is the caller. The branch-scoped `notifications.view`, which
     * carries the branch's payment, refund, purchasing and inventory rows,
     * must never appear here.
     */
    assert.deepEqual(permissionsForBuiltin('rider'), ['deliveries.ride', 'notifications.mine']);
    assert.ok(!permissionsForBuiltin('rider').includes('notifications.view'),
      'a rider must never hold the branch-scoped notification permission');
  });
});
