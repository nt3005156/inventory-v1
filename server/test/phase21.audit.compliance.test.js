import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Supplier, User} from '../src/models/index.js';
import {Branch, Order, Restaurant} from '../src/models/operations.js';
import {auditHash} from '../src/services/auditTrail.js';

/**
 * Phase 21 — audit log and compliance.
 *
 * Three things are under test, in order of importance:
 *   1. the trail cannot be rewritten through the application;
 *   2. tampering that bypasses the application is DETECTED;
 *   3. the events the brief names are actually recorded, with who/what/when/
 *      where/before/after/IP/reference, and are searchable.
 */

let world;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });
beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  await User.updateOne(
    {_id: world.owner._id},
    {$set: {password: await bcrypt.hash('OwnerP4ssword', 12)}}
  );
});

const login = (email, password, deviceLabel) =>
  request('/api/auth/login', {method: 'POST', body: {email, password, ...(deviceLabel ? {deviceLabel} : {})}});

async function ownerToken() {
  return (await login('owner@test.com', 'OwnerP4ssword', 'Audit')).body.token;
}

// ── immutability ─────────────────────────────────────────────────────────────

describe('Phase 21 · audit records are append-only', () => {
  it('refuses every Mongoose mutation path', async () => {
    const [row] = await Audit.create([{
      entity: 'test', action: 'probe', restaurant: world.restaurant._id, after: {v: 1}
    }]);

    // Document re-save.
    const doc = await Audit.findById(row._id);
    doc.action = 'tampered';
    await assert.rejects(() => doc.save(), /append-only/);

    // Query-level updates.
    await assert.rejects(() => Audit.updateOne({_id: row._id}, {$set: {action: 'x'}}), /append-only/);
    await assert.rejects(() => Audit.updateMany({}, {$set: {action: 'x'}}), /append-only/);
    await assert.rejects(() => Audit.findOneAndUpdate({_id: row._id}, {$set: {action: 'x'}}), /append-only/);
    await assert.rejects(() => Audit.replaceOne({_id: row._id}, {entity: 'x', action: 'y'}), /append-only/);

    // Deletes.
    await assert.rejects(() => Audit.deleteOne({_id: row._id}), /append-only/);
    await assert.rejects(() => Audit.deleteMany({}), /append-only/);
    await assert.rejects(() => Audit.findOneAndDelete({_id: row._id}), /append-only/);

    // DATABASE: the row is untouched by all of that.
    const after = await Audit.findById(row._id).lean();
    assert.equal(after.action, 'probe');
    assert.deepEqual(after.after, {v: 1});
    assert.equal(await Audit.countDocuments({entity: 'test'}), 1);
  });

  it('exposes no write endpoint', async () => {
    // A route that let a client author or edit an audit row would defeat the
    // subsystem, so the router is read-only by construction.
    const token = owner();
    for (const [method, path] of [
      ['POST', '/api/audit'], ['PATCH', '/api/audit'], ['DELETE', '/api/audit'],
      ['POST', '/api/audit/verify']
    ]) {
      const res = await request(path, {method, token, body: {entity: 'x', action: 'forged'}});
      assert.ok(res.status === 404 || res.status === 405,
        `${method} ${path} must not exist (${res.status})`);
    }
    assert.equal(await Audit.countDocuments({action: 'forged'}), 0);
  });
});

// ── hash chain ───────────────────────────────────────────────────────────────

