/**
 * Phase 11 — rider-facing delivery operation.
 *
 * Phase 10 built the lifecycle and proved its authorisation boundaries. This
 * suite covers what Phase 11 adds, and — deliberately — re-proves the security
 * boundaries against the rider-facing surface rather than assuming Phase 10's
 * guarantees still hold now that new endpoints exist.
 *
 * Every assertion checks MongoDB state as well as the HTTP response: a 200 is
 * not evidence that anything was persisted.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {io as ioClient} from 'socket.io-client';
import {Audit, User} from '../src/models/index.js';
import {Branch, Customer, Delivery, Order, Restaurant} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let baseUrl;
let world;
let rider;
let riderB;
let customer;

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Delivery.init();

  rider = await User.create({
    name: 'Kumar Rider', email: 'kumar11@test.com', password: 'x', role: 'rider',
    restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true, vehicle: 'motorcycle', maxConcurrent: 3, phone: '9811111111'}
  });
  riderB = await User.create({
    name: 'Sunil Rider', email: 'sunil11@test.com', password: 'x', role: 'rider',
    restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true, vehicle: 'scooter', maxConcurrent: 3}
  });
  customer = await Customer.create({
    restaurant: world.restaurant._id, branch: world.branchA._id,
    name: 'Ram Thapa', phone: '9800000001', phoneKey: '9800000001'
  });
});

const manager = () => tokenFor(world.manager);
const riderToken = () => tokenFor(rider);
const riderBToken = () => tokenFor(riderB);
const BRANCH = () => String(world.branchA._id);

async function readyDeliveryOrder(token = manager()) {
  const created = await request('/api/orders', {
    method: 'POST', token,
    body: {
      branch: BRANCH(), type: 'delivery', customer: String(customer._id),
      deliveryAddress: 'Jhamsikhel, Lalitpur',
      items: [{menuItem: String(world.menu._id), qty: 1}]
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const status of ['accepted', 'preparing', 'ready']) {
    await request(`/api/orders/${created.body._id}/status`, {
      method: 'PATCH', token, body: {status}
    });
  }
  return created.body;
}

async function dispatchTo(who, extra = {}) {
  const order = await readyDeliveryOrder();
  const res = await request('/api/deliveries', {
    method: 'POST', token: manager(),
    body: {order: String(order._id), rider: String(who._id), ...extra}
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return {order, delivery: res.body};
}

const setStatus = (id, status, token, extra = {}) =>
  request(`/api/deliveries/${id}/status`, {method: 'PATCH', token, body: {status, ...extra}});

async function seedRival() {
  const restaurant = await Restaurant.create({name: 'Rival Kitchen', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL', address: 'Thamel'
  });
  const rivalRider = await User.create({
    name: 'Rival Rider', email: 'rivalrider11@test.com', password: 'x', role: 'rider',
    restaurant: 'Rival Kitchen', restaurantId: restaurant._id, branch: branch._id,
    rider: {active: true, available: true}
  });
  return {restaurant, branch, rider: rivalRider};
}

// ═══════════════════════════════════════════════════════════════════════════
// Step 2 — rider login and identity
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — rider login and identity', () => {
  it('logs a rider in and returns their role', async () => {
    const bcrypt = (await import('bcryptjs')).default;
    await User.updateOne({_id: rider._id}, {$set: {password: await bcrypt.hash('secret123', 12)}});

    const res = await request('/api/auth/login', {
      method: 'POST', body: {email: 'kumar11@test.com', password: 'secret123'}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'rider');
    assert.ok(res.body.token);

    // The issued token must actually work on the rider surface.
    const mine = await request('/api/deliveries/mine', {token: res.body.token});
    assert.equal(mine.status, 200);
  });

  it('rejects a bad password without revealing whether the account exists', async () => {
    const res = await request('/api/auth/login', {
      method: 'POST', body: {email: 'kumar11@test.com', password: 'wrong'}
    });
    assert.equal(res.status, 401);
    const missing = await request('/api/auth/login', {
      method: 'POST', body: {email: 'nobody@test.com', password: 'wrong'}
    });
    assert.equal(missing.status, 401);
    assert.deepEqual(res.body, missing.body, 'the two answers must be indistinguishable');
  });

  it('derives rider identity from the token, never from the request body', async () => {
    const {delivery} = await dispatchTo(riderB);
    // Rider A claims to be rider B in the payload. Identity comes from the
    // verified token, so this must not reach rider B's delivery.
    const forged = await request(`/api/deliveries/${delivery._id}/status`, {
      method: 'PATCH', token: riderToken(),
      body: {status: 'picked_up', rider: String(riderB._id)}
    });
    assert.ok([400, 403, 404].includes(forged.status), `got ${forged.status}`);
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned',
      'the delivery must be untouched in the database');
  });

  it('refuses anonymous, invalid and expired tokens on every rider route', async () => {
    const {delivery} = await dispatchTo(rider);
    const expired = jwt.sign(
      {id: String(rider._id), role: 'rider'}, process.env.JWT_SECRET, {expiresIn: '-1h'}
    );

    for (const path of [
      '/api/deliveries/mine',
      '/api/deliveries/mine/dashboard',
      `/api/deliveries/mine/${delivery._id}`
    ]) {
      assert.equal((await request(path)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {token: 'not.a.jwt'})).status, 401, `${path} invalid`);
      assert.equal((await request(path, {token: expired})).status, 401, `${path} expired`);
    }

    // An expired token must not be able to mutate either.
    assert.equal((await setStatus(delivery._id, 'picked_up', expired)).status, 401);
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned');
  });

  it('keeps staff out of rider-only endpoints and riders out of staff endpoints', async () => {
    const {delivery} = await dispatchTo(rider);

    for (const path of ['/api/deliveries/mine', '/api/deliveries/mine/dashboard']) {
      assert.equal((await request(path, {token: manager()})).status, 403, `${path} for staff`);
    }
    for (const path of [
      '/api/deliveries', '/api/deliveries/dashboard', '/api/riders',
      `/api/riders/${rider._id}/history`, '/api/orders', '/api/branches', '/api/expenses'
    ]) {
      assert.equal((await request(path, {token: riderToken()})).status, 403, `${path} for rider`);
    }
    assert.ok(delivery);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step 3/4 — dashboard and delivery detail
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — rider dashboard', () => {
  it('reports identity, workload, capacity and today\'s figures', async () => {
    await dispatchTo(rider);
    const res = await request('/api/deliveries/mine/dashboard', {token: riderToken()});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(res.body.rider.name, 'Kumar Rider');
    assert.equal(res.body.rider.available, true);
    assert.equal(res.body.rider.active, true);
    assert.equal(res.body.workload, 1);
    assert.equal(res.body.capacity, 3);
    assert.equal(res.body.atCapacity, false);
    assert.equal(res.body.today.delivered, 0);
    assert.equal(res.body.today.failed, 0);
    assert.ok(res.body.activeDelivery, 'the job in hand is surfaced');
  });

  it('counts only today\'s completed work, and only this rider\'s', async () => {
    const mine = await dispatchTo(rider);
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      assert.equal((await setStatus(mine.delivery._id, status, riderToken())).status, 200);
    }
    // Another rider's completed job must not appear in these figures.
    const theirs = await dispatchTo(riderB);
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      await setStatus(theirs.delivery._id, status, riderBToken());
    }

    const res = await request('/api/deliveries/mine/dashboard', {token: riderToken()});
    assert.equal(res.body.today.delivered, 1);
    assert.equal(res.body.workload, 0, 'a delivered job is no longer workload');
    assert.equal(res.body.activeDelivery, null);
  });

  it('excludes yesterday\'s deliveries from today\'s count', async () => {
    const {delivery} = await dispatchTo(rider);
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      await setStatus(delivery._id, status, riderToken());
    }
    // Backdate the completion; "today" must mean today.
    await Delivery.updateOne(
      {_id: delivery._id},
      {$set: {deliveredAt: new Date(Date.now() - 36 * 60 * 60 * 1000)}}
    );
    const res = await request('/api/deliveries/mine/dashboard', {token: riderToken()});
    assert.equal(res.body.today.delivered, 0);
  });

  it('flags a rider who is at capacity', async () => {
    await User.updateOne({_id: rider._id}, {$set: {'rider.maxConcurrent': 1}});
    await dispatchTo(rider);
    const res = await request('/api/deliveries/mine/dashboard', {token: riderToken()});
    assert.equal(res.body.atCapacity, true);
    assert.equal(res.body.capacity, 1);
  });
});

describe('11 — delivery detail', () => {
  it('gives the rider what they need to complete the job', async () => {
    const {delivery} = await dispatchTo(rider, {
      instructions: 'Blue gate, ring twice', estimatedMinutes: 30
    });
    const res = await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()});
    assert.equal(res.status, 200);

    assert.equal(res.body.address, 'Jhamsikhel, Lalitpur');
    assert.equal(res.body.instructions, 'Blue gate, ring twice');
    assert.equal(res.body.customerName, 'Ram Thapa', 'the rider must know who to ask for');
    assert.equal(res.body.customerPhone, '9800000001', 'and how to reach them at the door');
    assert.equal(res.body.status, 'assigned');
    assert.ok(res.body.dueAt);
    assert.ok(res.body.assignedAt);
    assert.equal(res.body.order.orderNo, (await Order.findById(delivery.order)).orderNo);
    assert.equal(res.body.order.collectOnDelivery, true, 'unpaid order means collect cash');
    assert.ok(res.body.order.amountDue > 0);
  });

  it('never exposes recipe costs, margins or inventory requirements', async () => {
    // These leaked before Phase 11: populating the order wholesale handed a
    // courier the restaurant's per-item food cost and recipe quantities.
    const {delivery} = await dispatchTo(rider);
    const res = await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()});
    const serialised = JSON.stringify(res.body);

    for (const secret of [
      'foodCost', 'recipeCost', 'packagingCost', 'inventoryRequirements',
      'recipeVersion', 'foodCostVersioned', 'basePrice'
    ]) {
      assert.doesNotMatch(serialised, new RegExp(secret, 'i'),
        `${secret} is internal margin/recipe data and must not reach a rider`);
    }
    // The same must hold for the list endpoint.
    const list = await request('/api/deliveries/mine', {token: riderToken()});
    assert.doesNotMatch(JSON.stringify(list.body), /foodCost|inventoryRequirements|recipeCost/i);
  });

  it('still tells the rider what is in the bag, by name and quantity', async () => {
    const {delivery} = await dispatchTo(rider);
    const res = await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()});
    assert.ok(Array.isArray(res.body.order.items));
    assert.equal(res.body.order.items[0].name, 'Chicken Biryani');
    assert.equal(res.body.order.items[0].qty, 1);
    assert.deepEqual(Object.keys(res.body.order.items[0]).sort(), ['name', 'qty']);
  });

  it('shows a failure reason once one exists', async () => {
    const {delivery} = await dispatchTo(rider);
    await setStatus(delivery._id, 'picked_up', riderToken());
    await setStatus(delivery._id, 'failed', riderToken(), {reason: 'Nobody at the address'});

    const res = await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()});
    assert.equal(res.body.status, 'failed');
    assert.equal(res.body.failureReason, 'Nobody at the address');
    assert.ok(res.body.failedAt);
  });

  it('separates a rider\'s active work from their finished work', async () => {
    const active = await dispatchTo(rider);
    const done = await dispatchTo(rider);
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      await setStatus(done.delivery._id, status, riderToken());
    }

    const live = await request('/api/deliveries/mine', {token: riderToken()});
    assert.equal(live.body.length, 1);
    assert.equal(String(live.body[0]._id), String(active.delivery._id));

    const all = await request('/api/deliveries/mine?includeCompleted=true', {token: riderToken()});
    assert.equal(all.body.length, 2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step 5 / 10 — lifecycle and authorisation
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — rider lifecycle actions', () => {
  it('walks assigned → picked_up → out_for_delivery → delivered, persisting each stamp', async () => {
    const {order, delivery} = await dispatchTo(rider);

    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      const res = await setStatus(delivery._id, status, riderToken());
      assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
      // Verify the database, not the response body.
      assert.equal((await Delivery.findById(delivery._id)).status, status);
    }

    const stored = await Delivery.findById(delivery._id);
    assert.ok(stored.pickedUpAt instanceof Date);
    assert.ok(stored.dispatchedAt instanceof Date);
    assert.ok(stored.deliveredAt instanceof Date);
    assert.ok(stored.pickedUpAt <= stored.dispatchedAt);
    assert.ok(stored.dispatchedAt <= stored.deliveredAt);

    const completed = await Order.findById(order._id);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completedAt instanceof Date);
  });

  it('writes an audit entry for every rider transition', async () => {
    const {delivery} = await dispatchTo(rider);
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      await setStatus(delivery._id, status, riderToken());
    }
    for (const action of ['delivery_picked_up', 'delivery_out_for_delivery', 'delivery_delivered']) {
      const entry = await Audit.findOne({action, entityId: delivery._id}).lean();
      assert.ok(entry, `${action} must be audited`);
      assert.equal(String(entry.user), String(rider._id), 'the acting rider is recorded');
    }
  });

  it('refuses a duplicate transition', async () => {
    const {delivery} = await dispatchTo(rider);
    assert.equal((await setStatus(delivery._id, 'picked_up', riderToken())).status, 200);
    const again = await setStatus(delivery._id, 'picked_up', riderToken());
    assert.equal(again.status, 409);
    assert.match(again.body.message, /already/i);

    const stored = await Delivery.findById(delivery._id);
    assert.equal(stored.status, 'picked_up');
  });

  it('refuses a skipped state', async () => {
    const {delivery} = await dispatchTo(rider);
    const skipped = await setStatus(delivery._id, 'delivered', riderToken());
    assert.equal(skipped.status, 409);
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned');
  });

  it('refuses to modify a completed delivery', async () => {
    const {delivery} = await dispatchTo(rider);
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      await setStatus(delivery._id, status, riderToken());
    }
    const stamped = (await Delivery.findById(delivery._id)).deliveredAt;

    for (const status of ['out_for_delivery', 'failed', 'picked_up']) {
      const res = await setStatus(delivery._id, status, riderToken(), {reason: 'x'});
      assert.equal(res.status, 409, `${status} must be refused on a delivered job`);
    }
    const after = await Delivery.findById(delivery._id);
    assert.equal(after.status, 'delivered');
    assert.equal(String(after.deliveredAt), String(stamped), 'the completion instant survives');
  });

  it('refuses to modify a cancelled delivery', async () => {
    const {delivery} = await dispatchTo(rider);
    assert.equal((await setStatus(delivery._id, 'cancelled', manager())).status, 200);

    const res = await setStatus(delivery._id, 'picked_up', riderToken());
    assert.equal(res.status, 409);
    assert.equal((await Delivery.findById(delivery._id)).status, 'cancelled');
  });

  it('requires a reason to fail, and does not complete the order', async () => {
    const {order, delivery} = await dispatchTo(rider);
    await setStatus(delivery._id, 'picked_up', riderToken());

    assert.equal((await setStatus(delivery._id, 'failed', riderToken())).status, 400);
    const failed = await setStatus(delivery._id, 'failed', riderToken(), {
      reason: 'Customer unreachable on arrival'
    });
    assert.equal(failed.status, 200);

    const stored = await Delivery.findById(delivery._id);
    assert.equal(stored.failureReason, 'Customer unreachable on arrival');
    assert.ok(stored.failedAt instanceof Date);
    assert.notEqual((await Order.findById(order._id)).status, 'completed');
  });

  it('does not let a rider cancel their own job', async () => {
    const {delivery} = await dispatchTo(rider);
    const res = await setStatus(delivery._id, 'cancelled', riderToken());
    assert.equal(res.status, 403, 'cancelling has money in it; that is a management decision');
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned');
  });
});

describe('11 — rider isolation', () => {
  it('shows a rider only their own deliveries', async () => {
    await dispatchTo(rider);
    await dispatchTo(riderB);

    const mine = await request('/api/deliveries/mine', {token: riderToken()});
    assert.equal(mine.body.length, 1);
    const dashboard = await request('/api/deliveries/mine/dashboard', {token: riderToken()});
    assert.equal(dashboard.body.workload, 1);
  });

  it('refuses a rider read or write on another rider\'s delivery', async () => {
    const {delivery} = await dispatchTo(riderB);

    // 404, not 403: a 403 would confirm the delivery exists.
    assert.equal(
      (await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()})).status, 404
    );
    for (const status of ['picked_up', 'out_for_delivery', 'delivered', 'failed']) {
      const res = await setStatus(delivery._id, status, riderToken(), {reason: 'x'});
      assert.equal(res.status, 404, `${status} must be refused`);
    }
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned');
  });

  it('hides unassigned deliveries from every rider', async () => {
    const order = await readyDeliveryOrder();
    const created = await request('/api/deliveries', {
      method: 'POST', token: manager(), body: {order: String(order._id)}
    });
    assert.equal(created.status, 201);

    assert.equal((await request('/api/deliveries/mine', {token: riderToken()})).body.length, 0);
    assert.equal(
      (await request(`/api/deliveries/mine/${created.body._id}`, {token: riderToken()})).status, 404
    );
  });

  it('isolates riders across restaurants', async () => {
    const rival = await seedRival();
    const {delivery} = await dispatchTo(rider);
    const intruder = tokenFor(rival.rider);

    assert.equal((await request('/api/deliveries/mine', {token: intruder})).body.length, 0);
    assert.equal(
      (await request(`/api/deliveries/mine/${delivery._id}`, {token: intruder})).status, 404
    );
    assert.equal((await setStatus(delivery._id, 'picked_up', intruder)).status, 404);
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned');

    const dash = await request('/api/deliveries/mine/dashboard', {token: intruder});
    assert.equal(dash.status, 200);
    assert.equal(dash.body.workload, 0, 'a rival rider sees an empty board, not ours');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step 6 — availability
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — rider availability', () => {
  it('persists and audits a rider going off and back on shift', async () => {
    const off = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: false}
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.available, false);
    assert.equal((await User.findById(rider._id)).rider.available, false, 'persisted');

    const entry = await Audit.findOne({action: 'rider_unavailable', entityId: rider._id}).lean();
    assert.ok(entry, 'going off shift mid-rush must be reconstructable');
    assert.equal(entry.before.available, true);
    assert.equal(entry.after.available, false);

    const on = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: true}
    });
    assert.equal(on.body.available, true);
    assert.ok(await Audit.findOne({action: 'rider_available', entityId: rider._id}).lean());
  });

  it('reflects availability on the dashboard', async () => {
    await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: false}
    });
    const res = await request('/api/deliveries/mine/dashboard', {token: riderToken()});
    assert.equal(res.body.rider.available, false);
  });

  it('stops a deactivated rider putting themselves back on shift', async () => {
    await User.updateOne({_id: rider._id}, {$set: {'rider.active': false, 'rider.available': false}});
    const res = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: true}
    });
    assert.equal(res.status, 403);
    assert.equal((await User.findById(rider._id)).rider.available, false);
  });

  it('changes only the caller\'s own shift state', async () => {
    await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: false}
    });
    assert.equal((await User.findById(riderB._id)).rider.available, true,
      'one rider going off shift must not affect another');
  });

  it('refuses extra fields, so a rider cannot widen their own limits', async () => {
    const res = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: true, maxConcurrent: 99}
    });
    assert.equal(res.status, 400);
    assert.equal((await User.findById(rider._id)).rider.maxConcurrent, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step 11 — reassignment integrity
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — reassignment integrity', () => {
  it('moves the job and does not credit the new rider with the old work', async () => {
    const {delivery} = await dispatchTo(rider);
    await setStatus(delivery._id, 'picked_up', riderToken());
    await setStatus(delivery._id, 'out_for_delivery', riderToken());

    const moved = await request(`/api/deliveries/${delivery._id}/assign`, {
      method: 'POST', token: manager(),
      body: {rider: String(riderB._id), reason: 'Bike broke down'}
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));

    const stored = await Delivery.findById(delivery._id);
    assert.equal(String(stored.rider), String(riderB._id));
    assert.equal(stored.status, 'assigned', 'the job rewinds for the new rider');
    assert.equal(stored.pickedUpAt, null, 'the new rider has not collected anything');
    assert.equal(stored.dispatchedAt, null);

    // History records both riders, so a dispute can be reconstructed.
    assert.equal(stored.assignmentHistory.length, 2);
    assert.equal(String(stored.assignmentHistory[0].rider), String(rider._id));
    assert.equal(stored.assignmentHistory[1].action, 'reassigned');
    assert.equal(stored.assignmentHistory[1].reason, 'Bike broke down');
  });

  it('removes the job from the old rider and gives it to the new one', async () => {
    const {delivery} = await dispatchTo(rider);
    await request(`/api/deliveries/${delivery._id}/assign`, {
      method: 'POST', token: manager(), body: {rider: String(riderB._id)}
    });

    assert.equal((await request('/api/deliveries/mine', {token: riderToken()})).body.length, 0);
    const theirs = await request('/api/deliveries/mine', {token: riderBToken()});
    assert.equal(theirs.body.length, 1);

    // The old rider must also lose the right to touch it.
    assert.equal((await setStatus(delivery._id, 'picked_up', riderToken())).status, 404);
    assert.equal((await setStatus(delivery._id, 'picked_up', riderBToken())).status, 200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step 9 — address safety
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — address safety', () => {
  it('snapshots the address so a later edit cannot rewrite the rider\'s job', async () => {
    const added = await request(`/api/customers/${customer._id}/addresses`, {
      method: 'POST', token: manager(),
      body: {label: 'Home', address: 'Jhamsikhel, Lalitpur', instructions: 'Blue gate'}
    });
    assert.equal(added.status, 201);
    const {delivery} = await dispatchTo(rider, {instructions: 'Blue gate'});

    const addressId = (await Customer.findById(customer._id)).addresses[0]._id;
    await request(`/api/customers/${customer._id}/addresses/${addressId}`, {
      method: 'PATCH', token: manager(),
      body: {address: 'Somewhere else entirely', instructions: 'Red door'}
    });

    const stored = await Delivery.findById(delivery._id);
    assert.equal(stored.address, 'Jhamsikhel, Lalitpur',
      'the rider must not be redirected mid-delivery by a CRM edit');
    assert.equal(stored.instructions, 'Blue gate');
  });

  it('keeps one default address across edits and deletion', async () => {
    for (const address of ['Jhamsikhel, Lalitpur', 'Durbarmarg, Kathmandu']) {
      await request(`/api/customers/${customer._id}/addresses`, {
        method: 'POST', token: manager(), body: {label: 'A', address}
      });
    }
    let stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses.filter(a => a.default).length, 1);

    const defaultId = stored.addresses.find(a => a.default)._id;
    await request(`/api/customers/${customer._id}/addresses/${defaultId}`, {
      method: 'DELETE', token: manager()
    });
    stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses.length, 1);
    assert.equal(stored.addresses.filter(a => a.default).length, 1,
      'deleting the default must promote another');
  });

  it('cannot reach an address belonging to another customer', async () => {
    const other = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: 'Other Guest', phone: '9800000099', phoneKey: '9800000099',
      addresses: [{label: 'Home', address: 'Their private street', default: true}]
    });
    const theirAddressId = other.addresses[0]._id;

    // Addressing it through a DIFFERENT customer must not work.
    const res = await request(`/api/customers/${customer._id}/addresses/${theirAddressId}`, {
      method: 'PATCH', token: manager(), body: {address: 'Hijacked street'}
    });
    assert.equal(res.status, 404);
    assert.equal((await Customer.findById(other._id)).addresses[0].address, 'Their private street');
  });

  it('rejects an unusable address', async () => {
    const res = await request(`/api/customers/${customer._id}/addresses`, {
      method: 'POST', token: manager(), body: {label: 'Home', address: 'x'}
    });
    assert.equal(res.status, 400);
    assert.equal((await Customer.findById(customer._id)).addresses.length, 0);
  });

  it('does not let a rider read or edit the customer address book', async () => {
    await dispatchTo(rider);
    assert.equal(
      (await request(`/api/customers/${customer._id}`, {token: riderToken()})).status, 403
    );
    const res = await request(`/api/customers/${customer._id}/addresses`, {
      method: 'POST', token: riderToken(), body: {label: 'X', address: 'Rider added this'}
    });
    assert.equal(res.status, 403);
    assert.equal((await Customer.findById(customer._id)).addresses.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Step 7 — Socket.IO rider rooms
// ═══════════════════════════════════════════════════════════════════════════

describe('11 — realtime rider rooms', () => {
  /** Connect a socket and resolve once connected, or reject on failure. */
  function connect(token, auth = {}) {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: {token, ...auth}, transports: ['websocket'], reconnection: false, timeout: 4000
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', error => reject(error));
    });
  }

  const nextEvent = (socket, event, ms = 4000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });

  it('rejects an unauthenticated socket', async () => {
    await assert.rejects(connect(undefined), /Authentication required/);
    await assert.rejects(connect('not.a.jwt'), /Authentication required/);
  });

  it('delivers a rider their own assignment in real time', async () => {
    const socket = await connect(riderToken());
    try {
      const arrival = nextEvent(socket, 'delivery:update');
      const {delivery} = await dispatchTo(rider);
      const payload = await arrival;
      assert.equal(String(payload.deliveryId), String(delivery._id));
      assert.equal(payload.status, 'assigned');
    } finally {
      socket.disconnect();
    }
  });

  it('does not leak another rider\'s delivery to an unrelated rider', async () => {
    const socket = await connect(riderToken());
    try {
      let leaked = null;
      socket.on('delivery:update', payload => { leaked = payload; });
      await dispatchTo(riderB);
      // Give the event loop a genuine chance to deliver a stray event.
      await new Promise(resolve => setTimeout(resolve, 400));
      assert.equal(leaked, null, 'rider A must hear nothing about rider B\'s job');
    } finally {
      socket.disconnect();
    }
  });

  it('refuses to join a branch room, so kitchen and stock traffic stays private', async () => {
    // A rider asking for a branch at handshake time is ignored, not honoured.
    const socket = await connect(riderToken(), {branch: BRANCH()});
    try {
      const ack = await new Promise(resolve => {
        socket.emit('join:branch', BRANCH(), resolve);
        setTimeout(() => resolve({ok: false, timedOut: true}), 3000);
      });
      assert.equal(ack.ok, false, 'a rider must never join a branch room');

      // Prove it: a branch-only event must not reach this socket.
      let heard = null;
      socket.on('inventory:update', payload => { heard = payload; });
      const {publishInventoryEvent} = await import('../src/services/realtime.js');
      publishInventoryEvent(world.branchA._id, {reason: 'test'});
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(heard, null, 'branch traffic must not reach a rider socket');
    } finally {
      socket.disconnect();
    }
  });

  it('notifies both riders when a job is reassigned', async () => {
    const {delivery} = await dispatchTo(rider);
    const socketB = await connect(riderBToken());
    try {
      const arrival = nextEvent(socketB, 'delivery:update');
      await request(`/api/deliveries/${delivery._id}/assign`, {
        method: 'POST', token: manager(), body: {rider: String(riderB._id)}
      });
      const payload = await arrival;
      assert.equal(String(payload.deliveryId), String(delivery._id));
    } finally {
      socketB.disconnect();
    }
  });

  it('pushes status changes to the assigned rider', async () => {
    const {delivery} = await dispatchTo(rider);
    const socket = await connect(riderToken());
    try {
      const arrival = nextEvent(socket, 'delivery:update');
      await setStatus(delivery._id, 'picked_up', riderToken());
      const payload = await arrival;
      assert.equal(payload.status, 'picked_up');
    } finally {
      socket.disconnect();
    }
  });
});
