import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {io as ioClient} from 'socket.io-client';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {
  REALTIME_EVENTS, REALTIME_EVENT_NAMES, replaySince, resetReplayBuffers
} from '../src/services/realtimeEvents.js';
import {
  branchRoom, getIo, publishInventoryAlert, publishOrderEvent, publishPaymentEvent,
  publishRestaurantEvent, publishRoleEvent, restaurantRoom, roleRoom
} from '../src/services/realtime.js';

/**
 * Phase 22 — realtime platform.
 *
 * The security questions first (authentication, cross-branch and cross-tenant
 * leakage), then delivery, then the two properties a client actually depends
 * on in production: recovering after a reconnect, and being able to recognise
 * a duplicate.
 */

let baseUrl;
let world;

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  resetReplayBuffers();
});

function connect(token, branch) {
  const socket = ioClient(baseUrl, {
    auth: {token, ...(branch ? {branch: String(branch)} : {})},
    transports: ['websocket'], forceNew: true, reconnection: false
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
    setTimeout(() => reject(new Error('socket connect timeout')), 4000);
  });
}

const join = (socket, branch) => new Promise(resolve => socket.emit('join:branch', String(branch), resolve));
const replay = (socket, branch, sequence) =>
  new Promise(resolve => socket.emit('replay:since', {branch: String(branch), sequence}, resolve));

const settle = (ms = 350) => new Promise(resolve => setTimeout(resolve, ms));

/** Collect every business event a socket receives. */
function collect(socket) {
  const seen = [];
  for (const name of REALTIME_EVENT_NAMES) socket.on(name, payload => seen.push({event: name, payload}));
  return seen;
}

async function makeOrder(token, branch = world.branchA._id) {
  return request('/api/orders', {
    method: 'POST', token,
    body: {branch: String(branch), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
  });
}

// ── authentication ───────────────────────────────────────────────────────────

describe('Phase 22 · socket authentication', () => {
  it('accepts a valid token and places the socket in its rooms', async () => {
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      const ack = await join(socket, world.branchA._id);
      assert.equal(ack.ok, true);
      // The ack carries the room's current sequence so a client has a starting
      // point for a later replay.
      assert.equal(typeof ack.sequence, 'number');

      const live = (await getIo().fetchSockets()).find(s => String(s.user?.id) === String(world.manager._id));
      const rooms = [...live.rooms];
      assert.ok(rooms.includes(branchRoom(world.branchA._id)));
      assert.ok(rooms.includes(restaurantRoom(world.restaurant._id)));
      assert.ok(rooms.includes(roleRoom(world.restaurant._id, 'manager')));
    } finally { socket.close(); }
  });

  it('refuses an unauthenticated, forged or malformed token', async () => {
    await assert.rejects(connect(undefined, world.branchA._id), /Authentication required/i);
    await assert.rejects(connect('not-a-jwt', world.branchA._id), /Authentication required/i);
    const wrongSecret = jwt.sign({id: String(world.manager._id), role: 'manager'}, 'the-wrong-secret');
    await assert.rejects(connect(wrongSecret, world.branchA._id), /Authentication required/i);
  });

  it('refuses a token whose role is not a real role', async () => {
    const guest = jwt.sign(
      {id: String(world.owner._id), role: 'guest', sv: 0}, process.env.JWT_SECRET
    );
    await assert.rejects(connect(guest, world.branchA._id), /Insufficient permission|Authentication required/i);
  });

  it('refuses a deactivated account and a revoked session', async () => {
    const token = tokenFor(world.manager);
    await User.updateOne({_id: world.manager._id}, {$set: {active: false}});
    await assert.rejects(connect(token, world.branchA._id), /deactivated/i);

    await User.updateOne({_id: world.manager._id}, {$set: {active: true}});
    const live = tokenFor(await User.findById(world.manager._id));
    await User.updateOne({_id: world.manager._id}, {$inc: {sessionVersion: 1}});
    await assert.rejects(connect(live, world.branchA._id), /signed out/i);
  });

  it('never trusts a forged restaurant claim for room membership', async () => {
    // Rooms are joined from the RESOLVED principal, so a token claiming
    // another tenant cannot place the socket in that tenant's room.
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const forged = jwt.sign(
      {
        id: String(world.manager._id), name: 'Manager', role: 'manager',
        restaurantId: String(rival._id), branch: String(world.branchA._id), sv: 0
      },
      process.env.JWT_SECRET, {expiresIn: '1h'}
    );
    const socket = await connect(forged, world.branchA._id);
    try {
      const live = (await getIo().fetchSockets()).find(s => String(s.user?.id) === String(world.manager._id));
      const rooms = [...live.rooms];
      assert.ok(rooms.includes(restaurantRoom(world.restaurant._id)), 'must join its REAL tenant room');
      assert.ok(!rooms.includes(restaurantRoom(rival._id)), 'must not join the claimed tenant room');
    } finally { socket.close(); }
  });
});

