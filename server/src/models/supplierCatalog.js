import mongoose from 'mongoose';

const {Schema, model} = mongoose;
const oid = {type: Schema.Types.ObjectId};

const supplierIngredientSchema = new Schema({
  restaurant: {...oid, ref: 'Restaurant', required: true, index: true, immutable: true},
  supplier: {...oid, ref: 'Supplier', required: true, index: true, immutable: true},
  ingredient: {...oid, ref: 'Ingredient', required: true, index: true, immutable: true},
  supplierSku: {type: String, trim: true, uppercase: true, maxlength: 80},
  purchaseUnit: {type: String, required: true, trim: true, lowercase: true, maxlength: 30},
  baseUnit: {type: String, required: true, trim: true, lowercase: true, maxlength: 30, immutable: true},
  conversionFactor: {type: Number, required: true, min: Number.EPSILON, default: 1},
  currentPrice: {type: Number, required: true, min: 0},
  previousPrice: {type: Number, default: 0, min: 0},
  priceIncludesVat: {type: Boolean, default: false},
  vatRate: {type: Number, default: 13, min: 0, max: 100},
  minOrderQty: {type: Number, default: 1, min: Number.EPSILON},
  leadDays: {type: Number, default: 1, min: 0, max: 365},
  active: {type: Boolean, default: true, index: true},
  createdBy: {...oid, ref: 'User', immutable: true},
  updatedBy: {...oid, ref: 'User'}
}, {
  timestamps: true,
  autoIndex: false,
  optimisticConcurrency: true,
  toJSON: {virtuals: true},
  toObject: {virtuals: true}
});

supplierIngredientSchema.virtual('baseUnitPrice').get(function baseUnitPrice() {
  return this.conversionFactor ? this.currentPrice / this.conversionFactor : 0;
});

supplierIngredientSchema.index({restaurant: 1, supplier: 1, ingredient: 1}, {unique: true, name: 'catalog_restaurant_supplier_ingredient'});
supplierIngredientSchema.index(
  {restaurant: 1, supplier: 1, supplierSku: 1},
  {
    unique: true,
    name: 'catalog_restaurant_supplier_sku',
    partialFilterExpression: {supplierSku: {$type: 'string'}}
  }
);
supplierIngredientSchema.index({restaurant: 1, active: 1, updatedAt: -1}, {name: 'catalog_restaurant_active_updated'});

const supplierPriceHistorySchema = new Schema({
  restaurant: {...oid, ref: 'Restaurant', required: true, index: true, immutable: true},
  catalogItem: {...oid, ref: 'SupplierIngredient', required: true, index: true, immutable: true},
  supplier: {...oid, ref: 'Supplier', required: true, immutable: true},
  ingredient: {...oid, ref: 'Ingredient', required: true, immutable: true},
  price: {type: Number, required: true, min: 0, immutable: true},
  purchaseUnit: {type: String, required: true, immutable: true},
  baseUnit: {type: String, required: true, immutable: true},
  conversionFactor: {type: Number, required: true, min: Number.EPSILON, immutable: true},
  priceIncludesVat: {type: Boolean, default: false, immutable: true},
  vatRate: {type: Number, default: 13, min: 0, max: 100, immutable: true},
  reason: {type: String, trim: true, maxlength: 240, immutable: true},
  changedBy: {...oid, ref: 'User', immutable: true},
  effectiveAt: {type: Date, default: Date.now, immutable: true}
}, {timestamps: true, autoIndex: false});

supplierPriceHistorySchema.index({catalogItem: 1, effectiveAt: -1, _id: -1}, {name: 'catalog_price_history'});
supplierPriceHistorySchema.index({restaurant: 1, supplier: 1, effectiveAt: -1}, {name: 'catalog_supplier_price_history'});

export const SupplierIngredient = model('SupplierIngredient', supplierIngredientSchema);
export const SupplierPriceHistory = model('SupplierPriceHistory', supplierPriceHistorySchema);
