import mongoose from 'mongoose';
import {Ingredient, Supplier, User} from '../models/index.js';
import {Restaurant} from '../models/operations.js';
import {SupplierIngredient, SupplierPriceHistory} from '../models/supplierCatalog.js';

let running;

async function createCollection(name) {
  const existing = await mongoose.connection.db.listCollections({name}, {nameOnly: true}).hasNext();
  if (existing) return;
  try {
    await mongoose.connection.createCollection(name);
  } catch (error) {
    if (error?.codeName !== 'NamespaceExists' && error?.code !== 48) throw error;
  }
}

async function backfillSingleRestaurant() {
  const restaurants = await Restaurant.find().select('_id name').lean();
  if (restaurants.length !== 1) return;
  const restaurant = restaurants[0];
  await Promise.all([
    User.updateMany({restaurantId: {$exists: false}}, {$set: {restaurantId: restaurant._id}}),
    Supplier.updateMany({restaurant: {$exists: false}}, {$set: {restaurant: restaurant._id}}),
    Ingredient.updateMany({restaurant: {$exists: false}}, {$set: {restaurant: restaurant._id}}),
    SupplierIngredient.collection.updateMany({restaurant: {$exists: false}}, {$set: {restaurant: restaurant._id}})
  ]);
}

async function backfillCatalogRows() {
  const rows = await SupplierIngredient.find({
    $or: [
      {purchaseUnit: {$exists: false}},
      {baseUnit: {$exists: false}},
      {conversionFactor: {$exists: false}},
      {minOrderQty: {$exists: false}}
    ]
  }).lean();

  for (const row of rows) {
    const ingredient = await Ingredient.findById(row.ingredient).select('unit').lean();
    const baseUnit = String(ingredient?.unit || row.unit || 'each').trim().toLowerCase();
    const purchaseUnit = String(row.purchaseUnit || row.unit || baseUnit).trim().toLowerCase();
    await SupplierIngredient.collection.updateOne({_id: row._id}, {$set: {
      purchaseUnit,
      baseUnit,
      conversionFactor: Number(row.conversionFactor || 1),
      minOrderQty: Number(row.minOrderQty || 1),
      priceIncludesVat: Boolean(row.priceIncludesVat),
      vatRate: Number(row.vatRate ?? 13)
    }});
  }
}

async function ensureTenantSupplierIndex() {
  await createCollection(Supplier.collection.collectionName);
  const suppliers = await Supplier.find().select('+nameNormalized restaurant name').lean();
  const seen = new Set();
  const writes = [];
  for (const supplier of suppliers) {
    if (!supplier.restaurant) {
      throw new Error(`Supplier ${supplier._id} cannot be safely assigned to a restaurant`);
    }
    const normalized = String(supplier.name || '').trim().replace(/\s+/g, ' ').toUpperCase();
    if (!normalized) throw new Error(`Supplier ${supplier._id} has no valid name`);
    const identity = `${supplier.restaurant}:${normalized}`;
    if (seen.has(identity)) {
      throw new Error(`Duplicate supplier name ${supplier.name} must be resolved before migration`);
    }
    seen.add(identity);
    if (supplier.nameNormalized !== normalized) {
      writes.push({updateOne: {filter: {_id: supplier._id}, update: {$set: {nameNormalized: normalized}}}});
    }
  }
  if (writes.length) await Supplier.collection.bulkWrite(writes);
  await Supplier.collection.createIndex(
    {restaurant: 1, nameNormalized: 1},
    {
      unique: true,
      name: 'supplier_restaurant_name',
      partialFilterExpression: {restaurant: {$type: 'objectId'}, nameNormalized: {$type: 'string'}}
    }
  );
  await Supplier.collection.createIndex(
    {restaurant: 1, active: 1, name: 1},
    {name: 'supplier_restaurant_active_name'}
  );
}

async function ensureTenantIngredientCodeIndex() {
  await createCollection(Ingredient.collection.collectionName);
  const indexes = await Ingredient.collection.indexes();
  if (indexes.some(index => index.name === 'code_1')) {
    await Ingredient.collection.dropIndex('code_1');
  }
  await Ingredient.collection.createIndex(
    {restaurant: 1, code: 1},
    {
      unique: true,
      name: 'ingredient_restaurant_code',
      partialFilterExpression: {restaurant: {$type: 'objectId'}, code: {$type: 'string'}}
    }
  );
}

async function backfillPriceHistory() {
  const rows = await SupplierIngredient.find({restaurant: {$exists: true}}).lean();
  for (const row of rows) {
    if (await SupplierPriceHistory.exists({catalogItem: row._id})) continue;
    await SupplierPriceHistory.create({
      restaurant: row.restaurant,
      catalogItem: row._id,
      supplier: row.supplier,
      ingredient: row.ingredient,
      price: Number(row.currentPrice || 0),
      purchaseUnit: row.purchaseUnit || row.unit || row.baseUnit || 'each',
      baseUnit: row.baseUnit || row.unit || row.purchaseUnit || 'each',
      conversionFactor: Number(row.conversionFactor || 1),
      priceIncludesVat: Boolean(row.priceIncludesVat),
      vatRate: Number(row.vatRate ?? 13),
      reason: 'Migrated opening catalog price',
      effectiveAt: row.createdAt || new Date()
    });
  }
}

async function migrate() {
  if (mongoose.connection.readyState !== 1) return;
  await createCollection(SupplierIngredient.collection.collectionName);
  await createCollection(SupplierPriceHistory.collection.collectionName);
  await backfillSingleRestaurant();
  await ensureTenantSupplierIndex();
  await ensureTenantIngredientCodeIndex();
  await backfillCatalogRows();
  await backfillPriceHistory();

  const catalog = SupplierIngredient.collection;
  await catalog.createIndex(
    {restaurant: 1, supplier: 1, ingredient: 1},
    {unique: true, name: 'catalog_restaurant_supplier_ingredient'}
  );
  await catalog.createIndex(
    {restaurant: 1, supplier: 1, supplierSku: 1},
    {
      unique: true,
      name: 'catalog_restaurant_supplier_sku',
      partialFilterExpression: {supplierSku: {$type: 'string'}}
    }
  );
  await catalog.createIndex(
    {restaurant: 1, active: 1, updatedAt: -1},
    {name: 'catalog_restaurant_active_updated'}
  );
  await SupplierPriceHistory.collection.createIndex(
    {catalogItem: 1, effectiveAt: -1, _id: -1},
    {name: 'catalog_price_history'}
  );
  await SupplierPriceHistory.collection.createIndex(
    {restaurant: 1, supplier: 1, effectiveAt: -1},
    {name: 'catalog_supplier_price_history'}
  );
}

export function ensureSupplierCatalogIndexes() {
  if (!running) running = migrate().catch(error => {
    running = null;
    throw error;
  });
  return running;
}
