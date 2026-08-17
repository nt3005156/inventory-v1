import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, Supplier, User} from '../src/models/index.js';
import {Branch, InventoryBalance, InventoryBatch, InventoryTransaction, PurchaseOrder, Restaurant} from '../src/models/operations.js';
import {PurchaseReturn, PurchaseReturnCounter} from '../src/models/purchasing.js';
import {ensurePurchaseReturnIndexes} from '../src/services/purchaseReturnMigration.js';
import {returnPurchaseOrder} from '../src/services/returns.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {daysAhead} from './dates.js';


// FEFO ordering depends on EARLY < NEAR < LATE < FAR, all still in the future.
const EXPIRY_NEAR = daysAhead(120);
const EXPIRY_EARLY = daysAhead(300);
const EXPIRY_LATE = daysAhead(500);
const EXPIRY_FAR = daysAhead(700);
const EXPIRY_PAST = '2026-01-15';

let world;
let supplier;
let keySequence = 0;

before(async () => {
  await startTestApp();
  await ensurePurchaseReturnIndexes();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Return Test Supplier'});
});

async function createApprovedPo({qty = 100, unitPrice = 10, vatRate = 13, user = world.manager} = {}) {
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': `pr-po-${++keySequence}`},
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      items: [{
        ingredient: String(world.ingredient._id),
        orderedQty: qty,
        unit: 'g',
        unitPrice,
        vatRate
      }]
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH',
    token: tokenFor(user),
    body: {status: 'pending', expectedVersion: created.body.__v}
  });
  assert.equal(pending.status, 200, pending.body?.message);
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH',
    token: tokenFor(world.owner),
    body: {status: 'approved', expectedVersion: pending.body.__v}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return approved.body;
}

async function receiveLot(po, {qty, batchNumber, expiryDate, key}) {
  const result = await request(`/api/purchase-orders/${po._id}/receive`, {
    method: 'POST',
    token: tokenFor(world.manager),
    headers: {'Idempotency-Key': key || `pr-gr-${++keySequence}`},
    body: {
      expectedVersion: po.__v,
      items: [{
        itemId: String(po.items[0]._id),
        receivedQty: qty,
        damagedQty: 0,
        batchNumber,
        expiryDate
      }]
    }
  });
  assert.equal(result.status, 201, result.body?.message);
  return result.body.purchaseOrder;
}

function postReturn(po, items, {key = `pr-${++keySequence}`, reason = 'quality', notes, user = world.manager, expectedVersion = po.__v, extraBody = {}} = {}) {
  return request(`/api/purchase-orders/${po._id}/returns`, {
    method: 'POST',
    token: tokenFor(user),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {items, reason, notes, expectedVersion, ...extraBody}
  });
}

async function optionsFor(po, user = world.manager) {
  return request(`/api/purchase-orders/${po._id}/return-options`, {token: tokenFor(user)});
}

