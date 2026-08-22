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
import {revokeUserSessions} from '../services/sessions.js';

const r = Router();

export const signToken = user => jwt.sign(
  {
    id: user._id,
    name: user.name,
    role: user.role,
    restaurantId: user.restaurantId || null,
    branch: user.branch || null,
    // Phase 17: the session version this token was minted against. The guard
    // compares it to the stored value on every request, so incrementing
    // `user.sessionVersion` invalidates every token issued before the bump.
    sv: Number(user.sessionVersion || 0)
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
    return res.status(401).json({message: 'Invalid email or password'});
  }
  // Phase 12: a deactivated account must not be able to authenticate, even
  // with the correct password. Deliberately a distinct message from a bad
  // credential -- the person is a real employee who needs to know why, and
  // they have already proved they hold the password.
  if (user.active === false || (user.role === 'rider' && user.rider?.active === false)) {
    return res.status(403).json({message: 'This account is deactivated. Contact your manager.'});
  }
  res.json({
    token: signToken(user),
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
    const result = await revokeUserSessions({userId: req.user.id, reason: 'logout'});
    res.json({ok: true, sessionVersion: result.sessionVersion});
  } catch (error) {
    res.status(error?.status || 500).json({
      message: (error?.status || 500) >= 500 ? 'Server error' : String(error.message).slice(0, 300)
    });
  }
});

export default r;
