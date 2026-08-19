import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {MenuItem} from '../src/models/index.js';
import {Branch, Customer, Order, Restaurant} from '../src/models/operations.js';
import {buildReceipt, kathmanduStamp, renderReceiptHtml} from '../src/services/receipts.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  // Give the seller a PAN so the tax invoice header can be asserted.
  await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {pan: '301234567', receiptFooter: 'Wi-Fi: mittho-guest'}});
  await Branch.updateOne({_id: world.branchA._id}, {$set: {address: 'Kalanki, Kathmandu', phone: '01-4567890'}});
});

const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);

async function makeOrder(body = {}) {
  const res = await request('/api/orders', {
    method: 'POST',
    token: owner(),
    body: {
      branch: String(world.branchA._id),
      type: 'counter',
      items: [{menuItem: String(world.menu._id), qty: 2}],
      ...body
    }
  });
  assert.equal(res.status, 201, res.body?.message);
  return res.body;
}

const receipt = (id, query = '', token = owner()) =>
  request(`/api/orders/${id}/receipt${query}`, {token});

describe('Phase 4E — receipt document', () => {
  it('formats a Kathmandu timestamp', () => {
    const stamp = kathmanduStamp(new Date('2026-08-17T06:00:00.000Z'));
    // 06:00 UTC is 11:45 in Kathmandu (+05:45).
    assert.equal(stamp, '2026-08-17 11:45');
  });

  it('builds a receipt from stored order figures without re-pricing', () => {
    const built = buildReceipt({
      order: {
        _id: 'o1', orderNo: 'ORD-1', type: 'counter', status: 'completed',
        items: [{name: 'Momo', qty: 2, unitPrice: 100, lineNet: 200, lineVat: 26, lineTotal: 226, modifiers: []}],
        subtotal: 200, vat: 26, vatRate: 13, total: 226, paidAmount: 226, dueAmount: 0,
        createdAt: new Date(), updatedAt: new Date()
      },
      restaurant: {name: 'Mittho', currency: 'NPR', pan: '123'},
      branch: {name: 'KTM', code: 'KTM'},
      payments: [{_id: 'p1', amount: 226, method: 'cash', status: 'paid', createdAt: new Date()}]
    });
    assert.equal(built.document, 'receipt');
    assert.equal(built.seller.pan, '123');
    assert.equal(built.totals.total, 226);
    assert.equal(built.totals.taxableValue, 200);
    assert.equal(built.payment.tenders[0].method, 'cash');
    assert.equal(built.payment.settled, true);
  });

  it('escapes HTML so a crafted item name cannot inject markup', () => {
    const html = renderReceiptHtml(buildReceipt({
      order: {
        _id: 'o1', orderNo: 'ORD-1', type: 'counter', status: 'completed',
        items: [{name: '<script>alert(1)</script>', qty: 1, unitPrice: 10, lineNet: 10, lineVat: 0, lineTotal: 10, modifiers: []}],
        subtotal: 10, vat: 0, vatRate: 13, total: 10, paidAmount: 10, dueAmount: 0,
        createdAt: new Date(), updatedAt: new Date()
      },
      restaurant: {name: 'Mittho'}, branch: {name: 'KTM'}, payments: []
    }));
    assert.ok(!html.includes('<script>alert(1)</script>'), 'script tag must be escaped');
    assert.ok(html.includes('&lt;script&gt;'));
  });
});

