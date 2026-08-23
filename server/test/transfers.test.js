import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {InventoryBalance, InventoryTransaction, StockTransfer} from '../src/models/operations.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {canTransitionTransfer} from '../src/services/transfers.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

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

function createTransfer({from = world.branchA, to = world.branchB, qty = 5000, token = tokenFor(world.staffA)} = {}) {
  return request('/api/transfers', {
    method: 'POST',
    token,
    body: {
      fromBranch: String(from._id),
      toBranch: String(to._id),
      ingredient: String(world.ingredient._id),
      qty,
      unit: 'g'
    }
  });
}

function setStatus(id, status, token) {
  return request('/api/transfers/' + id + '/status', {
    method: 'PATCH',
    token,
    body: {status}
  });
}

async function shipAndReceive(id, {approve = tokenFor(world.manager), ship = tokenFor(world.manager), receive = tokenFor(world.owner)} = {}) {
  const approved = await setStatus(id, 'approved', approve);
  assert.equal(approved.status, 200, approved.body?.message);
  const shipped = await setStatus(id, 'in_transit', ship);
  assert.equal(shipped.status, 200, shipped.body?.message);
  const received = await setStatus(id, 'received', receive);
  assert.equal(received.status, 200, received.body?.message);
  return received;
}

describe('canTransitionTransfer', () => {
  it('allows the existing request → approve → ship → receive path and blocks skips', () => {
    assert.equal(canTransitionTransfer('requested', 'approved'), true);
    assert.equal(canTransitionTransfer('requested', 'cancelled'), true);
    assert.equal(canTransitionTransfer('approved', 'in_transit'), true);
    assert.equal(canTransitionTransfer('approved', 'cancelled'), true);
    assert.equal(canTransitionTransfer('in_transit', 'received'), true);
    assert.equal(canTransitionTransfer('requested', 'received'), false);
    assert.equal(canTransitionTransfer('requested', 'in_transit'), false);
    assert.equal(canTransitionTransfer('in_transit', 'cancelled'), false);
    assert.equal(canTransitionTransfer('received', 'cancelled'), false);
  });
});

describe('POST /api/transfers', () => {
  it('lets assigned staff request a transfer from their branch', async () => {
    const created = await createTransfer();
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.status, 'requested');
    assert.equal(created.body.qty, 5000);
    assert.equal(String(created.body.fromBranch._id || created.body.fromBranch), String(world.branchA._id));
    assert.equal(String(created.body.toBranch._id || created.body.toBranch), String(world.branchB._id));
    assert.equal(created.body.ingredient.name, 'Basmati Rice');
  });

  it('rejects same-branch, cross-branch staff, guests and missing tokens', async () => {
    const same = await createTransfer({to: world.branchA});
    assert.equal(same.status, 400);
    const cross = await createTransfer({from: world.branchB, to: world.branchA, token: tokenFor(world.staffA)});
    assert.equal(cross.status, 403);
    assert.equal((await request('/api/transfers', {
      method: 'POST',
      body: {fromBranch: String(world.branchA._id), toBranch: String(world.branchB._id), ingredient: String(world.ingredient._id), qty: 1}
    })).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await createTransfer({token: guest})).status, 403);
  });
});

