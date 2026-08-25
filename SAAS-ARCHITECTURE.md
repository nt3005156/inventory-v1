# SaaS architecture — P1

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

## 8. Honest limitations after P1

- **Isolation is application-enforced.** A missing filter leaks. P1B narrows
  the surface for the two riskiest collections; it does not eliminate the class.
- **`restaurant` is not yet `required`** on Order/Payment — legacy rows.
- **No platform admin, subscriptions, plans, feature flags, or tenant
  self-signup.** P2/P3.
- **Branding is receipt-footer only.** No logo, colours, or custom domain.
- **Single-instance only** — see §6.1.
- **Rate limits are per-IP, not per-tenant.**
- **The three production preconditions still stand**: terminate TLS, enable
  MongoDB `--auth`, ship backups off-host.
- **Payments have only ever run in sandbox mode.**
