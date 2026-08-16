import mongoose from 'mongoose';
import {Audit, Expense, User} from '../models/index.js';
import {Branch} from '../models/operations.js';
import {vatOf} from './invoices.js';
import {money} from './statements.js';
import {purchaseBranchContext} from './purchaseOrders.js';
import {userRestaurantContext} from './supplierCatalog.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dateRange(from, to, toExclusive) {
  if (!from && !to && !toExclusive) return {};
  const date = {};
  if (from) date.$gte = new Date(from);
  if (toExclusive) date.$lt = new Date(toExclusive);
  else if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    date.$lte = end;
  }
  return {date};
}

export function expenseVat(amount, vat) {
  if (vat !== undefined && vat !== null && vat !== '') return money(vat);
  return vatOf(amount);
}

export function expenseQuery({branchId, branchIds = [], userIds = [], from, to, toExclusive} = {}) {
  const match = dateRange(from, to, toExclusive);
  const ownedBranches = branchId ? [branchId] : branchIds;
  match.$or = [
    {branch: {$in: ownedBranches}},
    {
      $and: [
        {$or: [{branch: null}, {branch: {$exists: false}}]},
        {createdBy: {$in: userIds}}
      ]
    }
  ];
  return match;
}

export async function resolveExpenseContext({user, branchId, session} = {}) {
  const identity = await userRestaurantContext(user, {session});
  let branch = branchId || null;
  if (!branch && identity.role !== 'owner') {
    if (!identity.branchId) throw httpError('User is not assigned to a branch', 403);
    branch = identity.branchId;
  }
  let branchIds;
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    const context = await purchaseBranchContext({user, branchId: branch, session, allowInactive: true});
    branch = context.branch._id;
    branchIds = [context.branch._id];
  } else {
    branchIds = await Branch.find({restaurant: identity.restaurantId}).session(session || null).distinct('_id');
  }
  const userIds = await User.find({restaurantId: identity.restaurantId}).session(session || null).distinct('_id');
  return {identity, branch, branchIds, userIds};
}

export function expenseScope(rows, branchId) {
  if (!branchId) return 'restaurant';
  return (rows || []).some(e => e.branch) ? 'branch' : 'restaurant';
}

function populateExpense(doc) {
  return Expense.findById(doc._id).populate('createdBy', 'name role').populate('branch', 'name code');
}

function expenseOwnedByScope(expense, scope) {
  if (expense.branch) return scope.branchIds.some(branchId => String(branchId) === String(expense.branch));
  return scope.userIds.some(userId => String(userId) === String(expense.createdBy));
}

function assertCanMutate(user, expense, scope) {
  if (!expenseOwnedByScope(expense, scope)) throw httpError('Expense not found', 404);
  if (user?.role === 'owner') return;
  if (!expense.branch) throw httpError('Cannot change a restaurant-wide expense', 403);
  if (String(expense.branch) !== String(scope.branch)) throw httpError('Branch access denied', 403);
}

export async function listExpenses({branchId, user, from, to} = {}) {
  const scope = await resolveExpenseContext({user, branchId});
  const branch = scope.branch;
  const rows = await Expense.find(expenseQuery({
    branchId: branch,
    branchIds: scope.branchIds,
    userIds: scope.userIds,
    from,
    to
  }))
    .populate('createdBy', 'name role')
    .populate('branch', 'name code')
    .sort({date: -1, createdAt: -1});
  const amount = money(rows.reduce((s, e) => s + Number(e.amount || 0), 0));
  const vat = money(rows.reduce((s, e) => s + Number(e.vat || 0), 0));
  return {
    source: 'live',
    currency: 'NPR',
    vatRate: 13,
    scope: expenseScope(rows, branch),
    branch: branch || null,
    from: from || null,
    to: to || null,
    count: rows.length,
    amount,
    vat,
    expenses: rows
  };
}

