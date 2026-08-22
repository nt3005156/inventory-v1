import mongoose from 'mongoose';
import {Role} from '../models/index.js';
import {invalidateAllRoles, invalidateRole} from './principalCache.js';

/**
 * Cross-instance role-cache invalidation via a MongoDB change stream.
 *
 * The role cache is per-process, so an edit made on instance A would otherwise
 * take up to one TTL (5s) to be noticed by instance B. This closes that
 * window WITHOUT adding infrastructure:
 *
 *   • Change streams need a replica set or sharded cluster.
 *   • This deployment already REQUIRES one — `verifyTransactionCapableDatabase()`
 *     refuses to start otherwise, because purchasing uses transactions.
 *
 * So the seam already exists and is already a hard dependency; no Redis is
 * introduced to paper over the problem. Every API instance watches the `roles`
 * collection and drops its cached copy when a role document changes anywhere.
 *
 * HONEST SCOPE — what this does and does not guarantee:
 *
 *   • It covers ROLE DEFINITION changes only, which is all that is cached.
 *     User state (active, role, sessionVersion) is read live on every request
 *     and was never cached, so it needs no propagation.
 *   • It is best-effort. If the stream drops, the 5-second TTL remains the
 *     backstop and correctness still holds — propagation just returns to
 *     being TTL-bounded rather than immediate.
 *   • Cross-instance behaviour is NOT verified by the test suite: the harness
 *     runs a single API process against a single-node replica set. What IS
 *     tested is that the watcher starts, that an out-of-band role write
 *     invalidates this process's cache through the stream, and that it shuts
 *     down cleanly. The multi-instance claim is therefore stated as designed,
 *     not as proven.
 */

let stream = null;
let starting = false;

export const roleStreamStats = {started: 0, events: 0, errors: 0, closed: 0};

export function roleStreamActive() {
  return Boolean(stream);
}

/**
 * Begin watching. Safe to call more than once; a failure is logged and
 * swallowed, because losing the optimisation must never stop the API booting.
 */
export async function startRoleChangeStream() {
  if (stream || starting) return false;
  starting = true;
  try {
    const connection = mongoose.connection;
    if (!connection?.db) return false;
    // A single-node replica set supports change streams, so this works in the
    // test harness as well as in production.
    stream = Role.watch([], {fullDocument: 'updateLookup'});
    roleStreamStats.started += 1;

    stream.on('change', event => {
      roleStreamStats.events += 1;
      const doc = event.fullDocument;
      const restaurant = doc?.restaurant ?? event.documentKey?.restaurant;
      const key = doc?.key;
      // A delete carries no fullDocument, so the specific key is unknown and
      // the whole (bounded) cache is cleared instead. Clearing is cheap and
      // cannot be incomplete, which matters more than precision here.
      if (restaurant && key) invalidateRole(restaurant, key);
      else invalidateAllRoles();
    });

    stream.on('error', () => {
      roleStreamStats.errors += 1;
      // Drop the handle so a later start can retry. The TTL keeps the cache
      // correct in the meantime.
      try { stream?.close?.(); } catch { /* already gone */ }
      stream = null;
    });

    return true;
  } catch {
    roleStreamStats.errors += 1;
    stream = null;
    return false;
  } finally {
    starting = false;
  }
}

export async function stopRoleChangeStream() {
  if (!stream) return false;
  const current = stream;
  stream = null;
  roleStreamStats.closed += 1;
  try { await current.close(); } catch { /* already closed */ }
  return true;
}
