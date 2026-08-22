/**
 * Phase 17 — role-definition cache.
 *
 * MEASURED FIRST, as the brief requires. `resolvePrincipal()` costs
 * ~0.64 ms/call against the in-memory replica set (2,000 warmed calls),
 * i.e. ~1,565 resolutions/sec/process. There is no performance crisis here,
 * so the design question was "what can be cached without ever serving stale
 * authorisation", not "how fast can this go".
 *
 * WHAT IS NOT CACHED, AND WHY
 * ---------------------------
 * The `User` document is read on EVERY request, always. It carries the four
 * facts that decide whether a session is still valid at all: `active`,
 * `rider.active`, `role` and `sessionVersion`. An earlier revision of this
 * file cached the whole resolved principal behind a 5-second TTL. That was
 * abandoned after it was PROVEN unsafe: deactivating a manager with a direct
 * database write left their existing token returning 200 for the remainder of
 * the TTL, which silently reintroduced exactly the defect Phase 20 fixed.
 *
 * Explicit invalidation cannot rescue that design, because authorisation state
 * legitimately changes out of band — a second API instance, a migration
 * script, an operator in the mongo shell. A cache that is only correct when
 * every writer remembers to call it is not a safe authorisation cache.
 *
 * WHAT IS CACHED
 * --------------
 * Only the `Role` DOCUMENT: the permission bundle belonging to a custom role,
 * keyed by `restaurantId:roleKey`. This is safe in a way user state is not:
 *
 *   • it is the SECOND query a custom-role request makes, so caching it halves
 *     that request's database work while the user lookup still happens;
 *   • a role definition changes rarely, and only through `roles.js`, which
 *     invalidates here on every write;
 *   • a stale role bundle cannot resurrect a deactivated, demoted or
 *     signed-out account, because those are all decided from the live user
 *     row before this cache is ever consulted;
 *   • the worst case from a missed invalidation is a permission edit taking up
 *     to one short TTL to apply to holders — bounded, and the TTL is a
 *     backstop rather than the mechanism.
 *
 * Built-in roles are compiled constants and need no cache at all.
 *
 * Safety properties: short TTL (5s default), explicit invalidation on every
 * role write, bounded entry count with oldest-first eviction, defensive copies
 * so a caller cannot mutate a shared bundle, and promise coalescing so N
 * concurrent misses issue one read.
 *
 * Not distributed: each API process keeps its own map, so with several
 * instances a role edit can take up to one TTL to reach instances that did not
 * serve the write. Recorded in the README.
 */

const DEFAULT_TTL_MS = 5_000;
const DEFAULT_MAX_ENTRIES = 2_000;

export const roleCacheStats = {
  hits: 0, misses: 0, invalidations: 0, evictions: 0, coalesced: 0, expired: 0
};

export function resetRoleCacheStats() {
  for (const key of Object.keys(roleCacheStats)) roleCacheStats[key] = 0;
}

const entries = new Map();   // "restaurant:roleKey" -> {expires, value}
const inflight = new Map();

let ttlMs = Number(process.env.RBAC_ROLE_CACHE_TTL_MS || DEFAULT_TTL_MS);
let maxEntries = Number(process.env.RBAC_ROLE_CACHE_MAX || DEFAULT_MAX_ENTRIES);

export const cacheEnabled = () =>
  ttlMs > 0 && String(process.env.RBAC_ROLE_CACHE_DISABLED || '') !== 'true';

export function configureRoleCache({ttl, max} = {}) {
  if (ttl !== undefined) ttlMs = Number(ttl);
  if (max !== undefined) maxEntries = Number(max);
  entries.clear();
  inflight.clear();
}

export const roleCacheSize = () => entries.size;

const keyFor = (restaurantId, roleKey) => `${String(restaurantId)}:${String(roleKey)}`;

function evictIfNeeded() {
  while (entries.size > maxEntries) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
    roleCacheStats.evictions += 1;
  }
}

/** Never hand out the stored object: a mutated bundle would poison everyone. */
const copy = value => (value === null ? null : {...value, permissions: [...(value.permissions || [])]});

/**
 * Read a role definition through the cache.
 *
 * ONLY AN ACTIVE ROLE IS CACHED.
 *
 * A missing or deactivated role is a WITHDRAWAL of access, and withdrawal must
 * take effect immediately — the same rule that stopped user state being
 * cached. Proven necessary: with `null` cached, disabling a role by direct
 * database write left its holders authorised for the remainder of the TTL.
 * So a negative result is returned but never stored, and the next request
 * re-reads it. The cost is one query per request for a withdrawn role, which
 * is a path that should be rare and is about to 401 anyway.
 *
 * A THROWN error is never cached either: it could be a transient fault.
 */
export async function withRoleCache(restaurantId, roleKey, loader) {
  if (!cacheEnabled()) return loader();
  const key = keyFor(restaurantId, roleKey);

  const hit = entries.get(key);
  if (hit) {
    if (hit.expires > Date.now()) {
      roleCacheStats.hits += 1;
      return copy(hit.value);
    }
    entries.delete(key);
    roleCacheStats.expired += 1;
  }

  const pending = inflight.get(key);
  if (pending) {
    roleCacheStats.coalesced += 1;
    return copy(await pending);
  }

  roleCacheStats.misses += 1;
  const promise = (async () => loader())();
  inflight.set(key, promise);
  try {
    const value = await promise;
    // Cache only a live, active role. See the note above.
    if (value && value.active !== false) {
      entries.set(key, {expires: Date.now() + ttlMs, value});
      evictIfNeeded();
    }
    return copy(value);
  } finally {
    inflight.delete(key);
  }
}

export function invalidateRole(restaurantId, roleKey) {
  const key = keyFor(restaurantId, roleKey);
  const removed = entries.delete(key);
  inflight.delete(key);
  if (removed) roleCacheStats.invalidations += 1;
}

/** Drop every cached role definition. Used when a role is deleted. */
export function invalidateAllRoles() {
  const size = entries.size;
  entries.clear();
  inflight.clear();
  if (size) roleCacheStats.invalidations += size;
}

// ── compatibility shims ──────────────────────────────────────────────────────
// `sessions.js` and `roles.js` speak in terms of principals. Since user state
// is never cached, invalidating a principal is a no-op for correctness; these
// exist so callers do not have to know which half is cached, and so a future
// change of strategy has one place to edit.
export const invalidatePrincipal = () => {};
export const invalidatePrincipals = () => {};
export const invalidateAllPrincipals = invalidateAllRoles;
