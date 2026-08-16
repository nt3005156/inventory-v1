import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {Expense, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {expenseVat} from '../src/services/expenses.js';
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

function createExpense(body = {}, token = tokenFor(world.manager)) {
  return request('/api/expenses', {
    method: 'POST',
    token,
    body: {
      category: 'rent',
      description: 'Kalanki shop',
      amount: 500,
      ...body
    }
  });
}

describe('expenseVat', () => {
  it('defaults to Nepal 13% and keeps an explicit VAT', () => {
    assert.equal(expenseVat(500), 65);
    assert.equal(expenseVat(500, 0), 0);
    assert.equal(expenseVat(1000, 130), 130);
  });
});

describe('POST /api/expenses', () => {
  it('records a restaurant-wide expense with 13% VAT and feeds live P&L', async () => {
    const created = await createExpense({}, tokenFor(world.owner));
    assert.equal(created.status, 201, created.body?.message);
    assert.equal(created.body.category, 'rent');
    assert.equal(created.body.amount, 500);
    assert.equal(created.body.vat, 65);
    assert.equal(created.body.description, 'Kalanki shop');
    assert.ok(!created.body.branch);

    const pnl = await request('/api/reports/pnl?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(pnl.status, 200, pnl.body?.message);
    assert.equal(pnl.body.expenses, 500);
    assert.equal(pnl.body.expenseDetail.vat, 65);
    assert.equal(pnl.body.expenseDetail.scope, 'restaurant');
    assert.equal(pnl.body.netProfit, -500);
  });

  it('rejects staff, guests, missing tokens and non-positive amounts', async () => {
    assert.equal((await createExpense({}, tokenFor(world.staffA))).status, 403);
    assert.equal((await request('/api/expenses', {
      method: 'POST',
      body: {category: 'rent', description: 'Kalanki shop', amount: 500}
    })).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await createExpense({}, guest)).status, 403);
    assert.equal((await createExpense({amount: 0})).status, 400);
    assert.equal((await createExpense({amount: -10})).status, 400);
  });
});

describe('GET /api/expenses', () => {
  it('lists live expenses and can filter by date', async () => {
    const live = await createExpense({amount: 500});
    assert.equal(live.status, 201, live.body?.message);
    await Expense.create({
      category: 'utilities', description: 'Old bill', amount: 200, vat: 26,
      date: new Date('2020-01-15'), createdBy: world.owner._id
    });

    const all = await request('/api/expenses', {token: tokenFor(world.owner)});
    assert.equal(all.status, 200, all.body?.message);
    assert.equal(all.body.source, 'live');
    assert.equal(all.body.scope, 'restaurant');
    assert.equal(all.body.count, 2);
    assert.equal(all.body.amount, 700);
    assert.equal(all.body.vat, 91);

    const from = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const recent = await request('/api/expenses?from=' + from, {token: tokenFor(world.manager)});
    assert.equal(recent.status, 200, recent.body?.message);
    assert.equal(recent.body.count, 1);
    assert.equal(recent.body.amount, 500);
    assert.equal(recent.body.expenses[0].category, 'rent');
  });

  it('rejects staff, guests and missing tokens', async () => {
    assert.equal((await request('/api/expenses', {token: tokenFor(world.staffA)})).status, 403);
    assert.equal((await request('/api/expenses')).status, 401);
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    assert.equal((await request('/api/expenses', {token: guest})).status, 403);
  });

  it('hides and protects branch and restaurant-wide expenses owned by another restaurant', async () => {
    const restaurant = await Restaurant.create({name: 'Foreign Expense Restaurant'});
    const branch = await Branch.create({restaurant: restaurant._id, name: 'Foreign Expense Branch', code: 'FEB'});
    const owner = await User.create({
      name: 'Foreign Expense Owner', email: 'foreign-expense@test.com', password: 'x', role: 'owner', restaurantId: restaurant._id
    });
    const restaurantWide = await Expense.create({
      category: 'foreign rent', amount: 900, vat: 117, createdBy: owner._id, date: new Date()
    });
    await Expense.create({
      category: 'foreign utilities', amount: 600, vat: 78, branch: branch._id, createdBy: owner._id, date: new Date()
    });

    const list = await request('/api/expenses', {token: tokenFor(world.owner)});
    assert.equal(list.status, 200, list.body?.message);
    assert.equal(list.body.count, 0);
    const pnl = await request('/api/reports/pnl', {token: tokenFor(world.owner)});
    assert.equal(pnl.status, 200, pnl.body?.message);
    assert.equal(pnl.body.expenses, 0);
    assert.equal((await request(`/api/expenses/${restaurantWide._id}`, {
      method: 'PATCH', token: tokenFor(world.owner), body: {amount: 1}
    })).status, 404);
    assert.equal((await request(`/api/expenses/${restaurantWide._id}`, {
      method: 'DELETE', token: tokenFor(world.owner)
    })).status, 404);
    assert.equal((await createExpense({branch: String(branch._id)}, tokenFor(world.owner))).status, 403);
  });
});

describe('PATCH /api/expenses/:id', () => {
  it('edits amount and VAT, then live P&L follows', async () => {
    const created = await createExpense({amount: 500});
    assert.equal(created.status, 201, created.body?.message);
    const updated = await request('/api/expenses/' + created.body._id, {
      method: 'PATCH',
      token: tokenFor(world.owner),
      body: {amount: 800, description: 'Kalanki shop August'}
    });
    assert.equal(updated.status, 200, updated.body?.message);
    assert.equal(updated.body.amount, 800);
    assert.equal(updated.body.vat, 104);
    assert.equal(updated.body.description, 'Kalanki shop August');

    const pnl = await request('/api/reports/pnl', {token: tokenFor(world.owner)});
    assert.equal(pnl.body.expenses, 800);
    assert.equal(pnl.body.expenseDetail.vat, 104);
  });
});

describe('branch-scoped expenses', () => {
  it('keeps restaurant-wide costs on every branch and hides other-branch rows', async () => {
    const shared = await request('/api/expenses', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {category: 'rent', description: 'Head office', amount: 100}
    });
    assert.equal(shared.status, 201, shared.body?.message);
    assert.ok(!shared.body.branch);

    const atA = await createExpense({amount: 300, description: 'KTM power'});
    assert.equal(atA.status, 201, atA.body?.message);
    assert.equal(String(atA.body.branch?._id || atA.body.branch), String(world.branchA._id));

    const atB = await request('/api/expenses', {
      method: 'POST',
      token: tokenFor(world.owner),
      body: {category: 'utilities', description: 'LTP power', amount: 200, branch: String(world.branchB._id)}
    });
    assert.equal(atB.status, 201, atB.body?.message);

    const pnlA = await request('/api/reports/pnl?branch=' + world.branchA._id, {token: tokenFor(world.owner)});
    assert.equal(pnlA.body.expenses, 400);
    assert.equal(pnlA.body.expenseDetail.scope, 'branch');
    const pnlB = await request('/api/reports/pnl?branch=' + world.branchB._id, {token: tokenFor(world.owner)});
    assert.equal(pnlB.body.expenses, 300);
    const pnlAll = await request('/api/reports/pnl', {token: tokenFor(world.owner)});
    assert.equal(pnlAll.body.expenses, 600);
    assert.equal(pnlAll.body.expenseDetail.scope, 'restaurant');

    const listed = await request('/api/expenses?branch=' + world.branchA._id, {token: tokenFor(world.manager)});
    assert.equal(listed.status, 200, listed.body?.message);
    assert.equal(listed.body.count, 2);
    assert.equal(listed.body.amount, 400);
    assert.equal((await request('/api/expenses?branch=' + world.branchB._id, {token: tokenFor(world.manager)})).status, 403);
    assert.equal((await createExpense({branch: String(world.branchB._id)}, tokenFor(world.manager))).status, 403);
  });
});

describe('DELETE /api/expenses/:id', () => {
  it('removes the expense from the list and from P&L', async () => {
    const created = await createExpense({amount: 500});
    assert.equal(created.status, 201, created.body?.message);
    const removed = await request('/api/expenses/' + created.body._id, {
      method: 'DELETE',
      token: tokenFor(world.manager)
    });
    assert.equal(removed.status, 204, removed.body?.message);
    const list = await request('/api/expenses', {token: tokenFor(world.owner)});
    assert.equal(list.body.count, 0);
    const pnl = await request('/api/reports/pnl', {token: tokenFor(world.owner)});
    assert.equal(pnl.body.expenses, 0);
    assert.equal((await request('/api/expenses/' + created.body._id, {
      method: 'DELETE',
      token: tokenFor(world.owner)
    })).status, 404);
  });
});
