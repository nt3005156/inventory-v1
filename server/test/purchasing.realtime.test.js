import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {io as clientIo} from 'socket.io-client';
import {Supplier} from '../src/models/index.js';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let baseUrl;
let supplier;

function connectSocket(token, branch) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(baseUrl, {
      auth: {token, ...(branch ? {branch} : {})},
      transports: ['websocket'],
      reconnection: false,
      timeout: 4000
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('socket connect timeout'));
    }, 4000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitEvent(socket, event, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for ' + event)), timeout);
    socket.once(event, payload => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function joinBranch(socket, branchId) {
  return new Promise((resolve, reject) => {
    socket.emit('join:branch', branchId, ack => {
      if (!ack) return reject(new Error('no join ack'));
      resolve(ack);
    });
  });
}

function leaveBranch(socket, branchId) {
  return new Promise((resolve, reject) => {
    socket.emit('leave:branch', branchId, ack => {
      if (!ack) return reject(new Error('no leave ack'));
      resolve(ack);
    });
  });
}

function createDraftPo() {
  return request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(world.manager),
    body: {
      branch: String(world.branchA._id),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty: 400, unit: 'g', unitPrice: 0.05}],
      total: 20
    }
  });
}

async function approvePo(poId) {
  const pending = await request('/api/purchase-orders/' + poId + '/status', {
    method: 'PATCH',
    token: tokenFor(world.manager),
    body: {status: 'pending'}
  });
  if (pending.status !== 200) return pending;
  return request('/api/purchase-orders/' + poId + '/status', {
    method: 'PATCH',
    token: tokenFor(world.owner),
    body: {status: 'approved'}
  });
}

before(async () => {
  ({baseUrl} = await startTestApp());
});

after(async () => {
  await stopTestApp();
});

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  supplier = await Supplier.create({restaurant: world.restaurant._id, name: 'Live Mill', contact: '9800111222'});
});

describe('socket purchasing events', () => {
  it('emits purchasing:update on PO create only to that branch', async () => {
    const socketA = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    try {
      await joinBranch(socketA, world.branchA._id);
      await joinBranch(socketB, world.branchB._id);
      const leaked = [];
      socketB.on('purchasing:update', payload => leaked.push(payload));
      const pending = waitEvent(socketA, 'purchasing:update');
      const created = await createDraftPo();
      assert.equal(created.status, 201, created.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'po_create');
      assert.equal(String(payload.branch), String(world.branchA._id));
      assert.equal(payload.poId, String(created.body._id));
      await new Promise(r => setTimeout(r, 200));
      assert.equal(leaked.length, 0);
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('emits po_status when a draft is submitted and approved', async () => {
    const created = await createDraftPo();
    assert.equal(created.status, 201, created.body?.message);
    const socket = await connectSocket(tokenFor(world.owner), world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const pendingEvt = waitEvent(socket, 'purchasing:update');
      const pending = await request('/api/purchase-orders/' + created.body._id + '/status', {
        method: 'PATCH',
        token: tokenFor(world.manager),
        body: {status: 'pending'}
      });
      assert.equal(pending.status, 200, pending.body?.message);
      const first = await pendingEvt;
      assert.equal(first.reason, 'po_status');
      assert.equal(first.status, 'pending');

      const approvedEvt = waitEvent(socket, 'purchasing:update');
      const approved = await request('/api/purchase-orders/' + created.body._id + '/status', {
        method: 'PATCH',
        token: tokenFor(world.owner),
        body: {status: 'approved'}
      });
      assert.equal(approved.status, 200, approved.body?.message);
      const second = await approvedEvt;
      assert.equal(second.reason, 'po_status');
      assert.equal(second.status, 'approved');
      assert.equal(second.poId, String(created.body._id));
    } finally {
      socket.close();
    }
  });

  it('emits receive after an approved PO is posted', async () => {
    const created = await createDraftPo();
    const approved = await approvePo(created.body._id);
    assert.equal(approved.status, 200, approved.body?.message);
    const line = approved.body.items[0];
    const socket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const pending = waitEvent(socket, 'purchasing:update');
      const rec = await request('/api/purchase-orders/' + created.body._id + '/receive', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'live-gr'},
        body: {items: [{itemId: String(line._id), receivedQty: 100, damagedQty: 10}]}
      });
      assert.equal(rec.status, 201, rec.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'receive');
      assert.equal(payload.status, 'partially_received');
    } finally {
      socket.close();
    }
  });

  it('emits invoice_create and invoice_pay on the supplier invoice path', async () => {
    const socket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const createdEvt = waitEvent(socket, 'purchasing:update');
      const inv = await request('/api/supplier-invoices', {
        method: 'POST',
        token: tokenFor(world.manager),
        body: {
          branch: String(world.branchA._id),
          supplier: String(supplier._id),
          invoiceNo: 'INV-LIVE',
          subtotal: 1000,
          vat: 130,
          total: 1130
        }
      });
      assert.equal(inv.status, 201, inv.body?.message);
      const created = await createdEvt;
      assert.equal(created.reason, 'invoice_create');
      assert.equal(created.invoiceId, String(inv.body._id));

      const paidEvt = waitEvent(socket, 'purchasing:update');
      const paid = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
        method: 'POST',
        token: tokenFor(world.manager),
        body: {amount: 130, method: 'cash'}
      });
      assert.equal(paid.status, 201, paid.body?.message);
      const payload = await paidEvt;
      assert.equal(payload.reason, 'invoice_pay');
      assert.equal(payload.status, 'partial');
    } finally {
      socket.close();
    }
  });

  it('publishes restaurant catalog changes through each branch purchasing room', async () => {
    const socketA = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    try {
      await joinBranch(socketA, world.branchA._id);
      await joinBranch(socketB, world.branchB._id);
      const eventA = waitEvent(socketA, 'purchasing:update');
      const eventB = waitEvent(socketB, 'purchasing:update');
      const created = await request('/api/supplier-catalog', {
        method: 'POST',
        token: tokenFor(world.manager),
        body: {
          supplier: String(supplier._id),
          ingredient: String(world.ingredient._id),
          supplierSku: 'LIVE-RICE',
          purchaseUnit: 'kg',
          conversionFactor: 1000,
          currentPrice: 50,
          minOrderQty: 1,
          leadDays: 1,
          reason: 'Live supplier quote'
        }
      });
      assert.equal(created.status, 201, created.body?.message);
      const [payloadA, payloadB] = await Promise.all([eventA, eventB]);
      assert.equal(payloadA.reason, 'catalog_create');
      assert.equal(payloadA.catalogItemId, String(created.body._id));
      assert.equal(String(payloadA.branch), String(world.branchA._id));
      assert.equal(payloadB.reason, 'catalog_create');
      assert.equal(String(payloadB.branch), String(world.branchB._id));
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('stops purchasing events after leave:branch', async () => {
    const socket = await connectSocket(tokenFor(world.owner), world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const left = await leaveBranch(socket, world.branchA._id);
      assert.equal(left.ok, true, left.message);
      const missed = [];
      socket.on('purchasing:update', payload => missed.push(payload));
      const created = await createDraftPo();
      assert.equal(created.status, 201, created.body?.message);
      await new Promise(r => setTimeout(r, 250));
      assert.equal(missed.length, 0);
    } finally {
      socket.close();
    }
  });
});
