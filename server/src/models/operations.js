import mongoose from 'mongoose';
const {Schema,model}=mongoose;
const n={type:Number,default:0}; const oid={type:Schema.Types.ObjectId};
/**
 * 11D: manual discount ceilings.
 *
 * The policy is "any staff may discount, and every discount is audited" — a
 * counter should not need a manager for a Rs 20 goodwill gesture. But
 * "unlimited and audited" is not a control: a till operator could zero a
 * Rs 40,000 banquet bill and the audit would faithfully record the theft.
 *
 * These are the ceilings above which a discount requires a supervisor. They
 * are per-restaurant so an operator can set their own risk appetite, and the
 * defaults are deliberately generous enough not to obstruct normal service.
 */
export const Restaurant=model('Restaurant',new Schema({name:{type:String,required:true},currency:{type:String,default:'NPR'},vatRate:{type:Number,default:13},serviceChargeRate:{type:Number,default:0},
  // Largest percentage a non-supervisor may apply to a line or an order.
  staffMaxDiscountPercent:{type:Number,default:20,min:0,max:100},
  // Largest absolute amount a non-supervisor may take off one order.
  staffMaxDiscountAmount:{type:Number,default:500,min:0},
  // Hard ceiling for EVERYONE, including an owner. Guards a mistyped 100%
  // rather than a dishonest one; set to 100 to disable.
  maxDiscountPercent:{type:Number,default:100,min:0,max:100},phone:String,address:String,pan:{type:String,trim:true,maxlength:20},receiptFooter:{type:String,trim:true,maxlength:300}},{timestamps:true}));
export const Branch=model('Branch',new Schema({restaurant:{...oid,ref:'Restaurant',index:true},name:{type:String,required:true},code:{type:String,uppercase:true},address:String,phone:String,pan:{type:String,trim:true,maxlength:20},active:{type:Boolean,default:true}},{timestamps:true}));
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
  // Phase 14: `counting` marks a session a counter has actually started
  // entering figures into, distinct from an empty draft. `stale` is terminal:
  // the captured snapshot no longer matches the ledger, so the session is
  // closed unapproved and a recount must be started.
  status:{type:String,enum:['draft','counting','submitted','approved','rejected','stale'],default:'draft',index:true},
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
  // Phase 14: evidence of a stale-out. `staleLines` names the ingredients whose
  // stock moved after capture, so the recount is informed rather than blind.
  staleAt:Date,
  staleDetectedBy:{...oid,ref:'User'},
  staleLines:[{
    ingredient:{...oid,ref:'Ingredient'},
    ingredientName:{type:String,trim:true,maxlength:160},
    capturedQty:Number,
    currentQty:Number
  }],
  // Links a recount back to the session it replaces.
  recountOf:{...oid,ref:'StockCount',default:null,index:true},
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
  if(['draft','counting','submitted'].includes(this.status)&&!this.activeKey)this.invalidate('activeKey','Active stock counts require a branch lock');
  if(['approved','rejected','stale'].includes(this.status)&&this.activeKey)this.invalidate('activeKey','Completed stock counts cannot retain a branch lock');
  // A partially entered `counting` session is legitimate; only submission
  // onward requires every line.
  const NEEDS_COMPLETE=['submitted','approved','rejected','stale'];
  if(NEEDS_COMPLETE.includes(this.status)&&this.countedLineCount!==lines.length)this.invalidate('lines','Every ingredient requires a physical quantity before submission');
  if(NEEDS_COMPLETE.includes(this.status)&&(!this.submittedBy||!this.submittedAt))this.invalidate('status','Submitted stock counts require submission evidence');
  if(['approved','rejected'].includes(this.status)&&(!this.decisionKey||!this.decisionHash))this.invalidate('status','Completed stock counts require idempotent decision evidence');
  if(this.status==='approved'&&(!this.approvedBy||!this.approvedAt))this.invalidate('status','Approved stock counts require approval evidence');
  const adjustmentCount=this.adjustmentTransactions?.length||0;
  if(this.status==='approved'&&adjustmentCount!==this.varianceLineCount)this.invalidate('adjustmentTransactions','Approved non-zero variances require one ledger movement each');
  if(this.status!=='approved'&&adjustmentCount)this.invalidate('adjustmentTransactions','Only approved stock counts may reference variance movements');
  // A stale-out is a decision the SYSTEM made, so it carries its own evidence
  // rather than a decision key.
  if(this.status==='stale'&&(!this.staleAt||!this.staleLines?.length))this.invalidate('status','Stale stock counts require stale evidence');
  if(this.status!=='stale'&&(this.staleAt||this.staleLines?.length))this.invalidate('status','Only stale stock counts may carry stale evidence');
  if(this.status==='rejected'&&(!this.rejectedBy||!this.rejectedAt||!this.decisionNote))this.invalidate('status','Rejected stock counts require rejection evidence');
});
stockCountSchema.index({restaurant:1,countNo:1},{unique:true,name:'stock_count_restaurant_number'});
stockCountSchema.index({restaurant:1,branch:1,requestKey:1},{unique:true,name:'stock_count_request_key'});
stockCountSchema.index({restaurant:1,activeKey:1},{unique:true,name:'stock_count_active_branch',partialFilterExpression:{activeKey:{$type:'string'}}});
stockCountSchema.index({restaurant:1,branch:1,status:1,createdAt:-1},{name:'stock_count_branch_status_created'});
export const StockCount=model('StockCount',stockCountSchema);

