import mongoose from 'mongoose';
import {Audit, Expense} from '../models/index.js';
import {Branch} from '../models/operations.js';
import {assertBranchAccess} from './kitchen.js';
import {vatOf} from './invoices.js';
import {money} from './statements.js';

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

export function expenseQuery({branchId, from, to, toExclusive} = {}) {
  const match = dateRange(from, to, toExclusive);
  if (!branchId) return match;
  match.$or = [
    {branch: branchId},
    {branch: null},
    {branch: {$exists: false}}
  ];
  return match;
}

export function expenseScope(rows, branchId) {
  if (!branchId) return 'restaurant';
  return (rows || []).some(e => e.branch) ? 'branch' : 'restaurant';
}

function populateExpense(doc) {
  return Expense.findById(doc._id).populate('createdBy', 'name role').populate('branch', 'name code');
}

function resolveExpenseBranch(user, branchId) {
  if (branchId) return String(branchId);
  if (user?.role !== 'owner' && user?.branch) return String(user.branch);
  return null;
}

async function resolveBranchId(user, branchId) {
  const branch = resolveExpenseBranch(user, branchId || null);
  if (branch) {
    if (!mongoose.isValidObjectId(branch)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branch);
    if (!await Branch.findById(branch)) throw httpError('Branch not found', 404);
  }
  return branch;
}

function assertCanMutate(user, expense) {
  if (user?.role === 'owner') return;
  if (!expense.branch) throw httpError('Cannot change a restaurant-wide expense', 403);
  assertBranchAccess(user, expense.branch);
}

export async function listExpenses({branchId, user, from, to} = {}) {
  const branch = await resolveBranchId(user, branchId);
  const rows = await Expense.find(expenseQuery({branchId: branch, from, to}))
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

  let branchId = branch || null;
  if (branchId === '') branchId = null;
  if (!branchId && user?.role !== 'owner' && user?.branch) branchId = String(user.branch);
  if (branchId) {
    if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
    assertBranchAccess(user, branchId);
    if (!await Branch.findById(branchId)) throw httpError('Branch not found', 404);
  }

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
    action: 'create',
    after: {category: saved.category, amount: saved.amount, vat: saved.vat, date: saved.date, branch: saved.branch},
    user: user.id
  }]);
  return populateExpense(saved);
}

export async function updateExpense({expenseId, patch = {}, user}) {
  if (!mongoose.isValidObjectId(expenseId)) throw httpError('Invalid expense', 400);
  const expense = await Expense.findById(expenseId);
  if (!expense) throw httpError('Expense not found', 404);
  assertCanMutate(user, expense);

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
      if (!mongoose.isValidObjectId(patch.branch)) throw httpError('Invalid branch', 400);
      if (!await Branch.findById(patch.branch)) throw httpError('Branch not found', 404);
      expense.branch = patch.branch;
    }
  }

  await expense.save();
  await Audit.create([{
    entity: 'expense',
    entityId: expense._id,
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
  const expense = await Expense.findById(expenseId);
  if (!expense) throw httpError('Expense not found', 404);
  assertCanMutate(user, expense);
  await expense.deleteOne();
  await Audit.create([{
    entity: 'expense',
    entityId: expense._id,
    action: 'delete',
    before: {category: expense.category, amount: expense.amount, vat: expense.vat, date: expense.date, branch: expense.branch},
    user: user.id
  }]);
  return expense;
}
