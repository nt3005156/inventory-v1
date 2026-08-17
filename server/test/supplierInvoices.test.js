import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, Supplier, User} from '../src/models/index.js';
import {Branch, PurchaseOrder, Restaurant, SupplierInvoice, SupplierPayment} from '../src/models/operations.js';
import {ensureSupplierInvoiceIndexes} from '../src/services/supplierInvoiceMigration.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';
import {daysAgo} from './dates.js';


// Invoice dates must not be in the future, and the list filter window has to
// include FILTER-A while excluding FILTER-B.
const INVOICE_DATE = daysAgo(2);
const BEFORE_INVOICE = daysAgo(3);
const FILTER_FROM = daysAgo(16);
const FILTER_TO = daysAgo(15);
const FILTER_OUTSIDE = daysAgo(7);

let world;
let supplier;
let sequence = 0;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Invoice Test Supplier'});
  sequence = 0;
});

function postInvoice(body = {}, {user = world.manager, key = `invoice-${++sequence}`} = {}) {
  return request('/api/supplier-invoices', {
    method: 'POST',
    token: tokenFor(user),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      invoiceNo: `SUP-${sequence || 1}`,
      invoiceDate: INVOICE_DATE,
      subtotal: 1000,
      ...body
    }
  });
}

async function createApprovedPo({orderedQty = 100, unitPrice = 10, supplierId = supplier._id} = {}) {
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(world.manager),
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplierId),
      items: [{ingredient: String(world.ingredient._id), orderedQty, unit: 'g', unitPrice}]
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  const submitted = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH',
    token: tokenFor(world.manager),
    body: {status: 'pending', expectedVersion: created.body.__v}
  });
  assert.equal(submitted.status, 200, submitted.body?.message);
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH',
    token: tokenFor(world.owner),
    body: {status: 'approved', expectedVersion: submitted.body.__v}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return approved.body;
}

async function receiveAll(po, key = 'invoice-receipt') {
  const received = await request(`/api/purchase-orders/${po._id}/receive`, {
    method: 'POST',
    token: tokenFor(world.manager),
    headers: {'Idempotency-Key': key},
    body: {
      expectedVersion: po.__v,
      items: [{itemId: String(po.items[0]._id), receivedQty: po.items[0].orderedQty}]
    }
  });
  assert.equal(received.status, 201, received.body?.message);
  return received.body;
}

