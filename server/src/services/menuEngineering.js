import {Ingredient, MenuItem} from '../models/index.js';
import {InventoryBalance, Order} from '../models/operations.js';
import {resolveExpenseContext} from './expenses.js';
import {money} from './statements.js';

// Phase 3E defaults. Nepal casual-dining food cost target is ~35% of menu price.
export const DEFAULT_TARGET_FOOD_COST_PERCENT = 35;
// Kasavan–Smith "70% rule": an item is popular when it reaches 70% of the
// share it would hold if every item on the menu sold equally.
export const POPULARITY_RULE = 0.7;

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

const percent = (part, whole) => (Number(whole) > 0 ? money((Number(part) / Number(whole)) * 100) : 0);

export function classifyMenuItem(popularity, margin) {
  if (popularity >= 0.15) return margin >= 100 ? 'Star' : 'Plow-horse';
  return margin >= 100 ? 'Puzzle' : 'Dog';
}

// Menu-relative matrix: compares each item against the menu's own averages
// instead of the fixed cutoffs kept by classifyMenuItem.
export function classifyAgainstMenu(popularityIndex, margin, averageMargin) {
  const popular = popularityIndex >= POPULARITY_RULE;
  const profitable = margin >= averageMargin;
  if (popular) return profitable ? 'Star' : 'Plow-horse';
  return profitable ? 'Puzzle' : 'Dog';
}

const RECOMMENDATIONS = {
  Star: 'Protect quality and portion. Feature it and hold the price.',
  'Plow-horse': 'Popular but thin. Re-engineer the recipe cost or nudge the price up.',
  Puzzle: 'Profitable but slow. Promote, reposition on the menu, or rename it.',
  Dog: 'Low demand and low margin. Rework the recipe or retire the item.'
};

export function buildRows({menu, sold, totalQty, costs}) {
  const denom = totalQty || 1;
  return menu.map(item => {
    const stats = sold[String(item._id)];
    const soldQty = stats?.qty || 0;
    const packagingCost = money(item.packagingCost || 0);
    // Sold order lines already capture recipe cost + packaging in foodCost, so
    // they are taken as the full plate cost. Unsold items are priced from the
    // live recipe, which excludes packaging and must have it added.
    const foodCost = soldQty > 0
      ? money(stats.cost / soldQty)
      : money(Number(costs.get(String(item._id)) || 0) + packagingCost);
    const plateCost = money(foodCost - packagingCost);
    const price = money(item.price || 0);
    const margin = money(price - foodCost);
    const popularity = soldQty / denom;
    return {
      id: item._id,
      name: item.name,
      code: item.code || '',
      category: item.category || 'main',
      price,
      popularity,
      margin,
      classification: classifyMenuItem(popularity, margin),
      soldQty,
      // unitCost stays the full per-plate food cost so margin = price - unitCost.
      unitCost: foodCost,
      recipeCost: plateCost,
      packagingCost,
      foodCost,
      foodCostPercent: percent(foodCost, price),
      marginPercent: percent(margin, price),
      revenue: money(price * soldQty),
      totalFoodCost: money(foodCost * soldQty),
      totalMargin: money(margin * soldQty),
      costSource: soldQty > 0 ? 'sold' : 'recipe',
      source: 'live'
    };
  });
}

function summarise(rows, targetFoodCostPercent) {
  const totalQty = rows.reduce((sum, row) => sum + row.soldQty, 0);
  const revenue = money(rows.reduce((sum, row) => sum + row.revenue, 0));
  const foodCost = money(rows.reduce((sum, row) => sum + row.totalFoodCost, 0));
  const grossMargin = money(revenue - foodCost);
  const sellingRows = rows.filter(row => row.soldQty > 0);
  // Weighted by plates sold when there are sales, otherwise a plain menu average.
  const averageMargin = totalQty > 0
    ? money(rows.reduce((sum, row) => sum + row.totalMargin, 0) / totalQty)
    : money(rows.reduce((sum, row) => sum + row.margin, 0) / (rows.length || 1));
  const averageFoodCostPercent = revenue > 0
    ? percent(foodCost, revenue)
    : money(rows.reduce((sum, row) => sum + row.foodCostPercent, 0) / (rows.length || 1));
  return {
    items: rows.length,
    itemsSold: sellingRows.length,
    plates: totalQty,
    revenue,
    foodCost,
    grossMargin,
    grossMarginPercent: percent(grossMargin, revenue),
    averageMargin,
    averageFoodCostPercent,
    targetFoodCostPercent,
    popularityThreshold: rows.length ? money((POPULARITY_RULE / rows.length) * 100) : 0
  };
}

