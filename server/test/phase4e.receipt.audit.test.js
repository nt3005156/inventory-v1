import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MenuItem} from '../src/models/index.js';
import {
  Branch,
  InventoryTransaction,
  Order,
  Payment,
  Restaurant,
  SalesInvoiceCounter
} from '../src/models/operations.js';
import {assertTaxConfig, resolveSellerPan, getReceipt, renderReceiptHtml, buildReceipt} from '../src/services/receipts.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {pan: '301234567'}});
});

const owner = () => tokenFor(world.owner);
const staff = () => tokenFor(world.staffA);

async function makeOrder(body = {}, branch = world.branchA) {
  const res = await request('/api/orders', {
    method: 'POST',
    token: owner(),
    body: {
      branch: String(branch._id),
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

// ── 1. Preview must be side-effect free ──────────────────────────────────────
describe('AUDIT 1 — preview does not allocate', () => {
  it('returns invoiceNo null and leaves the counter untouched', async () => {
    const order = await makeOrder();
    for (let i = 0; i < 3; i += 1) {
      const res = await receipt(order._id);
      assert.equal(res.status, 200, res.body?.message);
      assert.equal(res.body.invoiceNo, null);
      assert.equal(res.body.document, 'receipt');
    }
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0, 'no counter row may exist yet');
    const stored = await Order.findById(order._id);
    assert.equal(stored.invoiceNo, undefined);
    assert.equal(Number(stored.printCount || 0), 0);
    assert.equal(stored.invoicedAt, undefined);
  });

  it('does not increment printCount on preview', async () => {
    const order = await makeOrder();
    await receipt(order._id);
    await receipt(order._id);
    assert.equal(Number((await Order.findById(order._id)).printCount || 0), 0);
  });
});

// ── 2. First print allocates exactly one number ──────────────────────────────
describe('AUDIT 2 — first print allocates once', () => {
  it('stores the number permanently on the order', async () => {
    const order = await makeOrder();
    const res = await receipt(order._id, '?issue=true');
    assert.equal(res.status, 200, res.body?.message);
    assert.match(res.body.invoiceNo, /^INV-KTM-\d{4}-000001$/);

    const stored = await Order.findById(order._id);
    assert.equal(stored.invoiceNo, res.body.invoiceNo);
    assert.ok(stored.invoicedAt instanceof Date);
    assert.equal(stored.printCount, 1);
    const counter = await SalesInvoiceCounter.findOne({});
    assert.equal(counter.value, 1, 'exactly one number consumed');
  });

  it('survives concurrent prints without minting duplicates', async () => {
    const order = await makeOrder();
    const results = await Promise.all(
      Array.from({length: 5}, () => receipt(order._id, '?issue=true'))
    );
    const numbers = new Set(results.map(r => r.body?.invoiceNo).filter(Boolean));
    assert.equal(numbers.size, 1, `expected one number, saw ${[...numbers].join(' & ')}`);
    const counter = await SalesInvoiceCounter.findOne({});
    assert.equal(counter.value, 1, `counter burned ${counter.value} numbers for one order`);
    assert.equal((await Order.findById(order._id)).invoiceNo, [...numbers][0]);
  });

  it('holds under a forced read-modify-write interleaving', async () => {
    const order = await makeOrder();
    const run = async () => {
      const session = await mongoose.startSession();
      try {
        let out;
        await session.withTransaction(async () => {
          // Hold the read open so both transactions see invoiceNo unset.
          await getReceipt({orderId: order._id, user: world.owner, issue: false, session});
          await new Promise(r => setTimeout(r, 50));
          out = await getReceipt({orderId: order._id, user: world.owner, issue: true, session});
        });
        return out.invoiceNo;
      } finally {
        await session.endSession();
      }
    };
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a, b, 'concurrent issue produced different numbers');
    assert.equal((await SalesInvoiceCounter.findOne({})).value, 1);
  });
});

// ── 3. Reprint reuses and creates nothing ────────────────────────────────────
describe('AUDIT 3 — reprint is inert', () => {
  it('reuses the number and records REPRINT (n)', async () => {
    const order = await makeOrder();
    const first = await receipt(order._id, '?format=html');
    assert.ok(!String(first.body).includes('REPRINT'), 'first print is not a reprint');

    const second = await receipt(order._id, '?format=html');
    assert.ok(String(second.body).includes('REPRINT (2)'));
    const third = await receipt(order._id, '?format=html');
    assert.ok(String(third.body).includes('REPRINT (3)'));

    const stored = await Order.findById(order._id);
    assert.equal(stored.printCount, 3);
    assert.equal((await SalesInvoiceCounter.findOne({})).value, 1, 'only one number ever issued');
  });

  it('creates no extra order, payment or inventory movement', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(), body: {amount: order.total, method: 'cash'}
    });

    const before = {
      orders: await Order.countDocuments({}),
      payments: await Payment.countDocuments({}),
      stock: await InventoryTransaction.countDocuments({}),
      invoiced: await Order.countDocuments({invoiceNo: {$ne: null}})
    };

    await receipt(order._id, '?issue=true');
    await receipt(order._id, '?issue=true');
    await receipt(order._id, '?format=html');

    assert.equal(await Order.countDocuments({}), before.orders, 'no new order');
    assert.equal(await Payment.countDocuments({}), before.payments, 'no new payment');
    assert.equal(await InventoryTransaction.countDocuments({}), before.stock, 'no stock movement');
    assert.equal(await Order.countDocuments({invoiceNo: {$ne: null}}), before.invoiced + 1);

    // Money is untouched by printing.
    const stored = await Order.findById(order._id);
    assert.equal(stored.total, order.total);
    assert.equal(stored.paidAmount, order.total);
    assert.equal(stored.dueAmount, 0);
  });
});