export const RestaurantTable=model('RestaurantTable',new Schema({branch:{...oid,ref:'Branch',index:true},name:String,area:String,seats:n,status:{type:String,enum:['available','occupied','reserved','cleaning','disabled'],default:'available'},active:{type:Boolean,default:true}},{timestamps:true}));
/**
 * Customer — Phase 9 CRM.
 *
 * SCOPE DECISION: customers are RESTAURANT-WIDE, not branch-specific.
 *
 * A chain's guest is a guest of the restaurant: someone who orders from
 * Kalanki on Monday and Patan on Friday is one person, and their loyalty
 * balance, lifetime spend and history must aggregate. Keeping them
 * branch-scoped (the pre-Phase-9 behaviour) silently created a duplicate
 * profile per branch and split the very numbers a CRM exists to report.
 *
 * `branch` is retained as the HOME branch — where the guest was first seen —
 * so branch attribution, reporting and the existing branch-scoped list
 * endpoint keep working. It is no longer an isolation boundary; `restaurant`
 * is. Tenant isolation is therefore strictly stronger than before: every
 * query is filtered by restaurant, which the old model could not express.
 *
 * `phoneKey` is the normalised phone (digits only, Nepali country code and
 * trunk zero stripped) and carries a unique partial index per restaurant.
 * Deduplication is enforced by the database, not by a lookup that can race.
 */
const customerSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,index:true},
  // Home branch: where this guest was first seen. Attribution, not isolation.
  branch:{...oid,ref:'Branch',index:true},
  name:{type:String,trim:true,maxlength:120},
  phone:{type:String,trim:true,maxlength:30,index:true},
  // Normalised phone. The dedupe key.
  phoneKey:{type:String,trim:true,maxlength:30,index:true},
  email:{type:String,trim:true,lowercase:true,maxlength:160},
  addresses:[{
    label:{type:String,trim:true,maxlength:60},
    address:{type:String,trim:true,maxlength:300},
    // Standing directions for the rider: gate codes, landmarks, which bell.
    instructions:{type:String,trim:true,maxlength:300},
    default:{type:Boolean,default:false}
  }],
  // Free-text operational notes: "always calls ahead", "difficult stairs".
  notes:{type:String,trim:true,maxlength:2000},
  preferences:{
    dietary:{type:String,enum:['none','vegetarian','vegan','halal','jain'],default:'none'},
    spiceLevel:{type:String,enum:['none','mild','medium','hot','extra-hot'],default:'medium'},
    allergies:[{type:String,trim:true,maxlength:60}],
    favouriteItems:[{...oid,ref:'MenuItem'}],
    seating:{type:String,trim:true,maxlength:60},
    contactPreference:{type:String,enum:['phone','sms','email','none'],default:'phone'},
    marketingOptIn:{type:Boolean,default:false}
  },
  tags:[{type:String,trim:true,lowercase:true,maxlength:40}],
  loyalty:{
    points:{type:Number,default:0,min:0},
    tier:{type:String,enum:['bronze','silver','gold','platinum'],default:'bronze'},
    lifetimePoints:{type:Number,default:0,min:0},
    joinedAt:Date
  },
  // Denormalised rollups, recomputed from orders. Never authored by hand.
  stats:{
    totalOrders:{type:Number,default:0,min:0},
    completedOrders:{type:Number,default:0,min:0},
    cancelledOrders:{type:Number,default:0,min:0},
    totalSpend:{type:Number,default:0,min:0},
    totalRefunded:{type:Number,default:0,min:0},
    averageOrderValue:{type:Number,default:0,min:0},
    firstOrderAt:{type:Date,default:null},
    lastOrderAt:{type:Date,default:null},
    statsUpdatedAt:{type:Date,default:null}
  },
  // Legacy fields kept so nothing that reads them breaks. Mirrored from stats.
  loyaltyPoints:n,
  totalSpend:n,
  lastOrderAt:Date,
  // Customers are deactivated, never hard-deleted: orders reference them and
  // financial history must stay intact.
  active:{type:Boolean,default:true,index:true},
  deactivatedAt:{type:Date,default:null},
  deactivatedBy:{...oid,ref:'User',default:null},
  deactivationReason:{type:String,trim:true,maxlength:300},
  // Set when this record was merged into another during deduplication.
  mergedInto:{...oid,ref:'Customer',default:null}
},{timestamps:true});
// One profile per phone per restaurant. Partial so historical rows without a
// usable phone are not forced into the constraint.
/**
 * Derive the tenant and the dedupe key from whatever the caller supplied.
 *
 * Plenty of existing code (and every pre-Phase-9 caller) creates a Customer
 * with just a branch and a phone. Making `restaurant` required without this
 * hook would break those call sites and, worse, tempt a caller to pass a
 * restaurant that disagrees with the branch. Deriving it from the branch keeps
 * the two consistent by construction, and normalising the phone here means no
 * write path can bypass deduplication.
 */
