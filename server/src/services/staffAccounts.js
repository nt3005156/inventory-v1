/**
 * Staff and rider account provisioning (Phase 12).
 *
 * This exists because `POST /auth/register` was `User.create({...req.body})`
 * with no validation at all. That allowed an owner to:
 *   - plant a user inside ANOTHER restaurant by passing `restaurantId`,
 *   - receive the bcrypt hash back in the response body,
 *   - set a one-character password,
 *   - and crash the request by omitting the password entirely.
 *
 * Every account now goes through here: the tenant is taken from the caller's
 * own token and never from the payload, the password is policy-checked, and
 * the response is a safe projection that cannot carry a credential.
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {Audit, RIDER_VEHICLES, User} from '../models/index.js';
import {Delivery} from '../models/operations.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {userRestaurantContext} from './supplierCatalog.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Roles an owner may provision. Never 'owner' — that is a deployment act. */
export const CREATABLE_ROLES = Object.freeze(['manager', 'staff', 'rider']);

export const MIN_PASSWORD_LENGTH = 10;

/**
 * A password must survive a stolen-database attack long enough to matter.
 * Ten characters with some variety is the floor; obvious choices are refused
 * outright because they are the first thing any attacker tries.
 */
const BANNED_PASSWORDS = new Set([
  'password', 'password1', 'password123', '1234567890', 'qwertyuiop',
  'changeme', 'letmein123', 'restaurant', 'mittho1234', 'admin12345'
]);

export function assertPasswordPolicy(raw) {
  const password = String(raw ?? '');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw httpError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
  if (password.length > 200) throw httpError('Password is too long', 400);
  if (BANNED_PASSWORDS.has(password.toLowerCase())) {
    throw httpError('That password is too common. Choose another.', 400);
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw httpError('Password must contain both letters and numbers', 400);
  }
  return password;
}

/**
 * The ONLY shape a user record leaves this module in.
 *
 * Built by hand rather than by deleting fields, so a future schema addition
 * cannot silently start leaking. The password hash is never included: a hash
 * is a credential, and handing it to a browser lets it be attacked offline.
 */
export function publicUserView(user) {
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    branch: user.branch || null,
    restaurantId: user.restaurantId || null,
    createdAt: user.createdAt,
    ...(user.role === 'rider'
      ? {
        rider: {
          active: user.rider?.active !== false,
          available: Boolean(user.rider?.available),
          phone: user.rider?.phone || null,
          vehicle: user.rider?.vehicle || 'motorcycle',
          licencePlate: user.rider?.licencePlate || null,
          maxConcurrent: Number(user.rider?.maxConcurrent || 3),
          notes: user.rider?.notes || null
        }
      }
      : {})
  };
}

/**
 * Create a staff or rider account inside the CALLER'S restaurant.
 *
 * `restaurantId` is deliberately not accepted from the payload. It is read
 * from the authenticated owner's own context, so an account cannot be planted
 * in another tenant.
 */
export async function createStaffAccount({user, input}) {
  const {restaurantId} = await userRestaurantContext(user);
  if (!restaurantId) throw httpError('User is not attached to a restaurant', 403);

  const role = clean(input.role).toLowerCase();
  if (!CREATABLE_ROLES.includes(role)) {
    // Refusing 'owner' here is the point: an owner account is created during
    // deployment, not minted through the API by another owner.
    throw httpError(`Role must be one of ${CREATABLE_ROLES.join(', ')}`, 400);
  }

  const email = clean(input.email).toLowerCase();
  if (!email) throw httpError('An email address is required', 400);
  const password = assertPasswordPolicy(input.password);

  // Duplicate email is a unique index, but checking first gives a usable
  // message instead of a raw driver error.
  if (await User.findOne({email})) {
    throw httpError('An account with that email already exists', 409);
  }

  const phone = clean(input.phone);
  if (role === 'rider' && phone) {
    // Two riders sharing a phone makes dispatch ambiguous at the door.
    const clash = await User.findOne({restaurantId, role: 'rider', 'rider.phone': phone});
    if (clash) throw httpError('Another rider already uses that phone number', 409);
  }

  let branch;
  if (input.branch) {
    await assertTenantBranchAccess(user, input.branch);
    branch = input.branch;
  } else if (role !== 'owner' && role !== 'manager') {
    // Staff and riders are branch-bound in every other part of the system.
    throw httpError('A branch is required for staff and rider accounts', 400);
  }

  const created = await User.create({
    name: clean(input.name),
    email,
    password: await bcrypt.hash(password, 12),
    role,
    // Tenant comes from the caller, never from the request.
    restaurantId,
    restaurant: user.restaurant || undefined,
    branch,
    ...(role === 'rider'
      ? {
        rider: {
          active: true,
          // A new rider starts off shift: going on shift is their own act.
          available: false,
          phone: phone || undefined,
          vehicle: input.vehicle || 'motorcycle',
          licencePlate: clean(input.licencePlate) || undefined,
          maxConcurrent: input.maxConcurrent ?? 3,
          notes: clean(input.notes) || undefined
        }
      }
      : {})
  });

  await Audit.create({
    entity: 'user', entityId: created._id, branch: created.branch,
    action: 'account_created',
    // Never log the password or its hash.
    after: {name: created.name, email: created.email, role: created.role},
    user: user.id
  });

  return publicUserView(created);
}

