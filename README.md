# Mittho OPS — Restaurant Operations, Inventory & Costing (Nepal)

Mittho OPS is a full-stack restaurant operations platform for Nepal. Purchasing receipts and returns update lot-aware inventory and weighted cost, recipes drive stock consumption and historical COGS, and supplier liabilities reconcile invoices, payments, reversals, and statements. Money is recorded in NPR and purchasing supports Nepal's 13% VAT convention.

## Modules

- JWT authentication with **Owner / Manager / Staff** authorization
- Restaurant and branch-scoped suppliers, catalogs, purchase orders, approval history, receipts, damage, returns, invoices, payments, statements, and purchasing reports
- Batch/lot provenance, expiry tracking, inventory balances, and an auditable stock-movement ledger
- Branch-scoped Socket.IO updates, with management-only purchasing financial events
- Recipes, menu costing, POS, kitchen display, tables, billing, transfers, waste, alerts, expenses, dashboard, P&L, and menu engineering
- Branch-aware month reconciliation with immutable close revisions and owner-controlled reopen
- Same-origin production web/API/Socket.IO routing through Nginx
- MongoDB transaction enforcement, startup data/index migrations, readiness checks, and graceful API shutdown

## Menu engineering (Phase 3E)

`GET /api/analytics/menu-engineering/report` (owner/manager, branch-scoped) analyzes the live
menu across five dimensions. Query parameters: `branch`, `from`, `to`,
`targetFoodCostPercent` (default 35), and `limit` (default 5).

| Dimension | How it is measured |
|---|---|
| **Popularity** | Share of plates sold per item, plus a `popularityIndex` against an equal share of the menu. An item is popular at the Kasavan–Smith 70% rule (`index >= 0.7`). Cancelled and refunded tickets are excluded. |
| **Food cost** | Recipe cost plus packaging. Sold items keep the food cost captured on the order line, so historical margins never move when today's stock cost changes; unsold items are priced from the live branch recipe cost (`costSource` reports which was used). |
| **Margin** | `price - foodCost` per plate, with `marginPercent`, `totalMargin`, and revenue for the period. |
| **Profitable items** | Items at or above the sales-weighted average margin, ranked by total contribution margin earned. |
| **Low-margin items** | Items whose food cost exceeds the target percent, or that sell at a loss, ranked worst-first with `overTargetBy` and a recommended action. |

Each item is also placed on the menu-relative matrix (`matrixClass`): **Star**, **Plow-horse**,
**Puzzle**, or **Dog**. The legacy `GET /api/analytics/menu-engineering` array endpoint is
unchanged and still returns the fixed-cutoff `classification`.

The Analytics screen renders the summary KPIs, the menu mix, the full item table, and the
profitable / low-margin breakdowns.

## POS core (Phase 4A)

`POST /api/orders` sells through four channels, each with its own rules enforced at creation:

| Channel | Table | Service charge | Delivery |
|---|---|---|---|
| `dine-in` | **Required** | 10% by default (waivable per order) | — |
| `takeaway` | Rejected | None | — |
| `counter` (default) | Rejected | None | — |
| `delivery` | Rejected | None | Customer + address **required**; optional fee |

**Pricing and taxes.** Each line is priced from the menu item's `vatInclusive` flag: an
inclusive price already contains the tax, so VAT is extracted from within it and the guest pays
exactly the listed amount; an exclusive price is net and 13% VAT is added on top. Lines persist
their own `lineNet`, `lineVat`, and `lineTotal`.

Totals follow Nepal convention: net subtotal, less discount, plus service charge, with VAT
applied to that whole base. A discount removes its tax with it, the service charge is itself
taxable, and the delivery fee is a pass-through added after VAT and never taxed. A discount
larger than the subtotal is rejected. Split checks inherit the parent channel's service-charge
rate and per-line VAT treatment, so a split ticket totals exactly like the original.

## POS modifiers (Phase 4B)

Menu items may declare modifier groups, and the POS validates every selection against that
catalog — a till can never invent a modifier or set its own price.

| Kind | Effect on price | Effect on stock |
|---|---|---|
| `variant` | `priceOverride` replaces the line price (Small/Medium/Large) | Optional ingredient mapping |
| `extra` | `priceDelta` added | Consumes additional stock |
| `addon` | `priceDelta` added | Usually price-only |
| `removal` | `priceDelta` (often 0 or negative) | **Credits** the ingredient back |

Groups support `required`, `single`/`multi` selection, and `minSelect`/`maxSelect`; unknown
groups or options, duplicates, and cardinality breaches are all rejected. Each line also accepts
free-text `specialInstructions` (500 chars).

Modifiers mapped to an ingredient flow through the lot-aware ledger: an extra deducts more
stock and raises the line's food cost, a removal credits stock back and lowers it. A removal can
never take out more than the recipe uses, and a movement that nets to zero writes no ledger
entry at all. Lines are only merged across tables when their modifiers *and* instructions match,
so a plain dish is never combined with a customised one.

```jsonc
POST /api/orders
{
  "branch": "...", "type": "counter",
  "items": [{
    "menuItem": "...", "qty": 2,
    "modifiers": [{"group": "size", "option": "large"}, {"group": "extras", "option": "cheese"}],
    "specialInstructions": "Less oil"
  }]
}
```

## Discounts & promotions (Phase 4C)

Discounts apply at two levels, each as a **percentage** or a **fixed** NPR amount:

| Level | Field | Applied to |
|---|---|---|
| Item | `items[].discount` | That line's net, before order maths |
| Order | `discount` | The subtotal after item discounts |
| Coupon | `coupon` | The same post-item base; stacks with a manual discount |

VAT always follows the discounted base, so reducing a line reduces its tax with it. The
dine-in service charge is calculated after discounts. A mistyped **manual** amount above the
order is rejected outright, while a management-set **coupon** worth more than the order simply
clamps to it — a keying error should fail loudly, a generous promotion should not.

**Coupons** (`/api/coupons`) support percentage or fixed value, `maxDiscount` cap,
`minOrderAmount`, a validity window, total and per-customer usage limits, and scoping to
branches, order types, or specific menu items. `POST /api/coupons/validate` previews a code
without consuming it. Redemptions are recorded per order, so usage limits hold and a failed
order leaves no redemption behind.

**Authorization.** Any staff member may apply a manual discount; every discount is written to
the audit log with the amount, reason, and who applied it. Creating and editing coupons is
owner/manager only, and retiring one is owner-only — coupons are deactivated rather than
deleted so redemption history survives.

## KDS & kitchen operations (Phase 5A)

`GET /api/kitchen/board?branch=...` returns the kitchen queue as four working stages:

```
New  →  Preparing  →  Ready  →  Completed
```

The underlying order statuses are unchanged — billing, tables and the realtime feed depend on
them — so the five queue statuses map onto the stages the kitchen thinks in: `pending`/`confirmed`
are **New**, `accepted`/`preparing` are **Preparing**, then **Ready** and **Completed**. Completed
tickets leave the board unless `includeCompleted=true`.

| Filter | Query | Behaviour |
|---|---|---|
| Branch | `branch` (required) | Enforced by role; staff cannot read another branch |
| Station | `station` | Ticket appears only if it has work there, and shows *only* that station's lines |
| Stage | `stage` | One of `new`, `preparing`, `ready`, `completed` |
| Priority | `priority` | One of `normal`, `due`, `late`, `overdue` |

**Stations** are declared per menu item (`station`, `prepMinutes`) from
`grill, fry, tandoor, curry, cold, bakery, dessert, bar, expo, kitchen`, and are copied onto the
order line at creation so a ticket can be routed without re-reading the menu.
`GET /api/kitchen/stations` lists them.

**Priority** escalates automatically with order age against the ticket's target prep time — the
slowest item on the ticket, or a per-channel default (delivery 10m, counter/takeaway 12m, dine-in
15m). A ticket is `due` at 75% of target, `late` at target, and `overdue` at 1.5×. `PATCH
/api/orders/:id/priority` flags a manual **rush**, which always sorts first and reports the top
level so an expediter's call is never downgraded by the clock. The board sorts rush → escalation →
oldest first, so nothing is starved behind a newer urgent ticket.

Each stage entry is timestamped (`acceptedAt`, `preparingAt`, `readyAt`, `completedAt`), written
once on first entry, so time-in-stage is measurable rather than estimated.

## Online ordering (Phase 8A)

A public storefront at `/order` lets a guest order without an account:

```
Menu → Cart → Customer → Address → Payment → Order
```

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/public/branches` | none | Branches accepting online orders |
| `GET /api/public/menu?branch=` | none | Public menu with modifier choices |
| `POST /api/public/quote` | none | Server-priced cart total |
| `POST /api/public/orders` | none | Places the order |
| `GET /api/public/orders/track` | none | Status by order number **and** phone |
| `GET /api/online-orders?branch=` | staff | The branch's web-order queue |
| `POST /api/online-orders/:id/accept` | staff | Confirms the ticket |
| `POST /api/online-orders/:id/reject` | manager | Cancels with a reason |

**The browser supplies intent, never authority.** A guest sends menu item ids, quantities and
modifier choices; every price, tax and total is derived server-side from stored records, so a
tampered cart cannot buy a Rs. 400 dish for Rs. 1. Request schemas are strict, so an injected
`unitPrice` or `total` is rejected outright.

The public menu exposes only what a guest needs to choose a dish — **cost, margin, recipe,
supplier and station data never leave the building**. Order tracking requires the order number
*and* the matching phone, and a mismatch returns the same 404 as an unknown order, so orders are
not enumerable. Public endpoints carry their own rate limits (ordering is capped hardest at 8 per
15 minutes), and a guest cannot reach the authenticated order API.

**Security controls on the public surface.** Every one is enforced by the backend and covered by
attack tests:

| Control | Behaviour |
|---|---|
| Idempotency | `Idempotency-Key` on checkout. A repeat returns the original order with `replayed: true`; a unique partial index makes a duplicate impossible even under a race |
| Stock safety | Availability is checked when the order is taken and again, transactionally, on acceptance. Stock can never go negative — six orders against three plates accept exactly three |
| Price integrity | Strict schemas reject an injected `unitPrice`, `total`, `discount`, `vat` or `deliveryFee`; every figure is recomputed from stored records |
| Coupons | Reuse the Phase 4C engine, so validity window, branch and menu scope, usage and per-customer limits, minimum spend and maximum cap all apply to anonymous guests |
| Order privacy | Tracking needs the reference **and** the phone; a mismatch returns the same 404 as an unknown order |
| Customer privacy | The Customer collection is not readable publicly, and ordering under a known phone echoes nothing back |
| Error safety | Public errors are sanitised — no zod dumps, Mongo errors, stack traces or paths |
| HTTP headers | Public responses are `no-store`, `nosniff`, `DENY` framing, `no-referrer` |
| Rate limits | Browse 120/min, quote 30/min, track 20/min, **order 8 per 15 min** |

**A web order does not move stock.** It is created `pending` with `source: 'online'`; the branch
accepts or rejects it, and only acceptance commits the ticket — deducting inventory for an order
that may be refused would corrupt the ledger.

Stock is deducted **on acceptance**, inside the transaction, reusing the lot-aware ledger — so a
branch cannot accept more orders than it can cook.

**Payment is honest about what happened.** Cash on delivery settles on handover. Choosing eSewa or
Khalti records the *intent* as a `pending` Payment row and reports `awaiting_payment`; no gateway
is called and no money is claimed. Live gateway integration is a separate task.

## Table billing (Phase 6D)

| Capability | Endpoint |
|---|---|
| Split bill onto a separate check | `POST /api/orders/:id/split` |
| Item share (pay only chosen items) | `POST /api/orders/:id/payments` with `items` |
| **Equal split** | `POST /api/orders/:id/split-equal` with `ways` |
| Partial payment | `POST /api/orders/:id/payments` with `amount` |
| Multiple payment methods | Repeat payments with different `method` values |
| Settlement | Full payment closes the check and releases the table |
| **Table settlement** | `GET /api/tables/:id/settlement` |

**Equal split reconciles to the paisa.** Naive division loses or invents money — 1740.20 split
three ways is 580.0666…, and three rounded shares of 580.07 would collect 1740.21. Each share is
floored to paisa and the remainder distributed one paisa at a time, so the shares always sum back
to the balance exactly (`[580.07, 580.07, 580.06]`). The quote reports `sharesTotal` as proof.

Splitting is a **calculation, not a mutation**: it quotes what each guest owes and takes no money,
so there remains one payment code path. Shares are computed from the **outstanding balance**, so a
split after a partial payment divides only what is left. Each guest may then settle their share
with a different tender.

**Table settlement** totals every check seated at a table, with a per-tender breakdown (refunds
net off) and a `readyToClear` flag, so a host can see whether a party split across several checks
still owes anything without opening each check individually.

**`GET /api/tables/:id/bill`** aggregates every check on a table — which may be several after a
split — reporting the combined total, paid, balance, per-check position and a tender breakdown, so
a host can close the table confidently.
| Operation | Endpoint |
|---|---|
| Split bill onto a second check | `POST /api/orders/:id/split` |
| Pay a share of specific items | `POST /api/orders/:id/payments` with `items` |
| **Equal split** | `POST /api/orders/:id/split-equal` with `ways` |
| Partial payment / multiple methods | `POST /api/orders/:id/payments` with `amount` + `method` |
| Check settlement | `GET /api/orders/:id/payment-summary` |
| **Table settlement** | `GET /api/tables/:id/settlement` |

**Equal split** divides the *outstanding balance* (so it still works after a deposit) into shares
that sum **exactly** to the amount owed. Naive division strands money: Rs. 435.05 / 3 rounds to
145.02, and three of those overshoot by a paisa, so the last guest's payment is rejected and the
check is left open. The split is computed in integer paisa with the remainder distributed one
paisa at a time, so the shares always reconcile. The endpoint is a **quote** — the till then takes
each share as an ordinary payment, keeping one payment path.

**Table settlement** totals every check seated at a table, with a per-tender breakdown (refunds
net off) and a `readyToClear` flag, so a host can see whether a party split across several checks
still owes anything without opening each one.

## Reservations (Phase 6C)

`/api/reservations` books a table for a **window of time** rather than blocking it outright, so a
table booked for 20:00 stays sellable all afternoon.

| Field | Notes |
|---|---|
| Customer | An existing `Customer`, or a name + phone captured inline for a phone booking |
| Date / time | Local `YYYY-MM-DD` and `HH:MM`, resolved to absolute instants so overlap checks are timezone-proof |
| Party size | Validated against the table's capacity |
| Table | Optional at booking; a host can assign it later |
| Status | `booked → confirmed → seated → completed`, with `cancelled` and `no_show` as terminal outcomes |

Two bookings whose windows overlap on the same table are rejected, naming the clashing reference.
Back-to-back bookings are allowed. Cancelling or marking a no-show frees the slot immediately and
releases a held table, while the record itself is kept for history — reservations are never
deleted. Every booking gets a sequential `RES-<BRANCH>-<YEAR>-#####` reference.

- `GET /api/reservations?branch=&date=` — the day's diary with covers and status counts
- `GET /api/reservations/availability?branch=&date=&time=&partySize=` — which tables are free,
  and which are taken and by whom
- `POST /api/reservations/:id/hold` — flips the table to `reserved` when arrival is imminent
- `PATCH /api/reservations/:id/status` — guarded lifecycle transitions; seating claims the table
  through the existing table machinery
- `DELETE /api/reservations/:id` — cancels with a reason, recording who and when

Impossible calendar dates are rejected: JavaScript rolls `2026-02-30` forward to March 2, which
would silently book a guest onto the wrong day.

## Table operations (Phase 6B)