customerSchema.pre('validate',async function deriveCustomerScope(){
  if(!this.restaurant&&this.branch){
    const branch=await mongoose.model('Branch').findById(this.branch).select('restaurant').lean();
    if(branch?.restaurant)this.restaurant=branch.restaurant;
  }
  if(this.phone){
    const digits=String(this.phone).replace(/\D+/g,'');
    let key=digits;
    if(key.startsWith('00977'))key=key.slice(5);
    else if(key.startsWith('977')&&key.length>10)key=key.slice(3);
    if(key.length>10&&key.startsWith('0'))key=key.replace(/^0+/,'');
    else if(key.length===11&&key.startsWith('0'))key=key.slice(1);
    if(key)this.phoneKey=key;
  }
});
customerSchema.index({restaurant:1,phoneKey:1},{unique:true,name:'customer_restaurant_phone',partialFilterExpression:{phoneKey:{$type:'string'}}});
customerSchema.index({restaurant:1,name:1},{name:'customer_restaurant_name'});
customerSchema.index({restaurant:1,email:1},{name:'customer_restaurant_email'});
customerSchema.index({restaurant:1,active:1,'stats.lastOrderAt':-1},{name:'customer_restaurant_recent'});
export const Customer=model('Customer',customerSchema);
// Phase 6C — reservations.
const reservationSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,index:true},
  branch:{...oid,ref:'Branch',required:true,index:true},
  reference:{type:String,required:true,trim:true,uppercase:true,maxlength:24},
  // Either a known customer, or walk-in details captured on the booking.
  customer:{...oid,ref:'Customer',default:null},
  guestName:{type:String,trim:true,maxlength:120,required:true},
  guestPhone:{type:String,trim:true,maxlength:30,required:true},
  guestEmail:{type:String,trim:true,maxlength:160},
  partySize:{type:Number,required:true,min:1,max:200},
  // The booked slot. startsAt/endsAt are absolute instants so overlap checks
  // are timezone-proof; date/time keep the host-facing local values.
  date:{type:String,required:true,match:/^\d{4}-\d{2}-\d{2}$/},
  time:{type:String,required:true,match:/^([01]\d|2[0-3]):[0-5]\d$/},
  durationMinutes:{type:Number,default:90,min:15,max:600},
  startsAt:{type:Date,required:true,index:true},
  endsAt:{type:Date,required:true},
  table:{...oid,ref:'RestaurantTable',default:null,index:true},
  status:{type:String,enum:['booked','confirmed','seated','completed','cancelled','no_show'],default:'booked',index:true},
  order:{...oid,ref:'Order',default:null},
  notes:{type:String,trim:true,maxlength:500},
  seatedAt:Date,
  completedAt:Date,
  cancelledAt:Date,
  cancelledBy:{...oid,ref:'User'},
  cancellationReason:{type:String,trim:true,maxlength:300},
  createdBy:{...oid,ref:'User'},
  updatedBy:{...oid,ref:'User'}
},{timestamps:true});
reservationSchema.index({restaurant:1,reference:1},{unique:true,name:'reservation_reference'});
// Serves the diary view and the overlap query.
reservationSchema.index({branch:1,startsAt:1,status:1},{name:'reservation_branch_slot'});
reservationSchema.index({table:1,startsAt:1},{name:'reservation_table_slot'});
export const Reservation=model('Reservation',reservationSchema);

const reservationCounterSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},
  branchCode:{type:String,required:true,trim:true,uppercase:true,maxlength:8,immutable:true},
  year:{type:Number,required:true,immutable:true},
  value:{type:Number,default:0,min:0}
},{timestamps:true,autoIndex:false});
reservationCounterSchema.index({restaurant:1,branchCode:1,year:1},{unique:true,name:'reservation_counter_scope'});
export const ReservationCounter=model('ReservationCounter',reservationCounterSchema);

