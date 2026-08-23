import {randomUUID} from 'node:crypto';
import {Server} from 'socket.io';
import jwt from 'jsonwebtoken';
import {verifyAccessToken} from '../middleware/auth.js';
import mongoose from 'mongoose';
import {purchaseBranchContext} from './purchaseOrders.js';
import {Order} from '../models/operations.js';
import {resolveCorsOptions} from './deployment.js';
import {
  CONTROL_EVENTS, REALTIME_EVENTS, envelope, nextSequence, recordForReplay, replaySince
} from './realtimeEvents.js';

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

/**
 * A private room per USER, joined by every authenticated socket regardless of
 * role.
 *
 * Needed because a notification addressed to one person previously went out on
 * the RESTAURANT room with a `user` field for the client to filter on. That
 * delivered the payload to every staff socket in the tenant (client-side
 * filtering is not an authorisation boundary) and, worse, never reached a
 * rider at all — riders deliberately do not join the restaurant room. A
 * dedicated per-user room fixes both directions at once.
 *
 * Distinct from `riderRoom` on purpose: `rider:<id>` carries delivery
 * dispatch, `user:<id>` carries anything addressed to that person whatever
 * their role.
 */
export const userRoom = id => 'user:' + String(id);

/**
 * Phase 22 — restaurant and role rooms.
 *
 * `restaurant:<id>` carries tenant-wide signals that are not tied to one
 * branch. `role:<restaurant>:<role>` is deliberately NAMESPACED BY TENANT: a
 * bare `role:manager` would put every manager of every restaurant in one room,
 * which is precisely the cross-tenant leak the rest of the system works to
 * prevent. The brief writes `role:<role>`; scoping it is the only way to
 * honour that safely.
 *
 * A rider joins neither. They are the least-privileged principal and get only
 * their private room.
 */
