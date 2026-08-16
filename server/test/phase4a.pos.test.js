import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {MenuItem} from '../src/models/index.js';
import {Customer, Order} from '../src/models/operations.js';
import {
  ORDER_TYPES,
  assertTypeRules,
  computeOrderTotals,
  normalizeOrderType,
  priceLine,
  priceOrder
} from '../src/services/pos.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => { await clearDb(); world = await seedWorld(); });

function post(body, user = world.owner) {
  return request('/api/orders', {method: 'POST', token: tokenFor(user), body});
}

function base(extra = {}) {
  return {
    branch: String(world.branchA._id),
    items: [{menuItem: String(world.menu._id), qty: 1}],
    ...extra
  };
}

async function customer() {
  return Customer.create({branch: world.branchA._id, name: 'Sita Rai', phone: '9800000001'});
}

describe('Phase 4A — POS pricing engine', () => {
  it('exposes exactly the four POS channels', () => {
    assert.deepEqual(ORDER_TYPES, ['dine-in', 'takeaway', 'counter', 'delivery']);
    assert.equal(normalizeOrderType('DINE-IN'), 'dine-in');
    assert.equal(normalizeOrderType(undefined), 'counter');
    assert.throws(() => normalizeOrderType('online'), /Order type must be one of/);
  });

  it('adds VAT on top of a VAT-exclusive price', () => {
    const line = priceLine({unitPrice: 100, qty: 2, vatInclusive: false, vatRate: 13});
    assert.equal(line.lineNet, 200);
    assert.equal(line.lineVat, 26);
    assert.equal(line.lineGross, 226);
  });

  it('extracts VAT from within a VAT-inclusive price', () => {
    const line = priceLine({unitPrice: 350, qty: 1, vatInclusive: true, vatRate: 13});
    // The guest still pays exactly the menu price.
    assert.equal(line.lineGross, 350);
    assert.equal(line.lineNet, 309.73);
    assert.equal(line.lineVat, 40.27);
    assert.equal(line.lineNet + line.lineVat, 350);
  });

  it('rejects non-positive quantities and negative prices', () => {
    assert.throws(() => priceLine({unitPrice: 100, qty: 0}), /quantity must be greater than zero/);
    assert.throws(() => priceLine({unitPrice: 100, qty: -1}), /quantity must be greater than zero/);
    assert.throws(() => priceLine({unitPrice: -5, qty: 1}), /non-negative/);
  });

  it('taxes the service charge and leaves the delivery fee untaxed', () => {
    const lines = [priceLine({unitPrice: 1000, qty: 1, vatInclusive: false})];
    const svc = computeOrderTotals({lines, serviceChargeRate: 10, vatRate: 13});
    assert.equal(svc.serviceCharge, 100);
    assert.equal(svc.vat, 143); // 13% of (1000 + 100)
    assert.equal(svc.total, 1243);

    const fee = computeOrderTotals({lines, deliveryFee: 120, vatRate: 13});
    assert.equal(fee.vat, 130); // fee is not taxed
    assert.equal(fee.total, 1250);
  });

  it('removes tax along with a discount and refuses to over-discount', () => {
    const lines = [priceLine({unitPrice: 1000, qty: 1, vatInclusive: false})];
    const totals = computeOrderTotals({lines, discount: 200, vatRate: 13});
    assert.equal(totals.subtotal, 1000);
    assert.equal(totals.discount, 200);
    assert.equal(totals.vat, 104); // 13% of 800
    assert.equal(totals.total, 904);
    assert.throws(() => computeOrderTotals({lines, discount: 1500}), /cannot exceed/);
  });

  it('enforces the channel rules for every type', () => {
    assert.equal(assertTypeRules({type: 'dine-in', table: 't'}), 'dine-in');
    assert.throws(() => assertTypeRules({type: 'dine-in'}), /require a table/);
    assert.throws(() => assertTypeRules({type: 'takeaway', table: 't'}), /cannot be assigned a table/);
    assert.throws(() => assertTypeRules({type: 'counter', table: 't'}), /cannot be assigned a table/);
    assert.throws(() => assertTypeRules({type: 'delivery', table: 't'}), /cannot be assigned a table/);
    assert.throws(() => assertTypeRules({type: 'delivery'}), /require a customer/);
    assert.throws(() => assertTypeRules({type: 'delivery', customer: 'c'}), /require a delivery address/);
    assert.equal(assertTypeRules({type: 'delivery', customer: 'c', deliveryAddress: 'Patan'}), 'delivery');
    assert.throws(() => assertTypeRules({type: 'counter', deliveryAddress: 'Patan'}), /Only delivery orders/);
  });

  it('applies the 10% service charge to dine-in only', () => {
    const dine = priceOrder({type: 'dine-in', table: 't', items: [{unitPrice: 1000, qty: 1, vatInclusive: false}]});
    assert.equal(dine.serviceChargeRate, 10);
    assert.equal(dine.serviceCharge, 100);
    for (const type of ['takeaway', 'counter']) {
      const other = priceOrder({type, items: [{unitPrice: 1000, qty: 1, vatInclusive: false}]});
      assert.equal(other.serviceCharge, 0, type);
    }
    // A caller may waive the dine-in charge, but cannot invent one elsewhere.
    assert.equal(priceOrder({type: 'dine-in', table: 't', serviceChargeRate: 0, items: [{unitPrice: 100, qty: 1}]}).serviceCharge, 0);
    assert.throws(() => priceOrder({type: 'takeaway', serviceChargeRate: 10, items: [{unitPrice: 100, qty: 1}]}), /do not carry a service charge/);
    assert.throws(() => priceOrder({type: 'counter', deliveryFee: 50, items: [{unitPrice: 100, qty: 1}]}), /cannot carry a delivery fee/);
  });
});