const orderSchema=new Schema({orderNo:{type:String,index:true},branch:{...oid,ref:'Branch',index:true},customer:{...oid,ref:'Customer'},table:{...oid,ref:'RestaurantTable'},type:{type:String,enum:['dine-in','takeaway','pickup','delivery','online','counter'],default:'counter'},status:{type:String,enum:['draft','held','pending','confirmed','accepted','preparing','ready','out_for_delivery','completed','cancelled','refunded'],default:'pending',index:true},items:[{menuItem:{...oid,ref:'MenuItem'},name:String,qty:n,unitPrice:n,vatInclusive:{type:Boolean,default:false},lineNet:n,lineVat:n,lineTotal:n,foodCost:n,recipeVersion:{type:Number,default:1,min:1},recipeCost:n,packagingCost:n,foodCostVersioned:n,notes:String,specialInstructions:{type:String,trim:true,maxlength:500},modifiers:[{groupKey:String,groupName:String,kind:{type:String,enum:['variant','extra','addon','removal']},optionKey:String,name:String,price:n,ingredient:{...oid,ref:'Ingredient'},qty:n,unit:String,removed:{type:Boolean,default:false}}],basePrice:n,station:{type:String,trim:true,lowercase:true,maxlength:40},prepMinutes:n,discount:n,discountKind:{type:String,enum:['percentage','fixed']},discountValue:n,discountReason:{type:String,trim:true,maxlength:200},inventoryRequirements:[{ingredient:{...oid,ref:'Ingredient'},qty:n,unit:String}]}],inventorySourceOrder:{...oid,ref:'Order',index:true},inventorySourceOrders:[{...oid,ref:'Order'}],deliveryAddress:{type:String,trim:true,maxlength:500},subtotal:n,itemDiscount:n,discount:n,discountTotal:n,manualDiscount:n,couponDiscount:n,couponCode:{type:String,trim:true,uppercase:true,maxlength:40},manualDiscountKind:{type:String,enum:['percentage','fixed']},manualDiscountValue:n,discountReason:{type:String,trim:true,maxlength:200},discountBy:{...oid,ref:'User'},vatRate:{type:Number,default:13},vat:n,serviceChargeRate:{type:Number,default:0,min:0,max:100},serviceCharge:n,deliveryFee:n,total:n,paidAmount:n,dueAmount:n,refundAmount:n,source:{type:String,enum:['pos','online'],default:'pos',index:true},publicRequestKey:{type:String,select:false},paymentMethod:{type:String,trim:true,maxlength:20},paymentSettledAt:Date,paymentReference:{type:String,trim:true,maxlength:80,index:true},acceptedOnlineAt:Date,rejectedOnlineAt:Date,rejectionReason:{type:String,trim:true,maxlength:300},reopenedAt:Date,reopenedBy:{...oid,ref:'User'},reopenCount:{type:Number,default:0,min:0},reopenReason:{type:String,trim:true,maxlength:300},priority:{type:String,enum:['normal','rush'],default:'normal',index:true},rushedAt:Date,rushedBy:{...oid,ref:'User'},acceptedAt:Date,preparingAt:Date,readyAt:Date,completedAt:Date,invoiceNo:{type:String,trim:true,uppercase:true,maxlength:40,index:true},invoicedAt:Date,printCount:{type:Number,default:0,min:0},lastPrintedAt:Date,inventoryDeducted:{type:Boolean,default:false},inventoryReversed:{type:Boolean,default:false},createdBy:{...oid,ref:'User'},
  // Phase 13: a tax invoice, once issued, is a legal document. `invoicedTotal`
  // is the figure the numbered invoice was issued against, so a reprint can
  // prove it still matches the order it claims to describe.
  invoicedTotal:{type:Number,default:null},
  invoicedBy:{...oid,ref:'User',default:null},
  // Set when an already-invoiced order is voided. The invoice number is never
  // released or reused; the reprint is stamped VOID instead.
  invoiceVoidedAt:{type:Date,default:null},
  invoiceVoidReason:{type:String,trim:true,maxlength:300}},{timestamps:true});

