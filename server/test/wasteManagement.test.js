import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import {io as clientIo} from 'socket.io-client';
import {Ingredient, User} from '../src/models/index.js';
import {Branch, InventoryBalance, InventoryBatch, InventoryTransaction, Restaurant, WASTE_CATEGORY_TYPES} from '../src/models/operations.js';
import {moveStock} from '../src/services/inventoryLedger.js';
import {ensureInventoryLedgerIndexes} from '../src/services/inventoryLedgerMigration.js';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';

let baseUrl;
let world;

before(async()=>{
  ({baseUrl}=await startTestApp());
});

after(async()=>{
  await stopTestApp();
});

beforeEach(async()=>{
  await clearDb();
  world=await seedWorld();
});

function postWaste({
  user=world.staffA,
  branch=world.branchA._id,
  ingredient=world.ingredient._id,
  qty=10,
  reason='spoiled',
  notes,
  batchId,
  key='waste-test-key'
}={}){
  return request('/api/waste/record',{
    method:'POST',
    token:tokenFor(user),
    headers:{'Idempotency-Key':key},
    body:{branch:String(branch),ingredient:String(ingredient),qty,reason,...(notes==null?{}:{notes}),...(batchId?{batchId:String(batchId)}:{})}
  });
}

function connectSocket(token,branch){
  return new Promise((resolve,reject)=>{
    const socket=clientIo(baseUrl,{auth:{token,branch},transports:['websocket'],reconnection:false,timeout:4000});
    const timer=setTimeout(()=>{socket.close();reject(new Error('socket connect timeout'));},4000);
    socket.on('connect',()=>{clearTimeout(timer);resolve(socket);});
    socket.on('connect_error',error=>{clearTimeout(timer);socket.close();reject(error);});
  });
}

function joinBranch(socket,branch){
  return new Promise(resolve=>socket.emit('join:branch',String(branch),resolve));
}

function waitEvent(socket,event,timeout=2500){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`timed out waiting for ${event}`)),timeout);
    socket.once(event,payload=>{clearTimeout(timer);resolve(payload);});
  });
}

function expectNoEvent(socket,event,timeout=450){
  return new Promise((resolve,reject)=>{
    const handler=payload=>{clearTimeout(timer);reject(new Error(`unexpected ${event}: ${JSON.stringify(payload)}`));};
    const timer=setTimeout(()=>{socket.off(event,handler);resolve();},timeout);
    socket.once(event,handler);
  });
}

