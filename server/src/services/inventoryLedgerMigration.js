import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Branch, INVENTORY_MOVEMENT_TYPES, WASTE_CATEGORY_TYPES, InventoryTransaction} from '../models/operations.js';
import {Ingredient, User} from '../models/index.js';

const id=value=>value?String(value):'';
const finite=value=>Number.isFinite(Number(value));
const validHash=value=>/^[a-f0-9]{64}$/.test(String(value||''));
const positiveTypes=new Set(['OPENING','PURCHASE','REVERSAL','TRANSFER_IN']);
const negativeTypes=new Set(['SALE','RECIPE_DEDUCTION','WASTE','TRANSFER_OUT','RETURN']);

function legacyWasteCategory(document){
  if(WASTE_CATEGORY_TYPES.includes(document.wasteCategory))return document.wasteCategory;
  const evidence=String(document.reason||'').toLowerCase();
  return WASTE_CATEGORY_TYPES.find(category=>category!=='other'&&(
    evidence.includes(category)||evidence.includes(category.replaceAll('_',' '))
  ))||'other';
}

function legacyWasteNotes(document){
  if(document.wasteNotes!=null)return String(document.wasteNotes).trim().slice(0,2000);
  const reason=String(document.reason||'');
  const separator=reason.indexOf('—');
  return separator<0?'':reason.slice(separator+1).trim().slice(0,2000);
}

function legacyHash(document){
  return crypto.createHash('sha256').update(JSON.stringify({
    migration:'inventory-ledger-v2',
    id:id(document._id),
    branch:id(document.branch),
    ingredient:id(document.ingredient),
    type:document.type,
    previousQty:document.previousQty,
    changeQty:document.changeQty,
    newQty:document.newQty
  })).digest('hex');
}

function quantities(document,type){
  let previous=finite(document.previousQty)?Number(document.previousQty):null;
  let change=finite(document.changeQty)?Number(document.changeQty):null;
  let next=finite(document.newQty)?Number(document.newQty):null;
  if(previous===null&&change!==null&&next!==null)previous=next-change;
  if(change===null&&previous!==null&&next!==null)change=next-previous;
  if(next===null&&previous!==null&&change!==null)next=previous+change;
  if(![previous,change,next].every(Number.isFinite)||Math.abs(change)<=1e-9||previous<-1e-9||next<-1e-9||Math.abs(previous+change-next)>1e-7){
    throw new Error(`Inventory ledger migration cannot reconstruct quantities for transaction ${document._id}`);
  }
  if(positiveTypes.has(type)&&change<0)throw new Error(`Inventory ledger transaction ${document._id} has an invalid direction for ${type}`);
  if(negativeTypes.has(type)&&change>0)throw new Error(`Inventory ledger transaction ${document._id} has an invalid direction for ${type}`);
  return {previousQty:Math.max(0,previous),changeQty:change,newQty:Math.max(0,next)};
}

