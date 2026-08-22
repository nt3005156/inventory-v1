import {Audit, Role, User} from '../models/index.js';
import {Branch} from '../models/operations.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {
  ALL_PERMISSIONS, BUILTIN_ROLES, BUILTIN_ROLE_KEYS, PERMISSION_CATALOG,
  ROLE_TEMPLATES, assertPermissionKeys, permissionsForBuiltin
} from './permissions.js';

/**
 * Phase 20 — role administration.
 *
 * Creating, editing and retiring the roles a tenant defines for itself, plus
 * assigning them to users. Everything here is guarded by `roles.manage` or
 * `users.manage` at the route; this module enforces the INVARIANTS that must
 * hold no matter who is calling:
 *
 *   • a custom role can never grant more than the caller holds;
 *   • a custom role can never be based on `owner`;
 *   • the built-in roles cannot be edited or deleted;
 *   • a role still assigned to somebody cannot be deleted;
 *   • the last active owner cannot be removed or demoted.
 *
 * Every mutation writes an audit row. "Who could do what, when" is the whole
 * reason an RBAC system is worth having.
 */

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/** Shape a role for the API, built by hand so nothing new leaks by accident. */
function roleView(role, {assignedCount} = {}) {
  return {
    key: role.key,
    name: role.name,
    description: role.description || null,
    baseRole: role.baseRole,
    permissions: [...(role.permissions || [])].sort(),
    builtin: Boolean(role.builtin),
    active: role.active !== false,
    ...(assignedCount === undefined ? {} : {assignedCount})
  };
}

function builtinView(key) {
  const role = BUILTIN_ROLES[key];
  return {
    key: role.key,
    name: role.name,
    description: role.description,
    baseRole: role.baseRole,
    permissions: permissionsForBuiltin(key),
    builtin: true,
    active: true,
    // An owner's permission list is "everything, including future additions".
    unrestricted: key === 'owner'
  };
}

/**
 * Every role available in this restaurant: the four built-ins followed by the
 * tenant's own, each with a live count of how many accounts hold it.
 */
export async function listRoles({user, includeInactive = false}) {
  const {restaurantId} = await userRestaurantContext(user);
  const match = {restaurant: restaurantId};
  if (!includeInactive) match.active = {$ne: false};
  const custom = await Role.find(match).sort({name: 1}).lean();

  const counts = new Map();
  const rows = await User.aggregate([
    {$match: {restaurantId, active: {$ne: false}}},
    {$group: {_id: {role: '$role', roleKey: '$roleKey'}, count: {$sum: 1}}}
  ]);
  for (const row of rows) {
    const key = row._id.roleKey || row._id.role;
    counts.set(key, (counts.get(key) || 0) + row.count);
  }

  return {
    roles: [
      ...BUILTIN_ROLE_KEYS.map(key => ({...builtinView(key), assignedCount: counts.get(key) || 0})),
      ...custom.map(role => roleView(role, {assignedCount: counts.get(role.key) || 0}))
    ],
    permissions: PERMISSION_CATALOG,
    templates: ROLE_TEMPLATES,
    baseRoles: ['manager', 'staff', 'rider']
  };
}

/**
 * PRIVILEGE ESCALATION GUARD.
 *
 * A non-owner with `roles.manage` must not be able to mint a role holding
 * permissions they do not themselves have — otherwise a manager creates
 * "Manager Plus" with `monthclose.manage`, assigns it to themselves, and has
 * escalated. An owner holds everything, so this is a no-op for them.
 */
function assertNoEscalation(principal, permissions) {
  if (principal?.baseRole === 'owner') return;
  const held = principal?.permissions || new Set();
  const excess = permissions.filter(permission => !held.has(permission));
  if (excess.length) {
    throw httpError(
      `You cannot grant permissions you do not hold: ${excess.slice(0, 5).join(', ')}`,
      403
    );
  }
}

