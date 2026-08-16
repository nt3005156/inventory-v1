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
