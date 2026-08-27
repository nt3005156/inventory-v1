# P2F-AUDIT — completing the entitlement and quota system

**AUDIT ONLY. No implementation has been performed.**

Read-only investigation of commit `f78e02a`. Every claim below was produced by
a probe script or a grep against the working tree, not by reading alone.

---

## A. Atomic quota enforcement — 2 of 6 paths still raceable

### Current state

| Resource | Limit key | Guard | Atomic? |
|---|---|---|---|
| branches | `maxBranches` | `createBranchWithinQuota()` | ✅ conditional write |
| tables | `maxTables` | `createTableWithinQuota()` | ✅ conditional write |
| customers | `maxCustomers` | `withQuota()` in `createCustomer` | ✅ conditional write |
| **users** | `maxUsers`, `maxManagers`, `maxStaff`, `maxRiders` | `assertWithinLimit()` | ❌ **check-then-act** |
| **menu items** | `maxMenuItems` | `assertWithinLimit()` | ❌ **check-then-act** |
| stations | `maxStations` | *none* | ❌ **unenforced** |

### Measured, not assumed

```
=== USERS: limit=2, 1 owner exists, 6 concurrent staff creates ===
  fulfilled: 6 | users now: 7 -> BYPASSED

=== MENU ITEMS: limit=2, 6 concurrent creates ===
  fulfilled: 6 | menu items now: 6 -> BYPASSED
```

A tenant on a 2-user plan can hold 7 users by opening tabs. Same pattern P2E
fixed for branches; two paths were left behind.

### Complication found: `quotaGuard` cannot join a transaction

`reserveQuota()` / `withQuota()` accept **no `session` parameter**. Station
creation (`routes/stations.js:53`) already runs inside
`session.withTransaction()`. Reserving quota outside that transaction means a
rolled-back station leaves a consumed reservation until the next
reconciliation.

Not fatal — the counter self-heals via reconciliation — but it must be a
deliberate decision, and `withQuota` should accept an optional session so the
reservation can participate where a transaction already exists.

### Per-role interaction

`staffAccounts` checks `maxUsers` **and** a per-role key (`maxManagers` /
`maxStaff` / `maxRiders`). Atomic enforcement needs **two** reservations that
must both succeed or both release — a compound case the current single-resource
`withQuota()` does not express.

---

## B. Remaining quota types

### `maxStations` — declared, no usage counter at all

`getUsageSummary()` returns `maxStations: null` with the comment "not yet
metered". `KitchenStation` is tenant-scoped (`restaurant` + unique
`{restaurant, code}`), so counting is straightforward.

**Definition question to settle:** does an *inactive* station consume quota?
Precedent from P2C users: deactivated accounts **do** count, because otherwise
a tenant cycles `active` to get unlimited seats. Recommend the same rule and
state it.

### `maxMonthlyOrders` / `maxMonthlyOnlineOrders` — counted, never enforced

`getOrderUsage()` and `getOnlineOrderUsage()` exist and are correct in shape,
but **nothing calls `assertWithinLimit()` with them**.

Two defects in the counting itself:

**1. Timezone is hardcoded.**

```js
export async function getOrderUsage(restaurantId, {now = new Date(), offsetMinutes = 345} = {})
```

`345` is +05:45 (Kathmandu), hardcoded — while `Restaurant.timezone` exists and
defaults to `Asia/Kathmandu`. The brief explicitly forbids this: *"Do not
silently use server UTC if tenant timezone is already available."* Today it is
not UTC, it is *Nepal for everyone*, which is the same class of error for any
tenant outside Nepal.

**2. Cancelled orders count toward the quota.**

No status filter. A tenant whose staff mis-key and void 40 orders burns 40
units of their monthly allowance. The brief: *"Do not count failed/rejected
operations incorrectly."*

**Definition to settle:** which statuses count. Recommend excluding
`cancelled`, and counting `draft` only once confirmed — to be stated explicitly
in the implementation, not inferred.

### Index gap, measured

```
monthly order count  -> IXSCAN restaurant_1
monthly ONLINE count -> IXSCAN restaurant_1
```

Only the single-field `restaurant_1` index is used: Mongo fetches **every order
for the tenant** and filters the date range in memory. Fine at 100 orders,
not at 100 restaurants × 25,000 orders/month. A compound
`{restaurant, createdAt}` (and `{restaurant, source, createdAt}`) is needed —
and quota checks run on the **order-creation hot path**, so this is a
correctness-of-performance issue, not a nicety.

