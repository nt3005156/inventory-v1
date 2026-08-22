/**
 * Phase 20 — the permission catalogue and the resolution engine.
 *
 * Before this phase authorisation was a hard-coded role list at each of ~135
 * route call sites: `auth(['owner','manager'])`. That has two problems the
 * brief asks to fix:
 *
 *   1. A restaurant cannot express "Cashier" or "Storekeeper". Every employee
 *      had to be squeezed into owner / manager / staff, so a storekeeper who
 *      needed to count stock was given `manager` and got refunds, purchasing
 *      approval and the P&L along with it.
 *   2. Nothing was configurable. Changing who may approve a purchase order
 *      meant editing and redeploying source.
 *
 * The model here is deliberately conventional: PERMISSIONS are the atoms,
 * ROLES are named bundles of permissions, and a USER holds exactly one role.
 * Permissions are never assigned to a user directly — a per-user override list
 * is how RBAC systems rot into an unauditable mess, and "why can this person
 * do that?" must always be answerable by naming their role.
 *
 * `owner` is special and stays special: it implicitly holds every permission,
 * including ones added by future phases. That is a deliberate safety property,
 * not laziness — a tenant must never be able to lock itself out of its own
 * data by mis-editing a role, and there must always be someone who can repair
 * a broken permission set.
 */

/**
 * The permission catalogue.
 *
 * Naming is `resource.action`. Each entry carries a human label and a group so
 * the management UI can render itself from this list rather than hard-coding a
 * second copy that drifts.
 */
