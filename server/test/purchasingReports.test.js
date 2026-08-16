import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Supplier} from '../src/models/index.js';
import {InventoryTransaction, PurchaseOrder, SupplierInvoice, SupplierPayment} from '../src/models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../src/models/purchasing.js';
import {purchasingReportPeriod} from '../src/services/purchasingReport.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let supplier;
let sequence;
const KATHMANDU_OFFSET_MS = 5.75 * 60 * 60 * 1000;
const kathmanduDay = (offsetDays = 0) => new Date(Date.now() + KATHMANDU_OFFSET_MS + offsetDays * 86400000).toISOString().slice(0, 10);

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Report Test Supplier'});
  sequence = 0;
});

function report(query = {}, user = world.owner) {
  const search = new URLSearchParams({branch: String(world.branchA._id), ...query});
  return request(`/api/reports/purchasing?${search}`, {token: tokenFor(user)});
}

async function createApprovedPo({qty = 10, unitPrice = 2, orderDate = '2026-08-10'} = {}) {
  sequence += 1;
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(world.manager),
    headers: {'Idempotency-Key': `report-po-${sequence}`},
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      orderDate,
      items: [{ingredient: String(world.ingredient._id), orderedQty: qty, unit: 'g', unitPrice}]
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(world.manager), body: {status: 'pending'}
  });
  assert.equal(pending.status, 200, pending.body?.message);
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(world.owner), body: {status: 'approved'}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return approved.body;
}

async function createInvoice(overrides = {}, branch = world.branchA) {
  sequence += 1;
  const response = await request('/api/supplier-invoices', {
    method: 'POST',
    token: tokenFor(branch._id.equals(world.branchA._id) ? world.manager : world.owner),
    headers: {'Idempotency-Key': `report-invoice-${sequence}`},
    body: {
      branch: String(branch._id),
      supplier: String(supplier._id),
      invoiceNo: `REPORT-${sequence}`,
      invoiceDate: '2026-08-01',
      subtotal: 100,
      ...overrides
    }
  });
  assert.equal(response.status, 201, response.body?.message);
  return response.body;
}

async function pay(invoice, overrides = {}) {
  sequence += 1;
  const response = await request(`/api/supplier-invoices/${invoice._id}/payments`, {
    method: 'POST',
    token: tokenFor(world.manager),
    headers: {'Idempotency-Key': `report-payment-${sequence}`},
    body: {amount: 20, method: 'cash', paidAt: '2026-08-10', ...overrides}
  });
  assert.equal(response.status, 201, response.body?.message);
  return response.body.payment;
}

