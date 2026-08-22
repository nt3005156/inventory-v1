import mongoose from 'mongoose';
import {assertCapability} from './capabilities.js';
import { Ingredient, MenuItem, Audit } from '../models/index.js';
import { Branch, InventoryBalance } from '../models/operations.js';
import { userRestaurantContext } from './supplierCatalog.js';
import { convertQuantity, INGREDIENT_UNITS } from './ingredients.js';
import { resolveStation } from './stations.js';

const clean = v => String(v ?? '').trim();
function httpError(msg, status=400){ const e=new Error(msg); e.status=status; return e; }

export const MENU_CATEGORIES = Object.freeze(['appetizer','main','side','dessert','beverage','set','other']);
export const RECIPE_UNITS = INGREDIENT_UNITS;

function normalizeUnit(u){ return clean(u).toLowerCase(); }

async function resolveRestaurant(user){
  const ctx = await userRestaurantContext(user);
  return ctx.restaurantId;
}

// Convert recipe qty in given unit to ingredient base unit for costing
function toBaseQty(qty, recipeUnit, ingredient){
  const base = normalizeUnit(ingredient.unit || ingredient.baseUnit || 'g');
  const from = normalizeUnit(recipeUnit);
  if(from === base) return Number(qty);
  const conv = (ingredient.conversions||[]).find(c=> normalizeUnit(c.unit)===from);
  if(conv) {
    return Number(qty) * Number(conv.factor);
  }
  try{
    return convertQuantity(qty, from, base, ingredient);
  }catch{
    if((from==='kg' && base==='g') || (from==='g' && base==='kg')){
      return from==='kg' && base==='g' ? Number(qty)*1000 : Number(qty)/1000;
    }
    if((from==='l' && base==='ml') || (from==='ml' && base==='l')){
      return from==='l' && base==='ml' ? Number(qty)*1000 : Number(qty)/1000;
    }
    throw httpError(`No conversion from ${recipeUnit} to ${ingredient.unit} for ${ingredient.name}`,400);
  }
}

export async function calculateRecipeCost(recipe, { restaurantId, branchId } = {}){
  if(!recipe || !recipe.length) return 0;
  const ingredientIds = [...new Set(recipe.map(r=> String(r.ingredient?._id || r.ingredient)).filter(Boolean))];
  if(!ingredientIds.length) return 0;
  const ingredients = await Ingredient.find({ _id: { $in: ingredientIds } }).lean();
  const ingMap = new Map(ingredients.map(i=>[String(i._id), i]));
  let branchIds = null;
  if(branchId){
    branchIds = [new mongoose.Types.ObjectId(branchId)];
  } else if(restaurantId){
    const branches = await Branch.find({ restaurant: restaurantId }).distinct('_id');
    branchIds = branches;
  }
  const balances = branchIds ? await InventoryBalance.find({ ingredient: { $in: ingredientIds }, branch: { $in: branchIds } }).select('ingredient quantity averageCost').lean() : [];
  const costMap = new Map();
  for(const b of balances){
    const key = String(b.ingredient);
    const cur = costMap.get(key) || { qty:0, value:0, fallback:0 };
    const q = Math.max(0, Number(b.quantity||0));
    const avg = Math.max(0, Number(b.averageCost||0));
    cur.qty += q;
    cur.value += q*avg;
    cur.fallback = avg;
    costMap.set(key, cur);
  }
  let total = 0;
  for(const line of recipe){
    const ingId = String(line.ingredient?._id || line.ingredient);
    const ing = ingMap.get(ingId);
    if(!ing) throw httpError(`Ingredient ${ingId} not found`,404);
    const qty = Number(line.qty);
    if(!(qty>0)) throw httpError(`Invalid quantity for ${ing.name}`,400);
    const baseQty = toBaseQty(qty, line.unit, ing);
    const costInfo = costMap.get(ingId);
    let unitCost = 0;
    if(costInfo){
      unitCost = costInfo.qty>0 ? costInfo.value / costInfo.qty : costInfo.fallback;
    }
    if(unitCost<=1e-9){
      unitCost = Number(ing.lastPurchasePrice || ing.standardCost || 0);
      if(unitCost<=1e-9){
        const { SupplierIngredient } = await import('../models/supplierCatalog.js');
        const cat = await SupplierIngredient.findOne({ ingredient: ing._id, restaurant: restaurantId, active:true }).sort({ updatedAt:-1 }).lean();
        if(cat) unitCost = Number(cat.baseUnitPrice || cat.currentPrice / (cat.conversionFactor||1) || 0);
      }
    }
    total += baseQty * unitCost;
  }
  return Math.round(total * 100) / 100;
}

