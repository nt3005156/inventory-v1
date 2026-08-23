import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {InventoryBalance, Notification} from '../src/models/operations.js';
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

async function hitReorder(branch = world.branchA, token = tokenFor(world.manager)) {
  await InventoryBalance.updateOne(
    {branch: branch._id, ingredient: world.ingredient._id},
    {reorderLevel: 20000}
  );
  return request('/api/inventory/adjustments', {
    method: 'POST',
    token,
    headers: {'Idempotency-Key': `alert-adjustment-${branch._id}`},
    body: {
      branch: String(branch._id),
      ingredient: String(world.ingredient._id),
      qty: -500,
      reason: 'Trigger reorder alert'
    }
  });
}

describe('GET /api/alerts', () => {
  it('lists unread low-stock alerts created by a ledger movement', async () => {
    const adj = await hitReorder();
    assert.equal(adj.status, 201, adj.body?.message);
    assert.equal(await Notification.countDocuments({type: 'low_stock', read: false}), 1);

    const list = await request('/api/alerts?branch=' + world.branchA._id, {token: tokenFor(world.manager)});
    assert.equal(list.status, 200, list.body?.message);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].source, 'live');
    assert.equal(list.body[0].type, 'low_stock');
    assert.equal(list.body[0].read, false);
    assert.equal(list.body[0].ingredientName, 'Basmati Rice');
    assert.equal(String(list.body[0].branch), String(world.branchA._id));
  });

  it('rejects guests, missing tokens and cross-branch managers', async () => {
    assert.equal((await request('/api/alerts')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request('/api/alerts', {token: guest})).status, 403);
    assert.equal((await request('/api/alerts?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
    const own = await request('/api/alerts', {token: tokenFor(world.staffA)});
    assert.equal(own.status, 200);
  });
});

describe('PATCH /api/alerts/:id/read', () => {
  it('dismisses one alert and drops it from the unread list', async () => {
    const adj = await hitReorder();
    assert.equal(adj.status, 201, adj.body?.message);
    const list = await request('/api/alerts?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(list.body.length, 1);
    const done = await request('/api/alerts/' + list.body[0]._id + '/read', {
      method: 'PATCH',
      token: tokenFor(world.manager)
    });
    assert.equal(done.status, 200, done.body?.message);
    assert.equal(done.body.read, true);
    const after = await request('/api/alerts?branch=' + world.branchA._id, {token: tokenFor(world.manager)});
    assert.equal(after.body.length, 0);
  });
});

describe('POST /api/alerts/read', () => {
  it('marks the branch inbox read and leaves the other branch unread', async () => {
    const a = await hitReorder(world.branchA, tokenFor(world.owner));
    const b = await hitReorder(world.branchB, tokenFor(world.owner));
    assert.equal(a.status, 201, a.body?.message);
    assert.equal(b.status, 201, b.body?.message);

    const cleared = await request('/api/alerts/read?branch=' + world.branchA._id, {
      method: 'POST',
      token: tokenFor(world.manager)
    });
    assert.equal(cleared.status, 200, cleared.body?.message);
    assert.equal(cleared.body.updated, 1);
    assert.equal((await request('/api/alerts?branch=' + world.branchA._id, {token: tokenFor(world.owner)})).body.length, 0);
    assert.equal((await request('/api/alerts?branch=' + world.branchB._id, {token: tokenFor(world.owner)})).body.length, 1);
    assert.equal((await request('/api/alerts/read?branch=' + world.branchB._id, {
      method: 'POST',
      token: tokenFor(world.manager)
    })).status, 403);
  });
});
