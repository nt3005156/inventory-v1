import crypto from 'node:crypto';
import mongoose from 'mongoose';
import {Ingredient, MenuItem, User} from '../models/index.js';
import {Branch, INVENTORY_MOVEMENT_TYPES, InventoryBalance, InventoryTransaction, Notification, Order} from '../models/operations.js';
import {addBatchStock, removeBatchStock} from './inventoryBatches.js';

function canonical(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort().flatMap(key => {
    const normalized = canonical(value[key]);
    return normalized === undefined ? [] : [[key, normalized]];
  }));
}

export function inventoryMovementFingerprint(input) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex');
}

export function inventoryMovementId({restaurant, branch, idempotencyKey}) {
  return new mongoose.Types.ObjectId(
    inventoryMovementFingerprint({restaurant, branch, idempotencyKey: clean(idempotencyKey)}).slice(0, 24)
  );
}

function httpError(message,status=400){
  return Object.assign(new Error(message),{status});
}

const clean=value=>String(value??'').trim();
const positiveTypes=new Set(['OPENING','PURCHASE','REVERSAL','TRANSFER_IN']);
const negativeTypes=new Set(['SALE','RECIPE_DEDUCTION','WASTE','TRANSFER_OUT','RETURN']);

function validateMovementInput(input,session){
  if(!session?.inTransaction?.())throw httpError('Inventory movements require an active MongoDB transaction',500);
  for(const [label,value] of [['branch',input.branch],['ingredient',input.ingredient],['user',input.user],['reference',input.referenceId]]){
    if(!mongoose.isValidObjectId(value))throw httpError(`Invalid inventory movement ${label}`);
  }
  const amount=Number(input.qty);
  const cost=Number(input.unitCost??0);
  if(!Number.isFinite(amount)||Math.abs(amount)<=1e-9)throw httpError('Inventory movement quantity must be a non-zero finite number');
  if(!Number.isFinite(cost)||cost<0||!Number.isFinite(Math.abs(amount)*cost))throw httpError('Inventory movement cost must be a non-negative finite number');
  if(!INVENTORY_MOVEMENT_TYPES.includes(input.type))throw httpError('Invalid inventory movement type');
  if(positiveTypes.has(input.type)&&amount<0)throw httpError(`${input.type} inventory movements must increase stock`);
  if(negativeTypes.has(input.type)&&amount>0)throw httpError(`${input.type} inventory movements must decrease stock`);
  if(clean(input.reason).length<3)throw httpError('Inventory movement reason must be at least 3 characters');
  if(clean(input.reason).length>500)throw httpError('Inventory movement reason must be 500 characters or fewer');
  if(clean(input.referenceType).length<2)throw httpError('Inventory movement reference type is required');
  if(clean(input.referenceType).length>80)throw httpError('Inventory movement reference type must be 80 characters or fewer');
  if(clean(input.idempotencyKey).length<3)throw httpError('Inventory movement idempotency key is required');
  if(clean(input.idempotencyKey).length>200)throw httpError('Inventory movement idempotency key must be 200 characters or fewer');
  return {amount,cost};
}

function assertIdempotentReplay(prior,hash,input) {
  const legacyMatch=Number(prior.idempotencyHashVersion||1)===1
    &&String(prior.branch)===String(input.branch)
    &&String(prior.ingredient)===String(input.ingredient)
    &&Number(prior.changeQty)===Number(input.qty)
    &&prior.type===input.type
    &&String(prior.referenceId)===String(input.referenceId)
    &&String(prior.user)===String(input.user);
  if(prior.idempotencyHash!==hash&&!legacyMatch){
    throw httpError('Idempotency key was already used for a different inventory movement',409);
  }
}

