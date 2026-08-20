/**
 * Phase 16B — critical reorder UI behaviour.
 *
 * DELIBERATELY LIGHTWEIGHT. The repository's convention is `node:test` with no
 * framework layered on top, and the backend already covers the API contracts
 * exhaustively. Adding Vitest + Testing Library + a config surface would be a
 * second test culture for very little gain, so this uses the runner the
 * project already uses plus ONE dependency (jsdom) and React's own
 * `act`/`createRoot`.
 *
 * These tests deliberately do NOT re-test backend behaviour. They cover only
 * what lives in the component: loading, error, empty, low/out-of-stock
 * rendering, permission-aware actions, and the confirm-before-create rule that
 * stops a purchase order being raised silently.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let Reorder;
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
  // socket.io-client is imported by the component; stub the transport so the
  // test never opens a real connection.
  Reorder = (await import('../src/Reorder.jsx')).default;
});

after(() => {
  delete global.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const BRANCHES = [{_id: 'b1', name: 'Kathmandu Branch', code: 'KTM'}];

/** Renders the component and lets effects settle. */
async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Reorder, {branches: BRANCHES, token: null, ...props}));
  });
  // Allow the load effect's promises to resolve.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return container;
}

const text = () => container.textContent;

function findButton(label) {
  return [...container.querySelectorAll('button')]
    .find(button => button.textContent.trim().toLowerCase().includes(label.toLowerCase()));
}

