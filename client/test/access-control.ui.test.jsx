/**
 * Phase 20 — access control screen.
 *
 * The screen is a convenience over an API that enforces everything itself, so
 * these tests check that it renders what the server returned, sends the right
 * mutations, and — importantly — reports a server refusal rather than hiding
 * it. There is no assertion here that hiding a button provides security,
 * because it does not.
 */
import {after, before, beforeEach, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';

let React;
let createRoot;
let act;
let AccessControl;
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
  AccessControl = (await import('../src/AccessControl.jsx')).default;
});

after(() => { delete global.IS_REACT_ACT_ENVIRONMENT; });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

const ROLES = {
  roles: [
    {key: 'owner', name: 'Owner', baseRole: 'owner', permissions: [], builtin: true, unrestricted: true, assignedCount: 1},
    {key: 'manager', name: 'Manager', baseRole: 'manager', permissions: ['reports.view'], builtin: true, assignedCount: 2},
    {key: 'cashier', name: 'Cashier', baseRole: 'staff', permissions: ['orders.create', 'payments.take'], builtin: false, assignedCount: 3}
  ],
  permissions: [
    {key: 'orders.create', group: 'Orders', label: 'Create and edit orders'},
    {key: 'orders.refund', group: 'Orders', label: 'Refund a settled order'},
    {key: 'inventory.adjust', group: 'Inventory', label: 'Adjust stock levels'}
  ],
  templates: [
    {key: 'cashier', name: 'Cashier', baseRole: 'staff', permissions: ['orders.create']}
  ],
  baseRoles: ['manager', 'staff', 'rider']
};

const ACCOUNTS = [
  {_id: 'u1', name: 'Sita Rai', email: 'sita@test.com', role: 'staff', roleKey: 'cashier', branch: 'b1', active: true},
  {_id: 'u2', name: 'Hari Thapa', email: 'hari@test.com', role: 'manager', roleKey: null, branch: 'b1', active: false}
];

const BRANCHES = [{_id: 'b1', name: 'Kathmandu Branch'}, {_id: 'b2', name: 'Lalitpur Branch'}];

const AUDIT = {
  events: [
    {_id: 'a1', action: 'role_created', at: '2026-08-20T04:00:00.000Z', user: {name: 'Owner'}}
  ]
};

function makeCall(overrides = {}, log = []) {
  return async (path, options = {}) => {
    log.push({path, options});
    if (overrides[path]) {
      const value = overrides[path];
      return typeof value === 'function' ? value() : value;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (path.startsWith(key)) return typeof value === 'function' ? value() : value;
    }
    if (path.startsWith('/roles')) return ROLES;
    if (path.startsWith('/accounts')) return ACCOUNTS;
    if (path.startsWith('/branches')) return BRANCHES;
    if (path.startsWith('/rbac/audit')) return AUDIT;
    return null;
  };
}

