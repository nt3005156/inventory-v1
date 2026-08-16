import mongoose from 'mongoose';
const {Schema,model}=mongoose;
const n={type:Number,default:0}; const oid={type:Schema.Types.ObjectId};
export const Restaurant=model('Restaurant',new Schema({name:{type:String,required:true},currency:{type:String,default:'NPR'},vatRate:{type:Number,default:13},serviceChargeRate:{type:Number,default:0},phone:String,address:String},{timestamps:true}));
export const Branch=model('Branch',new Schema({restaurant:{...oid,ref:'Restaurant',index:true},name:{type:String,required:true},code:{type:String,uppercase:true},address:String,phone:String,active:{type:Boolean,default:true}},{timestamps:true}));
const inventoryBalanceSchema=new Schema({
  branch:{...oid,ref:'Branch',required:true,index:true},
  ingredient:{...oid,ref:'Ingredient',required:true,index:true},
  quantity:{type:Number,default:0,min:0},
  reserved:n,
  averageCost:{type:Number,default:0,min:0},
  ledgerVersion:{type:Number,default:0,min:0,validate:{validator:Number.isSafeInteger,message:'Inventory ledger version must be a nonnegative safe integer'}},
  minLevel:n,
  reorderLevel:n,
  maxLevel:n,
  storageLocation:{type:String,default:'Main Store'}
},{timestamps:true});
inventoryBalanceSchema.index({branch:1,ingredient:1,storageLocation:1},{unique:true});
const stockFields=new Set(['quantity','averageCost','ledgerVersion']);
function inventoryBalanceChangesStock(update={}){
  return Object.entries(update).some(([operator,value])=>{
    if(stockFields.has(operator))return true;
    return operator.startsWith('$')&&value&&Object.keys(value).some(path=>stockFields.has(path.split('.')[0]));
  });
}
inventoryBalanceSchema.pre('save',function preventSilentBalanceSave(next,options){
  const changesStock=this.isNew
    ? ['quantity','averageCost','ledgerVersion'].some(path=>Number(this[path]||0)!==0)
    : ['quantity','averageCost','ledgerVersion'].some(path=>this.isModified(path));
  if(changesStock&&!options?.inventoryLedgerWrite)return next(Object.assign(new Error('Inventory quantities, costs, and revisions may only be changed by the inventory ledger service'),{status:409}));
  next();
});
inventoryBalanceSchema.pre(['updateOne','updateMany','findOneAndUpdate','replaceOne'],function preventSilentBalanceUpdate(next){
  if(inventoryBalanceChangesStock(this.getUpdate())&&!this.getOptions().inventoryLedgerWrite)return next(Object.assign(new Error('Inventory quantities, costs, and revisions may only be changed by the inventory ledger service'),{status:409}));
  next();
});
inventoryBalanceSchema.pre(['deleteOne','deleteMany','findOneAndDelete'],function preventSilentBalanceDelete(next){
  if(!this.getOptions().inventoryLedgerWrite)return next(Object.assign(new Error('Inventory balances may only be removed by an authorized inventory migration'),{status:409}));
  next();
});
inventoryBalanceSchema.pre(['insertMany','bulkWrite'],function preventSilentBalanceBulkWrite(next){
  next(Object.assign(new Error('Inventory balances may only be bulk-written by the inventory ledger service'),{status:409}));
});
export const InventoryBalance=model('InventoryBalance',inventoryBalanceSchema);
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
inventoryBatchSchema.pre('save',function preventSilentBatchSave(next,options){
  if(!options?.inventoryLedgerWrite)return next(Object.assign(new Error('Inventory batches may only be changed by the inventory ledger service'),{status:409}));
  next();
});
inventoryBatchSchema.pre(['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete'],function preventSilentBatchMutation(next){
  if(!this.getOptions().inventoryLedgerWrite)return next(Object.assign(new Error('Inventory batches may only be changed by the inventory ledger service'),{status:409}));
  next();
});
inventoryBatchSchema.pre(['insertMany','bulkWrite'],function preventSilentBatchBulkWrite(next){
  next(Object.assign(new Error('Inventory batches may only be bulk-written by the inventory ledger service'),{status:409}));
});
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
export const INVENTORY_MOVEMENT_TYPES=Object.freeze([
  'OPENING','PURCHASE','SALE','RECIPE_DEDUCTION','REVERSAL','WASTE','TRANSFER_OUT','TRANSFER_IN','RETURN','ADJUSTMENT'
]);
export const WASTE_CATEGORY_TYPES=Object.freeze([
  'expired','spoiled','damaged','burned','spilled','wrong_preparation','customer_return','other'
]);
const immutableQuantity={type:Number,required:true,immutable:true,validate:{validator:Number.isFinite,message:'Inventory quantity must be finite'}};
const inventoryTransactionSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,index:true,immutable:true},
  branch:{...oid,ref:'Branch',required:true,index:true,immutable:true},
  ingredient:{...oid,ref:'Ingredient',required:true,index:true,immutable:true},
  type:{type:String,enum:INVENTORY_MOVEMENT_TYPES,required:true,immutable:true},
  previousQty:immutableQuantity,
  changeQty:{...immutableQuantity,validate:[
    immutableQuantity.validate,
    {validator:value=>Math.abs(Number(value))>1e-9,message:'Inventory movement quantity cannot be zero'}
  ]},
  newQty:{...immutableQuantity,min:0},
  unit:{type:String,required:true,trim:true,maxlength:30,immutable:true},
  unitCost:{type:Number,required:true,min:0,immutable:true},
  totalCost:{type:Number,required:true,min:0,immutable:true},
  reason:{type:String,required:true,trim:true,minlength:3,maxlength:500,immutable:true},
  referenceType:{type:String,required:true,trim:true,minlength:2,maxlength:80,immutable:true},
  referenceId:{...oid,required:true,immutable:true},
  user:{...oid,ref:'User',required:true,immutable:true},
  wasteCategory:{type:String,enum:WASTE_CATEGORY_TYPES,immutable:true},
  wasteNotes:{type:String,trim:true,maxlength:2000,immutable:true},
  wasteBatch:{...oid,ref:'InventoryBatch',immutable:true},
  batchMovements:{type:[inventoryBatchMovementSchema],default:undefined,immutable:true},
  idempotencyKey:{type:String,required:true,trim:true,minlength:3,maxlength:200,immutable:true},
  idempotencyHash:{type:String,required:true,trim:true,match:/^[a-f0-9]{64}$/,immutable:true},
  idempotencyHashVersion:{type:Number,required:true,default:2,enum:[1,2],immutable:true},
  createdAt:{type:Date,default:Date.now,required:true,immutable:true}
},{timestamps:true,autoIndex:false});
inventoryTransactionSchema.pre('validate',function validateInventoryEquation(){
  const previous=Number(this.previousQty),change=Number(this.changeQty),next=Number(this.newQty);
  if([previous,change,next].every(Number.isFinite)&&Math.abs(previous+change-next)>1e-7)this.invalidate('newQty','New quantity must equal previous quantity plus change');
  const expectedCost=Math.abs(change)*Number(this.unitCost);
  if(Number.isFinite(expectedCost)&&Math.abs(expectedCost-Number(this.totalCost))>0.011)this.invalidate('totalCost','Total cost must equal absolute quantity change multiplied by unit cost');
  if(this.type==='WASTE'&&!this.wasteCategory)this.invalidate('wasteCategory','Waste movements require a structured waste category');
  if(this.type!=='WASTE'&&(this.wasteCategory||this.wasteNotes||this.wasteBatch))this.invalidate('wasteCategory','Waste evidence is only valid for WASTE movements');
});
inventoryTransactionSchema.pre('save',function preventLedgerRewrite(next,options){
  if(this.isNew&&!options?.inventoryLedgerWrite)return next(Object.assign(new Error('Inventory ledger rows may only be created by the inventory ledger service'),{status:409}));
  if(!this.isNew&&this.isModified())return next(Object.assign(new Error('Inventory ledger rows are immutable'),{status:409}));
  next();
});
inventoryTransactionSchema.pre(['updateOne','updateMany','findOneAndUpdate','replaceOne','deleteOne','deleteMany','findOneAndDelete'],function preventLedgerMutation(next){
  next(Object.assign(new Error('Inventory ledger rows are immutable'),{status:409}));
});
inventoryTransactionSchema.pre(['insertMany','bulkWrite'],function preventLedgerBulkWrite(next){
  next(Object.assign(new Error('Inventory ledger rows may only be created by the inventory ledger service'),{status:409}));
});
inventoryTransactionSchema.index({restaurant:1,branch:1,idempotencyKey:1},{unique:true,name:'inventory_transaction_tenant_idempotency'});
inventoryTransactionSchema.index({restaurant:1,branch:1,ingredient:1,createdAt:-1},{name:'inventory_transaction_tenant_ingredient_timeline'});
inventoryTransactionSchema.index({restaurant:1,branch:1,type:1,referenceType:1,createdAt:-1},{name:'inventory_transaction_purchasing_report'});
inventoryTransactionSchema.index({restaurant:1,branch:1,type:1,wasteCategory:1,createdAt:-1},{name:'inventory_transaction_waste_report'});
inventoryTransactionSchema.index({restaurant:1,referenceType:1,referenceId:1,createdAt:-1},{name:'inventory_transaction_reference_timeline'});
export const InventoryTransaction=model('InventoryTransaction',inventoryTransactionSchema);