export const restaurantRoom = id => 'restaurant:' + String(id);
export const roleRoom = (restaurantId, role) => `role:${String(restaurantId)}:${String(role)}`;

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
      // Phase 25: the same verification rules as the HTTP guard -- pinned
      // algorithm and a mandatory `exp`. The handshake previously called a
      // bare `jwt.verify`, so a token with no expiry could hold a socket open
      // indefinitely; confirmed by probe (CONNECTED).
      const payload = verifyAccessToken(token);
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
      socket.data = {
        ...(socket.data || {}),
        principalRole: principal.baseRole,
        restaurantId: principal.restaurantId || null
      };

      // A requested initial branch is fully tenant-checked during the handshake.
      // Clients still join explicitly and reload after the join acknowledgement so
      // mutations that happen during connection setup cannot be missed.
      // A rider is not a branch participant: they join only their own private
      // room, and any branch they ask for is ignored rather than honoured.
      // Everybody, every role, joins their own private room. It is keyed by
      // the RESOLVED principal id, not a token claim.
      await socket.join(userRoom(payload.id));

      if (principal.baseRole === 'rider') {
        await socket.join(riderRoom(payload.id));
        socket.data = {...(socket.data || {}), rider: true};
        return next();
      }

      /**
       * Phase 22 — tenant and role rooms.
       *
       * Joined from the RESOLVED principal, never from the token claim, so a
       * forged `restaurantId` or `role` cannot place a socket in another
       * tenant's room. Riders are excluded above: they hold only their own
       * private room.
       */
      if (principal.restaurantId) {
        await socket.join(restaurantRoom(principal.restaurantId));
        await socket.join(roleRoom(principal.restaurantId, principal.baseRole));
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
        // Hand back the room's current sequence so a client knows its starting
        // point and can ask for a replay after a later reconnect.
        const {sequence} = replaySince(branchRoom(joined), Number.POSITIVE_INFINITY);
        cb?.({ok: true, branch: joined, sequence});
      } catch (error) {
        cb?.({ok: false, status: error.status || 400, message: error.message});
      }
    });

    /**
     * Phase 22 — reconnect recovery.
     *
     * Socket.IO reconnects transparently, but events published while the
     * client was away are simply gone: rooms hold no history. The client sends
     * the last sequence it processed and receives everything newer.
     *
     * Authorisation is re-checked here, not assumed from the earlier join: a
     * socket must not be able to replay a branch it has since lost access to.
     * When the gap is larger than the buffer the client is told `truncated`
     * and must reload — a partial history it cannot distinguish from a
     * complete one would be worse than none.
     */
    socket.on('replay:since', async ({branch, sequence} = {}, cb) => {
      try {
        if (!branch) throw socketError('Branch is required');
        if (!mongoose.isValidObjectId(branch)) throw socketError('Invalid branch');
        const room = branchRoom(branch);
        if (!socket.rooms.has(room)) throw socketError('Socket is not joined to that branch', 403);
        // Re-verify against storage, exactly as joinBranch does.
        await purchaseBranchContext({user: socket.user, branchId: branch, allowInactive: true});
        const result = replaySince(room, sequence);
        cb?.({
          ok: true,
          branch: String(branch),
          sequence: result.sequence,
          truncated: result.truncated,
          // Belt and braces. `replaySince()` already returns an empty list
          // when it truncates, so this ternary is currently redundant --
          // confirmed by mutation testing, where removing it changed nothing.
          // It is kept so the invariant "truncated implies no events" holds at
          // the boundary even if the buffer's contract is ever loosened.
          events: result.truncated ? [] : result.events
        });
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

/**
 * Phase 22 — the single emit path.
 *
 * Every business event goes through here so that all of them get the same
 * treatment: a standard envelope with a deduplication id, a per-room sequence
 * number, and a copy in the room's replay buffer for reconnecting clients.
 * Before this, only `purchasing:update` had any of that.
 *
 * Publishing never throws into the caller. The business transaction is already
 * committed by the time an event is emitted; turning a notification failure
 * into a failed HTTP response would be strictly worse than a missed event.
 */
export function emitRoomEvent(room, event, payload = {}, {idempotencyKey, branch, restaurant, replay = true} = {}) {
  if (!io || !room) return null;
  try {
    const sequence = nextSequence(room);
    const message = envelope(event, payload, {branch, restaurant, idempotencyKey, sequence});
    if (replay) recordForReplay(room, message);
    io.to(room).emit(event, message);
    return message;
  } catch (error) {
    console.error('realtime publish failed', {event, room, message: error.message});
    return null;
  }
}

export function emitKitchenEvent(branchId, event, payload, options = {}) {
  if (!io || !branchId) return false;
  return Boolean(emitRoomEvent(branchRoom(branchId), event, payload, {...options, branch: branchId}));
}

/** Emits only after revalidating the room, for branch-sensitive kitchen data. */
export async function emitKitchenEventChecked(branchId, event, payload, options = {}) {
  if (!io || !branchId) return false;
  await evictStaleBranchSockets(branchId);
  return emitKitchenEvent(branchId, event, payload, options);
}

export function publishTableEvent(branchId, extra = {}, {idempotencyKey} = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, REALTIME_EVENTS.TABLE_UPDATE, extra, {idempotencyKey});
}

export function publishPurchasingEvent(branchId, extra = {}, {audience = 'branch', idempotencyKey} = {}) {
  if (!io || !branchId) return false;
  const id = String(branchId);
  const room = audience === 'management' ? purchasingManagementRoom(id) : branchRoom(id);
  return Boolean(emitRoomEvent(room, REALTIME_EVENTS.PURCHASING_UPDATE, extra, {
    branch: id, idempotencyKey
  }));
}

/**
 * Delivery updates go to the branch (dispatchers) and, when the delivery is
 * assigned, to that one rider's private room. A rider is never given a branch
 * room, so this is the only channel by which they can be reached.
 */
export function publishDeliveryEvent(branchId, extra = {}, {riderId, idempotencyKey} = {}) {
  if (!io || !branchId) return false;
  // The rider copy reuses the SAME eventId, so a dispatcher who is also the
  // assigned rider (or a client in both rooms) deduplicates it rather than
  // processing the delivery twice.
  const sent = emitRoomEvent(branchRoom(branchId), REALTIME_EVENTS.DELIVERY_UPDATE, extra, {
    branch: branchId, idempotencyKey
  });
  if (riderId && sent) {
    emitRoomEvent(riderRoom(riderId), REALTIME_EVENTS.DELIVERY_UPDATE, extra, {
      branch: branchId, idempotencyKey: sent.eventId
    });
  }
  return Boolean(sent);
}

export function publishInventoryEvent(branchId, extra = {}, {idempotencyKey} = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, REALTIME_EVENTS.INVENTORY_UPDATE, extra, {idempotencyKey});
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
export function publishInventoryAlert(branchId, alert = {}, {idempotencyKey} = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, REALTIME_EVENTS.INVENTORY_ALERT, alert, {idempotencyKey});
}

export async function publishKitchenOrder(order, event, extra = {}, {idempotencyKey} = {}) {
  try {
    if (!order?._id) return;
    const full = await Order.findById(order._id).populate('table', 'name area seats status').populate('customer', 'name phone');
    if (!full) return;
    // Goes through emitKitchenEventChecked -> emitKitchenEvent -> emitRoomEvent,
    // so kitchen events now carry the same envelope as everything else. They
    // previously arrived bare, which is why a reconnecting KDS could not tell
    // a redelivered ticket from a new one.
    await emitKitchenEventChecked(full.branch, event, {order: full.toJSON(), ...extra}, {idempotencyKey});
  } catch (error) {
    console.error('kitchen realtime publish failed', error.message);
  }
}

/**
 * Phase 22 — payment:update.
 *
 * MISSING BEFORE THIS PHASE. Verified against the running server: taking a
 * payment emitted nothing at all, so a second till or a manager's dashboard
 * had no idea an order had been settled until it refreshed. Money moving is
 * the single most important thing to broadcast.
 *
 * The amount and method are included; no card or transaction detail beyond the
 * reference the receipt already shows, because a branch room is a broad
 * audience.
 */
export function publishPaymentEvent(branchId, extra = {}, {idempotencyKey} = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, REALTIME_EVENTS.PAYMENT_UPDATE, extra, {idempotencyKey});
}

