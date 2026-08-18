import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Audit, MenuItem, User} from '../src/models/index.js';
import {Customer, Delivery, Order} from '../src/models/operations.js';
import {backfillCompletedAt, findCompletionEvidence} from '../src/services/completedAtBackfill.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let grill;
let fry;
let bev;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await request('/api/kitchen/stations', {token: tokenFor(world.owner)});
  const mi = props => MenuItem.create({
    restaurant: world.restaurant._id, price: 100, vatInclusive: false,
    recipe: [{ingredient: world.ingredient._id, qty: 5, unit: 'g'}], ...props
  });
  grill = await mi({name: 'Burger', station: 'grill', prepMinutes: 20});
  fry = await mi({name: 'Fries', station: 'fry', prepMinutes: 5});
  bev = await mi({name: 'Drink', station: 'beverage', prepMinutes: 2});
});

const owner = () => tokenFor(world.owner);
const perf = (query = '', token = owner()) =>
  request(`/api/kitchen/performance?branch=${world.branchA._id}${query}`, {token});

async function place(items, branch = world.branchA, extra = {}) {
  const res = await request('/api/orders', {
    method: 'POST', token: owner(),
    body: {branch: String(branch._id), type: 'counter', items, ...extra}
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

async function stamp(orderId, {ago, ready, done}) {
  const placed = new Date(Date.now() - ago * 60000);
  const $set = {createdAt: placed};
  if (ready != null) $set.readyAt = new Date(placed.getTime() + ready * 60000);
  if (done != null) {
    $set.completedAt = new Date(placed.getTime() + done * 60000);
    $set.status = 'completed';
  }
  await mongoose.connection.collection('orders').updateOne(
    {_id: new mongoose.Types.ObjectId(String(orderId))}, {$set}
  );
}

// ── §1 completion timestamps on every path ───────────────────────────────────
describe('AUDIT §1 — completedAt on every completion path', () => {
  it('stamps on the kitchen status path', async () => {
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      await request(`/api/orders/${order._id}/status`, {method: 'PATCH', token: owner(), body: {status}});
    }
    const stored = await Order.findById(order._id);
    assert.ok(stored.completedAt instanceof Date);
  });

  it('stamps when settled by payment', async () => {
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: order.total, method: 'cash'}
    });
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'completed');
    assert.ok(stored.completedAt instanceof Date);
  });

  it('stamps both sides of a split settled separately', async () => {
    const order = await place([{menuItem: String(grill._id), qty: 2}], world.branchA,
      {type: 'dine-in', table: String(world.table._id)});
    const line = order.items[0];
    const split = await request(`/api/orders/${order._id}/split`, {
      method: 'POST', token: owner(), body: {items: [{itemId: String(line._id), qty: 1}]}
    });
    assert.equal(split.status, 201, split.body?.message);
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: split.body.order.total, method: 'cash'}
    });
    await request(`/api/orders/${split.body.splitOrder._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: split.body.splitOrder.total, method: 'cash'}
    });
    const parent = await Order.findById(order._id);
    const child = await Order.findById(split.body.splitOrder._id);
    assert.ok(parent.completedAt instanceof Date, 'split parent must be stamped');
    assert.ok(child.completedAt instanceof Date, 'split child must be stamped');
  });

  it('stamps when a delivery is marked delivered', async () => {
    const guest = await Customer.create({branch: world.branchA._id, name: 'Ram', phone: '9800000001'});
    const order = await place([{menuItem: String(grill._id), qty: 1}], world.branchA, {
      type: 'delivery', customer: String(guest._id), deliveryAddress: 'Patan'
    });
    // Phase 10 will not dispatch an order that has not been cooked, and the
    // delivery state machine has no shortcut to 'delivered'.
    for (const status of ['accepted', 'preparing', 'ready']) {
      await request(`/api/orders/${order._id}/status`, {
        method: 'PATCH', token: owner(), body: {status}
      });
    }
    const rider = await User.create({
      name: 'Audit Rider', email: `rider-${Date.now()}@test.com`, password: 'x', role: 'rider',
      restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: true}
    });
    const delivery = await request('/api/deliveries', {
      method: 'POST', token: owner(),
      body: {order: order._id, address: 'Patan', rider: String(rider._id)}
    });
    assert.equal(delivery.status, 201, delivery.body?.message);
    let done;
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      done = await request(`/api/deliveries/${delivery.body._id}/status`, {
        method: 'PATCH', token: owner(),
        // Phase 12 requires proof of handover to complete a delivery.
        body: {status, ...(status === 'delivered' ? {proofType: 'handed_to_customer'} : {})}
      });
    }
    assert.equal(done.status, 200, done.body?.message);
    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'completed');
    assert.ok(stored.completedAt instanceof Date, 'delivery completion must be stamped');
  });

  it('never overwrites an existing completedAt', async () => {
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    for (const status of ['accepted', 'preparing', 'ready', 'completed']) {
      await request(`/api/orders/${order._id}/status`, {method: 'PATCH', token: owner(), body: {status}});
    }
    const first = (await Order.findById(order._id)).completedAt;
    // A repeat transition is refused, and the original instant survives.
    const again = await request(`/api/orders/${order._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'completed'}
    });
    assert.equal(again.status, 409);
    assert.equal(String((await Order.findById(order._id)).completedAt), String(first));
  });

  it('a repeat delivered callback keeps the first completion instant', async () => {
    const guest = await Customer.create({branch: world.branchA._id, name: 'Sita', phone: '9800000002'});
    const order = await place([{menuItem: String(grill._id), qty: 1}], world.branchA, {
      type: 'delivery', customer: String(guest._id), deliveryAddress: 'Patan'
    });
    for (const status of ['accepted', 'preparing', 'ready']) {
      await request(`/api/orders/${order._id}/status`, {
        method: 'PATCH', token: owner(), body: {status}
      });
    }
    const rider2 = await User.create({
      name: 'Audit Rider 2', email: `rider2-${Date.now()}@test.com`, password: 'x', role: 'rider',
      restaurant: 'Mittho Test', restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: true}
    });
    const delivery = await request('/api/deliveries', {
      method: 'POST', token: owner(),
      body: {order: order._id, address: 'Patan', rider: String(rider2._id)}
    });
    for (const status of ['picked_up', 'out_for_delivery', 'delivered']) {
      await request(`/api/deliveries/${delivery.body._id}/status`, {
        method: 'PATCH', token: owner(),
        body: {status, ...(status === 'delivered' ? {proofType: 'handed_to_customer'} : {})}
      });
    }
    const first = (await Order.findById(order._id)).completedAt;
    await new Promise(r => setTimeout(r, 20));
    // A repeat 'delivered' is now refused by the state machine, and the
    // original completion instant must survive regardless.
    await request(`/api/deliveries/${delivery.body._id}/status`, {
      method: 'PATCH', token: owner(), body: {status: 'delivered'}
    });
    assert.equal(String((await Order.findById(order._id)).completedAt), String(first));
  });
});