const finiteNumber={type:Number,required:true,validate:{validator:Number.isFinite,message:'Stock count quantities must be finite'}};
const stockCountLineSchema=new Schema({
  ingredient:{...oid,ref:'Ingredient',required:true,immutable:true},
  ingredientName:{type:String,required:true,trim:true,maxlength:160,immutable:true},
  ingredientCode:{type:String,trim:true,maxlength:80,immutable:true},
  unit:{type:String,required:true,trim:true,maxlength:30,immutable:true},
  systemQty:{...finiteNumber,min:0,immutable:true},
  systemUnitCost:{type:Number,required:true,min:0,validate:{validator:Number.isFinite,message:'Stock count cost must be finite'},immutable:true},
  balanceVersion:{type:Number,required:true,min:0,validate:{validator:Number.isSafeInteger,message:'Stock count balance version must be a nonnegative safe integer'},immutable:true},
  physicalQty:{type:Number,min:0,validate:{validator:value=>value==null||Number.isFinite(value),message:'Physical quantity must be finite'}},
  varianceQty:{type:Number,validate:{validator:value=>value==null||Number.isFinite(value),message:'Variance quantity must be finite'}},
  varianceValue:{type:Number,validate:{validator:value=>value==null||Number.isFinite(value),message:'Variance value must be finite'}},
  countedBy:{...oid,ref:'User'},
  countedAt:Date
},{_id:true});
stockCountLineSchema.pre('validate',function validateCountVariance(){
  if(this.physicalQty==null){
    if(this.countedBy||this.countedAt)this.invalidate('physicalQty','Uncounted lines cannot retain count evidence');
    this.varianceQty=undefined;
    this.varianceValue=undefined;
    return;
  }
  if(!this.countedBy||!this.countedAt)this.invalidate('physicalQty','Physical quantities require count actor and timestamp evidence');
  this.varianceQty=Number(this.physicalQty)-Number(this.systemQty);
  this.varianceValue=this.varianceQty*Number(this.systemUnitCost||0);
});

const stockCountSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,index:true,immutable:true},
  branch:{...oid,ref:'Branch',required:true,index:true,immutable:true},
  countNo:{type:String,required:true,trim:true,maxlength:80,immutable:true},
  scope:{type:String,enum:['full','cycle'],required:true,immutable:true},
  status:{type:String,enum:['draft','submitted','approved','rejected'],default:'draft',index:true},
  activeKey:{type:String,trim:true,maxlength:24},
  lines:{type:[stockCountLineSchema],validate:{validator:rows=>Array.isArray(rows)&&rows.length>0,message:'A stock count requires at least one ingredient'}},
  notes:{type:String,trim:true,maxlength:2000},
  submissionNote:{type:String,trim:true,maxlength:2000},
  decisionNote:{type:String,trim:true,maxlength:2000},
  countedLineCount:{type:Number,default:0,min:0},
  varianceLineCount:{type:Number,default:0,min:0},
  totalVarianceValue:{type:Number,default:0,validate:{validator:Number.isFinite,message:'Total variance value must be finite'}},
  createdBy:{...oid,ref:'User',required:true,immutable:true},
  submittedBy:{...oid,ref:'User'},
  submittedAt:Date,
  approvedBy:{...oid,ref:'User'},
  approvedAt:Date,
  rejectedBy:{...oid,ref:'User'},
  rejectedAt:Date,
  adjustmentTransactions:[{...oid,ref:'InventoryTransaction'}],
  requestKey:{type:String,required:true,trim:true,maxlength:200,select:false,immutable:true},
  requestHash:{type:String,required:true,match:/^[a-f0-9]{64}$/,select:false,immutable:true},
  decisionKey:{type:String,trim:true,maxlength:200,select:false},
  decisionHash:{type:String,match:/^[a-f0-9]{64}$/,select:false}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
