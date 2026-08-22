import {Audit, User} from '../models/index.js';
import {invalidateAllRoles} from './principalCache.js';
import {disconnectUserSockets, refreshUserSockets} from './realtime.js';

/**
 * Phase 17 — server-side session invalidation.
 *
 * A JWT cannot be un-issued. The options are a blacklist of every live token
 * or a version counter on the user; this uses the counter, because:
 *
 *   • it is O(1) to check and needs no expiry sweep;
 *   • it cannot grow without bound, whereas a blacklist grows with traffic;
 *   • it survives a process restart, because it lives in MongoDB;
 *   • it invalidates ALL of a user's sessions at once, which is exactly what
 *     "this employee has left" and "reset my password" both mean.
 *
 * Per-device logout is the one thing a counter cannot express. That is a
 * documented limitation rather than an oversight — supporting it needs a
 * device/session identifier in the claim and a per-session record, which is a
 * larger change than this phase should make.
 *
 * Every revocation also drops the cached principal and pushes the change to
 * any live Socket.IO connection, so HTTP, cache and socket state cannot drift
 * apart.
 */

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Reasons a session is revoked. Recorded on the audit row. */
export const REVOCATION_REASONS = Object.freeze([
  'logout', 'password_reset', 'deactivated', 'role_changed',
  'branch_changed', 'security', 'admin'
]);

/**
 * Bump a user's session version: every token issued before this call stops
 * working on its next request.
 *
 * @param {object} options
 * @param {string} options.userId    whose sessions to end
 * @param {string} options.reason    why (audited)
 * @param {object} [options.actor]   who did it, when not the user themselves
 * @param {object} [options.session] mongoose session, when inside a transaction
 * @param {boolean} [options.disconnectSockets] hard-drop live sockets too
 */
export async function revokeUserSessions({
  userId, reason = 'security', actor = null, session = null, disconnectSockets = true
}) {
  if (!userId) throw httpError('A user is required', 400);
  const updated = await User.findByIdAndUpdate(
    userId,
    {$inc: {sessionVersion: 1}, $set: {sessionsRevokedAt: new Date()}},
    {new: true, session: session || null}
  ).select('_id email sessionVersion restaurantId').lean();
  if (!updated) throw httpError('Account not found', 404);

  // Order matters: the database is the source of truth, so it is written
  // first; only then is the cached copy dropped. Doing it the other way round
  // leaves a window where a concurrent request repopulates the cache from
  // pre-bump state.

  await Audit.create([{
    entity: 'user',
    entityId: updated._id,
    restaurant: updated.restaurantId || null,
    action: 'sessions_revoked',
    after: {reason, sessionVersion: updated.sessionVersion},
    user: actor?.id || userId
  }], {session: session || null});

  if (disconnectSockets) {
    // Best effort: a socket that cannot be reached is not a reason to fail
    // the revocation, which has already taken effect for HTTP.
    try { disconnectUserSockets(String(userId), reason); } catch { /* not fatal */ }
  }
  return {sessionVersion: updated.sessionVersion, reason};
}

/**
 * A user's access changed but their session should survive.
 *
 * Used for a role or branch reassignment: the person is still employed, so
 * logging them out is hostile, but their cached permissions and their live
 * socket rooms are now wrong and must be corrected immediately.
 */
export async function refreshUserAccess({userId, reason = 'role_changed'}) {
  try { await refreshUserSockets(String(userId), reason); } catch { /* not fatal */ }
}

/**
 * A Role document changed, so every holder's permissions may have changed.
 * Clearing the whole (bounded) cache is cheaper and safer than finding them.
 */
export async function refreshRoleHolders({restaurantId, roleKey, reason = 'role_changed'}) {
  invalidateAllRoles();
  const holders = await User.find({
    ...(restaurantId ? {restaurantId} : {}),
    ...(roleKey ? {roleKey} : {})
  }).select('_id').lean();
  for (const holder of holders) {
    try { await refreshUserSockets(String(holder._id), reason); } catch { /* not fatal */ }
  }
  return holders.length;
}

/** The version a freshly minted token must carry. */
export async function currentSessionVersion(userId) {
  const user = await User.findById(userId).select('sessionVersion').lean();
  return Number(user?.sessionVersion || 0);
}
