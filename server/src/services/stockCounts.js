import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Audit, Ingredient} from '../models/index.js';
import {InventoryBalance, StockCount} from '../models/operations.js';
import {moveStock} from './inventoryLedger.js';
import {kathmanduDateString} from './inventoryBatches.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';

const EPSILON = 1e-9;
const COUNT_STATUSES = ['draft', 'counting', 'submitted', 'approved', 'rejected', 'stale'];
// Sessions that hold the branch lock and can still be edited by the counter.
const EDITABLE_STATUSES = ['draft', 'counting'];
const COUNT_SCOPES = ['full', 'cycle'];
const clean = value => String(value ?? '').trim();
const actorId = value => String(value?._id || value || '');

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

function requireTransaction(session) {
  if (!session?.inTransaction?.()) throw httpError('Stock count writes require an active MongoDB transaction', 500);
}

function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
    const normalized = canonical(value[key]);
    return normalized === undefined ? [] : [[key, normalized]];
  }));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function normalizedRequest({branchId, scope, ingredientIds, notes, recountOf}) {
  const normalizedScope = clean(scope);
  if (!COUNT_SCOPES.includes(normalizedScope)) throw httpError('Stock count scope must be full or cycle', 400);
  const ids = normalizedScope === 'cycle'
    ? [...new Set((ingredientIds || []).map(String))].sort()
    : [];
  if (normalizedScope === 'cycle' && !ids.length) throw httpError('A cycle count requires at least one ingredient', 400);
  if (ids.length > 500) throw httpError('A cycle count cannot contain more than 500 ingredients', 400);
  if (ids.some(id => !mongoose.isValidObjectId(id))) throw httpError('Invalid stock count ingredient', 400);
  return {
    branchId: String(branchId || ''),
    scope: normalizedScope,
    ingredientIds: ids,
    notes: clean(notes),
    recountOf: recountOf ? String(recountOf) : ''
  };
}

function requestEvidence(input) {
  return fingerprint({version: 1, ...normalizedRequest(input)});
}

function decisionEvidence({countId, decision, note}) {
  return fingerprint({version: 1, countId: String(countId), decision, note: clean(note)});
}

function countNumber(branch, id) {
  const code = clean(branch.code).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    || String(branch._id).slice(-4).toUpperCase();
  return `SC-${code}-${kathmanduDateString().replaceAll('-', '')}-${String(id).slice(-6).toUpperCase()}`;
}

function auditView(count, extra = {}) {
  return {
    countNo: count.countNo,
    scope: count.scope,
    status: count.status,
    lineCount: count.lines?.length || 0,
    countedLineCount: Number(count.countedLineCount || 0),
    varianceLineCount: Number(count.varianceLineCount || 0),
    totalVarianceValue: Number(count.totalVarianceValue || 0),
    version: Number(count.__v || 0),
    ...extra
  };
}

const COUNT_POPULATE = [
  {path: 'branch', select: 'name code active'},
  {path: 'lines.ingredient', select: 'name code category unit active'},
  {path: 'lines.countedBy', select: 'name role'},
  {path: 'createdBy', select: 'name role'},
  {path: 'submittedBy', select: 'name role'},
  {path: 'approvedBy', select: 'name role'},
  {path: 'rejectedBy', select: 'name role'},
  {path: 'staleDetectedBy', select: 'name role'},
  {path: 'recountOf', select: 'countNo status staleAt'},
  {path: 'adjustmentTransactions', select: 'type ingredient previousQty changeQty newQty unit unitCost totalCost reason referenceType referenceId user idempotencyKey createdAt'}
];

function populateCount(query) {
  for (const option of COUNT_POPULATE) query.populate(option);
  return query;
}

async function populatedCountById(id, session) {
  return populateCount(StockCount.findById(id).session(session || null));
}

async function scopedCount({countId, user, session, secrets = false}) {
  if (!mongoose.isValidObjectId(countId)) throw httpError('Invalid stock count', 400);
  const identity = await userRestaurantContext(user, {session});
  let query = StockCount.findOne({_id: countId, restaurant: identity.restaurantId});
  if (secrets) query = query.select('+requestKey +requestHash +decisionKey +decisionHash');
  const count = await query.session(session || null);
  if (!count) throw httpError('Stock count not found', 404);
  const context = await purchaseBranchContext({user, branchId: count.branch, session, allowInactive: true});
  return {count, context};
}

function assertExpectedVersion(count, expectedVersion) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw httpError('A nonnegative integer expectedVersion is required', 400);
  }
  if (Number(count.__v) !== expectedVersion) throw httpError('Stock count changed; refresh before continuing', 409);
}

