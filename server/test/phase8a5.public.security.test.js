import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {Audit, Coupon, CouponRedemption, Ingredient, MenuItem, User} from '../src/models/index.js';
import {
  Branch, Customer, InventoryBalance, InventoryTransaction, Order, Payment, Restaurant
} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {daysAgo, daysAhead} from './dates.js';

// Phase 8A.5 — security hardening of the public ordering surface.
//
// Every test here is an attack. The public endpoints are the only path an
// anonymous caller has into the system, so each control is probed directly
// rather than assumed from the frontend.

let world;
let baseUrl;

before(async () => { ({baseUrl} = await startTestApp()); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

const BRANCH = () => String(world.branchA._id);
const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

function cart(overrides = {}) {
  return {
    branch: BRANCH(),
    type: 'takeaway',
    items: [{menuItem: String(world.menu._id), qty: 1}],
    customer: {name: 'Test Guest', phone: '9800000001'},
    paymentMethod: 'cod',
    ...overrides
  };
}
const place = (body, headers = {}) =>
  request('/api/public/orders', {method: 'POST', body, headers});
const quote = body => request('/api/public/quote', {method: 'POST', body});

/** Drains stock through the ledger so batch and balance stay consistent. */
async function drainStockTo(grams) {
  const {moveStock} = await import('../src/services/inventoryLedger.js');
  const balance = await InventoryBalance.findOne({
    branch: world.branchA._id, ingredient: world.ingredient._id
  });
  const remove = Number(balance.quantity) - grams;
  if (remove <= 0) return;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(() => moveStock({
      branch: world.branchA._id, ingredient: world.ingredient._id,
      qty: -remove, unit: 'g', type: 'WASTE', wasteCategory: 'other',
      reason: 'stock drain for security test', referenceType: 'test',
      referenceId: world.ingredient._id, user: world.owner._id,
      idempotencyKey: `drain-${Date.now()}-${Math.random()}`
    }, session));
  } finally {
    await session.endSession();
  }
}

// ── 1. Sensitive data exposure ───────────────────────────────────────────────
describe('8A.5 §1 — public endpoints expose only what a guest needs', () => {
  it('never leaks costs, suppliers, stock, staff or internals', async () => {
    const menu = await request(`/api/public/menu?branch=${BRANCH()}`);
    const branches = await request('/api/public/branches');
    const raw = JSON.stringify(menu.body) + JSON.stringify(branches.body);
    for (const secret of [
      'foodCost', 'recipeCost', 'packagingCost', 'margin', 'grossMargin',
      'recipe', 'ingredient', 'supplier', 'station', 'prepMinutes',
      'quantity', 'averageCost', 'createdBy', 'updatedBy',
      'password', 'token', 'JWT_SECRET', 'restaurantId'
    ]) {
      assert.ok(!raw.includes(secret), `public payload leaked "${secret}"`);
    }
  });

  it('does not expose inventory levels even when nearly out of stock', async () => {
    await drainStockTo(250);
    const menu = await request(`/api/public/menu?branch=${BRANCH()}`);
    assert.ok(!JSON.stringify(menu.body).match(/quantity|stock|onHand/i));
  });

  it('keeps the authenticated API closed to anonymous callers', async () => {
    // Only paths the test harness mounts; /api/audit lives in index.js.
    for (const path of [
      '/api/orders', '/api/customers',
      `/api/kitchen/board?branch=${BRANCH()}`,
      `/api/inventory?branch=${BRANCH()}`,
      `/api/online-orders?branch=${BRANCH()}`,
      `/api/reports/pnl?branch=${BRANCH()}`
    ]) {
      assert.equal((await request(path)).status, 401, `${path} must require auth`);
    }
  });
});

// ── 2. Price integrity ───────────────────────────────────────────────────────
describe('8A.5 §2 — the client cannot dictate money', () => {
  it('rejects injected price, total, discount, VAT and delivery fields', async () => {
    const attacks = [
      {items: [{menuItem: String(world.menu._id), qty: 1, unitPrice: 1}]},
      {items: [{menuItem: String(world.menu._id), qty: 1, price: 1}]},
      {total: 1}, {subtotal: 1}, {discount: 500}, {vat: 0}, {vatRate: 0}, {deliveryFee: -50}
    ];
    for (const attack of attacks) {
      const res = await place(cart(attack));
      assert.equal(res.status, 400, `injected ${Object.keys(attack)[0]} was accepted`);
    }
  });

  it('prices from the database, not the request', async () => {
    const res = await place(cart());
    const stored = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(stored.subtotal, 350);
    assert.equal(stored.vat, 45.5);
    assert.equal(stored.total, 395.5);
  });

  it('recomputes VAT after a legitimate discount', async () => {
    await request('/api/coupons', {
      method: 'POST', token: owner(), body: {code: 'TEN', kind: 'percentage', value: 10}
    });
    const res = await place(cart({coupon: 'TEN'}));
    const stored = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(stored.couponDiscount, 35);
    assert.equal(stored.vat, 40.95, 'VAT follows the discounted base');
    assert.equal(stored.total, 355.95);
  });
});

// ── 3. Menu, modifier and variant integrity ──────────────────────────────────
describe('8A.5 §3 — menu and modifier integrity', () => {
  async function rivalItem() {
    const restaurant = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const ingredient = await Ingredient.create({
      restaurant: restaurant._id, code: 'RIV', name: 'Rival Ingredient', unit: 'g'
    });
    return MenuItem.create({
      restaurant: restaurant._id, name: 'Rival Dish', price: 99, vatInclusive: false,
      recipe: [{ingredient: ingredient._id, qty: 10, unit: 'g'}]
    });
  }

  it('refuses unknown, inactive and cross-restaurant items', async () => {
    assert.equal((await place(cart({
      items: [{menuItem: String(new mongoose.Types.ObjectId()), qty: 1}]
    }))).status, 404);

    const foreign = await rivalItem();
    const cross = await place(cart({items: [{menuItem: String(foreign._id), qty: 1}]}));
    assert.equal(cross.status, 404);
    // Control: our own item succeeds, so the refusal above is the tenant guard.
    assert.equal((await place(cart())).status, 201);

    await MenuItem.updateOne({_id: world.menu._id}, {$set: {active: false}});
    assert.equal((await place(cart({
      customer: {name: 'Second Guest', phone: '9800000002'}
    }))).status, 404);
  });

  it('rejects invented modifiers and modifier prices', async () => {
    const item = await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Momo', price: 300, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}],
      modifierGroups: [{
        key: 'size', name: 'Size', kind: 'variant', selection: 'single', required: true,
        options: [{key: 'reg', name: 'Regular'}, {key: 'lg', name: 'Large', priceOverride: 400}]
      }]
    });
    // Unknown group / option.
    assert.equal((await place(cart({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'ghost', option: 'x'}]}]
    }))).status, 400);
    assert.equal((await place(cart({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'huge'}]}]
    }))).status, 400);
    // A required group cannot be skipped.
    assert.equal((await place(cart({
      items: [{menuItem: String(item._id), qty: 1}]
    }))).status, 400);
    // A price cannot be smuggled into a modifier selection.
    assert.equal((await place(cart({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'lg', priceDelta: -300}]}]
    }))).status, 400);
    // The honest path uses the catalog's override.
    const ok = await place(cart({
      items: [{menuItem: String(item._id), qty: 1, modifiers: [{group: 'size', option: 'lg'}]}]
    }));
    assert.equal(ok.status, 201, ok.body?.message);
    assert.equal((await Order.findOne({orderNo: ok.body.orderNo})).subtotal, 400);
  });

  it('bounds quantities', async () => {
    for (const qty of [0, -5, 1.5, 21, 1e9]) {
      assert.equal((await place(cart({items: [{menuItem: String(world.menu._id), qty}]}))).status, 400);
    }
  });
});