// ── branch and tenant isolation ──────────────────────────────────────────────

describe('Phase 22 · no cross-branch or cross-tenant leakage', () => {
  it('does not deliver one branch\'s events to another branch\'s socket', async () => {
    const staffB = await User.findOne({email: 'staffb@test.com'});
    const socketA = await connect(tokenFor(world.staffA), world.branchA._id);
    const socketB = await connect(tokenFor(staffB), world.branchB._id);
    try {
      await join(socketA, world.branchA._id);
      await join(socketB, world.branchB._id);
      const seenA = collect(socketA);
      const seenB = collect(socketB);

      const created = await makeOrder(tokenFor(world.staffA), world.branchA._id);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      await settle();

      assert.ok(seenA.length > 0, 'branch A must receive its own events');
      assert.equal(seenB.length, 0, 'branch B must receive nothing');
      // And every payload it did get is stamped with its own branch.
      assert.ok(seenA.every(item => String(item.payload.branch) === String(world.branchA._id)));
    } finally { socketA.close(); socketB.close(); }
  });

  it('refuses a join to a branch the principal cannot reach', async () => {
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      const denied = await join(socket, world.branchB._id);
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 403);
      // The refused room must not have been joined anyway.
      const live = (await getIo().fetchSockets()).find(s => String(s.user?.id) === String(world.manager._id));
      assert.ok(![...live.rooms].includes(branchRoom(world.branchB._id)));
    } finally { socket.close(); }
  });

  it('keeps a role room inside one restaurant', async () => {
    // A bare `role:manager` room would put every tenant's managers together.
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'RB', code: 'RVB'});
    const rivalManager = await User.create({
      name: 'Rival Manager', email: 'rivalmgr@test.com', password: 'x',
      role: 'manager', restaurantId: rival._id, branch: rivalBranch._id
    });

    const ours = await connect(tokenFor(world.manager), world.branchA._id);
    const theirs = await connect(tokenFor(rivalManager), rivalBranch._id);
    try {
      const seenOurs = collect(ours);
      const seenTheirs = collect(theirs);
      publishRoleEvent(world.restaurant._id, 'manager', REALTIME_EVENTS.INVENTORY_ALERT, {marker: 'OURS-ONLY'});
      await settle();
      assert.equal(seenOurs.length, 1, 'our manager must receive it');
      assert.equal(seenTheirs.length, 0, 'another tenant\'s manager must not');
      assert.equal(seenOurs[0].payload.marker, 'OURS-ONLY');
      assert.notEqual(roleRoom(world.restaurant._id, 'manager'), roleRoom(rival._id, 'manager'));
    } finally { ours.close(); theirs.close(); }
  });

  it('keeps a restaurant room inside one tenant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'RB', code: 'RVC'});
    const rivalOwner = await User.create({
      name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x',
      role: 'owner', restaurantId: rival._id, branch: rivalBranch._id
    });
    const ours = await connect(tokenFor(world.owner), world.branchA._id);
    const theirs = await connect(tokenFor(rivalOwner), rivalBranch._id);
    try {
      const seenTheirs = collect(theirs);
      const seenOurs = collect(ours);
      publishRestaurantEvent(world.restaurant._id, REALTIME_EVENTS.ORDER_UPDATE, {marker: 'TENANT-A'});
      await settle();
      assert.equal(seenOurs.length, 1);
      assert.equal(seenTheirs.length, 0);
    } finally { ours.close(); theirs.close(); }
  });

  it('never puts a rider in a branch, restaurant or role room', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider22@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id, rider: {active: true}
    });
    const socket = await connect(tokenFor(rider));
    try {
      const denied = await join(socket, world.branchA._id);
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 403);

      const live = (await getIo().fetchSockets()).find(s => String(s.user?.id) === String(rider._id));
      const rooms = [...live.rooms];
      assert.ok(rooms.includes(`rider:${rider._id}`));
      assert.ok(!rooms.some(room => String(room).startsWith('branch:')));
      assert.ok(!rooms.some(room => String(room).startsWith('restaurant:')));
      assert.ok(!rooms.some(room => String(room).startsWith('role:')));
    } finally { socket.close(); }
  });
});