export const PERMISSION_CATALOG = Object.freeze([
  // Orders and the till
  {key: 'orders.view', group: 'Orders', label: 'View orders'},
  {key: 'orders.create', group: 'Orders', label: 'Create and edit orders'},
  {key: 'orders.cancel', group: 'Orders', label: 'Cancel an order'},
  {key: 'orders.discount', group: 'Orders', label: 'Apply a discount'},
  // The ceiling override. Holding orders.discount lets you discount at all;
  // holding this lets you exceed the staff ceiling. Kept as a SEPARATE
  // capability rather than a role check so a Supervisor custom role can be
  // given override authority without also being made a manager.
  {key: 'orders.discountoverride', group: 'Orders', label: 'Exceed the staff discount ceiling'},
  {key: 'orders.refund', group: 'Orders', label: 'Refund a settled order'},
  {key: 'payments.take', group: 'Orders', label: 'Take payment'},
  {key: 'payments.reverse', group: 'Orders', label: 'Reverse a tender'},
  {key: 'orders.reopen', group: 'Orders', label: 'Reopen a completed order'},
  {key: 'invoices.issue', group: 'Orders', label: 'Issue and reprint tax invoices'},

  // Kitchen
  {key: 'kds.view', group: 'Kitchen', label: 'View the kitchen display'},
  {key: 'kds.advance', group: 'Kitchen', label: 'Advance an order through the kitchen'},

  // Tables and reservations
  {key: 'tables.view', group: 'Front of house', label: 'View tables'},
  {key: 'tables.manage', group: 'Front of house', label: 'Seat, move and merge tables'},
  {key: 'tables.configure', group: 'Front of house', label: 'Create, retire and audit tables'},
  {key: 'reservations.manage', group: 'Front of house', label: 'Manage reservations'},

  // Inventory
  {key: 'inventory.view', group: 'Inventory', label: 'View stock'},
  {key: 'inventory.adjust', group: 'Inventory', label: 'Adjust stock levels'},
  {key: 'inventory.count', group: 'Inventory', label: 'Perform a stock count'},
  {key: 'inventory.approve', group: 'Inventory', label: 'Approve a stock count'},
  {key: 'inventory.waste', group: 'Inventory', label: 'Record waste'},
  {key: 'inventory.requesttransfer', group: 'Inventory', label: 'Request a branch transfer'},
  {key: 'inventory.transfer', group: 'Inventory', label: 'Approve, ship and receive transfers'},

  // Purchasing
  {key: 'purchase.view', group: 'Purchasing', label: 'View purchase orders'},
  {key: 'purchase.analyse', group: 'Purchasing', label: 'Reorder planning and price intelligence'},
  {key: 'purchase.create', group: 'Purchasing', label: 'Raise a purchase order'},
  {key: 'purchase.approve', group: 'Purchasing', label: 'Approve a purchase order'},
  {key: 'purchase.receive', group: 'Purchasing', label: 'Receive goods'},
  {key: 'purchase.invoice', group: 'Purchasing', label: 'Record supplier invoices and payments'},
  {key: 'suppliers.manage', group: 'Purchasing', label: 'Manage suppliers and the catalogue'},
  {key: 'purchase.return', group: 'Purchasing', label: 'Return goods to a supplier'},
  {key: 'purchase.pay', group: 'Purchasing', label: 'Pay a supplier invoice'},
  {key: 'purchase.reversepay', group: 'Purchasing', label: 'Reverse a supplier payment'},

  // Menu and recipes
  {key: 'menu.view', group: 'Menu', label: 'View the menu and recipes'},
  {key: 'menu.manage', group: 'Menu', label: 'Manage menu items and recipes'},
  {key: 'menu.delete', group: 'Menu', label: 'Delete a menu item'},
  {key: 'ingredients.view', group: 'Menu', label: 'View ingredients'},
  {key: 'ingredients.manage', group: 'Menu', label: 'Manage ingredients'},
  {key: 'ingredients.delete', group: 'Menu', label: 'Delete an ingredient'},
  {key: 'coupons.view', group: 'Menu', label: 'View coupons'},
  {key: 'coupons.manage', group: 'Menu', label: 'Manage coupons'},
  {key: 'coupons.delete', group: 'Menu', label: 'Delete a coupon'},
  {key: 'stations.manage', group: 'Kitchen', label: 'Manage kitchen stations'},

  // Customers and delivery
  {key: 'customers.view', group: 'Customers', label: 'View customers'},
  {key: 'customers.manage', group: 'Customers', label: 'Manage customer records'},
  {key: 'customers.merge', group: 'Customers', label: 'Merge and recalculate customer records'},
  {key: 'deliveries.dispatch', group: 'Customers', label: 'Dispatch and track deliveries'},
  {key: 'deliveries.ride', group: 'Customers', label: 'Carry out assigned deliveries'},
  {key: 'riders.manage', group: 'Customers', label: 'Manage rider profiles'},
  {key: 'customers.delete', group: 'Customers', label: 'Deactivate or delete a customer'},
  {key: 'customers.loyalty', group: 'Customers', label: 'Adjust loyalty points'},
  {key: 'onlineorders.accept', group: 'Customers', label: 'Accept online orders'},
  {key: 'onlineorders.manage', group: 'Customers', label: 'Reject online orders'},

  // Money and reporting
  {key: 'dashboard.view', group: 'Reports', label: 'View the operations dashboard'},
  {key: 'reports.view', group: 'Reports', label: 'View reports and analytics'},
  {key: 'reports.export', group: 'Reports', label: 'Export data'},
  {key: 'expenses.manage', group: 'Reports', label: 'Manage expenses'},
  {key: 'monthclose.manage', group: 'Reports', label: 'Close and reopen accounting months'},
  {key: 'alerts.view', group: 'Reports', label: 'View operational alerts'},
  {key: 'alerts.manage', group: 'Reports', label: 'Acknowledge and resolve alerts'},
  {key: 'audit.view', group: 'Administration', label: 'Read the system audit log'},
  {key: 'inventory.recover', group: 'Inventory', label: 'Recover stuck stock-count locks'},

  // Administration
  {key: 'users.manage', group: 'Administration', label: 'Manage users and their access'},
  // Deliberately SEPARATE from users.manage. Provisioning an account, resetting
  // somebody's password and switching an account off are owner-only acts today
  // (POST /accounts, POST /accounts/:id/password, PATCH /accounts/:id/active).
  // Folding them into users.manage -- which managers hold -- would have handed
  // every manager the ability to mint and disable staff accounts.
  {key: 'users.create', group: 'Administration', label: 'Create staff accounts'},
  {key: 'users.password', group: 'Administration', label: 'Reset another user\'s password'},
  {key: 'users.deactivate', group: 'Administration', label: 'Activate and deactivate accounts'},
  {key: 'roles.manage', group: 'Administration', label: 'Manage roles and permissions'},
  {key: 'branches.view', group: 'Administration', label: 'See the branch list'},
  {key: 'branches.manage', group: 'Administration', label: 'Manage branches'},
  {key: 'settings.manage', group: 'Administration', label: 'Manage restaurant settings'}
]);

