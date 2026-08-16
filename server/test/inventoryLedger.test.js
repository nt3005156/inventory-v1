import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Ingredient, User} from '../src/models/index.js';
import {
  Branch,
  INVENTORY_MOVEMENT_TYPES,
  InventoryBalance,
  InventoryBatch,
  InventoryTransaction,
  Restaurant
} from '../src/models/operations.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {ensureInventoryLedgerIndexes} from '../src/services/inventoryLedgerMigration.js';
import {ensureInventoryBatchIndexes} from '../src/services/inventoryBatchMigration.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let world;

before(async () => {
  await startTestApp();
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

async function transaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function movement(overrides = {}) {
  return {
    branch: world.branchA._id,
    ingredient: world.ingredient._id,
    qty: -100,
    unit: 'g',
    unitCost: 0.045,
    type: 'ADJUSTMENT',
    reason: 'Ledger contract test adjustment',
    referenceType: 'test_adjustment',
    referenceId: world.ingredient._id,
    user: world.owner._id,
    idempotencyKey: 'ledger-contract-adjustment',
    ...overrides
  };
}

describe('canonical inventory ledger contract', () => {
  it('keeps the exact authorized movement type set', () => {
    assert.deepEqual(INVENTORY_MOVEMENT_TYPES, [
      'OPENING',
      'PURCHASE',
      'SALE',
      'RECIPE_DEDUCTION',
      'REVERSAL',
      'WASTE',
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'RETURN',
      'ADJUSTMENT'
    ]);
    assert.deepEqual(InventoryTransaction.schema.path('type').enumValues, INVENTORY_MOVEMENT_TYPES);
  });

  it('requires an active transaction and complete reference, actor, reason and idempotency inputs', async () => {
    await assert.rejects(moveStock(movement()), /active MongoDB transaction/);
    for (const [field, value, pattern] of [
      ['referenceId', undefined, /Invalid inventory movement reference/],
      ['reason', '', /reason must be at least 3 characters/],
      ['idempotencyKey', '', /idempotency key is required/],
      ['user', new mongoose.Types.ObjectId(), /user was not found/]
    ]) {
      await assert.rejects(
        transaction(session => moveStock(movement({[field]: value}), session)),
        pattern
      );
    }
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 20000);
    assert.equal(await InventoryTransaction.countDocuments({branch: world.branchA._id}), 1);
  });

  it('writes a complete immutable audit row and atomically changes aggregate and lot stock', async () => {
    const row = await transaction(session => moveStock(movement(), session));
    const saved = await InventoryTransaction.findById(row._id).lean();
    assert.equal(String(saved.restaurant), String(world.restaurant._id));
    assert.equal(String(saved.branch), String(world.branchA._id));
    assert.equal(String(saved.ingredient), String(world.ingredient._id));
    assert.equal(saved.previousQty, 20000);
    assert.equal(saved.changeQty, -100);
    assert.equal(saved.newQty, 19900);
    assert.equal(saved.unitCost, 0.045);
    assert.equal(saved.totalCost, 4.5);
    assert.equal(String(saved.user), String(world.owner._id));
    assert.equal(saved.reason, 'Ledger contract test adjustment');
    assert.equal(saved.referenceType, 'test_adjustment');
    assert.equal(String(saved.referenceId), String(world.ingredient._id));
    assert.equal(saved.idempotencyKey, 'ledger-contract-adjustment');
    assert.match(saved.idempotencyHash, /^[a-f0-9]{64}$/);
    assert.equal(saved.idempotencyHashVersion, 2);
    assert.ok(saved.createdAt instanceof Date);
    assert.equal(saved.batchMovements.reduce((sum, item) => sum + item.changeQty, 0), -100);
    const aggregateBalance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    assert.equal(aggregateBalance.quantity, 19900);
    assert.equal(aggregateBalance.ledgerVersion, 2);
    const batchQty = await InventoryBatch.aggregate([
      {$match: {branch: world.branchA._id, ingredient: world.ingredient._id}},
      {$group: {_id: null, quantity: {$sum: '$quantity'}}}
    ]);
    assert.equal(batchQty[0].quantity, 19900);
  });

  it('replays one payload once and rejects changed payload reuse without changing stock', async () => {
    const first = await transaction(session => moveStock(movement(), session));
    const replay = await transaction(session => moveStock(movement(), session));
    assert.equal(String(replay._id), String(first._id));
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey: 'ledger-contract-adjustment'}), 1);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 19900);

    await assert.rejects(
      transaction(session => moveStock(movement({qty: -101}), session)),
      error => error.status === 409 && /different inventory movement/.test(error.message)
    );
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 19900);
  });

  it('rolls back an unexpected later lot conflict with no partial batch, balance or ledger write', async () => {
    const beforeBalance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    const beforeBatches = await InventoryBatch.countDocuments({branch: world.branchA._id, ingredient: world.ingredient._id});
    const beforeTransactions = await InventoryTransaction.countDocuments({branch: world.branchA._id});

    await assert.rejects(
      transaction(session => moveStock(movement({
        qty: 100,
        type: 'PURCHASE',
        reason: 'Atomic lot rollback test',
        referenceType: 'test_purchase',
        idempotencyKey: 'atomic-lot-rollback',
        incomingBatches: [
          {quantity: 50, lotKey: 'atomic-conflict-lot', batchNumber: 'LOT-A'},
          {quantity: 50, lotKey: 'atomic-conflict-lot', batchNumber: 'LOT-B'}
        ]
      }), session)),
      error => error.status === 409 && /identity conflicts/.test(error.message)
    );

    const afterBalance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id}).lean();
    assert.equal(afterBalance.quantity, beforeBalance.quantity);
    assert.equal(afterBalance.averageCost, beforeBalance.averageCost);
    assert.equal(await InventoryBatch.countDocuments({branch: world.branchA._id, ingredient: world.ingredient._id}), beforeBatches);
    assert.equal(await InventoryBatch.countDocuments({lotKey: 'atomic-conflict-lot'}), 0);
    assert.equal(await InventoryTransaction.countDocuments({branch: world.branchA._id}), beforeTransactions);
  });

  it('rejects ingredient and actor tenancy mismatches before any movement', async () => {
    const restaurant = await Restaurant.create({name: 'Foreign Ledger Tenant'});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Foreign Branch', code: 'FLT'});
    const actor = await User.create({
      name: 'Foreign Owner', email: 'foreign-ledger@test.com', password: 'x', role: 'owner', restaurantId: restaurant._id
    });
    const ingredient = await Ingredient.create({restaurant: restaurant._id, code: 'FOREIGN-ING', name: 'Foreign Ingredient', unit: 'g'});

    await assert.rejects(
      transaction(session => moveStock(movement({ingredient: ingredient._id, idempotencyKey: 'foreign-ingredient'}), session)),
      error => error.status === 403 && /ingredient does not belong/.test(error.message)
    );
    await assert.rejects(
      transaction(session => moveStock(movement({user: actor._id, idempotencyKey: 'foreign-actor'}), session)),
      error => error.status === 403 && /user does not belong/.test(error.message)
    );
    assert.equal(await InventoryTransaction.countDocuments({restaurant: restaurant._id}), 0);
    assert.equal(await InventoryBalance.countDocuments({branch: branch._id}), 0);

    await transaction(session => moveStock({
      branch: branch._id,
      ingredient: ingredient._id,
      qty: 100,
      unit: 'g',
      unitCost: 9,
      type: 'OPENING',
      reason: 'Foreign tenant opening stock',
      referenceType: 'opening',
      referenceId: ingredient._id,
      user: actor._id,
      idempotencyKey: 'foreign-tenant-opening'
    }, session));
    assert.equal(await InventoryTransaction.countDocuments({restaurant: restaurant._id}), 1);

    const localLedger = await request('/api/inventory/transactions', {token: tokenFor(world.owner)});
    assert.equal(localLedger.status, 200);
    assert.ok(localLedger.body.every(row => String(row.restaurant) === String(world.restaurant._id)));
    const localDashboard = await request('/api/dashboard', {token: tokenFor(world.owner)});
    assert.equal(localDashboard.status, 200);
    assert.equal(localDashboard.body.inventoryValue, 1800);
  });
});

