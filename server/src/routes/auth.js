/**
 * Authentication routes.
 *
 * Extracted from index.js in Phase 11 so the test harness can mount the same
 * code production runs. While these lived inline in index.js they were
 * unreachable from any integration test, which is why rider login had no
 * coverage at all despite the rider role shipping in Phase 10.
 *
 * Behaviour is unchanged: same login semantics, same rate limiter, same
 * owner-only registration.
 */
import {Router} from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {User} from '../models/index.js';
import {authenticated, requirePermission} from '../middleware/auth.js';
import {AUTH_RATE_LIMIT, createRateLimiter} from '../services/rateLimiting.js';
import {createStaffAccount} from '../services/staffAccounts.js';
import {
  createDeviceSession, listUserSessions, revokeDeviceSession, revokeUserSessions
} from '../services/sessions.js';
import {recordAuthEvent} from '../services/auditTrail.js';

const r = Router();

export const signToken = (user, sessionId = null) => jwt.sign(
  {
    id: user._id,
    name: user.name,
    role: user.role,
    restaurantId: user.restaurantId || null,
    branch: user.branch || null,
    // Phase 17: the session version this token was minted against. The guard
    // compares it to the stored value on every request, so incrementing
    // `user.sessionVersion` invalidates every token issued before the bump.
    sv: Number(user.sessionVersion || 0),
    // Opaque per-device session id. Only its hash is stored, so this token is
    // the only place the plaintext exists. Enables signing out one device
    // without ending the user's other sessions.
    ...(sessionId ? {sid: sessionId} : {})
  },
  process.env.JWT_SECRET,
  {expiresIn: '12h'}
);

// Credential stuffing control on the only unauthenticated staff endpoint.
const authLimit = createRateLimiter({
  name: 'auth:login',
  ...AUTH_RATE_LIMIT,
  enabled: () => process.env.NODE_ENV !== 'test'
});

r.post('/auth/login', authLimit, async (req, res) => {
  const user = await User.findOne({email: req.body.email});
  // One answer for "no such account" and "wrong password", so the endpoint
  // cannot be used to discover which email addresses exist.
  if (!user || !await bcrypt.compare(String(req.body.password || ''), user.password)) {
    // Audited with the address attempted and the source IP: a burst of these
    // from one IP is exactly what credential stuffing looks like. The row
    // carries no user id when the account is unknown, so the log cannot be
    // used to enumerate which addresses exist.
    await recordAuthEvent({
      req, action: 'login_failed', user: user || null, email: req.body.email,
      reason: user ? 'Incorrect password' : 'Unknown account'
    });
    return res.status(401).json({message: 'Invalid email or password'});
  }
  // Phase 12: a deactivated account must not be able to authenticate, even
  // with the correct password. Deliberately a distinct message from a bad
  // credential -- the person is a real employee who needs to know why, and
  // they have already proved they hold the password.
  if (user.active === false || (user.role === 'rider' && user.rider?.active === false)) {
    await recordAuthEvent({
      req, action: 'login_failed', user, email: req.body.email, reason: 'Account deactivated'
    });
    return res.status(403).json({message: 'This account is deactivated. Contact your manager.'});
  }
  await recordAuthEvent({req, action: 'login', user, email: user.email});
  const {sessionId} = await createDeviceSession({
    user,
    label: String(req.body?.deviceLabel || '').trim() || 'Web session',
    userAgent: req.headers['user-agent'],
    ip: req.ip
  });
  res.json({
    token: signToken(user, sessionId),
    user: {
      id: user._id,
      name: user.name,
      role: user.role,
      restaurantId: user.restaurantId || null,
      branch: user.branch || null
    }
  });
});

/**
 * Account provisioning.
 *
 * Delegates to createStaffAccount(), which takes the tenant from the caller's
 * token rather than the payload, enforces the password policy and returns a
 * safe projection. Before Phase 12 this was `User.create({...req.body})`,
 * which let an owner plant a user in another restaurant, echoed the bcrypt
 * hash back in the response, accepted a one-character password, and crashed
 * when the password was omitted.
 */
