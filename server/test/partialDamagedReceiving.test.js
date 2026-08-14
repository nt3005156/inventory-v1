import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {Audit, Supplier} from '../src/models/index.js';
import {InventoryBalance, InventoryTransaction, PurchaseOrder} from '../src/models/operations.js';
import {GoodsReceipt} from '../src/models/purchasing.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let supplier;
let keySequence = 0;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Exception Supply Nepal'});
});

async function createApprovedPo({qty = 100, branch = world.branchA, creator = world.manager} = {}) {
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(creator),
    headers: {'Idempotency-Key': `partial-po-${++keySequence}`},
    body: {
      branch: String(branch._id),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty: qty, unit: 'g', unitPrice: 2}]
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(creator), body: {status: 'pending', expectedVersion: created.body.__v}
  });
  assert.equal(pending.status, 200, pending.body?.message);
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(world.owner), body: {status: 'approved', expectedVersion: pending.body.__v}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return approved.body;
}

function receive(po, items, {key = `partial-gr-${++keySequence}`, user = world.manager, expectedVersion = po.__v, notes} = {}) {
  return request(`/api/purchase-orders/${po._id}/receive`, {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': key},
    body: {items, notes, expectedVersion}
  });
}

function closeShort(po, {reason = 'Supplier confirmed the remaining quantity is unavailable', user = world.manager, expectedVersion = po.__v, key = `short-close-${++keySequence}`} = {}) {
  return request(`/api/purchase-orders/${po._id}/close-short`, {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': key},
    body: {reason, expectedVersion}
  });
}

