import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Audit, Ingredient, MenuItem, User} from '../src/models/index.js';
import {Branch, Customer, Order, Payment, Restaurant} from '../src/models/operations.js';
import {normalizeGuest} from '../src/services/storefront.js';
import {PUBLIC_RATE_LIMITS} from '../src/routes/storefront.js';

const PUBLIC_LIMIT_ORDER = PUBLIC_RATE_LIMITS.order.max;
const PUBLIC_LIMIT_BROWSE = PUBLIC_RATE_LIMITS.browse.max;
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

// Phase 8A — public online ordering.
//
// This is the first unauthenticated write path in the system, so the tests
// below spend as much effort on what a guest must NOT be able to do as on the
// happy path.

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const BRANCH = () => String(world.branchA._id);
const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

/** A public request carries no token at all. */
function guestCart(overrides = {}) {
  return {
    branch: BRANCH(),
    type: 'delivery',
    items: [{menuItem: String(world.menu._id), qty: 2}],
    customer: {name: 'Ram Thapa', phone: '9800000001'},
    address: 'Jhamsikhel, Lalitpur',
    paymentMethod: 'cod',
    ...overrides
  };
}

const placeOrder = body => request('/api/public/orders', {method: 'POST', body});
const quote = body => request('/api/public/quote', {method: 'POST', body});

// ── Menu ─────────────────────────────────────────────────────────────────────
describe('Phase 8A — public menu', () => {
  it('serves branches and a menu with no authentication', async () => {
    const branches = await request('/api/public/branches');
    assert.equal(branches.status, 200, branches.body?.message);
    assert.ok(branches.body.branches.length >= 1);
    assert.ok(branches.body.branches[0].name);

    const menu = await request(`/api/public/menu?branch=${BRANCH()}`);
    assert.equal(menu.status, 200, menu.body?.message);
    assert.equal(menu.body.branch.name, 'Kathmandu Branch');
    assert.ok(menu.body.categories.length >= 1);
    const item = menu.body.categories[0].items[0];
    assert.equal(item.name, 'Chicken Biryani');
    assert.equal(item.price, 350);
  });

  it('never exposes cost, margin, recipe or supplier data', async () => {
    const menu = await request(`/api/public/menu?branch=${BRANCH()}`);
    const raw = JSON.stringify(menu.body);
    for (const secret of [
      'foodCost', 'recipeCost', 'packagingCost', 'margin', 'grossMargin',
      'recipe', 'ingredient', 'supplier', 'station', 'prepMinutes'
    ]) {
      assert.ok(!raw.includes(secret), `public menu leaked "${secret}"`);
    }
  });

  it('exposes modifier choices without their ingredient mappings', async () => {
    await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Momo', price: 300, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}],
      modifierGroups: [{
        key: 'extras', name: 'Extras', kind: 'extra', selection: 'multi',
        options: [{key: 'cheese', name: 'Extra cheese', priceDelta: 50, ingredient: world.ingredient._id, qty: 20, unit: 'g'}]
      }]
    });
    const menu = await request(`/api/public/menu?branch=${BRANCH()}`);
    const momo = menu.body.categories.flatMap(c => c.items).find(i => i.name === 'Momo');
    assert.ok(momo, 'the item should be listed');
    assert.equal(momo.modifierGroups[0].options[0].name, 'Extra cheese');
    assert.equal(momo.modifierGroups[0].options[0].priceDelta, 50);
    assert.ok(!JSON.stringify(momo).includes('ingredient'), 'ingredient mapping must stay private');
  });

  it('validates the branch', async () => {
    assert.equal((await request('/api/public/menu')).status, 400);
    assert.equal((await request('/api/public/menu?branch=nonsense')).status, 400);
    assert.equal((await request(`/api/public/menu?branch=${new mongoose.Types.ObjectId()}`)).status, 404);
  });

  it('hides an inactive branch', async () => {
    await Branch.updateOne({_id: world.branchB._id}, {$set: {active: false}});
    const branches = await request('/api/public/branches');
    assert.ok(!branches.body.branches.some(b => String(b.id) === String(world.branchB._id)));
    assert.equal((await request(`/api/public/menu?branch=${world.branchB._id}`)).status, 404);
  });
});