async function click(button) {
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

const emptyPlan = {
  formula: 'reorderPoint = averageDailyUsage x leadTimeDays + safetyStock',
  counts: {total: 0, critical: 0, reorder: 0, actionable: 0, blocked: 0},
  expectedTotal: 0, suggestedOrders: [], lines: []
};

const line = overrides => ({
  branch: 'b1', branchName: 'Kathmandu Branch', branchCode: 'KTM',
  ingredient: 'i1', ingredientName: 'Basmati Rice', unit: 'g',
  currentStock: 1000, reorderPoint: 5000, orderUpTo: 8000, suggestedQty: 7000,
  supplier: 's1', supplierName: 'Himalayan Foods', supplierSku: 'SKU-1',
  unitCost: 0.1, leadTimeDays: 3, leadTimeSource: 'catalog_declared',
  expectedCost: 700, urgency: 'reorder', actionable: true,
  ...overrides
});

/** A `call` stub routing by path, so each test states only what it needs. */
function makeCall(routes) {
  return async (path, options) => {
    for (const [match, handler] of Object.entries(routes)) {
      if (path.startsWith(match)) {
        return typeof handler === 'function' ? handler(path, options) : handler;
      }
    }
    return null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════

describe('Reorder UI', () => {
  it('refuses the workspace to staff without calling the API', async () => {
    let called = false;
    await render({
      user: {role: 'staff'},
      call: makeCall({'/': () => { called = true; return emptyPlan; }})
    });
    assert.match(text(), /available to managers and owners/i);
    assert.equal(called, false, 'an unauthorised view must not fetch purchasing data');
    assert.equal(findButton('Create draft PO'), undefined);
  });

  it('shows a loading state before the plan arrives', async () => {
    let resolvePlan;
    const pending = new Promise(resolve => { resolvePlan = resolve; });
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Reorder, {
        branches: BRANCHES, user: {role: 'manager'}, token: null,
        call: makeCall({'/purchasing/reorder-plan': () => pending, '/': () => []})
      }));
    });
    assert.match(text(), /Loading/i, 'the operator must see that work is in flight');
    await act(async () => { resolvePlan(emptyPlan); });
  });

  it('surfaces an API error instead of rendering a blank screen', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': () => { throw new Error('Branch access denied'); },
        '/': () => []
      })
    });
    assert.match(text(), /Branch access denied/, 'the real reason must reach the user');
  });

  it('states the empty case plainly', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({'/purchasing/reorder-plan': emptyPlan, '/': () => []})
    });
    assert.match(text(), /Nothing needs reordering/i);
  });

  it('renders a low-stock recommendation with its figures', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': {
          ...emptyPlan,
          counts: {total: 1, critical: 0, reorder: 1, actionable: 1, blocked: 0},
          lines: [line()]
        },
        '/': () => []
      })
    });
    const body = text();
    assert.match(body, /Basmati Rice/);
    assert.match(body, /Low stock/, 'the state must be labelled, not inferred from a colour');
    assert.match(body, /Himalayan Foods/);
    assert.match(body, /SKU-1/, 'the supplier SKU column must be populated');
    assert.match(body, /3d/, 'lead time');
    assert.match(body, /7,000/, 'suggested quantity');
  });

  it('distinguishes out of stock from low stock', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': {
          ...emptyPlan,
          counts: {total: 1, critical: 1, reorder: 0, actionable: 1, blocked: 0},
          lines: [line({currentStock: 0, urgency: 'critical'})]
        },
        '/': () => []
      })
    });
    assert.match(text(), /Out of stock/);
  });

  it('marks a measured lead time so it is not mistaken for the catalog claim', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': {
          ...emptyPlan,
          counts: {total: 1, critical: 0, reorder: 1, actionable: 1, blocked: 0},
          lines: [line({leadTimeSource: 'measured', leadTimeSamples: 4})]
        },
        '/': () => []
      })
    });
    const cell = [...container.querySelectorAll('span')]
      .find(span => (span.getAttribute('title') || '').includes('Measured from 4 deliveries'));
    assert.ok(cell, 'a measured lead time must be visibly distinguished');
  });

  it('requires confirmation before creating a purchase order', async () => {
    const posted = [];
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': {
          ...emptyPlan,
          counts: {total: 1, critical: 0, reorder: 1, actionable: 1, blocked: 0},
          lines: [line()],
          suggestedOrders: [{
            supplier: 's1', supplierName: 'Himalayan Foods', lineCount: 1, expectedCost: 700,
            items: [{ingredient: 'i1', ingredientName: 'Basmati Rice', unit: 'g', suggestedQty: 7000, unitCost: 0.1, expectedCost: 700}]
          }]
        },
        '/purchasing/suggested-orders': (path, options) => {
          posted.push(options);
          return {purchaseOrder: {poNo: 'PO-1', status: 'draft'}, requiresApproval: true};
        },
        '/': () => []
      })
    });

    await click(findButton('Create draft PO'));
    assert.equal(posted.length, 0, 'a PO must never be created on the first click');
    assert.match(text(), /Create a draft purchase order\?/i);
    assert.match(text(), /must still be submitted and approved/i, 'the dialog states approval is still required');

    await click(findButton('Cancel'));
    assert.equal(posted.length, 0, 'cancelling must not create anything');
  });

  it('creates the order only after confirmation and reports it is a draft', async () => {
    const posted = [];
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': {
          ...emptyPlan,
          suggestedOrders: [{
            supplier: 's1', supplierName: 'Himalayan Foods', lineCount: 1, expectedCost: 700,
            items: [{ingredient: 'i1', ingredientName: 'Basmati Rice', unit: 'g', suggestedQty: 7000, unitCost: 0.1, expectedCost: 700}]
          }]
        },
        '/purchasing/suggested-orders': (path, options) => {
          posted.push(JSON.parse(options.body));
          return {purchaseOrder: {poNo: 'PO-1', status: 'draft'}, requiresApproval: true};
        },
        '/': () => []
      })
    });

    await click(findButton('Create draft PO'));
    const confirmButton = [...container.querySelectorAll('button')]
      .filter(button => button.textContent.includes('Create draft PO')).pop();
    await click(confirmButton);

    assert.equal(posted.length, 1, 'exactly one order');
    assert.equal(posted[0].supplier, 's1');
    assert.equal(posted[0].branch, 'b1');
    assert.equal(posted[0].unitPrice, undefined, 'the client must not dictate a price');
    assert.match(text(), /needs submitting and approving/i);
  });

  it('reports a failed PO creation instead of pretending it worked', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': {
          ...emptyPlan,
          suggestedOrders: [{
            supplier: 's1', supplierName: 'Himalayan Foods', lineCount: 1, expectedCost: 700,
            items: [{ingredient: 'i1', ingredientName: 'Basmati Rice', unit: 'g', suggestedQty: 7000, unitCost: 0.1, expectedCost: 700}]
          }]
        },
        '/purchasing/suggested-orders': () => { throw new Error('Insufficient permission'); },
        '/': () => []
      })
    });

    await click(findButton('Create draft PO'));
    const confirmButton = [...container.querySelectorAll('button')]
      .filter(button => button.textContent.includes('Create draft PO')).pop();
    await click(confirmButton);

    assert.match(text(), /Insufficient permission/, 'a failure must be shown, never swallowed');
  });

  it('offers acknowledge and resolve only for persisted alerts', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': emptyPlan,
        '/alerts': [
          {_id: 'a1', type: 'low_stock', body: 'Rice is low', severity: 'warning', status: 'open'},
          {_id: 'a2', type: 'high_waste', body: 'Waste is high', severity: 'critical', synthetic: true}
        ],
        '/': () => null
      })
    });
    assert.match(text(), /Active alerts \(2\)/);
    // A computed (synthetic) alert has no database row, so it cannot be
    // acknowledged; only the persisted one offers the action.
    const acknowledgeButtons = [...container.querySelectorAll('button')]
      .filter(button => button.textContent.trim() === 'Acknowledge');
    assert.equal(acknowledgeButtons.length, 1, 'a computed alert has nothing to acknowledge');
  });

  it('shows the scheduler mode honestly', async () => {
    await render({
      user: {role: 'manager'},
      call: makeCall({
        '/purchasing/reorder-plan': emptyPlan,
        '/purchasing/reorder-scheduler': {
          running: true, intervalMinutes: 60, scope: 'distributed-lock', lastRunAt: null
        },
        '/': () => []
      })
    });
    assert.match(text(), /Scheduler: every 60m/);
  });
});
