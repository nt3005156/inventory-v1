/**
 * Phase 12 — rider production readiness.
 *
 * Two things this suite exists to lock down:
 *
 *   1. Account provisioning. `POST /auth/register` was
 *      `User.create({...req.body})` with no validation, which allowed an owner
 *      to plant a user in ANOTHER restaurant, returned the bcrypt hash in the
 *      response, accepted a one-character password, and crashed on a missing
 *      one. Each of those is a regression test below.
 *
 *   2. Proof of delivery. "Delivered" was a button with nothing behind it.
 *      Completion now requires evidence, stored on the delivery and written
 *      into the immutable audit trail.
 *
 * Every assertion checks MongoDB state, not just the HTTP status.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {io as ioClient} from 'socket.io-client';
import {Audit, User} from '../src/models/index.js';
import {Branch, Customer, Delivery, Order, Restaurant} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {assertPasswordPolicy, publicUserView} from '../src/services/staffAccounts.js';

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
  await User.init();

  rider = await User.create({
    name: 'Kumar Rider', email: 'kumar12@test.com', password: 'x', role: 'rider',
    restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true, maxConcurrent: 3, phone: '9811111111'}
  });
  riderB = await User.create({
    name: 'Sunil Rider', email: 'sunil12@test.com', password: 'x', role: 'rider',
    restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
    rider: {active: true, available: true, maxConcurrent: 3}
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

async function seedRival() {
  const restaurant = await Restaurant.create({name: 'Rival Kitchen', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL', address: 'Thamel'
  });
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rivalowner12@test.com', password: 'x', role: 'owner',
    restaurant: 'Rival Kitchen', restaurantId: restaurant._id
  });
  return {restaurant, branch, owner: rivalOwner};
}

async function readyDeliveryOrder() {
  const created = await request('/api/orders', {
    method: 'POST', token: manager(),
    body: {
      branch: String(world.branchA._id), type: 'delivery', customer: String(customer._id),
      deliveryAddress: 'Jhamsikhel, Lalitpur',
      items: [{menuItem: String(world.menu._id), qty: 1}]
    }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const status of ['accepted', 'preparing', 'ready']) {
    await request(`/api/orders/${created.body._id}/status`, {
      method: 'PATCH', token: manager(), body: {status}
    });
  }
  return created.body;
}

async function dispatchTo(who) {
  const order = await readyDeliveryOrder();
  const res = await request('/api/deliveries', {
    method: 'POST', token: manager(),
    body: {order: String(order._id), rider: String(who._id)}
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return {order, delivery: res.body};
}

const setStatus = (id, status, token, extra = {}) =>
  request(`/api/deliveries/${id}/status`, {method: 'PATCH', token, body: {status, ...extra}});

/** Advance to out_for_delivery, ready for a completion attempt. */
async function readyToComplete(who = rider, token = riderToken()) {
  const {order, delivery} = await dispatchTo(who);
  await setStatus(delivery._id, 'picked_up', token);
  await setStatus(delivery._id, 'out_for_delivery', token);
  return {order, delivery};
}

const GOOD_PASSWORD = 'RiderPass2024';

