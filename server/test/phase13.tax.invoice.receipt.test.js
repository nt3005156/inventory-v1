/**
 * Phase 13 — tax invoice and receipt system.
 *
 * The receipt engine shipped in Phase 4E: sequential per-branch numbering,
 * preview-does-not-allocate, JSON + printable HTML, escaping, PAN enforcement
 * and stored-figure rendering all existed and are pinned by
 * phase4e.receipts.test.js and phase4e.receipt.audit.test.js. None of it was
 * rebuilt.
 *
 * What this suite covers is what the audit of that engine found broken. Each
 * was reproduced against the running API before any code changed:
 *
 *   1. The invoice number was freely rewritable:
 *      Order.updateOne({...}, {invoiceNo: 'INV-KTM-2026-999999'}) succeeded.
 *   2. printCount could be rewound to 0, so a reprint presented itself as an
 *      original — the REPRINT marker simply disappeared.
 *   3. An order edited AFTER invoicing reprinted the same invoice number
 *      showing a different total (791 issued, 9999 reprinted).
 *   4. Cancelling an invoiced order left the number in place with nothing
 *      marking it void, and the reprint was refused with a flat 409 — the
 *      guest held a numbered tax invoice with no counterpart in the system.
 *   5. Issuing and reprinting a tax document wrote no audit row at all.
 *   6. The HTML escaper did not escape apostrophes.
 *
 * Reprints are also numbered by ORDINAL here — REPRINT (1), REPRINT (2) —
 * which is what the brief specifies and what a till operator counts.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import {Audit, MenuItem, User} from '../src/models/index.js';
import {
  Branch, Order, Payment, Restaurant, SalesInvoiceCounter
} from '../src/models/operations.js';
import {buildReceipt, renderReceiptHtml, getReceipt} from '../src/services/receipts.js';
import {ensureSalesInvoiceIndexes} from '../src/services/salesInvoiceMigration.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let rival;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {pan: '301234567'}});
  // Production runs this at startup (ensureOperationalIndexes). The unique
  // counter index is what makes number allocation atomic, so the tests must
  // exercise the same state rather than a conveniently index-free database.
  await ensureSalesInvoiceIndexes();

  const restaurant = await Restaurant.create({name: 'Rival13', currency: 'NPR', vatRate: 13, pan: '999888777'});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival13 Branch', code: 'RV3', address: 'Bhaktapur'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival13 Owner', email: 'rival13@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival13', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const MENU = () => String(world.menu._id);

async function makeOrder(qty = 2, branch = world.branchA, token = owner()) {
  const res = await request('/api/orders', {
    method: 'POST', token,
    body: {branch: String(branch._id), type: 'counter', items: [{menuItem: MENU(), qty}]}
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const receipt = (id, query = '', token = manager()) =>
  request(`/api/orders/${id}/receipt${query}`, {token});

const html = async (id, token = manager()) =>
  String((await receipt(id, '?format=html', token)).body);

const setStatus = (id, status, token = manager()) =>
  request(`/api/orders/${id}/status`, {method: 'PATCH', token, body: {status}});

// ═══════════════════════════════════════════════════════════════════════════
// Sequence
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — invoice sequence', () => {
  it('allocates INV-<BRANCH>-<YEAR>-###### gaplessly', async () => {
    const year = new Date().getFullYear();
    for (let n = 1; n <= 3; n += 1) {
      const order = await makeOrder(1);
      const res = await receipt(order._id, '?issue=true');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.invoiceNo, `INV-KTM-${year}-${String(n).padStart(6, '0')}`);
    }
    assert.equal((await SalesInvoiceCounter.findOne({branchCode: 'KTM'})).value, 3);
  });

  it('keeps a separate sequence per branch and one counter each', async () => {
    const a = await makeOrder(1, world.branchA);
    const b = await makeOrder(1, world.branchB);
    assert.match((await receipt(a._id, '?issue=true', owner())).body.invoiceNo, /^INV-KTM-\d{4}-000001$/);
    assert.match((await receipt(b._id, '?issue=true', owner())).body.invoiceNo, /^INV-LTP-\d{4}-000001$/);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 2);
  });

  it('does not spend a number when issuing is refused', async () => {
    // No PAN configured on this tenant, so the document would not be a valid
    // tax invoice.
    await Restaurant.updateOne({_id: world.restaurant._id}, {$unset: {pan: 1}});
    const order = await makeOrder(1);
    assert.equal((await receipt(order._id, '?issue=true')).status, 409);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0, 'a refused issue must not burn a number');
    assert.equal((await Order.findById(order._id)).invoiceNo, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrency
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — concurrency', () => {
  it('mints one number for one order under parallel issue', async () => {
    const order = await makeOrder(1);
    const results = await Promise.all(
      Array.from({length: 6}, () => receipt(order._id, '?issue=true'))
    );
    const numbers = new Set(results.map(r => r.body?.invoiceNo).filter(Boolean));
    assert.equal(numbers.size, 1, `saw ${[...numbers].join(' & ')}`);
    assert.equal((await SalesInvoiceCounter.findOne({})).value, 1);
  });

  it('never issues the same number to two different orders', async () => {
    // Duplicate numbering is defended at TWO independent layers: the unique
    // index on the counter scope (which makes the allocating upsert atomic)
    // and the unique partial index on {branch, invoiceNo}. Removing either
    // alone still passes; removing BOTH fails this test. Verified by mutation.
    // Driven through overlapping mongoose sessions: Express serialises HTTP
    // requests, so an HTTP-only race here would prove nothing.
    const orders = await Promise.all([makeOrder(1), makeOrder(1), makeOrder(1), makeOrder(1)]);
    const issue = async order => {
      const session = await mongoose.startSession();
      try {
        let out;
        await session.withTransaction(async () => {
          out = await getReceipt({orderId: order._id, user: world.owner, issue: true, session});
        });
        return out.invoiceNo;
      } finally {
        await session.endSession();
      }
    };
    const numbers = await Promise.all(orders.map(issue));
    assert.equal(new Set(numbers).size, orders.length, `duplicate number: ${numbers.join(', ')}`);
    assert.equal((await SalesInvoiceCounter.findOne({})).value, orders.length, 'gapless');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Preview
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — preview allocates nothing', () => {
  it('returns a receipt with no number and no counter row', async () => {
    const order = await makeOrder(1);
    const res = await receipt(order._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.invoiceNo, null);
    assert.equal(res.body.document, 'receipt');
    assert.equal(res.body.printCount, 0);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0);
    assert.equal((await Order.findById(order._id)).invoiceNo, undefined);
  });

  it('can be previewed repeatedly without ever allocating', async () => {
    const order = await makeOrder(1);
    for (let i = 0; i < 5; i += 1) await receipt(order._id);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0);
    assert.equal((await Order.findById(order._id)).printCount, 0);
    assert.equal(await Audit.countDocuments({action: 'tax_invoice_issued'}), 0);
  });

  it('previews a cancelled order without allocating', async () => {
    const order = await makeOrder(1);
    await setStatus(order._id, 'cancelled');
    assert.equal((await receipt(order._id)).status, 200);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Print and reprint
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — print and reprint', () => {
  it('numbers reprints by ordinal and reuses the invoice number', async () => {
    const order = await makeOrder(1);
    const first = await html(order._id);
    assert.ok(first.includes('TAX INVOICE'));
    assert.ok(!first.includes('REPRINT'), 'the first print is not a reprint');

    const number = (await Order.findById(order._id)).invoiceNo;
    assert.ok(number);

    assert.ok((await html(order._id)).includes('REPRINT (1)'));
    assert.ok((await html(order._id)).includes('REPRINT (2)'));
    assert.ok((await html(order._id)).includes('REPRINT (3)'));

    const stored = await Order.findById(order._id);
    assert.equal(stored.invoiceNo, number, 'a reprint never mints a new number');
    assert.equal(stored.printCount, 4);
    assert.equal((await SalesInvoiceCounter.findOne({})).value, 1);
  });

  it('reports the same figures in JSON and in the printed HTML', async () => {
    const order = await makeOrder(2);
    await request(`/api/orders/${order._id}/payments`, {
      method: 'POST', token: manager(), body: {amount: order.total, method: 'cash'}
    });
    const json = (await receipt(order._id, '?issue=true')).body;
    const printed = await html(order._id);

    assert.equal(json.invoiceNo, (await Order.findById(order._id)).invoiceNo);
    assert.ok(printed.includes(json.invoiceNo));
    assert.ok(printed.includes('791.00'), 'the printed total must match the JSON total');
    assert.equal(json.totals.total, 791);
    assert.ok(printed.includes('PAN: 301234567'));
  });

  it('creates no order, payment or counter movement on reprint', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    const before = {
      orders: await Order.countDocuments({}),
      payments: await Payment.countDocuments({}),
      counter: (await SalesInvoiceCounter.findOne({})).value
    };
    await receipt(order._id, '?issue=true');
    await html(order._id);
    assert.equal(await Order.countDocuments({}), before.orders);
    assert.equal(await Payment.countDocuments({}), before.payments);
    assert.equal((await SalesInvoiceCounter.findOne({})).value, before.counter);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The invoice number is immutable
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — the issued invoice is immutable', () => {
  it('refuses to rewrite the number through a query update', async () => {
    const order = await makeOrder(1);
    const issued = (await receipt(order._id, '?issue=true')).body.invoiceNo;

    await assert.rejects(
      Order.updateOne({_id: order._id}, {$set: {invoiceNo: 'INV-KTM-2026-999999'}}),
      /cannot be altered/
    );
    await assert.rejects(
      Order.findOneAndUpdate({_id: order._id}, {$set: {invoicedAt: new Date('2001-01-01')}}),
      /cannot be altered/
    );
    await assert.rejects(
      Order.updateOne({_id: order._id}, {$unset: {invoiceNo: 1}}),
      /cannot be altered/
    );

    assert.equal((await Order.findById(order._id)).invoiceNo, issued);
  });

  it('refuses to rewrite the number on the document', async () => {
    const order = await makeOrder(1);
    const issued = (await receipt(order._id, '?issue=true')).body.invoiceNo;

    const doc = await Order.findById(order._id);
    doc.invoiceNo = 'INV-KTM-2026-000042';
    await assert.rejects(doc.save(), /cannot be altered/);
    assert.equal((await Order.findById(order._id)).invoiceNo, issued);
  });

  it('refuses to rewind printCount so a reprint cannot pose as an original', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    await receipt(order._id, '?issue=true');
    assert.equal((await Order.findById(order._id)).printCount, 2);

    await assert.rejects(
      Order.updateOne({_id: order._id}, {$set: {printCount: 0}}),
      /cannot be decreased/
    );
    await assert.rejects(
      Order.updateOne({_id: order._id}, {$inc: {printCount: -2}}),
      /cannot be decreased/
    );
    const doc = await Order.findById(order._id);
    doc.printCount = 0;
    await assert.rejects(doc.save(), /cannot be decreased/);

    assert.equal((await Order.findById(order._id)).printCount, 2);
    assert.ok((await html(order._id)).includes('REPRINT'), 'the marker cannot be erased');
  });

  it('control: allocation itself is still allowed on an uninvoiced order', async () => {
    // The guard must only bite where a number already exists, or nothing could
    // ever be invoiced at all.
    const order = await makeOrder(1);
    const res = await receipt(order._id, '?issue=true');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.invoiceNo);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Never re-price a historical invoice
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — an invoice is never re-priced', () => {
  it('ignores a later menu price change', async () => {
    const order = await makeOrder(2);
    const issued = (await receipt(order._id, '?issue=true')).body;
    assert.equal(issued.totals.total, 791);

    await MenuItem.updateOne({_id: world.menu._id}, {$set: {price: 999}});

    const reprinted = (await receipt(order._id, '?issue=true')).body;
    assert.equal(reprinted.totals.total, 791);
    assert.equal(reprinted.lines[0].unitPrice, 350);
    assert.equal(reprinted.invoiceNo, issued.invoiceNo);
  });

  it('ignores a later restaurant VAT rate change', async () => {
    const order = await makeOrder(2);
    const issued = (await receipt(order._id, '?issue=true')).body;
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {vatRate: 20}});
    const reprinted = (await receipt(order._id, '?issue=true')).body;
    assert.equal(reprinted.totals.vatRate, issued.totals.vatRate);
    assert.equal(reprinted.totals.vat, issued.totals.vat);
  });

  it('flags a reprint whose order has drifted from the issued figure', async () => {
    const order = await makeOrder(2);
    const issued = (await receipt(order._id, '?issue=true')).body;
    assert.equal(issued.invoicedTotal, 791);
    assert.equal(issued.tampered, false);

    // Tamper with the order behind the API's back. The invoice number itself
    // is immutable, so this is the remaining way the document could lie.
    await Order.updateOne({_id: order._id}, {$set: {total: 9999}});

    const reprinted = (await receipt(order._id, '?issue=true')).body;
    assert.equal(reprinted.invoiceNo, issued.invoiceNo, 'still the same number');
    assert.equal(reprinted.invoicedTotal, 791, 'the issued figure is pinned');
    assert.equal(reprinted.tampered, true);
    assert.ok((await html(order._id)).includes('DOES NOT MATCH ISSUED INVOICE'));
  });

  it('does not flag an untouched invoice as tampered', async () => {
    // Control: the drift detector must not cry wolf on a normal reprint.
    const order = await makeOrder(2);
    await receipt(order._id, '?issue=true');
    const reprinted = (await receipt(order._id, '?issue=true')).body;
    assert.equal(reprinted.tampered, false);
    assert.ok(!(await html(order._id)).includes('DOES NOT MATCH'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Voiding
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — voiding an issued invoice', () => {
  it('keeps the number and stamps the reprint VOID', async () => {
    const order = await makeOrder(1);
    const issued = (await receipt(order._id, '?issue=true')).body.invoiceNo;

    assert.equal((await setStatus(order._id, 'cancelled')).status, 200);

    const stored = await Order.findById(order._id);
    assert.equal(stored.invoiceNo, issued, 'a VAT sequence must not develop a gap');
    assert.ok(stored.invoiceVoidedAt, 'the void must be recorded');

    const printed = await html(order._id);
    assert.ok(printed.includes('VOID'), 'the guest holds a numbered invoice; the reprint must say it is void');
    assert.ok(printed.includes(issued));
    assert.equal((await SalesInvoiceCounter.findOne({})).value, 1, 'the number is not released');
  });

  it('reports the void in the JSON document', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    await setStatus(order._id, 'cancelled');
    const res = await receipt(order._id);
    assert.equal(res.status, 200);
    assert.equal(res.body.voided, true);
    assert.ok(res.body.voidReason);
  });

  it('still refuses to allocate a number to a cancelled order', async () => {
    const order = await makeOrder(1);
    await setStatus(order._id, 'cancelled');
    assert.equal((await receipt(order._id, '?issue=true')).status, 409);
    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0);
  });

  it('does not mark a live invoice as void', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    assert.equal((await receipt(order._id)).body.voided, false);
    assert.ok(!(await html(order._id)).includes('VOID'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit trail
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — audit trail', () => {
  it('records the allocation and every reprint separately', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    await receipt(order._id, '?issue=true');
    await html(order._id);

    const issued = await Audit.find({entityId: order._id, action: 'tax_invoice_issued'}).lean();
    const reprints = await Audit.find({entityId: order._id, action: 'tax_invoice_reprinted'}).lean();

    assert.equal(issued.length, 1, 'a number is allocated exactly once');
    assert.equal(reprints.length, 2, 'each reprint of a tax document is traceable');
    assert.equal(issued[0].after.invoiceNo, (await Order.findById(order._id)).invoiceNo);
    assert.equal(String(issued[0].user), String(world.manager._id));
    assert.equal(reprints[1].after.printCount, 3);
  });

  it('records who voided an invoice and why', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    await setStatus(order._id, 'cancelled');
    const entry = await Audit.findOne({entityId: order._id, action: 'tax_invoice_voided'}).lean();
    assert.ok(entry, 'voiding a tax invoice must be auditable');
    assert.ok(entry.reason);
    assert.equal(String(entry.user), String(world.manager._id));
  });

  it('writes no audit row for a preview', async () => {
    const order = await makeOrder(1);
    await receipt(order._id);
    assert.equal(await Audit.countDocuments({
      entityId: order._id, action: {$in: ['tax_invoice_issued', 'tax_invoice_reprinted']}
    }), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VAT arithmetic
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — VAT arithmetic', () => {
  it('states a taxable value that reconciles with the VAT charged', async () => {
    const order = await makeOrder(2);
    const t = (await receipt(order._id, '?issue=true')).body.totals;
    assert.equal(t.subtotal, 700);
    assert.equal(t.taxableValue, 700);
    assert.equal(t.vatRate, 13);
    assert.equal(t.vat, 91);
    assert.equal(Math.round(t.taxableValue * t.vatRate) / 100, t.vat, 'VAT must equal taxable x rate');
    assert.equal(Math.round((t.taxableValue + t.vat) * 100) / 100, t.total);
  });

  it('excludes an untaxed delivery fee from the taxable value', async () => {
    const {Customer} = await import('../src/models/operations.js');
    const customer = await Customer.create({
      restaurant: world.restaurant._id, branch: world.branchA._id,
      name: 'Delivery Guest', phone: '9800000013'
    });
    const res = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id), type: 'delivery', deliveryAddress: 'Thamel',
        customer: String(customer._id),
        items: [{menuItem: MENU(), qty: 2}], deliveryFee: 100
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = (await receipt(res.body._id, '?issue=true', owner())).body.totals;
    assert.equal(t.deliveryFee, 100);
    assert.equal(t.taxableValue, 700, 'the delivery fee is not taxable');
    assert.equal(t.vat, 91, 'VAT must not be charged on delivery');
    assert.equal(t.total, 891);
  });

  it('nets a discount out of the taxable value before VAT', async () => {
    const res = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id), type: 'counter',
        items: [{menuItem: MENU(), qty: 2}],
        discount: {kind: 'fixed', value: 100, reason: 'Manager goodwill'}
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const t = (await receipt(res.body._id, '?issue=true', owner())).body.totals;
    assert.equal(t.taxableValue, 600, 'VAT is charged after the discount, not before');
    assert.equal(t.vat, 78);
    assert.equal(t.total, 678);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// XSS
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — HTML escaping', () => {
  it('escapes quotes, apostrophes and slashes', () => {
    const payload = `"><script>alert(1)</script><img src=x onerror='alert(2)'>`;
    const out = renderReceiptHtml(buildReceipt({
      order: {
        _id: 'o', orderNo: payload, type: 'counter', status: 'completed', invoiceNo: payload,
        printCount: 3, createdAt: new Date(), deliveryAddress: payload,
        items: [{name: payload, qty: 1, unitPrice: 1, lineNet: 1, lineVat: 0, lineTotal: 1,
          specialInstructions: payload, modifiers: [{name: payload, kind: 'extra', price: 1}]}],
        subtotal: 1, vat: 0, vatRate: 13, total: 1, paidAmount: 1, dueAmount: 0,
        couponCode: payload, couponDiscount: 1, discountTotal: 1,
        invoiceVoidReason: payload
      },
      restaurant: {name: payload, pan: payload, receiptFooter: payload, currency: 'NPR'},
      branch: {name: payload, address: payload, phone: payload, code: 'KTM'},
      customer: {name: payload, phone: payload},
      table: {name: payload},
      payments: [
        {_id: 'p1', amount: 1, method: 'cash', status: 'paid', transactionId: payload, createdAt: new Date()},
        {_id: 'p2', amount: -1, method: 'cash', status: 'refunded', reason: payload, createdAt: new Date()}
      ]
    }));

    assert.ok(!out.includes('<script>alert(1)</script>'), 'raw script tag leaked');
    assert.ok(!out.includes('<img src=x'), 'raw img tag leaked');
    assert.ok(!out.includes("onerror='alert(2)'"), 'raw event handler leaked');
    assert.ok(!/\balert\(1\)<\/script>/.test(out));
    assert.ok(out.includes('&lt;script&gt;'), 'the payload should be visible but inert');
    assert.ok(out.includes('&#39;'), 'apostrophes must be escaped for attribute safety');
  });

  it('escapes a crafted item name end to end through the API', async () => {
    const payload = `<script>alert('pwn')</script>`;
    const nasty = await MenuItem.create({
      restaurant: world.restaurant._id, name: payload, price: 100, vatInclusive: false, active: true
    });
    const order = await request('/api/orders', {
      method: 'POST', token: owner(),
      body: {branch: String(world.branchA._id), type: 'counter', items: [{menuItem: String(nasty._id), qty: 1}]}
    });
    assert.equal(order.status, 201, JSON.stringify(order.body));

    const printed = await html(order.body._id, owner());
    assert.ok(!printed.includes(payload), 'the raw payload reached the printed page');
    assert.ok(printed.includes('&lt;script&gt;'));
  });

  it('escapes a crafted void reason on the printed copy', async () => {
    const order = await makeOrder(1);
    await receipt(order._id, '?issue=true');
    await setStatus(order._id, 'cancelled');
    await Order.updateOne(
      {_id: order._id},
      {$set: {invoiceVoidReason: '<script>alert(1)</script>'}}
    );
    const printed = await html(order._id);
    assert.ok(printed.includes('VOID'));
    assert.ok(!printed.includes('<script>alert(1)</script>'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Branch isolation and authorisation
// ═══════════════════════════════════════════════════════════════════════════

describe('13 — isolation and authorisation', () => {
  it('refuses anonymous, guest, cross-branch and cross-restaurant access', async () => {
    const order = await makeOrder(1);
    assert.equal((await request(`/api/orders/${order._id}/receipt`)).status, 401);
    assert.equal((await receipt(order._id, '', 'not.a.jwt')).status, 401);

    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await receipt(order._id, '', guest)).status, 403);

    const intruder = tokenFor(rival.owner);
    assert.ok([403, 404].includes((await receipt(order._id, '', intruder)).status));
    assert.ok([403, 404].includes((await receipt(order._id, '?issue=true', intruder)).status));
    assert.ok([403, 404].includes((await receipt(order._id, '?format=html', intruder)).status));

    assert.equal(await SalesInvoiceCounter.countDocuments({}), 0, 'a refused caller must not burn a number');
    assert.equal((await Order.findById(order._id)).invoiceNo, undefined);
  });

  it('stops a branch-bound manager reading another branch invoice', async () => {
    const other = await makeOrder(1, world.branchB, owner());
    // world.manager is bound to branch A.
    assert.equal((await receipt(other._id, '', manager())).status, 403);
    assert.equal((await receipt(other._id, '?issue=true', manager())).status, 403);
    assert.equal((await receipt(other._id, '', staff())).status, 403);
    assert.equal((await Order.findById(other._id)).invoiceNo, undefined);
  });

  it('never leaks another restaurant number into this one sequence', async () => {
    const ours = await makeOrder(1);
    const theirs = await Order.create({
      orderNo: 'RV3-1', branch: rival.branch._id, status: 'completed', type: 'counter',
      items: [], subtotal: 100, vat: 13, vatRate: 13, total: 113, paidAmount: 113, dueAmount: 0
    });
    await receipt(ours._id, '?issue=true');
    await receipt(theirs._id, '?issue=true', tokenFor(rival.owner));

    const counters = await SalesInvoiceCounter.find({}).lean();
    assert.equal(counters.length, 2);
    assert.equal(new Set(counters.map(c => String(c.restaurant))).size, 2);
    assert.match((await Order.findById(ours._id)).invoiceNo, /^INV-KTM-/);
    assert.match((await Order.findById(theirs._id)).invoiceNo, /^INV-RV3-/);
  });

  it('returns 404 for an unknown order', async () => {
    assert.equal((await receipt(new mongoose.Types.ObjectId())).status, 404);
  });
});
