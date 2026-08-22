import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {io as ioClient} from 'socket.io-client';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Role, User, UserSession} from '../src/models/index.js';
import {Branch, Delivery, Order, Restaurant} from '../src/models/operations.js';
import {hashSessionId} from '../src/services/sessions.js';
import {
  invalidateAllRoles, resetRoleCacheStats, roleCacheStats
} from '../src/services/principalCache.js';
import {
  roleStreamActive, roleStreamStats, startRoleChangeStream, stopRoleChangeStream
} from '../src/services/roleChangeStream.js';

/**
 * Final RBAC gap closure.
 *
 * Covers the six limitations the previous cycle left open: rider self-scope,
 * per-device logout, cache invalidation across instances, admin password
 * reset, safe role deletion, and socket permission refresh.
 *
 * Security assertions verify database and socket state, not only status codes.
 */

let baseUrl;
let world;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopRoleChangeStream(); await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  invalidateAllRoles();
  resetRoleCacheStats();
});

async function makeRider({email = 'rider@gap.test', active = true} = {}) {
  return User.create({
    name: 'Gap Rider', email, password: 'x', role: 'rider',
    restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active, available: true}
  });
}

async function withRole({key, name, baseRole = 'staff', permissions, email}) {
  const created = await request('/api/roles', {
    method: 'POST', token: owner(), body: {key, name, baseRole, permissions}
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const user = await User.create({
    name, email: email || `${key}@gap.test`, password: 'x',
    role: baseRole, roleKey: created.body.key,
    restaurantId: world.restaurant._id, branch: world.branchA._id,
    ...(baseRole === 'rider' ? {rider: {active: true}} : {})
  });
  return {role: created.body, user, token: tokenFor(user)};
}

async function makeAccount(email, password = 'Str0ngPassw0rd', role = 'staff') {
  const created = await request('/api/accounts', {
    method: 'POST', token: owner(),
    body: {name: 'Account', email, password, role, branch: String(world.branchA._id)}
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body;
}

const login = (email, password = 'Str0ngPassw0rd', deviceLabel) =>
  request('/api/auth/login', {method: 'POST', body: {email, password, ...(deviceLabel ? {deviceLabel} : {})}});

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

const settle = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

// ── 1 & 7. rider guards ──────────────────────────────────────────────────────

describe('Gap closure · rider self-scope', () => {
  const RIDER_PRIVATE = [
    ['GET', '/api/deliveries/mine'],
    ['GET', '/api/deliveries/mine/dashboard']
  ];

  it('refuses rider-private endpoints to owner, manager and staff', async () => {
    // FOUND AND FIXED. `requirePermission('deliveries.ride')` let an owner
    // through, because an owner implicitly holds every permission: the
    // dashboard returned 200 with a rider profile synthesised from the
    // OWNER'S OWN user document, and /deliveries/mine returned an empty list
    // rather than a refusal. No other rider's data leaked — the handlers
    // scope by user.id — but a non-rider was transacting against a
    // rider-private surface. These now use requireSelfScopedPermission().
    for (const token of [owner(), manager(), staff()]) {
      for (const [method, path] of RIDER_PRIVATE) {
        const res = await request(path, {method, token});
        assert.equal(res.status, 403, `${path} must refuse a non-rider (${res.status})`);
      }
      const availability = await request('/api/deliveries/mine/availability', {
        method: 'PATCH', token, body: {available: true}
      });
      assert.equal(availability.status, 403);
    }
  });

  it('leaves an owner\'s own rider profile untouched by a refused call', async () => {
    // The old behaviour reached the service and could have written to the
    // owner's embedded rider subdocument. Prove nothing is mutated now.
    const before = await User.findById(world.owner._id).lean();
    await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: owner(), body: {available: true}
    });
    const after = await User.findById(world.owner._id).lean();
    assert.equal(Boolean(after.rider?.available), Boolean(before.rider?.available));
    assert.equal(after.role, 'owner');
  });

  it('still serves a genuine rider', async () => {
    const rider = await makeRider();
    const token = tokenFor(rider);
    for (const [method, path] of RIDER_PRIVATE) {
      assert.equal((await request(path, {method, token})).status, 200, `${path} must serve a rider`);
    }
    const availability = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token, body: {available: false}
    });
    assert.equal(availability.status, 200);
    // DATABASE state, not just the response.
    const stored = await User.findById(rider._id).lean();
    assert.equal(stored.rider.available, false);
  });

  it('serves a custom rider-based role the same way', async () => {
    const {token, user} = await withRole({
      key: 'courier', name: 'Courier', baseRole: 'rider', permissions: ['deliveries.ride']
    });
    assert.equal((await request('/api/deliveries/mine', {token})).status, 200);
    // ...but a custom STAFF role granted deliveries.ride must not get in:
    // the endpoint is meaningful only for a rider-shaped principal.
    const impostor = await withRole({
      key: 'pretender', name: 'Pretender', baseRole: 'staff',
      permissions: ['deliveries.ride', 'branches.view'], email: 'pretender@gap.test'
    });
    assert.equal((await request('/api/deliveries/mine', {token: impostor.token})).status, 403);
    assert.ok(user);
  });

  it('keeps one rider from seeing another rider\'s delivery', async () => {
    const riderA = await makeRider({email: 'ra@gap.test'});
    const riderB = await makeRider({email: 'rb@gap.test'});
    const order = await Order.create({
      orderNo: 'GAP-1', branch: world.branchA._id, type: 'delivery', status: 'ready',
      items: [], subtotal: 100, vat: 13, total: 113, createdBy: world.owner._id
    });
    const delivery = await Delivery.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, order: order._id,
      rider: riderA._id, status: 'assigned', address: 'Kalanki'
    });
    const res = await request(`/api/deliveries/mine/${delivery._id}`, {token: tokenFor(riderB)});
    assert.equal(res.status, 404, 'rider B must not read rider A\'s job');
    const mine = await request('/api/deliveries/mine', {token: tokenFor(riderB)});
    assert.deepEqual(mine.body, [], 'rider B\'s list must be empty');
  });

  it('leaves the shared dispatch/rider status route reachable by both', async () => {
    // /deliveries/:id/status is genuinely dual-audience and stays on
    // requirePermission with two keys; the service decides what each may set.
    const {readFile} = await import('node:fs/promises');
    const src = await readFile(new URL('../src/routes/deliveries.js', import.meta.url), 'utf8');
    assert.match(src, /requirePermission\('deliveries\.dispatch', 'deliveries\.ride'\)/);
    // And the four private ones are self-scoped. Count only real call sites:
    // the explanatory comment above them names the guard too.
    const callSites = (src.match(/r\.(?:get|patch)\('[^']*',\s*requireSelfScopedPermission\('deliveries\.ride'\)/g) || []);
    assert.equal(callSites.length, 4, `expected 4 self-scoped rider routes, saw ${callSites.length}`);
  });
});

