# P2E-AUDIT — feature entitlement enforcement, inspection before implementation

Read-only investigation completed before any code was written. Every claim was
produced by a probe or a grep, not by reading alone.

## Headline finding

**`assertFeature()` exists and has ZERO call sites.**

```
$ grep -rn "assertFeature(" server/src --include=*.js | grep -v entitlements.js
(no results)
```

P2C built the resolver, the plan catalogue, the 402 error contract and the
`assertFeature()` helper — and then never called it. Every one of the 18
feature keys is resolvable and **none is enforced**. The plan says
`onlineOrdering: false` and online ordering works perfectly.

## Feature enforcement matrix

| Feature | Defined | Resolver | Backend enforced | Frontend gated | Tests | Missing |
|---|---|---|---|---|---|---|
| `onlineOrdering` | ✅ catalogue | ✅ | ❌ **none** | ❌ | ❌ | all 10 public endpoints |
| `loyalty` | ✅ catalogue | ✅ | ❌ **none** | ❌ | ❌ | adjust endpoint + accrual |
| `apiAccess` | ✅ catalogue | ✅ | ❌ n/a | ❌ | ❌ | **no API-key subsystem exists** |
| `pos`,`inventory`,`kds`,`tables`,`delivery`,`reservations`,`purchasing` | ✅ | ✅ | ❌ | ❌ | ❌ | out of P2E scope |
| `advancedBranding`,`whiteLabel`,`customDomain` | ✅ | ✅ | ✅ **P2D** | ✅ | ✅ | — |

Only P2D's three branding features are actually enforced.

### `onlineOrdering` — 10 unprotected public endpoints

`grep` for `assertFeature|hasFeature|resolveEntitlement|entitlement` across
`routes/storefront.js` and `services/storefront.js` returns **nothing**.

```
GET  /api/public/branches          POST /api/public/orders
GET  /api/public/menu              GET  /api/public/orders/track
POST /api/public/quote             GET  /api/public/payment-methods
POST /api/public/payments          GET/POST /api/public/payments/return
GET  /api/public/payments/:reference
```

Tenant is resolved from `branchId` via `resolvePublicBranch()` — the mechanism
to reuse. Staff-side `/online-orders*` routes accept/reject orders that already
exist; those must keep working when the feature is switched off, or a tenant
whose plan lapses cannot finish serving orders already placed.

### `loyalty` — real, small, unprotected

Exists: `Customer.loyalty {points, tier, lifetimePoints, joinedAt}`, the legacy
`loyaltyPoints` mirror, and **one** endpoint —
`POST /api/customers/:id/loyalty` (`customers.loyalty` permission). Points are
also initialised on customer creation.

**Not** a full loyalty product (no earn rules, no redemption at POS, no
campaigns). Per the brief I will gate what exists and document the boundary
rather than invent a loyalty product inside P2E.

### `apiAccess` — nothing to gate

```
$ grep -rn "apiKey|api_key|ApiKey|x-api-key" server/src
(no results)
```

**No API-key subsystem exists.** Per the brief: define the entitlement, do not
fabricate a developer platform, document it as a later bounded phase. Creating
a fake key issuer purely to make a flag pass would be exactly the
"fake integration" the brief prohibits.

## Resource limit matrix

| Resource | Limit key | Enforced today | Where |
|---|---|---|---|
| users (+ per-role) | `maxUsers`,`maxManagers`,`maxStaff`,`maxRiders` | ✅ | `staffAccounts.js` |
| branches | `maxBranches` | ✅ | `tenantLimits.js` |
| menu items | `maxMenuItems` | ✅ | `recipes.js` |
| tables | `maxTables` | ✅ | `tenantLimits.js` |
| **customers** | `maxCustomers` | ❌ | — |
| **monthly orders** | `maxMonthlyOrders` | ❌ | — |
| **monthly online orders** | `maxMonthlyOnlineOrders` | ❌ | — |
| **stations** | `maxStations` | ❌ | usage returns `null` |
| ingredients / storage / API keys / sessions | *no key* | ❌ | not modelled |

**5 of 11 enforced.** `maxStations` has no usage counter at all.

## Two defects measured

### 1. Concurrent creates bypass the quota

```
limit maxBranches = 2, one branch already exists
5 simultaneous create attempts
  allowed through: 5 | branches now: 6   -> BYPASSED
```

Check-then-act: every request reads usage `1`, all pass, all insert. The
existing guards are correct sequentially and defenceless under concurrency.

### 2. Cache staleness on a direct plan edit

```
onlineOrdering now                     : false
after plan edit (no invalidation)      : false   <- stale
after explicit invalidation            : true
```

**Not** a defect in the API paths: `updatePlan()` and the subscription
lifecycle both call `invalidateEntitlements()`. My probe wrote to the database
directly, which is what a script or a second instance does. The 30-second TTL
bounds it. Honest statement: per-process cache, explicit invalidation on every
API write, ≤30s worst case for out-of-band changes and cross-instance.

## Cache and enforcement gate (existing, reused)

- `CACHE_TTL_MS = 30_000`, per-process `Map`, `invalidateEntitlements(id)`.
- `billingEnforcementActive()`: `off` / `on` / `auto` (default = enforce only
  once a plan catalogue exists). This is the rollout gate P2C added after
  unconditional enforcement would have bricked every tenant on deploy day.
  **P2E must respect it**, or gating online ordering ships the same disaster.

## Error contract (existing, reused)

