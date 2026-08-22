import {randomUUID} from 'node:crypto';
import {Server} from 'socket.io';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import {purchaseBranchContext} from './purchaseOrders.js';
import {Order} from '../models/operations.js';
import {resolveCorsOptions} from './deployment.js';

const SOCKET_ROLES = ['owner', 'manager', 'staff', 'rider'];
const MANAGEMENT_ROLES = new Set(['owner', 'manager']);
export const branchRoom = id => 'branch:' + String(id);
export const purchasingManagementRoom = id => `${branchRoom(id)}:purchasing-management`;
/**
 * Riders get a private room keyed by their user id, never a branch room.
 * Branch rooms carry kitchen tickets and inventory movements, which a delivery
 * rider has no business receiving.
 */
export const riderRoom = id => 'rider:' + String(id);

let io = null;

function socketError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readToken(socket) {
  const auth = socket.handshake.auth || {};
  if (auth.token) return auth.token;
  const header = socket.handshake.headers?.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  if (socket.handshake.query?.token) return String(socket.handshake.query.token);
  return null;
}

function leaveBranchRooms(socket, branchId) {
  if (!branchId) return;
  socket.leave(branchRoom(branchId));
  socket.leave(purchasingManagementRoom(branchId));
}

export async function joinBranch(socket, branchId) {
  // Defence in depth: even if a rider socket asks to join a branch room, it is
  // refused here as well as during the handshake.
  if (socket.user?.role === 'rider') throw socketError('Riders cannot join a branch room', 403);
  if (!branchId) throw socketError('Branch is required');
  if (!mongoose.isValidObjectId(branchId)) throw socketError('Invalid branch');

  // Resolve the stored user/restaurant/branch assignment on every room change. A
  // valid but stale JWT must not authorize a room after an assignment or role change.
  const context = await purchaseBranchContext({user: socket.user, branchId, allowInactive: true});
  for (const room of [...socket.rooms]) {
    if (String(room).startsWith('branch:')) socket.leave(room);
  }

  const id = String(context.branch._id);
  await socket.join(branchRoom(id));
  if (MANAGEMENT_ROLES.has(context.role)) await socket.join(purchasingManagementRoom(id));
  socket.data.branchId = id;
  socket.data.role = context.role;
  return id;
}

export function leaveBranch(socket, branchId) {
  const current = socket.data?.branchId;
  const requested = branchId ? String(branchId) : current;
  if (!requested) throw socketError('Branch is required');
  if (!mongoose.isValidObjectId(requested)) throw socketError('Invalid branch');
  if (current && requested !== String(current)) throw socketError('Socket is not joined to that branch', 409);

  leaveBranchRooms(socket, requested);
  if (current === requested) {
    socket.data.branchId = null;
    socket.data.role = null;
  }
  return requested;
}

export function attachRealtime(httpServer, {corsOrigin} = {}) {
  io = new Server(httpServer, {
    // Socket.IO does its own CORS check, so it must use the same resolved
    // policy as Express — otherwise a rejected HTTP origin could still open a
    // websocket. credentials stays false: auth is a Bearer token in the
    // handshake, never a cookie.
    cors: {
      origin: corsOrigin ?? resolveCorsOptions().origin,
      credentials: false
    }
  });

  io.use(async (socket, next) => {
    try {
      const token = readToken(socket);
      if (!token) return next(new Error('Authentication required'));
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      if (!SOCKET_ROLES.includes(payload.role)) return next(new Error('Insufficient permission'));

      /**
       * Phase 17: the handshake now resolves the principal against STORAGE,
       * exactly as the HTTP guard does. Previously it trusted the JWT, so a
       * deactivated or demoted user — or one whose sessions had been revoked
       * — could still open a websocket and sit in a branch room until the
       * token expired. The role used from here on is the stored one.
       */
      const {resolvePrincipal} = await import('./accessControl.js');
      const principal = await resolvePrincipal(payload);
      socket.user = {...payload, role: principal.baseRole, branch: principal.branch};
      socket.data = {...(socket.data || {}), principalRole: principal.baseRole};

      // A requested initial branch is fully tenant-checked during the handshake.
      // Clients still join explicitly and reload after the join acknowledgement so
      // mutations that happen during connection setup cannot be missed.
      // A rider is not a branch participant: they join only their own private
      // room, and any branch they ask for is ignored rather than honoured.
      if (principal.baseRole === 'rider') {
        await socket.join(riderRoom(payload.id));
        socket.data = {...(socket.data || {}), rider: true};
        return next();
      }

      const requested = socket.handshake.auth?.branch;
      if (requested) await purchaseBranchContext({user: socket.user, branchId: requested, allowInactive: true});
      next();
    } catch (error) {
      const message = error?.status === 401
        ? (error.message || 'Authentication required')
        : error?.status === 403
        ? (error.message || 'Branch access denied')
        : error?.status === 400
          ? (error.message || 'Invalid branch')
          : 'Authentication required';
      next(new Error(message));
    }
  });

  io.on('connection', socket => {
    socket.on('join:branch', async (branchId, cb) => {
      try {
        const joined = await joinBranch(socket, branchId);
        cb?.({ok: true, branch: joined});
      } catch (error) {
        cb?.({ok: false, status: error.status || 400, message: error.message});
      }
    });
    socket.on('leave:branch', (branchId, cb) => {
      try {
        const left = leaveBranch(socket, branchId);
        cb?.({ok: true, branch: left});
      } catch (error) {
        cb?.({ok: false, status: error.status || 400, message: error.message});
      }
    });
  });

  return io;
}

