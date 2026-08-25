/**
 * P2D.1 — THE canonical serialisation contract for audit hashing.
 *
 * ONE implementation, used by audit creation, audit verification and the
 * verification tooling. Duplicating it is how the three drift apart and a
 * chain starts reporting phantom tampering — which is precisely the defect
 * this module exists to fix.
 *
 * ── THE DEFECT THIS REPLACES ────────────────────────────────────────────────
 * The previous canonicaliser mapped BOTH `null` and `undefined` to `null`:
 *
 *     if (value === null || value === undefined) return null;
 *
 * Two independent problems followed.
 *
 * 1. FALSE TAMPER ALARMS. The hash is computed on the PRE-WRITE Mongoose
 *    document, inside `pre('validate')`. MongoDB then OMITS keys whose value
 *    is `undefined`. Verification re-reads the stored row, which no longer has
 *    those keys, and recomputes a different hash. Reproduced:
 *
 *        hash stamped at write : 69c37432a8ba3eb9
 *        hash recomputed stored: 8dee8272f80920d8
 *        stored before keys    : ['name','pan']   // slug, legalName dropped
 *
 *    `verifyAuditChain()` reported `type: 'content'` — the signature of a
 *    tampered row. Nothing was tampered with. A tamper-evidence mechanism that
 *    cries wolf trains investigators to ignore it, so this is a real integrity
 *    failure even though no data was altered.
 *
 * 2. SEMANTIC COLLISION. `{a: undefined}` and `{a: null}` hashed identically,
 *    so "not supplied" and "explicitly cleared" were indistinguishable. The
 *    brief forbids exactly this.
 *
 * ── THE CONTRACT ────────────────────────────────────────────────────────────
 * HASH WHAT WILL BE STORED, NOT WHAT WAS PASSED IN.
 *
 * The stored document is the artefact the chain protects, so the hash must be
 * a function of it. A key whose value is `undefined` will not exist after the
 * write, so it is DROPPED before hashing — the hashed shape then equals the
 * stored shape by construction, and the round trip is stable.
 *
 * That leaves `undefined` and `null` distinguishable, because an explicit
 * `null` IS stored:
 *
 *     {a: undefined}  ->  {}            (key absent, as MongoDB will store it)
 *     {a: null}       ->  {"a":null}    (key present with a null value)
 *     {}              ->  {}            (identical to the undefined case —
 *                                        correct, because they store identically)
 *
 * `{a: undefined}` and `{}` collapsing together is not the collision the brief
 * warns about; it is the *truth*, since MongoDB cannot represent a difference
 * between them. What matters is that neither collides with an explicit `null`.
 *
 * ARRAYS keep `undefined` as `null`, because that is what MongoDB stores in an
 * array — dropping the element would change the length and the indices of
 * everything after it. The array case and the object case therefore differ
 * deliberately, each mirroring how the database actually behaves.
 *
 * ── VERSIONING ──────────────────────────────────────────────────────────────
 * Rows written before this change used the old rules and cannot be re-hashed
 * without inventing the keys MongoDB discarded (proven impossible — see
 * P2D.1-AUDIT.md §5). They are therefore not "broken"; they are a different
 * format. `AUDIT_HASH_VERSION` lets verification say "legacy canonicalisation"
 * instead of "tampered", which is the difference between an accurate report
 * and a misleading one.
 */

/**
 * Bumped whenever the canonical form changes.
 *
 * v1 — the original: undefined and null both became null; undefined keys were
 *      hashed but not stored.
 * v2 — P2D.1: undefined keys are dropped before hashing, so the hashed shape
 *      matches the stored shape; explicit null is preserved and distinct.
 */
export const AUDIT_HASH_VERSION = 2;

/**
 * Depth cap. `before`/`after` are Mixed and callers put whatever they have in
 * them, including hydrated Mongoose documents with self-referencing internals.
 * Retained from the original implementation, which was added after a stack
 * overflow took down every supplier-invoice write.
 */
export const MAX_CANONICAL_DEPTH = 12;

/** Mongoose/BSON internals that must never contribute to a hash. */
const INTERNAL_KEYS = new Set(['__parentArray', '__index', '__v']);

function isInternalKey(key) {
  return key.startsWith('$') || INTERNAL_KEYS.has(key);
}

/**
 * Canonicalise one value.
 *
 * Returns the sentinel `OMIT` for a value that will not be stored, so the
 * caller can drop the key entirely rather than emitting a null for it.
 */
const OMIT = Symbol('omit');

function canonicalise(value, seen, depth) {
  // A key whose value is undefined will NOT exist in MongoDB, so it must not
  // exist in the hashed payload either.
  if (value === undefined) return OMIT;
  if (value === null) return null;

  if (depth > MAX_CANONICAL_DEPTH) return '[depth]';

  // Dates before the generic object branch: a Date IS an object.
  if (value instanceof Date) {
    // An invalid Date must not hash as the string "Invalid Date", which would
    // be indistinguishable from a user supplying that literal text.
    return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
  }

  if (typeof value === 'object') {
    // A hydrated document or subdocument: reduce it to its plain form first,
    // or two logically identical rows hash differently depending on whether
    // the caller passed a document or a POJO.
    if (typeof value.toObject === 'function') {
      try {
        value = value.toObject({depopulate: true, virtuals: false});
      } catch {
        return String(value);
      }
    } else if (value._bsontype) {
      // ObjectId, Decimal128, Long — stringify rather than walk their guts.
      return String(value);
    }

    if (value === null) return null;
    if (typeof value !== 'object') return canonicalise(value, seen, depth);
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? '[invalid-date]' : value.toISOString();
    }
    if (seen.has(value)) return '[circular]';

    seen.add(value);
    let result;
    if (Array.isArray(value)) {
      /**
       * Arrays keep `undefined` as `null`.
       *
       * MongoDB stores a sparse/undefined array element as null; it does not
       * remove it. Dropping the element here would change the length and shift
       * every subsequent index, so the hashed shape would stop matching the
       * stored shape — the very bug being fixed, reintroduced in the array
       * case. Order is preserved.
       */
      result = value.map(item => {
        const canonical = canonicalise(item, seen, depth + 1);
        return canonical === OMIT ? null : canonical;
      });
    } else {
      // Keys sorted, so insertion order cannot change a hash.
      result = {};
      for (const key of Object.keys(value).sort()) {
        if (isInternalKey(key)) continue;
        const canonical = canonicalise(value[key], seen, depth + 1);
        // THE FIX: an undefined value means the key will not be stored, so it
        // is not hashed either.
        if (canonical === OMIT) continue;
        result[key] = canonical;
      }
    }
    seen.delete(value);
    return result;
  }

  // Primitives. NaN and ±Infinity are not representable in JSON and would
  // silently become null, so they are named explicitly instead.
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return `[number:${String(value)}]`;
  }
  return value;
}

