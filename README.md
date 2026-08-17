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
| `CLIENT_URL` | Comma-separated exact HTTP(S) browser origins, with no paths or wildcard. Required in production. |
| `PORT` | API listen port, 1–65535. Compose fixes the internal API port at 4000. |
| `ESEWA_MERCHANT_CODE` | Optional integration setting; no credential is hard-coded. |
| `KHALTI_SECRET_KEY` | Optional integration setting; no credential is hard-coded. |

For the default Docker endpoint, keep `http://localhost:8080` in `CLIENT_URL`. For public deployment, replace local values with the exact TLS origin, such as `https://ops.example.com`.

The API refuses to listen until configuration is valid, MongoDB reports transaction capability and a writable primary, and all operational migrations complete.

## Health and shutdown behavior

`GET /health` returns HTTP 200 only when startup has completed and Mongoose is connected. The Docker web container proxies the same endpoint:

```json
{"ok":true,"database":"connected","startup":"ready"}
```

During shutdown, the API stops realtime delivery, closes the HTTP server, and disconnects MongoDB. Docker allows 15 seconds before forced termination.

## Production deployment checklist

1. Generate a unique secret (for example, `openssl rand -hex 32`) and set `JWT_SECRET`.
2. Set `CLIENT_URL` to the exact public HTTPS origin; do not use `*`.
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
