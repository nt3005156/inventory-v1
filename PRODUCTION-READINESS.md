# Production readiness audit — Phase 30

**Audited:** commit at the time of writing, Mittho OPS restaurant ERP.
**Method:** static audit of the repository, the full automated suite, and a
live Docker stack driven through Nginx by `scripts/production-audit.mjs`.

Every "verified" below has evidence behind it. Where something is *not*
verified, it says so and explains what is missing. This document exists so a
future operator can tell the difference between "tested" and "believed".

---

## Verdict

**The audited scope is production-ready for a single-instance deployment
behind a TLS terminator.** It is not ready for multi-instance operation, and
three operational preconditions below are unmet by default.

| Gate | Result |
|---|---|
| Backend suite | **2032 pass / 2032**, 463 suites, 0 fail, 0 skipped |
| Frontend suite | **106 pass / 106** |
| Frontend production build | clean (641 kB JS, 164 kB gzip) |
| Docker build + up + ps | all three services **healthy** from a clean volume |
| E2E through Nginx | **50 / 50 checks** |
| DR drill (backup → destroy → restore) | data fully recovered, app healthy afterwards |

---

## Architecture

| Item | Status | Evidence |
|---|---|---|
| Backend | Verified | 121 files / 37,001 lines; every route guarded (see Security) |
| Frontend | Verified | 27 screens / 11,837 lines; builds clean; committed `dist` matches a fresh build byte-for-byte |
| Database | Verified | MongoDB 7 replica set `rs0`, PRIMARY, transactions confirmed working |
| Docker | Verified | 4 services; clean rebuild from empty volume reaches healthy |
| Nginx | Verified | serves SPA, proxies `/api`, upgrades WebSocket, sends security headers, runs unprivileged (uid 101) |
| Realtime | Verified | 9 events through one emit path; `websocket` transport negotiated through Nginx |

**No Redis.** Deliberately excluded — no dependency in either `package.json`,
rate limiting uses an in-process store behind a pluggable factory, and the
Socket.IO adapter is per-instance. Adding it would be an unused service to
secure, back up and monitor. A test asserts it stays absent.

---

## Security

| Item | Status | Evidence |
|---|---|---|
| Authentication | Verified | JWT, HS256 pinned, `exp` mandatory; anonymous → 401 |
| Authorization | Verified | Every route guarded; only `/auth/login` and `/public/*` are open, all rate-limited |
| RBAC | Verified | 72 permissions, `resource.action` enforced, 0 malformed; owner `*`, manager 55, staff 26, rider 2 |
| Tenant isolation | Verified | 45 test files assert cross-tenant refusal; live cross-tenant probe → 404 |
| Rate limiting | Verified | Login (10 / 15 min) + 6 storefront buckets |
| CORS | Verified | Allowlist; wildcard refused in staging/production |
| Input validation | Verified | Zod on every mutating route; `.strict()` schemas reject unknown keys |
| XSS | Verified | No `dangerouslySetInnerHTML`; server-rendered receipt escapes all 20 interpolations |
| Injection | Verified | Operator injection on login refused (live probe); query params cast/validated |
| Secrets | Verified | None hardcoded; `.env` untracked and absent from history; `*_FILE` support for Docker/K8s secrets |

**Verified live:** wrong password and unknown user return byte-identical
responses (no user enumeration); error bodies contain no driver text, stack
frames or container paths.

**Residual risk:** login passes `req.body.email` straight to `findOne`. It is
safe *only* because Mongoose casts the field to `String`, turning `{$ne:null}`
into a CastError. That is an implicit protection, not an explicit one — worth
an explicit guard if the schema ever loosens.

---

## Restaurant operations

All verified live through Nginx against seeded data:

| Module | Result |
|---|---|
| POS | menu, orders, tables, customers — all 200 |
| KDS | queue + board; `pending→accepted→preparing→ready→completed` all 200 |
| Tables | floor plan, 12 tables |
| Delivery | 11 deliveries listed |
| Customers | list + summary |
| Purchasing | POs, suppliers, catalogue (50), supplier invoices |
| Inventory | balances (60), ledger, valuation, batches (68) |
| Suppliers | 16 suppliers with catalogue links |
| Payments | settled to `dueAmount: 0` |
| Refunds | reasonless refund refused (400) |
| Invoices | `INV-KTM-2026-000001` issued sequentially |
| Reports | dashboard, P&L, menu engineering |

