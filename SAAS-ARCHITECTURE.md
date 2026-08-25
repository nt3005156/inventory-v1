# SaaS architecture — P1 · P2A · P2B · P2C · P2D · P2D.1

How this single-restaurant ERP becomes a multi-tenant platform for ~100
restaurants on one codebase. Written at the end of Phase P1; sections marked
**P1** are implemented and tested, everything else is a decision recorded now
so later phases do not re-litigate it.

Target scale is **~100 tenants**, not millions. Every choice below is sized for
that. Designing for a scale you do not have buys complexity you cannot afford.

---

## 1. Tenant model

**The tenant is `Restaurant`.** Not a separate `Tenant` collection — the
restaurant already *is* the ownership boundary in every existing query, and
introducing a parallel entity would mean two ids to keep in step forever.

```
Restaurant  (tenant)
 ├── slug         URL-safe handle; unique platform-wide (subdomain later)
 ├── legalName    registered entity; tax documents need it, trading name ≠ legal
 ├── status       trial → active → suspended → cancelled
 ├── timezone     report boundaries; Nepal is UTC+05:45
 ├── settings     Mixed — per-tenant configuration
 └── Branch[] → User[] → operations
```

**Status lives on the tenant, not on a billing record.** Access control must
never depend on a billing system being reachable. P3 will *write* status from
subscription events; it will not be the source of truth for authorisation.

**`settings` is deliberately `Mixed`.** P1 cannot know what P4 will configure,
and a rigid sub-schema would force a migration for every new toggle. The cost
is no validation — acceptable for configuration, unacceptable for money, which
is why nothing financial goes in here.

### Isolation strategy: shared database, shared collections

Three options existed:

| Model | Isolation | Ops cost at 100 tenants |
|---|---|---|
| Database per tenant | Strongest | 100 databases to migrate, back up, index |
| Collection per tenant | Strong | ~4,000 collections; index bloat |
| **Shared, tenant-keyed** | Application-enforced | One migration, one backup |

**Chosen: shared, tenant-keyed.** At 100 tenants the operational cost of the
other two dominates, and this codebase already enforces tenancy in the
application layer with 45 test files proving it. Revisit if a tenant demands
physical separation for compliance — the tenant key makes extraction possible
later.

The trade-off is honest: **isolation is application-enforced, not
database-enforced.** A missing filter is a leak. P1B exists to make that filter
hard to get wrong.

---

## 2. Tenant ownership — P1B

**Every high-volume collection carries its tenant directly.**

Before P1, `Order` and `Payment` did not:

```
Payment → order → Order.branch → Branch.restaurant     (3 hops)
```

Isolation held, but it depended on ~90 query sites each remembering to join
through the branch. In the money collection, one forgotten join is a
cross-tenant leak. Now:

```
Order   { restaurant, branch, ... }
Payment { restaurant, branch, order, ... }
```

`branch` is kept — it is the *operational* scope. `restaurant` is the *tenancy*
scope. They are different questions and now have different fields.

**28 of 39 models already carried `restaurant`.** The remainder are either
branch-scoped children with a short, single-hop path, or genuinely global
(`Restaurant` itself). Extending the pattern further is a P2 decision, taken on
evidence rather than uniformly.

**Not `required` yet.** Rows written before the migration have no tenant, and
failing their validation would break historical reads. Tightening to `required`
is a P2 step, gated on `verifyTenantOwnership()` reporting zero.

---

## 3. Migration strategy — P1C

`server/src/services/tenantBackfill.js`, run explicitly:

```bash
npm run migrate:tenants:dry     # report only, no writes
npm run migrate:tenants         # apply
```

Four rules, each tested and mutation-verified:

1. **Idempotent** — only untagged rows are touched; a second run is a no-op.
2. **Restartable** — bounded batches, no cross-batch state; killing it mid-run
   leaves a consistent partial result the next run continues from.
3. **Never invents a tenant id** — a row whose branch is missing or whose
   branch has no restaurant is *reported* and left alone. Stamping a plausible
   tenant onto an order would silently move somebody's money.
4. **Dry run first** — verified on a live containerised database: 2 fixable
   rows reported, 1 orphan flagged, **zero writes**.

**Deliberately not in `OPERATIONAL_MIGRATIONS`.** A backfill over the two
largest collections should be an operator decision on first upgrade, not a
surprise during a container restart.

`ok: false` while anything is unresolved. A partial migration is a state a
human must look at — unresolved rows are usually orphaned data worth
understanding before patching.

---

## 3A. Platform authority — P2A

**Platform permissions are NOT in the tenant catalogue, and that is the whole
design.**

A restaurant owner holds `'*'`, which `resolvePrincipal()` expands into the
entire catalogue — verified: `permissionsForBuiltin('owner').length ===
ALL_PERMISSIONS.length`. Adding `platform.restaurants.suspend` there would have
silently handed every restaurant owner the power to suspend other restaurants.

So there are two authorities answering two different questions:

| | Question | Mechanism |
|---|---|---|
| Tenant RBAC | "What may this employee do **inside** their restaurant?" | `PERMISSION_CATALOG`, 72 keys, `requirePermission()` |
| Platform | "May this account act **across** restaurants at all?" | `User.platformRole` → `services/platformAccess.js` |

