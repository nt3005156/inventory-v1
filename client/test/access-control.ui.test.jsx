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
    {key: 'cashier', name: 'Cashier', baseRole: 'staff', permissions: ['orders.create', 'payments.take'], builtin: false, assignedCount: 3},
    // A second staff-based built-in, so reassignment has a valid target.
    {key: 'staff', name: 'Staff', baseRole: 'staff', permissions: ['orders.view'], builtin: true, assignedCount: 4}
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
      permissions: ['roles.manage', 'users.manage', 'users.create', 'users.deactivate', 'users.password'],
      ...props
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

  it('creates an account through the API with the chosen role and branch', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await setValue(container.querySelector('input[aria-label="New name"]'), 'Sunita Gurung');
    await setValue(container.querySelector('input[aria-label="New email"]'), 'sunita@test.com');
    await setValue(container.querySelector('input[aria-label="New password"]'), 'Str0ngPassw0rd');
    await setValue(container.querySelector('select[aria-label="New role"]'), 'cashier');
    await setValue(container.querySelector('select[aria-label="New branch"]'), 'b2');
    await click(findButton('Create account'));

    const post = log.find(entry => entry.path === '/accounts' && entry.options.method === 'POST');
    assert.ok(post, 'expected a POST /accounts');
    const body = JSON.parse(post.options.body);
    assert.equal(body.name, 'Sunita Gurung');
    assert.equal(body.email, 'sunita@test.com');
    assert.equal(body.role, 'cashier');
    assert.equal(body.branch, 'b2');
    assert.equal(body.password, 'Str0ngPassw0rd');
  });

  it('never offers owner as a creatable role', async () => {
    await render({});
    const select = container.querySelector('select[aria-label="New role"]');
    assert.ok(![...select.options].some(option => option.value === 'owner'),
      'an owner account must not be creatable from the roster');
  });

  it('shows the API validation error verbatim when creation is refused', async () => {
    const call = async (path, options = {}) => {
      if (options.method === 'POST' && path === '/accounts') {
        throw new Error('An account with that email already exists');
      }
      return makeCall({}, [])(path, options);
    };
    await render({call});
    await setValue(container.querySelector('input[aria-label="New name"]'), 'Dupe');
    await setValue(container.querySelector('input[aria-label="New email"]'), 'dupe@test.com');
    await setValue(container.querySelector('input[aria-label="New password"]'), 'Str0ngPassw0rd');
    await click(findButton('Create account'));
    assert.match(container.textContent, /already exists/);
  });

  it('requires an explicit confirmation before deactivating an account', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Deactivate'));
    // Nothing must have been sent yet — the first click only asks.
    assert.equal(log.filter(e => e.options.method === 'PATCH').length, 0);
    assert.match(container.textContent, /sessions end immediately/i);

    await click(findButton('Confirm'));
    const patch = log.find(e => e.path === '/accounts/u1/active');
    assert.ok(patch, 'expected the deactivation PATCH after confirming');
    assert.equal(JSON.parse(patch.options.body).active, false);
  });

  it('lets a cancelled confirmation send nothing', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Deactivate'));
    await click(findButton('Cancel'));
    assert.equal(log.filter(e => e.path === '/accounts/u1/active').length, 0);
  });

  it('offers reactivation for a deactivated account without confirmation', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Reactivate'));
    const patch = log.find(e => e.path === '/accounts/u2/active');
    assert.ok(patch, 'expected the reactivation PATCH');
    assert.equal(JSON.parse(patch.options.body).active, true);
  });

  it('hides account creation and deactivation without those permissions', async () => {
    // A manager holds users.manage but not users.create/users.deactivate.
    await render({permissions: ['users.manage'], user: {role: 'manager', name: 'M'}});
    assert.equal(container.querySelector('input[aria-label="New name"]'), null);
    assert.equal(findButton('Create account'), undefined);
    assert.equal(findButton('Deactivate'), undefined);
    // The roster itself is still readable.
    assert.match(container.textContent, /People/);
  });

  it('shows built-in roles as protected system roles with no delete control', async () => {
    await render({});
    const rows = [...container.querySelectorAll('tbody tr')];
    const ownerRow = rows.find(row => row.textContent.includes('Owner'));
    assert.match(ownerRow.textContent, /system role/i);
    assert.match(ownerRow.textContent, /protected/i);
    assert.equal([...ownerRow.querySelectorAll('button')].some(b => b.textContent === 'Delete'), false);
  });

  it('requires confirmation before deleting an unused role', async () => {
    const log = [];
    // Override /roles so the cashier role has no holders.
    const unheld = {
      ...ROLES,
      roles: ROLES.roles.map(role => role.key === 'cashier' ? {...role, assignedCount: 0} : role)
    };
    await render({call: makeCall({'/roles': unheld}, log)});
    await click(findButton('Delete'));
    // The first click only asks; nothing must be sent.
    assert.equal(log.filter(e => e.options.method === 'DELETE').length, 0);
    assert.match(container.textContent, /Nobody holds it/i);

    await click(findButton('Confirm delete'));
    const del = log.find(e => e.options.method === 'DELETE');
    assert.ok(del, 'expected the DELETE after confirming');
    assert.equal(del.path, '/roles/cashier');
  });

  it('demands a reassignment target when the role is still held', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    // CATALOGUE gives cashier assignedCount 3.
    await click(findButton('Delete'));
    assert.match(container.textContent, /3 account\(s\) hold/i);
    // No plain confirm button while holders exist — a target must be chosen.
    assert.equal(findButton('Confirm delete'), undefined);

    const select = container.querySelector('select[aria-label="Reassign Cashier to"]');
    assert.ok(select, 'expected a reassignment picker');
    // Only same-base-role, non-owner options may be offered.
    const values = [...select.options].map(option => option.value).filter(Boolean);
    assert.ok(!values.includes('owner'));
    assert.ok(!values.includes('manager'), 'a manager-based role must not be offered for a staff role');
    assert.ok(values.includes('staff'));

    await setValue(select, 'staff');
    await click(findButton('Reassign and delete'));
    const del = log.find(e => e.options.method === 'DELETE');
    assert.equal(del.path, '/roles/cashier?reassignTo=staff');
  });

  it('surfaces an API refusal to delete a role in use', async () => {
    const call = async (path, options = {}) => {
      if (options.method === 'DELETE') {
        throw new Error('3 account(s) still hold this role. Reassign them first.');
      }
      return makeCall({}, [])(path, options);
    };
    await render({call});
    await click(findButton('Delete'));
    await setValue(container.querySelector('select[aria-label="Reassign Cashier to"]'), 'staff');
    await click(findButton('Reassign and delete'));
    assert.match(container.textContent, /still hold this role/);
  });

  it('resets a password without ever echoing it back', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Reset password'));
    const input = container.querySelector('input[aria-label="New password for Sita Rai"]');
    assert.ok(input);
    assert.equal(input.type, 'password', 'the field must be masked');

    await setValue(input, 'BrandNewP4ssword');
    await click(findButton('Set password'));

    const post = log.find(e => e.path === '/accounts/u1/password');
    assert.ok(post, 'expected the reset POST');
    assert.equal(JSON.parse(post.options.body).password, 'BrandNewP4ssword');
    // After the reset the field is cleared and the plaintext is not rendered.
    assert.doesNotMatch(container.textContent, /BrandNewP4ssword/);
    assert.match(container.textContent, /sessions have ended/i);
  });

  it('will not submit a password shorter than the policy minimum', async () => {
    const log = [];
    await render({call: makeCall({}, log)});
    await click(findButton('Reset password'));
    await setValue(container.querySelector('input[aria-label="New password for Sita Rai"]'), 'short');
    const submit = findButton('Set password');
    assert.equal(submit.disabled, true, 'a too-short password must not be submittable');
    assert.equal(log.filter(e => e.path === '/accounts/u1/password').length, 0);
  });

  it('hides password reset without users.password', async () => {
    await render({permissions: ['users.manage'], user: {role: 'manager', name: 'M'}});
    assert.equal(findButton('Reset password'), undefined);
  });
});