export const ALL_PERMISSIONS = Object.freeze(PERMISSION_CATALOG.map(entry => entry.key));
const PERMISSION_SET = new Set(ALL_PERMISSIONS);

export const isPermission = key => PERMISSION_SET.has(key);

export function assertPermissionKeys(keys) {
  const list = [...new Set((keys || []).map(key => String(key || '').trim()).filter(Boolean))];
  const unknown = list.filter(key => !PERMISSION_SET.has(key));
  if (unknown.length) {
    throw Object.assign(
      new Error(`Unknown permission(s): ${unknown.slice(0, 5).join(', ')}`),
      {status: 400}
    );
  }
  return list.sort();
}

/**
 * The four historical roles, expressed as permission bundles.
 *
 * These are the COMPATIBILITY baseline: every existing deployment has users
 * carrying one of these four strings, and their access must not change on the
 * day this phase ships. Each bundle was derived by reading what the role could
 * actually reach before Phase 20, not by writing down what it arguably should
 * have — a permission audit is a separate decision from a permission refactor.
 */
const OWNER = '*';

export const BUILTIN_ROLES = Object.freeze({
  owner: {
    key: 'owner',
    name: 'Owner',
    description: 'Unrestricted access, including roles and users.',
    baseRole: 'owner',
    permissions: OWNER
  },
  manager: {
    key: 'manager',
    name: 'Manager',
    description: 'Runs a branch: inventory, purchasing, refunds and reports.',
    baseRole: 'manager',
    permissions: Object.freeze([
      'orders.view', 'orders.create', 'orders.cancel', 'orders.discount', 'orders.refund',
      // NOT payments.reverse: POST /payments/:id/reverse has always been
      // owner-only. Phase 20 put the key in this bundle while no endpoint
      // consumed it, so it granted nothing; leaving it here while migrating
      // that endpoint would have silently handed managers tender reversal.
      'payments.take', 'invoices.issue',
      'kds.view', 'kds.advance',
      'tables.view', 'tables.manage', 'reservations.manage',
      'inventory.view', 'inventory.adjust', 'inventory.count', 'inventory.approve',
      'inventory.waste', 'inventory.transfer', 'inventory.requesttransfer',
      'purchase.view', 'purchase.create', 'purchase.approve', 'purchase.receive',
      'purchase.invoice', 'purchase.return', 'purchase.pay', 'suppliers.manage',
      'menu.view', 'menu.manage',
      'ingredients.view', 'ingredients.manage',
      'coupons.view', 'coupons.manage',
      'stations.manage',
      'customers.view', 'customers.manage', 'customers.loyalty',
      'deliveries.dispatch', 'riders.manage', 'onlineorders.manage',
      'orders.reopen',
      'alerts.view', 'alerts.manage',
      'reports.view', 'reports.export', 'expenses.manage',
      'branches.view', 'users.manage',
      'tables.configure', 'customers.merge', 'onlineorders.accept',
      'purchase.analyse', 'dashboard.view', 'orders.discountoverride'
    ])
  },
  staff: {
    key: 'staff',
    name: 'Staff',
    description: 'General floor staff: orders, payments, kitchen and stock entry.',
    baseRole: 'staff',
    permissions: Object.freeze([
      'orders.view', 'orders.create', 'orders.discount',
      'payments.take', 'invoices.issue',
      'kds.view', 'kds.advance',
      'tables.view', 'tables.manage', 'reservations.manage',
      'inventory.view', 'inventory.count', 'inventory.waste',
      'inventory.requesttransfer',
      // NOT purchase.receive: POST /purchase-orders/:id/receive has always
      // been owner/manager. Phase 20 listed the key in this bundle while no
      // endpoint consumed it, so it granted nothing. Migrating that endpoint
      // would have made the latent mistake live and handed every staff member
      // goods receipt, which posts stock AND supplier liability.
      'purchase.view',
      'menu.view', 'ingredients.view', 'coupons.view',
      'alerts.view',
      'customers.view', 'customers.manage',
      'deliveries.dispatch', 'onlineorders.accept',
      'branches.view', 'dashboard.view'
    ])
  },
  rider: {
    key: 'rider',
    name: 'Rider',
    description: 'Delivery courier. Sees only their own assigned deliveries.',
    baseRole: 'rider',
    permissions: Object.freeze(['deliveries.ride'])
  }
});