// ── §3 station counting semantics ────────────────────────────────────────────
describe('AUDIT §3 — station counting semantics', () => {
  /**
   * Documented semantics, asserted below:
   *   summary.orders  — each order counted EXACTLY ONCE (a partition)
   *   station.orders  — each order counted ONCE PER STATION it touches
   *                     (an attribution, not a partition)
   *   station.items   — summed item quantities for that station only
   * Station order counts therefore intentionally sum to MORE than
   * summary.orders when tickets span sections.
   */
  it('order 1001 with Burger/Fries/Drink splits across three stations', async () => {
    const order = await place([
      {menuItem: String(grill._id), qty: 1},
      {menuItem: String(fry._id), qty: 2},
      {menuItem: String(bev._id), qty: 3}
    ]);
    await stamp(order._id, {ago: 60, ready: 15, done: 16});

    const res = await perf();
    assert.equal(res.body.summary.orders, 1, 'the order is counted once overall');

    const byCode = Object.fromEntries(res.body.stations.map(s => [s.station, s]));
    assert.equal(byCode.grill.orders, 1);
    assert.equal(byCode.grill.items, 1, 'Burger x1');
    assert.equal(byCode.fry.orders, 1);
    assert.equal(byCode.fry.items, 2, 'Fries x2');
    assert.equal(byCode.beverage.orders, 1);
    assert.equal(byCode.beverage.items, 3, 'Drink x3');

    // Attribution, not partition: the same ticket appears on three boards.
    const stationOrderSum = res.body.stations.reduce((sum, s) => sum + s.orders, 0);
    assert.equal(stationOrderSum, 3);
    assert.notEqual(stationOrderSum, res.body.summary.orders);

    // A station that did no work still reports, with zeroes.
    assert.equal(byCode.bar.orders, 0);
    assert.equal(byCode.bar.items, 0);
    assert.equal(byCode.bar.averagePrepMinutes, null);
  });

  it('does not double-count a station when several lines share it', async () => {
    const order = await place([
      {menuItem: String(fry._id), qty: 2},
      {menuItem: String(fry._id), qty: 3}
    ]);
    await stamp(order._id, {ago: 30, ready: 4, done: 5});
    const res = await perf();
    const fryRow = res.body.stations.find(s => s.station === 'fry');
    assert.equal(fryRow.orders, 1, 'one order, even with two fry lines');
    assert.equal(fryRow.items, 5, 'quantities are summed');
  });
});

