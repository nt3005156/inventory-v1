import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Ingredient} from '../src/models/index.js';
import {InventoryBalance, InventoryTransaction} from '../src/models/operations.js';
import {stockStatus} from '../src/services/inventory.js';
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

describe('stockStatus', () => {
  it('marks empty, reorder and healthy quantities', () => {
    assert.equal(stockStatus(0, 4000), 'negative');
    assert.equal(stockStatus(500, 4000), 'reorder');
    assert.equal(stockStatus(20000, 4000), 'ok');
  });
});

describe('GET /api/inventory', () => {
  it('lists live branch ledger balances and rejects obsolete Ingredient.stockQty writes', async () => {
    await assert.rejects(
      Ingredient.findByIdAndUpdate(world.ingredient._id, {stockQty: 99999}),
      /stockQty.*not in schema/
    );
    const sold = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(world.branchA._id),
        type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(sold.status, 201, sold.body?.message);

    const list = await request('/api/inventory?branch=' + world.branchA._id, {token: tokenFor(world.manager)});
    assert.equal(list.status, 200, list.body?.message);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].name, 'Basmati Rice');
    assert.equal(list.body[0].source, 'live');
    assert.equal(list.body[0].stockQty, 19750);
    assert.equal(list.body[0].stockValue, 888.75);
    assert.equal(list.body[0].status, 'ok');
    assert.equal((await Ingredient.findById(world.ingredient._id)).stockQty, undefined);
  });

  it('marks reorder when on-hand is at or below the ledger minimum', async () => {
    const adjusted = await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'inventory-reorder-threshold'},
      body: {
        branch: String(world.branchA._id),
        ingredient: String(world.ingredient._id),
        qty: -19500,
        reason: 'Set test stock to reorder threshold'
      }
    });
    assert.equal(adjusted.status, 201, adjusted.body?.message);
    const list = await request('/api/inventory?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(list.status, 200, list.body?.message);
    assert.equal(list.body[0].status, 'reorder');
    assert.equal(list.body[0].minimumStock, 4000);
  });

  it('lets assigned staff read their branch and blocks guests and cross-branch managers', async () => {
    const own = await request('/api/inventory', {token: tokenFor(world.staffA)});
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 1);
    assert.equal((await request('/api/inventory')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/inventory', {token: guest})).status, 403);
    assert.equal((await request('/api/inventory?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});

describe('GET /api/inventory/transactions', () => {
  it('lists live ledger rows for the branch after a sale', async () => {
    const sold = await request('/api/orders', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {
        branch: String(world.branchA._id),
        type: 'counter',
        items: [{menuItem: String(world.menu._id), qty: 1}]
      }
    });
    assert.equal(sold.status, 201, sold.body?.message);

    const list = await request('/api/inventory/transactions?branch=' + world.branchA._id, {token: tokenFor(world.manager)});
    assert.equal(list.status, 200, list.body?.message);
    assert.ok(list.body.length >= 1);
    const row = list.body.find(x => x.type === 'RECIPE_DEDUCTION');
    assert.equal(row.source, 'live');
    assert.equal(row.name, 'Basmati Rice');
    assert.equal(row.changeQty, -250);
    assert.equal(row.newQty, 19750);
    assert.equal(row.totalCost, 11.25);
    assert.equal(String(row.branch), String(world.branchA._id));
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    assert.equal((await request('/api/inventory/transactions?branch=' + world.branchA._id, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request('/api/inventory/transactions')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/inventory/transactions', {token: guest})).status, 403);
    assert.equal((await request('/api/inventory/transactions?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});

describe('POST /api/inventory/adjustments', () => {
  it('posts an ADJUSTMENT ledger row and updates on-hand qty', async () => {
    const adj = await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'cycle-count-shrink'},
      body: {
        branch: String(world.branchA._id),
        ingredient: String(world.ingredient._id),
        qty: -500,
        reason: 'Cycle count shrink'
      }
    });
    assert.equal(adj.status, 201, adj.body?.message);
    assert.equal(adj.body.type, 'ADJUSTMENT');
    assert.equal(adj.body.changeQty, -500);
    assert.equal(adj.body.newQty, 19500);
    assert.equal(adj.body.totalCost, 22.5);
    assert.equal((await InventoryBalance.findOne({branch: world.branchA._id, ingredient: world.ingredient._id})).quantity, 19500);
    assert.equal(await InventoryTransaction.countDocuments({type: 'ADJUSTMENT'}), 1);
  });

  it('blocks zero qty, over-shrink, staff and other-branch managers', async () => {
    assert.equal((await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: 0, reason: 'noop'}
    })).status, 400);
    const over = await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'over-shrink'},
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: -999999, reason: 'too much'}
    });
    assert.equal(over.status, 409);
    assert.equal((await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: -1, reason: 'staff try'}
    })).status, 403);
    assert.equal((await request('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenFor(world.manager),
      body: {branch: String(world.branchB._id), ingredient: String(world.ingredient._id), qty: -1, reason: 'other branch'}
    })).status, 403);
    assert.equal((await request('/api/inventory/adjustments', {
      method: 'POST',
      body: {branch: String(world.branchA._id), ingredient: String(world.ingredient._id), qty: -1, reason: 'anon'}
    })).status, 401);
  });
});
