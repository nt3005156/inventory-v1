import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Ingredient} from '../src/models/index.js';
import {InventoryBalance} from '../src/models/operations.js';
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
  it('lists live branch ledger balances instead of Ingredient.stockQty', async () => {
    await Ingredient.findByIdAndUpdate(world.ingredient._id, {stockQty: 99999});
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
    assert.equal((await Ingredient.findById(world.ingredient._id)).stockQty, 99999);
  });

  it('marks reorder when on-hand is at or below the ledger minimum', async () => {
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {quantity: 500, reorderLevel: 4000}
    );
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
