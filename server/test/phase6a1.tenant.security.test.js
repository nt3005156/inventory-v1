import {describe, it, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {io as clientIo} from 'socket.io-client';
import {User} from '../src/models/index.js';
import {Branch, Customer, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

// Phase 6A.1 — multi-tenant access control.
//
// The rule under test: user -> restaurant -> branch -> resource must all be
// compatible. An owner has broad rights INSIDE their own restaurant but may
// never cross the restaurant boundary. Managers and staff stay pinned to their
// assigned branch.

let world;
let baseUrl;
let rival;          // a second restaurant, fully populated
let victimOrder;    // an order belonging to world.branchA
const sockets = [];

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => {
  closeSockets();
  await new Promise(r => setTimeout(r, 100));
  await stopTestApp();
});

function closeSockets() {
  while (sockets.length) {
    const socket = sockets.pop();
    socket.removeAllListeners();
    socket.disconnect();
    socket.close();
  }
}

beforeEach(async () => {
  closeSockets();
  await clearDb();
  world = await seedWorld();

  const restaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL'});
  const owner = await User.create({
    name: 'Rival Owner', email: 'rival.owner@test.com', password: 'x', role: 'owner',
    restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
  });
  const manager = await User.create({
    name: 'Rival Manager', email: 'rival.manager@test.com', password: 'x', role: 'manager',
    restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
  });
  const staff = await User.create({
    name: 'Rival Staff', email: 'rival.staff@test.com', password: 'x', role: 'staff',
    restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
  });
  rival = {restaurant, branch, owner, manager, staff};

  const created = await request('/api/orders', {
    method: 'POST', token: tokenFor(world.owner),
    body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 2}]}
  });
  assert.equal(created.status, 201, created.body?.message);
  victimOrder = created.body;
});
afterEach(() => { closeSockets(); });

const OURS = () => String(world.branchA._id);
const DENIED = new Set([403, 404]);

/** Every branch-scoped endpoint an attacker could reach with a branch id. */
function branchScopedTargets() {
  return [
    ['GET  /kitchen/orders', `/api/kitchen/orders?branch=${OURS()}`, {}],
    ['GET  /kitchen/board', `/api/kitchen/board?branch=${OURS()}`, {}],
    ['GET  /kitchen/performance', `/api/kitchen/performance?branch=${OURS()}`, {}],
    ['GET  /alerts', `/api/alerts?branch=${OURS()}`, {}],
    ['GET  /reports/operations', `/api/reports/operations?branch=${OURS()}`, {}],
    ['GET  /customers', `/api/customers?branch=${OURS()}`, {}],
    ['GET  /orders', `/api/orders?branch=${OURS()}`, {}],
    ['GET  /tables', `/api/tables?branch=${OURS()}`, {}],
    ['GET  /tables/floor', `/api/tables/floor?branch=${OURS()}`, {}],
    ['GET  /inventory', `/api/inventory?branch=${OURS()}`, {}],
    ['GET  /inventory/balances', `/api/inventory/balances?branch=${OURS()}`, {}],
    ['GET  /inventory/valuation', `/api/inventory/valuation?branch=${OURS()}`, {}],
    ['GET  /stock-counts', `/api/stock-counts?branch=${OURS()}`, {}],
    ['GET  /waste/events', `/api/waste/events?branch=${OURS()}`, {}],
    ['GET  /transfers', `/api/transfers?branch=${OURS()}`, {}],
    ['GET  /reports/pnl', `/api/reports/pnl?branch=${OURS()}`, {}],
    ['GET  /dashboard', `/api/dashboard?branch=${OURS()}`, {}],
    ['POST /tables', '/api/tables', {method: 'POST', body: {branch: OURS(), name: 'Intruder', seats: 4}}],
    ['POST /customers', '/api/customers', {method: 'POST', body: {branch: OURS(), name: 'X', phone: '1'}}]
  ];
}

