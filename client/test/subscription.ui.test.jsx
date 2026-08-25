/**
 * P2C — subscription screens, platform and tenant.
 *
 * NOT SECURITY TESTS. The frontend is not the security boundary and nothing
 * here may be cited as evidence that it is: every assertion is about
 * presentation, and the corresponding server-side refusal is proved in
 * `server/test/p2c.billing.subscriptions.test.js`. A hidden button stops an
 * honest operator from making a mistake; it stops an attacker from nothing,
 * because they never load this bundle.
 *
 * What these DO check is that money is never recomputed in the browser, that
 * `null` renders as "unlimited" rather than as a number, and that a read-only
 * operator is not offered controls that would 403.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let Platform;
let Subscription;
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
  Subscription = (await import('../src/Subscription.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const BILLING_ADMIN = {
  platform: true, platformRole: 'platform_admin', platformRoleName: 'Platform administrator',
  permissions: [
    'platform.restaurants.view', 'platform.users.view', 'platform.audit.view',
    'platform.dashboard.view', 'platform.billing.view', 'platform.billing.manage'
  ]
};

const BILLING_SUPPORT = {
  platform: true, platformRole: 'platform_support', platformRoleName: 'Platform support',
  permissions: [
    'platform.restaurants.view', 'platform.users.view', 'platform.audit.view',
    'platform.dashboard.view', 'platform.billing.view'
  ]
};

const PLANS = {
  plans: [
    {
      _id: 'p1', code: 'starter', name: 'Starter', description: 'One branch.',
      active: true, displayOrder: 1,
      monthlyPriceMinor: 350000, annualPriceMinor: 3500000, currency: 'NPR',
      monthlyPriceDisplay: 'NPR 3,500.00', annualPriceDisplay: 'NPR 35,000.00',
      trialDays: 14, subscriberCount: 12,
      limits: {maxBranches: 1, maxUsers: 8, maxTables: 20},
      features: {pos: true, apiAccess: false}
    },
    {
      _id: 'p2', code: 'enterprise', name: 'Enterprise', description: 'Unlimited.',
      active: true, displayOrder: 3,
      monthlyPriceMinor: 2000000, annualPriceMinor: 20000000, currency: 'NPR',
      monthlyPriceDisplay: 'NPR 20,000.00', annualPriceDisplay: 'NPR 200,000.00',
      trialDays: 30, subscriberCount: 3,
      limits: {maxBranches: null, maxUsers: null, maxTables: null},
      features: {pos: true, apiAccess: true}
    }
  ],
  limitKeys: ['maxBranches', 'maxUsers', 'maxTables'],
  featureKeys: ['pos', 'apiAccess']
};

const SUBSCRIPTIONS = {
  subscriptions: [
    {
      _id: 's1', status: 'active', trialEnd: null,
      currentPeriodEnd: '2026-09-20T00:00:00.000Z', cancelAtPeriodEnd: false,
      plan: {_id: 'p1', code: 'starter', name: 'Starter'},
      restaurant: {_id: 'r1', name: 'Rival Momo', slug: 'rival-momo', status: 'active'}
    },
    {
      _id: 's2', status: 'cancelled', trialEnd: null,
      currentPeriodEnd: '2026-07-01T00:00:00.000Z', cancelAtPeriodEnd: false,
      plan: {_id: 'p2', code: 'enterprise', name: 'Enterprise'},
      restaurant: {_id: 'r2', name: 'Lapsed Lassi', slug: 'lapsed', status: 'active'}
    }
  ],
  pagination: {page: 1, limit: 25, total: 2, pages: 1}
};

const DETAIL = {
  restaurant: {_id: 'r1', name: 'Rival Momo', status: 'active'},
  subscription: {
    _id: 's1', status: 'active', plan: PLANS.plans[0],
    trialEnd: null, currentPeriodEnd: '2026-09-20T00:00:00.000Z',
    cancelAtPeriodEnd: false, startDate: '2026-08-01T00:00:00.000Z'
  },
  entitlement: {operational: true, reason: 'ok', limits: {maxBranches: 1}, features: {pos: true}}
};

const HISTORY = {
  events: [
    {
      _id: 'e1', event: 'plan_changed', at: '2026-08-20T04:00:00.000Z',
      before: {planCode: 'starter'}, after: {planCode: 'enterprise'},
      reason: 'Customer upgraded',
      actor: {id: 'a1', name: 'Platform Admin', role: 'platform:platform_admin'}
    }
  ],
  pagination: {page: 1, limit: 50, total: 1, pages: 1},
  eventTypes: ['plan_changed']
};

const USAGE = {
  usage: {maxBranches: 1, maxUsers: 6, maxTables: 14},
  limits: {maxBranches: 1, maxUsers: 8, maxTables: null},
  features: {pos: true}
};

/**
 * The Platform shell mounts Dashboard first, so its stub must be a real shape.
 * My first attempt used `{}`, and the dashboard threw on `restaurants.total`
 * before any billing tab was reachable — a faulty stub, not a defect.
 */