export function calculateFoodCost(recipeCost, packagingCost){
  return Math.round((Number(recipeCost||0) + Number(packagingCost||0))*100)/100;
}
export function calculateGrossMargin(price, foodCost){
  return Math.round((Number(price||0) - Number(foodCost||0))*100)/100;
}
export function calculateFoodCostPercent(foodCost, price){
  if(!(Number(price)>0)) return 0;
  return Math.round((Number(foodCost)/Number(price))*10000)/100;
}


// Phase 4B — validate a modifier catalog before it is stored on a menu item.
export function normalizeModifierGroups(groups){
  if(groups===undefined) return undefined;
  if(!Array.isArray(groups)) throw httpError('Modifier groups must be a list',400);
  const seenGroups=new Set();
  return groups.map(g=>{
    const key=clean(g.key).toLowerCase();
    if(!key) throw httpError('Modifier group key is required',400);
    if(seenGroups.has(key)) throw httpError(`Duplicate modifier group "${g.key}"`,400);
    seenGroups.add(key);
    const kind=g.kind||'extra';
    const selection=g.selection||(kind==='variant'?'single':'multi');
    const seenOptions=new Set();
    const options=(g.options||[]).map(o=>{
      const optKey=clean(o.key).toLowerCase();
      if(!optKey) throw httpError('Modifier option key is required',400);
      if(seenOptions.has(optKey)) throw httpError(`Duplicate option "${o.key}" in ${g.name}`,400);
      seenOptions.add(optKey);
      const qty=Number(o.qty||0);
      if(qty>0 && !o.ingredient) throw httpError(`Option "${o.name}" sets a quantity but no ingredient`,400);
      if(kind==='removal' && o.ingredient && !(qty>0)) throw httpError(`Removal "${o.name}" needs the quantity to remove`,400);
      // 11A: a quantity with no unit is unresolvable at the till. The order
      // path converts qty into the ingredient's base unit, and with no unit to
      // convert FROM it silently assumed the base unit -- which produced a
      // wrong deduction rather than an error.
      if(o.ingredient && qty>0 && !clean(o.unit)) throw httpError(`Option "${o.name}" needs a unit for its quantity`,400);
      return {
        key:clean(o.key),
        name:clean(o.name),
        priceDelta:Math.round(Number(o.priceDelta||0)*100)/100,
        priceOverride:o.priceOverride===undefined||o.priceOverride===null?null:Math.round(Number(o.priceOverride)*100)/100,
        isDefault:Boolean(o.isDefault),
        ingredient:o.ingredient||null,
        qty,
        unit:clean(o.unit)||undefined
      };
    });
    if(!options.length) throw httpError(`Modifier group "${g.name}" needs at least one option`,400);
    if(selection==='single' && options.filter(o=>o.isDefault).length>1) throw httpError(`${g.name} can only have one default`,400);
    const minSelect=Number(g.minSelect||0), maxSelect=Number(g.maxSelect||0);
    if(maxSelect>0 && minSelect>maxSelect) throw httpError(`${g.name} has a minimum above its maximum`,400);
    if(selection==='single' && maxSelect>1) throw httpError(`${g.name} is single-select but allows ${maxSelect}`,400);
    // 11A: a minimum the group can never satisfy is a menu that cannot be
    // ordered -- the till would reject every attempt with no way to comply.
    if(minSelect>options.length) throw httpError(`${g.name} requires ${minSelect} choices but only offers ${options.length}`,400);
    if(selection==='single' && minSelect>1) throw httpError(`${g.name} is single-select but requires ${minSelect}`,400);
    // 11A: a variant group exists to re-price the line (Small/Medium/Large).
    // If no option changes the price at all it is a decorative choice that
    // silently does nothing at the till.
    if(kind==='variant' && !options.some(o=>o.priceOverride!==null||Number(o.priceDelta||0)!==0)){
      throw httpError(`${g.name} is a variant group but no option changes the price`,400);
    }
    return {key:clean(g.key),name:clean(g.name),kind,selection,required:Boolean(g.required),minSelect,maxSelect,options};
  });
}

