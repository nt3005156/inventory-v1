/**
 * Phase 19 — export workspace UI.
 *
 * Same harness as the other client suites: `node:test` + jsdom, no extra
 * framework. What matters here is that the screen downloads through an
 * AUTHENTICATED fetch (a bare anchor would 401), honours the branch and period
 * pickers in the URL it requests, and reports a server refusal instead of
 * saving the error body as a file.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let Exports;
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
  global.Blob = dom.window.Blob;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  // jsdom implements neither of these; a download needs both.
  dom.window.URL.createObjectURL = () => 'blob:mock';
  dom.window.URL.revokeObjectURL = () => {};
  global.URL = dom.window.URL;

  React = (await import('react')).default;
  ({createRoot} = await import('react-dom/client'));
  ({act} = await import('react'));
  Exports = (await import('../src/Exports.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const CATALOGUE = {
  datasets: [
    {key: 'sales', title: 'Sales', dateless: false, columns: ['Order No', 'Total']},
    {key: 'inventory', title: 'Inventory On Hand', dateless: true, columns: ['Branch', 'Qty On Hand']}
  ],
  formats: ['csv', 'xlsx', 'pdf'],
  // Two branches, so the owner default really is "All branches"; the
  // single-branch preselect is exercised separately below.
  branches: [
    {_id: 'b1', name: 'Kathmandu Branch', code: 'KTM'},
    {_id: 'b2', name: 'Lalitpur Branch', code: 'LTP'}
  ]
};

const ONE_BRANCH = {...CATALOGUE, branches: [CATALOGUE.branches[0]]};

const makeCall = (catalogue = CATALOGUE) => async path => {
  if (path.startsWith('/exports/datasets')) return catalogue;
  throw new Error(`unexpected call ${path}`);
};

/** Records every fetch and returns a successful file response. */
function recordingFetch(calls, {ok = true, status = 200, message = 'Nope', filename = 'mittho-sales-all.csv'} = {}) {
  return async (url, init) => {
    calls.push({url, init});
    if (!ok) {
      return {
        ok: false,
        status,
        headers: {get: () => ''},
        json: async () => ({message})
      };
    }
    return {
      ok: true,
      status: 200,
      headers: {get: name => (name === 'content-disposition' ? `attachment; filename="${filename}"` : '')},
      blob: async () => new global.Blob(['a,b\r\n'], {type: 'text/csv'})
    };
  };
}

