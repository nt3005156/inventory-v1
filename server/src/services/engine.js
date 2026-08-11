import {Ingredient,MenuItem,Audit} from '../models/index.js';
export const recipeCost=async(item)=>{await item.populate('recipe.ingredient');return item.recipe.reduce((s,r)=>s+(r.qty*(r.ingredient?.averageCost||0)),0)};
export async function consumeRecipe(item,qty){await item.populate('recipe.ingredient');for(const r of item.recipe){if(!r.ingredient)continue;r.ingredient.stockQty-=r.qty*qty;await r.ingredient.save()}}
export const audit=(data)=>Audit.create(data);
export async function inventoryValue(){const x=await Ingredient.find();return x.reduce((s,i)=>s+i.stockQty*i.averageCost,0)};