/**
 * Re-checks every socket currently in a branch room against the stored user
 * assignment, evicting any whose access has since been revoked.
 *
 * Room membership is decided at join time, but a JWT outlives a reassignment:
 * a cook moved to another branch keeps a live socket in the old room and would
 * otherwise keep receiving that branch's tickets until they reconnect. This
 * closes that window at the moment of delivery.
 */
export async function evictStaleBranchSockets(branchId) {
  if (!io || !branchId) return 0;
  const id = String(branchId);
  let evicted = 0;
  let sockets = [];
  try {
    sockets = await io.in(branchRoom(id)).fetchSockets();
  } catch {
    return 0;
  }
  for (const socket of sockets) {
    try {
      await purchaseBranchContext({user: socket.user, branchId: id, allowInactive: true});
    } catch {
      socket.leave(branchRoom(id));
      socket.leave(purchasingManagementRoom(id));
      if (socket.data) {
        socket.data.branchId = null;
        socket.data.role = null;
      }
      socket.emit('branch:revoked', {branch: id, reason: 'Branch access revoked'});
      evicted += 1;
    }
  }
  return evicted;
}

export function emitKitchenEvent(branchId, event, payload) {
  if (!io || !branchId) return false;
  io.to(branchRoom(branchId)).emit(event, payload);
  return true;
}

/** Emits only after revalidating the room, for branch-sensitive kitchen data. */
export async function emitKitchenEventChecked(branchId, event, payload) {
  if (!io || !branchId) return false;
  await evictStaleBranchSockets(branchId);
  return emitKitchenEvent(branchId, event, payload);
}

export function publishTableEvent(branchId, extra = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, 'table:update', {
    ...extra,
    branch: String(branchId)
  });
}

export function publishPurchasingEvent(branchId, extra = {}, {audience = 'branch'} = {}) {
  if (!io || !branchId) return false;
  const id = String(branchId);
  const room = audience === 'management' ? purchasingManagementRoom(id) : branchRoom(id);
  try {
    io.to(room).emit('purchasing:update', {
      ...extra,
      schemaVersion: 1,
      eventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      branch: id
    });
    return true;
  } catch (error) {
    // The business transaction is already committed. Notification failure must
    // never turn a successful mutation into a retryable HTTP failure.
    console.error('purchasing realtime publish failed', error.message);
    return false;
  }
}

/**
 * Delivery updates go to the branch (dispatchers) and, when the delivery is
 * assigned, to that one rider's private room. A rider is never given a branch
 * room, so this is the only channel by which they can be reached.
 */
export function publishDeliveryEvent(branchId, extra = {}, {riderId} = {}) {
  if (!io || !branchId) return false;
  const payload = {...extra, branch: String(branchId)};
  io.to(branchRoom(branchId)).emit('delivery:update', payload);
  if (riderId) io.to(riderRoom(riderId)).emit('delivery:update', payload);
  return true;
}

export function publishInventoryEvent(branchId, extra = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, 'inventory:update', {
    ...extra,
    branch: String(branchId)
  });
}

/**
 * Phase 17 — push an inventory alert to the branch in realtime.
 *
 * Alerts were persisted as Notifications and only ever seen when someone
 * refreshed the alert list. Verified against the running API: driving stock
 * below the reorder level wrote a `low_stock` notification but emitted only a
 * generic `inventory:update`, carrying nothing about the alert itself, so a
 * manager watching the screen learned nothing.
 */
export function publishInventoryAlert(branchId, alert = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, 'inventory:alert', {
    ...alert,
    branch: String(branchId),
    at: new Date().toISOString()
  });
}

