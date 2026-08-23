import {randomUUID} from 'node:crypto';

/**
 * Phase 22 — the realtime event contract.
 *
 * Two problems this fixes, both found by probing the running server:
 *
 *  1. Only `purchasing:update` carried an `eventId`/`occurredAt`. Every other
 *     event arrived as a bare payload, so a client had no way to recognise a
 *     duplicate after a reconnect — Socket.IO redelivers on reconnection and
 *     several publishers fire twice for one business act (a status change also
 *     emits a table update). `Purchasing.jsx` already deduped on `eventId`,
 *     which is exactly the pattern that could not be used anywhere else.
 *
 *  2. Event names were string literals scattered across ~50 call sites. A typo
 *     produced an event nobody listened to and no test could catch.
 *
 * Every event now leaves through `envelope()`, so the shape is identical
 * regardless of publisher, and the names live in one frozen list a test
 * asserts against.
 */

export const REALTIME_EVENTS = Object.freeze({
  KITCHEN_NEW_ORDER: 'kitchen:new-order',
  KITCHEN_STATUS: 'kitchen:status',
  TABLE_UPDATE: 'table:update',
  PURCHASING_UPDATE: 'purchasing:update',
  INVENTORY_UPDATE: 'inventory:update',
  INVENTORY_ALERT: 'inventory:alert',
  DELIVERY_UPDATE: 'delivery:update',
  PAYMENT_UPDATE: 'payment:update',
  ORDER_UPDATE: 'order:update'
});

/** Control-plane events. Not business data; excluded from replay. */
export const CONTROL_EVENTS = Object.freeze({
  BRANCH_REVOKED: 'branch:revoked',
  SESSION_REVOKED: 'session:revoked',
  PERMISSIONS_CHANGED: 'permissions:changed'
});

export const REALTIME_EVENT_NAMES = Object.freeze(Object.values(REALTIME_EVENTS));

const EVENT_NAME_SET = new Set(REALTIME_EVENT_NAMES);
export const isRealtimeEvent = name => EVENT_NAME_SET.has(name);

/** Current envelope version. Bump only on a breaking payload change. */
export const REALTIME_SCHEMA_VERSION = 1;

/**
 * Wrap a payload in the standard envelope.
 *
 * `eventId` is the deduplication key. It is a random UUID unless the caller
 * supplies a DETERMINISTIC one via `idempotencyKey` — worth doing when the
 * same business act can legitimately publish twice (a retried request, a
 * replayed idempotent mutation), because then both emissions carry the same
 * id and a client that has seen one discards the other.
 *
 * `sequence` is assigned by the publisher, per room, so a client can tell
 * "older than what I have" from "newer" after a reconnect without trusting
 * clock skew between instances.
 */
export function envelope(event, payload = {}, {branch, restaurant, idempotencyKey, sequence} = {}) {
  return {
    ...payload,
    event,
    schemaVersion: REALTIME_SCHEMA_VERSION,
    eventId: idempotencyKey ? String(idempotencyKey) : randomUUID(),
    occurredAt: new Date().toISOString(),
    ...(sequence === undefined ? {} : {sequence}),
    ...(branch ? {branch: String(branch)} : {}),
    ...(restaurant ? {restaurant: String(restaurant)} : {})
  };
}

/**
 * Bounded per-room replay buffer.
 *
 * A reconnecting client has a gap: events published between the disconnect and
 * the rejoin are simply lost, because Socket.IO rooms hold no history. The
 * client sends the last `sequence` it saw when it rejoins, and everything
 * newer is replayed.
 *
 * Deliberately IN MEMORY and bounded (`MAX_PER_ROOM`), because:
 *   • it is a convenience, not a guarantee — a client that has been away
 *     longer than the buffer is told to do a full reload rather than being
 *     handed a partial history that looks complete;
 *   • persisting it would make every realtime publish a database write, which
 *     is a real cost for a feature whose fallback (reload) is cheap;
 *   • it is per-process, so with several API instances a client may reconnect
 *     to an instance holding a different buffer. That is why the reload
 *     fallback exists and why this is documented rather than claimed as
 *     delivery assurance.
 */
const MAX_PER_ROOM = 100;
const buffers = new Map(); // room -> {sequence, events: []}

export const replayStats = {recorded: 0, replayed: 0, truncated: 0, rooms: () => buffers.size};

export function resetReplayBuffers() {
  buffers.clear();
  replayStats.recorded = 0;
  replayStats.replayed = 0;
  replayStats.truncated = 0;
}

/** Next sequence number for a room, and the buffer to append to. */
function bufferFor(room) {
  let entry = buffers.get(room);
  if (!entry) {
    entry = {sequence: 0, events: []};
    buffers.set(room, entry);
  }
  return entry;
}

export function nextSequence(room) {
  const entry = bufferFor(room);
  entry.sequence += 1;
  return entry.sequence;
}

export function recordForReplay(room, payload) {
  const entry = bufferFor(room);
  entry.events.push(payload);
  if (entry.events.length > MAX_PER_ROOM) {
    entry.events.splice(0, entry.events.length - MAX_PER_ROOM);
    replayStats.truncated += 1;
  }
  replayStats.recorded += 1;
  return payload;
}

/**
 * Events a rejoining client has not seen.
 *
 * Returns `{truncated: true}` when the requested point has already fallen out
 * of the buffer. The client must then reload rather than assume it is caught
 * up — silently returning a partial list would be worse than returning
 * nothing, because the client could not tell the difference.
 */
export function replaySince(room, since) {
  const entry = buffers.get(room);
  if (!entry) return {events: [], sequence: 0, truncated: false};
  const after = Number(since);
  if (!Number.isFinite(after) || after < 0) {
    return {events: [], sequence: entry.sequence, truncated: false};
  }
  if (after > entry.sequence) {
    // The client claims to be ahead of us: a different instance, or the buffer
    // was cleared by a restart. Treat it as a gap rather than pretending.
    return {events: [], sequence: entry.sequence, truncated: true};
  }
  const oldest = entry.events.length ? Number(entry.events[0].sequence || 0) : entry.sequence + 1;
  if (after > 0 && after + 1 < oldest) {
    return {events: [], sequence: entry.sequence, truncated: true};
  }
  const events = entry.events.filter(item => Number(item.sequence || 0) > after);
  replayStats.replayed += events.length;
  return {events, sequence: entry.sequence, truncated: false};
}