describe('PATCH /api/transfers/:id/status', () => {
  it('ships and receives against the ledger and carries source average cost', async () => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        for (const movement of [
          {qty: -20000, unitCost: 0.045, idempotencyKey: 'transfer-cost-reset-out'},
          {qty: 20000, unitCost: 0.10, idempotencyKey: 'transfer-cost-reset-in'}
        ]) {
          await moveStock({
            ...movement,
            branch: world.branchB._id,
            ingredient: world.ingredient._id,
            unit: 'g',
            type: 'ADJUSTMENT',
            reason: 'Prepare destination valuation fixture',
            referenceType: 'test_adjustment',
            referenceId: world.ingredient._id,
            user: world.owner._id
          }, session);
        }
      });
    } finally {
      await session.endSession();
    }
    const created = await createTransfer({qty: 5000});
    assert.equal(created.status, 201, created.body?.message);

    const skip = await setStatus(created.body._id, 'received', tokenFor(world.owner));
    assert.equal(skip.status, 409);
    assert.equal(await InventoryTransaction.countDocuments({type: {$in: ['TRANSFER_OUT', 'TRANSFER_IN']}}), 0);

    await shipAndReceive(created.body._id);

    const source = await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id});
    const dest = await InventoryBalance.findOne({branch: world.branchB._id, ingredient: world.ingredient._id});
    assert.equal(source.quantity, 15000);
    assert.equal(source.averageCost, 0.045);
    assert.equal(dest.quantity, 25000);
    assert.equal(dest.averageCost, 0.089);

    const outTx = await InventoryTransaction.findOne({type: 'TRANSFER_OUT', referenceId: created.body._id});
    const inTx = await InventoryTransaction.findOne({type: 'TRANSFER_IN', referenceId: created.body._id});
    assert.equal(outTx.changeQty, -5000);
    assert.equal(outTx.totalCost, 225);
    assert.equal(String(outTx.branch), String(world.branchA._id));
    assert.equal(inTx.changeQty, 5000);
    assert.equal(inTx.unitCost, 0.045);
    assert.equal(inTx.totalCost, 225);
    assert.equal(String(inTx.branch), String(world.branchB._id));
    assert.equal((await StockTransfer.findById(created.body._id)).status, 'received');
  });

  it('blocks cancel after stock has left and insufficient source qty', async () => {
    const created = await createTransfer({qty: 5000});
    await setStatus(created.body._id, 'approved', tokenFor(world.manager));
    const shipped = await setStatus(created.body._id, 'in_transit', tokenFor(world.manager));
    assert.equal(shipped.status, 200, shipped.body?.message);
    const cancel = await setStatus(created.body._id, 'cancelled', tokenFor(world.owner));
    assert.equal(cancel.status, 409);

    const huge = await createTransfer({qty: 30000, token: tokenFor(world.owner)});
    await setStatus(huge.body._id, 'approved', tokenFor(world.owner));
    const failShip = await setStatus(huge.body._id, 'in_transit', tokenFor(world.owner));
    assert.equal(failShip.status, 409);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 15000);
  });

  it('lets destination managers receive and blocks source-only managers from receiving elsewhere', async () => {
    const created = await createTransfer({qty: 1000});
    await setStatus(created.body._id, 'approved', tokenFor(world.manager));
    await setStatus(created.body._id, 'in_transit', tokenFor(world.manager));
    const blocked = await setStatus(created.body._id, 'received', tokenFor(world.manager));
    assert.equal(blocked.status, 403);

    const incoming = await createTransfer({
      from: world.branchB,
      to: world.branchA,
      qty: 800,
      token: tokenFor(world.owner)
    });
    await setStatus(incoming.body._id, 'approved', tokenFor(world.owner));
    await setStatus(incoming.body._id, 'in_transit', tokenFor(world.owner));
    const received = await setStatus(incoming.body._id, 'received', tokenFor(world.manager));
    assert.equal(received.status, 200, received.body?.message);
  });

  it('rejects staff patches, guests and missing tokens', async () => {
    const created = await createTransfer();
    assert.equal((await setStatus(created.body._id, 'approved', tokenFor(world.staffA))).status, 403);
    assert.equal((await setStatus(created.body._id, 'approved')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await setStatus(created.body._id, 'approved', guest)).status, 403);
  });
});

describe('GET /api/transfers', () => {
  it('lists transfers that touch the selected branch', async () => {
    const outgoing = await createTransfer({qty: 1200});
    const incoming = await createTransfer({
      from: world.branchB,
      to: world.branchA,
      qty: 400,
      token: tokenFor(world.owner)
    });
    assert.equal(outgoing.status, 201, outgoing.body?.message);
    assert.equal(incoming.status, 201, incoming.body?.message);

    const atA = await request('/api/transfers?branch=' + world.branchA._id, {token: tokenFor(world.manager)});
    assert.equal(atA.status, 200, atA.body?.message);
    assert.equal(atA.body.length, 2);

    const atB = await request('/api/transfers?branch=' + world.branchB._id, {token: tokenFor(world.owner)});
    assert.equal(atB.status, 200);
    assert.equal(atB.body.length, 2);
    assert.equal((await request('/api/transfers?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
    assert.equal((await request('/api/transfers')).status, 401);
  });
});