| Operation | Endpoint | Notes |
|---|---|---|
| Move / transfer | `POST /api/tables/:id/move` | Re-tables an open check; refuses across branches |
| Merge | `POST /api/tables/:id/merge` | Combines two checks onto one table |
| Split | `POST /api/orders/:id/split` | Splits selected item quantities onto a second check |
| **Reopen** | `POST /api/orders/:id/reopen` | Restores a settled check (owner/manager) |
| **History** | `GET /api/tables/:id/history` | Table audit trail plus the checks seated there |

**Reopen** exists for the guest who returns and the payment keyed against the wrong ticket.
It returns the check to `ready` — the pass, not the kitchen queue, since the food was already
made — and re-seats the table even from `cleaning`. **Money is never touched**: payments already
taken stay recorded and only the outstanding balance is recomputed. `completedAt` is cleared so a
reopened check is not counted as finished by kitchen performance, and is re-stamped when it closes
again. Each reopen increments `reopenCount` and is audited with its reason and actor.

Refunded and cancelled checks are **not** reopenable — those are deliberate financial
terminations, and reversing one must go through the refund flow so the money trail stays intact.
A reopen is also refused if another party has since been seated at that table.

**History** correlates the audit trail already written for a table (status changes, moves, merges,
configuration edits, retirement) with the orders seated there, returning per-table revenue,
completed/cancelled/reopened counts and average turn time. Supports `from`, `to` and `limit`.

## RBAC: permissions, roles and sessions

Authorization is **permission-based**. A permission is the atom, a role is a named bundle, and a
user holds exactly one role. There are no per-user permission overrides: "why can this person do
that?" must always be answerable by naming their role.

### Capability naming

`resource.action`, lowercase, exactly two segments — `orders.refund`, `purchase.approve`,
`inventory.adjust`, `users.manage`. A test enforces the convention, and a second test asserts
every `requirePermission(...)` argument is a real catalogue key, so a typo cannot silently make
an endpoint unreachable.

The catalogue lives in `server/src/services/permissions.js` and is served by
`GET /api/permissions`. `GET /api/me/permissions` returns the caller's own effective list and is
readable by every authenticated principal, including riders.

### Built-in roles

| Role | Reach |
|---|---|
| `owner` | Everything, implicitly — including permissions added by future phases. An owner can never be locked out by a mis-edited role. |
| `manager` | Runs a branch: inventory, purchasing, refunds, reports, roster read. |
| `staff` | Floor work: orders, payments, kitchen, stock counts, waste, goods *view*. |
| `rider` | `deliveries.ride` only — their own assigned deliveries. |

Built-in roles cannot be edited or deleted. They are the floor the system is tested against and
the recovery path when a tenant breaks its own custom roles.

Capabilities deliberately withheld from `manager` because the endpoint has always been
owner-only: `payments.reverse`, `purchase.reversepay`, `menu.delete`, `ingredients.delete`,
`coupons.delete`, `customers.delete`, `monthclose.manage`, `branches.manage`, `roles.manage`,
`audit.view`, `inventory.recover`, `settings.manage`, `users.create`, `users.password`,
`users.deactivate`.

### Custom roles

A tenant defines its own roles (Cashier, Storekeeper, Kitchen, Purchaser…) at
`POST /api/roles`. Each declares a `baseRole` of `manager`, `staff` or `rider` — never `owner` —
which is what tenancy scoping, rider workspace routing and Socket.IO room policy continue to
reason about. `roleKey` narrows; it never widens.

A custom role holds **exactly** the permissions granted. It does *not* inherit its base role's
bundle, and it is admitted only through `requirePermission()`. Any endpoint still on a bare role
list refuses custom roles outright — deliberately conservative, so the failure mode is visible
rather than a silent over-grant.

A non-owner administrator cannot grant or assign a permission they do not themselves hold.

### Account lifecycle

`POST /api/accounts` (permission `users.create`, owner-only by default) is the single
provisioning path: the tenant comes from the caller's token and is never accepted from the body,
the password is policy-checked and bcrypt-hashed, and the response is a safe projection that can
never carry a credential. An owner account cannot be minted through the API.

Deactivation (`users.deactivate`) is immediate and total: the account fails login, its existing
tokens stop working, and its live sockets are disconnected. Reactivation does **not** resurrect
old tokens.

### Rider self-scope

The four rider-workspace endpoints (`/deliveries/mine*`) use
`requireSelfScopedPermission('deliveries.ride')` rather than
`requirePermission`. The difference matters: `requirePermission` admits an
owner because an owner implicitly holds every permission, and before this was
fixed `GET /deliveries/mine/dashboard` returned 200 to an owner with a rider
profile synthesised from their own user document. No other rider's data leaked
— the handlers scope by `user.id` — but a non-rider had no business there.

The self-scoped guard requires the permission to come from the principal's own
bundle **and** the base role to be one the capability belongs to, so an owner,
manager or staff member is refused while a built-in rider or a custom
rider-based role (a "Courier") is served. `PATCH /deliveries/:id/status` is
genuinely dual-audience and remains on `requirePermission('deliveries.dispatch',
'deliveries.ride')`; the service decides what each principal may set.

### Token and session invalidation

Every JWT carries `sv`, the user's `sessionVersion` at sign-in. The guard compares it to the
stored value on every request, so incrementing `user.sessionVersion` invalidates every token
issued before the bump. A version counter was chosen over a token blacklist because it is O(1)
to check, needs no expiry sweep and cannot grow without bound.

Sessions are revoked on: logout (`POST /api/auth/logout`), password reset, deactivation, and
explicitly by an administrator. Role and branch reassignment refreshes access *without* signing
the person out — they are still employed — but their sockets are re-authorised in place.

Tokens minted before `sv` existed are treated as version 0, so shipping this did not sign
everyone out.

### Per-device sessions

`sessionVersion` gives global revocation; it cannot express "sign this phone out and leave the
till running". Each login therefore also mints a `UserSession` row and puts an opaque random
`sid` in the JWT. **Only the SHA-256 hash of that id is stored** — a leaked database yields no
usable session credential — and the row carries `expiresAt` with a TTL index, so the collection
is self-pruning and bounded.

| Endpoint | Effect |
|---|---|
| `POST /api/auth/logout` | Ends **this device** only. Other devices keep working. |
| `POST /api/auth/logout` with `{"allDevices": true}` | Bumps `sessionVersion`; ends everything. |
| `GET /api/auth/sessions` | The caller's own devices. Never exposes a hash. |
| `DELETE /api/auth/sessions/:id` | Revokes one named device. |

Revoking is always scoped to the authenticated user, so one user cannot end another's session by
guessing an id — a mismatch is a 404, which also avoids confirming the id exists. Revoked rows
are kept, not deleted, so the trail survives until the TTL removes them. Deactivation and
password reset revoke every device row **and** bump the version.

A token with no `sid` (minted before this shipped) is accepted and stays covered by the version
check; logging such a token out falls back to a global sign-out rather than silently doing
nothing.

**Limitation:** a device is identified by its session row, not by hardware. Two logins from the
same browser are two sessions.

### Socket.IO authorization

The handshake resolves the principal against **storage**, exactly as the HTTP guard does — a
deactivated, demoted or signed-out user cannot open a socket even with a syntactically valid
token, and the role used thereafter is the stored one, never the client's claim.

When a role, permission set or branch assignment changes, the write pushes the change to live
connections: rooms the user no longer qualifies for are left, management rooms are gained or
lost, and a `permissions:changed` event is emitted. Deactivation and revocation emit
`session:revoked` and hard-disconnect. Riders never join a branch room.

**Limitation — single instance.** `io.fetchSockets()` sees only this process's connections. There
is no Redis, no Socket.IO adapter and no pub/sub in this repository, so a role change served by
instance A cannot push to a socket held by instance B; that socket keeps its rooms until it
reconnects or the branch next publishes, at which point `evictStaleBranchSockets()` revalidates it
lazily. No distributed guarantee is claimed. HTTP authorization is unaffected either way — it
resolves from the database on every request, so a stale socket can receive events it should not
see but can never perform an action.

### Branch and restaurant isolation

Permission checks alone do not grant tenancy. Every branch-scoped handler still resolves scope
through `assertTenantBranchAccess()` or `purchaseBranchContext()`, so holding `purchase.view`
lets a user read purchase orders **in their own branch**, not everywhere. A custom role key is
resolved inside the holder's own restaurant, so it cannot be borrowed across tenants.

### Discount authorization

Any user with `orders.discount` may discount; every discount is audited and requires a reason.
Exceeding `staffMaxDiscountPercent` / `staffMaxDiscountAmount` requires the separate
`orders.discountoverride` permission, so a custom Supervisor can be given override authority
without being promoted to manager. `maxDiscountPercent` remains a hard ceiling that applies to
everyone, owners included, to catch a mistyped 100%.

When no resolved principal is available (an internal or script caller) the legacy
owner/manager role list still applies, so pre-existing call paths behave unchanged.

### Cache behaviour

Permission resolution was **measured first**: `resolvePrincipal()` costs ~0.64 ms/call against
the in-memory replica set (2,000 warmed calls), about 1,565 resolutions/sec/process.

The **user row is never cached**. It carries `active`, `rider.active`, `role` and
`sessionVersion` — the facts that decide whether a session is still valid — and caching them was
tried and proven unsafe: deactivating a manager with a direct database write left their token
returning 200 for the remainder of the TTL, reintroducing the exact defect the previous phase
fixed. Explicit invalidation cannot rescue that design, because authorization state legitimately
changes out of band (a second instance, a migration, the mongo shell).

Only the **role definition** is cached, keyed by `restaurant:roleKey`, 5-second TTL, bounded to
2,000 entries with oldest-first eviction, defensive copies on read, and promise coalescing.
Only *active* roles are stored, and a hit is revalidated against storage before it is trusted, so
withdrawing a role takes effect immediately.

Tunable via `RBAC_ROLE_CACHE_TTL_MS`, `RBAC_ROLE_CACHE_MAX`, `RBAC_ROLE_CACHE_DISABLED`.

**Cross-instance invalidation** is implemented with a MongoDB **change stream** on the `roles`
collection, not with new infrastructure. Change streams require a replica set, and this
deployment already requires one — `verifyTransactionCapableDatabase()` refuses to boot otherwise,
because purchasing uses transactions — so the seam already existed. Every instance watches for
role writes and drops its cached copy, which closes the window for an edit made on another
instance.

Honest scope: this covers **role definitions only**, which is all that is cached. User state is
read live on every request. It is best-effort — if the stream drops, the 5-second TTL remains the
backstop and correctness still holds. **The multi-instance path is not verified by the test
suite**: the harness runs one API process against a single-node replica set. What is tested is
that the watcher starts, that an out-of-band role write invalidates this process's cache through
the stream, and that it shuts down cleanly. Treat the multi-instance behaviour as designed, not
proven.

### Password reset

`POST /api/accounts/:id/password` (permission `users.password`, owner-only by default). There is
**no email infrastructure in this repository**, so there is no self-service "forgot password"
flow and none is implied. The new password is policy-checked by the existing
`assertPasswordPolicy()`, hashed with the existing bcrypt cost, and never echoed back; no hash is
ever returned, and the audit row carries no credential.

**Revocation policy — two deliberately different cases:**

| Case | Sessions revoked | Token returned |
|---|---|---|
| Administrator resets **somebody else's** password | **All** of the target's devices | None — an administrator is never handed the target's session |
| User resets **their own** password | Every **other** device; the calling one is spared | A rotated token for the calling device |

An admin reset almost always means the credential is suspect or the person has lost access, so
sparing anything would defeat it. A self reset keeps the browser the user just typed into, which
is not a weakening: every other device still dies, and sparing is only safe because the caller has
just proved control of the account.

`sessionVersion` is bumped in **both** cases, so a legacy token with no `sid` cannot survive
either path. That also makes the spared session's own token stale, which is why the route returns
a rotated token — the client is not silently signed out on its next request.

The revocation is scoped by `user`, so a reset can only ever touch the target's rows. Verified at
the database level, because HTTP status alone cannot distinguish it: the `sessionVersion` bump
would 401 the target regardless of whether the row-level revocation were correctly scoped.

### Role deletion

Built-in roles cannot be deleted or edited. A custom role still held by somebody is refused with
409 unless the caller supplies `?reassignTo=<roleKey>`, in which case every holder is moved in the
same operation, each move is audited individually, and their cached permissions and live sockets
are refreshed. The replacement must share the outgoing role's `baseRole`, so nobody silently
changes tenancy regime, and can never be `owner`. Nobody is ever left pointing at a role that no
longer resolves. The API enforces all of this independently of the UI.

## Realtime platform

Socket.IO carries nine business events. Every one leaves through a single
publish path, so they all share the same envelope and the same guarantees.

### Events

| Event | Fired when |
|---|---|
| `kitchen:new-order` | an order reaches the kitchen |
| `kitchen:status` | an order advances through the kitchen |
| `table:update` | a table is seated, released, merged, moved |
| `purchasing:update` | PO, receipt, supplier invoice or payment activity |
| `inventory:update` | stock moved |
| `inventory:alert` | reorder point, expiry or waste threshold crossed |
| `delivery:update` | a delivery is dispatched or advances |
| `payment:update` | payment taken, refunded or reversed |
| `order:update` | an order changed outside the kitchen lifecycle |

`payment:update` and `order:update` were added in this phase — taking a payment
previously emitted nothing at all, so a second till learned about a settled
order only when it refreshed.

Control-plane events (`branch:revoked`, `session:revoked`,
`permissions:changed`) are separate and are not replayed.

### Envelope

Every event carries:

```
{ event, schemaVersion, eventId, occurredAt, sequence, branch|restaurant, ...payload }
```

- **`eventId`** is the deduplication key. Where a mutation is idempotent the
  request's `Idempotency-Key` becomes the event id, so a retry republishes the
  *same* id and a client discards it. A delivery sent to both the branch room
  and the assigned rider's room reuses one id for the same reason.
- **`sequence`** is per room and strictly increasing, which is what makes
  reconnect recovery possible without trusting clock skew.

Before this phase only `purchasing:update` had any of this; everything else
arrived bare, so a reconnecting client could not tell a redelivered ticket from
a new one.

### Rooms

| Room | Members |
|---|---|
| `branch:<id>` | staff joined to that branch |
| `branch:<id>:purchasing-management` | owners/managers of that branch |
| `restaurant:<id>` | every non-rider principal of the tenant |
| `role:<restaurantId>:<role>` | every holder of that role **within one tenant** |
| `rider:<userId>` | one rider, private |

The role room is deliberately namespaced by restaurant. A bare `role:manager`
would put every tenant's managers in one room, which is exactly the
cross-tenant leak the rest of the system prevents.

Rooms are joined from the **resolved principal**, never from the token claim,
so a forged `restaurantId` or `role` cannot place a socket anywhere. Riders
join only their private room — branch rooms carry kitchen tickets and stock
movements they have no business receiving.

### Reconnect recovery

Each room keeps a bounded in-memory buffer of its last 100 events. On rejoin a
client sends `replay:since {branch, sequence}` and receives everything newer.

Replay re-checks authorisation — room membership **and** a fresh storage
lookup — so a socket cannot replay a branch it has since lost access to.

When the gap exceeds the buffer the server answers `truncated: true` with **no
events**, and the client must refetch. Returning a partial history would be
worse than returning none, because the client could not tell the difference.

`subscribeBranch()` in `client/src/socket.js` implements this: it dedupes on
`eventId` with a bounded LRU, tracks the last sequence, replays on reconnect
and calls `onReload` when told to resync.

### Limitations

- **The replay buffer is in-memory and per-process.** A restart clears it, and
  with several API instances a client may reconnect to an instance holding a
  different buffer. Both cases surface as `truncated`, so the client reloads —
  correct, but it is a convenience, not delivery assurance.
- **No cross-instance fan-out.** Emitting reaches only sockets held by the
  process that published. Horizontal scaling needs a Socket.IO adapter
  (`@socket.io/redis-adapter`, or the MongoDB adapter, which would reuse the
  replica set already required). Not present, and not claimed.
