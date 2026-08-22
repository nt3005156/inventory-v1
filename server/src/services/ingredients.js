import mongoose from 'mongoose';
import {assertCapability} from './capabilities.js';
import { Ingredient, Supplier, Audit } from '../models/index.js';
import { Branch, InventoryBalance } from '../models/operations.js';
import { SupplierIngredient, SupplierPriceHistory } from '../models/supplierCatalog.js';
import { userRestaurantContext } from './supplierCatalog.js';

const clean = v => String(v ?? '').trim();
const money = v => Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

function httpError(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

export const INGREDIENT_CATEGORIES = Object.freeze([
  'vegetable','fruit','meat','seafood','poultry','dairy','spice','grain','pulse','oil','beverage','bakery','frozen','dry','condiment','other'
]);

export const INGREDIENT_UNITS = Object.freeze([
  'g','kg','mg','ml','l','pcs','piece','bag','box','bottle','can','unit','each','pack','carton','jar','sachet','tin','bundle','bunch','dozen'
]);

// Base conversions to stock unit (g/ml/pcs equivalents) for validation - not exhaustive, just for sanity
const BASE_CONVERSION_HINTS = Object.freeze({
  'kg->g': 1000,
  'g->kg': 0.001,
  'l->ml': 1000,
  'ml->l': 0.001,
  'bag->g': null, // custom per ingredient
  'box->pcs': null
});

export function normalizeUnit(u){ return clean(u).toLowerCase(); }
export function normalizeCategory(c){ return clean(c).toLowerCase(); }

export function validateCategory(cat){
  const c = normalizeCategory(cat);
  if(!c) return 'other';
  if(!INGREDIENT_CATEGORIES.includes(c)) throw httpError(`Invalid category. Allowed: ${INGREDIENT_CATEGORIES.join(', ')}`, 400);
  return c;
}
export function validateUnit(unit){
  const u = normalizeUnit(unit);
  if(!u) throw httpError('Unit is required', 400);
  if(!INGREDIENT_UNITS.includes(u)) throw httpError(`Invalid unit. Allowed: ${INGREDIENT_UNITS.join(', ')}`, 400);
  return u;
}
export function validateConversions(conversions, baseUnit){
  if(!conversions) return undefined;
  if(!Array.isArray(conversions)) throw httpError('Conversions must be an array', 400);
  const seen = new Set();
  const out = [];
  for(const c of conversions){
    const unit = normalizeUnit(c.unit);
    if(!unit) throw httpError('Conversion unit is required', 400);
    if(!INGREDIENT_UNITS.includes(unit)) throw httpError(`Invalid conversion unit ${unit}`, 400);
    if(unit === baseUnit) throw httpError(`Conversion unit must differ from base unit ${baseUnit}`, 400);
    if(seen.has(unit)) throw httpError(`Duplicate conversion unit ${unit}`, 400);
    seen.add(unit);
    const factor = Number(c.factor);
    if(!Number.isFinite(factor) || factor <=0) throw httpError(`Conversion factor for ${unit} must be positive`, 400);
    out.push({ unit, factor, description: clean(c.description) || undefined });
  }
  if(out.length>20) throw httpError('Too many conversions (max 20)', 400);
  return out.length ? out : undefined;
}

function ingredientView(row, { averageCost, supplierCount } = {}){
  const obj = row?.toJSON ? row.toJSON() : {...row};
  // enrich with computed costs if provided
  if(averageCost !== undefined) obj.averageCost = averageCost;
  if(supplierCount !== undefined) obj.supplierCount = supplierCount;
  return obj;
}

async function enrichIngredients(rows, restaurantId){
  if(!rows.length) return rows;
  const ids = rows.map(r=>r._id);
  const [balances, catalogCounts, priceHist] = await Promise.all([
    InventoryBalance.find({ ingredient: { $in: ids } }).select('ingredient quantity averageCost').lean(),
    SupplierIngredient.aggregate([{ $match: { restaurant: restaurantId, ingredient: { $in: ids }, active: true }}, { $group: { _id: '$ingredient', count: { $sum: 1 } } }]),
    // last purchase price per ingredient: handled via InventoryTransaction? Use balances average for now, and catalog for supplier price
  ]);
  const balById = new Map(balances.map(b=>[String(b.ingredient), b]));
  const countById = new Map(catalogCounts.map(c=>[String(c._id), c.count]));
  return rows.map(r=>{
    const bal = balById.get(String(r._id));
    const avg = bal ? Number(bal.averageCost||0) : 0;
    const qty = bal ? Number(bal.quantity||0) : 0;
    const supCount = countById.get(String(r._id)) || 0;
    return ingredientView(r, { averageCost: avg, supplierCount: supCount });
  });
}

export async function listIngredients({ user, q, category, unit, active, supplier, page=1, limit=50, sort='name' }){
  const ctx = await userRestaurantContext(user);
  const restaurantId = ctx.restaurantId;
  const safePage = Math.max(1, Number(page)||1);
  const safeLimit = Math.min(200, Math.max(1, Number(limit)||50));
  const match = { restaurant: restaurantId };
  if(active !== undefined && active !== ''){
    if(!['true','false'].includes(String(active))) throw httpError('Invalid active filter',400);
    match.active = String(active)==='true';
  }
  if(category){
    const cat = normalizeCategory(category);
    if(!INGREDIENT_CATEGORIES.includes(cat)) throw httpError('Invalid category filter',400);
    match.category = cat;
  }
  if(unit){
    const u = normalizeUnit(unit);
    if(!INGREDIENT_UNITS.includes(u)) throw httpError('Invalid unit filter',400);
    match.unit = u;
  }
  if(supplier){
    if(!mongoose.isValidObjectId(supplier)) throw httpError('Invalid supplier',400);
    const catalogIngredientIds = await SupplierIngredient.distinct('ingredient', { restaurant: restaurantId, supplier: new mongoose.Types.ObjectId(supplier), active:true });
    match._id = { $in: catalogIngredientIds.length ? catalogIngredientIds : [new mongoose.Types.ObjectId()] };
  }
  const term = clean(q);
  if(term){
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
    match.$or = [{ name: regex }, { code: regex }, { category: regex }];
  }
  const sortMap = { name: { name:1, _id:1 }, code: { code:1 }, category: { category:1, name:1 }, unit: { unit:1 }, updatedAt: { updatedAt:-1 } };
  const sortStage = sortMap[sort] || sortMap.name;

  const [rows, total] = await Promise.all([
    Ingredient.find(match).sort(sortStage).skip((safePage-1)*safeLimit).limit(safeLimit).populate('supplier','name').populate('primarySupplier','name').lean(),
    Ingredient.countDocuments(match)
  ]);
  const enriched = await enrichIngredients(rows, restaurantId);
  return { items: enriched, pagination: { page: safePage, limit: safeLimit, total, pages: Math.max(1, Math.ceil(total/safeLimit)) }, categories: INGREDIENT_CATEGORIES, units: INGREDIENT_UNITS };
}

export async function getIngredient({ ingredientId, user }){
  if(!mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient',400);
  const ctx = await userRestaurantContext(user);
  const row = await Ingredient.findOne({ _id: ingredientId, restaurant: ctx.restaurantId }).populate('supplier','name contact').populate('primarySupplier','name contact').lean();
  if(!row) throw httpError('Ingredient not found',404);
  const [balance, catalogItems, priceHistory] = await Promise.all([
    InventoryBalance.findOne({ ingredient: row._id }).select('quantity averageCost').lean(),
    SupplierIngredient.find({ restaurant: ctx.restaurantId, ingredient: row._id, active:true }).populate('supplier','name contact paymentTerms').sort({ updatedAt:-1 }).lean(),
    SupplierPriceHistory.find({ restaurant: ctx.restaurantId, ingredient: row._id }).sort({ effectiveAt:-1 }).limit(5).populate('supplier','name').populate('changedBy','name').lean()
  ]);
  const suppliers = catalogItems.map(c=> ({
    catalogId: c._id,
    supplier: c.supplier,
    supplierSku: c.supplierSku,
    purchaseUnit: c.purchaseUnit,
    baseUnit: c.baseUnit,
    conversionFactor: c.conversionFactor,
    currentPrice: c.currentPrice,
    baseUnitPrice: c.conversionFactor ? c.currentPrice / c.conversionFactor : 0,
    priceIncludesVat: c.priceIncludesVat,
    vatRate: c.vatRate,
    minOrderQty: c.minOrderQty,
    leadDays: c.leadDays,
    active: c.active
  }));
  const costs = {
    averageCost: balance ? Number(balance.averageCost||0) : 0,
    stockQty: balance ? Number(balance.quantity||0) : 0,
    stockValue: balance ? money(Number(balance.quantity||0)*Number(balance.averageCost||0)) : 0,
    lastPurchasePrice: Number(row.lastPurchasePrice||0),
    standardCost: Number(row.standardCost||0),
    supplierPrices: suppliers.map(s=> ({ supplierId: s.supplier?._id || s.supplier, supplierName: s.supplier?.name || '', price: s.currentPrice, baseUnitPrice: s.baseUnitPrice, purchaseUnit: s.purchaseUnit })),
    priceHistory: priceHistory.map(h=> ({ price: h.price, purchaseUnit: h.purchaseUnit, baseUnit: h.baseUnit, factor: h.conversionFactor, effectiveAt: h.effectiveAt, reason: h.reason }))
  };
  // conversions enriched
  const conversions = (row.conversions||[]).map(c=> ({ unit: c.unit, factor: c.factor, description: c.description, baseUnit: row.baseUnit || row.unit }));
  return { ...row, costs, suppliers, conversions, supplierCount: suppliers.length, averageCost: costs.averageCost };
}

export async function createIngredient({ input, user, principal }){
  const ctx = await userRestaurantContext(user);
  assertCapability(user, principal, 'ingredients.manage', 'Only owner/manager can create ingredients');
  const name = clean(input.name);
  if(!name || name.length<2) throw httpError('Ingredient name must be at least 2 characters',400);
  if(name.length>120) throw httpError('Ingredient name too long',400);
  const code = input.code ? clean(input.code).toUpperCase() : undefined;
  if(code && !/^[A-Z0-9_-]{2,30}$/.test(code)) throw httpError('Code must be 2-30 chars A-Z 0-9 _ -',400);
  const category = input.category ? validateCategory(input.category) : 'other';
  const unit = validateUnit(input.unit || 'g');
  const baseUnit = input.baseUnit ? validateUnit(input.baseUnit) : unit;
  if(baseUnit !== unit) throw httpError('Base unit must match unit; conversions define alternatives',400);
  const conversions = validateConversions(input.conversions, baseUnit);
  const supplierId = input.supplier || input.primarySupplier;
  if(supplierId && !mongoose.isValidObjectId(supplierId)) throw httpError('Invalid supplier',400);
  if(supplierId){
    const sup = await Supplier.findOne({ _id: supplierId, restaurant: ctx.restaurantId, active: {$ne:false} });
    if(!sup) throw httpError('Supplier not found or not active for this restaurant',404);
  }
  const doc = {
    restaurant: ctx.restaurantId,
    code: code || undefined,
    name,
    nameNp: clean(input.nameNp) || undefined,
    category,
    unit,
    baseUnit,
    conversions,
    active: input.active !== false,
    minimumStock: input.minimumStock !== undefined ? money(input.minimumStock) : 0,
    reorderQty: input.reorderQty !== undefined ? money(input.reorderQty) : 0,
    reorderLevel: input.reorderLevel !== undefined ? money(input.reorderLevel) : (input.minimumStock!==undefined? money(input.minimumStock):0),
    lastPurchasePrice: input.lastPurchasePrice!==undefined ? money(input.lastPurchasePrice) : 0,
    standardCost: input.standardCost!==undefined ? money(input.standardCost) : 0,
    supplier: supplierId || undefined,
    primarySupplier: supplierId || undefined,
    shelfLifeDays: input.shelfLifeDays!==undefined ? Number(input.shelfLifeDays) : undefined,
    storage: clean(input.storage) || undefined,
    description: clean(input.description) || undefined,
    expiryDate: input.expiryDate ? new Date(input.expiryDate) : undefined
  };
  if(doc.shelfLifeDays!==undefined && (!Number.isFinite(doc.shelfLifeDays) || doc.shelfLifeDays<0 || doc.shelfLifeDays>3650)) throw httpError('Invalid shelfLifeDays',400);
  try{
    const [row] = await Ingredient.create([doc]);
    await Audit.create({ entity:'ingredients', entityId: row._id, restaurant: ctx.restaurantId, action:'create', after: row, user: ctx.userId });
    return ingredientView(row);
  }catch(e){
    if(e?.code===11000) throw httpError('Ingredient code already exists for this restaurant',409);
    if(e?.name==='ValidationError') throw httpError(e.message,400);
    throw e;
  }
}

export async function updateIngredient({ ingredientId, patch, expectedVersion, user, principal }){
  if(!mongoose.isValidObjectId(ingredientId)) throw httpError('Invalid ingredient',400);
  const ctx = await userRestaurantContext(user);
  assertCapability(user, principal, 'ingredients.manage', 'Only owner/manager can update ingredients');
  const row = await Ingredient.findOne({ _id: ingredientId, restaurant: ctx.restaurantId });
  if(!row) throw httpError('Ingredient not found',404);
  if(expectedVersion!==undefined && Number(expectedVersion)!==row.__v) throw httpError('Ingredient changed since it was loaded; refresh and try again',409);
  const before = row.toObject();
  if(patch.name!==undefined){
    const n=clean(patch.name);
    if(!n || n.length<2) throw httpError('Ingredient name must be at least 2 characters',400);
    row.name=n;
  }
  if(patch.nameNp!==undefined) row.nameNp=clean(patch.nameNp)||undefined;
  if(patch.code!==undefined){
    const c=clean(patch.code).toUpperCase();
    if(c && !/^[A-Z0-9_-]{2,30}$/.test(c)) throw httpError('Invalid code',400);
    row.code=c||undefined;
  }
  if(patch.category!==undefined) row.category=validateCategory(patch.category);
  if(patch.unit!==undefined){
    const u=validateUnit(patch.unit);
    // Changing base unit requires no stock? Warn but allow
    if(row.unit!==u){
      const bal = await InventoryBalance.findOne({ ingredient: row._id });
      if(bal && Number(bal.quantity||0)>1e-9) throw httpError('Cannot change unit while stock exists; adjust stock to zero first',409);
      row.unit=u;
      row.baseUnit=u;
    }
  }
  if(patch.conversions!==undefined) row.conversions=validateConversions(patch.conversions, row.baseUnit||row.unit);
  if(patch.active!==undefined) row.active=Boolean(patch.active);
  if(patch.minimumStock!==undefined) row.minimumStock=money(patch.minimumStock);
  if(patch.reorderQty!==undefined) row.reorderQty=money(patch.reorderQty);
  if(patch.reorderLevel!==undefined) row.reorderLevel=money(patch.reorderLevel);
  if(patch.lastPurchasePrice!==undefined) row.lastPurchasePrice=money(patch.lastPurchasePrice);
  if(patch.standardCost!==undefined) row.standardCost=money(patch.standardCost);
  if(patch.supplier!==undefined || patch.primarySupplier!==undefined){
    const sid = patch.primarySupplier || patch.supplier;
    if(sid){
      if(!mongoose.isValidObjectId(sid)) throw httpError('Invalid supplier',400);
      const sup=await Supplier.findOne({_id:sid, restaurant: ctx.restaurantId});
      if(!sup) throw httpError('Supplier not found for this restaurant',404);
      row.supplier=new mongoose.Types.ObjectId(sid);
      row.primarySupplier=new mongoose.Types.ObjectId(sid);
    }else{
      row.supplier=undefined;
      row.primarySupplier=undefined;
    }
  }
  if(patch.shelfLifeDays!==undefined){
    const v=Number(patch.shelfLifeDays);
    if(!Number.isFinite(v) || v<0 || v>3650) throw httpError('Invalid shelfLifeDays',400);
    row.shelfLifeDays=v;
  }
  if(patch.storage!==undefined) row.storage=clean(patch.storage)||undefined;
  if(patch.description!==undefined) row.description=clean(patch.description)||undefined;
  if(patch.expiryDate!==undefined) row.expiryDate= patch.expiryDate ? new Date(patch.expiryDate) : undefined;

  try{
    await row.save();
  }catch(e){
    if(e?.name==='VersionError') throw httpError('Ingredient changed since it was loaded; refresh and try again',409);
    if(e?.code===11000) throw httpError('Ingredient code already exists',409);
    throw e;
  }
  await Audit.create({ entity:'ingredients', entityId: row._id, restaurant: ctx.restaurantId, action:'update', before, after: row.toObject(), user: ctx.userId });
  return ingredientView(row);
}

export async function deactivateIngredient({ ingredientId, user }){
  return updateIngredient({ ingredientId, patch:{active:false}, user });
}

export async function listCategories({user}){
  const ctx = await userRestaurantContext(user);
  // distinct categories for restaurant plus canonical list
  const distinct = await Ingredient.distinct('category', { restaurant: ctx.restaurantId });
  const all = [...new Set([...INGREDIENT_CATEGORIES, ...distinct.map(c=>String(c).toLowerCase())])].sort();
  return { categories: all, canonical: INGREDIENT_CATEGORIES, distinct };
}

export async function listUnits(){
  return { units: INGREDIENT_UNITS, hints: BASE_CONVERSION_HINTS };
}

export function convertQuantity(qty, fromUnit, toUnit, ingredient){
  const base = normalizeUnit(ingredient?.unit || ingredient?.baseUnit || 'g');
  const from = normalizeUnit(fromUnit);
  const to = normalizeUnit(toUnit);
  if(from===to) return Number(qty);
  // Use ingredient conversions if available
  const convMap = new Map();
  convMap.set(base,1);
  for(const c of (ingredient?.conversions||[])){
    const u=normalizeUnit(c.unit);
    const f=Number(c.factor);
    if(u && Number.isFinite(f)) convMap.set(u,f);
  }
  // Also common hints
  const fromFactor = convMap.get(from);
  const toFactor = convMap.get(to);
  if(fromFactor!==undefined && toFactor!==undefined){
    // convert to base then to target: qty * fromFactor / toFactor
    return Number(qty) * fromFactor / toFactor;
  }
  // Try via base hints
  const key = `${from}->${base}`;
  const key2 = `${base}->${to}`;
  // fallback: if no conversion, throw
  throw httpError(`No conversion factor from ${fromUnit} to ${toUnit} for ingredient ${ingredient?.name||''}`,400);
}

export async function ensureIngredientIndexes(){
  // called from startup
  await Ingredient.collection.createIndex({restaurant:1,code:1},{unique:true,name:'ingredient_restaurant_code',partialFilterExpression:{restaurant:{$type:'objectId'},code:{$type:'string'}}});
  await Ingredient.collection.createIndex({restaurant:1,name:1},{name:'ingredient_restaurant_name'});
  await Ingredient.collection.createIndex({restaurant:1,category:1,active:1},{name:'ingredient_restaurant_category'});
  await Ingredient.collection.createIndex({restaurant:1,unit:1},{name:'ingredient_restaurant_unit'});
}