// ── 4. Historical pricing is immutable ───────────────────────────────────────
describe('AUDIT 4 — historical pricing', () => {
  it('a menu price change does not alter an issued invoice', async () => {
    const order = await makeOrder();
    const issued = await receipt(order._id, '?issue=true');
    assert.equal(issued.body.totals.total, 791);
    assert.equal(issued.body.lines[0].unitPrice, 350);

    await MenuItem.updateOne({_id: world.menu._id}, {$set: {price: 5000}});

    const reprint = await receipt(order._id, '?issue=true');
    assert.equal(reprint.body.totals.total, 791);
    assert.equal(reprint.body.lines[0].unitPrice, 350);
    assert.equal(reprint.body.totals.vat, 91);
    assert.equal(reprint.body.invoiceNo, issued.body.invoiceNo);

    const html = await receipt(order._id, '?format=html');
    assert.ok(String(html.body).includes('791.00'));
    assert.ok(!String(html.body).includes('5,000.00'));
  });

  it('a VAT rate change does not alter an issued invoice', async () => {
    const order = await makeOrder();
    const issued = await receipt(order._id, '?issue=true');
    assert.equal(issued.body.totals.vatRate, 13);
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {vatRate: 20}});
    const reprint = await receipt(order._id);
    assert.equal(reprint.body.totals.vatRate, 13, 'stored rate must win');
    assert.equal(reprint.body.totals.vat, 91);
  });
});

