import {describe, it, before, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import {io as clientIo} from 'socket.io-client';
import {startTestApp, stopTestApp, clearDb, request, seedWorld, tokenFor} from './helpers.js';

let world;
let baseUrl;

function connectSocket(token, branch, extra = {}) {
  return new Promise((resolve, reject) => {
    const socket = clientIo(baseUrl, {
      auth: {token, ...(branch ? {branch} : {}), ...extra.auth},
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

async function createOrder(branch, user = world.owner) {
  return request('/api/orders', {
    method: 'POST',
    token: tokenFor(user),
    body: {
      branch: String(branch._id),
      type: 'counter',
      items: [{menuItem: String(world.menu._id), qty: 1, notes: 'live ticket'}]
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

describe('socket authentication', () => {
  it('rejects a missing token', async () => {
    await assert.rejects(() => connectSocket(undefined, world.branchA._id), err => {
      assert.match(err.message, /Authentication required/i);
      return true;
    });
  });

  it('rejects an invalid token', async () => {
    await assert.rejects(() => connectSocket('not-a-jwt', world.branchA._id), err => {
      assert.match(err.message, /Authentication required/i);
      return true;
    });
  });

  it('rejects an unauthorized role', async () => {
    const guest = jwt.sign({id: world.owner._id, name: 'Guest', role: 'guest'}, process.env.JWT_SECRET);
    await assert.rejects(() => connectSocket(guest, world.branchA._id), err => {
      assert.match(err.message, /Insufficient permission/i);
      return true;
    });
  });

  it('rejects staff connecting directly to another branch room', async () => {
    await assert.rejects(
      () => connectSocket(tokenFor(world.staffA), world.branchB._id),
      err => {
        assert.match(err.message, /Branch access denied/i);
        return true;
      }
    );
  });
});

describe('socket branch rooms', () => {
  it('lets assigned staff join their branch and blocks the other branch', async () => {
    const socket = await connectSocket(tokenFor(world.staffA));
    const ok = await joinBranch(socket, world.branchA._id);
    assert.equal(ok.ok, true);
    const denied = await joinBranch(socket, world.branchB._id);
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    socket.close();
  });

  it('lets an owner join either branch', async () => {
    const socket = await connectSocket(tokenFor(world.owner));
    assert.equal((await joinBranch(socket, world.branchA._id)).ok, true);
    assert.equal((await joinBranch(socket, world.branchB._id)).ok, true);
    socket.close();
  });
});

describe('socket kitchen events and isolation', () => {
  it('emits kitchen:new-order only to the order’s branch room', async () => {
    const socketA = await connectSocket(tokenFor(world.staffA), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    await joinBranch(socketA, world.branchA._id);
    await joinBranch(socketB, world.branchB._id);

    const leaked = [];
    socketB.on('kitchen:new-order', payload => leaked.push(payload));
    const pending = waitEvent(socketA, 'kitchen:new-order');
    const created = await createOrder(world.branchA);
    assert.equal(created.status, 201, created.body?.message);
    const payload = await pending;
    assert.equal(payload.order.orderNo, created.body.orderNo);
    assert.equal(payload.order.status, 'pending');
    assert.equal(String(payload.order.branch), String(world.branchA._id));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(leaked.length, 0);
    socketA.close();
    socketB.close();
  });

  it('emits kitchen:status only to the order’s branch room', async () => {
    const created = await createOrder(world.branchA);
    assert.equal(created.status, 201, created.body?.message);

    const socketA = await connectSocket(tokenFor(world.staffA), world.branchA._id);
    const socketB = await connectSocket(tokenFor(world.staffB), world.branchB._id);
    await joinBranch(socketA, world.branchA._id);
    await joinBranch(socketB, world.branchB._id);

    const leaked = [];
    socketB.on('kitchen:status', payload => leaked.push(payload));
    const pending = waitEvent(socketA, 'kitchen:status');
    const patched = await request('/api/orders/' + created.body._id + '/status', {
      method: 'PATCH',
      token: tokenFor(world.staffA),
      body: {status: 'accepted'}
    });
    assert.equal(patched.status, 200, patched.body?.message);
    const payload = await pending;
    assert.equal(payload.order.status, 'accepted');
    assert.equal(payload.previousStatus, 'pending');
    assert.equal(String(payload.order._id), String(created.body._id));
    await new Promise(r => setTimeout(r, 200));
    assert.equal(leaked.length, 0);
    socketA.close();
    socketB.close();
  });

  it('does not deliver events after leaving a branch room', async () => {
    const socket = await connectSocket(tokenFor(world.owner), world.branchA._id);
    await joinBranch(socket, world.branchA._id);
    const missed = [];
    socket.on('kitchen:new-order', payload => missed.push(payload));
    await joinBranch(socket, world.branchB._id);
    const created = await createOrder(world.branchA);
    assert.equal(created.status, 201, created.body?.message);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(missed.length, 0);
    socket.close();
  });

  it('receives events again after reconnecting and rejoining the branch', async () => {
    const token = tokenFor(world.staffA);
    let socket = await connectSocket(token, world.branchA._id);
    await joinBranch(socket, world.branchA._id);
    socket.close();
    await new Promise(r => setTimeout(r, 50));

    socket = await connectSocket(token, world.branchA._id);
    await joinBranch(socket, world.branchA._id);
    const pending = waitEvent(socket, 'kitchen:new-order');
    const created = await createOrder(world.branchA);
    assert.equal(created.status, 201, created.body?.message);
    const payload = await pending;
    assert.equal(payload.order.orderNo, created.body.orderNo);
    socket.close();
  });
});
