/**
 * P2D — branding UI.
 *
 * NOT SECURITY TESTS. The frontend is not the security boundary, and nothing
 * here may be cited as evidence that it is: every server-side refusal is
 * proved in `server/test/p2d.branding.whitelabel.test.js`. What these check is
 * that the client cannot be tricked into WRITING a dangerous value into the
 * document — an injected colour or font stack would be a client-side hole
 * whatever the server does — and that a tenant is not offered controls their
 * plan does not include.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let BrandSettings;
let applyBranding;
let brandInitials;
let DEFAULT_THEME;
let container;
let root;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://localhost/', pretendToBeVisual: true
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.Event = dom.window.Event;
  global.MouseEvent = dom.window.MouseEvent;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  React = (await import('react')).default;
  ({createRoot} = await import('react-dom/client'));
  ({act} = await import('react'));
  BrandSettings = (await import('../src/BrandSettings.jsx')).default;
  ({applyBranding, brandInitials, DEFAULT_THEME} = await import('../src/branding.js'));
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  // Reset any theme a previous test applied.
  document.documentElement.style.cssText = '';
});

const ENTERPRISE = {
  branding: {
    displayName: 'AAA Biryani', primaryColor: '#aa0000', receiptFooter: 'Thank you'
  },
  resolved: {displayName: 'AAA Biryani', primaryColor: '#aa0000'},
  identity: {
    name: 'AAA Biryani', legalName: 'AAA Pvt Ltd', pan: '301234567',
    address: 'Kalanki', phone: '01-444', currency: 'NPR', timezone: 'Asia/Kathmandu'
  },
  customDomain: {domain: null, verified: false, serving: false},
  tiers: {core: true, advanced: true, white: true, customDomain: true},
  editable: {core: true, advanced: true, white: true, customDomain: true}
};

const STARTER = {
  ...ENTERPRISE,
  tiers: {core: true, advanced: false, white: false, customDomain: false},
  editable: {core: true, advanced: false, white: false, customDomain: false}
};

function stubCall(routes) {
  const calls = [];
  const call = async (path, opts = {}) => {
    calls.push({path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null});
    const match = Object.keys(routes)
      .filter(prefix => path.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (match) {
      const value = routes[match];
      return typeof value === 'function' ? value(path, opts) : value;
    }
    throw new Error(`Unstubbed request: ${path}`);
  };
  return {call, calls};
}

async function render(element) {
  await act(async () => { root = createRoot(container); root.render(element); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => container.textContent;
const buttons = () => [...container.querySelectorAll('button')];
const buttonNamed = name => buttons().find(b => b.textContent.trim() === name);
const inputFor = label => container.querySelector(`[aria-label="${label}"]`);

const setInput = async (el, value) => {
  await act(async () => {
    const proto = el.tagName === 'SELECT'
      ? global.window.HTMLSelectElement.prototype
      : global.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new global.window.Event(el.tagName === 'SELECT' ? 'change' : 'input',
      {bubbles: true}));
  });
};

// ── applyBranding: the only code that writes tenant values into the DOM ──────

describe('P2D UI · applyBranding refuses unsafe values', () => {
  it('sets custom properties from a valid theme', () => {
    const theme = applyBranding({
      primaryColor: '#112233', accentColor: '#445566', displayName: 'Tenant A'
    });
    assert.equal(theme.primary, '#112233');
    assert.equal(document.documentElement.style.getPropertyValue('--brand-primary'), '#112233');
    assert.equal(document.title, 'Tenant A');
  });

  it('falls back to the product default for an injected colour', () => {
    /**
     * The server already refuses these, so this is defence in depth: a
     * compromised or mistaken API response must not be able to write CSS.
     */
    for (const evil of [
      '#fff; background:url(https://evil.test/x)',
      'red',
      'expression(alert(1))',
      '</style><script>alert(1)</script>',
      'var(--x)',
      null,
      12345
    ]) {
      const theme = applyBranding({primaryColor: evil});
      assert.equal(theme.primary, DEFAULT_THEME.primaryColor, `${evil} was written as a colour`);
      assert.equal(
        document.documentElement.style.getPropertyValue('--brand-primary'),
        DEFAULT_THEME.primaryColor
      );
    }
  });

  it('refuses a font stack containing a declaration terminator', () => {
    applyBranding({fontStack: "Arial; } body { background: url(https://evil.test/) "});
    assert.equal(document.documentElement.style.getPropertyValue('--brand-font'), '');
    // Control: a clean stack IS applied.
    applyBranding({fontStack: 'Georgia, serif'});
    assert.equal(document.documentElement.style.getPropertyValue('--brand-font'), 'Georgia, serif');
  });

  it('only sets a favicon from an http(s) URL', () => {
    applyBranding({faviconUrl: 'javascript:alert(1)'});
    assert.equal(document.querySelector("link[rel='icon']"), null);

    applyBranding({faviconUrl: 'https://cdn.test/icon.png'});
    assert.equal(document.querySelector("link[rel='icon']").getAttribute('href'),
      'https://cdn.test/icon.png');
  });

  it('produces initials when there is no logo', () => {
    assert.equal(brandInitials('AAA Biryani House'), 'AH');
    assert.equal(brandInitials('Mittho'), 'MI');
    assert.equal(brandInitials(''), '??');
    assert.equal(brandInitials(null), '??');
  });
});

