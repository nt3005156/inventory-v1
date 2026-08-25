import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, User} from '../src/models/index.js';
import {Branch, Restaurant} from '../src/models/operations.js';
import {
  AUDIT_HASH_VERSION, auditPayloadForVersion, canonicalAuditPayload, canonicaliseValue,
  legacyAuditPayloadV1
} from '../src/services/auditCanonical.js';
import {auditHash, auditPayload, classifyAuditRow, verifyAuditChain} from '../src/services/auditTrail.js';

/**
 * P2D.1 — audit-chain integrity.
 *
 * The defect this phase fixes: the hash was computed on the PRE-WRITE document
 * while MongoDB then dropped `undefined` keys, so any row containing one
 * verified as `content` — the signature of tampering — when nothing had been
 * altered. Separately, `undefined` and an explicit `null` hashed identically,
 * making "not supplied" and "explicitly cleared" indistinguishable.
 *
 * These tests assert the STORED state and the recomputed hash, never an HTTP
 * status. A 200 proves nothing about a hash chain.
 */

let world;
let rival;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

beforeEach(async () => {
  await clearDb();
  world = await seedWorld();
  const restaurant = await Restaurant.create({
    name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR', status: 'active'
  });
  const branch = await Branch.create({restaurant: restaurant._id, name: 'Rival', code: 'RVL'});
  const rivalOwner = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: restaurant._id
  });
  rival = {restaurant, branch, owner: rivalOwner};
});

/** Recompute a stored row's hash under the rules it declares. */
const recompute = row => auditHash(row, row.prevHash, Number(row.hashVersion) || 1);

// ── 1. the defect, and its fix ───────────────────────────────────────────────

describe('P2D.1 · the reproduced defect is fixed', () => {
  it('hashes what will be STORED, so an undefined key no longer breaks the chain', async () => {
    /**
     * The exact minimal fixture from the audit. Before the fix:
     *   write hash 69c37432…  stored hash 8dee8272…  MATCH: false
     */
    const written = await Audit.create({
      entity: 'restaurant', entityId: world.restaurant._id, restaurant: world.restaurant._id,
      action: 'probe',
      before: {name: 'X', slug: undefined, legalName: undefined, pan: '111'},
      after: {name: 'Y'}
    });

    const stored = await Audit.findById(written._id).lean();
    // MongoDB really did drop the undefined keys — the precondition still holds.
    assert.deepEqual(Object.keys(stored.before).sort(), ['name', 'pan']);
    // ...and the hash still verifies, which is the fix.
    assert.equal(recompute(stored), written.hash);
    assert.equal(classifyAuditRow(stored), null);
  });

  it('stamps the canonicalisation version on every new row', async () => {
    const written = await Audit.create({
      entity: 'x', restaurant: world.restaurant._id, action: 'probe', after: {a: 1}
    });
    const stored = await Audit.findById(written._id).lean();
    assert.equal(stored.hashVersion, AUDIT_HASH_VERSION);
    assert.equal(AUDIT_HASH_VERSION, 2);
  });

  it('survives a round trip through MongoDB for every awkward shape', async () => {
    const shapes = [
      {label: 'undefined leaf', before: {a: undefined, b: 1}},
      {label: 'nested undefined', before: {a: {b: undefined, c: 2}}},
      {label: 'deeply nested', before: {a: {b: {c: {d: undefined, e: 'x'}}}}},
      {label: 'array with undefined', before: {a: [1, undefined, 3]}},
      {label: 'explicit null', before: {a: null}},
      {label: 'empty object', before: {}},
      {label: 'date', before: {a: new Date('2026-01-01T00:00:00Z')}},
      {label: 'objectid', before: {a: new mongoose.Types.ObjectId()}},
      {label: 'mixed', before: {s: 'x', n: 42, f: 1.5, b: true, z: null, u: undefined}}
    ];
    for (const shape of shapes) {
      const written = await Audit.create({
        entity: 'roundtrip', restaurant: world.restaurant._id, action: 'probe',
        before: shape.before, after: {ok: true}
      });
      const stored = await Audit.findById(written._id).lean();
      assert.equal(recompute(stored), written.hash, `${shape.label} did not survive the round trip`);
      assert.equal(classifyAuditRow(stored), null, `${shape.label} was classified as a problem`);
    }
  });

  it('keeps the whole chain verifiable across many undefined-bearing writes', async () => {
    for (let i = 0; i < 25; i += 1) {
      await Audit.create({
        entity: 'bulk', restaurant: world.restaurant._id, action: 'probe',
        before: {i, maybe: i % 2 ? undefined : 'set', nested: {x: i % 3 ? undefined : i}},
        after: {i}
      });
    }
    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
    assert.equal(result.counts.content, 0);
    assert.equal(result.counts.legacy, 0);
    assert.equal(result.counts.valid, 25);
  });
});

