import {createHash, randomBytes} from 'node:crypto';
import {Audit, User, UserSession} from '../models/index.js';
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

const clean = value => String(value ?? '').trim();

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

  await revokeAllDeviceSessions({userId, actor, reason, session});

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


// ── per-device sessions ──────────────────────────────────────────────────────

/** Session ids are opaque randoms; only the hash is ever persisted. */
export const hashSessionId = value => createHash('sha256').update(String(value)).digest('hex');

export const TOKEN_TTL_HOURS = 12;

/**
 * Mint a session row for one device and return the plaintext id for the JWT.
 *
 * The caller puts `sid` in the token. Nothing reversible is stored, so a
 * database leak cannot be replayed as a session.
 */
export async function createDeviceSession({user, label, userAgent, ip}) {
  const sessionId = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000);
  await UserSession.create({
    user: user._id,
    restaurant: user.restaurantId || null,
    sessionHash: hashSessionId(sessionId),
    label: clean(label).slice(0, 120) || 'Unnamed device',
    userAgent: clean(userAgent).slice(0, 300) || undefined,
    ip: clean(ip).slice(0, 60) || undefined,
    expiresAt
  });
  return {sessionId, expiresAt};
}

/**
 * Is this session still usable?
 *
 * Returns the row when live, `null` when revoked, expired or unknown. A token
 * with no `sid` (minted before per-device sessions existed) is accepted and
 * reported as `legacy`, so shipping this does not sign everybody out; those
 * tokens remain covered by `sessionVersion`.
 */
export async function assertSessionLive(sessionId) {
  if (!sessionId) return {legacy: true, session: null};
  const session = await UserSession.findOne({sessionHash: hashSessionId(sessionId)}).lean();
  if (!session) return {legacy: false, session: null};
  if (session.revokedAt) return {legacy: false, session: null};
  if (session.expiresAt && session.expiresAt.getTime() <= Date.now()) return {legacy: false, session: null};
  return {legacy: false, session};
}

/** Sessions for one user, newest first. Never exposes the hash. */
export async function listUserSessions({userId, includeRevoked = false}) {
  const match = {user: userId};
  if (!includeRevoked) match.revokedAt = null;
  const rows = await UserSession.find(match).sort({createdAt: -1}).limit(50).lean();
  return rows.map(row => ({
    id: String(row._id),
    label: row.label,
    userAgent: row.userAgent || null,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    active: !row.revokedAt && row.expiresAt > new Date()
  }));
}

/**
 * Revoke ONE device session, leaving the user's other devices working.
 *
 * `ownerId` is the user the session must belong to. It is always the
 * authenticated caller (or an administrator's explicit target), so one user
 * can never revoke another's session by guessing an id — the query is scoped
 * by user, and a mismatch is a 404 rather than a leak that the id exists.
 */
export async function revokeDeviceSession({sessionRowId, ownerId, actor, reason = 'logout'}) {
  const session = await UserSession.findOne({_id: sessionRowId, user: ownerId});
  if (!session) throw httpError('Session not found', 404);
  if (session.revokedAt) return {alreadyRevoked: true, id: String(session._id)};

  session.revokedAt = new Date();
  session.revokedBy = actor?.id || ownerId;
  session.revokedReason = reason;
  await session.save();

  await Audit.create({
    entity: 'user',
    entityId: ownerId,
    restaurant: session.restaurant || null,
    action: 'session_device_revoked',
    after: {sessionId: String(session._id), label: session.label, reason},
    user: actor?.id || ownerId
  });

  // The socket for this device cannot be identified individually, so live
  // sockets are re-authorised: any whose session is now dead is dropped by the
  // handshake-equivalent check in refreshUserSockets().
  try { await refreshUserSockets(String(ownerId), reason); } catch { /* not fatal */ }
  return {alreadyRevoked: false, id: String(session._id)};
}

/** Mark every session for a user revoked. Used alongside a version bump. */
export async function revokeAllDeviceSessions({userId, actor, reason, session = null}) {
  const result = await UserSession.updateMany(
    {user: userId, revokedAt: null},
    {$set: {revokedAt: new Date(), revokedBy: actor?.id || userId, revokedReason: reason}},
    {session: session || null}
  );
  return result.modifiedCount || 0;
}

/** The version a freshly minted token must carry. */
export async function currentSessionVersion(userId) {
  const user = await User.findById(userId).select('sessionVersion').lean();
  return Number(user?.sessionVersion || 0);
}
