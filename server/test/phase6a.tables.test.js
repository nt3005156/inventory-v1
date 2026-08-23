import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Audit, User} from '../src/models/index.js';
import {Branch, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {
  DEFAULT_AREA,
  MAX_SEATS,
  buildFloorPlan,
  normalizeArea
} from '../src/services/tables.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

function makeTable(body, token = owner()) {
  return request('/api/tables', {
    method: 'POST', token,
    body: {branch: String(world.branchA._id), seats: 4, ...body}
  });
}

const floor = (query = '', token = owner()) =>
  request(`/api/tables/floor?branch=${world.branchA._id}${query}`, {token});

async function rivalOwner() {
  const restaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival', code: 'RVL'});
  const user = await User.create({
    name: 'Rival Owner', email: 'rival@test.com', password: 'x', role: 'owner',
    restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
  });
  return {restaurant, branch, user};
}

// ── Capacity ─────────────────────────────────────────────────────────────────
describe('Phase 6A — capacity', () => {
  it('requires seats: a table with no capacity is not a table', async () => {
    const res = await makeTable({name: 'NoSeats', seats: undefined});
    assert.equal(res.status, 400, 'seats must be mandatory');
  });

  it('rejects zero, negative and absurd capacities', async () => {
    assert.equal((await makeTable({name: 'Z', seats: 0})).status, 400);
    assert.equal((await makeTable({name: 'N', seats: -4})).status, 400);
    assert.equal((await makeTable({name: 'F', seats: 2.5})).status, 400);
    assert.equal((await makeTable({name: 'H', seats: MAX_SEATS + 1})).status, 400);
  });

  it('accepts a sane capacity up to the maximum', async () => {
    const small = await makeTable({name: 'Deuce', seats: 2});
    assert.equal(small.status, 201, small.body?.message);
    assert.equal(small.body.seats, 2);
    const banquet = await makeTable({name: 'Banquet', seats: MAX_SEATS});
    assert.equal(banquet.status, 201);
    assert.equal(banquet.body.seats, MAX_SEATS);
  });

  it('enforces the same bounds on update', async () => {
    const created = await makeTable({name: 'Upd', seats: 4});
    const id = created.body._id;
    assert.equal((await request(`/api/tables/${id}`, {
      method: 'PATCH', token: owner(), body: {seats: 0}
    })).status, 400);
    assert.equal((await request(`/api/tables/${id}`, {
      method: 'PATCH', token: owner(), body: {seats: 999}
    })).status, 400);
    const ok = await request(`/api/tables/${id}`, {
      method: 'PATCH', token: owner(), body: {seats: 6}
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.seats, 6);
  });
});

// ── Floor / area ─────────────────────────────────────────────────────────────
describe('Phase 6A — floor areas', () => {
  it('normalizes an area label', () => {
    assert.equal(normalizeArea('  Terrace  '), 'Terrace');
    assert.equal(normalizeArea('Main    Hall'), 'Main Hall', 'collapses runs of whitespace');
    assert.equal(normalizeArea(''), DEFAULT_AREA);
    assert.equal(normalizeArea(undefined), DEFAULT_AREA);
  });

  it('rejects a blank or over-long area', async () => {
    assert.equal((await makeTable({name: 'B1', area: '   '})).status, 400);
    assert.equal((await makeTable({name: 'B2', area: 'x'.repeat(61)})).status, 400);
  });

  it('defaults the area when none is given', async () => {
    const res = await makeTable({name: 'Solo'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.area, DEFAULT_AREA);
  });

  it('trims an area on create and update', async () => {
    const created = await makeTable({name: 'Trim', area: '  Garden  '});
    assert.equal(created.body.area, 'Garden');
    const updated = await request(`/api/tables/${created.body._id}`, {
      method: 'PATCH', token: owner(), body: {area: '  Roof   Top '}
    });
    assert.equal(updated.body.area, 'Roof Top');
  });
});

// ── Uniqueness ───────────────────────────────────────────────────────────────
describe('Phase 6A — table naming', () => {
  it('rejects a duplicate name regardless of case', async () => {
    assert.equal((await makeTable({name: 'T9'})).status, 201);
    assert.equal((await makeTable({name: 't9'})).status, 409, 'T9 and t9 are one table to a host');
    assert.equal((await makeTable({name: ' T9 '})).status, 409, 'padding does not make it distinct');
  });

  it('allows the same name at a different branch', async () => {
    // seedWorld already places 'T1' on branch A, so use a fresh name here.
    assert.equal((await makeTable({name: 'Patio1'})).status, 201);
    const other = await request('/api/tables', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchB._id), name: 'Patio1', seats: 4}
    });
    assert.equal(other.status, 201, 'branches have independent floors');
    // ...and the seeded name is genuinely protected on its own branch.
    assert.equal((await makeTable({name: 'T1'})).status, 409);
  });

  it('rejects an over-long name and unknown fields', async () => {
    assert.equal((await makeTable({name: 'x'.repeat(41)})).status, 400);
    assert.equal((await makeTable({name: 'Inject', bogusField: 1})).status, 400);
  });
});