// ── 2. the canonical contract ────────────────────────────────────────────────

describe('P2D.1 · canonical serialisation contract', () => {
  const c = value => JSON.stringify(canonicaliseValue(value));

  it('does NOT conflate undefined with an explicit null', () => {
    // The brief's explicit prohibition. Before the fix both were {"a":null}.
    assert.notEqual(c({a: undefined}), c({a: null}));
    assert.equal(c({a: undefined}), '{}');
    assert.equal(c({a: null}), '{"a":null}');
  });

  it('treats an undefined key and a missing key as identical — deliberately', () => {
    /**
     * These are NOT semantically different once stored: MongoDB cannot
     * represent a key whose value is undefined, so both produce the same
     * document. Hashing them identically is the correct, honest choice; the
     * collision the brief warns about is undefined-vs-null, asserted above.
     */
    assert.equal(c({a: undefined, b: 1}), c({b: 1}));
  });

  it('is stable under key ordering', () => {
    assert.equal(c({a: 1, b: 2, c: 3}), c({c: 3, b: 2, a: 1}));
    assert.equal(c({z: {y: 1, x: 2}}), c({z: {x: 2, y: 1}}));
  });

  it('preserves array order and positions', () => {
    assert.equal(c([1, 2, 3]), '[1,2,3]');
    assert.notEqual(c([1, 2, 3]), c([3, 2, 1]));
    // An undefined ELEMENT stays as null: dropping it would shift every index.
    assert.equal(c([1, undefined, 3]), '[1,null,3]');
    assert.notEqual(c([1, undefined, 3]), c([1, 3]));
  });

  it('is deterministic for dates, including invalid ones', () => {
    assert.equal(c(new Date('2026-01-01T00:00:00Z')), '"2026-01-01T00:00:00.000Z"');
    assert.equal(c(new Date('2026-01-01T00:00:00Z')), c(new Date('2026-01-01T00:00:00.000Z')));
    // An invalid date must not hash as the literal text "Invalid Date", which a
    // user could type.
    assert.equal(c(new Date('nonsense')), '"[invalid-date]"');
  });

  it('is deterministic for ObjectIds', () => {
    const id = new mongoose.Types.ObjectId();
    assert.equal(c(id), JSON.stringify(String(id)));
    assert.equal(c(id), c(new mongoose.Types.ObjectId(String(id))));
  });

  it('names non-finite numbers instead of letting JSON turn them into null', () => {
    assert.equal(c(NaN), '"[number:NaN]"');
    assert.equal(c(Infinity), '"[number:Infinity]"');
    assert.equal(c(-Infinity), '"[number:-Infinity]"');
    // ...and they must not collide with a real null.
    assert.notEqual(c(NaN), c(null));
  });

  it('handles numbers, booleans and strings unchanged', () => {
    assert.equal(c(42), '42');
    assert.equal(c(1.5), '1.5');
    assert.equal(c(true), 'true');
    assert.equal(c('x'), '"x"');
    // Types must not collide.
    assert.notEqual(c(1), c('1'));
    assert.notEqual(c(true), c('true'));
  });

  it('breaks cycles and caps depth without throwing', () => {
    const cyclic = {name: 'x'};
    cyclic.self = cyclic;
    assert.match(c(cyclic), /circular/);

    let deep = {v: 'bottom'};
    for (let i = 0; i < 40; i += 1) deep = {nested: deep};
    assert.match(c(deep), /depth/);
  });

  it('ignores Mongoose and BSON internals', () => {
    assert.equal(c({a: 1, $__: 'internal', __v: 3, __index: 0}), '{"a":1}');
  });

  it('produces byte-identical payloads for a document and its plain object', async () => {
    const doc = await Audit.create({
      entity: 'x', restaurant: world.restaurant._id, action: 'probe', after: {a: 1}
    });
    const lean = await Audit.findById(doc._id).lean();
    assert.equal(canonicalAuditPayload(doc), canonicalAuditPayload(lean));
  });
});

