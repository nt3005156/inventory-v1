/**
 * Phase 23 — notification centre screen.
 *
 * Read-only over an API that nobody can write to from a client. These check
 * the tabs, the unread badge, mark-read / mark-all-read, and that unimplemented
 * channels are shown honestly rather than as delivered.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let Notifications;
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
  Notifications = (await import('../src/Notifications.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const INBOX = {
  notifications: [
    {
      _id: 'n1', type: 'payment_received', title: 'Order ORD-1 paid',
      body: 'cash · Rs 395.50', severity: 'info', read: false, kind: 'event',
      reference: 'ORD-1', branch: 'b1', branchName: 'Kathmandu Branch', user: null,
      delivery: [
        {channel: 'in_app', status: 'delivered'},
        {channel: 'email', status: 'skipped', reason: 'No email provider is configured'}
      ],
      createdAt: '2026-08-20T04:00:00.000Z'
    },
    {
      _id: 'n2', type: 'supplier_invoice_due', title: 'Everest invoice INV-9 is overdue',
      body: 'Rs 1130.00 outstanding', severity: 'critical', read: true, kind: 'event',
      reference: 'INV-9', branch: null, branchName: null, user: null,
      delivery: [{channel: 'in_app', status: 'delivered'}],
      createdAt: '2026-08-19T04:00:00.000Z'
    }
  ],
  unreadCount: 1,
  pagination: {page: 1, limit: 25, total: 2, pages: 1},
  scope: 'restaurant'
};

const TYPES = {
  types: [
    {key: 'payment_received', label: 'Payment received', severity: 'info', roles: ['owner']},
    {key: 'supplier_invoice_due', label: 'Supplier invoice due', severity: 'warning', roles: ['owner']}
  ],
  channels: [
    {channel: 'in_app', implemented: true},
    {channel: 'email', implemented: false},
    {channel: 'sms', implemented: false},
    {channel: 'push', implemented: false}
  ]
};

const BRANCHES = [{_id: 'b1', name: 'Kathmandu Branch'}, {_id: 'b2', name: 'Lalitpur Branch'}];

function makeCall(overrides = {}, log = []) {
  return async (path, options = {}) => {
    log.push({path, options});
    for (const [key, value] of Object.entries(overrides)) {
      if (path.startsWith(key)) return typeof value === 'function' ? value() : value;
    }
    if (path.startsWith('/notifications/types')) return TYPES;
    if (path.startsWith('/notifications/read-all')) return {updated: 1, unread: 0};
    if (path.startsWith('/notifications')) return INBOX;
    return null;
  };
}

async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Notifications, {
      call: makeCall(), user: {role: 'owner', name: 'Owner'},
      permissions: ['notifications.view'], branches: BRANCHES, ...props
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

describe('Notification centre', () => {
  it('renders notifications with their severity, reference and time', async () => {
    await render({});
    assert.match(container.textContent, /Order ORD-1 paid/);
    assert.match(container.textContent, /cash · Rs 395\.50/);
    assert.match(container.textContent, /critical/);
    assert.match(container.textContent, /ref ORD-1/);
    // Kathmandu local: 04:00Z is 09:45 local.
    assert.match(container.textContent, /2026-08-20 09:45/);
  });

  it('shows the unread badge', async () => {
    await render({});
    const badge = [...container.querySelectorAll('span')]
      .find(node => node.textContent.trim() === '1' && node.style.borderRadius === '999px');
    assert.ok(badge, 'an unread count badge must be shown');
  });

  it('defaults to the unread tab and switches tabs through the API', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    assert.match(log[0].path, /unread=true/, 'unread is the default view');

    await click(findButton('Read'));
    assert.match([...log].reverse().find(e => e.path.startsWith('/notifications?')).path, /unread=false/);

    await click(findButton('All'));
    const all = [...log].reverse().find(e => e.path.startsWith('/notifications?')).path;
    assert.doesNotMatch(all, /unread=/, 'the All tab sends no unread filter');
  });

  it('marks one notification read', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Mark read'));
    const patch = log.find(entry => entry.path === '/notifications/n1/read');
    assert.ok(patch, 'expected a PATCH for the unread item');
    assert.deepEqual(JSON.parse(patch.options.body), {read: true});
  });

  it('marks an already-read notification unread again', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Mark unread'));
    const patch = log.find(entry => entry.path === '/notifications/n2/read');
    assert.deepEqual(JSON.parse(patch.options.body), {read: false});
  });

  it('marks everything read and reports how many changed', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Mark all read'));
    assert.ok(log.some(entry => entry.path.startsWith('/notifications/read-all')));
    assert.match(container.textContent, /Marked 1 notification\(s\) read/);
  });

  it('disables mark-all when there is nothing unread', async () => {
    await render({call: makeCall({'/notifications?': {...INBOX, unreadCount: 0}})});
    assert.equal(findButton('Mark all read').disabled, true);
  });

  it('shows channel delivery honestly, including skipped ones', async () => {
    // Only in-app is implemented; the UI must not imply an email was sent.
    await render({});
    assert.match(container.textContent, /in_app:delivered/);
    assert.match(container.textContent, /email:skipped/);
  });

  it('filters by type from the API catalogue rather than a hard-coded list', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    const select = container.querySelector('select[aria-label="Type"]');
    const values = [...select.options].map(option => option.value).filter(Boolean);
    assert.deepEqual(values, ['payment_received', 'supplier_invoice_due']);

    await setValue(select, 'supplier_invoice_due');
    assert.match([...log].reverse().find(e => e.path.startsWith('/notifications?')).path,
      /type=supplier_invoice_due/);
  });

  it('offers a branch filter to an owner only', async () => {
    await render({});
    assert.ok(container.querySelector('select[aria-label="Branch"]'));
    await render({user: {role: 'manager', name: 'M'}, permissions: ['notifications.view']});
    assert.equal(container.querySelector('select[aria-label="Branch"]'), null);
  });

  it('offers no control that creates a notification', async () => {
    // Forging "payment received" into an inbox must be impossible; there is no
    // write endpoint, so the screen must not suggest one.
    await render({});
    const labels = [...container.querySelectorAll('button')].map(b => b.textContent.trim().toLowerCase());
    for (const forbidden of ['create', 'new notification', 'send', 'add']) {
      assert.ok(!labels.includes(forbidden), `must not offer "${forbidden}"`);
    }
  });

  it('tells a user without the permission that the centre is closed, and calls nothing', async () => {
    let called = false;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Notifications, {
        call: async () => { called = true; return INBOX; },
        user: {role: 'staff'}, permissions: []
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(container.textContent, /do not have access/i);
    assert.equal(called, false);
  });

  it('surfaces an API failure instead of an empty list', async () => {
    const call = async path => {
      if (path.startsWith('/notifications?')) throw new Error('Insufficient permission');
      return makeCall()(path);
    };
    await render({call});
    assert.match(container.textContent, /Insufficient permission/);
  });

  it('says so plainly when the unread tab is empty', async () => {
    await render({
      call: makeCall({'/notifications?': {
        notifications: [], unreadCount: 0,
        pagination: {page: 1, limit: 25, total: 0, pages: 1}, scope: 'restaurant'
      }})
    });
    assert.match(container.textContent, /Nothing unread/);
  });
});