describe('Phase 4A — POST /api/orders across the four channels', () => {
  it('creates a dine-in order with a table, service charge and VAT', async () => {
    const res = await post(base({type: 'dine-in', table: String(world.table._id), items: [{menuItem: String(world.menu._id), qty: 2}]}));
    assert.equal(res.status, 201, res.body?.message);
    const o = res.body;
    assert.equal(o.type, 'dine-in');
    assert.equal(o.subtotal, 700);
    assert.equal(o.serviceChargeRate, 10);
    assert.equal(o.serviceCharge, 70);
    assert.equal(o.vat, 100.1); // 13% of (700 + 70)
    assert.equal(o.total, 870.1);
    assert.equal(o.dueAmount, 870.1);
    // Line-level tax breakdown is persisted.
    assert.equal(o.items[0].qty, 2);
    assert.equal(o.items[0].unitPrice, 350);
    assert.equal(o.items[0].lineNet, 700);
    assert.equal(o.items[0].lineVat, 91);
    assert.equal(o.items[0].lineTotal, 791);
  });

  it('creates takeaway and counter orders with no table and no service charge', async () => {
    for (const type of ['takeaway', 'counter']) {
      const res = await post(base({type}));
      assert.equal(res.status, 201, res.body?.message);
      assert.equal(res.body.type, type);
      assert.equal(res.body.serviceCharge, 0);
      assert.equal(res.body.subtotal, 350);
      assert.equal(res.body.vat, 45.5);
      assert.equal(res.body.total, 395.5);
      assert.ok(!res.body.table);
    }
  });

  it('creates a delivery order with a customer, address and untaxed fee', async () => {
    const c = await customer();
    const res = await post(base({type: 'delivery', customer: String(c._id), deliveryAddress: 'Jhamsikhel, Lalitpur', deliveryFee: 120}));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.type, 'delivery');
    assert.equal(res.body.deliveryAddress, 'Jhamsikhel, Lalitpur');
    assert.equal(res.body.deliveryFee, 120);
    assert.equal(res.body.serviceCharge, 0);
    assert.equal(res.body.vat, 45.5); // fee excluded from VAT
    assert.equal(res.body.total, 515.5); // 350 + 45.5 + 120
  });

  it('defaults to a counter order when no type is supplied', async () => {
    const res = await post(base());
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.type, 'counter');
  });

  it('rejects invalid channel combinations', async () => {
    assert.equal((await post(base({type: 'dine-in'}))).status, 400);
    assert.equal((await post(base({type: 'takeaway', table: String(world.table._id)}))).status, 400);
    assert.equal((await post(base({type: 'delivery'}))).status, 400);
    const c = await customer();
    assert.equal((await post(base({type: 'delivery', customer: String(c._id)}))).status, 400);
    assert.equal((await post(base({type: 'counter', deliveryAddress: 'Nowhere'}))).status, 400);
    // Types outside the POS core are refused.
    assert.equal((await post(base({type: 'online'}))).status, 400);
    assert.equal((await post(base({type: 'pickup'}))).status, 400);
  });

  it('honours a VAT-inclusive menu price so the guest pays the listed amount', async () => {
    const inclusive = await MenuItem.create({
      name: 'Inclusive Momo',
      price: 350,
      vatInclusive: true,
      recipe: [{ingredient: world.ingredient._id, qty: 100, unit: 'g'}]
    });
    const res = await post(base({type: 'counter', items: [{menuItem: String(inclusive._id), qty: 1}]}));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.total, 350);
    assert.equal(res.body.subtotal, 309.73);
    assert.equal(res.body.vat, 40.27);
    assert.equal(res.body.items[0].vatInclusive, true);
  });

  it('prices mixed quantities and multiple lines', async () => {
    const second = await MenuItem.create({
      name: 'Side Salad',
      price: 120,
      vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 50, unit: 'g'}]
    });
    const res = await post(base({
      type: 'counter',
      items: [
        {menuItem: String(world.menu._id), qty: 3},
        {menuItem: String(second._id), qty: 2}
      ]
    }));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.items.length, 2);
    assert.equal(res.body.subtotal, 1290); // 3x350 + 2x120
    assert.equal(res.body.vat, 167.7);
    assert.equal(res.body.total, 1457.7);
  });

  it('applies a discount before VAT', async () => {
    const res = await post(base({type: 'counter', items: [{menuItem: String(world.menu._id), qty: 2}], discount: 100}));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.subtotal, 700);
    assert.equal(res.body.discount, 100);
    assert.equal(res.body.vat, 78); // 13% of 600
    assert.equal(res.body.total, 678);
    // A discount larger than the order is refused.
    assert.equal((await post(base({type: 'counter', discount: 99999}))).status, 400);
  });

  it('honours a custom VAT rate and a zero-rated order', async () => {
    const zero = await post(base({type: 'counter', vatRate: 0}));
    assert.equal(zero.status, 201, zero.body?.message);
    assert.equal(zero.body.vat, 0);
    assert.equal(zero.body.total, 350);
  });

  it('validates quantities and item payloads', async () => {
    assert.equal((await post(base({items: [{menuItem: String(world.menu._id), qty: 0}]}))).status, 400);
    assert.equal((await post(base({items: [{menuItem: String(world.menu._id), qty: -2}]}))).status, 400);
    assert.equal((await post(base({items: []}))).status, 400);
    assert.equal((await post(base({items: [{menuItem: String(world.menu._id), qty: 1.5}]}))).status, 201);
  });

  it('still deducts recipe stock and keeps totals after a channel change', async () => {
    const res = await post(base({type: 'takeaway', items: [{menuItem: String(world.menu._id), qty: 2}]}));
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.inventoryDeducted, true);
    const stored = await Order.findById(res.body._id);
    assert.equal(stored.total, 791);
    assert.equal(stored.type, 'takeaway');
  });

  it('rejects unauthenticated and cross-branch order creation', async () => {
    assert.equal((await request('/api/orders', {method: 'POST', body: base({type: 'counter'})})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/orders', {method: 'POST', token: guest, body: base({type: 'counter'})})).status, 403);
    const crossBranch = {branch: String(world.branchB._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]};
    assert.equal((await post(crossBranch, world.staffA)).status, 403);
  });
});