const DASHBOARD = {
  restaurants: {total: 2, trial: 0, active: 2, suspended: 0, cancelled: 0, operational: 2},
  branches: {total: 3},
  users: {total: 9, active: 9, inactive: 0, platformOperators: 2},
  recentRestaurants: [],
  generatedAt: '2026-08-25T00:00:00.000Z'
};

const TENANT_ENTITLEMENTS = {
  planCode: 'starter', planName: 'Starter', status: 'active',
  operational: true, readOnly: true, reason: 'ok',
  trialEnd: null, currentPeriodEnd: '2026-09-20T00:00:00.000Z',
  features: {pos: true, inventory: true, apiAccess: false, loyalty: false},
  limits: {maxBranches: 1, maxUsers: 8, maxMenuItems: null, maxTables: 20},
  usage: {maxBranches: 1, maxUsers: 7, maxMenuItems: 45, maxTables: 20}
};

function stubCall(routes) {
  const calls = [];
  const call = async (path, opts = {}) => {
    calls.push({path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null});
    // Longest prefix wins, so '/platform/plans' does not shadow
    // '/platform/plans/:id' style routes registered later.
    const match = Object.keys(routes)
      .filter(prefix => path.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    if (match) return routes[match];
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

const setInput = async (el, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      global.window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new global.window.Event('input', {bubbles: true}));
  });
};

// ── platform: plans ──────────────────────────────────────────────────────────

