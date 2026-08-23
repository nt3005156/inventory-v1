/**
 * Phase 21 — audit log screen.
 *
 * The screen is read-only over an append-only API. These tests check it
 * searches correctly, renders who/what/when/where, reports an integrity
 * failure honestly, and offers no control that could edit or delete a record.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let AuditLog;
let container;
let root;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
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
  AuditLog = (await import('../src/AuditLog.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const EVENTS = {
  events: [
    {
      _id: 'e1', at: '2026-08-20T04:00:00.000Z', action: 'menu_price_changed',
      entity: 'menu_items', entityId: 'm1', reference: 'Chicken Biryani',
      restaurant: 'r1', branch: 'b1',
      actor: {id: 'u1', name: 'Sita Rai', role: 'manager'},
      ip: '203.0.113.9', userAgent: 'Mozilla', reason: null,
      before: {price: 350}, after: {price: 425}, sequence: 4, hash: 'abc'
    },
    {
      _id: 'e2', at: '2026-08-20T03:00:00.000Z', action: 'login_failed',
      entity: 'auth', entityId: null, reference: 'ghost@nowhere.test',
      restaurant: 'r1', branch: null,
      actor: {id: null, name: null, role: null},
      ip: '198.51.100.4', userAgent: null, reason: 'Unknown account',
      before: null, after: {email: 'ghost@nowhere.test'}, sequence: 3, hash: 'def'
    }
  ],
  pagination: {page: 1, limit: 25, total: 2, pages: 1},
  scope: 'restaurant'
};

const ACTIONS = {
  actions: ['login', 'login_failed', 'menu_price_changed', 'stock_adjustment'],
  groups: {
    Authentication: ['login', 'login_failed'],
    Pricing: ['menu_price_changed'],
    Inventory: ['stock_adjustment']
  }
};

const ACCOUNTS = [
  {_id: 'u1', name: 'Sita Rai', email: 'sita@test.com', role: 'manager'},
  {_id: 'u2', name: 'Hari Thapa', email: 'hari@test.com', role: 'staff'}
];

const BRANCHES = [{_id: 'b1', name: 'Kathmandu Branch'}, {_id: 'b2', name: 'Lalitpur Branch'}];

function makeCall(overrides = {}, log = []) {
  return async (path, options = {}) => {
    log.push({path, options});
    for (const [key, value] of Object.entries(overrides)) {
      if (path.startsWith(key)) return typeof value === 'function' ? value() : value;
    }
    if (path.startsWith('/audit/actions')) return ACTIONS;
    if (path.startsWith('/audit/verify')) {
      return {verified: true, checked: 42, problems: [], problemCount: 0, guarantee: 'Detects tampering.'};
    }
    if (path.startsWith('/audit')) return EVENTS;
    if (path.startsWith('/accounts')) return ACCOUNTS;
    return null;
  };
}

async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(AuditLog, {
      call: makeCall(), user: {role: 'owner', name: 'Owner'},
      permissions: ['audit.view'], branches: BRANCHES, ...props
    }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container;
}

function findButton(label) {
  return [...container.querySelectorAll('button')]
    .find(button => button.textContent.trim() === label);
}

async function click(button) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function setValue(element, value) {
  const prototype = element.tagName === 'SELECT'
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('change', {bubbles: true}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

describe('Audit log screen', () => {
  it('renders who, what, when, reference and IP', async () => {
    await render({});
    assert.match(container.textContent, /Sita Rai/);
    assert.match(container.textContent, /menu_price_changed/);
    assert.match(container.textContent, /Chicken Biryani/);
    assert.match(container.textContent, /203\.0\.113\.9/);
    // Kathmandu local time: 04:00Z is 09:45 local.
    assert.match(container.textContent, /2026-08-20 09:45/);
  });

  it('summarises the before/after delta and reveals full detail on demand', async () => {
    await render({});
    assert.match(container.textContent, /price: 350 → 425/);
    assert.doesNotMatch(container.textContent, /"before"/, 'raw JSON stays hidden until asked for');
    await click([...container.querySelectorAll('button')].find(b => b.textContent.trim() === 'detail'));
    assert.match(container.textContent, /"before"/);
  });

  it('shows a system-originated event without an actor as "system"', async () => {
    await render({});
    assert.match(container.textContent, /system/);
    assert.match(container.textContent, /Unknown account/);
  });

  it('sends every filter to the API', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await setValue(container.querySelector('select[aria-label="Action"]'), 'login_failed');
    await setValue(container.querySelector('select[aria-label="User"]'), 'u1');
    await setValue(container.querySelector('select[aria-label="Branch"]'), 'b2');
    await setValue(container.querySelector('input[aria-label="Entity"]'), 'auth');
    await setValue(container.querySelector('input[aria-label="Reference"]'), 'INV-1');
    await setValue(container.querySelector('input[aria-label="From"]'), '2026-08-01');
    await setValue(container.querySelector('input[aria-label="To"]'), '2026-08-20');

    const last = [...log].reverse().find(entry => entry.path.startsWith('/audit?'));
    assert.match(last.path, /action=login_failed/);
    assert.match(last.path, /user=u1/);
    assert.match(last.path, /branch=b2/);
    assert.match(last.path, /entity=auth/);
    assert.match(last.path, /reference=INV-1/);
    assert.match(last.path, /from=2026-08-01/);
    assert.match(last.path, /to=2026-08-20/);
  });

  it('offers the action vocabulary from the API rather than a hard-coded copy', async () => {
    await render({});
    const select = container.querySelector('select[aria-label="Action"]');
    const values = [...select.options].map(option => option.value).filter(Boolean);
    assert.deepEqual(values.sort(), [...ACTIONS.actions].sort());
  });

  it('reports a verified chain', async () => {
    await render({});
    await click(findButton('Verify integrity'));
    assert.match(container.textContent, /chain verified/);
    assert.match(container.textContent, /42 record\(s\) checked/);
  });

  it('reports tampering loudly and lists the breaks', async () => {
    const call = makeCall({
      '/audit/verify': {
        verified: false, checked: 10,
        problems: [{type: 'content', sequence: 4, id: 'e1'}, {type: 'link', sequence: 5, id: 'e2'}],
        problemCount: 2, guarantee: 'Detects tampering.'
      }
    });
    await render({call});
    await click(findButton('Verify integrity'));
    assert.match(container.textContent, /tampering detected/);
    assert.match(container.textContent, /content/);
    assert.match(container.textContent, /sequence 4/);
    assert.doesNotMatch(container.textContent, /chain verified/);
  });

  it('offers no control that edits or deletes a record', async () => {
    // The API is append-only; the screen must not imply otherwise.
    await render({});
    const labels = [...container.querySelectorAll('button')].map(b => b.textContent.trim().toLowerCase());
    for (const forbidden of ['delete', 'edit', 'remove', 'purge', 'clear']) {
      assert.ok(!labels.includes(forbidden), `an audit screen must not offer "${forbidden}"`);
    }
  });

  it('hides the branch filter from a non-owner, who is server-scoped anyway', async () => {
    await render({user: {role: 'manager', name: 'M'}, permissions: ['audit.view']});
    assert.equal(container.querySelector('select[aria-label="Branch"]'), null);
  });

  it('tells a user without the permission that the screen is closed, and calls nothing', async () => {
    let called = false;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AuditLog, {
        call: async () => { called = true; return EVENTS; },
        user: {role: 'staff'}, permissions: []
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(container.textContent, /do not have permission/i);
    assert.equal(called, false);
  });

  it('surfaces an API error instead of rendering an empty table', async () => {
    const call = async path => {
      if (path.startsWith('/audit?')) throw new Error('Insufficient permission');
      return makeCall()(path);
    };
    await render({call});
    assert.match(container.textContent, /Insufficient permission/);
  });
});