---

## C. Feature gates — 3 catalogued, 15 not

```
FEATURE_KEYS (18): pos, inventory, purchasing, kds, tables, delivery,
                   onlineOrdering, reservations, advancedReports, loyalty,
                   supplierPerformance, reorderAutomation, multiBranch,
                   advancedAccounting, apiAccess, advancedBranding,
                   whiteLabel, customDomain
CATALOGUED    (3): onlineOrdering, loyalty, apiAccess
ENFORCED      (2): onlineOrdering, loyalty
```

**Correction to the naive reading:** `advancedBranding`, `whiteLabel` and
`customDomain` are *not* ungated — P2D enforces them in `services/branding.js`
through its own tier mechanism. They are simply not in `featureCatalogue.js`.
That is a **consistency gap**, not a security gap: two enforcement mechanisms
exist for feature flags, and a reader cannot tell from the catalogue which
features are protected.

### Classification of all 18

| Feature | Real surface exists | Enforced | Classification |
|---|---|---|---|
| `onlineOrdering` | ✅ | ✅ P2E | implemented + enforced |
| `loyalty` | ✅ (minimal) | ✅ P2E | implemented + enforced |
| `advancedBranding` | ✅ | ✅ P2D (separate path) | enforced, **not catalogued** |
| `whiteLabel` | ✅ | ✅ P2D (separate path) | enforced, **not catalogued** |
| `customDomain` | ✅ | ✅ P2D (separate path) | enforced, **not catalogued** |
| `delivery` | ✅ 2 files | ❌ | implemented + **not enforced** |
| `reservations` | ✅ 2 files | ❌ | implemented + **not enforced** |
| `purchasing` | ✅ 2 files | ❌ | implemented + **not enforced** |
| `kds` | ✅ 2 files | ❌ | implemented + **not enforced** |
| `tables` | ✅ 2 files | ❌ | implemented + **not enforced** |
| `supplierPerformance` | ✅ | ❌ | implemented + **not enforced** |
| `reorderAutomation` | ✅ | ❌ | implemented + **not enforced** |
| `advancedAccounting` | ✅ 3 files | ❌ | implemented + **not enforced** |
| `advancedReports` | ✅ | ❌ | implemented + **not enforced** |
| `multiBranch` | ✅ | ❌ (overlaps `maxBranches`) | **redundant with a limit** |
| `pos` | ✅ | ❌ | **intentionally ungated** — see below |
| `inventory` | ✅ | ❌ | **intentionally ungated** — see below |
| `apiAccess` | ❌ **none** | n/a | declared, not implemented |

### A commercial judgement the audit must flag, not decide

`pos` and `inventory` appear in the Starter plan as `true`. Gating them would
mean a lapsed subscription stops a restaurant taking money at the till. That is
a **business decision about how aggressively to enforce non-payment**, not an
engineering one. Recommend: leave `pos`/`inventory` ungated at the feature
level (tenant lifecycle already blocks a suspended restaurant entirely), and
record the reasoning.

`multiBranch` overlaps `maxBranches`. Enforcing both means two different
refusals for the same act. Recommend treating `maxBranches: 1` as the
expression of "single branch" and leaving `multiBranch` as a marketing label —
or removing it. Flagged for decision.

---

## D. Cache — a reusable mechanism already exists

Current: per-process `Map`, `CACHE_TTL_MS = 30_000`, explicit invalidation from
exactly two places (`subscriptions.js`, `subscriptionLifecycle.js`).

**Finding: `services/roleChangeStream.js` already implements MongoDB change
streams** for exactly this problem — cross-instance cache invalidation for
`Role`. It watches, invalidates on change, swallows errors, and relies on the
TTL as a backstop. The repository already mandates a replica set, so change
streams work in production *and* in the test harness.

That is the honest answer to the brief's *"consider MongoDB change streams if
already available … do NOT add Redis just because it sounds good."* **The
mechanism is available and proven in this codebase.** A `Subscription`/`Plan`
change stream would close the ≤30s cross-instance window with zero new
infrastructure.

Cost: one more change stream per API instance. Bounded and already precedented.

---

## E. Audit coverage — adequate, one gap

