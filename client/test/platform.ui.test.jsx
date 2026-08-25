/**
 * P2B — platform administration screens.
 *
 * What these tests are for, and what they are NOT for.
 *
 * They check that the platform area renders the right things, hides controls
 * a read-only operator must not be offered, and refuses to submit a
 * suspension without a reason.
 *
 * They are NOT security tests. The frontend is not the security boundary and
 * these tests must never be cited as evidence that it is: every assertion
 * below is about presentation, and the corresponding server-side refusal is
 * proved in `server/test/p2b.platform.administration.test.js`. A hidden
 * button stops an honest operator from making a mistake; it stops an attacker
 * from nothing, because they never load this bundle.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let Platform;
let container;
let root;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/platform', pretendToBeVisual: true
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
  Platform = (await import('../src/Platform.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const SUPER_ADMIN = {
  platform: true,
  platformRole: 'super_admin',
  platformRoleName: 'Platform super administrator',
  permissions: [
    'platform.restaurants.view', 'platform.restaurants.create', 'platform.restaurants.update',
    'platform.restaurants.suspend', 'platform.restaurants.activate',
    'platform.users.view', 'platform.users.manage',
    'platform.audit.view', 'platform.dashboard.view', 'platform.admins.manage'
  ]
};

const SUPPORT = {
  platform: true,
  platformRole: 'platform_support',
  platformRoleName: 'Platform support',
  permissions: [
    'platform.restaurants.view', 'platform.users.view',
    'platform.audit.view', 'platform.dashboard.view'
  ]
};

const DASHBOARD = {
  restaurants: {total: 7, trial: 2, active: 3, suspended: 1, cancelled: 1, operational: 5},
  branches: {total: 11},
  users: {total: 40, active: 38, inactive: 2, platformOperators: 3},
  recentRestaurants: [
    {_id: 'r1', name: 'Rival Momo', slug: 'rival-momo', status: 'active', createdAt: '2026-08-01T00:00:00.000Z'}
  ],
  generatedAt: '2026-08-25T00:00:00.000Z'
};

const RESTAURANTS = {
  restaurants: [
    {
      _id: 'r1', name: 'Rival Momo', slug: 'rival-momo', status: 'active',
      branchCount: 2, userCount: 9, createdAt: '2026-08-01T00:00:00.000Z'
    },
    {
      _id: 'r2', name: 'Suspended Sekuwa', slug: 'suspended-sekuwa', status: 'suspended',
      branchCount: 1, userCount: 3, createdAt: '2026-07-01T00:00:00.000Z'
    }
  ],
  pagination: {page: 1, limit: 20, total: 2, pages: 1}
};

const USERS = {
  users: [
    {
      _id: 'u1', name: 'Rival Owner', email: 'rivalowner@test.com', role: 'owner',
      roleKey: null, platformRole: null, active: true,
      restaurant: {_id: 'r1', name: 'Rival Momo', slug: 'rival-momo', status: 'active'},
      branch: null
    },
    {
      _id: 'u2', name: 'Support Agent', email: 'support@saas.test', role: 'staff',
      roleKey: null, platformRole: 'platform_support', active: true,
      restaurant: null, branch: null
    }
  ],
  pagination: {page: 1, limit: 20, total: 2, pages: 1}
};

const AUDIT = {
  events: [
    {
      _id: 'a1', at: '2026-08-20T04:00:00.000Z', action: 'platform_restaurant_suspend',
      entity: 'restaurant', entityId: 'r2',
      restaurant: {_id: 'r2', name: 'Suspended Sekuwa', slug: 'suspended-sekuwa'},
      actor: {id: 'p1', name: 'Platform Admin', role: 'platform:platform_admin'},
      reason: 'Non-payment, 60 days', before: {status: 'active'}, after: {status: 'suspended'},
      ip: '203.0.113.9', sequence: 12, hash: 'abc'
    }
  ],
  actions: ['platform_restaurant_suspend', 'platform_user_deactivated'],
  pagination: {page: 1, limit: 20, total: 1, pages: 1}
};

/** A `call` stub that records every request the screen makes. */
function stubCall(routes) {
  const calls = [];
  const call = async (path, opts = {}) => {
    calls.push({path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null});
    for (const [prefix, value] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        if (typeof value === 'function') return value(path, opts);
        return value;
      }
    }
    throw new Error(`Unstubbed request: ${path}`);
  };
  return {call, calls};
}

