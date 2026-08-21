/**
 * Phase 16C — Supplier Performance screen.
 *
 * Minimum critical coverage only, in the same style as the reorder tests:
 * `node:test` + jsdom, no extra framework. The backend already proves the
 * arithmetic; these prove the screen never presents an estimate as a fact.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let SupplierPerformance;
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
  SupplierPerformance = (await import('../src/SupplierPerformance.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const BRANCHES = [{_id: 'b1', name: 'Kathmandu Branch', code: 'KTM'}];
const SUPPLIERS = [{_id: 's1', name: 'Himalayan Foods'}];

async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(SupplierPerformance, {branches: BRANCHES, ...props}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container;
}

const text = () => container.textContent;

/** Selects a supplier, which is what triggers the performance fetch. */
async function selectSupplier(value = 's1') {
  const select = container.querySelector('select');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLSelectElement.prototype, 'value'
    ).set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', {bubbles: true}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

function makeCall(routes) {
  return async path => {
    for (const [match, handler] of Object.entries(routes)) {
      if (path.startsWith(match)) {
        return typeof handler === 'function' ? handler(path) : handler;
      }
    }
    return null;
  };
}

const measured = {
  supplier: {_id: 's1', name: 'Himalayan Foods', status: 'active'},
  totalPurchaseOrders: 12, receivedPurchaseOrders: 9,
  declaredLeadDays: 2,
  insufficientData: false,
  leadTimeSemantics: 'first_receipt',
  averageLeadDays: 5, medianLeadDays: 5, minLeadDays: 3, maxLeadDays: 8, samples: 9,
  averageFullLeadDays: 6, medianFullLeadDays: 6, fullyReceivedSamples: 7,
  partialFirstReceipts: 2,
  lateCount: 3, onTimeRate: 66.7,
  onTimeBasis: 'Compared against the expected delivery date or the promised lead time',
  leadTimeSource: 'measured',
  deliveries: [{
    purchaseOrder: 'po1', poNo: 'PO-1', approvedAt: '2026-08-01T00:00:00Z',
    receivedAt: '2026-08-06T00:00:00Z', actualLeadDays: 5, fullLeadDays: 6,
    promisedLeadDays: 2, late: true, partialFirstReceipt: true, fullyReceived: true
  }]
};

describe('Supplier Performance UI', () => {
  it('refuses the screen to staff without fetching', async () => {
    let called = false;
    await render({
      user: {role: 'staff'},
      call: makeCall({'/': () => { called = true; return SUPPLIERS; }})
    });
    assert.match(text(), /available to managers and owners/i);
    assert.equal(called, false, 'an unauthorised view must not fetch supplier data');
  });

  it('prompts for a supplier before loading anything', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({'/suppliers': SUPPLIERS, '/': () => null})
    });
    assert.match(text(), /Choose a supplier/i);
  });

  it('shows a loading state while the report is in flight', async () => {
    let resolveReport;
    const pending = new Promise(resolve => { resolveReport = resolve; });
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': () => pending,
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await act(async () => {
      const select = container.querySelector('select');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype, 'value'
      ).set;
      setter.call(select, 's1');
      select.dispatchEvent(new window.Event('change', {bubbles: true}));
    });
    assert.match(text(), /Loading/i);
    await act(async () => { resolveReport(measured); });
  });

  it('renders measured metrics and separates them from the catalog claim', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': measured,
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await selectSupplier();

    const body = text();
    assert.match(body, /Catalog lead time \(declared\)/i);
    assert.match(body, /Actual lead time \(measured\)/i);
    assert.match(body, /A claim, not a measurement/i, 'the distinction must be explicit');
    assert.match(body, /5d average/, 'measured average');
    assert.match(body, /Median 5d/);
    assert.match(body, /first receipt/i, 'the semantic must be named on screen');
    assert.match(body, /6d average/, 'fully-received figure alongside');
    assert.match(body, /66.7%/, 'on-time rate');
    assert.match(body, /PO-1/, 'the delivery table');
  });

  it('states insufficient data instead of showing a number', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': {
          supplier: {_id: 's1', name: 'Himalayan Foods'},
          totalPurchaseOrders: 1, receivedPurchaseOrders: 1,
          declaredLeadDays: 2, insufficientData: true, samples: 1,
          reason: 'Only 1 completed deliveries; 3 are required before an average is meaningful',
          averageLeadDays: null, medianLeadDays: null, onTimeRate: null,
          averageFullLeadDays: null, partialFirstReceipts: 0,
          onTimeBasis: 'No delivery carried a promised date, so punctuality cannot be judged',
          leadTimeSource: 'catalog_declared', deliveries: []
        },
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await selectSupplier();

    const body = text();
    assert.match(body, /Insufficient data/i);
    assert.match(body, /3 are required/, 'the reason is shown, not hidden');
    assert.match(body, /falls back to the catalog lead time/i);
    assert.ok(!/\d+d average/.test(body), 'no measured average may be rendered');
  });

  it('shows on-time as N/A with no promised date, and explains why', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': {
          ...measured,
          onTimeRate: null, lateCount: 0, judgedDeliveries: 0,
          onTimeBasis: 'No delivery carried a promised date, so punctuality cannot be judged',
          deliveries: [{...measured.deliveries[0], promisedLeadDays: null, late: false}]
        },
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await selectSupplier();

    const body = text();
    assert.match(body, /N\/A/, 'on-time must read N/A, never 0% or 100%');
    assert.match(body, /On-time rate N\/A/i);
    assert.match(body, /cannot be judged/i, 'with the reason stated');
    assert.match(body, /5d average/, 'lead time is still reported');
    assert.match(body, /none/, 'the promised column shows none for that delivery');
  });

  it('marks a still-short order rather than inventing a completion time', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': {
          ...measured,
          averageFullLeadDays: null, fullyReceivedSamples: 0, partialFirstReceipts: 1,
          deliveries: [{
            ...measured.deliveries[0], fullLeadDays: null, fullyReceived: false, partialFirstReceipt: true
          }]
        },
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await selectSupplier();
    assert.match(text(), /no order has completed yet/i);
    assert.match(text(), /partial/i);
  });

  it('surfaces an API failure instead of a blank screen', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': () => { throw new Error('Supplier not found'); },
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await selectSupplier();
    assert.match(text(), /Supplier not found/);
  });

  it('surfaces a permission failure from the API', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/suppliers/s1/performance': () => { throw new Error('Insufficient permission'); },
        '/suppliers': SUPPLIERS,
        '/': () => null
      })
    });
    await selectSupplier();
    assert.match(text(), /Insufficient permission/);
  });
});