// Phase 13: the tax invoice identity is append-only.
//
// A sequential tax invoice number is the anchor of the VAT audit trail. It was
// freely rewritable: `Order.updateOne({...},{invoiceNo:'INV-KTM-2026-999999'})`
// succeeded, and printCount could be rewound to 0 so a reprint would present
// itself as an original. Both are now refused at the document and query layers.
const FROZEN_INVOICE_PATHS=['invoiceNo','invoicedAt','invoicedTotal','invoicedBy'];
function invoiceRewriteError(paths){
  return Object.assign(new Error(`An issued tax invoice cannot be altered (${paths.join(', ')}); void it and issue a credit note instead`),{status:409});
}
orderSchema.post('init',function(){this.$locals.hadInvoice=Boolean(this.get('invoiceNo'));this.$locals.priorPrintCount=Number(this.get('printCount')||0);});
orderSchema.pre('save',function(next){
  if(this.isNew||!this.$locals.hadInvoice)return next();
  const frozen=FROZEN_INVOICE_PATHS.filter(path=>this.isModified(path));
  if(frozen.length)return next(invoiceRewriteError(frozen));
  // A print counter that can go backwards lets a reprint pose as an original.
  if(this.isModified('printCount')&&Number(this.get('printCount')||0)<Number(this.$locals.priorPrintCount||0)){
    return next(Object.assign(new Error('printCount cannot be decreased; it records how many times a tax invoice was printed'),{status:409}));
  }
  next();
});
function refuseInvoiceRewrite(next){
  const update=this.getUpdate()||{};
  const touched=new Set();
  for(const [operator,payload] of Object.entries(update)){
    if(operator.startsWith('$')){
      if(payload&&typeof payload==='object')for(const path of Object.keys(payload))touched.add(path.split('.')[0]);
    }else touched.add(operator.split('.')[0]);
  }
  const frozen=FROZEN_INVOICE_PATHS.filter(path=>touched.has(path));
  // Allocation itself is an update on an order with no invoice yet, so the
  // guard only bites where a number already exists.
  if(frozen.length){
    this.setOptions({runInvoiceGuard:frozen});
  }
  if(touched.has('printCount')){
    const dec=update.$inc?.printCount;
    if(typeof dec==='number'&&dec<0)return next(Object.assign(new Error('printCount cannot be decreased; it records how many times a tax invoice was printed'),{status:409}));
    const set=update.$set?.printCount??update.printCount;
    if(typeof set==='number')this.setOptions({runPrintCountGuard:set});
  }
  const options=this.getOptions?.()||{};
  if(!options.runInvoiceGuard&&options.runPrintCountGuard===undefined)return next();
  if(options.allowInvoiceRewrite===true)return next();
  this.model.findOne(this.getQuery()).select('invoiceNo printCount').lean().then(existing=>{
    if(!existing)return next();
    if(options.runInvoiceGuard&&existing.invoiceNo)return next(invoiceRewriteError(options.runInvoiceGuard));
    if(options.runPrintCountGuard!==undefined&&existing.invoiceNo&&options.runPrintCountGuard<Number(existing.printCount||0)){
      return next(Object.assign(new Error('printCount cannot be decreased; it records how many times a tax invoice was printed'),{status:409}));
    }
    next();
  }).catch(next);
}
for(const hook of ['updateOne','updateMany','findOneAndUpdate'])orderSchema.pre(hook,refuseInvoiceRewrite);
export const Order=model('Order',orderSchema);
Order.schema.index({inventorySourceOrders:1},{name:'order_inventory_source_orders'});
// Phase 5D — serves the kitchen board and performance report, which always
// filter by branch + status and window/sort by createdAt. Without the trailing
// createdAt the sort is done in memory on every call.
Order.schema.index({branch:1,status:1,createdAt:1},{name:'order_branch_status_created'});
// Completion-time reporting scans settled tickets by branch over a period.
Order.schema.index({branch:1,completedAt:1},{name:'order_branch_completed',sparse:true});
// Phase 8A.5 — one public order per idempotency key. Enforced by the database
// so a double-click cannot win a race between two application-level checks.
Order.schema.index({publicRequestKey:1},{unique:true,name:'order_public_request_key',partialFilterExpression:{publicRequestKey:{$type:'string'}}});
/**
 * 11F: order payments carry an idempotency key.
 *
 * A double-clicked "Pay" button banked the amount twice — verified against the
 * running API before this was added. Supplier payments and goods receiving
 * already required a key; customer payments did not, which is the path a
 * cashier actually hammers on a slow connection.
 *
 * `reversedAt`/`reversalReason` support reversing a MISTAKE (wrong tender,
 * wrong amount) as distinct from a refund, which is money genuinely returned
 * to a guest and must stay on the record.
 */
const paymentSchema=new Schema({order:{...oid,ref:'Order',index:true},amount:n,method:{type:String,enum:['cash','card','esewa','khalti','wallet','online'],default:'cash'},transactionId:String,status:{type:String,enum:['pending','paid','failed','refunded','reversed'],default:'paid'},refundOf:{...oid,ref:'Payment',default:null,index:true},reason:{type:String,trim:true,maxlength:300},cashier:{...oid,ref:'User'},
  // 11F: one payment per idempotency key per order, so a double-clicked
  // "Pay" cannot bank the amount twice.
  idempotencyKey:{type:String,trim:true,maxlength:200,select:false},
  // A reversal corrects a till MISTAKE (wrong tender/amount) and reopens the
  // balance. Distinct from a refund, which is money genuinely returned and
  // must stay on the record.
  reversedAt:{type:Date,default:null},
  reversedBy:{...oid,ref:'User',default:null},
  reversalReason:{type:String,trim:true,maxlength:300}},{timestamps:true});

