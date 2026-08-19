/**
 * Phase 14 — inventory counts and stock adjustment.
 *
 * A full count session engine already existed (`services/stockCounts.js`):
 * full and cycle scopes, immutable system snapshot, variance calculation,
 * approval through the inventory ledger, separation of duties, per-branch
 * locking, idempotent create and decide, and optimistic versioning. It is
 * pinned by stockCounts.test.js and was NOT rebuilt.
 *
 * This suite covers the brief's state machine and the defect the audit found:
 *
 *   Draft → Counting → Submitted → Approved → ledger variance
 *                                → Rejected → recount
 *                                → STALE    → recount
 *
 *   1. There was no `counting` state — a sheet someone was part-way through
 *      was indistinguishable from an untouched draft.
 *   2. A stale approval THREW and left the session stuck in `submitted` still
 *      holding the branch lock. Reproduced against the running API: the count
 *      could never be approved, never be closed, and `POST /stock-counts`
 *      answered 409 "This branch already has an active stock count" forever.
 *      The branch could not count again.
 *   3. A recount had no link back to the session it replaced.
 *
 * Every assertion checks MongoDB state, not just the HTTP status.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, Ingredient, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Restaurant, StockCount
} from '../src/models/operations.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let rival;
let second;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  const {ensureStockCountIndexes} = await import('../src/services/stockCountMigration.js');
  await ensureStockCountIndexes();

  // A second ingredient, so a cycle count is genuinely a SUBSET.
  second = await Ingredient.create({
    restaurant: world.restaurant._id, code: 'ING-T9', name: 'Sunflower Oil',
    unit: 'ml', minimumStock: 500
  });

  const restaurant = await Restaurant.create({name: 'Rival14', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival14 Branch', code: 'RV4', address: 'Kirtipur'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival14 Owner', email: 'rival14s@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival14', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const BRANCH = () => String(world.branchA._id);

let keySeed = 0;
const KEY = () => `p14sc-${Date.now()}-${++keySeed}`;

const create = (body = {}, token = staff(), key = KEY()) =>
  request('/api/stock-counts', {
    method: 'POST', token, headers: {'Idempotency-Key': key},
    body: {branch: BRANCH(), scope: 'full', notes: 'Closing physical inventory', ...body}
  });

const patch = (id, body, token = staff()) =>
  request(`/api/stock-counts/${id}`, {method: 'PATCH', token, body});

const submit = (id, expectedVersion, token = staff(), note = 'Counted by hand') =>
  request(`/api/stock-counts/${id}/submit`, {method: 'POST', token, body: {expectedVersion, note}});

const approve = (id, expectedVersion, token = manager(), key = KEY(), note = 'Approved') =>
  request(`/api/stock-counts/${id}/approve`, {
    method: 'POST', token, headers: {'Idempotency-Key': key}, body: {expectedVersion, note}
  });

const reject = (id, expectedVersion, token = manager(), key = KEY(), note = 'Recount please') =>
  request(`/api/stock-counts/${id}/reject`, {
    method: 'POST', token, headers: {'Idempotency-Key': key}, body: {expectedVersion, note}
  });

const adjust = (qty, key = KEY(), ingredient = world.ingredient) =>
  request('/api/inventory/adjustments', {
    method: 'POST', token: owner(), headers: {'Idempotency-Key': key},
    body: {branch: BRANCH(), ingredient: String(ingredient._id), qty, reason: 'Movement after capture'}
  });

const balanceOf = async (ingredient = world.ingredient) => (await InventoryBalance.findOne({
  branch: world.branchA._id, ingredient: ingredient._id
}))?.quantity ?? 0;

/** Enter a physical quantity on every line and submit. */
async function countAndSubmit(created, physicalQty, token = staff()) {
  const updated = await patch(created.body._id, {
    expectedVersion: created.body.__v,
    lines: created.body.lines.map(line => ({lineId: String(line._id), physicalQty}))
  }, token);
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  return submit(created.body._id, updated.body.__v, token);
}