// ── 5. HTML security ─────────────────────────────────────────────────────────
describe('AUDIT 5 — HTML escaping', () => {
  const XSS = '<img src=x onerror=alert(1)>';

  it('escapes every user-controlled field', () => {
    const now = new Date();
    const html = renderReceiptHtml(buildReceipt({
      order: {
        _id: 'o1', orderNo: XSS, type: 'counter', status: 'completed', deliveryAddress: XSS,
        invoiceNo: XSS, printCount: 2, createdAt: now, updatedAt: now,
        items: [{
          name: XSS, qty: 1, unitPrice: 10, lineNet: 10, lineVat: 0, lineTotal: 10,
          specialInstructions: XSS, modifiers: [{name: XSS, kind: 'extra', price: 1}]
        }],
        subtotal: 10, vat: 0, vatRate: 13, total: 10, paidAmount: 10, dueAmount: 0,
        couponCode: XSS, couponDiscount: 1, discountTotal: 1
      },
      restaurant: {name: XSS, pan: XSS, receiptFooter: XSS, currency: 'NPR'},
      branch: {name: XSS, address: XSS, phone: XSS, code: 'KTM'},
      customer: {name: XSS, phone: XSS},
      table: {name: XSS},
      payments: [
        {_id: 'p1', amount: 10, method: 'cash', status: 'paid', transactionId: XSS, createdAt: now},
        {_id: 'p2', amount: -1, method: 'cash', status: 'refunded', reason: XSS, createdAt: now}
      ]
    }));
    assert.equal((html.match(/<img src=x onerror=alert\(1\)>/g) || []).length, 0, 'raw payload leaked');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'payload should appear escaped');
    assert.ok(!/<script\b/i.test(html.replace(/<script>alert/gi, '')), 'no injected script tag');
  });

  it('escapes a malicious item name end to end through the API', async () => {
    const nasty = await MenuItem.create({
      restaurant: world.restaurant._id,
      name: '<script>alert("pwned")</script>',
      price: 100, vatInclusive: false,
      recipe: [{ingredient: world.ingredient._id, qty: 10, unit: 'g'}]
    });
    const order = await makeOrder({items: [{menuItem: String(nasty._id), qty: 1}]});
    const html = await receipt(order._id, '?format=html');
    const body = String(html.body);
    assert.ok(!body.includes('<script>alert("pwned")</script>'), 'script executed verbatim');
    assert.ok(body.includes('&lt;script&gt;'), 'name must render escaped');
  });

  it('escapes a malicious transaction id and coupon code', async () => {
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: staff(),
      body: {amount: order.total, method: 'cash', transactionId: '"><img src=x onerror=alert(9)>'}
    });
    const html = String((await receipt(order._id, '?format=html')).body);
    assert.ok(!html.includes('<img src=x onerror=alert(9)>'), 'transactionId leaked raw HTML');
    assert.ok(html.includes('&lt;img src=x'));
  });
});

// ── 6. Tax information ───────────────────────────────────────────────────────
describe('AUDIT 6 — tax configuration', () => {
  it('reads PAN from stored config and never invents one', async () => {
    assert.equal(resolveSellerPan({pan: '  123456  '}, {}), '123456');
    assert.equal(resolveSellerPan({}, {}), null, 'must not fabricate a PAN');
    // A branch PAN overrides the restaurant PAN.
    assert.equal(resolveSellerPan({pan: 'REST'}, {pan: 'BRANCH'}), 'BRANCH');
    assert.throws(() => assertTaxConfig({}, {}), /PAN\/VAT number is not configured/);
    assert.doesNotThrow(() => assertTaxConfig({pan: '301234567'}, {}));

    const order = await makeOrder();
    const res = await receipt(order._id, '?issue=true');
    assert.equal(res.body.seller.pan, '301234567');
  });

  it('refuses to issue a numbered invoice when PAN is missing', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$unset: {pan: 1}});
    const order = await makeOrder();

    const blocked = await receipt(order._id, '?issue=true');
    assert.equal(blocked.status, 409, 'issuing without a PAN must be refused');
    assert.match(blocked.body.message, /PAN\/VAT number is not configured/);

    const blockedHtml = await receipt(order._id, '?format=html');
    assert.equal(blockedHtml.status, 409);

    // Critically: no invoice number was burned and nothing was mutated.
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0);
    const stored = await Order.findById(order._id);
    assert.equal(stored.invoiceNo, undefined);
    assert.equal(Number(stored.printCount || 0), 0);
  });

  it('still allows a non-tax preview and flags the missing configuration', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$unset: {pan: 1}});
    const order = await makeOrder();
    const preview = await receipt(order._id);
    assert.equal(preview.status, 200, 'preview stays available');
    assert.equal(preview.body.taxConfigured, false);
    assert.equal(preview.body.seller.pan, null);
    assert.equal(preview.body.document, 'receipt');
  });

  it('issues once the PAN is configured on the branch', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$unset: {pan: 1}});
    await Branch.updateOne({_id: world.branchA._id}, {$set: {pan: 'BR-9988'}});
    const order = await makeOrder();
    const res = await receipt(order._id, '?issue=true');
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.seller.pan, 'BR-9988');
    assert.equal(res.body.taxConfigured, true);
  });
});

