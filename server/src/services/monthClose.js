import mongoose from 'mongoose';
import {Audit, MonthlySnapshot} from '../models/index.js';
import {Branch, InventoryBalance, InventoryTransaction, Order, PurchaseOrder, SupplierInvoice} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {buildPnl} from './pnl.js';
import {money} from './statements.js';
import {ensureMonthCloseIndexes} from './monthCloseMigration.js';

const NEPAL_OFFSET_MINUTES = 5 * 60 + 45;
const OPEN_ORDER_STATUSES = ['draft', 'held', 'pending', 'confirmed', 'accepted', 'preparing', 'ready', 'out_for_delivery'];
const OPEN_PO_STATUSES = ['draft', 'pending', 'approved', 'sent', 'partially_received'];

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function monthRange(month) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(month || ''));
  if (!match) throw httpError('Month must use YYYY-MM', 400);
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const offset = NEPAL_OFFSET_MINUTES * 60 * 1000;
  const from = new Date(Date.UTC(year, monthIndex, 1) - offset);
  const toExclusive = new Date(Date.UTC(year, monthIndex + 1, 1) - offset);
  return {month: match[0], from, toExclusive, to: new Date(toExclusive.getTime() - 1)};
}

function currentMonth(now = new Date()) {
  const local = new Date(now.getTime() + NEPAL_OFFSET_MINUTES * 60 * 1000);
  return `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function resolveScope(user, branchId) {
  let branch = branchId ? String(branchId) : null;
  if (user?.role !== 'owner') {
    if (!user?.branch) throw httpError('An assigned branch is required', 403);
    branch = branch || String(user.branch);
    assertBranchAccess(user, branch);
  }
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
    if (!await Branch.exists({_id: branch})) throw httpError('Branch not found', 404);
  }
  return {branch, scopeKey: branch || 'all'};
}

/**
 * Replays the append-only ledger up to a point in time. Positive movements
 * carry their acquisition cost; negative movements retain weighted average.
 */
export async function inventoryValueAt({at, branchId}) {
  const match = {createdAt: {$lt: new Date(at)}};
  if (branchId) match.branch = new mongoose.Types.ObjectId(branchId);
  const transactions = await InventoryTransaction.find(match)
    .sort({createdAt: 1, _id: 1})
    .select('branch ingredient type previousQty changeQty newQty unitCost createdAt')
    .lean();
  const states = new Map();
  let ledgerGaps = 0;

  for (const tx of transactions) {
    const key = `${tx.branch}:${tx.ingredient}`;
    let state = states.get(key);
    const previousQty = Number(tx.previousQty || 0);
    const changeQty = Number(tx.changeQty || 0);
    const newQty = Number(tx.newQty ?? previousQty + changeQty);
    const unitCost = Number(tx.unitCost || 0);

    if (!state) {
      if (previousQty !== 0) ledgerGaps += 1;
      state = {quantity: previousQty, averageCost: unitCost};
    }

    const beforeQty = Number(state.quantity || 0);
    let averageCost = Number(state.averageCost || unitCost || 0);
    if (changeQty > 0 && newQty > 0) {
      averageCost = beforeQty > 0
        ? ((beforeQty * averageCost) + (changeQty * unitCost)) / newQty
        : unitCost;
    }
    state.quantity = newQty;
    state.averageCost = averageCost;
    states.set(key, state);
  }

  let value = 0;
  let quantity = 0;
  let negativeItems = 0;
  for (const state of states.values()) {
    quantity += Number(state.quantity || 0);
    value += Number(state.quantity || 0) * Number(state.averageCost || 0);
    if (Number(state.quantity || 0) < 0) negativeItems += 1;
  }
  return {value: money(value), quantity, items: states.size, negativeItems, ledgerGaps};
}

async function countUntrackedBalances({branchId, toExclusive}) {
  const balanceMatch = {quantity: {$ne: 0}, ...(branchId ? {branch: branchId} : {})};
  const balances = await InventoryBalance.find(balanceMatch).select('branch ingredient').lean();
  if (!balances.length) return 0;
  const txMatch = {
    createdAt: {$lt: toExclusive},
    ...(branchId ? {branch: branchId} : {}),
    $or: balances.map(b => ({branch: b.branch, ingredient: b.ingredient}))
  };
  const tracked = await InventoryTransaction.find(txMatch).select('branch ingredient').lean();
  const trackedKeys = new Set(tracked.map(t => `${t.branch}:${t.ingredient}`));
  return balances.filter(b => !trackedKeys.has(`${b.branch}:${b.ingredient}`)).length;
}

export async function previewMonthClose({month, branchId, user, now = new Date()}) {
  const range = monthRange(month);
  if (range.month > currentMonth(now)) throw httpError('Future months cannot be reconciled', 400);
  const scope = await resolveScope(user, branchId);
  const branchMatch = scope.branch ? {branch: scope.branch} : {};
  const beforePeriodEnd = {createdAt: {$lt: range.toExclusive}};

  const [pnl, opening, closing, openOrders, openPurchaseOrders, unpaidInvoices, untrackedBalances, activeSnapshot] = await Promise.all([
    buildPnl({
      branchId: scope.branch,
      user,
      from: range.from,
      toExclusive: range.toExclusive
    }),
    inventoryValueAt({at: range.from, branchId: scope.branch}),
    inventoryValueAt({at: range.toExclusive, branchId: scope.branch}),
    Order.countDocuments({...branchMatch, ...beforePeriodEnd, status: {$in: OPEN_ORDER_STATUSES}}),
    PurchaseOrder.countDocuments({...branchMatch, ...beforePeriodEnd, status: {$in: OPEN_PO_STATUSES}}),
    SupplierInvoice.countDocuments({...branchMatch, ...beforePeriodEnd, status: {$in: ['unpaid', 'partial']}}),
    countUntrackedBalances({branchId: scope.branch, toExclusive: range.toExclusive}),
    MonthlySnapshot.findOne({scopeKey: scope.scopeKey, month: range.month, status: 'closed'}).select('_id revision closedAt')
  ]);

  const blockers = [];
  const warnings = [];
  if (openOrders) blockers.push(`${openOrders} open order${openOrders === 1 ? '' : 's'} must be completed or cancelled`);
  if (closing.negativeItems) blockers.push(`${closing.negativeItems} inventory item${closing.negativeItems === 1 ? '' : 's'} have negative stock`);
  if (openPurchaseOrders) warnings.push(`${openPurchaseOrders} purchase order${openPurchaseOrders === 1 ? '' : 's'} remain open`);
  if (unpaidInvoices) warnings.push(`${unpaidInvoices} supplier invoice${unpaidInvoices === 1 ? '' : 's'} remain unpaid or partial`);
  if (untrackedBalances) warnings.push(`${untrackedBalances} non-zero balance${untrackedBalances === 1 ? '' : 's'} have no ledger history before month end`);
  if (opening.ledgerGaps || closing.ledgerGaps) warnings.push('The ledger contains movements whose opening quantity was not recorded');
  if (activeSnapshot) blockers.push(`Revision ${activeSnapshot.revision} is already closed`);

  return {
    source: 'live',
    timezone: 'Asia/Kathmandu',
    currency: 'NPR',
    month: range.month,
    branch: scope.branch,
    scopeKey: scope.scopeKey,
    period: {from: range.from, to: range.to},
    closable: range.toExclusive <= now,
    ready: blockers.length === 0 && range.toExclusive <= now,
    blockers,
    warnings,
    reconciliation: {
      openOrders,
      openPurchaseOrders,
      unpaidInvoices,
      untrackedBalances,
      ledgerGaps: Math.max(opening.ledgerGaps, closing.ledgerGaps)
    },
    inventory: {opening, closing},
    pnl,
    activeSnapshot: activeSnapshot || null
  };
}

function snapshotResponse(query) {
  return query.populate('branch', 'name code').populate('closedBy reopenedBy', 'name role');
}

export async function listMonthCloses({branchId, user, limit = 60}) {
  const scope = await resolveScope(user, branchId);
  const match = user?.role === 'owner' && !branchId ? {} : {scopeKey: scope.scopeKey};
  return snapshotResponse(MonthlySnapshot.find(match)
    .sort({month: -1, revision: -1})
    .limit(Math.min(Math.max(Number(limit) || 60, 1), 120)));
}

export async function closeMonth({month, branchId, notes, user}) {
  if (user?.role !== 'owner') throw httpError('Only the owner can close a month', 403);
  const preview = await previewMonthClose({month, branchId, user});
  if (!preview.closable) throw httpError('The current month cannot be closed before it ends in Nepal time', 409);
  if (preview.blockers.length) throw httpError(preview.blockers.join('; '), 409);

  await ensureMonthCloseIndexes();
  const latest = await MonthlySnapshot.findOne({scopeKey: preview.scopeKey, month: preview.month}).sort({revision: -1});
  const revision = Number(latest?.revision || 0) + 1;
  const pnl = preview.pnl;
  let saved;
  try {
    saved = await MonthlySnapshot.create({
      month: preview.month,
      branch: preview.branch,
      scopeKey: preview.scopeKey,
      revision,
      status: 'closed',
      currency: pnl.currency,
      vatRate: pnl.vatRate,
      periodFrom: preview.period.from,
      periodTo: preview.period.to,
      revenue: pnl.revenue,
      cogs: pnl.cogs,
      grossProfit: pnl.grossProfit,
      purchases: pnl.purchases,
      waste: pnl.waste,
      expenses: pnl.expenses,
      netProfit: pnl.netProfit,
      netMargin: pnl.revenue ? money((pnl.netProfit / pnl.revenue) * 100) : 0,
      openingInventory: preview.inventory.opening.value,
      closingInventory: preview.inventory.closing.value,
      sales: pnl.sales,
      purchasing: pnl.purchasing,
      expenseDetail: pnl.expenseDetail,
      wasteDetail: pnl.wasteDetail,
      reconciliation: {...preview.reconciliation, warnings: preview.warnings},
      notes: String(notes || '').trim(),
      closedAt: new Date(),
      closedBy: user.id
    });
  } catch (e) {
    if (e?.code === 11000) throw httpError('This month was closed by another request', 409);
    throw e;
  }
  await Audit.create({
    entity: 'monthly_snapshot',
    entityId: saved._id,
    action: 'close',
    after: {month: saved.month, branch: saved.branch, revision: saved.revision, revenue: saved.revenue, netProfit: saved.netProfit},
    user: user.id
  });
  return snapshotResponse(MonthlySnapshot.findById(saved._id));
}

export async function reopenMonth({snapshotId, reason, user}) {
  if (user?.role !== 'owner') throw httpError('Only the owner can reopen a month', 403);
  if (!mongoose.isValidObjectId(snapshotId)) throw httpError('Invalid monthly snapshot', 400);
  const explanation = String(reason || '').trim();
  if (explanation.length < 3) throw httpError('A reopen reason is required', 400);
  const snapshot = await MonthlySnapshot.findById(snapshotId);
  if (!snapshot) throw httpError('Monthly snapshot not found', 404);
  if (snapshot.status !== 'closed') throw httpError('This monthly snapshot is already reopened', 409);

  snapshot.status = 'reopened';
  snapshot.reopenedAt = new Date();
  snapshot.reopenedBy = user.id;
  snapshot.reopenReason = explanation;
  await snapshot.save();
  await Audit.create({
    entity: 'monthly_snapshot',
    entityId: snapshot._id,
    action: 'reopen',
    before: {status: 'closed'},
    after: {status: 'reopened', reason: explanation, revision: snapshot.revision},
    user: user.id
  });
  return snapshotResponse(MonthlySnapshot.findById(snapshot._id));
}