describe('durable purchase returns', () => {
  it('splits one PO line across exact receipt lots with durable evidence and server-owned NPR/VAT values', async () => {
    let po = await createApprovedPo({qty: 30, unitPrice: 10, vatRate: 13});
    po = await receiveLot(po, {qty: 10, batchNumber: 'LOT-LATE', expiryDate: EXPIRY_LATE});
    po = await receiveLot(po, {qty: 12, batchNumber: 'LOT-EARLY', expiryDate: EXPIRY_EARLY});

    const options = await optionsFor(po);
    assert.equal(options.status, 200, options.body?.message);
    assert.equal(options.body.items.length, 1);
    assert.equal(options.body.items[0].allocationSource, 'receipt_batch');
    assert.equal(options.body.items[0].returnableQty, 22);
    assert.equal(options.body.items[0].availableQty, 22);
    assert.deepEqual(options.body.items[0].batches.map(batch => batch.batchNumber), ['LOT-EARLY', 'LOT-LATE']);
    const [early, late] = options.body.items[0].batches;

    const posted = await postReturn(po, [
      {itemId: String(po.items[0]._id), batchId: String(early.batchId), qty: 4},
      {itemId: String(po.items[0]._id), batchId: String(late.batchId), qty: 3}
    ], {key: 'split-exact-lots', notes: 'Supplier pickup confirmed'});
    assert.equal(posted.status, 201, posted.body?.message);
    const returned = posted.body.purchaseReturn;
    assert.match(returned.returnNo, /^PR-KTM-\d{4}-\d{6}$/);
    assert.equal(returned.numberVersion, 2);
    assert.equal(String(returned.restaurant), String(world.restaurant._id));
    assert.equal(String(returned.branch), String(world.branchA._id));
    assert.equal(String(returned.supplier), String(supplier._id));
    assert.equal(returned.status, 'posted');
    assert.equal(returned.items.length, 2);
    assert.deepEqual(returned.items.map(item => String(item.inventoryBatch)).sort(), [String(early.batchId), String(late.batchId)].sort());
    assert.ok(returned.items.every(item => item.allocationSource === 'receipt_batch' && item.goodsReceipt));
    assert.ok(returned.items.every(item => item.unitCost === 10 && item.inventoryUnitCost === 10));
    assert.equal(returned.subtotal, 70);
    assert.equal(returned.vat, 9.1);
    assert.equal(returned.total, 79.1);
    assert.equal(posted.body.purchaseOrder.items[0].returnedQty, 7);

    const lots = await InventoryBatch.find({_id: {$in: [early.batchId, late.batchId]}}).lean();
    assert.deepEqual(Object.fromEntries(lots.map(lot => [lot.batchNumber, lot.quantity])), {'LOT-LATE': 7, 'LOT-EARLY': 8});
    const transactions = await InventoryTransaction.find({type: 'RETURN', referenceId: returned._id}).lean();
    assert.equal(transactions.length, 2);
    assert.equal(transactions.reduce((sum, tx) => sum + tx.changeQty, 0), -7);
    assert.ok(transactions.every(tx => tx.branch.equals(world.branchA._id) && tx.user.equals(world.manager._id)));
    assert.deepEqual(transactions.flatMap(tx => tx.batchMovements.map(movement => String(movement.batch))).sort(), [String(early.batchId), String(late.batchId)].sort());
    assert.equal(await Audit.countDocuments({entity: 'purchase_return', entityId: returned._id, restaurant: world.restaurant._id, branch: world.branchA._id}), 1);
  });

  it('keeps supplier credit at the authoritative PO cost while removing stock at immutable lot valuation', async () => {
    let po = await createApprovedPo({qty: 10, unitPrice: 20, vatRate: 13});
    po = await receiveLot(po, {qty: 10, batchNumber: 'VALUATION', expiryDate: EXPIRY_FAR});
    const options = await optionsFor(po);
    const batchId = options.body.items[0].batches[0].batchId;
    await InventoryBatch.collection.updateOne({_id: new mongoose.Types.ObjectId(batchId)}, {$set: {unitCost: 6}});

    const posted = await postReturn(po, [{itemId: String(po.items[0]._id), batchId: String(batchId), qty: 2}], {key: 'valuation-costs'});
    assert.equal(posted.status, 201, posted.body?.message);
    const line = posted.body.purchaseReturn.items[0];
    assert.equal(line.unitCost, 20);
    assert.equal(line.inventoryUnitCost, 6);
    assert.equal(line.subtotal, 40);
    assert.equal(line.stockValue, 12);
    assert.equal(posted.body.purchaseReturn.total, 45.2);
    const transaction = await InventoryTransaction.findOne({referenceId: posted.body.purchaseReturn._id});
    assert.equal(transaction.unitCost, 6);
    assert.equal(transaction.totalCost, 12);

    const history = await request(`/api/purchase-orders/${po._id}/returns`, {token: tokenFor(world.manager)});
    assert.equal(history.status, 200, history.body?.message);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].returnNo, posted.body.purchaseReturn.returnNo);
    assert.equal(history.body[0].items[0].inventoryUnitCost, 6);
    assert.equal(history.body[0].items[0].stockValue, 12);
    assert.equal(history.body[0].total, 45.2);
    assert.equal(history.body[0].requestHash, undefined);
    assert.equal(history.body[0].idempotencyKey, undefined);

    const report = await request(`/api/reports/purchasing?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(report.status, 200, report.body?.message);
    assert.equal(report.body.returns.count, 1);
    assert.equal(report.body.returns.value, 40);
    assert.equal(report.body.ledger.returnValue, 12);
    assert.equal(report.body.ledger.purchaseValue, 200);
    assert.equal(report.body.ledger.netStockValue, 188);
  });

  it('rolls back the return, lot, aggregate, PO, counter, ledger and audit together', async () => {
    let po = await createApprovedPo({qty: 10, unitPrice: 4});
    po = await receiveLot(po, {qty: 10, batchNumber: 'ROLLBACK'});
    const options = await optionsFor(po);
    const batchId = options.body.items[0].batches[0].batchId;
    const beforeBatch = await InventoryBatch.findById(batchId).lean();
    const beforeBalance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    const session = await mongoose.startSession();
    try {
      await assert.rejects(
        session.withTransaction(async () => {
          await returnPurchaseOrder({
            poId: po._id,
            items: [{itemId: String(po.items[0]._id), batchId: String(batchId), qty: 3}],
            reason: 'quality',
            expectedVersion: po.__v,
            user: world.manager,
            session,
            idempotencyKey: 'forced-rollback'
          });
          throw new Error('force purchase return rollback');
        }),
        /force purchase return rollback/
      );
    } finally {
      await session.endSession();
    }

    const freshPo = await PurchaseOrder.findById(po._id).lean();
    const freshBatch = await InventoryBatch.findById(batchId).lean();
    const freshBalance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(freshPo.items[0].returnedQty, 0);
    assert.equal(freshBatch.quantity, beforeBatch.quantity);
    assert.equal(freshBalance.quantity, beforeBalance.quantity);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po._id}), 0);
    assert.equal(await PurchaseReturnCounter.countDocuments(), 0);
    assert.equal(await InventoryTransaction.countDocuments({type: 'RETURN'}), 0);
    assert.equal(await Audit.countDocuments({entity: 'purchase_return'}), 0);
  });

  it('offers only receipt-created lots and constrains returns by their current availability', async () => {
    let po = await createApprovedPo({qty: 20});
    po = await receiveLot(po, {qty: 20, batchNumber: 'PO-LOT', expiryDate: EXPIRY_NEAR});
    const firstOptions = await optionsFor(po);
    const receiptBatch = firstOptions.body.items[0].batches[0];
    assert.equal(firstOptions.body.items[0].batches.length, 1);
    await InventoryBatch.create([
      {
        restaurant: world.restaurant._id,
        branch: world.branchA._id,
        ingredient: world.ingredient._id,
        lotKey: `unrelated-opening:${po._id}`,
        batchNumber: 'UNRELATED-OPENING',
        batchNumberNormalized: 'UNRELATED-OPENING',
        sourceType: 'opening',
        sourceId: new mongoose.Types.ObjectId(),
        unit: po.items[0].unit,
        unitCost: 1,
        initialQuantity: 100,
        quantity: 100
      },
      {
        restaurant: world.restaurant._id,
        branch: world.branchA._id,
        ingredient: world.ingredient._id,
        lotKey: `invalid-receipt-line:${po._id}`,
        batchNumber: 'INVALID-RECEIPT-LINE',
        batchNumberNormalized: 'INVALID-RECEIPT-LINE',
        sourceType: 'goods_receipt',
        sourceId: receiptBatch.goodsReceipt,
        sourceLine: new mongoose.Types.ObjectId(),
        unit: po.items[0].unit,
        unitCost: 1,
        initialQuantity: 100,
        quantity: 100
      }
    ], {inventoryLedgerWrite: true});
    await InventoryBalance.collection.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {$inc: {quantity: 200}}
    );

    const wasted = await request('/api/waste/record', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'consume-po-lot'},
      body: {
        branch: String(world.branchA._id),
        ingredient: String(world.ingredient._id),
        qty: 15,
        reason: 'spoiled',
        batchId: String(receiptBatch.batchId)
      }
    });
    assert.equal(wasted.status, 201, wasted.body?.message);
    const currentOptions = await optionsFor(po);
    assert.equal(currentOptions.body.items[0].returnableQty, 20);
    assert.equal(currentOptions.body.items[0].availableQty, 5);
    assert.equal(currentOptions.body.items[0].batches.length, 1);
    assert.equal(String(currentOptions.body.items[0].batches[0].batchId), String(receiptBatch.batchId));
    assert.equal(currentOptions.body.items[0].batches[0].availableQty, 5);

    const tooMuch = await postReturn(po, [{itemId: String(po.items[0]._id), batchId: String(receiptBatch.batchId), qty: 6}], {key: 'unavailable-lot'});
    assert.equal(tooMuch.status, 409);
    assert.match(tooMuch.body.message, /Insufficient|available/i);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po._id}), 0);
  });

  it('requires a stable key, rejects browser-owned cost and stale selectors, and validates Other details', async () => {
    let po = await createApprovedPo({qty: 10});
    po = await receiveLot(po, {qty: 10, batchNumber: 'VALIDATE', expiryDate: EXPIRY_NEAR});
    const options = await optionsFor(po);
    const batchId = options.body.items[0].batches[0].batchId;
    const line = {itemId: String(po.items[0]._id), batchId: String(batchId), qty: 1};

    assert.equal((await postReturn(po, [line], {key: null})).status, 400);
    const clientCost = await postReturn(po, [{...line, unitPrice: 0.01}], {key: 'client-cost'});
    assert.equal(clientCost.status, 400);
    assert.match(clientCost.body.message, /unrecognized|unitPrice/i);
    assert.equal((await postReturn(po, [line], {key: 'other-detail', reason: 'other', notes: 'x'})).status, 400);
    assert.equal((await postReturn(po, [{...line, batchId: String(new mongoose.Types.ObjectId())}], {key: 'foreign-batch'})).status, 409);
    assert.equal((await postReturn(po, [line], {key: 'stale-version', expectedVersion: Math.max(0, po.__v - 1)})).status, 409);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po._id}), 0);
  });

  it('replays the same request without another movement and rejects key reuse with changed payload', async () => {
    let po = await createApprovedPo({qty: 12});
    po = await receiveLot(po, {qty: 12, batchNumber: 'REPLAY', expiryDate: EXPIRY_NEAR});
    const options = await optionsFor(po);
    const item = {itemId: String(po.items[0]._id), batchId: String(options.body.items[0].batches[0].batchId), qty: 4};
    const first = await postReturn(po, [item], {key: 'same-durable-return'});
    assert.equal(first.status, 201, first.body?.message);
    const replay = await postReturn(po, [item], {key: 'same-durable-return', expectedVersion: po.__v});
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.purchaseReturn._id, first.body.purchaseReturn._id);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po._id}), 1);
    assert.equal(await InventoryTransaction.countDocuments({type: 'RETURN', referenceId: first.body.purchaseReturn._id}), 1);

    const conflict = await postReturn(po, [{...item, qty: 3}], {key: 'same-durable-return', expectedVersion: first.body.purchaseOrder.__v});
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.message, /different purchase return/i);
  });

  it('serializes concurrent returns so one cannot overdraw the same PO line or lot', async () => {
    let po = await createApprovedPo({qty: 10});
    po = await receiveLot(po, {qty: 10, batchNumber: 'RACE', expiryDate: EXPIRY_NEAR});
    const options = await optionsFor(po);
    const item = {itemId: String(po.items[0]._id), batchId: String(options.body.items[0].batches[0].batchId), qty: 7};
    const results = await Promise.all([
      postReturn(po, [item], {key: 'race-return-a'}),
      postReturn(po, [item], {key: 'race-return-b'})
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po._id}), 1);
    const batch = await InventoryBatch.findById(item.batchId);
    assert.equal(batch.quantity, 3);
    const currentPo = await PurchaseOrder.findById(po._id);
    assert.equal(currentPo.items[0].returnedQty, 7);
  });

  it('enforces manager write access, staff read-only access, branch isolation and tenant isolation', async () => {
    let po = await createApprovedPo({qty: 10});
    po = await receiveLot(po, {qty: 10, batchNumber: 'SCOPE', expiryDate: EXPIRY_NEAR});
    const options = await optionsFor(po);
    const item = {itemId: String(po.items[0]._id), batchId: String(options.body.items[0].batches[0].batchId), qty: 1};

    assert.equal((await optionsFor(po, world.staffA)).status, 200);
    assert.equal((await postReturn(po, [item], {key: 'staff-write', user: world.staffA})).status, 403);
    const managerB = await User.create({
      name: 'Branch B Manager', email: 'branch-b-return@test.com', password: 'hashed', role: 'manager',
      restaurant: world.restaurant.name, restaurantId: world.restaurant._id, branch: world.branchB._id
    });
    assert.equal((await optionsFor(po, managerB)).status, 403);
    assert.equal((await postReturn(po, [item], {key: 'branch-write', user: managerB})).status, 403);

    const otherRestaurant = await Restaurant.create({name: 'Other Return Tenant'});
    const otherBranch = await Branch.create({restaurant: otherRestaurant._id, name: 'Other Branch', code: 'OTH'});
    const otherOwner = await User.create({
      name: 'Other Owner', email: 'other-return@test.com', password: 'hashed', role: 'owner',
      restaurant: otherRestaurant.name, restaurantId: otherRestaurant._id, branch: otherBranch._id
    });
    assert.equal((await optionsFor(po, otherOwner)).status, 404);
    assert.equal((await postReturn(po, [item], {key: 'tenant-write', user: otherOwner})).status, 404);

    await Branch.updateOne({_id: world.branchA._id}, {$set: {active: false}});
    assert.equal((await optionsFor(po, world.owner)).status, 200);
    assert.equal((await postReturn(po, [item], {key: 'inactive-branch-write', user: world.owner})).status, 404);
    assert.equal(await PurchaseReturn.countDocuments({purchaseOrder: po._id}), 0);
  });

  it('backfills honest legacy evidence, repairs indexes, and aligns durable counters', async () => {
    const po = await createApprovedPo({qty: 5, unitPrice: 8});
    await PurchaseReturn.collection.createIndex({idempotencyKey: 1}, {unique: true, sparse: true, name: 'idempotencyKey_1'});
    await PurchaseReturn.collection.dropIndex('pr_restaurant_branch_supplier_created');
    await PurchaseReturn.collection.createIndex(
      {restaurant: 1, supplier: 1},
      {name: 'pr_restaurant_branch_supplier_created'}
    );
    const legacyId = new mongoose.Types.ObjectId();
    await PurchaseReturn.collection.insertOne({
      _id: legacyId,
      returnNo: 'PR-KTM-2026-000009',
      numberVersion: 2,
      purchaseOrder: new mongoose.Types.ObjectId(po._id),
      reason: 'quality',
      notes: 'Historical return',
      idempotencyKey: 'legacy-return-key',
      items: [{
        _id: new mongoose.Types.ObjectId(),
        poItem: new mongoose.Types.ObjectId(po.items[0]._id),
        ingredient: world.ingredient._id,
        qty: 2,
        unit: 'g',
        unitCost: 999,
        batchNumber: 'OLD-LOT'
      }],
      createdAt: new Date('2026-01-15T00:00:00Z'),
      updatedAt: new Date('2026-01-15T00:00:00Z')
    });
    const misleadingBatch = await new InventoryBatch({
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      lotKey: `misleading-receipt-source:${legacyId}`,
      batchNumber: 'MISLEADING-SOURCE',
      batchNumberNormalized: 'MISLEADING-SOURCE',
      sourceType: 'goods_receipt',
      sourceId: new mongoose.Types.ObjectId(),
      sourceLine: po.items[0]._id,
      unit: 'g',
      unitCost: 3,
      initialQuantity: 2,
      quantity: 0
    }).save({inventoryLedgerWrite: true});
    await new InventoryTransaction({
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      type: 'RETURN',
      previousQty: 2,
      changeQty: -2,
      newQty: 0,
      unit: 'g',
      unitCost: 3,
      totalCost: 6,
      reason: 'Historical purchase return fixture',
      referenceType: 'purchase_return',
      referenceId: legacyId,
      user: world.owner._id,
      idempotencyKey: 'legacy-return-ledger-fixture',
      idempotencyHash: 'a'.repeat(64),
      idempotencyHashVersion: 2,
      batchMovements: [{
        batch: misleadingBatch._id,
        batchNumber: misleadingBatch.batchNumber,
        previousQty: 2,
        changeQty: -2,
        newQty: 0,
        unitCost: 3
      }]
    }).save({inventoryLedgerWrite: true});

    const result = await ensurePurchaseReturnIndexes();
    assert.equal(result.migrated, 1);
    assert.ok(result.droppedIndexes.includes('idempotencyKey_1'));
    assert.ok(result.repairedIndexes.includes('pr_restaurant_branch_supplier_created'));
    const migrated = await PurchaseReturn.findById(legacyId).select('+requestHash +requestHashVersion').lean();
    assert.equal(String(migrated.restaurant), String(world.restaurant._id));
    assert.equal(String(migrated.branch), String(world.branchA._id));
    assert.equal(String(migrated.supplier), String(supplier._id));
    assert.equal(String(migrated.returnedBy), String(world.owner._id));
    assert.equal(migrated.status, 'posted');
    assert.equal(migrated.items[0].allocationSource, 'legacy_allocation');
    assert.equal(String(migrated.items[0].inventoryBatch), String(misleadingBatch._id));
    assert.equal(migrated.items[0].goodsReceipt, undefined);
    assert.equal(migrated.items[0].unitCost, 8);
    assert.equal(migrated.items[0].inventoryUnitCost, 3);
    assert.equal(migrated.items[0].stockValue, 6);
    assert.equal(migrated.items[0].subtotal, 16);
    assert.equal(migrated.subtotal, 16);
    assert.equal(migrated.vat, 2.08);
    assert.equal(migrated.total, 18.08);
    assert.equal(migrated.requestHashVersion, 2);
    assert.match(migrated.requestHash, /^[a-f0-9]{64}$/);

    const indexes = await PurchaseReturn.collection.indexes();
    const names = new Set(indexes.map(index => index.name));
    for (const name of ['pr_restaurant_number_v2', 'pr_restaurant_idempotency_key', 'pr_restaurant_branch_po_created', 'pr_restaurant_branch_supplier_created', 'pr_restaurant_branch_returned_at']) {
      assert.ok(names.has(name), `${name} should exist`);
    }
    assert.ok(!names.has('idempotencyKey_1'));
    const counter = await PurchaseReturnCounter.findOne({restaurant: world.restaurant._id, branchCode: 'KTM', year: 2026});
    assert.equal(counter.value, 9);
  });
});
