import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Supplier} from '../src/models/index.js';
import {InventoryBalance, InventoryTransaction, PurchaseOrder} from '../src/models/operations.js';
import {GoodsReceipt} from '../src/models/purchasing.js';
import {acceptedQty, remainingQty} from '../src/services/receiving.js';
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

describe('receiving helpers', () => {
  it('computes remaining and accepted quantities', () => {
    assert.equal(remainingQty({orderedQty: 1000, receivedQty: 400}), 600);
    assert.equal(acceptedQty(100, 15), 85);
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