---

## Inventory

| Item | Status | Notes |
|---|---|---|
| Ledger | Verified | `moveStock()` is the single write path; 6 model-level guards refuse writes from anywhere else |
| Transactions | Verified | Live sale wrote a `RECIPE_DEDUCTION` row with a negative `changeQty` |
| Counts | Verified | Full lifecycle with approval, covered by tests |
| Approvals | Verified | Submit → approve/reject with expected-version checks |
| Batches | Verified | 68 batches; immutable identity fields |
| Expiry | Verified | Per-restaurant policy: block / warn / allow |
| FEFO | Verified | Default consumption strategy, FIFO selectable |
| Waste | Verified | Categorised, ledger-posted |
| Returns | Verified | Purchase returns with counters |
| Transfers | Verified | Idempotent, two-branch posting |
| Reordering | Verified | Engine + scheduler under a distributed lease |

**Live proof:** a two-portion sale moved stock 81000 → 80700 and produced a
matching ledger row.

---

## Financial

| Item | Status | Notes |
|---|---|---|
| Payments | Verified | Idempotency-keyed; replay returns the original |
| Refunds | Verified | Reason ≥3 chars required; stranded-money check |
| VAT | Verified | Server-computed; live order 587.60 total / 67.60 VAT reconciled |
| Tax invoice | Verified | Sequential per branch/year; immutable once issued |
| Supplier balance | Verified | Statements with ageing |
| Customer balance | N/A | No customer credit/AR feature exists; loyalty points only |
| P&L | Verified | Live endpoint returns reconciled figures |

---

## Testing

| Item | Status | Count |
|---|---|---|
| Unit tests | Verified | Pure-function coverage across services |
| API tests | Verified | 94 backend files, all HTTP-driven |
| Database tests | Verified | All run against a real `MongoMemoryReplSet` |
| Socket tests | Verified | 18 files use a real Socket.IO client |
| RBAC tests | Verified | 78 files assert permission behaviour |
| Tenant isolation tests | Verified | 45 files assert cross-tenant refusal |
| E2E tests | Verified | 50-check gate against the live Docker stack |
| Regression suite | Verified | 2032 tests; no test file is orphaned from the runner |

Mutation testing has been applied every phase; survivors were either
strengthened or documented as equivalent with proof.

---

## Deployment

| Item | Status | Notes |
|---|---|---|
| Docker build | Verified | Clean build; production Vite build runs inside the image |
| Docker startup | Verified | All services healthy from an empty volume |
| Nginx | Verified | Unprivileged, WebSocket upgrade, security headers |
| HTTPS readiness | **Partial** | `trust proxy` + `X-Forwarded-Proto` correct, HSTS gated on `req.secure` + production — but **TLS terminates outside this stack** |
| Environment variables | Verified | Validated at startup; process refuses to boot on a bad config |
| Mongo persistence | Verified | 43 orders survived `down` → `up -d` |
| Backup | Verified | `mongodump` + gzip + oplog, SHA-256 manifest |
| Restore | Verified | Live drill: 1115 documents recovered, API healthy afterwards |
| Health checks | Verified | All three services; `web` waits on `service_healthy` |

---

## Performance

Measured through Nginx against the live stack:

| Endpoint | Time | Payload |
|---|---|---|
| Orders list | 16 ms | 12.8 KB |
| POS menu (100) | 30 ms | 101.5 KB |
| KDS queue | 17 ms | 6.9 KB |
| Dashboard | 46 ms | 0.3 KB |
| P&L | 31 ms | 0.7 KB |
| Inventory balances | 23 ms | 28.9 KB |
| Menu engineering | 24 ms | 37.2 KB |

| Item | Status |
|---|---|
| Indexes | Verified — hot queries use `IXSCAN`, asserted via `explain()` |
| Pagination | Verified — `limit` honoured, hard ceiling enforced |
| Large datasets | Verified — 1,200 orders / 6,000 ledger rows / 1,200 customers |
| Report performance | Verified — all reports under 50 ms |
| API response times | Verified — all endpoints under 50 ms |

---

## Defect found during this audit

**`mongorestore` reported success while restoring nothing.**

Running the DR drill against the containerised MongoDB (tools **100.18.0**, in
`mongo:7`) rather than the test environment (**100.9.4**) exposed it:

```
don't know what to do with file `.../orders.bson.gz`, skipping...
0 document(s) restored successfully.
```

