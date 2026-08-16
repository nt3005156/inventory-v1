import mongoose from 'mongoose';
const {Schema,model}=mongoose;
const n={type:Number,default:0}; const oid={type:Schema.Types.ObjectId};
export const Restaurant=model('Restaurant',new Schema({name:{type:String,required:true},currency:{type:String,default:'NPR'},vatRate:{type:Number,default:13},serviceChargeRate:{type:Number,default:0},phone:String,address:String},{timestamps:true}));
export const Branch=model('Branch',new Schema({restaurant:{...oid,ref:'Restaurant',index:true},name:{type:String,required:true},code:{type:String,uppercase:true},address:String,phone:String,active:{type:Boolean,default:true}},{timestamps:true}));
export const InventoryBalance=model('InventoryBalance',new Schema({branch:{...oid,ref:'Branch',index:true},ingredient:{...oid,ref:'Ingredient',index:true},quantity:n,reserved:n,averageCost:n,minLevel:n,reorderLevel:n,maxLevel:n,storageLocation:{type:String,default:'Main Store'}},{timestamps:true}));
InventoryBalance.schema.index({branch:1,ingredient:1,storageLocation:1},{unique:true});
const inventoryBatchSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,immutable:true,index:true},
  branch:{...oid,ref:'Branch',required:true,immutable:true,index:true},
  ingredient:{...oid,ref:'Ingredient',required:true,immutable:true,index:true},
  lotKey:{type:String,required:true,trim:true,maxlength:300,immutable:true},
  batchNumber:{type:String,trim:true,maxlength:120,immutable:true},
  batchNumberNormalized:{type:String,trim:true,maxlength:120,immutable:true},
  expiryDate:{type:Date,immutable:true},
  receivedAt:{type:Date,default:Date.now,required:true,immutable:true},
  sourceType:{type:String,enum:['goods_receipt','transfer','adjustment','opening','reversal','legacy','untracked'],required:true,immutable:true},
  sourceId:{...oid,immutable:true},
  sourceLine:{...oid,immutable:true},
  supplier:{...oid,ref:'Supplier',immutable:true},
  unit:{type:String,trim:true,maxlength:30,immutable:true},
  unitCost:{type:Number,default:0,min:0},
  initialQuantity:{type:Number,default:0,min:0},
  quantity:{type:Number,default:0,min:0}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
