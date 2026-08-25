# P2C-A — audit before implementation

Read-only inspection of the 18 areas the brief names, done before any code was
written. Recorded so the design decisions below can be checked against what is
actually in the repository rather than what one might assume.

## What already exists (reuse, do not rebuild)

| # | Area | Finding | P2C use |
|---|---|---|---|
| 1 | `Restaurant` model | `slug`, `legalName`, `status`, `timezone`, `settings` (Mixed), currency, vatRate | Subscription links to it; **no new field added to Restaurant** |
| 2 | `Restaurant.settings` | Mixed, default `{}`, tenant-writable via `settings.manage` | **Deliberately NOT used for entitlements** — tenant-writable means self-granting |
| 3 | Lifecycle | `TENANT_STATUSES` = trial/active/suspended/cancelled; `isTenantOperational()`; enforced in `loadPrincipal()` | Entitlement resolver composes with it; suspension keeps precedence |
| 4 | Platform admin | `services/platformAdmin.js`, `routes/platform.js`, rank ladder | Extend, same patterns |
| 5 | Platform permissions | 10 keys, 3-segment `platform.*`, outside tenant catalogue | Add 3 billing keys the same way |
| 6 | Tenant RBAC | 72 keys, owner = `'*'` → **all of them** | Entitlements must NOT be tenant permissions |
| 7 | Audit | Append-only, SHA-256 chain, `recordAudit()`, immutable hooks | Reuse for all commercial mutations |
| 8 | Counts | `countsFor()` in tenantAdmin: `$group` aggregations, 2 queries not 2N | Same shape for usage service |
| 9 | Feature flags | **None exist** (`grep` for hasFeature/entitlement → 0 hits) | Greenfield |
| 10 | Notifications | `notify()`, in_app implemented; email/sms/push record `skipped` | Available; not wired in P2C |
| 11 | Payment models | `Payment` = operational (customer orders). `money = {type:Number}` — **float** | **Do not reuse for billing money** |
| 12 | Numbering | `SalesInvoiceCounter`, `GoodsReceiptCounter`, unique-index allocation | Pattern noted; no billing invoice numbering in P2C |
| 13 | Reporting | analytics/pnl scoped per restaurant | Untouched |
| 14 | Migrations | `OPERATIONAL_MIGRATIONS` (index/backfill, startup); `tenantBackfill.js` is **deliberately excluded** from it and run manually | Follow tenantBackfill precedent exactly |
| 15 | Scheduler | `reorderScheduler.js` + **`schedulerLock.js`** — Mongo TTL lease, `acquire/renew/release` | **Reuse the lease. Do not write a second scheduler.** |
| 16 | Middleware | `auth.js` (`requirePermission`, `requirePlatformPermission`), `securityHeaders.js` | Extend auth.js only |
| 17 | Frontend | Single-file state routing in `main.jsx`; `/platform` swaps the whole shell | Add tabs to `Platform.jsx`, a tenant screen to main shell |
| 18 | Env config | `deployment.js`, `.env`: PORT, MONGODB_URI, JWT_SECRET, CLIENT_URL, APP_ENV, TRUST_PROXY, PAYMENT_MODE | Plans are **database-driven**, not env-driven |

## What is missing (build)

Plan model, Subscription model, immutable subscription history, entitlement
resolver, usage service, limit enforcement, trial expiry sweep, platform
billing API + UI, tenant subscription view, migration.

## Security risks identified

1. **Owner holds `'*'`.** Any entitlement expressed as a tenant permission is
   auto-granted to every owner. Entitlements therefore live in a separate
   subsystem keyed by restaurant, exactly as P2A did for platform authority.
2. **`Restaurant.settings` is tenant-writable** via `PATCH /api/my/restaurant`
   (`settings.manage`). Storing plan or entitlement data there would let a
   tenant grant itself features. Subscription is a **separate collection**;
   `settings` is never consulted by the resolver.
3. **Plan assignment must be platform-only.** A tenant-facing plan change is
   self-service billing, which the architecture does not support yet.
4. **`restaurantId` from a request body** must never select the subscription —
   always from the authenticated principal (tenant side) or an explicit,
   permission-checked id (platform side).
5. **Cancelled ≠ unlimited.** A missing/absent subscription must fail CLOSED to
   a restrictive default, never to "no limits configured, allow everything".
6. **Cached entitlements are a revocation hazard** — the P1/P20 lesson. Any
   cache needs a bounded TTL and explicit invalidation on write.

## Migration risks

- Existing restaurants have **no** subscription. Migration must be idempotent,
  dry-runnable, must never overwrite an existing subscription, and must not
  invent commercial history.
- `Restaurant.status === 'trial'` already exists on some tenants; the migration
  must not silently reinterpret that as a paid plan.
- Follows `tenantBackfill.js`: **excluded from `OPERATIONAL_MIGRATIONS`**, run
  explicitly. A commercial migration must not fire automatically on boot.

## Billing / data-integrity risks

- **Float money.** `money = {type:Number}` is used across operations. Billing
  amounts must be **integer minor units (paisa)** in a separate field type.
  `0.1 + 0.2 !== 0.3` is not acceptable in a price list.
- **History must be immutable.** Overwriting `Subscription.plan` destroys the
  commercial record; an append-only event log is required.
- **No fabricated payments.** P2C records amounts and pending state only. No
  gateway call, no "paid" transaction, no invented settlement.
- **Unlimited must be explicit** (`null`), never a magic number like `-1` or
  `999999` that arithmetic can accidentally compare against.

## Decisions taken from this audit

- Money: `Int32`-safe integer **minor units**, validated as safe integers.
- Unlimited: `null`, with `isUnlimited()` rather than a sentinel.
- Entitlements: separate `Plan`/`Subscription` collections, never
  `Restaurant.settings`.
- Trial sweep: reuses `mongoSchedulerLock` — no second scheduler.
- Migration: explicit npm script, dry-run first, excluded from startup.
