import {Server} from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {assertBranchAccess} from './kitchen.js';
import {Branch, Order} from '../models/operations.js';

const KITCHEN_ROLES = ['owner', 'manager', 'staff'];
export const branchRoom = id => 'branch:' + String(id);

let io = null;

function readToken(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token;
  const header = socket.handshake.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (socket.handshake.query?.token) return String(socket.handshake.query.token);
  return null;
}

export async function joinBranch(socket, branchId) {
  if (!branchId) {
    const err = new Error('Branch is required');
    err.status = 400;
    throw err;
  }
  if (!mongoose.isValidObjectId(branchId)) {
    const err = new Error('Invalid branch');
    err.status = 400;
    throw err;
  }
  assertBranchAccess(socket.user, branchId);
  const branch = await Branch.findById(branchId);
  if (!branch) {
    const err = new Error('Branch not found');
    err.status = 404;
    throw err;
  }
  for (const room of [...socket.rooms]) {
    if (String(room).startsWith('branch:')) socket.leave(room);
  }
  await socket.join(branchRoom(branchId));
  socket.data.branchId = String(branchId);
  return String(branchId);
}

export function leaveBranch(socket, branchId) {
  const current = branchId || socket.data?.branchId;
  if (!current) {
    const err = new Error('Branch is required');
    err.status = 400;
    throw err;
  }
  socket.leave(branchRoom(current));
  if (socket.data.branchId && String(socket.data.branchId) === String(current)) socket.data.branchId = null;
  return String(current);
}

export function attachRealtime(httpServer, {corsOrigin} = {}) {
  io = new Server(httpServer, {
    cors: {
      origin: corsOrigin ?? (process.env.CLIENT_URL?.split(',') || true),
      credentials: true
    }
  });

  io.use((socket, next) => {
    try {
      const token = readToken(socket);
      if (!token) return next(new Error('Authentication required'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (!KITCHEN_ROLES.includes(payload.role)) return next(new Error('Insufficient permission'));
      socket.user = payload;
      const requested = socket.handshake.auth?.branch;
      if (requested) {
        try {
          assertBranchAccess(payload, requested);
        } catch (e) {
          return next(new Error(e.message || 'Branch access denied'));
        }
      }
      next();
    } catch {
      next(new Error('Authentication required'));
    }
  });

  io.on('connection', socket => {
    const initial = socket.handshake.auth?.branch;
    if (initial) joinBranch(socket, initial).catch(() => {});
    socket.on('join:branch', async (branchId, cb) => {
      try {
        const joined = await joinBranch(socket, branchId);
        cb?.({ok: true, branch: joined});
      } catch (e) {
        cb?.({ok: false, status: e.status || 400, message: e.message});
      }
    });
    socket.on('leave:branch', (branchId, cb) => {
      try {
        const left = leaveBranch(socket, branchId);
        cb?.({ok: true, branch: left});
      } catch (e) {
        cb?.({ok: false, status: e.status || 400, message: e.message});
      }
    });
  });

  return io;
}

export function emitKitchenEvent(branchId, event, payload) {
  if (!io || !branchId) return;
  io.to(branchRoom(branchId)).emit(event, payload);
}

export function publishTableEvent(branchId, extra = {}) {
  if (!branchId) return;
  emitKitchenEvent(branchId, 'table:update', {
    branch: String(branchId),
    ...extra
  });
}

export function publishPurchasingEvent(branchId, extra = {}) {
  if (!branchId) return;
  emitKitchenEvent(branchId, 'purchasing:update', {
    branch: String(branchId),
    ...extra
  });
}

export async function publishKitchenOrder(order, event, extra = {}) {
  try {
    if (!order?._id) return;
    const full = await Order.findById(order._id).populate('table', 'name area seats status').populate('customer', 'name phone');
    if (!full) return;
    emitKitchenEvent(full.branch, event, {order: full.toJSON(), ...extra});
  } catch (e) {
    console.error('kitchen realtime publish failed', e.message);
  }
}

export function getIo() {
  return io;
}

export async function closeRealtime() {
  if (!io) return;
  await new Promise(resolve => io.close(resolve));
  io = null;
}
