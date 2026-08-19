/**
 * Phase 15 — stock count production hardening: recovery for wedged sessions.
 *
 * A stock count holds an exclusive per-branch lock (`activeKey`). Phase 14
 * fixed the common wedge — a stale snapshot now closes itself. Auditing the
 * shipped behaviour against the running API found three remaining ways a
 * SUBMITTED session can hold its lock with no route to a decision, each
 * reproduced before any code was written:
 *
 *   1. MISSING INGREDIENT — approval calls moveStock(), which answers
 *      404 "Inventory movement ingredient was not found". The transaction
 *      aborts and the session stays submitted and locked, forever.
 *      Probe: approve -> 404 | status submitted | lock STILL SET.
 *   2. ORPHAN LOCK — a terminal count still carrying `activeKey`. The schema
 *      blocks saving one, but a raw driver write produces it and it blocks the
 *      branch identically. Probe: approved count + reinstated lock ->
 *      new count 409 "This branch already has an active stock count".
 *   3. NO ELIGIBLE APPROVER — a manager-submitted count where separation of
 *      duties leaves nobody able to approve.
 *      Probe: self-approve -> 403 | lock STILL SET.
 *
 * The recovery must be boring and provable: dry run by default, never approve,
 * never post stock, never touch a captured figure, never delete audit history,
 * idempotent, and it must refuse to touch a session someone is working on.
 */
import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {Audit, Ingredient, User} from '../src/models/index.js';
import {
  Branch, InventoryBalance, InventoryTransaction, Restaurant, StockCount
} from '../src/models/operations.js';
import {
  DEFAULT_MIN_AGE_MINUTES, RECOVERY_REASONS, diagnoseSession,
  recoverLockedSessions, scanLockedSessions
} from '../src/services/stockCountRecovery.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let rival;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  const {ensureStockCountIndexes} = await import('../src/services/stockCountMigration.js');
  await ensureStockCountIndexes();

  const restaurant = await Restaurant.create({name: 'Rival15', currency: 'NPR', vatRate: 13});
  const branch = await Branch.create({
    restaurant: restaurant._id, name: 'Rival15 Branch', code: 'RV5', address: 'Bouddha'
  });
  rival = {
    restaurant,
    branch,
    owner: await User.create({
      name: 'Rival15 Owner', email: 'rival15@test.com', password: 'x', role: 'owner',
      restaurant: 'Rival15', restaurantId: restaurant._id
    })
  };
});

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const BRANCH = () => String(world.branchA._id);

let keySeed = 0;
const KEY = () => `p15-${Date.now()}-${++keySeed}`;

const create = (body = {}, token = staff()) =>
  request('/api/stock-counts', {
    method: 'POST', token, headers: {'Idempotency-Key': KEY()},
    body: {branch: BRANCH(), scope: 'full', notes: 'Recovery fixture', ...body}
  });

const recover = (body = {}, token = owner()) =>
  request('/api/stock-counts/recover-locks', {method: 'POST', token, body});