// ── Cart and quote ───────────────────────────────────────────────────────────
describe('Phase 8A — cart pricing', () => {
  it('prices a cart server-side with VAT', async () => {
    const res = await quote({branch: BRANCH(), type: 'delivery', items: [{menuItem: String(world.menu._id), qty: 2}], address: 'Patan'});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.subtotal, 700);
    assert.equal(res.body.vatRate, 13);
    assert.equal(res.body.vat, 91);
    assert.equal(res.body.total, 791);
    assert.equal(res.body.lines[0].qty, 2);
  });

  it('quotes takeaway without a delivery fee', async () => {
    const res = await quote({branch: BRANCH(), type: 'takeaway', items: [{menuItem: String(world.menu._id), qty: 1}]});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.deliveryFee, 0);
    assert.equal(res.body.total, 395.5);
  });

  it('applies modifier pricing from the catalog', async () => {
    const item = await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Sizes', price: 200, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}],
      modifierGroups: [{
        key: 'size', name: 'Size', kind: 'variant', selection: 'single',
        options: [{key: 'reg', name: 'Regular'}, {key: 'lg', name: 'Large', priceOverride: 350}]
      }]
    });
    const res = await quote({
      branch: BRANCH(), type: 'takeaway',
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'lg'}]}]
    });
    assert.equal(res.body.subtotal, 350, 'the variant override must come from the catalog');
  });

  it('rejects an empty or oversized cart', async () => {
    assert.equal((await quote({branch: BRANCH(), type: 'takeaway', items: []})).status, 400);
    const many = Array.from({length: 31}, () => ({menuItem: String(world.menu._id), qty: 1}));
    assert.equal((await quote({branch: BRANCH(), type: 'takeaway', items: many})).status, 400);
    assert.equal((await quote({
      branch: BRANCH(), type: 'takeaway', items: [{menuItem: String(world.menu._id), qty: 21}]
    })).status, 400);
  });
});

// ── Checkout ─────────────────────────────────────────────────────────────────
describe('Phase 8A — placing an order', () => {
  it('completes the flow: menu → cart → customer → address → payment → order', async () => {
    const res = await placeOrder(guestCart());
    assert.equal(res.status, 201, res.body?.message);
    assert.match(res.body.orderNo, /^WEB-\d{7}$/);
    assert.equal(res.body.status, 'pending');
    assert.equal(res.body.total, 791);
    assert.equal(res.body.paymentStatus, 'due_on_delivery');

    const stored = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(stored.source, 'online');
    assert.equal(stored.type, 'delivery');
    assert.equal(stored.deliveryAddress, 'Jhamsikhel, Lalitpur');
    assert.equal(stored.dueAmount, 791);
  });

  it('does not deduct stock until the branch accepts', async () => {
    const {InventoryTransaction} = await import('../src/models/operations.js');
    const before = await InventoryTransaction.countDocuments({});
    const res = await placeOrder(guestCart());
    assert.equal(res.status, 201, res.body?.message);
    const stored = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(stored.inventoryDeducted, false,
      'an unaccepted web order must not move the ledger');
    assert.equal(await InventoryTransaction.countDocuments({}), before);
  });

  it('creates a customer, and reuses them on a second order', async () => {
    await placeOrder(guestCart());
    assert.equal(await Customer.countDocuments({phone: '9800000001'}), 1);
    await placeOrder(guestCart({address: 'Patan Dhoka'}));
    assert.equal(await Customer.countDocuments({phone: '9800000001'}), 1,
      'a returning guest must not be duplicated');
    const customer = await Customer.findOne({phone: '9800000001'});
    assert.equal(customer.addresses.length, 2, 'the new address is remembered');
  });

  it('records a digital payment as pending, never as taken', async () => {
    const res = await placeOrder(guestCart({paymentMethod: 'esewa'}));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.paymentStatus, 'awaiting_payment');
    const stored = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(stored.paidAmount, 0, 'no money has actually been taken');
    const payment = await Payment.findOne({order: stored._id});
    assert.equal(payment.status, 'pending');
    assert.equal(payment.method, 'esewa');
  });

  it('requires a delivery address for delivery, not for takeaway', async () => {
    assert.equal((await placeOrder(guestCart({address: undefined}))).status, 400);
    assert.equal((await placeOrder(guestCart({address: 'abc'}))).status, 400, 'too short to deliver to');
    const takeaway = await placeOrder(guestCart({type: 'takeaway', address: undefined}));
    assert.equal(takeaway.status, 201, takeaway.body?.message);
  });

  it('validates the guest contact block', () => {
    assert.deepEqual(normalizeGuest({name: ' Ram ', phone: ' 98000-00001 '}),
      {name: 'Ram', phone: '98000-00001', email: undefined});
    assert.throws(() => normalizeGuest({name: 'R', phone: '9800000001'}), /contact name/);
    assert.throws(() => normalizeGuest({name: 'Ram Thapa', phone: '12'}), /contact phone/);
    assert.throws(() => normalizeGuest({name: 'Ram Thapa', phone: '9800000001', email: 'nope'}), /Invalid email/);
  });

  it('rejects unknown payment methods and order types', async () => {
    assert.equal((await placeOrder(guestCart({paymentMethod: 'crypto'}))).status, 400);
    assert.equal((await placeOrder(guestCart({type: 'dine-in'}))).status, 400,
      'a guest cannot book a table through the storefront');
    assert.equal((await placeOrder(guestCart({type: 'counter'}))).status, 400);
  });
});

