/**
 * Phase 18 — reports workspace.
 *
 * Same lightweight approach as the other client tests: `node:test` + jsdom, no
 * extra framework. The backend proves the arithmetic; these prove the screen
 * renders what the API returned, gates on role, and reports failure honestly.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let AnalyticsReports;
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
  AnalyticsReports = (await import('../src/AnalyticsReports.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const BRANCHES = [{_id: 'b1', name: 'Kathmandu Branch', code: 'KTM'}];

async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(AnalyticsReports, {branches: BRANCHES, ...props}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container;
}

const text = () => container.textContent;

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

const PNL = {
  revenue: 1000, grossRevenue: 1100, refunds: 100, discounts: 50, vat: 130,
  cogs: 300, grossProfit: 700, purchases: 400, waste: 25, inventoryValue: 900, netProfit: 600
};
const SALES = {
  totals: {
    orders: 4, grossRevenue: 1100, refunds: 100, netRevenue: 1000,
    discounts: 50, vat: 130, serviceCharge: 0, cogs: 300, grossProfit: 700,
    averageOrderValue: 250
  },
  period: {granularity: 'daily'},
  byPeriod: [{period: '2026-08-20', orders: 4, netRevenue: 1000, grossProfit: 700}],
  byBranch: [], byOrderType: [],
  byItem: [{menuItem: 'm1', name: 'Chicken Biryani', category: 'Mains', qty: 6, revenue: 900, cogs: 200, grossProfit: 700}],
  byCategory: [{category: 'Mains', qty: 6, revenue: 900, cogs: 200, grossProfit: 700}],
  byPaymentMethod: [{method: 'cash', count: 3, amount: 700}, {method: 'khalti', count: 1, amount: 300}]
};
const INVENTORY = {
  stockValue: 900,
  movement: {transactions: 5, byType: [{type: 'RECIPE_DEDUCTION', count: 4, quantity: 1000, value: 45}]},
  waste: {value: 25, quantity: 100, events: 1, byIngredient: [{ingredient: 'i1', name: 'Basmati Rice', quantity: 100, value: 25}]},
  adjustments: {value: 10, quantity: 50, events: 1},
  countVariance: {counts: 1, varianceLines: 1, varianceValue: -18, recent: []},
  expiry: {expired: {count: 0, quantity: 0, value: 0}, expiring: {count: 2, quantity: 300, value: 60}, fresh: {count: 1, quantity: 500, value: 100}},
  topValue: [{ingredient: 'i1', name: 'Basmati Rice', unit: 'g', quantity: 20000, value: 900}]
};
const CUSTOMERS = {
  totals: {
    orders: 3, identifiedOrders: 2, anonymousOrders: 1, customers: 2,
    repeatCustomers: 1, repeatRate: 50,
    repeatBasis: 'More than one order within the reporting period',
    revenue: 1000, identifiedRevenue: 700, anonymousRevenue: 300,
    averageOrderValue: 333.33, averageIdentifiedOrderValue: 350
  },
  topCustomers: [{
    customer: 'c1', name: 'Regular Guest', phone: '9800000101',
    orders: 2, revenue: 700, averageOrderValue: 350, repeat: true
  }]
};

function makeCall(routes) {
  return async path => {
    for (const [match, handler] of Object.entries(routes)) {
      if (path.startsWith(match)) return typeof handler === 'function' ? handler(path) : handler;
    }
    return null;
  };
}

const allRoutes = (overrides = {}) => makeCall({
  '/reports/pnl': PNL,
  '/reports/sales': SALES,
  '/reports/inventory': INVENTORY,
  '/reports/customers': CUSTOMERS,
  ...overrides
});

describe('Reports UI', () => {
  it('refuses the workspace to staff without fetching', async () => {
    let called = false;
    await render({
      user: {role: 'staff'},
      call: makeCall({'/': () => { called = true; return PNL; }})
    });
    assert.match(text(), /available to managers and owners/i);
    assert.equal(called, false, 'an unauthorised view must not fetch revenue data');
  });

  it('shows the overview KPIs from the P&L', async () => {
    await render({user: {role: 'manager'}, call: allRoutes()});
    const body = text();
    assert.match(body, /Net revenue/);
    assert.match(body, /1,000\.00/, 'net revenue');
    assert.match(body, /1,100\.00/, 'gross revenue');
    assert.match(body, /Inventory value/);
    assert.match(body, /900\.00/);
    assert.match(body, /Gross profit/);
  });

  it('reports an API failure instead of a blank screen', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({'/reports/pnl': () => { throw new Error('Branch access denied'); }, '/': () => null})
    });
    assert.match(text(), /Branch access denied/);
  });

  it('shows sales breakdowns by item, category and payment method', async () => {
    await render({user: {role: 'manager'}, call: allRoutes()});
    await click(findButton('Sales'));
    const body = text();
    assert.match(body, /Chicken Biryani/);
    assert.match(body, /Mains/);
    assert.match(body, /cash/);
    assert.match(body, /khalti/, 'a second tender is listed separately');
    assert.match(body, /2026-08-20/, 'the period bucket');
  });

  it('switches granularity and re-queries', async () => {
    const asked = [];
    await render({
      user: {role: 'manager'},
      call: allRoutes({'/reports/sales': path => { asked.push(path); return SALES; }})
    });
    await click(findButton('Sales'));
    await click(findButton('weekly'));
    assert.ok(asked.some(path => path.includes('granularity=weekly')), 'the API is asked for weekly');
  });

  it('shows inventory value, waste, variance and expiry', async () => {
    await render({user: {role: 'manager'}, call: allRoutes()});
    await click(findButton('Inventory'));
    const body = text();
    assert.match(body, /Stock value/);
    assert.match(body, /Count variance/);
    assert.match(body, /Expiring soon/);
    assert.match(body, /RECIPE_DEDUCTION/, 'movement by ledger type');
    assert.match(body, /Basmati Rice/);
  });

  it('shows customer repeat rate with its basis stated', async () => {
    await render({user: {role: 'manager'}, call: allRoutes()});
    await click(findButton('Customers'));
    const body = text();
    assert.match(body, /Regular Guest/);
    assert.match(body, /50% of identified/);
    assert.match(body, /More than one order within the reporting period/,
      'an ambiguous metric must state its definition');
    assert.match(body, /Walk-in orders/);
  });

  it('states an empty period rather than rendering nothing', async () => {
    await render({
      user: {role: 'manager'},
      call: allRoutes({
        '/reports/sales': {
          ...SALES,
          totals: {...SALES.totals, orders: 0, netRevenue: 0},
          byPeriod: [], byItem: [], byCategory: [], byPaymentMethod: []
        }
      })
    });
    await click(findButton('Sales'));
    assert.match(text(), /No sales in this period/i);
    assert.match(text(), /No payments recorded/i);
  });
});