async function countAndSubmit(created, physicalQty, token = staff()) {
  const updated = await request(`/api/stock-counts/${created.body._id}`, {
    method: 'PATCH', token,
    body: {
      expectedVersion: created.body.__v,
      lines: created.body.lines.map(line => ({lineId: String(line._id), physicalQty}))
    }
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  const submitted = await request(`/api/stock-counts/${created.body._id}/submit`, {
    method: 'POST', token, body: {expectedVersion: updated.body.__v}
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return submitted;
}

/** Backdate a session so it is past the activity threshold. */
async function age(countId, minutes = DEFAULT_MIN_AGE_MINUTES + 60) {
  const when = new Date(Date.now() - minutes * 60000);
  await StockCount.collection.updateOne(
    {_id: new mongoose.Types.ObjectId(String(countId))},
    {$set: {updatedAt: when, submittedAt: when, createdAt: when}}
  );
}

/** WEDGE 1: a submitted count whose ingredient has since been deleted. */
async function wedgedByMissingIngredient() {
  const doomed = await Ingredient.create({
    restaurant: world.restaurant._id, code: 'ING-DOOM', name: 'Discontinued Spice', unit: 'g'
  });
  const created = await create({scope: 'cycle', ingredientIds: [String(doomed._id)]});
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const submitted = await countAndSubmit(created, 12);
  await Ingredient.deleteOne({_id: doomed._id});
  await age(created.body._id);
  return {created, submitted, ingredientId: doomed._id};
}

/** WEDGE 2: a terminal count that still carries a branch lock. */
async function wedgedByOrphanLock() {
  const created = await create();
  const submitted = await countAndSubmit(created, 20000);
  const approved = await request(`/api/stock-counts/${created.body._id}/approve`, {
    method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
    body: {expectedVersion: submitted.body.__v, note: 'Clean count'}
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  // Only a raw driver write can create this state; the schema refuses to save it.
  await StockCount.collection.updateOne(
    {_id: new mongoose.Types.ObjectId(String(created.body._id))},
    {$set: {activeKey: BRANCH()}}
  );
  return created;
}

const RID = () => world.restaurant._id;

// ═══════════════════════════════════════════════════════════════════════════
// The wedges are real
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — the wedge is reproducible', () => {
  it('a deleted ingredient makes approval permanently impossible', async () => {
    const {created, submitted} = await wedgedByMissingIngredient();
    const res = await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {expectedVersion: submitted.body.__v, note: 'Try to close it'}
    });
    assert.equal(res.status, 404);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'submitted', 'the session is stuck');
    assert.ok(stored.activeKey, 'and it still holds the branch lock');

    // Which is what blocks the branch.
    const blocked = await create();
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.message, /already has an active stock count/);
  });

  it('an orphan lock on a terminal count blocks the branch just as hard', async () => {
    await wedgedByOrphanLock();
    const blocked = await create();
    assert.equal(blocked.status, 409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Dry run is the default
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — dry run by default', () => {
  it('reports what it would do and changes nothing', async () => {
    const {created} = await wedgedByMissingIngredient();

    const res = await recover();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, true, 'a bare call must never write');
    assert.equal(res.body.eligible, 1);
    assert.equal(res.body.recovered, 0);
    assert.equal(res.body.actions[0].applied, false);
    assert.equal(res.body.actions[0].toStatus, 'stale');

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'submitted', 'nothing was written');
    assert.ok(stored.activeKey, 'the lock is still held after a dry run');
    assert.equal(await Audit.countDocuments({action: 'stock_count_lock_recovered'}), 0);
  });

  it('explains why each session qualifies', async () => {
    await wedgedByMissingIngredient();
    const res = await recover();
    const action = res.body.actions[0];
    assert.equal(action.reason, RECOVERY_REASONS.MISSING_INGREDIENT);
    assert.match(action.detail, /no longer exist/i);
    assert.match(action.detail, /Discontinued Spice/);
    assert.ok(action.countNo, 'the operator needs the count number');
    assert.ok(action.branchName, 'and which branch it is blocking');
  });

  it('explains why a session does NOT qualify', async () => {
    // A perfectly normal submitted count awaiting a decision. Aged past the
    // activity threshold so the verdict is about approvability, not recency.
    const created = await create();
    await countAndSubmit(created, 19000);
    await age(created.body._id);

    const res = await recover();
    assert.equal(res.body.eligible, 0);
    assert.equal(res.body.skipped.length, 1);
    assert.match(res.body.skipped[0].detail, /pending decision|Approvable by/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Applying the recovery
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — applying recovery', () => {
  it('releases the lock, closes the session as stale and frees the branch', async () => {
    const {created} = await wedgedByMissingIngredient();

    const res = await recover({apply: true, reason: 'Ingredient deleted in error; unblocking the branch'});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.dryRun, false);
    assert.equal(res.body.recovered, 1);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'stale');
    assert.equal(stored.activeKey, undefined, 'the branch lock is released');
    assert.equal(stored.approvedBy, undefined, 'recovery must never approve');

    // The branch can count again.
    assert.equal((await create()).status, 201);
  });

  it('clears an orphan lock without altering the decision that was made', async () => {
    const created = await wedgedByOrphanLock();
    const before = await StockCount.findById(created.body._id);

    const res = await recover({apply: true, reason: 'Clearing an orphan branch lock from legacy data'});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recovered, 1);
    assert.equal(res.body.actions[0].reason, RECOVERY_REASONS.ORPHAN_LOCK);

    const after = await StockCount.findById(created.body._id);
    assert.equal(after.status, 'approved', 'an approved count stays approved');
    assert.equal(String(after.approvedBy), String(before.approvedBy));
    assert.equal(after.activeKey, undefined);
    assert.equal((await create()).status, 201);
  });

  it('recovers a count nobody is permitted to approve', async () => {
    // Manager creates and submits; separation of duties blocks self-approval.
    const created = await create({}, manager());
    await countAndSubmit(created, 19000, manager());
    // Remove every owner, so no one else can decide it either.
    await User.deleteOne({_id: world.owner._id});
    await age(created.body._id);

    const result = await recoverLockedSessions({
      restaurantId: RID(), apply: true, reason: 'No eligible approver remains for this branch'
    });
    assert.equal(result.recovered, 1);
    assert.equal(result.actions[0].reason, RECOVERY_REASONS.NO_ELIGIBLE_APPROVER);
    assert.equal((await StockCount.findById(created.body._id)).status, 'stale');
  });

  it('requires a substantive reason before it will write', async () => {
    await wedgedByMissingIngredient();
    const res = await recover({apply: true, reason: 'fix'});
    assert.equal(res.status, 400);
    assert.match(res.body.message, /reason/i);
    assert.equal(await Audit.countDocuments({action: 'stock_count_lock_recovered'}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Never releases an active session
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — active sessions are never released', () => {
  it('refuses a submitted session that was touched recently', async () => {
    // Genuinely wedged, but only just submitted: a manager may be reviewing it.
    const doomed = await Ingredient.create({
      restaurant: world.restaurant._id, code: 'ING-NEW', name: 'Fresh Wedge', unit: 'g'
    });
    const created = await create({scope: 'cycle', ingredientIds: [String(doomed._id)]});
    await countAndSubmit(created, 5);
    await Ingredient.deleteOne({_id: doomed._id});
    // Deliberately NOT aged.

    const res = await recover({apply: true, reason: 'Attempting to sweep a live session'});
    assert.equal(res.body.recovered, 0);
    assert.equal(res.body.eligible, 0);
    assert.match(res.body.skipped[0].detail, /threshold|actively in review/i);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'submitted', 'a live review must survive recovery');
    assert.ok(stored.activeKey);
  });

  it('never touches a draft or counting sheet', async () => {
    const draft = await create();
    await request(`/api/stock-counts/${draft.body._id}`, {
      method: 'PATCH', token: staff(),
      body: {
        expectedVersion: draft.body.__v,
        lines: [{lineId: String(draft.body.lines[0]._id), physicalQty: 19000}]
      }
    });
    assert.equal((await StockCount.findById(draft.body._id)).status, 'counting');
    await age(draft.body._id);

    const res = await recover({apply: true, reason: 'Should not take a counting sheet'});
    assert.equal(res.body.recovered, 0);
    assert.match(res.body.skipped[0].detail, /Only submitted sessions/i);
    assert.equal((await StockCount.findById(draft.body._id)).status, 'counting');
  });

  it('never touches an approvable submitted count, however old', async () => {
    const created = await create();
    await countAndSubmit(created, 19000);
    await age(created.body._id, 60 * 24 * 365);

    const res = await recover({apply: true, reason: 'Old but perfectly decidable'});
    assert.equal(res.body.recovered, 0, 'age alone is not a reason to close a count');
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');
  });

  it('honours a custom age threshold', async () => {
    const {created} = await wedgedByMissingIngredient();
    const strict = await recover({apply: true, minAgeMinutes: 60 * 24 * 400, reason: 'Very strict threshold'});
    assert.equal(strict.body.recovered, 0);
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');

    const relaxed = await recover({apply: true, minAgeMinutes: 1, reason: 'Relaxed threshold after review'});
    assert.equal(relaxed.body.recovered, 1);
  });

  it('re-checks eligibility at write time, not just at scan time', async () => {
    // A session that qualified during the scan but stopped qualifying before
    // the write must not be clobbered. The count KEEPS its lock here, so the
    // cheap "already resolved" guard cannot answer: only a genuine re-diagnosis
    // catches it. Proven by restoring the deleted ingredient mid-flight, which
    // makes the session approvable again.
    const {created, ingredientId} = await wedgedByMissingIngredient();

    const scan = await recover();
    assert.equal(scan.body.eligible, 1, 'it qualifies at scan time');

    // The operator undeletes the ingredient before running with --apply.
    await Ingredient.create({
      _id: ingredientId, restaurant: world.restaurant._id,
      code: 'ING-DOOM', name: 'Discontinued Spice', unit: 'g'
    });

    const res = await recover({apply: true, reason: 'Racing against a concurrent repair'});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.recovered, 0, 'it no longer qualifies, so it must not be closed');
    assert.equal(res.body.eligible, 0);
    assert.match(res.body.skipped[0].detail, /Approvable by/);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'submitted', 'the approvable session survives');
    assert.ok(stored.activeKey, 'and keeps its lock');
    assert.equal(await Audit.countDocuments({action: 'stock_count_lock_recovered'}), 0);
  });

  it('skips a session already resolved between scan and write', async () => {
    const {created} = await wedgedByMissingIngredient();
    await StockCount.collection.updateOne(
      {_id: new mongoose.Types.ObjectId(String(created.body._id))},
      {$unset: {activeKey: 1}, $set: {status: 'rejected'}}
    );
    const res = await recover({apply: true, reason: 'Racing against a concurrent decision'});
    assert.equal(res.body.recovered, 0);
    assert.equal((await StockCount.findById(created.body._id)).status, 'rejected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Idempotency
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — idempotency', () => {
  it('a second run changes nothing further', async () => {
    const {created} = await wedgedByMissingIngredient();

    const first = await recover({apply: true, reason: 'First recovery pass over the branch'});
    assert.equal(first.body.recovered, 1);
    const afterFirst = await StockCount.findById(created.body._id);

    const second = await recover({apply: true, reason: 'Second recovery pass over the branch'});
    assert.equal(second.body.recovered, 0, 'a re-run must be a no-op');
    assert.equal(second.body.scanned, 0, 'nothing is locked any more');

    const afterSecond = await StockCount.findById(created.body._id);
    assert.equal(afterSecond.status, afterFirst.status);
    assert.deepEqual(afterSecond.staleAt, afterFirst.staleAt, 'the recovery stamp is not rewritten');
    assert.equal(
      await Audit.countDocuments({action: 'stock_count_lock_recovered'}), 1,
      'one recovery, one audit row'
    );
  });

  it('three dry runs in a row report the same thing', async () => {
    await wedgedByMissingIngredient();
    const a = await recover();
    const b = await recover();
    const c = await recover();
    assert.equal(a.body.eligible, 1);
    assert.equal(b.body.eligible, 1);
    assert.equal(c.body.eligible, 1);
    assert.equal(await StockCount.countDocuments({status: 'stale'}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Inventory and ledger are untouched
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — recovery never moves stock', () => {
  it('leaves every balance and ledger row exactly as it found them', async () => {
    const {created} = await wedgedByMissingIngredient();

    const balancesBefore = await InventoryBalance.find({}).sort({_id: 1}).lean();
    const ledgerBefore = await InventoryTransaction.find({}).sort({_id: 1}).lean();

    const res = await recover({apply: true, reason: 'Unblocking the branch after a deleted ingredient'});
    assert.equal(res.body.recovered, 1);

    const balancesAfter = await InventoryBalance.find({}).sort({_id: 1}).lean();
    const ledgerAfter = await InventoryTransaction.find({}).sort({_id: 1}).lean();

    assert.equal(balancesAfter.length, balancesBefore.length);
    assert.equal(ledgerAfter.length, ledgerBefore.length, 'recovery must post no ledger movement');
    for (let i = 0; i < balancesBefore.length; i += 1) {
      assert.equal(balancesAfter[i].quantity, balancesBefore[i].quantity);
      assert.equal(balancesAfter[i].ledgerVersion, balancesBefore[i].ledgerVersion);
    }
    assert.equal(await InventoryTransaction.countDocuments({referenceType: 'stock_count'}), 0);
  });

  it('preserves the captured physical quantities on the recovered sheet', async () => {
    const doomed = await Ingredient.create({
      restaurant: world.restaurant._id, code: 'ING-KEEP', name: 'Kept Figures', unit: 'g'
    });
    const created = await create({scope: 'cycle', ingredientIds: [String(doomed._id)]});
    await countAndSubmit(created, 77);
    await Ingredient.deleteOne({_id: doomed._id});
    await age(created.body._id);

    await recover({apply: true, reason: 'Recovering while keeping the counted figures'});

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.lines[0].physicalQty, 77, 'the counted figure is evidence and must survive');
    assert.equal(stored.lines[0].systemQty, 0);
    assert.equal(stored.lines[0].varianceQty, 77);
    assert.ok(stored.lines[0].countedBy, 'who counted it is still recorded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Audit
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — audit trail', () => {
  it('preserves the whole prior history and appends the recovery', async () => {
    const {created} = await wedgedByMissingIngredient();
    const before = await Audit.find({entity: 'stock_count', entityId: created.body._id})
      .sort({at: 1}).lean();
    assert.ok(before.length >= 3, 'created, updated and submitted are already recorded');

    await recover({apply: true, reason: 'Deleted ingredient left this session undecidable'});

    const after = await Audit.find({entity: 'stock_count', entityId: created.body._id})
      .sort({at: 1}).lean();
    assert.equal(after.length, before.length + 1, 'exactly one row is appended');
    for (let i = 0; i < before.length; i += 1) {
      assert.equal(String(after[i]._id), String(before[i]._id), 'no prior row was replaced');
      assert.equal(after[i].action, before[i].action);
      assert.deepEqual(after[i].after, before[i].after, 'no prior row was rewritten');
    }

    const row = after.at(-1);
    assert.equal(row.action, 'stock_count_lock_recovered');
    assert.equal(row.reason, 'Deleted ingredient left this session undecidable');
    assert.equal(String(row.user), String(world.owner._id), 'who ran the recovery');
    assert.equal(row.before.status, 'submitted');
    assert.ok(row.before.activeKey, 'the lock that was held is recorded');
    assert.equal(row.after.status, 'stale');
    assert.equal(row.after.activeKey, null);
    assert.equal(row.after.recoveryReason, RECOVERY_REASONS.MISSING_INGREDIENT);
    assert.ok(row.at);
  });

  it('shows the recovery in the count history endpoint', async () => {
    const {created} = await wedgedByMissingIngredient();
    await recover({apply: true, reason: 'Recovered so the branch can count again'});

    const res = await request(`/api/stock-counts/${created.body._id}/history`, {token: owner()});
    assert.equal(res.status, 200);
    const entry = res.body.find(row => row.action === 'stock_count_lock_recovered');
    assert.ok(entry, 'the recovery must be visible to an auditor');
    assert.equal(entry.actor.name, 'Owner');
  });

  it('writes no audit row for a dry run', async () => {
    await wedgedByMissingIngredient();
    await recover();
    assert.equal(await Audit.countDocuments({action: 'stock_count_lock_recovered'}), 0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Authorization
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — authorization', () => {
  it('is owner only', async () => {
    const {created} = await wedgedByMissingIngredient();

    for (const [label, token] of [['manager', manager()], ['staff', staff()]]) {
      const res = await recover({apply: true, reason: `Attempted by ${label} without authority`}, token);
      assert.equal(res.status, 403, `${label} must not run recovery`);
    }
    assert.equal((await StockCount.findById(created.body._id)).status, 'submitted');
    assert.equal(await Audit.countDocuments({action: 'stock_count_lock_recovered'}), 0);
  });

  it('refuses anonymous and forged tokens', async () => {
    await wedgedByMissingIngredient();
    assert.equal((await request('/api/stock-counts/recover-locks', {method: 'POST', body: {}})).status, 401);
    assert.equal((await recover({}, 'not.a.jwt')).status, 401);
  });

  it('rejects unknown fields in the request', async () => {
    const res = await recover({apply: true, reason: 'Strict schema check here', restaurant: String(rival.restaurant._id)});
    assert.equal(res.status, 400, 'an attacker must not be able to retarget the run');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tenant and branch isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — tenant and branch isolation', () => {
  it('never sees or recovers another restaurant session', async () => {
    const {created} = await wedgedByMissingIngredient();

    // The rival owner runs recovery on their own restaurant.
    const res = await recover({apply: true, reason: 'Rival sweeping their own tenant'}, tokenFor(rival.owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.scanned, 0, 'our locked session is invisible to another tenant');
    assert.equal(res.body.recovered, 0);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.status, 'submitted', 'untouched by the other tenant');
    assert.ok(stored.activeKey);
  });

  it('refuses a branch id belonging to another restaurant', async () => {
    await wedgedByMissingIngredient();
    const res = await recover({
      apply: true, branch: String(rival.branch._id), reason: 'Aiming at another tenant branch'
    });
    assert.equal(res.status, 404);
  });

  it('scopes a run to one branch', async () => {
    // Wedge branch A.
    const {created: wedgedA} = await wedgedByMissingIngredient();
    // And an independent live session in branch B.
    const bDoomed = await Ingredient.create({
      restaurant: world.restaurant._id, code: 'ING-B', name: 'Branch B Spice', unit: 'g'
    });
    const createdB = await request('/api/stock-counts', {
      method: 'POST', token: owner(), headers: {'Idempotency-Key': KEY()},
      body: {branch: String(world.branchB._id), scope: 'cycle', ingredientIds: [String(bDoomed._id)], notes: 'B'}
    });
    assert.equal(createdB.status, 201, JSON.stringify(createdB.body));
    await countAndSubmit(createdB, 9, owner());
    await Ingredient.deleteOne({_id: bDoomed._id});
    await age(createdB.body._id);

    const res = await recover({apply: true, branch: BRANCH(), reason: 'Recovering branch A only'});
    assert.equal(res.body.recovered, 1);

    assert.equal((await StockCount.findById(wedgedA.body._id)).status, 'stale');
    assert.equal((await StockCount.findById(createdB.body._id)).status, 'submitted',
      'a branch-scoped run must not reach another branch');
  });

  it('scan is restaurant-scoped at the service level', async () => {
    await wedgedByMissingIngredient();
    const ours = await scanLockedSessions({restaurantId: RID()});
    const theirs = await scanLockedSessions({restaurantId: rival.restaurant._id});
    assert.equal(ours.length, 1);
    assert.equal(theirs.length, 0);
    await assert.rejects(scanLockedSessions({}), /restaurant is required/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Diagnosis unit behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe('15 — diagnosis', () => {
  it('reports a clear verdict for each session shape', async () => {
    const {created} = await wedgedByMissingIngredient();
    const wedged = await StockCount.findById(created.body._id);
    const verdict = await diagnoseSession(wedged, {minAgeMinutes: DEFAULT_MIN_AGE_MINUTES});
    assert.equal(verdict.qualifies, true);
    assert.equal(verdict.reason, RECOVERY_REASONS.MISSING_INGREDIENT);
    assert.equal(verdict.missingIngredients.length, 1);
    assert.ok(verdict.ageMinutes >= DEFAULT_MIN_AGE_MINUTES);
  });

  it('does not flag a terminal count that holds no lock', async () => {
    // A normally-approved count is finished and blocking nothing. It must not
    // appear in a recovery scan at all, or every historical count in the
    // restaurant would look like something to act on.
    const created = await create();
    const submitted = await countAndSubmit(created, 20000);
    assert.equal((await request(`/api/stock-counts/${created.body._id}/approve`, {
      method: 'POST', token: manager(), headers: {'Idempotency-Key': KEY()},
      body: {expectedVersion: submitted.body.__v, note: 'Clean count'}
    })).status, 200);

    const stored = await StockCount.findById(created.body._id);
    assert.equal(stored.activeKey, undefined);
    const verdict = await diagnoseSession(stored, {minAgeMinutes: DEFAULT_MIN_AGE_MINUTES});
    assert.equal(verdict.qualifies, false);
    assert.match(verdict.detail, /holding no lock/i);

    assert.equal((await scanLockedSessions({restaurantId: RID()})).length, 0);
    assert.equal((await recover()).body.scanned, 0);
  });

  it('defaults to a conservative twelve-hour threshold', () => {
    assert.equal(DEFAULT_MIN_AGE_MINUTES, 720);
  });
});