/**
 * 11A: every ingredient a modifier option points at must belong to THIS
 * restaurant.
 *
 * The order path already refuses a foreign ingredient at the till, so this is
 * not a data leak -- but without it the breakage surfaces as a menu item that
 * fails for every guest who picks that option, which is a support call rather
 * than a validation error. Rejecting it at authoring time is where an operator
 * can actually fix it.
 */
async function assertModifierIngredientsOwned(groups, restaurantId, session){
  if(!groups?.length) return;
  const ids=[];
  for(const g of groups) for(const o of (g.options||[])) if(o.ingredient) ids.push(String(o.ingredient));
  if(!ids.length) return;
  const unique=[...new Set(ids)];
  const owned=await Ingredient.find({_id:{$in:unique},restaurant:restaurantId})
    .select('_id').session(session||null).lean();
  const ownedSet=new Set(owned.map(i=>String(i._id)));
  for(const g of groups){
    for(const o of (g.options||[])){
      if(o.ingredient && !ownedSet.has(String(o.ingredient))){
        throw httpError(`Option "${o.name}" uses an ingredient that does not belong to this restaurant`,400);
      }
    }
  }
}

export async function listMenuItems({ user, q, category, active, page=1, limit=50, branchId }){
  const restaurantId = await resolveRestaurant(user);
  const safePage = Math.max(1, Number(page)||1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit)||50));
  const match = {};
  match.$or = [{ restaurant: restaurantId }, { restaurant: null }, { restaurant: { $exists:false } }];
  if(q){
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
    match.$and = [{ $or: [{ name: regex }, { code: regex }, { category: regex }] }];
  }
  if(category) match.category = clean(category).toLowerCase();
  if(active!==undefined && active!==''){
    if(!['true','false'].includes(String(active))) throw httpError('Invalid active filter',400);
    match.active = String(active)==='true';
  }
  const [rows, total] = await Promise.all([
    MenuItem.find(match).sort({ active:-1, name:1 }).skip((safePage-1)*safeLimit).limit(safeLimit).populate('recipe.ingredient','name code unit category baseUnit conversions').lean(),
    MenuItem.countDocuments(match)
  ]);
  const enriched = await Promise.all(rows.map(async r=>{
    const recipeCost = await calculateRecipeCost(r.recipe, { restaurantId, branchId }).catch(()=> Number(r.recipeCost||0));
    const packagingCost = Number(r.packagingCost||0);
    const foodCost = calculateFoodCost(recipeCost, packagingCost);
    const price = Number(r.price||0);
    return {
      ...r,
      recipeCost,
      packagingCost,
      foodCost,
      foodCostPercent: calculateFoodCostPercent(foodCost, price),
      margin: calculateGrossMargin(price, foodCost),
      grossMargin: calculateGrossMargin(price, foodCost),
      ingredientCount: (r.recipe||[]).length,
      recipeVersion: r.recipeVersion || 1
    };
  }));
  return { items: enriched, pagination: { page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total/safeLimit)) } };
}