describe('partial and damaged goods receiving', () => {
  it('requires structured damage details and rejects invalid combinations atomically', async () => {
    const po = await createApprovedPo();
    const itemId = String(po.items[0]._id);
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();

    const missingReason = await receive(po, [{itemId, receivedQty: 20, damagedQty: 5}], {key: 'missing-damage-reason'});
    assert.equal(missingReason.status, 400);
    assert.match(missingReason.body.message, /damage reason/i);

    const missingOtherDetail = await receive(po, [{itemId, receivedQty: 20, damagedQty: 5, damageReason: 'other'}], {key: 'missing-other-detail'});
    assert.equal(missingOtherDetail.status, 400);
    assert.match(missingOtherDetail.body.message, /damage notes/i);

    const detailsWithoutDamage = await receive(po, [{itemId, receivedQty: 20, damagedQty: 0, damageReason: 'quality'}], {key: 'orphan-damage-detail'});
    assert.equal(detailsWithoutDamage.status, 400);
    assert.match(detailsWithoutDamage.body.message, /damaged quantity/i);

    const fresh = await PurchaseOrder.findById(po._id).lean();
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(fresh.items[0].receivedQty, 0);
    assert.equal(after.quantity, before.quantity);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po._id}), 0);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), 0);
  });

  it('persists immutable damage reason, disposition and notes while stocking only accepted quantity', async () => {
    const po = await createApprovedPo();
    const itemId = String(po.items[0]._id);
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    const result = await receive(po, [{
      itemId,
      receivedQty: 40,
      damagedQty: 7,
      damageReason: 'transport_damage',
      damageNotes: 'Outer sacks were torn on arrival'
    }], {key: 'documented-damage', notes: 'Driver acknowledged damage'});

    assert.equal(result.status, 201, result.body?.message);
    assert.equal(result.body.purchaseOrder.status, 'partially_received');
    assert.equal(result.body.receipt.items[0].acceptedQty, 33);
    assert.equal(result.body.receipt.items[0].damageReason, 'transport_damage');
    assert.equal(result.body.receipt.items[0].damageDisposition, 'rejected_at_receiving');
    assert.equal(result.body.receipt.items[0].damageNotes, 'Outer sacks were torn on arrival');
    assert.equal(result.body.receipt.acceptedValue, 66);
    assert.equal(result.body.receipt.damagedValue, 14);
    assert.equal(result.body.receipt.requestHashVersion, undefined);
    assert.equal(result.body.receipt.idempotencyKey, undefined);

    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(after.quantity, before.quantity + 33);
    const ledger = await InventoryTransaction.find({referenceType: 'goods_receipt', referenceId: result.body.receipt._id}).lean();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].changeQty, 33);
    assert.equal(ledger[0].totalCost, 66);

    const audit = await Audit.findOne({entityId: po._id, action: 'receive'}).lean();
    assert.equal(audit.after.lines[0].damageReason, 'transport_damage');
    assert.equal(audit.after.lines[0].damageDisposition, 'rejected_at_receiving');
    assert.equal(audit.after.lines[0].damageNotes, 'Outer sacks were torn on arrival');

    const history = await request(`/api/purchase-orders/${po._id}/receipts`, {token: tokenFor(world.staffA)});
    assert.equal(history.status, 200, history.body?.message);
    assert.equal(history.body[0].items[0].damageReason, 'transport_damage');
    assert.equal(history.body[0].items[0].damageDisposition, 'rejected_at_receiving');
  });

  it('binds damage documentation into idempotency and does not double-post fully damaged delivery', async () => {
    const po = await createApprovedPo({qty: 25});
    const itemId = String(po.items[0]._id);
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    const items = [{itemId, receivedQty: 25, damagedQty: 25, damageReason: 'spoiled', damageNotes: 'Strong off smell'}];

    const first = await receive(po, items, {key: 'fully-damaged'});
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(first.body.purchaseOrder.status, 'received');
    assert.equal(first.body.receipt.acceptedValue, 0);
    assert.equal(first.body.receipt.damagedValue, 50);

    const replay = await receive(po, items, {key: 'fully-damaged'});
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.receipt._id, first.body.receipt._id);

    const changedReason = await receive(po, [{...items[0], damageReason: 'quality'}], {key: 'fully-damaged'});
    assert.equal(changedReason.status, 409);
    assert.match(changedReason.body.message, /different receiving request/i);

    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(after.quantity, before.quantity);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), 0);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po._id}), 1);
  });

  it('closes a partially received PO short with durable reason, audit and no stock movement', async () => {
    const po = await createApprovedPo({qty: 100});
    const itemId = String(po.items[0]._id);
    const partial = await receive(po, [{itemId, receivedQty: 40, damagedQty: 5, damageReason: 'packaging_damage'}], {key: 'short-first'});
    assert.equal(partial.status, 201, partial.body?.message);
    assert.equal(partial.body.purchaseOrder.status, 'partially_received');
    const ledgerBeforeClose = await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'});

    const closed = await closeShort(partial.body.purchaseOrder, {reason: 'Supplier discontinued this pack size', key: 'durable-short-close'});
    assert.equal(closed.status, 200, closed.body?.message);
    assert.equal(closed.body.status, 'closed_short');
    assert.equal(closed.body.shortCloseReason, 'Supplier discontinued this pack size');
    assert.equal(closed.body.shortClosedBy.name, world.manager.name);
    assert.ok(closed.body.shortClosedAt);
    assert.equal(closed.body.items[0].receivedQty, 40);
    assert.equal(closed.body.items[0].damagedQty, 5);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), ledgerBeforeClose);

    const retry = await closeShort(partial.body.purchaseOrder, {reason: 'Supplier discontinued this pack size', key: 'durable-short-close'});
    assert.equal(retry.status, 200, retry.body?.message);
    assert.equal(retry.body.status, 'closed_short');
    const changedRetry = await closeShort(partial.body.purchaseOrder, {reason: 'Supplier changed the commitment', key: 'durable-short-close'});
    assert.equal(changedRetry.status, 409);
    assert.match(changedRetry.body.message, /different short-close request/i);

    const audit = await Audit.findOne({entityId: po._id, action: 'po_short_close'}).lean();
    assert.equal(String(audit.restaurant), String(world.restaurant._id));
    assert.equal(String(audit.branch), String(world.branchA._id));
    assert.equal(audit.before.status, 'partially_received');
    assert.equal(audit.after.status, 'closed_short');
    assert.equal(audit.after.outstanding[0].shortQty, 60);
    assert.equal(audit.reason, 'Supplier discontinued this pack size');
    assert.equal(await Audit.countDocuments({entityId: po._id, action: 'po_short_close'}), 1);

    const blocked = await receive(closed.body, [{itemId, receivedQty: 10, damagedQty: 0}], {key: 'after-short-close'});
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /approved before receiving/i);
    const exactReplay = await receive(closed.body, [{itemId, receivedQty: 40, damagedQty: 5, damageReason: 'packaging_damage'}], {key: 'short-first'});
    assert.equal(exactReplay.status, 200, exactReplay.body?.message);
    assert.equal(exactReplay.body.duplicate, true);

    const report = await request(`/api/reports/purchasing?branch=${world.branchA._id}`, {token: tokenFor(world.owner)});
    assert.equal(report.status, 200, report.body?.message);
    assert.equal(report.body.purchaseOrders.shortClosedCount, 1);
    assert.equal(report.body.purchaseOrders.shortClosedQty, 60);
    assert.equal(report.body.purchaseOrders.outstandingQty, 0);
    assert.deepEqual(report.body.receipts.damageByReason, [{reason: 'packaging_damage', qty: 5, value: 10}]);
  });

  it('rejects invalid, stale and unauthorized short closes with branch isolation', async () => {
    const unreceived = await createApprovedPo();
    assert.equal((await closeShort(unreceived)).status, 409);

    const po = await createApprovedPo();
    const itemId = String(po.items[0]._id);
    const partial = await receive(po, [{itemId, receivedQty: 20, damagedQty: 0}], {key: 'auth-short'});
    assert.equal(partial.status, 201, partial.body?.message);

    const missingKey = await request(`/api/purchase-orders/${po._id}/close-short`, {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {reason: 'Supplier cancelled delivery', expectedVersion: partial.body.purchaseOrder.__v}
    });
    assert.equal(missingKey.status, 400);
    assert.match(missingKey.body.message, /idempotency-key/i);
    assert.equal((await closeShort(partial.body.purchaseOrder, {reason: 'x'})).status, 400);
    assert.equal((await closeShort(partial.body.purchaseOrder, {user: world.staffA})).status, 403);
    assert.equal((await closeShort(partial.body.purchaseOrder, {expectedVersion: po.__v})).status, 409);

    const branchBPo = await createApprovedPo({branch: world.branchB, creator: world.owner});
    const branchBPartial = await receive(branchBPo, [{itemId: String(branchBPo.items[0]._id), receivedQty: 10, damagedQty: 0}], {
      key: 'branch-b-short', user: world.owner
    });
    assert.equal(branchBPartial.status, 201, branchBPartial.body?.message);
    const crossBranch = await closeShort(branchBPartial.body.purchaseOrder, {user: world.manager});
    assert.equal(crossBranch.status, 403);

    const fresh = await PurchaseOrder.findById(po._id).lean();
    assert.equal(fresh.status, 'partially_received');
    assert.equal(fresh.shortClosedAt, undefined);
  });

  it('serializes a short close racing another partial receipt', async () => {
    const po = await createApprovedPo();
    const itemId = String(po.items[0]._id);
    const partial = await receive(po, [{itemId, receivedQty: 20, damagedQty: 0}], {key: 'race-initial'});
    assert.equal(partial.status, 201, partial.body?.message);
    const current = partial.body.purchaseOrder;
    const balanceBefore = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();

    const [closeResult, receiptResult] = await Promise.all([
      closeShort(current, {reason: 'Supplier cancelled the remaining delivery'}),
      receive(current, [{itemId, receivedQty: 10, damagedQty: 0}], {key: 'race-receipt'})
    ]);
    assert.equal([closeResult.status, receiptResult.status].filter(status => status === 200 || status === 201).length, 1);
    assert.equal([closeResult.status, receiptResult.status].filter(status => status === 409).length, 1);

    const fresh = await PurchaseOrder.findById(po._id).lean();
    const balanceAfter = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    if (closeResult.status === 200) {
      assert.equal(fresh.status, 'closed_short');
      assert.equal(fresh.items[0].receivedQty, 20);
      assert.equal(balanceAfter.quantity, balanceBefore.quantity);
    } else {
      assert.equal(fresh.status, 'partially_received');
      assert.equal(fresh.items[0].receivedQty, 30);
      assert.equal(balanceAfter.quantity, balanceBefore.quantity + 10);
    }
  });
});