// ── §4 branch isolation at the data layer ────────────────────────────────────
describe('AUDIT §4 — branch isolation', () => {
  it('branch A metrics are unaffected by branch B activity', async () => {
    const a = await place([{menuItem: String(grill._id), qty: 1}], world.branchA);
    const b1 = await place([{menuItem: String(grill._id), qty: 1}], world.branchB);
    const b2 = await place([{menuItem: String(grill._id), qty: 1}], world.branchB);
    await stamp(a._id, {ago: 90, ready: 10, done: 11});
    await stamp(b1._id, {ago: 90, ready: 50, done: 51});
    await stamp(b2._id, {ago: 90, ready: 60, done: 61});

    const resA = await perf();
    assert.equal(resA.body.summary.orders, 1);
    assert.equal(resA.body.summary.averagePrepMinutes, 10, 'B must not skew A');
    assert.equal(resA.body.summary.delayedOrders, 0);
    assert.equal(resA.body.stations.find(s => s.station === 'grill').orders, 1);

    const resB = await request(`/api/kitchen/performance?branch=${world.branchB._id}`, {token: owner()});
    assert.equal(resB.body.summary.orders, 2);
    assert.equal(resB.body.summary.averagePrepMinutes, 55);
  });
});

// ── §5 authorization ─────────────────────────────────────────────────────────
describe('AUDIT §5 — authorization cannot be bypassed via the API', () => {
  it('rejects anonymous, staff, guest, forged and expired credentials', async () => {
    const url = `/api/kitchen/performance?branch=${world.branchA._id}`;
    assert.equal((await request(url)).status, 401);
    assert.equal((await request(url, {token: tokenFor(world.staffA)})).status, 403);

    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request(url, {token: guest})).status, 403);

    const forged = jwt.sign({id: world.owner._id, role: 'owner'}, 'attacker-secret');
    assert.equal((await request(url, {token: forged})).status, 401);

    const expired = jwt.sign({id: world.owner._id, role: 'owner'}, process.env.JWT_SECRET, {expiresIn: '-1s'});
    assert.equal((await request(url, {token: expired})).status, 401);
  });

  it('confines a manager to their own branch', async () => {
    assert.equal((await request(`/api/kitchen/performance?branch=${world.branchA._id}`,
      {token: tokenFor(world.manager)})).status, 200);
    assert.equal((await request(`/api/kitchen/performance?branch=${world.branchB._id}`,
      {token: tokenFor(world.manager)})).status, 403);
  });
});