function assertCounter(count, context) {
  if (context.role === 'owner') return;
  if (actorId(count.createdBy) !== actorId(context.userId)) {
    throw httpError('Only the stock count creator or an owner can edit or submit this count', 403);
  }
}

async function createAudit({count, action, before, after, reason, userId, session}) {
  await Audit.create([{
    entity: 'stock_count',
    entityId: count._id,
    restaurant: count.restaurant,
    branch: count.branch,
    action,
    before,
    after,
    reason: clean(reason),
    user: userId
  }], {session});
}

export async function createStockCount({branchId, scope, ingredientIds = [], notes, recountOf, user, idempotencyKey, session}) {
  requireTransaction(session);
  const key = clean(idempotencyKey);
  if (key.length < 3 || key.length > 200) throw httpError('A valid Idempotency-Key is required', 400);
  const normalized = normalizedRequest({branchId, scope, ingredientIds, notes, recountOf});
  const hash = requestEvidence(normalized);
  const context = await purchaseBranchContext({user, branchId: normalized.branchId, session});
  const prior = await StockCount.findOne({
    restaurant: context.restaurantId,
    branch: context.branch._id,
    requestKey: key
  }).select('+requestKey +requestHash').session(session);
  if (prior) {
    if (prior.requestHash !== hash) throw httpError('Idempotency key was already used for a different stock count', 409);
    return populatedCountById(prior._id, session);
  }

  const active = await StockCount.exists({restaurant: context.restaurantId, activeKey: String(context.branch._id)}).session(session);
  if (active) throw httpError('This branch already has an active stock count', 409);

  const ingredientMatch = {restaurant: context.restaurantId, active: {$ne: false}};
  if (normalized.scope === 'cycle') ingredientMatch._id = {$in: normalized.ingredientIds};
  const ingredients = await Ingredient.find(ingredientMatch).sort({name: 1, _id: 1}).session(session).lean();
  if (!ingredients.length) throw httpError('No active ingredients are available for this stock count', 409);
  if (normalized.scope === 'cycle' && ingredients.length !== normalized.ingredientIds.length) {
    throw httpError('One or more cycle-count ingredients are unavailable', 404);
  }
  if (ingredients.length > 1000) throw httpError('A stock count cannot contain more than 1000 ingredients', 409);

  const balances = await InventoryBalance.find({
    branch: context.branch._id,
    ingredient: {$in: ingredients.map(item => item._id)}
  }).select('ingredient quantity averageCost ledgerVersion').session(session).lean();
  const balanceByIngredient = new Map(balances.map(balance => [String(balance.ingredient), balance]));
  // Phase 14: a recount must name the session it replaces, so a stale-out and
  // the count that supersedes it are traceable to each other rather than being
  // two unrelated sheets.
  let recountOfId = null;
  if (recountOf) {
    if (!mongoose.isValidObjectId(recountOf)) throw httpError('Invalid recount reference', 400);
    const prior = await StockCount.findOne({
      _id: recountOf, restaurant: context.restaurantId, branch: context.branch._id
    }).select('status').session(session).lean();
    if (!prior) throw httpError('The stock count being recounted was not found', 404);
    if (!['stale', 'rejected'].includes(prior.status)) {
      throw httpError('Only a stale or rejected stock count can be recounted', 409);
    }
    recountOfId = prior._id;
  }

  const id = new mongoose.Types.ObjectId();
  const count = new StockCount({
    _id: id,
    restaurant: context.restaurantId,
    branch: context.branch._id,
    countNo: countNumber(context.branch, id),
    scope: normalized.scope,
    status: 'draft',
    activeKey: String(context.branch._id),
    lines: ingredients.map(item => {
      const balance = balanceByIngredient.get(String(item._id));
      return {
        ingredient: item._id,
        ingredientName: item.name,
        ingredientCode: item.code || '',
        unit: item.unit || 'g',
        systemQty: Number(balance?.quantity || 0),
        systemUnitCost: Number(balance?.averageCost || 0),
        balanceVersion: Number(balance?.ledgerVersion || 0)
      };
    }),
    notes: normalized.notes,
    createdBy: context.userId,
    recountOf: recountOfId,
    requestKey: key,
    requestHash: hash
  });
  try {
    await count.save({session});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Stock count changed; refresh and try again', 409);
    if (error?.code === 11000 && error?.keyPattern?.activeKey) throw httpError('This branch already has an active stock count', 409);
    throw error;
  }
  await createAudit({
    count,
    action: 'stock_count_created',
    after: auditView(count),
    reason: normalized.notes,
    userId: context.userId,
    session
  });
  return populatedCountById(count._id, session);
}

