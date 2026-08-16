import {Audit} from '../models/index.js';
import {InventoryBalance} from '../models/operations.js';

export async function audit(entry){return Audit.create(entry);}

export async function recipeCost(item,{branch,branches}={}){
  await item.populate('recipe.ingredient');
  const ingredientIds=[...new Set((item.recipe||[]).map(row=>String(row.ingredient?._id||row.ingredient||'')).filter(Boolean))];
  if(!ingredientIds.length)return 0;
  if(!branch&&!Array.isArray(branches))throw Object.assign(new Error('Recipe costing requires an inventory branch scope'),{status:400});
  const branchScope=branch?{branch}:{branch:{$in:branches}};
  const balances=await InventoryBalance.find({
    ingredient:{$in:ingredientIds},
    ...branchScope
  }).select('ingredient quantity averageCost').lean();
  const costs=new Map();
  for(const balance of balances){
    const key=String(balance.ingredient);
    const current=costs.get(key)||{quantity:0,value:0,fallback:0};
    const quantity=Math.max(0,Number(balance.quantity||0));
    const averageCost=Math.max(0,Number(balance.averageCost||0));
    current.quantity+=quantity;
    current.value+=quantity*averageCost;
    current.fallback=averageCost;
    costs.set(key,current);
  }
  return (item.recipe||[]).reduce((sum,row)=>{
    const cost=costs.get(String(row.ingredient?._id||row.ingredient));
    const unitCost=cost?(cost.quantity>0?cost.value/cost.quantity:cost.fallback):0;
    return sum+Number(row.qty||0)*unitCost;
  },0);
}