function kathmanduToday(){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kathmandu',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const value=type=>parts.find(part=>part.type===type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

describe('Phase 2C waste management',()=>{
  it('records every required category as exactly one valued canonical ledger event with structured evidence',async()=>{
    assert.deepEqual(WASTE_CATEGORY_TYPES,[
      'expired','spoiled','damaged','burned','spilled','wrong_preparation','customer_return','other'
    ]);
    for(const [index,category] of WASTE_CATEGORY_TYPES.entries()){
      const response=await postWaste({
        reason:category,
        qty:10,
        notes:`Shift evidence ${category}`,
        key:`waste-category-${index}`
      });
      assert.equal(response.status,201,response.body?.message);
      assert.equal(response.body.type,'WASTE');
      assert.equal(response.body.wasteCategory,category);
      assert.equal(response.body.wasteNotes,`Shift evidence ${category}`);
      assert.equal(response.body.changeQty,-10);
      assert.ok(Math.abs(response.body.totalCost-0.45)<1e-9);
      assert.equal(response.body.referenceType,'waste');
      assert.equal(String(response.body.user),String(world.staffA._id));
    }

    const rows=await InventoryTransaction.find({branch:world.branchA._id,type:'WASTE'}).sort({createdAt:1});
    assert.equal(rows.length,8);
    assert.deepEqual(rows.map(row=>row.wasteCategory),WASTE_CATEGORY_TYPES);
    assert.ok(Math.abs(rows.reduce((sum,row)=>sum+row.totalCost,0)-3.6)<1e-9);
    assert.equal((await InventoryBalance.findOne({branch:world.branchA._id,ingredient:world.ingredient._id})).quantity,19920);

    const history=await request(`/api/waste/events?branch=${world.branchA._id}`,{token:tokenFor(world.staffA)});
    assert.equal(history.status,200,history.body?.message);
    assert.equal(history.body.items.length,8);
    assert.equal(history.body.summary.eventCount,8);
    assert.equal(history.body.summary.totalQuantity,80);
    assert.equal(history.body.summary.totalValue,3.6);
    assert.deepEqual(history.body.summary.categories.map(row=>row.category),WASTE_CATEGORY_TYPES);
    assert.ok(history.body.summary.categories.every(row=>row.eventCount===1&&row.value===0.45));
    assert.ok(history.body.items.every(row=>row.ledgerTransactionId&&row.actor.name===world.staffA.name));
  });

  it('binds idempotency to the complete waste payload and never removes stock twice',async()=>{
    const input={qty:125,reason:'spilled',notes:'Container tipped at prep station',key:'waste-exactly-once'};
    const attempts=await Promise.all([postWaste(input),postWaste(input)]);
    assert.deepEqual(attempts.map(response=>response.status).sort(),[200,201],attempts.map(response=>response.body?.message).join(' | '));
    const [first,replay]=attempts[0].status===201?attempts:[attempts[1],attempts[0]];
    assert.equal(replay.body._id,first.body._id);
    const laterReplay=await postWaste(input);
    assert.equal(laterReplay.status,200,laterReplay.body?.message);
    assert.equal(laterReplay.body._id,first.body._id);
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey:input.key}),1);
    assert.equal((await InventoryBalance.findOne({branch:world.branchA._id,ingredient:world.ingredient._id})).quantity,19875);

    const changedCategory=await postWaste({...input,reason:'damaged'});
    assert.equal(changedCategory.status,409,changedCategory.body?.message);
    const changedNotes=await postWaste({...input,notes:'Different incident'});
    assert.equal(changedNotes.status,409,changedNotes.body?.message);
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey:input.key}),1);
  });

  it('is lot-aware, values from canonical inventory cost, and returns exact batch audit evidence',async()=>{
    const lot=await InventoryBatch.findOne({branch:world.branchA._id,ingredient:world.ingredient._id,quantity:{$gt:0}});
    const beforeLot=lot.quantity;
    const response=await postWaste({
      qty:500,
      reason:'expired',
      notes:'Expiry verified during opening check',
      batchId:lot._id,
      key:'waste-exact-lot'
    });
    assert.equal(response.status,201,response.body?.message);
    assert.equal(response.body.totalCost,22.5);
    assert.equal(String(response.body.wasteBatch),String(lot._id));
    assert.equal(response.body.batchMovements.length,1);
    assert.equal(String(response.body.batchMovements[0].batch),String(lot._id));
    assert.equal(response.body.batchMovements[0].changeQty,-500);
    assert.equal((await InventoryBatch.findById(lot._id)).quantity,beforeLot-500);

    const history=await request(`/api/waste/events?branch=${world.branchA._id}&category=expired`,{token:tokenFor(world.manager)});
    assert.equal(history.status,200,history.body?.message);
    assert.equal(history.body.items.length,1);
    assert.equal(history.body.items[0].category,'expired');
    assert.equal(history.body.items[0].notes,'Expiry verified during opening check');
    assert.equal(String(history.body.items[0].selectedBatch._id),String(lot._id));
    assert.equal(String(history.body.items[0].batches[0].batchId),String(lot._id));
    assert.equal(history.body.items[0].value,22.5);
    assert.equal(history.body.summary.categories.find(row=>row.category==='expired').value,22.5);
  });

  it('rolls back overdraws and rejects invalid input without a ledger, aggregate, or lot side effect',async()=>{
    const balanceBefore=await InventoryBalance.findOne({branch:world.branchA._id,ingredient:world.ingredient._id}).lean();
    const lotsBefore=await InventoryBatch.find({branch:world.branchA._id,ingredient:world.ingredient._id}).lean();
    const rejected=await postWaste({qty:25000,key:'waste-overdraw'});
    assert.equal(rejected.status,409,rejected.body?.message);
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey:'waste-overdraw'}),0);
    assert.equal((await InventoryBalance.findById(balanceBefore._id)).quantity,balanceBefore.quantity);
    assert.deepEqual(
      (await InventoryBatch.find({branch:world.branchA._id,ingredient:world.ingredient._id}).sort({_id:1}).lean()).map(row=>[String(row._id),row.quantity]),
      lotsBefore.sort((a,b)=>String(a._id).localeCompare(String(b._id))).map(row=>[String(row._id),row.quantity])
    );

    const missingKey=await request('/api/waste/record',{
      method:'POST',token:tokenFor(world.staffA),body:{branch:String(world.branchA._id),ingredient:String(world.ingredient._id),qty:1,reason:'other'}
    });
    assert.equal(missingKey.status,400);
    assert.equal((await postWaste({reason:'not_a_category',key:'invalid-category'})).status,400);
    assert.equal((await postWaste({notes:'x'.repeat(2001),key:'invalid-notes'})).status,400);
    assert.equal(await InventoryTransaction.countDocuments({type:'WASTE'}),0);
  });

  it('enforces authentication, role, branch, and restaurant boundaries for recording and review',async()=>{
    const payload={branch:String(world.branchA._id),ingredient:String(world.ingredient._id),qty:1,reason:'other'};
    assert.equal((await request('/api/waste/record',{method:'POST',headers:{'Idempotency-Key':'missing-auth'},body:payload})).status,401);
    assert.equal((await postWaste({user:world.staffA,branch:world.branchB._id,key:'staff-cross-branch'})).status,403);
    assert.equal((await request(`/api/waste/events?branch=${world.branchB._id}`,{token:tokenFor(world.staffA)})).status,403);

    const guest=jwt.sign({id:world.owner._id,name:'Guest',role:'guest'},process.env.JWT_SECRET, {expiresIn: '1h'});
    assert.equal((await request('/api/waste/record',{method:'POST',token:guest,headers:{'Idempotency-Key':'guest-waste'},body:payload})).status,403);
    assert.equal((await request(`/api/waste/events?branch=${world.branchA._id}`,{token:guest})).status,403);

    const otherRestaurant=await Restaurant.create({name:'Other Restaurant'});
    const otherBranch=await Branch.create({restaurant:otherRestaurant._id,name:'Other Branch',code:'OTH'});
    const otherUser=await User.create({name:'Other Owner',email:'other-waste@test.com',password:'hashed',role:'owner',restaurant:'Other Restaurant',restaurantId:otherRestaurant._id});
    const otherIngredient=await Ingredient.create({restaurant:otherRestaurant._id,code:'OTHER-W',name:'Other Rice',unit:'g'});
    assert.equal((await postWaste({user:otherUser,branch:world.branchA._id,ingredient:world.ingredient._id,key:'tenant-cross-in'})).status,403);
    assert.equal((await postWaste({user:world.owner,branch:otherBranch._id,ingredient:otherIngredient._id,key:'tenant-cross-out'})).status,403);
    assert.equal((await request(`/api/waste/events?branch=${world.branchA._id}`,{token:tokenFor(otherUser)})).status,403);

    const ownerBranchB=await postWaste({user:world.owner,branch:world.branchB._id,reason:'customer_return',key:'owner-branch-b'});
    assert.equal(ownerBranchB.status,201,ownerBranchB.body?.message);
    const branchAHistory=await request(`/api/waste/events?branch=${world.branchA._id}`,{token:tokenFor(world.owner)});
    assert.equal(branchAHistory.status,200);
    assert.equal(branchAHistory.body.items.length,0);
  });

  it('supports category and Kathmandu date filtering while preserving all-category summary facets',async()=>{
    await postWaste({reason:'burned',qty:20,key:'waste-filter-burned'});
    await postWaste({reason:'spoiled',qty:30,key:'waste-filter-spoiled'});
    const today=kathmanduToday();
    const filtered=await request(`/api/waste/events?branch=${world.branchA._id}&category=burned&from=${today}&to=${today}`,{token:tokenFor(world.owner)});
    assert.equal(filtered.status,200,filtered.body?.message);
    assert.equal(filtered.body.items.length,1);
    assert.equal(filtered.body.items[0].category,'burned');
    assert.equal(filtered.body.pagination.total,1);
    assert.equal(filtered.body.summary.eventCount,2);
    assert.equal(filtered.body.summary.categories.find(row=>row.category==='burned').eventCount,1);
    assert.equal(filtered.body.summary.categories.find(row=>row.category==='spoiled').eventCount,1);

    assert.equal((await request(`/api/waste/events?branch=${world.branchA._id}&category=invalid`,{token:tokenFor(world.owner)})).status,400);
    assert.equal((await request(`/api/waste/events?branch=${world.branchA._id}&from=2026-02-30`,{token:tokenFor(world.owner)})).status,400);
    assert.equal((await request(`/api/waste/events?branch=${world.branchA._id}&from=2026-08-20&to=2026-08-19`,{token:tokenFor(world.owner)})).status,400);
  });

  it('requires structured waste evidence at the ledger boundary and publishes only to the authorized branch room',async()=>{
    const session=await mongoose.startSession();
    try{
      await assert.rejects(session.withTransaction(()=>moveStock({
        branch:world.branchA._id,
        ingredient:world.ingredient._id,
        qty:-1,
        unit:'g',
        type:'WASTE',
        reason:'Missing structured category',
        referenceType:'test',
        referenceId:new mongoose.Types.ObjectId(),
        user:world.owner._id,
        idempotencyKey:'waste-missing-structure'
      },session)),/structured category/i);
    }finally{
      await session.endSession();
    }
    assert.equal(await InventoryTransaction.countDocuments({idempotencyKey:'waste-missing-structure'}),0);

    const legacyId=new mongoose.Types.ObjectId();
    await InventoryTransaction.collection.insertOne({
      _id:legacyId,
      branch:world.branchA._id,
      ingredient:world.ingredient._id,
      type:'WASTE',
      previousQty:100,
      changeQty:-5,
      newQty:95,
      unit:'g',
      unitCost:0.045,
      totalCost:0.225,
      reason:'Waste: wrong_preparation — Garnish error',
      user:world.owner._id,
      createdAt:new Date()
    });
    await ensureInventoryLedgerIndexes();
    const migrated=await InventoryTransaction.findById(legacyId).lean();
    assert.equal(migrated.wasteCategory,'wrong_preparation');
    assert.equal(migrated.wasteNotes,'Garnish error');
    assert.equal(migrated.idempotencyHashVersion,1);

    const branchASocket=await connectSocket(tokenFor(world.staffA),world.branchA._id);
    const branchBSocket=await connectSocket(tokenFor(world.owner),world.branchB._id);
    try{
      assert.equal((await joinBranch(branchASocket,world.branchA._id)).ok,true);
      assert.equal((await joinBranch(branchBSocket,world.branchB._id)).ok,true);
      const received=waitEvent(branchASocket,'inventory:update');
      const isolated=expectNoEvent(branchBSocket,'inventory:update');
      const response=await postWaste({reason:'damaged',key:'waste-realtime'});
      assert.equal(response.status,201,response.body?.message);
      const event=await received;
      assert.equal(String(event.branch),String(world.branchA._id));
      assert.equal(event.reason,'waste');
      assert.equal(event.category,'damaged');
      assert.equal(event.transactionId,response.body._id);
      await isolated;
    }finally{
      branchASocket.close();
      branchBSocket.close();
    }
  });
});