export async function getMenuItem({ menuId, user, branchId }){
  if(!mongoose.isValidObjectId(menuId)) throw httpError('Invalid menu item',400);
  const restaurantId = await resolveRestaurant(user);
  const row = await MenuItem.findOne({ _id: menuId, $or:[{restaurant:restaurantId},{restaurant:null},{restaurant:{$exists:false}}] }).populate('recipe.ingredient','name code unit category baseUnit conversions').lean();
  if(!row) throw httpError('Menu item not found',404);
  const recipeCost = await calculateRecipeCost(row.recipe, { restaurantId, branchId });
  const packagingCost = Number(row.packagingCost||0);
  const foodCost = calculateFoodCost(recipeCost, packagingCost);
  const price = Number(row.price||0);
  return {
    ...row,
    recipeCost,
    packagingCost,
    foodCost,
    foodCostPercent: calculateFoodCostPercent(foodCost, price),
    margin: calculateGrossMargin(price, foodCost),
    grossMargin: calculateGrossMargin(price, foodCost),
    recipe: (row.recipe||[]).map(line=>{
      const ing = line.ingredient;
      return {
        ...line,
        ingredientName: ing?.name || 'Ingredient',
        ingredientCode: ing?.code || '',
        ingredientUnit: ing?.unit || line.unit,
        baseUnit: ing?.baseUnit || ing?.unit || line.unit
      };
    }),
    recipeHistory: (row.recipeHistory||[]).map(h=> ({
      version: h.version,
      recipe: h.recipe,
      recipeCost: h.recipeCost,
      packagingCost: h.packagingCost,
      foodCost: h.foodCost,
      updatedAt: h.updatedAt,
      reason: h.reason
    }))
  };
}

export async function getRecipeVersions({ menuId, user }){
  if(!mongoose.isValidObjectId(menuId)) throw httpError('Invalid menu item',400);
  const restaurantId = await resolveRestaurant(user);
  const row = await MenuItem.findOne({ _id: menuId, restaurant: restaurantId }).select('name code recipeVersion recipe recipeCost packagingCost foodCost recipeHistory').lean();
  if(!row) {
    const fallback = await MenuItem.findById(menuId).lean();
    if(!fallback) throw httpError('Menu item not found',404);
    // allow legacy without restaurant
  }
  const current = {
    version: row.recipeVersion || 1,
    recipe: row.recipe,
    recipeCost: row.recipeCost,
    packagingCost: row.packagingCost || 0,
    foodCost: row.foodCost || calculateFoodCost(row.recipeCost, row.packagingCost),
    updatedAt: row.updatedAt,
    isCurrent: true
  };
  const history = (row.recipeHistory||[]).map(h=> ({
    version: h.version,
    recipe: h.recipe,
    recipeCost: h.recipeCost,
    packagingCost: h.packagingCost,
    foodCost: h.foodCost,
    updatedAt: h.updatedAt,
    updatedBy: h.updatedBy,
    reason: h.reason,
    isCurrent: false
  })).sort((a,b)=> b.version - a.version);
  return { menuId: row._id, name: row.name, currentVersion: row.recipeVersion||1, current, history, all: [current, ...history].sort((a,b)=> b.version - a.version) };
}

