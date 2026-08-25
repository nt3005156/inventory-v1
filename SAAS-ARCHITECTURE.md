# SaaS architecture — P1 · P2A · P2B

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

## 8. Honest limitations after P1 / P2A / P2B

- **Isolation is application-enforced.** A missing filter leaks. P1B narrows
  the surface for the two riskiest collections; it does not eliminate the class.
- **`restaurant` is not yet `required`** on Order/Payment — legacy rows.
- **Platform administration (P2B) is built**: three roles, ten permissions,
  dashboard, cross-tenant user administration, platform audit, and a separate
  admin workspace. What it still does NOT do: no platform-side password reset,
  no operator MFA, no IP allowlisting for the platform surface, no session
  listing per operator, and no email notification when authority changes.
- **No subscriptions, plans, feature flags, or tenant self-signup.** P2E–P2H.
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
- **Branding is receipt-footer only.** No logo, colours, or custom domain.
- **Single-instance only** — see §6.1.
- **Rate limits are per-IP, not per-tenant.**
- **The three production preconditions still stand**: terminate TLS, enable
  MongoDB `--auth`, ship backups off-host.
- **Payments have only ever run in sandbox mode.**