async function render(element) {
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  // Let the effect-driven fetches settle.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

const text = () => container.textContent;
const buttons = () => [...container.querySelectorAll('button')];
const buttonNamed = name => buttons().find(b => b.textContent.trim() === name);

describe('P2B UI · the platform area is refused without platform authority', () => {
  it('shows a refusal, and no platform navigation, to a restaurant user', async () => {
    const {call, calls} = stubCall({});
    await render(
      <Platform call={call} user={{name: 'Owner'}}
        access={{platform: false, permissions: []}} onExit={() => {}}/>
    );
    assert.match(text(), /does not hold platform authority/);
    // Nothing was even requested: no dashboard, no restaurant list.
    assert.equal(calls.length, 0);
    // And it explains that being an owner is not the same thing.
    assert.match(text(), /Being an owner of a\s+restaurant does not grant it/);
  });

  it('treats an unresolved access object as no authority', async () => {
    // `/platform/me` failing must fail CLOSED in the UI too.
    const {call} = stubCall({});
    await render(<Platform call={call} user={{name: 'X'}} access={null} onExit={() => {}}/>);
    assert.match(text(), /does not hold platform authority/);
  });
});

describe('P2B UI · dashboard', () => {
  it('renders the aggregate figures', async () => {
    const {call} = stubCall({'/platform/dashboard': DASHBOARD});
    await render(
      <Platform call={call} user={{name: 'Super'}} access={SUPER_ADMIN} onExit={() => {}}/>
    );
    assert.match(text(), /Restaurants/);
    assert.match(text(), /Platform operators/);
    // The counts themselves.
    assert.ok(text().includes('11'), 'branch total missing');
    assert.ok(text().includes('40'), 'user total missing');
  });

  it('states plainly that no tenant financial data is shown', async () => {
    const {call} = stubCall({'/platform/dashboard': DASHBOARD});
    await render(
      <Platform call={call} user={{name: 'Super'}} access={SUPER_ADMIN} onExit={() => {}}/>
    );
    assert.match(text(), /No restaurant's sales, payments or customer data is shown/);
  });
});

describe('P2B UI · restaurants', () => {
  const routes = {
    '/platform/dashboard': DASHBOARD,
    '/platform/restaurants?': RESTAURANTS,
    '/platform/restaurants/r1': {
      _id: 'r1', name: 'Rival Momo', slug: 'rival-momo', status: 'active',
      legalName: 'Rival Momo Pvt Ltd', timezone: 'Asia/Kathmandu', branchCount: 2, userCount: 9,
      owner: {_id: 'u1', name: 'Rival Owner', email: 'rivalowner@test.com'},
      createdAt: '2026-08-01T00:00:00.000Z'
    },
    '/platform/restaurants/r2': {
      _id: 'r2', name: 'Suspended Sekuwa', slug: 'suspended-sekuwa', status: 'suspended',
      legalName: 'Sekuwa Pvt Ltd', timezone: 'Asia/Kathmandu', branchCount: 1, userCount: 3,
      owner: {_id: 'u9', name: 'Sekuwa Owner', email: 'sekuwa@test.com'},
      createdAt: '2026-07-01T00:00:00.000Z'
    }
  };

  const openRestaurants = async access => {
    const stub = stubCall(routes);
    await render(
      <Platform call={stub.call} user={{name: 'Op'}} access={access} onExit={() => {}}/>
    );
    await act(async () => { buttonNamed('Restaurants').click(); });
    await act(async () => { await Promise.resolve(); });
    return stub;
  };

  it('lists restaurants with status, branch and user counts', async () => {
    await openRestaurants(SUPER_ADMIN);
    assert.match(text(), /Rival Momo/);
    assert.match(text(), /Suspended Sekuwa/);
    assert.match(text(), /suspended/);
  });

  it('sends search and status filters to the server', async () => {
    const stub = await openRestaurants(SUPER_ADMIN);
    const search = container.querySelector('input[aria-label="Search restaurants"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        global.window.HTMLInputElement.prototype, 'value').set;
      setter.call(search, 'Rival');
      search.dispatchEvent(new global.window.Event('input', {bubbles: true}));
    });
    await act(async () => { await Promise.resolve(); });
    assert.ok(stub.calls.some(c => c.path.includes('q=Rival')),
      'the search term must reach the server, where filtering actually happens');
  });

  it('offers lifecycle controls to an operator who may use them', async () => {
    await openRestaurants(SUPER_ADMIN);
    await act(async () => { buttonNamed('Open').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.ok(buttonNamed('Suspend'), 'suspend control missing');
    assert.ok(buttonNamed('Activate'), 'activate control missing');
    assert.match(text(), /Rival Owner/);
  });

  it('hides lifecycle controls from a READ-ONLY support operator', async () => {
    await openRestaurants(SUPPORT);
    await act(async () => { buttonNamed('Open').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(buttonNamed('Suspend'), undefined);
    assert.equal(buttonNamed('Activate'), undefined);
    // They can still SEE the restaurant — that is the point of the role.
    assert.match(text(), /Suspended Sekuwa/);
  });

  it('refuses to submit a suspension with no reason', async () => {
    const stub = await openRestaurants(SUPER_ADMIN);
    await act(async () => { buttonNamed('Open').click(); });
    await act(async () => { await Promise.resolve(); });

    const before = stub.calls.length;
    await act(async () => { buttonNamed('Suspend').click(); });
    await act(async () => { await Promise.resolve(); });

    assert.match(text(), /reason is required/i);
    // Nothing was sent. The server would refuse it too; this just spares the
    // round trip and gives a clearer message.
    assert.equal(stub.calls.length, before, 'a reasonless suspension must not be sent');
  });

  it('sends the suspension with its reason once one is given', async () => {
    const stub = await openRestaurants(SUPER_ADMIN);
    await act(async () => { buttonNamed('Open').click(); });
    await act(async () => { await Promise.resolve(); });

    const reason = container.querySelector('input[aria-label="Reason"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        global.window.HTMLInputElement.prototype, 'value').set;
      setter.call(reason, 'Non-payment, 60 days');
      reason.dispatchEvent(new global.window.Event('input', {bubbles: true}));
    });
    await act(async () => { buttonNamed('Suspend').click(); });
    await act(async () => { await Promise.resolve(); });

    const sent = stub.calls.find(c => c.method === 'POST' && c.path.includes('/status'));
    assert.ok(sent, 'the suspension was not sent');
    assert.equal(sent.body.action, 'suspend');
    assert.equal(sent.body.reason, 'Non-payment, 60 days');
  });
});

describe('P2B UI · users', () => {
  const routes = {'/platform/dashboard': DASHBOARD, '/platform/users': USERS};

  const openUsers = async access => {
    const stub = stubCall(routes);
    await render(
      <Platform call={stub.call} user={{name: 'Op'}} access={access} onExit={() => {}}/>
    );
    await act(async () => { buttonNamed('Users').click(); });
    await act(async () => { await Promise.resolve(); });
    return stub;
  };

  it('shows identity, membership, role and platform standing', async () => {
    await openUsers(SUPER_ADMIN);
    assert.match(text(), /rivalowner@test.com/);
    assert.match(text(), /Rival Momo/);
    assert.match(text(), /platform_support/);
  });

  it('never renders a password field or hash', async () => {
    await openUsers(SUPER_ADMIN);
    assert.ok(!text().toLowerCase().includes('password'));
    assert.equal(container.querySelector('input[type="password"]'), null);
  });

  it('offers deactivation to an operator who may manage users', async () => {
    await openUsers(SUPER_ADMIN);
    assert.ok(buttonNamed('Deactivate'), 'deactivate control missing');
  });

  it('hides deactivation from a read-only support operator', async () => {
    await openUsers(SUPPORT);
    assert.equal(buttonNamed('Deactivate'), undefined);
    // ...but they still see the roster.
    assert.match(text(), /rivalowner@test.com/);
  });

  it('requires a reason before sending a deactivation', async () => {
    const stub = await openUsers(SUPER_ADMIN);
    await act(async () => { buttonNamed('Deactivate').click(); });
    await act(async () => { await Promise.resolve(); });

    const before = stub.calls.length;
    await act(async () => { buttonNamed('Confirm').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /reason is required/i);
    assert.equal(stub.calls.length, before);
  });

  it('offers no control that grants platform authority', async () => {
    await openUsers(SUPER_ADMIN);
    /**
     * Granting `platformRole` is the most dangerous operation in the system
     * and is deliberately absent from this screen — it is not something to
     * fat-finger while scrolling a user list.
     */
    for (const label of ['Make platform admin', 'Grant platform role', 'Promote']) {
      assert.equal(buttonNamed(label), undefined, `${label} must not be here`);
    }
    assert.match(text(), /granted separately from restaurant roles/);
  });
});

describe('P2B UI · audit', () => {
  it('renders platform actions with actor, reason and change', async () => {
    const {call} = stubCall({'/platform/dashboard': DASHBOARD, '/platform/audit': AUDIT});
    await render(
      <Platform call={call} user={{name: 'Op'}} access={SUPER_ADMIN} onExit={() => {}}/>
    );
    await act(async () => { buttonNamed('Audit').click(); });
    await act(async () => { await Promise.resolve(); });

    assert.match(text(), /platform_restaurant_suspend/);
    assert.match(text(), /Platform Admin/);
    assert.match(text(), /Non-payment, 60 days/);
    assert.match(text(), /Suspended Sekuwa/);
  });

  it('says plainly that tenant operational history is not shown here', async () => {
    const {call} = stubCall({'/platform/dashboard': DASHBOARD, '/platform/audit': AUDIT});
    await render(
      <Platform call={call} user={{name: 'Op'}} access={SUPER_ADMIN} onExit={() => {}}/>
    );
    await act(async () => { buttonNamed('Audit').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /A restaurant's own operational history stays with that restaurant/);
  });
});

describe('P2B UI · navigation reflects the operator\'s rank', () => {
  it('gives a support operator no page they cannot use', async () => {
    const {call} = stubCall({'/platform/dashboard': DASHBOARD});
    await render(
      <Platform call={call} user={{name: 'Support'}} access={SUPPORT} onExit={() => {}}/>
    );
    // All four pages are READ surfaces, so support sees all four...
    for (const label of ['Dashboard', 'Restaurants', 'Users', 'Audit']) {
      assert.ok(buttonNamed(label), `${label} missing`);
    }
    // ...and the role is named honestly in the chrome.
    assert.match(text(), /Platform support/);
  });

  it('hides a page whose permission the operator lacks', async () => {
    const {call} = stubCall({'/platform/dashboard': DASHBOARD});
    const narrow = {
      platform: true, platformRole: 'platform_support', platformRoleName: 'Platform support',
      permissions: ['platform.dashboard.view']
    };
    await render(
      <Platform call={call} user={{name: 'Narrow'}} access={narrow} onExit={() => {}}/>
    );
    assert.ok(buttonNamed('Dashboard'));
    assert.equal(buttonNamed('Restaurants'), undefined);
    assert.equal(buttonNamed('Users'), undefined);
    assert.equal(buttonNamed('Audit'), undefined);
  });
});