// ═══════════════════════════════════════════════════════════════════════════
// Full count
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — full count', () => {
  it('opens a session over every active ingredient with the system quantity captured', async () => {
    const res = await create();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'full');
    assert.equal(res.body.status, 'draft');
    assert.equal(res.body.lines.length, 2, 'a full count covers all active ingredients');

    const rice = res.body.lines.find(l => l.ingredientName === 'Basmati Rice');
    assert.equal(rice.systemQty, 20000, 'the system quantity is captured at open');
    assert.equal(rice.physicalQty, undefined, 'nothing is counted yet');
  });

  it('excludes inactive ingredients', async () => {
    await Ingredient.updateOne({_id: second._id}, {$set: {active: false}});
    const res = await create();
    assert.equal(res.body.lines.length, 1);
    assert.equal(res.body.lines[0].ingredientName, 'Basmati Rice');
  });

  it('captures system, physical and variance on each line', async () => {
    const created = await create();
    const updated = await patch(created.body._id, {
      expectedVersion: created.body.__v,
      lines: [{lineId: String(created.body.lines[0]._id), physicalQty: 19600}]
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const line = updated.body.lines.find(l => l.physicalQty != null);
    assert.equal(line.systemQty, 20000);
    assert.equal(line.physicalQty, 19600);
    assert.equal(line.varianceQty, -400, 'variance is physical less system');
    assert.equal(Math.round(line.varianceValue * 100) / 100, -18, '400g at 0.045 = 18');
    assert.ok(line.countedBy, 'the counter is recorded on the line');
    assert.ok(line.countedAt);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Cycle count
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — cycle count', () => {
  it('covers only the selected ingredients', async () => {
    const res = await create({scope: 'cycle', ingredientIds: [String(second._id)]});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.scope, 'cycle');
    assert.equal(res.body.lines.length, 1);
    assert.equal(res.body.lines[0].ingredientName, 'Sunflower Oil');
  });

  it('refuses an empty selection and an unknown ingredient', async () => {
    assert.equal((await create({scope: 'cycle', ingredientIds: []})).status, 400);
    // An id that matches no active ingredient resolves to an empty selection,
    // which is refused before any session is created.
    const unknown = await create({
      scope: 'cycle', ingredientIds: [String(new mongoose.Types.ObjectId())]
    });
    assert.equal(unknown.status, 409);
    assert.match(unknown.body.message, /No active ingredients/);
    assert.equal(await StockCount.countDocuments({}), 0);
  });

  it('adjusts only the counted ingredient on approval', async () => {
    const riceBefore = await balanceOf();
    const created = await create({scope: 'cycle', ingredientIds: [String(second._id)]});
    const submitted = await countAndSubmit(created, 40);
    assert.equal((await approve(created.body._id, submitted.body.__v)).status, 200);

    assert.equal(await balanceOf(), riceBefore, 'an uncounted ingredient is untouched');
    assert.equal(await balanceOf(second), 40);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The state machine
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — session lifecycle', () => {
  it('moves draft to counting on the first entered figure', async () => {
    const created = await create();
    assert.equal(created.body.status, 'draft');

    const updated = await patch(created.body._id, {
      expectedVersion: created.body.__v,
      lines: [{lineId: String(created.body.lines[0]._id), physicalQty: 19600}]
    });
    assert.equal(updated.body.status, 'counting', 'a part-counted sheet is not an untouched draft');
    assert.equal((await StockCount.findById(created.body._id)).status, 'counting');
  });

  it('stays draft when a note is edited but nothing is counted', async () => {
    const created = await create();
    const updated = await patch(created.body._id, {
      expectedVersion: created.body.__v, notes: 'Starting after close'
    });
    assert.equal(updated.body.status, 'draft');
  });

  it('does not fall back to draft when a figure is cleared', async () => {
    const created = await create();
    const line = String(created.body.lines[0]._id);
    const counted = await patch(created.body._id, {
      expectedVersion: created.body.__v, lines: [{lineId: line, physicalQty: 100}]
    });
    const cleared = await patch(created.body._id, {
      expectedVersion: counted.body.__v, lines: [{lineId: line, physicalQty: null}]
    });
    assert.equal(cleared.body.status, 'counting', 'the session was still opened for counting');
  });

  it('refuses to submit a partially counted sheet', async () => {
    const created = await create();
    const updated = await patch(created.body._id, {
      expectedVersion: created.body.__v,
      lines: [{lineId: String(created.body.lines[0]._id), physicalQty: 19600}]
    });
    const res = await submit(created.body._id, updated.body.__v);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /missing/i);
    assert.equal((await StockCount.findById(created.body._id)).status, 'counting');
  });

  it('refuses to edit a submitted sheet', async () => {
    const created = await create();
    const submitted = await countAndSubmit(created, 19600);
    assert.equal(submitted.body.status, 'submitted');
    const res = await patch(created.body._id, {
      expectedVersion: submitted.body.__v,
      lines: [{lineId: String(created.body.lines[0]._id), physicalQty: 1}]
    });
    assert.equal(res.status, 409);
    assert.equal((await StockCount.findById(created.body._id)).lines[0].physicalQty, 19600);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Approval writes the variance through the ledger
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — approval and the ledger', () => {
  it('writes the variance as a ledger movement with sound arithmetic', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19600);
    const res = await approve(created.body._id, submitted.body.__v);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'approved');

    assert.equal(await balanceOf(), 19600, 'the physical figure becomes the balance');

    const movement = await InventoryTransaction.findOne({
      referenceType: 'stock_count', referenceId: created.body._id
    });
    assert.ok(movement, 'the adjustment must go through the ledger');
    assert.equal(movement.type, 'ADJUSTMENT');
    assert.equal(movement.changeQty, -400);
    assert.equal(movement.previousQty, 20000);
    assert.equal(movement.newQty, 19600);
    assert.equal(movement.newQty, movement.previousQty + movement.changeQty);
  });

  it('writes no movement when the count matches the system exactly', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 20000);
    assert.equal((await approve(created.body._id, submitted.body.__v)).status, 200);

    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0,
      'a zero variance is not a stock movement');
    assert.equal(await balanceOf(), 20000);
  });

  it('records a positive variance as stock found', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 20500);
    assert.equal((await approve(created.body._id, submitted.body.__v)).status, 200);
    const movement = await InventoryTransaction.findOne({referenceType: 'stock_count'});
    assert.equal(movement.changeQty, 500);
    assert.equal(await balanceOf(), 20500);
  });

  it('releases the branch lock so the next count can start', async () => {
    const created = await create();
    const submitted = await countAndSubmit(created, 20000);
    await approve(created.body._id, submitted.body.__v);
    assert.equal((await StockCount.findById(created.body._id)).activeKey, undefined);
    assert.equal((await create()).status, 201);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Stale protection
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — stale protection', () => {
  it('closes the session as STALE instead of overwriting a later movement', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);

    // A genuine sale happens after the sheet was counted.
    assert.equal((await adjust(-500)).status, 201);
    assert.equal(await balanceOf(), 19500);

    const res = await approve(created.body._id, submitted.body.__v);
    assert.equal(res.status, 409);
    assert.match(res.body.message, /Stock changed after this count was captured/);

    // The valid movement stands; the stale snapshot is NOT written.
    assert.equal(await balanceOf(), 19500, 'a stale count must never overwrite newer stock');
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'stale');
    assert.ok(stored.staleAt);
    assert.equal(stored.approvedBy, undefined, 'a stale count was never approved');
  });

  it('refuses at the schema to persist a completed count still holding the lock', async () => {
    // The service clears activeKey; this is the backstop that stops a future
    // regression from leaving the branch permanently locked, which is exactly
    // the failure mode this phase fixed.
    const created = await create();
    const submitted = await countAndSubmit(created, 20000);
    await approve(created.body._id, submitted.body.__v);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'approved');
    stored.activeKey = String(world.branchA._id);
    await assert.rejects(stored.save(), /cannot retain a branch lock/);

    // And an active session must always hold one.
    const live = await create();
    const doc = await StockCount.findById(live.body._id);
    doc.activeKey = undefined;
    await assert.rejects(doc.save(), /require a branch lock/);
  });

  it('names the ingredients whose stock moved', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await approve(created.body._id, submitted.body.__v);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.staleLines.length, 1);
    assert.equal(stored.staleLines[0].ingredientName, 'Basmati Rice');
    assert.equal(stored.staleLines[0].capturedQty, 20000);
    assert.equal(stored.staleLines[0].currentQty, 19500);
  });

  it('detects a movement that nets back to the same quantity', async () => {
    // The quantity matches again, but the stock genuinely moved, so the sheet
    // is no longer evidence of anything.
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await adjust(500);
    assert.equal(await balanceOf(), 20000, 'the quantity is back where it started');

    const res = await approve(created.body._id, submitted.body.__v);
    assert.equal(res.status, 409, 'the ledger version moved even though the quantity did not');
    assert.equal((await StockCount.findById(created.body._id)).status, 'stale');
  });

  it('frees the branch so a recount can be started immediately', async () => {
    // The defect: the session stuck in `submitted` held the lock forever, so
    // the branch could never count again.
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await approve(created.body._id, submitted.body.__v);

    assert.equal((await StockCount.findById(created.body._id)).activeKey, undefined);
    const recount = await create({recountOf: String(created.body._id)});
    assert.equal(recount.status, 201, JSON.stringify(recount.body));
    assert.equal(String(recount.body.recountOf._id ?? recount.body.recountOf), String(created.body._id));
  });

  it('recaptures the CURRENT stock on the recount', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await approve(created.body._id, submitted.body.__v);

    const recount = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    assert.equal(recount.body.lines[0].systemQty, 19500, 'the recount starts from reality');
  });

  it('cannot be approved after it has gone stale', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await approve(created.body._id, submitted.body.__v);

    const again = await approve(created.body._id, submitted.body.__v + 1);
    assert.equal(again.status, 409);
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);
  });

  it('only recounts a stale or rejected session', async () => {
    // An APPROVED count is finished, not something to redo under a recount
    // link. The branch lock is already released here, so this isolates the
    // status rule itself rather than the lock.
    const done = await create();
    const submitted = await countAndSubmit(done, 20000);
    assert.equal((await approve(done.body._id, submitted.body.__v)).status, 200);

    const res = await create({recountOf: String(done.body._id)});
    assert.equal(res.status, 409);
    assert.match(res.body.message, /stale or rejected/);
    assert.equal(await StockCount.countDocuments({}), 1, 'no session was opened');

    // A rejected one is recountable.
    const bad = await create();
    const badSubmitted = await countAndSubmit(bad, 15000);
    await reject(bad.body._id, badSubmitted.body.__v);
    assert.equal((await create({recountOf: String(bad.body._id)})).status, 201);
  });

  it('refuses a recount pointing at another restaurant session', async () => {
    const foreign = await StockCount.create({
      restaurant: rival.restaurant._id, branch: rival.branch._id, countNo: 'SC-RV4-X',
      scope: 'full', status: 'rejected', createdBy: rival.owner._id,
      submittedBy: rival.owner._id, submittedAt: new Date(),
      rejectedBy: rival.owner._id, rejectedAt: new Date(), decisionNote: 'no',
      decisionKey: 'k-foreign', decisionHash: 'c'.repeat(64),
      requestKey: 'foreign-req', requestHash: 'd'.repeat(64),
      lines: [{
        ingredient: world.ingredient._id, ingredientName: 'X', unit: 'g',
        systemQty: 1, systemUnitCost: 1, balanceVersion: 0, physicalQty: 1,
        countedBy: rival.owner._id, countedAt: new Date()
      }]
    });
    const res = await create({recountOf: String(foreign._id)});
    assert.equal(res.status, 404, 'a recount must not reach across the tenant boundary');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrent stock change during approval
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — concurrent stock change', () => {
  it('never loses a movement that lands while the approval is running', async () => {
    // Driven through overlapping mongoose sessions. Express serialises HTTP
    // requests, so an HTTP-only "concurrency" test proves nothing here.
    const {decideStockCount} = await import('../src/services/stockCounts.js');
    const {moveStock} = await import('../src/services/inventoryLedger.js');

    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);

    const runApproval = async () => {
      const session = await mongoose.startSession();
      try {
        let out;
        await session.withTransaction(async () => {
          out = await decideStockCount({
            countId: created.body._id, decision: 'approved', note: 'Race',
            expectedVersion: submitted.body.__v, user: world.manager,
            idempotencyKey: KEY(), session
          });
        });
        return out?.stale ? 'STALE' : 'APPROVED';
      } catch (e) {
        return `ERR:${e.message}`;
      } finally {
        await session.endSession();
      }
    };

    const runMovement = async () => {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await moveStock({
            branch: world.branchA._id, ingredient: world.ingredient._id, qty: -500, unit: 'g',
            type: 'ADJUSTMENT', reason: 'Sale during the approval',
            referenceType: 'concurrent_probe', referenceId: new mongoose.Types.ObjectId(),
            user: world.owner._id, idempotencyKey: KEY()
          }, session);
        });
        return 'MOVED';
      } catch (e) {
        return `ERR:${e.message}`;
      } finally {
        await session.endSession();
      }
    };

    const [approval, movement] = await Promise.all([runApproval(), runMovement()]);
    assert.equal(movement, 'MOVED', 'a real stock movement must never be refused by a count');

    const balance = await balanceOf();
    const stored = await StockCount.findById(created.body._id);

    if (approval === 'APPROVED') {
      // The approval won the race: the count applied first, then the sale.
      assert.equal(stored.status, 'approved');
      assert.equal(balance, 18500, '19000 counted, then 500 sold');
    } else {
      // The sale won: the snapshot is stale and must not be written.
      assert.equal(approval, 'STALE', approval);
      assert.equal(stored.status, 'stale');
      assert.equal(balance, 19500, 'the sale stands; the stale snapshot is discarded');
      assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);
    }
  });

  it('keeps the ledger chain intact for the counted ingredient', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19600);
    await approve(created.body._id, submitted.body.__v);
    await adjust(-100);

    const rows = await InventoryTransaction.find({
      branch: world.branchA._id, ingredient: world.ingredient._id
    }).sort({createdAt: 1, _id: 1}).lean();

    for (let i = 1; i < rows.length; i += 1) {
      assert.equal(rows[i].previousQty, rows[i - 1].newQty,
        `ledger chain broken at row ${i}`);
      assert.equal(rows[i].newQty, rows[i].previousQty + rows[i].changeQty);
    }
    assert.equal(rows.at(-1).newQty, await balanceOf());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Rejection
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — rejection', () => {
  it('rejects with a reason, moves no stock and frees the branch', async () => {
    const before = await balanceOf();
    const created = await create();
    const submitted = await countAndSubmit(created, 15000);

    const res = await reject(created.body._id, submitted.body.__v, manager(), KEY(), 'Counted the wrong shelf');
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'rejected');
    assert.equal(stored.decisionNote, 'Counted the wrong shelf');
    assert.ok(stored.rejectedBy);
    assert.equal(await balanceOf(), before, 'a rejected count moves nothing');
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);

    assert.equal((await create({recountOf: String(created.body._id)})).status, 201);
  });

  it('requires a rejection reason', async () => {
    const created = await create();
    const submitted = await countAndSubmit(created, 15000);
    const res = await request(`/api/stock-counts/${created.body._id}/reject`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {expectedVersion: submitted.body.__v, note: 'x'}
    });
    assert.equal(res.status, 400);
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorisation
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — authorisation', () => {
  it('lets staff count but never decide', async () => {
    const created = await create();
    assert.equal(created.status, 201, 'staff may open and count a session');
    const submitted = await countAndSubmit(created, 20000);
    assert.equal(submitted.status, 200);

    assert.equal((await approve(created.body._id, submitted.body.__v, staff())).status, 403);
    assert.equal((await reject(created.body._id, submitted.body.__v, staff())).status, 403);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'submitted', 'hiding a button is not the control');
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);
  });

  it('refuses anonymous and forged tokens on every endpoint', async () => {
    const created = await create();
    const id = created.body._id;
    for (const [path, options] of [
      [`/api/stock-counts?branch=${BRANCH()}`, {}],
      [`/api/stock-counts/${id}`, {}],
      ['/api/stock-counts', {method: 'POST', body: {branch: BRANCH(), scope: 'full'}}],
      [`/api/stock-counts/${id}/submit`, {method: 'POST', body: {expectedVersion: 0}}],
      [`/api/stock-counts/${id}/approve`, {method: 'POST', body: {expectedVersion: 0}}],
      [`/api/stock-counts/${id}/reject`, {method: 'POST', body: {expectedVersion: 0, note: 'no'}}]
    ]) {
      assert.equal((await request(path, options)).status, 401, `${path} anonymous`);
      assert.equal((await request(path, {...options, token: 'not.a.jwt'})).status, 401, `${path} forged`);
    }
  });

  it('stops a manager approving a count they submitted themselves', async () => {
    const created = await create({}, manager());
    const submitted = await countAndSubmit(created, 19000, manager());
    const res = await approve(created.body._id, submitted.body.__v, manager());
    assert.equal(res.status, 403, 'separation of duties');
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');
    // An owner may still approve it.
    assert.equal((await approve(created.body._id, submitted.body.__v, owner())).status, 200);
  });

  it('refuses every cross-restaurant action', async () => {
    const created = await create();
    const submitted = await countAndSubmit(created, 19000);
    const intruder = tokenFor(rival.owner);

    for (const [path, options] of [
      [`/api/stock-counts/${created.body._id}`, {}],
      [`/api/stock-counts/${created.body._id}/history`, {}],
      [`/api/stock-counts/${created.body._id}/approve`, {
        method: 'POST', headers: {'Idempotency-Key': KEY()},
        body: {expectedVersion: submitted.body.__v, note: 'theft'}
      }]
    ]) {
      const res = await request(path, {...options, token: intruder});
      assert.ok([403, 404].includes(res.status), `${path} -> ${res.status}`);
    }
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');
    assert.equal(await balanceOf(), 20000);
  });

  it('stops a branch-bound manager counting another branch', async () => {
    // world.manager is bound to branch A.
    const res = await create({branch: String(world.branchB._id)}, manager());
    assert.equal(res.status, 403);
    assert.equal(await StockCount.countDocuments({}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit trail
// ═══════════════════════════════════════════════════════════════════════════

describe('14 — audit trail', () => {
  it('records the counter, the approver, the quantities and the variance', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19600);
    await approve(created.body._id, submitted.body.__v, manager(), KEY(), 'Shrinkage accepted');

    const rows = await Audit.find({entity: 'stock_count', entityId: created.body._id})
      .sort({at: 1}).lean();
    const actions = rows.map(r => r.action);
    assert.deepEqual(actions, [
      'stock_count_created', 'stock_count_updated', 'stock_count_submitted', 'stock_count_approved'
    ]);

    const submittedRow = rows.find(r => r.action === 'stock_count_submitted');
    assert.equal(String(submittedRow.user), String(world.staffA._id), 'the counter is recorded');

    const approvedRow = rows.find(r => r.action === 'stock_count_approved');
    assert.equal(String(approvedRow.user), String(world.manager._id), 'the approver is recorded');
    assert.equal(approvedRow.reason, 'Shrinkage accepted');
    assert.ok(approvedRow.at, 'every entry is timestamped');

    // Old quantity, physical quantity and variance survive on the count itself.
    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.lines[0].systemQty, 20000);
    assert.equal(stored.lines[0].physicalQty, 19600);
    assert.equal(stored.lines[0].varianceQty, -400);
    assert.equal(String(stored.lines[0].countedBy), String(world.staffA._id));
    assert.equal(String(stored.approvedBy), String(world.manager._id));
  });

  it('refuses at the schema to persist a stale count with no evidence', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await approve(created.body._id, submitted.body.__v);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'stale');
    stored.staleLines = [];
    await assert.rejects(stored.save(), /require stale evidence/);

    const fresh = await StockCount.findById(created.body._id);
    fresh.staleAt = undefined;
    await assert.rejects(fresh.save(), /require stale evidence/);
  });

  it('records a stale-out with the ingredients that moved', async () => {
    const created = await create({scope: 'cycle', ingredientIds: [String(world.ingredient._id)]});
    const submitted = await countAndSubmit(created, 19000);
    await adjust(-500);
    await approve(created.body._id, submitted.body.__v);

    const entry = await Audit.findOne({
      entity: 'stock_count', entityId: created.body._id, action: 'stock_count_stale'
    }).lean();
    assert.ok(entry, 'a stale-out must be auditable');
    assert.match(entry.reason, /Basmati Rice/);
    assert.equal(entry.after.status, 'stale');
    assert.equal(String(entry.user), String(world.manager._id));
  });

  it('exposes the history through the API', async () => {
    const created = await create();
    const submitted = await countAndSubmit(created, 20000);
    await reject(created.body._id, submitted.body.__v, manager(), KEY(), 'Recount the freezer');

    const res = await request(`/api/stock-counts/${created.body._id}/history`, {token: manager()});
    assert.equal(res.status, 200);
    const rejected = res.body.find(row => row.action === 'stock_count_rejected');
    assert.ok(rejected);
    assert.equal(rejected.reason, 'Recount the freezer');
    assert.equal(rejected.actor.name, 'Manager');
  });
});