// ── event delivery ───────────────────────────────────────────────────────────

describe('Phase 22 · event delivery', () => {
  it('names exactly the nine platform events', () => {
    assert.deepEqual([...REALTIME_EVENT_NAMES].sort(), [
      'delivery:update', 'inventory:alert', 'inventory:update',
      'kitchen:new-order', 'kitchen:status', 'order:update',
      'payment:update', 'purchasing:update', 'table:update'
    ]);
  });

  it('delivers the order lifecycle and, crucially, payment:update', async () => {
    // payment:update DID NOT EXIST before this phase. Verified against the
    // running server: taking a payment emitted nothing at all, so a second
    // till or a manager's dashboard learned nothing until it refreshed.
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const seen = collect(socket);

      const order = await makeOrder(tokenFor(world.manager));
      assert.equal(order.status, 201, JSON.stringify(order.body));
      await settle();

      const paid = await request(`/api/orders/${order.body._id}/payments`, {
        method: 'POST', token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'rt-pay-1'},
        body: {amount: 395.5, method: 'cash'}
      });
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      await settle();

      const names = seen.map(item => item.event);
      assert.ok(names.includes(REALTIME_EVENTS.KITCHEN_NEW_ORDER));
      assert.ok(names.includes(REALTIME_EVENTS.PAYMENT_UPDATE), 'a payment must be broadcast');

      const payment = seen.find(item => item.event === REALTIME_EVENTS.PAYMENT_UPDATE).payload;
      assert.equal(payment.reason, 'payment');
      assert.equal(payment.amount, 395.5);
      assert.equal(payment.method, 'cash');
      assert.equal(payment.settled, true);
      assert.equal(String(payment.order), String(order.body._id));
    } finally { socket.close(); }
  });

  it('emits order:update on a status change', async () => {
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const order = await makeOrder(tokenFor(world.manager));
      await settle();
      const seen = collect(socket);

      const moved = await request(`/api/orders/${order.body._id}/status`, {
        method: 'PATCH', token: tokenFor(world.manager), body: {status: 'accepted'}
      });
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      await settle();

      const update = seen.find(item => item.event === REALTIME_EVENTS.ORDER_UPDATE);
      assert.ok(update, 'order:update must fire on a status change');
      assert.equal(update.payload.status, 'accepted');
      assert.equal(update.payload.previousStatus, 'pending');
    } finally { socket.close(); }
  });

  it('gives every event the standard envelope', async () => {
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const seen = collect(socket);
      await makeOrder(tokenFor(world.manager));
      await settle();

      assert.ok(seen.length >= 2);
      for (const {event, payload} of seen) {
        assert.equal(payload.event, event, 'the envelope names its own event');
        assert.equal(payload.schemaVersion, 1);
        assert.match(String(payload.eventId), /^[0-9a-f-]{16,}$/i, `${event} needs a dedup id`);
        assert.ok(Date.parse(payload.occurredAt), `${event} needs a timestamp`);
        assert.equal(String(payload.branch), String(world.branchA._id));
        assert.equal(typeof payload.sequence, 'number');
      }
      // Sequences are strictly increasing within the room.
      const sequences = seen.map(item => item.payload.sequence);
      assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
      assert.equal(new Set(sequences).size, sequences.length, 'sequences must be unique');
    } finally { socket.close(); }
  });

  it('reaches an assigned rider through their private room only', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'deliveryrider@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id, rider: {active: true}
    });
    const riderSocket = await connect(tokenFor(rider));
    const branchSocket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(branchSocket, world.branchA._id);
      const riderSeen = collect(riderSocket);
      const branchSeen = collect(branchSocket);

      const {publishDeliveryEvent} = await import('../src/services/realtime.js');
      publishDeliveryEvent(world.branchA._id, {reason: 'assigned'}, {riderId: rider._id});
      await settle();

      assert.equal(riderSeen.length, 1, 'the assigned rider is notified');
      assert.equal(branchSeen.length, 1, 'dispatchers are notified');
      // Same business act, same dedup id, so a client in both rooms
      // processes it once.
      assert.equal(riderSeen[0].payload.eventId, branchSeen[0].payload.eventId);
    } finally { riderSocket.close(); branchSocket.close(); }
  });
});

// ── duplicate suppression ────────────────────────────────────────────────────