// ── 4. Coupon integrity ──────────────────────────────────────────────────────
describe('8A.5 §4 — coupons cannot be abused from the storefront', () => {
  const makeCoupon = body => request('/api/coupons', {method: 'POST', token: owner(), body});

  it('rejects unknown, inactive and expired codes', async () => {
    assert.equal((await place(cart({coupon: 'NOSUCH'}))).status, 404);

    const dead = await makeCoupon({code: 'DEAD', kind: 'fixed', value: 50});
    await request(`/api/coupons/${dead.body._id}`, {method: 'DELETE', token: owner()});
    assert.equal((await place(cart({coupon: 'DEAD'}))).status, 409);

    await makeCoupon({code: 'EXPIRED', kind: 'fixed', value: 50, endsAt: daysAgo(1)});
    assert.equal((await place(cart({coupon: 'EXPIRED'}))).status, 409);

    await makeCoupon({code: 'FUTURE', kind: 'fixed', value: 50, startsAt: daysAhead(3)});
    assert.equal((await place(cart({coupon: 'FUTURE'}))).status, 409);
  });

  it('enforces branch and menu-item scope', async () => {
    await makeCoupon({code: 'OTHERBRANCH', kind: 'fixed', value: 50, branches: [String(world.branchB._id)]});
    assert.equal((await place(cart({coupon: 'OTHERBRANCH'}))).status, 409);

    const other = await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Unrelated', price: 100, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 10, unit: 'g'}]
    });
    await makeCoupon({code: 'ONLYOTHER', kind: 'percentage', value: 50, menuItems: [String(other._id)]});
    assert.equal((await place(cart({coupon: 'ONLYOTHER'}))).status, 409);
  });

  it('enforces minimum spend and the maximum discount cap', async () => {
    await makeCoupon({code: 'BIGSPEND', kind: 'fixed', value: 100, minOrderAmount: 5000});
    assert.equal((await place(cart({coupon: 'BIGSPEND'}))).status, 409);

    await makeCoupon({code: 'CAPPED', kind: 'percentage', value: 90, maxDiscount: 20});
    const res = await place(cart({coupon: 'CAPPED'}));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal((await Order.findOne({orderNo: res.body.orderNo})).couponDiscount, 20);
  });

  it('enforces the total usage limit across public orders', async () => {
    await makeCoupon({code: 'ONCE', kind: 'fixed', value: 50, usageLimit: 1});
    assert.equal((await place(cart({coupon: 'ONCE'}))).status, 201);
    const second = await place(cart({
      coupon: 'ONCE', customer: {name: 'Second Guest', phone: '9800000002'}
    }));
    assert.equal(second.status, 409, 'the usage limit must hold for anonymous guests');
    assert.equal(await CouponRedemption.countDocuments({}), 1);
  });

  it('records exactly one redemption per order', async () => {
    await makeCoupon({code: 'TRACKED', kind: 'fixed', value: 20});
    const res = await place(cart({coupon: 'TRACKED'}), {'Idempotency-Key': 'coupon-key'});
    assert.equal(res.status, 201, res.body?.message);
    // A replayed request must not redeem twice.
    await place(cart({coupon: 'TRACKED'}), {'Idempotency-Key': 'coupon-key'});
    assert.equal(await CouponRedemption.countDocuments({}), 1);
  });
});