/**
 * Canonicalise a whole value for hashing. Exported for tests and tooling.
 * A top-level `undefined` becomes `null`, since there is no key to drop.
 */
export function canonicaliseValue(value) {
  const seen = new WeakSet();
  const result = canonicalise(value, seen, 0);
  return result === OMIT ? null : result;
}

/**
 * The exact set of fields the hash covers, in a fixed order.
 *
 * Fixed rather than derived from the object, because `JSON.stringify` follows
 * insertion order and two logically identical rows must produce byte-identical
 * payloads.
 *
 * `hash`, `prevHash` and `hashVersion` are deliberately NOT covered: the first
 * two are outputs, and the third is metadata about the format rather than
 * about the event. `prevHash` binds into the chain through `auditHash()`.
 */
export function canonicalAuditPayload(row) {
  const seen = new WeakSet();
  /**
   * The WHOLE wrapper is canonicalised, not just `before`/`after`.
   *
   * My first version walked only the two Mixed fields and let `JSON.stringify`
   * emit the wrapper in insertion order. v1 canonicalised the whole object, so
   * its keys came out SORTED — meaning v1 and v2 differed on every row, even
   * ones with no `undefined` anywhere, and legacy detection could never match.
   * Caught by the test asserting the two formats agree when nothing is
   * undefined.
   */
  const walk = value => {
    const canonical = canonicalise(value, seen, 0);
    return canonical === OMIT ? null : canonical;
  };

  return JSON.stringify(walk({
    entity: row.entity ?? null,
    entityId: row.entityId ? String(row.entityId) : null,
    restaurant: row.restaurant ? String(row.restaurant) : null,
    branch: row.branch ? String(row.branch) : null,
    action: row.action ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason ?? null,
    user: row.user ? String(row.user) : null,
    userName: row.userName ?? null,
    userRole: row.userRole ?? null,
    ip: row.ip ?? null,
    reference: row.reference ?? null,
    at: row.at instanceof Date ? row.at.toISOString() : row.at ?? null,
    sequence: row.sequence ?? null
  }));
}

/**
 * The v1 payload, preserved EXACTLY as it was.
 *
 * Needed so verification can recognise a pre-P2D.1 row and report it as
 * "legacy canonicalisation" rather than as tampering. It is never used to
 * write a new row.
 *
 * Kept as its own function rather than a flag inside the v2 walker: a shared
 * function with a version branch is one careless edit away from changing the
 * v1 output, which would retroactively invalidate every historical row.
 */
function canonicaliseV1(value, seen, depth) {
  if (value === null || value === undefined) return null;
  if (depth > MAX_CANONICAL_DEPTH) return '[depth]';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (typeof value.toObject === 'function') {
      try { value = value.toObject({depopulate: true, virtuals: false}); } catch { return String(value); }
    } else if (typeof value.toJSON === 'function' && value._bsontype) {
      return String(value);
    }
    if (value === null) return null;
    if (typeof value !== 'object') return value;
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const result = Array.isArray(value)
      ? value.map(item => canonicaliseV1(item, seen, depth + 1))
      : Object.keys(value).sort().reduce((acc, key) => {
        if (key.startsWith('$') || key === '__parentArray' || key === '__index') return acc;
        acc[key] = canonicaliseV1(value[key], seen, depth + 1);
        return acc;
      }, {});
    seen.delete(value);
    return result;
  }
  return value;
}

export function legacyAuditPayloadV1(row) {
  const seen = new WeakSet();
  const walk = value => canonicaliseV1(value, seen, 0);
  return JSON.stringify(walk({
    entity: row.entity ?? null,
    entityId: row.entityId ? String(row.entityId) : null,
    restaurant: row.restaurant ? String(row.restaurant) : null,
    branch: row.branch ? String(row.branch) : null,
    action: row.action ?? null,
    before: row.before ?? null,
    after: row.after ?? null,
    reason: row.reason ?? null,
    user: row.user ? String(row.user) : null,
    userName: row.userName ?? null,
    userRole: row.userRole ?? null,
    ip: row.ip ?? null,
    reference: row.reference ?? null,
    at: row.at instanceof Date ? row.at.toISOString() : row.at ?? null,
    sequence: row.sequence ?? null
  }));
}

/**
 * The payload for a given hash version. One dispatch point, so creation,
 * verification and tooling cannot disagree about which rules apply to a row.
 */
export function auditPayloadForVersion(row, version) {
  return Number(version) >= 2 ? canonicalAuditPayload(row) : legacyAuditPayloadV1(row);
}
