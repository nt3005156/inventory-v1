# P2D.1-AUDIT — audit-chain integrity, inspection before implementation

Read-only investigation completed before any code was changed. Every claim
below was produced by a probe script, not by reading alone.

## 1. Where everything lives

| Concern | Location |
|---|---|
| Canonicalisation | `services/auditTrail.js` → `canonicaliseSafe()` |
| Payload assembly | `services/auditTrail.js` → `auditPayload()` |
| Hash | `services/auditTrail.js` → `auditHash(row, prevHash)` = SHA-256(payload ‖ prevHash) |
| Stamping | `installAuditChain()` → injected into `auditSchema.pre('validate')` (models/index.js) |
| Serialisation | `withChainLock(key, task)` — per-restaurant in-process promise queue |
| Verification | `services/auditTrail.js` → `verifyAuditChain({user})`, owner-only, tenant-scoped |
| Startup migration | `services/auditMigration.js` → `ensureAuditIndexes()` (hook install + indexes) |
| Repair tooling | **none exists** |
| Verification script | **none exists** |

**119 audit write call sites across 40 files.**

## 2. The defect, reproduced

`canonicaliseSafe()` line 1: `if (value === null || value === undefined) return null;`

The hash is computed on the **pre-write Mongoose document**, inside
`pre('validate')`. MongoDB then **omits keys whose value is `undefined`** when
the document is persisted. Verification later re-reads the stored row, whose
`before`/`after` no longer contain those keys, and recomputes a different hash.

```
hash stamped at write : 69c37432a8ba3eb9
hash recomputed stored: 8dee8272f80920d8
MATCH: false
stored before keys    : [ 'name', 'pan' ]      // slug, legalName were DROPPED
```

`verifyAuditChain()` reports this as `type: 'content'` — the signature of a
**tampered row**. Nothing was tampered with. It is a **false positive**, and a
tamper-evidence mechanism that cries wolf is worse than none, because
investigators learn to ignore it.

### A second, independent defect in the same line

`undefined` and an explicit `null` both canonicalise to `null`:

```
undefined        {"a":null}
explicit null    {"a":null}
missing key      {}
```

So "this field was not supplied" and "this field was explicitly cleared" hash
**identically**. The brief names this exactly: *"Do NOT silently convert
undefined to null if that makes two semantically different values hash
identically."* It does, today.

## 3. Representation matrix (current behaviour)

| Input | Canonical form | Deterministic? |
|---|---|---|
| `undefined` | `null` | yes, but **collides with null** |
| explicit `null` | `null` | yes |
| missing key | absent | yes |
| nested `undefined` | `{"b":null}` | collides |
| array with `undefined` | `[1,null,3]` | order preserved ✓ |
| `Date` | ISO-8601 string | yes |
| `ObjectId` | 24-char hex string | yes |
| number / float / bool / string | as-is | yes |
| key ordering | sorted | yes ✓ |
| cycles | `'[circular]'` | yes ✓ |
| depth > 12 | `'[depth]'` | yes ✓ |

Key ordering, arrays, dates, ObjectIds, cycles and depth are already correct.
**Only the undefined/null conflation is wrong.**

## 4. Blast radius

A static survey of the 99 audit writes that carry `before`/`after`:

```
audit writes with before/after: 99
writes with an UNCOERCED property read (can be undefined): 95
```

**95 of 99.** This is systemic. Fixing 95 call sites individually would be a
large, error-prone change that leaves the trap armed for writer number 100. The
fix belongs in the canonicaliser.

## 5. Can historical rows be repaired? **No.**

The decisive probe: two *different* pre-write objects store *identically*.

```
row A stored before: {"name":"X"}     // pre-write had slug: undefined
row B stored before: {"name":"X"}     // pre-write had slug, legalName, pan: undefined
stored shapes identical: true
but hashes differ     : true
```

The stored row carries **no record of which keys were dropped, or what they
were called**. Reconstructing the pre-write object would require guessing both
the number *and the names* of absent keys — an unbounded search, not a `2^n`
one. Any "repair" would be **inventing evidence**, which the brief forbids
absolutely.

### Decision

**No repair tool will be written.** Per the brief: *"If repair is not safely
possible, DO NOT create a repair mechanism just for the sake of having one."*

Historical rows are classified and reported instead:

- **A — valid:** hash verifies. Untouched.
- **B — repairable:** *(empty set — proven impossible above)*
- **C — legacy-canonicalisation:** hash fails, but the row is structurally
  intact and consistent with the known pre-fix defect. Reported as
  `legacy_canonicalisation`, **not** as tampering.
- **D — malformed:** missing `hash`/`sequence`, or a broken `prevHash` link.
  Genuine integrity concern; reported loudly.

Distinguishing C from D is the substantive deliverable: it converts an
undifferentiated "chain broken" into "these rows predate the fix" versus
"these rows need a human".

## 6. Concurrency

`withChainLock()` serialises writes per restaurant through an in-process
promise chain. Correct within one process. Across processes two rows can share
a `prevHash`; `verifyAuditChain()` already detects that as a `link` problem and
the existing code documents it. **No change** — the brief says preserve what
already serialises correctly.

## 7. Tenant isolation (current state)

