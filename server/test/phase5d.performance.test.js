import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MenuItem} from '../src/models/index.js';
import {Order} from '../src/models/operations.js';
import {
  delayOf,
  minutesBetween,
  percentile,
  ticketTimings
} from '../src/services/kitchenPerformance.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let grill;   // 20 min target
let fryItem; // 5 min target

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await request('/api/kitchen/stations', {token: tokenFor(world.owner)}); // seed stations
  grill = await MenuItem.create({
    restaurant: world.restaurant._id, name: 'Sekuwa', price: 400, vatInclusive: false,
    station: 'grill', prepMinutes: 20,
    recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}]
  });
  fryItem = await MenuItem.create({
    restaurant: world.restaurant._id, name: 'Chips', price: 150, vatInclusive: false,
    station: 'fry', prepMinutes: 5,
    recipe: [{ingredient: world.ingredient._id, qty: 20, unit: 'g'}]
  });
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

const perf = (query = '', token = owner()) =>
  request(`/api/kitchen/performance?branch=${world.branchA._id}${query}`, {token});

async function placeOrder(items, branch = world.branchA) {
  const res = await request('/api/orders', {
    method: 'POST', token: owner(),
    body: {branch: String(branch._id), type: 'counter', items}
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

/**
 * Writes stage timestamps directly. createdAt is immutable to Mongoose, so the
 * raw driver is used to age a ticket into the past deterministically.
 */
async function stampTicket(orderId, {placedMinAgo, acceptedAfter = 1, preparingAfter = 2, readyAfter, completedAfter}) {
  const placed = new Date(Date.now() - placedMinAgo * 60000);
  const at = mins => new Date(placed.getTime() + mins * 60000);
  const $set = {createdAt: placed};
  if (acceptedAfter !== null) $set.acceptedAt = at(acceptedAfter);
  if (preparingAfter !== null) $set.preparingAt = at(preparingAfter);
  if (readyAfter !== undefined && readyAfter !== null) $set.readyAt = at(readyAfter);
  if (completedAfter !== undefined && completedAfter !== null) {
    $set.completedAt = at(completedAfter);
    $set.status = 'completed';
  }
  await mongoose.connection.collection('orders').updateOne(
    {_id: new mongoose.Types.ObjectId(String(orderId))}, {$set}
  );
}

// ── Timing primitives ────────────────────────────────────────────────────────
describe('Phase 5D — timing primitives', () => {
  it('measures minutes between two instants', () => {
    const base = new Date('2026-08-17T10:00:00Z');
    assert.equal(minutesBetween(base, new Date('2026-08-17T10:12:00Z')), 12);
    assert.equal(minutesBetween(base, new Date('2026-08-17T10:12:30Z')), 12.5);
    assert.equal(minutesBetween(null, base), null, 'missing start yields null');
    assert.equal(minutesBetween(base, null), null, 'missing end yields null');
    // Clock skew must never produce a negative duration.
    assert.equal(minutesBetween(base, new Date('2026-08-17T09:00:00Z')), 0);
  });

  it('splits a ticket into wait, cook, prep and service', () => {
    const t = ticketTimings({
      createdAt: new Date('2026-08-17T10:00:00Z'),
      acceptedAt: new Date('2026-08-17T10:02:00Z'),
      preparingAt: new Date('2026-08-17T10:03:00Z'),
      readyAt: new Date('2026-08-17T10:15:00Z'),
      completedAt: new Date('2026-08-17T10:40:00Z')
    });
    assert.equal(t.waitMinutes, 2);
    assert.equal(t.cookMinutes, 12);
    assert.equal(t.prepMinutes, 15, 'placed -> ready is the guest-facing wait');
    assert.equal(t.serviceMinutes, 40);
  });

  it('reports null timings for a ticket that never reached the pass', () => {
    const t = ticketTimings({createdAt: new Date(), acceptedAt: new Date()});
    assert.equal(t.prepMinutes, null);
    assert.equal(t.serviceMinutes, null);
  });

  it('computes percentiles by nearest rank', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(values, 50), 5);
    assert.equal(percentile(values, 90), 9);
    assert.equal(percentile(values, 100), 10);
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([null, 4], 50), 4, 'nulls are ignored');
  });
});

