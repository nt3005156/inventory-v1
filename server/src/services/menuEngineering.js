import {Ingredient, MenuItem} from '../models/index.js';
import {Order} from '../models/operations.js';
import {recipeCost} from './engine.js';
import {resolveExpenseContext} from './expenses.js';
import {money} from './statements.js';

function createdAtRange(from, to) {
  if (!from && !to) return {};
  const createdAt = {};
  if (from) createdAt.$gte = new Date(from);
  if (to) {
    const end = new Date(to);
    end.setHours(23, 59, 59, 999);
    createdAt.$lte = end;
  }
  return {createdAt};
}

export function classifyMenuItem(popularity, margin) {
  if (popularity >= 0.15) return margin >= 100 ? 'Star' : 'Plow-horse';
  return margin >= 100 ? 'Puzzle' : 'Dog';
}

export async function buildMenuEngineering({branchId, user, from, to}) {
  const scope = await resolveExpenseContext({user, branchId});
  const ingredientIds = await Ingredient.find({restaurant: scope.identity.restaurantId}).distinct('_id');
  const match = {
    status: {$nin: ['cancelled', 'refunded']},
    branch: {$in: scope.branchIds},
    ...createdAtRange(from, to)
  };
  const [orders, menu] = await Promise.all([
    Order.find(match).select('items'),
    MenuItem.find({active: {$ne: false}, 'recipe.ingredient': {$in: ingredientIds}}).sort({name: 1})
  ]);

  const sold = {};
  let totalQty = 0;
  for (const order of orders) {
    for (const line of order.items || []) {
      if (!line.menuItem) continue;
      const id = String(line.menuItem);
      const qty = Number(line.qty || 0);
      if (!sold[id]) sold[id] = {qty: 0, cost: 0};
      sold[id].qty += qty;
      sold[id].cost += Number(line.foodCost || 0) * qty;
      totalQty += qty;
    }
  }
  const denom = totalQty || 1;

  const rows = [];
  for (const item of menu) {
    const stats = sold[String(item._id)];
    const soldQty = stats?.qty || 0;
    const cost = soldQty > 0
      ? money(stats.cost / soldQty)
      : money(await recipeCost(item, {branches: scope.branchIds}));
    const margin = money(Number(item.price || 0) - cost);
    const popularity = soldQty / denom;
    rows.push({
      id: item._id,
      name: item.name,
      popularity,
      margin,
      classification: classifyMenuItem(popularity, margin),
      soldQty,
      unitCost: money(cost),
      costSource: soldQty > 0 ? 'sold' : 'recipe',
      source: 'live'
    });
  }
  return rows.sort((a, b) => b.soldQty - a.soldQty || b.margin - a.margin || a.name.localeCompare(b.name));
}
