import mongoose from 'mongoose';
const {Schema,model}=mongoose; const money={type:Number,default:0};
const auditSchema=new Schema({entity:String,entityId:Schema.Types.ObjectId,restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant'},branch:{type:Schema.Types.ObjectId,ref:'Branch'},action:String,before:Schema.Types.Mixed,after:Schema.Types.Mixed,reason:String,user:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}});
auditSchema.index({restaurant:1,branch:1,entity:1,entityId:1,action:1,at:1},{name:'audit_entity_timeline'});
/**
 * Phase 10 adds the 'rider' role.
 *
 * A rider is the least-privileged principal in the system: they may see and
 * advance ONLY the deliveries assigned to them. Because several legacy
 * endpoints are guarded by a bare auth() (any authenticated user), adding this
 * role without care would have handed riders the branch list, transfers and
 * the expense ledger. Those call sites were tightened in the same change --
 * see requireStaff() in middleware/auth.js.
 */
export const RIDER_VEHICLES=Object.freeze(['motorcycle','scooter','bicycle','car','on-foot']);
export const User=model('User',new Schema({name:String,email:{type:String,unique:true,lowercase:true},password:String,role:{type:String,enum:['owner','manager','staff','rider'],default:'staff'},
  // Phase 12: employment state for ANY account. Enforced at login, so a
  // deactivated employee cannot authenticate even with a valid password.
  active:{type:Boolean,default:true},
  restaurant:String,restaurantId:{type:Schema.Types.ObjectId,ref:'Restaurant',index:true},branch:{type:Schema.Types.ObjectId,ref:'Branch'},
  // Rider profile. Only meaningful when role === 'rider'.
  rider:{
    // Employment state: an inactive rider cannot be assigned anything.
    active:{type:Boolean,default:true},
    // Shift state: on/off duty. Distinct from `active` because a rider who is
    // simply off shift must not be confused with one who has left.
    available:{type:Boolean,default:false},
    phone:{type:String,trim:true,maxlength:30},
    vehicle:{type:String,enum:RIDER_VEHICLES,default:'motorcycle'},
    licencePlate:{type:String,trim:true,maxlength:20},
    // How many live deliveries this rider may hold at once.
    maxConcurrent:{type:Number,default:3,min:1,max:20},
    notes:{type:String,trim:true,maxlength:500}
  }},{timestamps:true}));
const supplierSchema=new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',index:true},
  name:{type:String,required:true,trim:true,maxlength:120},
  nameNormalized:{type:String,trim:true,uppercase:true,select:false},
  contact:{type:String,trim:true,maxlength:120},
  address:{type:String,trim:true,maxlength:240},
  paymentTerms:{type:String,trim:true,maxlength:120},
  // Phase 16 — supplier master data. `contact`/`address` were single free-text
  // strings, so a supplier with a sales rep and an accounts contact, or a
  // billing and a delivery address, had nowhere to put them.
  contacts:[{
    name:{type:String,trim:true,maxlength:120},
    role:{type:String,trim:true,maxlength:60},
    phone:{type:String,trim:true,maxlength:40},
    email:{type:String,trim:true,lowercase:true,maxlength:160},
    primary:{type:Boolean,default:false}
  }],
  addresses:[{
    label:{type:String,trim:true,maxlength:60},
    line1:{type:String,trim:true,maxlength:200},
    city:{type:String,trim:true,maxlength:80},
    kind:{type:String,enum:['billing','delivery','other'],default:'other'}
  }],
  // Nepal tax registration. PAN is 9 digits; a VAT-registered supplier must
  // carry one before its invoices can be claimed.
  pan:{type:String,trim:true,maxlength:20},
  vatRegistered:{type:Boolean,default:false},
  // Credit control. `paymentTermsDays` is the machine-readable form of the
  // free-text paymentTerms, used to age invoices and derive due dates.
  paymentTermsDays:{type:Number,default:0,min:0,max:365},
  creditLimit:{type:Number,default:0,min:0},
  // Lead time for reorder suggestions when the catalog has no per-item value.
  leadTimeDays:{type:Number,default:0,min:0,max:365},
  // `status` supersedes the boolean `active`, which is kept in step below so
  // every existing query that filters on it keeps working.
  status:{type:String,enum:['active','on_hold','blacklisted','inactive'],default:'active',index:true},
  statusReason:{type:String,trim:true,maxlength:300},
  active:{type:Boolean,default:true},
  ingredients:[{type:Schema.Types.ObjectId,ref:'Ingredient'}],
  createdBy:{type:Schema.Types.ObjectId,ref:'User'},
  updatedBy:{type:Schema.Types.ObjectId,ref:'User'}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
supplierSchema.pre('validate',function(){
  this.name=String(this.name||'').trim().replace(/\s+/g,' ');
  this.nameNormalized=this.name.toUpperCase();
  // `status` and `active` are two views of one fact. Keeping them in lockstep
  // means legacy `active:false` queries and the richer status both stay true,
  // rather than a supplier being blacklisted yet still 'active' to old code.
  if(this.isModified('status')&&!this.isModified('active')){
    this.active=this.status==='active';
  }else if(this.isModified('active')&&!this.isModified('status')){
    this.status=this.active?'active':'inactive';
  }
  if(this.pan!=null&&String(this.pan).trim()!==''){
    const pan=String(this.pan).trim();
    if(!/^\d{9}$/.test(pan))this.invalidate('pan','Supplier PAN must be exactly 9 digits');
  }
  // A VAT-registered supplier without a PAN cannot issue a claimable invoice.
  if(this.vatRegistered&&!String(this.pan||'').trim()){
    this.invalidate('pan','A VAT-registered supplier requires a PAN');
  }
  const primaries=(this.contacts||[]).filter(row=>row.primary).length;
  if(primaries>1)this.invalidate('contacts','Only one contact can be primary');
});
supplierSchema.index(
  {restaurant:1,nameNormalized:1},
  {unique:true,name:'supplier_restaurant_name',partialFilterExpression:{restaurant:{$type:'objectId'},nameNormalized:{$type:'string'}}}
);
export const Supplier=model('Supplier',supplierSchema);
const ingredientSchema=new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',index:true},
  code:{type:String,trim:true,uppercase:true,maxlength:30},
  name:{type:String,required:true,trim:true,maxlength:120},
  nameNp:{type:String,trim:true,maxlength:120},
  category:{type:String,trim:true,maxlength:60,default:'other'},
  unit:{type:String,trim:true,lowercase:true,maxlength:30,default:'g',required:true},
  baseUnit:{type:String,trim:true,lowercase:true,maxlength:30},
  conversions:{type:[{unit:{type:String,trim:true,lowercase:true,maxlength:30,required:true},factor:{type:Number,required:true,min:Number.EPSILON,max:1000000},description:{type:String,trim:true,maxlength:120}}],default:undefined},
  unitConversions:{type:Map,of:Number,default:undefined},
  active:{type:Boolean,default:true,index:true},
  minimumStock:{...money,default:0},
  reorderQty:{...money,default:0},
  reorderLevel:{...money,default:0},
  lastPurchasePrice:{...money,default:0},
  standardCost:{...money,default:0},
  supplier:{type:Schema.Types.ObjectId,ref:'Supplier'},
  primarySupplier:{type:Schema.Types.ObjectId,ref:'Supplier'},
  supplierCount:{type:Number,default:0,min:0},
  shelfLifeDays:{type:Number,min:0,max:3650},
  storage:{type:String,trim:true,maxlength:120},
  description:{type:String,trim:true,maxlength:500},
  expiryDate:Date
},{timestamps:true,strict:'throw',optimisticConcurrency:true});
ingredientSchema.pre('validate',function(){
  if(this.code) this.code=String(this.code).trim().toUpperCase().replace(/\s+/g,'');
  if(this.name) this.name=String(this.name).trim().replace(/\s+/g,' ');
  if(this.category) this.category=String(this.category).trim().toLowerCase();
  if(this.unit) this.unit=String(this.unit).trim().toLowerCase();
  if(this.baseUnit) this.baseUnit=String(this.baseUnit).trim().toLowerCase();
  else this.baseUnit=this.unit;
  // normalize conversions
  if(Array.isArray(this.conversions)){
    const seen=new Set();
    this.conversions=this.conversions.filter(c=>{
      const u=String(c.unit||'').trim().toLowerCase();
      if(!u || seen.has(u) || u===this.baseUnit) return false;
      seen.add(u);
      c.unit=u;
      c.factor=Number(c.factor);
      return Number.isFinite(c.factor) && c.factor>0;
    });
    if(!this.conversions.length) this.conversions=undefined;
  }
  if(this.unitConversions && this.unitConversions instanceof Map){
    for(const [k,v] of this.unitConversions.entries()){
      if(!k || Number(v)<=0) this.unitConversions.delete(k);
    }
    if(this.unitConversions.size===0) this.unitConversions=undefined;
  }
});
ingredientSchema.index({restaurant:1,code:1},{unique:true,name:'ingredient_restaurant_code',partialFilterExpression:{restaurant:{$type:'objectId'},code:{$type:'string'}}});
ingredientSchema.index({restaurant:1,name:1},{name:'ingredient_restaurant_name'});
ingredientSchema.index({restaurant:1,category:1,active:1},{name:'ingredient_restaurant_category'});
ingredientSchema.index({restaurant:1,unit:1},{name:'ingredient_restaurant_unit'});
ingredientSchema.index({restaurant:1,primarySupplier:1},{name:'ingredient_restaurant_supplier'});
export const Ingredient=model('Ingredient',ingredientSchema);
export const PriceHistory=model('PriceHistory',new Schema({ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},price:money,qty:money,unit:String,effectiveAt:{type:Date,default:Date.now},purchase:{type:Schema.Types.ObjectId,ref:'Purchase'},user:{type:Schema.Types.ObjectId,ref:'User'}}));
export const MenuItem=model('MenuItem',new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',index:true},
  name:{type:String,required:true,trim:true,maxlength:120},
  nameNp:{type:String,trim:true,maxlength:120},
  code:{type:String,trim:true,uppercase:true,maxlength:30},
  category:{type:String,trim:true,maxlength:60,default:'main'},
  price:{...money,required:true,min:0.01},
  vatInclusive:{type:Boolean,default:true},
  vatRate:{type:Number,default:13,min:0,max:100},
  active:{type:Boolean,default:true,index:true},
  yield:{type:Number,default:1,min:0.01,max:1000},
  yieldUnit:{type:String,trim:true,maxlength:30,default:'serving'},
  recipe:{type:[{
    ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient',required:true},
    qty:{...money,required:true,min:Number.EPSILON},
    unit:{type:String,trim:true,maxlength:30,required:true},
    cost:{...money,default:0},
    notes:{type:String,trim:true,maxlength:200}
  }],validate:{validator: function(v){ return !v || v.length<=50; }, message:'Recipe cannot have more than 50 ingredients'}},
  recipeVersion:{type:Number,default:1,min:1},
  recipeHistory:{type:[{
    version:{type:Number,required:true,min:1},
    recipe:{type:[{
      ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient',required:true},
      qty:{type:Number,required:true,min:Number.EPSILON},
      unit:{type:String,required:true},
      cost:{type:Number,default:0},
      notes:String
    }],required:true},
    recipeCost:{type:Number,default:0},
    packagingCost:{type:Number,default:0},
    foodCost:{type:Number,default:0},
    updatedAt:{type:Date,default:Date.now},
    updatedBy:{type:Schema.Types.ObjectId,ref:'User'},
    reason:{type:String,trim:true,maxlength:500}
  }],default:[]},
  // Phase 5A — KDS: which kitchen section prepares this item, and how long it
  // is expected to take. Drives station filtering and age-based priority.
  station:{type:String,trim:true,lowercase:true,maxlength:40,default:null,index:true},
  prepMinutes:{type:Number,min:0,max:600,default:0},
  // Phase 4B — POS modifiers. A group is a choice presented at the till
  // (Size, Extras, Remove...); each option may re-price the line and may map
  // to an ingredient so stock and food cost follow the guest's choice.
  modifierGroups:{type:[{
    key:{type:String,trim:true,maxlength:40,required:true},
    name:{type:String,trim:true,maxlength:80,required:true},
    kind:{type:String,enum:['variant','extra','addon','removal'],default:'extra'},
    selection:{type:String,enum:['single','multi'],default:'multi'},
    required:{type:Boolean,default:false},
    minSelect:{type:Number,default:0,min:0,max:50},
    maxSelect:{type:Number,default:0,min:0,max:50},
    options:{type:[{
      key:{type:String,trim:true,maxlength:40,required:true},
      name:{type:String,trim:true,maxlength:80,required:true},
      // Variants replace the line price; every other kind is a delta.
      priceDelta:{...money,default:0},
      priceOverride:{type:Number,min:0,default:null},
      isDefault:{type:Boolean,default:false},
      ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient',default:null},
      // Positive consumes extra stock; a removal credits the qty back.
      qty:{type:Number,default:0,min:0},
      unit:{type:String,trim:true,maxlength:30}
    }],default:[]}
  }],default:[]},
  recipeCost:{...money,default:0},
  packagingCost:{...money,default:0},
  foodCost:{...money,default:0},
  recipeCostUpdatedAt:Date,
  description:{type:String,trim:true,maxlength:500},
  imageUrl:{type:String,trim:true,maxlength:500}
},{timestamps:true,optimisticConcurrency:true}));
MenuItem.schema.index({restaurant:1,code:1},{unique:true,name:'menu_restaurant_code',partialFilterExpression:{restaurant:{$type:'objectId'},code:{$type:'string'}}});
MenuItem.schema.index({restaurant:1,name:1},{unique:true,name:'menu_restaurant_name',partialFilterExpression:{restaurant:{$type:'objectId'},name:{$type:'string'}}});
export const Purchase=model('Purchase',new Schema({date:{type:Date,default:Date.now},supplier:{type:Schema.Types.ObjectId,ref:'Supplier'},ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},qty:money,unit:String,total:money,unitPrice:money,invoiceNo:String,paymentStatus:{type:String,enum:['paid','due','partial'],default:'due'},paidAmount:money,createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
export const Sale=model('Sale',new Schema({date:{type:Date,default:Date.now},items:[{menuItem:{type:Schema.Types.ObjectId,ref:'MenuItem'},name:String,qty:money,unitPrice:money,foodCost:money}],orderType:{type:String,default:'dine-in'},paymentMethod:{type:String,default:'cash'},subtotal:money,vat:money,total:money,cogs:money,grossProfit:money,createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
export const Waste=model('Waste',new Schema({date:{type:Date,default:Date.now},ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},qty:money,reason:String,cost:money,createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
export const Expense=model('Expense',new Schema({date:{type:Date,default:Date.now},category:String,description:String,amount:money,vat:money,branch:{type:Schema.Types.ObjectId,ref:'Branch'},createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
const monthlySnapshotSchema=new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',required:true,immutable:true,index:true},
  month:{type:String,required:true,match:/^\d{4}-(0[1-9]|1[0-2])$/,immutable:true},
  branch:{type:Schema.Types.ObjectId,ref:'Branch',default:null,immutable:true},
  scopeKey:{type:String,required:true,immutable:true},
  revision:{type:Number,default:1,min:1,immutable:true},
  status:{type:String,enum:['closed','reopened'],default:'closed'},
  currency:{type:String,default:'NPR',immutable:true},
  vatRate:{type:Number,default:13,immutable:true},
  periodFrom:{type:Date,immutable:true},
  periodTo:{type:Date,immutable:true},
  revenue:{...money,immutable:true},
  cogs:{...money,immutable:true},
  grossProfit:{...money,immutable:true},
  purchases:{...money,immutable:true},
  waste:{...money,immutable:true},
  expenses:{...money,immutable:true},
  netProfit:{...money,immutable:true},
  netMargin:{...money,immutable:true},
  openingInventory:{...money,immutable:true},
  closingInventory:{...money,immutable:true},
  sales:{type:Schema.Types.Mixed,immutable:true},
  purchasing:{type:Schema.Types.Mixed,immutable:true},
  expenseDetail:{type:Schema.Types.Mixed,immutable:true},
  wasteDetail:{type:Schema.Types.Mixed,immutable:true},
  reconciliation:{type:Schema.Types.Mixed,immutable:true},
  notes:{type:String,default:'',immutable:true},
  closedAt:{type:Date,default:Date.now,immutable:true},
  closedBy:{type:Schema.Types.ObjectId,ref:'User',immutable:true},
  reopenedAt:Date,
  reopenedBy:{type:Schema.Types.ObjectId,ref:'User'},
  reopenReason:String
},{timestamps:true,autoIndex:false});
monthlySnapshotSchema.index({restaurant:1,scopeKey:1,month:1,revision:1},{unique:true,name:'monthly_snapshot_restaurant_revision'});
monthlySnapshotSchema.index({restaurant:1,scopeKey:1,month:1,status:1},{name:'monthly_snapshot_restaurant_status'});
// Phase 4C — Discounts & Promotions.
const couponSchema=new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',required:true,index:true},
  code:{type:String,required:true,trim:true,uppercase:true,maxlength:40},
  description:{type:String,trim:true,maxlength:300},
  kind:{type:String,enum:['percentage','fixed'],required:true},
  // Percentage 0<v<=100; fixed is an NPR amount off the eligible net.
  value:{type:Number,required:true,min:0},
  maxDiscount:{type:Number,min:0,default:null},
  minOrderAmount:{type:Number,min:0,default:0},
  startsAt:{type:Date,default:null},
  endsAt:{type:Date,default:null},
  usageLimit:{type:Number,min:0,default:0},
  perCustomerLimit:{type:Number,min:0,default:0},
  timesRedeemed:{type:Number,default:0,min:0},
  branches:[{type:Schema.Types.ObjectId,ref:'Branch'}],
  menuItems:[{type:Schema.Types.ObjectId,ref:'MenuItem'}],
  orderTypes:[{type:String}],
  active:{type:Boolean,default:true,index:true},
  createdBy:{type:Schema.Types.ObjectId,ref:'User'},
  updatedBy:{type:Schema.Types.ObjectId,ref:'User'}
},{timestamps:true});
couponSchema.index({restaurant:1,code:1},{unique:true,name:'coupon_restaurant_code'});
export const Coupon=model('Coupon',couponSchema);

const couponRedemptionSchema=new Schema({
  coupon:{type:Schema.Types.ObjectId,ref:'Coupon',required:true,index:true},
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',required:true,index:true},
  branch:{type:Schema.Types.ObjectId,ref:'Branch'},
  order:{type:Schema.Types.ObjectId,ref:'Order',required:true},
  customer:{type:Schema.Types.ObjectId,ref:'Customer',default:null},
  code:{type:String,required:true,uppercase:true},
  amount:{type:Number,required:true,min:0},
  redeemedBy:{type:Schema.Types.ObjectId,ref:'User'}
},{timestamps:true});
// One redemption row per order guarantees usage counts cannot double-count.
couponRedemptionSchema.index({coupon:1,order:1},{unique:true,name:'coupon_redemption_order'});
couponRedemptionSchema.index({coupon:1,customer:1},{name:'coupon_redemption_customer'});
export const CouponRedemption=model('CouponRedemption',couponRedemptionSchema);

// Phase 5C — kitchen stations, definable per restaurant.
const kitchenStationSchema=new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',required:true,index:true},
  code:{type:String,required:true,trim:true,lowercase:true,maxlength:40},
  name:{type:String,required:true,trim:true,maxlength:80},
  // Menu categories routed here when an item declares no station of its own.
  categories:[{type:String,trim:true,lowercase:true,maxlength:60}],
  sortOrder:{type:Number,default:0},
  // Exactly one station per restaurant catches otherwise unrouted items.
  isDefault:{type:Boolean,default:false},
  active:{type:Boolean,default:true,index:true},
  createdBy:{type:Schema.Types.ObjectId,ref:'User'},
  updatedBy:{type:Schema.Types.ObjectId,ref:'User'}
},{timestamps:true});
kitchenStationSchema.index({restaurant:1,code:1},{unique:true,name:'station_restaurant_code'});
export const KitchenStation=model('KitchenStation',kitchenStationSchema);

export const MonthlySnapshot=model('MonthlySnapshot',monthlySnapshotSchema);
export const Audit=model('Audit',auditSchema);