// ── 3. one implementation, shared ────────────────────────────────────────────

describe('P2D.1 · creation, verification and tooling share one canonicaliser', () => {
  it('exposes the same function through auditTrail as auditCanonical', () => {
    const row = {entity: 'e', action: 'a', before: {x: undefined, y: 1}, after: null};
    assert.equal(auditPayload(row), canonicalAuditPayload(row));
  });

  it('dispatches to the version a row declares', () => {
    const row = {entity: 'e', action: 'a', before: {x: undefined, y: 1}, after: null};
    assert.equal(auditPayloadForVersion(row, 2), canonicalAuditPayload(row));
    assert.equal(auditPayloadForVersion(row, 1), legacyAuditPayloadV1(row));
    // Absent/0 means v1 — the pre-P2D.1 default.
    assert.equal(auditPayloadForVersion(row, undefined), legacyAuditPayloadV1(row));
  });

  it('keeps v1 and v2 genuinely different for an undefined-bearing row', () => {
    const row = {entity: 'e', action: 'a', before: {x: undefined, y: 1}, after: null};
    assert.notEqual(legacyAuditPayloadV1(row), canonicalAuditPayload(row));
    // v1 emitted the key as null; v2 omits it.
    assert.match(legacyAuditPayloadV1(row), /"x":null/);
    assert.ok(!canonicalAuditPayload(row).includes('"x"'));
  });

  it('agrees with v1 when there is no undefined anywhere', () => {
    // The two formats must only diverge on the case that was broken.
    const row = {entity: 'e', action: 'a', before: {y: 1, z: null}, after: {q: [1, 2]}};
    assert.equal(legacyAuditPayloadV1(row), canonicalAuditPayload(row));
  });
});

// ── 4. classification of historical rows ─────────────────────────────────────