describe('P2C UI · platform plan catalogue', () => {
  const routes = {'/platform/dashboard': DASHBOARD, '/platform/plans': PLANS};

  const openPlans = async access => {
    const stub = stubCall(routes);
    await render(<Platform call={stub.call} user={{name: 'Op'}} access={access} onExit={() => {}}/>);
    await act(async () => { buttonNamed('Plans').click(); });
    await act(async () => { await Promise.resolve(); });
    return stub;
  };

  it('renders the SERVER-formatted price and never recomputes it', async () => {
    const stub = await openPlans(BILLING_ADMIN);
    assert.match(text(), /NPR 3,500\.00/);
    assert.match(text(), /NPR 20,000\.00/);
    // The raw minor-unit integer must not be displayed as if it were rupees.
    assert.ok(!text().includes('350000'), 'minor units leaked into the UI as a price');
    assert.ok(!text().includes('3500.00'), 'the client appears to have divided money itself');
    assert.ok(stub.calls.some(c => c.path.startsWith('/platform/plans')));
  });

  it('shows tenant counts and retired status', async () => {
    await openPlans(BILLING_ADMIN);
    assert.match(text(), /starter/);
    assert.match(text(), /enterprise/);
    assert.ok(text().includes('12'), 'subscriber count missing');
  });

  it('renders null limits as "unlimited", never as a number', async () => {
    await openPlans(BILLING_ADMIN);
    // Open the Enterprise plan, whose limits are all null.
    const detailButtons = buttons().filter(b => b.textContent.trim() === 'Details');
    await act(async () => { detailButtons[1].click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /unlimited/);
    // The classic sentinel bugs.
    assert.ok(!text().includes('-1'), 'unlimited rendered as -1');
    assert.ok(!text().includes('999999'), 'unlimited rendered as a magic number');
  });

  it('tells a read-only operator that they cannot change plans', async () => {
    await openPlans(BILLING_SUPPORT);
    const detailButtons = buttons().filter(b => b.textContent.trim() === 'Details');
    await act(async () => { detailButtons[0].click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /Read only/i);
  });

  it('hides the Plans tab from an operator without billing visibility', async () => {
    const noBilling = {
      platform: true, platformRole: 'platform_support', platformRoleName: 'Support',
      permissions: ['platform.dashboard.view']
    };
    const stub = stubCall({'/platform/dashboard': DASHBOARD});
    await render(<Platform call={stub.call} user={{name: 'X'}} access={noBilling} onExit={() => {}}/>);
    assert.equal(buttonNamed('Plans'), undefined);
    assert.equal(buttonNamed('Subscriptions'), undefined);
  });
});

// ── platform: subscriptions ──────────────────────────────────────────────────

describe('P2C UI · platform subscription management', () => {
  const routes = {
    '/platform/dashboard': DASHBOARD,
    '/platform/plans': PLANS,
    '/platform/subscriptions': SUBSCRIPTIONS,
    '/platform/restaurants/r1/subscription/history': HISTORY,
    '/platform/restaurants/r1/subscription': DETAIL,
    '/platform/restaurants/r1/usage': USAGE
  };

  const openSubs = async access => {
    const stub = stubCall(routes);
    await render(<Platform call={stub.call} user={{name: 'Op'}} access={access} onExit={() => {}}/>);
    await act(async () => { buttonNamed('Subscriptions').click(); });
    await act(async () => { await Promise.resolve(); });
    return stub;
  };

  const openDetail = async access => {
    const stub = await openSubs(access);
    await act(async () => { buttonNamed('Open').click(); });
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    return stub;
  };

  it('lists subscriptions across tenants', async () => {
    await openSubs(BILLING_ADMIN);
    assert.match(text(), /Rival Momo/);
    assert.match(text(), /Lapsed Lassi/);
    assert.match(text(), /cancelled/);
  });

  it('sends a status filter to the server', async () => {
    const stub = await openSubs(BILLING_ADMIN);
    const select = container.querySelector('select[aria-label="Subscription status filter"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        global.window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'cancelled');
      select.dispatchEvent(new global.window.Event('change', {bubbles: true}));
    });
    await act(async () => { await Promise.resolve(); });
    assert.ok(stub.calls.some(c => c.path.includes('status=cancelled')),
      'filtering must happen on the server, not in the browser');
  });

  it('shows usage against limits, with unlimited rendered as a word', async () => {
    await openDetail(BILLING_ADMIN);
    assert.match(text(), /Usage against limits/);
    assert.match(text(), /unlimited/);
  });

  it('shows the append-only history and says it cannot be edited', async () => {
    await openDetail(BILLING_ADMIN);
    assert.match(text(), /plan_changed/);
    assert.match(text(), /Customer upgraded/);
    assert.match(text(), /append-only/i);
  });

  it('refuses to send a commercial change with no reason', async () => {
    const stub = await openDetail(BILLING_ADMIN);
    const before = stub.calls.length;
    await act(async () => { buttonNamed('Cancel at period end').click(); });
    await act(async () => { await Promise.resolve(); });
    assert.match(text(), /reason is required/i);
    assert.equal(stub.calls.length, before, 'a reasonless cancellation must not be sent');
  });

  it('sends the change with its reason once one is given', async () => {
    const stub = await openDetail(BILLING_ADMIN);
    await setInput(container.querySelector('input[aria-label="Reason"]'), 'Customer requested');
    await act(async () => { buttonNamed('Cancel at period end').click(); });
    await act(async () => { await Promise.resolve(); });

    const sent = stub.calls.find(c => c.method === 'POST' && c.path.includes('/cancel'));
    assert.ok(sent, 'the cancellation was not sent');
    assert.equal(sent.body.reason, 'Customer requested');
  });

  it('hides every management control from a read-only operator', async () => {
    await openDetail(BILLING_SUPPORT);
    for (const label of ['Assign plan', 'Extend trial', 'Cancel at period end', 'Reactivate']) {
      assert.equal(buttonNamed(label), undefined, `${label} must not be offered to support`);
    }
    // ...but the data is still visible, which is the point of the role.
    assert.match(text(), /Rival Momo/);
    assert.match(text(), /plan_changed/);
  });

  it('states that no payment is taken', async () => {
    await openDetail(BILLING_ADMIN);
    assert.match(text(), /No payment is taken or recorded here/i);
  });
});

// ── tenant view ──────────────────────────────────────────────────────────────

describe('P2C UI · tenant subscription view', () => {
  const renderTenant = async payload => {
    const {call, calls} = stubCall({'/my/entitlements': payload});
    await render(<Subscription call={call}/>);
    return calls;
  };

  it('shows plan, status, usage and features', async () => {
    await renderTenant(TENANT_ENTITLEMENTS);
    assert.match(text(), /Starter/);
    assert.match(text(), /active/i);
    assert.match(text(), /Branches/);
    assert.match(text(), /User accounts/);
    assert.match(text(), /pos/);
  });

  it('separates included from excluded features', async () => {
    await renderTenant(TENANT_ENTITLEMENTS);
    assert.match(text(), /Included in your plan/);
    assert.match(text(), /Not included/);
    assert.match(text(), /apiAccess/);
  });

  it('renders an unlimited limit as a word, not a bar', async () => {
    await renderTenant(TENANT_ENTITLEMENTS);
    // maxMenuItems is null in the fixture.
    assert.match(text(), /unlimited/);
  });

  it('explains a non-operational subscription in commercial terms', async () => {
    await renderTenant({
      ...TENANT_ENTITLEMENTS,
      status: 'expired', operational: false, reason: 'trial_expired'
    });
    assert.match(text(), /does not currently permit new records/i);
    assert.match(text(), /trial expired/i);
    // And reassures them their data is still there — the readOnly guarantee.
    assert.match(text(), /existing data remains available/i);
  });

  it('offers NO control that changes the subscription', async () => {
    await renderTenant(TENANT_ENTITLEMENTS);
    /**
     * There is no tenant-side write endpoint, so a button here would produce a
     * 403 and teach the owner the product is broken.
     */
    for (const label of ['Upgrade', 'Change plan', 'Cancel', 'Start trial', 'Pay now']) {
      assert.equal(buttonNamed(label), undefined, `${label} must not exist on the tenant screen`);
    }
    assert.equal(container.querySelector('select'), null);
    assert.match(text(), /This screen is read only/i);
  });

  it('never shows a payment or card entry surface', async () => {
    await renderTenant(TENANT_ENTITLEMENTS);
    assert.equal(container.querySelector('input[type="password"]'), null);
    const lower = text().toLowerCase();
    for (const word of ['card number', 'cvv', 'pay now', 'checkout']) {
      assert.ok(!lower.includes(word), `tenant screen offered "${word}" with no gateway behind it`);
    }
  });
});
