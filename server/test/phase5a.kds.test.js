import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MenuItem} from '../src/models/index.js';
import {Order} from '../src/models/operations.js';
import {
  KDS_STAGES,
  KITCHEN_STATIONS,
  STAGE_STATUSES,
  ageMinutes,
  normalizeStation,
  priorityFor,
  sortQueue,
  stageForStatus,
  stampStage,
  stationLines,
  targetMinutes
} from '../src/services/kds.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let grillItem;
let fryItem;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  grillItem = await MenuItem.create({
    restaurant: world.restaurant._id, name: 'Grilled Sekuwa', price: 400, vatInclusive: false,
    station: 'grill', prepMinutes: 20,
    recipe: [{ingredient: world.ingredient._id, qty: 100, unit: 'g'}]
  });
  fryItem = await MenuItem.create({
    restaurant: world.restaurant._id, name: 'Chips', price: 150, vatInclusive: false,
    station: 'fry', prepMinutes: 5,
    recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}]
  });
});

const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);

async function placeOrder(items, extra = {}, branch = world.branchA, token = owner()) {
  const res = await request('/api/orders', {
    method: 'POST', token,
    body: {branch: String(branch._id), type: 'counter', items, ...extra}
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

const board = (query = '', token = owner()) =>
  request(`/api/kitchen/board?branch=${world.branchA._id}${query}`, {token});

// createdAt is immutable to Mongoose, so ageing a ticket needs the raw driver.
async function backdate(orderId, minutes) {
  await mongoose.connection.collection('orders').updateOne(
    {_id: new mongoose.Types.ObjectId(String(orderId))},
    {$set: {createdAt: new Date(Date.now() - minutes * 60000)}}
  );
}

const advance = (id, status, token = owner()) =>
  request(`/api/orders/${id}/status`, {method: 'PATCH', token, body: {status}});

// ── Queue model ──────────────────────────────────────────────────────────────
describe('Phase 5A — queue stages', () => {
  it('maps the five order statuses onto the four kitchen stages', () => {
    assert.deepEqual(KDS_STAGES, ['new', 'preparing', 'ready', 'completed']);
    assert.equal(stageForStatus('pending'), 'new');
    assert.equal(stageForStatus('confirmed'), 'new');
    assert.equal(stageForStatus('accepted'), 'preparing');
    assert.equal(stageForStatus('preparing'), 'preparing');
    assert.equal(stageForStatus('ready'), 'ready');
    assert.equal(stageForStatus('completed'), 'completed');
    assert.equal(stageForStatus('cancelled'), null);
    // Every queue status belongs to exactly one stage.
    const all = Object.values(STAGE_STATUSES).flat();
    assert.equal(new Set(all).size, all.length);
  });

  it('walks New -> Preparing -> Ready -> Completed on the board', async () => {
    const order = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    const stageOf = async () => {
      const res = await board();
      return res.body.tickets.find(t => String(t.id) === String(order._id))?.stage;
    };
    assert.equal(await stageOf(), 'new');
    assert.equal((await advance(order._id, 'accepted')).status, 200);
    assert.equal(await stageOf(), 'preparing');
    assert.equal((await advance(order._id, 'preparing')).status, 200);
    assert.equal(await stageOf(), 'preparing');
    assert.equal((await advance(order._id, 'ready')).status, 200);
    assert.equal(await stageOf(), 'ready');
    assert.equal((await advance(order._id, 'completed')).status, 200);
    // Completed leaves the working queue unless explicitly requested.
    assert.equal(await stageOf(), undefined);
    const withDone = await board('&includeCompleted=true');
    assert.equal(withDone.body.tickets.find(t => String(t.id) === String(order._id)).stage, 'completed');
  });

  it('records a timestamp for each stage', async () => {
    const order = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    await advance(order._id, 'accepted');
    await advance(order._id, 'preparing');
    await advance(order._id, 'ready');
    const stored = await Order.findById(order._id);
    assert.ok(stored.acceptedAt instanceof Date);
    assert.ok(stored.preparingAt instanceof Date);
    assert.ok(stored.readyAt instanceof Date);
    // Stamps are write-once so the first entry into a stage is preserved.
    const first = stored.acceptedAt;
    stampStage(stored, 'accepted', new Date(Date.now() + 60000));
    assert.equal(stored.acceptedAt, first);
  });

  it('returns columns for every stage even when empty', async () => {
    const res = await board();
    assert.equal(res.status, 200, res.body?.message);
    assert.deepEqual(res.body.columns.map(c => c.stage), KDS_STAGES);
    assert.equal(res.body.columns.find(c => c.stage === 'new').title, 'New');
  });
});

// ── Branch filtering ─────────────────────────────────────────────────────────
describe('Phase 5A — branch filtering', () => {
  it('shows only the requested branch', async () => {
    const a = await placeOrder([{menuItem: String(grillItem._id), qty: 1}], {}, world.branchA);
    await placeOrder([{menuItem: String(grillItem._id), qty: 1}], {}, world.branchB);

    const res = await board();
    assert.equal(res.body.tickets.length, 1);
    assert.equal(String(res.body.tickets[0].id), String(a._id));

    const other = await request(`/api/kitchen/board?branch=${world.branchB._id}`, {token: owner()});
    assert.equal(other.body.tickets.length, 1);
    assert.notEqual(String(other.body.tickets[0].id), String(a._id));
  });

  it('requires a valid branch', async () => {
    assert.equal((await request('/api/kitchen/board', {token: owner()})).status, 400);
    assert.equal((await request('/api/kitchen/board?branch=nonsense', {token: owner()})).status, 400);
    const ghost = new mongoose.Types.ObjectId();
    assert.equal((await request(`/api/kitchen/board?branch=${ghost}`, {token: owner()})).status, 404);
  });

  it('stops staff reading another branch board', async () => {
    assert.equal((await request(`/api/kitchen/board?branch=${world.branchB._id}`, {token: staff()})).status, 403);
    assert.equal((await request(`/api/kitchen/board?branch=${world.branchA._id}`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await board('', guest)).status, 403);
  });
});

// ── Station filtering ────────────────────────────────────────────────────────
describe('Phase 5A — station filtering', () => {
  it('validates station names', () => {
    assert.equal(normalizeStation('GRILL'), 'grill');
    assert.equal(normalizeStation(''), null);
    assert.throws(() => normalizeStation('teleporter'), /Station must be one of/);
    assert.ok(KITCHEN_STATIONS.includes('grill'));
  });

  it('lists a ticket only on the stations it touches', async () => {
    const mixed = await placeOrder([
      {menuItem: String(grillItem._id), qty: 1},
      {menuItem: String(fryItem._id), qty: 2}
    ]);
    const grillOnly = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);

    const grill = await board('&station=grill');
    assert.equal(grill.body.tickets.length, 2);

    const fry = await board('&station=fry');
    assert.equal(fry.body.tickets.length, 1);
    assert.equal(String(fry.body.tickets[0].id), String(mixed._id));

    // A station with no work shows an empty board, not an error.
    const bar = await board('&station=bar');
    assert.equal(bar.status, 200);
    assert.equal(bar.body.tickets.length, 0);
    assert.ok(grillOnly);
  });

  it('shows only that station’s lines on the ticket', async () => {
    await placeOrder([
      {menuItem: String(grillItem._id), qty: 1},
      {menuItem: String(fryItem._id), qty: 3}
    ]);
    const fry = await board('&station=fry');
    const ticket = fry.body.tickets[0];
    assert.equal(ticket.items.length, 1, 'grill line must not appear on the fry screen');
    assert.equal(ticket.items[0].name, 'Chips');
    assert.equal(ticket.itemCount, 3);
    // The ticket still reports every station involved, for expo awareness.
    assert.deepEqual(ticket.stations, ['fry', 'grill']);

    const unfiltered = await board();
    assert.equal(unfiltered.body.tickets[0].items.length, 2);
  });

  it('defaults an unassigned item to the kitchen station', async () => {
    // seedWorld's biryani predates stations.
    const order = await placeOrder([{menuItem: String(world.menu._id), qty: 1}]);
    const res = await board('&station=kitchen');
    assert.equal(res.body.tickets.length, 1);
    assert.equal(String(res.body.tickets[0].id), String(order._id));
  });

  it('rejects an unknown station', async () => {
    assert.equal((await board('&station=teleporter')).status, 400);
  });

  it('exposes the station list', async () => {
    const res = await request('/api/kitchen/stations', {token: staff()});
    assert.equal(res.status, 200);
    assert.ok(res.body.stations.includes('tandoor'));
  });
});

// ── Priority and age ─────────────────────────────────────────────────────────
describe('Phase 5A — priority and order age', () => {
  const at = mins => new Date(Date.now() - mins * 60000);

  it('computes age in whole minutes', () => {
    assert.equal(ageMinutes({createdAt: at(0)}), 0);
    assert.equal(ageMinutes({createdAt: at(7)}), 7);
    // A future timestamp must not produce a negative age.
    assert.equal(ageMinutes({createdAt: new Date(Date.now() + 60000)}), 0);
  });

  it('takes the slowest item as the ticket target', () => {
    assert.equal(targetMinutes({type: 'counter', items: [{prepMinutes: 5}, {prepMinutes: 20}]}), 20);
    // Falls back to the channel default when no item declares a time.
    assert.equal(targetMinutes({type: 'delivery', items: [{}]}), 10);
    assert.equal(targetMinutes({type: 'dine-in', items: []}), 15);
  });

  it('escalates normal -> due -> late -> overdue with age', () => {
    const items = [{prepMinutes: 20}];
    assert.equal(priorityFor({createdAt: at(0), items, type: 'counter'}), 'normal');
    assert.equal(priorityFor({createdAt: at(15), items, type: 'counter'}), 'due');   // 75% of 20
    assert.equal(priorityFor({createdAt: at(20), items, type: 'counter'}), 'late');  // at target
    assert.equal(priorityFor({createdAt: at(30), items, type: 'counter'}), 'overdue'); // 1.5x
  });

  it('treats a manual rush as top priority regardless of age', () => {
    const fresh = {createdAt: at(0), items: [{prepMinutes: 20}], type: 'counter', priority: 'rush'};
    assert.equal(priorityFor(fresh), 'overdue');
  });

  it('sorts rush first, then by escalation, then oldest first', () => {
    const rows = [
      {id: 'fresh', rush: false, priority: 'normal', createdAt: at(1)},
      {id: 'old', rush: false, priority: 'normal', createdAt: at(9)},
      {id: 'late', rush: false, priority: 'late', createdAt: at(2)},
      {id: 'rush', rush: true, priority: 'overdue', createdAt: at(0)}
    ];
    assert.deepEqual(sortQueue(rows).map(r => r.id), ['rush', 'late', 'old', 'fresh']);
  });

  it('reports age and target on every ticket', async () => {
    const order = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    const res = await board();
    const ticket = res.body.tickets.find(t => String(t.id) === String(order._id));
    assert.equal(ticket.targetMinutes, 20);
    assert.equal(ticket.ageMinutes, 0);
    assert.equal(ticket.overdueBy, 0);
    assert.equal(ticket.priority, 'normal');
    assert.equal(ticket.rush, false);
  });

  it('escalates a genuinely old ticket on the board', async () => {
    const order = await placeOrder([{menuItem: String(fryItem._id), qty: 1}]); // 5 min target
    await backdate(order._id, 30);
    const res = await board();
    const ticket = res.body.tickets.find(t => String(t.id) === String(order._id));
    assert.equal(ticket.ageMinutes, 30);
    assert.equal(ticket.priority, 'overdue');
    assert.equal(ticket.overdueBy, 25);
    assert.equal(res.body.summary.overdue, 1);
    assert.equal(res.body.summary.oldestMinutes, 30);
  });

  it('flags and clears a rush ticket', async () => {
    const order = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    const rushed = await request(`/api/orders/${order._id}/priority`, {
      method: 'PATCH', token: staff(), body: {priority: 'rush'}
    });
    assert.equal(rushed.status, 200, rushed.body?.message);
    assert.equal(rushed.body.priority, 'rush');
    assert.ok(rushed.body.rushedAt);

    const res = await board();
    const ticket = res.body.tickets.find(t => String(t.id) === String(order._id));
    assert.equal(ticket.rush, true);
    assert.equal(ticket.priority, 'overdue');
    assert.equal(res.body.summary.rush, 1);

    const cleared = await request(`/api/orders/${order._id}/priority`, {
      method: 'PATCH', token: staff(), body: {priority: 'normal'}
    });
    assert.equal(cleared.body.priority, 'normal');
  });

  it('puts a rush ticket at the front of the queue', async () => {
    const first = await placeOrder([{menuItem: String(fryItem._id), qty: 1}]);
    const second = await placeOrder([{menuItem: String(fryItem._id), qty: 1}]);
    await request(`/api/orders/${second._id}/priority`, {
      method: 'PATCH', token: owner(), body: {priority: 'rush'}
    });
    const res = await board();
    assert.equal(String(res.body.tickets[0].id), String(second._id), 'rush ticket must lead');
    assert.equal(String(res.body.tickets[1].id), String(first._id));
  });

  it('rejects an invalid priority and a closed ticket', async () => {
    const order = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    assert.equal((await request(`/api/orders/${order._id}/priority`, {
      method: 'PATCH', token: owner(), body: {priority: 'panic'}
    })).status, 400);

    await advance(order._id, 'accepted');
    await advance(order._id, 'preparing');
    await advance(order._id, 'ready');
    await advance(order._id, 'completed');
    assert.equal((await request(`/api/orders/${order._id}/priority`, {
      method: 'PATCH', token: owner(), body: {priority: 'rush'}
    })).status, 409);
  });

  it('filters the board by priority', async () => {
    const slow = await placeOrder([{menuItem: String(fryItem._id), qty: 1}]);
    await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    await backdate(slow._id, 40);

    const overdue = await board('&priority=overdue');
    assert.equal(overdue.body.tickets.length, 1);
    assert.equal(String(overdue.body.tickets[0].id), String(slow._id));
    assert.equal((await board('&priority=nonsense')).status, 400);
  });
});

// ── Stage filtering + regression guard ───────────────────────────────────────
describe('Phase 5A — stage filtering and compatibility', () => {
  it('filters by stage', async () => {
    const a = await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    await placeOrder([{menuItem: String(fryItem._id), qty: 1}]);
    await advance(a._id, 'accepted');

    const preparing = await board('&stage=preparing');
    assert.equal(preparing.body.tickets.length, 1);
    assert.equal(String(preparing.body.tickets[0].id), String(a._id));
    assert.equal((await board('&stage=new')).body.tickets.length, 1);
    assert.equal((await board('&stage=bogus')).status, 400);
  });

  it('keeps the legacy /kitchen/orders array contract', async () => {
    await placeOrder([{menuItem: String(grillItem._id), qty: 1}]);
    const res = await request(`/api/kitchen/orders?branch=${world.branchA._id}`, {token: owner()});
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body), 'existing clients expect a bare array');
    assert.equal(res.body.length, 1);
    assert.ok(res.body[0].orderNo);
  });

  it('carries the station onto order lines at creation', async () => {
    const order = await placeOrder([
      {menuItem: String(grillItem._id), qty: 1},
      {menuItem: String(fryItem._id), qty: 1}
    ]);
    const stored = await Order.findById(order._id);
    assert.equal(stored.items[0].station, 'grill');
    assert.equal(stored.items[0].prepMinutes, 20);
    assert.equal(stored.items[1].station, 'fry');
  });

  it('accepts station and prep time through the menu API', async () => {
    const created = await request('/api/menu-items', {
      method: 'POST', token: owner(),
      body: {
        name: 'Tandoori Roti', code: 'ROTI1', price: 60,
        station: 'tandoor', prepMinutes: 8,
        recipe: [{ingredient: String(world.ingredient._id), qty: 30, unit: 'g'}]
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.station, 'tandoor');
    assert.equal(created.body.prepMinutes, 8);
    assert.equal((await request('/api/menu-items', {
      method: 'POST', token: owner(),
      body: {name: 'Bad Station', price: 10, station: 'teleporter',
        recipe: [{ingredient: String(world.ingredient._id), qty: 1, unit: 'g'}]}
    })).status, 400);
  });

  it('exposes station lines helper behaviour', () => {
    const order = {items: [{station: 'grill', qty: 1}, {station: undefined, qty: 2}]};
    assert.equal(stationLines(order, null).lines.length, 2);
    assert.equal(stationLines(order, 'grill').lines.length, 1);
    assert.equal(stationLines(order, 'kitchen').matches, true, 'undefined station defaults to kitchen');
    assert.equal(stationLines(order, 'bar').matches, false);
  });
});