r.post('/auth/register', requirePermission('users.create'), async (req, res) => {
  try {
    res.status(201).json(await createStaffAccount({user: req.user, input: req.body || {}}));
  } catch (error) {
    const status = error?.status || 500;
    res.status(status).json({
      message: status >= 500 ? 'Server error' : String(error.message).slice(0, 300)
    });
  }
});

/**
 * Log out: end EVERY session for the calling user.
 *
 * A JWT cannot be un-issued, so this increments the user's session version,
 * which invalidates all tokens minted before now, drops the cached principal
 * and disconnects their live sockets.
 *
 * It is deliberately all-sessions rather than this-device-only. A version
 * counter cannot express per-device logout; supporting that needs a session
 * identifier in the claim and a per-session record. Documented as a
 * limitation rather than half-implemented.
 */
r.post('/auth/logout', authenticated(), async (req, res) => {
  try {
    // Default is THIS DEVICE only, so signing out a phone leaves the till
    // running. `allDevices: true` bumps the version and ends everything.
    if (req.body?.allDevices === true) {
      const result = await revokeUserSessions({userId: req.user.id, reason: 'logout'});
      await recordAuthEvent({req, action: 'logout', user: {_id: req.user.id, name: req.user.name, role: req.user.role, restaurantId: req.user.restaurantId, branch: req.user.branch}, email: req.user.email, reason: 'All devices'});
      return res.json({ok: true, scope: 'all', sessionVersion: result.sessionVersion});
    }
    if (!req.principal?.sessionId) {
      // A legacy token carries no session id, so there is nothing device-level
      // to revoke. Fall back to a global sign-out rather than silently doing
      // nothing, which would leave the user believing they had logged out.
      const result = await revokeUserSessions({userId: req.user.id, reason: 'logout'});
      return res.json({ok: true, scope: 'all', legacyToken: true, sessionVersion: result.sessionVersion});
    }
    await revokeDeviceSession({
      sessionRowId: req.principal.sessionId, ownerId: req.user.id,
      actor: req.user, reason: 'logout'
    });
    await recordAuthEvent({req, action: 'logout', user: {_id: req.user.id, name: req.user.name, role: req.user.role, restaurantId: req.user.restaurantId, branch: req.user.branch}, email: req.user.email, reason: 'This device'});
    res.json({ok: true, scope: 'device'});
  } catch (error) {
    res.status(error?.status || 500).json({
      message: (error?.status || 500) >= 500 ? 'Server error' : String(error.message).slice(0, 300)
    });
  }
});

/** The caller's own devices. Never exposes a session hash. */
r.get('/auth/sessions', authenticated(), async (req, res) => {
  try {
    const sessions = await listUserSessions({userId: req.user.id});
    res.json({
      sessions: sessions.map(session => ({
        ...session, current: session.id === req.principal?.sessionId
      }))
    });
  } catch (error) {
    res.status(error?.status || 500).json({message: 'Server error'});
  }
});

/**
 * Revoke one of the CALLER'S OWN sessions.
 *
 * `ownerId` is always the authenticated user, so a caller cannot revoke
 * somebody else's device by guessing an id — the lookup is scoped by user and
 * a mismatch is a 404, which also avoids confirming that the id exists.
 */
r.delete('/auth/sessions/:id', authenticated(), async (req, res) => {
  try {
    await revokeDeviceSession({
      sessionRowId: req.params.id, ownerId: req.user.id, actor: req.user, reason: 'logout'
    });
    res.json({ok: true});
  } catch (error) {
    res.status(error?.status || 500).json({
      message: (error?.status || 500) >= 500 ? 'Server error' : String(error.message).slice(0, 300)
    });
  }
});

export default r;
