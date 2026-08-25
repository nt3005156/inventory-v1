import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import mongoose from 'mongoose';
import {clearDb, request, seedWorld, startTestApp, stopTestApp, tokenFor} from './helpers.js';
import {Audit, Role, User} from '../src/models/index.js';
import {Branch, Order, Restaurant} from '../src/models/operations.js';
import {Plan, Subscription} from '../src/models/billing.js';
import {seedPlans} from '../scripts/seed-plans.js';
import {invalidateEntitlements, __resetBillingEnforcementProbe} from '../src/services/entitlements.js';
import {
  BRANDING_FIELDS, BRANDING_KEYS, FONT_KEYS, assertSafeUrl, isSafeColor, normalizeDomain,
  validateBrandingPatch, validateSettingsPatch
} from '../src/services/brandingSchema.js';
import {
  PRODUCT_DEFAULTS, __brandingCacheSize, getRestaurantBranding, invalidateBranding,
  publicBrandingView
} from '../src/services/branding.js';
import {getOwnBranding, updateBranding, updateSettings} from '../src/services/brandingAdmin.js';
import {buildReceipt, getReceipt, renderReceiptHtml} from '../src/services/receipts.js';

/**
 * P2D — tenant branding, white-label and customization.
 *
 * Two questions this phase must keep answering:
 *
 *   1. Branding is UNTRUSTED tenant input rendered into receipt HTML and a
 *      public web page. Can a tenant inject script, CSS or a dangerous URL
 *      scheme into either?
 *   2. Can restaurant A's branding ever reach restaurant B — or, worse, can
 *      editing A's profile rewrite A's own historical tax invoices?
 */

let world;
let rival;
let third;
let superAdmin;
let platformAdmin;
let support;

const owner = () => tokenFor(world.owner);
const manager = () => tokenFor(world.manager);
const staff = () => tokenFor(world.staffA);
const rivalOwner = () => tokenFor(rival.owner);
const sup = () => tokenFor(superAdmin);
const admin = () => tokenFor(platformAdmin);
const helpdesk = () => tokenFor(support);

const DAY = 86_400_000;

before(async () => { await startTestApp(); });
after(async () => { await stopTestApp(); });

/** Put a restaurant on a plan, so entitlement tiers resolve. */
async function subscribe(restaurantId, code) {
  const plan = await Plan.findOne({code});
  const now = new Date();
  await Subscription.create({
    restaurant: restaurantId, plan: plan._id, status: 'active',
    startDate: now, currentPeriodStart: now, currentPeriodEnd: new Date(now.getTime() + 30 * DAY)
  });
  invalidateEntitlements();
  invalidateBranding();
  __resetBillingEnforcementProbe();
}

beforeEach(async () => {
  await clearDb();
  invalidateEntitlements();
  invalidateBranding();
  __resetBillingEnforcementProbe();
  world = await seedWorld();

  // P2D-X: three visibly different restaurants.
  const r2 = await Restaurant.create({
    name: 'Rival Momo', slug: 'rival-momo', currency: 'NPR', status: 'active',
    legalName: 'Rival Momo Pvt Ltd', pan: '400111222', address: 'Patan', phone: '01-5555555'
  });
  const b2 = await Branch.create({restaurant: r2._id, name: 'Rival Branch', code: 'RVL'});
  const o2 = await User.create({
    name: 'Rival Owner', email: 'rivalowner@test.com', password: 'x', role: 'owner',
    restaurantId: r2._id
  });
  rival = {restaurant: r2, branch: b2, owner: o2};

  const r3 = await Restaurant.create({
    name: 'Third Thakali', slug: 'third-thakali', currency: 'NPR', status: 'active'
  });
  const b3 = await Branch.create({restaurant: r3._id, name: 'Third Branch', code: 'TRD'});
  const o3 = await User.create({
    name: 'Third Owner', email: 'thirdowner@test.com', password: 'x', role: 'owner',
    restaurantId: r3._id
  });
  third = {restaurant: r3, branch: b3, owner: o3};

  superAdmin = await User.create({
    name: 'Super Admin', email: 'super@saas.test', password: 'x',
    role: 'owner', platformRole: 'super_admin'
  });
  platformAdmin = await User.create({
    name: 'Platform Admin', email: 'platform@saas.test', password: 'x',
    role: 'owner', platformRole: 'platform_admin'
  });
  support = await User.create({
    name: 'Support Agent', email: 'support@saas.test', password: 'x',
    role: 'staff', platformRole: 'platform_support'
  });

  await seedPlans();
  __resetBillingEnforcementProbe();
  // Enterprise everywhere by default, so tier gating is tested explicitly
  // rather than accidentally.
  await subscribe(world.restaurant._id, 'enterprise');
  await subscribe(rival.restaurant._id, 'enterprise');
  await subscribe(third.restaurant._id, 'enterprise');
});

// ── 1. validation: colours, URLs, fonts (P2D-B, P2D-P) ───────────────────────

describe('P2D · colour validation refuses anything but #RRGGBB', () => {
  it('accepts a six-digit hex colour and normalises case', () => {
    assert.equal(isSafeColor('#ff8800'), true);
    assert.equal(validateBrandingPatch({primaryColor: '#FF8800'}).primaryColor, '#ff8800');
  });

  it('refuses every CSS-injection shape', () => {
    const malicious = [
      'red',
      'rgb(255,0,0)',
      '#f80',
      '#gggggg',
      '#ff8800; background:url(https://evil.test/x)',
      'expression(alert(1))',
      'url(javascript:alert(1))',
      '#ff8800}body{display:none',
      '</style><script>alert(1)</script>',
      'var(--x)',
      '#ff8800 !important',
      '  #ff8800; color:red  '
    ];
    for (const value of malicious) {
      assert.equal(isSafeColor(value), false, `${value} was accepted as a colour`);
      assert.throws(() => validateBrandingPatch({primaryColor: value}), /#RRGGBB/,
        `${value} was accepted by the patch validator`);
    }
  });
});

describe('P2D · URL validation refuses dangerous schemes', () => {
  it('accepts http and https', () => {
    assert.ok(assertSafeUrl('https://cdn.example.com/logo.png', 'logoUrl'));
    assert.ok(assertSafeUrl('http://example.com/logo.png', 'logoUrl'));
  });

  it('refuses javascript:, data:, vbscript: and friends', () => {
    const malicious = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)  ',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'data:image/svg+xml,<svg onload=alert(1)>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://x/y',
      'about:blank'
    ];
    for (const value of malicious) {
      assert.throws(() => assertSafeUrl(value, 'logoUrl'), /scheme|valid absolute URL/,
        `${value} was accepted as a URL`);
    }
  });

  it('refuses a relative URL and rubbish', () => {
    for (const value of ['/logo.png', 'logo.png', 'not a url', '://x']) {
      assert.throws(() => assertSafeUrl(value, 'logoUrl'));
    }
  });

  it('treats empty as "clear the field", not as an error', () => {
    assert.equal(assertSafeUrl('', 'logoUrl'), null);
    assert.equal(validateBrandingPatch({logoUrl: null}).logoUrl, null);
  });
});