// Phase 12: a settled payment row is evidence, not working state.
//
// Money that has been taken may only be corrected by APPENDING a reversal or a
// refund row; rewriting the original would erase the trail an auditor relies
// on. `pending` rows are exempt because the online-payment path legitimately
// upgrades its own stub to `paid` once the gateway confirms.
const FROZEN_PAYMENT_PATHS=['amount','method','order','refundOf','cashier'];
paymentSchema.post('init',function(){this.$locals.settledOnLoad=['paid','refunded','reversed'].includes(this.get('status'));});
paymentSchema.pre('save',function(next){
  if(this.isNew||!this.$locals.settledOnLoad)return next();
  const frozen=[...FROZEN_PAYMENT_PATHS,'transactionId'].filter(path=>this.isModified(path));
  if(frozen.length){
    return next(Object.assign(new Error(`A settled payment cannot be rewritten (${frozen.join(', ')}); append a refund or reversal instead`),{status:409}));
  }
  next();
});
// The same rule at the query layer, so a bare updateOne() cannot walk around
// the document hook. Status transitions (paid -> refunded/reversed) stay legal;
// the money itself does not move.
function refusePaymentRewrite(next){
  const update=this.getUpdate()||{};
  const touched=new Set();
  for(const [operator,payload] of Object.entries(update)){
    if(operator.startsWith('$')){
      if(payload&&typeof payload==='object')for(const path of Object.keys(payload))touched.add(path.split('.')[0]);
    }else touched.add(operator.split('.')[0]);
  }
  // Merging two table checks re-parents tenders onto the surviving order. That
  // moves no money — the amount, method and tender identity are untouched — so
  // it is allowed, but only when the caller says so explicitly.
  // Only `order` is ever exempt, so an amount or method change still fails
  // even when the escape hatch is used.
  const allowed=this.getOptions?.()?.reparentPayments===true?['order']:[];
  const frozen=FROZEN_PAYMENT_PATHS.filter(path=>touched.has(path)&&!allowed.includes(path));
  if(frozen.length){
    return next(Object.assign(new Error(`A payment cannot be rewritten (${frozen.join(', ')}); append a refund or reversal instead`),{status:409}));
  }
  next();
}
for(const hook of ['updateOne','updateMany','findOneAndUpdate'])paymentSchema.pre(hook,refusePaymentRewrite);
export const Payment=model('Payment',paymentSchema);
// One payment per key per order. Partial so historical rows without a key are
// not forced into the constraint.
// A PAYMENT is one row per key, so the pair is unique. A REFUND may split
// across several original tenders and therefore writes several rows under one
// key, so the constraint is scoped to non-refund rows; refund replay is
// handled by the lookup in refundOrder().
Payment.schema.index({order:1,idempotencyKey:1},{unique:true,name:'payment_order_idempotency',partialFilterExpression:{idempotencyKey:{$type:'string'},status:'paid'}});
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
// Phase 4E — sequential tax invoice numbers, scoped per branch code and year.
const salesInvoiceCounterSchema=new Schema({restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},branch:{...oid,ref:'Branch',required:true,immutable:true},branchCode:{type:String,required:true,trim:true,uppercase:true,maxlength:8,immutable:true},year:{type:Number,required:true,immutable:true},value:{type:Number,default:0,min:0}},{timestamps:true,autoIndex:false});
salesInvoiceCounterSchema.index({restaurant:1,branchCode:1,year:1},{unique:true,name:'sales_invoice_counter_scope'});
export const SalesInvoiceCounter=model('SalesInvoiceCounter',salesInvoiceCounterSchema);
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

/**
 * PaymentIntent — Phase 8B.
 *
 * The server-side record of a gateway payment attempt. It exists so that
 * nothing about a payment depends on what the browser sends back.
 *
 * `reference` is our own opaque identifier, generated before the guest leaves
 * for the gateway: it is the eSewa transaction_uuid and the Khalti
 * purchase_order_id. It is what lets a callback be tied to an order without
 * the callback naming the order at all.
 *
 * `expectedAmount` is captured at initiation from the order total, so an
 * amount echoed back by a gateway can be checked against what we actually
 * asked for rather than against a value that may since have changed.
 */
const paymentIntentSchema=new Schema({
  order:{...oid,ref:'Order',required:true,index:true},
  branch:{...oid,ref:'Branch',required:true,index:true},
  restaurant:{...oid,ref:'Restaurant',required:true,index:true},
  provider:{type:String,enum:['esewa','khalti'],required:true,index:true},
  // Our reference, handed to the gateway. Globally unique: it is the join key
  // a callback arrives with.
  reference:{type:String,required:true,trim:true,maxlength:80},
  // Provider-side identifier (Khalti pidx). Unknown until initiation returns.
  providerReference:{type:String,trim:true,maxlength:120,default:null},
  // The provider's own transaction id once settled, for reconciliation.
  transactionId:{type:String,trim:true,maxlength:120,default:null},
  expectedAmount:{type:Number,required:true,min:0},
  paidAmount:{type:Number,default:0,min:0},
  currency:{type:String,default:'NPR'},
  status:{type:String,enum:['initiated','pending','paid','failed','cancelled','expired','refunded'],default:'initiated',index:true},
  mode:{type:String,enum:['sandbox','production'],required:true},
  // Set once, when the intent first reaches a terminal paid state. Guards the
  // "already paid" and duplicate-callback cases.
  settledAt:{type:Date,default:null},
  expiresAt:{type:Date,default:null},
  attempts:{type:Number,default:0,min:0},
  lastCheckedAt:{type:Date,default:null},
  failureReason:{type:String,trim:true,maxlength:300,default:null},
  // Redacted provider response, retained for support/reconciliation. Never
  // contains a secret or a signature (see redactPaymentPayload).
  lastResponse:{type:Schema.Types.Mixed,default:null},
  payment:{...oid,ref:'Payment',default:null}
},{timestamps:true});
// The join key must be unique or two orders could claim one callback.
paymentIntentSchema.index({reference:1},{unique:true,name:'payment_intent_reference'});
// A provider reference is unique per provider once known; the partial filter
// keeps nulls out of the constraint before initiation returns.
paymentIntentSchema.index({provider:1,providerReference:1},{unique:true,name:'payment_intent_provider_reference',partialFilterExpression:{providerReference:{$type:'string'}}});
// At most one SETTLED intent per order. The unique key is {order} alone; the
// partial filter restricts the constraint to documents that have actually
// settled. Indexing {order, settledAt} together would be useless here, because
// two racing callbacks stamp different timestamps and would both be admitted.
paymentIntentSchema.index({order:1},{unique:true,name:'payment_intent_order_settled',partialFilterExpression:{settledAt:{$type:'date'}}});
paymentIntentSchema.index({restaurant:1,branch:1,status:1,createdAt:-1},{name:'payment_intent_scope_status'});
export const PaymentIntent=model('PaymentIntent',paymentIntentSchema);