/** Atomic, auditable aggregate and batch stock movement. */
export async function moveStock({
  branch,
  ingredient,
  qty,
  type,
  reason,
  referenceType,
  referenceId,
  user,
  idempotencyKey,
  unit,
  unitCost = 0,
  incomingBatches,
  restoredMovements,
  batchId,
  batchNumber,
  allowExpired
}, session) {
  const {amount,cost}=validateMovementInput({
    branch,ingredient,qty,type,reason,referenceType,referenceId,user,idempotencyKey,unitCost
  },session);
  const [branchRecord,ingredientRecord,userRecord]=await Promise.all([
    Branch.findById(branch).select('restaurant active').session(session).lean(),
    Ingredient.findById(ingredient).select('restaurant name unit').session(session).lean(),
    User.findById(user).select('restaurantId').session(session).lean()
  ]);
  if(!branchRecord)throw httpError('Inventory movement branch was not found',404);
  if(!ingredientRecord)throw httpError('Inventory movement ingredient was not found',404);
  if(!userRecord)throw httpError('Inventory movement user was not found',404);
  const restaurant=branchRecord.restaurant;
  if(String(ingredientRecord.restaurant)!==String(restaurant))throw httpError('Inventory movement ingredient does not belong to the branch restaurant',403);
  if(String(userRecord.restaurantId)!==String(restaurant))throw httpError('Inventory movement user does not belong to the branch restaurant',403);
  const movementUnit=clean(unit||ingredientRecord.unit);
  if(!movementUnit||movementUnit.length>30)throw httpError('Inventory movement unit is required');
  const normalizedReason=clean(reason);
  const normalizedReferenceType=clean(referenceType);
  const normalizedKey=clean(idempotencyKey);
  const idempotencyHash=inventoryMovementFingerprint({
    restaurant,
    branch,
    ingredient,
    qty:amount,
    type,
    reason:normalizedReason,
    referenceType:normalizedReferenceType,
    referenceId,
    user,
    unit:movementUnit,
    unitCost:cost,
    incomingBatches,
    restoredMovements,
    batchId,
    batchNumber,
    allowExpired
  });
  const transactionId=inventoryMovementId({restaurant,branch,idempotencyKey:normalizedKey});
  const prior=await InventoryTransaction.findOne({restaurant,branch,idempotencyKey:normalizedKey}).session(session);
  if(prior){
    assertIdempotentReplay(prior,idempotencyHash,{branch,ingredient,qty:amount,type,referenceId,user});
    return prior;
  }

  let balance=await InventoryBalance.findOne({branch,ingredient}).session(session);
  if(!balance){
    if(amount<0)throw httpError('Insufficient inventory',409);
    balance=new InventoryBalance({branch,ingredient,quantity:0,averageCost:0});
  }
  const before=Number(balance.quantity||0);
  const previousCost=Number(balance.averageCost||0);
  const after=before+amount;
  if(!Number.isFinite(before)||before<0||!Number.isFinite(previousCost)||previousCost<0||!Number.isFinite(after)){
    throw httpError('Inventory aggregate balance is invalid; run the inventory migration before posting movements',409);
  }
  if(after<-1e-9)throw httpError('Insufficient inventory for this movement',409);
  if(type==='OPENING'&&before>1e-9)throw httpError('Opening stock requires a zero inventory balance',409);

  let batchMovements;
  if(amount<0){
    batchMovements=await removeBatchStock({
      balance,
      branch,
      ingredient,
      quantity:Math.abs(amount),
      unit:movementUnit,
      batchId,
      batchNumber,
      allowExpired:allowExpired??['WASTE','ADJUSTMENT','RETURN'].includes(type)
    },session);
  }else{
    let restore=restoredMovements;
    if(type==='REVERSAL'&&!restore?.length&&!incomingBatches?.length){
      const originals=await InventoryTransaction.find({
        restaurant,
        branch,
        ingredient,
        referenceId,
        type:'RECIPE_DEDUCTION'
      }).select('batchMovements').session(session);
      restore=originals.flatMap(row=>(row.batchMovements||[]).map(movement=>({
        batch:movement.batch,
        quantity:Math.abs(Number(movement.changeQty||0))
      })));
      const restoreTotal=restore.reduce((sum,row)=>sum+row.quantity,0);
      if(Math.abs(restoreTotal-amount)>1e-9)throw httpError('Original batch allocation is unavailable for reversal',409);
    }
    batchMovements=await addBatchStock({
      balance,
      branch,
      ingredient,
      quantity:amount,
      unit:movementUnit,
      unitCost:cost,
      incomingBatches,
      restoredMovements:restore,
      sourceType:normalizedReferenceType==='goods_receipt'
        ?'goods_receipt'
        :type==='TRANSFER_IN'
          ?'transfer'
          :type==='REVERSAL'
            ?'reversal'
            :type==='OPENING'
              ?'opening'
              :type==='ADJUSTMENT'
                ?'adjustment'
                :'untracked',
      sourceId:referenceId,
      receivedAt:new Date()
    },session);
  }

  if(amount>0&&cost>0){
    balance.averageCost=after
      ?((before*previousCost)+(amount*cost))/after
      :cost;
  }
  balance.quantity=Math.max(0,after);
  await balance.save({session,inventoryLedgerWrite:true});

  const effectiveUnitCost=Number(cost||balance.averageCost||0);
  const tx=(await InventoryTransaction.create([{
    _id:transactionId,
    restaurant,
    branch,
    ingredient,
    type,
    previousQty:before,
    changeQty:amount,
    newQty:Math.max(0,after),
    unit:movementUnit,
    unitCost:effectiveUnitCost,
    totalCost:Math.abs(amount)*effectiveUnitCost,
    reason:normalizedReason,
    referenceType:normalizedReferenceType,
    referenceId,
    user,
    batchMovements,
    idempotencyKey:normalizedKey,
    idempotencyHash,
    idempotencyHashVersion:2
  }],{session,inventoryLedgerWrite:true}))[0];

  if(after<=Number(balance.reorderLevel||0)){
    const name=ingredientRecord.name||'Ingredient';
    await Notification.create([{
      branch,
      type:after<=0?'out_of_stock':'low_stock',
      title:after<=0?'Out of stock':'Low stock',
      body:`${name} is ${after<=0?'out of stock':'at reorder level'}`,
      referenceId:ingredient
    }],{session});
  }
  return tx;
}