// ── 5. Tenant isolation ──────────────────────────────────────────────────────
describe('8A.5 §5 — branch and restaurant isolation', () => {
  it('scopes the menu to the requested branch only', async () => {
    const menuA = await request(`/api/public/menu?branch=${BRANCH()}`);
    assert.equal(menuA.body.branch.name, 'Kathmandu Branch');

    const rival = await Restaurant.create({name: 'Rival Co', currency: 'NPR', vatRate: 13});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVL'});
    const rivalIngredient = await Ingredient.create({
      restaurant: rival._id, code: 'RIV', name: 'Rival Ingredient', unit: 'g'
    });
    await MenuItem.create({
      restaurant: rival._id, name: 'Secret Rival Dish', price: 99, vatInclusive: false,
      recipe: [{ingredient: rivalIngredient._id, qty: 10, unit: 'g'}]
    });
    const rivalMenu = await request(`/api/public/menu?branch=${rivalBranch._id}`);
    assert.ok(!JSON.stringify(menuA.body).includes('Secret Rival Dish'));
    assert.ok(!JSON.stringify(rivalMenu.body).includes('Chicken Biryani'));
  });

  it('refuses an inactive or unknown branch', async () => {
    await Branch.updateOne({_id: world.branchB._id}, {$set: {active: false}});
    assert.equal((await request(`/api/public/menu?branch=${world.branchB._id}`)).status, 404);
    assert.equal((await request(`/api/public/menu?branch=${new mongoose.Types.ObjectId()}`)).status, 404);
    assert.equal((await request('/api/public/menu?branch=nonsense')).status, 400);
  });
});