describe('P2D.1 · legacy rows are classified, not called tampering', () => {
  /** Write a row exactly as the pre-P2D.1 code would have. */
  async function writeLegacyRow({tamper = false} = {}) {
    const base = {
      entity: 'restaurant', entityId: world.restaurant._id, restaurant: world.restaurant._id,
      action: 'legacy_probe',
      before: {name: 'X', slug: undefined, pan: '111'},
      after: {name: 'Y'},
      at: new Date(), sequence: 1, prevHash: null
    };
    // v1 hash over the PRE-WRITE object, as the old code did.
    const hash = auditHash(base, null, 1);
    const stored = {
      ...base,
      before: {name: 'X', pan: '111'},      // as MongoDB stored it
      hash: tamper ? hash.replace(/^./, hash[0] === 'a' ? 'b' : 'a') : hash
      // hashVersion deliberately absent — a pre-P2D.1 row has none.
    };
    const inserted = await mongoose.connection.db.collection('audits').insertOne(stored);
    return Audit.findById(inserted.insertedId).lean();
  }

  it('reports an undefined-bearing legacy row as legacy_unverifiable', async () => {
    /**
     * PROVEN, not assumed. My first expectation here was
     * `legacy_canonicalisation` — i.e. that a v1 row could be re-verified
     * under v1. It cannot: the v1 hash covered `{"before":{…,"slug":null}}`
     * while MongoDB stored only `{"name":"X","pan":"111"}`. Neither ruleset
     * reproduces the hash, because the payload that was hashed no longer
     * exists anywhere. That is precisely why these rows are unrepairable.
     */
    const row = await writeLegacyRow();
    const problem = classifyAuditRow(row);
    assert.ok(problem, 'a legacy row should be reported');
    assert.equal(problem.type, 'legacy_unverifiable');
    assert.match(problem.detail, /cannot be reconstructed/);
  });

  it('verifies an INTACT v1 row cleanly — most history is unaffected', async () => {
    /**
     * The control for the test above, and a better result than I first
     * expected: when a v1 row contains no `undefined`, the v1 and v2 payloads
     * are byte-identical, so the row verifies as fully VALID rather than
     * needing the legacy class at all.
     *
     * That is the important scope finding: only rows that actually carried an
     * `undefined` are affected. The rest of the historical chain verifies
     * normally under the new rules.
     */
    const base = {
      entity: 'restaurant', restaurant: world.restaurant._id, action: 'clean_legacy',
      before: {name: 'X'}, after: {name: 'Y'}, at: new Date(), sequence: 1, prevHash: null
    };
    const inserted = await mongoose.connection.db.collection('audits').insertOne({
      ...base, hash: auditHash(base, null, 1)
    });
    const row = await Audit.findById(inserted.insertedId).lean();
    assert.equal(classifyAuditRow(row), null,
      'a clean v1 row should verify without needing the legacy class');
  });

  it('does NOT excuse a tampered row that declares v2', async () => {
    /**
     * The loophole to close: `legacy_unverifiable` must apply only to rows
     * with no version. A row written after the fix has no excuse, because the
     * hashed shape equals the stored shape by construction.
     */
    const written = await Audit.create({
      entity: 'x', restaurant: world.restaurant._id, action: 'v2row', after: {amount: 1}
    });
    await mongoose.connection.db.collection('audits').updateOne(
      {_id: written._id}, {$set: {'after.amount': 999999}});
    const row = await Audit.findById(written._id).lean();
    assert.equal(row.hashVersion, 2);
    assert.equal(classifyAuditRow(row).type, 'content',
      'a tampered v2 row was excused as legacy');
  });

  it('catches tampering with an unversioned row through the chain LINK', async () => {
    /**
     * An unversioned row's own hash cannot be verified, so content tampering
     * on it is genuinely undetectable — an honest limitation, documented.
     * What IS still detected is any change to the CHAIN: the next row's
     * prevHash no longer matches.
     */
    const first = await writeLegacyRow({tamper: true});
    // A properly chained successor pointing at the ORIGINAL hash.
    await mongoose.connection.db.collection('audits').insertOne({
      entity: 'x', restaurant: world.restaurant._id, action: 'successor',
      after: {a: 1}, at: new Date(), sequence: 2,
      prevHash: 'a'.repeat(64), hash: 'b'.repeat(64), hashVersion: 2
    });
    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, false, 'a broken link after a legacy row went undetected');
    assert.ok(result.problems.some(p => p.type === 'link' || p.type === 'content'));
  });

  it('does not let legacy rows fail overall verification', async () => {
    await writeLegacyRow();
    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    // Intact-but-old must not read as a breach, or the alarm becomes noise...
    assert.equal(result.verified, true);
    // ...but it must still be visible.
    assert.equal(result.legacyCanonicalisation, 1);
    assert.equal(result.counts.legacy, 1);
  });

  it('DOES fail verification for a genuinely tampered v2 row', async () => {
    const written = await Audit.create({
      entity: 'x', restaurant: world.restaurant._id, action: 'tamper_me', after: {amount: 1}
    });
    await mongoose.connection.db.collection('audits').updateOne(
      {_id: written._id}, {$set: {'after.amount': 999999}});
    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, false);
    assert.ok(result.problems.some(p => p.type === 'content'));
  });

  it('reports a row with no hash or no sequence as malformed', async () => {
    await mongoose.connection.db.collection('audits').insertOne({
      entity: 'x', restaurant: world.restaurant._id, action: 'nohash', at: new Date(), sequence: 1
    });
    const row = await Audit.findOne({action: 'nohash'}).lean();
    assert.equal(classifyAuditRow(row).type, 'malformed');
  });
});