async function orderRequirements(order, restaurantId, session) {
  const requirements = new Map();
  for (const line of order.items || []) {
    let rows = line.inventoryRequirements || [];
    if (!rows.length) {
      const menuItem = await MenuItem.findById(line.menuItem).populate('recipe.ingredient').session(session || null);
      if (!menuItem) throw Object.assign(new Error('Original order recipe is unavailable for reversal'), {status: 409});
      rows = menuItem.recipe || [];
    }
    for (const row of rows) {
      const ingredient = row.ingredient?._id || row.ingredient;
      if (!ingredient) throw Object.assign(new Error('Original order recipe is incomplete'), {status: 409});
      const key = String(ingredient);
      const current = requirements.get(key) || {ingredient, quantity: 0, unit: row.unit};
      current.quantity += Number(row.qty || 0) * Number(line.qty || 0);
      requirements.set(key, current);
    }
  }
  const ids = [...requirements.values()].map(row => row.ingredient);
  const valid = ids.length ? await Ingredient.countDocuments({_id: {$in: ids}, restaurant: restaurantId}).session(session || null) : 0;
  if (valid !== ids.length) throw Object.assign(new Error('Order inventory allocation does not belong to this restaurant'), {status: 409});
  return requirements;
}

function originalBatchAvailability(originals, reversals) {
  const batches = new Map();
  for (const transaction of originals) {
    for (const movement of transaction.batchMovements || []) {
      const key = String(movement.batch);
      const current = batches.get(key) || {batch: movement.batch, quantity: 0};
      current.quantity += Math.abs(Number(movement.changeQty || 0));
      batches.set(key, current);
    }
  }
  for (const transaction of reversals) {
    for (const movement of transaction.batchMovements || []) {
      const current = batches.get(String(movement.batch));
      if (current) current.quantity -= Math.max(0, Number(movement.changeQty || 0));
    }
  }
  return [...batches.values()].map(row => ({...row, quantity: Math.max(0, row.quantity)}));
}