// ── the settings screen ──────────────────────────────────────────────────────

describe('P2D UI · brand settings screen', () => {
  it('loads the tenant\'s own stored values', async () => {
    const {call} = stubCall({'/my/restaurant/branding': ENTERPRISE});
    await render(<BrandSettings call={call}/>);
    assert.equal(inputFor('Display name').value, 'AAA Biryani');
    assert.equal(inputFor('Receipt footer').value, 'Thank you');
  });

  it('renders a live preview without issuing any request', async () => {
    const stub = stubCall({'/my/restaurant/branding': ENTERPRISE});
    await render(<BrandSettings call={stub.call} />);
    const before = stub.calls.length;

    await setInput(inputFor('Display name'), 'Renamed Live');
    assert.match(text(), /Renamed Live/);
    // The preview is a pure function of form state — no fetch, no invoice.
    assert.equal(stub.calls.length, before, 'the preview issued a request');
  });

  it('previews the receipt without allocating an invoice number', async () => {
    const stub = stubCall({'/my/restaurant/branding': ENTERPRISE});
    await render(<BrandSettings call={stub.call}/>);
    assert.match(text(), /PAN: 301234567/);
    assert.match(text(), /Preview only\. Nothing is saved and no invoice number is issued/);
    assert.ok(!stub.calls.some(c => c.method !== 'GET'), 'the preview wrote something');
  });

  it('disables fields the plan does not include, and says why', async () => {
    const {call} = stubCall({'/my/restaurant/branding': STARTER});
    await render(<BrandSettings call={call}/>);
    assert.equal(inputFor('Display name').disabled, false, 'core must stay editable');
    assert.equal(inputFor('Title').disabled, true, 'storefront title needs advancedBranding');
    assert.equal(inputFor('Hide product branding').disabled, true);
    assert.match(text(), /Professional plan/);
    assert.match(text(), /Enterprise plan/);
  });

  it('never sends a field the plan excludes', async () => {
    const stub = stubCall({
      '/my/restaurant/branding': (path, opts) =>
        (opts.method === 'PATCH' ? {branding: {}, resolved: {}, changed: []} : STARTER)
    });
    await render(<BrandSettings call={stub.call}/>);
    await setInput(inputFor('Display name'), 'Starter Rename');
    await act(async () => { buttonNamed('Save branding').click(); });
    await act(async () => { await Promise.resolve(); });

    const sent = stub.calls.find(c => c.method === 'PATCH');
    assert.ok(sent, 'nothing was sent');
    assert.equal(sent.body.displayName, 'Starter Rename');
    assert.equal('storefrontTitle' in sent.body, false, 'an out-of-plan field was sent');
    assert.equal('hideProductBranding' in sent.body, false);
  });

  it('refuses to save an invalid colour or URL', async () => {
    const stub = stubCall({'/my/restaurant/branding': ENTERPRISE});
    await render(<BrandSettings call={stub.call}/>);
    await setInput(inputFor('Logo URL'), 'javascript:alert(1)');
    const before = stub.calls.length;
    await act(async () => { buttonNamed('Save branding').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /Check these fields/);
    assert.equal(stub.calls.length, before, 'an invalid value was sent to the server');
  });

  it('reports an unsaved-change state', async () => {
    const {call} = stubCall({'/my/restaurant/branding': ENTERPRISE});
    await render(<BrandSettings call={call}/>);
    assert.ok(!text().includes('Unsaved changes'));
    assert.equal(buttonNamed('Save branding').disabled, true, 'save is enabled with nothing to save');

    await setInput(inputFor('Tagline'), 'New tagline');
    assert.match(text(), /Unsaved changes/);
    assert.equal(buttonNamed('Save branding').disabled, false);
  });

  it('surfaces a server refusal rather than pretending it saved', async () => {
    const stub = stubCall({
      '/my/restaurant/branding': (path, opts) => {
        if (opts.method === 'PATCH') throw new Error('Not included in the starter plan');
        return ENTERPRISE;
      }
    });
    await render(<BrandSettings call={stub.call}/>);
    await setInput(inputFor('Tagline'), 'x');
    await act(async () => { buttonNamed('Save branding').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /Not included in the starter plan/);
  });

  it('reports success after a save', async () => {
    const stub = stubCall({
      '/my/restaurant/branding': (path, opts) => (opts.method === 'PATCH'
        ? {branding: {displayName: 'Saved Name'}, resolved: {}, changed: ['displayName']}
        : ENTERPRISE)
    });
    await render(<BrandSettings call={stub.call}/>);
    await setInput(inputFor('Display name'), 'Saved Name');
    await act(async () => { buttonNamed('Save branding').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /Saved 1 change/);
  });

  it('escapes tenant text rather than rendering it as markup', async () => {
    const {call} = stubCall({
      '/my/restaurant/branding': {
        ...ENTERPRISE,
        branding: {displayName: '<img src=x onerror=alert(1)>', receiptFooter: '<b>bold</b>'}
      }
    });
    await render(<BrandSettings call={call}/>);
    // React escapes by default; assert no element was actually created.
    assert.equal(container.querySelector('img[src="x"]'), null);
    assert.equal(container.querySelector('b'), null);
    assert.match(text(), /<b>bold<\/b>/);
  });
});
