import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import {io as clientIo} from 'socket.io-client';
import {Ingredient, Supplier, User} from '../src/models/index.js';
import {
  Branch,
  InventoryBalance,
  InventoryBatch,
  InventoryTransaction,
  Restaurant
} from '../src/models/operations.js';
import {GoodsReceipt} from '../src/models/purchasing.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {ensureInventoryBatchIndexes} from '../src/services/inventoryBatchMigration.js';
import {kathmanduDateString} from '../src/services/inventoryBatches.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let baseUrl;

const dateFromToday = days => kathmanduDateString(new Date(Date.now() + Number(days) * 86400000));

before(async () => {
  ({baseUrl} = await startTestApp());
  await ensureInventoryBatchIndexes();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

async function zeroInventory() {
  await Promise.all([
    InventoryBalance.updateMany({}, {$set: {quantity: 0, averageCost: 0}}),
    InventoryBatch.deleteMany({}),
    InventoryTransaction.deleteMany({})
  ]);
}

function adjustment({qty, batchNumber, expiryDate, key = `adj-${Math.random()}`, reason = 'Verified stock count', ingredient = world.ingredient, branch = world.branchA, token = tokenFor(world.owner)} = {}) {
  return request('/api/inventory/adjustments', {
    method: 'POST',
    token,
    headers: {'Idempotency-Key': key},
    body: {
      branch: String(branch._id),
      ingredient: String(ingredient._id),
      qty,
      reason,
      batchNumber,
      expiryDate
    }
  });
}

async function transactionalMovement(input) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await moveStock(input, session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function createApprovedPo({qty = 100, unitPrice = 0.5} = {}) {
  const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Batch Supplier'});
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    headers: {'Idempotency-Key': `batch-po-${Math.random()}`},
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty: qty, unit: 'g', unitPrice}]
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(world.owner), body: {status: 'pending', expectedVersion: created.body.__v}
  });
  assert.equal(pending.status, 200, pending.body?.message);
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(world.owner), body: {status: 'approved', expectedVersion: pending.body.__v}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return {po: approved.body, supplier};
}

function receive(po, item, key) {
  return request(`/api/purchase-orders/${po._id}/receive`, {
    method: 'POST',
    token: tokenFor(world.manager),
    headers: {'Idempotency-Key': key},
    body: {items: [{itemId: String(po.items[0]._id), damagedQty: 0, ...item}], expectedVersion: po.__v}
  });
}

function connectSocket(token, branch) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(baseUrl, {auth: {token, branch}, transports: ['websocket'], reconnection: false, timeout: 4000});
    const timer = setTimeout(() => reject(new Error('socket connect timeout')), 4000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', error => { clearTimeout(timer); reject(error); });
  });
}

function joinBranch(socket, branch) {
  return new Promise(resolve => socket.emit('join:branch', String(branch), resolve));
}

function waitEvent(socket, event, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeout);
    socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
  });
}

