import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Supplier} from '../src/models/index.js';
import {InventoryBalance, InventoryTransaction, PurchaseOrder} from '../src/models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../src/models/purchasing.js';
import {acceptedQty, remainingQty} from '../src/services/receiving.js';
import {returnableQty} from '../src/services/returns.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

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
  supplier = await Supplier.create({name: 'Kathmandu Food Suppliers', contact: '9800000000'});
});

function createPo(orderedQty = 1000, extras = {}) {
  return request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(world.manager),
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty, unit: 'g', unitPrice: 0.05}],
      total: orderedQty * 0.05,
      ...extras
    }
  });
}

function receive(poId, items, extras = {}) {
  return request('/api/purchase-orders/' + poId + '/receive', {
    method: 'POST',
    token: tokenFor(extras.user || world.manager),
    headers: extras.key ? {'Idempotency-Key': extras.key} : {},
    body: {items, notes: extras.notes}
  });
}

function postReturn(poId, items, extras = {}) {
  return request('/api/purchase-orders/' + poId + '/returns', {
    method: 'POST',
    token: tokenFor(extras.user || world.manager),
    headers: extras.key ? {'Idempotency-Key': extras.key} : {},
    body: {items, reason: extras.reason || 'quality', notes: extras.notes}
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
      expiryDate: '2026-12-31'
    }], {notes: 'First truck', key: 'gr-1'});
    assert.equal(res.status, 201, res.body?.message);
    assert.equal(res.body.purchaseOrder.status, 'partially_received');
    assert.equal(res.body.receipt.items[0].acceptedQty, 350);
    assert.equal(res.body.receipt.notes, 'First truck');
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(after.quantity, before.quantity + 350);
    assert.equal(after.batchNumber, 'LOT-A');
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
    const other = await Supplier.create({name: 'Other Supplier'});
    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {branch: String(world.branchA._id), supplier: String(supplier._id), invoiceNo: 'A1', subtotal: 100, vat: 13, total: 113}
    });
    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {branch: String(world.branchA._id), supplier: String(other._id), invoiceNo: 'B1', subtotal: 500, vat: 65, total: 565}
    });
    await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(world.owner),
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