// ── §7 historical completedAt backfill ───────────────────────────────────────
describe('AUDIT §7 — historical completedAt backfill', () => {
  /** Recreates a pre-fix order: completed, audited, but never stamped. */
  async function legacyOrder({audited = true, action = 'payment'} = {}) {
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    const completedInstant = new Date(Date.now() - 45 * 60000);
    await mongoose.connection.collection('orders').updateOne(
      {_id: new mongoose.Types.ObjectId(String(order._id))},
      {$set: {status: 'completed', createdAt: new Date(Date.now() - 60 * 60000)}, $unset: {completedAt: ''}}
    );
    if (audited) {
      await Audit.create({
        entity: 'order', entityId: order._id, action,
        after: {status: 'completed'}, at: completedInstant, user: world.owner._id
      });
    }
    return {order, completedInstant};
  }

  it('finds completion evidence in the audit log', async () => {
    const {order, completedInstant} = await legacyOrder();
    const evidence = await findCompletionEvidence(order._id);
    assert.ok(evidence, 'payment audit entry should be evidence');
    assert.equal(evidence.at.getTime(), completedInstant.getTime());
    assert.equal(evidence.action, 'payment');
  });

  it('backfills from the recorded instant, never an invented one', async () => {
    const {order, completedInstant} = await legacyOrder();
    const result = await backfillCompletedAt({});
    assert.equal(result.scanned, 1);
    assert.equal(result.backfilled, 1);
    const stored = await Order.findById(order._id);
    assert.equal(stored.completedAt.getTime(), completedInstant.getTime(),
      'the stamped value must equal the audited instant');
  });

  it('is idempotent — a second run changes nothing', async () => {
    const {order} = await legacyOrder();
    await backfillCompletedAt({});
    const afterFirst = (await Order.findById(order._id)).completedAt;
    const second = await backfillCompletedAt({});
    assert.equal(second.scanned, 0, 'nothing left to scan');
    assert.equal(second.backfilled, 0);
    assert.equal(String((await Order.findById(order._id)).completedAt), String(afterFirst));
  });

  it('never overwrites a valid completedAt', async () => {
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    await stamp(order._id, {ago: 60, ready: 10, done: 12});
    const original = (await Order.findById(order._id)).completedAt;
    await Audit.create({
      entity: 'order', entityId: order._id, action: 'payment',
      after: {status: 'completed'}, at: new Date(Date.now() - 5 * 60000), user: world.owner._id
    });
    const result = await backfillCompletedAt({});
    assert.equal(result.scanned, 0, 'already-stamped orders are not candidates');
    assert.equal(String((await Order.findById(order._id)).completedAt), String(original));
  });

  it('leaves completedAt null when the log holds no evidence', async () => {
    const {order} = await legacyOrder({audited: false});
    const result = await backfillCompletedAt({});
    assert.equal(result.scanned, 1);
    assert.equal(result.backfilled, 0);
    assert.equal(result.skippedNoEvidence, 1);
    const stored = await Order.findById(order._id);
    assert.ok(!stored.completedAt, 'no timestamp may be fabricated');
  });

  it('supports a dry run that writes nothing', async () => {
    const {order} = await legacyOrder();
    const result = await backfillCompletedAt({dryRun: true});
    assert.equal(result.dryRun, true);
    assert.equal(result.backfilled, 1, 'reports what it would do');
    assert.ok(!(await Order.findById(order._id)).completedAt, 'but writes nothing');
  });

  it('reports a null-timestamp order without corrupting metrics', async () => {
    // An unrecoverable legacy ticket must not break or skew the report.
    await legacyOrder({audited: false});
    const good = await place([{menuItem: String(grill._id), qty: 1}]);
    await stamp(good._id, {ago: 60, ready: 10, done: 11});

    const res = await perf();
    assert.equal(res.status, 200);
    assert.equal(res.body.summary.completedOrders, 2, 'both count as completed');
    // Only the ticket with real timings contributes to the averages.
    assert.equal(res.body.summary.averageServiceMinutes, 11);
    assert.equal(res.body.summary.averagePrepMinutes, 10);
  });
});

// ── §8 payment / receipt integration ─────────────────────────────────────────
describe('AUDIT §8 — payment, receipt and metrics together', () => {
  it('payment -> completed -> completedAt -> metrics -> receipt', async () => {
    const {Restaurant} = await import('../src/models/operations.js');
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {pan: '301234567'}});

    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    for (const status of ['accepted', 'preparing', 'ready']) {
      await request(`/api/orders/${order._id}/status`, {method: 'PATCH', token: owner(), body: {status}});
    }
    const paid = await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: order.total, method: 'esewa', transactionId: 'ESW-1'}
    });
    assert.equal(paid.status, 201, paid.body?.message);

    const stored = await Order.findById(order._id);
    assert.equal(stored.status, 'completed');
    assert.ok(stored.completedAt instanceof Date);

    // Metrics see it.
    const metrics = await perf();
    assert.equal(metrics.body.summary.completedOrders, 1);
    assert.notEqual(metrics.body.summary.averageServiceMinutes, null);

    // The receipt is unaffected and still issues correctly.
    const receipt = await request(`/api/orders/${order._id}/receipt?issue=true`, {token: owner()});
    assert.equal(receipt.status, 200, receipt.body?.message);
    assert.match(receipt.body.invoiceNo, /^INV-KTM-\d{4}-\d{6}$/);
    assert.equal(receipt.body.payment.tenders[0].method, 'esewa');
    assert.equal(receipt.body.payment.settled, true);
  });

  it('creates exactly one payment record — no duplicated logic', async () => {
    const {Payment} = await import('../src/models/operations.js');
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: order.total, method: 'cash'}
    });
    assert.equal(await Payment.countDocuments({order: order._id}), 1);
  });

  it('a partial refund keeps the ticket in completion metrics', async () => {
    const order = await place([{menuItem: String(grill._id), qty: 1}]);
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: owner(), body: {amount: order.total, method: 'cash'}
    });
    await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: tokenFor(world.manager), body: {amount: 10, reason: 'audit'}
    });
    const res = await perf();
    assert.equal(res.body.summary.completedOrders, 1);
  });
});
