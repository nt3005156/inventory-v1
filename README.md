# Mittho OPS — Restaurant Inventory & Costing Management (Nepal)

A full-stack operational system for Nepali restaurants: purchases update live stock and weighted costs; recipes calculate dish costs; POS sales permanently record COGS and deduct recipe stock. All money is NPR and VAT support is included in the sale schema.

## Modules
- JWT auth with **Owner / Manager / Staff** permissions and auth rate limit
- Ingredients, suppliers, recipes/menu mapping, append-only price history, audit events
- Purchase register with payment status and automatic weighted-average inventory costing
- Live inventory, reorder thresholds, stock valuation, waste model, stock alerts
- Fast mobile-responsive POS: dine-in/takeaway/delivery and cash/eSewa/Khalti/card selections
- Dashboard KPIs, menu engineering (Star / Plow-horse / Puzzle / Dog), P&L endpoint
- Expenses, branch-aware month reconciliation, immutable close revisions, owner-controlled reopen and audit history
- Docker Compose deployment configuration and MongoDB Atlas-compatible environment setup

## Run locally
```bash
cp .env.example .env
npm install
npm run seed        # requires MongoDB at MONGODB_URI
npm run dev
```
Open `http://localhost:5173`. API runs at `http://localhost:4000`.

**Demo credentials:** `owner@mittho.com` / `mittho123`

## Windows + Docker Desktop (one-click)
1. Install and open [Docker Desktop](https://www.docker.com/products/docker-desktop/); wait for the engine to say it is running.
2. Double-click **`START-WINDOWS.bat`** in the project folder.
3. The script creates `.env`, builds and starts MongoDB/API/web containers, and asks whether to load the sample Mittho data. Choosing **Y** resets the demo database, so choose **N** after you begin entering real data.
4. The system opens at `http://localhost:8080`. Demo login: `owner@mittho.com` / `mittho123`.

To stop the system later, open Command Prompt in the project folder and run `docker compose down`. To see errors, run `docker compose logs -f`.

## Deploy
Set production `MONGODB_URI`, strong `JWT_SECRET`, and `CLIENT_URL`, then use Docker Compose. On a VPS, put the web app behind TLS (Caddy/Nginx). eSewa and Khalti keys are intentionally environment stubs; no payment credential is hard-coded.

## Accounting integrity
Sales store their calculated food cost at creation, so later ingredient price changes do not rewrite historical COGS. PriceHistory and the inventory transaction ledger are append-only.

The **Month Close** workspace previews a calendar month using `Asia/Kathmandu` boundaries, checks open orders and ledger health, and shows unresolved purchasing warnings. Managers can reconcile their assigned branch; only the owner can close or reopen. A close stores an immutable `MonthlySnapshot` of P&L and historical opening/closing inventory. Reopening preserves that revision and its figures; the next close creates a new audited revision.

Month-close API:
- `GET /api/month-close/preview?month=YYYY-MM&branch=<id>`
- `GET /api/month-close`
- `POST /api/month-close`
- `POST /api/month-close/:id/reopen`

## Supplier statements
Owners and managers can review supplier balances through the Purchasing workspace. Statements are tenant scoped; managers are restricted to their assigned branch, while owners may select a branch or review all branches. Period boundaries and aging use `Asia/Kathmandu`, amounts are NPR including recorded invoice VAT, and invoice voids plus payment reversals remain explicit ledger adjustments.

Statement APIs:
- `GET /api/suppliers/:id/statement?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD&page=1&limit=100`
- `GET /api/suppliers/:id/balance?branch=<id>&asOf=YYYY-MM-DD`
- `GET /api/suppliers/:id/payments?branch=<id>&from=YYYY-MM-DD&to=YYYY-MM-DD`

## Remaining client configuration items
Actual production needs client menu/import data, VAT invoice numbering rules, POS printer hardware configuration, payment-provider verification endpoints, staff training, and a backup/retention policy before launch.