export async function buildMenuEngineeringReport({branchId, user, from, to, targetFoodCostPercent, limit} = {}) {
  const target = Number.isFinite(Number(targetFoodCostPercent)) && Number(targetFoodCostPercent) > 0
    ? Number(targetFoodCostPercent)
    : DEFAULT_TARGET_FOOD_COST_PERCENT;
  const topN = Math.min(50, Math.max(1, Number(limit) || 5));

  const scope = await resolveExpenseContext({user, branchId});
  const ingredientIds = await Ingredient.find({restaurant: scope.identity.restaurantId}).distinct('_id');
  const match = {
    status: {$nin: ['cancelled', 'refunded']},
    branch: {$in: scope.branchIds},
    ...createdAtRange(from, to)
  };
  const [orders, menu] = await Promise.all([
    // Phase 26: both are only read, never saved -- `.lean()` skips building
    // a Mongoose document per row (1,200 orders and the full menu here).
    Order.find(match).select('items').lean(),
    MenuItem.find({active: {$ne: false}, 'recipe.ingredient': {$in: ingredientIds}}).sort({name: 1}).lean()
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

  /**
   * Live recipe cost, only for items with no sold line to price them from.
   *
   * Phase 26: this was `await recipeCost(item, ...)` inside the loop, and
   * `recipeCost()` itself does a populate plus an InventoryBalance query --
   * so an unsold catalogue of 120 dishes cost ~240 sequential round trips and
   * dominated the report (measured 157ms). The balances for every unpriced
   * item are now loaded once and the arithmetic done in memory.
   */
  const unpriced = menu.filter(item => !(sold[String(item._id)]?.qty > 0));
  const costs = new Map();
  if (unpriced.length) {
    const neededIngredients = [...new Set(
      unpriced.flatMap(item => (item.recipe || [])
        .map(line => String(line.ingredient?._id || line.ingredient || '')))
        .filter(Boolean)
    )];
    const balances = neededIngredients.length
      ? await InventoryBalance.find({
        ingredient: {$in: neededIngredients}, branch: {$in: scope.branchIds}
      }).select('ingredient quantity averageCost').lean()
      : [];
    // Same weighted-average-across-branches rule recipeCost() applies.
    const unitCosts = new Map();
    for (const balance of balances) {
      const key = String(balance.ingredient);
      const current = unitCosts.get(key) || {quantity: 0, value: 0, fallback: 0};
      const quantity = Math.max(0, Number(balance.quantity || 0));
      const averageCost = Math.max(0, Number(balance.averageCost || 0));
      current.quantity += quantity;
      current.value += quantity * averageCost;
      current.fallback = averageCost;
      unitCosts.set(key, current);
    }
    for (const item of unpriced) {
      const total = (item.recipe || []).reduce((sum, line) => {
        const cost = unitCosts.get(String(line.ingredient?._id || line.ingredient));
        const unitCost = cost ? (cost.quantity > 0 ? cost.value / cost.quantity : cost.fallback) : 0;
        return sum + Number(line.qty || 0) * unitCost;
      }, 0);
      costs.set(String(item._id), total);
    }
  }

  const rows = buildRows({menu, sold, totalQty, costs});
  const summary = summarise(rows, target);
  const expectedShare = rows.length ? 1 / rows.length : 0;

  for (const row of rows) {
    row.popularityIndex = expectedShare > 0 ? money(row.popularity / expectedShare) : 0;
    row.popular = row.popularityIndex >= POPULARITY_RULE;
    row.matrixClass = classifyAgainstMenu(row.popularityIndex, row.margin, summary.averageMargin);
    row.profitable = row.margin > 0 && row.margin >= summary.averageMargin;
    row.lowMargin = row.margin <= 0 || row.foodCostPercent > target;
    row.overTargetBy = row.foodCostPercent > target ? money(row.foodCostPercent - target) : 0;
    row.recommendation = RECOMMENDATIONS[row.matrixClass];
  }

  rows.sort((a, b) => b.soldQty - a.soldQty || b.margin - a.margin || a.name.localeCompare(b.name));

  const byTotalMargin = [...rows].sort((a, b) => b.totalMargin - a.totalMargin || b.margin - a.margin);
  const profitable = rows.filter(row => row.profitable);
  const lowMargin = rows.filter(row => row.lowMargin);
  const mix = {Star: 0, 'Plow-horse': 0, Puzzle: 0, Dog: 0};
  for (const row of rows) mix[row.matrixClass] += 1;

  return {
    source: 'live',
    currency: 'NPR',
    branch: scope.branch ? String(scope.branch) : null,
    from: from || null,
    to: to || null,
    summary: {...summary, profitableItems: profitable.length, lowMarginItems: lowMargin.length, mix},
    popularity: {
      threshold: POPULARITY_RULE,
      expectedSharePercent: money(expectedShare * 100),
      top: [...rows].sort((a, b) => b.soldQty - a.soldQty).slice(0, topN)
        .map(({id, name, soldQty, popularity, popularityIndex, popular}) =>
          ({id, name, soldQty, popularity, popularityIndex, popular}))
    },
    profitableItems: byTotalMargin.filter(row => row.profitable).slice(0, topN)
      .map(({id, name, margin, marginPercent, totalMargin, soldQty, matrixClass}) =>
        ({id, name, margin, marginPercent, totalMargin, soldQty, matrixClass})),
    lowMarginItems: [...lowMargin].sort((a, b) => b.foodCostPercent - a.foodCostPercent || a.margin - b.margin).slice(0, topN)
      .map(({id, name, margin, marginPercent, foodCost, foodCostPercent, overTargetBy, soldQty, matrixClass, recommendation}) =>
        ({id, name, margin, marginPercent, foodCost, foodCostPercent, overTargetBy, soldQty, matrixClass, recommendation})),
    items: rows
  };
}

// Backward-compatible array response used by the existing analytics endpoint.
export async function buildMenuEngineering(options) {
  const report = await buildMenuEngineeringReport(options);
  return report.items;
}
