import mongoose from 'mongoose';
import {Audit, Expense} from '../models/index.js';
import {vatOf} from './invoices.js';
import {money} from './statements.js';

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function dateRange(from, to) {
  if (!from && !to) return {};
  const date = {};
  if (from) date.$gte = new Date(from);
  if (to) {
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

export async function listExpenses({from, to} = {}) {
  const rows = await Expense.find(dateRange(from, to))
    .populate('createdBy', 'name role')
    .sort({date: -1, createdAt: -1});
  const amount = money(rows.reduce((s, e) => s + Number(e.amount || 0), 0));
  const vat = money(rows.reduce((s, e) => s + Number(e.vat || 0), 0));
  return {
    source: 'live',
    currency: 'NPR',
    vatRate: 13,
    scope: 'restaurant',
    from: from || null,
    to: to || null,
    count: rows.length,
    amount,
    vat,
    expenses: rows
  };
}

export async function createExpense({category, description, amount, vat, date, user}) {
  const label = String(category || '').trim();
  if (!label) throw httpError('Category is required', 400);
  const amt = money(amount);
  if (!(amt > 0)) throw httpError('Amount must be positive', 400);
  const vatAmt = expenseVat(amt, vat);
  if (vatAmt < 0) throw httpError('VAT cannot be negative', 400);

  const saved = await Expense.create({
    category: label,
    description: description || '',
    amount: amt,
    vat: vatAmt,
    date: date ? new Date(date) : new Date(),
    createdBy: user.id
  });
  await Audit.create([{
    entity: 'expense',
    entityId: saved._id,
    action: 'create',
    after: {category: saved.category, amount: saved.amount, vat: saved.vat, date: saved.date},
    user: user.id
  }]);
  return Expense.findById(saved._id).populate('createdBy', 'name role');
}

export async function updateExpense({expenseId, patch = {}, user}) {
  if (!mongoose.isValidObjectId(expenseId)) throw httpError('Invalid expense', 400);
  const expense = await Expense.findById(expenseId);
  if (!expense) throw httpError('Expense not found', 404);

  const before = {
    category: expense.category,
    description: expense.description,
    amount: expense.amount,
    vat: expense.vat,
    date: expense.date
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
      date: expense.date
    },
    user: user.id
  }]);
  return Expense.findById(expense._id).populate('createdBy', 'name role');
}

export async function deleteExpense({expenseId, user}) {
  if (!mongoose.isValidObjectId(expenseId)) throw httpError('Invalid expense', 400);
  const expense = await Expense.findById(expenseId);
  if (!expense) throw httpError('Expense not found', 404);
  await expense.deleteOne();
  await Audit.create([{
    entity: 'expense',
    entityId: expense._id,
    action: 'delete',
    before: {category: expense.category, amount: expense.amount, vat: expense.vat, date: expense.date},
    user: user.id
  }]);
  return expense;
}
