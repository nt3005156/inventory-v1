/**
 * Phase 24 — the rider notification centre.
 *
 * The rider shell reads `/notifications/mine`, the SELF-SCOPED endpoint. These
 * tests check the states a courier on a bike actually hits (loading, empty,
 * error, expired session, offline/reconnecting), the unread badge, mark-read
 * and mark-all-read — and, most importantly, that the component never calls
 * the branch-scoped endpoint and never sends a user id of its own.
 *
 * The server is authoritative regardless; this is about the client not asking
 * for data it must not have.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let RiderApp;
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
  RiderApp = (await import('../src/RiderApp.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const DASHBOARD = {
  rider: {name: 'Rider A', active: true, available: true},
  deliveries: [], workload: 0, capacity: 3, atCapacity: false,
  today: {delivered: 2, failed: 0}
};

const INBOX = {
  notifications: [
    {
      _id: 'n1', type: 'delivery_update', title: 'A delivery has been assigned to you',
      body: 'Kalanki, Kathmandu', severity: 'info', read: false, kind: 'event',
      reference: 'ORD-1234567', branch: 'b1', branchName: 'Kathmandu Branch',
      user: 'rider-a', delivery: [{channel: 'in_app', status: 'delivered'}],
      createdAt: '2026-08-20T04:00:00.000Z'
    },
    {
      _id: 'n2', type: 'delivery_update', title: 'A delivery was cancelled',
      body: null, severity: 'info', read: true, kind: 'event',
      reference: 'ORD-1234500', branch: 'b1', branchName: 'Kathmandu Branch',
      user: 'rider-a', delivery: [{channel: 'in_app', status: 'delivered'}],
      createdAt: '2026-08-19T04:00:00.000Z'
    }
  ],
  unreadCount: 1,
  pagination: {page: 1, limit: 25, total: 2, pages: 1},
  scope: 'self'
};

function makeCall(overrides = {}, log = []) {
  const call = async (path, options = {}) => {
    log.push({path, options});
    for (const [key, value] of Object.entries(overrides)) {
      if (path.startsWith(key)) {
        return typeof value === 'function' ? value(path, options) : value;
      }
    }
    if (path.startsWith('/notifications/mine/read-all')) return {updated: 1, unread: 0};
    if (/^\/notifications\/mine\/[^/]+\/read/.test(path)) return {...INBOX.notifications[0], read: true};
    if (path.startsWith('/notifications/mine')) return INBOX;
    if (path.startsWith('/deliveries/mine/dashboard')) return DASHBOARD;
    if (path.startsWith('/deliveries/mine')) return [];
    return null;
  };
  call.log = log;
  return call;
}

async function render(props = {}) {
  const log = [];
  const call = props.call || makeCall({}, log);
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(RiderApp, {
      call, user: {name: 'Rider A', role: 'rider'}, token: '', onLogout: () => {}, ...props
    }));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return {container, log: call.log || log};
}

function findButton(label) {
  return [...container.querySelectorAll('button')]
    .find(button => button.textContent.trim() === label);
}

function findByTestId(id) {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function click(button) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function openAlerts() {
  await click(findByTestId('rider-notifications-tab'));
}

describe('Phase 24 · rider notification centre', () => {
  it('reads only the self-scoped endpoint, never the branch inbox', async () => {
    // The heart of this phase. A rider must not even ASK for branch data.
    const {log} = await render();
    const paths = log.map(entry => entry.path);
    assert.ok(paths.some(p => p.startsWith('/notifications/mine')), 'reads its own inbox');
    for (const path of paths) {
      assert.ok(
        !/^\/notifications(\?|$|\/(?!mine))/.test(path),
        `must not call the branch-scoped notification API: ${path}`
      );
      assert.ok(!path.includes('/notifications/types'), 'the catalogue is branch-scoped');
      assert.ok(!path.includes('/notifications/read-all') || path.includes('/mine/'),
        'must not call branch mark-all-read');
    }
  });

  it('never sends a user, rider or recipient identifier', async () => {
    // Identity comes from the token. If the client ever started sending one,
    // it would be a short step to sending somebody else's.
    const {log} = await render();
    await openAlerts();
    const markAll = findByTestId('rider-mark-all');
    if (markAll && !markAll.disabled) await click(markAll);

    for (const {path, options} of log) {
      for (const key of ['userId', 'riderId', 'recipientId', 'user=']) {
        assert.ok(!path.includes(key), `${path} must not carry ${key}`);
      }
      if (options?.body) {
        const body = JSON.parse(options.body);
        for (const key of ['user', 'userId', 'riderId', 'recipientId', 'branch']) {
          assert.ok(!(key in body), `request body must not carry ${key}`);
        }
      }
    }
  });

  it('shows the unread count on the tab and lists the notifications', async () => {
    await render();
    const tab = findByTestId('rider-notifications-tab');
    assert.match(tab.textContent, /Alerts \(1\)/, 'unread badge');

    await openAlerts();
    const rows = container.querySelectorAll('[data-testid="rider-notification"]');
    assert.equal(rows.length, 2);
    assert.match(container.textContent, /A delivery has been assigned to you/);
    assert.match(container.textContent, /Kalanki, Kathmandu/, 'message body');
    assert.match(container.textContent, /Ref ORD-1234567/, 'entity reference');
    assert.match(container.textContent, /Delivery/, 'notification type label');
    assert.match(container.textContent, /1 unread/);

    // Read and unread are visually distinct, not merely both listed.
    assert.ok(rows[0].className.includes('is-unread'), 'the unread row is flagged');
    assert.ok(!rows[1].className.includes('is-unread'), 'the read row is not');
  });

  it('renders a timestamp for every notification', async () => {
    await render();
    await openAlerts();
    const rows = [...container.querySelectorAll('[data-testid="rider-notification"]')];
    for (const row of rows) {
      assert.match(row.textContent, /\d{2}:\d{2}/, 'a time is shown');
    }
  });

  it('marks one read and reloads from the server', async () => {
    const log = [];
    const call = makeCall({}, log);
    await render({call});
    await openAlerts();
    await click(findButton('Mark read'));

    const patch = log.find(entry => entry.options?.method === 'PATCH');
    assert.ok(patch, 'a PATCH was issued');
    assert.equal(patch.path, '/notifications/mine/n1/read');
    assert.deepEqual(JSON.parse(patch.options.body), {read: true});
    // Reloaded rather than trusting local state.
    assert.ok(log.filter(e => e.path.startsWith('/notifications/mine?')).length >= 2);
  });

  it('marks all read through the self-scoped route only', async () => {
    const log = [];
    const call = makeCall({}, log);
    await render({call});
    await openAlerts();
    await click(findByTestId('rider-mark-all'));

    const post = log.find(entry => entry.options?.method === 'POST');
    assert.ok(post, 'a POST was issued');
    assert.equal(post.path, '/notifications/mine/read-all',
      'must be the self-scoped route, not /notifications/read-all');
    assert.deepEqual(JSON.parse(post.options.body), {});
  });

  it('disables mark-all when there is nothing unread', async () => {
    const call = makeCall({'/notifications/mine': {...INBOX, unreadCount: 0}});
    await render({call});
    await openAlerts();
    assert.equal(findByTestId('rider-mark-all').disabled, true);
    assert.match(container.textContent, /All caught up/);
  });

  it('shows an empty state', async () => {
    const call = makeCall({
      '/notifications/mine': {notifications: [], unreadCount: 0, pagination: {}, scope: 'self'}
    });
    await render({call});
    await openAlerts();
    assert.ok(findByTestId('rider-inbox-empty'));
    assert.match(container.textContent, /No notifications yet/);
    assert.equal(container.querySelectorAll('[data-testid="rider-notification"]').length, 0);
  });

  it('shows an API error state with a retry that works', async () => {
    let fail = true;
    const call = makeCall({
      '/notifications/mine': () => {
        if (fail) throw new Error('Service unavailable');
        return INBOX;
      }
    });
    await render({call});
    await openAlerts();
    assert.ok(findByTestId('rider-inbox-error'));
    assert.match(container.textContent, /Service unavailable/);

    fail = false;
    await click(findButton('Try again'));
    assert.ok(findByTestId('rider-inbox'), 'recovered');
    assert.match(container.textContent, /A delivery has been assigned to you/);
  });

  it('keeps the delivery screen working when only the inbox fails', async () => {
    // A rider mid-job needs the address far more than the badge.
    const call = makeCall({
      '/notifications/mine': () => { throw new Error('Notifications unavailable'); }
    });
    await render({call});
    assert.match(container.textContent, /On shift/, 'the delivery screen still rendered');
    assert.match(container.textContent, /Delivered today/);
  });

  it('shows the expired-session screen when the inbox 401s', async () => {
    const call = makeCall({
      '/notifications/mine': () => { throw new Error('Authentication required'); }
    });
    await render({call});
    assert.match(container.textContent, /Session expired/);
    assert.ok(findButton('Sign in'), 'offers a re-login');
  });

  it('shows an offline notice on the inbox when the socket is not live', async () => {
    // `live` starts at 'offline' with no socket in the test environment.
    await render();
    await openAlerts();
    const notice = findByTestId('rider-inbox-live');
    assert.ok(notice, 'an offline/reconnecting notice is shown');
    assert.match(notice.textContent, /Offline|Reconnecting/);
  });

  it('renders no branch-wide notification data', async () => {
    // Defence in depth: even if the API were to return something branch-wide,
    // the rider screen must not render branch financial detail. The scope is
    // enforced server-side; this asserts the client is not a second leak.
    const call = makeCall({
      '/notifications/mine': {
        ...INBOX,
        notifications: [{
          ...INBOX.notifications[0],
          type: 'payment_received', title: 'BRANCH-PAYMENT-RS-40000',
          user: null, branchName: 'Kathmandu Branch'
        }]
      }
    });
    await render({call});
    await openAlerts();
    assert.ok(!container.textContent.includes('Kathmandu Branch'),
      'a branch name is not part of the rider view');
  });
});
