import mongoose from 'mongoose';
const {Schema, model} = mongoose;
const n = {type: Number, default: 0};
const oid = {type: Schema.Types.ObjectId};

export const GoodsReceipt = model('GoodsReceipt', new Schema({
  receiptNo: {type: String, index: true},
  purchaseOrder: {...oid, ref: 'PurchaseOrder', required: true, index: true},
  branch: {...oid, ref: 'Branch', index: true},
  supplier: {...oid, ref: 'Supplier'},
  notes: String,
  idempotencyKey: {type: String, sparse: true, unique: true},
  receivedBy: {...oid, ref: 'User'},
  items: [{
    poItem: oid,
    ingredient: {...oid, ref: 'Ingredient'},
    receivedQty: n,
    damagedQty: n,
    acceptedQty: n,
    unit: String,
    unitPrice: n,
    batchNumber: String,
    expiryDate: Date
  }]
}, {timestamps: true}));

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