export async function createRole({user, principal, input}) {
  const {restaurantId} = await userRestaurantContext(user);
  const key = clean(input.key || input.name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!key) throw httpError('A role key is required', 400);
  if (BUILTIN_ROLE_KEYS.includes(key)) {
    throw httpError(`'${key}' is a built-in role and cannot be redefined`, 409);
  }
  const name = clean(input.name);
  if (name.length < 2) throw httpError('A role name is required', 400);

  const baseRole = clean(input.baseRole || 'staff').toLowerCase();
  if (!['manager', 'staff', 'rider'].includes(baseRole)) {
    // 'owner' is refused deliberately: an owner-based custom role would hold
    // every permission implicitly, which is exactly the escalation this
    // module exists to prevent.
    throw httpError('Base role must be manager, staff or rider', 400);
  }

  const permissions = assertPermissionKeys(input.permissions);
  assertNoEscalation(principal, permissions);

  if (await Role.findOne({restaurant: restaurantId, key})) {
    throw httpError('A role with that key already exists', 409);
  }

  const role = await Role.create({
    restaurant: restaurantId,
    key,
    name,
    description: clean(input.description) || undefined,
    baseRole,
    permissions,
    createdBy: user.id
  });

  await Audit.create({
    entity: 'role', entityId: role._id, restaurant: restaurantId,
    action: 'role_created',
    after: {key: role.key, name: role.name, baseRole, permissions},
    user: user.id
  });
  return roleView(role, {assignedCount: 0});
}

export async function updateRole({user, principal, key, input}) {
  const {restaurantId} = await userRestaurantContext(user);
  const roleKey = clean(key).toLowerCase();
  if (BUILTIN_ROLE_KEYS.includes(roleKey)) {
    // The built-ins are the floor the system is tested against and the last
    // resort when a tenant breaks its own custom roles. They are defined in
    // code precisely so they cannot be edited into uselessness.
    throw httpError('A built-in role cannot be modified', 403);
  }
  const role = await Role.findOne({restaurant: restaurantId, key: roleKey});
  if (!role) throw httpError('Role not found', 404);

  const before = {
    name: role.name, description: role.description,
    permissions: [...role.permissions], active: role.active
  };

  if (input.name !== undefined) {
    const name = clean(input.name);
    if (name.length < 2) throw httpError('A role name is required', 400);
    role.name = name;
  }
  if (input.description !== undefined) role.description = clean(input.description) || undefined;
  if (input.permissions !== undefined) {
    const permissions = assertPermissionKeys(input.permissions);
    assertNoEscalation(principal, permissions);
    role.permissions = permissions;
  }
  if (input.active !== undefined) {
    if (input.active === false) {
      // Switching a role off logs out everyone holding it (resolvePrincipal
      // refuses an inactive role), so it must be as deliberate as deletion.
      const holders = await User.countDocuments({
        restaurantId, roleKey, active: {$ne: false}
      });
      if (holders > 0) {
        throw httpError(
          `${holders} active account(s) still hold this role. Reassign them first.`,
          409
        );
      }
    }
    role.active = Boolean(input.active);
  }
  // `baseRole` is deliberately immutable after creation. Changing it would
  // silently move every holder between tenancy regimes — a staff-based role
  // becoming manager-based would hand its holders branch-wide reach with no
  // reassignment and no audit of the individual users affected.
  if (input.baseRole !== undefined && clean(input.baseRole) !== role.baseRole) {
    throw httpError('A role\'s base role cannot be changed. Create a new role instead.', 409);
  }

  role.updatedBy = user.id;
  await role.save();

  await Audit.create({
    entity: 'role', entityId: role._id, restaurant: restaurantId,
    action: 'role_updated',
    before,
    after: {
      name: role.name, description: role.description,
      permissions: [...role.permissions], active: role.active
    },
    user: user.id
  });
  const assignedCount = await User.countDocuments({restaurantId, roleKey, active: {$ne: false}});
  return roleView(role, {assignedCount});
}