This is not a second authorization system for the same question — it is one
system for a question the existing one cannot express.

`User.platformRole` is `select: false`, defaults to null for every existing
account, and is **not settable through any tenant-facing endpoint**.
Self-promotion from inside a tenant is impossible; it is set out-of-band
(database today, a platform-admin screen in P2B). Authority is always read from
storage — a forged `platformRole` claim in a JWT grants nothing.

### Surfaces

| Path | Audience | Guard |
|---|---|---|
| `/api/platform/restaurants*` | platform operators | `platformRole` (service layer) |
| `/api/my/restaurant` | a tenant, itself | `branches.view` / `settings.manage` |

Separate paths rather than one endpoint with a mode flag: a flag is one
refactor away from being widened by accident, and the audit trail must
distinguish "the platform changed this tenant" from "the tenant changed
itself".

### Lifecycle enforcement

P1 added `Restaurant.status`; nothing read it, so it was decoration. P2A
enforces it in `loadPrincipal()` — the one place every authenticated request
already resolves its principal, so no endpoint can forget it.

- `trial`, `active` → trade normally
- `suspended`, `cancelled` → **403 on every operational request**
- Platform operators are **exempt**, or suspension would be irreversible

403 rather than 401: the credentials are valid, the business is not permitted
to trade. A 401 would send staff round a pointless re-login loop. The message
is actionable ("contact the platform administrator") via an explicit
`tenantLifecycle` flag — the generic 403 flattening is otherwise preserved, so
no permission is disclosed.

Status changes go through a **separate endpoint** from profile edits, need
their own permission, require a **reason** to suspend or cancel, and are
audited individually. A tenant can never change its own status.

## 3B. Platform administration — P2B

P2A created the platform boundary. P2B builds the controlled administration
system on top of it: an authority ladder, a safe provisioning path, one
centralized guard, cross-tenant user administration, a platform audit view, a
dashboard, and a separate frontend workspace.

### The authority ladder

Three roles, because there is a real authorization difference at each rung —
not because a matrix looks thorough.

| Role | Rank | May do | Deliberately may NOT |
|---|---|---|---|
| `platform_support` | 1 | read: restaurants, users, audit, dashboard | change anything at all |
| `platform_admin` | 2 | everything above + create/update/suspend/activate restaurants, deactivate/reactivate users | **mint other operators** |
| `super_admin` | 3 | everything, incl. `platform.admins.manage` | — |

Each rung is a strict superset of the one below (asserted in the suite), so a
demotion can never grant something.

**Why `platform_admin` cannot mint operators.** That is the
privilege-escalation path. An administrator who can suspend every restaurant
on the platform still cannot recruit an accomplice or make themselves
permanent, so one compromised admin account is a contained incident.

`rank` answers only "may this actor grant/act on that role?". Permission checks
are always explicit key lookups, so a future role cannot inherit a capability
by sitting high on the ladder.

### Platform permissions

Ten keys, all `platform.<resource>.<action>`:

```
platform.restaurants.view / create / update / suspend / activate
platform.users.view / manage
platform.audit.view
platform.dashboard.view
platform.admins.manage
```

They are **three segments on purpose**. `phase20.rbac.test.js` requires every
tenant catalogue key to match `/^[a-z]+\.[a-z]+$/`, so a platform key is
*structurally* incompatible with the tenant catalogue — a mechanical guarantee
on top of the policy one.

### One guard: `requirePlatformPermission()`

Every platform route uses it. No platform route uses `requirePermission()` —
those are tenant permissions and an owner holds all 72, so guarding a platform
endpoint with one would open it to every owner on the platform.

Three layers, in order:

1. `authenticate()` — valid, unexpired, HS256 token agreeing with storage.
2. a **fresh database read** of `platformRole`. Never the token.
3. an **explicit permission-key check**. Holding a platform role is not the
   same as holding a capability.

The service layer re-asserts the same permission independently. Two checks for
one decision is deliberate: P2A's mutation run proved a check living only
behind a route is a check no unit test exercises.

**Forged claims.** `authenticate()` `delete`s `req.user.platformRole` outright.
Nothing reads it, but leaving an attacker-controlled field named exactly like
the authority field, on the object every handler destructures, is a defect
waiting for its first careless reader.

| Caller | Result |
|---|---|
| anonymous | 401 |
| owner / manager / staff / rider / custom role | 403, identical message |
| forged `platformRole` claim | 403 |
| role removed from DB, or account deactivated/deleted | access stops on the next request |
| operator without the specific permission | 403 |

The refusal is byte-identical for every unauthorized caller: the platform
surface must not describe itself differently to different callers.

### Provisioning — no bootstrap route, ever

The first operator is created by `server/scripts/platform-admin.js`, which
needs **shell access**:

```
node scripts/platform-admin.js list
node scripts/platform-admin.js grant <email> [super_admin|platform_admin|platform_support]
node scripts/platform-admin.js revoke <email>
```

Rejected alternatives, and why:

- *a public `/bootstrap` route that disables itself after first use* — the
  disable condition ("no super admin exists") becomes true again after a
  restore from an older backup or a botched migration. A dormant route is a
  route that comes back.