- `verifyAuditChain()` scopes to `userRestaurantContext(user)` and is
  **owner-only**. No `restaurantId` parameter exists, so a tenant cannot aim it
  at another restaurant.
- Platform audit (`/api/platform/audit`) is guarded by
  `platform.audit.view` and whitelisted to platform actions.
- No HTTP endpoint exposes cross-tenant chain verification. The new script must
  stay **CLI-only** for the same reason.

## 8. Existing tests

4 audit test files; 15 assertions touch the chain. None asserts canonicalisation
of `undefined`, key ordering, or stored-vs-computed hash equality. That gap is
why the defect survived to P2D.

## 9. Plan (bounded)

1. Extract canonicalisation into `services/auditCanonical.js`, used by
   creation, verification and tooling — one implementation, no duplicates.
2. Represent `undefined` distinctly from `null`, and **strip undefined keys
   before hashing** so the hashed shape equals the stored shape.
3. Version the format (`hashVersion`) so pre-fix rows are identifiable rather
   than indistinguishable from tampering.
4. `scripts/verify-audit-chain.js` — read-only, JSON output, non-zero exit.
5. No repair tool. A documented remediation policy instead.
6. Tests + mutation tests asserting stored state, not HTTP responses.


---

# IMPLEMENTATION OUTCOME

## The fix

`services/auditCanonical.js` — one canonicaliser, shared by creation,
verification and tooling.

**Contract: hash what will be STORED, not what was passed in.** A key whose
value is `undefined` will not exist after the write, so it is dropped before
hashing. The hashed shape then equals the stored shape by construction.

| Input | v1 (broken) | v2 (fixed) |
|---|---|---|
| `{a: undefined}` | `{"a":null}` | `{}` |
| `{a: null}` | `{"a":null}` | `{"a":null}` |
| `{}` | `{}` | `{}` |
| `[1, undefined, 3]` | `[1,null,3]` | `[1,null,3]` |

`undefined` and explicit `null` no longer collide. `{a: undefined}` and `{}`
*do* collapse together — correct, because MongoDB stores them identically.

Arrays keep `undefined` as `null`: dropping an element would shift every later
index, which is the same class of bug in a different place.

`Date`, `ObjectId`, key ordering, cycles and depth were already correct and are
unchanged. Added: invalid dates → `[invalid-date]`, non-finite numbers →
`[number:NaN]` etc., so neither silently becomes `null`.

## A second defect, found and fixed: a duplicate-sequence race

Discovered by the concurrency test, and **confirmed pre-existing** — the probe
gives identical results on `57c5ec4`.

```
sequential : 10 rows, 10 distinct sequences   OK
concurrent : 10 rows,  9 distinct sequences   BROKEN  (1,1,2,3,4,…)
30 concurrent writes -> only 21 distinct sequences
```

`withChainLock()` serialises *stamping*, but the hook is `pre('validate')` and
the **insert lands after the lock is released**, so the next writer re-read a
`chainHead()` that had not advanced.

Bounded fix: `pendingHeads` remembers the head this process just stamped and
prefers it when it is ahead of the database. The stored head always wins when
it is further along, so a stale entry cannot drag the sequence backwards.
Cross-instance behaviour is unchanged and still reported as a `link` problem.

## Historical rows — classification, no repair

Four classes, per the brief:

| Class | Meaning | Action |
|---|---|---|
| **A — valid** | hash verifies | none |
| **B — repairable** | **empty set, proven** | none possible |
| **C — legacy** | `legacy_canonicalisation` (verifies under v1) or `legacy_unverifiable` (v1 row whose hashed payload MongoDB discarded) | reported, not repaired |
| **D — malformed** | no hash or no sequence | reported loudly |

**No repair tool was written.** Two different pre-write objects store
identically, and the dropped key *names* are unrecoverable, so reconstruction
would mean inventing evidence.

A refinement found during implementation: a v1 row that carried an `undefined`
cannot be verified under *either* ruleset, because the payload that was hashed
no longer exists anywhere. Those are `legacy_unverifiable` — honest, and
distinct from tampering. A row that **declares v2** gets no such excuse.

Dry run against a realistic mixed dataset (88 rows):

```
valid                      60      (68% verify cleanly under v2)
legacy_unverifiable        25      (only rows that carried an undefined)
malformed                   3
content                     0
```

**Only rows that actually contained an `undefined` are affected.** The rest of
the historical chain verifies normally.

## Production migration policy

**No migration is required, and none is offered.**

- New writes are correct from deployment onward — no backfill needed.
- Historical rows are left untouched. Rewriting them would destroy the
  evidence the chain exists to provide.
- `verified` excludes the legacy classes, so a deployment with pre-P2D.1
  history reports **INTEGRITY OK** rather than a permanent false breach, while
  still surfacing the counts.

**Safe to deploy. No manual review required. Nothing to roll back** — the only
schema change is an additive, optional `hashVersion`.

## Honest limitation

Content tampering with a **pre-P2D.1 row that carried an `undefined`** is not
detectable by that row's own hash, because the original payload is gone. Such a
row was *already* unverifiable before this phase; the difference is that it is
now reported accurately instead of as a false tamper alarm. The chain **link**
still detects insertion, deletion and re-parenting around those rows, which is
asserted by tests.