describe('Phase 4E — GET /api/orders/:id/receipt', () => {
  it('returns order details, VAT and payment details', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total, method: 'esewa', transactionId: 'ESW-77'}
    });

    const res = await receipt(order._id);
    assert.equal(res.status, 200, res.body?.message);
    const body = res.body;

    // --- seller / order details ---
    assert.equal(body.seller.name, 'Mittho Test');
    assert.equal(body.seller.pan, '301234567');
    assert.equal(body.seller.address, 'Kalanki, Kathmandu');
    assert.equal(body.orderNo, order.orderNo);
    assert.equal(body.order.typeLabel, 'Counter');
    assert.equal(body.order.itemCount, 2);
    assert.equal(body.currency, 'NPR');

    // --- line + VAT breakdown ---
    assert.equal(body.lines.length, 1);
    assert.equal(body.lines[0].qty, 2);
    assert.equal(body.lines[0].unitPrice, 350);
    assert.equal(body.lines[0].lineNet, 700);
    assert.equal(body.lines[0].lineVat, 91);
    assert.equal(body.totals.subtotal, 700);
    assert.equal(body.totals.taxableValue, 700);
    assert.equal(body.totals.vatRate, 13);
    assert.equal(body.totals.vat, 91);
    assert.equal(body.totals.total, 791);

    // --- payment details ---
    assert.equal(body.payment.tenders.length, 1);
    assert.equal(body.payment.tenders[0].method, 'esewa');
    assert.equal(body.payment.tenders[0].transactionId, 'ESW-77');
    assert.equal(body.payment.paid, 791);
    assert.equal(body.payment.due, 0);
    assert.equal(body.payment.settled, true);
  });

  it('shows an unpaid balance before settlement', async () => {
    const order = await makeOrder();
    const res = await receipt(order._id);
    assert.equal(res.body.payment.settled, false);
    assert.equal(res.body.payment.due, 791);
    assert.equal(res.body.payment.tenders.length, 0);
  });

  it('itemises modifiers, instructions and discounts', async () => {
    const cheese = await MenuItem.create({
      restaurant: world.restaurant._id, name: 'Momo Set', price: 300, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 100, unit: 'g'}],
      modifierGroups: [{
        key: 'extras', name: 'Extras', kind: 'extra', selection: 'multi',
        options: [{key: 'spicy', name: 'Extra spicy', priceDelta: 30}]
      }]
    });
    const order = await makeOrder({
      items: [{
        menuItem: String(cheese._id), qty: 1,
        modifiers: [{group: 'extras', option: 'spicy'}],
        specialInstructions: 'No coriander',
        discount: {kind: 'fixed', value: 30, reason: 'Test discount'}
      }]
    });
    const res = await receipt(order._id);
    const line = res.body.lines[0];
    assert.equal(line.unitPrice, 330); // 300 + 30 modifier
    assert.equal(line.modifiers[0].name, 'Extra spicy');
    assert.equal(line.specialInstructions, 'No coriander');
    assert.equal(line.discount, 30);
    assert.equal(res.body.totals.itemDiscount, 30);
  });

  it('shows the dine-in service charge and a delivery fee', async () => {
    const dineIn = await makeOrder({type: 'dine-in', table: String(world.table._id)});
    const dineReceipt = await receipt(dineIn._id);
    assert.equal(dineReceipt.body.totals.serviceChargeRate, 10);
    assert.equal(dineReceipt.body.totals.serviceCharge, 70);
    assert.equal(dineReceipt.body.order.table, 'T1');

    const guest = await Customer.create({branch: world.branchA._id, name: 'Sita', phone: '9800000009'});
    const delivery = await makeOrder({
      type: 'delivery', customer: String(guest._id),
      deliveryAddress: 'Patan Dhoka', deliveryFee: 120
    });
    const deliveryReceipt = await receipt(delivery._id);
    assert.equal(deliveryReceipt.body.totals.deliveryFee, 120);
    assert.equal(deliveryReceipt.body.order.deliveryAddress, 'Patan Dhoka');
    assert.equal(deliveryReceipt.body.customer.name, 'Sita');
    // The fee is outside the taxable value.
    assert.equal(deliveryReceipt.body.totals.taxableValue, 700);
  });

  it('reports refunds on the receipt', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total, method: 'cash'}
    });
    await request(`/api/orders/${order._id}/refunds`, {
      method: 'POST', token: tokenFor(world.manager), body: {amount: 100, reason: 'Cold food'}
    });
    const res = await receipt(order._id);
    assert.equal(res.body.payment.refunded, 100);
    assert.equal(res.body.payment.refunds.length, 1);
    assert.equal(res.body.payment.refunds[0].reason, 'Cold food');
    assert.equal(res.body.payment.due, 100);
  });
});