// ── Delay detection ──────────────────────────────────────────────────────────
describe('Phase 5D — delayed orders', () => {
  const ago = m => new Date(Date.now() - m * 60000);

  it('flags a ticket that beat or missed its target', () => {
    const items = [{prepMinutes: 20}];
    const onTime = delayOf({createdAt: ago(30), readyAt: ago(15), items, type: 'counter', status: 'completed'});
    assert.equal(onTime.target, 20);
    assert.equal(onTime.elapsed, 15);
    assert.equal(onTime.delayed, false);
    assert.equal(onTime.overBy, 0);

    const late = delayOf({createdAt: ago(60), readyAt: ago(25), items, type: 'counter', status: 'completed'});
    assert.equal(late.elapsed, 35);
    assert.equal(late.delayed, true);
    assert.equal(late.overBy, 15);
  });

  it('judges an open ticket against the clock, not its eventual close', () => {
    // Placed 40 minutes ago, never marked ready — it is late right now.
    const stalled = delayOf({createdAt: ago(40), items: [{prepMinutes: 10}], type: 'counter', status: 'preparing'});
    assert.equal(stalled.delayed, true);
    assert.ok(stalled.overBy >= 29, `expected ~30 over, got ${stalled.overBy}`);
  });

  it('uses the channel default when no item declares a prep time', () => {
    const delivery = delayOf({createdAt: ago(20), readyAt: ago(5), items: [{}], type: 'delivery', status: 'completed'});
    assert.equal(delivery.target, 10);
    assert.equal(delivery.delayed, true);
  });
});