- Events are best-effort. A publish failure is logged and swallowed: the
  business transaction is already committed, and turning a notification
  failure into a failed HTTP response would be strictly worse.

## Audit log and compliance

Every security- or money-relevant act writes an append-only audit record.

### What is recorded

| Column | Field(s) |
|---|---|
| **Who** | `user`, plus `userName` / `userRole` frozen at write time so the row stays readable after a rename, demotion or deletion |
| **What** | `entity`, `entityId`, `action`, `before`, `after`, `reason` |
| **When** | `at` |
| **Where** | `restaurant`, `branch`, `ip`, `userAgent` |
| **Reference** | `reference` — the human-facing document number (invoice, PO, ingredient code) |
| **Integrity** | `sequence`, `prevHash`, `hash` |

Covered events include: login, failed login (with the address attempted and
the source IP), logout, price changes, stock adjustments, inventory counts,
approvals, refunds, payments, invoice creation, invoice reprint, PO changes and
user/role/permission changes. `GET /api/audit/actions` returns the full
vocabulary, grouped, so the UI filter is not a second hard-coded copy.

A failed login on a real account links the user; a failed login for an unknown
address deliberately does **not**, so the trail cannot be used to enumerate
which addresses exist.

### Tamper resistance, and its honest limit

Two layers:

1. **Append-only through the application.** Every field is `immutable`, and
   Mongoose `pre` hooks refuse `save()` on an existing document, all four
   update forms and all four delete forms. There is no write endpoint — the
   audit router exposes only `GET`.
2. **Hash chain.** `hash = SHA256(canonical(row) || prevHash)`, per restaurant,
   with a contiguous `sequence`. Editing a row breaks its own hash; deleting
   one breaks the following row's link and leaves a sequence gap.

`GET /api/audit/verify` (owner only) walks the chain and reports each break as
`content` (row edited), `link` (row deleted or inserted) or `sequence` (rows
removed).

**The limit, stated plainly:** the chain makes tampering *detectable*, not
*impossible*. Anyone with direct database access can still run
`db.audits.updateOne(...)` — the application cannot stop that. Preventing it
requires an append-only store or shipping the log off the host (WORM storage,
an external SIEM, or MongoDB queryable-encryption/immutable collections). None
of that exists in this repository and none is implied.

The per-restaurant chain head is serialised with an in-process lock, so two
concurrent writes on one instance cannot fork the chain. Across multiple API
instances two rows can share a `prevHash`; verification walks in `sequence`
order and reports the fork rather than silently accepting it.

### Search

`GET /api/audit` — permission `audit.view`, owner-only in the built-in bundles.
Filters: `user`, `action` (comma-separated), `entity`, `entityId`, `branch`,
`reference`, `from`, `to`, `page`, `limit` (max 200).

Scoping is enforced server-side: results are always confined to the caller's
restaurant, and a non-owner holding `audit.view` through a custom role is
further pinned to their own branch — asking for another branch is a 403, not a
silently-ignored parameter. The audit log must not become a side channel for
reading another branch's refunds.

### Operational notes

- Audit writes never throw into the caller's path. A failed audit write is
  logged but does not roll back the business operation it describes — losing a
  log line is bad, failing a completed refund because of it is worse. This is a
  deliberate trade-off: under database pressure the trail can have gaps, which
  chain verification will surface as sequence breaks.
- The collection has no TTL and grows without bound. Retention/archival is not
  implemented.

## Production runbook — sessions, cache and realtime

Operational reference for the RBAC/session subsystem. Everything here is
behaviour that has been verified against the test suite unless explicitly
marked otherwise.

### Session and device semantics

| Fact | Value |
|---|---|
| Token lifetime | 12 hours (`TOKEN_TTL_HOURS`) |
| "Device" | One `UserSession` row, created per login. Not hardware — two logins from one browser are two sessions. |
| Stored credential | SHA-256 hash of an opaque `sid` only. The plaintext exists solely inside the JWT. |
| Global kill switch | `user.sessionVersion`; incrementing it invalidates every token minted earlier. |
| Row cleanup | TTL index on `expiresAt`; the collection self-prunes and stays bounded. |
| Revoked rows | Kept, not deleted, so the trail survives until the TTL removes it. |

Endpoints: `POST /api/auth/logout` (this device), the same with
`{"allDevices": true}` (everything), `GET /api/auth/sessions`,
`DELETE /api/auth/sessions/:id`. Revocation is always scoped to the
authenticated user; another user's id yields 404 rather than confirming it
exists.

Both authentication layers are checked on every request: the session row must
be live **and** the token's `sv` must match the stored `sessionVersion`.
Tokens minted before per-device sessions carry no `sid`, still work, and remain
covered by the version check alone.

**Operational note:** there is no admin endpoint to list or revoke *another*
user's individual devices. Ending someone else's access is all-or-nothing —
deactivate the account, or reset their password.

### Permission cache

| Setting | Default | Env var |
|---|---|---|
| TTL | 5 s | `RBAC_ROLE_CACHE_TTL_MS` |
| Max entries | 2000 | `RBAC_ROLE_CACHE_MAX` |
| Disable | off | `RBAC_ROLE_CACHE_DISABLED=true` |

Only **role definitions** are cached. The user row — `active`, `rider.active`,
`role`, `sessionVersion` — is read live on every request and is never cached,
which is what makes deactivation, demotion and revocation immediate.

Three layers keep the cache honest, in order of precedence:

1. **Explicit invalidation** on every role write through the service — same
   process, same request, immediate.
2. **Change stream** on the `roles` collection for writes made elsewhere
   (another instance, a migration, the mongo shell).
3. **TTL** as the backstop. If both of the above fail, staleness is bounded by
   the TTL and resolves on its own. Verified: with the stream stopped and an
   out-of-band write, access converged after the TTL lapsed.

**Withdrawal is never deferred.** Bounded staleness is acceptable when access
is being granted; it is not when access is being taken away. A disabled or
deleted role is revalidated against storage on read, so it takes effect
immediately even with a 60-second TTL configured.

### Change-stream fallback

Change streams require a replica set. This deployment already requires one —
`verifyTransactionCapableDatabase()` refuses to boot otherwise, because
purchasing uses transactions — so no new infrastructure was introduced.

If the stream cannot start or later drops, the API logs it, continues serving,
and falls back to the TTL. Startup failure of the watcher is deliberately
non-fatal: losing an optimisation must never stop the API booting.

**Not verified multi-instance.** The test harness runs one API process against
a single-node replica set. What is tested is that the watcher starts, that an
out-of-band role write invalidates this process's cache through the stream,
and that it stops cleanly. Treat cross-instance propagation as designed, not
proven.

### Socket.IO authorization and horizontal scaling

Single instance: when a role, permission set or branch assignment changes, the
write pushes to live sockets — unauthorized rooms are left, management rooms
gained or lost, `permissions:changed` emitted. Deactivation and revocation emit
`session:revoked` and hard-disconnect. Handshakes resolve the principal from
storage, so a deactivated, demoted or signed-out user cannot open a socket.

**Multi-instance requires a shared adapter, which this repository does not
have.** `io.fetchSockets()` sees only the current process's connections, so a
role change served by instance A cannot push to a socket held by instance B.

To scale horizontally with correct socket permission invalidation you must add
a Socket.IO adapter — `@socket.io/redis-adapter` with Redis, or the MongoDB
adapter, which would reuse the replica set already required. Until then:

- **Safe:** run a single API instance, where push refresh is immediate.
- **Degraded but not unsafe:** run several instances. A socket on another
  instance keeps its rooms until it reconnects or that branch next publishes,
  at which point `evictStaleBranchSockets()` revalidates it lazily.
- **HTTP is unaffected either way.** Authorization resolves from the database
  on every request, so a stale socket can receive events it should no longer
  see, but can never perform an action.

## Multi-tenant access control

Every branch-scoped endpoint enforces **user → restaurant → branch → resource**. An owner has
broad rights inside their own restaurant but can never cross the restaurant boundary; managers
and staff stay pinned to their assigned branch.

Two guards implement this, and both check the restaurant:

- `assertTenantBranchAccess(user, branchId)` — branch check plus restaurant ownership, used by
  kitchen, KDS performance, receipts, refunds, billing, alerts, tables and deliveries.
- `purchaseBranchContext({user, branchId})` — the equivalent on the purchasing, inventory,
  transfers, waste and month-close side, and in the Socket.IO handshake.

`assertBranchAccess()` remains exported for the pure branch comparison and is the first step
inside the tenant-aware guard, but it is **not** sufficient on its own: it is synchronous and
returns early for any owner, so it cannot see the restaurant boundary.

List endpoints called without a `branch` parameter resolve the caller's own branches rather than
querying across all restaurants. A syntactically valid JWT for one restaurant is still refused
against another — signature validity is not authorization, and a forged `restaurantId` claim is
overridden by the server-side lookup.

## Tables & floor (Phase 6A)

A branch floor is a set of **areas**, each holding tables with a **capacity** and a **status**.

| Status | Meaning |
|---|---|
| `available` | Free to seat |
| `occupied` | Party seated / open check |
| `reserved` | Held for a booking |
| `cleaning` | Being turned over |
| `disabled` | Out of service (management only) |

Transitions are guarded: `available → occupied/reserved/cleaning/disabled`,
`reserved → occupied/available`, `occupied → cleaning/available`, `cleaning → available/disabled`,
`disabled → available`. Seating and release are driven by the order lifecycle, and every change
is broadcast to the branch room as `table:update`.

`GET /api/tables/floor?branch=...` returns the floor plan grouped by area, with per-area table
and seat counts plus a branch summary — table/seat totals, status counts, and both table and seat
**occupancy rates** (computed over in-service tables only). Pass `includeRetired=true` to include
retired tables.

**Capacity** is required and bounded 1–40; a table that seats nobody is not a table. **Areas** are
trimmed, whitespace-collapsed, capped at 60 characters and default to `Main Floor`. Table names
are unique per branch **case-insensitively** — `T9` and `t9` are one table to a host.

`DELETE /api/tables/:id` **retires** a table rather than deleting it, because orders, audit
history and past receipts still reference it. Retiring is refused while the table is occupied or
holds an open check, and is audited.

All table endpoints are tenant-scoped: the branch must belong to the caller's restaurant, so an
owner of another restaurant cannot read or modify this floor.

## Kitchen performance (Phase 5D)

`GET /api/kitchen/performance?branch=...` (owner/manager) reports how the kitchen actually
performed, derived from the stage timestamps the KDS writes rather than re-inferred from status.

| Metric | Meaning |
|---|---|
| **Preparation time** | Placed → ready, the interval a guest experiences. Split into wait (→ accepted), cook (→ ready) and service (→ completed) |
| **Average prep time** | Mean, plus median and p90 — a long tail is visible instead of hidden behind an average |
| **Delayed orders** | Tickets whose prep time exceeded their target, with the overrun in minutes and an on-time rate |
| **Completed orders** | Settled tickets, alongside open and cancelled counts |
| **Station performance** | Orders, items, average prep, delays and on-time rate per station |

Query with `from`/`to`, `station`, `limit` (slowest/delayed list size) and `includeCancelled`.

**Counting semantics.** `summary.orders` counts each order **exactly once** (a partition).
`stations[].orders` counts an order **once per station it touches** (an attribution, not a
partition), so a Burger/Fries/Drink ticket appears on the grill, fry and beverage rows and the
station counts intentionally sum to more than `summary.orders`. `stations[].items` sums the item
quantities for that station only.

**Completion timestamps.** `completedAt` is stamped on every path that can complete an order —
the kitchen status route, payment settlement, both sides of a split, and delivery hand-off — and
is written exactly once, so a repeat request never moves the original instant.

Orders completed before this stamping existed may have `completedAt` null. A controlled,
idempotent migration recovers them from the audit log, which records the exact completion
instant:

```bash
node scripts/backfill-completed-at.js          # dry run
node scripts/backfill-completed-at.js --apply  # write
```

It never overwrites a valid `completedAt`, and where the audit log holds no evidence the value is
**left null rather than invented** — such tickets still count as completed but contribute no
service time.

A ticket's target is the slowest item on it, else the channel default (delivery 10m,
counter/takeaway 12m, dine-in 15m). **Open tickets are judged against the clock**, so a stalled
ticket counts as delayed now rather than only once someone closes it. Cancelled tickets are
excluded from timing averages by default — a ticket voided after two minutes would otherwise
flatter the numbers — but are still counted so the volume is visible. A multi-station ticket is
attributed to every station that worked on it, so station totals intentionally do not sum to the
order count.

## Kitchen stations (Phase 5C)

Stations are defined **per restaurant**, so a kitchen can describe its own sections rather than
being held to a global list. Each restaurant is seeded on first use with:

`kitchen` · `grill` · `fry` · `tandoor` · `curry` · `cold` · `bakery` · `dessert` ·
`beverage` · `bar` · `expo`

`GET /api/kitchen/stations` lists them (staff may read; owner/manager may change). Management can
add its own — a momo counter, a pizza oven — via `POST /api/kitchen/stations`, reorder them,
remap categories, and move the default with `POST /api/kitchen/stations/:id/default`. Stations are
deactivated rather than deleted, because historical order lines still name them, and the default
station can never be deactivated or removed.

**Routing.** Each order line is routed once, at creation, and stored on the ticket:

1. an explicit `station` on the menu item — always wins
2. otherwise a station whose `categories` list claims the item's menu category
3. otherwise the restaurant's default station

The category tier means an existing menu routes sensibly the moment stations are switched on,
instead of every ticket landing on one board. Because the station is stored on the line, editing a
menu item later never re-routes a ticket already in the pass.

`GET /api/kitchen/board?station=<code>` shows only that section's tickets, and only that
section's lines within them. The board also reports `summary.byStation` so an expo screen can see
the whole kitchen at once.

## KDS realtime (Phase 5B)

Socket.IO delivers kitchen tickets to branch-scoped rooms named `branch:<id>`.

| Event | Emitted when |
|---|---|
| `kitchen:new-order` | An order is placed, or a bill split creates a second ticket |
| `kitchen:status` | Any stage transition, a rush flag, or payment settlement (carries `previousStatus`) |
| `branch:revoked` | The socket's branch access was withdrawn mid-session |

**No unauthorized branch access.** The handshake verifies the JWT, rejects roles outside
owner/manager/staff, and tenant-checks any branch named in `auth.branch`. `join:branch` re-resolves
the *stored* user assignment on every room change, so a valid but stale token cannot open a room,
and joining a new branch leaves the previous one. A branch belonging to another restaurant is
refused with 403.

Room membership is also re-verified **at emit time**: a JWT outlives a reassignment, so a cook
moved to another branch would otherwise keep receiving the old branch's tickets on their open
socket until they reconnected. Before each kitchen event the room is revalidated against stored
assignments, any socket whose access was revoked is evicted and told via `branch:revoked`, and
unaffected sockets are untouched.

## Payments (Phase 4D)

Tickets settle through `POST /api/orders/:id/payments` in **cash**, **card**, **eSewa** or
**khalti** (plus `wallet`/`online`). eSewa and Khalti are recorded as tenders with an optional
`transactionId`; no gateway call is made from the API.

- **Multiple payments** — a ticket accepts as many tenders as needed; the order stays open until
  the balance clears, then closes as `completed` and releases its table.
- **Partial payment** — any amount up to the balance due. Overpaying is rejected.
- **Split payment** — pay only selected item quantities (`items: [{itemId, qty}]`), or split the
  check onto a second ticket with `POST /api/orders/:id/split` and settle each independently.
- `GET /api/orders/:id/payment-summary` reports what was taken, by tender, and what is refundable.

**Refunds** (`POST /api/orders/:id/refunds`, owner/manager only) reverse money that was actually
taken. Each refund is written as its own negative `Payment` row linked to the tender it reverses
via `refundOf`, so the ledger stays append-only and money goes back the way it came — refunds
allocate against the newest tender first. Omitting `amount` refunds whatever is left.

