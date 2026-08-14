import mongoose from 'mongoose';
import {Ingredient, Supplier} from '../models/index.js';
import {Branch} from '../models/operations.js';
import {SupplierIngredient} from '../models/supplierCatalog.js';
import {catalogForPurchase, restaurantForUser} from './supplierCatalog.js';

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const positive = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw httpError(`${label} must be greater than zero`, 400);
  return number;
};
const rate = value => Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export async function prepareCatalogPurchaseOrder({branchId, supplierId, items, user}) {
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  if (!Array.isArray(items) || !items.length) throw httpError('At least one purchase order item is required', 400);

  const restaurantId = await restaurantForUser(user);
  const [branch, supplier] = await Promise.all([
    Branch.findById(branchId).select('restaurant active').lean(),
    Supplier.findById(supplierId).select('restaurant active').lean()
  ]);
  if (!branch || branch.active === false) throw httpError('Active branch not found', 404);
  if (String(branch.restaurant) !== String(restaurantId)) {
    throw httpError('Branch does not belong to the user restaurant', 403);
  }
  if (!supplier || supplier.active === false) throw httpError('Active supplier not found', 404);
  if (supplier.restaurant && String(supplier.restaurant) !== String(branch.restaurant)) {
    throw httpError('Supplier does not belong to the purchase order restaurant', 403);
  }

  const catalogExists = await SupplierIngredient.exists({restaurant: branch.restaurant, supplier: supplierId});
  const seen = new Set();
  const lines = [];
  let total = 0;

  for (const input of items) {
    if (!mongoose.isValidObjectId(input.ingredient)) throw httpError('Invalid ingredient', 400);
    if (seen.has(String(input.ingredient))) throw httpError('Duplicate ingredient lines are not allowed', 409);
    seen.add(String(input.ingredient));

    const ingredient = await Ingredient.findById(input.ingredient).select('restaurant active unit').lean();
    if (!ingredient || ingredient.active === false) throw httpError('Active ingredient not found', 404);
    if (ingredient.restaurant && String(ingredient.restaurant) !== String(branch.restaurant)) {
      throw httpError('Ingredient does not belong to the purchase order restaurant', 403);
    }

    const catalog = await catalogForPurchase({
      restaurantId: branch.restaurant,
      supplierId,
      item: input
    });
    if ((input.catalogItem || catalogExists) && !catalog) {
      throw httpError('An active supplier catalog mapping is required for this ingredient', 409);
    }

    if (catalog) {
      const conversionFactor = positive(catalog.conversionFactor, 'Conversion factor');
      const purchaseQty = input.purchaseQty !== undefined
        ? positive(input.purchaseQty, 'Purchase quantity')
        : positive(input.orderedQty, 'Ordered quantity') / conversionFactor;
      if (purchaseQty < Number(catalog.minOrderQty || 1)) {
        throw httpError(`Minimum order is ${catalog.minOrderQty || 1} ${catalog.purchaseUnit}`, 409);
      }
      const orderedQty = rate(purchaseQty * conversionFactor);
      const unitPrice = rate(catalog.currentPrice / conversionFactor);
      lines.push({
        ingredient: ingredient._id,
        catalogItem: catalog._id,
        supplierSku: catalog.supplierSku,
        orderedQty,
        purchaseQty: rate(purchaseQty),
        receivedQty: 0,
        damagedQty: 0,
        returnedQty: 0,
        unit: catalog.baseUnit,
        purchaseUnit: catalog.purchaseUnit,
        conversionFactor,
        unitPrice,
        catalogPrice: catalog.currentPrice,
        priceIncludesVat: catalog.priceIncludesVat,
        vatRate: catalog.vatRate
      });
      total += purchaseQty * catalog.currentPrice;
      continue;
    }

    const orderedQty = positive(input.orderedQty, 'Ordered quantity');
    const unitPrice = positive(input.unitPrice, 'Unit price');
    lines.push({
      ingredient: ingredient._id,
      orderedQty,
      receivedQty: 0,
      damagedQty: 0,
      returnedQty: 0,
      unit: String(input.unit || ingredient.unit || 'each').trim().toLowerCase(),
      unitPrice
    });
    total += orderedQty * unitPrice;
  }

  return {items: lines, total: money(total)};
}