- *a route behind a shared secret in an env var* — a password with no
  rotation, no audit and no expiry, sitting in a file that lands in CI logs.
- *seeding it* — either mints a real operator in production or is
  conditionally skipped, which is the dormant-route problem again.

After that, `PATCH /api/platform/users/:id/platform-role` handles every grant.
It requires `platform.admins.manage` (super admin only) and enforces:

- **rank ceiling** — nobody grants above their own rank;
- **no self-service** — an actor cannot change their own platform authority in
  either direction (self-promotion is the attack; self-demotion is how the
  last super admin disappears);
- **target must exist and be active** — promoting a deactivated account
  creates dormant authority nobody is watching;
- **last-super-admin protection** — counted among active accounts only;
- **mandatory reason + audit row**, and the target's sessions are revoked.

The endpoint grants authority to accounts that **already exist**. It never
accepts a password, keeping credential handling out of the authority path.

### Cross-tenant user administration

`GET /api/platform/users` searches every tenant, filterable by restaurant,
role, platform role and status. Scoping is **by explicit request, never
implicitly by the caller's own tenant** — an operator embedded in a restaurant
must not silently see only their own.

`PATCH /api/platform/users/:id/active` can deactivate an owner, which the
tenant-side equivalent refuses — "this restaurant's owner is abusing the
service" is exactly what the platform exists to handle. It cannot touch the
actor themselves or a **peer or superior** operator.

> **Grant vs. administer are different questions.** Granting permits *equal*
> rank (a super admin must be able to create peers, or the platform has a bus
> factor of one). Acting on somebody's account requires *strictly higher* rank
> (a lateral attack on a peer is what one compromised operator would attempt).
> Conflating them was a real defect the P2B suite caught: one `platform_admin`
> could deactivate another. Now `canGrantPlatformRole()` is `<=` and
> `canAdministerPlatformUser()` is `<`.

**The two authority systems never bleed.** `role = 'owner'` does not imply
`platformRole`. `platformRole` is refused by the tenant role-assignment,
account-creation and restaurant-profile endpoints, and never appears in any
tenant-facing projection. All asserted.

### Platform audit

Reuses the existing append-only, SHA-256 hash-chained `Audit` collection — not
a second log. The difference is scope: `searchAudit()` pins every query to the
caller's own restaurant, which is right for a tenant and useless for an
operator.

`GET /api/platform/audit` is a **whitelist** of platform actions:

```
platform_admin_created / _revoked / _role_changed
platform_restaurant_created / _updated / _activate / _trial / _suspend / _cancel
platform_user_deactivated / _reactivated
```

Without the whitelist this endpoint would be a cross-tenant window onto every
refund, price change and failed login on the platform. An operator can see what
the **platform** did, not what a restaurant did internally; investigating a
tenant's own operations means asking that tenant.

Rows are stamped under the **target's** restaurant, so the tenant's own chain
records what the platform did to it. Platform-authority changes carry no
restaurant — they are not a tenant fact and belong on the global chain.
Actor name and role are denormalised at write time (`platform:<role>`), so the
record stays readable after a rename.

### Dashboard

`GET /api/platform/dashboard`: restaurant counts by status, branch total, user
totals (active/inactive/operators), and the five newest restaurants. Counted in
one aggregation per collection, not N queries.

A restaurant with **no** `status` is legacy and counts as `active`, matching
what the list screen reports — asserted, because a disagreement here would send
somebody chasing a phantom discrepancy.

**Deliberately absent: revenue, orders, payments, anything from a tenant's
books.** An aggregate over money is one `groupBy` away from being individual
tenant financial data. Business metrics are P2G.

### Frontend

`client/src/Platform.jsx` — a **separate workspace**, not a page in the
restaurant shell. A platform operator is not an employee of any restaurant, and
mixing the surfaces is how "suspend restaurant" ends up two clicks from "print
receipt". The shell swaps entirely; the entry point appears only when
`/platform/me` confirms authority, and never from a tenant permission.

Screens: Dashboard, Restaurants (search, status filter, open, activate,
suspend-with-reason), Users, Audit. Controls are hidden according to the
permissions the server reports, so `platform_support` gets read-only screens.

**The frontend is not the security boundary.** Every request is re-authorized
server-side against the database `platformRole`. The UI tests say so in their
own header, so they can never be cited as evidence of enforcement.

## 3C. Subscriptions, plans and entitlements — P2C

The commercial layer: which restaurant is on which plan, and what that plan
permits. Built so a plan change is a DATA change, never a code change.

### Where commercial state lives, and why not on `Restaurant`

`Restaurant.settings` is `Mixed` and writable by any tenant holding
`settings.manage` — that is `PATCH /api/my/restaurant`. Storing a plan or a
feature map there would be **self-grantable**: an owner could give themselves
Enterprise by editing their own settings. So commercial state lives in three
collections no tenant-facing endpoint writes:

| Collection | Role |
|---|---|
| `Plan` | the catalogue: prices, limits, features. One per `code`, unique. |
| `Subscription` | CURRENT state. Exactly one per restaurant (unique index). |
| `SubscriptionEvent` | the append-only commercial record. |