describe('purchasing report periods', () => {
  it('uses strict inclusive Kathmandu days while preserving exact internal ranges', async () => {
    const period = purchasingReportPeriod({from: '2026-08-10', to: '2026-08-10'});
    assert.equal(period.fromDate.toISOString(), '2026-08-09T18:15:00.000Z');
    assert.equal(period.toExclusive.toISOString(), '2026-08-10T18:15:00.000Z');
    assert.equal(period.boundaryMode, 'kathmandu_day');

    const internal = purchasingReportPeriod({
      from: new Date('2026-07-31T18:15:00.000Z'),
      toExclusive: new Date('2026-08-31T18:15:00.000Z')
    });
    assert.equal(internal.fromDate.toISOString(), '2026-07-31T18:15:00.000Z');
    assert.equal(internal.toExclusive.toISOString(), '2026-08-31T18:15:00.000Z');
    assert.equal(internal.boundaryMode, 'instant');

    for (const query of [
      {from: '2026/08/10'},
      {to: '2026-02-30'},
      {from: '2026-08-11', to: '2026-08-10'},
      {to: kathmanduDay(2)},
      {branch: ''},
      {branch: 'not-an-object-id'},
      {unexpected: 'value'}
    ]) {
      const response = await report(query);
      assert.equal(response.status, 400, `${JSON.stringify(query)}: ${response.body?.message}`);
    }
  });

  it('filters each operational entity by its canonical reporting date and reconciles ledger values', async () => {
    let po = await createApprovedPo();
    const received = await request(`/api/purchase-orders/${po._id}/receive`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'report-canonical-receipt'},
      body: {items: [{itemId: String(po.items[0]._id), receivedQty: 10, damagedQty: 0, batchNumber: 'REPORT-LOT'}]}
    });
    assert.equal(received.status, 201, received.body?.message);
    po = received.body.purchaseOrder;
    const returned = await request(`/api/purchase-orders/${po._id}/returns`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'report-canonical-return'},
      body: {items: [{itemId: String(po.items[0]._id), qty: 2}], reason: 'quality', expectedVersion: po.__v}
    });
    assert.equal(returned.status, 201, returned.body?.message);

    const canonical = new Date('2026-08-10T06:00:00.000Z');
    const outsideCreatedAt = new Date('2026-08-12T06:00:00.000Z');
    const poId = new mongoose.Types.ObjectId(po._id);
    const receiptId = new mongoose.Types.ObjectId(received.body.receipt._id);
    const returnId = new mongoose.Types.ObjectId(returned.body.purchaseReturn._id);
    await PurchaseOrder.collection.updateOne({_id: poId}, {$set: {createdAt: outsideCreatedAt}});
    await GoodsReceipt.collection.updateOne({_id: receiptId}, {$set: {receivedAt: canonical, createdAt: outsideCreatedAt}});
    await PurchaseReturn.collection.updateOne({_id: returnId}, {$set: {returnedAt: canonical, createdAt: outsideCreatedAt}});
    await InventoryTransaction.collection.updateMany({
      referenceId: {$in: [receiptId, returnId]}
    }, {$set: {createdAt: canonical}});

    const day = await report({from: '2026-08-10', to: '2026-08-10'});
    assert.equal(day.status, 200, day.body?.message);
    assert.equal(day.body.purchaseOrders.count, 1);
    assert.equal(day.body.receipts.count, 1);
    assert.equal(day.body.returns.count, 1);
    assert.equal(day.body.receipts.acceptedValue, 20);
    assert.equal(day.body.returns.stockValue, 4);
    assert.equal(day.body.ledger.netStockValue, 16);
    assert.equal(day.body.reconciliation.balanced, true);
    assert.deepEqual(day.body.period.dateFields, {
      purchaseOrders: 'orderDate', receipts: 'receivedAt', returns: 'returnedAt',
      invoices: 'invoiceDate/voidedAt', payments: 'paidAt/reversedAt', ledger: 'createdAt'
    });

    await InventoryTransaction.collection.updateOne(
      {referenceId: receiptId, type: 'PURCHASE'},
      {$set: {totalCost: 19}}
    );
    const mismatch = await report({from: '2026-08-10', to: '2026-08-10'});
    assert.equal(mismatch.status, 200, mismatch.body?.message);
    assert.equal(mismatch.body.reconciliation.balanced, false);
    assert.equal(mismatch.body.reconciliation.receiptsToPurchaseLedger.difference, 1);
    assert.ok(mismatch.body.dataQuality.warnings.includes('Accepted receipt value does not match purchase ledger value for the period'));

    const nextDay = await report({from: '2026-08-11', to: '2026-08-11'});
    assert.equal(nextDay.status, 200, nextDay.body?.message);
    assert.equal(nextDay.body.activity.empty, true);
  });
});