describe('P2D · font family is an allowlist key, never raw CSS', () => {
  it('accepts a known key', () => {
    assert.equal(validateBrandingPatch({fontFamily: 'serif'}).fontFamily, 'serif');
  });

  it('refuses a raw font stack, which would be a CSS injection', () => {
    for (const value of [
      "Arial; } body { background: url(https://evil.test/?c=1)",
      'Comic Sans MS',
      '"><script>alert(1)</script>'
    ]) {
      assert.throws(() => validateBrandingPatch({fontFamily: value}), /must be one of/);
    }
  });

  it('exposes only server-controlled stacks', async () => {
    await updateBranding({user: {id: String(world.owner._id), role: 'owner'}, patch: {fontFamily: 'mono'}});
    const branding = await getRestaurantBranding(world.restaurant._id, {fresh: true});
    assert.match(branding.fontStack, /Consolas|SF Mono/);
    assert.ok(!branding.fontStack.includes('<'));
  });
});

describe('P2D · unknown keys are rejected, never silently stripped', () => {
  it('rejects an unknown branding field', () => {
    assert.throws(() => validateBrandingPatch({evilField: 'x'}), /Unknown branding field/);
  });

  it('rejects an unknown settings category or key', () => {
    assert.throws(() => validateSettingsPatch({security: {jwtSecret: 'x'}}), /Unknown settings category/);
    assert.throws(() => validateSettingsPatch({pos: {rootPassword: 'x'}}), /Unknown setting/);
  });

  it('refuses an unknown branding field over HTTP rather than ignoring it', async () => {
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {notARealField: 'x'}
    });
    assert.equal(res.status, 400);
  });

  it('gives a tenant no way to name a security-sensitive setting', async () => {
    /**
     * The settings catalogue is a CLOSED key set, so these are not blocked by
     * a blocklist — they simply cannot be expressed.
     */
    for (const patch of [
      {platform: {role: 'super_admin'}},
      {billing: {plan: 'enterprise'}},
      {auth: {jwtSecret: 'x'}},
      {infrastructure: {mongoUri: 'mongodb://evil'}},
      {audit: {enabled: false}}
    ]) {
      const res = await request('/api/my/restaurant/settings', {
        method: 'PATCH', token: owner(), body: patch
      });
      assert.equal(res.status, 400, JSON.stringify(patch));
    }
  });
});

// ── 2. HTML escaping in receipts (P2D-P) ─────────────────────────────────────

describe('P2D · malicious branding cannot escape receipt HTML', () => {
  it('escapes a script payload in the footer and the display name', async () => {
    const payload = '<script>alert("xss")</script>';
    const html = renderReceiptHtml(buildReceipt({
      order: {
        _id: new mongoose.Types.ObjectId(), orderNo: 'A-1', type: 'counter', status: 'completed',
        items: [{name: 'Momo', qty: 1, unitPrice: 100, lineNet: 100, lineVat: 13, lineTotal: 113}],
        subtotal: 100, vat: 13, total: 113, vatRate: 13
      },
      restaurant: {name: payload, receiptFooter: payload, currency: 'NPR', pan: '123'},
      branch: {name: 'B', code: 'B', pan: '123'},
      payments: [],
      branding: {displayName: payload, footer: payload, logoUrl: null}
    }));
    assert.ok(!html.includes('<script>'), 'raw <script> reached the receipt HTML');
    assert.ok(html.includes('&lt;script&gt;'), 'the payload was not escaped');
  });

  it('escapes a logo URL so it cannot break out of the src attribute', async () => {
    const html = renderReceiptHtml(buildReceipt({
      order: {
        _id: new mongoose.Types.ObjectId(), orderNo: 'A-1', type: 'counter', status: 'completed',
        items: [], subtotal: 0, vat: 0, total: 0, vatRate: 13
      },
      restaurant: {name: 'R', currency: 'NPR', pan: '1'},
      branch: {name: 'B', code: 'B', pan: '1'},
      payments: [],
      branding: {displayName: 'R', logoUrl: 'https://x.test/a.png" onerror="alert(1)', footer: null}
    }));
    assert.ok(!html.includes('onerror="alert(1)"'), 'attribute break-out succeeded');
    assert.ok(html.includes('&quot;'), 'the quote was not escaped');
  });

  it('stores markup RAW rather than pre-escaped, so editing does not double-escape', () => {
    // "Fish & Chips" is legitimate text. Escaping at storage time would turn a
    // second save into "Fish &amp;amp; Chips".
    const stored = validateBrandingPatch({receiptFooter: 'Fish & Chips <10% off>'});
    assert.equal(stored.receiptFooter, 'Fish & Chips <10% off>');
  });

  it('strips control characters but keeps ordinary punctuation', () => {
    const value = validateBrandingPatch({tagline: 'Best\u0000 momo\u001f in town!'});
    assert.equal(value.tagline, 'Best momo in town!');
  });

  it('refuses an over-long value rather than truncating it silently', () => {
    assert.throws(() => validateBrandingPatch({tagline: 'x'.repeat(500)}), /characters or fewer/);
  });
});

// ── 3. the resolver: defaults and no write-back (P2D-G, R) ───────────────────

describe('P2D · branding resolver defaults', () => {
  it('renders a completely unbranded restaurant correctly', async () => {
    const branding = await getRestaurantBranding(third.restaurant._id, {fresh: true});
    assert.equal(branding.displayName, 'Third Thakali', 'falls back to the restaurant name');
    assert.equal(branding.primaryColor, PRODUCT_DEFAULTS.primaryColor);
    assert.equal(branding.logoUrl, null);
    assert.equal(branding.storefrontTitle, 'Third Thakali');
    assert.ok(branding.fontStack);
    // Every key present, so no caller needs its own fallback.
    for (const key of BRANDING_KEYS) {
      assert.ok(key in branding, `${key} missing from the resolved branding`);
    }
  });

  it('does NOT write defaults back to the database', async () => {
    await getRestaurantBranding(third.restaurant._id, {fresh: true});
    const stored = await Restaurant.findById(third.restaurant._id).select('branding').lean();
    assert.ok(!stored.branding?.primaryColor,
      'a default was persisted, which turns "never chose" into "chose this"');
  });

  it('falls back safely for a missing or invalid restaurant', async () => {
    assert.equal((await getRestaurantBranding('nonsense')).displayName, 'Restaurant');
    assert.equal((await getRestaurantBranding(null)).displayName, 'Restaurant');
    const gone = await getRestaurantBranding(new mongoose.Types.ObjectId(), {fresh: true});
    assert.equal(gone.displayName, 'Restaurant');
  });

  it('honours the legacy Restaurant.receiptFooter when branding sets none', async () => {
    await Restaurant.updateOne({_id: third.restaurant._id}, {$set: {receiptFooter: 'Legacy footer'}});
    invalidateBranding();
    const branding = await getRestaurantBranding(third.restaurant._id, {fresh: true});
    assert.equal(branding.receiptFooter, 'Legacy footer');
  });

  it('lets branding override the legacy footer', async () => {
    await Restaurant.updateOne({_id: third.restaurant._id}, {$set: {receiptFooter: 'Legacy'}});
    await updateBranding({
      user: {id: String(third.owner._id), role: 'owner'}, patch: {receiptFooter: 'New footer'}
    });
    const branding = await getRestaurantBranding(third.restaurant._id, {fresh: true});
    assert.equal(branding.receiptFooter, 'New footer');
  });
});

