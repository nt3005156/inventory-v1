import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Audit, User} from '../src/models/index.js';
import {Branch, Customer, Reservation, Restaurant, RestaurantTable} from '../src/models/operations.js';
import {
  DEFAULT_DURATION_MINUTES,
  RESERVATION_STATUSES,
  assertReservationTransition,
  canTransitionReservation,
  overlaps,
  reservationWindow
} from '../src/services/reservations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let bigTable;   // 8 seats
let smallTable; // 2 seats

const DATE = '2026-09-01';

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  bigTable = (await request('/api/tables', {
    method: 'POST', token: tokenFor(world.owner),
    body: {branch: String(world.branchA._id), name: 'Big-8', area: 'Terrace', seats: 8}
  })).body;
  smallTable = (await request('/api/tables', {
    method: 'POST', token: tokenFor(world.owner),
    body: {branch: String(world.branchA._id), name: 'Deuce', area: 'Terrace', seats: 2}
  })).body;
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

function book(body = {}, token = owner()) {
  return request('/api/reservations', {
    method: 'POST', token,
    body: {
      branch: String(world.branchA._id),
      guestName: 'Ram Thapa', guestPhone: '9800000001',
      partySize: 2, date: DATE, time: '19:00',
      table: String(world.table._id),
      ...body
    }
  });
}

const setStatus = (id, status, extra = {}, token = owner()) =>
  request(`/api/reservations/${id}/status`, {method: 'PATCH', token, body: {status, ...extra}});

// ── Window and overlap maths ─────────────────────────────────────────────────
describe('Phase 6C — booking windows', () => {
  it('resolves a local date and time into an absolute window', () => {
    const w = reservationWindow({date: '2026-09-01', time: '19:00'});
    // 19:00 Kathmandu (+05:45) is 13:15 UTC.
    assert.equal(w.startsAt.toISOString(), '2026-09-01T13:15:00.000Z');
    assert.equal(w.durationMinutes, DEFAULT_DURATION_MINUTES);
    assert.equal(w.endsAt.getTime() - w.startsAt.getTime(), 90 * 60000);
  });

  it('honours a custom duration', () => {
    const w = reservationWindow({date: DATE, time: '12:00', durationMinutes: 120});
    assert.equal(w.endsAt.getTime() - w.startsAt.getTime(), 120 * 60000);
  });

  it('rejects malformed dates, times and durations', () => {
    assert.throws(() => reservationWindow({date: '01-09-2026', time: '19:00'}), /YYYY-MM-DD/);
    assert.throws(() => reservationWindow({date: DATE, time: '7pm'}), /HH:MM/);
    assert.throws(() => reservationWindow({date: DATE, time: '25:00'}), /HH:MM/);
    assert.throws(() => reservationWindow({date: DATE, time: '19:00', durationMinutes: 5}), /between 15 and 600/);
    assert.throws(() => reservationWindow({date: '2026-02-30', time: '19:00'}), /Invalid reservation date/);
  });

  it('detects overlapping windows and treats touching ones as free', () => {
    const a = ['2026-09-01T18:00:00Z', '2026-09-01T19:30:00Z'];
    assert.equal(overlaps(...a, '2026-09-01T19:00:00Z', '2026-09-01T20:30:00Z'), true);
    assert.equal(overlaps(...a, '2026-09-01T17:00:00Z', '2026-09-01T18:30:00Z'), true);
    // Back-to-back bookings do not clash.
    assert.equal(overlaps(...a, '2026-09-01T19:30:00Z', '2026-09-01T21:00:00Z'), false);
    assert.equal(overlaps(...a, '2026-09-01T16:00:00Z', '2026-09-01T17:00:00Z'), false);
  });

  it('guards the status machine', () => {
    assert.deepEqual(RESERVATION_STATUSES,
      ['booked', 'confirmed', 'seated', 'completed', 'cancelled', 'no_show']);
    assert.equal(canTransitionReservation('booked', 'seated'), true);
    assert.equal(canTransitionReservation('booked', 'completed'), false);
    assert.equal(canTransitionReservation('seated', 'completed'), true);
    assert.equal(canTransitionReservation('cancelled', 'booked'), false);
    assert.throws(() => assertReservationTransition('completed', 'seated'), /Cannot move a reservation/);
    assert.throws(() => assertReservationTransition('booked', 'nonsense'), /Invalid reservation status/);
  });
});