// ── Floor plan ───────────────────────────────────────────────────────────────
describe('Phase 6A — floor plan', () => {
  it('groups tables into areas with capacity and status counts', () => {
    const plan = buildFloorPlan([
      {_id: '1', name: 'T1', area: 'Terrace', seats: 4, status: 'occupied', active: true},
      {_id: '2', name: 'T2', area: 'Terrace', seats: 2, status: 'available', active: true},
      {_id: '3', name: 'B1', area: 'Bar', seats: 6, status: 'reserved', active: true}
    ]);
    assert.equal(plan.areas.length, 2);
    const terrace = plan.areas.find(a => a.area === 'Terrace');
    assert.equal(terrace.tableCount, 2);
    assert.equal(terrace.seats, 6);
    assert.equal(terrace.statuses.occupied, 1);
    assert.equal(terrace.seatedCapacity, 4);

    assert.equal(plan.summary.tableCount, 3);
    assert.equal(plan.summary.totalSeats, 12);
    assert.equal(plan.summary.statuses.reserved, 1);
    // 1 occupied of 3 in-service tables.
    assert.equal(plan.summary.occupancyRate, 33.33);
    assert.equal(plan.summary.seatOccupancyRate, 33.33, '4 seated of 12 seats');
  });

  it('treats an inactive table as out of service and excludes it from occupancy', () => {
    const plan = buildFloorPlan([
      {_id: '1', name: 'T1', area: 'Main', seats: 4, status: 'occupied', active: true},
      {_id: '2', name: 'T2', area: 'Main', seats: 4, status: 'available', active: false}
    ]);
    assert.equal(plan.summary.statuses.disabled, 1);
    assert.equal(plan.summary.occupancyRate, 100, 'only in-service tables count');
  });

  it('handles an empty floor without dividing by zero', () => {
    const plan = buildFloorPlan([]);
    assert.equal(plan.areas.length, 0);
    assert.equal(plan.summary.occupancyRate, 0);
    assert.equal(plan.summary.seatOccupancyRate, 0);
  });

  it('sorts tables naturally within an area', () => {
    const plan = buildFloorPlan([
      {_id: '1', name: 'T10', area: 'Main', seats: 2, status: 'available', active: true},
      {_id: '2', name: 'T2', area: 'Main', seats: 2, status: 'available', active: true}
    ]);
    assert.deepEqual(plan.areas[0].tables.map(t => t.name), ['T2', 'T10']);
  });

  it('serves the floor plan over the API', async () => {
    await makeTable({name: 'A1', area: 'Terrace', seats: 4});
    await makeTable({name: 'A2', area: 'Terrace', seats: 2});
    await makeTable({name: 'B1', area: 'Bar', seats: 6});

    const res = await floor();
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.branch, String(world.branchA._id));
    // seedWorld already places T1 on the default floor.
    assert.ok(res.body.summary.tableCount >= 4);
    assert.ok(res.body.areas.some(a => a.area === 'Terrace'));
    assert.ok(res.body.areas.some(a => a.area === 'Bar'));
    assert.equal(res.body.areas.find(a => a.area === 'Terrace').seats, 6);
  });

  it('reflects a seated table in the occupancy figures', async () => {
    const created = await makeTable({name: 'Seat1', area: 'Terrace', seats: 4});
    const before = await floor();
    assert.equal(before.body.summary.statuses.occupied, 0);

    const seated = await request(`/api/tables/${created.body._id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'occupied'}
    });
    assert.equal(seated.status, 200, seated.body?.message);

    const after = await floor();
    assert.equal(after.body.summary.statuses.occupied, 1);
    assert.ok(after.body.summary.occupancyRate > 0);
    assert.equal(after.body.areas.find(a => a.area === 'Terrace').seatedCapacity, 4);
  });

  it('hides retired tables unless asked', async () => {
    const created = await makeTable({name: 'Gone', seats: 2});
    await request(`/api/tables/${created.body._id}`, {method: 'DELETE', token: owner()});
    const plan = await floor();
    assert.ok(!plan.body.areas.some(a => a.tables.some(t => t.name === 'Gone')));
    const withRetired = await floor('&includeRetired=true');
    assert.ok(withRetired.body.areas.some(a => a.tables.some(t => t.name === 'Gone')));
  });
});

// ── Status lifecycle (guards over existing behaviour) ────────────────────────
describe('Phase 6A — status lifecycle', () => {
  it('walks available → occupied → cleaning → available', async () => {
    const created = await makeTable({name: 'Cycle', seats: 4});
    const id = created.body._id;
    assert.equal(created.body.status, 'available');
    const step = status => request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: staff(), body: {status}
    });
    assert.equal((await step('occupied')).status, 200);
    assert.equal((await step('cleaning')).status, 200);
    const done = await step('available');
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'available');
  });

  it('supports reserving and seating a reserved table', async () => {
    const created = await makeTable({name: 'Resv', seats: 2});
    const id = created.body._id;
    const reserved = await request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'reserved'}
    });
    assert.equal(reserved.body.status, 'reserved');
    const seated = await request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'occupied'}
    });
    assert.equal(seated.body.status, 'occupied');
  });

  it('refuses an illegal transition and an unknown status', async () => {
    const created = await makeTable({name: 'Bad', seats: 2});
    const id = created.body._id;
    // available → ready is not a table status at all
    assert.equal((await request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'ready'}
    })).status, 400);
    // cleaning cannot be reached from available? it can; occupied → reserved cannot.
    await request(`/api/tables/${id}/status`, {method: 'PATCH', token: staff(), body: {status: 'occupied'}});
    assert.equal((await request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'reserved'}
    })).status, 409);
  });

  it('restricts out-of-service to management', async () => {
    const created = await makeTable({name: 'OOS', seats: 2});
    const id = created.body._id;
    assert.equal((await request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'disabled'}
    })).status, 403);
    assert.equal((await request(`/api/tables/${id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'disabled'}
    })).status, 200);
  });
});

