import mongoose from 'mongoose';
const {Schema,model}=mongoose; const money={type:Number,default:0};
const auditSchema=new Schema({entity:String,entityId:Schema.Types.ObjectId,action:String,before:Schema.Types.Mixed,after:Schema.Types.Mixed,user:{type:Schema.Types.ObjectId,ref:'User'},at:{type:Date,default:Date.now}});
export const User=model('User',new Schema({name:String,email:{type:String,unique:true,lowercase:true},password:String,role:{type:String,enum:['owner','manager','staff'],default:'staff'},restaurant:String,branch:{type:Schema.Types.ObjectId,ref:'Branch'}},{timestamps:true}));
export const Supplier=model('Supplier',new Schema({name:{type:String,required:true},contact:String,address:String,paymentTerms:String,ingredients:[{type:Schema.Types.ObjectId,ref:'Ingredient'}]},{timestamps:true}));
export const Ingredient=model('Ingredient',new Schema({code:{type:String,unique:true},name:{type:String,required:true},nameNp:String,category:String,unit:{type:String,default:'g'},minimumStock:money,reorderQty:money,stockQty:money,averageCost:money,lastPurchasePrice:money,supplier:{type:Schema.Types.ObjectId,ref:'Supplier'},expiryDate:Date},{timestamps:true}));
export const PriceHistory=model('PriceHistory',new Schema({ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},price:money,qty:money,unit:String,effectiveAt:{type:Date,default:Date.now},purchase:{type:Schema.Types.ObjectId,ref:'Purchase'},user:{type:Schema.Types.ObjectId,ref:'User'}}));
export const MenuItem=model('MenuItem',new Schema({name:{type:String,required:true},nameNp:String,category:String,price:money,vatInclusive:{type:Boolean,default:true},active:{type:Boolean,default:true},recipe:[{ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},qty:money,unit:String}]},{timestamps:true}));
export const Purchase=model('Purchase',new Schema({date:{type:Date,default:Date.now},supplier:{type:Schema.Types.ObjectId,ref:'Supplier'},ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},qty:money,unit:String,total:money,unitPrice:money,invoiceNo:String,paymentStatus:{type:String,enum:['paid','due','partial'],default:'due'},paidAmount:money,createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
export const Sale=model('Sale',new Schema({date:{type:Date,default:Date.now},items:[{menuItem:{type:Schema.Types.ObjectId,ref:'MenuItem'},name:String,qty:money,unitPrice:money,foodCost:money}],orderType:{type:String,default:'dine-in'},paymentMethod:{type:String,default:'cash'},subtotal:money,vat:money,total:money,cogs:money,grossProfit:money,createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
export const Waste=model('Waste',new Schema({date:{type:Date,default:Date.now},ingredient:{type:Schema.Types.ObjectId,ref:'Ingredient'},qty:money,reason:String,cost:money,createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
export const Expense=model('Expense',new Schema({date:{type:Date,default:Date.now},category:String,description:String,amount:money,vat:money,branch:{type:Schema.Types.ObjectId,ref:'Branch'},createdBy:{type:Schema.Types.ObjectId,ref:'User'}},{timestamps:true}));
const monthlySnapshotSchema=new Schema({
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
monthlySnapshotSchema.index({scopeKey:1,month:1,revision:1},{unique:true});
monthlySnapshotSchema.index({scopeKey:1,month:1,status:1});
export const MonthlySnapshot=model('MonthlySnapshot',monthlySnapshotSchema);
export const Audit=model('Audit',auditSchema);