// ── 7. Output formats ────────────────────────────────────────────────────────
describe('AUDIT 7 — output formats', () => {
  it('serves JSON with the full document', async () => {
    const order = await makeOrder();
    const res = await receipt(order._id);
    assert.equal(typeof res.body, 'object');
    for (const key of ['seller', 'order', 'lines', 'totals', 'payment']) {
      assert.ok(res.body[key], `missing ${key}`);
    }
  });

  it('serves an 80mm inline-CSS document with no external assets', async () => {
    const order = await makeOrder();
    const html = String((await receipt(order._id, '?format=html')).body);
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('@page{size:80mm auto'), '80mm page size');
    assert.ok(html.includes('<style>'), 'inline stylesheet');
    assert.ok(!/<link\b/i.test(html), 'no <link> element');
    assert.ok(!/<img\b/i.test(html), 'no images');
    assert.ok(!/<script\s+src=/i.test(html), 'no external script');
    assert.ok(!/@import/i.test(html), 'no CSS import');
    assert.ok(!/https?:\/\//i.test(html), 'no absolute URLs');
    assert.ok(!/url\(/i.test(html), 'no url() asset reference');
  });

  it('ships no PDF dependency', async () => {
    const {createRequire} = await import('node:module');
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json');
    const deps = Object.keys({...pkg.dependencies, ...pkg.devDependencies}).join(' ');
    for (const banned of ['pdfkit', 'puppeteer', 'playwright', 'html-pdf', 'wkhtmltopdf']) {
      assert.ok(!deps.includes(banned), `unexpected PDF dependency: ${banned}`);
    }
  });
});

// ── 8. Isolation and authorization ───────────────────────────────────────────
describe('AUDIT 8 — branch isolation and authorization', () => {
  it('keeps invoice sequences independent per branch', async () => {
    const a1 = await makeOrder({}, world.branchA);
    const a2 = await makeOrder({}, world.branchA);
    const b1 = await makeOrder({items: [{menuItem: String(world.menu._id), qty: 1}]}, world.branchB);

    const ra1 = await receipt(a1._id, '?issue=true');
    const ra2 = await receipt(a2._id, '?issue=true');
    const rb1 = await receipt(b1._id, '?issue=true');

    assert.match(ra1.body.invoiceNo, /^INV-KTM-\d{4}-000001$/);
    assert.match(ra2.body.invoiceNo, /^INV-KTM-\d{4}-000002$/);
    assert.match(rb1.body.invoiceNo, /^INV-LTP-\d{4}-000001$/);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 2, 'one counter per branch code');
  });

  it('rejects unauthenticated, guest and cross-branch access', async () => {
    const order = await makeOrder();
    assert.equal((await request(`/api/orders/${order._id}/receipt`)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await receipt(order._id, '', guest)).status, 403);

    const otherBranch = await makeOrder({items: [{menuItem: String(world.menu._id), qty: 1}]}, world.branchB);
    assert.equal((await receipt(otherBranch._id, '', staff())).status, 403);
    assert.equal((await receipt(otherBranch._id, '?issue=true', tokenFor(world.manager))).status, 403);
    // The blocked attempt must not have consumed a number.
    assert.equal((await Order.findById(otherBranch._id)).invoiceNo, undefined);
  });

  it('returns 404 for an unknown order and 409 for a cancelled one', async () => {
    assert.equal((await receipt(new mongoose.Types.ObjectId())).status, 404);
    const order = await makeOrder();
    await request(`/api/orders/${order._id}/status`, {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'cancelled'}
    });
    assert.equal((await receipt(order._id, '?issue=true')).status, 409);
    assert.equal((await receipt(order._id)).status, 200, 'preview of a cancelled order is allowed');
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0);
  });
});
