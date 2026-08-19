/**
 * Phase 14 — POS management workspace.
 *
 * The engine (11A–11F) is not rebuilt. This suite covers the workflows the new
 * manager UI drives end to end, and re-proves the authorisation and tenancy
 * boundaries against that surface — a screen is not a security boundary, so
 * every action it offers is tested server-side.
 *
 * Every assertion checks MongoDB state, not just the HTTP status.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Audit, Ingredient, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Order, Payment, Restaurant
} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let rival;
let keySeed = 0;
const KEY = () => `p14-${Date.now()}-${++keySeed}`;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  keySeed = 0;
  world = await seedWorld();
  await Payment.init();
  // A tax invoice cannot be issued without a PAN; the workspace needs one.
  await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {pan: '301234567'}});

  const restaurant = await Restaurant.create({name: 'Rival', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival Branch', code: 'RVL', address: 'Thamel'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival Owner', email: 'rival14@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const MENU = () => String(world.menu._id);
const BRANCH = () => String(world.branchA._id);

async function newOrder(body = {}, token = manager()) {
  const res = await request('/api/orders', {
    method: 'POST', token,
    body: {branch: BRANCH(), type: 'counter', items: [{menuItem: MENU(), qty: 2}], ...body}
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const pay = (id, body, key, token = manager()) =>
  request(`/api/orders/${id}/payments`, {
    method: 'POST', token, ...(key ? {headers: {'Idempotency-Key': key}} : {}), body
  });

const refund = (id, body, key, token = manager()) =>
  request(`/api/orders/${id}/refunds`, {
    method: 'POST', token, ...(key ? {headers: {'Idempotency-Key': key}} : {}), body
  });

const reverse = (paymentId, reason, token = owner()) =>
  request(`/api/payments/${paymentId}/reverse`, {method: 'POST', token, body: {reason}});

const summaryOf = (id, token = manager()) =>
  request(`/api/orders/${id}/payment-summary`, {token});

async function settledOrder(qty = 2) {
  const order = await newOrder({items: [{menuItem: MENU(), qty}]});
  await pay(order._id, {amount: order.total, method: 'cash'}, KEY());
  return order;
}

// ═══════════════════════════════════════════════════════════════════════════
// The workspace list and detail
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — workspace data', () => {
  it('lists branch orders with everything the workspace displays', async () => {
    const order = await newOrder();
    const res = await request(`/api/orders?branch=${BRANCH()}`, {token: manager()});
    assert.equal(res.status, 200);

    const row = (Array.isArray(res.body) ? res.body : res.body.items)
      .find(o => String(o._id) === String(order._id));
    assert.ok(row, 'the order must appear in its own branch');
    for (const field of ['orderNo', 'status', 'type', 'total', 'vat', 'dueAmount', 'createdAt']) {
      assert.ok(row[field] !== undefined, `${field} is needed by the list`);
    }
  });

  it('returns a payment summary with the settlement figures', async () => {
    const order = await settledOrder(2);
    const res = await summaryOf(order._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, order.total);
    assert.equal(res.body.paid, order.total);
    assert.equal(res.body.due, 0);
    assert.equal(res.body.settled, true);
    assert.equal(res.body.refundable, order.total);
    assert.equal(res.body.byMethod.cash, order.total);
  });

  it('shows stored amounts, not amounts recalculated from today\'s menu', async () => {
    const order = await newOrder({items: [{menuItem: MENU(), qty: 1}]});
    const originalTotal = order.total;

    // The menu price changes after the sale.
    const {MenuItem} = await import('../src/models/index.js');
    await MenuItem.updateOne({_id: world.menu._id}, {$set: {price: 9999}});

    const res = await request(`/api/orders/${order._id}`, {token: manager()});
    assert.equal(res.body.total, originalTotal, 'a historical order must never be re-priced');
    assert.equal(res.body.items[0].unitPrice, 350);
  });

  it('records modifiers on the line so the workspace can show them', async () => {
    const cheese = await Ingredient.create({
      restaurant: world.restaurant._id, code: 'CHZ14', name: 'Cheese', unit: 'g', minimumStock: 0
    });
    const {MenuItem} = await import('../src/models/index.js');
    const item = await MenuItem.create({
      name: 'Burger14', price: 200, vatInclusive: false,
      modifierGroups: [{
        key: 'extras', name: 'Extras', kind: 'extra', selection: 'multi',
        options: [{key: 'cheese', name: 'Cheese', priceDelta: 40}]
      }]
    });

    const order = await newOrder({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'extras', option: 'cheese'}]}]
    });
    const stored = await Order.findById(order._id);
    assert.equal(stored.items[0].modifiers[0].name, 'Cheese');
    assert.equal(stored.items[0].unitPrice, 240, 'the modifier is priced into the line');
    assert.ok(cheese);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Split and partial payment, as the UI drives it
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — payment workflows', () => {
  it('settles a bill across several tenders and reports the running balance', async () => {
    const order = await newOrder();
    await pay(order._id, {amount: 200, method: 'cash'}, KEY());
    let sum = (await summaryOf(order._id)).body;
    assert.equal(sum.settled, false);
    assert.equal(sum.due, Math.round((order.total - 200) * 100) / 100);

    await pay(order._id, {amount: sum.due, method: 'card'}, KEY());
    sum = (await summaryOf(order._id)).body;
    assert.equal(sum.due, 0);
    assert.equal(sum.settled, true);
    assert.equal((await Order.findById(order._id)).status, 'completed');
  });

  it('refuses overpayment and banks nothing', async () => {
    const order = await newOrder();
    const res = await pay(order._id, {amount: order.total + 500, method: 'cash'}, KEY());
    assert.ok([400, 409].includes(res.status));
    assert.equal(await Payment.countDocuments({order: order._id}), 0);
  });

  it('banks a double-submitted payment once', async () => {
    const order = await newOrder();
    const key = KEY();
    const first = await pay(order._id, {amount: 100, method: 'cash'}, key);
    const second = await pay(order._id, {amount: 100, method: 'cash'}, key);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal((await Order.findById(order._id)).paidAmount, 100);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Refunds
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — refunds', () => {
  it('refunds partially and reports the remaining refundable amount', async () => {
    const order = await settledOrder(2);
    assert.equal((await refund(order._id, {amount: 100, reason: 'Cold food'}, KEY())).status, 201);

    const sum = (await summaryOf(order._id)).body;
    assert.equal(sum.refunded, 100);
    assert.equal(sum.refundable, Math.round((order.total - 100) * 100) / 100);
    assert.equal((await Order.findById(order._id)).refundAmount, 100);
  });

  it('refuses to refund more than remains refundable', async () => {
    const order = await settledOrder(1);
    await refund(order._id, {amount: 100, reason: 'Partial'}, KEY());
    const over = await refund(order._id, {amount: order.total, reason: 'Too much'}, KEY());
    assert.ok([400, 409].includes(over.status));
    assert.equal((await Order.findById(order._id)).refundAmount, 100);
  });

  it('banks a double-submitted refund once', async () => {
    const order = await settledOrder(2);
    const key = KEY();
    assert.equal((await refund(order._id, {amount: 50, reason: 'Dup'}, key)).status, 201);
    assert.equal((await refund(order._id, {amount: 50, reason: 'Dup'}, key)).status, 200);
    assert.equal((await Order.findById(order._id)).refundAmount, 50);
  });

  it('refuses a refund from staff', async () => {
    const order = await settledOrder(1);
    const res = await refund(order._id, {amount: 10, reason: 'Nope'}, KEY(), staff());
    assert.equal(res.status, 403, 'hiding the button is not the control');
    assert.equal((await Order.findById(order._id)).refundAmount, 0);
  });

  it('does not restore stock on a money-only refund', async () => {
    // The food was made and left the kitchen; refunding the money does not
    // put ingredients back on the shelf.
    const order = await settledOrder(1);
    const before = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;

    await refund(order._id, {amount: 100, reason: 'Goodwill'}, KEY());

    const after = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.equal(after, before, 'a refund must not silently restore inventory');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Payment reversal
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — payment reversal', () => {
  const livePayment = orderId =>
    Payment.findOne({order: orderId, status: 'paid', refundOf: null});

  it('reverses a mistyped tender, reopening the balance without deleting it', async () => {
    const order = await settledOrder(1);
    const payment = await livePayment(order._id);

    const res = await reverse(payment._id, 'Charged to cash by mistake');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, 0);
    assert.equal(stored.dueAmount, order.total);
    assert.notEqual(stored.status, 'completed');

    // Not a deletion: the row survives and carries its history.
    const row = await Payment.findById(payment._id);
    assert.ok(row, 'the original payment must remain auditable');
    assert.equal(row.status, 'reversed');
    assert.ok(row.reversedAt instanceof Date);
    assert.equal(row.reversalReason, 'Charged to cash by mistake');
    assert.ok(row.reversedBy);
  });

  it('refuses a duplicate reversal', async () => {
    const order = await settledOrder(1);
    const payment = await livePayment(order._id);
    assert.equal((await reverse(payment._id, 'First')).status, 200);
    assert.equal((await reverse(payment._id, 'Second')).status, 409);
    assert.equal((await Order.findById(order._id)).dueAmount, order.total,
      'the balance must not be credited twice');
  });

  it('reserves reversal for owners', async () => {
    const order = await settledOrder(1);
    const payment = await livePayment(order._id);
    assert.equal((await reverse(payment._id, 'Wrong tender', manager())).status, 403);
    assert.equal((await reverse(payment._id, 'Wrong tender', staff())).status, 403);
    assert.equal((await Payment.findById(payment._id)).status, 'paid');
  });

  it('audits the reversal', async () => {
    const order = await settledOrder(1);
    const payment = await livePayment(order._id);
    await reverse(payment._id, 'Wrong tender at the till');

    const entry = await Audit.findOne({action: 'payment_reversed', entityId: payment._id}).lean();
    assert.ok(entry);
    assert.equal(String(entry.user), String(world.owner._id));
    assert.equal(entry.after.reason, 'Wrong tender at the till');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Receipts and invoice numbering
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — receipts', () => {
  it('previews without allocating an invoice number', async () => {
    const order = await settledOrder(1);
    const res = await request(`/api/orders/${order._id}/receipt`, {token: manager()});
    assert.equal(res.status, 200);
    assert.equal((await Order.findById(order._id)).invoiceNo, undefined,
      'previewing must never burn an invoice number');
  });

  it('allocates a sequential invoice number on the first issue', async () => {
    const order = await settledOrder(1);
    assert.equal((await request(`/api/orders/${order._id}/receipt?issue=true`, {token: manager()})).status, 200);

    const stored = await Order.findById(order._id);
    assert.match(stored.invoiceNo, /^INV-[A-Z]+-\d{4}-\d{6}$/);
    assert.ok(stored.invoicedAt instanceof Date);
  });

  it('reuses the same number on a reprint and marks it', async () => {
    const order = await settledOrder(1);
    await request(`/api/orders/${order._id}/receipt?issue=true`, {token: manager()});
    const first = (await Order.findById(order._id)).invoiceNo;

    const again = await request(`/api/orders/${order._id}/receipt?issue=true`, {token: manager()});
    assert.equal(again.status, 200);
    const stored = await Order.findById(order._id);
    assert.equal(stored.invoiceNo, first, 'a reprint must not mint a second number');
    assert.ok(stored.printCount > 1);
  });

  it('renders printable HTML that flags a reprint', async () => {
    const order = await settledOrder(1);
    await request(`/api/orders/${order._id}/receipt?issue=true`, {token: manager()});
    const html = await request(`/api/orders/${order._id}/receipt?format=html`, {token: manager()});
    assert.equal(html.status, 200);
    assert.match(String(html.body), /REPRINT/i);
  });

  it('escapes rendered values rather than injecting them', async () => {
    const {Customer} = await import('../src/models/operations.js');
    const nasty = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: '<script>alert(1)</script>', phone: '9800000014', phoneKey: '9800000014'
    });
    const order = await newOrder({customer: String(nasty._id), items: [{menuItem: MENU(), qty: 1}]});
    await pay(order._id, {amount: order.total, method: 'cash'}, KEY());
    await request(`/api/orders/${order._id}/receipt?issue=true`, {token: manager()});

    const html = String((await request(`/api/orders/${order._id}/receipt?format=html`, {token: manager()})).body);
    assert.ok(!html.includes('<script>alert(1)</script>'), 'the script tag must be escaped');
    assert.match(html, /&lt;script&gt;/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorisation and tenancy across the workspace surface
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — authorisation and tenancy', () => {
  it('refuses anonymous and invalid tokens on every workspace endpoint', async () => {
    const order = await settledOrder(1);
    const payment = await Payment.findOne({order: order._id, status: 'paid'});
    const endpoints = [
      [`/api/orders?branch=${BRANCH()}`, {}],
      [`/api/orders/${order._id}`, {}],
      [`/api/orders/${order._id}/payment-summary`, {}],
      [`/api/orders/${order._id}/payments`, {}],
      [`/api/orders/${order._id}/receipt`, {}],
      [`/api/orders/${order._id}/refunds`, {method: 'POST', body: {amount: 10, reason: 'x'}}],
      [`/api/payments/${payment._id}/reverse`, {method: 'POST', body: {reason: 'xyz'}}]
    ];
    for (const [path, options] of endpoints) {
      assert.equal((await request(path, options)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {...options, token: 'not.a.jwt'})).status, 401, `${path} invalid`);
    }
  });

  it('refuses every cross-restaurant workspace action', async () => {
    const order = await settledOrder(1);
    const payment = await Payment.findOne({order: order._id, status: 'paid'});
    const intruder = tokenFor(rival.owner);

    for (const [path, options] of [
      [`/api/orders/${order._id}`, {}],
      [`/api/orders/${order._id}/payment-summary`, {}],
      [`/api/orders/${order._id}/receipt`, {}],
      [`/api/orders/${order._id}/payments`, {method: 'POST', body: {amount: 10, method: 'cash'}}],
      [`/api/orders/${order._id}/refunds`, {method: 'POST', body: {amount: 10, reason: 'theft'}}],
      [`/api/payments/${payment._id}/reverse`, {method: 'POST', body: {reason: 'theft'}}]
    ]) {
      const res = await request(path, {...options, token: intruder});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }

    // Nothing may have moved.
    const stored = await Order.findById(order._id);
    assert.equal(stored.paidAmount, order.total);
    assert.equal(stored.refundAmount, 0);
    assert.equal((await Payment.findById(payment._id)).status, 'paid');
  });

  it('does not leak another restaurant\'s orders into the list', async () => {
    await settledOrder(1);
    const theirs = await request(`/api/orders?branch=${BRANCH()}`, {token: tokenFor(rival.owner)});
    if (theirs.status === 200) {
      const rows = Array.isArray(theirs.body) ? theirs.body : theirs.body.items || [];
      assert.equal(rows.length, 0, 'a rival must see none of our orders');
    } else {
      assert.ok([403, 404].includes(theirs.status));
    }
  });

  it('rejects a forged amount rather than trusting the client', async () => {
    const order = await newOrder();
    // A client claiming to pay far more than the bill.
    const forged = await pay(order._id, {amount: order.total * 10, method: 'cash'}, KEY());
    assert.ok([400, 409].includes(forged.status));

    // A client injecting protected fields.
    const massAssign = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {
        branch: BRANCH(), type: 'counter', items: [{menuItem: MENU(), qty: 1}],
        total: 1, paidAmount: 9999, status: 'completed', invoiceNo: 'INV-FAKE-1'
      }
    });
    if (massAssign.status === 201) {
      const stored = await Order.findById(massAssign.body._id);
      assert.notEqual(stored.total, 1, 'the server prices the order');
      assert.equal(stored.paidAmount, 0);
      assert.notEqual(stored.invoiceNo, 'INV-FAKE-1');
    } else {
      assert.equal(massAssign.status, 400);
    }
  });

  it('lets staff run the till but not the financial controls', async () => {
    const order = await newOrder({}, staff());
    assert.equal((await pay(order._id, {amount: 100, method: 'cash'}, KEY(), staff())).status, 201,
      'staff must be able to take payment');

    await pay(order._id, {amount: order.total - 100, method: 'cash'}, KEY());
    const payment = await Payment.findOne({order: order._id, status: 'paid'});
    assert.equal((await refund(order._id, {amount: 10, reason: 'x'}, KEY(), staff())).status, 403);
    assert.equal((await reverse(payment._id, 'wrong tender', staff())).status, 403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inventory and ledger safety
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — inventory and ledger', () => {
  it('deducts stock through the ledger when a sale is rung up', async () => {
    const before = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;

    const order = await newOrder({items: [{menuItem: MENU(), qty: 2}]});

    const after = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.equal(before - after, 500, '2 plates at 250g');

    const rows = await InventoryTransaction.find({
      branch: world.branchA._id, ingredient: world.ingredient._id, referenceId: order._id
    }).lean();
    assert.ok(rows.length >= 1, 'the movement must go through the ledger');
    for (const row of rows) {
      assert.ok(row.previousQty != null && row.newQty != null);
      assert.ok(Math.abs((row.previousQty + row.changeQty) - row.newQty) < 1e-9);
      assert.ok(row.user, 'the actor is recorded');
    }
  });

  it('leaves the ledger untouched when an order is refused', async () => {
    const rowsBefore = await InventoryTransaction.countDocuments({});
    const res = await request('/api/orders', {
      method: 'POST', token: manager(),
      body: {branch: BRANCH(), type: 'counter', items: [{menuItem: MENU(), qty: 100000}]}
    });
    assert.ok([400, 409].includes(res.status), 'far beyond available stock');
    assert.equal(await InventoryTransaction.countDocuments({}), rowsBefore);
  });
});