export async function createMenuItem({ input, user, principal }){
  const restaurantId = await resolveRestaurant(user);
  const normalizedModifierGroups = normalizeModifierGroups(input.modifierGroups);
  await assertModifierIngredientsOwned(normalizedModifierGroups, restaurantId);
  assertCapability(user, principal, 'menu.manage', 'Only owner/manager can create menu items');
  const name = clean(input.name);
  if(!name || name.length<2) throw httpError('Menu name must be at least 2 characters',400);
  if(name.length>120) throw httpError('Menu name too long',400);
  const code = input.code ? clean(input.code).toUpperCase() : undefined;
  if(code && !/^[A-Z0-9_-]{2,30}$/.test(code)) throw httpError('Code must be 2-30 chars A-Z 0-9 _ -',400);
  const category = input.category ? clean(input.category).toLowerCase() : 'main';
  const price = Number(input.price);
  if(!Number.isFinite(price) || price <0) throw httpError('Invalid price',400);
  const packagingCost = input.packagingCost!==undefined ? Number(input.packagingCost) : 0;
  if(!Number.isFinite(packagingCost) || packagingCost<0) throw httpError('Invalid packaging cost',400);
  const recipe = [];
  if(input.recipe){
    if(!Array.isArray(input.recipe)) throw httpError('Recipe must be an array',400);
    if(input.recipe.length>50) throw httpError('Recipe cannot have more than 50 ingredients',400);
    const seen = new Set();
    for(const line of input.recipe){
      if(!line.ingredient || !mongoose.isValidObjectId(line.ingredient)) throw httpError('Invalid recipe ingredient',400);
      const ingId = String(line.ingredient);
      if(seen.has(ingId)) throw httpError('Duplicate ingredient in recipe',400);
      seen.add(ingId);
      const ing = await Ingredient.findOne({ _id: ingId, $or:[{restaurant:restaurantId},{restaurant:null},{restaurant:{$exists:false}}] });
      if(!ing) throw httpError(`Ingredient ${ingId} not found for this restaurant`,404);
      if(ing.active===false) throw httpError(`Ingredient ${ing.name} is inactive`,400);
      const qty = Number(line.qty);
      if(!Number.isFinite(qty) || qty<=0) throw httpError(`Invalid quantity for ${ing.name}`,400);
      const unit = normalizeUnit(line.unit || ing.unit);
      if(!unit) throw httpError(`Unit required for ${ing.name}`,400);
      try{ toBaseQty(qty, unit, ing); }catch(e){ throw httpError(e.message,400); }
      recipe.push({ ingredient: ing._id, qty, unit, notes: clean(line.notes)||undefined });
    }
  }
  const yieldVal = input.yield!==undefined ? Number(input.yield) : 1;
  if(!Number.isFinite(yieldVal) || yieldVal<=0) throw httpError('Invalid yield',400);
  const doc = {
    restaurant: restaurantId,
    name,
    code: code || undefined,
    category,
    price: Math.round(price*100)/100,
    vatInclusive: input.vatInclusive !== false,
    vatRate: input.vatRate!==undefined ? Number(input.vatRate) : 13,
    active: input.active!==false,
    yield: yieldVal,
    yieldUnit: clean(input.yieldUnit)||'serving',
    recipe,
    modifierGroups: normalizedModifierGroups||[],
    station: (await resolveStation({restaurantId, code: input.station})) || undefined,
    prepMinutes: Number(input.prepMinutes || 0),
    recipeVersion: 1,
    recipeHistory: [],
    packagingCost: Math.round(packagingCost*100)/100,
    description: clean(input.description)||undefined,
    imageUrl: clean(input.imageUrl)||undefined
  };
  const recipeCost = await calculateRecipeCost(recipe, { restaurantId });
  doc.recipeCost = recipeCost;
  doc.foodCost = calculateFoodCost(recipeCost, doc.packagingCost);
  doc.recipeCostUpdatedAt = new Date();
  for(const line of doc.recipe){
    const ing = await Ingredient.findById(line.ingredient).lean();
    line.cost = await calculateRecipeCost([line], { restaurantId });
  }
  try{
    const [row] = await MenuItem.create([doc]);
    await Audit.create({ entity:'menu_items', entityId: row._id, restaurant: restaurantId, action:'create', after: row, user: (await userRestaurantContext(user)).userId });
    return getMenuItem({ menuId: row._id, user });
  }catch(e){
    if(e?.code===11000) throw httpError('Menu code or name already exists',409);
    if(e?.name==='ValidationError') throw httpError(e.message,400);
    throw e;
  }
}

