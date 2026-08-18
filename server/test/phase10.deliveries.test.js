/**
 * Phase 10 — customer addresses and delivery management.
 *
 * The security question this phase introduces is the rider: a new, lowest-
 * privilege role that must see ONLY the deliveries assigned to it. A large
 * share of these tests exist to prove a rider cannot reach a branch queue,
 * another rider's job, another restaurant's data, or the staff surfaces that
 * were previously guarded by a bare auth().
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, User} from '../src/models/index.js';
import {Branch, Customer, Delivery, Order, Restaurant} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {
  canTransitionDelivery,
  LIVE_DELIVERY_STATUSES
} from '../src/services/deliveries.js';
import {migrateDeliveries} from '../src/services/deliveryMigration.js';

let world;
let rider;
let riderB;
let customer;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Delivery.init();

  rider = await User.create({
    name: 'Kumar Rider', email: 'kumar@test.com', password: 'x', role: 'rider',
    restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true, vehicle: 'motorcycle', maxConcurrent: 3}
  });
  riderB = await User.create({
    name: 'Sunil Rider', email: 'sunil@test.com', password: 'x', role: 'rider',
    restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true, vehicle: 'scooter', maxConcurrent: 3}
  });
  customer = await Customer.create({
    restaurant: world.restaurant._id, branch: world.branchA._id,
    name: 'Ram Thapa', phone: '9800000001', phoneKey: '9800000001'
  });
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const riderToken = () => tokenFor(rider);
const riderBToken = () => tokenFor(riderB);
const BRANCH = () => String(world.branchA._id);

/** A delivery order that has been cooked and is ready to leave. */
async function readyDeliveryOrder({branch = world.branchA, token = manager()} = {}) {
  const created = await request('/api/orders', {
    method: 'POST', token,
    body: {
      branch: String(branch._id), type: 'delivery', customer: String(customer._id),
      deliveryAddress: 'Jhamsikhel, Lalitpur',
      items: [{menuItem: String(world.menu._id), qty: 1}]
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const status of ['accepted', 'preparing', 'ready']) {
    const moved = await request(`/api/orders/${created.body._id}/status`, {
      method: 'PATCH', token, body: {status}
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
  }
  return created.body;
}

const dispatch = (order, body = {}, token = manager()) =>
  request('/api/deliveries', {method: 'POST', token, body: {order: String(order._id), ...body}});

const setStatus = (id, status, token, extra = {}) =>
  request(`/api/deliveries/${id}/status`, {method: 'PATCH', token, body: {status, ...extra}});

async function seedRival() {
  const restaurant = await Restaurant.create({name: 'Rival Kitchen', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL', address: 'Thamel'
  });
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurant: 'Rival Kitchen', restaurantId: restaurant._id
  });
  const rivalRider = await User.create({
    name: 'Rival Rider', email: 'rivalrider@test.com', password: 'x', role: 'rider',
    restaurant: 'Rival Kitchen', restaurantId: restaurant._id, branch: branch._id,
    rider: {active: true, available: true}
  });
  return {restaurant, branch, owner: rivalOwner, rider: rivalRider};
}

// ═══════════════════════════════════════════════════════════════════════════
// Addresses
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — customer addresses', () => {
  const addAddress = (body, token = manager()) =>
    request(`/api/customers/${customer._id}/addresses`, {method: 'POST', token, body});

  it('adds multiple labelled addresses with delivery instructions', async () => {
    const home = await addAddress({
      label: 'Home', address: 'Jhamsikhel, Lalitpur', instructions: 'Blue gate, ring twice'
    });
    assert.equal(home.status, 201, JSON.stringify(home.body));
    const office = await addAddress({label: 'Office', address: 'Durbarmarg, Kathmandu'});
    assert.equal(office.status, 201);

    const stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses.length, 2);
    assert.equal(stored.addresses[0].instructions, 'Blue gate, ring twice');
    assert.equal(stored.addresses[0].label, 'Home');
  });

  it('makes the first address the default automatically', async () => {
    await addAddress({label: 'Home', address: 'Jhamsikhel, Lalitpur'});
    const stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses[0].default, true,
      'a customer with addresses must always have a default');
  });

  it('keeps exactly one default when another is promoted', async () => {
    await addAddress({label: 'Home', address: 'Jhamsikhel, Lalitpur'});
    await addAddress({label: 'Office', address: 'Durbarmarg, Kathmandu'});
    let stored = await Customer.findById(customer._id);
    const officeId = stored.addresses[1]._id;

    const promoted = await request(`/api/customers/${customer._id}/addresses/${officeId}`, {
      method: 'PATCH', token: manager(), body: {default: true}
    });
    assert.equal(promoted.status, 200);

    stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses.filter(a => a.default).length, 1);
    assert.equal(String(stored.addresses.find(a => a.default)._id), String(officeId));
  });

  it('validates the address and rejects a duplicate', async () => {
    assert.equal((await addAddress({label: 'Home', address: 'x'})).status, 400,
      'a two-character address is not deliverable');
    await addAddress({label: 'Home', address: 'Jhamsikhel, Lalitpur'});
    const again = await addAddress({label: 'Home 2', address: 'jhamsikhel, lalitpur'});
    assert.equal(again.status, 409, 'the same place saved twice is a slip, not two addresses');
  });

  it('edits an address without disturbing the others', async () => {
    await addAddress({label: 'Home', address: 'Jhamsikhel, Lalitpur'});
    await addAddress({label: 'Office', address: 'Durbarmarg, Kathmandu'});
    let stored = await Customer.findById(customer._id);
    const homeId = stored.addresses[0]._id;

    await request(`/api/customers/${customer._id}/addresses/${homeId}`, {
      method: 'PATCH', token: manager(),
      body: {address: 'Sanepa, Lalitpur', instructions: 'Second floor'}
    });

    stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses[0].address, 'Sanepa, Lalitpur');
    assert.equal(stored.addresses[0].instructions, 'Second floor');
    assert.equal(stored.addresses[1].address, 'Durbarmarg, Kathmandu', 'the other is untouched');
  });

  it('deletes an address and re-homes the default', async () => {
    await addAddress({label: 'Home', address: 'Jhamsikhel, Lalitpur'});
    await addAddress({label: 'Office', address: 'Durbarmarg, Kathmandu'});
    let stored = await Customer.findById(customer._id);
    const defaultId = stored.addresses.find(a => a.default)._id;

    const removed = await request(`/api/customers/${customer._id}/addresses/${defaultId}`, {
      method: 'DELETE', token: manager()
    });
    assert.equal(removed.status, 200);

    stored = await Customer.findById(customer._id);
    assert.equal(stored.addresses.length, 1);
    assert.equal(stored.addresses[0].default, true,
      'deleting the default must promote another, not leave the customer defaultless');
  });

  it('caps the address book and audits changes', async () => {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await addAddress({label: `A${i}`, address: `Street number ${i}, Lalitpur`})).status, 201);
    }
    assert.equal((await addAddress({label: 'Too many', address: 'Eleventh Street, Lalitpur'})).status, 409);
    assert.ok(await Audit.findOne({action: 'customer_address_added'}).lean());
  });

  it('refuses address changes on another restaurant\'s customer', async () => {
    const rivalWorld = await seedRival();
    const theirs = await Customer.create({
      restaurant: rivalWorld.restaurant._id, branch: rivalWorld.branch._id,
      name: 'Their Guest', phone: '9805555555', phoneKey: '9805555555'
    });
    const res = await request(`/api/customers/${theirs._id}/addresses`, {
      method: 'POST', token: owner(), body: {label: 'Home', address: 'Somewhere in Thamel'}
    });
    assert.equal(res.status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dispatch and the state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — dispatch', () => {
  it('creates a pending delivery carrying the order address', async () => {
    const order = await readyDeliveryOrder();
    const res = await dispatch(order);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.address, 'Jhamsikhel, Lalitpur');
    // Tenancy is denormalised so rider queries never join through the order.
    assert.equal(String(res.body.branch), BRANCH());
    assert.equal(String(res.body.restaurant), String(world.restaurant._id));
  });

  it('can dispatch straight to a rider', async () => {
    const order = await readyDeliveryOrder();
    const res = await dispatch(order, {rider: String(rider._id), estimatedMinutes: 30});
    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'assigned');
    assert.ok(res.body.assignedAt);
    assert.equal(res.body.assignmentHistory.length, 1);
    assert.ok(res.body.dueAt, 'an ETA sets a due time so the dashboard can flag lateness');
  });

  it('refuses a second delivery for the same order', async () => {
    const order = await readyDeliveryOrder();
    assert.equal((await dispatch(order)).status, 201);
    const again = await dispatch(order);
    assert.equal(again.status, 409, 'a duplicate dispatch would send two riders');
    assert.match(again.body.message, /already has a delivery/);
    assert.equal(await Delivery.countDocuments({order: order._id}), 1);
  });

  it('enforces uniqueness at the database, not only in application code', async () => {
    const order = await readyDeliveryOrder();
    await dispatch(order);
    await assert.rejects(
      Delivery.create({
        order: order._id, branch: world.branchA._id, restaurant: world.restaurant._id,
        address: 'Second dispatch, Lalitpur', status: 'pending'
      }),
      error => error.code === 11000,
      'the unique index is the real guarantee'
    );
  });

  it('refuses to dispatch a non-delivery order or one that is not ready', async () => {
    const counter = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {branch: BRANCH(), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    const wrongType = await dispatch(counter.body);
    assert.equal(wrongType.status, 409);
    assert.match(wrongType.body.message, /Only a delivery order/);

    const draft = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'delivery', customer: String(customer._id),
        deliveryAddress: 'Jhamsikhel, Lalitpur',
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    await Order.updateOne({_id: draft.body._id}, {$set: {status: 'cancelled'}});
    const cancelled = await dispatch(draft.body);
    assert.equal(cancelled.status, 409);
  });

  it('walks the full lifecycle and completes the order', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const id = created.body._id;

    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      const moved = await setStatus(id, status, riderToken());
      assert.equal(moved.status, 200, `${status}: ${JSON.stringify(moved.body)}`);
      assert.equal(moved.body.status, status);
    }

    const stored = await Delivery.findById(id);
    assert.ok(stored.pickedUpAt && stored.dispatchedAt && stored.deliveredAt,
      'each stage is stamped for dashboard ageing');

    const completed = await Order.findById(order._id);
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completedAt instanceof Date,
      'delivery completion must stamp the order, or it drops out of kitchen metrics');
  });

  it('moves the order to out_for_delivery when the rider departs', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    await setStatus(created.body._id, 'picked_up', riderToken());
    await setStatus(created.body._id, 'out_for_delivery', riderToken());
    assert.equal((await Order.findById(order._id)).status, 'out_for_delivery');
  });

  it('rejects invalid transitions', () => {
    assert.equal(canTransitionDelivery('pending', 'delivered'), false);
    assert.equal(canTransitionDelivery('assigned', 'delivered'), false);
    assert.equal(canTransitionDelivery('delivered', 'out_for_delivery'), false);
    assert.equal(canTransitionDelivery('cancelled', 'assigned'), false);
    assert.equal(canTransitionDelivery('failed', 'delivered'), false);
    assert.equal(canTransitionDelivery('pending', 'assigned'), true);
    assert.equal(canTransitionDelivery('out_for_delivery', 'delivered'), true);
  });

  it('refuses an invalid transition over HTTP', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const skipped = await setStatus(created.body._id, 'delivered', manager());
    assert.equal(skipped.status, 409, 'a rider cannot arrive before collecting the food');
    assert.match(skipped.body.message, /cannot become/);
    assert.equal((await Delivery.findById(created.body._id)).status, 'assigned');
  });

  it('cannot un-complete a delivered job', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const id = created.body._id;
    await setStatus(id, 'picked_up', riderToken());
    await setStatus(id, 'out_for_delivery', riderToken());
    await setStatus(id, 'delivered', riderToken());

    const reverted = await setStatus(id, 'out_for_delivery', manager());
    assert.equal(reverted.status, 409);
    assert.equal((await Delivery.findById(id)).status, 'delivered');
  });

  it('requires a reason to fail a delivery', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const bare = await setStatus(created.body._id, 'failed', riderToken());
    assert.equal(bare.status, 400);

    const withReason = await setStatus(created.body._id, 'failed', riderToken(), {
      reason: 'Customer did not answer the door'
    });
    assert.equal(withReason.status, 200);
    const stored = await Delivery.findById(created.body._id);
    assert.equal(stored.failureReason, 'Customer did not answer the door');
    assert.ok(stored.failedAt);
    // A failed delivery must not silently complete the order.
    assert.notEqual((await Order.findById(order._id)).status, 'completed');
  });

  it('will not advance a delivery that has no rider', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order);
    const res = await setStatus(created.body._id, 'picked_up', manager());
    assert.equal(res.status, 409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Assignment and reassignment
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — assignment', () => {
  it('assigns a rider to a pending delivery', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order);
    const assigned = await request(`/api/deliveries/${created.body._id}/assign`, {
      method: 'POST', token: manager(), body: {rider: String(rider._id)}
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.status, 'assigned');
    assert.equal(String(assigned.body.rider), String(rider._id));
    assert.ok(await Audit.findOne({action: 'delivery_assigned'}).lean());
  });

  it('reassigns and records the history', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const moved = await request(`/api/deliveries/${created.body._id}/assign`, {
      method: 'POST', token: manager(),
      body: {rider: String(riderB._id), reason: 'Bike broke down'}
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(String(moved.body.rider), String(riderB._id));

    const stored = await Delivery.findById(created.body._id);
    assert.equal(stored.assignmentHistory.length, 2);
    assert.equal(stored.assignmentHistory[1].action, 'reassigned');
    assert.equal(stored.assignmentHistory[1].reason, 'Bike broke down');
    assert.ok(await Audit.findOne({action: 'delivery_reassigned'}).lean());
  });

  it('rewinds an in-flight job so the new rider is not credited with the old work', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    await setStatus(created.body._id, 'picked_up', riderToken());
    await setStatus(created.body._id, 'out_for_delivery', riderToken());

    await request(`/api/deliveries/${created.body._id}/assign`, {
      method: 'POST', token: manager(), body: {rider: String(riderB._id)}
    });

    const stored = await Delivery.findById(created.body._id);
    assert.equal(stored.status, 'assigned');
    assert.equal(stored.pickedUpAt, null, 'the new rider has not collected anything yet');
    assert.equal(stored.dispatchedAt, null);
  });

  it('refuses to reassign a completed delivery', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const id = created.body._id;
    await setStatus(id, 'picked_up', riderToken());
    await setStatus(id, 'out_for_delivery', riderToken());
    await setStatus(id, 'delivered', riderToken());

    const res = await request(`/api/deliveries/${id}/assign`, {
      method: 'POST', token: manager(), body: {rider: String(riderB._id)}
    });
    assert.equal(res.status, 409);
  });

  it('refuses a no-op reassignment to the same rider', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const res = await request(`/api/deliveries/${created.body._id}/assign`, {
      method: 'POST', token: manager(), body: {rider: String(rider._id)}
    });
    assert.equal(res.status, 409);
  });

  it('refuses an inactive rider', async () => {
    await User.updateOne({_id: rider._id}, {$set: {'rider.active': false}});
    const order = await readyDeliveryOrder();
    const res = await dispatch(order, {rider: String(rider._id)});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /inactive/);
  });

  it('respects the rider capacity limit', async () => {
    await User.updateOne({_id: rider._id}, {$set: {'rider.maxConcurrent': 1}});
    const first = await readyDeliveryOrder();
    assert.equal((await dispatch(first, {rider: String(rider._id)})).status, 201);

    const second = await readyDeliveryOrder();
    const overloaded = await dispatch(second, {rider: String(rider._id)});
    assert.equal(overloaded.status, 409, 'stacking jobs on one rider is how food goes cold');
    assert.match(overloaded.body.message, /delivery limit/);
  });

  it('frees capacity once a delivery finishes', async () => {
    await User.updateOne({_id: rider._id}, {$set: {'rider.maxConcurrent': 1}});
    const first = await readyDeliveryOrder();
    const created = await dispatch(first, {rider: String(rider._id)});
    await setStatus(created.body._id, 'picked_up', riderToken());
    await setStatus(created.body._id, 'out_for_delivery', riderToken());
    await setStatus(created.body._id, 'delivered', riderToken());

    const second = await readyDeliveryOrder();
    assert.equal((await dispatch(second, {rider: String(rider._id)})).status, 201);
  });

  it('refuses a rider who belongs to another branch', async () => {
    const otherBranchRider = await User.create({
      name: 'Branch B Rider', email: 'branchb@test.com', password: 'x', role: 'rider',
      restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchB._id,
      rider: {active: true, available: true}
    });
    const order = await readyDeliveryOrder();
    const res = await dispatch(order, {rider: String(otherBranchRider._id)});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /another branch/);
  });

  it('refuses a rider from another restaurant', async () => {
    const rivalWorld = await seedRival();
    const order = await readyDeliveryOrder();
    const res = await dispatch(order, {rider: String(rivalWorld.rider._id)});
    assert.equal(res.status, 404, 'a rival rider must not even be addressable');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rider authorisation — the core security of this phase
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — rider authorisation', () => {
  it('shows a rider only their own queue', async () => {
    const mine = await readyDeliveryOrder();
    const theirs = await readyDeliveryOrder();
    await dispatch(mine, {rider: String(rider._id)});
    await dispatch(theirs, {rider: String(riderB._id)});

    const queue = await request('/api/deliveries/mine', {token: riderToken()});
    assert.equal(queue.status, 200);
    assert.equal(queue.body.length, 1);
    assert.equal(String(queue.body[0].rider), String(rider._id));
  });

  it('hides unassigned deliveries from every rider', async () => {
    const order = await readyDeliveryOrder();
    await dispatch(order);
    const queue = await request('/api/deliveries/mine', {token: riderToken()});
    assert.equal(queue.body.length, 0, 'a rider must not browse the pending pool');
  });

  it('refuses a rider access to another rider\'s delivery', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(riderB._id)});
    const id = created.body._id;

    // Reported as missing, not forbidden, so ids cannot be probed.
    assert.equal((await request(`/api/deliveries/mine/${id}`, {token: riderToken()})).status, 404);
    const hijack = await setStatus(id, 'picked_up', riderToken());
    assert.equal(hijack.status, 404);
    assert.equal((await Delivery.findById(id)).status, 'assigned');
  });

  it('keeps riders out of every staff surface', async () => {
    const order = await readyDeliveryOrder();
    await dispatch(order, {rider: String(rider._id)});

    for (const [path, options] of [
      ['/api/deliveries', {}],
      [`/api/deliveries?branch=${BRANCH()}`, {}],
      ['/api/deliveries/dashboard', {}],
      ['/api/riders', {}],
      ['/api/orders', {}],
      ['/api/customers/search?q=9800000001', {}],
      [`/api/kitchen/board?branch=${BRANCH()}`, {}]
    ]) {
      const res = await request(path, {token: riderToken(), ...options});
      assert.equal(res.status, 403, `${path} must be closed to riders (got ${res.status})`);
    }
  });

  it('does not let the rider role widen the legacy bare-auth endpoints', async () => {
    // Adding a role to the enum silently widens every auth() with no role list.
    // These were tightened to requireStaff() in the same change.
    for (const path of ['/api/branches', '/api/transfers', '/api/expenses']) {
      const res = await request(path, {token: riderToken()});
      assert.equal(res.status, 403, `${path} must not be reachable by a rider`);
    }
  });

  it('lets a rider advance only their own job, and not cancel it', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    assert.equal((await setStatus(created.body._id, 'picked_up', riderToken())).status, 200);

    const cancelled = await setStatus(created.body._id, 'cancelled', riderToken());
    assert.equal(cancelled.status, 403, 'cancelling has money in it; that is a management call');
    assert.equal((await Delivery.findById(created.body._id)).status, 'picked_up');
  });

  it('lets a rider set their own shift state only', async () => {
    const off = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: false}
    });
    assert.equal(off.status, 200);
    assert.equal(off.body.available, false);

    // They cannot promote themselves through the rider profile endpoint.
    const escalate = await request(`/api/riders/${rider._id}`, {
      method: 'PATCH', token: riderToken(), body: {maxConcurrent: 20}
    });
    assert.equal(escalate.status, 403);
  });

  it('stops a deactivated rider from putting themselves back on shift', async () => {
    await User.updateOne({_id: rider._id}, {$set: {'rider.active': false, 'rider.available': false}});
    const res = await request('/api/deliveries/mine/availability', {
      method: 'PATCH', token: riderToken(), body: {available: true}
    });
    assert.equal(res.status, 403);
  });

  it('isolates riders across restaurants', async () => {
    const rivalWorld = await seedRival();
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});

    const intruder = tokenFor(rivalWorld.rider);
    assert.equal((await request('/api/deliveries/mine', {token: intruder})).body.length, 0);
    assert.equal(
      (await request(`/api/deliveries/mine/${created.body._id}`, {token: intruder})).status, 404
    );
    assert.equal((await setStatus(created.body._id, 'picked_up', intruder)).status, 404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cross-branch and cross-tenant staff access
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — branch and tenant isolation', () => {
  it('refuses a rival to dispatch, read or advance our delivery', async () => {
    const rivalWorld = await seedRival();
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    const rivalToken = tokenFor(rivalWorld.owner);

    assert.ok([403, 404].includes((await dispatch(order, {}, rivalToken)).status));
    assert.ok([403, 404].includes((await setStatus(created.body._id, 'picked_up', rivalToken)).status));
    assert.ok([403, 404].includes((await request(`/api/deliveries/${created.body._id}/assign`, {
      method: 'POST', token: rivalToken, body: {rider: String(rivalWorld.rider._id)}
    })).status));

    const theirList = await request('/api/deliveries', {token: rivalToken});
    assert.equal(theirList.body.length, 0, 'a rival must see none of our deliveries');
    assert.equal((await Delivery.findById(created.body._id)).status, 'assigned');
  });

  it('confines a branch manager to their own branch', async () => {
    const order = await readyDeliveryOrder();
    await dispatch(order, {rider: String(rider._id)});

    const otherBranch = await request(`/api/deliveries?branch=${world.branchB._id}`, {
      token: manager()
    });
    assert.equal(otherBranch.status, 403, 'the seeded manager belongs to branch A');

    const own = await request(`/api/deliveries?branch=${BRANCH()}`, {token: manager()});
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 1);
  });

  it('lets an owner see across branches', async () => {
    const atA = await readyDeliveryOrder();
    await dispatch(atA);
    const all = await request('/api/deliveries', {token: owner()});
    assert.equal(all.status, 200);
    assert.equal(all.body.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rider management
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — rider management', () => {
  it('lists riders with their live load', async () => {
    const order = await readyDeliveryOrder();
    await dispatch(order, {rider: String(rider._id)});

    const res = await request('/api/riders', {token: manager()});
    assert.equal(res.status, 200);
    const busy = res.body.find(x => String(x._id) === String(rider._id));
    assert.equal(busy.activeDeliveries, 1);
    assert.equal(busy.atCapacity, false);
    const idle = res.body.find(x => String(x._id) === String(riderB._id));
    assert.equal(idle.activeDeliveries, 0);
  });

  it('filters to available riders and hides inactive ones', async () => {
    await User.updateOne({_id: riderB._id}, {$set: {'rider.available': false}});
    const available = await request('/api/riders?available=true', {token: manager()});
    assert.equal(available.body.length, 1);
    assert.equal(String(available.body[0]._id), String(rider._id));

    await User.updateOne({_id: riderB._id}, {$set: {'rider.active': false}});
    assert.equal((await request('/api/riders', {token: manager()})).body.length, 1);
    assert.equal((await request('/api/riders?includeInactive=true', {token: manager()})).body.length, 2);
  });

  it('updates a rider profile and takes a deactivated rider off shift', async () => {
    const res = await request(`/api/riders/${rider._id}`, {
      method: 'PATCH', token: manager(),
      body: {vehicle: 'bicycle', licencePlate: 'BA-2-PA-1234', maxConcurrent: 5}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.rider.vehicle, 'bicycle');
    assert.equal(res.body.rider.maxConcurrent, 5);

    const stood = await request(`/api/riders/${rider._id}`, {
      method: 'PATCH', token: manager(), body: {active: false}
    });
    assert.equal(stood.body.rider.active, false);
    assert.equal(stood.body.rider.available, false,
      'standing a rider down must remove them from the available pool');
  });

  it('will not mark an inactive rider available', async () => {
    await request(`/api/riders/${rider._id}`, {
      method: 'PATCH', token: manager(), body: {active: false}
    });
    const res = await request(`/api/riders/${rider._id}`, {
      method: 'PATCH', token: manager(), body: {available: true}
    });
    assert.equal(res.status, 409);
  });

  it('reports rider delivery history and performance', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    await setStatus(created.body._id, 'picked_up', riderToken());
    await setStatus(created.body._id, 'out_for_delivery', riderToken());
    await setStatus(created.body._id, 'delivered', riderToken());

    const res = await request(`/api/riders/${rider._id}/history`, {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.stats.total, 1);
    assert.equal(res.body.stats.delivered, 1);
    assert.equal(res.body.stats.failed, 0);
    assert.equal(res.body.deliveries.length, 1);
  });

  it('refuses rider history across restaurants', async () => {
    const rivalWorld = await seedRival();
    const res = await request(`/api/riders/${rivalWorld.rider._id}/history`, {token: owner()});
    assert.equal(res.status, 404);
  });

  it('reserves rider administration for supervisors', async () => {
    assert.equal((await request(`/api/riders/${rider._id}`, {
      method: 'PATCH', token: staff(), body: {vehicle: 'car'}
    })).status, 403);
    assert.equal((await request(`/api/riders/${rider._id}/history`, {token: staff()})).status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — dispatch dashboard', () => {
  it('buckets deliveries by state', async () => {
    const pendingOrder = await readyDeliveryOrder();
    await dispatch(pendingOrder);

    const assignedOrder = await readyDeliveryOrder();
    await dispatch(assignedOrder, {rider: String(rider._id)});

    const activeOrder = await readyDeliveryOrder();
    const active = await dispatch(activeOrder, {rider: String(riderB._id)});
    await setStatus(active.body._id, 'picked_up', riderBToken());

    const res = await request(`/api/deliveries/dashboard?branch=${BRANCH()}`, {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.counts.pending, 1);
    assert.equal(res.body.counts.assigned, 1);
    assert.equal(res.body.counts.active, 1);
    assert.equal(res.body.counts.completed, 0);
  });

  it('flags a live delivery that is past its due time', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id), estimatedMinutes: 30});
    // Age it: lateness is derived from the clock, never a stored flag.
    await Delivery.updateOne(
      {_id: created.body._id},
      {$set: {dueAt: new Date(Date.now() - 10 * 60_000)}}
    );

    const res = await request(`/api/deliveries/dashboard?branch=${BRANCH()}`, {token: manager()});
    assert.equal(res.body.counts.delayed, 1);
    assert.equal(String(res.body.delayed[0]._id), String(created.body._id));
  });

  it('stops counting a delivery as delayed once it is delivered', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id), estimatedMinutes: 30});
    await Delivery.updateOne(
      {_id: created.body._id},
      {$set: {dueAt: new Date(Date.now() - 10 * 60_000)}}
    );
    await setStatus(created.body._id, 'picked_up', riderToken());
    await setStatus(created.body._id, 'out_for_delivery', riderToken());
    await setStatus(created.body._id, 'delivered', riderToken());

    const res = await request(`/api/deliveries/dashboard?branch=${BRANCH()}`, {token: manager()});
    assert.equal(res.body.counts.delayed, 0);
    assert.equal(res.body.counts.completed, 1);
  });

  it('separates failed and cancelled work', async () => {
    const order = await readyDeliveryOrder();
    const created = await dispatch(order, {rider: String(rider._id)});
    await setStatus(created.body._id, 'failed', riderToken(), {reason: 'Nobody home'});

    const res = await request(`/api/deliveries/dashboard?branch=${BRANCH()}`, {token: manager()});
    assert.equal(res.body.counts.failed, 1);
    assert.equal(res.body.counts.active, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Migration
// ═══════════════════════════════════════════════════════════════════════════

describe('10 — migration', () => {
  it('backfills tenancy, maps legacy statuses and retires duplicates', async () => {
    const order = await readyDeliveryOrder();

    // Exactly the pre-Phase-10 shape: no branch, no restaurant, legacy status,
    // and two rows for one order because nothing prevented it.
    const legacy = await Delivery.collection.insertOne({
      order: order._id, rider: rider._id, address: 'Old Road',
      status: 'picking_up', createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-02')
    });
    const duplicate = await Delivery.collection.insertOne({
      order: order._id, address: 'Old Road', status: 'available',
      createdAt: new Date('2024-01-03'), updatedAt: new Date('2024-01-03')
    });

    const result = await migrateDeliveries();
    assert.ok(result.backfilled >= 2);
    assert.equal(result.deduped, 1, 'the second dispatch for one order is retired');

    const migrated = await Delivery.findById(legacy.insertedId);
    assert.equal(String(migrated.branch), BRANCH());
    assert.equal(String(migrated.restaurant), String(world.restaurant._id));
    assert.equal(migrated.status, 'picked_up', 'picking_up maps to the new vocabulary');
    assert.ok(migrated.assignedAt, 'an assigned rider implies an assignment time');

    const retired = await Delivery.findById(duplicate.insertedId);
    assert.equal(retired.status, 'cancelled');
    assert.match(retired.failureReason, /Duplicate dispatch/);
  });

  it('leaves a unique constraint behind, so duplicates cannot reappear', async () => {
    // The model and the migration each declare this index. A mutation that
    // dropped `unique` from the MIGRATION alone previously went unnoticed,
    // because every other test relies on the model's autoIndex build. This
    // asserts the constraint the migration itself installs.
    const order = await readyDeliveryOrder();
    await Delivery.collection.dropIndex('delivery_order_unique').catch(() => null);
    await migrateDeliveries();

    const indexes = await Delivery.collection.indexes();
    const unique = indexes.find(i => i.name === 'delivery_order_unique');
    assert.ok(unique, 'the migration must install the index');
    assert.equal(unique.unique, true, 'and it must be unique, or duplicates return');

    await Delivery.create({
      order: order._id, branch: world.branchA._id, restaurant: world.restaurant._id,
      address: 'First dispatch, Lalitpur', status: 'pending'
    });
    await assert.rejects(
      Delivery.create({
        order: order._id, branch: world.branchA._id, restaurant: world.restaurant._id,
        address: 'Second dispatch, Lalitpur', status: 'pending'
      }),
      error => error.code === 11000
    );
  });

  it('is safe to run twice', async () => {
    const order = await readyDeliveryOrder();
    await Delivery.collection.insertOne({
      order: order._id, address: 'Old Road', status: 'available', createdAt: new Date()
    });
    await migrateDeliveries();
    const second = await migrateDeliveries();
    assert.equal(second.deduped, 0, 'a converged database needs no further cleanup');
  });

  it('exposes the live status list used for capacity and dashboards', () => {
    assert.deepEqual([...LIVE_DELIVERY_STATUSES],
      ['pending', 'assigned', 'picked_up', 'out_for_delivery']);
    assert.ok(!LIVE_DELIVERY_STATUSES.includes('delivered'));
  });
});
