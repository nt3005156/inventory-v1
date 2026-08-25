# P2D-A — audit before implementation

Read-only inspection of all 22 areas the brief names, completed before any code
was written. Recorded so the design decisions can be checked against what is
actually in the repository rather than what one might assume.

## Headline finding — a real defect, reproduced

**Seller identity on an ISSUED tax invoice is read live from `Restaurant` at
print time.** Editing the restaurant profile today rewrites yesterday's invoice.

Reproduced with a script, with passing controls:

```
AT ISSUE TIME:            name: Mittho Biryani   pan: 301234567   address: Kalanki, Kathmandu
AFTER A PROFILE EDIT:     name: COMPLETELY       pan: 999999999   address: Somewhere Else
                                DIFFERENT CO
  invoiceNo unchanged     (control) true  INV-KTM-2026-000001
  invoicedTotal unchanged (control) true
  >>> SELLER IDENTITY DRIFTED ON A HISTORICAL TAX INVOICE: true
```

The controls matter: `invoiceNo` and `invoicedTotal` are frozen by Phase 13's
`FROZEN_INVOICE_PATHS`, so the money and the number are safe. What was never
frozen is **who issued it** — legal name, PAN/VAT, address, phone, footer.

For a VAT-registered business in Nepal this is an accounting-integrity problem,
and P2D makes it strictly worse by *encouraging* tenants to edit their identity.
Fixed in this phase (P2D-K) with a focused, immutable snapshot.

Scope note: this is a targeted fix to the invoice path, not a redesign.

## What already exists (reuse, do not rebuild)

| # | Area | Finding | P2D use |
|---|---|---|---|
| 1 | `Restaurant` | already has `name`, `legalName`, `slug`, `timezone`, `currency`, `vatRate`, `phone`, `address`, `pan`, `receiptFooter` | **reuse all of it**; add `branding` only |
| 2 | `Restaurant.settings` | `Mixed`, default `{}`, tenant-writable via `settings.manage` | keep for loose prefs; **never** for entitlements |
| 3/4 | Receipts | `receipts.js` builds a `seller` block; `esc()` escapes `&<>"'/` on every field | reuse; feed it the snapshot |
| 5 | Storefront | tenant resolved from `branchId` via `resolvePublicBranch()` | **reuse**; never trust a restaurant id from the browser |
| 6/7/8 | POS/KDS/Tables | no hardcoded brand strings or colours in these components | only POS header needs tenant name |
| 9/10 | Delivery/notifications | untouched by branding | no change |
| 11/12 | Platform / tenant UI | `Platform.jsx` shell + tab pattern; `main.jsx` state routing | extend, same patterns |
| 13 | Menu presentation | public menu already narrow (no cost/margin leak) | no change |
| 14/15 | Contact / PAN | `resolveSellerPan()` prefers `Branch.pan` then `Restaurant.pan` | preserve that precedence in the snapshot |
| 16 | Timezone | `Restaurant.timezone` exists; receipts hardcode `Asia/Kathmandu` | leave rendering alone this phase |
| 17 | Currency | `Restaurant.currency` used by receipts/storefront | reuse |
| 18 | Env config | `.env`: PORT, MONGODB_URI, JWT_SECRET, CLIENT_URL, APP_ENV, TRUST_PROXY, PAYMENT_MODE | branding is **database-driven**, not env |
| 22 | Entitlements | P2C resolver + `hasFeature()`/`assertFeature()` | **reuse**; add 3 feature keys |

## Hardcoded brand values found

| Location | Value | Action |
|---|---|---|
| `client/src/main.jsx:212` | `MITTHO BIRYANI HOUSE` — the header of **every** tenant's workspace | replace with tenant `displayName` |
| `client/src/main.jsx:195` | sidebar `mittho / OPS · Nepal` | product chrome; keep unless white-label |
| `client/src/main.jsx:245,252` | login brand + demo credentials | product chrome; out of scope |
| `client/src/Storefront.jsx:207` | `<h1>Order online</h1>` | replace with tenant storefront title |
| `client/src/style.css` | **205** hard-coded hex colours, **zero** CSS custom properties | add a variable layer; do not rewrite 205 rules |
| `client/index.html` | no `<title>`, no favicon | leave; per-tenant `<title>` set at runtime |

## What is missing (build)

`Restaurant.branding` subdocument with strict validation; a branding resolver
with safe defaults; typed tenant settings; tenant + platform branding APIs;
3 entitlement feature keys; invoice identity snapshot; storefront/POS wiring;
tenant settings UI with preview.

## Security risks identified

1. **Branding is untrusted tenant input rendered into HTML.** Receipt `esc()`
   already covers `& < > " ' /`. Colours must be `#RRGGBB`-only — a raw CSS
   value permits `expression()`, `url(javascript:)` and style-based exfiltration.
2. **Logo URLs are attacker-controlled.** `javascript:`, `data:` and
   `vbscript:` schemes must be refused; only `https:` (and `http:` in dev).
3. **`Restaurant.settings` is tenant-writable**, so it must never carry plan,
   entitlement or platform data — the P2C rule, restated.
4. **Strict schemas**: an unknown key must 400, not be silently stripped
   (Mongoose `strict:true` drops unknown paths — the P1 finding).
5. **A tenant must not set its own white-label flag.** Entitlement comes from
   the plan, checked server-side; a forged frontend flag must do nothing.
6. **Caching branding caches authority-adjacent data** — needs explicit
   invalidation, same discipline as the P2C entitlement cache.

## Storage (P2D-L) — decision

**No upload architecture exists**: no `multer`, no `express.static`, no
object-storage client anywhere in the repository.

Chosen: **option B — a validated external URL**, behind a
`LogoStorageProvider`-shaped seam so a real uploader can be added later without
touching callers. No S3 credentials invented; no unverified dependency added.

## Custom domains (P2D-M) — decision

Deployment terminates TLS **outside** the stack and there is no DNS or ACME
automation. Therefore: **model and validate the domain, do not pretend to
serve it.** Hostname normalisation, uniqueness, ownership-token generation and
audit are implemented; DNS/TLS provisioning is documented as NOT implemented.

## Migration risk

Existing restaurants have populated `settings` and profile fields. The
migration must be **additive only**: never overwrite a custom value, never
destroy `settings`, idempotent, dry-runnable. Since `branding` is a new
subdocument with defaults, a backfill is likely unnecessary — verified during
implementation rather than assumed.