// ── 4. cache invalidation (P2D-Q) ────────────────────────────────────────────

describe('P2D · branding cache', () => {
  it('invalidates on update, so a change is visible immediately', async () => {
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {primaryColor: '#111111'}
    });
    // No `fresh` flag: a stale cache would still report the old colour.
    assert.equal((await getRestaurantBranding(world.restaurant._id)).primaryColor, '#111111');

    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {primaryColor: '#222222'}
    });
    assert.equal((await getRestaurantBranding(world.restaurant._id)).primaryColor, '#222222');
  });

  it('invalidates only the restaurant that changed', async () => {
    await getRestaurantBranding(world.restaurant._id);
    await getRestaurantBranding(rival.restaurant._id);
    const before = __brandingCacheSize();
    invalidateBranding(world.restaurant._id);
    assert.equal(__brandingCacheSize(), before - 1);
  });
});

// ── 5. tenant isolation (P2D-X) ──────────────────────────────────────────────

describe('P2D · multi-tenant branding isolation', () => {
  beforeEach(async () => {
    await updateBranding({user: {id: String(world.owner._id), role: 'owner'}, patch: {
      displayName: 'AAA Biryani', primaryColor: '#aa0000', receiptFooter: 'AAA footer',
      storefrontTitle: 'AAA Storefront', logoUrl: 'https://cdn.test/aaa.png'
    }});
    await updateBranding({user: {id: String(rival.owner._id), role: 'owner'}, patch: {
      displayName: 'BBB Momo', primaryColor: '#00bb00', receiptFooter: 'BBB footer',
      storefrontTitle: 'BBB Storefront', logoUrl: 'https://cdn.test/bbb.png'
    }});
    await updateBranding({user: {id: String(third.owner._id), role: 'owner'}, patch: {
      displayName: 'CCC Thakali', primaryColor: '#0000cc', receiptFooter: 'CCC footer',
      storefrontTitle: 'CCC Storefront', logoUrl: 'https://cdn.test/ccc.png'
    }});
  });

  it('gives each restaurant only its own branding', async () => {
    const a = await getRestaurantBranding(world.restaurant._id, {fresh: true});
    const b = await getRestaurantBranding(rival.restaurant._id, {fresh: true});
    const c = await getRestaurantBranding(third.restaurant._id, {fresh: true});

    assert.equal(a.displayName, 'AAA Biryani');
    assert.equal(b.displayName, 'BBB Momo');
    assert.equal(c.displayName, 'CCC Thakali');
    assert.equal(a.primaryColor, '#aa0000');
    assert.equal(b.primaryColor, '#00bb00');
    assert.equal(c.primaryColor, '#0000cc');
    // No cross-contamination in either direction.
    assert.notEqual(a.logoUrl, b.logoUrl);
    assert.notEqual(b.receiptFooter, c.receiptFooter);
  });

  it('does not alter B or C when A rebrands', async () => {
    const bBefore = await getRestaurantBranding(rival.restaurant._id, {fresh: true});
    const cBefore = await getRestaurantBranding(third.restaurant._id, {fresh: true});

    await updateBranding({user: {id: String(world.owner._id), role: 'owner'}, patch: {
      displayName: 'AAA RENAMED', primaryColor: '#123456'
    }});

    const bAfter = await getRestaurantBranding(rival.restaurant._id, {fresh: true});
    const cAfter = await getRestaurantBranding(third.restaurant._id, {fresh: true});
    assert.deepEqual(
      {n: bAfter.displayName, c: bAfter.primaryColor},
      {n: bBefore.displayName, c: bBefore.primaryColor}
    );
    assert.deepEqual(
      {n: cAfter.displayName, c: cAfter.primaryColor},
      {n: cBefore.displayName, c: cBefore.primaryColor}
    );
  });

  it('takes the tenant from the principal, never from the request', async () => {
    for (const contamination of [
      {restaurantId: String(rival.restaurant._id)},
      {restaurant: String(rival.restaurant._id)}
    ]) {
      const result = await getOwnBranding({
        user: {id: String(world.owner._id), role: 'owner', ...contamination}
      });
      assert.equal(result.branding.displayName, 'AAA Biryani',
        `a caller-supplied ${Object.keys(contamination)[0]} reached the branding lookup`);
    }
  });

  it('ignores a restaurant id in the tenant PATCH body', async () => {
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(),
      body: {displayName: 'HIJACK', restaurantId: String(rival.restaurant._id)}
    });
    // The strict schema refuses the unknown key outright.
    assert.equal(res.status, 400);
    const b = await getRestaurantBranding(rival.restaurant._id, {fresh: true});
    assert.equal(b.displayName, 'BBB Momo', "B's branding was modified");
  });

  it('refuses A any access to B\'s branding through the platform path', async () => {
    const read = await request(`/api/platform/restaurants/${rival.restaurant._id}/branding`,
      {token: owner()});
    assert.equal(read.status, 403);

    const write = await request(`/api/platform/restaurants/${rival.restaurant._id}/branding`, {
      method: 'PATCH', token: owner(), body: {displayName: 'HIJACKED'}
    });
    assert.equal(write.status, 403);
    assert.equal((await getRestaurantBranding(rival.restaurant._id, {fresh: true})).displayName,
      'BBB Momo');
  });

  it('keeps the public storefront tenant-isolated by branch', async () => {
    const a = await request(`/api/public/branding?branch=${world.branchA._id}`);
    const b = await request(`/api/public/branding?branch=${rival.branch._id}`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.branding.displayName, 'AAA Biryani');
    assert.equal(b.body.branding.displayName, 'BBB Momo');
    assert.notEqual(a.body.branding.primaryColor, b.body.branding.primaryColor);
  });
});

// ── 6. public storefront exposure (P2D-H) ────────────────────────────────────

