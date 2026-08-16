import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {io as connectIo} from 'socket.io-client';
import {Audit} from '../src/models/index.js';
import {
  InventoryBalance,
  InventoryBatch,
  InventoryTransaction,
  PurchaseOrder,
  SupplierInvoice,
  SupplierPayment
} from '../src/models/operations.js';
import {GoodsReceipt, PurchaseReturn} from '../src/models/purchasing.js';
import {SupplierIngredient, SupplierPriceHistory} from '../src/models/supplierCatalog.js';
import {ensureOperationalIndexes} from '../src/services/startup.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let baseUrl;
let world;
const sockets = [];

before(async () => {
  ({baseUrl} = await startTestApp());
  await ensureOperationalIndexes();
  await clearDb();
  world = await seedWorld();
});

after(async () => {
  for (const socket of sockets) socket.disconnect();
  await stopTestApp();
});

function expectStatus(response, status) {
  assert.equal(response.status, status, response.body?.message || JSON.stringify(response.body));
  return response.body;
}

async function connectBranch(user, branch) {
  const events = [];
  const socket = connectIo(baseUrl, {
    auth: {token: tokenFor(user), branch: String(branch._id)},
    transports: ['websocket'],
    reconnection: false
  });
  sockets.push(socket);
  socket.on('purchasing:update', event => events.push(event));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 3000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Branch join timed out')), 3000);
    socket.emit('join:branch', String(branch._id), result => {
      clearTimeout(timer);
      if (!result?.ok) reject(new Error(result?.message || 'Branch join failed'));
      else resolve();
    });
  });
  return {socket, events};
}

async function waitFor(predicate, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for realtime delivery');
}