async function render(props) {
  await act(async () => {
    root = createRoot(container);
    root.render(React.createElement(AccessControl, {
      call: makeCall(), user: {role: 'owner', name: 'Owner'},
      permissions: ['roles.manage', 'users.manage'], ...props
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

describe('Access control screen', () => {
  it('lists built-in and custom roles with their usage', async () => {
    await render({});
    assert.match(container.textContent, /Owner/);
    assert.match(container.textContent, /Cashier/);
    assert.match(container.textContent, /built-in/);
    assert.match(container.textContent, /custom/);
    // An owner's permission count is meaningless; it must read as everything.
    assert.match(container.textContent, /Everything/);
  });

  it('marks built-in roles as protected and offers no destructive control', async () => {
    await render({});
    const rows = [...container.querySelectorAll('tbody tr')];
    const ownerRow = rows.find(row => row.textContent.includes('Owner'));
    const cashierRow = rows.find(row => row.textContent.includes('Cashier'));
    assert.match(ownerRow.textContent, /protected/);
    assert.ok(![...ownerRow.querySelectorAll('button')].some(b => b.textContent === 'Delete'));
    // A custom role does get Edit and Delete.
    assert.ok([...cashierRow.querySelectorAll('button')].some(b => b.textContent === 'Delete'));
  });

  it('creates a role from the permission picker', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await setValue(container.querySelector('input[aria-label="Role name"]'), 'Storekeeper');
    const checkbox = [...container.querySelectorAll('input[type="checkbox"]')][2];
    await act(async () => {
      checkbox.dispatchEvent(new window.MouseEvent('click', {bubbles: true}));
    });
    await click(findButton('Create role'));

    const post = log.find(entry => entry.path === '/roles' && entry.options.method === 'POST');
    assert.ok(post, 'expected a POST /roles');
    const body = JSON.parse(post.options.body);
    assert.equal(body.name, 'Storekeeper');
    assert.deepEqual(body.permissions, ['inventory.adjust']);
  });

  it('prefills the form from a template', async () => {
    await render({});
    await click(findButton('Cashier'));
    assert.equal(container.querySelector('input[aria-label="Role name"]').value, 'Cashier');
    const checked = [...container.querySelectorAll('input[type="checkbox"]')].filter(box => box.checked);
    assert.equal(checked.length, 1);
  });

  it('locks the base role when editing, because it cannot be changed', async () => {
    // The API refuses a baseRole change (it would move every holder between
    // tenancy regimes), so the control must not invite one.
    await render({});
    await click(findButton('Edit'));
    assert.equal(container.querySelector('select[aria-label="Base role"]').disabled, true);
    assert.equal(container.querySelector('input[aria-label="Role name"]').value, 'Cashier');
  });

  it('reassigns a user role through the roster', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await setValue(container.querySelector('select[aria-label="Role for Sita Rai"]'), 'manager');
    const patch = log.find(entry => entry.path === '/users/u1/role');
    assert.ok(patch, 'expected a PATCH to the user role endpoint');
    assert.deepEqual(JSON.parse(patch.options.body), {role: 'manager'});
  });

  it('moves a user to another branch', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await setValue(container.querySelector('select[aria-label="Branch for Sita Rai"]'), 'b2');
    const patch = log.find(entry => entry.path === '/users/u1/role');
    assert.deepEqual(JSON.parse(patch.options.body), {branch: 'b2'});
  });

  it('never offers to reassign an owner', async () => {
    await render({});
    // Owner accounts are a deployment act; the API refuses it too.
    const select = container.querySelector('select[aria-label="Role for Hari Thapa"]');
    assert.ok(![...select.options].some(option => option.value === 'owner'));
  });

  it('shows deactivated accounts as such', async () => {
    await render({});
    const rows = [...container.querySelectorAll('tbody tr')];
    const hari = rows.find(row => row.textContent.includes('Hari Thapa'));
    assert.match(hari.textContent, /deactivated/);
  });

  it('surfaces a server refusal instead of pretending it succeeded', async () => {
    // The screen must never imply an action worked when the backend said no.
    const log = [];
    const call = async (path, options = {}) => {
      log.push({path, options});
      if (options.method === 'POST') {
        throw new Error('You cannot grant permissions you do not hold: monthclose.manage');
      }
      return makeCall({}, [])(path, options);
    };
    await render({call});
    await setValue(container.querySelector('input[aria-label="Role name"]'), 'Super Plus');
    await click(findButton('Create role'));
    assert.match(container.textContent, /cannot grant permissions you do not hold/);
  });

  it('renders the access-change trail', async () => {
    await render({});
    assert.match(container.textContent, /role created/);
    assert.match(container.textContent, /Owner/);
  });

  it('tells a user without the permission that the screen is closed', async () => {
    // Presentation only — the API refuses independently — but the screen must
    // not fire requests that will certainly 403.
    let called = false;
    await act(async () => {
      root = createRoot(container);
      root.render(React.createElement(AccessControl, {
        call: async () => { called = true; return ROLES; },
        user: {role: 'staff'}, permissions: ['orders.create']
      }));
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(container.textContent, /do not have permission/i);
    assert.equal(called, false);
  });

  it('shows the roster but no role editor to a user with only users.manage', async () => {
    await render({permissions: ['users.manage'], user: {role: 'manager', name: 'M'}});
    assert.match(container.textContent, /People/);
    // No role authoring surface without roles.manage.
    assert.equal(container.querySelector('input[aria-label="Role name"]'), null);
    assert.equal(findButton('Create role'), undefined);
  });
});