describe('P2D · the public branding endpoint', () => {
  it('exposes no tax identity, legal name, address or plan', async () => {
    await updateBranding({user: {id: String(world.owner._id), role: 'owner'}, patch: {
      displayName: 'Public Name'
    }});
    const res = await request(`/api/public/branding?branch=${world.branchA._id}`);
    assert.equal(res.status, 200);
    const blob = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ['pan', 'legalname', 'plancode', 'vat', 'password', 'tier']) {
      assert.ok(!blob.includes(forbidden), `the public endpoint leaked "${forbidden}"`);
    }
  });

  it('is reachable without authentication', async () => {
    const res = await request(`/api/public/branding?branch=${world.branchA._id}`);
    assert.equal(res.status, 200);
  });

  it('refuses a missing, malformed or unknown branch', async () => {
    assert.equal((await request('/api/public/branding')).status, 400);
    assert.equal((await request('/api/public/branding?branch=nonsense')).status, 400);
    assert.equal(
      (await request(`/api/public/branding?branch=${new mongoose.Types.ObjectId()}`)).status, 404);
  });

  it('does not accept a restaurant id from the browser', async () => {
    // Only `branch` is honoured; a restaurant parameter must not select a tenant.
    const res = await request(`/api/public/branding?restaurant=${rival.restaurant._id}`);
    assert.equal(res.status, 400, 'a restaurant id was accepted as a tenant selector');
  });

  it('refuses an inactive branch, so it is not a side channel', async () => {
    await Branch.updateOne({_id: rival.branch._id}, {$set: {active: false}});
    const res = await request(`/api/public/branding?branch=${rival.branch._id}`);
    assert.equal(res.status, 404);
  });

  it('projects only public fields', () => {
    const view = publicBrandingView({
      ...PRODUCT_DEFAULTS, displayName: 'X', fontStack: 'serif', currency: 'NPR',
      legalName: 'Secret Legal Ltd', tiers: {white: true}, restaurantId: 'abc'
    });
    assert.equal(view.legalName, undefined);
    assert.equal(view.tiers, undefined);
    assert.equal(view.restaurantId, undefined);
    assert.equal(view.displayName, 'X');
  });
});

// ── 7. authorization (P2D-E, F) ──────────────────────────────────────────────

describe('P2D · who may read and write branding', () => {
  it('lets staff READ their own branding — the POS shell needs it', async () => {
    assert.equal((await request('/api/my/branding', {token: staff()})).status, 200);
    assert.equal((await request('/api/my/restaurant/branding', {token: staff()})).status, 200);
  });

  it('refuses a manager the WRITE, which is settings.manage', async () => {
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: manager(), body: {displayName: 'Manager Rename'}
    });
    assert.equal(res.status, 403);
    // Control: the owner may.
    const ok = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {displayName: 'Owner Rename'}
    });
    assert.equal(ok.status, 200);
  });

  it('refuses staff and riders the write', async () => {
    const rider = await User.create({
      name: 'Rider', email: 'rider-p2d@test.com', password: 'x', role: 'rider',
      restaurantId: world.restaurant._id, branch: world.branchA._id,
      rider: {active: true, available: false}
    });
    for (const token of [staff(), tokenFor(rider)]) {
      const res = await request('/api/my/restaurant/branding', {
        method: 'PATCH', token, body: {displayName: 'Nope'}
      });
      assert.equal(res.status, 403);
    }
  });

  it('answers 401 to an anonymous caller on tenant endpoints', async () => {
    assert.equal((await request('/api/my/restaurant/branding')).status, 401);
    assert.equal((await request('/api/my/branding')).status, 401);
  });

  it('refuses a custom tenant role without settings.manage', async () => {
    await Role.create({
      restaurant: world.restaurant._id, key: 'brander', name: 'Brander',
      baseRole: 'manager', permissions: ['branches.view'], active: true
    });
    const custom = await User.create({
      name: 'Custom', email: 'custom-p2d@test.com', password: 'x', role: 'manager',
      roleKey: 'brander', restaurantId: world.restaurant._id, branch: world.branchA._id
    });
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: tokenFor(custom), body: {displayName: 'Nope'}
    });
    assert.equal(res.status, 403);
    // ...but it may read, because it holds branches.view.
    assert.equal((await request('/api/my/branding', {token: tokenFor(custom)})).status, 200);
  });

  it('lets platform support VIEW but not modify tenant branding', async () => {
    const read = await request(`/api/platform/restaurants/${world.restaurant._id}/branding`,
      {token: helpdesk()});
    assert.equal(read.status, 200);

    const write = await request(`/api/platform/restaurants/${world.restaurant._id}/branding`, {
      method: 'PATCH', token: helpdesk(), body: {displayName: 'Support Rename'}
    });
    assert.equal(write.status, 403);
  });

  it('lets platform admin and super admin modify tenant branding', async () => {
    for (const [token, name] of [[admin(), 'Admin Set'], [sup(), 'Super Set']]) {
      const res = await request(`/api/platform/restaurants/${world.restaurant._id}/branding`, {
        method: 'PATCH', token, body: {displayName: name, reason: 'support request'}
      });
      assert.equal(res.status, 200, `${name}: ${res.body?.message}`);
    }
    assert.equal((await getRestaurantBranding(world.restaurant._id, {fresh: true})).displayName,
      'Super Set');
  });

  it('ignores a forged platformRole JWT claim', async () => {
    const forged = tokenFor(world.owner, {platformRole: 'super_admin'});
    const read = await request(`/api/platform/restaurants/${rival.restaurant._id}/branding`,
      {token: forged});
    assert.equal(read.status, 403);
    const write = await request(`/api/platform/restaurants/${rival.restaurant._id}/branding`, {
      method: 'PATCH', token: forged, body: {displayName: 'FORGED'}
    });
    assert.equal(write.status, 403);
    assert.notEqual((await getRestaurantBranding(rival.restaurant._id, {fresh: true})).displayName,
      'FORGED');
  });

  it('refuses at the SERVICE layer with no route guard in the way', async () => {
    await assert.rejects(
      () => updateBranding({
        user: {id: String(world.owner._id)}, patch: {displayName: 'X'},
        restaurantId: String(rival.restaurant._id), viaPlatform: true
      }),
      /not available to this account/
    );
    // Control: a real operator passes the same call.
    const ok = await updateBranding({
      user: {id: String(platformAdmin._id)}, patch: {displayName: 'Platform OK'},
      restaurantId: String(rival.restaurant._id), viaPlatform: true
    });
    assert.equal(ok.branding.displayName, 'Platform OK');
  });
});

// ── 8. entitlement tiers (P2D-N, O) ──────────────────────────────────────────