A test asserts the resolver ignores `Restaurant.settings` even when it is
stuffed with every feature set to true.

### Money is integer minor units

The operational schemas use `money = {type: Number}` — a float. Tolerable for a
Rs 350 biryani, not for a price list, where `0.1 + 0.2 !== 0.3` becomes a
billing dispute. **Every amount in the billing path is an integer count of
paisa**, validated as a safe integer at the schema. `formatMinor()` renders it
with integer division and remainder; the client never divides money.

`NPR 8,300.00` is stored as `830000`.

### Unlimited is `null`

Not `-1`, not `999999`. Both take part in arithmetic, so a forgotten guard
turns "unlimited" into a negative or into a real ceiling somebody eventually
hits. `null` cannot be compared by accident and forces the explicit
`isUnlimited()` check. A mutant that made `isUnlimited()` return `false` is
killed by the suite.

### Where the commercial VALUES are set

**Not in source.** Nobody has approved real pricing, so inventing it in code
would bake a guess into the product. The limit STRUCTURE (`LIMIT_KEYS`,
`FEATURE_KEYS`) is in `models/billing.js`; the VALUES are data:

1. **`PATCH /api/platform/plans/:id`** with `platform.billing.manage` — the
   intended route for a live platform. Every edit is audited.
2. **`node scripts/seed-plans.js --force`** — development and fresh
   environments. The figures there are DEMO VALUES, modelled from the stated
   ~NPR 1 crore/year across ~100 restaurants (≈ NPR 8,300/restaurant/month,
   which is where `professional` sits).

### The entitlement resolver

ONE authoritative function, `resolveEntitlement(restaurantId)`:

```
restaurant -> subscription -> plan -> {features, limits}
```

Each failure has a different correct answer, and all of them **fail closed**:

| Situation | Result |
|---|---|
| suspended / cancelled tenant | nothing, not even read access (a platform sanction) |
| no subscription | RESTRICTED, never "unlimited because nothing is configured" |
| plan document missing | RESTRICTED, `reason: plan_missing` (a data fault, named) |
| subscription cancelled / expired | not operational, **but data still readable** |
| trial end date passed | not operational **immediately**, before any sweep |
| plan retired underneath a live tenant | keeps working — see below |

**`operational` vs `readOnly`.** The brief requires that a lapsed subscription
not destroy access to historical data, and for a VAT-registered business in
Nepal that is also a compliance matter. So a cancelled tenant keeps `readOnly`
and loses `operational`. A *suspended* tenant loses both, because suspension is
a platform sanction already enforced in `loadPrincipal()`.

**A retired plan keeps working for existing subscribers.** Silently downgrading
a paying customer because marketing archived a SKU would be worse than the
alternative. New assignments to a retired plan are refused (409).

### The check API

```js
hasFeature(restaurantId, 'onlineOrdering')      // boolean
getLimit(restaurantId, 'maxBranches')           // number | null
assertFeature(restaurantId, 'apiAccess')        // throws 402
assertWithinLimit(restaurantId, 'maxUsers', used, {adding: 1})  // throws 402
```

**402, not 403.** 403 means "your role does not allow this" and sends an owner
hunting a permission misconfiguration; 402 means "your plan does not include
this" and points at the actual fix. The error carries `billing: true` and a
machine-readable `reason`.

**The boundary:** usage 4, limit 5, adding 1 → allowed (the fifth). Usage 5 →
refused (the sixth). A plan that says "5 branches" permits exactly five.

### Enforcement rollout gate — a defect the suite caught

The first implementation enforced unconditionally. That is right in steady
state and **catastrophic on deploy day**: every existing restaurant has no
subscription, so restarting the container would have refused every menu item,
user and table on the platform *before* anybody could run the migration. Nine
existing tests failed and said so.

Enforcement is therefore gated by `BILLING_ENFORCEMENT`:

| Value | Behaviour |
|---|---|
| `off` | never enforce; entitlements still computed and reported honestly |
| `on` | always enforce |
| unset / `auto` (default) | enforce only once a plan catalogue **exists** |

`auto` is safe because an empty catalogue unambiguously means the commercial
subsystem is not provisioned here — a platform that has never sold anything
cannot refuse somebody for not having bought it. This is not a hole: creating
plans needs `platform.billing.manage` and there is no delete-plan endpoint, so
a tenant cannot empty the catalogue to disable enforcement.

**Rollout order: deploy → `seed:plans` → `migrate:subscriptions` → enforced.**

### Enforcement points (P2C-I — representative, not exhaustive)

| Resource | Where | Why there |
|---|---|---|
| users | `staffAccounts.createStaffAccount()` | both `/auth/register` and `/accounts` land here |
| menu items | `recipes.createMenuItem()` | every caller covered, not just the route |
| branches | `tenantLimits.assertBranchCreationAllowed()` | created inline in the route; guard extracted to a service |
| tables | `tenantLimits.assertTableCreationAllowed()` | same, and resolves the tenant from the branch |

Each check runs **after** validation and **immediately before** the insert, so
a refusal cannot leave a partially created record. Later phases apply the same
mechanism to the remaining resources.

