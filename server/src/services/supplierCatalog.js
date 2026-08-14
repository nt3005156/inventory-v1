import mongoose from 'mongoose';
import {Audit, Ingredient, Supplier, User} from '../models/index.js';
import {Branch, Restaurant} from '../models/operations.js';
import {SupplierIngredient, SupplierPriceHistory} from '../models/supplierCatalog.js';
import {ensureSupplierCatalogIndexes} from './supplierCatalogMigration.js';

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const asId = value => value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
const clean = value => String(value || '').trim();
const sku = value => clean(value).toUpperCase() || undefined;
const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const unitRate = value => Math.round((Number(value) + Number.EPSILON) * 1000000) / 1000000;
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function userRestaurantContext(user, {session} = {}) {
  if (!user?.id) throw httpError('Authentication required', 401);
  const stored = await User.findById(user.id).select('restaurant restaurantId branch role').session(session || null).lean();
  if (!stored) throw httpError('User not found', 401);
  if (user.role !== stored.role) throw httpError('User permissions changed; sign in again', 401);

  let restaurantId = stored.restaurantId ? new mongoose.Types.ObjectId(stored.restaurantId) : null;
  const branchId = asId(stored.branch);
  if (!restaurantId && branchId) {
    const branch = await Branch.findById(branchId).select('restaurant').session(session || null).lean();
    if (branch?.restaurant) restaurantId = new mongoose.Types.ObjectId(branch.restaurant);
  }
  if (!restaurantId && stored.restaurant) {
    const restaurant = await Restaurant.findOne({name: stored.restaurant}).select('_id').session(session || null).lean();
    if (restaurant) restaurantId = restaurant._id;
  }
  if (!restaurantId) throw httpError('User is not assigned to a restaurant', 403);
  return {restaurantId, branchId, role: stored.role, userId: stored._id};
}

export async function restaurantForUser(user, options = {}) {
  return (await userRestaurantContext(user, options)).restaurantId;
}

async function assertCatalogReferences({restaurantId, supplierId, ingredientId, session}) {
  if (!asId(supplierId)) throw httpError('Invalid supplier', 400);
  if (!asId(ingredientId)) throw httpError('Invalid ingredient', 400);
  const [supplier, ingredient] = await Promise.all([
    Supplier.findById(supplierId).session(session || null),
    Ingredient.findById(ingredientId).session(session || null)
  ]);
  if (!supplier || supplier.active === false) throw httpError('Active supplier not found', 404);
  if (!ingredient || ingredient.active === false) throw httpError('Active ingredient not found', 404);
  if (!supplier.restaurant || String(supplier.restaurant) !== String(restaurantId)) {
    throw httpError('Supplier does not belong to this restaurant', 403);
  }
  if (!ingredient.restaurant || String(ingredient.restaurant) !== String(restaurantId)) {
    throw httpError('Ingredient does not belong to this restaurant', 403);
  }
  return {supplier, ingredient};
}

function validateConversion(purchaseUnit, baseUnit, conversionFactor) {
  if (purchaseUnit === baseUnit && Number(conversionFactor) !== 1) {
    throw httpError('Conversion factor must be 1 when purchase and inventory units match', 400);
  }
}

function historyState(row) {
  return {
    restaurant: row.restaurant,
    catalogItem: row._id,
    supplier: row.supplier,
    ingredient: row.ingredient,
    price: row.currentPrice,
    purchaseUnit: row.purchaseUnit,
    baseUnit: row.baseUnit,
    conversionFactor: row.conversionFactor,
    priceIncludesVat: row.priceIncludesVat,
    vatRate: row.vatRate
  };
}

function catalogView(row) {
  const value = row?.toJSON ? row.toJSON() : row;
  return {
    ...value,
    baseUnitPrice: value.conversionFactor ? unitRate(value.currentPrice / value.conversionFactor) : 0
  };
}

