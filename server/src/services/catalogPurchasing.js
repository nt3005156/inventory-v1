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

function vatRate(value) {
  const number = Number(value ?? 13);
  if (!Number.isFinite(number) || number < 0 || number > 100) throw httpError('VAT rate must be between 0 and 100', 400);
  return number;
}

function financials(quotedAmount, includesVat, ratePercent) {
  const quoted = Number(quotedAmount);
  const divisor = 1 + ratePercent / 100;
  const subtotal = includesVat && ratePercent ? money(quoted / divisor) : money(quoted);
  const vat = includesVat ? money(quoted - subtotal) : money(subtotal * ratePercent / 100);
  return {subtotal, vat, total: money(subtotal + vat)};
}

export async function prepareCatalogPurchaseOrder({branchId, supplierId, items, user, session}) {
  if (!mongoose.isValidObjectId(branchId)) throw httpError('Invalid branch', 400);
  if (!mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier', 400);
  if (!Array.isArray(items) || !items.length) throw httpError('At least one purchase order item is required', 400);

  const restaurantId = await restaurantForUser(user, {session});
  const [branch, supplier] = await Promise.all([
    Branch.findById(branchId).select('restaurant active').session(session || null).lean(),
    Supplier.findById(supplierId).select('restaurant active').session(session || null).lean()
  ]);
  if (!branch || branch.active === false) throw httpError('Active branch not found', 404);
  if (String(branch.restaurant) !== String(restaurantId)) {
    throw httpError('Branch does not belong to the user restaurant', 403);
  }
  if (!supplier || supplier.active === false) throw httpError('Active supplier not found', 404);
  if (!supplier.restaurant || String(supplier.restaurant) !== String(branch.restaurant)) {
    throw httpError('Supplier does not belong to the purchase order restaurant', 403);
  }

  const catalogExists = await SupplierIngredient.exists({restaurant: branch.restaurant, supplier: supplierId}).session(session || null);
  const seen = new Set();
  const lines = [];
  let subtotal = 0;
  let vat = 0;
  let total = 0;
  let maxLeadDays = 0;

  for (const input of items) {
    if (!mongoose.isValidObjectId(input.ingredient)) throw httpError('Invalid ingredient', 400);
    if (seen.has(String(input.ingredient))) throw httpError('Duplicate ingredient lines are not allowed', 409);
    seen.add(String(input.ingredient));

    const ingredient = await Ingredient.findById(input.ingredient).select('restaurant active unit').session(session || null).lean();
    if (!ingredient || ingredient.active === false) throw httpError('Active ingredient not found', 404);
    if (!ingredient.restaurant || String(ingredient.restaurant) !== String(branch.restaurant)) {
      throw httpError('Ingredient does not belong to the purchase order restaurant', 403);
    }

    const catalog = await catalogForPurchase({
      restaurantId: branch.restaurant,
      supplierId,
      item: input,
      session
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
      const ratePercent = vatRate(catalog.vatRate);
      const amounts = financials(purchaseQty * Number(catalog.currentPrice), Boolean(catalog.priceIncludesVat), ratePercent);
      const leadDays = Number(catalog.leadDays || 0);
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
        unitPrice: rate(amounts.subtotal / orderedQty),
        catalogPrice: catalog.currentPrice,
        priceIncludesVat: catalog.priceIncludesVat,
        vatRate: ratePercent,
        minOrderQty: Number(catalog.minOrderQty || 0),
        leadDays,
        lineSubtotal: amounts.subtotal,
        lineVat: amounts.vat,
        lineTotal: amounts.total
      });
      subtotal += amounts.subtotal;
      vat += amounts.vat;
      total += amounts.total;
      maxLeadDays = Math.max(maxLeadDays, leadDays);
      continue;
    }

    const orderedQty = positive(input.orderedQty, 'Ordered quantity');
    const quotedUnitPrice = positive(input.unitPrice, 'Unit price');
    const ratePercent = vatRate(input.vatRate);
    const includesVat = Boolean(input.priceIncludesVat);
    const amounts = financials(orderedQty * quotedUnitPrice, includesVat, ratePercent);
    lines.push({
      ingredient: ingredient._id,
      orderedQty,
      receivedQty: 0,
      damagedQty: 0,
      returnedQty: 0,
      unit: String(input.unit || ingredient.unit || 'each').trim().toLowerCase(),
      unitPrice: rate(amounts.subtotal / orderedQty),
      catalogPrice: quotedUnitPrice,
      priceIncludesVat: includesVat,
      vatRate: ratePercent,
      lineSubtotal: amounts.subtotal,
      lineVat: amounts.vat,
      lineTotal: amounts.total
    });
    subtotal += amounts.subtotal;
    vat += amounts.vat;
    total += amounts.total;
  }

  return {
    items: lines,
    subtotal: money(subtotal),
    vat: money(vat),
    total: money(total),
    maxLeadDays
  };
}