describe('supplier invoice migration and indexes', () => {
  it('backfills legacy ownership, financial metadata and collision-safe normalized identities', async () => {
    const indexes = await SupplierInvoice.collection.indexes();
    for (const index of indexes) if (index.name !== '_id_') await SupplierInvoice.collection.dropIndex(index.name);
    const createdAt = new Date('2025-01-01T00:00:00.000Z');
    await SupplierInvoice.collection.insertMany([
      {
        branch: world.branchA._id,
        supplier: supplier._id,
        invoiceNo: ' legacy  10 ',
        invoiceDate: createdAt,
        subtotal: 100,
        vat: 13,
        total: 113,
        paidAmount: 0,
        status: 'unpaid',
        createdBy: world.manager._id,
        createdAt,
        updatedAt: createdAt
      },
      {
        branch: world.branchA._id,
        supplier: supplier._id,
        invoiceNo: 'LEGACY 10',
        invoiceDate: createdAt,
        subtotal: 200,
        vat: 26,
        total: 226,
        paidAmount: 26,
        status: 'partial',
        createdBy: world.manager._id,
        createdAt: new Date(createdAt.getTime() + 1000),
        updatedAt: createdAt
      }
    ]);

    const result = await ensureSupplierInvoiceIndexes();
    assert.equal(result.migrated, 2);
    assert.equal(result.normalizedCollisions, 1);
    const rows = await SupplierInvoice.find().sort({createdAt: 1}).lean();
    assert.equal(rows.length, 2);
    assert.equal(String(rows[0].restaurant), String(world.restaurant._id));
    assert.equal(rows[0].currency, 'NPR');
    assert.equal(rows[0].vatRate, 13);
    assert.equal(rows[0].matching.status, 'unlinked');
    assert.equal(String(rows[0].updatedBy), String(world.manager._id));
    assert.equal(rows[0].invoiceNoNormalized, 'LEGACY 10');
    assert.match(rows[1].invoiceNoNormalized, /^LEGACY 10 #LEGACY-/);
    assert.notEqual(rows[0].invoiceNoNormalized, rows[1].invoiceNoNormalized);
    const indexNames = new Set((await SupplierInvoice.collection.indexes()).map(index => index.name));
    assert.ok(indexNames.has('supplier_invoice_restaurant_supplier_number'));
    assert.ok(indexNames.has('supplier_invoice_restaurant_idempotency'));
    assert.ok(indexNames.has('supplier_invoice_restaurant_branch_report_date'));
    assert.ok(indexNames.has('supplier_invoice_statement_scope_date'));
    assert.ok(indexNames.has('supplier_invoice_statement_branch_date'));
    const rerun = await ensureSupplierInvoiceIndexes();
    assert.equal(rerun.migrated, 0);
    assert.equal(rerun.normalizedCollisions, 0);
  });

  it('aborts rather than guessing ownership for an orphaned legacy invoice', async () => {
    const orphanId = new mongoose.Types.ObjectId();
    await SupplierInvoice.collection.insertOne({
      _id: orphanId,
      invoiceNo: 'ORPHAN-1',
      subtotal: 10,
      total: 11.3,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    await assert.rejects(ensureSupplierInvoiceIndexes(), /cannot safely migrate ownership or invoice data/i);
    const unchanged = await SupplierInvoice.collection.findOne({_id: orphanId});
    assert.equal(unchanged.restaurant, undefined);
  });

  it('rejects invalid legacy financial data and cross-restaurant audit actors', async () => {
    const invalidFinancialId = new mongoose.Types.ObjectId();
    const base = {
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      supplier: supplier._id,
      subtotal: 10,
      vat: 1.3,
      total: 11.3,
      invoiceDate: new Date(`${FILTER_FROM}T00:00:00.000Z`),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await SupplierInvoice.collection.insertOne({
      ...base,
      _id: invalidFinancialId,
      invoiceNo: 'INVALID-PAID',
      paidAmount: 20,
      createdBy: world.manager._id,
      updatedBy: world.manager._id
    });
    await assert.rejects(ensureSupplierInvoiceIndexes(), /cannot safely migrate ownership or invoice data/i);
    assert.equal((await SupplierInvoice.collection.findOne({_id: invalidFinancialId})).identityVersion, undefined);
    await SupplierInvoice.collection.deleteOne({_id: invalidFinancialId});

    const otherRestaurant = await Restaurant.create({name: 'Migration Actor Restaurant'});
    const otherOwner = await User.create({
      name: 'Migration Actor',
      email: 'migration-actor@test.com',
      password: 'x',
      role: 'owner',
      restaurantId: otherRestaurant._id
    });
    const invalidActorId = new mongoose.Types.ObjectId();
    await SupplierInvoice.collection.insertOne({
      ...base,
      _id: invalidActorId,
      invoiceNo: 'INVALID-ACTOR',
      paidAmount: 0,
      createdBy: otherOwner._id,
      updatedBy: otherOwner._id
    });
    await assert.rejects(ensureSupplierInvoiceIndexes(), /cannot safely migrate ownership or invoice data/i);
    assert.equal((await SupplierInvoice.collection.findOne({_id: invalidActorId})).identityVersion, undefined);
  });

  it('canonicalizes BSON string references and rejects cross-restaurant legacy references without partial migration', async () => {
    const otherRestaurant = await Restaurant.create({name: 'Migration Reference Restaurant'});
    const otherSupplier = await Supplier.create({restaurant: otherRestaurant._id, name: 'Foreign Migration Supplier'});
    const validId = new mongoose.Types.ObjectId();
    const invalidId = new mongoose.Types.ObjectId();
    const base = {
      restaurant: String(world.restaurant._id),
      branch: String(world.branchA._id),
      invoiceDate: new Date(`${FILTER_FROM}T00:00:00.000Z`),
      subtotal: 100,
      vat: 13,
      total: 113,
      paidAmount: 0,
      status: 'unpaid',
      createdBy: String(world.manager._id),
      createdAt: new Date(),
      updatedAt: new Date()
    };
    await SupplierInvoice.collection.insertMany([
      {...base, _id: validId, supplier: String(supplier._id), invoiceNo: 'STRING-REFS'},
      {...base, _id: invalidId, supplier: otherSupplier._id, invoiceNo: 'FOREIGN-REF'}
    ]);

    await assert.rejects(ensureSupplierInvoiceIndexes(), /cannot safely migrate ownership or invoice data/i);
    assert.equal((await SupplierInvoice.collection.findOne({_id: validId})).identityVersion, undefined);
    await SupplierInvoice.collection.deleteOne({_id: invalidId});

    const result = await ensureSupplierInvoiceIndexes();
    assert.equal(result.migrated, 1);
    const migrated = await SupplierInvoice.collection.findOne({_id: validId});
    assert.ok(migrated.restaurant instanceof mongoose.Types.ObjectId);
    assert.ok(migrated.branch instanceof mongoose.Types.ObjectId);
    assert.ok(migrated.supplier instanceof mongoose.Types.ObjectId);
    assert.ok(migrated.createdBy instanceof mongoose.Types.ObjectId);
    assert.ok(migrated.updatedBy instanceof mongoose.Types.ObjectId);
    assert.equal(String(migrated.restaurant), String(world.restaurant._id));
    assert.equal(String(migrated.supplier), String(supplier._id));

    // Referential validation also covers malformed rows that already carry the
    // current identity version and therefore need no field backfill.
    await SupplierInvoice.collection.updateOne({_id: validId}, {$set: {supplier: otherSupplier._id}});
    await assert.rejects(ensureSupplierInvoiceIndexes(), /cannot safely migrate ownership or invoice data/i);
    assert.equal((await SupplierInvoice.collection.findOne({_id: validId})).identityVersion, 2);
  });
});

describe('POST /api/supplier-invoices', () => {
  it('calculates authoritative Nepal VAT for exclusive and inclusive supplier documents', async () => {
    const exclusive = await postInvoice({invoiceNo: 'VAT-EXCLUSIVE', subtotal: 1000, vatRate: 13});
    assert.equal(exclusive.status, 201, exclusive.body?.message);
    assert.equal(exclusive.body.currency, 'NPR');
    assert.equal(exclusive.body.subtotal, 1000);
    assert.equal(exclusive.body.vat, 130);
    assert.equal(exclusive.body.total, 1130);
    assert.equal(exclusive.body.priceIncludesVat, false);
    assert.equal(exclusive.body.matching.status, 'unlinked');

    const inclusive = await postInvoice({
      invoiceNo: 'VAT-INCLUSIVE',
      subtotal: undefined,
      total: 1130,
      priceIncludesVat: true,
      vatRate: 13
    });
    assert.equal(inclusive.status, 201, inclusive.body?.message);
    assert.equal(inclusive.body.subtotal, 1000);
    assert.equal(inclusive.body.vat, 130);
    assert.equal(inclusive.body.total, 1130);
    assert.equal(inclusive.body.priceIncludesVat, true);

    const mismatch = await postInvoice({invoiceNo: 'VAT-FORGED', subtotal: 1000, vat: 1, total: 1001});
    assert.equal(mismatch.status, 400);
    assert.match(mismatch.body.message, /VAT does not match/);
    const badDueDate = await postInvoice({invoiceNo: 'BAD-DATE', dueDate: BEFORE_INVOICE});
    assert.equal(badDueDate.status, 400);
    assert.match(badDueDate.body.message, /Due date/);
  });

  it('requires idempotency, replays the same request once, and rejects key reuse or duplicate normalized numbers', async () => {
    const missingKey = await postInvoice({invoiceNo: 'NO-KEY'}, {key: null});
    assert.equal(missingKey.status, 400);
    assert.match(missingKey.body.message, /Idempotency-Key/);

    const body = {invoiceNo: '  supplier   abc-10 ', invoiceDate: undefined, subtotal: 500};
    const first = await postInvoice(body, {key: 'stable-invoice-key'});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(first.body.duplicate, false);
    const replay = await postInvoice(body, {key: 'stable-invoice-key'});
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body._id, first.body._id);
    assert.equal(await SupplierInvoice.countDocuments(), 1);
    assert.equal(await Audit.countDocuments({entity: 'supplier_invoice', action: 'create'}), 1);

    const conflict = await postInvoice({invoiceNo: 'DIFFERENT', subtotal: 500}, {key: 'stable-invoice-key'});
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.message, /different supplier invoice/);
    const duplicateNumber = await postInvoice({invoiceNo: 'SUPPLIER ABC-10', subtotal: 500}, {key: 'another-key'});
    assert.equal(duplicateNumber.status, 409);
    assert.match(duplicateNumber.body.message, /already recorded/);
  });

  it('rolls back invoice persistence when its audit write fails in the transaction', async () => {
    const originalCreate = Audit.create;
    Audit.create = async () => { throw new Error('forced audit failure'); };
    let response;
    try {
      response = await postInvoice({invoiceNo: 'ROLLBACK-1'});
    } finally {
      Audit.create = originalCreate;
    }
    assert.equal(response.status, 500, JSON.stringify(response.body));
    assert.match(response.body.message, /forced audit failure/);
    assert.equal(await SupplierInvoice.countDocuments({invoiceNoNormalized: 'ROLLBACK-1'}), 0);
  });

  it('enforces restaurant, branch, supplier and PO reference boundaries', async () => {
    const otherRestaurant = await Restaurant.create({name: 'Other Restaurant'});
    const otherBranch = await Branch.create({restaurant: otherRestaurant._id, name: 'Other Branch', code: 'OTH'});
    const otherSupplier = await Supplier.create({restaurant: otherRestaurant._id, name: 'Other Supplier'});
    const otherOwner = await User.create({
      name: 'Other Owner', email: 'other-owner@test.com', password: 'x', role: 'owner', restaurantId: otherRestaurant._id
    });
    const foreign = await request('/api/supplier-invoices', {
      method: 'POST',
      token: tokenFor(otherOwner),
      headers: {'Idempotency-Key': 'foreign-invoice'},
      body: {branch: String(otherBranch._id), supplier: String(otherSupplier._id), invoiceNo: 'FOREIGN-1', subtotal: 100}
    });
    assert.equal(foreign.status, 201, foreign.body?.message);
    assert.equal((await request(`/api/supplier-invoices/${foreign.body._id}`, {token: tokenFor(world.owner)})).status, 404);
    assert.equal((await request('/api/supplier-invoices?branch=' + otherBranch._id, {token: tokenFor(world.owner)})).status, 403);

    const foreignSupplier = await postInvoice({supplier: String(otherSupplier._id), invoiceNo: 'BAD-SUPPLIER'});
    assert.equal(foreignSupplier.status, 404);
    const otherLocalSupplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Other Local Supplier'});
    const po = await createApprovedPo();
    const mismatchedPo = await postInvoice({
      supplier: String(otherLocalSupplier._id),
      purchaseOrder: String(po._id),
      invoiceNo: 'BAD-PO'
    });
    assert.equal(mismatchedPo.status, 409);
    const staffCreate = await postInvoice({invoiceNo: 'STAFF-FORBIDDEN'}, {user: world.staffA});
    assert.equal(staffCreate.status, 403);
    assert.equal(await SupplierInvoice.countDocuments({restaurant: world.restaurant._id}), 0);
  });

  it('persists receipt and prior-invoice evidence for matched, awaiting and over-billed POs', async () => {
    const receivedPo = await createApprovedPo();
    const receiptResult = await receiveAll(receivedPo);
    const matched = await postInvoice({
      purchaseOrder: String(receivedPo._id),
      invoiceNo: 'MATCHED-1',
      subtotal: 1000
    });
    assert.equal(matched.status, 201, matched.body?.message);
    assert.equal(matched.body.matching.status, 'matched');
    assert.equal(matched.body.matching.receivedSubtotal, 1000);
    assert.equal(matched.body.matching.receivedVat, 130);
    assert.equal(matched.body.matching.receivedTotal, 1130);
    assert.deepEqual(matched.body.matching.receiptIds.map(String), [String(receiptResult.receipt._id)]);
    assert.equal(matched.body.matching.varianceTotal, 0);

    const over = await postInvoice({
      purchaseOrder: String(receivedPo._id),
      invoiceNo: 'OVER-2',
      subtotal: 100
    });
    assert.equal(over.status, 201, over.body?.message);
    assert.equal(over.body.matching.status, 'over_billed');
    assert.equal(over.body.matching.previouslyInvoicedTotal, 1130);
    assert.equal(over.body.matching.availableTotal, 0);
    assert.equal(over.body.matching.varianceTotal, 113);

    const returnOptions = await request(`/api/purchase-orders/${receivedPo._id}/return-options`, {
      token: tokenFor(world.manager)
    });
    assert.equal(returnOptions.status, 200, returnOptions.body?.message);
    const postedReturn = await request(`/api/purchase-orders/${receivedPo._id}/returns`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'invoice-matching-return'},
      body: {
        reason: 'quality',
        expectedVersion: receiptResult.purchaseOrder.__v,
        items: [{
          itemId: String(receivedPo.items[0]._id),
          batchId: returnOptions.body.items[0].batches[0].batchId,
          qty: 10
        }]
      }
    });
    assert.equal(postedReturn.status, 201, postedReturn.body?.message);
    const afterReturn = await request(`/api/supplier-invoices/${matched.body._id}`, {token: tokenFor(world.manager)});
    assert.equal(afterReturn.status, 200, afterReturn.body?.message);
    assert.equal(afterReturn.body.matching.status, 'over_billed');
    assert.equal(afterReturn.body.matching.returnedTotal, 113);
    assert.deepEqual(afterReturn.body.matching.returnIds.map(String), [String(postedReturn.body.purchaseReturn._id)]);
    assert.ok(await Audit.exists({
      entity: 'supplier_invoice', entityId: matched.body._id, action: 'matching_refresh', reason: 'purchase_return'
    }));

    const awaitingPo = await createApprovedPo({orderedQty: 20, unitPrice: 5});
    const awaiting = await postInvoice({
      purchaseOrder: String(awaitingPo._id),
      invoiceNo: 'AWAIT-1',
      subtotal: 100
    });
    assert.equal(awaiting.status, 201, awaiting.body?.message);
    assert.equal(awaiting.body.matching.status, 'awaiting_receipt');
    assert.equal(awaiting.body.matching.receivedTotal, 0);
    await receiveAll(awaitingPo, 'invoice-awaiting-receipt');
    const refreshed = await request(`/api/supplier-invoices/${awaiting.body._id}`, {token: tokenFor(world.manager)});
    assert.equal(refreshed.status, 200, refreshed.body?.message);
    assert.equal(refreshed.body.matching.status, 'matched');
    assert.equal(refreshed.body.matching.receivedTotal, 113);
    assert.ok(refreshed.body.__v > awaiting.body.__v);
    const matchingAudit = await Audit.findOne({
      entity: 'supplier_invoice', entityId: awaiting.body._id, action: 'matching_refresh'
    }).lean();
    assert.equal(matchingAudit.reason, 'goods_receipt');
  });
});