describe('Phase 21 · tamper-evident hash chain', () => {
  it('chains every row, whatever wrote it', async () => {
    // The ~90 pre-existing Audit.create() call sites know nothing about
    // hashing; the schema hook must cover them anyway.
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Chain Supplier'});
    await request('/api/suppliers', {
      method: 'POST', token: owner(), body: {name: 'Another Supplier'}
    });
    await request(`/api/menu-items/${world.menu._id}`, {
      method: 'PATCH', token: owner(), body: {price: 400}
    });

    const rows = await Audit.find({restaurant: world.restaurant._id}).sort({sequence: 1}).lean();
    assert.ok(rows.length >= 2, 'expected several audited events');
    assert.ok(rows.every(row => Boolean(row.hash)), 'every row must be hashed');
    rows.forEach((row, index) => {
      assert.equal(row.sequence, index + 1, 'sequence must be contiguous');
    });
    assert.equal(rows[0].prevHash, null, 'the first row is the genesis link');
    for (let i = 1; i < rows.length; i += 1) {
      assert.equal(rows[i].prevHash, rows[i - 1].hash, `row ${i} must link to its predecessor`);
    }
    assert.ok(supplier);
  });

  it('verifies a clean chain', async () => {
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'Verify Supplier'}});
    const res = await request('/api/audit/verify', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.problemCount, 0);
    assert.ok(res.body.checked > 0);
    // The response must state the real guarantee, not overclaim prevention.
    assert.match(res.body.guarantee, /append-only store|log shipping/i);
  });

  it('DETECTS an edit made straight through the driver', async () => {
    // The application cannot be made to rewrite a row, but somebody with
    // database access can. The chain turns that from undetectable into
    // detectable, which is the honest ceiling here.
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'S1'}});
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'S2'}});
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'S3'}});

    const rows = await Audit.find({restaurant: world.restaurant._id}).sort({sequence: 1}).lean();
    const victim = rows[1];
    await Audit.collection.updateOne({_id: victim._id}, {$set: {action: 'silently-changed'}});

    const res = await request('/api/audit/verify', {token: owner()});
    assert.equal(res.body.verified, false);
    const content = res.body.problems.find(problem => problem.type === 'content');
    assert.ok(content, 'an edited row must be reported as a content break');
    assert.equal(content.sequence, victim.sequence);
  });

  it('DETECTS a deleted row', async () => {
    for (const name of ['D1', 'D2', 'D3', 'D4']) {
      await request('/api/suppliers', {method: 'POST', token: owner(), body: {name}});
    }
    const rows = await Audit.find({restaurant: world.restaurant._id}).sort({sequence: 1}).lean();
    await Audit.collection.deleteOne({_id: rows[1]._id});

    const res = await request('/api/audit/verify', {token: owner()});
    assert.equal(res.body.verified, false);
    // A removal shows up as both a sequence gap and a broken link.
    assert.ok(res.body.problems.some(problem => problem.type === 'sequence'));
    assert.ok(res.body.problems.some(problem => problem.type === 'link'));
  });

  it('recomputes the same hash for unchanged content', async () => {
    // Determinism: verification must not produce false positives.
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'Deterministic'}});
    const row = await Audit.findOne({restaurant: world.restaurant._id}).sort({sequence: -1}).lean();
    assert.equal(auditHash(row, row.prevHash), row.hash);
    assert.equal(auditHash(row, row.prevHash), auditHash(row, row.prevHash));
  });

  it('hashes a hydrated Mongoose document in before/after', async () => {
    // REGRESSION. The first canonicaliser recursed through a hydrated
    // document's self-referencing internals ($__, $parent) and blew the
    // stack, turning every supplier-invoice write into a 500. Passing a live
    // document is exactly what several existing call sites do.
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Hydrated'});
    const [row] = await Audit.create([{
      entity: 'test', action: 'hydrated', restaurant: world.restaurant._id,
      before: null, after: supplier
    }]);
    assert.ok(row.hash, 'a hydrated document must still hash');
    assert.equal((await request('/api/audit/verify', {token: owner()})).body.verified, true);
  });

  it('hashes a circular payload without recursing forever', async () => {
    // MongoDB itself refuses to store a truly circular object, so this is
    // asserted at the hashing layer where the stack overflow actually
    // happened rather than through a write that BSON would reject anyway.
    const circular = {name: 'loop'};
    circular.self = circular;
    const hash = auditHash({entity: 'test', action: 'circular', after: circular}, null);
    assert.match(hash, /^[a-f0-9]{64}$/);
    // Deterministic despite the cycle.
    assert.equal(auditHash({entity: 'test', action: 'circular', after: circular}, null), hash);
  });
});

// ── recorded events ──────────────────────────────────────────────────────────