describe('durable batch and expiry inventory', () => {
  it('allocates ordinary deductions FEFO and exposes usable lot and ledger evidence', async () => {
    await zeroInventory();
    const late = await adjustment({qty: 100, batchNumber: 'LATE-01', expiryDate: dateFromToday(90), key: 'fefo-late'});
    const early = await adjustment({qty: 80, batchNumber: 'EARLY-01', expiryDate: dateFromToday(10), key: 'fefo-early'});
    assert.equal(late.status, 201, late.body?.message);
    assert.equal(early.status, 201, early.body?.message);

    const deduction = await transactionalMovement({
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      qty: -120,
      unit: 'g',
      type: 'RECIPE_DEDUCTION',
      reason: 'FEFO recipe usage',
      referenceType: 'order',
      referenceId: new mongoose.Types.ObjectId(),
      user: world.owner._id,
      idempotencyKey: 'fefo-deduction'
    });
    assert.equal(deduction.batchMovements.length, 2);
    assert.equal(deduction.batchMovements[0].batchNumber, 'EARLY-01');
    assert.equal(deduction.batchMovements[0].changeQty, -80);
    assert.equal(deduction.batchMovements[1].batchNumber, 'LATE-01');
    assert.equal(deduction.batchMovements[1].changeQty, -40);

    const balance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(balance.quantity, 60);
    const earlyLot = await InventoryBatch.findOne({batchNumberNormalized: 'EARLY-01'});
    const lateLot = await InventoryBatch.findOne({batchNumberNormalized: 'LATE-01'});
    assert.equal(earlyLot.quantity, 0);
    assert.equal(lateLot.quantity, 60);

    const inventory = await request(`/api/inventory?branch=${world.branchA._id}`, {token: tokenFor(world.staffA)});
    assert.equal(inventory.status, 200, inventory.body?.message);
    assert.equal(inventory.body[0].stockQty, 60);
    assert.equal(inventory.body[0].usableQty, 60);
    assert.equal(inventory.body[0].batchCount, 1);

    const batches = await request(`/api/inventory/batches?branch=${world.branchA._id}&status=depleted`, {token: tokenFor(world.staffA)});
    assert.equal(batches.status, 200, batches.body?.message);
    assert.equal(batches.body.items.length, 1);
    assert.equal(batches.body.items[0].batchNumber, 'EARLY-01');

    const ledger = await request(`/api/inventory/transactions?branch=${world.branchA._id}`, {token: tokenFor(world.manager)});
    const row = ledger.body.find(item => item._id === String(deduction._id));
    assert.deepEqual(row.batchMovements.map(item => [item.batchNumber, item.changeQty]), [['EARLY-01', -80], ['LATE-01', -40]]);
  });

  it('keeps expired stock physical, excludes it from ordinary use, and permits explicit waste', async () => {
    await zeroInventory();
    const added = await adjustment({qty: 100, batchNumber: 'EXP-01', expiryDate: dateFromToday(-2), key: 'expired-add'});
    assert.equal(added.status, 201, added.body?.message);
    const lot = await InventoryBatch.findOne({batchNumberNormalized: 'EXP-01'});

    const inventory = await request(`/api/inventory?branch=${world.branchA._id}`, {token: tokenFor(world.staffA)});
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body[0].stockQty, 100);
    assert.equal(inventory.body[0].expiredQty, 100);
    assert.equal(inventory.body[0].usableQty, 0);

    await assert.rejects(
      transactionalMovement({
        branch: world.branchA._id,
        ingredient: world.ingredient._id,
        qty: -1,
        unit: 'g',
        type: 'RECIPE_DEDUCTION',
        reason: 'Must not use expired',
        referenceType: 'order',
        referenceId: new mongoose.Types.ObjectId(),
        user: world.owner._id,
        idempotencyKey: 'expired-recipe'
      }),
      error => error.status === 409 && /unexpired/i.test(error.message)
    );
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 100);
    assert.equal((await InventoryBatch.findById(lot._id)).quantity, 100);

    const waste = await request('/api/waste/record', {
      method: 'POST',
      token: tokenFor(world.staffA),
      headers: {'Idempotency-Key': 'expired-waste'},
      body: {
        branch: String(world.branchA._id),
        ingredient: String(world.ingredient._id),
        qty: 25,
        reason: 'expired',
        batchId: String(lot._id)
      }
    });
    assert.equal(waste.status, 201, waste.body?.message);
    assert.equal(waste.body.batchMovements[0].changeQty, -25);
    assert.equal((await InventoryBatch.findById(lot._id)).quantity, 75);
  });

  it('restores the exact original lot allocations on recipe reversal', async () => {
    await zeroInventory();
    await adjustment({qty: 50, batchNumber: 'REV-EARLY', expiryDate: dateFromToday(5), key: 'rev-early'});
    await adjustment({qty: 70, batchNumber: 'REV-LATE', expiryDate: dateFromToday(50), key: 'rev-late'});
    const referenceId = new mongoose.Types.ObjectId();
    const used = await transactionalMovement({
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      qty: -80,
      unit: 'g',
      type: 'RECIPE_DEDUCTION',
      reason: 'Order recipe deduction',
      referenceType: 'order',
      referenceId,
      user: world.owner._id,
      idempotencyKey: 'reversal-original'
    });
    const restored = await transactionalMovement({
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      qty: 80,
      unit: 'g',
      type: 'RECIPE_REVERSAL',
      reason: 'Order cancellation reversal',
      referenceType: 'order',
      referenceId,
      user: world.owner._id,
      idempotencyKey: 'reversal-restored'
    });
    assert.deepEqual(
      restored.batchMovements.map(row => [String(row.batch), row.changeQty]),
      used.batchMovements.map(row => [String(row.batch), Math.abs(row.changeQty)])
    );
    const lots = await InventoryBatch.find({batchNumberNormalized: {$in: ['REV-EARLY', 'REV-LATE']}}).sort({batchNumberNormalized: 1});
    assert.deepEqual(lots.map(row => row.quantity).sort((a, b) => a - b), [50, 70]);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 120);
  });

  it('aggregates shared recipe ingredients and reverses split checks from immutable lot evidence', async () => {
    await zeroInventory();
    await adjustment({qty: 300, batchNumber: 'ORDER-EARLY', expiryDate: dateFromToday(10), key: 'order-early'});
    await adjustment({qty: 300, batchNumber: 'ORDER-LATE', expiryDate: dateFromToday(60), key: 'order-late'});
    const created = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(world.branchA._id),
        items: [
          {menuItem: String(world.menu._id), qty: 1},
          {menuItem: String(world.menu._id), qty: 1}
        ]
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    const deductions = await InventoryTransaction.find({type: 'RECIPE_DEDUCTION', referenceId: created.body._id});
    assert.equal(deductions.length, 1);
    assert.equal(deductions[0].changeQty, -500);
    assert.deepEqual(deductions[0].batchMovements.map(row => [row.batchNumber, row.changeQty]), [
      ['ORDER-EARLY', -300],
      ['ORDER-LATE', -200]
    ]);

    world.menu.recipe[0].qty = 999;
    await world.menu.save();
    const split = await request(`/api/orders/${created.body._id}/split`, {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {items: [{itemId: created.body.items[0]._id, qty: 1}]}
    });
    assert.equal(split.status, 201, split.body?.message);
    const childCancelled = await request(`/api/orders/${split.body.splitOrder._id}/status`, {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'cancelled'}
    });
    assert.equal(childCancelled.status, 200, childCancelled.body?.message);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 350);

    const parentCancelled = await request(`/api/orders/${created.body._id}/status`, {
      method: 'PATCH', token: tokenFor(world.manager), body: {status: 'cancelled'}
    });
    assert.equal(parentCancelled.status, 200, parentCancelled.body?.message);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 600);
    const early = await InventoryBatch.findOne({batchNumberNormalized: 'ORDER-EARLY'});
    const late = await InventoryBatch.findOne({batchNumberNormalized: 'ORDER-LATE'});
    assert.equal(early.quantity, 300);
    assert.equal(late.quantity, 300);
    assert.equal(await InventoryTransaction.countDocuments({type: 'RECIPE_REVERSAL'}), 2);
  });

  it('binds inventory idempotency keys to payload and avoids duplicate lots and quantities', async () => {
    await zeroInventory();
    const first = await adjustment({qty: 25, batchNumber: 'IDEM-01', expiryDate: dateFromToday(30), key: 'same-adjustment'});
    const replay = await adjustment({qty: 25, batchNumber: 'IDEM-01', expiryDate: dateFromToday(30), key: 'same-adjustment'});
    const changed = await adjustment({qty: 26, batchNumber: 'IDEM-01', expiryDate: dateFromToday(30), key: 'same-adjustment'});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(replay.status, 201, replay.body?.message);
    assert.equal(replay.body._id, first.body._id);
    assert.equal(changed.status, 409);
    assert.match(changed.body.message, /different inventory movement/i);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 25);
    assert.equal(await InventoryBatch.countDocuments(), 1);
    assert.equal((await InventoryBatch.findOne()).quantity, 25);
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey: 'same-adjustment'}), 1);
  });

  it('normalizes concurrent replays and scopes idempotency keys by branch', async () => {
    await zeroInventory();
    const concurrent = () => adjustment({
      qty: 15,
      batchNumber: 'IDEM-RACE',
      expiryDate: dateFromToday(30),
      key: 'concurrent-same-key'
    });
    const [first, second] = await Promise.all([concurrent(), concurrent()]);
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);
    assert.equal(first.body._id, second.body._id);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 15);
    assert.equal((await InventoryBatch.findOne({branch: world.branchA._id, batchNumberNormalized: 'IDEM-RACE'})).quantity, 15);
    assert.equal(await InventoryTransaction.countDocuments({branch: world.branchA._id, idempotencyKey: 'concurrent-same-key'}), 1);

    const conflicting = await Promise.all([
      adjustment({qty: 11, batchNumber: 'IDEM-CONFLICT-A', expiryDate: dateFromToday(40), key: 'concurrent-conflict-key'}),
      adjustment({qty: 12, batchNumber: 'IDEM-CONFLICT-B', expiryDate: dateFromToday(50), key: 'concurrent-conflict-key'})
    ]);
    const accepted = conflicting.find(row => row.status === 201);
    const rejected = conflicting.find(row => row.status === 409);
    assert.ok(accepted, 'one conflicting request must succeed');
    assert.ok(rejected, 'one conflicting request must be rejected');
    assert.match(rejected.body.message, /different inventory movement/i);
    assert.equal(
      (await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity,
      15 + accepted.body.changeQty
    );
    assert.equal(await InventoryTransaction.countDocuments({branch: world.branchA._id, idempotencyKey: 'concurrent-conflict-key'}), 1);
    const conflictLots = await InventoryBatch.find({
      branch: world.branchA._id,
      batchNumberNormalized: {$in: ['IDEM-CONFLICT-A', 'IDEM-CONFLICT-B']}
    });
    assert.equal(conflictLots.length, 1);
    assert.equal(conflictLots[0].quantity, accepted.body.changeQty);

    const samePayloadA = await adjustment({qty: 2, key: 'same-payload-a'});
    const samePayloadB = await adjustment({qty: 2, key: 'same-payload-b'});
    assert.equal(samePayloadA.status, 201, samePayloadA.body?.message);
    assert.equal(samePayloadB.status, 201, samePayloadB.body?.message);
    assert.notEqual(samePayloadA.body._id, samePayloadB.body._id);

    const otherBranch = await adjustment({
      qty: 7,
      batchNumber: 'IDEM-OTHER-BRANCH',
      expiryDate: dateFromToday(30),
      key: 'concurrent-same-key',
      branch: world.branchB,
      token: tokenFor(world.owner)
    });
    assert.equal(otherBranch.status, 201, otherBranch.body?.message);
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey: 'concurrent-same-key'}), 2);
    assert.equal((await InventoryBalance.findOne({branch: world.branchB._id, ingredient: world.ingredient._id})).quantity, 7);
  });

  it('serializes competing deductions without diverging aggregate and lot quantities', async () => {
    await zeroInventory();
    await adjustment({qty: 100, batchNumber: 'RACE-01', expiryDate: dateFromToday(30), key: 'race-stock'});
    const move = key => transactionalMovement({
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      qty: -60,
      unit: 'g',
      type: 'RECIPE_DEDUCTION',
      reason: 'Concurrent recipe usage',
      referenceType: 'order',
      referenceId: new mongoose.Types.ObjectId(),
      user: world.owner._id,
      idempotencyKey: key
    });
    const results = await Promise.allSettled([move('race-a'), move('race-b')]);
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    assert.equal(results.filter(row => row.status === 'rejected').length, 1);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 40);
    assert.equal((await InventoryBatch.findOne({batchNumberNormalized: 'RACE-01'})).quantity, 40);
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey: {$in: ['race-a', 'race-b']}}), 1);
  });

  it('preserves source batch and expiry evidence through branch transfers', async () => {
    await zeroInventory();
    const expiryDate = dateFromToday(40);
    await adjustment({qty: 100, batchNumber: 'MOVE-01', expiryDate, key: 'transfer-stock'});
    const created = await request('/api/transfers', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        fromBranch: String(world.branchA._id),
        toBranch: String(world.branchB._id),
        ingredient: String(world.ingredient._id),
        qty: 40,
        unit: 'g'
      }
    });
    assert.equal(created.status, 201, created.body?.message);
    for (const status of ['approved', 'in_transit', 'received']) {
      const transitioned = await request(`/api/transfers/${created.body._id}/status`, {
        method: 'PATCH', token: tokenFor(world.owner), body: {status}
      });
      assert.equal(transitioned.status, 200, transitioned.body?.message);
    }
    const source = await InventoryBatch.findOne({branch: world.branchA._id, batchNumberNormalized: 'MOVE-01'});
    const destination = await InventoryBatch.findOne({branch: world.branchB._id, batchNumberNormalized: 'MOVE-01'});
    assert.equal(source.quantity, 60);
    assert.equal(destination.quantity, 40);
    assert.equal(destination.expiryDate.toISOString().slice(0, 10), expiryDate);
    assert.equal(destination.sourceType, 'transfer');
    assert.equal(String(destination.sourceId), String(created.body._id));
    const inbound = await InventoryTransaction.findOne({type: 'TRANSFER_IN', referenceId: created.body._id});
    assert.equal(inbound.batchMovements.length, 1);
    assert.equal(inbound.batchMovements[0].batchNumber, 'MOVE-01');
  });

  it('creates source-linked receipt lots and rejects unsafe expiry combinations atomically', async () => {
    await zeroInventory();
    const {po, supplier} = await createApprovedPo({qty: 100, unitPrice: 0.75});
    const missingBatch = await receive(po, {receivedQty: 10, expiryDate: dateFromToday(20)}, 'receipt-missing-batch');
    assert.equal(missingBatch.status, 400);
    const expired = await receive(po, {receivedQty: 10, batchNumber: 'OLD-01', expiryDate: dateFromToday(-1)}, 'receipt-expired');
    assert.equal(expired.status, 409);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po._id}), 0);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 0);

    const expiryDate = dateFromToday(60);
    const accepted = await receive(po, {receivedQty: 35, batchNumber: 'GRN-01', expiryDate}, 'receipt-batch-ok');
    assert.equal(accepted.status, 201, accepted.body?.message);
    const receipt = await GoodsReceipt.findById(accepted.body.receipt._id);
    const lot = await InventoryBatch.findOne({sourceType: 'goods_receipt', sourceId: receipt._id});
    assert.ok(lot);
    assert.equal(lot.batchNumber, 'GRN-01');
    assert.equal(lot.expiryDate.toISOString().slice(0, 10), expiryDate);
    assert.equal(lot.quantity, 35);
    assert.equal(lot.unitCost, 0.75);
    assert.equal(String(lot.sourceLine), String(po.items[0]._id));
    assert.equal(String(lot.supplier), String(supplier._id));
    const transaction = await InventoryTransaction.findOne({referenceType: 'goods_receipt', referenceId: receipt._id});
    assert.equal(transaction.batchMovements.length, 1);
    assert.equal(String(transaction.batchMovements[0].batch), String(lot._id));
  });

  it('backfills and reconciles legacy balances idempotently while removing singleton metadata', async () => {
    await zeroInventory();
    const balance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    await InventoryBalance.collection.updateOne({_id: balance._id}, {$set: {
      quantity: 500,
      averageCost: 0.2,
      batchNumber: 'UNSAFE-SINGLETON',
      expiryDate: new Date('2000-01-01T00:00:00.000Z')
    }});

    const first = await ensureInventoryBatchIndexes();
    assert.equal(first.backfilled, 1);
    assert.equal(first.unresolved, 0);
    const legacy = await InventoryBatch.findOne({lotKey: `legacy:${balance._id}`});
    assert.ok(legacy);
    assert.equal(legacy.quantity, 500);
    assert.equal(legacy.initialQuantity, 500);
    assert.equal(legacy.batchNumber, undefined);
    assert.equal(legacy.expiryDate, undefined);
    const rawBalance = await InventoryBalance.collection.findOne({_id: balance._id});
    assert.equal(Object.hasOwn(rawBalance, 'batchNumber'), false);
    assert.equal(Object.hasOwn(rawBalance, 'expiryDate'), false);

    const second = await ensureInventoryBatchIndexes();
    assert.equal(second.backfilled, 0);
    assert.equal(await InventoryBatch.countDocuments({lotKey: `legacy:${balance._id}`}), 1);

    await InventoryBatch.updateOne({_id: legacy._id}, {$set: {quantity: 125}});
    const reconciled = await ensureInventoryBatchIndexes();
    assert.equal(reconciled.backfilled, 1);
    assert.equal((await InventoryBatch.findById(legacy._id)).quantity, 500);

    await InventoryBalance.updateOne({_id: balance._id}, {$set: {quantity: 0}});
    const reconciledToZero = await ensureInventoryBatchIndexes();
    assert.equal(reconciledToZero.backfilled, 1);
    assert.equal((await InventoryBatch.findById(legacy._id)).quantity, 0);
    assert.equal((await InventoryBatch.findById(legacy._id)).initialQuantity, 500);
    const indexes = await InventoryBatch.collection.indexes();
    for (const name of ['inventory_batch_lot_key', 'inventory_batch_expiry_quantity', 'inventory_batch_lookup']) {
      assert.ok(indexes.some(index => index.name === name), `missing ${name}`);
    }
    const transactionIndexes = await InventoryTransaction.collection.indexes();
    assert.ok(transactionIndexes.some(index => index.name === 'inventory_transaction_purchasing_report'));
    const orderIndexes = await mongoose.connection.db.collection('orders').indexes();
    assert.ok(orderIndexes.some(index => index.name === 'order_inventory_source_orders'));
  });

  it('enforces branch and restaurant boundaries on batch reads and transfer creation', async () => {
    await zeroInventory();
    await adjustment({qty: 10, batchNumber: 'SCOPE-01', expiryDate: dateFromToday(30), key: 'scope-stock'});
    assert.equal((await request(`/api/inventory/batches?branch=${world.branchA._id}`, {token: tokenFor(world.staffA)})).status, 200);
    assert.equal((await request(`/api/inventory/batches?branch=${world.branchB._id}`, {token: tokenFor(world.manager)})).status, 403);
    assert.equal((await request(`/api/inventory/batches?branch=${world.branchA._id}`, {
      token: jwt.sign({id: world.owner._id, role: 'guest'}, process.env.JWT_SECRET)
    })).status, 403);

    const otherRestaurant = await Restaurant.create({name: 'Foreign Restaurant'});
    const otherBranch = await Branch.create({restaurant: otherRestaurant._id, name: 'Foreign Branch', code: 'FOR'});
    const otherOwner = await User.create({
      name: 'Foreign Owner', email: 'foreign-batches@test.com', password: 'hashed', role: 'owner',
      restaurant: otherRestaurant.name, restaurantId: otherRestaurant._id
    });
    const otherIngredient = await Ingredient.create({restaurant: otherRestaurant._id, code: 'FOREIGN', name: 'Foreign Stock', unit: 'g'});
    await InventoryBalance.create({branch: otherBranch._id, ingredient: otherIngredient._id, quantity: 0});
    assert.equal((await request(`/api/inventory/batches?branch=${world.branchA._id}`, {token: tokenFor(otherOwner)})).status, 403);
    const crossTenantOrder = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(otherOwner),
      body: {branch: String(world.branchA._id), items: [{menuItem: String(world.menu._id), qty: 1}]}
    });
    assert.equal(crossTenantOrder.status, 403);

    const crossTenant = await request('/api/transfers', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        fromBranch: String(world.branchA._id),
        toBranch: String(otherBranch._id),
        ingredient: String(world.ingredient._id),
        qty: 1,
        unit: 'g'
      }
    });
    assert.equal(crossTenant.status, 404);
  });

  it('publishes branch-scoped inventory updates and rejects cross-tenant socket rooms', async () => {
    await zeroInventory();
    const socketA = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    try {
      assert.equal((await joinBranch(socketA, world.branchA._id)).ok, true);
      assert.equal((await joinBranch(socketB, world.branchB._id)).ok, true);
      const leaked = [];
      socketB.on('inventory:update', payload => leaked.push(payload));
      const pending = waitEvent(socketA, 'inventory:update');
      const result = await adjustment({qty: 12, batchNumber: 'LIVE-01', expiryDate: dateFromToday(20), key: 'live-adjustment'});
      assert.equal(result.status, 201, result.body?.message);
      const event = await pending;
      assert.equal(event.reason, 'adjustment');
      assert.equal(String(event.branch), String(world.branchA._id));
      assert.equal(event.transactionId, result.body._id);
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(leaked.length, 0);

      const foreignRestaurant = await Restaurant.create({name: 'Socket Foreign'});
      const foreignOwner = await User.create({
        name: 'Socket Foreign Owner', email: 'socket-foreign@test.com', password: 'hashed', role: 'owner',
        restaurant: foreignRestaurant.name, restaurantId: foreignRestaurant._id
      });
      const foreignSocket = await connectSocket(tokenFor(foreignOwner), world.branchA._id);
      try {
        const denied = await joinBranch(foreignSocket, world.branchA._id);
        assert.equal(denied.ok, false);
        assert.equal(denied.status, 403);
      } finally {
        foreignSocket.close();
      }
    } finally {
      socketA.close();
      socketB.close();
    }
  });
});