export async function listCatalog({user, q, supplier, ingredient, active, page = 1, limit = 50}) {
  const restaurantId = await restaurantForUser(user);
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const match = {restaurant: restaurantId};

  if (supplier) {
    if (!asId(supplier)) throw httpError('Invalid supplier', 400);
    match.supplier = asId(supplier);
  }
  if (ingredient) {
    if (!asId(ingredient)) throw httpError('Invalid ingredient', 400);
    match.ingredient = asId(ingredient);
  }
  if (active !== undefined && active !== '') match.active = String(active) === 'true';

  const term = clean(q);
  if (term) {
    const regex = new RegExp(escapeRegex(term), 'i');
    const [suppliers, ingredients] = await Promise.all([
      Supplier.find({restaurant: restaurantId, name: regex}).distinct('_id'),
      Ingredient.find({restaurant: restaurantId, $or: [{name: regex}, {code: regex}, {category: regex}]}).distinct('_id')
    ]);
    match.$or = [
      {supplierSku: regex},
      {purchaseUnit: regex},
      {supplier: {$in: suppliers}},
      {ingredient: {$in: ingredients}}
    ];
  }

  const [items, total] = await Promise.all([
    SupplierIngredient.find(match)
      .populate('supplier', 'name contact paymentTerms active')
      .populate('ingredient', 'name code category unit active')
      .sort({active: -1, updatedAt: -1, _id: -1})
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit),
    SupplierIngredient.countDocuments(match)
  ]);

  return {
    items: items.map(catalogView),
    pagination: {page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total / safeLimit))}
  };
}

export async function catalogOptions({user}) {
  const restaurantId = await restaurantForUser(user);
  const [suppliers, ingredients] = await Promise.all([
    Supplier.find({restaurant: restaurantId, active: {$ne: false}}).select('name contact paymentTerms').sort({name: 1}).lean(),
    Ingredient.find({restaurant: restaurantId, active: {$ne: false}}).select('name code category unit').sort({name: 1}).lean()
  ]);
  return {suppliers, ingredients};
}

export async function createCatalogItem({input, user, session}) {
  await ensureSupplierCatalogIndexes();
  const restaurantId = await restaurantForUser(user, {session});
  const {ingredient} = await assertCatalogReferences({
    restaurantId,
    supplierId: input.supplier,
    ingredientId: input.ingredient,
    session
  });
  const purchaseUnit = clean(input.purchaseUnit).toLowerCase();
  const baseUnit = clean(ingredient.unit || 'each').toLowerCase();
  validateConversion(purchaseUnit, baseUnit, input.conversionFactor);

  try {
    const [row] = await SupplierIngredient.create([{
      restaurant: restaurantId,
      supplier: input.supplier,
      ingredient: input.ingredient,
      supplierSku: sku(input.supplierSku),
      purchaseUnit,
      baseUnit,
      conversionFactor: Number(input.conversionFactor),
      currentPrice: money(input.currentPrice),
      priceIncludesVat: Boolean(input.priceIncludesVat),
      vatRate: Number(input.vatRate ?? 13),
      minOrderQty: Number(input.minOrderQty),
      leadDays: Number(input.leadDays),
      active: input.active !== false,
      createdBy: user.id,
      updatedBy: user.id
    }], {session});

    await SupplierPriceHistory.create([{
      ...historyState(row),
      reason: clean(input.reason) || 'Opening supplier price',
      changedBy: user.id
    }], {session});
    await Audit.create([{
      entity: 'supplier_catalog',
      entityId: row._id,
      restaurant: restaurantId,
      action: 'catalog_create',
      after: catalogView(row),
      reason: clean(input.reason),
      user: user.id
    }], {session});
    return catalogView(await SupplierIngredient.findById(row._id)
      .session(session || null)
      .populate('supplier', 'name contact paymentTerms active')
      .populate('ingredient', 'name code category unit active'));
  } catch (error) {
    if (error?.code === 11000) throw httpError('This supplier mapping or supplier SKU already exists', 409);
    throw error;
  }
}