// ── 6 & 7. Order and customer privacy ────────────────────────────────────────
describe('8A.5 §6/§7 — orders and customers are not enumerable', () => {
  it('does not let one guest read another guest order', async () => {
    const victim = await place(cart({customer: {name: 'Victim Guest', phone: '9811111111'}}));
    const attacker = await place(cart({customer: {name: 'Attacker Guest', phone: '9822222222'}}));

    // Right number, wrong phone: same answer as a wrong number.
    const stolen = await request(
      `/api/public/orders/track?orderNo=${victim.body.orderNo}&phone=9822222222`
    );
    assert.equal(stolen.status, 404);
    const own = await request(
      `/api/public/orders/track?orderNo=${attacker.body.orderNo}&phone=9822222222`
    );
    assert.equal(own.status, 200);
  });

  it('requires both the reference and the phone', async () => {
    const res = await place(cart({customer: {name: 'Solo Guest', phone: '9833333333'}}));
    assert.equal((await request(`/api/public/orders/track?orderNo=${res.body.orderNo}`)).status, 400);
    assert.equal((await request('/api/public/orders/track?phone=9833333333')).status, 400);
    assert.equal((await request(
      `/api/public/orders/track?orderNo=WEB-0000000&phone=9833333333`
    )).status, 404);
  });

  it('exposes no internal fields on a tracked order', async () => {
    const res = await place(cart({customer: {name: 'Tracked Guest', phone: '9844444444'}}));
    const tracked = await request(
      `/api/public/orders/track?orderNo=${res.body.orderNo}&phone=9844444444`
    );
    const raw = JSON.stringify(tracked.body);
    for (const secret of ['foodCost', 'station', 'inventoryRequirements', 'branch', 'createdBy', '_id']) {
      assert.ok(!raw.includes(secret), `tracking leaked "${secret}"`);
    }
  });

  it('does not let a guest enumerate customers', async () => {
    await Customer.create({branch: world.branchA._id, name: 'Private Person', phone: '9855555555'});
    assert.equal((await request(`/api/customers?branch=${BRANCH()}`)).status, 401);
    // Ordering under a known phone must not echo that customer's details back.
    const res = await place(cart({customer: {name: 'Impersonator', phone: '9855555555'}}));
    assert.ok(!JSON.stringify(res.body).includes('Private Person'));
  });
});