describe('Phase 21 · required events are recorded', () => {
  it('records login, failed login and logout with the source IP', async () => {
    await login('owner@test.com', 'WrongPassword');
    await login('ghost@nowhere.test', 'WhateverP4ss');
    const token = (await login('owner@test.com', 'OwnerP4ssword', 'Phone')).body.token;
    await request('/api/auth/logout', {method: 'POST', token, body: {}});

    const rows = await Audit.find({entity: 'auth'}).sort({at: 1}).lean();
    const actions = rows.map(row => row.action);
    assert.deepEqual(actions, ['login_failed', 'login_failed', 'login', 'logout']);

    // A wrong password on a REAL account links the user; an unknown address
    // must not, so the log cannot be used to enumerate accounts.
    assert.equal(String(rows[0].user), String(world.owner._id));
    assert.equal(rows[0].reason, 'Incorrect password');
    assert.equal(rows[1].user, undefined);
    assert.equal(rows[1].reason, 'Unknown account');
    assert.equal(rows[1].after.email, 'ghost@nowhere.test');

    // WHERE: every auth row carries the client IP.
    assert.ok(rows.every(row => Boolean(row.ip)), 'auth events must record an IP');
  });

  it('records a deactivated account\'s login attempt as a failure', async () => {
    const account = await request('/api/accounts', {
      method: 'POST', token: owner(),
      body: {
        name: 'Deactivated User', email: 'gone@test.com', password: 'Str0ngPassw0rd',
        role: 'staff', branch: String(world.branchA._id)
      }
    });
    await request(`/api/accounts/${account.body._id}/active`, {
      method: 'PATCH', token: owner(), body: {active: false}
    });
    await login('gone@test.com', 'Str0ngPassw0rd');
    const row = await Audit.findOne({entity: 'auth', action: 'login_failed', reason: 'Account deactivated'}).lean();
    assert.ok(row, 'a deactivated login attempt must be audited');
  });

  it('records a price change as its own searchable action with before/after', async () => {
    const res = await request(`/api/menu-items/${world.menu._id}`, {
      method: 'PATCH', token: owner(), body: {price: 425}
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = await Audit.findOne({action: 'menu_price_changed'}).lean();
    assert.ok(row, 'a price change needs a distinct action');
    assert.equal(row.before.price, 350);
    assert.equal(row.after.price, 425);
    assert.equal(row.reference, 'Chicken Biryani');

    // Changing something else must NOT raise a price-change row.
    await request(`/api/menu-items/${world.menu._id}`, {
      method: 'PATCH', token: owner(), body: {name: 'Chicken Biryani Special'}
    });
    assert.equal(await Audit.countDocuments({action: 'menu_price_changed'}), 1);
  });

  it('records a stock adjustment with the real before and after balances', async () => {
    const res = await request('/api/inventory/adjustments', {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': 'audit-adjust-1'},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: -500, reason: 'spillage during service'
      }
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = await Audit.findOne({action: 'stock_adjustment'}).lean();
    assert.ok(row, 'a manual adjustment must be audited, not only ledgered');
    // seedWorld stocks 20000g.
    assert.equal(row.before.quantity, 20000);
    assert.equal(row.after.quantity, 19500);
    assert.equal(row.after.changeQty, -500);
    assert.equal(row.reason, 'spillage during service');
    assert.equal(row.reference, 'ING-T1');
    assert.equal(String(row.branch), String(world.branchA._id));
    assert.ok(row.ip, 'the request IP must be captured');
    assert.equal(row.userName, 'Owner');
  });

  it('already records the remaining events the brief names', async () => {
    // These were audited before this phase. Asserted here so the compliance
    // coverage is pinned in one place and cannot silently regress.
    const supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Coverage Supplier'});
    const po = await request('/api/purchase-orders', {
      method: 'POST', token: owner(),
      body: {
        branch: String(world.branchA._id), supplier: String(supplier._id),
        items: [{ingredient: String(world.ingredient._id), orderedQty: 1000, unit: 'g', unitPrice: 0.05, vatRate: 13}]
      }
    });
    assert.equal(po.status, 201, JSON.stringify(po.body));

    const count = await request('/api/stock-counts', {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': 'audit-count-1'},
      body: {branch: String(world.branchA._id), scope: 'full', notes: 'compliance probe'}
    });
    assert.equal(count.status, 201, JSON.stringify(count.body));

    await request(`/api/users/${world.staffA._id}/role`, {
      method: 'PATCH', token: owner(), body: {role: 'manager'}
    });

    const actions = new Set((await Audit.find({}).lean()).map(row => row.action));
    for (const required of ['po_create', 'stock_count_created', 'user_role_assigned']) {
      assert.ok(actions.has(required), `missing audit action ${required}`);
    }
  });
});

// ── search ───────────────────────────────────────────────────────────────────

describe('Phase 21 · compliance search', () => {
  async function seedEvents() {
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'Search Supplier'}});
    await request(`/api/menu-items/${world.menu._id}`, {method: 'PATCH', token: owner(), body: {price: 401}});
    await request('/api/inventory/adjustments', {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': 'search-adjust'},
      body: {
        branch: String(world.branchA._id), ingredient: String(world.ingredient._id),
        qty: -10, reason: 'search fixture adjustment'
      }
    });
  }

  it('searches by action, user, entity and reference', async () => {
    await seedEvents();

    const byAction = await request('/api/audit?action=menu_price_changed', {token: owner()});
    assert.equal(byAction.status, 200);
    assert.equal(byAction.body.pagination.total, 1);
    assert.equal(byAction.body.events[0].after.price, 401);

    const byUser = await request(`/api/audit?user=${world.manager._id}`, {token: owner()});
    assert.ok(byUser.body.pagination.total >= 1);
    assert.ok(byUser.body.events.every(event => String(event.actor.id) === String(world.manager._id)));

    const byEntity = await request('/api/audit?entity=inventory', {token: owner()});
    assert.equal(byEntity.body.events[0].action, 'stock_adjustment');

    const byReference = await request('/api/audit?reference=ING-T1', {token: owner()});
    assert.ok(byReference.body.pagination.total >= 1);
  });

  it('searches by date and rejects an impossible one', async () => {
    await seedEvents();
    const today = new Date(Date.now() + 5.75 * 3600 * 1000).toISOString().slice(0, 10);
    const hit = await request(`/api/audit?from=${today}&to=${today}`, {token: owner()});
    assert.ok(hit.body.pagination.total > 0, 'today\'s events must be findable');

    const miss = await request('/api/audit?from=2020-01-01&to=2020-01-02', {token: owner()});
    assert.equal(miss.body.pagination.total, 0);

    assert.equal((await request('/api/audit?from=2025-02-31', {token: owner()})).status, 400);
    assert.equal((await request('/api/audit?from=2025-05-10&to=2025-05-01', {token: owner()})).status, 400);
  });

  it('paginates', async () => {
    for (let i = 0; i < 6; i += 1) {
      await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: `Page Supplier ${i}`}});
    }
    const page1 = await request('/api/audit?limit=3&page=1', {token: owner()});
    const page2 = await request('/api/audit?limit=3&page=2', {token: owner()});
    assert.equal(page1.body.events.length, 3);
    assert.equal(page2.body.events.length, 3);
    const ids = new Set([...page1.body.events, ...page2.body.events].map(event => String(event._id)));
    assert.equal(ids.size, 6, 'pages must not overlap');
  });

  it('serves the action vocabulary for the UI filter', async () => {
    const res = await request('/api/audit/actions', {token: owner()});
    assert.equal(res.status, 200);
    for (const action of ['login', 'login_failed', 'logout', 'menu_price_changed',
      'stock_adjustment', 'order_refund', 'po_status', 'tax_invoice_issued', 'user_role_assigned']) {
      assert.ok(res.body.actions.includes(action), `${action} must be offered as a filter`);
    }
    assert.ok(res.body.groups.Authentication.includes('login_failed'));
  });
});