`assertFeature()` / `assertWithinLimit()` throw **402** with
`{billing: true, reason}`. `reason` values today: `feature_not_in_plan`,
`limit_reached`, `trial_expired`, `period_ended`, `subscription_*`,
`tenant_suspended`, `no_subscription`. P2E adds stable machine-readable
`code` values on top rather than inventing a second scheme.

## Security invariants to preserve

1. `Restaurant.settings` is tenant-writable → must never grant entitlement
   (asserted in P2C/P2D; must stay asserted).
2. Tenant comes from the authenticated principal or, publicly, from `branchId`
   — never from a request body.
3. Suspended/cancelled tenants lose operational entitlement but keep read
   access to their own history (P2C rule).
4. Platform operators are exempt from tenant plan limits.

## Plan (bounded)

1. `featureCatalogue.js` — one authoritative catalogue with metadata; unknown
   keys fail closed.
2. `requireFeature()` guard + `assertFeature` with stable error codes.
3. Gate the 10 public ordering endpoints (branding/tracking stay reachable).
4. Gate the loyalty endpoint and accrual; document the boundary.
5. `apiAccess`: entitlement defined, documented as not-yet-implemented.
6. Add `maxCustomers` and monthly order limits; add a **conditional-write**
   pattern for the concurrency bypass.
7. Frontend feature awareness distinguishing "not in plan" from "lifecycle".
8. No Redis. Document the cache honestly.


---

# IMPLEMENTATION OUTCOME

## What was built

| Component | Purpose |
|---|---|
| `services/featureCatalogue.js` | one authoritative catalogue + stable error codes |
| `services/featureGuard.js` | `requireFeature()`, `assertPublicFeature()`, `describeTenantFeatures()` |
| `services/quotaGuard.js` | atomic, race-proof quota reservation |
| `GET /api/my/features` | tenant-facing feature state |

## Enforcement points added

| Surface | Where enforced | Feature |
|---|---|---|
| public menu | `storefront.getPublicMenu()` | `onlineOrdering` |
| cart quote | `storefront.priceCart()` | `onlineOrdering` |
| order creation | `storefront.placePublicOrder()` | `onlineOrdering` |
| payment intent | `onlinePayments.createPaymentIntent()` | `onlineOrdering` |
| loyalty adjust | `customers.adjustLoyaltyPoints()` | `loyalty` |
| branch create | `tenantLimits.createBranchWithinQuota()` | `maxBranches` (atomic) |
| table create | `tenantLimits.createTableWithinQuota()` | `maxTables` (atomic) |
| customer create | `customers.createCustomer()` | `maxCustomers` (atomic, **new**) |

All at the **service** layer, so every caller is covered rather than one route.

### Deliberately NOT gated

`/api/public/branding`, order tracking, the payment RETURN handler, reading a
loyalty balance, and the staff `/online-orders*` accept/reject routes. A guest
mid-payment must be able to finish; a kitchen must be able to serve orders
already placed; public identity is not the paid capability.

## Two defects fixed

**1. Concurrent quota bypass.** Measured before: 5 simultaneous creates against
a 2-branch limit produced **6 branches**. After: **2**, one success, the rest
refused with `RESOURCE_LIMIT_REACHED`. Fixed with a single-document conditional
write (`count: {$lte: limit - adding}` + `$inc`), which MongoDB applies
atomically. Reconciled against the real count on every reservation, so counter
drift self-heals rather than accumulating.

**2. Missing `maxCustomers`.** Declared by P2C, never checked. Now enforced.

## apiAccess — not implemented, and not faked

`grep` for `apiKey|api_key|ApiKey|x-api-key` across `server/src` returns
nothing. There is no key model, no issuance, no key authentication. The
entitlement is **declared and resolvable**, marked `implemented: false`, and
`assertFeatureImplemented()` **refuses to gate on it** so nobody can wire a
permanently-closed door by accident. `GET /my/features` reports
`not_implemented` rather than pretending. API-key management is a later bounded
phase.

## Loyalty — gated, boundary documented

What exists: `Customer.loyalty {points, tier, lifetimePoints}` and one
adjustment endpoint. Both now gated. What does **not** exist and was not
invented: earn rules, POS redemption, campaigns, tier automation. The feature
boundary is in place for a future loyalty phase.

## Cache behaviour (honest)

Per-process `Map`, 30s TTL, explicit invalidation on every API write that can
change entitlement (`updatePlan`, subscription lifecycle, plan assignment).
Verified live: upgrade → 200 and downgrade → 402 on the very next request.

**Limitation:** an out-of-band database write (a script, or another instance's
write) is not seen until the TTL expires — ≤30 seconds. No Redis was added; the
brief is explicit about not adding it reflexively, and a 30-second worst case
on a cosmetic-to-commercial boundary does not justify new infrastructure.

## Performance

```
cold resolve (2 indexed queries) : 3.51 ms
cached hasFeature   x2000        : 0.0027 ms each
uncached resolve    x200         : 2.42 ms each
cache saves ~900x per call
quota counter lookup             : IXSCAN resource_counter_scope
```

No new query is added to requests that were not already resolving entitlement.

## Rollout safety

Every gate respects `billingEnforcementActive()`. With no plan catalogue,
online ordering behaves exactly as before P2E — verified live: **50/50 E2E
before seeding plans, and 50/50 after**. This is the P2C lesson applied: gating
the busiest public surface unconditionally would have bricked every tenant on
deploy day.