describe('supplier invoice update and query concurrency', () => {
  it('reallocates matching evidence for later invoices after amount edits and voids', async () => {
    const po = await createApprovedPo();
    await receiveAll(po, 'invoice-update-receipt');
    const first = await postInvoice({
      purchaseOrder: String(po._id),
      invoiceNo: 'ALLOC-FIRST',
      subtotal: 500
    });
    const second = await postInvoice({
      purchaseOrder: String(po._id),
      invoiceNo: 'ALLOC-SECOND',
      subtotal: 500
    });
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(second.body.matching.status, 'matched');
    assert.equal(second.body.matching.previouslyInvoicedTotal, 565);

    const updatedFirst = await request(`/api/supplier-invoices/${first.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {subtotal: 600, expectedVersion: first.body.__v}
    });
    assert.equal(updatedFirst.status, 200, updatedFirst.body?.message);
    const secondAfterEdit = await request(`/api/supplier-invoices/${second.body._id}`, {token: tokenFor(world.manager)});
    assert.equal(secondAfterEdit.status, 200, secondAfterEdit.body?.message);
    assert.equal(secondAfterEdit.body.matching.status, 'over_billed');
    assert.equal(secondAfterEdit.body.matching.previouslyInvoicedTotal, 678);
    assert.ok(secondAfterEdit.body.__v > second.body.__v);

    const voidedFirst = await request(`/api/supplier-invoices/${first.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'void', expectedVersion: updatedFirst.body.__v}
    });
    assert.equal(voidedFirst.status, 200, voidedFirst.body?.message);
    const secondAfterVoid = await request(`/api/supplier-invoices/${second.body._id}`, {token: tokenFor(world.manager)});
    assert.equal(secondAfterVoid.status, 200, secondAfterVoid.body?.message);
    assert.equal(secondAfterVoid.body.matching.status, 'partial');
    assert.equal(secondAfterVoid.body.matching.previouslyInvoicedTotal, 0);
    assert.ok(await Audit.exists({
      entity: 'supplier_invoice',
      entityId: second.body._id,
      action: 'matching_refresh',
      reason: 'supplier_invoice_void'
    }));
  });

  it('relinks and unlinks invoices while refreshing allocations on both affected purchase orders', async () => {
    const firstPo = await createApprovedPo();
    const secondPo = await createApprovedPo({orderedQty: 50, unitPrice: 10});
    await receiveAll(firstPo, 'invoice-relink-first-receipt');
    await receiveAll(secondPo, 'invoice-relink-second-receipt');
    const first = await postInvoice({
      purchaseOrder: String(firstPo._id), invoiceNo: 'RELINK-FIRST', subtotal: 500
    });
    const later = await postInvoice({
      purchaseOrder: String(firstPo._id), invoiceNo: 'RELINK-LATER', subtotal: 500
    });
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(later.status, 201, later.body?.message);
    assert.equal(later.body.matching.status, 'matched');
    assert.equal(later.body.matching.previouslyInvoicedTotal, 565);

    const relinked = await request(`/api/supplier-invoices/${first.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {purchaseOrder: String(secondPo._id), expectedVersion: first.body.__v}
    });
    assert.equal(relinked.status, 200, relinked.body?.message);
    assert.equal(String(relinked.body.purchaseOrder._id), String(secondPo._id));
    assert.equal(relinked.body.matching.status, 'matched');
    const laterAfterRelink = await request(`/api/supplier-invoices/${later.body._id}`, {token: tokenFor(world.manager)});
    assert.equal(laterAfterRelink.status, 200, laterAfterRelink.body?.message);
    assert.equal(laterAfterRelink.body.matching.status, 'partial');
    assert.equal(laterAfterRelink.body.matching.previouslyInvoicedTotal, 0);
    assert.ok(laterAfterRelink.body.__v > later.body.__v);

    const unlinked = await request(`/api/supplier-invoices/${first.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {purchaseOrder: null, expectedVersion: relinked.body.__v}
    });
    assert.equal(unlinked.status, 200, unlinked.body?.message);
    assert.equal(unlinked.body.purchaseOrder, undefined);
    assert.equal(unlinked.body.matching.status, 'unlinked');
    assert.ok(await Audit.exists({
      entity: 'supplier_invoice', entityId: later.body._id,
      action: 'matching_refresh', reason: 'supplier_invoice_update'
    }));
  });

  it('uses expectedVersion, writes tenant audit evidence and rejects stale or void edits', async () => {
    const created = await postInvoice({invoiceNo: 'VERSION-1'});
    assert.equal(created.status, 201, created.body?.message);
    const updated = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {invoiceNo: 'VERSION-2', subtotal: 2000, expectedVersion: created.body.__v}
    });
    assert.equal(updated.status, 200, updated.body?.message);
    assert.equal(updated.body.total, 2260);
    assert.equal(updated.body.__v, created.body.__v + 1);

    const stale = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {notes: 'stale write', expectedVersion: created.body.__v}
    });
    assert.equal(stale.status, 409);
    assert.match(stale.body.message, /refresh/);
    const audit = await Audit.findOne({entity: 'supplier_invoice', entityId: created.body._id, action: 'update'}).lean();
    assert.equal(String(audit.restaurant), String(world.restaurant._id));
    assert.equal(String(audit.branch), String(world.branchA._id));
    assert.equal(audit.before.invoiceNo, 'VERSION-1');
    assert.equal(audit.after.invoiceNo, 'VERSION-2');

    const voided = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'void', expectedVersion: updated.body.__v}
    });
    assert.equal(voided.status, 200, voided.body?.message);
    assert.equal(voided.body.status, 'void');
    assert.equal(String(voided.body.voidedBy._id || voided.body.voidedBy), String(world.manager._id));
    const editVoid = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager), body: {notes: 'no', expectedVersion: voided.body.__v}
    });
    assert.equal(editVoid.status, 409);
  });

  it('locks financial identity and voiding after any supplier payment exists', async () => {
    const created = await postInvoice({invoiceNo: 'PAID-LOCK'});
    assert.equal(created.status, 201, created.body?.message);
    await SupplierPayment.create({
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      invoice: created.body._id,
      supplier: supplier._id,
      paymentNo: `PAY-${String(created.body._id).slice(-8).toUpperCase()}`,
      amount: 100,
      method: 'bank',
      reference: 'LOCK-TEST',
      paidAt: new Date(),
      status: 'posted',
      origin: 'legacy_record',
      migrationSource: 'supplier invoice locking fixture',
      idempotencyKey: `locking-fixture-${created.body._id}`,
      requestHash: 'a'.repeat(64),
      requestHashVersion: 2,
      createdBy: world.manager._id
    });
    const amountEdit = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {subtotal: 2000, expectedVersion: created.body.__v}
    });
    assert.equal(amountEdit.status, 409);
    assert.match(amountEdit.body.message, /Cannot change amounts/);
    const voidAttempt = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {status: 'void', expectedVersion: created.body.__v}
    });
    assert.equal(voidAttempt.status, 409);
    assert.match(voidAttempt.body.message, /Cannot void an invoice/);
    const po = await createApprovedPo();
    const relinkAttempt = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {purchaseOrder: String(po._id), expectedVersion: created.body.__v}
    });
    assert.equal(relinkAttempt.status, 409);
    assert.match(relinkAttempt.body.message, /Cannot change the purchase order/);
    const notesOnly = await request(`/api/supplier-invoices/${created.body._id}`, {
      method: 'PATCH', token: tokenFor(world.manager),
      body: {notes: 'Bank reference verified', expectedVersion: created.body.__v}
    });
    assert.equal(notesOnly.status, 200, notesOnly.body?.message);
    assert.equal(notesOnly.body.notes, 'Bank reference verified');
  });

  it('scopes manager list/detail access and filters status, supplier, dates and text', async () => {
    const first = await postInvoice({invoiceNo: 'FILTER-A', invoiceDate: FILTER_FROM, notes: 'rice shipment'});
    assert.equal(first.status, 201, first.body?.message);
    const otherSupplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Second Supplier'});
    const second = await postInvoice({supplier: String(otherSupplier._id), invoiceNo: 'FILTER-B', invoiceDate: FILTER_OUTSIDE});
    assert.equal(second.status, 201, second.body?.message);

    const filtered = await request(`/api/supplier-invoices?branch=${world.branchA._id}&supplier=${supplier._id}&status=unpaid&from=${FILTER_FROM}&to=${FILTER_TO}&q=rice`, {
      token: tokenFor(world.manager)
    });
    assert.equal(filtered.status, 200, filtered.body?.message);
    assert.deepEqual(filtered.body.map(row => row.invoiceNo), ['FILTER-A']);
    const ownDefault = await request('/api/supplier-invoices', {token: tokenFor(world.manager)});
    assert.equal(ownDefault.status, 200);
    assert.equal(ownDefault.body.length, 2);
    assert.equal((await request(`/api/supplier-invoices/${first.body._id}`, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request(`/api/supplier-invoices/${new mongoose.Types.ObjectId()}`, {token: tokenFor(world.manager)})).status, 404);
  });
});