// ── 2. per-device sessions ───────────────────────────────────────────────────

describe('Gap closure · per-device logout', () => {
  it('creates a session row per login and stores only a hash', async () => {
    const account = await makeAccount('dev1@gap.test');
    const first = await login('dev1@gap.test', 'Str0ngPassw0rd', 'Phone');
    assert.equal(first.status, 200);

    const rows = await UserSession.find({user: account._id}).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Phone');
    // The plaintext id lives only in the JWT; the row must hold a hash of it.
    const claims = jwt.decode(first.body.token);
    assert.ok(claims.sid, 'the token must carry a session id');
    assert.equal(rows[0].sessionHash, hashSessionId(claims.sid));
    assert.notEqual(rows[0].sessionHash, claims.sid, 'the raw id must never be stored');
    assert.equal(rows[0].sessionHash.length, 64);
    assert.ok(rows[0].expiresAt > new Date());
  });

  it('signs out one device and leaves the other working', async () => {
    await makeAccount('dev2@gap.test');
    const deviceA = (await login('dev2@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    const deviceB = (await login('dev2@gap.test', 'Str0ngPassw0rd', 'Till')).body.token;

    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 200);
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 200);

    const out = await request('/api/auth/logout', {method: 'POST', token: deviceA, body: {}});
    assert.equal(out.status, 200);
    assert.equal(out.body.scope, 'device');

    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 401,
      'device A must be signed out');
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 200,
      'device B must keep working');

    // DATABASE: exactly one row revoked, the other still live.
    const rows = await UserSession.find({}).sort({createdAt: 1}).lean();
    assert.equal(rows.filter(row => row.revokedAt).length, 1);
    assert.equal(rows.filter(row => !row.revokedAt).length, 1);
    assert.equal(rows.find(row => row.revokedAt).revokedReason, 'logout');
  });

  it('signs out every device on request', async () => {
    await makeAccount('dev3@gap.test');
    const deviceA = (await login('dev3@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    const deviceB = (await login('dev3@gap.test', 'Str0ngPassw0rd', 'Till')).body.token;
    const out = await request('/api/auth/logout', {
      method: 'POST', token: deviceA, body: {allDevices: true}
    });
    assert.equal(out.body.scope, 'all');
    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 401);
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 401);
    assert.equal(await UserSession.countDocuments({revokedAt: null}), 0);
  });

  it('lists a user\'s own devices without exposing any hash', async () => {
    await makeAccount('dev4@gap.test');
    const token = (await login('dev4@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    await login('dev4@gap.test', 'Str0ngPassw0rd', 'Till');

    const res = await request('/api/auth/sessions', {token});
    assert.equal(res.status, 200);
    assert.equal(res.body.sessions.length, 2);
    assert.equal(res.body.sessions.filter(session => session.current).length, 1);
    const serialised = JSON.stringify(res.body);
    assert.doesNotMatch(serialised, /sessionHash/);
    assert.doesNotMatch(serialised, /[a-f0-9]{64}/, 'no hash may appear in the payload');
  });

  it('revokes a named device from the session list', async () => {
    await makeAccount('dev5@gap.test');
    const deviceA = (await login('dev5@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    const deviceB = (await login('dev5@gap.test', 'Str0ngPassw0rd', 'Till')).body.token;

    const list = await request('/api/auth/sessions', {token: deviceB});
    const other = list.body.sessions.find(session => !session.current);
    const res = await request(`/api/auth/sessions/${other.id}`, {method: 'DELETE', token: deviceB});
    assert.equal(res.status, 200);

    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 401);
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 200);
  });

  it('cannot revoke another user\'s session', async () => {
    await makeAccount('victim@gap.test');
    await makeAccount('attacker@gap.test');
    const victim = (await login('victim@gap.test', 'Str0ngPassw0rd', 'Victim phone')).body.token;
    const attacker = (await login('attacker@gap.test', 'Str0ngPassw0rd', 'Attacker')).body.token;

    const victimSessions = await request('/api/auth/sessions', {token: victim});
    const victimSessionId = victimSessions.body.sessions[0].id;

    const res = await request(`/api/auth/sessions/${victimSessionId}`, {
      method: 'DELETE', token: attacker
    });
    // 404 rather than 403: it must not even confirm the id exists.
    assert.equal(res.status, 404);
    assert.equal((await request('/api/me/permissions', {token: victim})).status, 200,
      'the victim must still be signed in');
    const row = await UserSession.findById(victimSessionId).lean();
    assert.equal(row.revokedAt, null, 'the victim\'s session row must be untouched');
  });

  it('rejects a forged or unknown session id', async () => {
    const account = await makeAccount('forge@gap.test');
    const forged = jwt.sign(
      {
        id: String(account._id), name: 'Account', role: 'staff',
        restaurantId: String(world.restaurant._id), branch: String(world.branchA._id),
        sv: 0, sid: 'deadbeef'.repeat(8)
      },
      process.env.JWT_SECRET
    );
    assert.equal((await request('/api/me/permissions', {token: forged})).status, 401);
  });

  it('rejects an expired session row even before the JWT expires', async () => {
    const account = await makeAccount('exp@gap.test');
    const token = (await login('exp@gap.test')).body.token;
    assert.equal((await request('/api/me/permissions', {token})).status, 200);
    // Age the row out. The JWT is still cryptographically valid.
    await UserSession.collection.updateOne(
      {user: new mongoose.Types.ObjectId(String(account._id))},
      {$set: {expiresAt: new Date(Date.now() - 1000)}}
    );
    assert.equal((await request('/api/me/permissions', {token})).status, 401);
  });

  it('still accepts a legacy token that predates per-device sessions', async () => {
    // Shipping this must not sign every live session out.
    const legacy = jwt.sign(
      {
        id: String(world.manager._id), name: 'Manager', role: 'manager',
        restaurantId: String(world.restaurant._id), branch: String(world.branchA._id), sv: 0
      },
      process.env.JWT_SECRET
    );
    assert.equal((await request('/api/accounts', {token: legacy})).status, 200);
    // And logging that token out falls back to a global sign-out rather than
    // silently doing nothing.
    const out = await request('/api/auth/logout', {method: 'POST', token: legacy, body: {}});
    assert.equal(out.body.scope, 'all');
    assert.equal(out.body.legacyToken, true);
    assert.equal((await request('/api/accounts', {token: legacy})).status, 401);
  });

  it('audits a device revocation', async () => {
    const account = await makeAccount('audit@gap.test');
    const token = (await login('audit@gap.test')).body.token;
    await request('/api/auth/logout', {method: 'POST', token, body: {}});
    const row = await Audit.findOne({entityId: account._id, action: 'session_device_revoked'}).lean();
    assert.ok(row, 'a per-device revocation must be audited');
    assert.equal(row.after.reason, 'logout');
  });
});