async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(Exports, {
      call: makeCall(), token: 'tok-123', user: {role: 'owner', name: 'Owner'}, apiBase: '/api', ...props
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

/**
 * React installs its own `value` setter on the element, so assigning
 * `element.value` directly does not notify it. The native prototype setter has
 * to be used — and it must be the setter for the element's OWN class: calling
 * the HTMLInputElement one on a <select> throws
 * "'set value' called on an object that is not a valid instance".
 */
async function setValue(element, value) {
  const prototype = element.tagName === 'SELECT'
    ? window.HTMLSelectElement.prototype
    : window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
    element.dispatchEvent(new window.Event('change', {bubbles: true}));
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return element;
}

const setInput = (selector, value) => setValue(container.querySelector(selector), value);

describe('Exports screen', () => {
  it('renders the catalogue the server returned, with a card per dataset', async () => {
    await render({});
    assert.match(container.textContent, /Sales/);
    assert.match(container.textContent, /Inventory On Hand/);
    assert.match(container.textContent, /2 columns/);
    // A dateless dataset must say so, or a user will expect the period picker
    // to apply to it.
    assert.match(container.textContent, /current position, not a period/);
  });

  it('offers all three formats for every dataset', async () => {
    await render({});
    assert.equal([...container.querySelectorAll('button')].filter(b => b.textContent.trim() === 'CSV').length, 2);
    assert.equal([...container.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Excel').length, 2);
    assert.equal([...container.querySelectorAll('button')].filter(b => b.textContent.trim() === 'PDF').length, 2);
  });

  it('downloads through an AUTHENTICATED fetch, not a bare link', async () => {
    // The API is bearer-guarded, so an <a href> download would arrive with no
    // Authorization header and 401. This is the whole reason the screen goes
    // through fetch + Blob.
    const calls = [];
    global.fetch = recordingFetch(calls);
    await render({});
    await click(findButton('CSV'));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/exports/sales.csv');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
    assert.match(container.textContent, /Downloaded mittho-sales-all\.csv/);
  });

  it('puts the chosen branch and period into the export URL', async () => {
    const calls = [];
    global.fetch = recordingFetch(calls);
    await render({});
    await setInput('select', 'b1');
    const dates = container.querySelectorAll('input[type="date"]');
    await setValue(dates[0], '2026-08-01');
    await setValue(dates[1], '2026-08-20');

    await click(findButton('CSV'));
    assert.equal(calls[0].url, '/api/exports/sales.csv?branch=b1&from=2026-08-01&to=2026-08-20');
  });

  it('omits the period from a dateless dataset but keeps the branch', async () => {
    const calls = [];
    global.fetch = recordingFetch(calls);
    await render({});
    await setInput('select', 'b1');
    const inventoryCsv = [...container.querySelectorAll('button')]
      .filter(button => button.textContent.trim() === 'CSV')[1];
    await click(inventoryCsv);
    // Stock on hand is a position, not a period; sending from/to would imply
    // a historical valuation the endpoint does not compute.
    assert.equal(calls[0].url, '/api/exports/inventory.csv?branch=b1');
  });

  it('requests the report packs as PDFs', async () => {
    const calls = [];
    global.fetch = recordingFetch(calls);
    await render({});
    await click(findButton('Full management pack'));
    assert.equal(calls[0].url, '/api/exports/reports/full.pdf');
    await click(findButton('Profit and loss'));
    assert.equal(calls[1].url, '/api/exports/reports/pnl.pdf');
  });

  it('shows the server refusal instead of saving the error body as a file', async () => {
    const calls = [];
    let objectUrls = 0;
    global.URL.createObjectURL = () => { objectUrls += 1; return 'blob:mock'; };
    global.fetch = recordingFetch(calls, {ok: false, status: 403, message: 'Insufficient permission'});
    await render({});
    await click(findButton('CSV'));

    assert.match(container.textContent, /Insufficient permission/);
    // A JSON error body must never be handed to the browser as a download.
    assert.equal(objectUrls, 0);
    global.URL.createObjectURL = () => 'blob:mock';
  });

  it('preselects the only branch a manager can see', async () => {
    await render({call: makeCall(ONE_BRANCH), user: {role: 'manager', name: 'Manager'}});
    // No "All branches" option for a manager, and their branch is already
    // chosen so a first download cannot be scoped wider than they may see.
    const select = container.querySelector('select');
    assert.equal(select.value, 'b1');
    assert.equal([...select.options].some(option => option.value === ''), false);
  });

  it('offers an owner the all-branches scope', async () => {
    await render({});
    const select = container.querySelector('select');
    assert.equal([...select.options].some(option => option.value === ''), true);
  });

  it('tells a staff user the screen is not for them and calls nothing', async () => {
    // Presentation only — the backend 403 is the authoritative control — but
    // the screen must not fire requests that will certainly be refused.
    let called = false;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Exports, {
        call: async () => { called = true; return CATALOGUE; },
        token: 'tok', user: {role: 'staff'}, apiBase: '/api'
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(container.textContent, /available to managers and owners/);
    assert.equal(called, false);
  });

  it('reports a catalogue failure rather than rendering an empty screen', async () => {
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(Exports, {
        call: async () => { throw new Error('Authentication required'); },
        token: 'tok', user: {role: 'owner'}, apiBase: '/api'
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(container.textContent, /Authentication required/);
  });
});