/** Endpoints addressed by a direct resource id, with no branch parameter. */
function resourceIdTargets() {
  const id = victimOrder._id;
  return [
    ['GET  /orders/:id', `/api/orders/${id}`, {}],
    ['GET  /orders/:id/payments', `/api/orders/${id}/payments`, {}],
    ['GET  /orders/:id/payment-summary', `/api/orders/${id}/payment-summary`, {}],
    ['GET  /orders/:id/receipt', `/api/orders/${id}/receipt`, {}],
    ['POST /orders/:id/payments', `/api/orders/${id}/payments`, {method: 'POST', body: {amount: 1, method: 'cash'}}],
    ['POST /orders/:id/refunds', `/api/orders/${id}/refunds`, {method: 'POST', body: {amount: 1}}],
    ['PATCH /orders/:id/status', `/api/orders/${id}/status`, {method: 'PATCH', body: {status: 'accepted'}}],
    ['PATCH /orders/:id/priority', `/api/orders/${id}/priority`, {method: 'PATCH', body: {priority: 'rush'}}],
    ['POST /orders/:id/split', `/api/orders/${id}/split`, {method: 'POST', body: {items: [{itemId: String(victimOrder.items[0]._id), qty: 1}]}}],
    ['POST /deliveries', '/api/deliveries', {method: 'POST', body: {order: String(id), address: 'Rival St'}}]
  ];
}

async function assertAllDenied(token, targets, label) {
  const leaks = [];
  for (const [name, path, opts] of targets) {
    const res = await request(path, {token, ...opts});
    if (!DENIED.has(res.status)) leaks.push(`${name} -> ${res.status}`);
  }
  assert.deepEqual(leaks, [], `${label} must be denied everywhere, leaked: ${leaks.join(' | ')}`);
}

// ── Cross-restaurant denial, every role ──────────────────────────────────────
describe('Phase 6A.1 — owner of another restaurant is denied', () => {
  it('cannot reach any branch-scoped endpoint', async () => {
    await assertAllDenied(tokenFor(rival.owner), branchScopedTargets(), 'rival owner (branch id)');
  });

  it('cannot reach a resource by its direct id', async () => {
    await assertAllDenied(tokenFor(rival.owner), resourceIdTargets(), 'rival owner (resource id)');
  });

  it('cannot mutate our table by id', async () => {
    const table = await RestaurantTable.findOne({branch: world.branchA._id});
    const token = tokenFor(rival.owner);
    assert.ok(DENIED.has((await request(`/api/tables/${table._id}/status`, {
      method: 'PATCH', token, body: {status: 'occupied'}
    })).status));
    assert.ok(DENIED.has((await request(`/api/tables/${table._id}`, {
      method: 'PATCH', token, body: {seats: 99}
    })).status));
    assert.ok(DENIED.has((await request(`/api/tables/${table._id}`, {method: 'DELETE', token})).status));
  });
});

describe('Phase 6A.1 — manager and staff of another restaurant are denied', () => {
  it('rival manager is denied everywhere', async () => {
    await assertAllDenied(tokenFor(rival.manager), branchScopedTargets(), 'rival manager');
    await assertAllDenied(tokenFor(rival.manager), resourceIdTargets(), 'rival manager (resource id)');
  });

  it('rival staff is denied everywhere', async () => {
    // Staff lack the role for some endpoints; either way nothing may succeed.
    await assertAllDenied(tokenFor(rival.staff), branchScopedTargets(), 'rival staff');
    await assertAllDenied(tokenFor(rival.staff), resourceIdTargets(), 'rival staff (resource id)');
  });
});

// ── Unscoped listings must not spill across tenants ──────────────────────────
describe('Phase 6A.1 — list endpoints without a branch parameter', () => {
  it('returns only the caller’s own restaurant data', async () => {
    await Customer.create({branch: world.branchA._id, name: 'Our Guest', phone: '9800000001'});
    await Customer.create({branch: rival.branch._id, name: 'Their Guest', phone: '9800000002'});

    const ours = await request('/api/customers', {token: tokenFor(world.owner)});
    assert.equal(ours.status, 200);
    assert.ok(ours.body.every(c => c.name !== 'Their Guest'), 'must not see the rival customer');
    assert.ok(ours.body.some(c => c.name === 'Our Guest'));

    const theirs = await request('/api/customers', {token: tokenFor(rival.owner)});
    assert.equal(theirs.status, 200);
    assert.ok(theirs.body.every(c => c.name !== 'Our Guest'), 'rival must not see ours');
  });

  it('scopes orders and deliveries to the caller’s restaurant', async () => {
    const rivalOrders = await request('/api/orders', {token: tokenFor(rival.owner)});
    assert.equal(rivalOrders.status, 200);
    assert.equal(rivalOrders.body.length, 0, 'rival has no orders of their own');

    const ourOrders = await request('/api/orders', {token: tokenFor(world.owner)});
    assert.ok(ourOrders.body.length >= 1);

    const rivalDeliveries = await request('/api/deliveries', {token: tokenFor(rival.owner)});
    assert.equal(rivalDeliveries.status, 200);
    assert.equal(rivalDeliveries.body.length, 0);
  });

  it('confines a non-owner to their assigned branch', async () => {
    const staffOrders = await request('/api/orders', {token: tokenFor(world.staffA)});
    assert.equal(staffOrders.status, 200);
    assert.ok(staffOrders.body.every(o => String(o.branch) === String(world.branchA._id)));
  });
});

