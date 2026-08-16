import mongoose from 'mongoose';
import {Ingredient} from '../models/index.js';
import {InventoryTransaction, WASTE_CATEGORY_TYPES} from '../models/operations.js';
import {inventoryMovementId, moveStock} from './inventoryLedger.js';
import {purchaseBranchContext} from './purchaseOrders.js';

const clean=value=>String(value??'').trim();
const money=value=>Math.round((Number(value)||0)*100)/100;
const httpError=(message,status=400)=>Object.assign(new Error(message),{status});
const KATHMANDU_OFFSET_MS=(5*60+45)*60*1000;

export const WASTE_CATEGORIES=WASTE_CATEGORY_TYPES;
export const WASTE_CATEGORY_LABELS=Object.freeze({
  expired:'Expired',
  spoiled:'Spoiled',
  damaged:'Damaged',
  burned:'Burned',
  spilled:'Spilled',
  wrong_preparation:'Wrong preparation',
  customer_return:'Customer return',
  other:'Other'
});

function normalizeWasteInput({branch,ingredient,qty,reason,notes,batchId,idempotencyKey}){
  if(!mongoose.isValidObjectId(branch)||!mongoose.isValidObjectId(ingredient))throw httpError('Invalid branch or ingredient');
  if(batchId&&!mongoose.isValidObjectId(batchId))throw httpError('Invalid waste batch');
  const quantity=Number(qty);
  if(!Number.isFinite(quantity)||quantity<=0)throw httpError('Waste quantity must be a positive finite number');
  if(!WASTE_CATEGORIES.includes(reason))throw httpError('Invalid waste category');
  const normalizedNotes=clean(notes);
  if(normalizedNotes.length>2000)throw httpError('Waste notes must be 2000 characters or fewer');
  const key=clean(idempotencyKey);
  if(key.length<3||key.length>200)throw httpError('A valid Idempotency-Key header is required');
  return {
    branch:String(branch),
    ingredient:String(ingredient),
    qty:quantity,
    reason,
    notes:normalizedNotes,
    batchId:batchId?String(batchId):'',
    idempotencyKey:key
  };
}

function ledgerReason(category,notes){
  const label=WASTE_CATEGORY_LABELS[category]||WASTE_CATEGORY_LABELS.other;
  const suffix=notes?` — ${notes}`:'';
  return `Waste: ${label}${suffix}`.slice(0,500);
}

async function wasteContext(input,user,session,{allowInactive=true}={}){
  const context=await purchaseBranchContext({user,branchId:input.branch,session,allowInactive});
  const ingredient=await Ingredient.findOne({_id:input.ingredient,restaurant:context.restaurantId})
    .select('name unit')
    .session(session||null);
  if(!ingredient)throw httpError('Ingredient not found',404);
  return {context,ingredient};
}

export async function recordWaste({branch,ingredient,qty,reason,notes,batchId,user,idempotencyKey,session}){
  if(!session?.inTransaction?.())throw httpError('Waste recording requires an active MongoDB transaction',500);
  const input=normalizeWasteInput({branch,ingredient,qty,reason,notes,batchId,idempotencyKey});
  const {context,ingredient:item}=await wasteContext(input,user,session);
  const referenceId=inventoryMovementId({
    restaurant:context.restaurantId,
    branch:input.branch,
    idempotencyKey:input.idempotencyKey
  });
  return moveStock({
    branch:input.branch,
    ingredient:input.ingredient,
    qty:-input.qty,
    unit:item.unit,
    type:'WASTE',
    reason:ledgerReason(input.reason,input.notes),
    referenceType:'waste',
    referenceId,
    user:context.userId,
    idempotencyKey:input.idempotencyKey,
    allowExpired:true,
    ...(input.batchId?{batchId:input.batchId,wasteBatch:input.batchId}:{}),
    wasteCategory:input.reason,
    wasteNotes:input.notes
  },session);
}

/** Recover a concurrent duplicate after the losing transaction aborts without posting a second movement. */
export async function replayWasteRecord({branch,ingredient,qty,reason,notes,batchId,user,idempotencyKey}){
  const input=normalizeWasteInput({branch,ingredient,qty,reason,notes,batchId,idempotencyKey});
  const {context}=await wasteContext(input,user,null,{allowInactive:true});
  const prior=await InventoryTransaction.findOne({
    restaurant:context.restaurantId,
    branch:input.branch,
    idempotencyKey:input.idempotencyKey
  });
  if(!prior)throw httpError('The prior waste request could not be recovered; retry with the same idempotency key',409);
  const matches=prior.type==='WASTE'
    &&prior.referenceType==='waste'
    &&String(prior.ingredient)===input.ingredient
    &&String(prior.user)===String(context.userId)
    &&Math.abs(Number(prior.changeQty)+input.qty)<=1e-9
    &&prior.wasteCategory===input.reason
    &&clean(prior.wasteNotes)===input.notes
    &&clean(prior.wasteBatch)===input.batchId;
  if(!matches)throw httpError('Idempotency key was already used for a different waste movement',409);
  return prior;
}

function dateBoundary(value,label){
  const text=clean(value);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))throw httpError(`${label} must use YYYY-MM-DD`);
  const [year,month,day]=text.split('-').map(Number);
  const canonical=new Date(Date.UTC(year,month-1,day));
  if(canonical.getUTCFullYear()!==year||canonical.getUTCMonth()!==month-1||canonical.getUTCDate()!==day){
    throw httpError(`${label} is not a valid date`);
  }
  return new Date(canonical.getTime()-KATHMANDU_OFFSET_MS);
}