export async function replayStockCountCreate({branchId, scope, ingredientIds = [], notes, user, idempotencyKey}) {
  const key = clean(idempotencyKey);
  const normalized = normalizedRequest({branchId, scope, ingredientIds, notes});
  const context = await purchaseBranchContext({user, branchId: normalized.branchId, allowInactive: true});
  const prior = await StockCount.findOne({restaurant: context.restaurantId, branch: context.branch._id, requestKey: key})
    .select('+requestKey +requestHash');
  if (!prior) throw httpError('This branch already has an active stock count', 409);
  if (prior.requestHash !== requestEvidence(normalized)) {
    throw httpError('Idempotency key was already used for a different stock count', 409);
  }
  return populatedCountById(prior._id);
}

export async function listStockCounts({branchId, status, scope, user, limit = 100}) {
  const context = await purchaseBranchContext({user, branchId, allowInactive: true});
  if (status && !COUNT_STATUSES.includes(status)) throw httpError('Invalid stock count status', 400);
  if (scope && !COUNT_SCOPES.includes(scope)) throw httpError('Invalid stock count scope', 400);
  const safeLimit = Math.min(250, Math.max(1, Number(limit) || 100));
  const match = {
    restaurant: context.restaurantId,
    branch: context.branch._id,
    ...(status ? {status} : {}),
    ...(scope ? {scope} : {})
  };
  const [items, statusRows] = await Promise.all([
    populateCount(StockCount.find(match).sort({createdAt: -1, _id: -1}).limit(safeLimit)),
    StockCount.aggregate([
      {$match: {restaurant: new mongoose.Types.ObjectId(String(context.restaurantId)), branch: new mongoose.Types.ObjectId(String(context.branch._id))}},
      {$group: {_id: '$status', count: {$sum: 1}}}
    ])
  ]);
  const statusCounts = Object.fromEntries(statusRows.map(row => [row._id, row.count]));
  return {
    items,
    summary: {
      total: Object.values(statusCounts).reduce((sum, count) => sum + Number(count || 0), 0),
      draft: Number(statusCounts.draft || 0),
      pending: Number(statusCounts.submitted || 0),
      approved: Number(statusCounts.approved || 0),
      rejected: Number(statusCounts.rejected || 0)
    }
  };
}

export async function getStockCount({countId, user}) {
  const {count} = await scopedCount({countId, user});
  return populatedCountById(count._id);
}

export async function updateStockCount({countId, lines = [], notes, expectedVersion, user, session}) {
  requireTransaction(session);
  const {count, context} = await scopedCount({countId, user, session});
  assertCounter(count, context);
  assertExpectedVersion(count, expectedVersion);
  if (!EDITABLE_STATUSES.includes(count.status)) throw httpError('Only draft or in-progress stock counts can be edited', 409);
  if (!lines.length && notes === undefined) throw httpError('No stock count changes were supplied', 400);

  const before = auditView(count);
  const lineById = new Map(count.lines.map(line => [String(line._id), line]));
  const seen = new Set();
  const changes = [];
  for (const patch of lines) {
    const id = String(patch.lineId || '');
    if (seen.has(id)) throw httpError('A stock count line can only be updated once per request', 400);
    seen.add(id);
    const line = lineById.get(id);
    if (!line) throw httpError('Stock count line not found', 404);
    const previousPhysicalQty = line.physicalQty == null ? null : Number(line.physicalQty);
    if (patch.physicalQty == null) {
      line.physicalQty = undefined;
      line.varianceQty = undefined;
      line.varianceValue = undefined;
      line.countedBy = undefined;
      line.countedAt = undefined;
    } else {
      const physicalQty = Number(patch.physicalQty);
      if (!Number.isFinite(physicalQty) || physicalQty < 0) throw httpError('Physical quantity must be a nonnegative finite number', 400);
      line.physicalQty = physicalQty;
      line.varianceQty = physicalQty - Number(line.systemQty);
      line.varianceValue = line.varianceQty * Number(line.systemUnitCost || 0);
      line.countedBy = context.userId;
      line.countedAt = new Date();
    }
    changes.push({
      lineId: line._id,
      ingredient: line.ingredient,
      ingredientName: line.ingredientName,
      previousPhysicalQty,
      physicalQty: line.physicalQty == null ? null : Number(line.physicalQty)
    });
  }
  if (notes !== undefined) count.notes = clean(notes);
  // The session moves to `counting` as soon as a real figure is entered, so a
  // sheet someone is part-way through is distinguishable from an untouched
  // draft. It never moves back on its own.
  if (count.status === 'draft' && count.lines.some(line => line.physicalQty != null)) {
    count.status = 'counting';
  }
  try {
    await count.save({session});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Stock count changed; refresh before saving', 409);
    throw error;
  }
  await createAudit({
    count,
    action: 'stock_count_updated',
    before,
    after: auditView(count, {changes}),
    reason: count.notes,
    userId: context.userId,
    session
  });
  return populatedCountById(count._id, session);
}

