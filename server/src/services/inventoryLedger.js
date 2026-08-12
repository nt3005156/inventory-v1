import mongoose from 'mongoose';
import {InventoryBalance,InventoryTransaction,Notification} from '../models/operations.js';
/** Atomic, auditable stock movement. Call inside a transaction for multi-item workflows. */
export async function moveStock({branch,ingredient,qty,type,reason,referenceType,referenceId,user,idempotencyKey,unit,unitCost=0},session){
  if(idempotencyKey){const prior=await InventoryTransaction.findOne({idempotencyKey}).session(session||null);if(prior)return prior;}
  let balance=await InventoryBalance.findOne({branch,ingredient}).session(session||null);
  if(!balance){if(qty<0)throw Object.assign(new Error('Insufficient inventory'),{status:409});balance=new InventoryBalance({branch,ingredient,quantity:0,averageCost:unitCost,unit});}
  const before=balance.quantity,after=before+qty;
  if(after<0)throw Object.assign(new Error('Insufficient inventory for this order'),{status:409});
  if(qty>0&&unitCost) balance.averageCost=((before*balance.averageCost)+(qty*unitCost))/after;
  balance.quantity=after;await balance.save({session});
  const tx=await InventoryTransaction.create([{branch,ingredient,type,previousQty:before,changeQty:qty,newQty:after,unit,unitCost:unitCost||balance.averageCost,totalCost:Math.abs(qty)*(unitCost||balance.averageCost),reason,referenceType,referenceId,user,idempotencyKey} ],{session});
  if(after<=balance.reorderLevel) await Notification.create([{branch,type:after<=0?'out_of_stock':'low_stock',title:after<=0?'Out of stock':'Low stock',body:`Ingredient stock is ${after<=0?'out of stock':'at reorder level'}`,referenceId:ingredient}],{session});
  return tx[0];
}