export async function updateMenuItem({ menuId, patch, expectedVersion, user, principal }){
  if(!mongoose.isValidObjectId(menuId)) throw httpError('Invalid menu item',400);
  const restaurantId = await resolveRestaurant(user);
  assertCapability(user, principal, 'menu.manage', 'Only owner/manager can update menu items');
  const row = await MenuItem.findOne({ _id: menuId, $or:[{restaurant:restaurantId},{restaurant:null},{restaurant:{$exists:false}}] });
  if(!row) throw httpError('Menu item not found',404);
  if(expectedVersion!==undefined && Number(expectedVersion)!==row.__v) throw httpError('Menu item changed since loaded; refresh',409);
  const before = row.toObject();
  const beforeRecipe = JSON.stringify(row.recipe);
  const beforePackaging = Number(row.packagingCost||0);
  let recipeChanged = false;
  let packagingChanged = false;

  if(patch.name!==undefined){
    const n=clean(patch.name);
    if(!n || n.length<2) throw httpError('Invalid name',400);
    row.name=n;
  }
  if(patch.code!==undefined){
    const c=clean(patch.code).toUpperCase();
    if(c && !/^[A-Z0-9_-]{2,30}$/.test(c)) throw httpError('Invalid code',400);
    row.code=c||undefined;
  }
  if(patch.category!==undefined) row.category=clean(patch.category).toLowerCase();
  if(patch.price!==undefined){
    const p=Number(patch.price);
    if(!Number.isFinite(p) || p<0) throw httpError('Invalid price',400);
    row.price=Math.round(p*100)/100;
  }
  if(patch.vatInclusive!==undefined) row.vatInclusive=Boolean(patch.vatInclusive);
  if(patch.modifierGroups!==undefined){
    const groups=normalizeModifierGroups(patch.modifierGroups);
    await assertModifierIngredientsOwned(groups, row.restaurant);
    row.modifierGroups=groups;
  }
  if(patch.station!==undefined) row.station=(await resolveStation({restaurantId, code: patch.station}))||undefined;
  if(patch.prepMinutes!==undefined) row.prepMinutes=Number(patch.prepMinutes);
  if(patch.vatRate!==undefined) row.vatRate=Number(patch.vatRate);
  if(patch.active!==undefined) row.active=Boolean(patch.active);
  if(patch.yield!==undefined){
    const y=Number(patch.yield);
    if(!Number.isFinite(y) || y<=0) throw httpError('Invalid yield',400);
    row.yield=y;
  }
  if(patch.yieldUnit!==undefined) row.yieldUnit=clean(patch.yieldUnit);
  if(patch.description!==undefined) row.description=clean(patch.description)||undefined;
  if(patch.imageUrl!==undefined) row.imageUrl=clean(patch.imageUrl)||undefined;
  if(patch.packagingCost!==undefined){
    const pc = Number(patch.packagingCost);
    if(!Number.isFinite(pc) || pc<0) throw httpError('Invalid packaging cost',400);
    if(Math.abs(pc - Number(row.packagingCost||0))>1e-9) packagingChanged = true;
    row.packagingCost = Math.round(pc*100)/100;
  }
  if(patch.recipe!==undefined){
    if(!Array.isArray(patch.recipe)) throw httpError('Recipe must be array',400);
    if(patch.recipe.length>50) throw httpError('Too many recipe lines',400);
    const newRecipe=[];
    const seen=new Set();
    for(const line of patch.recipe){
      if(!line.ingredient || !mongoose.isValidObjectId(line.ingredient)) throw httpError('Invalid ingredient',400);
      const ingId=String(line.ingredient);
      if(seen.has(ingId)) throw httpError('Duplicate ingredient',400);
      seen.add(ingId);
      const ing=await Ingredient.findOne({_id:ingId, $or:[{restaurant:restaurantId},{restaurant:null},{restaurant:{$exists:false}}]});
      if(!ing) throw httpError('Ingredient not found',404);
      const qty=Number(line.qty);
      if(!Number.isFinite(qty)||qty<=0) throw httpError(`Invalid qty for ${ing.name}`,400);
      const unit=normalizeUnit(line.unit||ing.unit);
      try{ toBaseQty(qty, unit, ing); }catch(e){ throw httpError(e.message,400); }
      newRecipe.push({ ingredient: ing._id, qty, unit, notes: clean(line.notes)||undefined });
    }
    // detect change
    if(JSON.stringify(newRecipe.map(r=>({ingredient:String(r.ingredient),qty:r.qty,unit:r.unit}))) !== JSON.stringify((row.recipe||[]).map(r=>({ingredient:String(r.ingredient?._id||r.ingredient),qty:r.qty,unit:r.unit})))){
      recipeChanged = true;
    }
    row.recipe=newRecipe;
  }
  // Handle versioning if recipe or packaging changed
  if(recipeChanged || packagingChanged){
    const prevVersion = Number(row.recipeVersion||1);
    // push current state to history before recalc
    const histEntry = {
      version: prevVersion,
      recipe: before.recipe || [],
      recipeCost: Number(before.recipeCost||0),
      packagingCost: Number(before.packagingCost||0),
      foodCost: Number(before.foodCost|| calculateFoodCost(before.recipeCost, before.packagingCost)),
      updatedAt: before.updatedAt || before.createdAt || new Date(),
      updatedBy: before.updatedBy || null,
      reason: clean(patch.reason) || (recipeChanged ? 'Recipe updated' : 'Packaging updated')
    };
    // ensure history array exists
    if(!Array.isArray(row.recipeHistory)) row.recipeHistory = [];
    row.recipeHistory.push(histEntry);
    row.recipeVersion = prevVersion + 1;
    // keep only last 20 versions
    if(row.recipeHistory.length>20) row.recipeHistory = row.recipeHistory.slice(-20);
  }
  // Recalculate costs if recipe or packaging changed
  if(recipeChanged || packagingChanged){
    const cost = await calculateRecipeCost(row.recipe, { restaurantId });
    row.recipeCost=cost;
    row.foodCost = calculateFoodCost(cost, row.packagingCost);
    row.recipeCostUpdatedAt=new Date();
    for(const line of row.recipe){
      const ing=await Ingredient.findById(line.ingredient).lean();
      line.cost = await calculateRecipeCost([line], { restaurantId });
    }
  }
  try{
    await row.save();
  }catch(e){
    if(e?.name==='VersionError') throw httpError('Menu item changed',409);
    if(e?.code===11000) throw httpError('Menu code/name already exists',409);
    throw e;
  }
  await Audit.create({ entity:'menu_items', entityId: row._id, restaurant: restaurantId, action:'update', before, after: row.toObject(), user: (await userRestaurantContext(user)).userId });
  return getMenuItem({ menuId: row._id, user });
}

