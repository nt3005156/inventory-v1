import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Audit, Supplier, User} from '../src/models/index.js';
import {InventoryBalance, InventoryBatch, InventoryTransaction, PurchaseOrder, SupplierInvoice} from '../src/models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../src/models/purchasing.js';
import {acceptedQty, remainingQty} from '../src/services/receiving.js';
import {canReceivePo, canTransitionPo} from '../src/services/purchaseOrders.js';
import {returnableQty} from '../src/services/returns.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {daysAhead} from './dates.js';


// Expiry must stay in the future so these lots never read as expired stock.
const FUTURE_EXPIRY = daysAhead(365);

let world;
let supplier;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Kathmandu Food Suppliers', contact: '9800000000'});
});

function patchPoStatus(poId, status, extras = {}) {
  return request('/api/purchase-orders/' + poId + '/status', {
    method: 'PATCH',
    token: tokenFor(extras.user || world.manager),
    body: {status, notes: extras.notes}
  });
}

async function createPo(orderedQty = 1000, extras = {}) {
  const {draft, user, ...body} = extras;
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(user || world.manager),
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty, unit: 'g', unitPrice: 0.05}],
      ...body
    }
  });
  if (created.status !== 201 || draft) return created;
  const pending = await patchPoStatus(created.body._id, 'pending', {user: user || world.manager});
  if (pending.status !== 200) return pending;
  const approved = await patchPoStatus(created.body._id, 'approved', {user: world.owner});
  if (approved.status !== 200) return approved;
  return {status: 201, body: approved.body};
}

let receiptRequestSequence = 0;
function receive(poId, items, extras = {}) {
  const key = extras.key === null ? null : (extras.key || `test-gr-${++receiptRequestSequence}`);
  return request('/api/purchase-orders/' + poId + '/receive', {
    method: 'POST',
    token: tokenFor(extras.user || world.manager),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {
      items: items.map(item => Number(item.damagedQty || 0) > 0 && !item.damageReason ? {...item, damageReason: 'quality'} : item),
      notes: extras.notes,
      expectedVersion: extras.expectedVersion
    }
  });
}

let returnRequestSequence = 0;
async function postReturn(poId, items, extras = {}) {
  const current = await PurchaseOrder.findById(poId).select('__v').lean();
  const key = extras.key === null ? null : (extras.key || `test-pr-${++returnRequestSequence}`);
  return request('/api/purchase-orders/' + poId + '/returns', {
    method: 'POST',
    token: tokenFor(extras.user || world.manager),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {
      items,
      reason: extras.reason || 'quality',
      notes: extras.notes,
      expectedVersion: extras.expectedVersion ?? current?.__v ?? 0
    }
  });
}

describe('receiving helpers', () => {
  it('computes remaining, accepted and returnable quantities', () => {
    assert.equal(remainingQty({orderedQty: 1000, receivedQty: 400}), 600);
    assert.equal(acceptedQty(100, 15), 85);
    assert.equal(returnableQty({receivedQty: 400, damagedQty: 50, returnedQty: 100}), 250);
  });
});

