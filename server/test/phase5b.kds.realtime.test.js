import {describe, it, before, after, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {io as clientIo} from 'socket.io-client';
import {User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {branchRoom} from '../src/services/realtime.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let baseUrl;
const open = [];

function closeAll() {
  while (open.length) {
    const socket = open.pop();
    socket.removeAllListeners();
    socket.disconnect();
    socket.close();
  }
}

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => {
  // Sockets must be closed before the server, or the event loop stays alive.
  closeAll();
  await new Promise(r => setTimeout(r, 100));
  await stopTestApp();
});
beforeEach(async () => {
  closeAll();
  await clearDb();
  world = await seedWorld();
});
afterEach(() => { closeAll(); });

function connect(token, branch, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(baseUrl, {
      auth: {token, ...(branch ? {branch} : {}), ...extra},
      transports: ['websocket'],
      reconnection: false,
      timeout: 4000
    });
    const timer = setTimeout(() => { socket.close(); reject(new Error('connect timeout')); }, 4000);
    socket.on('connect', () => { clearTimeout(timer); open.push(socket); resolve(socket); });
    socket.on('connect_error', err => { clearTimeout(timer); reject(err); });
  });
}

const join = (socket, branchId) =>
  new Promise(resolve => socket.emit('join:branch', branchId, resolve));
const leave = (socket, branchId) =>
  new Promise(resolve => socket.emit('leave:branch', branchId, resolve));

/** Collects events for a window; listeners are attached before the trigger. */
async function collect(sockets, event, trigger, settle = 350) {
  const seen = sockets.map(() => []);
  sockets.forEach((s, i) => s.on(event, p => seen[i].push(p)));
  const result = await trigger();
  await new Promise(r => setTimeout(r, settle));
  sockets.forEach(s => s.off(event));
  return {seen, result};
}

const createOrder = (branch = world.branchA, token = tokenFor(world.owner)) =>
  request('/api/orders', {
    method: 'POST', token,
    body: {branch: String(branch._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
  });

// ── Room naming ──────────────────────────────────────────────────────────────
describe('Phase 5B — branch room naming', () => {
  it('uses branch:<id>', () => {
    assert.equal(branchRoom('abc123'), 'branch:abc123');
    assert.equal(branchRoom(world.branchA._id), `branch:${world.branchA._id}`);
  });
});

// ── kitchen:new-order ────────────────────────────────────────────────────────
describe('Phase 5B — kitchen:new-order', () => {
  it('reaches the order branch and no other', async () => {
    const a = await connect(tokenFor(world.staffA));
    const b = await connect(tokenFor(world.staffB));
    assert.equal((await join(a, world.branchA._id)).ok, true);
    assert.equal((await join(b, world.branchB._id)).ok, true);

    const {seen, result} = await collect([a, b], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(result.status, 201, result.body?.message);
    assert.equal(seen[0].length, 1, 'branch A must receive its ticket');
    assert.equal(seen[1].length, 0, 'branch B must not see it');
    assert.equal(seen[0][0].order.orderNo, result.body.orderNo);
    assert.equal(String(seen[0][0].order.branch), String(world.branchA._id));
    assert.equal(seen[0][0].order.status, 'pending');
  });

  it('fires on a bill split, which creates a second ticket', async () => {
    const created = await request('/api/orders', {
      method: 'POST', token: tokenFor(world.owner),
      body: {branch: String(world.branchA._id), type: 'dine-in', table: String(world.table._id),
        items: [{menuItem: String(world.menu._id), qty: 2}]}
    });
    assert.equal(created.status, 201, created.body?.message);
    const a = await connect(tokenFor(world.staffA));
    await join(a, world.branchA._id);

    const line = created.body.items[0];
    const {seen} = await collect([a], 'kitchen:new-order', () =>
      request(`/api/orders/${created.body._id}/split`, {
        method: 'POST', token: tokenFor(world.staffA), body: {items: [{itemId: String(line._id), qty: 1}]}
      }));
    assert.equal(seen[0].length, 1, 'the split ticket is announced to the kitchen');
  });
});

// ── kitchen:status ───────────────────────────────────────────────────────────
describe('Phase 5B — kitchen:status', () => {
  it('broadcasts each stage transition to the branch only', async () => {
    const created = await createOrder(world.branchA);
    const a = await connect(tokenFor(world.staffA));
    const b = await connect(tokenFor(world.staffB));
    await join(a, world.branchA._id);
    await join(b, world.branchB._id);

    for (const status of ['accepted', 'preparing', 'ready']) {
      const {seen, result} = await collect([a, b], 'kitchen:status', () =>
        request(`/api/orders/${created.body._id}/status`, {
          method: 'PATCH', token: tokenFor(world.owner), body: {status}
        }));
      assert.equal(result.status, 200, result.body?.message);
      assert.equal(seen[0].length, 1, `branch A missed ${status}`);
      assert.equal(seen[0][0].order.status, status);
      assert.equal(seen[1].length, 0, `branch B leaked ${status}`);
    }
  });

  it('carries the previous status so a board can reconcile', async () => {
    const created = await createOrder(world.branchA);
    const a = await connect(tokenFor(world.staffA));
    await join(a, world.branchA._id);
    const {seen} = await collect([a], 'kitchen:status', () =>
      request(`/api/orders/${created.body._id}/status`, {
        method: 'PATCH', token: tokenFor(world.owner), body: {status: 'accepted'}
      }));
    assert.equal(seen[0][0].previousStatus, 'pending');
  });

  it('fires when a ticket is flagged rush', async () => {
    const created = await createOrder(world.branchA);
    const a = await connect(tokenFor(world.staffA));
    await join(a, world.branchA._id);
    const {seen} = await collect([a], 'kitchen:status', () =>
      request(`/api/orders/${created.body._id}/priority`, {
        method: 'PATCH', token: tokenFor(world.staffA), body: {priority: 'rush'}
      }));
    assert.equal(seen[0].length, 1);
    assert.equal(seen[0][0].order.priority, 'rush');
  });

  it('fires on payment settlement', async () => {
    const created = await createOrder(world.branchA);
    const a = await connect(tokenFor(world.staffA));
    await join(a, world.branchA._id);
    const {seen} = await collect([a], 'kitchen:status', () =>
      request(`/api/orders/${created.body._id}/payments`, {
        method: 'POST', token: tokenFor(world.staffA),
        body: {amount: created.body.total, method: 'cash'}
      }));
    assert.equal(seen[0].length, 1);
    assert.equal(seen[0][0].order.status, 'completed');
  });
});

// ── Authorization ────────────────────────────────────────────────────────────
describe('Phase 5B — no unauthorized branch access', () => {
  it('refuses a connection with no, malformed or expired token', async () => {
    await assert.rejects(() => connect(undefined), /Authentication required/i);
    await assert.rejects(() => connect('not-a-jwt'), /Authentication required/i);
    const expired = jwt.sign({id: world.staffA._id, role: 'staff'}, process.env.JWT_SECRET, {expiresIn: '-1s'});
    await assert.rejects(() => connect(expired), /Authentication required/i);
  });

  it('refuses a token signed with the wrong secret', async () => {
    const forged = jwt.sign({id: world.owner._id, role: 'owner'}, 'attacker-secret');
    await assert.rejects(() => connect(forged), /Authentication required/i);
  });

  it('refuses a role outside the kitchen roles', async () => {
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    await assert.rejects(() => connect(guest), /Insufficient permission/i);
  });

  it('refuses a handshake naming another branch', async () => {
    await assert.rejects(
      () => connect(tokenFor(world.staffA), String(world.branchB._id)),
      /Branch access denied/i
    );
  });

  it('refuses joining another branch, and delivers nothing to the refused room', async () => {
    const socket = await connect(tokenFor(world.staffA));
    const denied = await join(socket, world.branchB._id);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);

    const {seen} = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchB));
    assert.equal(seen[0].length, 0, 'a refused join must not deliver events');
  });

  it('refuses a branch belonging to another restaurant', async () => {
    const other = await Restaurant.create({name: 'Other Co', currency: 'NPR', vatRate: 13});
    const foreign = await Branch.create({restaurant: other._id, name: 'Foreign', code: 'FGN'});
    const socket = await connect(tokenFor(world.owner));
    const ack = await join(socket, String(foreign._id));
    assert.equal(ack.ok, false);
    assert.equal(ack.status, 403);
  });

  it('rejects a missing or malformed branch id', async () => {
    const socket = await connect(tokenFor(world.owner));
    assert.equal((await join(socket, null)).ok, false);
    assert.equal((await join(socket, 'not-an-id')).ok, false);
  });

  it('joining a second branch leaves the first', async () => {
    const socket = await connect(tokenFor(world.owner));
    assert.equal((await join(socket, world.branchA._id)).ok, true);
    assert.equal((await join(socket, world.branchB._id)).ok, true);

    const {seen} = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(seen[0].length, 0, 'the previous room must be left on re-join');

    const second = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchB));
    assert.equal(second.seen[0].length, 1, 'the current room still delivers');
  });

  it('stops delivering after leave:branch, and resumes on re-join', async () => {
    const socket = await connect(tokenFor(world.staffA));
    await join(socket, world.branchA._id);
    assert.equal((await leave(socket, world.branchA._id)).ok, true);

    const gone = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(gone.seen[0].length, 0);

    await join(socket, world.branchA._id);
    const back = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(back.seen[0].length, 1);
  });
});

