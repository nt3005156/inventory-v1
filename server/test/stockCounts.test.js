import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {io as clientIo} from 'socket.io-client';
import {Ingredient} from '../src/models/index.js';
import {InventoryBalance, InventoryBatch, InventoryTransaction, StockCount} from '../src/models/operations.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let baseUrl;
let world;

before(async () => {
  ({baseUrl} = await startTestApp());
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
});

async function createCount({user = world.staffA, scope = 'full', ingredientIds, key = 'stock-count-create-1', notes = 'Closing physical inventory'} = {}) {
  return request('/api/stock-counts', {
    method: 'POST',
    token: tokenFor(user),
    headers: {'Idempotency-Key': key},
    body: {
      branch: String(world.branchA._id),
      scope,
      ...(ingredientIds ? {ingredientIds} : {}),
      notes
    }
  });
}

async function countAndSubmit(created, physicalQty, user = world.staffA) {
  const updated = await request(`/api/stock-counts/${created.body._id}`, {
    method: 'PATCH',
    token: tokenFor(user),
    body: {
      expectedVersion: created.body.__v,
      lines: created.body.lines.map(line => ({lineId: line._id, physicalQty}))
    }
  });
  assert.equal(updated.status, 200, updated.body?.message);
  const submitted = await request(`/api/stock-counts/${created.body._id}/submit`, {
    method: 'POST',
    token: tokenFor(user),
    body: {expectedVersion: updated.body.__v, note: 'Physical count completed'}
  });
  assert.equal(submitted.status, 200, submitted.body?.message);
  return submitted;
}