inventoryBatchSchema.index({restaurant:1,branch:1,ingredient:1,lotKey:1},{unique:true,name:'inventory_batch_lot_key'});
inventoryBatchSchema.index({restaurant:1,branch:1,expiryDate:1,quantity:1},{name:'inventory_batch_expiry_quantity'});
inventoryBatchSchema.index({restaurant:1,branch:1,ingredient:1,batchNumberNormalized:1,quantity:1},{name:'inventory_batch_lookup'});
export const InventoryBatch=model('InventoryBatch',inventoryBatchSchema);
const inventoryBatchMovementSchema=new Schema({
  batch:{...oid,ref:'InventoryBatch',required:true,immutable:true},
  batchNumber:{type:String,trim:true,maxlength:120,immutable:true},
  expiryDate:{type:Date,immutable:true},
  previousQty:{type:Number,required:true,immutable:true},
  changeQty:{type:Number,required:true,immutable:true},
  newQty:{type:Number,required:true,immutable:true},
  unitCost:{type:Number,default:0,min:0,immutable:true}
},{_id:false});
const inventoryTransactionSchema=new Schema({branch:{...oid,ref:'Branch',index:true},ingredient:{...oid,ref:'Ingredient',index:true},type:{type:String,enum:['OPENING','PURCHASE','SALE','RECIPE_DEDUCTION','RECIPE_REVERSAL','WASTE','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT','RETURN'],required:true},previousQty:n,changeQty:n,newQty:n,unit:String,unitCost:n,totalCost:n,reason:String,referenceType:String,referenceId:oid,user:{...oid,ref:'User'},batchMovements:{type:[inventoryBatchMovementSchema],default:undefined,immutable:true},idempotencyKey:{type:String,trim:true},idempotencyHash:{type:String,trim:true,immutable:true}},{timestamps:true});
inventoryTransactionSchema.index({branch:1,idempotencyKey:1},{unique:true,partialFilterExpression:{idempotencyKey:{$type:'string'}},name:'inventory_transaction_branch_idempotency'});
export const InventoryTransaction=model('InventoryTransaction',inventoryTransactionSchema);
export const RestaurantTable=model('RestaurantTable',new Schema({branch:{...oid,ref:'Branch',index:true},name:String,area:String,seats:n,status:{type:String,enum:['available','occupied','reserved','cleaning','disabled'],default:'available'},active:{type:Boolean,default:true}},{timestamps:true}));
export const Customer=model('Customer',new Schema({branch:{...oid,ref:'Branch'},name:String,phone:{type:String,index:true},email:String,addresses:[{label:String,address:String,default:Boolean}],loyaltyPoints:n,totalSpend:n,lastOrderAt:Date},{timestamps:true}));
export const Order=model('Order',new Schema({orderNo:{type:String,index:true},branch:{...oid,ref:'Branch',index:true},customer:{...oid,ref:'Customer'},table:{...oid,ref:'RestaurantTable'},type:{type:String,enum:['dine-in','takeaway','pickup','delivery','online','counter'],default:'counter'},status:{type:String,enum:['draft','held','pending','confirmed','accepted','preparing','ready','out_for_delivery','completed','cancelled','refunded'],default:'pending',index:true},items:[{menuItem:{...oid,ref:'MenuItem'},name:String,qty:n,unitPrice:n,foodCost:n,notes:String,modifiers:[{name:String,price:n}],inventoryRequirements:[{ingredient:{...oid,ref:'Ingredient'},qty:n,unit:String}]}],inventorySourceOrder:{...oid,ref:'Order',index:true},inventorySourceOrders:[{...oid,ref:'Order'}],subtotal:n,discount:n,vatRate:{type:Number,default:13},vat:n,serviceCharge:n,deliveryFee:n,total:n,paidAmount:n,dueAmount:n,refundAmount:n,inventoryDeducted:{type:Boolean,default:false},inventoryReversed:{type:Boolean,default:false},createdBy:{...oid,ref:'User'}},{timestamps:true}));
Order.schema.index({inventorySourceOrders:1},{name:'order_inventory_source_orders'});
export const Payment=model('Payment',new Schema({order:{...oid,ref:'Order',index:true},amount:n,method:{type:String,enum:['cash','card','esewa','khalti','wallet','online'],default:'cash'},transactionId:String,status:{type:String,enum:['pending','paid','failed','refunded'],default:'paid'},cashier:{...oid,ref:'User'}},{timestamps:true}));
const purchaseOrderLineSchema=new Schema({
  ingredient:{...oid,ref:'Ingredient',required:true,immutable:true},
  catalogItem:{...oid,ref:'SupplierIngredient',immutable:true},
  supplierSku:{type:String,immutable:true},
  orderedQty:{type:Number,required:true,min:Number.EPSILON,immutable:true},
  purchaseQty:{type:Number,min:Number.EPSILON,immutable:true},
  receivedQty:n,
  damagedQty:n,
  returnedQty:n,
  unit:{type:String,required:true,immutable:true},
  purchaseUnit:{type:String,immutable:true},
  conversionFactor:{type:Number,default:1,min:Number.EPSILON,immutable:true},
  unitPrice:{type:Number,required:true,min:0,immutable:true},
  catalogPrice:{type:Number,min:0,immutable:true},
  priceIncludesVat:{type:Boolean,default:false,immutable:true},
  vatRate:{type:Number,default:13,min:0,max:100,immutable:true},
  minOrderQty:{type:Number,min:0,immutable:true},
  leadDays:{type:Number,min:0,max:365,immutable:true},
  lineSubtotal:{type:Number,default:0,min:0,immutable:true},
  lineVat:{type:Number,default:0,min:0,immutable:true},
  lineTotal:{type:Number,default:0,min:0,immutable:true}
},{_id:true});
const purchaseOrderSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,index:true,immutable:true},
  poNo:{type:String,required:true,trim:true,index:true,immutable:true},
  numberVersion:{type:Number,default:2,immutable:true},
  branch:{...oid,ref:'Branch',required:true,index:true,immutable:true},
  supplier:{...oid,ref:'Supplier',required:true,index:true,immutable:true},
  status:{type:String,enum:['draft','pending','approved','rejected','sent','partially_received','received','closed_short','cancelled'],default:'draft',index:true},
  orderDate:{type:Date,default:Date.now,required:true,immutable:true},
  expectedDeliveryDate:{type:Date,immutable:true},
  deliveryAddress:{type:String,trim:true,maxlength:500,immutable:true},
  submittedBy:{...oid,ref:'User'},
  submittedAt:Date,
  submissionNote:{type:String,trim:true,maxlength:1000},
  approvalRound:{type:Number,default:0,min:0},
  approvedBy:{...oid,ref:'User'},
  approvedAt:Date,
  approvalNote:{type:String,trim:true,maxlength:1000},
  rejectedBy:{...oid,ref:'User'},
  rejectedAt:Date,
  rejectionReason:{type:String,trim:true,maxlength:1000},
  shortClosedBy:{...oid,ref:'User'},
  shortClosedAt:Date,
  shortCloseReason:{type:String,trim:true,maxlength:1000},
  shortCloseIdempotencyKey:{type:String,trim:true,maxlength:120,select:false},
  shortCloseRequestHash:{type:String,select:false},
  items:{type:[purchaseOrderLineSchema],validate:[items=>items.length>0,'At least one purchase order item is required']},
  subtotal:{type:Number,default:0,min:0,immutable:true},
  vat:{type:Number,default:0,min:0,immutable:true},
  total:{type:Number,default:0,min:0,immutable:true},
  notes:{type:String,trim:true,maxlength:1000,immutable:true},
  requestKey:{type:String,trim:true,maxlength:120,immutable:true},
  requestHash:{type:String,select:false,immutable:true},
  createdBy:{...oid,ref:'User',required:true,immutable:true},
  updatedBy:{...oid,ref:'User'}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