async function normalizedUpdates(documents){
  const branchIds=[...new Set(documents.map(row=>id(row.branch)).filter(value=>mongoose.isValidObjectId(value)))];
  const ingredientIds=[...new Set(documents.map(row=>id(row.ingredient)).filter(value=>mongoose.isValidObjectId(value)))];
  const userIds=[...new Set(documents.map(row=>id(row.user)).filter(value=>mongoose.isValidObjectId(value)))];
  const [branches,ingredients,users]=await Promise.all([
    Branch.collection.find({_id:{$in:branchIds.map(value=>new mongoose.Types.ObjectId(value))}},{projection:{restaurant:1}}).toArray(),
    Ingredient.collection.find({_id:{$in:ingredientIds.map(value=>new mongoose.Types.ObjectId(value))}},{projection:{restaurant:1,unit:1}}).toArray(),
    User.collection.find({_id:{$in:userIds.map(value=>new mongoose.Types.ObjectId(value))}},{projection:{restaurantId:1}}).toArray()
  ]);
  const branchById=new Map(branches.map(row=>[id(row._id),row]));
  const ingredientById=new Map(ingredients.map(row=>[id(row._id),row]));
  const userById=new Map(users.map(row=>[id(row._id),row]));
  const idempotencyOwners=new Map();

  return documents.map(document=>{
    if(!mongoose.isValidObjectId(document.branch)||!mongoose.isValidObjectId(document.ingredient)){
      throw new Error(`Inventory ledger transaction ${document._id} is missing a valid branch or ingredient`);
    }
    if(!mongoose.isValidObjectId(document.user))throw new Error(`Inventory ledger transaction ${document._id} is missing its user`);
    const branch=branchById.get(id(document.branch));
    if(!branch?.restaurant)throw new Error(`Inventory ledger transaction ${document._id} references a branch without a restaurant`);
    const ingredient=ingredientById.get(id(document.ingredient));
    if(!ingredient)throw new Error(`Inventory ledger transaction ${document._id} references an unknown ingredient`);
    if(id(ingredient.restaurant)!==id(branch.restaurant)){
      throw new Error(`Inventory ledger transaction ${document._id} crosses restaurant boundaries`);
    }
    const actor=userById.get(id(document.user));
    if(!actor||id(actor.restaurantId)!==id(branch.restaurant)){
      throw new Error(`Inventory ledger transaction ${document._id} has an actor outside its restaurant`);
    }
    if(document.restaurant&&id(document.restaurant)!==id(branch.restaurant)){
      throw new Error(`Inventory ledger transaction ${document._id} has conflicting restaurant ownership`);
    }
    const type=document.type==='RECIPE_REVERSAL'?'REVERSAL':document.type;
    if(!INVENTORY_MOVEMENT_TYPES.includes(type))throw new Error(`Inventory ledger transaction ${document._id} has unsupported type ${document.type}`);
    const upgradesLegacyWaste=type==='WASTE'&&!WASTE_CATEGORY_TYPES.includes(document.wasteCategory);
    const quantity=quantities(document,type);
    const unitCost=finite(document.unitCost)&&Number(document.unitCost)>=0
      ?Number(document.unitCost)
      :finite(document.totalCost)&&Number(document.totalCost)>=0
        ?Math.abs(Number(document.totalCost)/quantity.changeQty)
        :0;
    if(!Number.isFinite(unitCost)||unitCost<0)throw new Error(`Inventory ledger transaction ${document._id} has an invalid cost`);
    const createdAt=document.createdAt instanceof Date&&!Number.isNaN(document.createdAt.getTime())
      ?document.createdAt
      :document._id.getTimestamp();
    const normalized={
      restaurant:branch.restaurant,
      branch:document.branch,
      ingredient:document.ingredient,
      type,
      ...quantity,
      unit:String(document.unit||ingredient.unit||'unit').trim().slice(0,30)||'unit',
      unitCost,
      totalCost:Math.abs(quantity.changeQty)*unitCost,
      reason:String(document.reason||`Imported ${type.toLowerCase()} inventory movement`).trim().slice(0,500),
      referenceType:String(document.referenceType||`legacy_${type.toLowerCase()}`).trim().slice(0,80),
      referenceId:mongoose.isValidObjectId(document.referenceId)?document.referenceId:document._id,
      user:document.user,
      idempotencyKey:String(document.idempotencyKey||`ledger-migration:${document._id}`).trim().slice(0,200),
      idempotencyHash:validHash(document.idempotencyHash)?document.idempotencyHash:legacyHash({...document,type,...quantity}),
      idempotencyHashVersion:upgradesLegacyWaste?1:Number(document.idempotencyHashVersion)===2?2:1,
      createdAt,
      updatedAt:document.updatedAt instanceof Date?document.updatedAt:createdAt
    };
    if(type==='WASTE'){
      normalized.wasteCategory=legacyWasteCategory(document);
      const wasteNotes=legacyWasteNotes(document);
      if(wasteNotes)normalized.wasteNotes=wasteNotes;
      if(mongoose.isValidObjectId(document.wasteBatch))normalized.wasteBatch=document.wasteBatch;
    }
    if(normalized.reason.length<3)normalized.reason=`Imported ${type.toLowerCase()} movement`;
    if(normalized.referenceType.length<2)normalized.referenceType='legacy';
    if(normalized.idempotencyKey.length<3)normalized.idempotencyKey=`ledger-migration:${document._id}`;
    const idempotencyScope=`${normalized.restaurant}:${normalized.branch}:${normalized.idempotencyKey}`;
    const prior=idempotencyOwners.get(idempotencyScope);
    if(prior)throw new Error(`Inventory ledger migration found duplicate idempotency keys in transactions ${prior} and ${document._id}`);
    idempotencyOwners.set(idempotencyScope,document._id);
    return {updateOne:{filter:{_id:document._id},update:{$set:normalized}}};
  });
}

async function replaceIndexes(collection){
  const targets={
    inventory_transaction_tenant_idempotency:{key:{restaurant:1,branch:1,idempotencyKey:1},unique:true},
    inventory_transaction_tenant_ingredient_timeline:{key:{restaurant:1,branch:1,ingredient:1,createdAt:-1}},
    inventory_transaction_purchasing_report:{key:{restaurant:1,branch:1,type:1,referenceType:1,createdAt:-1}},
    inventory_transaction_waste_report:{key:{restaurant:1,branch:1,type:1,wasteCategory:1,createdAt:-1}},
    inventory_transaction_reference_timeline:{key:{restaurant:1,referenceType:1,referenceId:1,createdAt:-1}}
  };
  const indexes=await collection.indexes();
  const obsolete=indexes.filter(index=>{
    if(index.name==='_id_')return false;
    const keys=Object.keys(index.key||{});
    if(index.name==='inventory_transaction_branch_idempotency'||index.name==='inventory_tx_branch_idempotency_unique')return true;
    if(index.unique&&keys.length===2&&keys[0]==='branch'&&keys[1]==='idempotencyKey')return true;
    const target=targets[index.name];
    return Boolean(target&&(JSON.stringify(index.key)!==JSON.stringify(target.key)||Boolean(index.unique)!==Boolean(target.unique)));
  });
  for(const index of obsolete)await collection.dropIndex(index.name);
  for(const [name,target] of Object.entries(targets)){
    await collection.createIndex(target.key,{name,...(target.unique?{unique:true}:{})});
  }
  return obsolete.map(index=>index.name);
}

export async function ensureInventoryLedgerIndexes(){
  const collection=InventoryTransaction.collection;
  const documents=await collection.find({}).toArray();
  const operations=await normalizedUpdates(documents);
  const session=await mongoose.startSession();
  let ingredientStockFieldsRemoved=0;
  try{
    await session.withTransaction(async()=>{
      if(operations.length)await collection.bulkWrite(operations,{session,ordered:true});
      const removed=await Ingredient.collection.updateMany(
        {$or:[
          {stockQty:{$exists:true}},
          {averageCost:{$exists:true}},
          {quantity:{$exists:true}},
          {unitCost:{$exists:true}}
        ]},
        {$unset:{stockQty:'',averageCost:'',quantity:'',unitCost:''}},
        {session}
      );
      ingredientStockFieldsRemoved=removed.modifiedCount;
    });
  }finally{
    await session.endSession();
  }
  const droppedIndexes=await replaceIndexes(collection);
  return {scanned:documents.length,migrated:operations.length,ingredientStockFieldsRemoved,droppedIndexes};
}