export async function createExpense({category, description, amount, vat, date, branch, user}) {
  const label = String(category || '').trim();
  if (!label) throw httpError('Category is required', 400);
  const amt = money(amount);
  if (!(amt > 0)) throw httpError('Amount must be positive', 400);
  const vatAmt = expenseVat(amt, vat);
  if (vatAmt < 0) throw httpError('VAT cannot be negative', 400);

  const requestedBranch = branch === '' ? null : branch || null;
  const scope = await resolveExpenseContext({user, branchId: requestedBranch});
  const branchId = scope.branch;

  const saved = await Expense.create({
    category: label,
    description: description || '',
    amount: amt,
    vat: vatAmt,
    date: date ? new Date(date) : new Date(),
    branch: branchId || undefined,
    createdBy: user.id
  });
  await Audit.create([{
    entity: 'expense',
    entityId: saved._id,
    restaurant: scope.identity.restaurantId,
    branch: saved.branch,
    action: 'create',
    after: {category: saved.category, amount: saved.amount, vat: saved.vat, date: saved.date, branch: saved.branch},
    user: user.id
  }]);
  return populateExpense(saved);
}

export async function updateExpense({expenseId, patch = {}, user}) {
  if (!mongoose.isValidObjectId(expenseId)) throw httpError('Invalid expense', 400);
  const scope = await resolveExpenseContext({user});
  const expense = await Expense.findById(expenseId);
  if (!expense) throw httpError('Expense not found', 404);
  assertCanMutate(user, expense, scope);

  const before = {
    category: expense.category,
    description: expense.description,
    amount: expense.amount,
    vat: expense.vat,
    date: expense.date,
    branch: expense.branch
  };

  if (patch.category !== undefined) {
    const label = String(patch.category || '').trim();
    if (!label) throw httpError('Category is required', 400);
    expense.category = label;
  }
  if (patch.description !== undefined) expense.description = patch.description || '';
  if (patch.date !== undefined) expense.date = patch.date ? new Date(patch.date) : expense.date;
  if (patch.amount !== undefined) {
    const amt = money(patch.amount);
    if (!(amt > 0)) throw httpError('Amount must be positive', 400);
    expense.amount = amt;
    expense.vat = expenseVat(amt, patch.vat);
  } else if (patch.vat !== undefined) {
    const vatAmt = money(patch.vat);
    if (vatAmt < 0) throw httpError('VAT cannot be negative', 400);
    expense.vat = vatAmt;
  }
  if (patch.branch !== undefined) {
    if (user?.role !== 'owner') throw httpError('Only the owner can move expense scope', 403);
    if (!patch.branch) {
      expense.branch = undefined;
    } else {
      const targetScope = await resolveExpenseContext({user, branchId: patch.branch});
      expense.branch = targetScope.branch;
    }
  }

  await expense.save();
  await Audit.create([{
    entity: 'expense',
    entityId: expense._id,
    restaurant: scope.identity.restaurantId,
    branch: expense.branch,
    action: 'update',
    before,
    after: {
      category: expense.category,
      description: expense.description,
      amount: expense.amount,
      vat: expense.vat,
      date: expense.date,
      branch: expense.branch
    },
    user: user.id
  }]);
  return populateExpense(expense);
}

export async function deleteExpense({expenseId, user}) {
  if (!mongoose.isValidObjectId(expenseId)) throw httpError('Invalid expense', 400);
  const scope = await resolveExpenseContext({user});
  const expense = await Expense.findById(expenseId);
  if (!expense) throw httpError('Expense not found', 404);
  assertCanMutate(user, expense, scope);
  await expense.deleteOne();
  await Audit.create([{
    entity: 'expense',
    entityId: expense._id,
    restaurant: scope.identity.restaurantId,
    branch: expense.branch,
    action: 'delete',
    before: {category: expense.category, amount: expense.amount, vat: expense.vat, date: expense.date, branch: expense.branch},
    user: user.id
  }]);
  return expense;
}