describe('POST /api/purchase-orders/:id/receive', () => {
  it('posts a partial receipt and only accepted qty hits usable stock', async () => {
    const po = await createPo(1000);
    assert.equal(po.status, 201, po.body?.message);
    const line = po.body.items[0];
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    const res = await receive(po.body._id, [{
      itemId: String(line._id),
      receivedQty: 400,
      damagedQty: 50,
      batchNumber: 'LOT-A',
      expiryDate: FUTURE_EXPIRY
    }], {notes: 'First truck', key: 'gr-1'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.purchaseOrder.status, 'partially_received');
    assert.equal(res.body.receipt.items[0].acceptedQty, 350);
    assert.equal(res.body.receipt.notes, 'First truck');
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(after.quantity, before.quantity + 350);
    assert.equal(after.batchNumber, undefined);
    const lot = await InventoryBatch.findOne({
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      batchNumberNormalized: 'LOT-A'
    });
    assert.ok(lot);
    assert.equal(lot.quantity, 350);
    assert.equal(lot.expiryDate.toISOString().slice(0, 10), FUTURE_EXPIRY);
    const txs = await InventoryTransaction.find({type: 'PURCHASE', referenceType: 'goods_receipt'});
    assert.equal(txs.length, 1);
    assert.equal(txs[0].changeQty, 350);
  });

  it('allows a second receipt and then marks the PO received', async () => {
    const po = await createPo(1000);
    const line = po.body.items[0];
    const first = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 400, damagedQty: 0}], {key: 'gr-a'});
    assert.equal(first.status, 201, first.body?.message);
    const second = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 600, damagedQty: 0}], {key: 'gr-b'});
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(second.body.purchaseOrder.status, 'received');
    assert.equal(second.body.purchaseOrder.items[0].receivedQty, 1000);
    const history = await request('/api/purchase-orders/' + po.body._id + '/receipts', {token: tokenFor(world.owner)});
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 2);
  });

  it('rejects over-receive, damaged over received, and cancelled POs', async () => {
    const po = await createPo(100);
    const line = po.body.items[0];
    assert.equal((await receive(po.body._id, [{itemId: String(line._id), receivedQty: 80, damagedQty: 90}])).status, 409);
    assert.equal((await receive(po.body._id, [{itemId: String(line._id), receivedQty: 150, damagedQty: 0}])).status, 409);
    await PurchaseOrder.findByIdAndUpdate(po.body._id, {status: 'cancelled'});
    assert.equal((await receive(po.body._id, [{itemId: String(line._id), receivedQty: 10, damagedQty: 0}])).status, 409);
  });

  it('does not double-post when the same idempotency key is replayed', async () => {
    const po = await createPo(500);
    const line = po.body.items[0];
    const first = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 200, damagedQty: 0}], {key: 'same-key'});
    assert.equal(first.status, 201, first.body?.message);
    const before = await InventoryTransaction.countDocuments({type: 'PURCHASE'});
    const again = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 200, damagedQty: 0}], {key: 'same-key'});
    assert.equal(again.status, 200, again.body?.message);
    assert.equal(again.body.duplicate, true);
    assert.equal(await InventoryTransaction.countDocuments({type: 'PURCHASE'}), before);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po.body._id}), 1);
  });

  it('rejects staff, guests, and missing tokens', async () => {
    const po = await createPo(100);
    const line = po.body.items[0];
    const body = {items: [{itemId: String(line._id), receivedQty: 10, damagedQty: 0}]};
    assert.equal((await receive(po.body._id, body.items, {user: world.staffA})).status, 403);
    assert.equal((await request('/api/purchase-orders/' + po.body._id + '/receive', {method: 'POST', body})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/purchase-orders/' + po.body._id + '/receive', {method: 'POST', token: guest, body})).status, 403);
  });
});

describe('POST /api/purchase-orders/:id/returns', () => {
  it('returns accepted stock and posts a RETURN ledger row', async () => {
    const po = await createPo(1000);
    const line = po.body.items[0];
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 400, damagedQty: 50}], {key: 'ret-gr'});
    assert.equal(rec.status, 201, rec.body?.message);
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    const res = await postReturn(po.body._id, [{itemId: String(line._id), qty: 100}], {reason: 'quality', notes: 'Off smell', key: 'pr-1'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.purchaseReturn.items[0].qty, 100);
    assert.equal(res.body.purchaseOrder.items[0].returnedQty, 100);
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(after.quantity, before.quantity - 100);
    const txs = await InventoryTransaction.find({type: 'RETURN', referenceType: 'purchase_return'});
    assert.equal(txs.length, 1);
    assert.equal(txs[0].changeQty, -100);
    const history = await request('/api/purchase-orders/' + po.body._id + '/returns', {token: tokenFor(world.owner)});
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].reason, 'quality');
  });

  it('rejects returning more than accepted and a second over-return', async () => {
    const po = await createPo(200);
    const line = po.body.items[0];
    assert.equal((await postReturn(po.body._id, [{itemId: String(line._id), qty: 10}])).status, 409);
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 80, damagedQty: 20}], {key: 'ret-gr2'});
    assert.equal(rec.status, 201, rec.body?.message);
    assert.equal((await postReturn(po.body._id, [{itemId: String(line._id), qty: 70}])).status, 409);
    const ok = await postReturn(po.body._id, [{itemId: String(line._id), qty: 40}], {key: 'pr-ok'});
    assert.equal(ok.status, 201, ok.body?.message);
    assert.equal((await postReturn(po.body._id, [{itemId: String(line._id), qty: 30}])).status, 409);
  });

  it('does not double-post a replayed return idempotency key', async () => {
    const po = await createPo(300);
    const line = po.body.items[0];
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 200, damagedQty: 0}], {key: 'ret-gr3'});
    assert.equal(rec.status, 201, rec.body?.message);
    const first = await postReturn(po.body._id, [{itemId: String(line._id), qty: 50}], {key: 'same-ret'});
    assert.equal(first.status, 201, first.body?.message);
    const before = await InventoryTransaction.countDocuments({type: 'RETURN'});
    const again = await postReturn(po.body._id, [{itemId: String(line._id), qty: 50}], {key: 'same-ret'});
    assert.equal(again.status, 200, again.body?.message);
    assert.equal(again.body.duplicate, true);
    assert.equal(await InventoryTransaction.countDocuments({type: 'RETURN'}), before);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po.body._id}), 1);
  });

  it('rejects cancelled POs, staff, and missing tokens', async () => {
    const po = await createPo(100);
    const line = po.body.items[0];
    await receive(po.body._id, [{itemId: String(line._id), receivedQty: 80, damagedQty: 0}], {key: 'ret-gr4'});
    await PurchaseOrder.findByIdAndUpdate(po.body._id, {status: 'cancelled'});
    assert.equal((await postReturn(po.body._id, [{itemId: String(line._id), qty: 10}])).status, 409);
    const open = await createPo(100);
    const openLine = open.body.items[0];
    await receive(open.body._id, [{itemId: String(openLine._id), receivedQty: 50, damagedQty: 0}], {key: 'ret-gr5'});
    assert.equal((await postReturn(open.body._id, [{itemId: String(openLine._id), qty: 10}], {user: world.staffA})).status, 403);
    assert.equal((await request('/api/purchase-orders/' + open.body._id + '/returns', {method: 'POST', body: {items: [{itemId: String(openLine._id), qty: 10}]}})).status, 401);
  });

  it('rejects a return when usable stock is insufficient', async () => {
    const po = await createPo(100);
    const line = po.body.items[0];
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 80, damagedQty: 0}], {key: 'ret-gr6'});
    assert.equal(rec.status, 201, rec.body?.message);
    await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'clear-stock-for-return'},
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: -20080, reason: 'Clear stock for return test'}
    });
    const res = await postReturn(po.body._id, [{itemId: String(line._id), qty: 80}]);
    assert.equal(res.status, 409);
  });
});