export const BUILTIN_ROLE_KEYS = Object.freeze(Object.keys(BUILTIN_ROLES));

/**
 * Role templates the brief names, offered when a tenant creates a role.
 *
 * These are SUGGESTIONS the owner can edit, not additional built-ins. Shipping
 * them as templates rather than as fixed roles is the difference between
 * "configurable permissions" and "four more hard-coded roles".
 */
export const ROLE_TEMPLATES = Object.freeze([
  {
    key: 'cashier',
    name: 'Cashier',
    baseRole: 'staff',
    description: 'Runs the till: takes orders and payment, nothing else.',
    permissions: Object.freeze([
      'orders.view', 'orders.create', 'payments.take', 'invoices.issue', 'menu.view', 'customers.view'
    ])
  },
  {
    key: 'kitchen',
    name: 'Kitchen',
    baseRole: 'staff',
    description: 'Kitchen display only.',
    permissions: Object.freeze(['kds.view', 'kds.advance', 'orders.view', 'menu.view'])
  },
  {
    key: 'storekeeper',
    name: 'Storekeeper',
    baseRole: 'staff',
    description: 'Stock: counts, waste, adjustments and goods receipt.',
    permissions: Object.freeze([
      'inventory.view', 'inventory.count', 'inventory.waste', 'inventory.adjust',
      'purchase.view', 'purchase.receive'
    ])
  },
  {
    key: 'supervisor',
    name: 'Supervisor',
    baseRole: 'manager',
    description: 'Shift lead: the till plus refunds and discounts.',
    permissions: Object.freeze([
      'orders.view', 'orders.create', 'orders.cancel', 'orders.discount', 'orders.refund',
      'payments.take', 'payments.reverse', 'invoices.issue',
      'kds.view', 'kds.advance', 'tables.view', 'tables.manage',
      'inventory.view', 'menu.view', 'customers.view', 'reports.view'
    ])
  }
]);

/** Legacy role strings the rest of the codebase still reasons about. */
export const BASE_ROLES = Object.freeze(['owner', 'manager', 'staff', 'rider']);

export function permissionsForBuiltin(roleKey) {
  const role = BUILTIN_ROLES[roleKey];
  if (!role) return [];
  return role.permissions === OWNER ? [...ALL_PERMISSIONS] : [...role.permissions];
}

/**
 * Does a resolved principal hold a permission?
 *
 * An owner holds everything by construction, so a permission added in a later
 * phase is granted to owners without a migration.
 */
export function grants(resolved, permission) {
  if (!resolved) return false;
  if (resolved.baseRole === 'owner') return true;
  return resolved.permissions.has(permission);
}

export function grantsAny(resolved, permissions) {
  return permissions.some(permission => grants(resolved, permission));
}