function wasteItem(row){
  const batches=(row.batchMovements||[]).map(movement=>({
    batchId:movement.batch?._id||movement.batch,
    batchNumber:movement.batchNumber||movement.batch?.batchNumber||'',
    expiryDate:movement.expiryDate||movement.batch?.expiryDate||null,
    quantity:Math.abs(Number(movement.changeQty||0)),
    unitCost:Number(movement.unitCost||0)
  }));
  return {
    _id:row._id,
    category:row.wasteCategory||'other',
    categoryLabel:WASTE_CATEGORY_LABELS[row.wasteCategory]||WASTE_CATEGORY_LABELS.other,
    notes:row.wasteNotes||'',
    quantity:Math.abs(Number(row.changeQty||0)),
    unit:row.unit,
    unitCost:Number(row.unitCost||0),
    value:money(row.totalCost),
    previousQty:Number(row.previousQty||0),
    newQty:Number(row.newQty||0),
    ingredient:row.ingredient?._id?{
      _id:row.ingredient._id,
      name:row.ingredient.name,
      code:row.ingredient.code||'',
      unit:row.ingredient.unit||row.unit
    }:{_id:row.ingredient,name:'Ingredient',unit:row.unit},
    branch:row.branch?._id?{_id:row.branch._id,name:row.branch.name,code:row.branch.code||''}:{_id:row.branch},
    actor:row.user?._id?{_id:row.user._id,name:row.user.name,role:row.user.role}:{_id:row.user,name:'Unknown actor'},
    selectedBatch:row.wasteBatch?._id?{
      _id:row.wasteBatch._id,
      batchNumber:row.wasteBatch.batchNumber||'',
      expiryDate:row.wasteBatch.expiryDate||null
    }:null,
    batches,
    ledgerTransactionId:row._id,
    createdAt:row.createdAt
  };
}

export async function listWasteEvents({branchId,user,category,ingredient,from,to,page=1,limit=100}){
  if(!mongoose.isValidObjectId(branchId))throw httpError('Invalid branch');
  const context=await purchaseBranchContext({user,branchId,allowInactive:true});
  const selectedCategory=clean(category);
  if(selectedCategory&&!WASTE_CATEGORIES.includes(selectedCategory))throw httpError('Invalid waste category');
  const match={
    restaurant:new mongoose.Types.ObjectId(context.restaurantId),
    branch:new mongoose.Types.ObjectId(branchId),
    type:'WASTE'
  };
  if(ingredient){
    if(!mongoose.isValidObjectId(ingredient))throw httpError('Invalid ingredient');
    const exists=await Ingredient.exists({_id:ingredient,restaurant:context.restaurantId});
    if(!exists)throw httpError('Ingredient not found',404);
    match.ingredient=new mongoose.Types.ObjectId(ingredient);
  }
  if(from||to){
    match.createdAt={};
    if(from)match.createdAt.$gte=dateBoundary(from,'From date');
    if(to)match.createdAt.$lt=new Date(dateBoundary(to,'To date').getTime()+24*60*60*1000);
    if(match.createdAt.$gte&&match.createdAt.$lt&&match.createdAt.$gte>=match.createdAt.$lt)throw httpError('From date must not be after to date');
  }
  const safePage=Math.max(1,Number(page)||1);
  const safeLimit=Math.min(200,Math.max(1,Number(limit)||100));
  const eventMatch=selectedCategory?{...match,wasteCategory:selectedCategory}:match;
  const [rows,total,summaryRows]=await Promise.all([
    InventoryTransaction.find(eventMatch)
      .populate('ingredient','name code unit')
      .populate('branch','name code')
      .populate('user','name role')
      .populate('wasteBatch','batchNumber expiryDate')
      .populate('batchMovements.batch','batchNumber expiryDate')
      .sort({createdAt:-1,_id:-1})
      .skip((safePage-1)*safeLimit)
      .limit(safeLimit)
      .lean(),
    InventoryTransaction.countDocuments(eventMatch),
    InventoryTransaction.aggregate([
      {$match:match},
      {$group:{
        _id:{$ifNull:['$wasteCategory','other']},
        eventCount:{$sum:1},
        quantity:{$sum:{$abs:'$changeQty'}},
        value:{$sum:'$totalCost'}
      }}
    ])
  ]);
  const byCategory=new Map(summaryRows.map(row=>[row._id,row]));
  const categories=WASTE_CATEGORIES.map(key=>{
    const row=byCategory.get(key)||{};
    return {
      category:key,
      label:WASTE_CATEGORY_LABELS[key],
      eventCount:Number(row.eventCount||0),
      quantity:Number(row.quantity||0),
      value:money(row.value)
    };
  });
  return {
    items:rows.map(wasteItem),
    summary:{
      eventCount:summaryRows.reduce((sum,row)=>sum+Number(row.eventCount||0),0),
      totalQuantity:summaryRows.reduce((sum,row)=>sum+Number(row.quantity||0),0),
      totalValue:money(summaryRows.reduce((sum,row)=>sum+Number(row.value||0),0)),
      categories
    },
    pagination:{page:safePage,limit:safeLimit,total,pages:Math.max(1,Math.ceil(total/safeLimit))}
  };
}