// ── Archive ──────────────────────────────────────────────────────────────────
describe('Phase 6A — retiring a table', () => {
  it('deactivates rather than deletes, preserving history', async () => {
    const created = await makeTable({name: 'Retire', seats: 4});
    const res = await request(`/api/tables/${created.body._id}`, {method: 'DELETE', token: owner()});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.archived, true);
    const stored = await RestaurantTable.findById(created.body._id);
    assert.ok(stored, 'the row must still exist');
    assert.equal(stored.active, false);
    assert.equal(stored.status, 'disabled');
    const entry = await Audit.findOne({entity: 'table', entityId: stored._id, action: 'archive'});
    assert.ok(entry, 'retiring is audited');
  });

  it('refuses to retire an occupied table', async () => {
    const created = await makeTable({name: 'Busy', seats: 4});
    await request(`/api/tables/${created.body._id}/status`, {
      method: 'PATCH', token: staff(), body: {status: 'occupied'}
    });
    const res = await request(`/api/tables/${created.body._id}`, {method: 'DELETE', token: owner()});
    assert.equal(res.status, 409);
  });

  it('refuses to retire a table holding an open order', async () => {
    const res = await request(`/api/tables/${world.table._id}`, {method: 'DELETE', token: owner()});
    // The seeded table is free, so retire succeeds; now prove the guard with an order.
    assert.equal(res.status, 200);
    const fresh = await makeTable({name: 'WithOrder', seats: 4});
    const order = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id), type: 'dine-in',
        table: String(fresh.body._id), items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(order.status, 201, order.body?.message);
    const blocked = await request(`/api/tables/${fresh.body._id}`, {method: 'DELETE', token: owner()});
    assert.equal(blocked.status, 409);
  });

  it('is management only', async () => {
    const created = await makeTable({name: 'Perm', seats: 2});
    assert.equal((await request(`/api/tables/${created.body._id}`, {
      method: 'DELETE', token: staff()
    })).status, 403);
  });
});

// ── Tenant isolation and RBAC ────────────────────────────────────────────────
describe('Phase 6A — tenant isolation and RBAC', () => {
  it('stops another restaurant reading or writing this floor', async () => {
    await makeTable({name: 'Private', seats: 4});
    const rival = await rivalOwner();
    const token = tokenFor(rival.user);

    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token})).status, 403);
    assert.equal((await request(`/api/tables/floor?branch=${world.branchA._id}`, {token})).status, 403);
    assert.equal((await request('/api/tables', {
      method: 'POST', token, body: {branch: String(world.branchA._id), name: 'Intruder', seats: 2}
    })).status, 403);

    const mine = await RestaurantTable.findOne({branch: world.branchA._id, name: 'Private'});
    assert.equal((await request(`/api/tables/${mine._id}/status`, {
      method: 'PATCH', token, body: {status: 'occupied'}
    })).status, 403);
    assert.equal((await request(`/api/tables/${mine._id}`, {method: 'DELETE', token})).status, 403);
  });

  it('confines a manager to their own branch', async () => {
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token: manager()})).status, 200);
    assert.equal((await request(`/api/tables?branch=${world.branchB._id}`, {token: manager()})).status, 403);
    assert.equal((await request(`/api/tables/floor?branch=${world.branchB._id}`, {token: manager()})).status, 403);
  });

  it('keeps table configuration management-only', async () => {
    assert.equal((await makeTable({name: 'StaffMade'}, staff())).status, 403);
    const created = await makeTable({name: 'Cfg', seats: 4});
    assert.equal((await request(`/api/tables/${created.body._id}`, {
      method: 'PATCH', token: staff(), body: {seats: 8}
    })).status, 403);
  });

  it('rejects anonymous, guest and malformed requests', async () => {
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request(`/api/tables?branch=${world.branchA._id}`, {token: guest})).status, 403);
    assert.equal((await request('/api/tables/floor', {token: owner()})).status, 400);
    assert.equal((await request('/api/tables/floor?branch=nonsense', {token: owner()})).status, 400);
    const ghost = new mongoose.Types.ObjectId();
    assert.equal((await request(`/api/tables/floor?branch=${ghost}`, {token: owner()})).status, 404);
    assert.equal((await request('/api/tables/not-an-id/status', {
      method: 'PATCH', token: owner(), body: {status: 'occupied'}
    })).status, 400);
  });
});