// ── access control and tenancy ───────────────────────────────────────────────

describe('Phase 21 · audit access control', () => {
  it('is owner-only', async () => {
    for (const token of [manager(), staff()]) {
      assert.equal((await request('/api/audit', {token})).status, 403);
      assert.equal((await request('/api/audit/actions', {token})).status, 403);
      assert.equal((await request('/api/audit/verify', {token})).status, 403);
    }
    assert.equal((await request('/api/audit')).status, 401);
    assert.equal((await request('/api/audit', {token: owner()})).status, 200);
  });

  it('never returns another restaurant\'s audit rows', async () => {
    // THE DEFECT THIS PHASE FIXES. The previous handler ran `Audit.find()`
    // with no tenant filter, so an owner of one restaurant could read every
    // other restaurant's trail. It went unnoticed because the route lived in
    // index.js, outside the test harness's router set.
    const rival = await Restaurant.create({name: 'Rival Momo', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'Rival', code: 'RVL'});
    const rivalOwner = await User.create({
      name: 'Rival Owner', email: 'rival@test.com', password: 'x',
      role: 'owner', restaurantId: rival._id
    });
    await Audit.create([{
      entity: 'order', entityId: new mongoose.Types.ObjectId(), restaurant: rival._id,
      branch: rivalBranch._id, action: 'order_refund',
      after: {marker: 'RIVAL-CONFIDENTIAL-9999'}, user: rivalOwner._id
    }]);
    await request('/api/suppliers', {method: 'POST', token: owner(), body: {name: 'Ours'}});

    const res = await request('/api/audit', {token: owner()});
    assert.equal(res.status, 200);
    assert.doesNotMatch(JSON.stringify(res.body), /RIVAL-CONFIDENTIAL-9999/);
    assert.ok(res.body.events.every(event => String(event.restaurant) === String(world.restaurant._id)));

    // And the rival cannot read ours.
    const theirs = await request('/api/audit', {token: tokenFor(rivalOwner)});
    assert.ok(theirs.body.events.every(event => String(event.restaurant) === String(rival._id)));
  });

  it('confines a non-owner reader to their own branch', async () => {
    // A manager granted audit.view through a custom role must not read another
    // branch's refunds. Proven with a row explicitly stamped to branch B.
    const created = await request('/api/roles', {
      method: 'POST', token: owner(),
      body: {
        key: 'compliance', name: 'Compliance Officer', baseRole: 'manager',
        permissions: ['audit.view', 'branches.view']
      }
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const officer = await User.create({
      name: 'Officer', email: 'officer@test.com', password: 'x',
      role: 'manager', roleKey: 'compliance',
      restaurantId: world.restaurant._id, branch: world.branchA._id
    });

    await Audit.create([{
      entity: 'order', entityId: new mongoose.Types.ObjectId(), restaurant: world.restaurant._id,
      branch: world.branchB._id, action: 'order_refund', after: {marker: 'BRANCH-B-ONLY'},
      user: world.owner._id
    }]);
    await Audit.create([{
      entity: 'order', entityId: new mongoose.Types.ObjectId(), restaurant: world.restaurant._id,
      branch: world.branchA._id, action: 'order_refund', after: {marker: 'BRANCH-A-OK'},
      user: world.owner._id
    }]);

    const res = await request('/api/audit', {token: tokenFor(officer)});
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'branch');
    const body = JSON.stringify(res.body);
    assert.match(body, /BRANCH-A-OK/);
    assert.doesNotMatch(body, /BRANCH-B-ONLY/, 'a branch reader must not see another branch');

    // Asking for the other branch explicitly is refused rather than ignored.
    assert.equal((await request(`/api/audit?branch=${world.branchB._id}`, {token: tokenFor(officer)})).status, 403);
    // Chain verification is a whole-tenant statement, so it stays owner-only.
    assert.equal((await request('/api/audit/verify', {token: tokenFor(officer)})).status, 403);
  });

  it('refuses a branch from another restaurant', async () => {
    const rival = await Restaurant.create({name: 'Rival', currency: 'NPR'});
    const rivalBranch = await Branch.create({restaurant: rival._id, name: 'R', code: 'RVX'});
    assert.equal((await request(`/api/audit?branch=${rivalBranch._id}`, {token: owner()})).status, 404);
  });
});
