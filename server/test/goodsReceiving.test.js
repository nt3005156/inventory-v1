import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {Audit, Ingredient, Supplier, User} from '../src/models/index.js';
import {Branch, InventoryBalance, InventoryTransaction, PurchaseOrder, Restaurant} from '../src/models/operations.js';
import {GoodsReceipt, GoodsReceiptCounter} from '../src/models/purchasing.js';
import {ensureGoodsReceivingIndexes} from '../src/services/goodsReceivingMigration.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;
let supplier;

before(async () => {
  await startTestApp();
  await ensureGoodsReceivingIndexes();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Receiving Supplier'});
});

async function createApprovedPo({currentWorld = world, currentSupplier = supplier, qty = 100, unitPrice = 0.5, actor} = {}) {
  const user = actor || currentWorld.owner;
  const created = await request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': `po-${currentWorld.restaurant._id}-${Math.random()}`},
    body: {
      branch: String(currentWorld.branchA._id),
      supplier: String(currentSupplier._id),
      items: [{
        ingredient: String(currentWorld.ingredient._id),
        orderedQty: qty,
        unit: 'g',
        unitPrice
      }]
    }
  });
  assert.equal(created.status, 201, created.body?.message);
  const pending = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(user), body: {status: 'pending', expectedVersion: created.body.__v}
  });
  assert.equal(pending.status, 200, pending.body?.message);
  const approved = await request(`/api/purchase-orders/${created.body._id}/status`, {
    method: 'PATCH', token: tokenFor(currentWorld.owner), body: {status: 'approved', expectedVersion: pending.body.__v}
  });
  assert.equal(approved.status, 200, approved.body?.message);
  return approved.body;
}

function postReceipt(po, {items, key, user = world.manager, notes = 'Counted at receiving bay', expectedVersion = po.__v, preserveLegacyDamage = false} = {}) {
  const receiptItems = items || [{itemId: String(po.items[0]._id), receivedQty: 25, damagedQty: 0}];
  return request(`/api/purchase-orders/${po._id}/receive`, {
    method: 'POST',
    token: tokenFor(user),
    headers: key ? {'Idempotency-Key': key} : {},
    body: {
      items: receiptItems.map(item => !preserveLegacyDamage && Number(item.damagedQty || 0) > 0 && !item.damageReason ? {...item, damageReason: 'quality'} : item),
      notes,
      expectedVersion
    }
  });
}

async function seedOtherTenant() {
  const restaurant = await Restaurant.create({name: 'Other Restaurant', currency: 'NPR', vatRate: 13});
  const branchA = await Branch.create({restaurant: restaurant._id, name: 'Bhaktapur Branch', code: 'BKT'});
  const owner = await User.create({
    name: 'Other Owner', email: 'other-owner@test.com', password: 'hashed', role: 'owner',
    restaurant: restaurant.name, restaurantId: restaurant._id
  });
  const ingredient = await Ingredient.create({
    restaurant: restaurant._id, code: 'OTHER-RICE', name: 'Other Rice', unit: 'g', averageCost: 1
  });
  await InventoryBalance.create({branch: branchA._id, ingredient: ingredient._id, quantity: 0, averageCost: 0});
  const currentSupplier = await Supplier.create({restaurant: restaurant._id, name: 'Other Supplier'});
  return {restaurant, branchA, owner, ingredient, supplier: currentSupplier};
}

