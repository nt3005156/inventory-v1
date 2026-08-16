import 'dotenv/config';import express from 'express';import mongoose from 'mongoose';import cors from 'cors';import rateLimit from 'express-rate-limit';import bcrypt from 'bcryptjs';import jwt from 'jsonwebtoken';
import {User,Ingredient,MenuItem,Purchase,PriceHistory,Sale,Waste,Expense,MonthlySnapshot,Audit} from './models/index.js';import {auth} from './middleware/auth.js';import {recipeCost,consumeRecipe,inventoryValue,audit} from './services/engine.js';import http from 'http';import operations from './routes/operations.js';import supplierCatalog from './routes/supplierCatalog.js';import {attachRealtime,closeRealtime} from './services/realtime.js';import {configuredClientOrigins,ensureOperationalIndexes,validateRuntimeEnvironment,verifyTransactionCapableDatabase} from './services/startup.js';
const allowedOrigins=configuredClientOrigins();const corsOrigin=allowedOrigins.length?allowedOrigins:true;
const app=express();app.set('trust proxy',1);app.use(cors({origin:corsOrigin}));app.use(express.json());app.use('/api',operations);app.use('/api',supplierCatalog);
const sign=u=>jwt.sign({id:u._id,name:u.name,role:u.role,restaurantId:u.restaurantId||null,branch:u.branch||null},process.env.JWT_SECRET,{expiresIn:'12h'});
app.post('/api/auth/login',rateLimit({windowMs:900000,max:10}),async(req,res)=>{const u=await User.findOne({email:req.body.email});if(!u||!await bcrypt.compare(req.body.password,u.password))return res.status(401).json({message:'Invalid email or password'});res.json({token:sign(u),user:{id:u._id,name:u.name,role:u.role,restaurantId:u.restaurantId||null,branch:u.branch||null}})});
app.post('/api/auth/register',auth(['owner']),async(req,res)=>{const password=await bcrypt.hash(req.body.password,12);res.status(201).json(await User.create({...req.body,password}))});
const crud=(path,Model,roles=['owner','manager'])=>{app.get('/api/'+path,auth(),async(req,res)=>res.json(await Model.find().sort({createdAt:-1}).populate('supplier ingredient menuItem')));app.post('/api/'+path,auth(roles),async(req,res)=>{const d=await Model.create(req.body);await audit({entity:path,entityId:d._id,action:'create',after:d,user:req.user.id});res.status(201).json(d)});app.patch('/api/'+path+'/:id',auth(roles),async(req,res)=>{const before=await Model.findById(req.params.id);const d=await Model.findByIdAndUpdate(req.params.id,req.body,{new:true});await audit({entity:path,entityId:d._id,action:'update',before,after:d,user:req.user.id});res.json(d)});app.delete('/api/'+path+'/:id',auth(['owner']),async(req,res)=>{const d=await Model.findByIdAndDelete(req.params.id);await audit({entity:path,entityId:req.params.id,action:'delete',before:d,user:req.user.id});res.status(204).end()})};
crud('ingredients',Ingredient);crud('menu-items',MenuItem);crud('expenses',Expense,['owner','manager']);crud('waste',Waste,['owner','manager']);
app.post('/api/purchases',auth(['owner','manager','staff']),async(req,res)=>{const p=await Purchase.create({...req.body,createdBy:req.user.id});const i=await Ingredient.findById(p.ingredient);const old=i.stockQty||0,newQty=old+p.qty;i.averageCost=newQty?(old*i.averageCost+p.total)/newQty:p.unitPrice;i.stockQty=newQty;i.lastPurchasePrice=p.unitPrice;await i.save();await PriceHistory.create({ingredient:i._id,price:p.unitPrice,qty:p.qty,unit:p.unit,purchase:p._id,user:req.user.id});await audit({entity:'purchase',entityId:p._id,action:'create',after:p,user:req.user.id});res.status(201).json(p)});app.get('/api/purchases',auth(),async(req,res)=>res.json(await Purchase.find().populate('ingredient supplier').sort({date:-1})));
app.post('/api/sales',auth(['owner','manager','staff']),async(req,res)=>{let subtotal=0,cogs=0;const items=[];for(const row of req.body.items){const m=await MenuItem.findById(row.menuItem);const cost=await recipeCost(m);const qty=Number(row.qty||1);subtotal+=m.price*qty;cogs+=cost*qty;items.push({menuItem:m._id,name:m.name,qty,unitPrice:m.price,foodCost:cost});await consumeRecipe(m,qty)}const vat=req.body.vatInclusive?0:subtotal*.13;const sale=await Sale.create({items,orderType:req.body.orderType,paymentMethod:req.body.paymentMethod,subtotal,vat,total:subtotal+vat,cogs,grossProfit:subtotal-cogs,createdBy:req.user.id});res.status(201).json(sale)});app.get('/api/sales',auth(),async(req,res)=>res.json(await Sale.find().sort({date:-1}).limit(200)));
app.get('/api/inventory',auth(),async(req,res)=>{const items=await Ingredient.find().populate('supplier');res.json(items.map(i=>({...i.toJSON(),stockValue:i.stockQty*i.averageCost,status:i.stockQty<=0?'negative':i.stockQty<=i.minimumStock?'reorder':'ok'})))});
app.get('/api/dashboard',auth(),async(req,res)=>{const start=new Date();start.setHours(0,0,0,0);const [sales,ingredients,expenses]=await Promise.all([Sale.find({date:{$gte:start}}),Ingredient.find(),Expense.find({date:{$gte:start}})]);const revenue=sales.reduce((s,x)=>s+x.total,0),cogs=sales.reduce((s,x)=>s+x.cogs,0),expense=expenses.reduce((s,x)=>s+x.amount,0);res.json({revenue,cogs,expense,profit:revenue-cogs-expense,orders:sales.length,lowStock:ingredients.filter(x=>x.stockQty<=x.minimumStock),inventoryValue:await inventoryValue()})});
app.get('/api/analytics/menu-engineering',auth(['owner','manager']),async(req,res)=>{const [menu,sales]=await Promise.all([MenuItem.find(),Sale.find()]);const count={};sales.forEach(s=>s.items.forEach(x=>count[x.menuItem]=(count[x.menuItem]||0)+x.qty));const total=Object.values(count).reduce((a,b)=>a+b,0)||1;const rows=[];for(const m of menu){const cost=await recipeCost(m),pop=(count[m._id]||0)/total,margin=m.price-cost;rows.push({id:m._id,name:m.name,popularity:pop,margin,classification:pop>=.15?(margin>=100?'Star':'Plow-horse'):(margin>=100?'Puzzle':'Dog')})}res.json(rows)});
app.get('/api/reports/pnl',auth(['owner','manager']),async(req,res)=>{const [sales,buys,expenses]=await Promise.all([Sale.find(),Purchase.find(),Expense.find()]);const revenue=sales.reduce((s,x)=>s+x.total,0),cogs=sales.reduce((s,x)=>s+x.cogs,0),expense=expenses.reduce((s,x)=>s+x.amount,0);res.json({revenue,cogs,grossProfit:revenue-cogs,purchases:buys.reduce((s,x)=>s+x.total,0),expenses:expense,netProfit:revenue-cogs-expense})});
app.get('/api/audit',auth(['owner']),async(req,res)=>res.json(await Audit.find().sort({at:-1}).limit(300).populate('user')));
let startupReady=false;
app.get('/health',(_,res)=>{const database=mongoose.connection.readyState===1?'connected':'unavailable';const ok=startupReady&&database==='connected';res.status(ok?200:503).json({ok,database,startup:startupReady?'ready':'starting'})});
app.use((e,req,res,next)=>{console.error(e);res.status(e.status||500).json({message:e.message||'Server error'})});