// ── Legitimate access must be preserved ──────────────────────────────────────
describe('Phase 6A.1 — legitimate permissions are unchanged', () => {
  it('our owner reaches every branch of their own restaurant', async () => {
    for (const branch of [world.branchA, world.branchB]) {
      for (const path of ['/api/kitchen/board', '/api/tables', '/api/tables/floor', '/api/dashboard']) {
        const res = await request(`${path}?branch=${branch._id}`, {token: tokenFor(world.owner)});
        assert.equal(res.status, 200, `${path} @ ${branch.name}: ${res.body?.message}`);
      }
    }
  });

  it('our manager keeps their own branch and is refused the other', async () => {
    assert.equal((await request(`/api/kitchen/board?branch=${world.branchA._id}`,
      {token: tokenFor(world.manager)})).status, 200);
    assert.equal((await request(`/api/kitchen/board?branch=${world.branchB._id}`,
      {token: tokenFor(world.manager)})).status, 403);
  });

  it('our staff keeps branch-level operations', async () => {
    assert.equal((await request(`/api/kitchen/orders?branch=${world.branchA._id}`,
      {token: tokenFor(world.staffA)})).status, 200);
    assert.equal((await request(`/api/orders/${victimOrder._id}`,
      {token: tokenFor(world.staffA)})).status, 200);
    // ...but role limits still apply.
    assert.equal((await request(`/api/kitchen/performance?branch=${world.branchA._id}`,
      {token: tokenFor(world.staffA)})).status, 403);
  });

  it('our staff can still take a payment and our manager can still refund', async () => {
    const paid = await request(`/api/orders/${victimOrder._id}/payments`, {
      method: 'POST', token: tokenFor(world.staffA), body: {amount: victimOrder.total, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    const refunded = await request(`/api/orders/${victimOrder._id}/refunds`, {
      // Phase 12 made a refund reason mandatory.
      method: 'POST', token: tokenFor(world.manager), body: {amount: 10, reason: 'Tenant control check'}
    });
    assert.equal(refunded.status, 201, refunded.body?.message);
  });
});

// ── JWT vs authorization ─────────────────────────────────────────────────────
describe('Phase 6A.1 — JWT validity is not authorization', () => {
  it('rejects missing, malformed, expired and wrongly-signed tokens', async () => {
    const url = `/api/kitchen/board?branch=${OURS()}`;
    assert.equal((await request(url)).status, 401);
    assert.equal((await request(url, {token: 'not-a-jwt'})).status, 401);
    assert.equal((await request(url, {
      token: jwt.sign({id: world.owner._id, role: 'owner'}, process.env.JWT_SECRET, {expiresIn: '-1s'})
    })).status, 401);
    assert.equal((await request(url, {
      token: jwt.sign({id: world.owner._id, role: 'owner'}, 'attacker-secret')
    })).status, 401);
  });

  it('a perfectly valid token for another restaurant is still refused', async () => {
    const token = tokenFor(rival.owner);
    // The signature is genuine — only the tenant boundary stops it.
    assert.doesNotThrow(() => jwt.verify(token, process.env.JWT_SECRET));
    assert.equal((await request(`/api/kitchen/board?branch=${OURS()}`, {token})).status, 403);
  });

  it('a forged restaurantId claim does not grant access', async () => {
    // Server-side lookup wins over whatever the token asserts.
    const forged = jwt.sign(
      {id: rival.owner._id, name: 'Rival', role: 'owner', restaurantId: world.restaurant._id, branch: world.branchA._id},
      process.env.JWT_SECRET
    );
    const res = await request(`/api/kitchen/board?branch=${OURS()}`, {token: forged});
    assert.ok(DENIED.has(res.status), `forged claim leaked: ${res.status}`);
  });

  it('rejects an unknown role', async () => {
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request(`/api/kitchen/board?branch=${OURS()}`, {token: guest})).status, 403);
  });
});

// ── Socket.IO ────────────────────────────────────────────────────────────────
describe('Phase 6A.1 — Socket.IO tenant isolation', () => {
  function connect(token, branch) {
    return new Promise((resolve, reject) => {
      const socket = clientIo(baseUrl, {
        auth: {token, ...(branch ? {branch} : {})},
        transports: ['websocket'], reconnection: false, timeout: 4000
      });
      const timer = setTimeout(() => { socket.close(); reject(new Error('connect timeout')); }, 4000);
      socket.on('connect', () => { clearTimeout(timer); sockets.push(socket); resolve(socket); });
      socket.on('connect_error', err => { clearTimeout(timer); reject(err); });
    });
  }
  const join = (socket, branchId) =>
    new Promise(resolve => socket.emit('join:branch', String(branchId), resolve));

  it('refuses a cross-restaurant handshake for every role', async () => {
    for (const user of [rival.owner, rival.manager, rival.staff]) {
      await assert.rejects(
        () => connect(tokenFor(user), OURS()),
        err => {
          assert.match(err.message, /does not belong to the user restaurant|Branch access denied/i);
          return true;
        },
        `${user.name} should not complete a handshake on our branch`
      );
    }
  });

  it('refuses join:branch across restaurants', async () => {
    for (const user of [rival.owner, rival.manager, rival.staff]) {
      const socket = await connect(tokenFor(user));
      const ack = await join(socket, OURS());
      assert.equal(ack.ok, false, `${user.name} joined our room`);
      assert.equal(ack.status, 403);
    }
  });

  it('delivers no kitchen, table or purchasing events to another restaurant', async () => {
    const intruder = await connect(tokenFor(rival.owner));
    await join(intruder, OURS()); // refused, but listen anyway
    const heard = [];
    for (const event of ['kitchen:new-order', 'kitchen:status', 'table:update', 'purchasing:update', 'inventory:update']) {
      intruder.on(event, payload => heard.push({event, payload}));
    }

    // Generate real activity on our branch.
    const order = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.owner),
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(order.status, 201, order.body?.message);
    const table = await RestaurantTable.findOne({branch: world.branchA._id});
    await request(`/api/tables/${table._id}/status`, {
      method: 'PATCH', token: tokenFor(world.staffA), body: {status: 'occupied'}
    });
    await new Promise(r => setTimeout(r, 500));

    assert.deepEqual(heard, [], `rival received ${heard.length} event(s): ${heard.map(h => h.event).join(', ')}`);
  });

  it('still delivers to a legitimate user of the branch', async () => {
    const insider = await connect(tokenFor(world.staffA));
    const ack = await join(insider, OURS());
    assert.equal(ack.ok, true, 'our own staff must still join');

    const heard = [];
    insider.on('kitchen:new-order', p => heard.push(p));
    const order = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.owner),
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(order.status, 201, order.body?.message);
    await new Promise(r => setTimeout(r, 400));
    assert.equal(heard.length, 1, 'legitimate delivery must be unaffected');
  });
});