export async function submitStockCount({countId, note, expectedVersion, user, session}) {
  requireTransaction(session);
  const {count, context} = await scopedCount({countId, user, session});
  assertCounter(count, context);
  assertExpectedVersion(count, expectedVersion);
  if (!EDITABLE_STATUSES.includes(count.status)) throw httpError('Only draft or in-progress stock counts can be submitted', 409);
  const missing = count.lines.filter(line => line.physicalQty == null);
  if (missing.length) throw httpError(`Physical quantities are missing for ${missing.length} ingredient${missing.length === 1 ? '' : 's'}`, 409);

  const before = auditView(count);
  count.status = 'submitted';
  count.submittedBy = context.userId;
  count.submittedAt = new Date();
  count.submissionNote = clean(note);
  try {
    await count.save({session});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Stock count changed; refresh before submitting', 409);
    throw error;
  }
  await createAudit({
    count,
    action: 'stock_count_submitted',
    before,
    after: auditView(count),
    reason: count.submissionNote,
    userId: context.userId,
    session
  });
  return populatedCountById(count._id, session);
}

export async function decideStockCount({countId, decision, note, expectedVersion, user, idempotencyKey, session}) {
  requireTransaction(session);
  const key = clean(idempotencyKey);
  if (key.length < 3 || key.length > 200) throw httpError('A valid Idempotency-Key is required', 400);
  if (!['approved', 'rejected'].includes(decision)) throw httpError('Decision must be approved or rejected', 400);
  const decisionNote = clean(note);
  if (decision === 'rejected' && decisionNote.length < 3) throw httpError('A rejection reason is required', 400);
  const hash = decisionEvidence({countId, decision, note: decisionNote});
  const {count, context} = await scopedCount({countId, user, session, secrets: true});
  if (!['owner', 'manager'].includes(context.role)) throw httpError('Only owners and managers can decide stock counts', 403);

  if (count.decisionKey) {
    if (count.decisionKey === key && count.decisionHash === hash && count.status === decision) {
      return populatedCountById(count._id, session);
    }
    throw httpError('This stock count already has a different final decision', 409);
  }
  assertExpectedVersion(count, expectedVersion);
  if (count.status !== 'submitted') throw httpError('Only submitted stock counts can be approved or rejected', 409);
  if (decision === 'approved' && context.role === 'manager' && [count.createdBy, count.submittedBy].some(actor => actorId(actor) === actorId(context.userId))) {
    throw httpError('Managers cannot approve a stock count they created or submitted', 403);
  }

  const before = auditView(count);
  count.decisionKey = key;
  count.decisionHash = hash;
  count.decisionNote = decisionNote;
  count.activeKey = undefined;

  if (decision === 'rejected') {
    count.status = 'rejected';
    count.rejectedBy = context.userId;
    count.rejectedAt = new Date();
    try {
      await count.save({session});
    } catch (error) {
      if (error?.name === 'VersionError') throw httpError('Stock count changed; refresh before rejecting', 409);
      throw error;
    }
    await createAudit({
      count,
      action: 'stock_count_rejected',
      before,
      after: auditView(count),
      reason: decisionNote,
      userId: context.userId,
      session
    });
    return populatedCountById(count._id, session);
  }

  const balances = await InventoryBalance.find({
    branch: count.branch,
    ingredient: {$in: count.lines.map(line => line.ingredient)}
  }).select('ingredient quantity averageCost ledgerVersion').session(session).lean();
  const balanceByIngredient = new Map(balances.map(balance => [String(balance.ingredient), balance]));
  const stale = count.lines.filter(line => {
    const balance = balanceByIngredient.get(String(line.ingredient));
    const currentQty = Number(balance?.quantity || 0);
    const currentVersion = Number(balance?.ledgerVersion || 0);
    return Math.abs(currentQty - Number(line.systemQty)) > EPSILON || currentVersion !== Number(line.balanceVersion);
  });
  if (stale.length) {
    // Phase 14: previously this threw and left the session stuck in
    // `submitted` still holding the branch lock — the count could never be
    // approved, never be closed, and no new count could be started for the
    // branch. It is now closed as STALE, which releases the lock so a recount
    // can begin, and records exactly which ingredients moved.
    //
    // The captured figures are NEVER written to the ledger in this path: the
    // whole point is that valid movements made after capture must not be
    // overwritten by a snapshot that predates them.
    count.status = 'stale';
    count.staleAt = new Date();
    count.staleDetectedBy = context.userId;
    count.staleLines = stale.map(line => {
      const balance = balanceByIngredient.get(String(line.ingredient));
      return {
        ingredient: line.ingredient,
        ingredientName: line.ingredientName,
        capturedQty: Number(line.systemQty),
        currentQty: Number(balance?.quantity || 0)
      };
    });
    // A stale-out is not a human decision, so it must not consume the decision
    // key — the same key stays usable against the recount. `activeKey` was
    // already cleared above, and the schema refuses to persist a completed
    // count that still holds a branch lock, so the release is guaranteed at
    // two layers rather than by this assignment alone.
    count.decisionKey = undefined;
    count.decisionHash = undefined;
    try {
      await count.save({session});
    } catch (error) {
      if (error?.name === 'VersionError') throw httpError('Stock count changed; refresh before approval', 409);
      throw error;
    }
    await createAudit({
      count,
      action: 'stock_count_stale',
      before,
      after: auditView(count, {staleLines: count.staleLines}),
      reason: `Stock moved after capture for ${stale.map(line => line.ingredientName).slice(0, 5).join(', ')}`,
      userId: context.userId,
      session
    });
    // Returned rather than thrown: throwing would roll back the very
    // stale-out we just recorded, since the caller runs inside a transaction.
    // The route turns this into a 409.
    const names = stale.slice(0, 3).map(line => line.ingredientName).join(', ');
    const extra = stale.length > 3 ? ` and ${stale.length - 3} more` : '';
    return {
      stale: true,
      message: `Stock changed after this count was captured for ${names}${extra}; create a fresh count`,
      count: await populatedCountById(count._id, session)
    };
  }

  const transactions = [];
  for (const line of count.lines) {
    if (line.physicalQty == null) throw httpError('Every ingredient requires a physical quantity before approval', 409);
    const variance = Number(line.physicalQty) - Number(line.systemQty);
    if (Math.abs(variance) <= EPSILON) continue;
    transactions.push(await moveStock({
      branch: count.branch,
      ingredient: line.ingredient,
      qty: variance,
      unit: line.unit,
      unitCost: Number(line.systemUnitCost || 0),
      type: 'ADJUSTMENT',
      reason: `Physical inventory variance for ${count.countNo}${decisionNote ? ` — ${decisionNote}` : ''}`.slice(0, 500),
      referenceType: 'stock_count',
      referenceId: count._id,
      user: context.userId,
      idempotencyKey: `stock-count:${count._id}:${line._id}`,
      allowExpired: true,
      ...(variance > 0 ? {
        incomingBatches: [{
          quantity: variance,
          batchNumber: count.countNo,
          sourceType: 'adjustment',
          sourceId: count._id,
          sourceLine: line._id,
          unitCost: Number(line.systemUnitCost || 0)
        }]
      } : {})
    }, session));
  }

  count.status = 'approved';
  count.approvedBy = context.userId;
  count.approvedAt = new Date();
  count.adjustmentTransactions = transactions.map(transaction => transaction._id);
  try {
    await count.save({session});
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Stock count changed; refresh before approval', 409);
    throw error;
  }
  await createAudit({
    count,
    action: 'stock_count_approved',
    before,
    after: auditView(count, {adjustmentTransactions: count.adjustmentTransactions}),
    reason: decisionNote,
    userId: context.userId,
    session
  });
  return populatedCountById(count._id, session);
}

export async function getStockCountHistory({countId, user}) {
  const {count} = await scopedCount({countId, user});
  const rows = await Audit.find({
    entity: 'stock_count',
    entityId: count._id,
    restaurant: count.restaurant,
    branch: count.branch
  }).sort({at: 1, _id: 1}).populate('user', 'name role').lean();
  return rows.map(row => ({
    _id: row._id,
    action: row.action,
    status: row.after?.status || row.before?.status || '',
    previousStatus: row.before?.status || '',
    actor: row.user ? {_id: row.user._id, name: row.user.name, role: row.user.role} : null,
    at: row.at,
    reason: row.reason || '',
    before: row.before || null,
    after: row.after || null
  }));
}