describe('P2D · branding tiers are enforced by plan', () => {
  async function downgradeTo(code) {
    await Subscription.deleteMany({restaurant: world.restaurant._id});
    await subscribe(world.restaurant._id, code);
  }

  it('lets every plan use CORE branding', async () => {
    await downgradeTo('starter');
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(),
      body: {displayName: 'Starter Name', primaryColor: '#123456', logoUrl: 'https://cdn.test/a.png'}
    });
    assert.equal(res.status, 200, res.body?.message);
  });

  it('refuses ADVANCED branding on Starter, with 402', async () => {
    await downgradeTo('starter');
    for (const patch of [
      {storefrontTitle: 'Fancy'},
      {accentColor: '#ff0000'},
      {fontFamily: 'serif'},
      {orderingInstructions: 'Please queue'}
    ]) {
      const res = await request('/api/my/restaurant/branding', {
        method: 'PATCH', token: owner(), body: patch
      });
      assert.equal(res.status, 402, `${Object.keys(patch)[0]} should need advancedBranding`);
      assert.match(res.body.message, /advanced branding|not included/i);
    }
  });

  it('allows ADVANCED branding on Professional', async () => {
    await downgradeTo('professional');
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {storefrontTitle: 'Pro Storefront', fontFamily: 'serif'}
    });
    assert.equal(res.status, 200, res.body?.message);
  });

  it('refuses WHITE-LABEL below Enterprise', async () => {
    await downgradeTo('professional');
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {hideProductBranding: true}
    });
    assert.equal(res.status, 402);

    await Subscription.deleteMany({restaurant: world.restaurant._id});
    await subscribe(world.restaurant._id, 'enterprise');
    const ok = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {hideProductBranding: true}
    });
    assert.equal(ok.status, 200, ok.body?.message);
  });

  it('a forged frontend flag does nothing — the backend decides', async () => {
    await downgradeTo('starter');
    // The client cannot assert its own entitlement; there is no field for it,
    // and the tier is read from the plan.
    const res = await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(),
      body: {hideProductBranding: true, tiers: {white: true}, editable: {white: true}}
    });
    assert.ok([400, 402].includes(res.status), `got ${res.status}`);
    const stored = await Restaurant.findById(world.restaurant._id).select('branding').lean();
    assert.notEqual(stored.branding?.hideProductBranding, true);
  });

  it('stops APPLYING a paid tier after downgrade but does not destroy the values', async () => {
    // Set advanced values on Enterprise...
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'},
      patch: {storefrontTitle: 'Fancy Title', accentColor: '#abcdef'}
    });
    // ...then downgrade.
    await downgradeTo('starter');
    const resolved = await getRestaurantBranding(world.restaurant._id, {fresh: true});
    assert.equal(resolved.storefrontTitle, resolved.displayName, 'advanced value must stop applying');
    assert.equal(resolved.accentColor, PRODUCT_DEFAULTS.accentColor);

    // The stored values survive, so an upgrade restores them without re-entry.
    const stored = await Restaurant.findById(world.restaurant._id).select('branding').lean();
    assert.equal(stored.branding.storefrontTitle, 'Fancy Title');
    assert.equal(stored.branding.accentColor, '#abcdef');

    await Subscription.deleteMany({restaurant: world.restaurant._id});
    await subscribe(world.restaurant._id, 'enterprise');
    const back = await getRestaurantBranding(world.restaurant._id, {fresh: true});
    assert.equal(back.storefrontTitle, 'Fancy Title');
  });

  it('reverts to core branding when the subscription lapses', async () => {
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {accentColor: '#abcdef'}
    });
    await Subscription.updateOne({restaurant: world.restaurant._id}, {$set: {status: 'cancelled'}});
    invalidateEntitlements();
    invalidateBranding();
    const resolved = await getRestaurantBranding(world.restaurant._id, {fresh: true});
    assert.equal(resolved.accentColor, PRODUCT_DEFAULTS.accentColor,
      'a lapsed tenant must not keep paid-tier presentation');
  });

  it('exempts a platform operator from the tenant\'s plan limits', async () => {
    await downgradeTo('starter');
    // Support fixing a Starter tenant's storefront must not be blocked by the
    // tenant's own plan — the operator is not the one being sold to.
    const res = await request(`/api/platform/restaurants/${world.restaurant._id}/branding`, {
      method: 'PATCH', token: admin(),
      body: {storefrontTitle: 'Fixed by support', reason: 'ticket 91'}
    });
    assert.equal(res.status, 200, res.body?.message);
  });
});

// ── 9. invoice identity snapshot (P2D-J, K) ──────────────────────────────────