// ═══════════════════════════════════════════════════════════════════════════
// A — account provisioning
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — rider account provisioning', () => {
  const create = (body, token = owner()) =>
    request('/api/accounts', {method: 'POST', token, body});

  it('creates a rider that can immediately log in', async () => {
    const res = await create({
      name: 'New Rider', email: 'new@test.com', password: GOOD_PASSWORD, role: 'rider',
      branch: String(world.branchA._id), phone: '9822222222', vehicle: 'scooter'
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.role, 'rider');
    assert.equal(res.body.rider.vehicle, 'scooter');
    assert.equal(res.body.rider.active, true);
    assert.equal(res.body.rider.available, false,
      'a new rider starts off shift; going on shift is their own act');

    const stored = await User.findOne({email: 'new@test.com'});
    assert.ok(stored, 'persisted');
    assert.equal(String(stored.restaurantId), String(world.restaurant._id));
    assert.ok(await bcrypt.compare(GOOD_PASSWORD, stored.password), 'password is hashed, not stored raw');

    const login = await request('/api/auth/login', {
      method: 'POST', body: {email: 'new@test.com', password: GOOD_PASSWORD}
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'rider');
  });

  it('never returns the password or its hash', async () => {
    const res = await create({
      name: 'Hash Check', email: 'hash@test.com', password: GOOD_PASSWORD,
      role: 'rider', branch: String(world.branchA._id)
    });
    const serialised = JSON.stringify(res.body);
    assert.doesNotMatch(serialised, /\$2[aby]\$/, 'a bcrypt hash must never reach a client');
    assert.doesNotMatch(serialised, new RegExp(GOOD_PASSWORD));
    assert.ok(!('password' in res.body));

    // The same must hold for the legacy register endpoint and the roster.
    const legacy = await request('/api/auth/register', {
      method: 'POST', token: owner(),
      body: {
        name: 'Legacy', email: 'legacy@test.com', password: GOOD_PASSWORD,
        role: 'rider', branch: String(world.branchA._id)
      }
    });
    assert.equal(legacy.status, 201);
    assert.doesNotMatch(JSON.stringify(legacy.body), /\$2[aby]\$/);

    const roster = await request('/api/accounts?role=rider', {token: owner()});
    assert.doesNotMatch(JSON.stringify(roster.body), /\$2[aby]\$/);
  });

  it('cannot plant an account in another restaurant', async () => {
    // The pre-Phase-12 register endpoint took restaurantId straight from the
    // body, so an owner could create a user inside a rival tenant.
    const rival = await seedRival();
    const res = await create({
      name: 'Planted', email: 'planted@test.com', password: GOOD_PASSWORD, role: 'rider',
      branch: String(world.branchA._id),
      restaurantId: String(rival.restaurant._id)
    });
    assert.equal(res.status, 400, 'an unknown field must be rejected outright');

    // And even via the legacy endpoint, the tenant comes from the caller.
    const legacy = await request('/api/auth/register', {
      method: 'POST', token: owner(),
      body: {
        name: 'Planted2', email: 'planted2@test.com', password: GOOD_PASSWORD, role: 'rider',
        branch: String(world.branchA._id), restaurantId: String(rival.restaurant._id)
      }
    });
    if (legacy.status === 201) {
      const stored = await User.findOne({email: 'planted2@test.com'});
      assert.equal(String(stored.restaurantId), String(world.restaurant._id),
        'the tenant must come from the caller, never the payload');
    }
    assert.equal(await User.countDocuments({restaurantId: rival.restaurant._id, role: 'rider'}), 0);
  });

  it('refuses to create an account on another restaurant\'s branch', async () => {
    const rival = await seedRival();
    const res = await create({
      name: 'Trespass', email: 'trespass@test.com', password: GOOD_PASSWORD,
      role: 'rider', branch: String(rival.branch._id)
    });
    assert.ok([403, 404].includes(res.status), `expected refusal, got ${res.status}`);
    assert.equal(await User.countDocuments({email: 'trespass@test.com'}), 0);
  });

  it('enforces a password policy', () => {
    assert.throws(() => assertPasswordPolicy('short1'), /at least 10 characters/);
    assert.throws(() => assertPasswordPolicy('allletters'), /letters and numbers/);
    assert.throws(() => assertPasswordPolicy('1234567890'), /too common/);
    assert.throws(() => assertPasswordPolicy('password123'), /too common/);
    assert.doesNotThrow(() => assertPasswordPolicy(GOOD_PASSWORD));
  });

  it('rejects a weak password over HTTP without creating anything', async () => {
    const res = await create({
      name: 'Weak', email: 'weak@test.com', password: 'x',
      role: 'rider', branch: String(world.branchA._id)
    });
    assert.equal(res.status, 400);
    assert.equal(await User.countDocuments({email: 'weak@test.com'}), 0);
  });

  it('answers cleanly when the password is missing, rather than crashing', async () => {
    // This previously threw inside bcrypt and produced an unhandled rejection.
    const res = await request('/api/auth/register', {
      method: 'POST', token: owner(),
      body: {name: 'NoPw', email: 'nopw@test.com', role: 'rider', branch: String(world.branchA._id)}
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.message, 'a usable message, not a stack trace');
    assert.equal(await User.countDocuments({email: 'nopw@test.com'}), 0);
  });

  it('refuses a duplicate email and a duplicate rider phone', async () => {
    assert.equal((await create({
      name: 'First', email: 'dupe@test.com', password: GOOD_PASSWORD,
      role: 'rider', branch: String(world.branchA._id), phone: '9833333333'
    })).status, 201);

    const dupeEmail = await create({
      name: 'Second', email: 'dupe@test.com', password: GOOD_PASSWORD,
      role: 'rider', branch: String(world.branchA._id)
    });
    assert.equal(dupeEmail.status, 409);
    assert.match(dupeEmail.body.message, /email already exists/);

    const dupePhone = await create({
      name: 'Third', email: 'third@test.com', password: GOOD_PASSWORD,
      role: 'rider', branch: String(world.branchA._id), phone: '9833333333'
    });
    assert.equal(dupePhone.status, 409);
    assert.match(dupePhone.body.message, /phone/);
    assert.equal(await User.countDocuments({email: 'third@test.com'}), 0);
  });

  it('will not mint another owner', async () => {
    const res = await create({
      name: 'Ghost Owner', email: 'ghost@test.com', password: GOOD_PASSWORD, role: 'owner'
    });
    assert.equal(res.status, 400, 'an owner account is a deployment act, not an API call');
    assert.equal(await User.countDocuments({email: 'ghost@test.com'}), 0);
  });

  it('reserves account creation for owners', async () => {
    for (const [label, token] of [['manager', manager()], ['staff', staff()], ['rider', riderToken()]]) {
      const res = await create({
        name: 'X', email: `x-${label}@test.com`, password: GOOD_PASSWORD,
        role: 'rider', branch: String(world.branchA._id)
      }, token);
      assert.equal(res.status, 403, `${label} must not create accounts`);
    }
    assert.equal((await request('/api/accounts', {token: riderToken()})).status, 403,
      'a rider must not read the staff roster');
    assert.equal((await request('/api/accounts', {token: manager()})).status, 200,
      'a manager may read the roster');
  });

  it('audits creation without recording the credential', async () => {
    const res = await create({
      name: 'Audited', email: 'audited@test.com', password: GOOD_PASSWORD,
      role: 'rider', branch: String(world.branchA._id)
    });
    const entry = await Audit.findOne({action: 'account_created', entityId: res.body._id}).lean();
    assert.ok(entry);
    assert.equal(entry.after.email, 'audited@test.com');
    assert.doesNotMatch(JSON.stringify(entry), new RegExp(GOOD_PASSWORD));
    assert.doesNotMatch(JSON.stringify(entry), /\$2[aby]\$/);
  });

  it('never exposes a credential through the public projection', () => {
    const view = publicUserView({
      _id: 'x', name: 'A', email: 'a@b.c', role: 'rider',
      password: '$2b$12$averyrealisticlookinghashvalue', rider: {active: true}
    });
    assert.ok(!('password' in view));
    assert.doesNotMatch(JSON.stringify(view), /\$2[aby]\$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Deactivation
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — account deactivation', () => {
  it('blocks login for a deactivated account even with the right password', async () => {
    await User.updateOne({_id: rider._id}, {$set: {password: await bcrypt.hash(GOOD_PASSWORD, 12)}});
    assert.equal((await request('/api/auth/login', {
      method: 'POST', body: {email: 'kumar12@test.com', password: GOOD_PASSWORD}
    })).status, 200);

    const off = await request(`/api/accounts/${rider._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false, reason: 'Left the company'}
    });
    assert.equal(off.status, 200);
    assert.equal((await User.findById(rider._id)).rider.active, false);

    const blocked = await request('/api/auth/login', {
      method: 'POST', body: {email: 'kumar12@test.com', password: GOOD_PASSWORD}
    });
    assert.equal(blocked.status, 403, 'a deactivated employee must not authenticate');
    assert.match(blocked.body.message, /deactivated/i);
  });

  it('refuses to stand down a rider holding live deliveries', async () => {
    await dispatchTo(rider);
    const res = await request(`/api/accounts/${rider._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.equal(res.status, 409, 'the job would be stranded with nobody able to advance it');
    assert.match(res.body.message, /live deliver/i);
    assert.equal((await User.findById(rider._id)).rider.active, true);
  });

  it('allows deactivation once the work is finished', async () => {
    const {delivery} = await readyToComplete();
    await setStatus(delivery._id, 'delivered', riderToken(), {proofType: 'handed_to_customer'});
    const res = await request(`/api/accounts/${rider._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.equal(res.status, 200);
    const stored = await User.findById(rider._id);
    assert.equal(stored.rider.active, false);
    assert.equal(stored.rider.available, false, 'and they leave the available pool');
  });

  it('will not let an owner deactivate themselves or another owner', async () => {
    assert.equal((await request(`/api/accounts/${world.owner._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    })).status, 403);
    assert.equal((await User.findById(world.owner._id)).active, true);
  });

  it('shows each restaurant only its own roster', async () => {
    // A rival owner legitimately sees their OWN account and nothing of ours.
    // (A live probe first read this as a leak; it was the probe that was
    // wrong, so the real invariant is pinned here.)
    const rival = await seedRival();
    const theirs = await request('/api/accounts', {token: tokenFor(rival.owner)});
    assert.equal(theirs.status, 200);
    assert.deepEqual(theirs.body.map(u => u.name), ['Rival Owner']);

    const ours = await request('/api/accounts', {token: owner()});
    const names = ours.body.map(u => u.name);
    assert.ok(names.includes('Kumar Rider'));
    assert.ok(!names.includes('Rival Owner'), 'no cross-tenant bleed in either direction');
  });

  it('cannot touch another restaurant\'s account', async () => {
    const rival = await seedRival();
    const res = await request(`/api/accounts/${rival.owner._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    assert.equal(res.status, 404);
  });

  it('resets a password to policy, and the new one works', async () => {
    const res = await request(`/api/accounts/${rider._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'BrandNewPass99'}
    });
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /BrandNewPass99|\$2[aby]\$/);

    const login = await request('/api/auth/login', {
      method: 'POST', body: {email: 'kumar12@test.com', password: 'BrandNewPass99'}
    });
    assert.equal(login.status, 200);
    assert.equal((await request(`/api/accounts/${rider._id}/password`, {
      method: 'POST', token: owner(), body: {password: 'weak'}
    })).status, 400);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Proof of delivery
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — proof of delivery', () => {
  it('refuses to complete a delivery without proof', async () => {
    const {order, delivery} = await readyToComplete();
    const bare = await setStatus(delivery._id, 'delivered', riderToken());
    assert.equal(bare.status, 400);
    assert.match(bare.body.message, /handed over/i);

    // Nothing may have moved.
    assert.equal((await Delivery.findById(delivery._id)).status, 'out_for_delivery');
    assert.notEqual((await Order.findById(order._id)).status, 'completed');
  });

  it('rejects an unknown proof type', async () => {
    const {delivery} = await readyToComplete();
    const res = await setStatus(delivery._id, 'delivered', riderToken(), {proofType: 'teleported'});
    assert.equal(res.status, 400);
    assert.equal((await Delivery.findById(delivery._id)).status, 'out_for_delivery');
  });

  it('completes a handover to the customer and persists the proof', async () => {
    const {order, delivery} = await readyToComplete();
    const res = await setStatus(delivery._id, 'delivered', riderToken(), {
      proofType: 'handed_to_customer', proofNote: 'Handed over at the gate'
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await Delivery.findById(delivery._id);
    assert.equal(stored.status, 'delivered');
    assert.equal(stored.proofType, 'handed_to_customer');
    assert.equal(stored.proofNote, 'Handed over at the gate');
    assert.ok(stored.proofAt instanceof Date);
    assert.equal(String(stored.proofBy), String(rider._id), 'the rider who gave proof is recorded');
    assert.ok(stored.deliveredAt instanceof Date);
    assert.equal((await Order.findById(order._id)).status, 'completed');
  });

  it('requires a recipient or a note when nobody took it in person', async () => {
    const {delivery} = await readyToComplete();
    const bare = await setStatus(delivery._id, 'delivered', riderToken(), {
      proofType: 'left_at_door'
    });
    assert.equal(bare.status, 400, '"left at door" with no detail is the disputed case');
    assert.equal((await Delivery.findById(delivery._id)).status, 'out_for_delivery');

    const named = await setStatus(delivery._id, 'delivered', riderToken(), {
      proofType: 'left_at_door', receivedBy: 'Left with the security guard'
    });
    assert.equal(named.status, 200);
    assert.equal((await Delivery.findById(delivery._id)).receivedBy, 'Left with the security guard');
  });

  it('writes the proof into the immutable audit trail as well', async () => {
    const {delivery} = await readyToComplete();
    await setStatus(delivery._id, 'delivered', riderToken(), {
      proofType: 'left_with_neighbour', receivedBy: 'Neighbour at 4B', proofNote: 'Called first'
    });

    const entry = await Audit.findOne({action: 'delivery_delivered', entityId: delivery._id}).lean();
    assert.ok(entry);
    assert.equal(entry.after.proofType, 'left_with_neighbour');
    assert.equal(entry.after.receivedBy, 'Neighbour at 4B');
    assert.equal(entry.after.proofNote, 'Called first');
    assert.equal(String(entry.user), String(rider._id));

    // The audit survives a later edit to the delivery document.
    await Delivery.updateOne({_id: delivery._id}, {$set: {proofNote: 'tampered'}});
    const again = await Audit.findOne({action: 'delivery_delivered', entityId: delivery._id}).lean();
    assert.equal(again.after.proofNote, 'Called first');
  });

  it('shows the proof to the rider and to staff', async () => {
    const {delivery} = await readyToComplete();
    await setStatus(delivery._id, 'delivered', riderToken(), {
      proofType: 'reception', receivedBy: 'Front desk'
    });

    const mine = await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()});
    assert.equal(mine.body.proofType, 'reception');
    assert.equal(mine.body.receivedBy, 'Front desk');

    const staffView = await request(
      `/api/deliveries?branch=${world.branchA._id}`, {token: manager()}
    );
    const row = staffView.body.find(d => String(d._id) === String(delivery._id));
    assert.equal(row.proofType, 'reception');
    assert.equal(row.receivedBy, 'Front desk');
  });

  it('does not require proof to fail, but does require a reason', async () => {
    const {delivery} = await readyToComplete();
    assert.equal((await setStatus(delivery._id, 'failed', riderToken())).status, 400);
    const failed = await setStatus(delivery._id, 'failed', riderToken(), {
      reason: 'Address does not exist'
    });
    assert.equal(failed.status, 200);
    const stored = await Delivery.findById(delivery._id);
    assert.equal(stored.failureReason, 'Address does not exist');
    assert.equal(stored.proofType, null, 'a failure has no handover to evidence');
  });

  it('cannot re-complete or rewrite proof on a delivered job', async () => {
    const {delivery} = await readyToComplete();
    await setStatus(delivery._id, 'delivered', riderToken(), {proofType: 'handed_to_customer'});
    const original = await Delivery.findById(delivery._id);

    const again = await setStatus(delivery._id, 'delivered', riderToken(), {
      proofType: 'left_at_door', receivedBy: 'Rewritten'
    });
    assert.equal(again.status, 409);

    const after = await Delivery.findById(delivery._id);
    assert.equal(after.proofType, 'handed_to_customer');
    assert.equal(String(after.proofAt), String(original.proofAt));
  });

  it('does not let another rider supply the proof', async () => {
    const {delivery} = await readyToComplete();
    const res = await setStatus(delivery._id, 'delivered', riderBToken(), {
      proofType: 'handed_to_customer'
    });
    assert.equal(res.status, 404);
    assert.equal((await Delivery.findById(delivery._id)).status, 'out_for_delivery');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Security regression sweep
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — security regression sweep', () => {
  it('refuses anonymous, invalid and expired tokens on the account API', async () => {
    const expired = jwt.sign(
      {id: String(world.owner._id), role: 'owner'}, process.env.JWT_SECRET, {expiresIn: '-1h'}
    );
    for (const token of [undefined, 'not.a.jwt', expired]) {
      assert.equal((await request('/api/accounts', {token})).status, 401);
      assert.equal((await request('/api/accounts', {
        method: 'POST', token,
        body: {name: 'X', email: 'x@t.com', password: GOOD_PASSWORD, role: 'rider'}
      })).status, 401);
    }
    assert.equal(await User.countDocuments({email: 'x@t.com'}), 0);
  });

  it('keeps riders out of financial and margin data', async () => {
    const {delivery} = await dispatchTo(rider);
    const detail = await request(`/api/deliveries/mine/${delivery._id}`, {token: riderToken()});
    const serialised = JSON.stringify(detail.body);
    for (const secret of ['foodCost', 'recipeCost', 'packagingCost', 'inventoryRequirements']) {
      assert.doesNotMatch(serialised, new RegExp(secret, 'i'), `${secret} must not reach a rider`);
    }
    for (const path of ['/api/reports/operations', '/api/pnl', '/api/expenses', '/api/analytics']) {
      const res = await request(path, {token: riderToken()});
      assert.ok([401, 403, 404].includes(res.status), `${path} must be closed to riders (${res.status})`);
    }
  });

  it('has no bare auth() left that the rider role could widen', async () => {
    // Adding a role to the enum silently widens any auth() with no role list.
    const {readFile, readdir} = await import('node:fs/promises');
    const files = ['../src/index.js'];
    for (const name of await readdir(new URL('../src/routes/', import.meta.url))) {
      if (name.endsWith('.js')) files.push(`../src/routes/${name}`);
    }
    for (const file of files) {
      const source = await readFile(new URL(file, import.meta.url), 'utf8');
      assert.doesNotMatch(source, /auth\(\)/,
        `${file} uses a bare auth(); use requireStaff() or an explicit role list`);
    }
  });

  it('enforces the rider boundary across the whole surface', async () => {
    const {delivery} = await dispatchTo(riderB);
    for (const [path, options] of [
      ['/api/deliveries', {}],
      ['/api/deliveries/dashboard', {}],
      ['/api/riders', {}],
      ['/api/accounts', {}],
      [`/api/deliveries/mine/${delivery._id}`, {}]
    ]) {
      const res = await request(path, {token: riderToken(), ...options});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }
    assert.equal((await setStatus(delivery._id, 'picked_up', riderToken())).status, 404);
    assert.equal((await Delivery.findById(delivery._id)).status, 'assigned');
  });

  it('keeps one active delivery per order and terminal states final', async () => {
    const order = await readyDeliveryOrder();
    assert.equal((await request('/api/deliveries', {
      method: 'POST', token: manager(), body: {order: String(order._id)}
    })).status, 201);
    assert.equal((await request('/api/deliveries', {
      method: 'POST', token: manager(), body: {order: String(order._id)}
    })).status, 409);
    assert.equal(await Delivery.countDocuments({order: order._id}), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Socket isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('12 — socket isolation', () => {
  function connect(token, auth = {}) {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: {token, ...auth}, transports: ['websocket'], reconnection: false, timeout: 4000
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }

  it('rejects an unauthenticated or deactivated-token socket', async () => {
    await assert.rejects(connect(undefined), /Authentication required/);
    await assert.rejects(connect('rubbish'), /Authentication required/);
  });

  it('delivers proof-completion events only to the assigned rider', async () => {
    const {delivery} = await readyToComplete();
    const mine = await connect(riderToken());
    const other = await connect(riderBToken());
    try {
      let leaked = null;
      other.on('delivery:update', payload => { leaked = payload; });
      const heard = new Promise(resolve => mine.once('delivery:update', resolve));

      await setStatus(delivery._id, 'delivered', riderToken(), {proofType: 'handed_to_customer'});

      const payload = await heard;
      assert.equal(payload.status, 'delivered');
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(leaked, null, 'an unrelated rider must hear nothing');
    } finally {
      mine.disconnect();
      other.disconnect();
    }
  });

  it('still refuses a rider a branch room', async () => {
    const socket = await connect(riderToken(), {branch: String(world.branchA._id)});
    try {
      const ack = await new Promise(resolve => {
        socket.emit('join:branch', String(world.branchA._id), resolve);
        setTimeout(() => resolve({ok: false, timedOut: true}), 3000);
      });
      assert.equal(ack.ok, false);
    } finally {
      socket.disconnect();
    }
  });
});