export async function deleteMenuItem({ menuId, user }){
  if(!mongoose.isValidObjectId(menuId)) throw httpError('Invalid menu item',400);
  const restaurantId = await resolveRestaurant(user);
  const row = await MenuItem.findOne({ _id: menuId, restaurant: restaurantId });
  if(!row) throw httpError('Menu item not found',404);
  throw httpError('Menu items with order history cannot be deleted; deactivate instead',409);
}

export async function getFoodCosting({ menuId, user, branchId }){
  const item = await getMenuItem({ menuId, user, branchId });
  const ingredientCost = Number(item.recipeCost||0);
  const packagingCost = Number(item.packagingCost||0);
  const foodCost = calculateFoodCost(ingredientCost, packagingCost);
  const price = Number(item.price||0);
  const grossMargin = calculateGrossMargin(price, foodCost);
  return {
    menuId: item._id,
    name: item.name,
    recipeVersion: item.recipeVersion || 1,
    ingredientCost,
    recipeCost: ingredientCost,
    packagingCost,
    foodCost,
    sellingPrice: price,
    grossMargin,
    foodCostPercent: calculateFoodCostPercent(foodCost, price),
    yield: item.yield,
    yieldUnit: item.yieldUnit,
    recipe: item.recipe,
    branchId: branchId || null
  };
}

export async function ensureRecipeIndexes(){
  await MenuItem.collection.createIndex({restaurant:1,code:1},{unique:true,name:'menu_restaurant_code',partialFilterExpression:{restaurant:{$type:'objectId'},code:{$type:'string'}}});
  await MenuItem.collection.createIndex({restaurant:1,name:1},{unique:true,name:'menu_restaurant_name',partialFilterExpression:{restaurant:{$type:'objectId'},name:{$type:'string'}}});
}

