import {money} from './billing.js';

// Phase 4B — POS modifiers.
// Four kinds of choice a guest can make at the till:
//   variant  — replaces the line price outright (Small / Medium / Large)
//   extra    — a priced addition that usually consumes more of an ingredient
//   addon    — a priced side or accompaniment
//   removal  — takes an ingredient out; credits stock and food cost back
export const MODIFIER_KINDS = Object.freeze(['variant', 'extra', 'addon', 'removal']);
export const MAX_SPECIAL_INSTRUCTIONS = 500;

function httpError(message, status = 400) {
  return Object.assign(new Error(message), {status});
}

const clean = value => String(value ?? '').trim();

export function normalizeInstructions(value) {
  const text = clean(value);
  if (!text) return '';
  if (text.length > MAX_SPECIAL_INSTRUCTIONS) {
    throw httpError(`Special instructions must be ${MAX_SPECIAL_INSTRUCTIONS} characters or fewer`, 400);
  }
  return text;
}

function findGroup(menuItem, groupKey) {
  const key = clean(groupKey).toLowerCase();
  const group = (menuItem.modifierGroups || []).find(g => clean(g.key).toLowerCase() === key);
  if (!group) throw httpError(`Unknown modifier group "${groupKey}" for ${menuItem.name}`, 400);
  return group;
}

function findOption(group, optionKey, menuItem) {
  const key = clean(optionKey).toLowerCase();
  const option = (group.options || []).find(o => clean(o.key).toLowerCase() === key);
  if (!option) throw httpError(`Unknown option "${optionKey}" in ${group.name} for ${menuItem.name}`, 400);
  return option;
}

/**
 * Validates a guest's selections against the menu item's modifier catalog and
 * resolves them into concrete, priced modifier records.
 *
 * Enforces per-group cardinality: required groups must be chosen, single-select
 * groups accept exactly one option, and multi-select groups honour
 * min/maxSelect. Unknown groups or options are rejected outright so a till can
 * never invent a modifier or set its own price.
 */
export function resolveModifiers({menuItem, selections = []}) {
  const groups = menuItem.modifierGroups || [];
  if (!Array.isArray(selections)) throw httpError('Modifiers must be a list', 400);
  if (selections.length && !groups.length) {
    throw httpError(`${menuItem.name} does not accept modifiers`, 400);
  }

  // Group the incoming picks so cardinality can be checked per group.
  const picked = new Map();
  for (const selection of selections) {
    const group = findGroup(menuItem, selection.group);
    const option = findOption(group, selection.option, menuItem);
    const groupKey = clean(group.key);
    const list = picked.get(groupKey) || {group, options: []};
    if (list.options.some(o => clean(o.key) === clean(option.key))) {
      throw httpError(`Duplicate option "${option.name}" in ${group.name}`, 400);
    }
    list.options.push(option);
    picked.set(groupKey, list);
  }

  for (const group of groups) {
    const entry = picked.get(clean(group.key));
    const count = entry?.options.length || 0;
    if (group.required && count === 0) {
      throw httpError(`${group.name} is required for ${menuItem.name}`, 400);
    }
    if (group.selection === 'single' && count > 1) {
      throw httpError(`${group.name} allows only one choice`, 400);
    }
    const min = Number(group.minSelect || 0);
    const max = Number(group.maxSelect || 0);
    if (count > 0 && min > 0 && count < min) {
      throw httpError(`${group.name} needs at least ${min} choices`, 400);
    }
    if (max > 0 && count > max) {
      throw httpError(`${group.name} allows at most ${max} choices`, 400);
    }
  }

  const resolved = [];
  for (const {group, options} of picked.values()) {
    for (const option of options) {
      resolved.push({
        groupKey: clean(group.key),
        groupName: group.name,
        kind: group.kind || 'extra',
        optionKey: clean(option.key),
        name: option.name,
        price: money(option.priceDelta || 0),
        priceOverride: option.priceOverride === null || option.priceOverride === undefined
          ? null
          : money(option.priceOverride),
        ingredient: option.ingredient || null,
        qty: Number(option.qty || 0),
        unit: option.unit || null,
        removed: (group.kind || 'extra') === 'removal'
      });
    }
  }
  return resolved;
}

/**
 * Applies resolved modifiers to a line's unit price.
 *
 * A variant carrying a priceOverride replaces the base price; when two variants
 * could apply, the last one wins. Every other kind adds its delta. A removal
 * may carry a negative delta to discount the line.
 */
export function applyModifierPricing({basePrice, modifiers = []}) {
  let unitPrice = Number(basePrice || 0);
  const override = modifiers.filter(m => m.kind === 'variant' && m.priceOverride !== null).pop();
  if (override) unitPrice = Number(override.priceOverride);
  const delta = modifiers.reduce((sum, m) => sum + (m.kind === 'variant' && m.priceOverride !== null ? 0 : Number(m.price || 0)), 0);
  const finalPrice = money(unitPrice + delta);
  if (finalPrice < 0) throw httpError('Modifiers cannot reduce a line below zero', 400);
  return {basePrice: money(basePrice || 0), unitPrice: finalPrice, modifierTotal: money(finalPrice - Number(basePrice || 0))};
}

/**
 * Converts resolved modifiers into signed ingredient movements for one unit of
 * the line. Extras and add-ons consume additional stock (positive); removals
 * give it back (negative). Options with no ingredient mapping are price-only.
 */
export function modifierIngredientDeltas(modifiers = []) {
  const deltas = [];
  for (const modifier of modifiers) {
    if (!modifier.ingredient || !(Number(modifier.qty) > 0)) continue;
    deltas.push({
      ingredient: modifier.ingredient,
      qty: modifier.removed ? -Number(modifier.qty) : Number(modifier.qty),
      unit: modifier.unit || null,
      name: modifier.name
    });
  }
  return deltas;
}

// Persisted shape for an order line; priceOverride is a catalog detail and is
// resolved into unitPrice, so it is not stored on the ticket.
export function toOrderModifiers(modifiers = []) {
  return modifiers.map(m => ({
    groupKey: m.groupKey,
    groupName: m.groupName,
    kind: m.kind,
    optionKey: m.optionKey,
    name: m.name,
    price: m.price,
    ingredient: m.ingredient || undefined,
    qty: m.qty || 0,
    unit: m.unit || undefined,
    removed: Boolean(m.removed)
  }));
}