…and **exit code 0** — after `--drop` had already emptied the target. The
identical arguments restored correctly on 100.9.4, so the Phase 27 test suite
was green while production restore was broken.

Cause: `--nsFrom/--nsTo` passed alongside a database-level `--dir`. Fixed to
the version-independent `-d <database>` form. Additionally, the script no
longer treats exit 0 as proof: it parses the restored document count and
**fails loudly** on a skipped file or a zero-document restore after `--drop`.
Verified on both tool versions; covered by tests that hold regardless of which
version is installed.

This is the clearest argument for testing DR against the real deployment
artefact rather than a convenient stand-in.

---

## Audit-chain integrity (P2D.1)

The audit trail is a per-restaurant SHA-256 hash chain. Two integrity defects
were found and fixed in P2D.1; both **predated** the phase that found them.

### 1. False tamper alarms (fixed)

The hash was computed on the pre-write document while MongoDB drops keys whose
value is `undefined`, so any row containing one verified as `content` — the
signature of tampering — when nothing had been altered. Canonicalisation now
hashes what will be stored. `Audit.hashVersion` records which ruleset produced
a hash.

### 2. Duplicate sequence numbers under concurrency (fixed)

30 concurrent writes to one chain produced only 21 distinct sequence numbers:
the stamping lock released before the insert landed, so the next writer re-read
a stale head. Fixed by tracking the in-flight head per chain.

**Still true across instances:** two processes can stamp the same `prevHash`.
Detected as a `link` problem; a database-side counter would be needed to
prevent it.

### Operational procedure

```bash
npm run audit:verify                        # read-only; exit 1 if broken
npm run audit:verify -- --json              # for monitoring
npm run audit:verify -- --restaurant <id>
```

Run it after any restore, before any compliance review, and on a schedule if
audit integrity is being monitored. It never writes.

### Historical rows

Rows written before P2D.1 that carried an `undefined` are **unverifiable** —
the payload that was hashed no longer exists, so no ruleset can reproduce it.
They are reported as `legacy_unverifiable`, not as tampering, and are **not**
repaired: the dropped key names are unrecoverable, so any repair would be
inventing evidence.

Measured on a realistic mixed dataset, **68% of historical rows verify cleanly**
under the new rules; only rows that actually carried an `undefined` are
affected.

**Limitation, stated plainly:** content tampering with one of those specific
legacy rows cannot be detected by its own hash. It could not be detected before
this phase either — the difference is that it is now reported honestly instead
of being buried among false alarms. The chain link still detects insertion,
deletion and re-parenting around them.

### No migration required

The only schema change is an additive, optional `hashVersion`. New writes are
correct from deployment; existing rows are left untouched. Nothing to roll
back.

## Operational preconditions (unmet by default)

These must be handled before taking real orders:

1. **Terminate TLS in front of Nginx.** The stack serves plain HTTP on 8080.
2. **Enable MongoDB authentication.** Mongo runs unauthenticated. Acceptable
   only because the `backend` network is `internal` and the port is never
   published — but `--auth` with a keyfile is the correct posture.
3. **Copy backups off-host and rehearse the restore.** Backups land in a local
   directory; nothing ships them elsewhere, and nothing runs the drill on a
   schedule.

---

## Genuine limitations

- **Single-instance only.** Rate-limit counters, the Socket.IO adapter and the
  realtime replay buffer are per-process. Running two API containers behind a
  load balancer will produce inconsistent rate limiting and missed realtime
  events. Multi-instance needs a shared adapter and store.
- **Single-node replica set.** No failover, election or step-down behaviour has
  ever been exercised.
- **No point-in-time recovery** between backups; worst-case loss is the backup
  interval.
- **No email / SMS / push.** Notification channels are declared and recorded as
  `skipped`; only in-app exists.
- **Riders cannot open the notification centre** — `notifications.mine` is
  self-scoped by design; closing this needs a self-scoped inbox screen.
- **No memory profiling or sustained-load testing.** All timings are
  single-request; no heap analysis was done.
- **No external penetration test, dependency CVE scan or SAST.** The security
  audit is code-and-probe driven.
- **Docker verified on Linux with the Compose plugin only** — not Docker
  Desktop, not Swarm, not Kubernetes.
- **Supplier-invoice-due sweep is manual**, not wired into the scheduler.
- **No CPU/memory limits** on containers; they need a load profile to size.