export async function updateCatalogItem({catalogId, patch, expectedVersion, user, session}) {
  await ensureSupplierCatalogIndexes();
  if (!asId(catalogId)) throw httpError('Invalid supplier catalog item', 400);
  const restaurantId = await restaurantForUser(user, {session});
  const row = await SupplierIngredient.findOne({_id: catalogId, restaurant: restaurantId}).session(session || null);
  if (!row) throw httpError('Supplier catalog item not found', 404);
  if (Number(expectedVersion) !== row.__v) {
    throw httpError('Catalog item changed since it was loaded; refresh and try again', 409);
  }

  const before = catalogView(row);
  const oldPrice = row.currentPrice;
  const priceFields = ['currentPrice', 'purchaseUnit', 'conversionFactor', 'priceIncludesVat', 'vatRate'];
  const priceChanged = priceFields.some(field => patch[field] !== undefined && patch[field] !== row[field]);

  if (patch.supplierSku !== undefined) row.supplierSku = sku(patch.supplierSku);
  if (patch.purchaseUnit !== undefined) row.purchaseUnit = clean(patch.purchaseUnit).toLowerCase();
  if (patch.conversionFactor !== undefined) row.conversionFactor = Number(patch.conversionFactor);
  if (patch.currentPrice !== undefined) row.currentPrice = money(patch.currentPrice);
  if (patch.priceIncludesVat !== undefined) row.priceIncludesVat = Boolean(patch.priceIncludesVat);
  if (patch.vatRate !== undefined) row.vatRate = Number(patch.vatRate);
  if (patch.minOrderQty !== undefined) row.minOrderQty = Number(patch.minOrderQty);
  if (patch.leadDays !== undefined) row.leadDays = Number(patch.leadDays);
  if (patch.active !== undefined) row.active = Boolean(patch.active);
  row.previousPrice = patch.currentPrice !== undefined && row.currentPrice !== oldPrice ? oldPrice : row.previousPrice;
  row.updatedBy = user.id;
  validateConversion(row.purchaseUnit, row.baseUnit, row.conversionFactor);

  try {
    await row.save({session});
    if (priceChanged) {
      await SupplierPriceHistory.create([{
        ...historyState(row),
        reason: clean(patch.reason) || 'Supplier price terms updated',
        changedBy: user.id
      }], {session});
    }
    const action = patch.active !== undefined && Object.keys(patch).filter(k => !['active', 'reason'].includes(k)).length === 0
      ? (row.active ? 'catalog_activate' : 'catalog_deactivate')
      : (priceChanged ? 'catalog_price_update' : 'catalog_update');
    await Audit.create([{
      entity: 'supplier_catalog',
      entityId: row._id,
      restaurant: restaurantId,
      action,
      before,
      after: catalogView(row),
      reason: clean(patch.reason),
      user: user.id
    }], {session});
    return catalogView(await SupplierIngredient.findById(row._id)
      .session(session || null)
      .populate('supplier', 'name contact paymentTerms active')
      .populate('ingredient', 'name code category unit active'));
  } catch (error) {
    if (error?.name === 'VersionError') throw httpError('Catalog item changed since it was loaded; refresh and try again', 409);
    if (error?.code === 11000) throw httpError('This supplier SKU already exists', 409);
    throw error;
  }
}

export async function catalogPriceHistory({catalogId, user, limit = 100}) {
  if (!asId(catalogId)) throw httpError('Invalid supplier catalog item', 400);
  const restaurantId = await restaurantForUser(user);
  const item = await SupplierIngredient.findOne({_id: catalogId, restaurant: restaurantId}).select('_id');
  if (!item) throw httpError('Supplier catalog item not found', 404);
  return SupplierPriceHistory.find({catalogItem: item._id, restaurant: restaurantId})
    .sort({effectiveAt: -1, _id: -1})
    .limit(Math.min(250, Math.max(1, Number(limit) || 100)))
    .populate('changedBy', 'name role')
    .lean();
}

export async function catalogForPurchase({restaurantId, supplierId, item, session}) {
  const match = {
    restaurant: restaurantId,
    supplier: supplierId,
    ingredient: item.ingredient,
    active: true
  };
  if (item.catalogItem) {
    if (!asId(item.catalogItem)) throw httpError('Invalid supplier catalog item', 400);
    match._id = item.catalogItem;
  }
  return SupplierIngredient.findOne(match).session(session || null);
}
