import 'dotenv/config';import express from 'express';import mongoose from 'mongoose';import cors from 'cors';
import {User,Ingredient,MenuItem,Expense,Audit} from './models/index.js';import {auth,requireStaff,requirePermission} from './middleware/auth.js';
import ingredientsRouter from './routes/ingredients.js';
import recipesRouter from './routes/recipes.js';import customersRouter from './routes/customers.js';import deliveriesRouter from './routes/deliveries.js';import authRouter from './routes/auth.js';import accountsRouter from './routes/accounts.js';import {audit} from './services/engine.js';import http from 'http';import operations from './routes/operations.js';import exportsRouter from './routes/exports.js';import rbacRouter from './routes/rbac.js';import auditRouter from './routes/audit.js';import notificationsRouter from './routes/notifications.js';import supplierCatalog from './routes/supplierCatalog.js';import {attachRealtime,closeRealtime} from './services/realtime.js';import {ensureOperationalIndexes,validateRuntimeEnvironment,verifyTransactionCapableDatabase} from './services/startup.js';import {startReorderScheduler,stopReorderScheduler} from './services/reorderScheduler.js';import {startRoleChangeStream,stopRoleChangeStream} from './services/roleChangeStream.js';import {describeDeployment,resolveCorsOptions,resolveEnvironment,resolveTrustProxy} from './services/deployment.js';import {rateLimitScope} from './services/rateLimiting.js';import {describePayments} from './services/paymentConfig.js';
// Deployment posture is resolved once, at load, so a misconfigured staging or
// production process fails immediately instead of serving traffic with
// development-grade CORS. See services/deployment.js for the topology notes.
const corsOptions=resolveCorsOptions();const corsOrigin=corsOptions.origin;const deployment=describeDeployment();
const app=express();
// Trust exactly the proxies that actually exist. Default 'loopback'; set
// TRUST_PROXY=1 for the nginx in client/nginx.conf. Never true/*, which would
// make a client's own X-Forwarded-For authoritative and let it forge its
// rate-limit identity.
app.set('trust proxy',resolveTrustProxy());
app.use(cors({origin:corsOrigin,credentials:corsOptions.credentials}));app.use(express.json());app.use('/api',authRouter);app.use('/api',accountsRouter);app.use('/api',customersRouter);app.use('/api',deliveriesRouter);app.use('/api',rbacRouter);app.use('/api',auditRouter);app.use('/api',notificationsRouter);app.use('/api',exportsRouter);app.use('/api',operations);app.use('/api',supplierCatalog);
const crud=(path,Model,roles=['owner','manager'])=>{app.get('/api/'+path,requireStaff(),async(req,res)=>res.json(await Model.find().sort({createdAt:-1}).populate('supplier ingredient menuItem')));app.post('/api/'+path,auth(roles),async(req,res)=>{const d=await Model.create(req.body);await audit({entity:path,entityId:d._id,action:'create',after:d,user:req.user.id});res.status(201).json(d)});app.patch('/api/'+path+'/:id',auth(roles),async(req,res)=>{const before=await Model.findById(req.params.id);const d=await Model.findByIdAndUpdate(req.params.id,req.body,{new:true});await audit({entity:path,entityId:d._id,action:'update',before,after:d,user:req.user.id});res.json(d)});app.delete('/api/'+path+'/:id',auth(['owner']),async(req,res)=>{const d=await Model.findByIdAndDelete(req.params.id);await audit({entity:path,entityId:req.params.id,action:'delete',before:d,user:req.user.id});res.status(204).end()})};
app.use('/api', ingredientsRouter);
app.use('/api', recipesRouter);
// Ingredient master now via ingredientsRouter (Phase 3A) — includes units, conversions, categories, suppliers, costs
app.delete('/api/ingredients/:id',requirePermission('ingredients.delete'),async(_req,res)=>res.status(409).json({message:'Ingredients with inventory history cannot be deleted; deactivate the ingredient instead'}));
crud('expenses',Expense,['owner','manager']);
// These three are PERMANENTLY retired and return 410 to every caller. They
// carried requireStaff() only because everything else did; the guard gates
// nothing, since the handler ignores the principal entirely. Phase 20 makes
// that harmful: authentication now resolves against the database, so a
// caller whose account no longer exists gets a 401 that HIDES the 410 and
// makes a retired endpoint look like an auth problem. The tombstone should
// answer the same way to everyone.
app.all('/api/purchases',(_req,res)=>res.status(410).json({message:'Legacy purchases are retired. Use purchase orders and goods receiving so stock is posted atomically to the inventory ledger.'}));
app.all('/api/sales',(_req,res)=>res.status(410).json({message:'Legacy sales are retired. Use orders so recipe stock is posted atomically to the inventory ledger.'}));
app.all('/api/waste',(_req,res)=>res.status(410).json({message:'Legacy waste records are retired. Use the waste inventory operation so stock is posted atomically to the inventory ledger.'}));
// Phase 21: the inline /api/audit handler is retired. It ran `Audit.find()`
// with NO tenant filter, so an owner of one restaurant could read every other
// restaurant's audit rows -- a cross-tenant leak that no test caught because
// the route lived here, outside the test harness's router set. It is replaced
// by routes/audit.js, which is mounted in BOTH production and the harness and
// scopes every query through userRestaurantContext().
let startupReady=false;
app.get('/health',(req,res)=>{const database=mongoose.connection.readyState===1?'connected':'unavailable';const ok=startupReady&&database==='connected';res.status(ok?200:503).json({ok,database,startup:startupReady?'ready':'starting',environment:deployment.environment,cors:deployment.cors,trustProxy:String(deployment.trustProxy),rateLimit:rateLimitScope(),clientIp:req.ip,payments:describePayments()})});
app.use((e,req,res,next)=>{console.error(e);res.status(e.status||500).json({message:e.message||'Server error'})});

const httpServer=http.createServer(app);attachRealtime(httpServer,{corsOrigin});
let shuttingDown=false;
async function shutdown(signal){
  if(shuttingDown)return;
  shuttingDown=true;startupReady=false;
  console.log(`${signal} received; shutting down`);
  const force=setTimeout(()=>process.exit(1),10000);force.unref();
  try{
    await stopReorderScheduler();
    await stopRoleChangeStream();
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
  // Phase 16A: opt-in scheduled reorder sweep. Disabled unless
  // REORDER_SCHEDULER_ENABLED is set, and it never blocks startup.
  try{startReorderScheduler();}catch(error){console.error('Reorder scheduler failed to start',error);}
  // Cross-instance role-cache invalidation. Optional: losing it degrades to
  // the 5s TTL, so a failure must never stop the API booting.
  try{await startRoleChangeStream();}catch(error){console.error('Role change stream failed to start',error);}
  startupReady=true;
  const port=Number(process.env.PORT||4000);
  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(port,'0.0.0.0',()=>{httpServer.off('error',reject);resolve()})});
  console.log(`API ready on port ${port}`);
}
start().catch(async error=>{console.error('API startup failed',error);startupReady=false;if(mongoose.connection.readyState)await mongoose.disconnect().catch(()=>{});process.exit(1)});