/** Reverse the immutable allocation recorded for an order, including split and merged checks. */
export async function reverseOrderStock({order, status, user, restaurantId}, session) {
  const sourceOrders = order.inventorySourceOrders?.length
    ? order.inventorySourceOrders
    : [order.inventorySourceOrder || order._id];
  const requirements = await orderRequirements(order, restaurantId, session);
  if (!requirements.size) return [];
  const relatedOrders = await Order.find({
    $or: [
      {_id: {$in: sourceOrders}},
      {inventorySourceOrder: {$in: sourceOrders}},
      {inventorySourceOrders: {$in: sourceOrders}}
    ]
  }).select('_id').session(session || null);
  const relatedIds = relatedOrders.map(row => row._id);
  const [originals, reversals] = await Promise.all([
    InventoryTransaction.find({restaurant: restaurantId, branch: order.branch, referenceId: {$in: sourceOrders}, type: 'RECIPE_DEDUCTION'}).sort({createdAt: 1, _id: 1}).session(session || null),
    InventoryTransaction.find({restaurant: restaurantId, branch: order.branch, referenceId: {$in: relatedIds}, type: 'REVERSAL'}).session(session || null)
  ]);
  if (!originals.length) {
    const legacyResults = [];
    for (const requirement of requirements.values()) {
      legacyResults.push(await moveStock({
        branch: order.branch,
        ingredient: requirement.ingredient,
        qty: requirement.quantity,
        unit: requirement.unit,
        type: 'REVERSAL',
        reason: `${status} ${order.orderNo} (legacy allocation)`,
        referenceType: 'order_reversal',
        referenceId: order._id,
        user,
        idempotencyKey: `reverse:${order._id}:${requirement.ingredient}`,
        incomingBatches: [{quantity: requirement.quantity, sourceType: 'reversal', sourceId: order._id}]
      }, session));
    }
    return legacyResults;
  }

  const results = [];
  for (const requirement of requirements.values()) {
    const matchingOriginals = originals.filter(row => String(row.ingredient) === String(requirement.ingredient));
    const matchingReversals = reversals.filter(row => String(row.ingredient) === String(requirement.ingredient));
    const originalTotal = matchingOriginals.reduce((sum, row) => sum + Math.abs(Number(row.changeQty || 0)), 0);
    const reversedTotal = matchingReversals.reduce((sum, row) => sum + Math.max(0, Number(row.changeQty || 0)), 0);
    if (!(requirement.quantity > 0) || reversedTotal + requirement.quantity > originalTotal + 1e-9) {
      throw Object.assign(new Error('Order reversal exceeds its original inventory allocation'), {status: 409});
    }

    const availableBatches = originalBatchAvailability(matchingOriginals, matchingReversals);
    const documentedTotal = availableBatches.reduce((sum, row) => sum + row.quantity, 0);
    let restoredMovements;
    let incomingBatches;
    if (documentedTotal > 1e-9) {
      if (documentedTotal + 1e-9 < requirement.quantity) {
        throw Object.assign(new Error('Original batch allocation is incomplete for reversal'), {status: 409});
      }
      let remaining = requirement.quantity;
      restoredMovements = [];
      for (const row of availableBatches) {
        if (!(remaining > 1e-9)) break;
        const quantity = Math.min(row.quantity, remaining);
        if (quantity > 1e-9) restoredMovements.push({batch: row.batch, quantity});
        remaining -= quantity;
      }
    } else {
      incomingBatches = [{
        quantity: requirement.quantity,
        sourceType: 'reversal',
        sourceId: order._id
      }];
    }

    results.push(await moveStock({
      branch: order.branch,
      ingredient: requirement.ingredient,
      qty: requirement.quantity,
      unit: requirement.unit,
      type: 'REVERSAL',
      reason: `${status} ${order.orderNo}`,
      referenceType: 'order_reversal',
      referenceId: order._id,
      user,
      idempotencyKey: `reverse:${order._id}:${requirement.ingredient}`,
      restoredMovements,
      incomingBatches
    }, session));
  }
  return results;
}
