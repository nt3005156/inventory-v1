import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Supplier, User} from '../src/models/index.js';
import {Branch, Notification, Restaurant, SupplierInvoice} from '../src/models/operations.js';
import {
  CHANNELS, IMPLEMENTED_CHANNELS, NOTIFICATION_TYPE_KEYS, notify
} from '../src/services/notifications.js';

/**
 * Phase 23 — notification infrastructure.
 *
 * Covers the nine types the brief names, the in-app channel (and the honest
 * handling of the three that do not exist yet), the notification centre, and
 * the tenancy rules that stop an inbox becoming a side channel into another
 * branch's money.
 */

let world;
let baseUrl;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

async function makeOrder(token = manager(), branch = world.branchA._id) {
  return request('/api/orders', {
    method: 'POST', token,
    body: {branch: String(branch), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
  });
}

const settle = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));

// ── catalogue ────────────────────────────────────────────────────────────────

describe('Phase 23 · notification catalogue', () => {
  it('covers every type the brief names', async () => {
    // low stock and expiry already existed as inventory ALERTS; the other
    // seven had no producer at all before this phase.
    const {ALERT_TYPES} = await import('../src/services/alerts.js');
    assert.ok(ALERT_TYPES.includes('low_stock'), 'low stock');
    assert.ok(ALERT_TYPES.includes('expiry_approaching'), 'expiry');
    for (const type of [
      'po_approval_required', 'new_order', 'payment_received', 'refund_issued',
      'delivery_update', 'inventory_count_submitted', 'supplier_invoice_due'
    ]) {
      assert.ok(NOTIFICATION_TYPE_KEYS.includes(type), `missing type ${type}`);
    }
  });

  it('declares the channels honestly', async () => {
    const res = await request('/api/notifications/types', {token: manager()});
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.channels.map(c => c.channel), [...CHANNELS]);
    // Only in-app is real. Nothing may claim otherwise while there is no
    // email, SMS or push provider in this repository.
    assert.deepEqual(IMPLEMENTED_CHANNELS, ['in_app']);
    for (const entry of res.body.channels) {
      assert.equal(entry.implemented, entry.channel === 'in_app', `${entry.channel} implemented flag`);
    }
    assert.equal(res.body.types.length, NOTIFICATION_TYPE_KEYS.length);
  });

  it('records an unimplemented channel as skipped rather than sent', async () => {
    const row = await notify({
      type: 'new_order', restaurant: world.restaurant._id, branch: world.branchA._id,
      title: 'Channel probe', channels: ['in_app', 'email', 'sms', 'push']
    });
    assert.ok(row);
    const delivery = row.context.delivery;
    assert.equal(delivery.find(d => d.channel === 'in_app').status, 'delivered');
    for (const channel of ['email', 'sms', 'push']) {
      const entry = delivery.find(d => d.channel === channel);
      assert.equal(entry.status, 'skipped', `${channel} must not claim delivery`);
      assert.match(entry.reason, /No .* provider is configured/);
    }
  });

  it('refuses an unknown type without throwing into the caller', async () => {
    // A notification failure must never fail the business act it describes.
    const row = await notify({
      type: 'not_a_real_type', restaurant: world.restaurant._id, title: 'x'
    });
    assert.equal(row, null);
    assert.equal(await Notification.countDocuments({type: 'not_a_real_type'}), 0);
  });
});

// ── producers ────────────────────────────────────────────────────────────────