### Subscription lifecycle

```
trialing → active | past_due | cancelled | expired
active   → past_due | cancelled | expired
past_due → active | cancelled | expired
cancelled → active          (reactivation)
expired   → active
```

Declared as data in `SUBSCRIPTION_TRANSITIONS`; anything absent is refused.
**Nothing returns to `trialing`** — otherwise "extend the trial" and "restart
the trial" become the same operation and a tenant can be trialled indefinitely.

`past_due` is reachable **only by an explicit platform action**. Nothing in P2C
infers a failed payment, because no gateway exists to report one.

### Trials

Duration comes from `Plan.trialDays`, never a constant. A trial is offered only
on FIRST assignment — re-trialling an existing subscriber is an unbounded free
ride one "plan change" at a time. Extensions require `platform.billing.manage`,
are bounded to 1–365 days, need a reason, and are audited.

**There is no hidden infinite trial.** The resolver computes expiry from the
DATE, so access stops on time whether or not the scheduler ever runs.

### The sweep reuses the existing lease

`subscriptionScheduler.js` uses `mongoSchedulerLock()` from Phase 16B under the
lock name `subscription-sweep` — a *different* name from the reorder sweep, so
the two singletons do not starve each other. **No second scheduler was written.**

The sweep is **bookkeeping, not enforcement**: it makes the stored status agree
with reality so listings and history are honest. Enforcement is in the
resolver, which is why the job is safe to be late, skipped, or switched off.
Idempotent and restartable; it re-reads and re-checks each transition, so
losing a race with an operator is a no-op rather than overwriting a human
decision.

Disabled by default (`SUBSCRIPTION_SCHEDULER_ENABLED`).

### Two logs, deliberately

Every commercial mutation writes to both:

- **`SubscriptionEvent`** — append-only (schema hooks refuse update/delete),
  queryable per tenant. It **is** the commercial record, so the write is
  awaited and allowed to throw.
- **`Audit`** — the existing tamper-evident hash chain, stamped under the
  tenant. Best-effort: losing a log line must not roll back a completed state
  change.

Not duplication — they answer different questions. System actions record
`system:scheduler` or `system:migration` rather than inventing a user.

### Authority

| Surface | Guard |
|---|---|
| `/api/platform/plans*`, `/api/platform/subscriptions*` | `requirePlatformPermission()` |
| `/api/my/subscription`, `/api/my/entitlements` | `branches.view` — **read only** |

`platform.billing.view` / `.manage` are split so support can see which plan a
caller is on without being able to move them. **A tenant has no write surface
over its own subscription anywhere in P2C** — self-service billing is a
commercial design that does not exist yet.

### Migration

`migrate:subscriptions` (+ `:dry`). Idempotent, dry-runnable, **never
overwrites** an existing subscription, aborts rather than inventing a plan, and
does not backdate `startDate` (which would fabricate a billing relationship).
Defaults to `starter`/`trialing` — the least-privileged, non-paying option.

Deliberately **excluded from `OPERATIONAL_MIGRATIONS`**: assigning commercial
standing to every tenant must not happen because somebody restarted a
container. Same precedent as `tenantBackfill.js`.

## 3D. Tenant branding, white-label and customization — P2D

One codebase, one product, many restaurants, tenant-specific configuration. No
restaurant-specific values are hardcoded in any React component.

### Where branding lives, and why not in `settings`

`Restaurant.settings` is `Mixed` and writable by any tenant holding
`settings.manage`. That is fine for loose operational preferences and wrong for
anything rendered into receipt HTML or a public page, which needs a declared
type and a validator. So branding is a **structured sub-document**,
`Restaurant.branding`, validated in two places:

- `models/operations.js` — so a script or migration cannot store rubbish;
- `services/brandingSchema.js` — so an API payload fails with a useful message.

### Branding is untrusted input, and is treated like it

| Field type | Rule | Why |
|---|---|---|
| colour | `#RRGGBB` **only** | a raw CSS value permits `expression()`, `url(javascript:)` and background-image exfiltration |
| URL | http/https only, parsed with `new URL()` | a regex over URLs is a reliable source of bypasses; `javascript:`/`data:`/`vbscript:` are refused by name AND by allowlist |
| font | a **key** into a server-side allowlist | free-text `font-family` lands inside a declaration and can close it |
| text | length-capped, control chars stripped, **markup stored raw** | escaping happens at every render site; storing pre-escaped text double-escapes on the next edit |
| unknown key | **400** | Mongoose `strict:true` silently drops unknown paths, so a typo would look accepted and never apply |

Receipt HTML escapes `& < > " ' /` on every interpolated value; the storefront
is React, which escapes by default. Both are asserted with real payloads.

### One resolver, safe defaults, never written back

`getRestaurantBranding(restaurantId)` is the single authority. Every key is
always present, so no caller writes its own `|| '#something'` fallback — that
pattern, repeated at 30 sites, is how per-page defaults drift apart.

Defaults are **never persisted**: writing one turns "the owner never chose"
into "the owner chose this", which then survives a change to the product
default and cannot be distinguished from a deliberate setting.

### White-label tiers, wired to P2C entitlements