describe('P2D · historical tax invoices are immune to profile edits', () => {
  async function invoiceAnOrder() {
    const order = await Order.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, orderNo: 'INV-1',
      type: 'counter', status: 'completed',
      items: [{name: 'Biryani', qty: 1, unitPrice: 100, lineNet: 100, lineVat: 13, lineTotal: 113}],
      subtotal: 100, vat: 13, total: 113, paidAmount: 113, vatRate: 13
    });
    return getReceipt({
      orderId: order._id, user: {id: String(world.owner._id), role: 'owner'}, issue: true
    });
  }

  beforeEach(async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {
      name: 'Original Name', legalName: 'Original Legal Ltd', pan: '301234567',
      address: 'Kalanki, Kathmandu', phone: '01-4441234'
    }});
    invalidateBranding();
  });

  it('captures the seller identity when the invoice is issued', async () => {
    const receipt = await invoiceAnOrder();
    assert.equal(receipt.seller.identitySource, 'snapshot');
    assert.equal(receipt.seller.pan, '301234567');
    assert.equal(receipt.seller.legalName, 'Original Legal Ltd');
  });

  it('REPRODUCES THE FIX: a profile edit does not rewrite an issued invoice', async () => {
    const first = await invoiceAnOrder();
    const orderId = first.order.id;

    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {
      name: 'COMPLETELY DIFFERENT CO', legalName: 'New Owner Ltd', pan: '999999999',
      address: 'Somewhere Else', phone: '00-0000000', receiptFooter: 'New footer'
    }});
    invalidateBranding();

    const reprint = await getReceipt({
      orderId, user: {id: String(world.owner._id), role: 'owner'}, issue: true
    });
    assert.equal(reprint.seller.pan, '301234567', 'the PAN on a historical invoice drifted');
    assert.equal(reprint.seller.name, 'Original Name');
    assert.equal(reprint.seller.legalName, 'Original Legal Ltd');
    /**
     * The BRANCH address, not the restaurant's — `seedWorld` gives branchA
     * `'Kalanki'`, and branch values take precedence for address/phone/PAN
     * (a branch can be separately registered). My first assertion expected the
     * restaurant address and was simply wrong about the precedence, not
     * evidence of a defect. What matters is that it is STABLE.
     */
    assert.equal(reprint.seller.address, first.seller.address);
    assert.equal(reprint.seller.address, 'Kalanki');
    // Controls: the number and the total were already frozen by Phase 13.
    assert.equal(reprint.invoiceNo, first.invoiceNo);
    assert.equal(reprint.invoicedTotal, first.invoicedTotal);
  });

  it('uses the CURRENT identity for a NEW invoice — the control', async () => {
    await invoiceAnOrder();
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {
      name: 'Renamed Co', pan: '888888888'
    }});
    invalidateBranding();
    const next = await invoiceAnOrder();
    assert.equal(next.seller.pan, '888888888');
    assert.equal(next.seller.name, 'Renamed Co');
  });

  it('refuses to rewrite the snapshot on an issued invoice', async () => {
    const receipt = await invoiceAnOrder();
    const order = await Order.findById(receipt.order.id);
    order.invoiceIdentity.pan = '111111111';
    await assert.rejects(() => order.save(), /cannot be altered/);

    await assert.rejects(
      () => Order.updateOne({_id: receipt.order.id}, {$set: {'invoiceIdentity.pan': '222'}},
        {runInvoiceGuard: 'invoiceIdentity'}),
      /cannot be altered/
    );
  });

  it('never re-prices an order from current settings', async () => {
    const first = await invoiceAnOrder();
    // Change the tenant's VAT rate AFTER issue.
    await Restaurant.updateOne({_id: world.restaurant._id}, {$set: {vatRate: 25}});
    invalidateBranding();
    const reprint = await getReceipt({
      orderId: first.order.id, user: {id: String(world.owner._id), role: 'owner'}, issue: true
    });
    assert.equal(reprint.totals.vat, first.totals.vat, 'historical VAT was recalculated');
    assert.equal(reprint.totals.total, first.totals.total);
  });

  it('uses the branding footer that was current at issue', async () => {
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {receiptFooter: 'Footer at issue'}
    });
    const first = await invoiceAnOrder();
    assert.equal(first.seller.footer, 'Footer at issue');

    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {receiptFooter: 'Changed later'}
    });
    const reprint = await getReceipt({
      orderId: first.order.id, user: {id: String(world.owner._id), role: 'owner'}, issue: true
    });
    assert.equal(reprint.seller.footer, 'Footer at issue', 'the printed footer changed retroactively');
  });

  it('falls back to live values for a legacy invoice with no snapshot', async () => {
    // An order invoiced before P2D: number present, snapshot absent.
    const legacy = await Order.create({
      restaurant: world.restaurant._id, branch: world.branchA._id, orderNo: 'LEG-1',
      type: 'counter', status: 'completed',
      items: [{name: 'X', qty: 1, unitPrice: 100, lineNet: 100, lineVat: 13, lineTotal: 113}],
      subtotal: 100, vat: 13, total: 113, vatRate: 13,
      invoiceNo: 'INV-KTM-2025-000009', invoicedAt: new Date('2025-01-01'), invoicedTotal: 113
    });
    const receipt = await getReceipt({
      orderId: legacy._id, user: {id: String(world.owner._id), role: 'owner'}
    });
    assert.equal(receipt.seller.identitySource, 'live');
    assert.equal(receipt.seller.pan, '301234567');
  });
});

// ── 10. audit (P2D-E) ────────────────────────────────────────────────────────

describe('P2D · branding changes are audited', () => {
  it('records only the fields that changed', async () => {
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'},
      patch: {displayName: 'Audited Name', primaryColor: '#abcdef'}
    });
    const row = await Audit.findOne({action: 'branding_updated'}).lean();
    assert.ok(row);
    assert.equal(row.after.displayName, 'Audited Name');
    assert.equal(row.after.primaryColor, '#abcdef');
    assert.ok(row.hash, 'the row is not chained');
    assert.equal(String(row.restaurant), String(world.restaurant._id));
  });

  it('distinguishes a platform edit from a tenant edit', async () => {
    await request(`/api/platform/restaurants/${world.restaurant._id}/branding`, {
      method: 'PATCH', token: admin(), body: {displayName: 'By Platform', reason: 'ticket 5'}
    });
    const row = await Audit.findOne({action: 'platform_branding_updated'}).lean();
    assert.ok(row, 'a platform edit must be distinguishable from a tenant edit');
    assert.equal(row.reason, 'ticket 5');
    assert.equal(row.userRole, 'platform:platform_admin');
  });

  it('keeps the audit chain verifiable after branding changes', async () => {
    const {verifyAuditChain} = await import('../src/services/auditTrail.js');
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {displayName: 'Chain Test'}
    });
    await updateSettings({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {pos: {showItemImages: true}}
    });
    const result = await verifyAuditChain({user: {id: String(world.owner._id), role: 'owner'}});
    assert.equal(result.verified, true, JSON.stringify(result.problems));
  });

  it('never records a secret', async () => {
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {displayName: 'X'}
    });
    const rows = await Audit.find({entity: 'restaurant'}).lean();
    const blob = JSON.stringify(rows).toLowerCase();
    for (const secret of ['password', 'jwt', 'secret', 'token']) {
      assert.ok(!blob.includes(secret), `branding audit leaked "${secret}"`);
    }
  });
});

// ── 11. typed settings (P2D-D) ───────────────────────────────────────────────

describe('P2D · tenant settings', () => {
  it('returns defaults for a restaurant that has set nothing', async () => {
    const res = await request('/api/my/restaurant/settings', {token: owner()});
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.kds.ticketColumns, 3);
    assert.equal(res.body.settings.localization.timeFormat, '24h');
  });

  it('merges a patch without destroying other categories', async () => {
    await updateSettings({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {kds: {ticketColumns: 5}}
    });
    await updateSettings({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {pos: {showItemImages: true}}
    });
    const res = await request('/api/my/restaurant/settings', {token: owner()});
    assert.equal(res.body.settings.kds.ticketColumns, 5);
    assert.equal(res.body.settings.pos.showItemImages, true);
  });

  it('does NOT destroy pre-existing legacy settings keys', async () => {
    await Restaurant.updateOne({_id: world.restaurant._id}, {
      $set: {settings: {legacyThing: {keep: 'me'}}}
    });
    await updateSettings({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {kds: {ticketColumns: 4}}
    });
    const stored = await Restaurant.findById(world.restaurant._id).select('settings').lean();
    assert.deepEqual(stored.settings.legacyThing, {keep: 'me'},
      'the migration/merge destroyed an unrelated settings key');
    assert.equal(stored.settings.kds.ticketColumns, 4);
  });

  it('enforces types and ranges', async () => {
    for (const patch of [
      {kds: {ticketColumns: 99}},
      {kds: {ticketColumns: 'three'}},
      {pos: {showItemImages: 'yes'}},
      {localization: {timeFormat: '36h'}}
    ]) {
      const res = await request('/api/my/restaurant/settings', {
        method: 'PATCH', token: owner(), body: patch
      });
      assert.equal(res.status, 400, JSON.stringify(patch));
    }
  });

  it('is tenant-isolated', async () => {
    await updateSettings({
      user: {id: String(world.owner._id), role: 'owner'}, patch: {kds: {ticketColumns: 6}}
    });
    const theirs = await request('/api/my/restaurant/settings', {token: rivalOwner()});
    assert.equal(theirs.body.settings.kds.ticketColumns, 3, "A's settings leaked into B");
  });
});