/**
 * Phase 22 — order:update.
 *
 * Also missing. `kitchen:*` covers the kitchen lifecycle, but an order can
 * change in ways the kitchen does not care about — a discount applied, an
 * order reopened, a bill split, a refund posted — and nothing announced those.
 * This is the general "this order changed" channel; kitchen events stay
 * separate so a KDS is not woken by a billing edit.
 */
export function publishOrderEvent(branchId, extra = {}, {idempotencyKey} = {}) {
  if (!branchId) return false;
  return emitKitchenEvent(branchId, REALTIME_EVENTS.ORDER_UPDATE, extra, {idempotencyKey});
}

/** Tenant-wide signal, for anything not scoped to a single branch. */
export function publishRestaurantEvent(restaurantId, event, extra = {}, {idempotencyKey} = {}) {
  if (!io || !restaurantId) return false;
  return Boolean(emitRoomEvent(restaurantRoom(restaurantId), event, extra, {
    restaurant: restaurantId, idempotencyKey
  }));
}

/**
 * Signal every holder of a role within ONE restaurant.
 *
 * The room is tenant-namespaced, so this cannot reach another restaurant's
 * managers even if the caller passes only a role name.
 */
export function publishRoleEvent(restaurantId, role, event, extra = {}, {idempotencyKey} = {}) {
  if (!io || !restaurantId || !role) return false;
  return Boolean(emitRoomEvent(roleRoom(restaurantId, role), event, extra, {
    restaurant: restaurantId, idempotencyKey
  }));
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
 * Push-based socket authorisation refresh.
 *
 * SCOPE — SINGLE INSTANCE ONLY, stated plainly because it matters.
 *
 * `io.fetchSockets()` and `io.sockets.sockets` see only the connections held
 * by THIS process. There is no Redis, no Socket.IO adapter and no pub/sub in
 * this repository, so a role change served by instance A cannot reach a socket
 * held by instance B. Running more than one API process therefore leaves that
 * socket with its old rooms until it reconnects or the branch it sits in next
 * publishes an event, at which point `evictStaleBranchSockets()` revalidates
 * it lazily.
 *
 * No fake distributed guarantee is implied. Closing this properly needs a
 * shared adapter (`@socket.io/redis-adapter` or the Mongo equivalent), which
 * is infrastructure this deployment does not have. What IS implemented is the
 * strongest safe single-instance behaviour: an immediate push on the instance
 * that served the write, plus the pre-existing lazy revalidation on delivery
 * that covers every instance.
 *
 * HTTP authorisation is unaffected either way — it resolves from the database
 * on every request, so a stale socket can never grant an action, only receive
 * events it should no longer see.
 */

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
      // Demoted to rider: they keep their own private room, having lost the
      // branch rooms above.
      socket.join(userRoom(userId));
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