// ── 8. Rate limiting ─────────────────────────────────────────────────────────
describe('8A.5 §8 — rate limits protect every public write', () => {
  it('caps ordering hardest and still limits browsing', async () => {
    const {PUBLIC_RATE_LIMITS} = await import('../src/routes/storefront.js');
    assert.ok(PUBLIC_RATE_LIMITS.order.max < PUBLIC_RATE_LIMITS.quote.max);
    assert.ok(PUBLIC_RATE_LIMITS.quote.max < PUBLIC_RATE_LIMITS.browse.max);
    for (const key of ['browse', 'quote', 'order', 'track']) {
      assert.ok(PUBLIC_RATE_LIMITS[key].max > 0, `${key} must be limited`);
      assert.ok(PUBLIC_RATE_LIMITS[key].windowMs > 0);
    }
  });

  it('actually refuses a flood', async () => {
    const express = (await import('express')).default;
    const rateLimit = (await import('express-rate-limit')).default;
    const http = await import('node:http');
    const {PUBLIC_RATE_LIMITS} = await import('../src/routes/storefront.js');

    const app = express();
    app.use(express.json());
    app.post('/x', rateLimit({...PUBLIC_RATE_LIMITS.order, standardHeaders: true, legacyHeaders: false}),
      (_req, res) => res.status(201).json({ok: true}));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const {port} = server.address();
      const statuses = [];
      for (let i = 0; i <= PUBLIC_RATE_LIMITS.order.max; i += 1) {
        statuses.push((await fetch(`http://127.0.0.1:${port}/x`, {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'
        })).status);
      }
      assert.equal(statuses.filter(s => s === 201).length, PUBLIC_RATE_LIMITS.order.max);
      assert.equal(statuses.at(-1), 429);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});

// ── 9. Idempotency ───────────────────────────────────────────────────────────
describe('8A.5 §9 — a retry never buys twice', () => {
  it('returns the same order for a repeated key', async () => {
    const first = await place(cart(), {'Idempotency-Key': 'checkout-1'});
    assert.equal(first.status, 201, first.body?.message);
    const replay = await place(cart(), {'Idempotency-Key': 'checkout-1'});
    assert.equal(replay.status, 200);
    assert.equal(replay.body.orderNo, first.body.orderNo);
    assert.equal(replay.body.replayed, true);
    assert.equal(await Order.countDocuments({source: 'online'}), 1);
  });

  it('survives a genuine double-click race', async () => {
    const body = cart({customer: {name: 'Fast Clicker', phone: '9866666666'}});
    const [a, b] = await Promise.all([
      place(body, {'Idempotency-Key': 'race-1'}),
      place(body, {'Idempotency-Key': 'race-1'})
    ]);
    assert.equal(await Order.countDocuments({source: 'online'}), 1, 'exactly one order');
    assert.equal(a.body.orderNo, b.body.orderNo, 'both callers see the same order');
    assert.ok([200, 201].includes(a.status) && [200, 201].includes(b.status));
  });

  it('creates exactly one payment intent on replay', async () => {
    const body = cart({paymentMethod: 'esewa', customer: {name: 'Wallet Guest', phone: '9877777777'}});
    await place(body, {'Idempotency-Key': 'pay-1'});
    await place(body, {'Idempotency-Key': 'pay-1'});
    assert.equal(await Payment.countDocuments({}), 1);
  });

  it('treats distinct keys as distinct orders', async () => {
    await place(cart(), {'Idempotency-Key': 'a'});
    await place(cart(), {'Idempotency-Key': 'b'});
    assert.equal(await Order.countDocuments({source: 'online'}), 2);
  });
});

// ── 10. Inventory safety ─────────────────────────────────────────────────────
describe('8A.5 §10 — stock can never go negative', () => {
  it('refuses an order the branch cannot cook', async () => {
    await drainStockTo(250);
    const ok = await place(cart({items: [{menuItem: String(world.menu._id), qty: 1}]}));
    assert.equal(ok.status, 201, 'one plate is affordable');
    const tooMany = await place(cart({
      items: [{menuItem: String(world.menu._id), qty: 10}],
      customer: {name: 'Hungry Guest', phone: '9888888888'}
    }));
    assert.equal(tooMany.status, 409);
    assert.match(tooMany.body.message, /out of stock/i);
    assert.ok(!/\d+\s*g\b/.test(tooMany.body.message), 'must not reveal exact stock levels');
  });

  it('deducts exactly once on acceptance', async () => {
    const res = await place(cart());
    const order = await Order.findOne({orderNo: res.body.orderNo});
    const before = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;

    const accept = () => request(`/api/online-orders/${order._id}/accept`, {
      method: 'POST', token: staff(), body: {}
    });
    assert.equal((await accept()).status, 200);
    assert.equal((await accept()).status, 409, 'a second accept is refused');

    const after = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.equal(before - after, 250, 'exactly one plate of stock left');
    assert.equal(await InventoryTransaction.countDocuments({
      type: 'RECIPE_DEDUCTION', referenceId: order._id
    }), 1);
  });

  it('does not oversell when several pending orders are accepted', async () => {
    await drainStockTo(750); // three plates
    const placed = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await place(cart({customer: {name: `Queue Guest ${i}`, phone: `981000000${i}`}}));
      if (res.status === 201) placed.push(res.body.orderNo);
    }
    const orders = await Order.find({source: 'online'});
    const results = await Promise.all(orders.map(o =>
      request(`/api/online-orders/${o._id}/accept`, {method: 'POST', token: staff(), body: {}})
    ));
    const accepted = results.filter(r => r.status === 200).length;
    const refused = results.filter(r => r.status === 409).length;
    assert.equal(accepted, 3, 'only what the kitchen can cook');
    assert.equal(refused, orders.length - 3);

    const remaining = (await InventoryBalance.findOne({
      branch: world.branchA._id, ingredient: world.ingredient._id
    })).quantity;
    assert.ok(remaining >= 0, `stock went negative: ${remaining}`);
    assert.equal(remaining, 0);
  });

  it('moves no stock when an order is rejected', async () => {
    const res = await place(cart());
    const order = await Order.findOne({orderNo: res.body.orderNo});
    const before = await InventoryTransaction.countDocuments({});
    const rejected = await request(`/api/online-orders/${order._id}/reject`, {
      method: 'POST', token: manager(), body: {reason: 'closed'}
    });
    assert.equal(rejected.status, 200);
    assert.equal(await InventoryTransaction.countDocuments({}), before);
  });
});

// ── 11. Payment honesty ──────────────────────────────────────────────────────
describe('8A.5 §11 — payment state is never faked', () => {
  it('records COD as owed, not paid', async () => {
    const res = await place(cart({paymentMethod: 'cod'}));
    assert.equal(res.body.paymentStatus, 'due_on_delivery');
    const order = await Order.findOne({orderNo: res.body.orderNo});
    assert.equal(order.paidAmount, 0);
    assert.equal(order.dueAmount, order.total);
  });

  it('records a wallet intent as pending with no transaction id', async () => {
    // Phase 8B refuses a gateway the deployment has no credentials for, so
    // both must be configured for this Phase 8A behaviour to be reachable.
    // (The refusal itself is covered in phase8b.online.payments.test.js.)
    const savedKhalti = process.env.KHALTI_SECRET_KEY;
    process.env.KHALTI_SECRET_KEY = 'test_secret_key_for_suite';
    try {
    for (const method of ['esewa', 'khalti']) {
      const res = await place(cart({
        paymentMethod: method, customer: {name: 'Wallet Guest', phone: `98999999${method.length}`}
      }));
      assert.equal(res.body.paymentStatus, 'awaiting_payment');
      const order = await Order.findOne({orderNo: res.body.orderNo});
      const payment = await Payment.findOne({order: order._id});
      assert.equal(payment.status, 'pending', 'never "paid" without a gateway');
      assert.equal(payment.method, method);
      assert.ok(!payment.transactionId, 'no fabricated transaction id');
      assert.equal(order.paidAmount, 0, 'no money is claimed');
    }
    } finally {
      if (savedKhalti === undefined) delete process.env.KHALTI_SECRET_KEY;
      else process.env.KHALTI_SECRET_KEY = savedKhalti;
    }
  });

  it('rejects an unsupported payment method', async () => {
    assert.equal((await place(cart({paymentMethod: 'crypto'}))).status, 400);
    assert.equal((await place(cart({paymentMethod: 'wallet'}))).status, 400);
  });
});

// ── 12. Error safety ─────────────────────────────────────────────────────────
describe('8A.5 §12 — errors say enough and no more', () => {
  it('never returns raw validation, database or stack detail', async () => {
    const cases = [
      cart({customer: {name: 'X', phone: '1'}}),
      cart({items: [{menuItem: 'not-an-id', qty: 1}]}),
      cart({branch: 'nonsense'}),
      cart({type: 'dine-in'}),
      {}
    ];
    for (const body of cases) {
      const res = await place(body);
      const message = String(res.body?.message ?? '');
      assert.ok(message.length > 0 && message.length <= 200, `unhelpful or oversized: ${message}`);
      for (const leak of ['"code"', 'ZodError', 'MongoServerError', 'at Object.', '/home/', 'node_modules', 'E11000']) {
        assert.ok(!message.includes(leak), `error leaked "${leak}": ${message}`);
      }
      assert.ok(!res.body?.stack, 'no stack trace');
    }
  });

  it('still returns a useful message', async () => {
    const res = await place(cart({customer: {name: 'X', phone: '9800000001'}}));
    assert.match(res.body.message, /customer|name|invalid|missing/i);
  });
});

// ── 13. HTTP hardening ───────────────────────────────────────────────────────
describe('8A.5 §13 — public responses carry safe headers', () => {
  it('marks public responses no-store and non-embeddable', async () => {
    const res = await fetch(`${baseUrl}/api/public/menu?branch=${BRANCH()}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /no-store/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  });

  it('requires an explicit CLIENT_URL in production', async () => {
    const {validateRuntimeEnvironment} = await import('../src/services/startup.js');
    assert.throws(
      () => validateRuntimeEnvironment({
        NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40),
        MONGODB_URI: 'mongodb://localhost:27017/x', CLIENT_URL: ''
      }),
      /CLIENT_URL is required in production/
    );
    assert.throws(
      () => validateRuntimeEnvironment({
        NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40),
        MONGODB_URI: 'mongodb://localhost:27017/x', CLIENT_URL: '*'
      }),
      /explicit HTTP\(S\) origins/
    );
  });
});