stockCountSchema.pre('validate',function validateStockCount(){
  const lines=this.lines||[];
  const ingredientIds=lines.map(line=>String(line.ingredient));
  if(new Set(ingredientIds).size!==ingredientIds.length)this.invalidate('lines','A stock count cannot contain duplicate ingredients');
  this.countedLineCount=lines.filter(line=>line.physicalQty!=null).length;
  this.varianceLineCount=lines.filter(line=>line.physicalQty!=null&&Math.abs(Number(line.physicalQty)-Number(line.systemQty))>1e-9).length;
  this.totalVarianceValue=lines.reduce((sum,line)=>line.physicalQty==null?sum:sum+(Number(line.physicalQty)-Number(line.systemQty))*Number(line.systemUnitCost||0),0);
  if(['draft','submitted'].includes(this.status)&&!this.activeKey)this.invalidate('activeKey','Active stock counts require a branch lock');
  if(['approved','rejected'].includes(this.status)&&this.activeKey)this.invalidate('activeKey','Completed stock counts cannot retain a branch lock');
  if(this.status!=='draft'&&this.countedLineCount!==lines.length)this.invalidate('lines','Every ingredient requires a physical quantity before submission');
  if(this.status!=='draft'&&(!this.submittedBy||!this.submittedAt))this.invalidate('status','Submitted stock counts require submission evidence');
  if(['approved','rejected'].includes(this.status)&&(!this.decisionKey||!this.decisionHash))this.invalidate('status','Completed stock counts require idempotent decision evidence');
  if(this.status==='approved'&&(!this.approvedBy||!this.approvedAt))this.invalidate('status','Approved stock counts require approval evidence');
  const adjustmentCount=this.adjustmentTransactions?.length||0;
  if(this.status==='approved'&&adjustmentCount!==this.varianceLineCount)this.invalidate('adjustmentTransactions','Approved non-zero variances require one ledger movement each');
  if(this.status!=='approved'&&adjustmentCount)this.invalidate('adjustmentTransactions','Only approved stock counts may reference variance movements');
  if(this.status==='rejected'&&(!this.rejectedBy||!this.rejectedAt||!this.decisionNote))this.invalidate('status','Rejected stock counts require rejection evidence');
});
stockCountSchema.index({restaurant:1,countNo:1},{unique:true,name:'stock_count_restaurant_number'});
stockCountSchema.index({restaurant:1,branch:1,requestKey:1},{unique:true,name:'stock_count_request_key'});
stockCountSchema.index({restaurant:1,activeKey:1},{unique:true,name:'stock_count_active_branch',partialFilterExpression:{activeKey:{$type:'string'}}});
stockCountSchema.index({restaurant:1,branch:1,status:1,createdAt:-1},{name:'stock_count_branch_status_created'});
export const StockCount=model('StockCount',stockCountSchema);

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
purchaseOrderSchema.index({restaurant:1,branch:1,orderDate:-1,createdAt:-1,_id:-1},{name:'po_restaurant_branch_order_date'});
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
supplierInvoiceSchema.index({restaurant:1,branch:1,invoiceDate:-1},{name:'supplier_invoice_restaurant_branch_report_date'});
supplierInvoiceSchema.index({restaurant:1,supplier:1,invoiceDate:1,createdAt:1,_id:1},{name:'supplier_invoice_statement_scope_date'});
supplierInvoiceSchema.index({restaurant:1,supplier:1,branch:1,invoiceDate:1,createdAt:1,_id:1},{name:'supplier_invoice_statement_branch_date'});
supplierInvoiceSchema.index({restaurant:1,purchaseOrder:1,status:1},{name:'supplier_invoice_restaurant_po_status'});
export const SupplierInvoice=model('SupplierInvoice',supplierInvoiceSchema);
const supplierPaymentSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},
  branch:{...oid,ref:'Branch',required:true,immutable:true},
  invoice:{...oid,ref:'SupplierInvoice',required:true,immutable:true},
  supplier:{...oid,ref:'Supplier',required:true,immutable:true},
  paymentNo:{type:String,required:true,trim:true,maxlength:80,immutable:true},
  numberVersion:{type:Number,default:2,immutable:true},
  amount:{type:Number,required:true,min:Number.EPSILON,max:1000000000,immutable:true},
  currency:{type:String,default:'NPR',enum:['NPR'],immutable:true},
  method:{type:String,enum:['cash','bank','esewa','khalti','card','legacy'],required:true,immutable:true},
  reference:{type:String,trim:true,maxlength:200,immutable:true},
  origin:{type:String,enum:['recorded','legacy_record','legacy_invoice_balance'],default:'recorded',required:true,immutable:true},
  migrationSource:{type:String,trim:true,maxlength:200,immutable:true},
  paidAt:{type:Date,default:Date.now,required:true,immutable:true},
  status:{type:String,enum:['posted','reversed'],default:'posted'},
  idempotencyKey:{type:String,required:true,trim:true,maxlength:120,select:false,immutable:true},
  requestHash:{type:String,required:true,match:/^[a-f0-9]{64}$/,select:false,immutable:true},
  requestHashVersion:{type:Number,required:true,default:2,enum:[2],select:false,immutable:true},
  createdBy:{...oid,ref:'User',required:true,immutable:true},
  reversedAt:Date,
  reversedBy:{...oid,ref:'User'},
  reversalReason:{type:String,trim:true,maxlength:500},
  reversalIdempotencyKey:{type:String,trim:true,maxlength:120,select:false},
  reversalRequestHash:{type:String,match:/^[a-f0-9]{64}$/,select:false}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