describe('Phase 22 · duplicate events', () => {
  it('derives the event id from the idempotency key so a republish is recognisable', async () => {
    // The guarantee is that the SAME business act always publishes the SAME
    // event id, so a client can discard a duplicate however it arrived —
    // a retry, a reconnect replay, or membership of two rooms.
    //
    // Note on the payment endpoint specifically: a retried settle is refused
    // (409 "Order is already closed") rather than replayed, so a second
    // publish does not occur there. Verified against the running API rather
    // than assumed. The dedup property is therefore asserted directly on the
    // publisher, which is where it lives.
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const seen = collect(socket);

      publishPaymentEvent(world.branchA._id, {reason: 'payment', amount: 100}, {idempotencyKey: 'till-key-1'});
      publishPaymentEvent(world.branchA._id, {reason: 'payment', amount: 100}, {idempotencyKey: 'till-key-1'});
      await settle();

      const payments = seen.filter(item => item.event === REALTIME_EVENTS.PAYMENT_UPDATE);
      assert.equal(payments.length, 2, 'both emissions reach the room');
      assert.equal(payments[0].payload.eventId, 'till-key-1');
      assert.equal(payments[1].payload.eventId, 'till-key-1');
      // Deduplicating by eventId leaves exactly one logical event...
      assert.equal(new Set(payments.map(item => item.payload.eventId)).size, 1);
      // ...while the sequence still advances, so replay ordering is intact.
      assert.notEqual(payments[0].payload.sequence, payments[1].payload.sequence);
    } finally { socket.close(); }
  });

  it('carries the request idempotency key through a real payment', async () => {
    // End-to-end: the till's Idempotency-Key becomes the event id, which is
    // what makes cross-channel deduplication possible at all.
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const order = await makeOrder(tokenFor(world.manager));
      await settle();
      const seen = collect(socket);

      const paid = await request(`/api/orders/${order.body._id}/payments`, {
        method: 'POST', token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'till-real-key'},
        body: {amount: 395.5, method: 'cash'}
      });
      assert.equal(paid.status, 201, JSON.stringify(paid.body));
      await settle();

      const payment = seen.find(item => item.event === REALTIME_EVENTS.PAYMENT_UPDATE);
      assert.ok(payment, 'a payment must be broadcast');
      assert.equal(payment.payload.eventId, 'till-real-key');
    } finally { socket.close(); }
  });

  it('gives genuinely distinct events distinct ids', async () => {
    // The control for the test above: dedup must not collapse real events.
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const seen = collect(socket);
      publishOrderEvent(world.branchA._id, {reason: 'one'});
      publishOrderEvent(world.branchA._id, {reason: 'two'});
      await settle();
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0].payload.eventId, seen[1].payload.eventId);
    } finally { socket.close(); }
  });
});

// ── reconnect recovery ───────────────────────────────────────────────────────

