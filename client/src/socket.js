import {io} from 'socket.io-client';

export function socketOrigin() {
  const configured = import.meta.env.VITE_SOCKET_URL || import.meta.env.VITE_API_URL;
  if (configured && String(configured).startsWith('http')) return String(configured).replace(/\/api\/?$/, '');
  return typeof window !== 'undefined' ? window.location.origin : undefined;
}

export function connectBranchSocket(token, branchId) {
  return io(socketOrigin(), {
    auth: {token, ...(branchId ? {branch: branchId} : {})},
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 4000
  });
}

/**
 * Phase 22 — a realtime subscription that survives a reconnect and never
 * applies the same event twice.
 *
 * Two problems this solves for every screen at once:
 *
 *   RECONNECT GAP. Socket.IO reconnects transparently, but events published
 *   while the client was away are gone — rooms hold no history. On every
 *   (re)join we ask the server for everything after the last sequence we
 *   processed and feed it through the same handler as a live event.
 *
 *   DUPLICATES. The same business act can legitimately arrive twice: a retried
 *   mutation, a replayed gap, or membership of two rooms (a dispatcher who is
 *   also the assigned rider). Every event carries a stable `eventId`, so a
 *   bounded LRU of recent ids makes the handler idempotent.
 *
 * `onReload` fires when the gap is bigger than the server's replay buffer. The
 * server tells us `truncated` rather than handing back a partial history that
 * we could not distinguish from a complete one, so the honest response is a
 * full refetch.
 */
export function subscribeBranch({
  token, branchId, events = [], onEvent, onReload, onStatus, seenLimit = 300
}) {
  const socket = connectBranchSocket(token, branchId);
  const seen = new Set();
  let lastSequence = 0;
  let closed = false;

  const remember = eventId => {
    if (!eventId) return false;
    if (seen.has(eventId)) return true;
    seen.add(eventId);
    // Bounded: a long-lived KDS session must not grow this without limit.
    if (seen.size > seenLimit) seen.delete(seen.values().next().value);
    return false;
  };

  const dispatch = payload => {
    if (!payload) return;
    if (remember(payload.eventId)) return;          // already applied
    if (typeof payload.sequence === 'number' && payload.sequence > lastSequence) {
      lastSequence = payload.sequence;
    }
    onEvent?.(payload.event || payload.__event, payload);
  };

  for (const name of events) {
    socket.on(name, payload => dispatch({...payload, __event: name}));
  }

  const joinAndRecover = () => {
    if (closed || !branchId) return;
    socket.emit('join:branch', String(branchId), ack => {
      if (!ack?.ok) {
        onStatus?.({state: 'denied', message: ack?.message});
        return;
      }
      // First join: adopt the server's sequence rather than replaying history
      // the screen has never needed.
      if (lastSequence === 0) {
        lastSequence = Number(ack.sequence || 0);
        onStatus?.({state: 'live'});
        onReload?.();
        return;
      }
      socket.emit('replay:since', {branch: String(branchId), sequence: lastSequence}, result => {
        if (!result?.ok || result.truncated) {
          // Too far behind to patch up: refetch instead of pretending.
          onStatus?.({state: 'resynced'});
          lastSequence = Number(result?.sequence || lastSequence);
          onReload?.();
          return;
        }
        for (const event of result.events || []) dispatch(event);
        lastSequence = Number(result.sequence || lastSequence);
        onStatus?.({state: 'live'});
      });
    });
  };

  socket.on('connect', joinAndRecover);
  socket.on('disconnect', reason => onStatus?.({state: 'offline', reason}));
  // The server pushes these when access changes underneath a live socket.
  socket.on('branch:revoked', () => onStatus?.({state: 'denied', message: 'Branch access revoked'}));
  socket.on('session:revoked', () => onStatus?.({state: 'signed-out'}));

  return {
    socket,
    close() {
      closed = true;
      socket.close();
    },
    get sequence() { return lastSequence; }
  };
}