// ── 3. cache invalidation ────────────────────────────────────────────────────

describe('Gap closure · cache invalidation', () => {
  it('invalidates in-process immediately on a role edit', async () => {
    const {token} = await withRole({
      key: 'cashier', name: 'Cashier', permissions: ['orders.view', 'branches.view']
    });
    await request('/api/branches', {token});
    assert.equal((await request('/api/reports/pnl', {token})).status, 403);

    await request('/api/roles/cashier', {
      method: 'PATCH', token: owner(),
      body: {permissions: ['orders.view', 'branches.view', 'reports.view']}
    });
    assert.equal((await request('/api/reports/pnl', {token})).status, 200,
      'the very next request must see the new permissions');
  });

  it('propagates an OUT-OF-BAND role write through the change stream', async () => {
    // This is what another API instance's write looks like to this process:
    // the database changes with no local service call, so nothing invalidates
    // explicitly. The change stream is what closes the gap.
    assert.equal(await startRoleChangeStream(), true);
    assert.equal(roleStreamActive(), true);
    try {
      const {token} = await withRole({
        key: 'clerk', name: 'Clerk', permissions: ['orders.view', 'branches.view']
      });
      // Warm the cache so a stale hit would be observable.
      for (let i = 0; i < 4; i += 1) await request('/api/branches', {token});
      assert.ok(roleCacheStats.hits >= 2, `expected warm hits, saw ${JSON.stringify(roleCacheStats)}`);
      assert.equal((await request('/api/reports/pnl', {token})).status, 403);

      const before = roleStreamStats.events;
      await Role.collection.updateOne(
        {restaurant: world.restaurant._id, key: 'clerk'},
        {$set: {permissions: ['orders.view', 'branches.view', 'reports.view']}}
      );
      await settle(600);
      assert.ok(roleStreamStats.events > before, 'the change stream must observe the write');
      assert.equal((await request('/api/reports/pnl', {token})).status, 200,
        'the out-of-band edit must have invalidated the cache');
    } finally {
      await stopRoleChangeStream();
    }
  });

  it('shuts the change stream down cleanly and is safe to start twice', async () => {
    assert.equal(await startRoleChangeStream(), true);
    assert.equal(await startRoleChangeStream(), false, 'a second start must be a no-op');
    assert.equal(await stopRoleChangeStream(), true);
    assert.equal(roleStreamActive(), false);
    assert.equal(await stopRoleChangeStream(), false);
  });

  it('still resolves correctly with the cache disabled', async () => {
    // Correctness must not depend on the cache being present.
    const {configureRoleCache} = await import('../src/services/principalCache.js');
    configureRoleCache({ttl: 0});
    try {
      const {token} = await withRole({
        key: 'nocache', name: 'No Cache', permissions: ['orders.view', 'branches.view']
      });
      assert.equal((await request('/api/branches', {token})).status, 200);
      assert.equal((await request('/api/reports/pnl', {token})).status, 403);
    } finally {
      configureRoleCache({ttl: 5000, max: 2000});
    }
  });
});