/** List staff/rider accounts for the caller's restaurant. */
export async function listStaffAccounts({user, role, branchId, includeInactive = false}) {
  const {restaurantId} = await userRestaurantContext(user);
  const filter = {restaurantId};
  if (role) filter.role = role;
  if (branchId) {
    await assertTenantBranchAccess(user, branchId);
    filter.branch = new mongoose.Types.ObjectId(String(branchId));
  }
  if (!includeInactive && role === 'rider') filter['rider.active'] = {$ne: false};

  const users = await User.find(filter).sort({name: 1}).limit(300).lean();
  return users.map(publicUserView);
}

/**
 * Reset a password. Owners only.
 *
 * Returns nothing but a confirmation: the new password is chosen by the
 * caller, so echoing it back would only create another place for it to leak.
 */
export async function resetAccountPassword({user, targetId, password}) {
  const {restaurantId} = await userRestaurantContext(user);
  const target = await User.findOne({_id: targetId, restaurantId});
  if (!target) throw httpError('Account not found', 404);
  if (target.role === 'owner' && String(target._id) !== String(user.id)) {
    throw httpError('An owner password cannot be reset through this endpoint', 403);
  }

  target.password = await bcrypt.hash(assertPasswordPolicy(password), 12);
  await target.save();

  await Audit.create({
    entity: 'user', entityId: target._id, branch: target.branch,
    action: 'account_password_reset',
    after: {email: target.email}, user: user.id
  });
  return {ok: true};
}

/**
 * Deactivate or reactivate an account.
 *
 * A rider carrying live deliveries cannot be stood down: the jobs would be
 * stranded with nobody able to advance them. Reassign first.
 */
export async function setAccountActive({user, targetId, active, reason}) {
  const {restaurantId} = await userRestaurantContext(user);
  const target = await User.findOne({_id: targetId, restaurantId});
  if (!target) throw httpError('Account not found', 404);
  if (target.role === 'owner') throw httpError('An owner account cannot be deactivated', 403);
  if (String(target._id) === String(user.id)) {
    throw httpError('You cannot deactivate your own account', 409);
  }

  if (!active && target.role === 'rider') {
    const live = await Delivery.countDocuments({
      rider: target._id,
      status: {$in: ['pending', 'assigned', 'picked_up', 'out_for_delivery']}
    });
    if (live > 0) {
      throw httpError(
        `That rider still has ${live} live ${live === 1 ? 'delivery' : 'deliveries'}. Reassign them first.`,
        409
      );
    }
  }

  if (target.role === 'rider') {
    const profile = target.rider || {};
    profile.active = Boolean(active);
    // Standing a rider down also takes them off shift, or they linger in the
    // available pool and a dispatcher can still pick them.
    if (!active) profile.available = false;
    target.rider = profile;
    target.markModified('rider');
  }
  target.active = Boolean(active);
  await target.save();

  await Audit.create({
    entity: 'user', entityId: target._id, branch: target.branch,
    action: active ? 'account_reactivated' : 'account_deactivated',
    after: {email: target.email, reason: clean(reason) || null}, user: user.id
  });
  return publicUserView(target);
}

export const RIDER_VEHICLE_OPTIONS = RIDER_VEHICLES;
