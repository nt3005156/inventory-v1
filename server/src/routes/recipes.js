import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { auth, requirePermission} from '../middleware/auth.js';
import { listMenuItems, getMenuItem, createMenuItem, updateMenuItem, getRecipeVersions, getFoodCosting } from '../services/recipes.js';

const r = Router();
const fail = (res,e)=> res.status(e.status||400).json({message:e.message||'Failed'});
const parse = (s,b)=> s.parse(b);

const recipeLine = z.object({
  ingredient: z.string().min(1),
  qty: z.number().positive().max(1000000),
  unit: z.string().min(1).max(30),
  notes: z.string().max(200).optional()
});


const modifierOption = z.object({
  key: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  priceDelta: z.number().min(-100000).max(100000).optional(),
  priceOverride: z.number().min(0).max(1000000).nullable().optional(),
  isDefault: z.boolean().optional(),
  ingredient: z.string().min(1).nullable().optional(),
  qty: z.number().min(0).max(1000000).optional(),
  unit: z.string().max(30).optional()
}).strict();

const modifierGroup = z.object({
  key: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['variant', 'extra', 'addon', 'removal']).optional(),
  selection: z.enum(['single', 'multi']).optional(),
  required: z.boolean().optional(),
  minSelect: z.number().int().min(0).max(50).optional(),
  maxSelect: z.number().int().min(0).max(50).optional(),
  options: z.array(modifierOption).min(1).max(50)
}).strict();

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  nameNp: z.string().trim().max(120).optional(),
  code: z.string().trim().max(30).optional(),
  category: z.string().trim().max(60).optional(),
  price: z.number().min(0).max(1000000),
  vatInclusive: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
  yield: z.number().positive().max(1000).optional(),
  yieldUnit: z.string().max(30).optional(),
  station: z.string().trim().max(40).optional(),
  prepMinutes: z.number().min(0).max(600).optional(),
  recipe: z.array(recipeLine).max(50).optional(),
  modifierGroups: z.array(modifierGroup).max(20).optional(),
  packagingCost: z.number().min(0).max(100000).optional(),
  description: z.string().max(500).optional(),
  imageUrl: z.string().max(500).optional()
}).strict();

const updateSchema = z.object({
  expectedVersion: z.number().int().nonnegative().optional(),
  name: z.string().trim().min(2).max(120).optional(),
  nameNp: z.string().trim().max(120).optional(),
  code: z.string().trim().max(30).optional().nullable(),
  category: z.string().trim().max(60).optional(),
  price: z.number().min(0).max(1000000).optional(),
  vatInclusive: z.boolean().optional(),
  vatRate: z.number().min(0).max(100).optional(),
  active: z.boolean().optional(),
  yield: z.number().positive().max(1000).optional(),
  yieldUnit: z.string().max(30).optional(),
  station: z.string().trim().max(40).optional(),
  prepMinutes: z.number().min(0).max(600).optional(),
  recipe: z.array(recipeLine).max(50).optional(),
  modifierGroups: z.array(modifierGroup).max(20).optional(),
  packagingCost: z.number().min(0).max(100000).optional(),
  description: z.string().max(500).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable(),
  reason: z.string().max(500).optional()
}).strict();

r.get('/menu-items', requirePermission('menu.view'), async(req,res)=>{
  try{
    res.json(await listMenuItems({
      user:req.user,
      q:req.query.q,
      category:req.query.category,
      active:req.query.active,
      page:req.query.page,
      limit:req.query.limit,
      branchId: req.query.branch
    }));
  }catch(e){ fail(res,e); }
});

r.post('/menu-items', requirePermission('menu.manage'), async(req,res)=>{
  try{
    const input = parse(createSchema, req.body);
    const row = await createMenuItem({principal: req.principal, input, user:req.user});
    res.status(201).json(row);
  }catch(e){ fail(res,e); }
});

r.get('/menu-items/:id', requirePermission('menu.view'), async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid menu item'),{status:400});
    res.json(await getMenuItem({menuId:req.params.id, user:req.user, branchId:req.query.branch}));
  }catch(e){ fail(res,e); }
});

r.patch('/menu-items/:id', requirePermission('menu.manage'), async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid menu item'),{status:400});
    const {expectedVersion, ...patch} = parse(updateSchema, req.body);
    res.json(await updateMenuItem({principal: req.principal, menuId:req.params.id, patch, expectedVersion, user:req.user}));
  }catch(e){ fail(res,e); }
});

r.delete('/menu-items/:id', requirePermission('menu.delete'), async(req,res)=>{
  res.status(409).json({message:'Menu items with order history cannot be deleted; deactivate instead'});
});

r.get('/menu-items/:id/versions', requirePermission('menu.view'), async(req,res)=>{
  try{
    res.json(await getRecipeVersions({menuId:req.params.id, user:req.user}));
  }catch(e){ fail(res,e); }
});

r.get('/menu-items/:id/food-costing', requirePermission('menu.view'), async(req,res)=>{
  try{
    res.json(await getFoodCosting({menuId:req.params.id, user:req.user, branchId:req.query.branch}));
  }catch(e){ fail(res,e); }
});

r.get('/menu-items/:id/cost', requirePermission('menu.view'), async(req,res)=>{
  try{
    const data = await getFoodCosting({menuId:req.params.id, user:req.user, branchId:req.query.branch});
    res.json({ recipeCost: data.recipeCost, packagingCost: data.packagingCost, foodCost: data.foodCost, price: data.sellingPrice, margin: data.grossMargin, foodCostPercent: data.foodCostPercent, recipe: data.recipe, recipeVersion: data.recipeVersion });
  }catch(e){ fail(res,e); }
});

export default r;