// ── 4. admin password reset ──────────────────────────────────────────────────

describe('Gap closure · administrator password reset', () => {
  it('replaces the credential, ends sessions, and never echoes anything back', async () => {
    const account = await makeAccount('pw1@gap.test');
    const before = await User.findById(account._id).select('password').lean();
    const deviceA = (await login('pw1@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    const deviceB = (await login('pw1@gap.test', 'Str0ngPassw0rd', 'Till')).body.token;

    const reset = await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });
    assert.equal(reset.status, 200);
    // Neither the plaintext nor a hash may come back.
    const body = JSON.stringify(reset.body);
    assert.doesNotMatch(body, /BrandNewP4ssword/);
    assert.doesNotMatch(body, /\$2[aby]\$/);

    // DATABASE: a new bcrypt hash that verifies against the new password only.
    const after = await User.findById(account._id).select('password').lean();
    assert.notEqual(after.password, before.password);
    assert.match(after.password, /^\$2[aby]\$/);
    assert.equal(await bcrypt.compare('BrandNewP4ssword', after.password), true);
    assert.equal(await bcrypt.compare('Str0ngPassw0rd', after.password), false);

    // EVERY existing session ends — a reset usually means the credential may
    // be compromised, so leaving other devices alive would defeat it. Checked
    // BEFORE logging back in, because a successful login legitimately mints a
    // fresh session row.
    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 401);
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 401);
    assert.equal(await UserSession.countDocuments({user: account._id, revokedAt: null}), 0);
    assert.equal(await UserSession.countDocuments({user: account._id, revokedAt: {$ne: null}}), 2,
      'both device rows must be marked revoked, not deleted');

    // Old password refused, new accepted.
    assert.equal((await login('pw1@gap.test', 'Str0ngPassw0rd')).status, 401);
    assert.equal((await login('pw1@gap.test', 'BrandNewP4ssword')).status, 200);
    assert.equal(await UserSession.countDocuments({user: account._id, revokedAt: null}), 1,
      'the fresh login gets exactly one new session');
  });

  it('enforces the existing password policy', async () => {
    const account = await makeAccount('pw2@gap.test');
    const before = await User.findById(account._id).select('password').lean();
    for (const password of ['short', 'passwordpassword', '1234567890']) {
      const res = await request(`/api/accounts/${account._id}/password`, {
        method: 'POST', token: owner(), body: {password}
      });
      assert.equal(res.status, 400, `'${password}' must be refused`);
    }
    const after = await User.findById(account._id).select('password').lean();
    assert.equal(after.password, before.password, 'a refused reset must not change the credential');
  });

  it('is closed to callers without users.password', async () => {
    const account = await makeAccount('pw3@gap.test');
    for (const token of [manager(), staff()]) {
      const res = await request(`/api/accounts/${account._id}/password`, {
        method: 'POST', token, body: {password: 'BrandNewP4ssword'}
      });
      assert.equal(res.status, 403);
    }
    assert.equal((await login('pw3@gap.test', 'Str0ngPassw0rd')).status, 200,
      'the original credential must still work');
  });

  it('cannot reset an account in another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const outsider = await User.create({
      name: 'Outsider', email: 'outsider@gap.test', password: await bcrypt.hash('Str0ngPassw0rd', 12),
      role: 'staff', restaurantId: rival._id
    });
    const res = await request(`/api/accounts/${outsider._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });
    assert.equal(res.status, 404);
  });

  it('audits who performed the reset and when', async () => {
    const account = await makeAccount('pw4@gap.test');
    await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });
    const row = await Audit.findOne({entityId: account._id, action: 'account_password_reset'}).lean();
    assert.ok(row);
    assert.equal(String(row.user), String(world.owner._id));
    assert.ok(row.at instanceof Date);
    // The audit row must not carry the credential either.
    assert.doesNotMatch(JSON.stringify(row), /BrandNewP4ssword/);
  });
});

// ── 5. role deletion ─────────────────────────────────────────────────────────

describe('Gap closure · safe role deletion', () => {
  it('refuses to delete a built-in role', async () => {
    for (const key of ['owner', 'manager', 'staff', 'rider']) {
      const res = await request(`/api/roles/${key}`, {method: 'DELETE', token: owner()});
      assert.equal(res.status, 403, `${key} must be protected`);
    }
  });

  it('deletes an unused custom role', async () => {
    await request('/api/roles', {
      method: 'POST', token: owner(), body: {name: 'Spare', permissions: ['orders.view']}
    });
    const res = await request('/api/roles/spare', {method: 'DELETE', token: owner()});
    assert.equal(res.status, 200);
    assert.equal(await Role.countDocuments({key: 'spare'}), 0);
  });

  it('refuses to delete a role that is still held, leaving everything intact', async () => {
    const {user} = await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    const res = await request('/api/roles/cashier', {method: 'DELETE', token: owner()});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /still hold this role/);
    // Neither the role nor the holder may be touched by a refused delete.
    assert.equal(await Role.countDocuments({key: 'cashier'}), 1);
    assert.equal((await User.findById(user._id)).roleKey, 'cashier');
  });

  it('reassigns holders and deletes in one operation', async () => {
    const {user} = await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {key: 'teller', name: 'Teller', baseRole: 'staff', permissions: ['orders.view', 'branches.view']}
    });

    const res = await request('/api/roles/cashier?reassignTo=teller', {
      method: 'DELETE', token: owner()
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.reassigned, 1);

    // DATABASE: role gone, holder moved, no dangling reference.
    assert.equal(await Role.countDocuments({key: 'cashier'}), 0);
    const moved = await User.findById(user._id).lean();
    assert.equal(moved.roleKey, 'teller');
    assert.equal(moved.role, 'staff');
    // The moved account must still authenticate and get the NEW permissions.
    const token = tokenFor(await User.findById(user._id));
    assert.equal((await request('/api/branches', {token})).status, 200);
    assert.equal(await User.countDocuments({roleKey: 'cashier'}), 0,
      'nobody may be left pointing at the deleted role');
  });

  it('refuses a reassignment target with a different base role', async () => {
    // Moving a staff-based role's holders onto a manager-based role would
    // change their tenancy regime silently.
    const {user} = await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {key: 'supervisor', name: 'Supervisor', baseRole: 'manager', permissions: ['orders.view']}
    });
    const res = await request('/api/roles/cashier?reassignTo=supervisor', {
      method: 'DELETE', token: owner()
    });
    assert.equal(res.status, 409);
    assert.match(res.body.message, /based on 'staff'/);
    assert.equal((await User.findById(user._id)).roleKey, 'cashier');
  });

  it('refuses reassignment to owner or to a missing role', async () => {
    await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    assert.equal((await request('/api/roles/cashier?reassignTo=owner', {
      method: 'DELETE', token: owner()
    })).status, 403);
    assert.equal((await request('/api/roles/cashier?reassignTo=ghost', {
      method: 'DELETE', token: owner()
    })).status, 404);
    assert.equal(await Role.countDocuments({key: 'cashier'}), 1);
  });

  it('preserves the audit history of a deleted role and its reassignments', async () => {
    const {user} = await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    await request('/api/roles/cashier?reassignTo=staff', {method: 'DELETE', token: owner()});

    const deletion = await Audit.findOne({action: 'role_deleted'}).lean();
    assert.ok(deletion);
    assert.deepEqual(deletion.before.permissions, ['orders.view']);
    assert.equal(deletion.after.reassignedTo, 'staff');
    assert.equal(deletion.after.reassignedCount, 1);

    const move = await Audit.findOne({
      action: 'user_role_assigned', entityId: user._id, 'after.reason': 'role_deleted_reassignment'
    }).lean();
    assert.ok(move, 'each reassigned account needs its own audit row');
    assert.equal(move.before.roleKey, 'cashier');
  });

  it('is closed to callers without roles.manage', async () => {
    await withRole({key: 'cashier', name: 'Cashier', permissions: ['orders.view']});
    for (const token of [manager(), staff()]) {
      assert.equal((await request('/api/roles/cashier', {method: 'DELETE', token})).status, 403);
    }
    assert.equal(await Role.countDocuments({key: 'cashier'}), 1);
  });

  it('cannot delete a role belonging to another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    await Role.create({
      restaurant: rival._id, key: 'foreign', name: 'Foreign',
      baseRole: 'staff', permissions: ['orders.view']
    });
    assert.equal((await request('/api/roles/foreign', {method: 'DELETE', token: owner()})).status, 404);
    assert.equal(await Role.countDocuments({key: 'foreign'}), 1);
  });
});

// ── 6. socket authorisation refresh ──────────────────────────────────────────

describe('Gap closure · socket authorisation', () => {
  it('joins an authorised branch and refuses another', async () => {
    const socket = await connectSocket(manager(), world.branchA._id);
    try {
      assert.equal((await joinBranch(socket, world.branchA._id)).ok, true);
      const other = await joinBranch(socket, world.branchB._id);
      assert.equal(other.ok, false);
      assert.equal(other.status, 403);
    } finally {
      socket.close();
    }
  });

  it('removes the branch room when the user is reassigned', async () => {
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

      // Prove the ROOM emptied, not just that an event fired: publishing to
      // the old branch must no longer reach this socket.
      await settle();
      let leaked = false;
      socket.on('table:update', () => { leaked = true; });
      const {publishTableEvent} = await import('../src/services/realtime.js');
      publishTableEvent(world.branchA._id, {reason: 'probe'});
      await settle();
      assert.equal(leaked, false, 'the socket must no longer receive the old branch\'s traffic');
    } finally {
      socket.close();
    }
  });

  it('disconnects the socket when the account is deactivated', async () => {
    const account = await makeAccount('sock@gap.test');
    const token = (await login('sock@gap.test')).body.token;
    const socket = await connectSocket(token, world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const gone = new Promise(resolve => socket.once('disconnect', resolve));
      await request(`/api/accounts/${account._id}/active`, {
        method: 'PATCH', token: owner(), body: {active: false}
      });
      await gone;
      assert.equal(socket.connected, false);
    } finally {
      socket.close();
    }
  });

  it('refuses a handshake for a device whose session was revoked', async () => {
    await makeAccount('sockrevoke@gap.test');
    const deviceA = (await login('sockrevoke@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    const deviceB = (await login('sockrevoke@gap.test', 'Str0ngPassw0rd', 'Till')).body.token;
    await request('/api/auth/logout', {method: 'POST', token: deviceA, body: {}});

    await assert.rejects(connectSocket(deviceA, world.branchA._id), /signed out/i);
    // The other device may still connect.
    const socket = await connectSocket(deviceB, world.branchA._id);
    socket.close();
  });

  it('gives a reconnecting socket only its current permissions', async () => {
    // Downgrade, then reconnect: the new connection must reflect the new
    // access, not whatever the old token claimed.
    const socket = await connectSocket(manager(), world.branchA._id);
    socket.close();
    await request(`/api/users/${world.manager._id}/role`, {
      method: 'PATCH', token: owner(), body: {branch: String(world.branchB._id)}
    });
    const fresh = tokenFor(await User.findById(world.manager._id));
    await assert.rejects(connectSocket(fresh, world.branchA._id), /Branch access denied/i);
    const allowed = await connectSocket(fresh, world.branchB._id);
    try {
      assert.equal((await joinBranch(allowed, world.branchB._id)).ok, true);
    } finally {
      allowed.close();
    }
  });

  it('never puts a rider in a branch room', async () => {
    const rider = await makeRider({email: 'sockrider@gap.test'});
    const socket = await connectSocket(tokenFor(rider));
    try {
      const result = await joinBranch(socket, world.branchA._id);
      assert.equal(result.ok, false);
      assert.equal(result.status, 403);
    } finally {
      socket.close();
    }
  });

  it('documents the single-instance limitation in the source', async () => {
    // The repository has no Redis or Socket.IO adapter, so cross-instance
    // socket refresh is genuinely not implemented. The code must say so
    // rather than implying a guarantee it cannot make.
    const {readFile} = await import('node:fs/promises');
    const src = await readFile(new URL('../src/services/realtime.js', import.meta.url), 'utf8');
    assert.match(src, /single-instance|this process|not distributed/i);
  });
});

// ── password reset revocation policy ─────────────────────────────────────────

describe('Gap closure · password reset revocation policy', () => {
  /**
   * Two deliberately different policies, reviewed and confirmed:
   *
   *   admin resets SOMEBODY ELSE -> revoke every session, spare nothing.
   *   user resets THEIR OWN      -> revoke every OTHER device, keep this one,
   *                                 and rotate its token.
   *
   * Sparing is only safe in the self case, where the caller has just proved
   * control of the account. `sessionVersion` is bumped either way, so a legacy
   * token with no `sid` cannot survive a reset in either case.
   */

  it('spares only the calling device on a SELF reset, and rotates its token', async () => {
    const bcryptModule = await import('bcryptjs');
    await User.updateOne(
      {_id: world.owner._id},
      {$set: {password: await bcryptModule.default.hash('OwnerP4ssword', 12)}}
    );
    const deviceA = (await login('owner@test.com', 'OwnerP4ssword', 'Laptop')).body.token;
    const deviceB = (await login('owner@test.com', 'OwnerP4ssword', 'Phone')).body.token;

    const res = await request(`/api/accounts/${world.owner._id}/password`, {
      method: 'POST', token: deviceA, body: {password: 'OwnerNewP4ss'}
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.selfReset, true);
    assert.equal(res.body.rotatedSession, true);
    assert.ok(res.body.token, 'a self reset must hand back a rotated token');

    // The OLD token is dead (sessionVersion moved) but the session row lives,
    // and the rotated token works against it.
    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 401);
    assert.equal((await request('/api/me/permissions', {token: res.body.token})).status, 200);
    // Every OTHER device is gone. That is the security property.
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 401);

    // DATABASE: exactly one session row survives.
    assert.equal(await UserSession.countDocuments({user: world.owner._id, revokedAt: null}), 1);
    assert.equal(await UserSession.countDocuments({user: world.owner._id, revokedAt: {$ne: null}}), 1);

    // Credential actually changed.
    assert.equal((await login('owner@test.com', 'OwnerP4ssword')).status, 401);
    assert.equal((await login('owner@test.com', 'OwnerNewP4ss')).status, 200);
  });

  it('spares nothing when an administrator resets somebody else', async () => {
    const account = await makeAccount('other@gap.test');
    const deviceA = (await login('other@gap.test', 'Str0ngPassw0rd', 'Phone')).body.token;
    const deviceB = (await login('other@gap.test', 'Str0ngPassw0rd', 'Till')).body.token;

    const res = await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.selfReset, false);
    assert.equal(res.body.rotatedSession, false);
    // No token may be minted for a third party — that would be an
    // administrator handing themselves the target's session.
    assert.equal(res.body.token, undefined);

    assert.equal((await request('/api/me/permissions', {token: deviceA})).status, 401);
    assert.equal((await request('/api/me/permissions', {token: deviceB})).status, 401);
    assert.equal(await UserSession.countDocuments({user: account._id, revokedAt: null}), 0);
  });

  it('leaves the administrator\'s own sessions untouched', async () => {
    const bcryptModule = await import('bcryptjs');
    await User.updateOne(
      {_id: world.owner._id},
      {$set: {password: await bcryptModule.default.hash('OwnerP4ssword', 12)}}
    );
    const adminToken = (await login('owner@test.com', 'OwnerP4ssword', 'Admin')).body.token;
    const account = await makeAccount('victim2@gap.test');
    await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: adminToken, body: {password: 'BrandNewP4ssword'}
    });
    assert.equal((await request('/api/me/permissions', {token: adminToken})).status, 200,
      'resetting somebody else must not sign the administrator out');
  });

  it('records the policy taken on the audit row', async () => {
    const account = await makeAccount('audited@gap.test');
    await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });
    const row = await Audit.findOne({entityId: account._id, action: 'account_password_reset'}).lean();
    assert.equal(row.after.selfReset, false);
    assert.equal(row.after.sparedCurrentSession, false);
    assert.doesNotMatch(JSON.stringify(row), /BrandNewP4ssword/);
  });

  it('kills a legacy token with no sid through either reset path', async () => {
    // A pre-per-device token cannot be spared, because there is no session row
    // to spare. The version bump must end it.
    const account = await makeAccount('legacy@gap.test');
    const legacy = jwt.sign(
      {
        id: String(account._id), name: 'Account', role: 'staff',
        restaurantId: String(world.restaurant._id), branch: String(world.branchA._id), sv: 0
      },
      process.env.JWT_SECRET
    );
    assert.equal((await request('/api/me/permissions', {token: legacy})).status, 200);
    await request(`/api/accounts/${account._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });
    assert.equal((await request('/api/me/permissions', {token: legacy})).status, 401);
  });

  it('confines a reset to the target account only', async () => {
    // BLAST RADIUS. A reset must touch exactly one user's sessions. Asserted
    // at the DATABASE level because the HTTP outcome alone is masked by
    // `sessionVersion`: even if the row-level revocation were mis-scoped, the
    // version bump would still 401 the target, so a status-code-only test
    // cannot see the difference. This checks the rows themselves.
    const target = await makeAccount('blast-target@gap.test');
    const bystander = await makeAccount('blast-bystander@gap.test');
    await login('blast-target@gap.test', 'Str0ngPassw0rd', 'T1');
    await login('blast-target@gap.test', 'Str0ngPassw0rd', 'T2');
    const bystanderToken = (await login('blast-bystander@gap.test', 'Str0ngPassw0rd', 'B1')).body.token;

    const bystanderVersionBefore =
      (await User.findById(bystander._id).select('sessionVersion').lean()).sessionVersion;

    await request(`/api/accounts/${target._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewP4ssword'}
    });

    // Target: every row revoked.
    assert.equal(await UserSession.countDocuments({user: target._id, revokedAt: null}), 0);
    assert.equal(await UserSession.countDocuments({user: target._id, revokedAt: {$ne: null}}), 2);

    // Bystander: untouched at every level — row, version, and live access.
    assert.equal(await UserSession.countDocuments({user: bystander._id, revokedAt: null}), 1,
      'another user\'s session row must not be revoked');
    assert.equal(
      (await User.findById(bystander._id).select('sessionVersion').lean()).sessionVersion,
      bystanderVersionBefore,
      'another user\'s sessionVersion must not move'
    );
    assert.equal((await request('/api/me/permissions', {token: bystanderToken})).status, 200);
  });

  it('revokes only the target\'s rows even when the actor holds a session', async () => {
    // Directly pins the scoping of the bulk revocation: the actor is signed in
    // on their own device while resetting somebody else, and their row must
    // survive. Without user-scoping on the update this fails at the row level.
    const bcryptModule = await import('bcryptjs');
    await User.updateOne(
      {_id: world.owner._id},
      {$set: {password: await bcryptModule.default.hash('OwnerP4ssword', 12)}}
    );
    const adminToken = (await login('owner@test.com', 'OwnerP4ssword', 'Admin device')).body.token;
    const target = await makeAccount('scoped-target@gap.test');
    await login('scoped-target@gap.test', 'Str0ngPassw0rd', 'Target device');

    await request(`/api/accounts/${target._id}/password`, {
      method: 'POST', token: adminToken, body: {password: 'BrandNewP4ssword'}
    });

    assert.equal(await UserSession.countDocuments({user: world.owner._id, revokedAt: null}), 1,
      'the administrator\'s own session row must survive');
    assert.equal(await UserSession.countDocuments({user: target._id, revokedAt: null}), 0);
    assert.equal((await request('/api/me/permissions', {token: adminToken})).status, 200);
  });
});

// ── cache TTL fallback ───────────────────────────────────────────────────────

describe('Gap closure · cache TTL fallback without the change stream', () => {
  it('self-heals within the TTL when the change stream is unavailable', async () => {
    // The stream is the fast path. This proves correctness does NOT depend on
    // it: with the stream stopped and an out-of-band write (no service call,
    // so no explicit invalidation), staleness is bounded by the TTL and then
    // resolves on its own.
    const {configureRoleCache} = await import('../src/services/principalCache.js');
    await stopRoleChangeStream();
    configureRoleCache({ttl: 800, max: 2000});
    try {
      const {token} = await withRole({
        key: 'ttlclerk', name: 'TTL Clerk', permissions: ['orders.view', 'branches.view']
      });
      await request('/api/branches', {token});
      assert.equal((await request('/api/reports/pnl', {token})).status, 403);

      await Role.collection.updateOne(
        {restaurant: world.restaurant._id, key: 'ttlclerk'},
        {$set: {permissions: ['orders.view', 'branches.view', 'reports.view']}}
      );
      // Within the TTL the old answer may still be served — that is the
      // documented, bounded staleness, not a defect.
      await settle(1100);
      assert.equal((await request('/api/reports/pnl', {token})).status, 200,
        'the cache must self-heal once the TTL lapses');
    } finally {
      configureRoleCache({ttl: 5000, max: 2000});
    }
  });

  it('never lets the cache outlive a WITHDRAWAL of access, TTL or not', async () => {
    // Bounded staleness is acceptable when access is being GRANTED. It is not
    // acceptable when access is being taken away, so a disabled role is
    // revalidated on read rather than waiting for the TTL.
    const {configureRoleCache} = await import('../src/services/principalCache.js');
    await stopRoleChangeStream();
    configureRoleCache({ttl: 60_000, max: 2000});
    try {
      const {token} = await withRole({
        key: 'doomed', name: 'Doomed', permissions: ['orders.view', 'branches.view']
      });
      assert.equal((await request('/api/branches', {token})).status, 200);
      await Role.collection.updateOne(
        {restaurant: world.restaurant._id, key: 'doomed'}, {$set: {active: false}}
      );
      assert.equal((await request('/api/branches', {token})).status, 401,
        'withdrawal must be immediate even with a 60s TTL');
    } finally {
      configureRoleCache({ttl: 5000, max: 2000});
    }
  });
});
