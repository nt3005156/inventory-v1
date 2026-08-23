import { Router } from 'express';
import {fail as safeFail} from '../services/httpErrors.js';
import mongoose from 'mongoose';
import { z } from 'zod';
import { auth, requirePermission} from '../middleware/auth.js';
import {
  listIngredients,
  getIngredient,
  createIngredient,
  updateIngredient,
  listCategories,
  listUnits
} from '../services/ingredients.js';

const r = Router();
// Phase 25: shared safe error mapper. The local one echoed any error
// verbatim with a 400, leaking driver text and mislabelling server faults.
const fail = safeFail;
const parse = (s,b)=> s.parse(b);

const conversionSchema = z.object({
  unit: z.string().min(1).max(30),
  factor: z.number().positive().max(1000000),
  description: z.string().max(120).optional()
});

const createSchema = z.object({
  code: z.string().trim().max(30).optional(),
  name: z.string().trim().min(2).max(120),
  nameNp: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  unit: z.string().trim().min(1).max(30).optional(),
  baseUnit: z.string().trim().max(30).optional(),
  conversions: z.array(conversionSchema).max(20).optional(),
  active: z.boolean().optional(),
  minimumStock: z.number().min(0).max(1000000000).optional(),
  reorderQty: z.number().min(0).optional(),
  reorderLevel: z.number().min(0).optional(),
  lastPurchasePrice: z.number().min(0).optional(),
  standardCost: z.number().min(0).optional(),
  supplier: z.string().optional(),
  primarySupplier: z.string().optional(),
  shelfLifeDays: z.number().int().min(0).max(3650).optional(),
  storage: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  expiryDate: z.string().optional()
}).strict();

const updateSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  code: z.string().trim().max(30).optional(),
  name: z.string().trim().min(2).max(120).optional(),
  nameNp: z.string().trim().max(120).optional(),
  category: z.string().trim().max(60).optional(),
  unit: z.string().trim().min(1).max(30).optional(),
  conversions: z.array(conversionSchema).max(20).optional(),
  active: z.boolean().optional(),
  minimumStock: z.number().min(0).optional(),
  reorderQty: z.number().min(0).optional(),
  reorderLevel: z.number().min(0).optional(),
  lastPurchasePrice: z.number().min(0).optional(),
  standardCost: z.number().min(0).optional(),
  supplier: z.string().nullable().optional(),
  primarySupplier: z.string().nullable().optional(),
  shelfLifeDays: z.number().int().min(0).max(3650).optional(),
  storage: z.string().max(120).optional(),
  description: z.string().max(500).optional(),
  expiryDate: z.string().nullable().optional()
}).strict();

r.get('/ingredients/categories', requirePermission('ingredients.view'), async(req,res)=>{
  try{ res.json(await listCategories({user:req.user})); }catch(e){ fail(res,e); }
});

r.get('/ingredients/units', requirePermission('ingredients.view'), async(req,res)=>{
  try{ res.json(await listUnits()); }catch(e){ fail(res,e); }
});

r.get('/ingredients', requirePermission('ingredients.view'), async(req,res)=>{
  try{
    const q = req.query.q;
    const category = req.query.category;
    const unit = req.query.unit;
    const active = req.query.active;
    const supplier = req.query.supplier;
    const page = req.query.page;
    const limit = req.query.limit;
    const sort = req.query.sort;
    res.json(await listIngredients({user:req.user, q, category, unit, active, supplier, page, limit, sort}));
  }catch(e){ fail(res,e); }
});

r.post('/ingredients', requirePermission('ingredients.manage'), async(req,res)=>{
  try{
    const input = parse(createSchema, req.body);
    const row = await createIngredient({principal: req.principal, input, user:req.user});
    res.status(201).json(row);
  }catch(e){ fail(res,e); }
});

r.get('/ingredients/:id', requirePermission('ingredients.view'), async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid ingredient'),{status:400});
    res.json(await getIngredient({ingredientId:req.params.id, user:req.user}));
  }catch(e){ fail(res,e); }
});

r.patch('/ingredients/:id', requirePermission('ingredients.manage'), async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid ingredient'),{status:400});
    const {expectedVersion, ...patch} = parse(updateSchema, req.body);
    res.json(await updateIngredient({principal: req.principal, ingredientId:req.params.id, patch, expectedVersion, user:req.user}));
  }catch(e){ fail(res,e); }
});

r.get('/ingredients/:id/suppliers', requirePermission('ingredients.view'), async(req,res)=>{
  try{
    const data = await getIngredient({ingredientId:req.params.id, user:req.user});
    res.json({ suppliers: data.suppliers, count: data.suppliers.length });
  }catch(e){ fail(res,e); }
});

r.get('/ingredients/:id/costs', requirePermission('ingredients.view'), async(req,res)=>{
  try{
    const data = await getIngredient({ingredientId:req.params.id, user:req.user});
    res.json({ costs: data.costs, conversions: data.conversions, unit: data.unit, baseUnit: data.baseUnit });
  }catch(e){ fail(res,e); }
});

r.delete('/ingredients/:id', requirePermission('ingredients.delete'), async(req,res)=>{
  res.status(409).json({message:'Ingredients with inventory history cannot be deleted; deactivate the ingredient instead'});
});

export default r;