`plan_created` and `plan_updated` are audited; subscription lifecycle events
are audited via `recordSubscriptionChange()` (dual-write to `SubscriptionEvent`
+ hash-chained `Audit`), verified in P2C/P2D.1.

`quotaGuard` writes **no** audit rows — correct. The brief says *"Do not create
noisy audit rows for every feature check."* A counter increment per create
would flood the chain.

**Gap:** if P2F adds a quota *override* or *reset* capability, that is a
configuration change and must be audited. No such capability exists today.

---

## F. Test surface

P2E: 59 `it()` blocks, 63 assertions passing. Mutation harness pattern
established (18/18 killed). P2F needs mutation coverage for: quota race
bypass, monthly boundary, timezone boundary, station quota, and the new
change-stream invalidation.

---

## Security implications

1. **Quota bypass is a revenue leak, not a data breach.** A tenant exceeding
   seats does not reach another tenant's data. Severity: commercial.
2. **Monthly quotas are the first limits tied to a hot write path.** A slow or
   failing quota check must not block order creation — the failure mode has to
   be decided deliberately (fail-open on infrastructure error vs fail-closed).
3. **Change streams carry cross-tenant data** by definition. The handler must
   invalidate by restaurant id only and never leak document contents into logs.
4. **Timezone changes shift quota boundaries.** A tenant editing `timezone`
   could re-open a month. Needs consideration.

## Tenant-isolation implications

`ResourceCounter` is scoped `{restaurant, resource}` with a unique index —
verified IXSCAN in P2E. New counters must follow the same shape. Monthly
counting already filters on `restaurant`.

## Migration requirements

| Change | Migration | Risk |
|---|---|---|
| Compound Order indexes | `createIndexes()`, idempotent | Index build on a large collection — background build, needs a note |
| Station/user/menu counters | none (created on demand) | none |
| Subscription change stream | none | none |
| Monthly quota enforcement | **behavioural** — tenants over quota start being refused | **Needs a dry-run report before switching on** |

The last one is the significant one: switching on `maxMonthlyOrders` could
refuse orders for a tenant already over the line. Same class of hazard as P2C's
deploy-day near-miss, and it needs the same treatment — a report of who would
be affected before enforcement begins.

## Concurrency / race conditions identified

1. Users — **measured raceable** (7 on a limit of 2).
2. Menu items — **measured raceable** (6 on a limit of 2).
3. Per-role + total user quota — needs a compound two-reservation pattern.
4. Station creation inside a transaction — `withQuota` cannot currently join it.
5. Monthly quota at a month boundary — two concurrent orders either side of
   midnight local time.

---

## Proposed acceptance criteria for P2F

1. Concurrent-create tests prove users, menu items and stations hold their
   quota (the probes above, inverted).
2. `withQuota` accepts an optional session and is used inside the station
   transaction.
3. Per-role user quotas reserve compound-atomically, releasing both on failure.
4. `maxStations` enforced; counting rule documented.
5. `maxMonthlyOrders` / `maxMonthlyOnlineOrders` enforced, using
   **`Restaurant.timezone`**, excluding cancelled orders, with the rule stated.
6. Compound Order indexes verified by `explain()` as IXSCAN.
7. Feature catalogue extended to describe all 18 keys with an explicit
   classification; P2D's three folded in or cross-referenced.
8. `delivery`, `reservations`, `advancedReports` (and others where the surface
   genuinely exists) gated at the service layer.
9. `pos`/`inventory`/`multiBranch` decisions recorded, not silently skipped.
10. Subscription/Plan change stream invalidating entitlement caches, reusing
    the `roleChangeStream` pattern; TTL retained as backstop.
11. A dry-run report for monthly-quota enforcement before it takes effect.
12. Mutation tests for every guarantee in F.
13. Full backend + frontend suites, Docker, E2E 50/50, multi-tenant verified.

## Recommended scope control

Items 1–6 and 10–13 are **mechanical and safe**. Item 8 is where scope can run
away: gating 10 features means touching 10 subsystems. Recommend gating the
three with the clearest commercial boundary (`delivery`, `reservations`,
`advancedReports`) in P2F and deferring the rest with an explicit register,
rather than half-gating everything.

Items 7 and 9 require **your commercial decision** on `pos`, `inventory` and
`multiBranch` before I implement.

---

**No code has been changed. Working tree clean at `f78e02a`.**