A partial refund leaves the order `completed` with a running `refundAmount` so the till still
sees what was settled; the order only becomes `refunded` once every rupee is returned, and a
partially refunded ticket can be topped up again. Refunded money is netted out of P&L revenue
(`revenue`, with `grossRevenue` and `refunds` reported alongside).

## Receipts (Phase 4E)

`GET /api/orders/:id/receipt` returns the receipt as JSON; `?format=html` returns a
self-contained 80mm thermal-printer document that prints straight from the browser. The HTML
references no external stylesheet, font or image, so it renders identically on a till with no
network access.

The receipt carries the full **order details** (number, channel, table or delivery address,
customer, every line with its modifiers, special instructions and per-line discount), the
**VAT breakdown** (taxable value, rate, and tax amount, with per-line net and VAT), and the
**payment details** (each tender with its transaction id, refunds with reasons, and any balance
due).

**Tax invoice numbers.** A preview does not consume a number. Printing (`?format=html`, or
`?issue=true`) allocates an immutable `INV-<BRANCH>-<YEAR>-######` from a per-branch, per-year
counter — the same gapless pattern used for purchase orders and supplier payments — and stores it
on the order. Reprints reuse that number and are stamped `REPRINT (n)`. A cancelled order cannot
be invoiced.

Every figure is read from the stored order, never recalculated, so a reprint months later shows
exactly what the guest was charged even after menu prices or VAT settings change.

**Tax registration is required to issue.** A Nepal tax invoice must carry the seller's PAN, so
issuing is refused with HTTP 409 when neither `Branch.pan` nor `Restaurant.pan` is set — the PAN
is never fabricated or silently omitted, and the invoice sequence is not spent on a document that
would be invalid. A read-only preview still works and reports `taxConfigured: false` so the till
can warn before printing. A branch PAN overrides the restaurant's.

## Test dates

The API validates against the real Asia/Kathmandu clock: statement and report windows may not end
in the future, and supplier payments may not be post-dated. Tests therefore derive their dates
from `server/test/dates.js` (`today`, `daysAgo`, `daysAhead`, `daysFromToday`) instead of hardcoding
a calendar day, so a suite keeps testing the same relationships whenever it runs.

Literal dates are still used where the value is deliberately time-independent — malformed input
such as `2026-02-30`, reversed ranges, or fixed ISO instants asserted by pure period arithmetic.

## Recommended local start: Docker Compose

Docker Compose starts a single-member MongoDB replica set, waits for a writable primary, runs API migrations, waits for API readiness, and then starts the web proxy.

```bash
cp .env.example .env
# Replace JWT_SECRET in .env with at least 32 random characters.
# On Linux/macOS, one option is: openssl rand -hex 32

docker compose up -d --build
docker compose ps
curl -fsS http://localhost:8080/health
```

Open `http://localhost:8080`. Browser API and Socket.IO traffic remain on that origin and are proxied internally; direct API access is bound to `127.0.0.1:4000` for local diagnostics only.

Load demo data only on a disposable/demo database:

```bash
docker compose exec -T api npm run seed
```

**Demo credentials:** `owner@mittho.com` / `mittho123`

> `npm run seed` resets the demo dataset. Do not run it against operational data.

Stop or inspect the stack with:

```bash
docker compose down
docker compose logs -f api mongo-init web
```

Use `docker compose down -v` only when you intentionally want to delete the local MongoDB volume.

## Windows + Docker Desktop