// ── Revoked access on a live socket (the gap this phase closed) ──────────────
describe('Phase 5B — revoked access on an open socket', () => {
  it('stops delivering once the user is reassigned to another branch', async () => {
    const socket = await connect(tokenFor(world.staffA));
    assert.equal((await join(socket, world.branchA._id)).ok, true);

    // Control: the room genuinely delivers before anything is revoked.
    const control = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(control.seen[0].length, 1, 'control failed — the room was never live');

    // The cook is moved to another branch while their socket stays open.
    await User.updateOne({_id: world.staffA._id}, {$set: {branch: world.branchB._id}});

    const after = await collect([socket], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(after.seen[0].length, 0, 'a reassigned user must stop receiving the old branch');
  });

  it('tells the client its access was revoked', async () => {
    const socket = await connect(tokenFor(world.staffA));
    await join(socket, world.branchA._id);
    await User.updateOne({_id: world.staffA._id}, {$set: {branch: world.branchB._id}});

    const {seen} = await collect([socket], 'branch:revoked', () => createOrder(world.branchA));
    assert.equal(seen[0].length, 1);
    assert.equal(String(seen[0][0].branch), String(world.branchA._id));
  });

  it('keeps delivering to users whose access is unchanged', async () => {
    const staff = await connect(tokenFor(world.staffA));
    const owner = await connect(tokenFor(world.owner));
    await join(staff, world.branchA._id);
    await join(owner, world.branchA._id);

    // Revoke only the staff member.
    await User.updateOne({_id: world.staffA._id}, {$set: {branch: world.branchB._id}});

    const {seen} = await collect([staff, owner], 'kitchen:new-order', () => createOrder(world.branchA));
    assert.equal(seen[0].length, 0, 'revoked staff must be evicted');
    assert.equal(seen[1].length, 1, 'the owner must be unaffected');
  });
});