// ── 5. tamper detection (the actual guarantee) ───────────────────────────────

describe('P2D.1 · tampering with a stored row is detected', () => {
  async function seedChain(n = 4) {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      const row = await Audit.create({
        entity: 'order', entityId: new mongoose.Types.ObjectId(),
        restaurant: world.restaurant._id, action: 'payment',
        before: {status: 'pending'}, after: {status: 'paid', amount: 100 + i},
        userName: 'Cashier', reason: `sale ${i}`
      });
      ids.push(row._id);
    }
    return ids;
  }

  const verify = () => verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});

  it('is clean before tampering — the control', async () => {
    await seedChain();
    const result = await verify();
    assert.equal(result.verified, true, JSON.stringify(result.problems));
  });

  /**
   * Each of these edits the STORED document directly, bypassing Mongoose's
   * append-only hooks exactly as an attacker with database access would. The
   * assertion is on the recomputed hash, not on any HTTP response.
   */
  const tampers = [
    {field: 'after', mutate: {$set: {'after.amount': 999999}}},
    {field: 'before', mutate: {$set: {'before.status': 'refunded'}}},
    {field: 'user identity', mutate: {$set: {userName: 'Somebody Else'}}},
    {field: 'reason', mutate: {$set: {reason: 'rewritten reason'}}},
    {field: 'timestamp', mutate: {$set: {at: new Date('2020-01-01')}}},
    {field: 'action', mutate: {$set: {action: 'refund'}}},
    {field: 'entity', mutate: {$set: {entity: 'ghost'}}}
  ];

  for (const {field, mutate} of tampers) {
    it(`detects a rewritten ${field}`, async () => {
      const ids = await seedChain();
      await mongoose.connection.db.collection('audits').updateOne({_id: ids[1]}, mutate);
      const result = await verify();
      assert.equal(result.verified, false, `tampering with ${field} went undetected`);
      assert.ok(result.problems.some(p => p.type === 'content' && p.id === String(ids[1])),
        `${field} tampering was not attributed to the right row`);
    });
  }

  it('detects a rewritten hash', async () => {
    const ids = await seedChain();
    await mongoose.connection.db.collection('audits').updateOne(
      {_id: ids[1]}, {$set: {hash: 'f'.repeat(64)}});
    const result = await verify();
    assert.equal(result.verified, false);
  });

  it('detects a rewritten prevHash — a broken link', async () => {
    const ids = await seedChain();
    await mongoose.connection.db.collection('audits').updateOne(
      {_id: ids[2]}, {$set: {prevHash: '0'.repeat(64)}});
    const result = await verify();
    assert.equal(result.verified, false);
    assert.ok(result.problems.some(p => p.type === 'link' || p.type === 'content'));
  });

  it('detects a DELETED row through the sequence gap', async () => {
    const ids = await seedChain(5);
    await mongoose.connection.db.collection('audits').deleteOne({_id: ids[2]});
    const result = await verify();
    assert.equal(result.verified, false);
    assert.ok(result.problems.some(p => p.type === 'sequence' || p.type === 'link'));
  });

  it('detects an INSERTED row that was never chained', async () => {
    await seedChain(3);
    await mongoose.connection.db.collection('audits').insertOne({
      entity: 'order', restaurant: world.restaurant._id, action: 'forged_payment',
      after: {amount: 1}, at: new Date(), sequence: 2,
      prevHash: '0'.repeat(64), hash: '1'.repeat(64), hashVersion: 2
    });
    const result = await verify();
    assert.equal(result.verified, false);
  });

  it('still refuses rewrites through Mongoose — the append-only guarantee', async () => {
    const ids = await seedChain(1);
    await assert.rejects(
      () => Audit.updateOne({_id: ids[0]}, {$set: {reason: 'x'}}), /append-only/);
    await assert.rejects(() => Audit.deleteOne({_id: ids[0]}), /append-only/);
  });
});