| Tier | Feature key | Contents |
|---|---|---|
| core | *(none — every plan)* | name, logo, favicon, primary/secondary colour, contact, receipt footer |
| advanced | `advancedBranding` | storefront copy, accent/background/text colours, typography, social links |
| white | `whiteLabel` | suppressing the product's own branding |
| — | `customDomain` | claiming a hostname |

Enforced **twice**: writes are refused with 402 naming the feature, and the
resolver refuses to APPLY an unentitled tier even if the value is in the
database. A downgrade therefore stops paid presentation immediately **without
destroying the stored values**, so an upgrade restores them without re-entry.
A lapsed subscription reverts to core branding for the same reason.

Platform operators are exempt: support fixing a Starter tenant's storefront
must not be blocked by that tenant's plan.

### THE INVOICE IDENTITY SNAPSHOT — a defect found and fixed in P2D

**Reproduced before fixing**, with passing controls:

```
at issue time         name: Mittho Biryani      pan: 301234567   addr: Kalanki
after a profile edit  name: COMPLETELY DIFFERENT CO
                                                pan: 999999999   addr: Somewhere Else
  invoiceNo unchanged     (control) true
  invoicedTotal unchanged (control) true
```

Phase 13 froze the invoice number and total, but **seller identity was rebuilt
from the live `Restaurant` on every print**. Editing today's profile rewrote
yesterday's tax invoice. For a VAT-registered business that is an
accounting-integrity problem, and P2D makes it worse by inviting tenants to
edit their identity.

`Order.invoiceIdentity` now captures name, legal name, PAN, address, phone,
branch and the printed footer at the moment the number is allocated, and is
listed in `FROZEN_INVOICE_PATHS` so it is as immutable as the number itself.
Reprints read the snapshot; new invoices capture current identity.

Deliberately **narrow**: only what a tax invoice must legally carry. The logo
is cosmetic and is not snapshotted.

Orders invoiced **before** P2D have no snapshot and fall back to live values —
the pre-existing behaviour. A snapshot cannot be invented after the fact,
because nobody knows what the profile said that day; the receipt payload
reports `identitySource: 'live' | 'snapshot'` so the difference is legible
rather than guessed at.

### Custom domains — modelled, NOT served

Hostname normalisation, a unique partial index, an ownership token, an explicit
`verified` flag and full audit. **DNS and TLS are not automated**: this
deployment terminates TLS outside the stack and has no ACME integration, so
`customDomain` is a recorded intention. Every response carries
`serving: false`, and nothing in the request path trusts the `Host` header —
adding hostname-based tenant resolution without that caveat would be the real
vulnerability, since `Host` is caller-controlled behind a proxy.

### Logo storage

There is **no upload pipeline** in this repository — no multer, no static
serving, no object-storage client. Rather than invent S3 credentials, P2D
stores a **validated external URL**. A real uploader can be added behind the
same field without changing any caller. Object storage is an operational
dependency that does not exist yet, not a solved problem.

### Caching, and its honest multi-instance behaviour

A per-process `Map` with a 60-second TTL and explicit invalidation on every
write. **Multi-instance:** a branding change invalidates only the instance that
served the write; other instances keep the previous value until their own entry
expires. Worst case is ~60 seconds of stale colours or an old logo on some
instances — cosmetic, self-healing, and not a correctness or security problem,
which is why Redis is not justified here.

The cache does **not** self-heal in general: a write that bypasses the service
leaves a stale entry until the TTL. Proven, and the reason the invalidation
calls stay even where a subsequent fresh read happens to mask them.

### Migration

**None was needed, and that was verified rather than assumed.** `branding` is a
new optional sub-document and `settings` is merged, never replaced. Checked
against an old restaurant with no `branding` key, a partially configured one
and a fully configured one: all three render correctly, legacy `settings` keys
survive, and no default is written back.

## 3E. Audit-chain canonicalisation — P2D.1

### The contract

`services/auditCanonical.js` is the **single** canonicaliser, used by audit
creation, verification and the CLI tool. Duplicating it is how the three drift
apart and a chain starts reporting phantom tampering.

**Hash what will be STORED, not what was passed in.** The hash is stamped in
`pre('validate')`, before MongoDB writes the document; MongoDB then omits keys
whose value is `undefined`. Hashing the pre-write object therefore produced a
hash the stored row could never reproduce.

| Value | Canonical form | Note |
|---|---|---|
| `undefined` (object value) | key **omitted** | matches what MongoDB stores |
| `null` | `null` | distinct from undefined |
| missing key | absent | identical to undefined — they store identically |
| `undefined` (array element) | `null` | dropping it would shift indices |
| `Date` | ISO-8601 | invalid → `[invalid-date]` |
| `ObjectId` | 24-char hex | |
| `NaN` / `±Infinity` | `[number:NaN]` etc. | JSON would silently emit `null` |
| object keys | sorted | insertion order cannot change a hash |
| cycles / depth > 12 | `[circular]` / `[depth]` | |

### Versioning

`Audit.hashVersion` records which rules produced the hash. Absent means v1.
Verification applies the rules a row declares, so a pre-fix row is reported as
**legacy**, not as tampering.

### Row classification

