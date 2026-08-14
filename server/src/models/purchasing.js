import mongoose from 'mongoose';
const {Schema, model} = mongoose;
const n = {type: Number, default: 0};
const oid = {type: Schema.Types.ObjectId};

const receiptLineSchema = new Schema({
  poItem: {...oid, required: true, immutable: true},
  ingredient: {...oid, ref: 'Ingredient', required: true, immutable: true},
  receivedQty: {type: Number, required: true, min: 0, immutable: true},
  damagedQty: {type: Number, required: true, min: 0, immutable: true},
  acceptedQty: {type: Number, required: true, min: 0, immutable: true},
  unit: {type: String, required: true, trim: true, maxlength: 30, immutable: true},
  unitPrice: {type: Number, required: true, min: 0, immutable: true},
  batchNumber: {type: String, trim: true, maxlength: 120, immutable: true},
  expiryDate: {type: Date, immutable: true}
}, {_id: true});

const goodsReceiptSchema = new Schema({
  restaurant: {...oid, ref: 'Restaurant', required: true, immutable: true},
  branch: {...oid, ref: 'Branch', required: true, immutable: true},
  supplier: {...oid, ref: 'Supplier', required: true, immutable: true},
  purchaseOrder: {...oid, ref: 'PurchaseOrder', required: true, immutable: true},
  receiptNo: {type: String, required: true, trim: true, maxlength: 40, immutable: true},
  numberVersion: {type: Number, default: 2, immutable: true},
  receivedAt: {type: Date, required: true, default: Date.now, immutable: true},
  notes: {type: String, trim: true, maxlength: 1000, immutable: true},
  idempotencyKey: {type: String, trim: true, maxlength: 120, select: false, immutable: true},
  requestHash: {type: String, select: false, immutable: true},
  receivedBy: {...oid, ref: 'User', required: true, immutable: true},
  receivedValue: {type: Number, required: true, min: 0, immutable: true},
  acceptedValue: {type: Number, required: true, min: 0, immutable: true},
  damagedValue: {type: Number, required: true, min: 0, immutable: true},
  items: {
    type: [receiptLineSchema],
    validate: [items => Array.isArray(items) && items.length > 0, 'At least one receipt item is required']
  }
}, {timestamps: true, autoIndex: false});
goodsReceiptSchema.set('toJSON', {
  transform: (_document, result) => {
    delete result.idempotencyKey;
    delete result.requestHash;
    return result;
  }
});
goodsReceiptSchema.index(
  {restaurant: 1, receiptNo: 1},
  {unique: true, name: 'gr_restaurant_number_v2', partialFilterExpression: {numberVersion: 2}}
);
goodsReceiptSchema.index(
  {restaurant: 1, idempotencyKey: 1},
  {unique: true, name: 'gr_restaurant_idempotency_key', partialFilterExpression: {idempotencyKey: {$type: 'string'}}}
);
goodsReceiptSchema.index(
  {restaurant: 1, branch: 1, purchaseOrder: 1, createdAt: -1},
  {name: 'gr_restaurant_branch_po_created'}
);
export const GoodsReceipt = model('GoodsReceipt', goodsReceiptSchema);

const goodsReceiptCounterSchema = new Schema({
  restaurant: {...oid, ref: 'Restaurant', required: true, immutable: true},
  branch: {...oid, ref: 'Branch', required: true, immutable: true},
  branchCode: {type: String, required: true, trim: true, uppercase: true, maxlength: 8, immutable: true},
  year: {type: Number, required: true, immutable: true},
  value: {type: Number, default: 0, min: 0}
}, {timestamps: true, autoIndex: false});
goodsReceiptCounterSchema.index(
  {restaurant: 1, branchCode: 1, year: 1},
  {unique: true, name: 'gr_counter_scope'}
);
export const GoodsReceiptCounter = model('GoodsReceiptCounter', goodsReceiptCounterSchema);

export const PurchaseReturn = model('PurchaseReturn', new Schema({
  returnNo: {type: String, index: true},
  purchaseOrder: {...oid, ref: 'PurchaseOrder', required: true, index: true},
  branch: {...oid, ref: 'Branch', index: true},
  supplier: {...oid, ref: 'Supplier'},
  reason: {type: String, enum: ['quality', 'wrong_item', 'expired', 'overstock', 'damaged', 'other'], default: 'quality'},
  notes: String,
  idempotencyKey: {type: String, sparse: true, unique: true},
  returnedBy: {...oid, ref: 'User'},
  items: [{
    poItem: oid,
    ingredient: {...oid, ref: 'Ingredient'},
    qty: n,
    unit: String,
    unitCost: n,
    batchNumber: String
  }]
}, {timestamps: true}));