describe('Phase 1 purchasing end-to-end lifecycle', () => {
  it('connects supplier catalog through payment, reporting, inventory evidence and scoped realtime delivery', async () => {
    const managerA = await connectBranch(world.manager, world.branchA);
    const staffA = await connectBranch(world.staffA, world.branchA);
    const staffB = await connectBranch(world.staffB, world.branchB);
    const managerToken = tokenFor(world.manager);
    const ownerToken = tokenFor(world.owner);

    const supplier = expectStatus(await request('/api/suppliers', {
      method: 'POST',
      token: managerToken,
      body: {
        name: '  Himalayan   Provisions  ',
        contact: '01-5550100',
        address: 'Kalimati, Kathmandu',
        paymentTerms: 'Net 14',
        reason: 'Approved for the rice program'
      }
    }), 201);
    assert.equal(supplier.name, 'Himalayan Provisions');
    assert.equal(supplier.__v, 0);

    const catalog = expectStatus(await request('/api/supplier-catalog', {
      method: 'POST',
      token: managerToken,
      body: {
        supplier: supplier._id,
        ingredient: String(world.ingredient._id),
        supplierSku: 'HP-RICE-1KG',
        purchaseUnit: 'bag',
        conversionFactor: 1000,
        currentPrice: 1000,
        priceIncludesVat: false,
        vatRate: 13,
        minOrderQty: 1,
        leadDays: 2,
        reason: 'Opening supplier quotation'
      }
    }), 201);
    assert.equal(catalog.baseUnit, 'g');
    assert.equal(catalog.baseUnitPrice, 1);

    const poInput = {
      branch: String(world.branchA._id),
      supplier: supplier._id,
      orderDate: '2026-08-16',
      expectedDeliveryDate: '2026-08-18',
      notes: 'Phase 1 replenishment lifecycle',
      items: [{
        catalogItem: catalog._id,
        ingredient: String(world.ingredient._id),
        purchaseQty: 1
      }]
    };
    const createdPo = expectStatus(await request('/api/purchase-orders', {
      method: 'POST', token: managerToken, headers: {'Idempotency-Key': 'phase1-po'}, body: poInput
    }), 201);
    assert.match(createdPo.poNo, /^PO-KTM-2026-\d{6}$/);
    assert.equal(createdPo.status, 'draft');
    assert.equal(createdPo.items[0].orderedQty, 1000);
    assert.equal(createdPo.items[0].unit, 'g');
    assert.equal(createdPo.items[0].unitPrice, 1);
    assert.deepEqual(
      {subtotal: createdPo.subtotal, vat: createdPo.vat, total: createdPo.total},
      {subtotal: 1000, vat: 130, total: 1130}
    );
    const poReplay = expectStatus(await request('/api/purchase-orders', {
      method: 'POST', token: managerToken, headers: {'Idempotency-Key': 'phase1-po'}, body: poInput
    }), 200);
    assert.equal(poReplay._id, createdPo._id);

    const pending = expectStatus(await request(`/api/purchase-orders/${createdPo._id}/status`, {
      method: 'PATCH', token: managerToken,
      body: {status: 'pending', notes: 'Submitted for owner approval', expectedVersion: createdPo.__v}
    }), 200);
    assert.equal(pending.status, 'pending');
    const approved = expectStatus(await request(`/api/purchase-orders/${createdPo._id}/status`, {
      method: 'PATCH', token: ownerToken,
      body: {status: 'approved', notes: 'Approved within budget', expectedVersion: pending.__v}
    }), 200);
    assert.equal(approved.status, 'approved');
    const approvalHistory = expectStatus(await request(`/api/purchase-orders/${createdPo._id}/approval-history`, {
      token: managerToken
    }), 200);
    assert.deepEqual(approvalHistory.map(item => item.status), ['pending', 'approved']);

    const receiveInput = {
      expectedVersion: approved.__v,
      notes: 'One damaged inner pack rejected at the dock',
      items: [{
        itemId: String(approved.items[0]._id),
        receivedQty: 1000,
        damagedQty: 100,
        damageReason: 'packaging_damage',
        damageNotes: 'Inner liner torn during transport',
        batchNumber: 'HP-LOT-2026-08',
        expiryDate: '2027-08-31'
      }]
    };
    const received = expectStatus(await request(`/api/purchase-orders/${approved._id}/receive`, {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-receipt'}, body: receiveInput
    }), 201);
    assert.equal(received.purchaseOrder.status, 'received');
    assert.equal(received.receipt.items[0].acceptedQty, 900);
    assert.equal(received.receipt.acceptedValue, 900);
    assert.equal(received.receipt.damagedValue, 100);
    const receiptReplay = expectStatus(await request(`/api/purchase-orders/${approved._id}/receive`, {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-receipt'}, body: receiveInput
    }), 200);
    assert.equal(receiptReplay.duplicate, true);
    assert.equal(receiptReplay.receipt._id, received.receipt._id);

    const returnOptions = expectStatus(await request(`/api/purchase-orders/${approved._id}/return-options`, {
      token: managerToken
    }), 200);
    const returnBatch = returnOptions.items[0].batches[0];
    assert.equal(returnBatch.batchNumber, 'HP-LOT-2026-08');
    assert.equal(returnBatch.availableQty, 900);
    const returnInput = {
      reason: 'quality',
      notes: 'Supplier accepted a quality return',
      expectedVersion: received.purchaseOrder.__v,
      items: [{
        itemId: String(received.purchaseOrder.items[0]._id),
        batchId: String(returnBatch.batchId),
        qty: 100
      }]
    };
    const returned = expectStatus(await request(`/api/purchase-orders/${approved._id}/returns`, {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-return'}, body: returnInput
    }), 201);
    assert.equal(returned.purchaseReturn.subtotal, 100);
    assert.equal(returned.purchaseReturn.vat, 13);
    assert.equal(returned.purchaseReturn.total, 113);
    const returnReplay = expectStatus(await request(`/api/purchase-orders/${approved._id}/returns`, {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-return'}, body: returnInput
    }), 200);
    assert.equal(returnReplay.duplicate, true);
    assert.equal(returnReplay.purchaseReturn._id, returned.purchaseReturn._id);

    const invoiceInput = {
      branch: String(world.branchA._id),
      supplier: supplier._id,
      purchaseOrder: approved._id,
      invoiceNo: 'HP-INV-2026-0816',
      invoiceDate: '2026-08-16',
      dueDate: '2026-08-30',
      subtotal: 800,
      priceIncludesVat: false,
      vatRate: 13,
      notes: 'Invoice net of receiving damage and posted return'
    };
    const invoice = expectStatus(await request('/api/supplier-invoices', {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-invoice'}, body: invoiceInput
    }), 201);
    assert.equal(invoice.matching.status, 'matched');
    assert.equal(invoice.matching.receivedSubtotal, 900);
    assert.equal(invoice.matching.returnedSubtotal, 100);
    assert.equal(invoice.matching.availableSubtotal, 800);
    assert.equal(invoice.total, 904);
    const invoiceReplay = expectStatus(await request('/api/supplier-invoices', {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-invoice'}, body: invoiceInput
    }), 200);
    assert.equal(invoiceReplay.duplicate, true);
    assert.equal(invoiceReplay._id, invoice._id);

    const paymentInput = {
      amount: 904,
      method: 'bank',
      reference: 'NCHL-PHASE1-0001',
      paidAt: '2026-08-16',
      expectedInvoiceVersion: invoice.__v
    };
    const paid = expectStatus(await request(`/api/supplier-invoices/${invoice._id}/payments`, {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-payment'}, body: paymentInput
    }), 201);
    assert.equal(paid.invoice.status, 'paid');
    assert.equal(paid.invoice.paidAmount, 904);
    assert.match(paid.payment.paymentNo, /^PAY-KTM-2026-\d{6}$/);
    const paymentReplay = expectStatus(await request(`/api/supplier-invoices/${invoice._id}/payments`, {
      method: 'POST', token: managerToken,
      headers: {'Idempotency-Key': 'phase1-payment'}, body: paymentInput
    }), 200);
    assert.equal(paymentReplay.duplicate, true);
    assert.equal(paymentReplay.payment._id, paid.payment._id);

    const statement = expectStatus(await request(
      `/api/suppliers/${supplier._id}/statement?branch=${world.branchA._id}&from=2026-08-16&to=2026-08-16`,
      {token: ownerToken}
    ), 200);
    assert.equal(statement.invoiced, 904);
    assert.equal(statement.paid, 904);
    assert.equal(statement.balance, 0);
    assert.equal(statement.reconciliation.balanced, true);
    assert.deepEqual(statement.lines.map(line => line.type), ['invoice', 'payment']);

    const report = expectStatus(await request(
      `/api/reports/purchasing?branch=${world.branchA._id}&from=2026-08-16&to=2026-08-16`,
      {token: ownerToken}
    ), 200);
    assert.equal(report.purchaseOrders.count, 1);
    assert.equal(report.receipts.count, 1);
    assert.equal(report.receipts.acceptedQty, 900);
    assert.equal(report.receipts.damagedQty, 100);
    assert.equal(report.returns.count, 1);
    assert.equal(report.returns.qty, 100);
    assert.equal(report.invoices.grossInvoiced, 904);
    assert.equal(report.invoices.grossPaid, 904);
    assert.equal(report.invoices.due, 0);
    assert.equal(report.invoices.matching.byStatus.matched, 1);
    assert.deepEqual(
      {purchase: report.ledger.purchaseValue, returned: report.ledger.returnValue, net: report.ledger.netStockValue},
      {purchase: 900, returned: 100, net: 800}
    );
    assert.equal(report.reconciliation.balanced, true);
    assert.deepEqual(report.dataQuality.warnings, []);

    const [storedPo, receipt, purchaseReturn, storedInvoice, storedPayment, catalogCount, historyCount] = await Promise.all([
      PurchaseOrder.findById(approved._id).lean(),
      GoodsReceipt.findById(received.receipt._id).lean(),
      PurchaseReturn.findById(returned.purchaseReturn._id).lean(),
      SupplierInvoice.findById(invoice._id).lean(),
      SupplierPayment.findById(paid.payment._id).lean(),
      SupplierIngredient.countDocuments({_id: catalog._id}),
      SupplierPriceHistory.countDocuments({catalogItem: catalog._id})
    ]);
    assert.equal(storedPo.items[0].returnedQty, 100);
    assert.equal(receipt.items[0].damageDisposition, 'rejected_at_receiving');
    assert.equal(String(purchaseReturn.items[0].goodsReceipt), String(receipt._id));
    assert.equal(storedInvoice.status, 'paid');
    assert.equal(storedPayment.status, 'posted');
    assert.equal(catalogCount, 1);
    assert.equal(historyCount, 1);

    const batch = await InventoryBatch.findById(returnBatch.batchId).lean();
    const balance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(batch.quantity, 800);
    assert.equal(balance.quantity, 20800);
    const movements = await InventoryTransaction.find({
      referenceId: {$in: [receipt._id, purchaseReturn._id]},
      type: {$in: ['PURCHASE', 'RETURN']}
    }).sort({createdAt: 1}).lean();
    assert.deepEqual(movements.map(item => item.changeQty), [900, -100]);
    assert.deepEqual(movements.map(item => item.newQty), [20900, 20800]);
    assert.ok(movements.every(item =>
      item.branch && item.ingredient && item.user && item.reason && item.referenceType
      && item.referenceId && item.idempotencyKey && Number.isFinite(item.previousQty)
      && Number.isFinite(item.changeQty) && Number.isFinite(item.newQty)
      && Number.isFinite(item.unitCost) && item.createdAt
    ));
    assert.ok(await Audit.countDocuments({restaurant: world.restaurant._id, user: {$in: [world.manager._id, world.owner._id]}}) >= 9);

    await waitFor(() => managerA.events.some(event => event.reason === 'invoice_pay'));
    const managerReasons = managerA.events.map(event => event.reason);
    for (const reason of [
      'catalog_supplier_create', 'catalog_create', 'po_create', 'po_status',
      'receive', 'return', 'invoice_create', 'invoice_pay'
    ]) assert.ok(managerReasons.includes(reason), `manager did not receive ${reason}`);
    assert.ok(managerA.events.every(event =>
      event.schemaVersion === 1 && event.eventId && event.occurredAt && event.branch === String(world.branchA._id)
    ));

    const staffAReasons = staffA.events.map(event => event.reason);
    assert.ok(staffAReasons.includes('receive'));
    assert.ok(staffAReasons.includes('return'));
    assert.ok(!staffAReasons.includes('invoice_create'));
    assert.ok(!staffAReasons.includes('invoice_pay'));
    const staffBReasons = staffB.events.map(event => event.reason);
    assert.ok(staffBReasons.includes('catalog_supplier_create'));
    assert.ok(staffBReasons.includes('catalog_create'));
    assert.ok(!staffBReasons.includes('po_create'));
    assert.ok(!staffBReasons.includes('receive'));
    assert.ok(!staffBReasons.includes('return'));
    assert.ok(!staffBReasons.includes('invoice_create'));
    assert.ok(!staffBReasons.includes('invoice_pay'));

    assert.equal(await PurchaseOrder.countDocuments(), 1);
    assert.equal(await GoodsReceipt.countDocuments(), 1);
    assert.equal(await PurchaseReturn.countDocuments(), 1);
    assert.equal(await SupplierInvoice.countDocuments(), 1);
    assert.equal(await SupplierPayment.countDocuments(), 1);
  });
});