describe('purchasing report financial history', () => {
  it('includes period payments against older invoices and exposes closing supplier liability', async () => {
    const invoice = await createInvoice();
    await pay(invoice);

    const response = await report({from: '2026-08-10', to: '2026-08-10'});
    assert.equal(response.status, 200, response.body?.message);
    assert.equal(response.body.invoices.count, 0);
    assert.equal(response.body.invoices.grossInvoiced, 0);
    assert.equal(response.body.invoices.grossPaid, 20);
    assert.equal(response.body.invoices.paid, 20);
    assert.equal(response.body.invoices.openingDue, 113);
    assert.equal(response.body.invoices.activityChange, -20);
    assert.equal(response.body.invoices.due, 93);
    assert.equal(response.body.bySupplier[0].grossInvoiced, 0);
    assert.equal(response.body.bySupplier[0].paid, 20);
    assert.equal(response.body.bySupplier[0].openingDue, 113);
    assert.equal(response.body.bySupplier[0].due, 93);
  });

  it('reconstructs payment reversals at the requested cutoff instead of trusting current status', async () => {
    const invoice = await createInvoice();
    const payment = await pay(invoice);
    const reversed = await request(`/api/supplier-payments/${payment._id}/reverse`, {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'report-reverse-history'},
      body: {reason: 'Purchasing report historical test'}
    });
    assert.equal(reversed.status, 201, reversed.body?.message);
    await SupplierPayment.collection.updateOne(
      {_id: new mongoose.Types.ObjectId(payment._id)},
      {$set: {reversedAt: new Date('2026-08-16T06:00:00.000Z')}}
    );

    const before = await report({from: '2026-08-10', to: '2026-08-15'});
    assert.equal(before.status, 200, before.body?.message);
    assert.equal(before.body.invoices.paid, 20);
    assert.equal(before.body.invoices.reversed, 0);
    assert.equal(before.body.invoices.due, 93);

    const reversalDay = await report({from: '2026-08-16', to: '2026-08-16'});
    assert.equal(reversalDay.status, 200, reversalDay.body?.message);
    assert.equal(reversalDay.body.invoices.grossPaid, 0);
    assert.equal(reversalDay.body.invoices.reversed, 20);
    assert.equal(reversalDay.body.invoices.paid, -20);
    assert.equal(reversalDay.body.invoices.due, 113);
  });

  it('reports backdated invoice voids as explicit period credits with historical as-of balances', async () => {
    const invoice = await createInvoice({invoiceDate: '2026-08-10'});
    const voided = await request(`/api/supplier-invoices/${invoice._id}`, {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'void', expectedVersion: invoice.__v}
    });
    assert.equal(voided.status, 200, voided.body?.message);
    await SupplierInvoice.collection.updateOne(
      {_id: new mongoose.Types.ObjectId(invoice._id)},
      {$set: {voidedAt: new Date('2026-08-16T06:00:00.000Z')}}
    );

    const historical = await report({to: '2026-08-15'});
    assert.equal(historical.status, 200, historical.body?.message);
    assert.equal(historical.body.invoices.grossInvoiced, 113);
    assert.equal(historical.body.invoices.voided, 0);
    assert.equal(historical.body.invoices.due, 113);

    const voidDay = await report({from: '2026-08-16', to: '2026-08-16'});
    assert.equal(voidDay.status, 200, voidDay.body?.message);
    assert.equal(voidDay.body.invoices.grossInvoiced, 0);
    assert.equal(voidDay.body.invoices.voided, 113);
    assert.equal(voidDay.body.invoices.invoiced, -113);
    assert.equal(voidDay.body.invoices.due, 0);
  });
});

describe('purchasing report authorization and tenant scope', () => {
  it('supports restaurant-wide owner scope while enforcing manager branch and role boundaries', async () => {
    await createInvoice({invoiceNo: 'KTM-REPORT'});
    await createInvoice({invoiceNo: 'LTP-REPORT', subtotal: 200}, world.branchB);

    const ownerAll = await request('/api/reports/purchasing', {token: tokenFor(world.owner)});
    assert.equal(ownerAll.status, 200, ownerAll.body?.message);
    assert.equal(ownerAll.body.scope, 'restaurant');
    assert.equal(ownerAll.body.branch, null);
    assert.equal(ownerAll.body.invoices.due, 339);

    const managerDefault = await request('/api/reports/purchasing', {token: tokenFor(world.manager)});
    assert.equal(managerDefault.status, 200, managerDefault.body?.message);
    assert.equal(managerDefault.body.scope, 'branch');
    assert.equal(managerDefault.body.branch._id, String(world.branchA._id));
    assert.equal(managerDefault.body.invoices.due, 113);

    assert.equal((await report({}, world.staffA)).status, 403);
    assert.equal((await request(`/api/reports/purchasing?branch=${world.branchB._id}`, {token: tokenFor(world.manager)})).status, 403);
    assert.equal((await request('/api/reports/purchasing')).status, 401);
  });
});
