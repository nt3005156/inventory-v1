import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { auth } from '../middleware/auth.js';
import { listMenuItems, getMenuItem, createMenuItem, updateMenuItem } from '../services/recipes.js';

const r = Router();
const fail = (res,e)=> res.status(e.status||400).json({message:e.message||'Failed'});
const parse = (s,b)=> s.parse(b);

const recipeLine = z.object({
  ingredient: z.string().min(1),
  qty: z.number().positive().max(1000000),
  unit: z.string().min(1).max(30),
  notes: z.string().max(200).optional()
});

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
  recipe: z.array(recipeLine).max(50).optional(),
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
  recipe: z.array(recipeLine).max(50).optional(),
  description: z.string().max(500).optional().nullable(),
  imageUrl: z.string().max(500).optional().nullable()
}).strict();

r.get('/menu-items', auth(['owner','manager','staff']), async(req,res)=>{
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

r.post('/menu-items', auth(['owner','manager']), async(req,res)=>{
  try{
    const input = parse(createSchema, req.body);
    const row = await createMenuItem({input, user:req.user});
    res.status(201).json(row);
  }catch(e){ fail(res,e); }
});

r.get('/menu-items/:id', auth(['owner','manager','staff']), async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid menu item'),{status:400});
    res.json(await getMenuItem({menuId:req.params.id, user:req.user, branchId:req.query.branch}));
  }catch(e){ fail(res,e); }
});

r.patch('/menu-items/:id', auth(['owner','manager']), async(req,res)=>{
  try{
    if(!mongoose.isValidObjectId(req.params.id)) throw Object.assign(new Error('Invalid menu item'),{status:400});
    const {expectedVersion, ...patch} = parse(updateSchema, req.body);
    res.json(await updateMenuItem({menuId:req.params.id, patch, expectedVersion, user:req.user}));
  }catch(e){ fail(res,e); }
});

r.delete('/menu-items/:id', auth(['owner']), async(req,res)=>{
  res.status(409).json({message:'Menu items with order history cannot be deleted; deactivate instead'});
});

r.get('/menu-items/:id/cost', auth(['owner','manager','staff']), async(req,res)=>{
  try{
    const data = await getMenuItem({menuId:req.params.id, user:req.user, branchId:req.query.branch});
    res.json({ recipeCost: data.recipeCost, price: data.price, margin: data.margin, foodCostPercent: data.foodCostPercent, recipe: data.recipe });
  }catch(e){ fail(res,e); }
});

export default r;