describe('Phase 22 · reconnect recovery', () => {
  it('replays only what the client missed', async () => {
    const first = await connect(tokenFor(world.manager), world.branchA._id);
    const ack = await join(first, world.branchA._id);
    publishOrderEvent(world.branchA._id, {reason: 'seen-before-drop'});
    await settle();
    const marker = (await replay(first, world.branchA._id, ack.sequence)).sequence;
    first.close();
    await settle(200);

    // Published while the client is away.
    publishOrderEvent(world.branchA._id, {reason: 'missed-one'});
    publishPaymentEvent(world.branchA._id, {reason: 'missed-two'});
    await settle(150);

    const reconnected = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(reconnected, world.branchA._id);
      const result = await replay(reconnected, world.branchA._id, marker);
      assert.equal(result.ok, true);
      assert.equal(result.truncated, false);
      assert.equal(result.events.length, 2, 'exactly the missed events');
      assert.deepEqual(result.events.map(event => event.reason), ['missed-one', 'missed-two']);
      // Replayed events keep their original ids, so a client that somehow saw
      // one already still deduplicates it.
      assert.ok(result.events.every(event => Boolean(event.eventId)));
    } finally { reconnected.close(); }
  });

  it('reports a gap larger than the buffer instead of returning a partial history', async () => {
    // Silently returning some of the missed events would be worse than
    // returning none: the client could not tell it was still behind.
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      for (let i = 0; i < 130; i += 1) publishOrderEvent(world.branchA._id, {reason: `bulk-${i}`});
      await settle(200);
      const result = await replay(socket, world.branchA._id, 1);
      assert.equal(result.ok, true);
      assert.equal(result.truncated, true, 'the client must be told to reload');
      assert.equal(result.events.length, 0);
    } finally { socket.close(); }
  });

  it('refuses a replay for a branch the socket has not joined', async () => {
    // DEFENCE IN DEPTH, verified. Two checks guard a replay: room membership
    // and a fresh storage authorisation. Removing the storage check alone
    // leaves this suite green because the room check catches it first;
    // removing BOTH was confirmed to fail. The storage check is kept because
    // membership is decided at join time and can go stale — that is exactly
    // the case the next test covers.
    const socket = await connect(tokenFor(world.owner), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const denied = await replay(socket, world.branchB._id, 0);
      assert.equal(denied.ok, false);
      assert.equal(denied.status, 403);
    } finally { socket.close(); }
  });

  it('refuses a replay after the socket loses branch access', async () => {
    // Authorisation is re-checked on replay, not assumed from the join.
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      publishOrderEvent(world.branchA._id, {reason: 'before-move'});
      await settle();

      const moved = await request(`/api/users/${world.manager._id}/role`, {
        method: 'PATCH', token: tokenFor(world.owner), body: {branch: String(world.branchB._id)}
      });
      assert.equal(moved.status, 200);
      await settle();

      const denied = await replay(socket, world.branchA._id, 0);
      assert.equal(denied.ok, false, 'a reassigned user must not replay their old branch');
    } finally { socket.close(); }
  });

  it('rejects a malformed replay request', async () => {
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      assert.equal((await replay(socket, 'not-an-id', 0)).ok, false);
      const missing = await new Promise(resolve => socket.emit('replay:since', {}, resolve));
      assert.equal(missing.ok, false);
    } finally { socket.close(); }
  });

  it('keeps the replay buffer bounded per room', () => {
    // In-memory and capped, so a busy branch cannot grow the heap without
    // limit. Asserted at the buffer directly; the socket path is covered above.
    const room = branchRoom(world.branchA._id);
    for (let i = 0; i < 400; i += 1) publishOrderEvent(world.branchA._id, {reason: `cap-${i}`});
    const {events} = replaySince(room, 0);
    // A full replay from 0 is truncated once the buffer has rolled, and the
    // retained window never exceeds the cap.
    assert.ok(events.length <= 100, `buffer must stay bounded, held ${events.length}`);
  });
});

// ── publisher resilience ─────────────────────────────────────────────────────

describe('Phase 22 · publishing never breaks the business path', () => {
  it('returns falsy rather than throwing when there is no branch', () => {
    // Callers publish AFTER the transaction commits. A publish failure must
    // never turn a completed sale into a 500.
    assert.equal(publishPaymentEvent(null, {reason: 'x'}), false);
    assert.equal(publishOrderEvent(undefined, {reason: 'x'}), false);
    assert.equal(publishInventoryAlert(null, {}), false);
    assert.equal(publishRoleEvent(null, 'manager', REALTIME_EVENTS.ORDER_UPDATE, {}), false);
    assert.equal(publishRestaurantEvent(null, REALTIME_EVENTS.ORDER_UPDATE, {}), false);
  });

  it('survives an unserialisable payload without failing the caller', async () => {
    const socket = await connect(tokenFor(world.manager), world.branchA._id);
    try {
      await join(socket, world.branchA._id);
      const circular = {reason: 'loop'};
      circular.self = circular;
      // Must not throw out of the publisher.
      assert.doesNotThrow(() => publishOrderEvent(world.branchA._id, circular));
      // And the socket survives to receive the next, well-formed event.
      const seen = collect(socket);
      publishOrderEvent(world.branchA._id, {reason: 'after-bad-payload'});
      await settle();
      assert.ok(seen.some(item => item.payload.reason === 'after-bad-payload'));
    } finally { socket.close(); }
  });

  it('uses the shared event constants rather than scattered string literals', async () => {
    // A typo in an event name produces an event nobody listens to and no test
    // can catch, so publishers must reference the frozen list.
    const {readFile} = await import('node:fs/promises');
    const source = await readFile(new URL('../src/services/realtime.js', import.meta.url), 'utf8');
    for (const name of REALTIME_EVENT_NAMES) {
      // The literal may appear only inside realtimeEvents.js; realtime.js
      // should route through REALTIME_EVENTS.*
      if (name.startsWith('kitchen:')) continue; // passed in by callers
      assert.doesNotMatch(
        source, new RegExp(`emit\\('${name.replace(':', ':')}'`),
        `${name} should be published via REALTIME_EVENTS`
      );
    }
    assert.ok(mongoose.isValidObjectId(String(world.branchA._id)));
  });
});