describe('Phase 4E — tax invoice numbering', () => {
  it('allocates an invoice number on first issue and reuses it on reprint', async () => {
    const order = await makeOrder();
    const preview = await receipt(order._id);
    assert.equal(preview.body.invoiceNo, null, 'a preview must not consume a number');
    assert.equal(preview.body.document, 'receipt');

    const issued = await receipt(order._id, '?issue=true');
    assert.equal(issued.status, 200, issued.body?.message);
    assert.match(issued.body.invoiceNo, /^INV-KTM-\d{4}-000001$/);
    assert.equal(issued.body.document, 'tax_invoice');
    assert.equal(issued.body.printCount, 1);
    assert.equal(issued.body.reprint, false);

    const again = await receipt(order._id, '?issue=true');
    assert.equal(again.body.invoiceNo, issued.body.invoiceNo, 'reprint reuses the number');
    assert.equal(again.body.printCount, 2);
    assert.equal(again.body.reprint, true);
  });

  it('issues gapless sequential numbers per branch', async () => {
    const a = await makeOrder();
    const b = await makeOrder();
    const first = await receipt(a._id, '?issue=true');
    const second = await receipt(b._id, '?issue=true');
    const seq = n => Number(n.split('-').pop());
    assert.equal(seq(second.body.invoiceNo), seq(first.body.invoiceNo) + 1);

    // A different branch keeps its own sequence.
    const other = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchB._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    const otherReceipt = await receipt(other.body._id, '?issue=true');
    assert.match(otherReceipt.body.invoiceNo, /^INV-LTP-\d{4}-000001$/);
  });

  it('refuses to invoice a cancelled order', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/status`, {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'cancelled'}
    });
    const res = await receipt(order._id, '?issue=true');
    assert.equal(res.status, 409);
    // A read-only preview of a cancelled order is still allowed.
    assert.equal((await receipt(order._id)).status, 200);
  });

  it('keeps stored figures on a reprint after the menu price changes', async () => {
    const order = await makeOrder();
    const before = await receipt(order._id, '?issue=true');
    assert.equal(before.body.totals.total, 791);

    await MenuItem.updateOne({_id: world.menu._id}, {$set: {price: 999}});

    const after = await receipt(order._id, '?issue=true');
    assert.equal(after.body.totals.total, 791, 'a reprint must show what the guest was charged');
    assert.equal(after.body.lines[0].unitPrice, 350);
  });
});

describe('Phase 4E — printable HTML', () => {
  it('renders a self-contained thermal receipt', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total, method: 'khalti', transactionId: 'KHL-1'}
    });
    const res = await request(`/api/orders/${order._id}/receipt?format=html`, {token: owner()});
    assert.equal(res.status, 200);
    const html = String(res.body);

    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('TAX INVOICE'));
    assert.ok(html.includes('PAN: 301234567'));
    assert.ok(html.includes('Chicken Biryani'));
    assert.ok(html.includes('VAT 13%'));
    assert.ok(html.includes('791.00'));
    assert.ok(html.includes('KHALTI · KHL-1'));
    assert.ok(html.includes('Wi-Fi: mittho-guest'), 'receipt footer');
    assert.ok(html.includes('@page{size:80mm auto'), '80mm print stylesheet');

    // Must not depend on anything the printer cannot fetch.
    assert.ok(!/<img|<link|<script src=|@import|https?:\/\//.test(html), 'no external assets');
  });

  it('marks a reprint on the printed copy', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/receipt?format=html`, {token: owner()});
    const second = await request(`/api/orders/${order._id}/receipt?format=html`, {token: owner()});
    assert.ok(String(second.body).includes('REPRINT (2)'));
  });

  it('serves HTML rather than JSON', async () => {
    const order = await makeOrder();
    const html = await request(`/api/orders/${order._id}/receipt?format=html`, {token: owner()});
    assert.equal(html.status, 200);
    // The helper only returns a string when the body failed to parse as JSON,
    // so a string body proves this route did not serve JSON.
    assert.equal(typeof html.body, 'string');
    assert.ok(html.body.includes('<html'));

    const json = await request(`/api/orders/${order._id}/receipt`, {token: owner()});
    assert.equal(typeof json.body, 'object');
  });
});

describe('Phase 4E — receipt authorization', () => {
  it('requires authentication and rejects guests', async () => {
    const order = await makeOrder();
    assert.equal((await request(`/api/orders/${order._id}/receipt`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await receipt(order._id, '', guest)).status, 403);
  });

  it('stops staff reading another branch receipt', async () => {
    const other = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchB._id), type: 'counter', items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal((await receipt(other.body._id, '', staff())).status, 403);
  });

  it('returns 404 for an unknown order', async () => {
    const missing = new (await import('mongoose')).default.Types.ObjectId();
    assert.equal((await receipt(missing)).status, 404);
  });
});