// ── 6. tenant isolation ──────────────────────────────────────────────────────

describe('P2D.1 · verification is tenant-isolated', () => {
  beforeEach(async () => {
    await Audit.create({
      entity: 'secret', restaurant: rival.restaurant._id, action: 'rival_only',
      after: {confidential: 'rival data'}
    });
    await Audit.create({
      entity: 'mine', restaurant: world.restaurant._id, action: 'mine_only', after: {a: 1}
    });
  });

  it('verifies only the caller\'s own chain', async () => {
    const mine = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(mine.checked, 1, 'another tenant\'s rows were included');
    const theirs = await verifyAuditChain({user: {id: String(rival.owner._id), role: 'owner'}});
    assert.equal(theirs.checked, 1);
  });

  it('offers no restaurantId parameter that could aim it elsewhere', async () => {
    // Even if a caller invents one, the tenant comes from the principal.
    const result = await verifyAuditChain({
      user: {id: String(world.owner._id), role: 'owner', restaurantId: String(rival.restaurant._id)}
    });
    assert.equal(result.checked, 1);
    const rows = await Audit.find({restaurant: world.restaurant._id}).lean();
    assert.equal(result.checked, rows.length);
  });

  it('refuses a non-owner', async () => {
    await assert.rejects(
      () => verifyAuditChain({user: {id: String(world.manager._id), role: 'manager'}}),
      /Only an owner/
    );
  });

  it('exposes no HTTP endpoint for cross-tenant verification', async () => {
    // The tenant endpoint must not accept a restaurant selector.
    const res = await request(
      `/api/audit/verify?restaurant=${rival.restaurant._id}`, {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.checked, 1, 'a query parameter widened the scope');

    // And a manager cannot reach it at all.
    const denied = await request('/api/audit/verify', {token: manager()});
    assert.equal(denied.status, 403);
  });

  it('never leaks another tenant\'s audit content through the tenant search', async () => {
    const res = await request('/api/audit', {token: owner()});
    assert.equal(res.status, 200);
    const blob = JSON.stringify(res.body);
    assert.ok(!blob.includes('rival data'), 'cross-tenant audit content leaked');
    assert.ok(!blob.includes('rival_only'));
  });
});

// ── 7. concurrency ───────────────────────────────────────────────────────────

describe('P2D.1 · concurrent writes keep the chain intact', () => {
  it('produces no duplicate sequence and no broken link under parallel writes', async () => {
    /**
     * `withChainLock()` serialises per restaurant through an in-process promise
     * queue. This asserts the property it exists to provide, rather than
     * assuming it: 30 concurrent writes must yield 30 consecutive sequences and
     * a chain that verifies.
     */
    await Promise.all(Array.from({length: 30}, (_, i) => Audit.create({
      entity: 'concurrent', restaurant: world.restaurant._id, action: 'race',
      after: {i}, before: {maybe: i % 2 ? undefined : i}
    })));

    const rows = await Audit.find({restaurant: world.restaurant._id})
      .sort({sequence: 1}).lean();
    assert.equal(rows.length, 30);

    const sequences = rows.map(r => r.sequence);
    assert.equal(new Set(sequences).size, 30, 'duplicate sequence numbers were issued');
    for (let i = 0; i < rows.length; i += 1) {
      assert.equal(sequences[i], i + 1, 'sequence numbers are not consecutive');
      if (i > 0) {
        assert.equal(rows[i].prevHash, rows[i - 1].hash, `link broken at sequence ${i + 1}`);
      }
    }

    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
  });

  it('keeps two tenants\' chains independent under interleaved writes', async () => {
    await Promise.all([
      ...Array.from({length: 10}, (_, i) => Audit.create({
        entity: 'a', restaurant: world.restaurant._id, action: 'x', after: {i}
      })),
      ...Array.from({length: 10}, (_, i) => Audit.create({
        entity: 'b', restaurant: rival.restaurant._id, action: 'x', after: {i}
      }))
    ]);
    for (const [label, id, user] of [
      ['mine', world.restaurant._id, world.owner], ['rival', rival.restaurant._id, rival.owner]
    ]) {
      const rows = await Audit.find({restaurant: id}).sort({sequence: 1}).lean();
      assert.deepEqual(rows.map(r => r.sequence), Array.from({length: 10}, (_, i) => i + 1),
        `${label} chain has gaps`);
      const result = await verifyAuditChain({user: {id: String(user._id), role: 'owner'}});
      assert.equal(result.verified, true, `${label}: ${JSON.stringify(result.problems)}`);
    }
  });
});

// ── 8. real writers, end to end ──────────────────────────────────────────────

describe('P2D.1 · real application writers keep the chain verifiable', () => {
  it('stays verifiable across branding, settings and account operations', async () => {
    const {updateBranding, updateSettings} = await import('../src/services/brandingAdmin.js');
    const user = {id: String(world.owner._id), role: 'owner'};

    await updateBranding({user, patch: {displayName: 'Chain Test', primaryColor: '#aa0000'}});
    await updateSettings({user, patch: {kds: {ticketColumns: 5}}});
    await request('/api/my/restaurant', {
      method: 'PATCH', token: owner(), body: {phone: '01-5551234'}
    });

    const result = await verifyAuditChain({user});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
    assert.equal(result.counts.legacy, 0, 'a new write used the legacy canonicalisation');
    assert.ok(result.checked >= 3);
  });

  it('keeps the platform tenant-update writer verifiable — the P2D finding', async () => {
    /**
     * `tenantAdmin.updateRestaurant()` builds `before` from restaurant fields
     * that are frequently undefined (`slug`, `legalName`). That is the exact
     * writer whose rows failed verification in P2D. It must now pass without
     * the writer itself being changed — the fix is in the canonicaliser.
     */
    const {updateRestaurant} = await import('../src/services/tenantAdmin.js');
    const admin = await User.create({
      name: 'Platform Admin', email: 'padmin@saas.test', password: 'x',
      role: 'owner', platformRole: 'super_admin'
    });
    await updateRestaurant({
      user: {id: String(admin._id)}, restaurantId: String(world.restaurant._id),
      input: {name: 'Renamed', legalName: 'New Legal Ltd', pan: '999999999'},
      viaPlatform: true
    });

    const row = await Audit.findOne({action: 'platform_restaurant_updated'}).lean();
    assert.ok(row);
    assert.equal(row.hashVersion, AUDIT_HASH_VERSION);
    assert.equal(classifyAuditRow(row), null, 'the P2D-reported row still fails verification');

    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
  });

  it('records the version on rows written through recordAudit()', async () => {
    const {recordAudit} = await import('../src/services/auditTrail.js');
    await recordAudit({
      user: {id: String(world.owner._id), name: 'Owner'},
      entity: 'test', action: 'probe',
      restaurant: world.restaurant._id,
      before: {a: undefined, b: 1}, after: {a: 2}
    });
    const row = await Audit.findOne({action: 'probe'}).lean();
    assert.equal(row.hashVersion, AUDIT_HASH_VERSION);
    assert.equal(classifyAuditRow(row), null);
  });
});

// ── 9. chain LINKAGE, isolated (mutation-driven) ─────────────────────────────

describe('P2D.1 · chain linkage is detected on its own merits', () => {
  /**
   * WHY THIS BLOCK EXISTS — a mutation finding.
   *
   * Three mutants survived the first run:
   *   M9  stop chaining to prevHash entirely
   *   M12 stop detecting broken links
   *   M13 stop detecting sequence gaps
   *
   * None was a hole, but all three were REAL TEST GAPS. My tamper assertions
   * were disjunctions — `p.type === 'link' || p.type === 'content'` — so the
   * still-working content check satisfied them and the link/sequence checks
   * were never actually exercised. These assert each detector alone, with the
   * row's own hash left INTACT so `content` cannot mask the result.
   */
  const verify = () => verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});

  /** A correctly chained row whose own hash verifies, inserted directly. */
  async function appendValidRow({sequence, prevHash, action = 'linked'}) {
    const base = {
      entity: 'link', restaurant: world.restaurant._id, action,
      before: null, after: {seq: sequence}, at: new Date(), sequence, prevHash,
      hashVersion: AUDIT_HASH_VERSION
    };
    const hash = auditHash(base, prevHash, AUDIT_HASH_VERSION);
    const inserted = await mongoose.connection.db.collection('audits')
      .insertOne({...base, hash});
    return {id: inserted.insertedId, hash, sequence};
  }

  it('detects a broken prevHash even when every row hash is individually VALID', async () => {
    const a = await appendValidRow({sequence: 1, prevHash: null});
    // Correct sequence, self-consistent hash, but pointing at the wrong parent.
    await appendValidRow({sequence: 2, prevHash: '0'.repeat(64)});

    const result = await verify();
    const linkProblems = result.problems.filter(p => p.type === 'link');
    assert.equal(linkProblems.length, 1, 'a broken link was not detected on its own');
    // The rows themselves are fine — only the LINK is wrong.
    assert.equal(result.counts.content, 0, 'this must be a link failure, not a content failure');
    assert.equal(result.verified, false);
    assert.ok(a.hash);
  });

  it('detects a sequence gap even when every row hash is individually VALID', async () => {
    const a = await appendValidRow({sequence: 1, prevHash: null});
    // Correct parent hash, self-consistent, but sequence 3 — row 2 is missing.
    await appendValidRow({sequence: 3, prevHash: a.hash});

    const result = await verify();
    const gaps = result.problems.filter(p => p.type === 'sequence');
    assert.equal(gaps.length, 1, 'a sequence gap was not detected on its own');
    assert.equal(result.counts.content, 0);
    assert.equal(result.verified, false);
  });

  it('accepts a correctly linked chain — the control', async () => {
    const a = await appendValidRow({sequence: 1, prevHash: null});
    const b = await appendValidRow({sequence: 2, prevHash: a.hash});
    await appendValidRow({sequence: 3, prevHash: b.hash});

    const result = await verify();
    assert.equal(result.verified, true, JSON.stringify(result.problems));
    assert.equal(result.counts.valid, 3);
  });

  it('binds prevHash INTO each row hash, so a re-parented row cannot verify', async () => {
    /**
     * Kills M9. If `auditHash()` stopped mixing `prevHash` in, a row could be
     * lifted from one position in the chain to another and still verify — the
     * chain would degrade into a bag of independently-hashed rows.
     *
     * Asserted directly on the hash function: the SAME row content under two
     * different parents must produce two different hashes.
     */
    const row = {
      entity: 'x', restaurant: world.restaurant._id, action: 'rebind',
      before: null, after: {a: 1}, at: new Date('2026-01-01T00:00:00Z'), sequence: 5
    };
    const underA = auditHash(row, 'a'.repeat(64), AUDIT_HASH_VERSION);
    const underB = auditHash(row, 'b'.repeat(64), AUDIT_HASH_VERSION);
    assert.notEqual(underA, underB, 'prevHash does not contribute to the row hash');

    const genesis = auditHash(row, null, AUDIT_HASH_VERSION);
    assert.notEqual(genesis, underA, 'a genesis row hashes the same as a chained one');
  });

  it('detects a row moved to a different position in the chain', async () => {
    // End to end: a valid row re-parented to the wrong predecessor.
    const a = await appendValidRow({sequence: 1, prevHash: null});
    const b = await appendValidRow({sequence: 2, prevHash: a.hash});
    // Re-point row 3 at row 1 instead of row 2.
    await appendValidRow({sequence: 3, prevHash: a.hash});

    const result = await verify();
    assert.equal(result.verified, false, 'a re-parented row was accepted');
    assert.ok(result.problems.some(p => p.type === 'link'));
    assert.ok(b.hash);
  });
});
