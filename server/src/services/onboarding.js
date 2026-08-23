/**
 * Phase 24 — new-restaurant onboarding.
 *
 * The brief's chain:
 *
 *   Restaurant -> Branch -> Users -> Ingredients -> Suppliers -> Menu -> Tables
 *
 * WHY THIS EXISTS. Every one of those steps already had a working endpoint,
 * but nothing sequenced them and nothing enforced the ORDER. That order is not
 * decorative: a menu item's recipe references ingredients, an ingredient's
 * supplier link references a supplier, a user references a branch, and a
 * branch references a restaurant. Attempting them out of order produces either
 * a dangling reference or an unhelpful validation error three screens later.
 *
 * WHAT THIS IS NOT. It is not a second way to create these entities. Steps
 * that already have a hardened service go through it — accounts are created by
 * `createStaffAccount()` so the password policy, the tenant pin and the safe
 * projection all still apply. Nothing here re-implements authorisation.
 *
 * THE FIRST STEP IS DIFFERENT. Creating the restaurant and its first owner is
 * a BOOTSTRAP: by definition there is no authenticated principal inside the
 * new tenant yet. That path is therefore NOT exposed as an open HTTP endpoint
 * — it would let anybody mint a tenant. It is called by the seed script and by
 * `provisionRestaurant()` below, which the CLI uses. Every subsequent step
 * requires an authenticated caller and is scoped to their own tenant.
 */
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {Audit, Ingredient, MenuItem, Supplier, User} from '../models/index.js';
import {Branch, Restaurant, RestaurantTable} from '../models/operations.js';
import {userRestaurantContext} from './supplierCatalog.js';
import {assertTenantBranchAccess} from './kitchen.js';
import {assertPasswordPolicy, createStaffAccount, publicUserView} from './staffAccounts.js';

const clean = value => String(value ?? '').trim();

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

/**
 * The canonical order. Exported so the API, the CLI and the tests all describe
 * the same sequence instead of three drifting copies.
 */
export const ONBOARDING_STEPS = Object.freeze([
  {key: 'restaurant', label: 'Restaurant', requires: null},
  {key: 'branch', label: 'Branch', requires: 'restaurant'},
  {key: 'users', label: 'Users', requires: 'branch'},
  {key: 'ingredients', label: 'Ingredients', requires: 'branch'},
  {key: 'suppliers', label: 'Suppliers', requires: 'branch'},
  {key: 'menu', label: 'Menu', requires: 'ingredients'},
  {key: 'tables', label: 'Tables', requires: 'branch'}
]);

export const ONBOARDING_STEP_KEYS = Object.freeze(ONBOARDING_STEPS.map(s => s.key));

// ── step 1: bootstrap (restaurant + first owner) ─────────────────────────────

/**
 * Create a restaurant and its FIRST owner.
 *
 * Bootstrap only. There is no authenticated principal in a tenant that does
 * not exist yet, so this cannot be permission-guarded in the usual way and is
 * deliberately not mounted as an open route — see the module note.
 *
 * The owner password goes through the SAME policy as every other account
 * (`assertPasswordPolicy`), so a bootstrap cannot quietly create the one
 * account in the system with a weak credential.
 */
export async function provisionRestaurant({restaurant, owner}) {
  const name = clean(restaurant?.name);
  if (name.length < 2) throw httpError('A restaurant name is required', 400);

  const ownerEmail = clean(owner?.email).toLowerCase();
  if (!ownerEmail) throw httpError('An owner email is required', 400);
  const ownerName = clean(owner?.name) || 'Owner';
  const password = assertPasswordPolicy(owner?.password);

  if (await User.findOne({email: ownerEmail})) {
    throw httpError('An account with that email already exists', 409);
  }

  const created = await Restaurant.create({
    name,
    currency: restaurant?.currency || 'NPR',
    vatRate: restaurant?.vatRate ?? 13,
    address: clean(restaurant?.address) || undefined,
    phone: clean(restaurant?.phone) || undefined,
    pan: clean(restaurant?.pan) || undefined,
    receiptFooter: clean(restaurant?.receiptFooter) || undefined
  });

  const ownerUser = await User.create({
    name: ownerName,
    email: ownerEmail,
    password: await bcrypt.hash(password, 12),
    role: 'owner',
    restaurant: created.name,
    restaurantId: created._id
  });

  await Audit.create({
    entity: 'restaurant', entityId: created._id, restaurant: created._id,
    action: 'restaurant_provisioned',
    after: {name: created.name, owner: ownerEmail},
    user: ownerUser._id
  });

  return {restaurant: created, owner: publicUserView(ownerUser)};
}

// ── step 2: branch ───────────────────────────────────────────────────────────