purchaseOrderSchema.index({restaurant:1,poNo:1},{unique:true,name:'po_restaurant_number_v2',partialFilterExpression:{numberVersion:2}});
purchaseOrderSchema.index({restaurant:1,requestKey:1},{unique:true,name:'po_restaurant_request_key',partialFilterExpression:{requestKey:{$type:'string'}}});
purchaseOrderSchema.index({restaurant:1,shortCloseIdempotencyKey:1},{unique:true,name:'po_restaurant_short_close_key',partialFilterExpression:{shortCloseIdempotencyKey:{$type:'string'}}});
purchaseOrderSchema.index({restaurant:1,branch:1,status:1,createdAt:-1},{name:'po_restaurant_branch_status_created'});
purchaseOrderSchema.index({restaurant:1,supplier:1,createdAt:-1},{name:'po_restaurant_supplier_created'});
export const PurchaseOrder=model('PurchaseOrder',purchaseOrderSchema);
const purchaseOrderCounterSchema=new Schema({restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},branch:{...oid,ref:'Branch',required:true,immutable:true},branchCode:{type:String,required:true,trim:true,uppercase:true,maxlength:8,immutable:true},year:{type:Number,required:true,immutable:true},value:{type:Number,default:0,min:0}},{timestamps:true,autoIndex:false});
purchaseOrderCounterSchema.index({restaurant:1,branchCode:1,year:1},{unique:true,name:'po_counter_scope'});
export const PurchaseOrderCounter=model('PurchaseOrderCounter',purchaseOrderCounterSchema);
const supplierInvoiceMatchSchema=new Schema({
  status:{type:String,enum:['unlinked','awaiting_receipt','partial','matched','over_billed'],required:true},
  receivedSubtotal:{type:Number,default:0,min:0},receivedVat:{type:Number,default:0,min:0},receivedTotal:{type:Number,default:0,min:0},
  returnedSubtotal:{type:Number,default:0,min:0},returnedVat:{type:Number,default:0,min:0},returnedTotal:{type:Number,default:0,min:0},
  netReceivedSubtotal:{type:Number,default:0,min:0},netReceivedVat:{type:Number,default:0,min:0},netReceivedTotal:{type:Number,default:0,min:0},
  previouslyInvoicedSubtotal:{type:Number,default:0,min:0},previouslyInvoicedVat:{type:Number,default:0,min:0},previouslyInvoicedTotal:{type:Number,default:0,min:0},
  availableSubtotal:{type:Number,default:0,min:0},availableVat:{type:Number,default:0,min:0},availableTotal:{type:Number,default:0,min:0},
  varianceSubtotal:{type:Number,default:0},varianceVat:{type:Number,default:0},varianceTotal:{type:Number,default:0},
  receiptIds:[{...oid,ref:'GoodsReceipt'}],returnIds:[{...oid,ref:'PurchaseReturn'}],matchedAt:{type:Date,required:true}
},{_id:false});
const supplierInvoiceSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},
  branch:{...oid,ref:'Branch',required:true,immutable:true},
  supplier:{...oid,ref:'Supplier',required:true},
  purchaseOrder:{...oid,ref:'PurchaseOrder'},
  invoiceNo:{type:String,required:true,trim:true,maxlength:120},
  invoiceNoNormalized:{type:String,required:true,trim:true,maxlength:120},
  identityVersion:{type:Number,default:2,immutable:true},
  invoiceDate:{type:Date,required:true,default:Date.now},
  dueDate:Date,
  currency:{type:String,default:'NPR',enum:['NPR'],immutable:true},
  priceIncludesVat:{type:Boolean,default:false},
  vatRate:{type:Number,default:13,min:0,max:100},
  subtotal:{type:Number,required:true,min:0},
  vat:{type:Number,required:true,min:0},
  total:{type:Number,required:true,min:Number.EPSILON},
  paidAmount:{type:Number,default:0,min:0},
  status:{type:String,enum:['unpaid','partial','paid','void'],default:'unpaid'},
  matching:{type:supplierInvoiceMatchSchema,required:true},
  attachmentUrl:{type:String,trim:true,maxlength:1000},
  notes:{type:String,trim:true,maxlength:1000},
  idempotencyKey:{type:String,trim:true,maxlength:120,select:false,immutable:true},
  requestHash:{type:String,select:false,immutable:true},
  requestHashVersion:{type:Number,default:2,select:false,immutable:true},
  createdBy:{...oid,ref:'User',required:true,immutable:true},
  updatedBy:{...oid,ref:'User'},
  voidedBy:{...oid,ref:'User'},
  voidedAt:Date
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
supplierInvoiceSchema.pre('validate',function validateSupplierInvoice(){
  const paid=Number(this.paidAmount||0),total=Number(this.total||0);
  if(Math.abs(total-Number(this.subtotal||0)-Number(this.vat||0))>0.011)this.invalidate('total','Invoice total must equal subtotal plus VAT');
  if(paid>total+0.011)this.invalidate('paidAmount','Paid amount cannot exceed invoice total');
  if(this.status==='paid'&&paid+0.011<total)this.invalidate('status','Paid invoices must be fully paid');
  if(this.status==='unpaid'&&paid>0.011)this.invalidate('status','An invoice with payments cannot be unpaid');
  if(this.status==='partial'&&(paid<=0.011||paid+0.011>=total))this.invalidate('status','Partial invoices require a positive balance and a partial payment');
  if(this.dueDate&&this.invoiceDate&&this.dueDate<this.invoiceDate)this.invalidate('dueDate','Due date cannot be before invoice date');
});
supplierInvoiceSchema.virtual('paymentCount',{ref:'SupplierPayment',localField:'_id',foreignField:'invoice',count:true});
supplierInvoiceSchema.set('toJSON',{virtuals:true,transform:(_document,result)=>{delete result.idempotencyKey;delete result.requestHash;delete result.requestHashVersion;delete result.id;return result;}});
supplierInvoiceSchema.index({restaurant:1,supplier:1,invoiceNoNormalized:1},{unique:true,name:'supplier_invoice_restaurant_supplier_number'});
supplierInvoiceSchema.index({restaurant:1,idempotencyKey:1},{unique:true,name:'supplier_invoice_restaurant_idempotency',partialFilterExpression:{idempotencyKey:{$type:'string'}}});
supplierInvoiceSchema.index({restaurant:1,branch:1,status:1,invoiceDate:-1},{name:'supplier_invoice_restaurant_branch_status_date'});
supplierInvoiceSchema.index({restaurant:1,purchaseOrder:1,status:1},{name:'supplier_invoice_restaurant_po_status'});
export const SupplierInvoice=model('SupplierInvoice',supplierInvoiceSchema);
export const SupplierPayment=model('SupplierPayment',new Schema({invoice:{...oid,ref:'SupplierInvoice',index:true},supplier:{...oid,ref:'Supplier'},amount:n,method:{type:String,enum:['cash','bank','esewa','khalti','card'],default:'cash'},reference:String,paidAt:{type:Date,default:Date.now},createdBy:{...oid,ref:'User'}},{timestamps:true}));
export const StockTransfer=model('StockTransfer',new Schema({fromBranch:{...oid,ref:'Branch'},toBranch:{...oid,ref:'Branch'},ingredient:{...oid,ref:'Ingredient'},qty:n,unit:String,status:{type:String,enum:['requested','approved','in_transit','received','cancelled'],default:'requested'},requestedBy:{...oid,ref:'User'},approvedBy:{...oid,ref:'User'}},{timestamps:true}));
export const Delivery=model('Delivery',new Schema({order:{...oid,ref:'Order'},rider:{...oid,ref:'User'},address:String,phone:String,status:{type:String,enum:['available','assigned','picking_up','out_for_delivery','delivered','cancelled'],default:'assigned'},estimatedMinutes:n},{timestamps:true}));
export const Notification=model('Notification',new Schema({branch:{...oid,ref:'Branch'},user:{...oid,ref:'User'},type:String,title:String,body:String,read:{type:Boolean,default:false},referenceId:oid},{timestamps:true}));
