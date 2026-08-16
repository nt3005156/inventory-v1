import mongoose from 'mongoose';
import { Ingredient, MenuItem, Audit } from '../models/index.js';
import { Branch, InventoryBalance } from '../models/operations.js';
import { userRestaurantContext } from './supplierCatalog.js';
import { convertQuantity, INGREDIENT_UNITS } from './ingredients.js';

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
  // Try ingredient conversions
  const conv = (ingredient.conversions||[]).find(c=> normalizeUnit(c.unit)===from);
  if(conv) {
    // conv.factor is multiplier from conversion unit to base: 1 fromUnit = factor baseUnit
    // But our earlier conversion definition was 1 conversion unit = factor baseUnit
    // For recipe, qty in fromUnit needs to be converted to base: baseQty = qty * factor
    return Number(qty) * Number(conv.factor);
  }
  // Try via ingredients service helper
  try{
    return convertQuantity(qty, from, base, ingredient);
  }catch{
    // fallback: if units are kg<->g etc., use hints
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
  // Need branch scope for averageCost
  let branchIds = null;
  if(branchId){
    branchIds = [new mongoose.Types.ObjectId(branchId)];
  } else if(restaurantId){
    // restaurant-wide average across all branches
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
  // If no balances, fallback to ingredient lastPurchasePrice or standardCost or supplier price
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
      // fallback to ingredient costs or supplier
      unitCost = Number(ing.lastPurchasePrice || ing.standardCost || 0);
      if(unitCost<=1e-9){
        // try supplier catalog base price
        const { SupplierIngredient } = await import('../models/supplierCatalog.js');
        const cat = await SupplierIngredient.findOne({ ingredient: ing._id, restaurant: restaurantId, active:true }).sort({ updatedAt:-1 }).lean();
        if(cat) unitCost = Number(cat.baseUnitPrice || cat.currentPrice / (cat.conversionFactor||1) || 0);
      }
    }
    total += baseQty * unitCost;
  }
  return Math.round(total * 100) / 100;
}

export async function listMenuItems({ user, q, category, active, page=1, limit=50, branchId }){
  const restaurantId = await resolveRestaurant(user);
  const safePage = Math.max(1, Number(page)||1);
  const safeLimit = Math.min(100, Math.max(1, Number(limit)||50));
  const match = {};
  // restaurant filter: include legacy null plus current restaurant
  match.$or = [{ restaurant: restaurantId }, { restaurant: null }, { restaurant: { $exists:false } }];
  // Actually we want only current restaurant plus legacy, but for strict we filter by restaurant or null
  // Simpler: match restaurant or null
  // Use $or
  if(q){
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
    match.$and = [{ $or: [{ name: regex }, { code: regex }, { category: regex }] }];
  }
  if(category) match.category = clean(category).toLowerCase();
  if(active!==undefined && active!==''){
    if(!['true','false'].includes(String(active))) throw httpError('Invalid active filter',400);
    match.active = String(active)==='true';
  }
  // For branch-specific costing, we will compute cost per branch but still list
  const [rows, total] = await Promise.all([
    MenuItem.find(match).sort({ active:-1, name:1 }).skip((safePage-1)*safeLimit).limit(safeLimit).populate('recipe.ingredient','name code unit category baseUnit conversions').lean(),
    MenuItem.countDocuments(match)
  ]);
  // Enrich with cost (branch-scoped if branchId given)
  const enriched = await Promise.all(rows.map(async r=>{
    const cost = await calculateRecipeCost(r.recipe, { restaurantId, branchId }).catch(()=>0);
    const price = Number(r.price||0);
    return {
      ...r,
      recipeCost: cost,
      foodCostPercent: price>0 ? Math.round((cost/price)*10000)/100 : 0,
      margin: Math.round((price - cost)*100)/100,
      ingredientCount: (r.recipe||[]).length
    };
  }));
  return { items: enriched, pagination: { page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total/safeLimit)) } };
}