describe('no silent inventory model writes', () => {
  it('blocks ordinary aggregate, lot and ledger writes while the canonical service still succeeds', async () => {
    const balance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    await assert.rejects(
      InventoryBalance.updateOne({_id: balance._id}, {$inc: {quantity: 1}}),
      /only be changed by the inventory ledger service/
    );
    balance.quantity += 1;
    await assert.rejects(balance.save(), /only be changed by the inventory ledger service/);
    const versionOnly = await InventoryBalance.findById(balance._id);
    versionOnly.ledgerVersion += 1;
    await assert.rejects(versionOnly.save(), /only be changed by the inventory ledger service/);

    const batch = await InventoryBatch.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    await assert.rejects(
      InventoryBatch.updateOne({_id: batch._id}, {$inc: {quantity: 1}}),
      /only be changed by the inventory ledger service/
    );

    await assert.rejects(
      InventoryBalance.insertMany([{branch: world.branchA._id, ingredient: world.ingredient._id, quantity: 1, unit: 'g'}]),
      /inventory ledger service/
    );
    await assert.rejects(
      InventoryBalance.bulkWrite([{updateOne: {filter: {_id: balance._id}, update: {$inc: {quantity: 1}}}}]),
      /inventory ledger service/
    );
    await assert.rejects(
      InventoryBatch.insertMany([{branch: world.branchA._id, ingredient: world.ingredient._id, quantity: 1, unit: 'g'}]),
      /inventory ledger service/
    );
    await assert.rejects(
      InventoryBatch.bulkWrite([{deleteOne: {filter: {_id: batch._id}}}]),
      /inventory ledger service/
    );

    const opening = await InventoryTransaction.findOne({branch: world.branchA._id});
    await assert.rejects(
      InventoryTransaction.updateOne({_id: opening._id}, {$set: {reason: 'Rewritten'}}),
      /immutable/
    );
    await assert.rejects(InventoryTransaction.deleteOne({_id: opening._id}), /immutable/);
    await assert.rejects(
      InventoryTransaction.bulkWrite([{updateOne: {filter: {_id: opening._id}, update: {$set: {reason: 'Rewritten'}}}}]),
      /inventory ledger service/
    );
    const fake = new InventoryTransaction({
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      type: 'ADJUSTMENT',
      previousQty: 20000,
      changeQty: -1,
      newQty: 19999,
      unit: 'g',
      unitCost: 0.045,
      totalCost: 0.045,
      reason: 'Unauthorized model write',
      referenceType: 'test',
      referenceId: world.ingredient._id,
      user: world.owner._id,
      idempotencyKey: 'unauthorized-ledger-create',
      idempotencyHash: 'a'.repeat(64),
      idempotencyHashVersion: 2
    });
    await assert.rejects(fake.save(), /only be created by the inventory ledger service/);
    await assert.rejects(
      InventoryTransaction.insertMany([fake.toObject()]),
      /only be created by the inventory ledger service/
    );

    const posted = await transaction(session => moveStock(movement({idempotencyKey: 'guarded-canonical-success'}), session));
    assert.ok(posted._id);
    assert.equal((await InventoryBalance.findById(balance._id)).quantity, 19900);
  });
});

