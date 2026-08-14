import mongoose from 'mongoose';
const {Schema,model}=mongoose;
const n={type:Number,default:0}; const oid={type:Schema.Types.ObjectId};
export const Restaurant=model('Restaurant',new Schema({name:{type:String,required:true},currency:{type:String,default:'NPR'},vatRate:{type:Number,default:13},serviceChargeRate:{type:Number,default:0},phone:String,address:String},{timestamps:true}));
export const Branch=model('Branch',new Schema({restaurant:{...oid,ref:'Restaurant',index:true},name:{type:String,required:true},code:{type:String,uppercase:true},address:String,phone:String,active:{type:Boolean,default:true}},{timestamps:true}));
export const InventoryBalance=model('InventoryBalance',new Schema({branch:{...oid,ref:'Branch',index:true},ingredient:{...oid,ref:'Ingredient',index:true},quantity:n,reserved:n,averageCost:n,minLevel:n,reorderLevel:n,maxLevel:n,storageLocation:{type:String,default:'Main Store'},expiryDate:Date,batchNumber:String},{timestamps:true}));
InventoryBalance.schema.index({branch:1,ingredient:1,storageLocation:1},{unique:true});
export const InventoryTransaction=model('InventoryTransaction',new Schema({branch:{...oid,ref:'Branch',index:true},ingredient:{...oid,ref:'Ingredient',index:true},type:{type:String,enum:['OPENING','PURCHASE','SALE','RECIPE_DEDUCTION','RECIPE_REVERSAL','WASTE','TRANSFER_OUT','TRANSFER_IN','ADJUSTMENT','RETURN'],required:true},previousQty:n,changeQty:n,newQty:n,unit:String,unitCost:n,totalCost:n,reason:String,referenceType:String,referenceId:oid,user:{...oid,ref:'User'},idempotencyKey:{type:String,sparse:true,unique:true}},{timestamps:true}));
export const RestaurantTable=model('RestaurantTable',new Schema({branch:{...oid,ref:'Branch',index:true},name:String,area:String,seats:n,status:{type:String,enum:['available','occupied','reserved','cleaning','disabled'],default:'available'},active:{type:Boolean,default:true}},{timestamps:true}));
export const Customer=model('Customer',new Schema({branch:{...oid,ref:'Branch'},name:String,phone:{type:String,index:true},email:String,addresses:[{label:String,address:String,default:Boolean}],loyaltyPoints:n,totalSpend:n,lastOrderAt:Date},{timestamps:true}));
export const Order=model('Order',new Schema({orderNo:{type:String,index:true},branch:{...oid,ref:'Branch',index:true},customer:{...oid,ref:'Customer'},table:{...oid,ref:'RestaurantTable'},type:{type:String,enum:['dine-in','takeaway','pickup','delivery','online','counter'],default:'counter'},status:{type:String,enum:['draft','held','pending','confirmed','accepted','preparing','ready','out_for_delivery','completed','cancelled','refunded'],default:'pending',index:true},items:[{menuItem:{...oid,ref:'MenuItem'},name:String,qty:n,unitPrice:n,foodCost:n,notes:String,modifiers:[{name:String,price:n}]}],subtotal:n,discount:n,vatRate:{type:Number,default:13},vat:n,serviceCharge:n,deliveryFee:n,total:n,paidAmount:n,dueAmount:n,refundAmount:n,inventoryDeducted:{type:Boolean,default:false},inventoryReversed:{type:Boolean,default:false},createdBy:{...oid,ref:'User'}},{timestamps:true}));
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
  status:{type:String,enum:['draft','pending','approved','rejected','sent','partially_received','received','cancelled'],default:'draft',index:true},
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
purchaseOrderSchema.index({restaurant:1,branch:1,status:1,createdAt:-1},{name:'po_restaurant_branch_status_created'});
purchaseOrderSchema.index({restaurant:1,supplier:1,createdAt:-1},{name:'po_restaurant_supplier_created'});
export const PurchaseOrder=model('PurchaseOrder',purchaseOrderSchema);
const purchaseOrderCounterSchema=new Schema({restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},branch:{...oid,ref:'Branch',required:true,immutable:true},branchCode:{type:String,required:true,trim:true,uppercase:true,maxlength:8,immutable:true},year:{type:Number,required:true,immutable:true},value:{type:Number,default:0,min:0}},{timestamps:true,autoIndex:false});
purchaseOrderCounterSchema.index({restaurant:1,branchCode:1,year:1},{unique:true,name:'po_counter_scope'});
export const PurchaseOrderCounter=model('PurchaseOrderCounter',purchaseOrderCounterSchema);
export const SupplierInvoice=model('SupplierInvoice',new Schema({branch:{...oid,ref:'Branch',index:true},supplier:{...oid,ref:'Supplier',index:true},purchaseOrder:{...oid,ref:'PurchaseOrder'},invoiceNo:{type:String,index:true},invoiceDate:Date,dueDate:Date,subtotal:n,vat:n,total:n,paidAmount:n,status:{type:String,enum:['unpaid','partial','paid','void'],default:'unpaid'},attachmentUrl:String,notes:String,createdBy:{...oid,ref:'User'}},{timestamps:true}));
export const SupplierPayment=model('SupplierPayment',new Schema({invoice:{...oid,ref:'SupplierInvoice',index:true},supplier:{...oid,ref:'Supplier'},amount:n,method:{type:String,enum:['cash','bank','esewa','khalti','card'],default:'cash'},reference:String,paidAt:{type:Date,default:Date.now},createdBy:{...oid,ref:'User'}},{timestamps:true}));
export const StockTransfer=model('StockTransfer',new Schema({fromBranch:{...oid,ref:'Branch'},toBranch:{...oid,ref:'Branch'},ingredient:{...oid,ref:'Ingredient'},qty:n,unit:String,status:{type:String,enum:['requested','approved','in_transit','received','cancelled'],default:'requested'},requestedBy:{...oid,ref:'User'},approvedBy:{...oid,ref:'User'}},{timestamps:true}));
export const Delivery=model('Delivery',new Schema({order:{...oid,ref:'Order'},rider:{...oid,ref:'User'},address:String,phone:String,status:{type:String,enum:['available','assigned','picking_up','out_for_delivery','delivered','cancelled'],default:'assigned'},estimatedMinutes:n},{timestamps:true}));
export const Notification=model('Notification',new Schema({branch:{...oid,ref:'Branch'},user:{...oid,ref:'User'},type:String,title:String,body:String,read:{type:Boolean,default:false},referenceId:oid},{timestamps:true}));
