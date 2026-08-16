import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {MenuItem, Sale} from '../src/models/index.js';
import {classifyMenuItem} from '../src/services/menuEngineering.js';
import {moveStock} from '../src/services/inventoryLedger.js';
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

function createLiveOrder(branch = world.branchA, qty = 1) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(branch._id),
      type: 'counter',
      items: [{menuItem: String(world.menu._id), qty}]
    }
  });
}

describe('classifyMenuItem', () => {
  it('keeps the Kasavan–Smith cutoffs', () => {
    assert.equal(classifyMenuItem(0.2, 120), 'Star');
    assert.equal(classifyMenuItem(0.2, 80), 'Plow-horse');
    assert.equal(classifyMenuItem(0.05, 120), 'Puzzle');
    assert.equal(classifyMenuItem(0.05, 80), 'Dog');
  });
});

describe('GET /api/analytics/menu-engineering', () => {
  it('classifies menu items from live orders and ignores legacy Sale rows', async () => {
    await MenuItem.create({
      name: 'Unused Pudding',
      price: 350,
      recipe: [{ingredient: world.ingredient._id, qty: 250, unit: 'g'}]
    });
    const first = await createLiveOrder(world.branchA, 2);
    assert.equal(first.status, 201, first.body?.message);
    const cancelled = await createLiveOrder(world.branchA, 5);
    assert.equal(cancelled.status, 201, cancelled.body?.message);
    assert.equal((await request('/api/orders/' + cancelled.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    })).status, 200);
    await createLiveOrder(world.branchB, 1);
    await Sale.create({
      items: [{menuItem: world.menu._id, name: 'Chicken Biryani', qty: 99, unitPrice: 350, foodCost: 11.25}],
      subtotal: 34650,
      vat: 0,
      total: 34650,
      cogs: 1113.75,
      grossProfit: 33536.25
    });

    const rows = await request('/api/analytics/menu-engineering?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(rows.status, 200, rows.body?.message);
    assert.equal(rows.body.length, 2);
    const biryani = rows.body.find(x => x.name === 'Chicken Biryani');
    const unused = rows.body.find(x => x.name === 'Unused Pudding');
    assert.equal(biryani.source, 'live');
    assert.equal(biryani.soldQty, 2);
    assert.equal(biryani.popularity, 1);
    assert.equal(biryani.margin, 338.75);
    assert.equal(biryani.classification, 'Star');
    assert.equal(unused.soldQty, 0);
    assert.equal(unused.popularity, 0);
    assert.equal(unused.classification, 'Puzzle');
    assert.equal(biryani.costSource, 'sold');
    assert.equal(unused.costSource, 'recipe');
  });

  it('keeps sold-line food cost after the live recipe cost changes', async () => {
    const sold = await createLiveOrder(world.branchA, 1);
    assert.equal(sold.status, 201, sold.body?.message);
    assert.equal(sold.body.items[0].foodCost, 11.25);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(() => moveStock({
        branch: world.branchA._id,
        ingredient: world.ingredient._id,
        qty: 19750,
        unit: 'g',
        unitCost: 1.955,
        type: 'PURCHASE',
        reason: 'Later recipe-cost test purchase',
        referenceType: 'test_purchase',
        referenceId: world.ingredient._id,
        user: world.owner._id,
        idempotencyKey: 'menu-engineering-later-cost'
      }, session));
    } finally {
      await session.endSession();
    }

    const rows = await request('/api/analytics/menu-engineering?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(rows.status, 200, rows.body?.message);
    const biryani = rows.body.find(x => x.name === 'Chicken Biryani');
    assert.equal(biryani.soldQty, 1);
    assert.equal(biryani.unitCost, 11.25);
    assert.equal(biryani.margin, 338.75);
    assert.equal(biryani.costSource, 'sold');
    assert.equal(biryani.classification, 'Star');
  });

  it('rejects staff, guests, missing tokens and cross-branch managers', async () => {
    assert.equal((await request('/api/analytics/menu-engineering?branch=' + world.branchA._id, {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request('/api/analytics/menu-engineering?branch=' + world.branchA._id)).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/analytics/menu-engineering?branch=' + world.branchA._id, {token: guest})).status, 403);
    assert.equal((await request('/api/analytics/menu-engineering?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});