describe('supplier statement', () => {
  it('builds a running balance from invoices and payments', async () => {
    const po = await createPo(200);
    const inv = await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-1' },
      body: {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        purchaseOrder: String(po.body._id),
        invoiceNo: 'INV-STMT',
        subtotal: 1000,
        vat: 130,
        total: 1130
      }
    });
    assert.equal(inv.status, 201, inv.body?.message);
    const paid = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-payment-statement-1'},
      body: {amount: 130, method: 'cash', reference: 'PART-1'}
    });
    assert.equal(paid.status, 201, paid.body?.message);

    const stmt = await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(stmt.status, 200, stmt.body?.message);
    assert.equal(stmt.body.invoiced, 1130);
    assert.equal(stmt.body.paid, 130);
    assert.equal(stmt.body.balance, 1000);
    assert.equal(stmt.body.lines.length, 2);
    assert.equal(stmt.body.lines[0].type, 'invoice');
    assert.equal(stmt.body.lines[0].debit, 1130);
    assert.equal(stmt.body.lines[0].balance, 1130);
    assert.equal(stmt.body.lines[1].type, 'payment');
    assert.equal(stmt.body.lines[1].credit, 130);
    assert.equal(stmt.body.lines[1].balance, 1000);

    const pays = await request('/api/suppliers/' + supplier._id + '/payments?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(pays.status, 200);
    assert.equal(pays.body.length, 1);
    const invPays = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {token: tokenFor(world.manager)});
    assert.equal(invPays.status, 200);
    assert.equal(invPays.body.length, 1);
    assert.equal(invPays.body[0].amount, 130);
    const bal = await request('/api/suppliers/' + supplier._id + '/balance?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(bal.body.balance, 1000);
  });

  it('does not mix another supplier or another branch onto the statement', async () => {
    const other = await Supplier.create({restaurant: world.restaurant._id, name: 'Other Supplier'});
    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-2' },
      body: {branch: String(world.branchA._id), supplier: String(supplier._id), invoiceNo: 'A1', subtotal: 100, vat: 13, total: 113}
    });
    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-3' },
      body: {branch: String(world.branchA._id), supplier: String(other._id), invoiceNo: 'B1', subtotal: 500, vat: 65, total: 565}
    });
    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-4' },
      body: {branch: String(world.branchB._id), supplier: String(supplier._id), invoiceNo: 'A-BKT', subtotal: 200, vat: 26, total: 226}
    });
    const stmt = await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(stmt.status, 200);
    assert.equal(stmt.body.invoiced, 113);
    assert.equal(stmt.body.lines.every(l => l.ref !== 'B1' && l.ref !== 'A-BKT'), true);
  });

  it('rejects staff, guests, and missing tokens', async () => {
    assert.equal((await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id, {token: guest})).status, 403);
    assert.equal((await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});

describe('supplier invoice VAT', () => {
  it('stores a 13% VAT invoice against a purchase order', async () => {
    const po = await createPo(200);
    assert.equal(po.status, 201, po.body?.message);
    const inv = await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-5' },
      body: {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        purchaseOrder: String(po.body._id),
        invoiceNo: 'INV-13',
        subtotal: 1000,
        vat: 130,
        total: 1130
      }
    });
    assert.equal(inv.status, 201, inv.body?.message);
    assert.equal(inv.body.vat, 130);
    assert.equal(inv.body.total, 1130);
    assert.equal(inv.body.status, 'unpaid');
  });
});

