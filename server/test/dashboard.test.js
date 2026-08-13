import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Expense, Sale} from '../src/models/index.js';
import {InventoryBalance} from '../src/models/operations.js';
import {resolveDashboardBranch} from '../src/services/dashboard.js';
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

function createLiveOrder(branch = world.branchA) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(branch._id),
      type: 'counter',
      items: [{menuItem: String(world.menu._id), qty: 1}]
    }
  });
}

describe('dashboard branch helper', () => {
  it('uses an assigned branch for non-owners and leaves owners unscoped', () => {
    assert.equal(resolveDashboardBranch({role: 'owner'}, null), null);
    assert.equal(resolveDashboardBranch({role: 'manager', branch: 'abc'}, null), 'abc');
    assert.equal(resolveDashboardBranch({role: 'staff', branch: 'abc'}, 'def'), 'def');
  });
});

describe('GET /api/dashboard', () => {
  it('uses today’s live orders and branch ledger, not legacy Sale rows', async () => {
    const sold = await createLiveOrder();
    assert.equal(sold.status, 201, sold.body?.message);
    const cancelled = await createLiveOrder();
    assert.equal(cancelled.status, 201, cancelled.body?.message);
    assert.equal((await request('/api/orders/' + cancelled.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    })).status, 200);
    await createLiveOrder(world.branchB);
    await Expense.create({category: 'rent', description: 'Kalanki shop', amount: 500, vat: 0, date: new Date()});
    await Sale.create({items: [{name: 'Legacy', qty: 1, unitPrice: 999, foodCost: 1}], subtotal: 999, vat: 0, total: 999, cogs: 1, grossProfit: 998});

    const dash = await request('/api/dashboard', {token: tokenFor(world.manager)});
    assert.equal(dash.status, 200, dash.body?.message);
    assert.equal(dash.body.source, 'live');
    assert.equal(String(dash.body.branch), String(world.branchA._id));
    assert.equal(dash.body.revenue, 395.5);
    assert.equal(dash.body.cogs, 11.25);
    assert.equal(dash.body.orders, 1);
    assert.equal(dash.body.expense, 500);
    assert.equal(dash.body.waste, 0);
    assert.equal(dash.body.profit, -115.75);
    assert.equal(dash.body.inventoryValue, 888.75);

    const owner = await request('/api/dashboard', {token: tokenFor(world.owner)});
    assert.equal(owner.status, 200);
    assert.equal(owner.body.orders, 2);
    assert.equal(owner.body.revenue, 791);
    assert.equal(owner.body.inventoryValue, 1777.5);
  });

  it('lists live low stock from inventory balances', async () => {
    await InventoryBalance.updateOne(
      {branch: world.branchA._id, ingredient: world.ingredient._id},
      {quantity: 500, reorderLevel: 4000}
    );
    const dash = await request('/api/dashboard?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(dash.status, 200, dash.body?.message);
    assert.equal(dash.body.lowStock.length, 1);
    assert.equal(dash.body.lowStock[0].name, 'Basmati Rice');
    assert.equal(dash.body.lowStock[0].stockQty, 500);
  });

  it('lets assigned staff read their branch and blocks guests and cross-branch queries', async () => {
    assert.equal((await request('/api/dashboard', {token: tokenFor(world.staffA)})).status, 200);
    assert.equal((await request('/api/dashboard')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/dashboard', {token: guest})).status, 403);
    assert.equal((await request('/api/dashboard?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
  });
});