/**
 * PaymentEvent — the audit trail for everything a gateway tells us.
 *
 * Every callback, lookup and status check is appended here, including the ones
 * we reject. `dedupeKey` is what makes duplicate callback protection provable:
 * a unique index means the second identical callback cannot create a second
 * event, so it cannot be processed twice.
 */
const paymentEventSchema=new Schema({
  intent:{...oid,ref:'PaymentIntent',required:true,index:true},
  order:{...oid,ref:'Order',required:true,index:true},
  provider:{type:String,enum:['esewa','khalti'],required:true},
  kind:{type:String,enum:['initiated','callback','lookup','status_check','settled','failed','cancelled','expired','rejected'],required:true},
  outcome:{type:String,enum:['paid','pending','failed','cancelled','expired','refunded','rejected'],required:true},
  dedupeKey:{type:String,required:true,trim:true,maxlength:200},
  amount:{type:Number,default:0},
  message:{type:String,trim:true,maxlength:300},
  // Redacted. Signatures and keys are stripped before this is written.
  detail:{type:Schema.Types.Mixed,default:null},
  at:{type:Date,default:Date.now,index:true}
},{timestamps:true});
paymentEventSchema.index({dedupeKey:1},{unique:true,name:'payment_event_dedupe'});
paymentEventSchema.index({order:1,at:-1},{name:'payment_event_order_timeline'});
export const PaymentEvent=model('PaymentEvent',paymentEventSchema);

const supplierPaymentCounterSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,immutable:true},
  branch:{...oid,ref:'Branch',required:true,immutable:true},
  branchCode:{type:String,required:true,trim:true,uppercase:true,maxlength:8,immutable:true},
  year:{type:Number,required:true,immutable:true},
  value:{type:Number,default:0,min:0}
},{timestamps:true,autoIndex:false});
supplierPaymentCounterSchema.index({restaurant:1,branchCode:1,year:1},{unique:true,name:'supplier_payment_counter_scope'});
export const SupplierPaymentCounter=model('SupplierPaymentCounter',supplierPaymentCounterSchema);
const stockTransferSchema=new Schema({
  restaurant:{...oid,ref:'Restaurant',required:true,index:true,immutable:true},
  fromBranch:{...oid,ref:'Branch',required:true,index:true,immutable:true},
  toBranch:{...oid,ref:'Branch',required:true,index:true,immutable:true},
  ingredient:{...oid,ref:'Ingredient',required:true,index:true,immutable:true},
  qty:{type:Number,required:true,min:Number.EPSILON,immutable:true},
  unit:{type:String,required:true,trim:true,maxlength:30,immutable:true},
  status:{type:String,enum:['requested','approved','in_transit','received','cancelled'],default:'requested',index:true},
  requestedBy:{...oid,ref:'User',required:true,immutable:true},
  approvedBy:{...oid,ref:'User'},
  requestKey:{type:String,trim:true,maxlength:200,select:false,immutable:true},
  requestHash:{type:String,match:/^[a-f0-9]{64}$/,select:false,immutable:true}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
stockTransferSchema.index({restaurant:1,requestKey:1},{unique:true,name:'stock_transfer_restaurant_request',partialFilterExpression:{requestKey:{$type:'string'}}});
stockTransferSchema.index({restaurant:1,fromBranch:1,status:1,createdAt:-1},{name:'stock_transfer_from_status'});
stockTransferSchema.index({restaurant:1,toBranch:1,status:1,createdAt:-1},{name:'stock_transfer_to_status'});
export const StockTransfer=model('StockTransfer',stockTransferSchema);
/**
 * Delivery — Phase 10.
 *
 * The pre-Phase-10 model had no branch or restaurant of its own: tenancy was
 * inferred by joining through the order every single time, which made
 * rider-scoped queries impossible to write safely. Both are now denormalised
 * onto the delivery itself, so every query filters on the tenant directly.
 *
 * Lifecycle (DELIVERY_TRANSITIONS below):
 *   pending -> assigned -> picked_up -> out_for_delivery -> delivered
 * with `failed` and `cancelled` reachable from any live state. The legacy
 * 'available'/'picking_up' values are migrated to 'pending'/'picked_up'.
 */
const deliverySchema=new Schema({
  order:{...oid,ref:'Order',required:true,index:true},
  // Denormalised tenancy. The order remains the source of truth, but a rider
  // query must not have to join through it to stay inside a restaurant.
  branch:{...oid,ref:'Branch',required:true,index:true},
  restaurant:{...oid,ref:'Restaurant',required:true,index:true},
  rider:{...oid,ref:'User',default:null,index:true},
  address:{type:String,trim:true,maxlength:500},
  phone:{type:String,trim:true,maxlength:30},
  // Captured from the customer address at dispatch, so a later edit to the
  // saved address cannot rewrite what the rider was actually told.
  instructions:{type:String,trim:true,maxlength:300},
  status:{type:String,enum:['pending','assigned','picked_up','out_for_delivery','delivered','failed','cancelled'],default:'pending',index:true},
  estimatedMinutes:{type:Number,default:0,min:0,max:600},
  // Lifecycle stamps, for dashboard ageing and rider performance.
  assignedAt:{type:Date,default:null},
  pickedUpAt:{type:Date,default:null},
  dispatchedAt:{type:Date,default:null},
  deliveredAt:{type:Date,default:null},
  failedAt:{type:Date,default:null},
  cancelledAt:{type:Date,default:null},
  // When the delivery is expected; drives the "delayed" dashboard bucket.
  dueAt:{type:Date,default:null},
  failureReason:{type:String,trim:true,maxlength:300},
  assignedBy:{...oid,ref:'User',default:null},
  // Every assignment and reassignment, so a dispute can be reconstructed.
  assignmentHistory:[{
    rider:{...oid,ref:'User'},
    assignedBy:{...oid,ref:'User'},
    at:{type:Date,default:Date.now},
    reason:{type:String,trim:true,maxlength:300},
    action:{type:String,enum:['assigned','reassigned','unassigned'],default:'assigned'}
  }],
  /**
   * Proof of delivery (Phase 12).
   *
   * `proofNote` is free text ("handed to customer", "left with reception").
   * `proofType` records HOW the handover was evidenced. There is no photo or
   * signature field: this repository has no object storage and inventing an
   * external service would be unverifiable, so the bounded, honest version is
   * a typed note plus an optional recipient name -- see README for the
   * documented storage limitation.
   */
  proofNote:{type:String,trim:true,maxlength:300},
  proofType:{type:String,enum:['handed_to_customer','left_with_neighbour','left_at_door','reception','other'],default:null},
  // Who actually took the food, when it was not the customer themselves.
  receivedBy:{type:String,trim:true,maxlength:120,default:null},
  // Set when the rider records the completion, distinct from deliveredAt so a
  // later correction cannot silently rewrite when proof was captured.
  proofAt:{type:Date,default:null},
  proofBy:{...oid,ref:'User',default:null}
},{timestamps:true});
// One LIVE delivery per order. A second dispatch is a duplicate and the
// database refuses it rather than trusting every caller to check. Cancelled
// rows are excluded so a failed attempt can legitimately be re-dispatched,
// and so the Phase 10 migration can retire historical duplicates instead of
// deleting them. This must stay identical to deliveryMigration.js.
deliverySchema.index({order:1},{unique:true,name:'delivery_order_unique',partialFilterExpression:{status:{$in:['pending','assigned','picked_up','out_for_delivery','delivered','failed']}}});
deliverySchema.index({restaurant:1,branch:1,status:1,createdAt:-1},{name:'delivery_scope_status'});
deliverySchema.index({rider:1,status:1,createdAt:-1},{name:'delivery_rider_queue'});
export const Delivery=model('Delivery',deliverySchema);

/**
 * The delivery state machine.
 *
 * Terminal states are dead ends: a delivered order cannot be walked back to
 * out_for_delivery, which would let a rider un-complete a finished job.
 */
export const DELIVERY_TRANSITIONS=Object.freeze({
  pending:['assigned','cancelled'],
  assigned:['picked_up','pending','failed','cancelled'],
  picked_up:['out_for_delivery','failed','cancelled'],
  out_for_delivery:['delivered','failed'],
  delivered:[],
  failed:[],
  cancelled:[]
});
export const Notification=model('Notification',new Schema({branch:{...oid,ref:'Branch'},user:{...oid,ref:'User'},type:String,title:String,body:String,read:{type:Boolean,default:false},referenceId:oid},{timestamps:true}));