// ── Report ───────────────────────────────────────────────────────────────────
describe('Phase 5D — GET /api/kitchen/performance', () => {
  it('reports average prep time and completed orders', async () => {
    const a = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    const b = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    await stampTicket(a._id, {placedMinAgo: 60, readyAfter: 10, completedAfter: 12});
    await stampTicket(b._id, {placedMinAgo: 50, readyAfter: 20, completedAfter: 22});

    const res = await perf();
    assert.equal(res.status, 200, res.body?.message);
    const s = res.body.summary;
    assert.equal(s.orders, 2);
    assert.equal(s.completedOrders, 2);
    assert.equal(s.averagePrepMinutes, 15, '(10 + 20) / 2');
    assert.equal(s.medianPrepMinutes, 10);
    assert.equal(s.slowestPrepMinutes, 20);
    assert.equal(s.averageWaitMinutes, 1);
    assert.equal(s.averageServiceMinutes, 17, '(12 + 22) / 2');
  });

  it('counts delayed orders and quantifies the overrun', async () => {
    const onTime = await placeOrder([{menuItem: String(grill._id), qty: 1}]);   // 20m target
    const late = await placeOrder([{menuItem: String(fryItem._id), qty: 1}]);   // 5m target
    await stampTicket(onTime._id, {placedMinAgo: 60, readyAfter: 12, completedAfter: 14});
    await stampTicket(late._id, {placedMinAgo: 60, readyAfter: 25, completedAfter: 26});

    const res = await perf();
    const s = res.body.summary;
    assert.equal(s.delayedOrders, 1);
    assert.equal(s.onTimeOrders, 1);
    assert.equal(s.onTimeRate, 50);
    assert.equal(s.averageDelayMinutes, 20, '25 actual vs 5 target');
    assert.equal(s.worstDelayMinutes, 20);

    assert.equal(res.body.delayed.length, 1);
    assert.equal(res.body.delayed[0].orderNo, late.orderNo);
    assert.equal(res.body.delayed[0].targetMinutes, 5);
    assert.equal(res.body.delayed[0].overBy, 20);
  });

  it('breaks performance down by station', async () => {
    const grillTicket = await placeOrder([{menuItem: String(grill._id), qty: 2}]);
    const fryTicket = await placeOrder([{menuItem: String(fryItem._id), qty: 3}]);
    await stampTicket(grillTicket._id, {placedMinAgo: 60, readyAfter: 30, completedAfter: 31}); // late
    await stampTicket(fryTicket._id, {placedMinAgo: 60, readyAfter: 4, completedAfter: 5});     // on time

    const res = await perf();
    const byCode = Object.fromEntries(res.body.stations.map(s => [s.station, s]));
    assert.equal(byCode.grill.orders, 1);
    assert.equal(byCode.grill.items, 2);
    assert.equal(byCode.grill.averagePrepMinutes, 30);
    assert.equal(byCode.grill.delayedOrders, 1);
    assert.equal(byCode.grill.onTimeRate, 0);

    assert.equal(byCode.fry.orders, 1);
    assert.equal(byCode.fry.items, 3);
    assert.equal(byCode.fry.averagePrepMinutes, 4);
    assert.equal(byCode.fry.delayedOrders, 0);
    assert.equal(byCode.fry.onTimeRate, 100);

    // A station with no work still reports, so a screen can show every section.
    assert.equal(byCode.bar.orders, 0);
    assert.equal(byCode.bar.averagePrepMinutes, null);
  });

  it('attributes a multi-station ticket to every station involved', async () => {
    const mixed = await placeOrder([
      {menuItem: String(grill._id), qty: 1},
      {menuItem: String(fryItem._id), qty: 1}
    ]);
    await stampTicket(mixed._id, {placedMinAgo: 60, readyAfter: 12, completedAfter: 13});

    const res = await perf();
    const byCode = Object.fromEntries(res.body.stations.map(s => [s.station, s]));
    assert.equal(byCode.grill.orders, 1);
    assert.equal(byCode.fry.orders, 1);
    // The ticket is one order overall, counted once at summary level.
    assert.equal(res.body.summary.orders, 1);
    // Late for fry (5m target), on time for grill (20m) — same ticket.
    assert.equal(byCode.fry.delayedOrders, 0, 'delay uses the ticket target, the slowest item');
  });

  it('filters by station', async () => {
    const g = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    const f = await placeOrder([{menuItem: String(fryItem._id), qty: 1}]);
    await stampTicket(g._id, {placedMinAgo: 60, readyAfter: 15, completedAfter: 16});
    await stampTicket(f._id, {placedMinAgo: 60, readyAfter: 3, completedAfter: 4});

    const res = await perf('&station=grill');
    assert.equal(res.body.summary.orders, 1);
    assert.equal(res.body.summary.averagePrepMinutes, 15);
    assert.equal(res.body.stations.length, 1);
    assert.equal(res.body.stations[0].station, 'grill');
    assert.equal((await perf('&station=teleporter')).status, 400);
  });

  it('lists the slowest tickets', async () => {
    for (const mins of [5, 30, 12]) {
      const o = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
      await stampTicket(o._id, {placedMinAgo: 90, readyAfter: mins, completedAfter: mins + 1});
    }
    const res = await perf('&limit=2');
    assert.equal(res.body.slowestTickets.length, 2);
    assert.equal(res.body.slowestTickets[0].prepMinutes, 30);
    assert.equal(res.body.slowestTickets[1].prepMinutes, 12);
  });

  it('excludes cancelled tickets from timings unless asked', async () => {
    const good = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    const void_ = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    await stampTicket(good._id, {placedMinAgo: 60, readyAfter: 10, completedAfter: 11});
    await request(`/api/orders/${void_._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'cancelled'}
    });

    const res = await perf();
    assert.equal(res.body.summary.orders, 1, 'cancelled excluded by default');
    const withVoid = await perf('&includeCancelled=true');
    assert.equal(withVoid.body.summary.orders, 2);
    assert.equal(withVoid.body.summary.cancelledOrders, 1);
  });

  it('honours a date range', async () => {
    const old = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    const recent = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    await stampTicket(old._id, {placedMinAgo: 60 * 24 * 10, readyAfter: 10, completedAfter: 11});
    await stampTicket(recent._id, {placedMinAgo: 30, readyAfter: 10, completedAfter: 11});

    const {daysAgo} = await import('./dates.js');
    const res = await perf(`&from=${daysAgo(1)}`);
    assert.equal(res.body.summary.orders, 1, 'only the recent ticket is in range');
  });

  it('handles a kitchen with no tickets', async () => {
    const res = await perf();
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.summary.orders, 0);
    assert.equal(res.body.summary.averagePrepMinutes, null, 'no average without data');
    assert.equal(res.body.summary.onTimeRate, null);
    assert.deepEqual(res.body.delayed, []);
  });

  it('counts an open ticket without inventing a prep time', async () => {
    const open = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    await stampTicket(open._id, {placedMinAgo: 45, readyAfter: null, completedAfter: null});
    const res = await perf();
    assert.equal(res.body.summary.orders, 1);
    assert.equal(res.body.summary.openOrders, 1);
    assert.equal(res.body.summary.completedOrders, 0);
    assert.equal(res.body.summary.averagePrepMinutes, null, 'an unfinished ticket has no prep time');
    // ...but it is already visibly late.
    assert.equal(res.body.summary.delayedOrders, 1);
  });
});

// ── completedAt on every completion path (the gap this phase closed) ─────────
describe('Phase 5D — completion timestamps', () => {
  it('stamps completedAt when a ticket is settled by payment', async () => {
    const order = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    const paid = await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'completed');
    assert.ok(stored.completedAt instanceof Date, 'payment completion must be timestamped');
  });

  it('stamps completedAt via the kitchen status route', async () => {
    const order = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      await request(`/api/orders/${order._id}/status`, {
        method: 'PATCH', token: owner(), body: {status}
      });
    }
    const stored = await Order.findById(order._id);
    assert.ok(stored.completedAt instanceof Date);
    assert.ok(stored.readyAt instanceof Date);
  });

  it('counts a payment-completed ticket in the report', async () => {
    const order = await placeOrder([{menuItem: String(grill._id), qty: 1}]);
    await request(`/api/orders/${order._id}/status`, {method: 'PATCH', token: owner(), body: {status: 'accepted'}});
    await request(`/api/orders/${order._id}/status`, {method: 'PATCH', token: owner(), body: {status: 'preparing'}});
    await request(`/api/orders/${order._id}/status`, {method: 'PATCH', token: owner(), body: {status: 'ready'}});
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total, method: 'cash'}
    });
    const res = await perf();
    assert.equal(res.body.summary.completedOrders, 1, 'settled tickets must count as completed');
    assert.notEqual(res.body.summary.averageServiceMinutes, null);
  });
});

// ── Authorization ────────────────────────────────────────────────────────────
describe('Phase 5D — authorization', () => {
  it('is management only', async () => {
    assert.equal((await perf('', staff())).status, 403);
    assert.equal((await request(`/api/kitchen/performance?branch=${world.branchA._id}`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await perf('', guest)).status, 403);
    assert.equal((await perf('', manager())).status, 200);
  });

  it('enforces branch scope and validates the branch', async () => {
    assert.equal((await request(`/api/kitchen/performance?branch=${world.branchB._id}`, {token: manager()})).status, 403);
    assert.equal((await request('/api/kitchen/performance', {token: owner()})).status, 400);
    assert.equal((await request('/api/kitchen/performance?branch=nonsense', {token: owner()})).status, 400);
    const ghost = new mongoose.Types.ObjectId();
    assert.equal((await request(`/api/kitchen/performance?branch=${ghost}`, {token: owner()})).status, 404);
  });

  it('does not leak another branch’s tickets', async () => {
    const mine = await placeOrder([{menuItem: String(grill._id), qty: 1}], world.branchA);
    await placeOrder([{menuItem: String(grill._id), qty: 1}], world.branchB);
    await stampTicket(mine._id, {placedMinAgo: 60, readyAfter: 10, completedAfter: 11});
    const res = await perf();
    assert.equal(res.body.summary.orders, 1);
  });
});