/**
 * Add a branch to the CALLER'S restaurant.
 *
 * The tenant comes from the authenticated principal. A `restaurant` in the
 * payload is refused rather than honoured — the raw `POST /branches` endpoint
 * used to take it from the body, which let an owner plant a branch inside
 * another restaurant (reproduced by probe, fixed in the same change).
 */
export async function addBranch({user, input}) {
  const {restaurantId} = await userRestaurantContext(user);
  const name = clean(input?.name);
  const code = clean(input?.code).toUpperCase();
  if (name.length < 2) throw httpError('A branch name is required', 400);
  if (code.length < 2) throw httpError('A branch code is required', 400);

  // A malformed id is a validation fault; a well-formed id belonging to another
  // tenant is a permission fault. They are answered differently on purpose.
  if (input?.restaurant !== undefined && !mongoose.isValidObjectId(input.restaurant)) {
    throw httpError('Invalid restaurant', 400);
  }
  if (input?.restaurant && String(input.restaurant) !== String(restaurantId)) {
    throw httpError('A branch can only be created in your own restaurant', 403);
  }
  // Branch codes appear in PO and invoice numbers, so a duplicate inside one
  // tenant would make two branches share a document sequence.
  if (await Branch.findOne({restaurant: restaurantId, code})) {
    throw httpError('A branch with that code already exists', 409);
  }

  const branch = await Branch.create({
    restaurant: restaurantId,
    name,
    code,
    address: clean(input?.address) || undefined,
    phone: clean(input?.phone) || undefined
  });

  await Audit.create({
    entity: 'branch', entityId: branch._id, restaurant: restaurantId, branch: branch._id,
    action: 'branch_created', after: {name, code}, user: user.id
  });
  return branch;
}

// ── step 3: users ────────────────────────────────────────────────────────────

/**
 * Provision the opening team. Delegates every account to
 * `createStaffAccount()`, so the password policy, the tenant pin, the branch
 * check and the safe projection are the existing hardened ones.
 */
export async function addTeam({user, members}) {
  if (!Array.isArray(members) || !members.length) {
    throw httpError('At least one team member is required', 400);
  }
  if (members.length > 50) throw httpError('Too many accounts in one request', 400);

  const created = [];
  for (const member of members) {
    created.push(await createStaffAccount({user, input: member}));
  }
  return created;
}

// ── step 4: ingredients ──────────────────────────────────────────────────────

export async function addIngredients({user, items}) {
  const {restaurantId} = await userRestaurantContext(user);
  if (!Array.isArray(items) || !items.length) {
    throw httpError('At least one ingredient is required', 400);
  }
  if (items.length > 500) throw httpError('Too many ingredients in one request', 400);

  const docs = [];
  for (const item of items) {
    const name = clean(item?.name);
    if (!name) throw httpError('Every ingredient needs a name', 400);
    const code = clean(item?.code).toUpperCase() || undefined;
    if (code && await Ingredient.findOne({restaurant: restaurantId, code})) {
      throw httpError(`Ingredient code ${code} is already in use`, 409);
    }
    docs.push(await Ingredient.create({
      restaurant: restaurantId,
      code,
      name,
      nameNp: clean(item?.nameNp) || undefined,
      category: clean(item?.category) || 'other',
      unit: clean(item?.unit).toLowerCase() || 'g',
      minimumStock: Number(item?.minimumStock || 0),
      reorderQty: Number(item?.reorderQty || 0),
      reorderLevel: Number(item?.reorderLevel || 0),
      lastPurchasePrice: Number(item?.lastPurchasePrice || 0),
      shelfLifeDays: item?.shelfLifeDays ?? undefined,
      storage: clean(item?.storage) || undefined
    }));
  }
  return docs;
}

// ── step 5: suppliers ────────────────────────────────────────────────────────

export async function addSuppliers({user, items}) {
  const {restaurantId} = await userRestaurantContext(user);
  if (!Array.isArray(items) || !items.length) {
    throw httpError('At least one supplier is required', 400);
  }
  if (items.length > 200) throw httpError('Too many suppliers in one request', 400);

  const docs = [];
  for (const item of items) {
    const name = clean(item?.name);
    if (name.length < 2) throw httpError('Every supplier needs a name', 400);
    docs.push(await Supplier.create({
      restaurant: restaurantId,
      name,
      contact: clean(item?.contact) || undefined,
      email: clean(item?.email).toLowerCase() || undefined,
      address: clean(item?.address) || undefined,
      paymentTerms: clean(item?.paymentTerms) || undefined
    }));
  }
  return docs;
}

// ── step 6: menu ─────────────────────────────────────────────────────────────