export async function getMenuItem({ menuId, user, branchId }){
  if(!mongoose.isValidObjectId(menuId)) throw httpError('Invalid menu item',400);
  const restaurantId = await resolveRestaurant(user);
  const row = await MenuItem.findOne({ _id: menuId, $or:[{restaurant:restaurantId},{restaurant:null},{restaurant:{$exists:false}}] }).populate('recipe.ingredient','name code unit category baseUnit conversions').lean();
  if(!row) throw httpError('Menu item not found',404);
  const cost = await calculateRecipeCost(row.recipe, { restaurantId, branchId });
  return {
    ...row,
    recipeCost: cost,
    foodCostPercent: row.price>0 ? Math.round((cost/row.price)*10000)/100 : 0,
    margin: Math.round((Number(row.price||0)-cost)*100)/100,
    recipe: (row.recipe||[]).map(line=>{
      const ing = line.ingredient;
      return {
        ...line,
        ingredientName: ing?.name || 'Ingredient',
        ingredientCode: ing?.code || '',
        ingredientUnit: ing?.unit || line.unit,
        baseUnit: ing?.baseUnit || ing?.unit || line.unit
      };
    })
  };
}

export async function createMenuItem({ input, user }){
  const restaurantId = await resolveRestaurant(user);
  if(!['owner','manager'].includes((await userRestaurantContext(user)).role)) throw httpError('Only owner/manager can create menu items',403);
  const name = clean(input.name);
  if(!name || name.length<2) throw httpError('Menu name must be at least 2 characters',400);
  if(name.length>120) throw httpError('Menu name too long',400);
  const code = input.code ? clean(input.code).toUpperCase() : undefined;
  if(code && !/^[A-Z0-9_-]{2,30}$/.test(code)) throw httpError('Code must be 2-30 chars A-Z 0-9 _ -',400);
  const category = input.category ? clean(input.category).toLowerCase() : 'main';
  if(category && !MENU_CATEGORIES.includes(category) && category!=='main') {
    // allow any but warn
  }
  const price = Number(input.price);
  if(!Number.isFinite(price) || price <0) throw httpError('Invalid price',400);
  // Validate recipe
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
      // Validate conversion exists if unit differs
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
    description: clean(input.description)||undefined,
    imageUrl: clean(input.imageUrl)||undefined
  };
  // Calculate cost
  const cost = await calculateRecipeCost(recipe, { restaurantId });
  doc.recipeCost = cost;
  doc.recipeCostUpdatedAt = new Date();
  // Also set cost per line
  for(const line of doc.recipe){
    const ing = await Ingredient.findById(line.ingredient).lean();
    const baseQty = toBaseQty(line.qty, line.unit, ing);
    // need average cost per base unit
    const lineCost = await calculateRecipeCost([line], { restaurantId });
    line.cost = lineCost;
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

export async function updateMenuItem({ menuId, patch, expectedVersion, user }){
  if(!mongoose.isValidObjectId(menuId)) throw httpError('Invalid menu item',400);
  const restaurantId = await resolveRestaurant(user);
  if(!['owner','manager'].includes((await userRestaurantContext(user)).role)) throw httpError('Only owner/manager can update menu items',403);
  const row = await MenuItem.findOne({ _id: menuId, $or:[{restaurant:restaurantId},{restaurant:null},{restaurant:{$exists:false}}] });
  if(!row) throw httpError('Menu item not found',404);
  if(expectedVersion!==undefined && Number(expectedVersion)!==row.__v) throw httpError('Menu item changed since loaded; refresh',409);
  const before = row.toObject();
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
    row.recipe=newRecipe;
  }
  // Recalculate costs if recipe changed
  if(patch.recipe!==undefined){
    const cost = await calculateRecipeCost(row.recipe, { restaurantId });
    row.recipeCost=cost;
    row.recipeCostUpdatedAt=new Date();
    for(const line of row.recipe){
      const ing=await Ingredient.findById(line.ingredient).lean();
      line.cost = await calculateRecipeCost([line], { restaurantId });
    }
  } else if(patch.price!==undefined){
    // price change doesn't need cost recalc, but we could keep
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
  // Soft delete via active false if has orders? For now allow deactivate only
  throw httpError('Menu items with order history cannot be deleted; deactivate instead',409);
}

export async function ensureRecipeIndexes(){
  await MenuItem.collection.createIndex({restaurant:1,code:1},{unique:true,name:'menu_restaurant_code',partialFilterExpression:{restaurant:{$type:'objectId'},code:{$type:'string'}}});
  await MenuItem.collection.createIndex({restaurant:1,name:1},{unique:true,name:'menu_restaurant_name',partialFilterExpression:{restaurant:{$type:'objectId'},name:{$type:'string'}}});
}