const httpServer=http.createServer(app);attachRealtime(httpServer,{corsOrigin});
let shuttingDown=false;
async function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;startupReady=false;
  console.log(`${signal} received; shutting down`);
  const force=setTimeout(()=>process.exit(1),10000);force.unref();
  try{
    await closeRealtime();
    if(httpServer.listening)await new Promise((resolve,reject)=>httpServer.close(error=>error?reject(error):resolve()));
    if(mongoose.connection.readyState)await mongoose.disconnect();
    clearTimeout(force);
    process.exit(0);
  }catch(error){console.error('Graceful shutdown failed',error);process.exit(1)}
}
process.once('SIGTERM',()=>shutdown('SIGTERM'));process.once('SIGINT',()=>shutdown('SIGINT'));

async function start(){
  validateRuntimeEnvironment();
  await mongoose.connect(process.env.MONGODB_URI);
  await verifyTransactionCapableDatabase();
  await ensureOperationalIndexes();
  startupReady=true;
  const port=Number(process.env.PORT||4000);
  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(port,'0.0.0.0',()=>{httpServer.off('error',reject);resolve()})});
  console.log(`API ready on port ${port}`);
}
start().catch(async error=>{console.error('API startup failed',error);startupReady=false;if(mongoose.connection.readyState)await mongoose.disconnect().catch(()=>{});process.exit(1)});