// ── Creating ─────────────────────────────────────────────────────────────────
describe('Phase 6C — creating a reservation', () => {
  it('captures customer, date, time, party size and table', async () => {
    const res = await book({partySize: 4, table: String(bigTable._id), notes: 'Window seat'});
    assert.equal(res.status, 201, res.body?.message);
    assert.match(res.body.reference, /^RES-KTM-\d{4}-\d{5}$/);
    assert.equal(res.body.guestName, 'Ram Thapa');
    assert.equal(res.body.guestPhone, '9800000001');
    assert.equal(res.body.partySize, 4);
    assert.equal(res.body.date, DATE);
    assert.equal(res.body.time, '19:00');
    assert.equal(String(res.body.table), String(bigTable._id));
    assert.equal(res.body.status, 'booked');
    assert.equal(res.body.notes, 'Window seat');
  });

  it('issues sequential references per branch', async () => {
    const first = await book();
    const second = await book({time: '21:00'});
    const seq = ref => Number(ref.split('-').pop());
    assert.equal(seq(second.body.reference), seq(first.body.reference) + 1);
  });

  it('links an existing customer and inherits their details', async () => {
    const guest = await Customer.create({
      branch: world.branchA._id, name: 'Sita Rai', phone: '9800000009', email: 'sita@example.com'
    });
    const res = await book({customer: String(guest._id), guestName: undefined, guestPhone: undefined});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(String(res.body.customer), String(guest._id));
    assert.equal(res.body.guestName, 'Sita Rai');
    assert.equal(res.body.guestPhone, '9800000009');
  });

  it('accepts a walk-in booking with no customer record', async () => {
    const res = await book({customer: undefined, guestName: 'Phone Caller', guestPhone: '9811111111'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.customer, null);
    assert.equal(res.body.guestName, 'Phone Caller');
  });

  it('requires a contactable guest', async () => {
    assert.equal((await book({guestName: undefined, guestPhone: undefined})).status, 400);
    assert.equal((await book({guestName: '   ', guestPhone: '   '})).status, 400);
  });

  it('takes a booking with no table for later assignment', async () => {
    const res = await book({table: null});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.table, null);
  });

  it('validates the payload strictly', async () => {
    assert.equal((await book({partySize: 0})).status, 400);
    assert.equal((await book({partySize: 2.5})).status, 400);
    assert.equal((await book({date: 'tomorrow'})).status, 400);
    assert.equal((await book({time: '7pm'})).status, 400);
    assert.equal((await book({durationMinutes: 5})).status, 400);
    assert.equal((await book({bogus: 1})).status, 400);
  });

  it('audits the booking', async () => {
    const res = await book();
    const entry = await Audit.findOne({
      entity: 'reservation', entityId: res.body._id, action: 'reservation_created'
    });
    assert.ok(entry);
    assert.equal(entry.after.reference, res.body.reference);
    assert.equal(String(entry.user), String(world.owner._id));
  });
});