| Class | Meaning |
|---|---|
| valid | hash verifies |
| `legacy_canonicalisation` | verifies under v1; intact, predates the fix |
| `legacy_unverifiable` | v1 row whose hashed payload MongoDB discarded — unverifiable either way, **not** evidence of tampering |
| `content` | matches no known ruleset. **The real alarm.** A row declaring v2 always lands here |
| `malformed` | no hash or no sequence |
| `link` / `sequence` | broken parent, or a gap from a deleted row |

`verified` excludes the legacy classes. A deployment with pre-P2D.1 history
would otherwise report a permanent breach, and operators would learn to ignore
the alarm — destroying the value of the check.

### Verification tool

```bash
npm run audit:verify                          # all chains, read-only
npm run audit:verify -- --json                # machine-readable
npm run audit:verify -- --restaurant <id>     # one tenant
```

Exit `0` intact, `1` integrity problem, `2` tool failure. **CLI only, never an
HTTP endpoint**: it walks every tenant's chain, and the per-tenant HTTP case is
already served by the owner-scoped `verifyAuditChain()`.

### Concurrency

`withChainLock()` serialises stamping per chain. Because the insert lands after
the lock releases, `pendingHeads` tracks the head this process just stamped —
without it, 30 concurrent writes produced only 21 distinct sequence numbers.
The stored head wins whenever it is further along, so a stale entry cannot move
the sequence backwards.

**Across instances** two processes can still stamp the same `prevHash`. That is
unchanged, detected as a `link` problem, and fixing it needs a database-side
counter — out of scope here.

### No repair tool, deliberately

Two different pre-write objects store identically, and the dropped key *names*
are unrecoverable. Any repair would be inventing evidence, which is worse than
an honest gap in an audit trail.

## 4. Configuration and customization strategy

| Layer | Where | Phase |
|---|---|---|
| Identity — name, legal name, PAN, slug | `Restaurant` columns | **P1** |
| Locale — currency, VAT, service charge, timezone | `Restaurant` columns | **P1** |
| Branding — logo, colours, receipt header/footer | `Restaurant.settings` | P4 |
| Feature availability | plan entitlements, not settings | P3 |
| Operational — menus, tables, stations, roles | existing per-tenant collections | done |

**Branding and feature flags are separated on purpose.** Branding is what a
tenant may change freely. Features are what a tenant has *paid for* — a tenant
must never be able to grant itself a module by editing settings.

Existing strengths worth not breaking: **zero hardcoded brand strings in the
client**, receipts already read `restaurant.receiptFooter`, and onboarding
already models `Restaurant → Branch → Users → Ingredients → Suppliers → Menu →
Tables`.

---

## 5. Subscription strategy (P3 — not built)

```
Plan       feature entitlements + limits (branches, users, orders/month)
Subscription  tenant → plan, period, status
Usage      metered counters for limit enforcement and invoicing
```

Two rules already settled:

- **Entitlements are checked server-side**, in the same guard layer as
  permissions. Hiding a button is not a feature gate.
- **`Restaurant.status` is the authorisation input**; the subscription writes
  it. A `suspended` tenant is refused at the guard, not at the billing service.

At ~NPR 8,300/restaurant/month for the 1 crore target, billing can start manual
(bank transfer + an operator marking the tenant active). Automated collection
is a later optimisation, not a launch blocker.

---

## 6. Scaling architecture — P1E

```
                    Internet
                        │  TLS terminates HERE (not built — see limitations)
                        ▼
                   ┌─────────┐
                   │  Nginx  │  static SPA, /api proxy, WebSocket upgrade
                   └────┬────┘
                        │
            ┌───────────┴───────────┐
            ▼                       ▼
      ┌──────────┐            ┌──────────┐
      │  API #1  │            │  API #2  │   ← multi-instance needs §6.1
      └────┬─────┘            └────┬─────┘
           └───────────┬───────────┘
                       ▼
                 ┌───────────┐
                 │  MongoDB  │  replica set (transactions required)
                 └───────────┘
```

Today's verified deployment is **one API instance**. That is sufficient for
~100 tenants of this size, and is what the Docker stack runs.

### 6.1 What breaks on the second instance

Three things are per-process and would silently misbehave, not fail loudly:

| Component | Single-instance behaviour | Needed for N instances |
|---|---|---|
| Rate limiting | in-memory counters | shared store — `configureRateLimitStore()` hook exists |
| Socket.IO | in-memory adapter; events reach only that process's sockets | shared adapter |
| Scheduler lock | Mongo-based lease (already distributed) | **already correct** |
| Realtime replay buffer | per-process, 100/room | shared, or accept reconnect gaps |

**The scheduler lease is already distributed** — it was built that way in Phase
16B and needs no change.

### 6.2 Redis — only where required

Redis is **not** in the stack and should not be added until a specific need
exists. When it does, the needs are:

1. **Socket.IO adapter** — the first real driver. Without it, a customer on
   instance #1 never sees an order accepted on instance #2.
2. **Distributed rate limits** — otherwise every limit multiplies by instance
   count.
3. **Cache invalidation** — the role cache already uses a MongoDB change
   stream, which works multi-instance; Redis would be an optimisation, not a
   fix.

