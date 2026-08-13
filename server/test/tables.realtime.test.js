import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {io as clientIo} from 'socket.io-client';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let baseUrl;

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

function createOrder(table = world.table, branch = world.branchA) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(world.owner),
    body: {
      branch: String(branch._id),
      type: 'dine-in',
      table: String(table._id),
      items: [{menuItem: String(world.menu._id), qty: 1, notes: 'live floor'}]
    }
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
});

describe('socket table floor events', () => {
  it('emits table:update on occupy only to the order’s branch room', async () => {
    const socketA = await connectSocket(tokenFor(world.staffA), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    await joinBranch(socketA, world.branchA._id);
    await joinBranch(socketB, world.branchB._id);

    const leaked = [];
    socketB.on('table:update', payload => leaked.push(payload));
    const pending = waitEvent(socketA, 'table:update');
    const created = await createOrder();
    assert.equal(created.status, 201, created.body?.message);
    const payload = await pending;
    assert.equal(payload.reason, 'occupy');
    assert.equal(String(payload.branch), String(world.branchA._id));
    assert.equal(payload.tableIds.includes(String(world.table._id)), true);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(leaked.length, 0);
    socketA.close();
    socketB.close();
  });

  it('emits table:update when a host changes table status', async () => {
    const socket = await connectSocket(tokenFor(world.manager), world.branchA._id);
    await joinBranch(socket, world.branchA._id);
    const pending = waitEvent(socket, 'table:update');
    const res = await request('/api/tables/' + world.table._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'reserved'}
    });
    assert.equal(res.status, 200, res.body?.message);
    const payload = await pending;
    assert.equal(payload.reason, 'status');
    assert.equal(payload.tableIds.includes(String(world.table._id)), true);
    socket.close();
  });

  it('emits table:update when a seated order is cancelled', async () => {
    const created = await createOrder();
    assert.equal(created.status, 201, created.body?.message);
    const socket = await connectSocket(tokenFor(world.staffA), world.branchA._id);
    await joinBranch(socket, world.branchA._id);
    const pending = waitEvent(socket, 'table:update');
    const cancelled = await request('/api/orders/' + created.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.manager),
      body: {status: 'cancelled'}
    });
    assert.equal(cancelled.status, 200, cancelled.body?.message);
    const payload = await pending;
    assert.equal(payload.reason, 'release');
    assert.equal(payload.orderStatus, 'cancelled');
    socket.close();
  });

  it('emits table:update when a check is paid in full', async () => {
    const created = await createOrder();
    assert.equal(created.status, 201, created.body?.message);
    const socket = await connectSocket(tokenFor(world.staffA), world.branchA._id);
    await joinBranch(socket, world.branchA._id);
    const pending = waitEvent(socket, 'table:update');
    const paid = await request('/api/orders/' + created.body._id + '/payments', {
      method: 'POST',
      token: tokenFor(world.staffA),
      body: {amount: created.body.total, method: 'cash'}
    });
    assert.equal(paid.status, 201, paid.body?.message);
    const payload = await pending;
    assert.equal(payload.reason, 'payment');
    socket.close();
  });

  it('stops table events after leave:branch', async () => {
    const socket = await connectSocket(tokenFor(world.owner), world.branchA._id);
    try {
      await joinBranch(socket, world.branchA._id);
      const left = await leaveBranch(socket, world.branchA._id);
      assert.equal(left.ok, true, left.message);
      const missed = [];
      socket.on('table:update', payload => missed.push(payload));
      const created = await createOrder();
      assert.equal(created.status, 201, created.body?.message);
      await new Promise(r => setTimeout(r, 250));
      assert.equal(missed.length, 0);
    } finally {
      socket.close();
    }
  });
});