supplierPaymentSchema.pre('validate',function validateSupplierPayment(){
  const amount=Number(this.amount);
  const reference=String(this.reference||'').trim();
  const reversalKey=String(this.reversalIdempotencyKey||'').trim();
  const reversalHash=String(this.reversalRequestHash||'').trim();
  if(!Number.isFinite(amount)||amount<=0)this.invalidate('amount','Payment amount must be positive');
  if(Math.abs(amount-Math.round(amount*100)/100)>1e-9)this.invalidate('amount','Payment amount cannot have more than two decimal places');
  if(this.origin==='recorded'&&this.method==='legacy')this.invalidate('method','Recorded payments cannot use the legacy method');
  if(this.origin!=='recorded'&&!String(this.migrationSource||'').trim())this.invalidate('migrationSource','Migrated payments require source evidence');
  if(this.origin==='recorded'&&!['cash','legacy'].includes(this.method)&&reference.length<3)this.invalidate('reference','Non-cash payments require a traceable reference');
  if(this.status==='posted'&&(this.reversedAt||this.reversedBy||this.reversalReason||reversalKey||reversalHash))this.invalidate('status','Posted payments cannot have reversal details');
  if(this.status==='reversed'&&(!this.reversedAt||!this.reversedBy||!this.reversalReason||!reversalKey||!reversalHash))this.invalidate('status','Reversed payments require complete reversal details');
});
supplierPaymentSchema.set('toJSON',{transform:(_document,result)=>{delete result.idempotencyKey;delete result.requestHash;delete result.requestHashVersion;delete result.reversalIdempotencyKey;delete result.reversalRequestHash;return result;}});
supplierPaymentSchema.index({restaurant:1,paymentNo:1},{unique:true,name:'supplier_payment_restaurant_number'});
supplierPaymentSchema.index({restaurant:1,idempotencyKey:1},{unique:true,name:'supplier_payment_restaurant_idempotency',partialFilterExpression:{idempotencyKey:{$type:'string'}}});
supplierPaymentSchema.index({restaurant:1,reversalIdempotencyKey:1},{unique:true,name:'supplier_payment_restaurant_reversal_idempotency',partialFilterExpression:{reversalIdempotencyKey:{$type:'string'}}});
supplierPaymentSchema.index({restaurant:1,invoice:1,status:1,paidAt:1},{name:'supplier_payment_restaurant_invoice_status_date'});
supplierPaymentSchema.index({restaurant:1,branch:1,status:1,paidAt:-1},{name:'supplier_payment_restaurant_branch_status_date'});
supplierPaymentSchema.index({restaurant:1,branch:1,paidAt:-1},{name:'supplier_payment_restaurant_branch_report_date'});
supplierPaymentSchema.index({restaurant:1,supplier:1,status:1,paidAt:-1},{name:'supplier_payment_restaurant_supplier_status_date'});
supplierPaymentSchema.index({restaurant:1,supplier:1,paidAt:1,createdAt:1,_id:1},{name:'supplier_payment_statement_scope_date'});
supplierPaymentSchema.index({restaurant:1,supplier:1,branch:1,paidAt:1,createdAt:1,_id:1},{name:'supplier_payment_statement_branch_date'});
export const SupplierPayment=model('SupplierPayment',supplierPaymentSchema);
const supplierPaymentCounterSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},
  branch:{...oid,ref:'Branch',required:true,immutable:true},
  branchCode:{type:String,required:true,trim:true,uppercase:true,maxlength:8,immutable:true},
  year:{type:Number,required:true,immutable:true},
  value:{type:Number,default:0,min:0}
},{timestamps:true,autoIndex:false});
supplierPaymentCounterSchema.index({restaurant:1,branchCode:1,year:1},{unique:true,name:'supplier_payment_counter_scope'});
export const SupplierPaymentCounter=model('SupplierPaymentCounter',supplierPaymentCounterSchema);
export const StockTransfer=model('StockTransfer',new Schema({fromBranch:{...oid,ref:'Branch'},toBranch:{...oid,ref:'Branch'},ingredient:{...oid,ref:'Ingredient'},qty:n,unit:String,status:{type:String,enum:['requested','approved','in_transit','received','cancelled'],default:'requested'},requestedBy:{...oid,ref:'User'},approvedBy:{...oid,ref:'User'}},{timestamps:true}));
export const Delivery=model('Delivery',new Schema({order:{...oid,ref:'Order'},rider:{...oid,ref:'User'},address:String,phone:String,status:{type:String,enum:['available','assigned','picking_up','out_for_delivery','delivered','cancelled'],default:'assigned'},estimatedMinutes:n},{timestamps:true}));
export const Notification=model('Notification',new Schema({branch:{...oid,ref:'Branch'},user:{...oid,ref:'User'},type:String,title:String,body:String,read:{type:Boolean,default:false},referenceId:oid},{timestamps:true}));
