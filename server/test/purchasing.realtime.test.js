import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {io as clientIo} from 'socket.io-client';
import {Supplier} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
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
      socket.close();
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

async function expectNoEvent(socket, action, event = 'purchasing:update', duration = 150) {
  const received = [];
  const listener = payload => received.push(payload);
  socket.on(event, listener);
  try {
    const result = await action();
    await new Promise(resolve => setTimeout(resolve, duration));
    assert.equal(received.length, 0, `expected no ${event} event`);
    return result;
  } finally {
    socket.off(event, listener);
  }
}

function assertEventEnvelope(payload, branch = world.branchA._id) {
  assert.equal(payload.schemaVersion, 1);
  assert.match(payload.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(Number.isNaN(Date.parse(payload.occurredAt)), false);
  assert.equal(String(payload.branch), String(branch));
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

function createDraftPo({idempotencyKey, branch = world.branchA._id, user = world.manager} = {}) {
  return request('/api/purchase-orders', {
    method: 'POST',
    token: tokenFor(user),
    ...(idempotencyKey ? {headers: {'Idempotency-Key': idempotencyKey}} : {}),
    body: {
      branch: String(branch),
      supplier: String(supplier._id),
      items: [{ingredient: String(world.ingredient._id), orderedQty: 400, unit: 'g', unitPrice: 0.05}],
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
  it('rejects cross-tenant and unassigned branches during the socket handshake', async () => {
    const foreignRestaurant = await Restaurant.create({name: 'Foreign Restaurant'});
    const foreignBranch = await Branch.create({restaurant: foreignRestaurant._id, name: 'Foreign Branch', code: 'FRN'});

    await assert.rejects(
      connectSocket(tokenFor(world.owner), foreignBranch._id),
      /Branch does not belong to the user restaurant/
    );
    await assert.rejects(
      connectSocket(tokenFor(world.manager), world.branchB._id),
      /Branch access denied/
    );
    // Phase 17: the handshake now resolves the principal against storage, so a
    // forged role-escalation token is refused with the specific reason rather
    // than a generic 'Authentication required'. Still rejected, and the
    // message is strictly more informative to an operator reading logs.
    await assert.rejects(
      connectSocket(tokenFor(world.staffA, {role: 'owner'}), world.branchA._id),
      /User permissions changed; sign in again/
    );
  });

  it('does not subscribe a validated socket until an explicit join is acknowledged', async () => {
    const socket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    try {
      const created = await expectNoEvent(socket, () => createDraftPo());
      assert.equal(created.status, 201, created.body?.message);
      assert.equal((await joinBranch(socket, world.branchA._id)).ok, true);
      const pending = waitEvent(socket, 'purchasing:update');
      const next = await createDraftPo();
      assert.equal(next.status, 201, next.body?.message);
      assert.equal((await pending).poId, String(next.body._id));
    } finally {
      socket.close();
    }
  });

  it('acknowledges joins, rejects unauthorized switches, and atomically switches owner rooms', async () => {
    const managerSocket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const ownerSocket = await connectSocket(tokenFor(world.owner), world.branchA._id);
    try {
      const joined = await joinBranch(managerSocket, world.branchA._id);
      assert.equal(joined.ok, true, joined.message);
      assert.equal(joined.branch, String(world.branchA._id));
      const denied = await joinBranch(managerSocket, world.branchB._id);
      assert.equal(denied.ok, false);
      assert.match(denied.message, /Branch access denied/);

      assert.equal((await joinBranch(ownerSocket, world.branchA._id)).ok, true);
      const switched = await joinBranch(ownerSocket, world.branchB._id);
      assert.equal(switched.ok, true, switched.message);
      assert.equal(switched.branch, String(world.branchB._id));

      const branchAEvents = [];
      ownerSocket.on('purchasing:update', event => branchAEvents.push(event));
      const managerBranchAEvent = waitEvent(managerSocket, 'purchasing:update');
      const createdA = await createDraftPo();
      assert.equal(createdA.status, 201, createdA.body?.message);
      assert.equal((await managerBranchAEvent).poId, String(createdA.body._id), 'denied switch must preserve the authorized room');
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(branchAEvents.length, 0, 'successful switch must leave the previous branch');

      const branchBEvent = waitEvent(ownerSocket, 'purchasing:update');
      const createdB = await createDraftPo({branch: world.branchB._id, user: world.owner});
      assert.equal(createdB.status, 201, createdB.body?.message);
      const payload = await branchBEvent;
      assert.equal(payload.reason, 'po_create');
      assertEventEnvelope(payload, world.branchB._id);
    } finally {
      managerSocket.close();
      ownerSocket.close();
    }
  });

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
      assertEventEnvelope(payload);
      assert.equal(payload.poId, String(created.body._id));
      await new Promise(r => setTimeout(r, 200));
      assert.equal(leaked.length, 0);
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('emits po_update after an optimistic draft edit', async () => {
    const created = await createDraftPo();
    assert.equal(created.status, 201, created.body?.message);
    const socket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    try {
      assert.equal((await joinBranch(socket, world.branchA._id)).ok, true);
      const pending = waitEvent(socket, 'purchasing:update');
      const updated = await request('/api/purchase-orders/' + created.body._id, {
        method: 'PATCH',
        token: tokenFor(world.manager),
        body: {
          supplier: String(supplier._id),
          items: [{ingredient: String(world.ingredient._id), orderedQty: 500, unit: 'g', unitPrice: 0.05}],
          notes: 'Realtime edit',
          expectedVersion: created.body.__v
        }
      });
      assert.equal(updated.status, 200, updated.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'po_update');
      assert.equal(payload.poId, String(created.body._id));
      assertEventEnvelope(payload);
    } finally {
      socket.close();
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
        body: {items: [{itemId: String(line._id), receivedQty: 100, damagedQty: 10, damageReason: 'transport_damage'}]}
      });
      assert.equal(rec.status, 201, rec.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'receive');
      assert.equal(payload.status, 'partially_received');
      assertEventEnvelope(payload);

      const replay = await expectNoEvent(socket, () => request('/api/purchase-orders/' + created.body._id + '/receive', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'live-gr'},
        body: {items: [{itemId: String(line._id), receivedQty: 100, damagedQty: 10, damageReason: 'transport_damage'}]}
      }));
      assert.equal(replay.status, 200, replay.body?.message);
      assert.equal(replay.body.duplicate, true);
    } finally {
      socket.close();
    }
  });

  it('emits a branch-scoped return update with durable return evidence', async () => {
    const created = await createDraftPo();
    const approved = await approvePo(created.body._id);
    assert.equal(approved.status, 200, approved.body?.message);
    const line = approved.body.items[0];
    const rec = await request('/api/purchase-orders/' + created.body._id + '/receive', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'live-return-gr'},
      body: {
        expectedVersion: approved.body.__v,
        items: [{itemId: String(line._id), receivedQty: 100, damagedQty: 0, batchNumber: 'LIVE-RETURN'}]
      }
    });
    assert.equal(rec.status, 201, rec.body?.message);
    const options = await request('/api/purchase-orders/' + created.body._id + '/return-options', {token: tokenFor(world.manager)});
    assert.equal(options.status, 200, options.body?.message);
    const batch = options.body.items[0].batches[0];

    const socketA = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    try {
      await joinBranch(socketA, world.branchA._id);
      await joinBranch(socketB, world.branchB._id);
      const leaked = [];
      socketB.on('purchasing:update', payload => leaked.push(payload));
      const pending = waitEvent(socketA, 'purchasing:update');
      const returned = await request('/api/purchase-orders/' + created.body._id + '/returns', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'live-return-pr'},
        body: {
          expectedVersion: rec.body.purchaseOrder.__v,
          reason: 'quality',
          items: [{itemId: String(line._id), batchId: String(batch.batchId), qty: 10}]
        }
      });
      assert.equal(returned.status, 201, returned.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'return');
      assert.equal(payload.poId, String(created.body._id));
      assert.equal(payload.returnId, String(returned.body.purchaseReturn._id));
      assert.equal(payload.returnNo, returned.body.purchaseReturn.returnNo);
      assertEventEnvelope(payload);

      const replay = await expectNoEvent(socketA, () => request('/api/purchase-orders/' + created.body._id + '/returns', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'live-return-pr'},
        body: {
          expectedVersion: rec.body.purchaseOrder.__v,
          reason: 'quality',
          items: [{itemId: String(line._id), batchId: String(batch.batchId), qty: 10}]
        }
      }));
      assert.equal(replay.status, 200, replay.body?.message);
      assert.equal(replay.body.duplicate, true);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(leaked.length, 0);
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('emits a branch-scoped short-close update after partial receiving', async () => {
    const created = await createDraftPo();
    const approved = await approvePo(created.body._id);
    assert.equal(approved.status, 200, approved.body?.message);
    const line = approved.body.items[0];
    const rec = await request('/api/purchase-orders/' + created.body._id + '/receive', {
      method: 'POST',
      token: tokenFor(world.manager),
      headers: {'Idempotency-Key': 'live-short-gr'},
      body: {items: [{itemId: String(line._id), receivedQty: 100, damagedQty: 0}]}
    });
    assert.equal(rec.status, 201, rec.body?.message);

    const socketA = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    try {
      await joinBranch(socketA, world.branchA._id);
      await joinBranch(socketB, world.branchB._id);
      const leaked = [];
      socketB.on('purchasing:update', payload => leaked.push(payload));
      const pending = waitEvent(socketA, 'purchasing:update');
      const closed = await request('/api/purchase-orders/' + created.body._id + '/close-short', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'live-short-close'},
        body: {
          reason: 'Supplier cancelled the remainder',
          expectedVersion: rec.body.purchaseOrder.__v
        }
      });
      assert.equal(closed.status, 200, closed.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'po_short_close');
      assert.equal(payload.status, 'closed_short');
      assert.equal(payload.poId, String(created.body._id));
      assertEventEnvelope(payload);

      const replay = await expectNoEvent(socketA, () => request('/api/purchase-orders/' + created.body._id + '/close-short', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'live-short-close'},
        body: {
          reason: 'Supplier cancelled the remainder',
          expectedVersion: rec.body.purchaseOrder.__v
        }
      }));
      assert.equal(replay.status, 200, replay.body?.message);
      assert.equal(replay.body.status, 'closed_short');
      await new Promise(r => setTimeout(r, 100));
      assert.equal(leaked.length, 0);
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('publishes invoice and payment changes only to persisted management roles without replay duplicates', async () => {
    const socket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    const staffSocket = await connectSocket(tokenFor(world.staffA), world.branchA._id);
    const staffEvents = [];
    staffSocket.on('purchasing:update', event => staffEvents.push(event));
    try {
      assert.equal((await joinBranch(socket, world.branchA._id)).ok, true);
      assert.equal((await joinBranch(staffSocket, world.branchA._id)).ok, true);
      const invoiceBody = {
        branch: String(world.branchA._id),
        supplier: String(supplier._id),
        invoiceNo: 'INV-LIVE',
        subtotal: 1000,
        vat: 130,
        total: 1130
      };
      const createdEvt = waitEvent(socket, 'purchasing:update');
      const inv = await request('/api/supplier-invoices', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'legacy-invoice-purchasing.realtime.test-1'},
        body: invoiceBody
      });
      assert.equal(inv.status, 201, inv.body?.message);
      const created = await createdEvt;
      assert.equal(created.reason, 'invoice_create');
      assert.equal(created.invoiceId, String(inv.body._id));
      assertEventEnvelope(created);

      const invoiceReplay = await expectNoEvent(socket, () => request('/api/supplier-invoices', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'legacy-invoice-purchasing.realtime.test-1'},
        body: invoiceBody
      }));
      assert.equal(invoiceReplay.status, 200, invoiceReplay.body?.message);
      assert.equal(invoiceReplay.body.duplicate, true);

      const updateEvt = waitEvent(socket, 'purchasing:update');
      const updated = await request('/api/supplier-invoices/' + inv.body._id, {
        method: 'PATCH',
        token: tokenFor(world.manager),
        body: {notes: 'Realtime verified', expectedVersion: inv.body.__v}
      });
      assert.equal(updated.status, 200, updated.body?.message);
      const updatePayload = await updateEvt;
      assert.equal(updatePayload.reason, 'invoice_update');
      assert.equal(updatePayload.invoiceId, String(inv.body._id));
      assertEventEnvelope(updatePayload);

      const paidEvt = waitEvent(socket, 'purchasing:update');
      const paid = await request('/api/supplier-invoices/' + inv.body._id + '/payments', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'legacy-payment-realtime-1'},
        body: {amount: 130, method: 'cash'}
      });
      assert.equal(paid.status, 201, paid.body?.message);
      const payload = await paidEvt;
      assert.equal(payload.reason, 'invoice_pay');
      assert.equal(payload.status, 'partial');
      assert.equal(payload.paymentNo, paid.body.payment.paymentNo);
      assertEventEnvelope(payload);

      const paidReplay = await expectNoEvent(socket, () => request('/api/supplier-invoices/' + inv.body._id + '/payments', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'legacy-payment-realtime-1'},
        body: {amount: 130, method: 'cash'}
      }));
      assert.equal(paidReplay.status, 200, paidReplay.body?.message);
      assert.equal(paidReplay.body.duplicate, true);

      const reversalEvt = waitEvent(socket, 'purchasing:update');
      const reversed = await request('/api/supplier-payments/' + paid.body.payment._id + '/reverse', {
        method: 'POST',
        token: tokenFor(world.owner),
        headers: {'Idempotency-Key': 'payment-reversal-realtime-1'},
        body: {reason: 'Wrong supplier payment'}
      });
      assert.equal(reversed.status, 201, reversed.body?.message);
      const reversalPayload = await reversalEvt;
      assert.equal(reversalPayload.reason, 'invoice_payment_reverse');
      assert.equal(reversalPayload.status, 'unpaid');
      assert.equal(reversalPayload.paymentNo, paid.body.payment.paymentNo);
      assertEventEnvelope(reversalPayload);

      const reversalReplay = await expectNoEvent(socket, () => request('/api/supplier-payments/' + paid.body.payment._id + '/reverse', {
        method: 'POST',
        token: tokenFor(world.owner),
        headers: {'Idempotency-Key': 'payment-reversal-realtime-1'},
        body: {reason: 'Wrong supplier payment'}
      }));
      assert.equal(reversalReplay.status, 200, reversalReplay.body?.message);
      assert.equal(reversalReplay.body.duplicate, true);

      const secondCreatedEvt = waitEvent(socket, 'purchasing:update');
      const secondInvoice = await request('/api/supplier-invoices', {
        method: 'POST',
        token: tokenFor(world.manager),
        headers: {'Idempotency-Key': 'invoice-void-realtime-1'},
        body: {...invoiceBody, invoiceNo: 'INV-LIVE-VOID'}
      });
      assert.equal(secondInvoice.status, 201, secondInvoice.body?.message);
      assert.equal((await secondCreatedEvt).reason, 'invoice_create');

      const voidEvt = waitEvent(socket, 'purchasing:update');
      const voided = await request('/api/supplier-invoices/' + secondInvoice.body._id, {
        method: 'PATCH',
        token: tokenFor(world.manager),
        body: {status: 'void', expectedVersion: secondInvoice.body.__v}
      });
      assert.equal(voided.status, 200, voided.body?.message);
      const voidPayload = await voidEvt;
      assert.equal(voidPayload.reason, 'invoice_void');
      assert.equal(voidPayload.status, 'void');
      assertEventEnvelope(voidPayload);

      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(staffEvents.length, 0, 'stored staff role must not receive management finance events');
    } finally {
      socket.close();
      staffSocket.close();
    }
  });

  it('publishes restaurant supplier-master and catalog changes through each branch purchasing room', async () => {
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
      assertEventEnvelope(payloadA, world.branchA._id);
      assert.equal(payloadB.reason, 'catalog_create');
      assertEventEnvelope(payloadB, world.branchB._id);
      assert.notEqual(payloadA.eventId, payloadB.eventId, 'each room publication must have its own delivery identity');

      const updateA = waitEvent(socketA, 'purchasing:update');
      const updateB = waitEvent(socketB, 'purchasing:update');
      const updated = await request('/api/supplier-catalog/' + created.body._id, {
        method: 'PATCH',
        token: tokenFor(world.manager),
        body: {currentPrice: 55, reason: 'Live market update', expectedVersion: created.body.__v}
      });
      assert.equal(updated.status, 200, updated.body?.message);
      const [updatedA, updatedB] = await Promise.all([updateA, updateB]);
      assert.equal(updatedA.reason, 'catalog_update');
      assert.equal(updatedA.catalogItemId, String(created.body._id));
      assertEventEnvelope(updatedA, world.branchA._id);
      assert.equal(updatedB.reason, 'catalog_update');
      assertEventEnvelope(updatedB, world.branchB._id);

      const supplierCreateA = waitEvent(socketA, 'purchasing:update');
      const supplierCreateB = waitEvent(socketB, 'purchasing:update');
      const supplierCreated = await request('/api/suppliers', {
        method: 'POST',
        token: tokenFor(world.manager),
        body: {name: 'Live Produce Vendor', paymentTerms: 'Net 15'}
      });
      assert.equal(supplierCreated.status, 201, supplierCreated.body?.message);
      const [supplierPayloadA, supplierPayloadB] = await Promise.all([supplierCreateA, supplierCreateB]);
      assert.equal(supplierPayloadA.reason, 'catalog_supplier_create');
      assert.equal(supplierPayloadA.supplierId, supplierCreated.body._id);
      assertEventEnvelope(supplierPayloadA, world.branchA._id);
      assert.equal(supplierPayloadB.reason, 'catalog_supplier_create');
      assertEventEnvelope(supplierPayloadB, world.branchB._id);

      const supplierUpdateA = waitEvent(socketA, 'purchasing:update');
      const supplierUpdateB = waitEvent(socketB, 'purchasing:update');
      const supplierUpdated = await request(`/api/suppliers/${supplierCreated.body._id}`, {
        method: 'PATCH',
        token: tokenFor(world.manager),
        body: {expectedVersion: supplierCreated.body.__v, active: false, reason: 'Vendor contract paused'}
      });
      assert.equal(supplierUpdated.status, 200, supplierUpdated.body?.message);
      const [supplierUpdatedA, supplierUpdatedB] = await Promise.all([supplierUpdateA, supplierUpdateB]);
      assert.equal(supplierUpdatedA.reason, 'catalog_supplier_update');
      assert.equal(supplierUpdatedA.supplierId, supplierCreated.body._id);
      assertEventEnvelope(supplierUpdatedA, world.branchA._id);
      assert.equal(supplierUpdatedB.reason, 'catalog_supplier_update');
      assertEventEnvelope(supplierUpdatedB, world.branchB._id);
    } finally {
      socketA.close();
      socketB.close();
    }
  });

  it('recovers purchasing delivery after reconnect and an acknowledged rejoin', async () => {
    const first = await connectSocket(tokenFor(world.manager), world.branchA._id);
    assert.equal((await joinBranch(first, world.branchA._id)).ok, true);
    first.close();

    const reconnected = await connectSocket(tokenFor(world.manager), world.branchA._id);
    try {
      const joined = await joinBranch(reconnected, world.branchA._id);
      assert.equal(joined.ok, true, joined.message);
      const pending = waitEvent(reconnected, 'purchasing:update');
      const created = await createDraftPo();
      assert.equal(created.status, 201, created.body?.message);
      const payload = await pending;
      assert.equal(payload.reason, 'po_create');
      assert.equal(payload.poId, String(created.body._id));
      assertEventEnvelope(payload);
    } finally {
      reconnected.close();
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