describe('GET /api/reports/purchasing', () => {
  it('summarizes POs, receipts, returns, invoices and ledger for one branch', async () => {
    const po = await createPo(1000);
    const line = po.body.items[0];
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 400, damagedQty: 50}], {key: 'rep-gr'});
    assert.equal(rec.status, 201, rec.body?.message);
    const ret = await postReturn(po.body._id, [{itemId: String(line._id), qty: 100}], {key: 'rep-pr'});
    assert.equal(ret.status, 201, ret.body?.message);
    const inv = await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-6' },
      body: {branch: String(world.branchA._id), supplier: String(supplier._id), invoiceNo: 'INV-REP', subtotal: 1000, vat: 130, total: 1130}
    });
    assert.equal(inv.status, 201, inv.body?.message);
    await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-payment-report-1'},
      body: {amount: 130, method: 'cash'}
    });

    const other = await Supplier.create({restaurant: world.restaurant._id, name: 'Other Mill'});
    await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(world.branchB._id),
        supplier: String(other._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 50, unit: 'g', unitPrice: 1}],
      }
    });

    const report = await request('/api/reports/purchasing?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(report.status, 200, report.body?.message);
    assert.equal(report.body.purchaseOrders.count, 1);
    assert.equal(report.body.purchaseOrders.orderedValue, 56.5);
    assert.equal(report.body.purchaseOrders.receivedQty, 400);
    assert.equal(report.body.purchaseOrders.damagedQty, 50);
    assert.equal(report.body.purchaseOrders.acceptedQty, 350);
    assert.equal(report.body.purchaseOrders.returnedQty, 100);
    assert.equal(report.body.purchaseOrders.outstandingQty, 600);
    assert.equal(report.body.purchaseOrders.shortClosedQty, 0);
    assert.equal(report.body.purchaseOrders.partialCount, 1);
    assert.equal(report.body.receipts.acceptedValue, 17.5);
    assert.equal(report.body.receipts.damagedValue, 2.5);
    assert.deepEqual(report.body.receipts.damageByReason, [{reason: 'quality', qty: 50, value: 2.5}]);
    assert.equal(report.body.returns.value, 5);
    assert.equal(report.body.invoices.invoiced, 1130);
    assert.equal(report.body.invoices.vat, 130);
    assert.equal(report.body.invoices.paid, 130);
    assert.equal(report.body.invoices.due, 1000);
    assert.equal(report.body.ledger.purchaseValue, 17.5);
    assert.equal(report.body.ledger.returnValue, 5);
    assert.equal(report.body.ledger.netStockValue, 12.5);
    assert.equal(report.body.bySupplier.length, 1);
    assert.equal(report.body.bySupplier[0].name, 'Kathmandu Food Suppliers');
    assert.equal(report.body.bySupplier[0].due, 1000);
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    assert.equal((await request('/api/reports/purchasing?branch=' + world.branchA._id, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request('/api/reports/purchasing?branch=' + world.branchA._id)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/reports/purchasing?branch=' + world.branchA._id, {token: guest})).status, 403);
    assert.equal((await request('/api/reports/purchasing?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});

function createInvoice(body = {}) {
  return request('/api/supplier-invoices', {
    method: 'POST',
    token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-7' },
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      invoiceNo: 'INV-EDIT',
      subtotal: 1000,
      vat: 130,
      total: 1130,
      ...body
    }
  });
}

async function patchInvoice(id, body, extras = {}) {
  const current = await SupplierInvoice.findById(id).select('__v').lean();
  return request('/api/supplier-invoices/' + id, {
    method: 'PATCH',
    token: tokenFor(extras.user || world.manager),
    body: {...body, expectedVersion: current?.__v ?? 0}
  });
}

describe('PATCH /api/supplier-invoices/:id', () => {
  it('edits unpaid invoice number, dates, notes and recomputes 13% VAT', async () => {
    const po = await createPo(200);
    const inv = await createInvoice({purchaseOrder: String(po.body._id), notes: 'draft'});
    assert.equal(inv.status, 201, inv.body?.message);

    const patched = await patchInvoice(inv.body._id, {
      invoiceNo: 'INV-FIXED',
      invoiceDate: '2026-08-01',
      dueDate: '2026-08-31',
      subtotal: 2000,
      notes: 'Corrected bill'
    });
    assert.equal(patched.status, 200, patched.body?.message);
    assert.equal(patched.body.invoiceNo, 'INV-FIXED');
    assert.equal(patched.body.subtotal, 2000);
    assert.equal(patched.body.vat, 260);
    assert.equal(patched.body.total, 2260);
    assert.equal(patched.body.notes, 'Corrected bill');
    assert.equal(patched.body.status, 'unpaid');
    assert.equal(new Date(new Date(patched.body.invoiceDate).getTime() + 5.75 * 60 * 60 * 1000).toISOString().slice(0, 10), '2026-08-01');

    const got = await request('/api/supplier-invoices/' + inv.body._id, {token: tokenFor(world.owner)});
    assert.equal(got.status, 200);
    assert.equal(got.body.invoiceNo, 'INV-FIXED');
    assert.equal(got.body.total, 2260);
  });

  it('locks amounts after a payment but still allows notes and invoice number', async () => {
    const inv = await createInvoice();
    const paid = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-payment-lock-1'},
      body: {amount: 130, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);

    const blocked = await patchInvoice(inv.body._id, {subtotal: 500, vat: 65, total: 565});
    assert.equal(blocked.status, 409, blocked.body?.message);

    const ok = await patchInvoice(inv.body._id, {invoiceNo: 'INV-PAID-NOTE', notes: 'typo fix'});
    assert.equal(ok.status, 200, ok.body?.message);
    assert.equal(ok.body.invoiceNo, 'INV-PAID-NOTE');
    assert.equal(ok.body.notes, 'typo fix');
    assert.equal(ok.body.total, 1130);
    assert.equal(ok.body.paidAmount, 130);
    assert.equal(ok.body.status, 'partial');
  });

  it('voids an unpaid invoice and preserves an explicit zeroing statement adjustment', async () => {
    const inv = await createInvoice({invoiceNo: 'INV-VOID'});
    const voided = await patchInvoice(inv.body._id, {status: 'void'});
    assert.equal(voided.status, 200, voided.body?.message);
    assert.equal(voided.body.status, 'void');

    const pay = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-payment-void-1'},
      body: {amount: 100, method: 'cash'}
    });
    assert.equal(pay.status, 409);

    const again = await patchInvoice(inv.body._id, {notes: 'nope'});
    assert.equal(again.status, 409);

    const stmt = await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(stmt.status, 200);
    assert.equal(stmt.body.invoiced, 0);
    assert.deepEqual(stmt.body.lines.map(line => line.type), ['invoice', 'invoice_void']);
    assert.deepEqual(stmt.body.lines.map(line => line.balance), [1130, 0]);
  });

  it('cannot void an invoice that already has payments', async () => {
    const inv = await createInvoice({invoiceNo: 'INV-NOP'});
    const paid = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-payment-no-void-1'},
      body: {amount: 130, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    const voided = await patchInvoice(inv.body._id, {status: 'void'});
    assert.equal(voided.status, 409);
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    const inv = await createInvoice({invoiceNo: 'INV-ACL'});
    assert.equal((await patchInvoice(inv.body._id, {notes: 'x'}, {user: world.staffA})).status, 403);
    assert.equal((await request('/api/supplier-invoices/' + inv.body._id, {method: 'PATCH', body: {notes: 'x'}})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/supplier-invoices/' + inv.body._id, {method: 'PATCH', token: guest, body: {notes: 'x'}})).status, 403);

    const other = await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'legacy-invoice-purchasing.test-8' },
      body: {branch: String(world.branchB._id), supplier: String(supplier._id), invoiceNo: 'INV-B', subtotal: 100, vat: 13, total: 113}
    });
    assert.equal(other.status, 201, other.body?.message);
    assert.equal((await patchInvoice(other.body._id, {notes: 'cross'})).status, 403);
    assert.equal((await request('/api/supplier-invoices/' + other.body._id, {token: tokenFor(world.manager)})).status, 403);
  });
});

describe('PATCH /api/purchase-orders/:id/status', () => {
  it('submits a draft, approves it, and then allows receiving', async () => {
    const po = await createPo(400, {draft: true});
    assert.equal(po.status, 201, po.body?.message);
    assert.equal(po.body.status, 'draft');
    const line = po.body.items[0];
    assert.equal((await receive(po.body._id, [{itemId: String(line._id), receivedQty: 10, damagedQty: 0}])).status, 409);

    const forced = await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        status: 'approved',
        items: [{ingredient: String(world.ingredient._id), orderedQty: 10, unit: 'g', unitPrice: 1}],
      }
    });
    // Phase 13: PO schemas are .strict(), so an injected protected field is
    // now rejected outright. Previously it was accepted and silently ignored
    // (the response was 201 with status still 'draft'), which was safe but
    // hid the attempt. Refusing is strictly better; the guarantee that a PO
    // can never be born approved is asserted either way.
    assert.equal(forced.status, 400, 'an injected status must be refused');
    assert.match(forced.body.message, /Unrecognized field|Invalid/i);

    const pending = await patchPoStatus(po.body._id, 'pending', {notes: 'Weekly stock request'});
    assert.equal(pending.status, 200, pending.body?.message);
    assert.equal(pending.body.status, 'pending');
    assert.equal(pending.body.submittedBy._id, String(world.manager._id));
    assert.ok(pending.body.submittedAt);
    assert.equal(pending.body.submissionNote, 'Weekly stock request');
    assert.equal(pending.body.approvalRound, 1);
    assert.equal((await receive(po.body._id, [{itemId: String(line._id), receivedQty: 10, damagedQty: 0}])).status, 409);

    const approved = await patchPoStatus(po.body._id, 'approved', {user: world.owner, notes: 'OK to buy'});
    assert.equal(approved.status, 200, approved.body?.message);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.approvedBy._id, String(world.owner._id));
    assert.ok(approved.body.approvedAt);
    assert.equal(approved.body.approvalNote, 'OK to buy');
    const history = await request('/api/purchase-orders/' + po.body._id + '/approval-history', {token: tokenFor(world.staffA)});
    assert.equal(history.status, 200, history.body?.message);
    assert.deepEqual(history.body.map(event => event.status), ['pending', 'approved']);
    assert.deepEqual(history.body.map(event => event.actor.name), ['Manager', 'Owner']);
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 100, damagedQty: 0}], {key: 'appr-gr'});
    assert.equal(rec.status, 201, rec.body?.message);
    assert.equal(rec.body.purchaseOrder.status, 'partially_received');
  });

  it('rejects a pending PO, keeps it off the report, and blocks receive', async () => {
    const po = await createPo(200, {draft: true});
    await patchPoStatus(po.body._id, 'pending');
    assert.equal((await patchPoStatus(po.body._id, 'rejected', {user: world.owner})).status, 400);
    const rejected = await patchPoStatus(po.body._id, 'rejected', {user: world.owner, notes: 'Too expensive'});
    assert.equal(rejected.status, 200, rejected.body?.message);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(rejected.body.rejectedBy._id, String(world.owner._id));
    assert.ok(rejected.body.rejectedAt);
    assert.equal(rejected.body.rejectionReason, 'Too expensive');
    assert.equal(rejected.body.approvalNote, undefined);
    const line = po.body.items[0];
    assert.equal((await receive(po.body._id, [{itemId: String(line._id), receivedQty: 10, damagedQty: 0}])).status, 409);
    const report = await request('/api/reports/purchasing?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(report.body.purchaseOrders.count, 0);

    const again = await patchPoStatus(po.body._id, 'pending');
    assert.equal(again.status, 200, again.body?.message);
    assert.equal(again.body.status, 'pending');
    assert.equal(again.body.approvalRound, 2);
    assert.equal(again.body.rejectedBy, undefined);
    assert.equal(again.body.rejectionReason, undefined);
  });

  it('prevents manager self-approval while retaining an explicit owner override', async () => {
    const own = await createPo(100, {draft: true});
    const pending = await patchPoStatus(own.body._id, 'pending');
    assert.equal(pending.status, 200, pending.body?.message);
    const denied = await patchPoStatus(own.body._id, 'approved');
    assert.equal(denied.status, 403);
    assert.match(denied.body.message, /cannot approve or reject/i);
    const unchanged = await PurchaseOrder.findById(own.body._id).lean();
    assert.equal(unchanged.status, 'pending');
    assert.equal(await Audit.countDocuments({entity: 'purchase_order', entityId: own.body._id, action: 'po_status'}), 1);
    const reviewer = await User.create({
      name: 'Reviewer', email: 'reviewer@test.com', password: 'hashed', role: 'manager',
      restaurant: world.restaurant.name, restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    const independentlyApproved = await patchPoStatus(own.body._id, 'approved', {user: reviewer, notes: 'Reviewed independently'});
    assert.equal(independentlyApproved.status, 200, independentlyApproved.body?.message);
    assert.equal(independentlyApproved.body.approvedBy._id, String(reviewer._id));

    const ownerPo = await createPo(100, {draft: true, user: world.owner});
    const ownerPending = await patchPoStatus(ownerPo.body._id, 'pending', {user: world.owner});
    const ownerApproved = await patchPoStatus(ownerPo.body._id, 'approved', {user: world.owner});
    assert.equal(ownerPending.status, 200, ownerPending.body?.message);
    assert.equal(ownerApproved.status, 200, ownerApproved.body?.message);
    const approvalAudit = await Audit.findOne({entity: 'purchase_order', entityId: ownerPo.body._id, action: 'po_status', 'after.status': 'approved'}).lean();
    assert.equal(approvalAudit.after.ownerOverride, true);
  });

  it('cannot skip pending or cancel after a receipt', async () => {
    const po = await createPo(100, {draft: true});
    assert.equal((await patchPoStatus(po.body._id, 'approved')).status, 409);
    await patchPoStatus(po.body._id, 'pending');
    await patchPoStatus(po.body._id, 'approved', {user: world.owner});
    const line = po.body.items[0];
    const rec = await receive(po.body._id, [{itemId: String(line._id), receivedQty: 40, damagedQty: 0}], {key: 'appr-gr2'});
    assert.equal(rec.status, 201, rec.body?.message);
    assert.equal((await patchPoStatus(po.body._id, 'cancelled')).status, 409);
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    const po = await createPo(50, {draft: true});
    assert.equal((await patchPoStatus(po.body._id, 'pending', {user: world.staffA})).status, 403);
    assert.equal((await request('/api/purchase-orders/' + po.body._id + '/status', {method: 'PATCH', body: {status: 'pending'}})).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/purchase-orders/' + po.body._id + '/status', {method: 'PATCH', token: guest, body: {status: 'pending'}})).status, 403);

    const other = await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(world.branchB._id),
        supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 10, unit: 'g', unitPrice: 1}],
      }
    });
    assert.equal(other.status, 201, other.body?.message);
    assert.equal((await patchPoStatus(other.body._id, 'pending')).status, 403);
    assert.equal((await request('/api/purchase-orders/' + other.body._id + '/approval-history', {token: tokenFor(world.manager)})).status, 403);
    assert.equal((await request('/api/purchase-orders', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {
        branch: String(world.branchB._id),
        supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 5, unit: 'g', unitPrice: 1}],
      }
    })).status, 403);
  });
});

