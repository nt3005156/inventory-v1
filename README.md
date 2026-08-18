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