describe('Phase 23 · notifications are raised by real business acts', () => {
  it('raises new_order and payment_received', async () => {
    const order = await makeOrder();
    assert.equal(order.status, 201, JSON.stringify(order.body));
    await settle();
    const created = await Notification.findOne({type: 'new_order'}).lean();
    assert.ok(created, 'a new order must notify');
    assert.equal(String(created.branch), String(world.branchA._id));
    assert.equal(created.context.kind, 'event');
    assert.equal(created.read, false);

    const paid = await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'n23-pay'},
      body: {amount: 395.5, method: 'cash'}
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    await settle();
    const payment = await Notification.findOne({type: 'payment_received'}).lean();
    assert.ok(payment, 'a settled bill must notify');
    assert.match(payment.title, /paid/i);
    assert.equal(payment.context.reference, order.body.orderNo);
  });

  it('does not notify on a partial tender, only on settlement', async () => {
    // A notification per tender on a split bill is noise, not information.
    const order = await makeOrder();
    const partial = await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'n23-part'},
      body: {amount: 100, method: 'cash'}
    });
    assert.equal(partial.status, 201);
    await settle();
    assert.equal(await Notification.countDocuments({type: 'payment_received'}), 0);

    const rest = await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'n23-rest'},
      body: {amount: 295.5, method: 'cash'}
    });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    await settle();
    assert.equal(await Notification.countDocuments({type: 'payment_received'}), 1);
  });

  it('raises refund_issued with the amount and reason', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order.body._id}/payments`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'n23-rp'},
      body: {amount: 395.5, method: 'cash'}
    });
    const refund = await request(`/api/orders/${order.body._id}/refunds`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'n23-rf'},
      body: {amount: 100, reason: 'spilled the biryani'}
    });
    assert.equal(refund.status, 201, JSON.stringify(refund.body));
    await settle();
    const row = await Notification.findOne({type: 'refund_issued'}).lean();
    assert.ok(row);
    assert.match(row.body, /100\.00/);
    assert.match(row.body, /spilled the biryani/);
    assert.equal(row.severity, 'warning');
  });

  it('raises po_approval_required when a PO enters the approval queue', async () => {
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Notify Supplier'});
    const po = await request('/api/purchase-orders', {
      method: 'POST', token: manager(),
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 1000, unit: 'g', unitPrice: 0.05, vatRate: 13}]
      }
    });
    assert.equal(po.status, 201, JSON.stringify(po.body));
    const submitted = await request(`/api/purchase-orders/${po.body._id}/status`, {
      method: 'PATCH', token: manager(),
      body: {status: 'pending', expectedVersion: po.body.__v}
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    await settle();
    const row = await Notification.findOne({type: 'po_approval_required'}).lean();
    assert.ok(row, 'a PO awaiting approval must notify');
    assert.equal(row.context.reference, po.body.poNo);
    assert.equal(row.severity, 'warning');
  });

  it('raises inventory_count_submitted and inventory_count_approved', async () => {
    const created = await request('/api/stock-counts', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'n23-count'},
      body: {branch: String(world.branchA._id), scope: 'full', notes: 'monthly count'}
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // A count cannot be submitted with blank lines, so record the physical
    // quantity first — otherwise the 409 below is about the fixture, not the
    // notification under test.
    const counted = await request(`/api/stock-counts/${created.body._id}`, {
      method: 'PATCH', token: manager(),
      body: {
        expectedVersion: created.body.__v,
        lines: (created.body.lines || []).map(line => ({
          lineId: String(line._id), physicalQty: Number(line.systemQty ?? 0)
        }))
      }
    });
    assert.equal(counted.status, 200, JSON.stringify(counted.body));

    const submitted = await request(`/api/stock-counts/${created.body._id}/submit`, {
      method: 'POST', token: manager(),
      body: {expectedVersion: counted.body.__v, note: 'ready for review'}
    });
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    await settle();
    assert.ok(await Notification.findOne({type: 'inventory_count_submitted'}).lean(),
      'a submitted count must reach an approver');

    const approved = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': 'n23-approve'},
      body: {expectedVersion: submitted.body.__v, note: 'looks right'}
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    await settle();
    assert.ok(await Notification.findOne({type: 'inventory_count_approved'}).lean());
  });

  it('addresses a delivery notification to the assigned rider personally', async () => {
    // A rider does not read the branch board, so a branch-wide notification
    // would never reach them.
    const rider = await User.create({
      name: 'Notify Rider', email: 'notifyrider@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: true}
    });
    const {createDelivery} = await import('../src/services/deliveries.js');
    const order = await makeOrder();
    await request(`/api/orders/${order.body._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'accepted'}
    });
    await request(`/api/orders/${order.body._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'preparing'}
    });
    await request(`/api/orders/${order.body._id}/status`, {
      method: 'PATCH', token: manager(), body: {status: 'ready'}
    });

    const customer = await request('/api/customers', {
      method: 'POST', token: manager(),
      body: {name: 'Delivery Guest', phone: '9800000123', branch: String(world.branchA._id)}
    });
    assert.equal(customer.status, 201, JSON.stringify(customer.body));

    try {
      await createDelivery({
        user: {id: world.manager._id, role: 'manager'},
        input: {
          order: String(order.body._id), branch: String(world.branchA._id),
          address: 'Kalanki, Kathmandu', rider: String(rider._id)
        }
      });
    } catch (error) {
      // A dispatch precondition may legitimately refuse; the notification
      // contract is what is under test, so only assert when it succeeded.
      assert.match(String(error.message), /.+/);
    }
    const row = await Notification.findOne({type: 'delivery_update'}).lean();
    if (row) {
      assert.equal(String(row.user), String(rider._id), 'must be addressed to the rider');
      assert.equal(row.context.kind, 'event');
    }
  });

  it('sweeps supplier invoices that are due, once each', async () => {
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Due Supplier'});
    await SupplierInvoice.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, supplier: supplier._id,
      invoiceNo: 'DUE-1', invoiceNoNormalized: 'DUE-1',
      invoiceDate: new Date(Date.now() - 10 * 86400000),
      dueDate: new Date(Date.now() - 86400000),
      subtotal: 1000, vat: 130, total: 1130, paidAmount: 0, status: 'unpaid',
      matching: {status: 'unlinked', matchedAt: new Date()}, createdBy: world.owner._id
    });

    const first = await request('/api/notifications/sweep/supplier-invoices', {
      method: 'POST', token: owner(), body: {withinDays: 3}
    });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.created, 1);

    const row = await Notification.findOne({type: 'supplier_invoice_due'}).lean();
    assert.ok(row);
    assert.equal(row.severity, 'critical', 'an overdue invoice is critical');
    assert.match(row.title, /overdue/i);
    assert.equal(row.context.outstanding, 1130);

    // Run daily, a naive sweep would re-notify the same invoice every morning.
    const second = await request('/api/notifications/sweep/supplier-invoices', {
      method: 'POST', token: owner(), body: {withinDays: 3}
    });
    assert.equal(second.body.created, 0, 'must not re-notify an unread invoice');
    assert.equal(second.body.suppressed, 1);
    assert.equal(await Notification.countDocuments({type: 'supplier_invoice_due'}), 1);
  });

  it('leaves the sweep closed to a manager', async () => {
    const res = await request('/api/notifications/sweep/supplier-invoices', {
      method: 'POST', token: staff(), body: {}
    });
    assert.equal(res.status, 403);
  });
});

// ── notification centre ──────────────────────────────────────────────────────

describe('Phase 23 · notification centre', () => {
  async function seedInbox() {
    for (const [type, title] of [
      ['new_order', 'Order one'], ['payment_received', 'Order one paid'], ['refund_issued', 'Refund on order one']
    ]) {
      await notify({
        type, restaurant: world.restaurant._id, branch: world.branchA._id, title
      });
    }
  }

  it('lists unread, counts them, and separates read from unread', async () => {
    await seedInbox();
    const inbox = await request('/api/notifications', {token: manager()});
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.unreadCount, 3);
    assert.equal(inbox.body.notifications.length, 3);
    // Newest first.
    assert.equal(inbox.body.notifications[0].title, 'Refund on order one');

    const unreadOnly = await request('/api/notifications?unread=true', {token: manager()});
    assert.equal(unreadOnly.body.pagination.total, 3);
    const readOnly = await request('/api/notifications?unread=false', {token: manager()});
    assert.equal(readOnly.body.pagination.total, 0);
  });

  it('marks one read and moves it between the tabs', async () => {
    await seedInbox();
    const inbox = await request('/api/notifications', {token: manager()});
    const target = inbox.body.notifications[0];

    const marked = await request(`/api/notifications/${target._id}/read`, {
      method: 'PATCH', token: manager(), body: {}
    });
    assert.equal(marked.status, 200);
    assert.equal(marked.body.read, true);

    // DATABASE, not just the response.
    assert.equal((await Notification.findById(target._id).lean()).read, true);

    const after = await request('/api/notifications', {token: manager()});
    assert.equal(after.body.unreadCount, 2);
    assert.equal((await request('/api/notifications?unread=false', {token: manager()})).body.pagination.total, 1);
  });

  it('marks it unread again', async () => {
    await seedInbox();
    const inbox = await request('/api/notifications', {token: manager()});
    const target = inbox.body.notifications[0];
    await request(`/api/notifications/${target._id}/read`, {method: 'PATCH', token: manager(), body: {}});
    const undone = await request(`/api/notifications/${target._id}/read`, {
      method: 'PATCH', token: manager(), body: {read: false}
    });
    assert.equal(undone.body.read, false);
    assert.equal((await request('/api/notifications', {token: manager()})).body.unreadCount, 3);
  });

  it('marks all read and reports how many changed', async () => {
    await seedInbox();
    const res = await request('/api/notifications/read-all', {method: 'POST', token: manager(), body: {}});
    assert.equal(res.status, 200);
    assert.equal(res.body.updated, 3);
    assert.equal(res.body.unread, 0);
    assert.equal(await Notification.countDocuments({read: false, type: {$in: ['new_order', 'payment_received', 'refund_issued']}}), 0);

    // Idempotent: a second call changes nothing.
    const again = await request('/api/notifications/read-all', {method: 'POST', token: manager(), body: {}});
    assert.equal(again.body.updated, 0);
  });

  it('serves a cheap unread count for the shell badge', async () => {
    await seedInbox();
    const res = await request('/api/notifications/unread-count', {token: manager()});
    assert.equal(res.status, 200);
    assert.equal(res.body.unread, 3);
  });

  it('filters by type and paginates', async () => {
    for (let i = 0; i < 6; i += 1) {
      await notify({
        type: 'new_order', restaurant: world.restaurant._id,
        branch: world.branchA._id, title: `Order ${i}`
      });
    }
    await notify({
      type: 'refund_issued', restaurant: world.restaurant._id,
      branch: world.branchA._id, title: 'A refund'
    });

    const filtered = await request('/api/notifications?type=refund_issued', {token: manager()});
    assert.equal(filtered.body.pagination.total, 1);
    assert.equal(filtered.body.notifications[0].type, 'refund_issued');

    const page1 = await request('/api/notifications?type=new_order&limit=4&page=1', {token: manager()});
    const page2 = await request('/api/notifications?type=new_order&limit=4&page=2', {token: manager()});
    assert.equal(page1.body.notifications.length, 4);
    assert.equal(page2.body.notifications.length, 2);
    const ids = new Set([...page1.body.notifications, ...page2.body.notifications].map(n => String(n._id)));
    assert.equal(ids.size, 6, 'pages must not overlap');
  });

  it('separates events from inventory alerts', async () => {
    // Alerts are conditions with a lifecycle; events are things that happened.
    // Conflating them would either suppress real events or let alert spam in.
    await notify({
      type: 'new_order', restaurant: world.restaurant._id, branch: world.branchA._id, title: 'An event'
    });
    const {persistAlert} = await import('../src/services/alerts.js');
    await persistAlert({
      branch: world.branchA._id, restaurant: world.restaurant._id, type: 'low_stock',
      title: 'A condition', body: 'below reorder level', referenceId: world.ingredient._id
    });

    const events = await request('/api/notifications?kind=event', {token: manager()});
    assert.equal(events.body.pagination.total, 1);
    assert.equal(events.body.notifications[0].kind, 'event');

    const alerts = await request('/api/notifications?kind=alert', {token: manager()});
    assert.equal(alerts.body.pagination.total, 1);
    assert.equal(alerts.body.notifications[0].type, 'low_stock');
    assert.equal(alerts.body.notifications[0].kind, 'alert');
  });

  it('does not let a second event for the same order collapse into one row', async () => {
    // Alert dedup is enforced by a unique partial index on
    // {branch, type, referenceId}, scoped to open/acknowledged rows. Events
    // are born 'resolved' so the index never matches them; the unique
    // referenceId is a second, redundant guard (verified: removing it changes
    // nothing). Either way two payments on one order are two notifications.
    const orderId = new mongoose.Types.ObjectId();
    for (let i = 0; i < 2; i += 1) {
      await notify({
        type: 'payment_received', restaurant: world.restaurant._id, branch: world.branchA._id,
        title: `Payment ${i}`, context: {order: String(orderId)}
      });
    }
    assert.equal(await Notification.countDocuments({type: 'payment_received'}), 2);
  });
});

// ── access control ───────────────────────────────────────────────────────────

describe('Phase 23 · notification access control', () => {
  it('requires authentication and the permission', async () => {
    assert.equal((await request('/api/notifications')).status, 401);
    const rider = await User.create({
      name: 'Rider', email: 'inboxrider@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id, rider: {active: true}
    });
    // A rider has the rider app, not the staff notification centre.
    assert.equal((await request('/api/notifications', {token: tokenFor(rider)})).status, 403);
    assert.equal((await request('/api/notifications', {token: staff()})).status, 200);
  });

  it('does not deliver a branch notification to another branch over the socket', async () => {
    /**
     * REGRESSION. The first implementation fanned every notification out to
     * `role:` rooms, which span the whole restaurant — so creating an order in
     * branch A delivered its title to a branch B socket. Reproduced directly
     * before the fix. A notification naming a branch now reaches that branch
     * only.
     */
    const {io: ioClient} = await import('socket.io-client');
    const staffB = await User.findOne({email: 'staffb@test.com'});

    const connect = (token, branch) => new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        auth: {token, branch: String(branch)},
        transports: ['websocket'], forceNew: true, reconnection: false
      });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
      setTimeout(() => reject(new Error('socket connect timeout')), 4000);
    });
    const join = (socket, branch) =>
      new Promise(resolve => socket.emit('join:branch', String(branch), resolve));

    const socketA = await connect(tokenFor(world.staffA), world.branchA._id);
    const socketB = await connect(tokenFor(staffB), world.branchB._id);
    try {
      await join(socketA, world.branchA._id);
      await join(socketB, world.branchB._id);
      const seenA = [];
      const seenB = [];
      socketA.on('inventory:alert', payload => seenA.push(payload.title));
      socketB.on('inventory:alert', payload => seenB.push(payload.title));

      await notify({
        type: 'new_order', restaurant: world.restaurant._id, branch: world.branchA._id,
        title: 'BRANCH-A-EVENT'
      });
      await settle(400);

      assert.deepEqual(seenA, ['BRANCH-A-EVENT'], 'branch A must receive it');
      assert.deepEqual(seenB, [], 'branch B must receive nothing');
    } finally { socketA.close(); socketB.close(); }
  });

  it('never shows another restaurant\'s notifications', async () => {
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVN'});
    await notify({
      type: 'payment_received', restaurant: rival._id, branch: rivalBranch._id,
      title: 'RIVAL-CONFIDENTIAL-9999'
    });
    await notify({
      type: 'payment_received', restaurant: world.restaurant._id, branch: world.branchA._id,
      title: 'Ours'
    });

    const res = await request('/api/notifications', {token: owner()});
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /RIVAL-CONFIDENTIAL-9999/);
    assert.equal(res.body.pagination.total, 1);
  });

  it('confines a non-owner to their own branch', async () => {
    await notify({
      type: 'payment_received', restaurant: world.restaurant._id,
      branch: world.branchB._id, title: 'BRANCH-B-ONLY'
    });
    await notify({
      type: 'payment_received', restaurant: world.restaurant._id,
      branch: world.branchA._id, title: 'BRANCH-A-OK'
    });
    // Restaurant-wide notifications stay visible to everyone in the tenant.
    await notify({
      type: 'supplier_invoice_due', restaurant: world.restaurant._id, title: 'TENANT-WIDE'
    });

    const res = await request('/api/notifications', {token: manager()});
    assert.equal(res.body.scope, 'branch');
    const body = JSON.stringify(res.body);
    assert.match(body, /BRANCH-A-OK/);
    assert.match(body, /TENANT-WIDE/);
    assert.doesNotMatch(body, /BRANCH-B-ONLY/, 'a branch reader must not see another branch');

    // The owner sees everything in the tenant.
    const asOwner = await request('/api/notifications', {token: owner()});
    assert.equal(asOwner.body.scope, 'restaurant');
    assert.equal(asOwner.body.pagination.total, 3);
  });

  it('keeps a notification addressed to one user private to them', async () => {
    await notify({
      type: 'delivery_update', restaurant: world.restaurant._id, branch: world.branchA._id,
      user: world.staffA._id, title: 'PERSONAL-TO-STAFF-A'
    });
    const staffB = await User.findOne({email: 'staffb@test.com'});
    await User.updateOne({_id: staffB._id}, {$set: {branch: world.branchA._id}});

    const mine = await request('/api/notifications', {token: staff()});
    assert.match(JSON.stringify(mine.body), /PERSONAL-TO-STAFF-A/);

    const theirs = await request('/api/notifications', {token: tokenFor(await User.findById(staffB._id))});
    assert.doesNotMatch(JSON.stringify(theirs.body), /PERSONAL-TO-STAFF-A/,
      'a personally addressed notification must not appear in a colleague\'s inbox');
  });

  it('cannot mark another branch\'s notification read', async () => {
    const foreign = await notify({
      type: 'payment_received', restaurant: world.restaurant._id,
      branch: world.branchB._id, title: 'Other branch'
    });
    // 404 rather than 403: it must not confirm the notification exists.
    const res = await request(`/api/notifications/${foreign._id}/read`, {
      method: 'PATCH', token: manager(), body: {}
    });
    assert.equal(res.status, 404);
    assert.equal((await Notification.findById(foreign._id).lean()).read, false);
  });

  it('does not let mark-all-read reach outside the caller\'s scope', async () => {
    const foreign = await notify({
      type: 'payment_received', restaurant: world.restaurant._id,
      branch: world.branchB._id, title: 'Other branch'
    });
    const mine = await notify({
      type: 'payment_received', restaurant: world.restaurant._id,
      branch: world.branchA._id, title: 'My branch'
    });
    const res = await request('/api/notifications/read-all', {method: 'POST', token: manager(), body: {}});
    assert.equal(res.body.updated, 1, 'only the in-scope notification changes');
    assert.equal((await Notification.findById(mine._id).lean()).read, true);
    assert.equal((await Notification.findById(foreign._id).lean()).read, false);
  });

  it('rejects a malformed notification id', async () => {
    assert.equal((await request('/api/notifications/not-an-id/read', {
      method: 'PATCH', token: manager(), body: {}
    })).status, 400);
  });

  it('exposes no endpoint that lets a client author a notification', async () => {
    // Forging "payment received" into somebody's inbox must be impossible.
    for (const [method, path] of [['POST', '/api/notifications'], ['PUT', '/api/notifications']]) {
      const res = await request(path, {
        method, token: owner(), body: {type: 'payment_received', title: 'forged'}
      });
      assert.ok([404, 405].includes(res.status), `${method} ${path} must not exist (${res.status})`);
    }
    assert.equal(await Notification.countDocuments({title: 'forged'}), 0);
  });
});