// ── Abuse resistance ─────────────────────────────────────────────────────────
describe('Phase 8A — the public endpoint cannot be abused', () => {
  it('ignores any price the browser tries to send', async () => {
    // Strict schemas reject unknown keys outright.
    assert.equal((await placeOrder(guestCart({
      items: [{menuItem: String(world.menu._id), qty: 1, unitPrice: 1}]
    }))).status, 400);
    assert.equal((await placeOrder(guestCart({total: 1}))).status, 400);
    assert.equal((await placeOrder(guestCart({
      items: [{menuItem: String(world.menu._id), qty: 1}], deliveryFee: 0, discount: 500
    }))).status, 400);

    // And the honest path is priced from the catalog, not the request.
    const res = await placeOrder(guestCart({items: [{menuItem: String(world.menu._id), qty: 1}]}));
    const stored = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(stored.subtotal, 350, 'price comes from the stored menu item');
  });

  it('refuses a menu item belonging to another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const rivalIngredient = await Ingredient.create({
      restaurant: rival._id, code: 'RIV1', name: 'Rival Ingredient', unit: 'g'
    });
    const rivalItem = await MenuItem.create({
      restaurant: rival._id, name: 'Rival Dish', price: 99, vatInclusive: false,
      recipe: [{ingredient: rivalIngredient._id, qty: 10, unit: 'g'}]
    });
    const res = await placeOrder(guestCart({items: [{menuItem: String(rivalItem._id), qty: 1}]}));
    assert.equal(res.status, 404);
    assert.match(res.body.message, /not available at this branch/);

    // Control: our own item with the same guest succeeds, so the rejection
    // above is genuinely the tenant guard and not incidental validation.
    const ours = await placeOrder(guestCart({items: [{menuItem: String(world.menu._id), qty: 1}]}));
    assert.equal(ours.status, 201, ours.body?.message);
  });

  it('refuses an unknown or inactive menu item', async () => {
    assert.equal((await placeOrder(guestCart({
      items: [{menuItem: String(new mongoose.Types.ObjectId()), qty: 1}]
    }))).status, 404);
    await MenuItem.updateOne({_id: world.menu._id}, {$set: {active: false}});
    assert.equal((await placeOrder(guestCart())).status, 404);
  });

  it('does not let a guest reach the authenticated order API', async () => {
    assert.equal((await request('/api/orders', {
      method: 'POST',
      body: {branch: BRANCH(), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    })).status, 401, 'the staff order API stays closed');
    assert.equal((await request(`/api/kitchen/board?branch=${BRANCH()}`)).status, 401);
    assert.equal((await request(`/api/online-orders?branch=${BRANCH()}`)).status, 401);
  });

  it('keeps order tracking unenumerable', async () => {
    const res = await placeOrder(guestCart({customer: {name: 'Sita Rai', phone: '9800000009'}}));
    const orderNo = res.body.orderNo;

    const correct = await request(`/api/public/orders/track?orderNo=${orderNo}&phone=9800000009`);
    assert.equal(correct.status, 200);
    assert.equal(correct.body.status, 'pending');

    // A wrong phone is indistinguishable from a wrong order number.
    const wrongPhone = await request(`/api/public/orders/track?orderNo=${orderNo}&phone=9811111111`);
    assert.equal(wrongPhone.status, 404);
    const noPhone = await request(`/api/public/orders/track?orderNo=${orderNo}`);
    assert.equal(noPhone.status, 400);
  });

  it('does not expose internal costs on a tracked order', async () => {
    const res = await placeOrder(guestCart({customer: {name: 'Hari Lama', phone: '9800000010'}}));
    const tracked = await request(`/api/public/orders/track?orderNo=${res.body.orderNo}&phone=9800000010`);
    const raw = JSON.stringify(tracked.body);
    for (const secret of ['foodCost', 'recipeCost', 'station', 'inventoryRequirements', 'branch']) {
      assert.ok(!raw.includes(secret), `tracking leaked "${secret}"`);
    }
  });
});