describe('purchasing E2E workflow', () => {
  it('walks PO → submit → approve → receive → return → invoice → edit → pay → statement → report', async () => {
    const draft = await createPo(1000, {draft: true});
    assert.equal(draft.status, 201, draft.body?.message);
    assert.equal(draft.body.status, 'draft');
    const submitted = await patchPoStatus(draft.body._id, 'pending');
    assert.equal(submitted.body.status, 'pending');
    const po = await patchPoStatus(draft.body._id, 'approved', {user: world.owner});
    assert.equal(po.status, 200, po.body?.message);
    assert.equal(po.body.status, 'approved');
    const line = po.body.items[0];

    const rec = await receive(po.body._id, [{
      itemId: String(line._id),
      receivedQty: 400,
      damagedQty: 50,
      batchNumber: 'LOT-E2E',
      expiryDate: FUTURE_EXPIRY
    }], {notes: 'First truck', key: 'e2e-gr'});
    assert.equal(rec.status, 201, rec.body?.message);
    assert.equal(rec.body.purchaseOrder.status, 'partially_received');
    assert.equal(rec.body.receipt.items[0].acceptedQty, 350);

    const ret = await postReturn(po.body._id, [{itemId: String(line._id), qty: 100}], {reason: 'quality', notes: 'Off smell', key: 'e2e-pr'});
    assert.equal(ret.status, 201, ret.body?.message);
    assert.equal(ret.body.purchaseOrder.items[0].returnedQty, 100);

    const inv = await createInvoice({
      purchaseOrder: String(po.body._id),
      invoiceNo: 'INV-E2E-DRAFT',
      subtotal: 1000,
      vat: 130,
      total: 1130
    });
    assert.equal(inv.status, 201, inv.body?.message);

    const edited = await patchInvoice(inv.body._id, {
      invoiceNo: 'INV-E2E',
      subtotal: 2000,
      notes: 'Corrected after receiving'
    });
    assert.equal(edited.status, 200, edited.body?.message);
    assert.equal(edited.body.invoiceNo, 'INV-E2E');
    assert.equal(edited.body.vat, 260);
    assert.equal(edited.body.total, 2260);

    const paid = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'legacy-payment-e2e-1'},
      body: {amount: 260, method: 'bank', reference: 'E2E-PAY'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    assert.equal(paid.body.invoice.status, 'partial');
    assert.equal(paid.body.invoice.paidAmount, 260);

    const amountLock = await patchInvoice(inv.body._id, {subtotal: 100});
    assert.equal(amountLock.status, 409);

    const stmt = await request('/api/suppliers/' + supplier._id + '/statement?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(stmt.status, 200, stmt.body?.message);
    assert.equal(stmt.body.invoiced, 2260);
    assert.equal(stmt.body.paid, 260);
    // Phase 16: this flow returns 100 units worth 5.65 to the supplier, and a
    // return is a credit. The balance previously ignored it and read 2000,
    // overstating what was owed by the value of goods already sent back.
    assert.equal(stmt.body.returned, 5.65);
    assert.equal(stmt.body.balance, 1994.35);
    assert.deepEqual(stmt.body.outstandingFormula, {
      invoiced: 2260, payments: 260, returns: 5.65, outstanding: 1994.35
    });
    // Three lines now: the return is its own credit on the statement rather
    // than an invisible adjustment.
    assert.equal(stmt.body.lines.length, 3);
    const byType = Object.fromEntries(stmt.body.lines.map(line => [line.type, line]));
    assert.equal(byType.invoice.ref, 'INV-E2E');
    assert.equal(byType.invoice.debit, 2260);
    assert.equal(byType.payment.credit, 260);
    assert.equal(byType.purchase_return.credit, 5.65);
    assert.equal(stmt.body.lines.at(-1).balance, 1994.35, 'the running balance closes at the outstanding amount');

    const report = await request('/api/reports/purchasing?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(report.status, 200, report.body?.message);
    assert.equal(report.body.purchaseOrders.count, 1);
    assert.equal(report.body.purchaseOrders.orderedValue, 56.5);
    assert.equal(report.body.purchaseOrders.receivedQty, 400);
    assert.equal(report.body.purchaseOrders.damagedQty, 50);
    assert.equal(report.body.purchaseOrders.acceptedQty, 350);
    assert.equal(report.body.purchaseOrders.returnedQty, 100);
    assert.equal(report.body.receipts.acceptedValue, 17.5);
    assert.equal(report.body.receipts.damagedValue, 2.5);
    assert.equal(report.body.returns.value, 5);
    assert.equal(report.body.invoices.invoiced, 2260);
    assert.equal(report.body.invoices.vat, 260);
    assert.equal(report.body.invoices.paid, 260);
    assert.equal(report.body.invoices.due, 2000);
    assert.equal(report.body.ledger.purchaseValue, 17.5);
    assert.equal(report.body.ledger.returnValue, 5);
    assert.equal(report.body.ledger.netStockValue, 12.5);
    assert.equal(report.body.bySupplier[0].name, 'Kathmandu Food Suppliers');
    assert.equal(report.body.bySupplier[0].due, 2000);

    const stock = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(stock.quantity, 20000 + 350 - 100);
    const purchaseTx = await InventoryTransaction.find({type: 'PURCHASE', referenceType: 'goods_receipt'});
    const returnTx = await InventoryTransaction.find({type: 'RETURN', referenceType: 'purchase_return'});
    assert.equal(purchaseTx.length, 1);
    assert.equal(purchaseTx[0].changeQty, 350);
    assert.equal(returnTx.length, 1);
    assert.equal(returnTx[0].changeQty, -100);
  });
});