/**
 * Menu items, with recipes resolved against the tenant's OWN ingredients.
 *
 * A recipe line naming an ingredient from another restaurant is refused. That
 * is the step-order rule made enforceable: the menu cannot be built before the
 * ingredients exist, and it cannot reach outside the tenant to find them.
 */
export async function addMenu({user, items}) {
  const {restaurantId} = await userRestaurantContext(user);
  if (!Array.isArray(items) || !items.length) {
    throw httpError('At least one menu item is required', 400);
  }
  if (items.length > 500) throw httpError('Too many menu items in one request', 400);

  const docs = [];
  for (const item of items) {
    const name = clean(item?.name);
    if (!name) throw httpError('Every menu item needs a name', 400);
    const price = Number(item?.price);
    if (!(price > 0)) throw httpError(`Menu item ${name} needs a price`, 400);

    const recipe = [];
    for (const line of item?.recipe || []) {
      if (!mongoose.isValidObjectId(line?.ingredient)) {
        throw httpError(`Invalid recipe ingredient on ${name}`, 400);
      }
      const ingredient = await Ingredient.findOne({
        _id: line.ingredient, restaurant: restaurantId
      }).select('unit').lean();
      // Cross-tenant recipe references are the reason this is checked here and
      // not left to the schema: the ref would happily store a foreign id.
      if (!ingredient) throw httpError(`Recipe ingredient not found for ${name}`, 404);
      const qty = Number(line.qty);
      if (!(qty > 0)) throw httpError(`Recipe quantity must be positive on ${name}`, 400);
      recipe.push({ingredient: ingredient._id, qty, unit: clean(line.unit) || ingredient.unit});
    }

    docs.push(await MenuItem.create({
      restaurant: restaurantId,
      name,
      nameNp: clean(item?.nameNp) || undefined,
      code: clean(item?.code).toUpperCase() || undefined,
      category: clean(item?.category) || 'main',
      price,
      vatInclusive: item?.vatInclusive !== false,
      packagingCost: Number(item?.packagingCost || 0),
      prepMinutes: Number(item?.prepMinutes || 0),
      station: clean(item?.station).toLowerCase() || undefined,
      recipe
    }));
  }
  return docs;
}

// ── step 7: tables ───────────────────────────────────────────────────────────

export async function addTables({user, branchId, items}) {
  await assertTenantBranchAccess(user, branchId);
  if (!Array.isArray(items) || !items.length) {
    throw httpError('At least one table is required', 400);
  }
  if (items.length > 200) throw httpError('Too many tables in one request', 400);

  const docs = [];
  for (const item of items) {
    const name = clean(item?.name);
    if (!name) throw httpError('Every table needs a name', 400);
    if (await RestaurantTable.findOne({branch: branchId, name})) {
      throw httpError(`Table ${name} already exists in this branch`, 409);
    }
    docs.push(await RestaurantTable.create({
      branch: branchId,
      name,
      area: clean(item?.area) || undefined,
      seats: Number(item?.seats || 4)
    }));
  }
  return docs;
}

// ── progress ─────────────────────────────────────────────────────────────────

/**
 * What the tenant has done so far, in the brief's order.
 *
 * Read-only and derived by counting, so it cannot drift from reality the way a
 * stored "onboarding_state" flag would. `blocked` names the prerequisite that
 * is missing, which is what makes the ORDER visible in the UI rather than
 * merely implied.
 */
export async function onboardingStatus({user}) {
  const {restaurantId} = await userRestaurantContext(user);
  const branchIds = await Branch.find({restaurant: restaurantId}).distinct('_id');

  const counts = {
    restaurant: await Restaurant.countDocuments({_id: restaurantId}),
    branch: branchIds.length,
    users: await User.countDocuments({restaurantId, role: {$ne: 'owner'}}),
    ingredients: await Ingredient.countDocuments({restaurant: restaurantId}),
    suppliers: await Supplier.countDocuments({restaurant: restaurantId}),
    menu: await MenuItem.countDocuments({restaurant: restaurantId}),
    tables: branchIds.length ? await RestaurantTable.countDocuments({branch: {$in: branchIds}}) : 0
  };

  const done = key => counts[key] > 0;
  const steps = ONBOARDING_STEPS.map(step => ({
    key: step.key,
    label: step.label,
    requires: step.requires,
    count: counts[step.key],
    complete: done(step.key),
    // A step is blocked while its prerequisite is unmet. This is the chain.
    blocked: Boolean(step.requires) && !done(step.requires)
  }));

  return {
    steps,
    complete: steps.every(step => step.complete),
    nextStep: steps.find(step => !step.complete && !step.blocked)?.key || null
  };
}