describe('inventory ledger and batch migrations', () => {
  it('normalizes legacy reversal evidence, removes Ingredient stock fields, and owns canonical indexes', async () => {
    await Ingredient.collection.updateOne(
      {_id: world.ingredient._id},
      {$set: {stockQty: 999, averageCost: 88, quantity: 777, unitCost: 6}}
    );
    const legacyId = new mongoose.Types.ObjectId();
    await InventoryTransaction.collection.insertOne({
      _id: legacyId,
      branch: world.branchA._id,
      ingredient: world.ingredient._id,
      type: 'RECIPE_REVERSAL',
      previousQty: 10,
      changeQty: 5,
      unitCost: 0.045,
      user: world.owner._id,
      createdAt: new Date('2025-01-01T00:00:00.000Z')
    });
    await InventoryTransaction.collection.createIndex(
      {branch: 1, idempotencyKey: 1},
      {name: 'inventory_transaction_branch_idempotency', unique: true, sparse: true}
    );

    const result = await ensureInventoryLedgerIndexes();
    assert.equal(result.scanned, 3);
    assert.equal(result.migrated, 3);
    assert.equal(result.ingredientStockFieldsRemoved, 1);
    assert.ok(result.droppedIndexes.includes('inventory_transaction_branch_idempotency'));

    const migrated = await InventoryTransaction.findById(legacyId).lean();
    assert.equal(String(migrated.restaurant), String(world.restaurant._id));
    assert.equal(migrated.type, 'REVERSAL');
    assert.equal(migrated.previousQty, 10);
    assert.equal(migrated.changeQty, 5);
    assert.equal(migrated.newQty, 15);
    assert.ok(Math.abs(migrated.totalCost - 0.225) < 1e-9);
    assert.equal(migrated.referenceType, 'legacy_reversal');
    assert.equal(String(migrated.referenceId), String(legacyId));
    assert.equal(migrated.idempotencyKey, `ledger-migration:${legacyId}`);
    assert.equal(migrated.idempotencyHashVersion, 1);
    assert.match(migrated.idempotencyHash, /^[a-f0-9]{64}$/);

    const rawIngredient = await Ingredient.collection.findOne({_id: world.ingredient._id});
    for (const field of ['stockQty', 'averageCost', 'quantity', 'unitCost']) assert.equal(Object.hasOwn(rawIngredient, field), false);
    const names = new Set((await InventoryTransaction.collection.indexes()).map(index => index.name));
    for (const name of [
      'inventory_transaction_tenant_idempotency',
      'inventory_transaction_tenant_ingredient_timeline',
      'inventory_transaction_purchasing_report',
      'inventory_transaction_waste_report',
      'inventory_transaction_reference_timeline'
    ]) assert.ok(names.has(name), `missing ${name}`);
  });

  it('preflights strict ledger failures so no earlier row or Ingredient cleanup is partially written', async () => {
    await Ingredient.collection.updateOne({_id: world.ingredient._id}, {$set: {stockQty: 321}});
    const validId = new mongoose.Types.ObjectId();
    await InventoryTransaction.collection.insertMany([
      {
        _id: validId,
        branch: world.branchA._id,
        ingredient: world.ingredient._id,
        type: 'ADJUSTMENT',
        previousQty: 5,
        changeQty: -1,
        newQty: 4,
        unitCost: 1,
        user: world.owner._id
      },
      {
        _id: new mongoose.Types.ObjectId(),
        branch: new mongoose.Types.ObjectId(),
        ingredient: world.ingredient._id,
        type: 'ADJUSTMENT',
        previousQty: 5,
        changeQty: -1,
        newQty: 4,
        unitCost: 1,
        user: world.owner._id
      }
    ]);

    await assert.rejects(ensureInventoryLedgerIndexes(), /branch without a restaurant/);
    const untouched = await InventoryTransaction.collection.findOne({_id: validId});
    assert.equal(Object.hasOwn(untouched, 'restaurant'), false);
    assert.equal((await Ingredient.collection.findOne({_id: world.ingredient._id})).stockQty, 321);
  });

  it('preflights every legacy balance before batch backfill and rolls back all planned writes', async () => {
    await InventoryBatch.collection.deleteMany({});
    await InventoryBalance.collection.updateMany({}, {$set: {quantity: 500, averageCost: 0.2, batchNumber: 'LEGACY'}});
    await Branch.collection.deleteOne({_id: world.branchB._id});
    const balanceA = await InventoryBalance.findOne({branch: world.branchA._id});

    await assert.rejects(ensureInventoryBatchIndexes(), /without valid tenant ownership/);
    assert.equal(await InventoryBatch.countDocuments({lotKey: `legacy:${balanceA._id}`}), 0);
    const rawBalance = await InventoryBalance.collection.findOne({_id: balanceA._id});
    assert.equal(rawBalance.batchNumber, 'LEGACY');
  });
});

