import jwt from 'jsonwebtoken';

/** Every role that is part of restaurant operations, excluding riders. */
export const STAFF_ROLES = Object.freeze(['owner', 'manager', 'staff']);

/**
 * Authenticate, and optionally authorise against a role list.
 *
 * IMPORTANT (Phase 10): `auth()` with no roles means "any authenticated
 * principal", which now includes riders. A rider is the least-privileged
 * account in the system, so `auth()` must NOT be used to guard anything
 * operational. Use `requireStaff()` for endpoints that are staff-only but not
 * role-specific.
 */
export const auth = (roles = []) => async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    if (roles.length && !roles.includes(payload.role)) {
      return res.status(403).json({message: 'Insufficient permission'});
    }
    next();
  } catch {
    return res.status(401).json({message: 'Authentication required'});
  }
};

/**
 * Any restaurant employee, but never a rider.
 *
 * Introduced because adding the rider role would otherwise have silently
 * widened every bare `auth()` endpoint — the branch list, transfers and the
 * expense ledger among them — to delivery riders.
 */
export const requireStaff = () => auth(STAFF_ROLES);