// ── 12. custom domain (P2D-M) ────────────────────────────────────────────────

describe('P2D · custom domain modelling', () => {
  it('normalises a hostname', () => {
    assert.equal(normalizeDomain('  Example.COM.  '), 'example.com');
    assert.equal(normalizeDomain('shop.example.co.uk'), 'shop.example.co.uk');
  });

  it('refuses a scheme, port, path or rubbish', () => {
    for (const value of [
      'https://example.com', 'example.com:8080', 'example.com/path',
      'not a domain', 'example', '-bad.com', 'x'.repeat(300) + '.com'
    ]) {
      assert.throws(() => normalizeDomain(value), /domain/i, `${value} was accepted`);
    }
  });

  it('claims a domain unverified, and never claims to serve it', async () => {
    const res = await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'order.aaabiryani.com'}
    });
    assert.equal(res.status, 200, res.body?.message);
    assert.equal(res.body.domain, 'order.aaabiryani.com');
    assert.equal(res.body.verified, false);
    assert.equal(res.body.serving, false, 'the API must not imply DNS/TLS is handled');
    assert.ok(res.body.verificationToken);
  });

  it('refuses a domain already claimed by another restaurant', async () => {
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'shared.example.com'}
    });
    const res = await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: rivalOwner(), body: {domain: 'shared.example.com'}
    });
    assert.equal(res.status, 409);
  });

  it('requires the customDomain entitlement', async () => {
    await Subscription.deleteMany({restaurant: world.restaurant._id});
    await subscribe(world.restaurant._id, 'starter');
    const res = await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'nope.example.com'}
    });
    assert.equal(res.status, 402);
  });

  it('only a platform operator may mark a domain verified', async () => {
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'verify.example.com'}
    });
    const denied = await request(
      `/api/platform/restaurants/${world.restaurant._id}/domain/verify`,
      {method: 'POST', token: owner(), body: {}});
    assert.equal(denied.status, 403);

    const ok = await request(
      `/api/platform/restaurants/${world.restaurant._id}/domain/verify`,
      {method: 'POST', token: admin(), body: {reason: 'TXT record confirmed'}});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.verified, true);
    assert.equal(ok.body.serving, false);
  });

  it('resets verification when the domain changes', async () => {
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'first.example.com'}
    });
    await request(`/api/platform/restaurants/${world.restaurant._id}/domain/verify`,
      {method: 'POST', token: admin(), body: {}});
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'second.example.com'}
    });
    const stored = await Restaurant.findById(world.restaurant._id).lean();
    assert.equal(stored.customDomainVerified, false,
      'proving one hostname says nothing about another');
  });

  it('audits a domain change', async () => {
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'audited.example.com'}
    });
    assert.ok(await Audit.findOne({action: 'custom_domain_changed'}).lean());
  });
});

// ── 13. survivors from the mutation run ──────────────────────────────────────

describe('P2D · gaps found by mutation testing', () => {
  /**
   * Five mutants survived the first run. Three were real test gaps and are
   * closed here; two are equivalent and are documented rather than papered
   * over with a test that would assert nothing.
   */

  it('refuses a duplicate custom domain at the DATABASE, not only in the check', async () => {
    /**
     * M15 (pre-flight duplicate check deleted) SURVIVES, and is EQUIVALENT:
     * the unique partial index `restaurant_custom_domain` refuses the write
     * regardless, and `setCustomDomain()` catches E11000 and maps it to the
     * same 409. The pre-flight check exists only to produce that message
     * without a failed write, so removing it changes no observable behaviour.
     *
     * Both layers are asserted below, so the guarantee is covered wherever it
     * actually lives.
     */
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: owner(), body: {domain: 'contested.example.com'}
    });
    // The friendly 409 from the pre-flight check.
    const second = await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: rivalOwner(), body: {domain: 'contested.example.com'}
    });
    assert.equal(second.status, 409);

    // ...and the index refuses it even when the check is bypassed entirely.
    await assert.rejects(
      () => Restaurant.updateOne(
        {_id: rival.restaurant._id}, {$set: {customDomain: 'contested.example.com'}}
      ),
      /E11000|duplicate key/
    );

    // Control: a different hostname is accepted.
    const ok = await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: rivalOwner(), body: {domain: 'uncontested.example.com'}
    });
    assert.equal(ok.status, 200);
  });

  it('serves updated branding immediately, without waiting for the cache TTL', async () => {
    /**
     * M13 (`invalidateBranding()` removed from `updateBranding`) SURVIVES, and
     * it is EQUIVALENT — proven, not assumed.
     *
     * Why: `updateBranding()` returns `getRestaurantBranding(id, {fresh:true})`,
     * and a fresh resolve RE-CACHES its result. So the entry is replaced with
     * the new value on the very next line whether or not it was invalidated
     * first. Probed directly: cache size stays 1 and the cached read returns
     * the new name either way.
     *
     * The cache is NOT self-healing in general, which is why the call stays.
     * Probed with a write that bypasses the service entirely:
     *     stale cached read: Probe          (no invalidation)
     *     after invalidate  : DIRECT WRITE
     * So any future path that mutates branding without going through
     * `updateBranding()` needs its own invalidation, and removing the existing
     * call would make this equivalence depend on an unrelated return value.
     *
     * What is asserted here is the OBSERVABLE guarantee: after an update, a
     * cached read returns the new value.
     */
    assert.ok(await getRestaurantBranding(world.restaurant._id));

    await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {displayName: 'Cache Bust A'}
    });
    assert.equal((await getRestaurantBranding(world.restaurant._id)).displayName, 'Cache Bust A');

    await request('/api/my/restaurant/branding', {
      method: 'PATCH', token: owner(), body: {displayName: 'Cache Bust B'}
    });
    const shell = await request('/api/my/branding', {token: staff()});
    assert.equal(shell.body.displayName, 'Cache Bust B');
  });

  it('goes stale WITHOUT invalidation, which is why the call must stay', async () => {
    // A write that bypasses the service, standing in for a future path that
    // forgets to invalidate. This is the evidence that the cache does not
    // self-heal and that M13's equivalence is incidental, not structural.
    await getRestaurantBranding(third.restaurant._id);
    await Restaurant.updateOne(
      {_id: third.restaurant._id}, {$set: {'branding.displayName': 'DIRECT WRITE'}});

    assert.notEqual((await getRestaurantBranding(third.restaurant._id)).displayName, 'DIRECT WRITE',
      'the cache unexpectedly self-healed; the TTL may have elapsed');
    invalidateBranding(third.restaurant._id);
    assert.equal((await getRestaurantBranding(third.restaurant._id)).displayName, 'DIRECT WRITE');
  });

  it('invalidates the cache after a PLATFORM edit too', async () => {
    assert.ok(await getRestaurantBranding(rival.restaurant._id));
    await request(`/api/platform/restaurants/${rival.restaurant._id}/branding`, {
      method: 'PATCH', token: admin(), body: {displayName: 'Platform Bust', reason: 'ticket'}
    });
    assert.equal((await getRestaurantBranding(rival.restaurant._id)).displayName, 'Platform Bust');
  });

  it('resolves the tenant from STORAGE, so a request-supplied id is inert', async () => {
    /**
     * M2 made the tenant path prefer `user.restaurantId`. It survived, and it
     * is EQUIVALENT: `authenticate()` overwrites `req.user.restaurantId` from
     * `principal.restaurantId`, which `loadPrincipal()` reads from the
     * database. So the two expressions are the same value by construction, and
     * a caller cannot influence either.
     *
     * Asserted as a property rather than left as prose: if a future change
     * ever lets a token claim survive into `req.user.restaurantId`, this
     * fails.
     */
    const source = readFileSync(new URL('../src/middleware/auth.js', import.meta.url), 'utf8');
    assert.match(source, /restaurantId: principal\.restaurantId/,
      'req.user.restaurantId must be overwritten from the stored principal');

    // Behavioural control: a token whose claim disagrees with storage is
    // refused outright, so a forged tenant id cannot even reach a handler.
    const forged = tokenFor(world.owner, {restaurantId: String(rival.restaurant._id)});
    const res = await request('/api/my/restaurant/branding', {token: forged});
    assert.equal(res.status, 200);
    // Still their OWN restaurant, not the one in the claim.
    const own = await Restaurant.findById(world.restaurant._id).lean();
    assert.equal(res.body.identity.name, own.name);
  });

  it('keeps escaping angle brackets even if one escape rule is lost', () => {
    /**
     * M4 replaced the `&` rule with a no-op and survived. That is REDUNDANCY,
     * not a hole: `<`, `>`, `"`, `'` and `/` are each escaped independently,
     * so a script payload is still neutralised. The `&` rule exists to stop
     * double-decoding, not to stop tags.
     *
     * Documented with a direct assertion so the layering is explicit.
     */
    const html = renderReceiptHtml(buildReceipt({
      order: {
        _id: new mongoose.Types.ObjectId(), orderNo: 'A', type: 'counter', status: 'completed',
        items: [], subtotal: 0, vat: 0, total: 0, vatRate: 13
      },
      restaurant: {name: '<script>x</script>', currency: 'NPR', pan: '1'},
      branch: {name: 'B', code: 'B', pan: '1'},
      payments: []
    }));
    assert.ok(!html.includes('<script>x'), 'the tag survived escaping');
  });

  it('refuses a dangerous scheme by name AND by allowlist — two layers', () => {
    /**
     * M7 removed the allowlist and survived, because `DANGEROUS_SCHEMES`
     * catches `javascript:`, `data:` and `vbscript:` first. The allowlist is
     * the backstop for everything else (`ftp:`, `gopher:`, a future scheme
     * nobody has thought of), so both are kept.
     */
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x']) {
      assert.throws(() => assertSafeUrl(value, 'logoUrl'), /must not use the/,
        `${value} should be caught by the dangerous-scheme layer`);
    }
    for (const value of ['ftp://x.test/a.png', 'gopher://x.test/1']) {
      assert.throws(() => assertSafeUrl(value, 'logoUrl'), /http or https/,
        `${value} should be caught by the allowlist layer`);
    }
  });
});