// ── Capacity and conflicts ───────────────────────────────────────────────────
describe('Phase 6C — capacity and conflicts', () => {
  it('refuses a party larger than the table', async () => {
    const res = await book({partySize: 6, table: String(smallTable._id)});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /too small for a party of 6/);
  });

  it('accepts a party that exactly fills the table', async () => {
    assert.equal((await book({partySize: 2, table: String(smallTable._id)})).status, 201);
  });

  it('refuses an overlapping booking on the same table', async () => {
    assert.equal((await book({time: '19:00'})).status, 201);
    const clash = await book({time: '19:30'});
    assert.equal(clash.status, 409);
    assert.match(clash.body.message, /already reserved from 19:00/);
    // An earlier booking that runs into it also clashes.
    assert.equal((await book({time: '18:00', durationMinutes: 120})).status, 409);
  });

  it('allows a back-to-back booking once the window ends', async () => {
    assert.equal((await book({time: '19:00'})).status, 201); // ends 20:30
    assert.equal((await book({time: '20:30'})).status, 201);
  });

  it('allows the same slot on a different table', async () => {
    assert.equal((await book({time: '19:00', table: String(world.table._id)})).status, 201);
    assert.equal((await book({time: '19:00', table: String(bigTable._id)})).status, 201);
  });

  it('frees the slot once a booking is cancelled or marked no-show', async () => {
    const first = await book({time: '19:00'});
    assert.equal((await book({time: '19:00'})).status, 409);
    await request(`/api/reservations/${first.body._id}`, {
      method: 'DELETE', token: owner(), body: {reason: 'guest called'}
    });
    assert.equal((await book({time: '19:00'})).status, 201, 'a cancelled slot is bookable again');

    const second = await book({time: '22:00'});
    await setStatus(second.body._id, 'no_show');
    assert.equal((await book({time: '22:00'})).status, 201);
  });

  it('refuses a table at another branch or out of service', async () => {
    assert.equal((await book({table: String(world.tableB._id)})).status, 409);
    await request(`/api/tables/${bigTable._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'disabled'}
    });
    assert.equal((await book({table: String(bigTable._id)})).status, 409);
  });
});

// ── Lifecycle ────────────────────────────────────────────────────────────────
describe('Phase 6C — reservation lifecycle', () => {
  it('confirms, seats and completes a booking', async () => {
    const created = await book({table: String(bigTable._id), partySize: 4});
    const id = created.body._id;

    assert.equal((await setStatus(id, 'confirmed')).status, 200);
    const seated = await setStatus(id, 'seated');
    assert.equal(seated.status, 200, seated.body?.message);
    assert.equal(seated.body.reservation.status, 'seated');
    assert.ok(seated.body.reservation.seatedAt);
    assert.equal((await RestaurantTable.findById(bigTable._id)).status, 'occupied',
      'seating claims the table');

    const done = await setStatus(id, 'completed');
    assert.equal(done.status, 200);
    assert.ok(done.body.reservation.completedAt);
  });

  it('refuses to seat a booking with no table', async () => {
    const created = await book({table: null});
    const res = await setStatus(created.body._id, 'seated');
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Assign a table/);
  });

  it('refuses to seat when the table already has an open check', async () => {
    const created = await book({table: String(bigTable._id)});
    const order = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id), type: 'dine-in',
        table: String(bigTable._id), items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(order.status, 201, order.body?.message);
    const res = await setStatus(created.body._id, 'seated');
    assert.equal(res.status, 409);
    assert.match(res.body.message, /already has an open check/);
  });

  it('refuses an illegal transition', async () => {
    const created = await book();
    assert.equal((await setStatus(created.body._id, 'completed')).status, 409,
      'a booking must be seated before it can complete');
    await setStatus(created.body._id, 'cancelled');
    assert.equal((await setStatus(created.body._id, 'seated')).status, 409,
      'a cancelled booking is terminal');
  });

  it('holds the table when the arrival is imminent, and releases it on cancel', async () => {
    const created = await book({table: String(bigTable._id)});
    const held = await request(`/api/reservations/${created.body._id}/hold`, {
      method: 'POST', token: staff(), body: {}
    });
    assert.equal(held.status, 200, held.body?.message);
    assert.equal((await RestaurantTable.findById(bigTable._id)).status, 'reserved');

    await request(`/api/reservations/${created.body._id}`, {
      method: 'DELETE', token: owner(), body: {reason: 'no longer coming'}
    });
    assert.equal((await RestaurantTable.findById(bigTable._id)).status, 'available',
      'cancelling releases a held table');
  });
});

// ── Cancellation ─────────────────────────────────────────────────────────────
describe('Phase 6C — cancellation', () => {
  it('records who cancelled, when and why', async () => {
    const created = await book();
    const res = await request(`/api/reservations/${created.body._id}`, {
      method: 'DELETE', token: manager(), body: {reason: 'Guest called to cancel'}
    });
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.cancelled, true);

    const stored = await Reservation.findById(created.body._id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancellationReason, 'Guest called to cancel');
    assert.ok(stored.cancelledAt instanceof Date);
    assert.equal(String(stored.cancelledBy), String(world.manager._id));

    const entry = await Audit.findOne({
      entity: 'reservation', entityId: stored._id, action: 'reservation_status'
    });
    assert.ok(entry, 'cancellation is audited');
    assert.equal(entry.after.status, 'cancelled');
  });

  it('keeps the record rather than deleting it', async () => {
    const created = await book();
    await request(`/api/reservations/${created.body._id}`, {method: 'DELETE', token: owner(), body: {}});
    assert.ok(await Reservation.findById(created.body._id), 'the booking history survives');
  });

  it('marks a no-show distinctly from a cancellation', async () => {
    const created = await book();
    const res = await setStatus(created.body._id, 'no_show', {reason: 'never arrived'});
    assert.equal(res.status, 200);
    assert.equal(res.body.reservation.status, 'no_show');
  });

  it('cannot cancel twice', async () => {
    const created = await book();
    assert.equal((await request(`/api/reservations/${created.body._id}`, {
      method: 'DELETE', token: owner(), body: {}
    })).status, 200);
    assert.equal((await request(`/api/reservations/${created.body._id}`, {
      method: 'DELETE', token: owner(), body: {}
    })).status, 409);
  });
});

// ── Amending ─────────────────────────────────────────────────────────────────
describe('Phase 6C — amending a booking', () => {
  it('moves the slot and re-checks the table', async () => {
    const created = await book();
    const moved = await request(`/api/reservations/${created.body._id}`, {
      method: 'PATCH', token: owner(), body: {time: '20:00', partySize: 3}
    });
    assert.equal(moved.status, 200, moved.body?.message);
    assert.equal(moved.body.time, '20:00');
    assert.equal(moved.body.partySize, 3);
    assert.equal(new Date(moved.body.startsAt).toISOString(), '2026-09-01T14:15:00.000Z');
  });

  it('does not clash with itself when only the party changes', async () => {
    const created = await book();
    const res = await request(`/api/reservations/${created.body._id}`, {
      method: 'PATCH', token: owner(), body: {partySize: 4}
    });
    assert.equal(res.status, 200, 'a booking must not block its own amendment');
  });

  it('refuses a move onto an occupied slot or an undersized table', async () => {
    await book({time: '19:00', table: String(bigTable._id)});
    const second = await book({time: '19:00', table: String(smallTable._id), partySize: 2});
    const clash = await request(`/api/reservations/${second.body._id}`, {
      method: 'PATCH', token: owner(), body: {table: String(bigTable._id)}
    });
    assert.equal(clash.status, 409);
    const tooBig = await request(`/api/reservations/${second.body._id}`, {
      method: 'PATCH', token: owner(), body: {partySize: 8}
    });
    assert.equal(tooBig.status, 409);
  });

  it('refuses to amend a closed booking', async () => {
    const created = await book();
    await request(`/api/reservations/${created.body._id}`, {method: 'DELETE', token: owner(), body: {}});
    assert.equal((await request(`/api/reservations/${created.body._id}`, {
      method: 'PATCH', token: owner(), body: {time: '20:00'}
    })).status, 409);
  });
});

// ── Diary and availability ───────────────────────────────────────────────────
describe('Phase 6C — diary and availability', () => {
  it('lists the day with a covers summary', async () => {
    await book({time: '19:00', partySize: 2});
    await book({time: '21:00', partySize: 4, table: String(bigTable._id)});
    const res = await request(`/api/reservations?branch=${world.branchA._id}&date=${DATE}`, {token: staff()});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.summary.total, 2);
    assert.equal(res.body.summary.covers, 6);
    assert.equal(res.body.summary.byStatus.booked, 2);
    // Sorted by start time.
    assert.equal(res.body.reservations[0].time, '19:00');
    assert.ok(res.body.reservations[0].table.name);
  });

  it('filters by date, status and table', async () => {
    await book({time: '19:00'});
    await book({date: '2026-09-02', time: '19:00'});
    const day = await request(`/api/reservations?branch=${world.branchA._id}&date=${DATE}`, {token: owner()});
    assert.equal(day.body.summary.total, 1);

    const cancelled = await request(
      `/api/reservations?branch=${world.branchA._id}&status=cancelled`, {token: owner()}
    );
    assert.equal(cancelled.body.summary.total, 0);
    assert.equal((await request(
      `/api/reservations?branch=${world.branchA._id}&status=bogus`, {token: owner()}
    )).status, 400);
  });

  it('counts unassigned bookings so a host can seat them', async () => {
    await book({table: null});
    const res = await request(`/api/reservations?branch=${world.branchA._id}&date=${DATE}`, {token: owner()});
    assert.equal(res.body.summary.unassigned, 1);
  });

  it('reports which tables are free for a window', async () => {
    await book({time: '19:00', table: String(world.table._id)});
    const res = await request(
      `/api/reservations/availability?branch=${world.branchA._id}&date=${DATE}&time=19:00&partySize=2`,
      {token: owner()}
    );
    assert.equal(res.status, 200, res.body?.message);
    const free = res.body.available.map(t => t.name);
    const taken = res.body.unavailable.map(t => t.name);
    assert.ok(taken.includes('T1'), 'the booked table is unavailable');
    assert.ok(free.includes('Big-8') && free.includes('Deuce'));
    // A larger party excludes the two-seater.
    const bigger = await request(
      `/api/reservations/availability?branch=${world.branchA._id}&date=${DATE}&time=19:00&partySize=6`,
      {token: owner()}
    );
    assert.ok(!bigger.body.available.some(t => t.name === 'Deuce'));
  });

  it('validates the availability query', async () => {
    const base = `/api/reservations/availability?branch=${world.branchA._id}`;
    assert.equal((await request(`${base}&date=bad&time=19:00&partySize=2`, {token: owner()})).status, 400);
    assert.equal((await request(`${base}&date=${DATE}&time=19:00&partySize=0`, {token: owner()})).status, 400);
    assert.equal((await request('/api/reservations/availability', {token: owner()})).status, 400);
  });

  it('fetches a single booking', async () => {
    const created = await book();
    const res = await request(`/api/reservations/${created.body._id}`, {token: staff()});
    assert.equal(res.status, 200);
    assert.equal(res.body.reference, created.body.reference);
    assert.equal((await request('/api/reservations/not-an-id', {token: owner()})).status, 400);
    assert.equal((await request(
      `/api/reservations/${new mongoose.Types.ObjectId()}`, {token: owner()}
    )).status, 404);
  });
});

// ── Authorization and tenant isolation ───────────────────────────────────────
describe('Phase 6C — authorization and tenant isolation', () => {
  it('lets front-of-house staff take and manage bookings', async () => {
    const created = await book({}, staff());
    assert.equal(created.status, 201, created.body?.message);
    assert.equal((await setStatus(created.body._id, 'confirmed', {}, staff())).status, 200);
  });

  it('rejects anonymous and guest access', async () => {
    assert.equal((await request(`/api/reservations?branch=${world.branchA._id}`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request(
      `/api/reservations?branch=${world.branchA._id}`, {token: guest}
    )).status, 403);
    assert.equal((await book({}, guest)).status, 403);
  });

  it('confines a manager to their own branch', async () => {
    assert.equal((await request(
      `/api/reservations?branch=${world.branchB._id}`, {token: manager()}
    )).status, 403);
    assert.equal((await book({branch: String(world.branchB._id)}, manager())).status, 403);
  });

  it('blocks another restaurant entirely', async () => {
    const restaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival', code: 'RVL'});
    const rival = await User.create({
      name: 'Rival Owner', email: 'rival6c@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival Co', restaurantId: restaurant._id, branch: branch._id
    });
    const token = tokenFor(rival);
    const mine = await book();

    assert.ok([403, 404].includes((await request(
      `/api/reservations?branch=${world.branchA._id}`, {token}
    )).status));
    assert.ok([403, 404].includes((await request(
      `/api/reservations/${mine.body._id}`, {token}
    )).status));
    assert.ok([403, 404].includes((await setStatus(mine.body._id, 'cancelled', {}, token)).status));
    assert.ok([403, 404].includes((await book({}, token)).status));

    assert.equal((await Reservation.findById(mine.body._id)).status, 'booked',
      'the rival must not have altered our booking');
  });
});