export async function deleteRole({user, key}) {
  const {restaurantId} = await userRestaurantContext(user);
  const roleKey = clean(key).toLowerCase();
  if (BUILTIN_ROLE_KEYS.includes(roleKey)) {
    throw httpError('A built-in role cannot be deleted', 403);
  }
  const role = await Role.findOne({restaurant: restaurantId, key: roleKey});
  if (!role) throw httpError('Role not found', 404);

  // Deleting a role out from under its holders would lock them out with no
  // trace of what they used to be able to do.
  const holders = await User.countDocuments({restaurantId, roleKey});
  if (holders > 0) {
    throw httpError(
      `${holders} account(s) still hold this role. Reassign them first.`,
      409
    );
  }

  await Role.deleteOne({_id: role._id});
  await Audit.create({
    entity: 'role', entityId: role._id, restaurant: restaurantId,
    action: 'role_deleted',
    before: {key: role.key, name: role.name, permissions: [...role.permissions]},
    user: user.id
  });
  return {deleted: true, key: role.key};
}

/**
 * Assign a role — built-in or custom — to a user, and optionally move them to
 * a different branch.
 */
export async function assignUserRole({user, principal, targetId, roleKey, branchId}) {
  const {restaurantId} = await userRestaurantContext(user);
  const target = await User.findOne({_id: targetId, restaurantId});
  if (!target) throw httpError('Account not found', 404);

  const before = {role: target.role, roleKey: target.roleKey, branch: target.branch};
  let nextRole = target.role;
  let nextRoleKey = target.roleKey || null;

  if (roleKey !== undefined) {
    const key = clean(roleKey).toLowerCase();
    if (!key) throw httpError('A role is required', 400);

    if (BUILTIN_ROLE_KEYS.includes(key)) {
      if (key === 'owner') {
        // Minting an owner through the roster is how a tenant loses control of
        // itself. Owner accounts are a deployment act, consistent with
        // CREATABLE_ROLES in staffAccounts.js.
        throw httpError('An owner account cannot be created through role assignment', 403);
      }
      nextRole = key;
      nextRoleKey = null;
    } else {
      const role = await Role.findOne({restaurant: restaurantId, key});
      if (!role) throw httpError('Role not found', 404);
      if (role.active === false) throw httpError('That role is not active', 409);
      // A non-owner cannot hand out a role stronger than their own.
      assertNoEscalation(principal, role.permissions || []);
      nextRole = role.baseRole;
      nextRoleKey = role.key;
    }

    // Demoting the last owner would leave the restaurant with nobody who can
    // repair its roles or reinstate an account.
    if (target.role === 'owner' && nextRole !== 'owner') {
      const owners = await User.countDocuments({
        restaurantId, role: 'owner', active: {$ne: false}, _id: {$ne: target._id}
      });
      if (owners === 0) throw httpError('The last owner cannot be demoted', 409);
    }
  }

  if (branchId !== undefined) {
    if (branchId === null || branchId === '') {
      if (nextRole !== 'owner') {
        // Only an owner is legitimately restaurant-wide. Clearing the branch
        // on anyone else produces a principal that tenancy scoping cannot
        // place, and several services throw 403 on it.
        throw httpError('Only an owner may be left without a branch', 400);
      }
      target.branch = null;
    } else {
      const branch = await Branch.findOne({_id: branchId, restaurant: restaurantId}).lean();
      if (!branch) throw httpError('Branch not found', 404);
      target.branch = branch._id;
    }
  }

  target.role = nextRole;
  target.roleKey = nextRoleKey;
  await target.save();

  await Audit.create({
    entity: 'user', entityId: target._id, restaurant: restaurantId, branch: target.branch,
    action: 'user_role_assigned',
    before,
    after: {role: target.role, roleKey: target.roleKey, branch: target.branch},
    user: user.id
  });

  return {
    _id: target._id,
    name: target.name,
    email: target.email,
    role: target.role,
    roleKey: target.roleKey,
    branch: target.branch || null,
    active: target.active !== false
  };
}

/** What the CALLER themselves may do — drives the client's navigation. */
export function describeSelf(principal) {
  return {
    userId: principal.userId,
    name: principal.name,
    role: principal.baseRole,
    roleKey: principal.roleKey,
    roleName: principal.roleName,
    custom: principal.custom,
    branch: principal.branch,
    unrestricted: principal.baseRole === 'owner',
    permissions: principal.baseRole === 'owner'
      ? [...ALL_PERMISSIONS]
      : [...principal.permissions].sort()
  };
}