// ── 14. a PRE-EXISTING defect found during P2D (reported, not silently fixed) ─

describe('P2D · audit-chain finding (pre-existing, NOT introduced by P2D)', () => {
  /**
   * FOUND DURING P2D VERIFICATION, PRESENT SINCE P2A. Reported rather than
   * quietly redesigned, per the standing instruction to stop and report a
   * serious finding before a broad unrelated change.
   *
   * WHAT HAPPENS
   * `verifyAuditChain()` reports `type: 'content'` — the signature of a
   * TAMPERED row — on any audit row whose `before`/`after` contained an
   * `undefined` value at write time.
   *
   * WHY
   * `auditPayload()` canonicalises `undefined` to `null` and hashes it. MongoDB
   * then DROPS undefined keys when the document is saved. At verification the
   * row no longer has those keys, so the recomputed payload differs from the
   * one that was hashed, and the hashes disagree. Proven directly:
   *     write-time payload before-block: {legalName:null, name:'X', pan:'111', slug:null}
   *     stored    payload before-block: {name:'X', pan:'111'}
   *     >>> payloads differ: true
   *
   * IT IS A FALSE ALARM, NOT A BREACH. Nothing was altered; the hash simply
   * covers fields the database declines to store. But a tamper-evidence
   * mechanism that cries wolf is worse than useless — an investigator learns
   * to ignore it — so it needs fixing properly, in the audit subsystem, with
   * a decision about existing rows (they cannot be re-hashed without
   * destroying the very evidence the chain provides).
   *
   * CONFIRMED PRE-EXISTING: the same probe reproduces identically against the
   * P2C commit 164b108, with P2D not present at all.
   *
   * P2D'S OWN WRITERS ARE IMMUNE — `diffOf()` coerces with `?? null` before
   * storing, so no undefined ever reaches the payload. Asserted below so that
   * property cannot regress while the underlying issue is outstanding.
   */
  it('keeps the chain verifiable across every P2D audit writer', async () => {
    const {verifyAuditChain} = await import('../src/services/auditTrail.js');
    const user = {id: String(third.owner._id), role: 'owner'};

    await updateBranding({user, patch: {displayName: 'Chain A', primaryColor: '#aa0000'}});
    await updateBranding({user, patch: {storefrontTitle: 'Chain T', accentColor: '#00bb00'}});
    await updateSettings({user, patch: {kds: {ticketColumns: 5}}});
    await request('/api/my/restaurant/domain', {
      method: 'PATCH', token: tokenFor(third.owner), body: {domain: 'chain.example.com'}
    });

    const result = await verifyAuditChain({user});
    assert.equal(result.verified, true,
      `P2D writers broke the chain: ${JSON.stringify(result.problems)}`);
    assert.ok(result.checked >= 4);
  });

  it('stores no undefined in a branding audit payload — the property that keeps it clean', async () => {
    await updateBranding({
      user: {id: String(world.owner._id), role: 'owner'},
      patch: {displayName: 'Undefined Probe'}
    });
    const row = await Audit.findOne({action: 'branding_updated'}).lean();
    assert.ok(row);
    for (const block of [row.before, row.after]) {
      for (const [key, value] of Object.entries(block || {})) {
        assert.notEqual(value, undefined, `${key} was stored as undefined`);
      }
    }
  });
});