1. Install and open [Docker Desktop](https://www.docker.com/products/docker-desktop/) and wait for the engine to become ready.
2. Double-click **`START-WINDOWS.bat`**.
3. On first run, the launcher copies `.env.example`, generates a random JWT secret, builds the stack, and waits on `http://localhost:8080/health`.
4. Choose **Y** to reset/load sample data or **N** to preserve existing data.

The app opens at `http://localhost:8080`. If startup fails, run `docker compose ps` and `docker compose logs api mongo-init web` from Command Prompt in the project directory.

## Native development

Purchasing uses MongoDB transactions. A standalone `mongod` is therefore not supported: native development requires a writable replica set or sharded MongoDB deployment.

For a local one-member replica set, start MongoDB with `--replSet rs0` and initialize it once:

```bash
mongod --dbpath /path/to/mongo-data --replSet rs0 --bind_ip 127.0.0.1
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
```

Then, in the repository:

```bash
cp .env.example .env
npm ci
npm run seed       # optional and destructive to demo data
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` and `/socket.io` to the API on port 4000, matching production's same-origin browser behavior.

## Runtime configuration

| Variable | Requirement |
|---|---|
| `MONGODB_URI` | Native API URI; must resolve to a writable replica set or sharded cluster. |
| `COMPOSE_MONGODB_URI` | Optional API URI override for Compose. Empty uses the bundled `mongo:27017` replica member. |
| `JWT_SECRET` | At least 32 characters. Known placeholders are rejected when `NODE_ENV=production`. |
| `CLIENT_URL` | Comma-separated exact HTTP(S) browser origins, with no paths or wildcard. Required in staging and production. |
| `APP_ENV` | Deployment class: `development`, `test`, `staging`, `production`. Overrides `NODE_ENV` for security decisions. Unrecognised values are rejected at startup. |
| `TRUST_PROXY` | How many reverse proxies sit in front of the API. `1` for the bundled Nginx. Defaults to `loopback`. `true`/`*` are rejected. |
| `PORT` | API listen port, 1–65535. Compose fixes the internal API port at 4000. |
| `PAYMENT_MODE` | `sandbox` or `production`. Defaults to sandbox outside production. |
| `PAYMENT_RETURN_BASE_URL` | Absolute URL gateways redirect back to. Defaults to the first `CLIENT_URL` origin. |
| `PAYMENT_HTTP_TIMEOUT_MS` | Gateway HTTP deadline, default 15000. |
| `ESEWA_MERCHANT_CODE` | eSewa product code. Falls back to the vendor sandbox code (`EPAYTEST`) in sandbox only. |
| `ESEWA_SECRET_KEY` | eSewa HMAC secret. Falls back to eSewa's published sandbox secret in sandbox only; refused in production. |
| `KHALTI_SECRET_KEY` | Khalti secret key. Khalti is not offered to guests until this is set. |

For the default Docker endpoint, keep `http://localhost:8080` in `CLIENT_URL`. For public deployment, replace local values with the exact TLS origin, such as `https://ops.example.com`.

The API refuses to listen until configuration is valid, MongoDB reports transaction capability and a writable primary, and all operational migrations complete.

## Health and shutdown behavior

`GET /health` returns HTTP 200 only when startup has completed and Mongoose is connected. The Docker web container proxies the same endpoint:

```json
{
  "ok": true,
  "database": "connected",
  "startup": "ready",
  "environment": "production",
  "cors": "allowlist",
  "trustProxy": "1",
  "rateLimit": "per-instance-memory",
  "clientIp": "203.0.113.9"
}
```

`environment`, `cors`, `trustProxy` and `rateLimit` report the posture the
process actually booted with, and `clientIp` is the address the API resolved for
the caller. Together they let an operator confirm from outside the container
that proxy trust and CORS are configured as intended, without reading env vars
off the host. See **Deployment hardening (Phase 8A.6)** below.

During shutdown, the API stops realtime delivery, closes the HTTP server, and disconnects MongoDB. Docker allows 15 seconds before forced termination.

## Purchasing & inventory audit (Phase 13)

An adversarial security and data-integrity audit. Purchasing and inventory
were found **largely correct**; the audit verified the guarantees against the
live API rather than assuming them, and pinned each in a regression suite.

### Verified working, now pinned

| Guarantee | Evidence |
|---|---|
| Over-receiving | 500 against a 100 order → 409, stock untouched, no ledger row |
| Over-receiving the remainder | 60 with 40 outstanding → 409 |
| Receiving idempotency | `Idempotency-Key` is **mandatory**; replay → 200, banked once |
| Damaged goods | Excluded from sellable stock (20 received, 5 damaged → +15) |
| Over-return / replay | 200 of 100 → 409; replayed return deducts once |
| Return optimistic locking | Stale `expectedVersion` → 409 |
| Overpayment | 10,000 invoice → 3,000 then 7,000 → balance 0; further payment 409 |
| VAT arithmetic | Subtotal/VAT/total mismatch → 400 |
| Negative stock | Refused atomically; **no ledger row written** |
| Concurrency | 3 parallel 60% deductions → at most one wins, never negative |
| Tenant isolation | Cross-restaurant PO, receive, return, adjust, report all refused |
| Ledger completeness | Every row carries prev/change/new, user, reference, idempotency key, and `previous + change === new` |

### Two defects found and fixed

**1. Internal error disclosure.** `fail()` in `routes/purchasing.js` returned
`e.message` verbatim. For a ZodError that is the serialised issue array — a
**607-character** dump of schema structure, expected types and field paths —
and for an unexpected fault, the raw exception text. Now sanitised to ~28
characters. Deliberate operator messages (`custom` issues, unrecognised-key
names, and all 4xx business refusals) are preserved, because a sanitised
error must not become a useless one.

**2. Mass assignment.** Purchase order schemas were not `.strict()`, so
`status`, `approvedBy`, `restaurant`, `total`, `poNo` and misspelled fields
were silently dropped. **Not exploitable** — every protected value is
server-derived and the injections were verifiably ignored — but silent
acceptance hides typos and means a future field could quietly become
client-writable. Now rejected outright.

### Negative stock is defended twice

Mutation testing showed that removing the ledger's `after < 0` guard did *not*
produce negative stock: the FEFO batch allocator refuses independently.
Removing **both** does break it, and a test now pins that. This is genuine
defence in depth, confirmed rather than assumed.

### Not changed

No transactions were added — receiving, returns, payments and adjustments
already run inside `withTransaction` with idempotency keys, verified by the
existing rollback tests. No indexes were added: every collection already
carries tenant-prefixed compound indexes matching its real query patterns.

## Reporting and business intelligence (Phase 18)

### The brief's P&L premise was wrong — recorded rather than quietly worked around

The brief states `/api/reports/pnl` runs on "legacy Purchase/Sale/Expense data"
and must be moved onto the modern purchasing/ledger architecture. **It does
not.** Verified against the running API before any code was written: a legacy
`Sale` of 99,999 and a legacy `Purchase` of 77,777 were planted, and P&L
reported `revenue: 0` and `purchases: 0`. It already reads `Order`,
`InventoryTransaction` and `buildPurchasingReport()`. The legacy `Purchase` and
`Sale` models still exist in `models/index.js` but **nothing imports them**. A
regression test now plants those rows permanently, so reintroducing a legacy
read fails the suite.

What P&L *was* missing — and this is fixed — is flat `vat`, `discounts` and
`inventoryValue` at the top level. A caller reading `body.vat` got `undefined`,
and P&L had no inventory figure at all while the dashboard did, so the two
disagreed about what stock the business was holding. Fixed additively; the
nested `sales` block is untouched for existing callers.

### Report families

| Report | Endpoint | Notes |
|---|---|---|
| Dashboard | `GET /dashboard` | now also carries `sales`, `grossRevenue`, `discounts`, `refunds`, `grossProfit` |
| P&L | `GET /reports/pnl` | plus flat `vat`, `discounts`, `inventoryValue` |
| Sales | `GET /reports/sales` | daily / weekly / monthly, by branch, item, category, order type, payment method |
| Inventory | `GET /reports/inventory` | stock value, movement, waste, adjustments, count variance, expiry |
| Customers | `GET /reports/customers` | repeat rate, AOV, top customers |
| Purchasing | existing family | **audited and integrated**, not rebuilt |
| Kitchen | `GET /kitchen/performance` | **audited**: prep time, delayed orders and station performance already existed |

### Semantics worth stating

* **Reporting days are Kathmandu days.** A 23:00 UTC sale belongs to the next
  local day; bucketing on UTC would put evening takings in the wrong day.
* **Net vs gross.** `grossRevenue` is what was rung up; `netRevenue` subtracts
  refunds. Cancelled, draft and held orders are never revenue.
* **Payment split comes from the `Payment` rows, not the order.** An order
  settled across cash and Khalti is reported as two tenders. Reversed tenders
  are excluded — money that was never really taken.
* **Count variance uses approved counts only.** A submitted or stale count is
  not evidence.
* **"Repeat customer" means more than one order within the reporting period**,
  stated in the payload as `repeatBasis` so the metric cannot be misread as
  lifetime behaviour.
* **Analytics never writes.** A test asserts balances, ledger rows and order
  counts are unchanged after running every report.

The reports workspace is a **new** `Reports` screen. The pre-existing
`Analytics` screen (menu engineering) is untouched and still reachable.

## Sweep ownership and lease integrity (Phase 16D)

Final hardening pass for the reorder/scheduler module.

### Scheduled vs manual sweeps

These are two deliberately different operations, and the code now forces a
caller to say which one it is running.

|  | Scheduled | Manual |
|---|---|---|
| Trigger | background interval timer | `POST /purchasing/reorder-alerts/run` |
| Scope | every restaurant | one branch, as the requesting user |
| Distributed lease | **required** | **not used, by design** |
| Lease loss | aborts the sweep | n/a |
| Entry point | `runScheduledSweep({ownership: sweepOwnership.scheduled({shouldContinue})})` | `raiseReorderAlerts()` via the route |

`runScheduledSweep()` previously defaulted `shouldContinue` to permissive, so a
future caller could run a full multi-tenant sweep with **no lease behind it**
simply by forgetting — the failure mode being silent duplicate sweeps across
containers. An audit found only one production caller (the scheduler tick) and
no way for the manual route to reach it, so nothing live was bypassing the
lease. The latent hole is now closed: **ownership is a required argument** and
the function throws without it. Bypassing the lease has to be deliberate and
visible, and tests declare `sweepOwnership.manual('<why>')`.

**Why the manual endpoint may run unleased.** It is a foreground request an
operator is waiting on; queueing it behind a background lease would be wrong.
It is safe to repeat because alert writes are idempotent — the unique partial
index on `{branch, type, referenceId}` scoped to unresolved alerts means a
second run raises nothing. Tested: running it twice yields `raised: 1` then
`raised: 0`, and a manual run concurrent with a scheduled tick still leaves one
alert. It never mutates scheduler lock state, and it enforces authentication,
RBAC, and branch/restaurant isolation exactly as before.

### Lease loss during work

Previously the lease was only checked *between* tenants, so a restaurant with
hundreds of short ingredients could keep writing long after the lease had gone.
It is now also checked **before each alert write**, which is the unit of
meaningful work. Guarantees:

* the sweep never continues indefinitely after lease loss;
* ownership is never claimed after expiry (renewal matches on `{_id, owner}`);
* partial progress is safe — alerts already written stand;
* the next sweep resumes and does **not** duplicate them;
* another scheduler can acquire the lease once it lapses or is released.

Abort is defended at two layers (mid-tenant propagation and the between-tenant
check). Removing either alone still stops the sweep; removing both fails the
test — verified by mutation.

### MongoDB failover

**Primary-election/step-down behaviour has not been exercised in the automated
test environment.** The harness is a single-node replica set, so no election can
be triggered. What is tested is the observable consequence: a renewal that fails
with `not primary` (10107) aborts the sweep and releases cleanly. Genuine
failover remains an **operational verification item**.

### Production migration

**NOT EXECUTED.** The runbook (BACKUP → DRY RUN → REVIEW → EXECUTE → VERIFY →
SECOND VERIFICATION) is below under Phase 16B, and the sequence is verified in
tests against a deliberately messy dataset: the dry run writes nothing, apply
backfills and retires duplicates, acknowledged alerts survive untouched, nothing
is deleted, and a second run reports zero changes.

## Scheduler lease renewal (Phase 16C)

Phase 16B's lock had a `renew()` method that the scheduler never called. Two
problems followed, both found by reading the code rather than by guessing:

1. **`renew()` was architecturally unreachable.** `mongoSchedulerLock().acquire()`
   returned a *bare release function* and discarded the handle, so the scheduler
   had no way to renew even if it wanted to. `acquire()` now returns a callable
   that is also an object carrying `renew`/`owner`; callers written against the
   old `typeof release === 'function'` contract are unaffected.
2. **A long sweep outlived its lease.** With a 300s lease and no renewal, a
   sweep over enough restaurants would let the lock expire, a second instance
   would acquire it, and two schedulers would run at once.

### How renewal works

```
acquire → renew → renew → sweep completes → release      (normal)
acquire → renew refused/errors → abort sweep → release   (lease lost)
```

* **Interval is derived, never fixed.** One third of the lease
  (`ttl/3`, floored at 100 ms), taken from the lease the provider actually
  granted where it reports one, otherwise from `REORDER_SCHEDULER_LOCK_TTL_SECONDS`.
  Two renewals are therefore attempted before expiry, and a short lease can
  never end up with an interval longer than itself.
* **Renewal is ownership-verified.** `updateOne({_id, owner})` — a superseded
  holder cannot extend the lease that replaced it.
* **Lease loss is never ignored.** A refused renewal *or* a renewal that throws
  (a stepped-down primary, a connection reset) both mark the lease lost. The
  sweep then stops between tenants — the natural safe boundary, since a
  restaurant is either swept fully or not at all — and reports
  `aborted: true`. It does not keep writing while another instance believes it
  owns the work.
* **The timer stops on every exit path**: success, failure, or lease loss. A
  renewal timer that outlived its sweep would keep extending a lease nobody is
  using.
* `schedulerStatus()` reports `leaseRenewals`, `leaseLosses` and `lastAborted`.

### Failover: what is NOT covered

The test harness runs a **single-node replica set**, so a real primary election
cannot be triggered and **actual MongoDB failover is not tested**. What *is*
tested is the observable consequence a failover has on this code — the renewal
write fails (including a simulated `not primary`, code 10107) — and that path
aborts the sweep and releases cleanly. Behaviour during a genuine election
remains unverified here.

### Promised-date semantics

| Order has… | Lead-time metrics | On-time rate |
|---|---|---|
| a promised/expected date | contributes | contributes |
| no promised date | **contributes** | **excluded** |
| no delivery at all | excluded | excluded |

When *no* delivery carried a promise, `onTimeRate` is `null` and the UI shows
**N/A** with `onTimeBasis` explaining why — never 0% or 100%. Promised dates
are never fabricated: an order created without an expected delivery date keeps
`expectedDeliveryDate` unset, and the report will not synthesise one from the
catalog to make the rate computable.

## Reorder scheduler, locking and migration (Phase 16B)

Phase 16A shipped an in-process scheduler and said plainly that multiple API
containers would each tick. This phase closes that, audits the migration, and
puts the supplier-performance data on screen.

### Distributed scheduler lock

**Why MongoDB and not Redis.** `verifyTransactionCapableDatabase()` already
refuses to boot against anything but a replica set, so the deployment has a
linearizable primary and atomic `findOneAndUpdate`. That is everything a
lease lock needs. Redis would add an operational dependency the architecture
does not otherwise have, so it is deliberately not used. Probed before writing
any code: two racing upserts on the same `_id` produced exactly one winner and
error 11000 for the loser.

| Property | How |
|---|---|
| Atomic acquisition | One `findOneAndUpdate` with `upsert`; the loser gets 11000, which is read as "someone else holds it", not as an error. |
| Owner token | `pid:uuid` per acquisition, stored on the document. |
| Automatic expiry | The lock is a **lease** with `expiresAt`. A crashed process blocks the scheduler for at most the TTL, with no manual cleanup. |
| Ownership-verified release | `deleteOne({_id, owner})`. A stalled instance whose lease was taken over cannot delete the new holder's lock. |
| TTL index | A **backstop only**. Mongo's TTL monitor runs about once a minute, far too coarse for correctness; expiry is enforced by the `expiresAt <= now` term in the acquisition filter. |

Configured by `REORDER_SCHEDULER_DISTRIBUTED_LOCK` (default **on** when the
scheduler is enabled) and `REORDER_SCHEDULER_LOCK_TTL_SECONDS` (default 300,
clamped 30–3600). Contention is counted in `schedulerStatus().lockContentions`.
The manual `POST /purchasing/reorder-alerts/run` **never** consults the lease —
a human pressing the button is not the scheduler — and no ordinary API request
waits on it.

### Alert lifecycle migration (runbook)

The migration is idempotent, deterministic, and **never deletes** an alert:
duplicates are marked `resolved`, keeping the newest open. Verified by test that
a second run reports zero changes.

```bash
# 1. Back up first. This edits alert status in place.
mongodump --uri "$MONGODB_URI" --out ./backup-$(date +%F)

# 2. Dry run — writes nothing
node scripts/migrate-alert-lifecycle.js

# 3. Review the output: totalAlerts, missingStatus, alreadyValid,
#    wouldMarkResolved / wouldMarkOpen, and the duplicate samples showing
#    which row is kept for each condition.

# 4. Execute
node scripts/migrate-alert-lifecycle.js --apply --

# 5. Verify
node scripts/migrate-alert-lifecycle.js --verify
#    Expect missingStatus: 0, duplicateGroups: 0, uniqueIndexPresent: true

# 6. Re-run the dry run; it must now report changesRequired: false
node scripts/migrate-alert-lifecycle.js
```

The same logic also runs automatically at startup via
`ensureOperationalIndexes()`. The script exists so it can be previewed and
audited against production before a deploy does it unattended.

### Lead time: first receipt vs fully received

Both are reported; **neither replaces the other**.

* `averageLeadDays` / `medianLeadDays` — approval to the **first** goods
  receipt. This is the existing semantic and remains the default that
  `leadTimeSemantics: 'first_receipt'` labels. It answers *when did anything
  arrive*, which is what a reorder point needs: partial stock on the shelf ends
  the stockout.
* `averageFullLeadDays` / `medianFullLeadDays` — approval to the receipt that
  **completed** the order. `null` while an order is still short delivered, never
  approximated from the latest partial receipt.
* `partialFirstReceipts` counts orders whose first delivery was short.

The reorder engine continues to use first-receipt lead time. On-time rate is
`null` (shown as **N/A**) when no delivery carried a promised date, with
`onTimeBasis` explaining why rather than implying 100%.

### Supplier performance UI

`Supplier Performance` in the sidebar shows PO counts, late deliveries,
on-time rate, partial first receipts, and two visually separated panels:
**catalog lead time (declared)** against **actual lead time (measured)**. An
estimate is never presented as a fact — with insufficient history the measured
panel says so and states that the engine is falling back to the catalog value.

### Frontend tests

The repository had no frontend harness. Rather than adopt a second test culture,
the existing `node:test` runner is reused with one new dependency (`jsdom`) and
a small JSX loader built on `rolldown`, which Vite already ships. `npm test -w web`
covers the reorder workspace: loading, API error, empty state, low/out-of-stock
rendering, measured-vs-declared lead time, permission gating, and the
confirm-before-create rule. Backend contracts are not duplicated there.

## Reorder alert hardening (Phase 16A)

Phase 17's reorder engine, the alert list, the PO workflow and the Socket.IO
infrastructure were reused unchanged. This phase fixed one real defect and
added the operational scaffolding around them.

### Defect: a restaurant-wide plan summed stock across branches

Reproduced against the running API. Branch A held 18000 against a reorder level
of 19000 while branch B held 20000. The branch-scoped plan correctly reported
one line; the **owner-wide plan reported zero**, because quantities were summed
into a single number before comparison, and the sweep therefore raised nothing
while a branch was genuinely short. Any alert it did raise carried
`branch: null` — nobody's alert. Stock, usage and on-order are now keyed by
branch+ingredient, and every line names its branch.

### Scheduled sweep

`REORDER_SCHEDULER_ENABLED=true` starts an interval sweep
(`REORDER_SCHEDULER_INTERVAL_MINUTES`, default 60). It runs once per restaurant
as that restaurant's own owner, so it cannot cross tenants; a restaurant with no
active owner is **skipped and reported** rather than swept with borrowed
privileges. A tick never overlaps itself, every error is caught and logged, the
timer is `unref()`ed so it cannot delay shutdown, and a module-level singleton
means importing the module twice cannot start two timers. The manual
`POST /purchasing/reorder-alerts/run` endpoint is unchanged.

**Horizontal scaling limitation, stated plainly:** this is in-process. With
multiple API containers every container ticks. Alert *correctness* survives that
because the unique partial index `alert_open_condition` collapses concurrent
inserts to one alert per condition, but read load multiplies and telemetry is
per-process. `setSchedulerLock()` accepts an external lock so a scaled
deployment can add leader election without touching the module. No Redis or lock
collection exists in this repository, so none is pretended.

### Alert lifecycle

The existing `Notification` model **was** the alert model, so it was extended
rather than duplicated: `restaurant`, `ingredient`, `severity`, `status`
(`open` → `acknowledged` → `resolved`), `acknowledgedAt/By`, `resolvedAt/By` and
`context`. Duplicate suppression moved from a racy "find one from the last 24h"
check to a **unique partial index** on `{branch, type, referenceId}` scoped to
unresolved alerts. Resolving frees the condition so a recurrence alerts again.
`POST /alerts/:id/acknowledge` and `/resolve` are manager/owner only.

A consequence worth recording: the new index initially made a *goods receipt*
fail, because the ledger raised its low-stock alert with a plain insert inside
the stock transaction and E11000 aborted the movement. The ledger now upserts,
so an alert can never block stock.

### Supplier performance

`GET /suppliers/:id/performance` measures actual lead time from
`PurchaseOrder.approvedAt` to the first `GoodsReceipt.receivedAt`. It reports
average, median, min/max, late count and on-time rate. Below three completed
deliveries it returns `insufficientData: true` with nulls rather than inventing
a number, and the reorder engine keeps the catalog figure. Where history does
exist the measured value **overrides** the declared one, so a chronically late
supplier no longer looks punctual.

### Usage refinement

The flat mean still drives the reorder point. On top of it, a weekday profile is
published only with 21+ days of history *and* every weekday observed, and a
trend only with 14+ days. Below those thresholds the fields are `null` rather
than fake precision.

### Reorder workspace

`Reorder` in the sidebar: recommendations with current quantity, reorder point,
target, suggested quantity, supplier, SKU, price, lead time (marked when
measured), estimated value, branch and alert status; filters by branch, supplier
and stock state; alert acknowledge/resolve; and PO creation **behind an explicit
confirmation dialog** that states the result is a draft. A generated PO follows
the unchanged Draft → Pending → Approved → Receive chain.

## Inventory alert and reorder engine (Phase 17 — replenishment)

Six alert classes already existed (`services/alerts.js`), as did Phase 16's
reorder suggestions. Neither was rebuilt. Auditing them against the running API
found four gaps.

### Alerts

| Alert | Status |
|---|---|
| low stock / out of stock | already existed; now **pushed in realtime** |
| expiring / expired | already existed (Phase 15 tiers) |
| unusual consumption | already existed |
| negative stock attempt | already existed |
| **high waste** | **new** |

**High waste** is a ratio, not an absolute: waste as a share of everything
consumed over a rolling 7-day window, flagged above 10%. 2 kg of rice wasted in
a branch that used 500 kg is noise; the same 2 kg where 6 kg was used is a
problem. Quantities under 1 unit are ignored so a single spill on a quiet day
does not read as a 100% waste rate.

### Realtime

Alerts were persisted as Notifications and only surfaced when somebody
refreshed. Verified against the running API: dropping stock below the reorder
level wrote a `low_stock` row but the connected client saw only a generic
`inventory:update` carrying nothing about the alert. There is now an
`inventory:alert` Socket.IO event, scoped to the branch room, emitted **after
the transaction commits** — an alert for a movement that later rolled back
would be a lie. The Inventory screen shows it as a banner without a refresh.

### Reorder point

Phase 16 restored stock to a static level someone had typed in, which ignores
how fast an ingredient actually moves. The engine now computes:

```
reorderPoint = averageDailyUsage × leadTimeDays + safetyStock
safetyStock  = z × stdDevDailyUsage × √leadTimeDays
```

* `averageDailyUsage` is measured from the consumption ledger over a 30-day
  lookback. **Days with no consumption count as zero** — averaging only the days
  something moved would make a weekly spice look like a daily staple.
* `leadTimeDays` comes from the preferred supplier's catalog entry.
* The √ is not decoration: variance accumulates linearly over independent days,
  so the deviation grows with the square root of the lead time. Multiplying by
  the lead time would massively overstock.
* A configured minimum is a **floor, never a ceiling** — an operator who insists
  on holding 5 kg is not overridden by a formula that says 2 kg.

`GET /purchasing/reorder-plan` reports every term, so a manager can check the
arithmetic rather than trust it.

### Suggested purchase orders

The plan groups actionable lines into one suggested order per supplier.
`POST /purchasing/suggested-orders` turns one into a **draft** purchase order —
deliberately a draft, so a computed number never commits money without a human.
It then flows through the existing approval chain unchanged.

## Procurement and supplier ERP (Phase 16 — purchasing)

Purchase orders with approval and receiving, goods receipts, purchase returns,
supplier invoices, supplier payments, the supplier catalog (per-item lead days,
price history, purchase-unit conversion) and a running-balance statement all
already existed and were **not** rebuilt. Auditing them against the running API
found five gaps.

### A posted return did not reduce the supplier balance

The brief states **Invoice − Payments − Returns = Outstanding**. The statement
only ever queried invoices and payments, so goods sent back were still owed
for. Probe: invoice 1130 → balance 1130 → post a 50-unit return → **balance
still 1130**. Returns now emit a `purchase_return` credit into the statement
event stream, appear as their own line in the running balance, and are exposed
as `returned` plus an explicit `outstandingFormula`. Only `posted` returns
count, and a return dated after the statement cut-off does not back-date into
an earlier period.

Two existing tests asserted the old figures and were corrected, not weakened:
the purchasing E2E now expects `1994.35` instead of `2000`, and the Phase 1
lifecycle expects `-113` instead of `0` — a supplier that has been paid in full
and then had goods returned genuinely owes a credit back.

### Supplier master data

`contacts[]`, `addresses[]` (billing/delivery), `pan` (9 digits, required when
`vatRegistered`), `paymentTermsDays`, `creditLimit`, `leadTimeDays` and
`status` (`active` / `on_hold` / `blacklisted` / `inactive`). `status` and the
legacy boolean `active` are kept in lockstep by a schema hook, so old
`active:false` queries stay correct rather than a blacklisted supplier still
reading as active. The balance endpoint now reports `creditLimit`,
`creditAvailable` and `overCreditLimit`.

### Purchase order lifecycle

`received` was terminal, so a delivered order could never be marked
commercially complete. The graph now ends `... → Received → Closed`, with
`closed_short → closed` as well. Closing is refused while an invoice against
the order is still outstanding, and stamps `closedBy` / `closedAt` /
`closeNote`.

### Reorder suggestions, preferred supplier, price comparison

| Endpoint | Purpose |
|---|---|
| `GET /purchasing/reorder-suggestions` | What to order, how much, from whom |
| `GET /purchasing/price-comparison/:ingredientId` | Every supplier ranked |
| `GET /purchasing/purchase-history/:ingredientId` | What was actually received and at what price |

"Preferred" is **derived, not a flag someone must remember to set**: the
cheapest *effective cost per base unit* from an orderable supplier wins, with
the shorter lead time breaking ties. Headline prices are not comparable — one
supplier quotes per kg VAT-exclusive, another per 500 g VAT-inclusive — so
quotes are normalised to net-of-VAT per base unit first. A blacklisted supplier
is never preferred however cheap (defended at two independent layers).

Suggestions subtract stock already on an open purchase order, so a buyer is not
told to order the same thing twice, and round up to the supplier's minimum
order quantity **converted into base units**. An ingredient with no orderable
supplier is reported as `actionable: false` rather than hidden.

### Reports

`purchase-by-supplier`, `purchase-by-branch`, `ingredient-purchase-prices`
(with movement and trend) and `unpaid-invoices` (aged, with overdue totals).
All are management-only and tenant-scoped.

## Lot / batch / expiry inventory (Phase 15 — batches)

Batch-level stock already existed and was not rebuilt: `InventoryBatch` carries
batch number, supplier, received date, expiry, quantity and unit cost;
`removeBatchStock()` implements FEFO (with FIFO selectable per movement); the
ledger already refused to sell expired stock; and the alert endpoints already
reported expired / expiring / fresh. Auditing that against the running API
found two real gaps.

### Expiry tiers

`expiryTier()` grades a lot instead of lumping everything into one bucket:

| Tier | Meaning | Severity |
|---|---|---|
| `expired` | Past its expiry date | critical |
| `critical` | Within `expiryCriticalDays` (default **3**) | critical |
| `warning` | Within `expiryWarningDays` (default **7**) | warning |
| `notice` | Inside the wider reporting window | info |
| `fresh` / `no_expiry` | Nothing to act on | info |

**The defect:** batches 2, 5 and 20 days from expiry all came back
`severity: warning`, so a lot expiring tomorrow looked exactly as urgent as one
expiring in three weeks. Tiers are now returned per alert along with
`tierCounts`, and the thresholds are per-restaurant. A critical window wider
than the warning window is clamped, because otherwise `warning` could never be
reached.

### Configurable expired-stock policy

`Restaurant.expiryPolicy` replaces a hard-coded rule:

| Policy | Behaviour on a sale |
|---|---|
| `block` (default) | Expired lots are skipped; if only expired stock remains the movement is refused `409 Insufficient unexpired inventory`. |
| `warn` | The sale proceeds, and an `expired_stock_consumed` notification names the ingredient and lot count. |
| `allow` | No expiry restriction. |

`WASTE`, `ADJUSTMENT` and `RETURN` always reach expired stock whatever the
policy — writing off what has gone bad is precisely what they are for. A
partially expired shelf still sells its good lots and refuses to dip into the
bad ones (pinned by test).

### FEFO

Consumption takes the nearest expiry first, then earliest received as a
tie-break, with undated lots last so dated stock always moves ahead of stock
that keeps. `consumptionStrategy: 'fifo'` switches a single movement to
receipt order without a data migration. Lot totals always reconcile with the
aggregate balance, and the ledger chain (`previous + change === new`) is
asserted across batch movements.

## Stock count lock recovery (runbook)

A stock count holds an exclusive per-branch lock (`activeKey`, enforced by the
unique partial index `stock_count_active_branch`). The lock is released when
the session reaches a terminal state. Phase 14 fixed the common wedge — a stale
snapshot now closes itself — but auditing the shipped behaviour against the
running API found three remaining ways a **submitted** session can hold its
lock with no route to a decision. While one is held, the branch cannot start
any new count: `POST /stock-counts` answers
`409 This branch already has an active stock count`.

| Wedge | Why approval can never succeed |
|---|---|
| `missing_ingredient` | A counted ingredient was deleted. Approval calls `moveStock()`, which 404s `Inventory movement ingredient was not found`; the transaction aborts and the session stays submitted and locked. |
| `orphan_lock` | A terminal count (approved/rejected/stale) still carries `activeKey` from legacy data or a direct database edit. The schema refuses to *save* one, but a raw driver write produces it and it blocks the branch identically. |
| `no_eligible_approver` | A manager-submitted count where separation of duties leaves nobody able to approve, and no active owner remains. |

### What recovery will and will not do

It **only** releases a branch lock held by a session proven undecidable, and
appends an audit row saying so. It never approves a count, never posts stock,
never writes `InventoryBalance` or `InventoryTransaction`, never alters a
captured `physicalQty`/`systemQty`/variance, and never deletes a count or an
audit row. A recovered session is closed as `stale` — the same terminal state
the approval path uses for an untrustworthy snapshot — with its counted figures
left intact for inspection. The recount is then created normally.

### 1. Dry run (the default)

```bash
node scripts/recover-stock-count-locks.js --restaurant <restaurantId>
```

Nothing is written. `--restaurant` is mandatory so a run can never span
tenants by accident. Optional: `--branch <id>`, `--min-age <minutes>`.

The same thing over HTTP, owner-only:

```bash
curl -X POST /api/stock-counts/recover-locks -H 'Authorization: Bearer <owner>' \
     -H 'Content-Type: application/json' -d '{}'
```

### 2. Review the output

Every locked session is listed with a verdict. Read them before applying:

* `actions[]` — sessions that **would** be recovered, each with `countNo`,
  `branchName`, `reason`, a plain-English `detail`, `ageMinutes` and the
  `toStatus` it would move to.
* `skipped[]` — locked sessions that will **not** be touched, and why
  (`Approvable by 2 user(s)`, `under the 720-minute threshold`, …).

A session younger than `minAgeMinutes` (default **720 = 12 hours**) is always
skipped, even when genuinely wedged, so an approval a manager is part-way
through is never swept out from under them. Widen with `--min-age` only after
reading the dry run.

### 3. Execute

```bash
node scripts/recover-stock-count-locks.js --restaurant <id> --apply \
     --reason "Ingredient deleted in error; branch KTM blocked since 12 Aug"
```

`--reason` (10+ characters) is mandatory with `--apply` and is written to the
audit trail. Each session is re-diagnosed inside the write, so anything decided
between the scan and the write is skipped rather than clobbered.

### 4. Verify

Re-run the dry run. It should report `scanned: 0` for the recovered branches.
The operation is idempotent — a second `--apply` recovers nothing and writes no
further audit rows. Confirm the branch works:
`POST /api/stock-counts` should now return `201`.

### Rollback and recovery considerations

* **There is nothing to roll back in the inventory.** Recovery moves no stock,
  so balances and the ledger are bit-identical before and after (pinned by
  test). No stock correction is ever needed afterwards.
* **The only state change is `status` + `activeKey`** (plus stale evidence).
  To reverse one, restore `status: 'submitted'` and `activeKey: '<branchId>'`
  on that document from your backup — but note the wedge will return, because
  the underlying cause (deleted ingredient, missing approver) is unchanged.
* **Prefer fixing the cause.** Re-creating the deleted ingredient, or adding an
  eligible approver, makes the session decidable again through the normal API;
  the write-time re-check will then skip it automatically.
* **The audit trail is append-only.** `stock_count_lock_recovered` records the
  prior status, the lock that was held, the machine-readable reason and the
  operator. Nothing before it is modified, so the history of who counted what
  survives recovery intact.
* Take a database snapshot before the first `--apply` in production, as with
  any migration. Docker is **not** available in this workspace, so no
  containerised rehearsal of this runbook has been performed.

## Inventory counts and stock adjustment (Phase 14 — counts)

A count session engine already existed: full and cycle scopes, an immutable
system snapshot, variance calculation, approval through the inventory ledger,
separation of duties, per-branch locking, idempotent create/decide and
optimistic versioning. None of it was rebuilt. This phase completed the brief's
state machine and fixed the defect that made stale counts unrecoverable.

### The session lifecycle

```
Draft → Counting → Submitted → Approved → ledger variance
                             → Rejected → recount
                             → STALE    → recount
```

| State | Meaning |
|---|---|
| `draft` | Opened, nothing entered. Holds the branch lock. |
| `counting` | **New.** At least one physical figure entered. Still editable. |
| `submitted` | Every line counted, awaiting a decision. Staff cannot decide. |
| `approved` | Variance posted to the ledger, one `ADJUSTMENT` per non-zero line. |
| `rejected` | Closed with a mandatory reason. Nothing moves. |
| `stale` | **New, terminal.** Stock moved after capture; the snapshot is discarded. |

Full counts cover every active ingredient; cycle counts cover a chosen subset
and touch nothing else. Each line records system quantity, physical quantity,
variance quantity and variance value, plus who counted it and when.

### Three defects fixed

**1. A stale approval left the session permanently stuck.** It threw, so the
count stayed `submitted` still holding the branch lock — it could never be
approved, never be closed, and `POST /stock-counts` answered
`409 This branch already has an active stock count` forever. **The branch could
never count again.** A stale-out is now committed as a terminal `stale` state
that releases the lock, records `staleAt` and lists exactly which ingredients
moved with their captured and current quantities. It is still a 409 to the
caller, because the approval genuinely did not happen.

**2. There was no `counting` state,** so a sheet a counter was part-way through
looked identical to an untouched draft.

**3. A recount had no link to the session it replaced.** `recountOf` now points
back, is tenant-scoped, and only accepts a `stale` or `rejected` parent.

### Stale protection

The check compares both the captured quantity **and** the ledger version, so a
movement that nets back to the same number is still detected — the sheet is no
longer evidence of anything. A stale snapshot is **never** written to the
ledger: valid movements made after capture always win. Verified under genuine
concurrency by driving the approval and a stock movement through overlapping
`mongoose` sessions; whichever loses, the movement is never lost and the ledger
chain stays intact.

## Tax invoice and receipt system (Phase 13 — invoicing)

Phase 4E already built sequential per-branch numbering, preview-does-not-
allocate, JSON + printable HTML, PAN enforcement and stored-figure rendering.
None of it was rebuilt. This phase audited that engine and fixed six defects,
each reproduced against the running API first.

### The rules, as enforced

| Rule | Behaviour |
|---|---|
| Number | `INV-<BRANCH>-<YEAR>-000001`, gapless per branch code and year. |
| Preview | Allocates nothing — no number, no counter row, no print count, no audit row. |
| Issue | Allocates once. Refused without a PAN, and refused entirely for a cancelled order. |
| Reprint | Reuses the number and stamps `REPRINT (1)`, `REPRINT (2)` by ordinal. |
| Immutability | The number, its date, the issuer and the invoiced total cannot be altered. |
| Void | An invoiced order that is cancelled keeps its number and reprints stamped `VOID`. |

### Six defects fixed

**1. Concurrent first-issues minted DUPLICATE invoice numbers.** The counter's
unique index was declared on the schema but the model is `autoIndex:false` and
no migration ever built it, so it did not exist. Four different orders were all
issued `INV-KTM-2026-000001`, with four counter rows for one branch.
`ensureSalesInvoiceIndexes()` now builds it (consolidating any duplicate
counters to the highest value first — a gap is explainable, a reused number is
not) and `nextInvoiceNumber()` retries on the resulting `E11000`. Duplicate
numbering is now defended at **two independent layers**: the counter-scope index
and a unique partial index on `{branch, invoiceNo}`. Removing either alone still
passes; removing both fails. Pre-existing duplicate numbers are **reported, never
renumbered** — an issued invoice is already in a customer's hands.

**2. The invoice number was freely rewritable.**
`Order.updateOne({...}, {invoiceNo: 'INV-KTM-2026-999999'})` succeeded. Now
refused at the document and query layers, along with `invoicedAt`,
`invoicedTotal` and `invoicedBy`.

**3. `printCount` could be rewound to 0,** so a reprint presented itself as an
original and the REPRINT marker simply vanished. The counter can no longer
decrease once a number is issued.

**4. An order edited after invoicing reprinted the same number with a different
total** (791 issued, 9999 reprinted). `invoicedTotal` is now pinned at
allocation and a drifted reprint is stamped `*** DOES NOT MATCH ISSUED INVOICE
***`. Orders invoiced before this field existed report `invoicedTotal: null` and
are never flagged as tampered.

**5. Cancelling an invoiced order left the number in place with nothing marking
it void, and the reprint was refused with a flat 409** — the guest held a
numbered tax invoice with no counterpart in the system. Cancelling now voids the
invoice, keeps the number, and reprints stamped `VOID` with the reason.

**6. Issuing or reprinting a tax document wrote no audit row.** Allocation,
every reprint and every void are now audited with the user, the number and the
print count.

The HTML escaper also now escapes `'` and `/`, so a value is safe in an
attribute context as well as in text.

## Refunds, voiding and financial controls (Phase 12 — financial)

The refund engine shipped in Phase 4D and was hardened in 11F. This phase did
not rebuild it: it audited the money-out paths against the running API and
fixed five defects, each reproduced with evidence and a passing control before
any code changed.

### The rules, as enforced

| Rule | Behaviour |
|---|---|
| Partial refund | Money only. Rs 1,000 paid less Rs 300 refunded leaves Rs 700 paid. The sale stays `completed` and **no stock is returned** — the food left the kitchen. |
| Full refund | Voids the sale. `completed` → `refunded`, and the ingredients go back through `reverseOrderStock()`, the same immutable-ledger path a cancellation uses. |
| Allocation | Newest tender first, so money goes back the way it came. Each reversal names the payment it reverses. |
| Authorisation | Manager and owner only, enforced server-side. |
| Reason | Mandatory, minimum three characters, written to the audit row *and* the reversal. |
| Original payment | Immutable. Never rewritten, never deleted. |

### Five defects fixed

**1. Cancelling a part-paid order stranded the guest's money.** The cancel
succeeded with the cash still banked, and `refundOrder()` then refused because
the order was cancelled — the money was neither the restaurant's nor returned.
`assertNoStrandedMoney()` now blocks the cancel (and the online-order reject)
while any refundable amount is held, naming the figure. Control: cancelling an
unpaid order still works.

**2. A full refund left the ingredients deducted.** Only the cancel path called
`reverseOrderStock()`. A voided sale now restores stock through the ledger —
verified by asserting `previous + change === new` on the `REVERSAL` row, and
that a partial-then-full sequence writes exactly one restoration.

**3. A refund could be issued with no reason at all,** leaving an audit row an
auditor could do nothing with.

**4. A settled payment row could be silently rewritten.** `payment.amount = 1;
payment.save()` succeeded and the money simply changed. Append-only was a
convention, not a constraint. It is now enforced at both the document and query
layers. The single sanctioned exception is a table merge re-parenting tenders
onto the surviving check, which must pass `reparentPayments: true` and may
change nothing but `order`.

**5. A reversed tender still counted as refundable.** Found while probing a
surviving mutation: a 300 cash + 491 khalti order with the cash reversed
reported 791 refundable while holding 491, so the reversed 300 could be handed
to the guest a second time.

### Refunding a live ticket

`REFUNDABLE_STATUSES` was widened beyond `completed`: a deposit on a ticket the
kitchen is still cooking can now be handed back. Such a refund reopens the
balance and leaves the ticket live — only `REFUND_CLOSES_FROM`
(`completed`, `refunded`) closes an order as `refunded`, and only that closure
returns stock. `cancelled` is refundable *only* so money stranded by rows
cancelled before fix 1 existed can still be repaid; it never reopens the ticket
and never restores stock twice.

## POS management workspace (Phase 14)

Phases 11A–11F built a tested POS engine that was **entirely API-only**:
refunds, payment reversal, receipt issuing and split payments had no screen at
all. Phase 14 connects them. No backend capability was rebuilt and no endpoint
was duplicated — the workspace binds to the existing routes.

`POS Admin` in the sidebar provides today's orders with date, status, payment
status, type and method filters plus free-text search over order number,
customer and invoice; a full order detail; and the financial controls.

### Two rules the UI follows

**Stored values only.** Every amount comes from the persisted order and
payment records. A test changes a menu price *after* a sale and asserts the
order still shows what was actually charged — a historical order is never
re-priced against today's menu.

**The backend is the authority.** Buttons are hidden by role for usability,
but every action is authorised server-side. The tests exercise the API
directly with a staff token, because hiding a button is not a control.

| Action | Who | Confirmation |
|---|---|---|
| Take payment | staff+ | Amount + method, capped at the outstanding balance |
| Refund | manager+ | Amount + reason, capped at refundable |
| Reverse payment | **owner** | Reason required, explains it is not a refund |
| Issue invoice | staff+ | Warns the number is permanent |

### Receipts

Preview and issue are deliberately different actions in the UI, because they
are different in the backend: **previewing never allocates an invoice
number**. Issuing allocates `INV-<BRANCH>-<YEAR>-######` once; reprints reuse
it and are marked `REPRINT`. A test asserts a customer named
`<script>alert(1)</script>` is escaped in the rendered HTML.

### Loyalty — deferred, not implemented

Loyalty **balances** are displayed by the CRM (Phase 9) and points accrue from
spend. There is **no redemption workflow** in the backend, so none was invented
here. Burning points at the till remains a separate bounded task.

## POS split payments (11F)

Multiple tenders, partial payment, running balance, overpayment refusal and
the refund rules shipped in Phase 4D. 11F audited them against the running API
and fixed three gaps.

### Verified working, now pinned

One bill split across cash + card + eSewa settles exactly, the balance falls
correctly at each step, and the order only completes when the due amount
reaches zero. Overpayment, negative and zero amounts are refused with nothing
banked. Over-refunding is refused; a partial refund leaves the sale
`completed`, a full one moves it to `refunded`. Refunds are supervisor-only.

### Three defects fixed

**1. A double-clicked payment banked twice.** Goods receiving and supplier
payments both require an `Idempotency-Key`; the customer till — the one a
cashier actually hammers on a slow connection — ignored it. Payments now
accept a key, a replay returns `200` with the original payment, and a unique
partial index on `{order, idempotencyKey}` enforces it at the database.

**2. A retried refund paid the guest back twice.** Refunds now honour the same
key. The index is scoped to `status: 'paid'` because one refund may legitimately
split across several original tenders and write several rows under one key.

**3. There was no way to reverse a payment taken by mistake.** The only
correction was a refund, which misstates a till error as money returned to a
customer.

### Reversal vs refund

| | Refund | Reversal |
|---|---|---|
| Meaning | Money genuinely returned to a guest | A till **mistake** (wrong tender/amount) |
| Record | Stays on the books | Original row kept and marked `reversed` |
| Effect | `refundAmount` rises | Balance reopens, correct tender can be taken |
| Who | Owner or manager | **Owner only** |

`POST /api/payments/:id/reverse` is deliberately narrow: it requires a reason,
refuses a second attempt, and refuses any tender that has been fully or
partly refunded — that amount would be ambiguous. Every reversal is audited.

### Note

The `Payment` reversal fields were initially added with `schema.add()` after
the model had compiled. `status` persisted but `reversedAt` silently did not,
so a double reversal succeeded. Fields must be declared in the schema literal.

## POS coupons (11E)

The coupon engine shipped in Phase 4C and implements all ten requirements:
code, percentage/fixed, validity window, minimum order, maximum discount,
total usage limit, per-customer limit, branch scope, menu-item scope and
redemption records. 11E audited each against the running API and fixed one
real defect.

### Defect: the usage limit could be exceeded

The total usage limit was enforced by counting redemptions in
`validateCoupon()` and then inserting — a read-then-write race. Two concurrent
transactions both read `used = 0` against a `usageLimit` of 1, both inserted,
and the coupon was **redeemed twice**. Reproduced against the database before
the fix.

`recordRedemption()` now claims the limit atomically:

```js
Coupon.updateOne(
  {_id: coupon._id, timesRedeemed: {$lt: limit}},
  {$inc: {timesRedeemed: 1}}
)
```

Only one writer can move the counter while it is still below the limit; the
loser matches no document and is refused. The unique `{coupon, order}` index
separately prevents one order redeeming the same coupon twice.

**Guarded twice, deliberately.** `validateCoupon()` still checks first so a
guest gets a clear message before the order is priced; the atomic claim is the
guarantee. Removing either alone is safe, removing both is not, and tests pin
each.

### A note on testing concurrency

Driving the race over HTTP did **not** reproduce it — Express serialises the
requests, so two mutations of the fix survived an over-the-wire concurrency
test. Only genuinely overlapping `mongoose` sessions expose a read-then-write
race. Concurrency tests that go through the HTTP layer can give false
confidence.

## POS discounts (11D)

The discount engine shipped in Phase 4C: percentage and fixed, line and order
scope, coupon clamping, and an `order_discount` audit entry. 11D bounds it.

### The policy, and why it needed a ceiling

The chosen policy is **any staff may discount, and everything is audited** — a
counter should not need a manager for a small goodwill gesture. The audit
found that implemented as *unlimited* and audited: a till operator could take
**100% off any order**, and the audit would faithfully record the theft. A
reason was also optional, which makes the trail close to useless.

The policy is unchanged. It is now bounded:

| Setting | Default | Applies to |
|---|---|---|
| `staffMaxDiscountPercent` | 20% | Non-supervisors |
| `staffMaxDiscountAmount` | 500 | Non-supervisors |
| `maxDiscountPercent` | 100% | **Everyone, including owners** |

All three are per-restaurant. The hard ceiling exists to catch a mistyped
100%, not a dishonest one. A reason is now **mandatory**.

### Evasion is closed

Ceilings are checked on the **combined** manual write-off, not per discount:

- Splitting one write-off across several lines is authorised on the **sum**.
- A 15% line discount **plus** a 15% order discount is ~28% combined; each is
  individually under a 20% ceiling, so the combination is checked too.

Coupons are exempt from the till ceiling — their limits are set by management
in the coupon itself, not typed at the counter.

The legacy bare-numeric form (`discount: 100`) has nowhere to carry a reason
and is a documented contract, so it is exempt from the reason requirement —
but it is still subject to every ceiling.

## POS modifier catalog integrity (Phase 11A)

The modifier **engine** shipped in Phase 4B — selection validation,
cardinality, variant/extra pricing and ingredient deltas — and is unchanged.
Phase 11A hardens the **catalog** that engine reads.

An audit authored ten deliberately incoherent catalogs; five were accepted:

| Accepted before | Consequence at the till | Now |
|---|---|---|
| Option pointing at **another restaurant's ingredient** | Order rejected 404 for every guest picking it | Refused at authoring |
| `qty` with **no unit** | Converted against the base unit and deducted the **wrong** amount | Refused |
| `minSelect` above the option count | Group unorderable — every attempt rejected | Refused |
| `single` select with `minSelect > 1` | Contradiction, unorderable | Refused |
| `variant` group where no option changes price | Size choice that silently does nothing | Refused |

The cross-tenant case was **not** a data leak — the order path already blocked
it (`Modifier X is not available for this restaurant`), which is why it went
unnoticed. The defect was that breakage surfaced as a support call from the
counter rather than a validation error where an operator could fix it. The
same checks run on **edit** as well as create, so an update is not a way
around them.

### The reference catalog

```
Burger (base 200)
├── Size    (variant, single, required)     Small 150 · Medium 200 · Large 260
└── Extras  (extra,  multi, max 3)          Cheese +40 (20g) · Bacon +60 · Sauce +15
```

A variant **replaces** the line price; extras are **deltas**. Large + Cheese +
Bacon = 260 + 40 + 60 = **360**, and two of them deduct **40g** of cheese.
Verified end to end against the database, not just the response.

## Rider production readiness (Phase 12)

### Account provisioning — four vulnerabilities fixed

`POST /auth/register` was `User.create({...req.body})` with no validation. A
live probe confirmed all four of these before any code changed:

| Defect | Fix |
|---|---|
| An owner could plant a user in **another restaurant** by passing `restaurantId` | Tenant is read from the caller's token; unknown fields are rejected |
| The **bcrypt hash was returned** in the response body | `publicUserView()` builds the response by hand and never includes it |
| A **one-character password** was accepted | 10+ chars, letters and numbers, common passwords refused |
| A **missing password crashed** the request (unhandled rejection) | Validated, returns `400` |

Accounts are created through `POST /api/accounts` (owner-only). **`owner` is
not a creatable role** — an owner account is a deployment act, not an API call.
Duplicate email and duplicate rider phone are both refused.

`User.active` now exists for every account and is **enforced at login**: a
deactivated employee cannot authenticate even with the correct password. A
rider holding live deliveries **cannot** be stood down — the jobs would be
stranded with nobody able to advance them; reassign first.

### Proof of delivery

Completing a delivery previously required nothing — "delivered" was a button a
rider could press from anywhere. It now requires evidence:

- `proofType` — handed to customer / neighbour / reception / left at door / other
- `receivedBy` — required when nobody took it in person (the disputed case)
- `proofNote` — free text
- `proofAt` / `proofBy` — stamped separately from `deliveredAt`, so a later
  correction cannot silently rewrite when proof was captured

Proof is written **both** onto the delivery and into the immutable audit trail,
so it survives any later edit to the document. Staff see it on the dispatch
board; the rider sees it on the finished job.

**Documented storage limitation:** there is no photo or signature capture.
This repository has no object storage (no S3, no GridFS, no upload pipeline),
and introducing an external storage service here would be unverifiable in this
environment. The bounded, honest version is a typed handover record. Adding
image capture requires an object-storage decision first, and is out of scope
for this phase.

### Rider UI

Completion opens an explicit proof form rather than firing on one tap;
"report a problem" asks for confirmation because a failed delivery cannot be
walked back. Both irreversible actions are now guarded.

## Rider app (Phase 11)

### What a rider sees

A rider logging in gets the courier workspace instead of the staff shell
(`RiderApp.jsx`), rendered straight after the login gate. The backend refuses
them every operational endpoint regardless — this only stops a phone user
staring at a menu where nothing works. Mobile-first: one job in focus, one
large primary action, tap-to-call the customer.

`GET /deliveries/mine/dashboard` returns identity, shift state, workload
against capacity, the job in hand and today's delivered/failed counts —
computed server-side from the caller's own token, because a client that
assembled those figures itself could be pointed at another rider's data.

### Security fix: the rider payload leaked margin data

Phase 10's rider endpoints populated the order wholesale, which handed a
courier `foodCost`, `recipeCost`, `packagingCost` and `inventoryRequirements`
— per-item margins and recipe quantities. Phase 11 replaces this with a
hand-built `riderDeliveryView()`: the rider now gets the address, the customer
name and phone (needed at the door, and previously *missing*), what to collect,
and item names with quantities so they can check the bag. Nothing else.

A regression test asserts each leaked field never appears in either the list or
the detail response.

### Authentication

`POST /api/auth/login` and `/auth/register` moved out of `index.js` into
`routes/auth.js`. They were inline in the app file, so **no integration test
could reach them** — rider login had zero coverage despite the role shipping in
Phase 10. Behaviour is unchanged; the test harness now mounts the same router
production does, and login is covered.

Login answers identically for an unknown email and a wrong password, so the
endpoint cannot be used to discover which accounts exist.

### Rider boundaries (all tested)

| Attempt | Result |
|---|---|
| Anonymous / invalid / expired JWT | `401` on every rider route, read and write |
| Staff calling a rider-only route | `403` |
| Rider calling any staff route | `403` |
| Rider A reading or writing rider B's delivery | `404` — never `403`, which would confirm it exists |
| Rider reading the unassigned pool | Empty; detail is `404` |
| Rider from another restaurant | Empty board, `404` on our deliveries |
| Forged `rider` id in the request body | Rejected; identity comes from the token only |
| Rider cancelling a delivery | `403` — cancelling has money in it |
| Rider editing their own capacity | `400`, strict schema |
| Skipped, duplicate, completed or cancelled transition | `409`, database unchanged |

### Realtime

Riders join only their private `rider:<id>` room. Requesting a branch at
handshake time is ignored, `join:branch` is refused, and a test publishes a
branch-only `inventory:update` to prove no kitchen or stock traffic reaches a
rider socket. Assignment, reassignment and status changes each push to the
correct rider; a test asserts an unrelated rider hears nothing.

The UI distinguishes connected / reconnecting / offline, and separates "your
session expired" (re-login) from "the network blipped" (retry) — a rider on a
bike loses signal constantly.

### Availability

`PATCH /deliveries/mine/availability` toggles shift state for the authenticated
rider only. Now **audited** (`rider_available` / `rider_unavailable`) — it was
persisted but not audited in Phase 10, so a rider going off shift mid-rush left
no trail. A deactivated rider cannot put themselves back on shift.

## Addresses & delivery (Phase 10)

### The rider role

Phase 10 introduces `rider`, the lowest-privilege principal in the system.

**Adding it to the role enum silently widened every endpoint guarded by a bare
`auth()`** — the branch list, transfers and the expense ledger among them,
because `auth()` with no role list means "any authenticated principal". Those
call sites now use `requireStaff()` (`owner`/`manager`/`staff`), and a test
asserts a rider token is refused by each. There are no bare `auth()` guards
left in the codebase.

A rider may only ever:

- list the deliveries **assigned to them** (`GET /deliveries/mine`)
- read one of those (`GET /deliveries/mine/:id`)
- advance it to `picked_up`, `out_for_delivery`, `delivered` or `failed`
- set their own shift state (`PATCH /deliveries/mine/availability`)

They cannot browse the unassigned pool, see a branch queue, touch another
rider's job, cancel anything (that has money in it), or change their own
profile limits. The rule is enforced in one helper, `riderDeliveryOrFail()`,
which every rider path goes through; anything not assigned to them answers
`404`, never `403`, so delivery ids cannot be probed.

On Socket.IO, riders join a **private `rider:<id>` room** and are refused a
branch room in both the handshake and `joinBranch()`. Branch rooms carry
kitchen tickets and inventory movements, which a rider has no business seeing.

### Lifecycle

```
Order ready
   ↓  POST /deliveries
pending ──► assigned ──► picked_up ──► out_for_delivery ──► delivered
              │             │                │
              └─────────────┴────────────────┴──► failed  (reason required)
   any live state ──► cancelled (staff only)
```

Terminal states are dead ends: a delivered job cannot be walked back, so no one
can un-complete finished work. Reassigning an in-flight delivery **rewinds it
to `assigned`** and clears the pickup/dispatch stamps, so a new rider is not
credited with the previous rider's progress.

Order status follows along: `out_for_delivery` moves the order, and `delivered`
completes it and stamps `completedAt` (without which the ticket vanishes from
kitchen performance metrics).

### Duplicate dispatch

One live delivery per order, enforced by a **unique partial index** on `order`
covering every non-cancelled status — so a failed attempt can legitimately be
re-dispatched, but two dispatchers clicking at once cannot both win. Note that
MongoDB partial indexes do **not** support `$ne`, so the filter lists the
statuses explicitly; the model and the migration must keep identical
definitions.

### Riders and capacity

Riders carry `active` (employment) and `available` (shift) separately — a rider
who is off shift must not be confused with one who has left. Deactivating a
rider also takes them off shift. Assignment refuses an inactive rider, a rider
from another branch or restaurant, and one already at `maxConcurrent` live
deliveries (default 3): silently stacking jobs on one rider is how food goes
cold.

### Dashboard

`GET /deliveries/dashboard` buckets into pending, assigned, active, completed,
failed and **delayed**. Lateness is *derived* from `dueAt` against the clock,
never stored — a persisted "late" flag would be wrong a minute later.

### Addresses

Addresses are managed individually (`POST`/`PATCH`/`DELETE
/customers/:id/addresses[/:addressId]`) rather than by replacing the array, so
two staff editing different addresses cannot clobber each other. Exactly one
address is the default, enforced server-side: the first address added becomes
the default automatically, and deleting the default promotes another. Each
carries a label and rider `instructions` (gate codes, landmarks), which are
**copied onto the delivery at dispatch** so a later edit cannot rewrite what
the rider was told. Capped at 10 per customer; duplicates are refused.

### Migration

`ensureDeliveryIndexes()` backfills `branch`/`restaurant` onto historical
deliveries (previously joined through the order every time), maps the legacy
`available`/`picking_up` statuses to `pending`/`picked_up`, infers missing
lifecycle stamps, and retires duplicate dispatches as `cancelled` rather than
deleting them — a cancelled row is honest where a missing row is not. It drops
the unique index first so it cannot deadlock against the duplicates it exists
to clean, then rebuilds it. Idempotent.

## Customers & CRM (Phase 9)

### Scope: customers are restaurant-wide

This is the central decision of the phase, and it changed existing behaviour.

Before Phase 9 a `Customer` carried only a `branch`, and the storefront
deduplicated on `{branch, phone}`. A guest who ordered from Kalanki on Monday
and Patan on Friday became **two profiles**, splitting the very lifetime-spend
and loyalty figures a CRM exists to report.

Customers are now scoped to the **restaurant**. `branch` is retained as the
*home* branch — where the guest was first seen — for attribution, reporting
and the existing branch-scoped list endpoint. It is no longer an isolation
boundary; `restaurant` is. Tenant isolation is therefore strictly *stronger*
than before, because the old model had no restaurant field to filter on at all.

One consequence, deliberately accepted: a reservation may now be booked at any
branch for a guest first seen elsewhere. The guard that previously rejected
this (`Customer belongs to another branch`) now checks the restaurant instead.

### Deduplication

Phone numbers are normalised before comparison — `+977 9800000001`,
`9779800000001`, `09800000001` and `9800000001` are one person. The normalised
value is stored as `phoneKey` and carries a **unique partial index per
restaurant**, so deduplication is enforced by the database rather than by a
lookup that can race. Every write path — CRM, POS and the public storefront —
converges on one `findOrCreateCustomer()` helper.

Two different restaurants may of course each hold the same phone number.

### Derived statistics

`stats` and loyalty tiers are **always recomputed from orders**, never
incremented in place and never writable by a client — an incremented counter
drifts the moment an order is refunded, cancelled or edited.

| Figure | Rule |
|---|---|
| `totalSpend` | Settled orders, **minus refunds** |
| `cancelledOrders` | Counted, but excluded from spend |
| `averageOrderValue` | `totalSpend / completedOrders` |
| Loyalty tier | Derived from lifetime spend: silver 15k, gold 50k, platinum 100k |

Rollups refresh after a payment or refund **commits** — never inside the
transaction, because a reporting figure must not be able to fail a sale.
`POST /customers/:id/recalculate` repairs any drift.

### API

| Route | Roles |
|---|---|
| `GET /customers/search` — phone, name, email or customer ID | staff+ |
| `GET /customers/:id`, `GET /customers/:id/history` | staff+ |
| `POST /customers`, `PATCH /customers/:id` | staff+ |
| `GET /customers/summary` | manager+ |
| `POST /customers/:id/loyalty`, `POST /customers/merge` | manager+ |
| `PATCH /customers/:id/active` | owner |
| `DELETE /customers/:id` | **405 — always** |

Search terms are escaped before reaching a regular expression, so `.*` matches
nothing rather than everyone.

### Privacy

There is **no public customer API**. Every route above requires
authentication, a record belonging to another restaurant answers `404` rather
than `403` (a 403 would confirm it exists), and the public storefront never
returns profile data — order confirmations and tracking expose neither email,
loyalty, notes nor lifetime spend.

### Deletion

Customers are **deactivated, never deleted**: orders reference them, and
destroying a profile would orphan financial history. `DELETE` returns 405 and
says so. Deactivation is reversible and audited.

Duplicates created before this phase can be reconciled with
`POST /customers/merge`, which repoints orders, unions addresses, sums loyalty
points and leaves a tombstone (`mergedInto`) so old links still resolve.

### Migration

`ensureCustomerIndexes()` runs at startup: it backfills `restaurant` from the
home branch and `phoneKey` from the phone, merges the per-branch duplicates the
old model created, and only then builds the unique index — which would
otherwise fail against that existing data. It drops the constraint first so a
re-run cannot deadlock against the duplicates it exists to clean, and it is
idempotent.

## Online payments (Phase 8B)

eSewa ePay v2 and Khalti ePayment v2 are fully integrated: initiation,
redirect, signed callback, server-side verification, settlement and audit.

### Flow

```
Public order (pending, unpaid)
      ↓  POST /api/public/payments   {orderNo, phone, provider}
PaymentIntent (initiated → pending)     expectedAmount captured here
      ↓  eSewa: signed form POST      Khalti: server-to-server initiate → payment_url
Provider-hosted payment page
      ↓  redirect to /api/public/payments/return?ref=…
Server-side verification                ← the browser is NOT believed
      ↓  eSewa: HMAC verify + status enquiry   Khalti: lookup API
Amount checked against expectedAmount
      ↓  transaction
Payment (paid) · Order.paidAmount · PaymentIntent.settledAt · Audit
      ↓  staff accept
Kitchen ticket + inventory deduction
```

### The security rule

**A payment is real only when the provider confirms it, server-to-server, for
an amount recorded before the guest left.** Concretely:

| Attack | Defence |
|---|---|
| Browser claims `status=Completed` | Redirect status is ignored; eSewa is re-confirmed by status enquiry, Khalti by the lookup API |
| Forged callback signature | HMAC-SHA256 verified with a constant-time compare |
| Signed blob edited after signing | Signature covers the edited fields, so verification fails |
| Signature covering a harmless subset | `signed_field_names` must include `transaction_uuid`, `total_amount` and `status` |
| Underpayment / amount tampering | Provider amount compared to `expectedAmount`; a mismatch is refused **and** audited for a human |
| Callback replayed | `PaymentEvent.dedupeKey` unique index — the database refuses the second write |
| Two callbacks racing | Settlement atomically claims the intent with a conditional `findOneAndUpdate` on `settledAt: null` |
| Paying someone else's order | Ownership requires order number **and** the phone on the order |
| Callback naming another transaction | `transaction_uuid` / `purchase_order_id` must equal our own reference |
| Accepting unpaid prepaid food | Staff `accept` refuses an `esewa`/`khalti` order without `paymentSettledAt` |

The reference handed to a gateway is a random UUID, not the order id, so a live
reference cannot be guessed.

### Statuses

Provider vocabularies are normalised to `paid | pending | failed | cancelled |
expired | refunded`. **Anything unrecognised normalises to `failed`** — an
unknown status is never treated as money.

### Secrets

Credentials live only in the environment; `.env` is git-ignored and nothing is
baked into an image. `/health` reports whether a gateway is *configured*, never
its key, and `redactPaymentPayload()` strips signature/key/token fields before
any provider payload is persisted to `PaymentEvent` or logged.

In **sandbox**, eSewa falls back to the vendor's published test credentials, so
eSewa works locally with no setup. Production **refuses to start** with those
credentials, or with `PAYMENT_MODE=sandbox`. Khalti publishes no shared test
key, so Khalti is hidden from the storefront until `KHALTI_SECRET_KEY` is set —
a gateway with no credentials is never offered, because a dead redirect is
worse than an honest refusal.

### Cash on delivery

Unchanged and deliberately exempt: COD orders settle on delivery, so they may
still be accepted unpaid.

## Deployment hardening (Phase 8A.6)

### Expected topology

```
Browser
   │  https (TLS terminates at the host proxy / load balancer)
   ▼
web  — Nginx  (client/nginx.conf, container port 80, published :8080)
   │  http, docker network
   ▼
api  — Express (container port 4000, published on 127.0.0.1 only)
   │
   ▼
mongo — replica set rs0 (never published)
```

Nginx is the **only** reverse proxy in front of the API. It sets `Host`,
`X-Real-IP` and appends the peer address to `X-Forwarded-For`, and the API port
is bound to loopback on the host, so nothing external can reach Express
directly. If you place another proxy or load balancer in front of `web`, raise
`TRUST_PROXY` by that number of hops — and only by that number.

### Environment classes

`development`, `test`, `staging` and `production` are treated separately.
`NODE_ENV` cannot express staging (build tooling only understands "production"
or not), so `APP_ENV` is the explicit deployment class and takes precedence.

| Class | CORS | Notes |
|---|---|---|
| `development` | `reflect-any-origin` when `CLIENT_URL` is empty | Local convenience only. |
| `test` | same as development | Rate limits are bypassed; see below. |
| `staging` | `allowlist`, `CLIENT_URL` mandatory | Hardened identically to production. **Never** falls back to permissive CORS, even with `NODE_ENV=development`. |
| `production` | `allowlist`, `CLIENT_URL` mandatory | Startup fails if missing, wildcarded, path-bearing, or plaintext `http` for a non-loopback host. |

An unrecognised `APP_ENV` is a startup error. An unrecognised `NODE_ENV` is
treated as production, so an unexpected value fails to the strict side rather
than silently unlocking the permissive path.

`Access-Control-Allow-Credentials` is never sent. Authentication is a Bearer
token held by the SPA, not a cookie, so no origin ever needs to send ambient
credentials — and credentials combined with a reflected origin is the classic
CORS foot-gun.

### Trust proxy

| `TRUST_PROXY` | Effect |
|---|---|
| unset | `loopback` — only a proxy on this host may set forwarding headers (safe default). |
| `1`, `2`, … | Trust exactly N hops. Use `1` for the bundled Nginx. |
| `false` / `0` | No proxy; `req.ip` is the socket peer and `X-Forwarded-For` is ignored. |
| `loopback`, `uniquelocal`, CIDR list | Passed to Express verbatim. |
| `true`, `*` | **Rejected at startup.** |

The default is deliberately not `1`: with no proxy actually in front, trusting
one hop makes the caller's own `X-Forwarded-For` authoritative, letting anyone
forge their rate-limit identity. Trusting exactly the hops that exist means a
prepended forged entry is discarded and the address Nginx appended wins.

### Rate limiting

| Surface | Window | Max | Key |
|---|---|---|---|
| `GET /api/public/branches`, `/api/public/menu` | 60 s | 120 | client IP |
| `POST /api/public/quote` | 60 s | 30 | client IP |
| `POST /api/public/orders` | 15 min | 8 | client IP |
| `GET /api/public/orders/:orderNo` (track) | 60 s | 20 | client IP |
| `POST /api/auth/login` | 15 min | 10 | client IP |

Authenticated staff endpoints are otherwise not rate limited; they are protected
by JWT authentication and RBAC. The limiter supports keying by user id
(`byUser`) so an abusive account cannot exhaust the bucket of everyone sharing
an office NAT address, and that path is covered by tests.

The bucket key is `req.ip`, which honours the `trust proxy` setting above.
IPv4-mapped IPv6 addresses are folded so a single client cannot occupy two
buckets.

**Scope — read this before scaling out:**

```
Single API instance:      supported
Multiple API instances:   requires a shared rate-limit store such as Redis
```

Counters live in each process's memory. With N API containers behind a load
balancer the effective limit is up to N × max. This is **not** solved.

**Redis decision:** Redis is not part of this project's infrastructure and the
Compose deployment runs exactly one `api` service, so adding
`rate-limit-redis` today would introduce a production dependency and an
operational failure mode for no present benefit. Instead the store is injected:

```js
import {configureRateLimitStore} from './services/rateLimiting.js';
import RedisStore from 'rate-limit-redis';

configureRateLimitStore(({name, windowMs}) => new RedisStore({/* … */}));
```

Call it once at startup before the routers are imported. No route changes.
`GET /health` reports `rateLimit: "per-instance-memory"` or `"shared-store"` so
the active scope is observable in a running deployment.

Limits are bypassed when `NODE_ENV=test` — a functional suite legitimately
places dozens of orders in seconds. The predicate is evaluated per request, not
at module load, and the limiter itself is covered by tests that mount it
unconditionally on their own Express app.

## Production deployment checklist

1. Generate a unique secret (for example, `openssl rand -hex 32`) and set `JWT_SECRET`.
2. Set `CLIENT_URL` to the exact public HTTPS origin; do not use `*`. Set `APP_ENV=production` (or `staging` for a staging host — never leave staging on the development default).
2a. Set `TRUST_PROXY` to the real number of proxies in front of the API — `1` for the bundled Nginx. Confirm afterwards with `GET /health`: `clientIp` must be the real browser address, not the proxy's.
2b. Rate limiting is per API instance. Run exactly one `api` container, or introduce a shared store first (see **Deployment hardening**).
3. Use a backed-up MongoDB replica set/sharded cluster. The bundled one-member Compose replica set provides transaction semantics but **not high availability**.
4. If the Compose API should connect to managed MongoDB, set `COMPOSE_MONGODB_URI` to that transaction-capable URI. The base Compose file still starts its bundled Mongo services; remove/disable those services in the deployment-specific override when they are not needed.
5. Publish the web service through a TLS reverse proxy or load balancer. Keep MongoDB private and keep the direct API port private/loopback-only.
6. Verify `https://your-origin/health`, login, an authenticated API request, and Socket.IO connectivity after deployment.
7. Configure automated encrypted backups, retention, restore drills, monitoring, and log collection before storing live restaurant data.
8. Never seed a live database.

The included Nginx configuration provides SPA fallback, same-origin API and Socket.IO proxying, gzip, security headers, static-asset caching, and a proxied readiness endpoint. TLS should terminate at the host proxy/load balancer in front of port 8080.

### Basic backup example for bundled MongoDB

```bash
docker compose exec -T mongo mongodump --archive --gzip > mittho-$(date +%F).archive.gz
```

Test restoration in a separate environment. A destructive restore uses `mongorestore --archive --gzip --drop`; do not run it against live data without a reviewed recovery procedure.

## Verification

```bash
npm test
npm run build
```

The server suite includes a connected Phase 1 HTTP/Socket.IO lifecycle covering supplier catalog, purchase order approval, damaged receiving, exact-lot return, matched invoice, payment, supplier statement, purchasing report reconciliation, idempotent replays, audit evidence, inventory ledger evidence, branch isolation, and realtime audience filtering.

## Accounting integrity

Sales store calculated food cost at creation, so later ingredient prices do not rewrite historical COGS. Inventory transactions and supplier liability events preserve append-only movement history. Purchasing quantities are normalized to ingredient stock units; invoices and returns reconcile against receipt-backed quantities and values.

The **Month Close** workspace uses `Asia/Kathmandu` boundaries, checks open orders and ledger health, and shows unresolved purchasing warnings. Managers reconcile their assigned branch; only owners can close or reopen. Reopening preserves the prior revision and the next close creates a new audited revision.

## Waste management

Waste is recorded through the same append-only, lot-aware inventory ledger used by purchases, recipes, transfers, returns, and adjustments—there is no separate waste stock balance. Every accepted event removes stock atomically, preserves category/notes/actor/lot/cost evidence, emits a branch-scoped inventory update, and contributes to P&L and close reporting.

- `POST /api/waste/record` requires an `Idempotency-Key` header and accepts `expired`, `spoiled`, `damaged`, `burned`, `spilled`, `wrong_preparation`, `customer_return`, or `other`.
- `GET /api/waste/events?branch=<id>&category=<category>&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&limit=50` returns branch-authorized history, all-category summary facets, and immutable ledger/lot evidence. Dates are inclusive `Asia/Kathmandu` calendar days.

The Stock Operations workspace provides recording confirmation, notes, exact-lot selection, category/value summaries, filters, and paginated history. The retired unscoped `/api/waste` CRUD endpoint remains unavailable by design.

## Supplier statements and purchasing reports

Statement APIs:

- `GET /api/suppliers/:id/statement?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&limit=100`
- `GET /api/suppliers/:id/balance?branch=<id>&asOf=YYYY-MM-DD`
- `GET /api/suppliers/:id/payments?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`

Purchasing report API:

- `GET /api/reports/purchasing?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`

Public dates are inclusive `Asia/Kathmandu` calendar days. Managers are restricted to their assigned branch; owners may select a branch or review restaurant-wide totals. Reports preserve invoice-void and payment-reversal events and disclose matching or inventory-ledger reconciliation warnings.

## External launch items

A real rollout still needs restaurant-specific menu/import data, approved VAT invoice-numbering rules, POS printer setup, payment-provider verification endpoints, user training, access reviews, and an organization-owned backup/retention policy.