function connectSocket(token, branch) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(baseUrl, {auth: {token, branch}, transports: ['websocket'], reconnection: false, timeout: 4000});
    const timer = setTimeout(() => { socket.close(); reject(new Error('socket connect timeout')); }, 4000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', error => { clearTimeout(timer); socket.close(); reject(error); });
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

describe('physical inventory stock counts', () => {
  it('enforces durable physical, submission, decision, variance-ledger, and safe-revision evidence in persistence', async () => {
    let sequence = 0;
    const modelCount = overrides => new StockCount({
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      countNo: `SC-MODEL-${++sequence}`,
      scope: 'cycle',
      status: 'draft',
      activeKey: String(world.branchA._id),
      lines: [{
        ingredient: world.ingredient._id,
        ingredientName: world.ingredient.name,
        unit: world.ingredient.unit,
        systemQty: 20000,
        systemUnitCost: 0.045,
        balanceVersion: 1
      }],
      createdBy: world.staffA._id,
      requestKey: `model-count-${sequence}`,
      requestHash: 'a'.repeat(64),
      ...overrides
    });
    const countedLine = physicalQty => ({
      ingredient: world.ingredient._id,
      ingredientName: world.ingredient.name,
      unit: world.ingredient.unit,
      systemQty: 20000,
      systemUnitCost: 0.045,
      balanceVersion: 1,
      physicalQty,
      countedBy: world.staffA._id,
      countedAt: new Date()
    });

    await assert.rejects(modelCount({lines: [{...countedLine(19600), countedBy: undefined}]}).validate(), /count actor and timestamp evidence/);
    await assert.rejects(modelCount({
      status: 'submitted',
      lines: [countedLine(undefined)],
      submittedBy: world.staffA._id,
      submittedAt: new Date()
    }).validate(), /Every ingredient requires a physical quantity/);
    await assert.rejects(modelCount({status: 'submitted', lines: [countedLine(20000)]}).validate(), /submission evidence/);
    await assert.rejects(modelCount({
      status: 'approved',
      activeKey: undefined,
      lines: [countedLine(20000)],
      submittedBy: world.staffA._id,
      submittedAt: new Date(),
      approvedBy: world.owner._id,
      approvedAt: new Date()
    }).validate(), /idempotent decision evidence/);
    await assert.rejects(modelCount({
      status: 'approved',
      activeKey: undefined,
      lines: [countedLine(19600)],
      submittedBy: world.staffA._id,
      submittedAt: new Date(),
      approvedBy: world.owner._id,
      approvedAt: new Date(),
      decisionKey: 'model-decision',
      decisionHash: 'b'.repeat(64)
    }).validate(), /one ledger movement each/);
    await assert.rejects(modelCount({lines: [{...countedLine(20000), balanceVersion: 1.5}]}).validate(), /safe integer/);

    const balance = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    balance.ledgerVersion = 1.5;
    await assert.rejects(balance.validate(), /safe integer/);
  });

  it('captures immutable system stock, calculates physical variance, and atomically approves through the ledger', async () => {
    const created = await createCount();
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.scope, 'full');
    assert.equal(created.body.status, 'draft');
    assert.equal(created.body.lines.length, 1);
    assert.equal(created.body.lines[0].systemQty, 20000);
    assert.equal(created.body.lines[0].balanceVersion, 1);
    assert.equal(created.body.lines[0].systemUnitCost, 0.045);
    assert.equal(created.body.lines[0].physicalQty, undefined);
    assert.equal(created.body.requestKey, undefined);
    assert.equal(created.body.decisionKey, undefined);

    const submitted = await countAndSubmit(created, 19600);
    assert.equal(submitted.body.status, 'submitted');
    assert.equal(submitted.body.countedLineCount, 1);
    assert.equal(submitted.body.varianceLineCount, 1);
    assert.equal(submitted.body.lines[0].varianceQty, -400);
    assert.equal(submitted.body.lines[0].varianceValue, -18);
    assert.equal(submitted.body.totalVarianceValue, -18);

    const approved = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'stock-count-approve-1'},
      body: {expectedVersion: submitted.body.__v, note: 'Variance verified against count sheet'}
    });
    assert.equal(approved.status, 200, approved.body?.message);
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.adjustmentTransactions.length, 1);
    assert.equal(approved.body.adjustmentTransactions[0].type, 'ADJUSTMENT');
    assert.equal(approved.body.adjustmentTransactions[0].previousQty, 20000);
    assert.equal(approved.body.adjustmentTransactions[0].changeQty, -400);
    assert.equal(approved.body.adjustmentTransactions[0].newQty, 19600);
    assert.equal(approved.body.adjustmentTransactions[0].referenceType, 'stock_count');
    assert.equal(String(approved.body.adjustmentTransactions[0].referenceId), String(created.body._id));
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 19600);
    assert.equal(await InventoryTransaction.countDocuments({type: 'ADJUSTMENT', referenceType: 'stock_count'}), 1);

    const replay = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'stock-count-approve-1'},
      body: {expectedVersion: submitted.body.__v, note: 'Variance verified against count sheet'}
    });
    assert.equal(replay.status, 200, replay.body?.message);
    assert.equal(await InventoryTransaction.countDocuments({type: 'ADJUSTMENT', referenceType: 'stock_count'}), 1);

    const history = await request(`/api/stock-counts/${created.body._id}/history`, {token: tokenFor(world.staffA)});
    assert.equal(history.status, 200, history.body?.message);
    assert.deepEqual(history.body.map(row => row.action), [
      'stock_count_created',
      'stock_count_updated',
      'stock_count_submitted',
      'stock_count_approved'
    ]);
    assert.equal(history.body.at(-1).actor.name, world.manager.name);
    assert.equal(history.body.at(-1).reason, 'Variance verified against count sheet');
  });

  it('supports selected-ingredient cycle counts, complete-entry validation, one active count, and create idempotency', async () => {
    const second = await Ingredient.create({
      restaurant: world.restaurant._id,
      code: 'ING-T2',
      name: 'Cooking Oil',
      unit: 'ml',
      minimumStock: 100
    });
    const created = await createCount({
      scope: 'cycle',
      ingredientIds: [String(second._id)],
      key: 'cycle-count-only-oil'
    });
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.lines.length, 1);
    assert.equal(String(created.body.lines[0].ingredient._id), String(second._id));
    assert.equal(created.body.lines[0].systemQty, 0);
    assert.equal(created.body.lines[0].balanceVersion, 0);

    const replay = await createCount({
      scope: 'cycle',
      ingredientIds: [String(second._id)],
      key: 'cycle-count-only-oil'
    });
    assert.equal(replay.status, 201, replay.body?.message);
    assert.equal(String(replay.body._id), String(created.body._id));
    assert.equal(await StockCount.countDocuments(), 1);

    const changedReplay = await createCount({
      scope: 'cycle',
      ingredientIds: [String(world.ingredient._id)],
      key: 'cycle-count-only-oil'
    });
    assert.equal(changedReplay.status, 409);
    assert.match(changedReplay.body.message, /different stock count/);

    const secondActive = await createCount({key: 'another-active-count'});
    assert.equal(secondActive.status, 409);
    assert.match(secondActive.body.message, /active stock count/);

    const premature = await request(`/api/stock-counts/${created.body._id}/submit`, {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {expectedVersion: created.body.__v}
    });
    assert.equal(premature.status, 409);
    assert.match(premature.body.message, /Physical quantities are missing/);

    const updated = await request(`/api/stock-counts/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.staffA),
      body: {expectedVersion: created.body.__v, lines: [{lineId: created.body.lines[0]._id, physicalQty: 25}]}
    });
    assert.equal(updated.status, 200, updated.body?.message);
    assert.equal(updated.body.lines[0].varianceQty, 25);
    assert.equal(updated.body.totalVarianceValue, 0);
    const submitted = await request(`/api/stock-counts/${created.body._id}/submit`, {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {expectedVersion: updated.body.__v, note: 'Oil cycle count complete'}
    });
    assert.equal(submitted.status, 200, submitted.body?.message);
    const approved = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'approve-positive-cycle-variance'},
      body: {expectedVersion: submitted.body.__v, note: 'Positive variance checked'}
    });
    assert.equal(approved.status, 200, approved.body?.message);
    assert.equal(approved.body.adjustmentTransactions[0].changeQty, 25);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: second._id})).quantity, 25);
    const batch = await InventoryBatch.findOne({branch: world.branchA._id, ingredient: second._id});
    assert.equal(batch.quantity, 25);
    assert.equal(batch.sourceType, 'adjustment');
    assert.equal(String(batch.sourceId), String(created.body._id));
  });

  it('rejects stale snapshots after any relevant ledger movement instead of overwriting newer stock', async () => {
    const created = await createCount({key: 'stale-count'});
    const submitted = await countAndSubmit(created, 19800);

    const movement = await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'movement-after-count-capture'},
      body: {
        branch: String(world.branchA._id),
        ingredient: String(world.ingredient._id),
        qty: -100,
        reason: 'Valid movement after stock was captured'
      }
    });
    assert.equal(movement.status, 201, movement.body?.message);
    const restored = await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'restore-after-count-capture'},
      body: {
        branch: String(world.branchA._id),
        ingredient: String(world.ingredient._id),
        qty: 100,
        reason: 'Restore quantity without restoring count snapshot version'
      }
    });
    assert.equal(restored.status, 201, restored.body?.message);

    const approval = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'stale-count-approval'},
      body: {expectedVersion: submitted.body.__v, note: 'Attempt stale approval'}
    });
    assert.equal(approval.status, 409);
    assert.match(approval.body.message, /Stock changed after this count was captured/);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 20000);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);
    // Phase 14: a stale-out is now terminal. Previously the session was left in
    // `submitted` still holding the branch lock, so it could neither be
    // approved nor closed and the branch could never start another count. The
    // ledger protection asserted above is unchanged.
    const staled = await StockCount.findById(created.body._id);
    assert.equal(staled.status, 'stale');
    assert.ok(staled.staleAt, 'the stale-out must be recorded');
    assert.equal(staled.activeKey, undefined, 'the branch lock must be released');
  });

  it('rolls back every variance movement and the decision when any later line cannot reconcile', async () => {
    const second = await Ingredient.create({
      restaurant: world.restaurant._id,
      code: 'ING-T2',
      name: 'Cooking Oil',
      unit: 'ml'
    });
    await InventoryBatch.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      restaurant: world.restaurant._id,
      branch: world.branchA._id,
      ingredient: second._id,
      lotKey: 'deliberate-unreconciled-lot',
      receivedAt: new Date(),
      sourceType: 'legacy',
      unit: 'ml',
      unitCost: 1,
      initialQuantity: 1,
      quantity: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      __v: 0
    });
    const created = await createCount({key: 'atomic-two-line-count'});
    assert.equal(created.status, 201, created.body?.message);
    const quantities = {'Basmati Rice': 19900, 'Cooking Oil': 1};
    const updated = await request(`/api/stock-counts/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.staffA),
      body: {
        expectedVersion: created.body.__v,
        lines: created.body.lines.map(line => ({lineId: line._id, physicalQty: quantities[line.ingredientName]}))
      }
    });
    assert.equal(updated.status, 200, updated.body?.message);
    const submitted = await request(`/api/stock-counts/${created.body._id}/submit`, {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {expectedVersion: updated.body.__v, note: 'Two-line count complete'}
    });
    assert.equal(submitted.status, 200, submitted.body?.message);

    const approval = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'atomic-two-line-approval'},
      body: {expectedVersion: submitted.body.__v, note: 'Atomic rollback exercise'}
    });
    assert.equal(approval.status, 409);
    assert.match(approval.body.message, /batch quantities do not match/);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 20000);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count', referenceId: created.body._id}), 0);
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');
  });

  it('publishes approval updates only to the affected branch realtime room', async () => {
    const created = await createCount({key: 'realtime-count'});
    const submitted = await countAndSubmit(created, 20000);
    const socketA = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    try {
      assert.equal((await joinBranch(socketA, world.branchA._id)).ok, true);
      assert.equal((await joinBranch(socketB, world.branchB._id)).ok, true);
      const leaked = [];
      socketB.on('inventory:update', payload => leaked.push(payload));
      const pending = waitEvent(socketA, 'inventory:update');
      const approved = await request(`/api/stock-counts/${created.body._id}/approve`, {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'realtime-count-approval'},
        body: {expectedVersion: submitted.body.__v, note: 'Realtime approval'}
      });
      assert.equal(approved.status, 200, approved.body?.message);
      const event = await pending;
      assert.equal(event.reason, 'stock_count_approved');
      assert.equal(event.countId, String(created.body._id));
      assert.equal(event.branch, String(world.branchA._id));
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(leaked.length, 0);
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('enforces creator, manager separation-of-duties, and branch boundaries while owners may approve any count', async () => {
    const created = await createCount({user: world.manager, key: 'manager-created-count'});
    assert.equal(created.status, 201, created.body?.message);

    const staffEdit = await request(`/api/stock-counts/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.staffA),
      body: {expectedVersion: created.body.__v, lines: [{lineId: created.body.lines[0]._id, physicalQty: 20000}]}
    });
    assert.equal(staffEdit.status, 403);

    const submitted = await countAndSubmit(created, 20000, world.manager);
    const selfApproval = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'manager-self-approval'},
      body: {expectedVersion: submitted.body.__v, note: 'Self approval attempt'}
    });
    assert.equal(selfApproval.status, 403);
    assert.match(selfApproval.body.message, /cannot approve/);

    const ownerApproval = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST',
      token: tokenFor(world.owner),
      headers: {'Idempotency-Key': 'owner-approval'},
      body: {expectedVersion: submitted.body.__v, note: 'Owner independent approval'}
    });
    assert.equal(ownerApproval.status, 200, ownerApproval.body?.message);
    assert.equal(ownerApproval.body.status, 'approved');
    assert.equal(ownerApproval.body.adjustmentTransactions.length, 0);

    const crossBranch = await request(`/api/stock-counts/${created.body._id}`, {token: tokenFor(world.staffB)});
    assert.equal(crossBranch.status, 403);
    const crossBranchList = await request(`/api/stock-counts?branch=${world.branchA._id}`, {token: tokenFor(world.staffB)});
    assert.equal(crossBranchList.status, 403);
  });

  it('requires optimistic versions and durable rejection evidence, then frees the branch for a new count', async () => {
    const created = await createCount({key: 'rejected-count'});
    const staleUpdate = await request(`/api/stock-counts/${created.body._id}`, {
      method: 'PATCH',
      token: tokenFor(world.staffA),
      body: {expectedVersion: created.body.__v + 1, lines: [{lineId: created.body.lines[0]._id, physicalQty: 20000}]}
    });
    assert.equal(staleUpdate.status, 409);

    const submitted = await countAndSubmit(created, 20000);
    const rejected = await request(`/api/stock-counts/${created.body._id}/reject`, {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'reject-count-decision'},
      body: {expectedVersion: submitted.body.__v, note: 'Count sheet requires recount'}
    });
    assert.equal(rejected.status, 200, rejected.body?.message);
    assert.equal(rejected.body.status, 'rejected');
    assert.equal(rejected.body.decisionNote, 'Count sheet requires recount');
    assert.equal(rejected.body.rejectedBy.name, world.manager.name);

    const next = await createCount({key: 'new-count-after-rejection'});
    assert.equal(next.status, 201, next.body?.message);
    assert.notEqual(String(next.body._id), String(created.body._id));

    const limited = await request(`/api/stock-counts?branch=${world.branchA._id}&limit=1`, {token: tokenFor(world.staffA)});
    assert.equal(limited.status, 200, limited.body?.message);
    assert.equal(limited.body.items.length, 1);
    assert.deepEqual(limited.body.summary, {total: 2, draft: 1, pending: 0, approved: 0, rejected: 1});
  });
});