// ── Rate limiting ────────────────────────────────────────────────────────────
describe('Phase 8A — rate limiting protects the public endpoint', () => {
  it('throttles a flood of public requests', async () => {
    // The suite runs with limits disabled (a test legitimately places dozens of
    // orders), so the limiter is exercised here against its own app instance.
    const express = (await import('express')).default;
    const rateLimit = (await import('express-rate-limit')).default;
    const http = await import('node:http');
    const {PUBLIC_RATE_LIMITS} = await import('../src/routes/storefront.js');

    const app = express();
    app.use(express.json());
    app.post('/api/public/orders',
      rateLimit({...PUBLIC_RATE_LIMITS.order, standardHeaders: true, legacyHeaders: false}),
      (_req, res) => res.status(201).json({ok: true}));

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    try {
      const statuses = [];
      // The configured cap is 8 per window; the 9th must be refused.
      for (let i = 0; i < PUBLIC_RATE_LIMITS.order.max + 1; i += 1) {
        const res = await fetch(`http://127.0.0.1:${port}/api/public/orders`, {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
        });
        statuses.push(res.status);
      }
      assert.equal(statuses.filter(s => s === 201).length, PUBLIC_RATE_LIMITS.order.max);
      assert.equal(statuses[statuses.length - 1], 429, 'the flood must be refused');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('limits ordering harder than browsing', () => {
    assert.ok(PUBLIC_LIMIT_ORDER < PUBLIC_LIMIT_BROWSE,
      'placing an order is the expensive operation and must be capped tightest');
  });
});

// ── Staff acceptance ─────────────────────────────────────────────────────────
describe('Phase 8A — the branch accepts or rejects a web order', () => {
  async function webOrder() {
    const res = await placeOrder(guestCart());
    assert.equal(res.status, 201, res.body?.message);
    return Order.findOne({orderNo: res.body.orderNo});
  }

  it('lists pending web orders for the branch', async () => {
    await webOrder();
    const res = await request(`/api/online-orders?branch=${BRANCH()}&pending=true`, {token: staff()});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.pending, 1);
    assert.equal(res.body.orders[0].source, 'online');
    assert.equal(res.body.orders[0].customer.phone, '9800000001');
  });

  it('accepting confirms the ticket and audits it', async () => {
    const order = await webOrder();
    const res = await request(`/api/online-orders/${order._id}/accept`, {method: 'POST', token: staff(), body: {}});
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.status, 'confirmed');
    const stored = await Order.findById(order._id);
    assert.ok(stored.acceptedOnlineAt instanceof Date);
    assert.ok(await Audit.findOne({entityId: order._id, action: 'online_order_accepted'}));
  });

  it('rejecting cancels it with a reason and moves no stock', async () => {
    const {InventoryTransaction} = await import('../src/models/operations.js');
    const order = await webOrder();
    const before = await InventoryTransaction.countDocuments({});
    const res = await request(`/api/online-orders/${order._id}/reject`, {
      method: 'POST', token: manager(), body: {reason: 'Kitchen at capacity'}
    });
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.status, 'cancelled');
    assert.equal(res.body.rejectionReason, 'Kitchen at capacity');
    assert.equal(await InventoryTransaction.countDocuments({}), before,
      'nothing was deducted, so nothing needs reversing');
  });

  it('cannot accept or reject twice', async () => {
    const order = await webOrder();
    assert.equal((await request(`/api/online-orders/${order._id}/accept`, {
      method: 'POST', token: staff(), body: {}
    })).status, 200);
    assert.equal((await request(`/api/online-orders/${order._id}/accept`, {
      method: 'POST', token: staff(), body: {}
    })).status, 409);
    assert.equal((await request(`/api/online-orders/${order._id}/reject`, {
      method: 'POST', token: manager(), body: {}
    })).status, 409);
  });

  it('refuses to accept a till order through the online route', async () => {
    const till = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: BRANCH(), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(till.status, 201, till.body?.message);
    assert.equal((await request(`/api/online-orders/${till.body._id}/accept`, {
      method: 'POST', token: staff(), body: {}
    })).status, 409);
  });

  it('restricts rejection to management and enforces tenant scope', async () => {
    const order = await webOrder();
    assert.equal((await request(`/api/online-orders/${order._id}/reject`, {
      method: 'POST', token: staff(), body: {}
    })).status, 403);

    const rivalRestaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const rivalBranch = await Branch.create({restaurant: rivalRestaurant._id, name: 'Rival', code: 'RVL'});
    const rivalOwner = await User.create({
      name: 'Rival Owner', email: 'rival8a@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival Co', restaurantId: rivalRestaurant._id, branch: rivalBranch._id
    });
    const token = tokenFor(rivalOwner);
    assert.ok([403, 404].includes((await request(`/api/online-orders?branch=${BRANCH()}`, {token})).status));
    assert.ok([403, 404].includes((await request(`/api/online-orders/${order._id}/accept`, {
      method: 'POST', token, body: {}
    })).status));
    assert.equal((await Order.findById(order._id)).status, 'pending', 'the rival changed nothing');
  });

  it('rejects a guest token on the staff endpoints', async () => {
    const order = await webOrder();
    const guest = jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request(`/api/online-orders?branch=${BRANCH()}`, {token: guest})).status, 403);
    assert.equal((await request(`/api/online-orders/${order._id}/accept`, {
      method: 'POST', token: guest, body: {}
    })).status, 403);
  });
});
