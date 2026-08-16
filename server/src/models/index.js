import mongoose from 'mongoose';
const {Schema,model}=mongoose; const money={type:Number,default:0};
const auditSchema=new Schema({entity:String,entityId:Schema.Types.ObjectId,restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant'},branch:{type:Schema.Types.ObjectId,ref:'Branch'},action:String,before:Schema.Types.Mixed,after:Schema.Types.Mixed,reason:String,user:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}});
auditSchema.index({restaurant:1,branch:1,entity:1,entityId:1,action:1,at:1},{name:'audit_entity_timeline'});
export const User=model('User',new Schema({name:String,email:{type:String,unique:true,lowercase:true},password:String,role:{type:String,enum:['owner','manager','staff'],default:'staff'},restaurant:String,restaurantId:{type:Schema.Types.ObjectId,ref:'Restaurant',index:true},branch:{type:Schema.Types.ObjectId,ref:'Branch'}},{timestamps:true}));
const supplierSchema=new Schema({
  restaurant:{type:Schema.Types.ObjectId,ref:'Restaurant',index:true},
  name:{type:String,required:true,trim:true,maxlength:120},
  nameNormalized:{type:String,trim:true,uppercase:true,select:false},
  contact:{type:String,trim:true,maxlength:120},
  address:{type:String,trim:true,maxlength:240},
  paymentTerms:{type:String,trim:true,maxlength:120},
  active:{type:Boolean,default:true},
  ingredients:[{type:Schema.Types.ObjectId,ref:'Ingredient'}],
  createdBy:{type:Schema.Types.ObjectId,ref:'User'},
  updatedBy:{type:Schema.Types.ObjectId,ref:'User'}
},{timestamps:true,autoIndex:false,optimisticConcurrency:true});
supplierSchema.pre('validate',function(){
  this.name=String(this.name||'').trim().replace(/\s+/g,' ');
  this.nameNormalized=this.name.toUpperCase();
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
export const MonthlySnapshot=model('MonthlySnapshot',monthlySnapshotSchema);
export const Audit=model('Audit',auditSchema);