// ── Guard unit behaviour ─────────────────────────────────────────────────────
describe('Phase 6A.1 — assertTenantBranchAccess', () => {
  it('allows an owner inside their own restaurant and blocks outside it', async () => {
    const {assertTenantBranchAccess} = await import('../src/services/kitchen.js');
    await assertTenantBranchAccess(
      {id: String(world.owner._id), role: 'owner'}, world.branchB._id
    );
    await assert.rejects(
      () => assertTenantBranchAccess({id: String(rival.owner._id), role: 'owner'}, world.branchA._id),
      /does not belong to the user restaurant/
    );
  });

  it('keeps a non-owner pinned to their assigned branch', async () => {
    const {assertTenantBranchAccess} = await import('../src/services/kitchen.js');
    await assert.rejects(
      () => assertTenantBranchAccess(
        {id: String(world.staffA._id), role: 'staff', branch: String(world.branchA._id)},
        world.branchB._id
      ),
      /Branch access denied/
    );
  });

  it('validates the branch id and its existence', async () => {
    const {assertTenantBranchAccess} = await import('../src/services/kitchen.js');
    const user = {id: String(world.owner._id), role: 'owner'};
    await assert.rejects(() => assertTenantBranchAccess(user, 'not-an-id'), /Invalid branch/);
    await assert.rejects(
      () => assertTenantBranchAccess(user, new mongoose.Types.ObjectId()),
      /Branch not found/
    );
  });
});