export async function publishKitchenOrder(order, event, extra = {}) {
  try {
    if (!order?._id) return;
    const full = await Order.findById(order._id).populate('table', 'name area seats status').populate('customer', 'name phone');
    if (!full) return;
    await emitKitchenEventChecked(full.branch, event, {order: full.toJSON(), ...extra});
  } catch (error) {
    console.error('kitchen realtime publish failed', error.message);
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

/**
 * Phase 17 — push-based socket authorisation refresh.
 *
 * `evictStaleBranchSockets()` above is LAZY: it revalidates a branch room only
 * when something is emitted to it, so a downgraded user kept their room until
 * the next event happened to be published. These two functions close that
 * window at the moment of the change, driven by the write that caused it.
 *
 * Everything here re-derives authority from STORAGE. Nothing trusts the role
 * in `socket.user`, which came from a JWT that may predate the change.
 */

/** Every live socket belonging to one user. */
async function socketsForUser(userId) {
  if (!io || !userId) return [];
  const id = String(userId);
  try {
    const all = await io.fetchSockets();
    return all.filter(socket => String(socket.user?.id || '') === id);
  } catch {
    return [];
  }
}

/**
 * Re-authorise a user's live sockets after a role, permission or branch change.
 *
 * Each socket is re-checked against the database. A socket that may no longer
 * be in its branch room is removed from it and told why; a socket whose
 * management standing changed gains or loses the purchasing-management room.
 * The socket stays CONNECTED — the person is still employed — but it now holds
 * exactly the rooms their current access allows.
 */
export async function refreshUserSockets(userId, reason = 'role_changed') {
  const sockets = await socketsForUser(userId);
  if (!sockets.length) return 0;

  const {resolvePrincipal} = await import('./accessControl.js');
  let changed = 0;

  for (const socket of sockets) {
    let principal = null;
    try {
      principal = await resolvePrincipal({id: userId, role: socket.user?.role, sv: socket.user?.sv});
    } catch {
      // The session is no longer valid at all (deactivated, demoted, role
      // withdrawn, sessions revoked). Nothing to refresh — end it.
      socket.emit('session:revoked', {reason});
      socket.disconnect(true);
      changed += 1;
      continue;
    }

    // A principal whose base role changed to rider must lose every branch room:
    // branch rooms carry kitchen tickets and stock movements.
    if (principal.baseRole === 'rider') {
      for (const room of [...socket.rooms]) {
        if (String(room).startsWith('branch:')) socket.leave(room);
      }
      socket.data = {...(socket.data || {}), branchId: null, role: 'rider', rider: true};
      socket.join(riderRoom(userId));
      socket.emit('branch:revoked', {reason: 'Role changed', branch: null});
      changed += 1;
      continue;
    }

    const current = socket.data?.branchId;
    if (!current) continue;

    let allowed = false;
    try {
      await purchaseBranchContext({user: {id: userId, role: principal.baseRole}, branchId: current, allowInactive: true});
      allowed = true;
    } catch {
      allowed = false;
    }

    if (!allowed) {
      socket.leave(branchRoom(current));
      socket.leave(purchasingManagementRoom(current));
      socket.data.branchId = null;
      socket.data.role = null;
      socket.emit('branch:revoked', {branch: String(current), reason: 'Branch access revoked'});
      changed += 1;
      continue;
    }

    // Still entitled to the branch, but management standing may have moved.
    const isManagement = MANAGEMENT_ROLES.has(principal.baseRole);
    const room = purchasingManagementRoom(current);
    const inRoom = socket.rooms.has(room);
    if (isManagement && !inRoom) {
      await socket.join(room);
      changed += 1;
    } else if (!isManagement && inRoom) {
      socket.leave(room);
      changed += 1;
    }
    socket.data.role = principal.baseRole;
    // Tell the client its permissions moved so it can re-render its nav. The
    // client is not trusted with this; it is a courtesy, and every event and
    // endpoint remains independently guarded.
    socket.emit('permissions:changed', {reason});
  }
  return changed;
}

/**
 * Hard-disconnect every socket for a user — deactivation, or an explicit
 * session revocation. Their token is already dead for HTTP; leaving a live
 * websocket streaming branch traffic would be exactly the hole this closes.
 */
export function disconnectUserSockets(userId, reason = 'revoked') {
  if (!io || !userId) return 0;
  const id = String(userId);
  let count = 0;
  // Synchronous local iteration: this runs inside a revocation path that must
  // not await a cluster round-trip before reporting success.
  for (const socket of io.sockets.sockets.values()) {
    if (String(socket.user?.id || '') !== id) continue;
    try {
      socket.emit('session:revoked', {reason});
      socket.disconnect(true);
      count += 1;
    } catch { /* already gone */ }
  }
  return count;
}