**Scheduler locks do not need Redis** — the Mongo lease is correct.

Adding Redis for its own sake buys another service to secure, back up, monitor
and fail over. The trigger is the second API instance, not the roadmap.

### 6.3 Noisy-neighbour risks at 100 tenants

- **Rate limiting is per-IP, not per-tenant.** A busy tenant's traffic competes
  with everyone's on shared buckets. Per-tenant quotas belong with plan limits
  in P3.
- **The reorder scheduler loops all tenants serially in one process.** Fine at
  3, a long sweep at 100. Needs either per-tenant scheduling or a work queue.
- **No per-tenant resource caps.** One tenant's huge report can occupy the
  event loop. Pagination (Phase 26) bounds the worst cases; hard caps do not
  exist.

---

## 7. Security boundaries

| Boundary | Enforced by | Verified |
|---|---|---|
| Tenant | `restaurant` on the row + `userRestaurantContext()` | 45 test files; P1D matrix over all roles |
| Branch | `assertTenantBranchAccess()` / `purchaseBranchContext()` | Phase 25 |
| Role | 72 permissions, `requirePermission()` | 78 test files |
| Self-scope | `requireSelfScopedPermission()` (riders) | Phase 24 |
| Transport | Nginx security headers, JWT HS256 + mandatory `exp` | Phase 25/28 |

**`assertBranchAccess()` returns early for an owner** — correct within a
restaurant, and exactly why the tenant check must be separate. An owner is the
account a branch-only check fails to stop, which is why the P1D matrix tests
with an owner.

**The platform-admin boundary does not exist yet.** `owner` is currently the
ceiling; nobody can legitimately act across tenants. That is safe but means
support work requires database access. P2 introduces it — and it is the single
most dangerous role in a SaaS, so it needs its own audit trail from day one.

---

## 8. Honest limitations after P1 / P2A / P2B / P2C / P2D / P2D.1

- **Isolation is application-enforced.** A missing filter leaks. P1B narrows
  the surface for the two riskiest collections; it does not eliminate the class.
- **`restaurant` is not yet `required`** on Order/Payment — legacy rows.
- **Platform administration (P2B) is built**: three roles, ten permissions,
  dashboard, cross-tenant user administration, platform audit, and a separate
  admin workspace. What it still does NOT do: no platform-side password reset,
  no operator MFA, no IP allowlisting for the platform surface, no session
  listing per operator, and no email notification when authority changes.
- **Subscriptions, plans and entitlements exist (P2C)**, but: **no payment
  gateway** — no charge is ever taken and no gateway transaction is fabricated;
  no invoices, no dunning, no proration, no tax on subscription fees; no tenant
  self-service billing; `past_due` is set only by hand.
- **Limit enforcement covers four representative resources** (users, branches,
  menu items, tables). Every other resource is unmetered until a later phase
  applies the same central mechanism.
- **Feature entitlements are resolvable but only partly enforced.** The
  resolver reports all 15 keys; individual feature gates are added as each
  surface is wired up.
- **The entitlement cache is per-process with a 30s TTL.** A missed
  invalidation self-heals within 30 seconds; across instances a plan change can
  take that long to be seen everywhere.
- **No feature flags beyond plan entitlements, no branding, no tenant
  self-signup.** P2D–P2H.
- **The first operator still requires shell access** (`scripts/platform-admin.js`).
  That is the design, not a gap — but it means platform bootstrap cannot be
  performed by anyone without server access.
- **The grant rank-ceiling is currently unreachable** and proven so: only
  `super_admin` holds `platform.admins.manage`, and it is already top rank. It
  is retained for the first mid-rank granting role, and a test fails loudly if
  one is added without the accompanying escalation test.
- **Platform operators are exempt from tenant lifecycle blocking.** Necessary
  for suspension to be reversible, but it does mean an embedded operator keeps
  working inside a suspended restaurant.
- **Branding (P2D) covers name, logo, favicon, colours, typography, storefront
  copy, receipt identity and contact details**, gated by plan tier. What it does
  NOT do: no logo UPLOAD (an external URL only — there is no object storage);
  no DNS/TLS automation for custom domains (modelled and audited, never served);
  no per-tenant email templates; no localisation beyond a stored preference —
  the `ne` locale is selectable but no translations ship; POS/KDS remain
  deliberately un-themed so operational readability cannot be degraded.
- **FIXED IN P2D.1** — the audit-chain `undefined` defect reported at the end
  of P2D. Canonicalisation now hashes what will be STORED, so the false
  `content` alarms are gone. A duplicate-sequence race under concurrent writes
  was found and fixed in the same phase. Historical rows that carried an
  `undefined` remain **unverifiable** (their hashed payload no longer exists)
  and are reported as `legacy_unverifiable` rather than as tampering — see
  §3E. Content tampering with one of those specific rows cannot be detected by
  its own hash, though the chain link still detects insertion, deletion and
  re-parenting.
- **Single-instance only** — see §6.1.
- **Rate limits are per-IP, not per-tenant.**
- **The three production preconditions still stand**: terminate TLS, enable
  MongoDB `--auth`, ship backups off-host.
- **Payments have only ever run in sandbox mode.**