describe('connected inventory ledger API', () => {
  it('requires stable adjustment idempotency and returns complete tenant-scoped audit output with filtering', async () => {
    const body = {
      branch: String(world.branchA._id),
      ingredient: String(world.ingredient._id),
      qty: -250,
      reason: 'API ledger contract'
    };
    const missing = await request('/api/inventory/adjustments', {
      method: 'POST', token: tokenFor(world.manager), body
    });
    assert.equal(missing.status, 400);
    assert.match(missing.body.message, /idempotency key is required/);

    const posted = await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'api-ledger-contract'},
      body
    });
    assert.equal(posted.status, 201, posted.body?.message);

    const listed = await request(`/api/inventory/transactions?branch=${world.branchA._id}&type=ADJUSTMENT`, {
      token: tokenFor(world.manager)
    });
    assert.equal(listed.status, 200, listed.body?.message);
    assert.equal(listed.body.length, 1);
    const row = listed.body[0];
    assert.equal(String(row.restaurant), String(world.restaurant._id));
    assert.equal(String(row.branch), String(world.branchA._id));
    assert.equal(String(row.ingredientId), String(world.ingredient._id));
    assert.equal(row.previousQty, 20000);
    assert.equal(row.changeQty, -250);
    assert.equal(row.newQty, 19750);
    assert.equal(row.unitCost, 0.045);
    assert.equal(row.totalCost, 11.25);
    assert.equal(row.userName, world.manager.name);
    assert.equal(row.userRole, 'manager');
    assert.equal(row.reason, 'API ledger contract');
    assert.equal(row.reference.type, 'adjustment');
    assert.ok(row.reference.id);
    assert.equal(row.idempotencyKey, 'api-ledger-contract');
    assert.ok(row.timestamp);
    assert.equal(row.batchMovements.reduce((sum, item) => sum + item.changeQty, 0), -250);

    assert.equal((await request('/api/inventory/transactions?type=UNKNOWN', {token: tokenFor(world.owner)})).status, 400);
    assert.equal((await request(`/api/inventory/transactions?branch=${world.branchB._id}`, {token: tokenFor(world.manager)})).status, 403);
    assert.equal((await request(`/api/inventory/transactions?branch=${world.branchA._id}`, {token: tokenFor(world.staffA)})).status, 403);
  });
});