describe('production goods receiving', () => {
  it('uses authoritative PO cost, durable tenant numbering, exact ledger linkage, and complete audit state', async () => {
    const po = await createApprovedPo({qty: 100, unitPrice: 0.75});
    const beforeBalance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();

    const tampered = await postReceipt(po, {
      key: 'authoritative-cost',
      items: [{itemId: String(po.items[0]._id), receivedQty: 40, damagedQty: 5, unitPrice: 9999}]
    });
    assert.equal(tampered.status, 400);

    const result = await postReceipt(po, {
      key: 'authoritative-cost',
      items: [{itemId: String(po.items[0]._id), receivedQty: 40, damagedQty: 5}]
    });
    assert.equal(result.status, 201, result.body?.message);
    assert.match(result.body.receipt.receiptNo, /^GR-KTM-\d{4}-000001$/);
    assert.equal(result.body.receipt.restaurant, String(world.restaurant._id));
    assert.equal(result.body.receipt.items[0].unitPrice, 0.75);
    assert.equal(result.body.receipt.receivedValue, 30);
    assert.equal(result.body.receipt.acceptedValue, 26.25);
    assert.equal(result.body.receipt.damagedValue, 3.75);
    assert.equal(result.body.receipt.idempotencyKey, undefined);
    assert.equal(result.body.receipt.requestHash, undefined);

    const ledger = await InventoryTransaction.findOne({referenceType: 'goods_receipt', referenceId: result.body.receipt._id}).lean();
    assert.ok(ledger);
    assert.equal(String(ledger.branch), String(world.branchA._id));
    assert.equal(String(ledger.ingredient), String(world.ingredient._id));
    assert.equal(ledger.previousQty, beforeBalance.quantity);
    assert.equal(ledger.changeQty, 35);
    assert.equal(ledger.newQty, beforeBalance.quantity + 35);
    assert.equal(ledger.unitCost, 0.75);
    assert.equal(ledger.totalCost, 26.25);
    assert.equal(String(ledger.user), String(world.manager._id));
    assert.equal(ledger.reason, `${result.body.receipt.receiptNo} ${po.poNo}`);
    assert.equal(String(ledger.referenceId), String(result.body.receipt._id));
    assert.match(ledger.idempotencyKey, /^receipt:/);

    const audit = await Audit.findOne({entity: 'purchase_order', entityId: po._id, action: 'receive'}).lean();
    assert.equal(String(audit.restaurant), String(world.restaurant._id));
    assert.equal(String(audit.branch), String(world.branchA._id));
    assert.equal(audit.before.status, 'approved');
    assert.equal(audit.before.lines[0].receivedQty, 0);
    assert.equal(audit.after.status, 'partially_received');
    assert.equal(audit.after.acceptedValue, 26.25);
    assert.equal(audit.after.lines[0].receivedNow, 40);
    assert.equal(audit.after.lines[0].remainingQty, 60);
  });

  it('rejects duplicate request lines atomically instead of cumulatively over-receiving', async () => {
    const po = await createApprovedPo({qty: 100});
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    const itemId = String(po.items[0]._id);
    const result = await postReceipt(po, {
      key: 'duplicate-lines',
      items: [
        {itemId, receivedQty: 60, damagedQty: 0},
        {itemId, receivedQty: 60, damagedQty: 0}
      ]
    });
    assert.equal(result.status, 400);
    assert.match(result.body.message, /only once/i);
    const fresh = await PurchaseOrder.findById(po._id).lean();
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(fresh.items[0].receivedQty, 0);
    assert.equal(after.quantity, before.quantity);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po._id}), 0);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), 0);
    assert.equal(await GoodsReceiptCounter.countDocuments(), 0);
  });

  it('requires payload-bound idempotency and rejects changed or cross-PO reuse', async () => {
    const po = await createApprovedPo({qty: 100});
    const withoutKey = await postReceipt(po, {key: null});
    assert.equal(withoutKey.status, 400);
    assert.match(withoutKey.body.message, /Idempotency-Key is required/i);

    const first = await postReceipt(po, {key: 'payload-bound'});
    assert.equal(first.status, 201, first.body?.message);
    const replay = await postReceipt(po, {key: 'payload-bound'});
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.receipt._id, first.body.receipt._id);

    const changed = await postReceipt(po, {
      key: 'payload-bound',
      items: [{itemId: String(po.items[0]._id), receivedQty: 20, damagedQty: 0}]
    });
    assert.equal(changed.status, 409);
    assert.match(changed.body.message, /different receiving request/i);

    const otherPo = await createApprovedPo({qty: 50});
    const other = await postReceipt(otherPo, {key: 'payload-bound'});
    assert.equal(other.status, 409);
    assert.equal(await GoodsReceipt.countDocuments({restaurant: world.restaurant._id, idempotencyKey: 'payload-bound'}), 1);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), 1);
  });

  it('serializes concurrent full receipts and never overstates PO or stock quantities', async () => {
    const po = await createApprovedPo({qty: 100, unitPrice: 0.5});
    const before = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    const item = [{itemId: String(po.items[0]._id), receivedQty: 100, damagedQty: 0}];
    const [one, two] = await Promise.all([
      postReceipt(po, {key: 'concurrent-a', items: item}),
      postReceipt(po, {key: 'concurrent-b', items: item})
    ]);
    assert.deepEqual([one.status, two.status].sort(), [201, 409]);
    const fresh = await PurchaseOrder.findById(po._id).lean();
    const after = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(fresh.status, 'received');
    assert.equal(fresh.items[0].receivedQty, 100);
    assert.equal(after.quantity, before.quantity + 100);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po._id}), 1);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), 1);
  });

  it('replays simultaneous identical submissions and allocates monotonic receipt numbers', async () => {
    const po = await createApprovedPo({qty: 100});
    const items = [{itemId: String(po.items[0]._id), receivedQty: 25, damagedQty: 0}];
    const [one, two] = await Promise.all([
      postReceipt(po, {key: 'parallel-same', items}),
      postReceipt(po, {key: 'parallel-same', items})
    ]);
    assert.deepEqual([one.status, two.status].sort(), [200, 201]);
    assert.equal(one.body.receipt._id, two.body.receipt._id);

    const second = await postReceipt(one.body.purchaseOrder, {
      key: 'parallel-next',
      items: [{itemId: String(po.items[0]._id), receivedQty: 25, damagedQty: 0}],
      expectedVersion: one.body.purchaseOrder.__v
    });
    assert.equal(second.status, 201, second.body?.message);
    assert.match(one.body.receipt.receiptNo, /-000001$/);
    assert.match(second.body.receipt.receiptNo, /-000002$/);
    assert.equal(await GoodsReceiptCounter.countDocuments({restaurant: world.restaurant._id}), 1);
  });

  it('allows the same idempotency key in different restaurants while isolating history and restaurant-wide reports', async () => {
    const other = await seedOtherTenant();
    const firstPo = await createApprovedPo({qty: 40});
    const otherPo = await createApprovedPo({currentWorld: other, currentSupplier: other.supplier, qty: 30, unitPrice: 1, actor: other.owner});
    const first = await postReceipt(firstPo, {key: 'cross-tenant-key'});
    const second = await postReceipt(otherPo, {
      key: 'cross-tenant-key',
      user: other.owner,
      items: [{itemId: String(otherPo.items[0]._id), receivedQty: 10, damagedQty: 0}]
    });
    assert.equal(first.status, 201, first.body?.message);
    assert.equal(second.status, 201, second.body?.message);
    assert.notEqual(first.body.receipt._id, second.body.receipt._id);

    const denied = await request(`/api/purchase-orders/${firstPo._id}/receipts`, {token: tokenFor(other.owner)});
    assert.equal(denied.status, 403);
    const history = await request(`/api/purchase-orders/${firstPo._id}/receipts`, {token: tokenFor(world.owner)});
    assert.equal(history.status, 200);
    assert.equal(history.body.length, 1);
    assert.equal(history.body[0].receivedBy.name, world.manager.name);
    assert.equal(history.body[0].receivedBy.password, undefined);
    assert.equal(history.body[0].receivedBy.email, undefined);

    const report = await request('/api/reports/purchasing', {token: tokenFor(world.owner)});
    assert.equal(report.status, 200, report.body?.message);
    assert.equal(report.body.purchaseOrders.count, 1);
    assert.equal(report.body.receipts.count, 1);
    assert.equal(report.body.receipts.acceptedValue, first.body.receipt.acceptedValue);
  });

  it('rejects persisted supplier or ingredient references outside the purchase order tenant', async () => {
    const other = await seedOtherTenant();
    const po = await createApprovedPo({qty: 30});

    await PurchaseOrder.collection.updateOne({poNo: po.poNo}, {$set: {supplier: other.supplier._id}});
    const foreignSupplier = await postReceipt(po, {key: 'foreign-supplier'});
    assert.equal(foreignSupplier.status, 409);
    assert.match(foreignSupplier.body.message, /supplier does not belong/i);

    await PurchaseOrder.collection.updateOne({poNo: po.poNo}, {
      $set: {supplier: supplier._id, 'items.0.ingredient': other.ingredient._id}
    });
    const foreignIngredient = await postReceipt(po, {key: 'foreign-ingredient'});
    assert.equal(foreignIngredient.status, 409);
    assert.match(foreignIngredient.body.message, /ingredient does not belong/i);
    assert.equal(await GoodsReceipt.countDocuments({purchaseOrder: po._id}), 0);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'goods_receipt'}), 0);
    assert.equal(await GoodsReceiptCounter.countDocuments(), 0);
  });

  it('backfills legacy receipt tenancy and values and keeps receiving indexes idempotent', async () => {
    const po = await createApprovedPo({qty: 100, unitPrice: 0.5});
    const inserted = await GoodsReceipt.collection.insertOne({
      receiptNo: 'GR-LEGACY01',
      purchaseOrder: po._id,
      branch: world.branchA._id,
      supplier: supplier._id,
      idempotencyKey: 'legacy-key',
      receivedBy: world.manager._id,
      items: [{
        poItem: po.items[0]._id,
        ingredient: world.ingredient._id,
        receivedQty: 10,
        damagedQty: 2,
        acceptedQty: 8,
        unit: 'g',
        unitPrice: 0.5
      }],
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z')
    });
    const migration = await ensureGoodsReceivingIndexes();
    assert.ok(migration.migrated >= 1);
    assert.equal(migration.unresolved, 0);
    const legacy = await GoodsReceipt.collection.findOne({_id: inserted.insertedId});
    assert.equal(String(legacy.restaurant), String(world.restaurant._id));
    assert.equal(legacy.numberVersion, 1);
    assert.equal(legacy.receivedValue, 5);
    assert.equal(legacy.acceptedValue, 4);
    assert.equal(legacy.damagedValue, 1);
    assert.equal(legacy.receivedAt.toISOString(), '2025-01-01T00:00:00.000Z');
    assert.equal(legacy.requestHashVersion, 2);
    assert.equal(legacy.items[0].damageReason, 'legacy_unspecified');
    assert.equal(legacy.items[0].damageDisposition, 'rejected_at_receiving');
    assert.match(legacy.requestHash, /^[a-f0-9]{64}$/);

    const replay = await postReceipt(po, {
      key: 'legacy-key',
      notes: '',
      preserveLegacyDamage: true,
      items: [{itemId: String(po.items[0]._id), receivedQty: 10, damagedQty: 2}]
    });
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(replay.body.duplicate, true);
    assert.equal(replay.body.receipt._id, String(inserted.insertedId));
    const changedReplay = await postReceipt(po, {
      key: 'legacy-key',
      notes: '',
      preserveLegacyDamage: true,
      items: [{itemId: String(po.items[0]._id), receivedQty: 9, damagedQty: 2}]
    });
    assert.equal(changedReplay.status, 409);

    const rerun = await ensureGoodsReceivingIndexes();
    assert.equal(rerun.migrated, 0);
    const indexes = await GoodsReceipt.collection.indexes();
    for (const name of ['gr_restaurant_number_v2', 'gr_restaurant_idempotency_key', 'gr_restaurant_branch_po_created']) {
      assert.ok(indexes.some(index => index.name === name), `missing ${name}`);
    }
    assert.ok((await GoodsReceiptCounter.collection.indexes()).some(index => index.name === 'gr_counter_scope'));
  });
});
