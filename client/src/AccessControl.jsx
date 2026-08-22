import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ShieldCheck} from 'lucide-react';

/**
 * Phase 20 — role, permission and user administration.
 *
 * This screen is a CONVENIENCE. Every control it renders is also enforced by
 * the backend: `requirePermission()` guards each endpoint and resolves the
 * caller's permissions from the database on every request. Hiding a button
 * here stops an honest mistake; it stops nothing else. The screen is written
 * on that assumption — it renders whatever the API allows and reports refusals
 * plainly rather than pretending they cannot happen.
 */

const groupBy = (items, key) => items.reduce((acc, item) => {
  (acc[item[key]] = acc[item[key]] || []).push(item);
  return acc;
}, {});

function Pill({children, tone = 'grey'}) {
  const tones = {
    grey: {background: '#f1f5f9', color: '#334155'},
    green: {background: '#dcfce7', color: '#166534'},
    amber: {background: '#fef3c7', color: '#92400e'}
  };
  return (
    <span style={{
      ...tones[tone], padding: '1px 7px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap'
    }}>{children}</span>
  );
}

export default function AccessControl({call, user, permissions = []}) {
  const canManageRoles = permissions.includes('roles.manage');
  const canManageUsers = permissions.includes('users.manage');
  const canCreateUsers = permissions.includes('users.create');
  const canDeactivate = permissions.includes('users.deactivate');
  const canResetPassword = permissions.includes('users.password');
  const allowed = canManageRoles || canManageUsers;

  const [catalogue, setCatalogue] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [branches, setBranches] = useState([]);
  const [audit, setAudit] = useState([]);
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState({name: '', baseRole: 'staff', permissions: []});
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [newUser, setNewUser] = useState({
    name: '', email: '', password: '', role: 'staff', branch: ''
  });
  // Destructive actions require an explicit confirmation step rather than a
  // browser confirm(): the preview iframe blocks modals, and an inline
  // confirmation states exactly what is about to happen.
  const [confirming, setConfirming] = useState(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    setError('');
    try {
      const [roles, roster, branchList, trail] = await Promise.all([
        call('/roles'),
        call('/accounts').catch(() => []),
        call('/branches').catch(() => []),
        call('/rbac/audit?limit=25').catch(() => ({events: []}))
      ]);
      setCatalogue(roles);
      setAccounts(Array.isArray(roster) ? roster : roster?.accounts || []);
      setBranches(Array.isArray(branchList) ? branchList : []);
      setAudit(trail?.events || []);
    } catch (e) {
      setError(e.message || 'Could not load access control');
    }
  }, [call, allowed]);

  useEffect(() => { load(); }, [load]);

  const grouped = useMemo(
    () => groupBy(catalogue?.permissions || [], 'group'),
    [catalogue]
  );

  const toggle = key => setDraft(current => ({
    ...current,
    permissions: current.permissions.includes(key)
      ? current.permissions.filter(value => value !== key)
      : [...current.permissions, key]
  }));

  const applyTemplate = template => setDraft({
    name: template.name,
    baseRole: template.baseRole,
    permissions: [...template.permissions]
  });

  const saveRole = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (selected) {
        await call(`/roles/${selected}`, {
          method: 'PATCH',
          body: JSON.stringify({name: draft.name, permissions: draft.permissions})
        });
        setNote(`Updated ${draft.name}`);
      } else {
        await call('/roles', {
          method: 'POST',
          body: JSON.stringify({
            name: draft.name, baseRole: draft.baseRole, permissions: draft.permissions
          })
        });
        setNote(`Created ${draft.name}`);
      }
      setSelected(null);
      setDraft({name: '', baseRole: 'staff', permissions: []});
      await load();
    } catch (e) {
      setError(e.message || 'Could not save the role');
    } finally {
      setBusy(false);
    }
  };

  const editRole = role => {
    setSelected(role.key);
    setDraft({name: role.name, baseRole: role.baseRole, permissions: [...role.permissions]});
  };

  const removeRole = async role => {
    setBusy(true);
    setError('');
    try {
      await call(`/roles/${role.key}`, {method: 'DELETE'});
      setNote(`Deleted ${role.name}`);
      await load();
    } catch (e) {
      setError(e.message || 'Could not delete the role');
    } finally {
      setBusy(false);
    }
  };

  const assign = async (account, changes) => {
    setBusy(true);
    setError('');
    try {
      await call(`/users/${account._id}/role`, {method: 'PATCH', body: JSON.stringify(changes)});
      setNote(`Updated ${account.name}`);
      await load();
    } catch (e) {
      setError(e.message || 'Could not update the account');
    } finally {
      setBusy(false);
    }
  };

  const createAccount = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await call('/accounts', {method: 'POST', body: JSON.stringify({
        name: newUser.name.trim(),
        email: newUser.email.trim(),
        password: newUser.password,
        role: newUser.role,
        ...(newUser.branch ? {branch: newUser.branch} : {})
      })});
      setNote(`Created ${newUser.name.trim()}`);
      setNewUser({name: '', email: '', password: '', role: 'staff', branch: ''});
      await load();
    } catch (e) {
      // The API is the source of truth for validation: duplicate email, weak
      // password, unauthorised role. Show exactly what it said.
      setError(e.message || 'Could not create the account');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (account, active) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await call(`/accounts/${account._id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({active, reason: active ? 'Reinstated' : 'Deactivated by administrator'})
      });
      setNote(active
        ? `Reactivated ${account.name}`
        : `Deactivated ${account.name}. Their sessions have been ended.`);
      setConfirming(null);
      await load();
    } catch (e) {
      setError(e.message || 'Could not change the account status');
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Access control</h1>
        <p>You do not have permission to manage roles or users.</p>
      </div>
    );
  }

  return (
    <div style={{padding: '16px'}}>
      <header style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
        <ShieldCheck size={20}/>
        <h1 style={{margin: 0}}>Access control</h1>
      </header>
      <p style={{fontSize: '12px', opacity: 0.7}}>
        Roles are bundles of permissions. Changes apply immediately — nobody has to sign in
        again. The server enforces every permission independently of this screen.
      </p>

      {error && <p style={{color: '#991b1b'}}>{error}</p>}
      {note && <p style={{color: '#065f46'}}>{note}</p>}
      {!catalogue && !error && <p>Loading…</p>}

      {catalogue && (
        <>
          <h2 style={{fontSize: '15px'}}>Roles</h2>
          <div style={{overflowX: 'auto'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
              <thead>
                <tr style={{textAlign: 'left', borderBottom: '2px solid #e5e7eb'}}>
                  <th style={{padding: '4px 6px'}}>Role</th>
                  <th style={{padding: '4px 6px'}}>Based on</th>
                  <th style={{padding: '4px 6px'}}>Permissions</th>
                  <th style={{padding: '4px 6px'}}>In use</th>
                  <th style={{padding: '4px 6px'}}></th>
                </tr>
              </thead>
              <tbody>
                {catalogue.roles.map(role => (
                  <tr key={role.key} style={{borderBottom: '1px solid #f1f5f9'}}>
                    <td style={{padding: '4px 6px'}}>
                      <strong>{role.name}</strong>{' '}
                      {role.builtin
                        ? <Pill>built-in</Pill>
                        : <Pill tone="green">custom</Pill>}
                    </td>
                    <td style={{padding: '4px 6px'}}>{role.baseRole}</td>
                    <td style={{padding: '4px 6px'}}>
                      {role.unrestricted ? 'Everything' : `${role.permissions.length}`}
                    </td>
                    <td style={{padding: '4px 6px'}}>{role.assignedCount}</td>
                    <td style={{padding: '4px 6px', textAlign: 'right'}}>
                      {!role.builtin && canManageRoles && (
                        <>
                          <button onClick={() => editRole(role)} disabled={busy}>Edit</button>{' '}
                          <button onClick={() => removeRole(role)} disabled={busy}>Delete</button>
                        </>
                      )}
                      {role.builtin && <span style={{fontSize: '11px', opacity: 0.6}}>protected</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canManageRoles && (
            <section style={{marginTop: '18px', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px'}}>
              <h3 style={{marginTop: 0, fontSize: '14px'}}>
                {selected ? `Edit role: ${selected}` : 'New role'}
              </h3>
              <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px'}}>
                <input
                  aria-label="Role name" placeholder="Role name" value={draft.name}
                  onChange={e => setDraft({...draft, name: e.target.value})}
                />
                <select
                  aria-label="Base role" value={draft.baseRole} disabled={Boolean(selected)}
                  onChange={e => setDraft({...draft, baseRole: e.target.value})}
                >
                  {(catalogue.baseRoles || ['manager', 'staff', 'rider']).map(base => (
                    <option key={base} value={base}>{base}</option>
                  ))}
                </select>
                <button onClick={saveRole} disabled={busy || draft.name.trim().length < 2}>
                  {selected ? 'Save changes' : 'Create role'}
                </button>
                {selected && (
                  <button onClick={() => {
                    setSelected(null);
                    setDraft({name: '', baseRole: 'staff', permissions: []});
                  }}>Cancel</button>
                )}
              </div>

              {!selected && (
                <div style={{marginBottom: '10px'}}>
                  <span style={{fontSize: '12px', opacity: 0.7, marginRight: '6px'}}>Start from:</span>
                  {(catalogue.templates || []).map(template => (
                    <button key={template.key} onClick={() => applyTemplate(template)}
                      style={{marginRight: '6px'}}>
                      {template.name}
                    </button>
                  ))}
                </div>
              )}

              {Object.entries(grouped).map(([group, entries]) => (
                <div key={group} style={{marginBottom: '8px'}}>
                  <div style={{fontSize: '11px', textTransform: 'uppercase', opacity: 0.6, letterSpacing: '.4px'}}>
                    {group}
                  </div>
                  <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap'}}>
                    {entries.map(entry => (
                      <label key={entry.key} style={{fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center'}}>
                        <input
                          type="checkbox"
                          checked={draft.permissions.includes(entry.key)}
                          onChange={() => toggle(entry.key)}
                        />
                        {entry.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}

          {canManageUsers && (
            <>
              <h2 style={{fontSize: '15px', marginTop: '20px'}}>People</h2>

              {canCreateUsers && (
                <section style={{border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px', marginBottom: '12px'}}>
                  <h3 style={{marginTop: 0, fontSize: '14px'}}>Create an account</h3>
                  <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                    <input aria-label="New name" placeholder="Full name" value={newUser.name}
                      onChange={e => setNewUser({...newUser, name: e.target.value})}/>
                    <input aria-label="New email" placeholder="Email" value={newUser.email}
                      onChange={e => setNewUser({...newUser, email: e.target.value})}/>
                    <input aria-label="New password" type="password" placeholder="Temporary password"
                      value={newUser.password}
                      onChange={e => setNewUser({...newUser, password: e.target.value})}/>
                    <select aria-label="New role" value={newUser.role}
                      onChange={e => setNewUser({...newUser, role: e.target.value})}>
                      {catalogue.roles
                        .filter(role => role.key !== 'owner')
                        .map(role => <option key={role.key} value={role.key}>{role.name}</option>)}
                    </select>
                    <select aria-label="New branch" value={newUser.branch}
                      onChange={e => setNewUser({...newUser, branch: e.target.value})}>
                      <option value="">No branch</option>
                      {branches.map(branch => (
                        <option key={branch._id} value={String(branch._id)}>{branch.name}</option>
                      ))}
                    </select>
                    <button onClick={createAccount}
                      disabled={busy || !newUser.name.trim() || !newUser.email.trim() || !newUser.password}>
                      Create account
                    </button>
                  </div>
                  <p style={{fontSize: '11px', opacity: 0.65, marginBottom: 0}}>
                    An owner account cannot be created here. The password must be at least 10 characters
                    with letters and numbers; the server enforces this and rejects duplicates.
                  </p>
                </section>
              )}
              <div style={{overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
                  <thead>
                    <tr style={{textAlign: 'left', borderBottom: '2px solid #e5e7eb'}}>
                      <th style={{padding: '4px 6px'}}>Name</th>
                      <th style={{padding: '4px 6px'}}>Role</th>
                      <th style={{padding: '4px 6px'}}>Branch</th>
                      <th style={{padding: '4px 6px'}}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map(account => (
                      <tr key={account._id} style={{borderBottom: '1px solid #f1f5f9'}}>
                        <td style={{padding: '4px 6px'}}>
                          {account.name}
                          <div style={{fontSize: '11px', opacity: 0.6}}>{account.email}</div>
                        </td>
                        <td style={{padding: '4px 6px'}}>
                          <select
                            aria-label={`Role for ${account.name}`}
                            value={account.roleKey || account.role}
                            disabled={busy || account.role === 'owner'}
                            onChange={e => assign(account, {role: e.target.value})}
                          >
                            {catalogue.roles
                              .filter(role => role.key !== 'owner')
                              .map(role => (
                                <option key={role.key} value={role.key}>{role.name}</option>
                              ))}
                          </select>
                        </td>
                        <td style={{padding: '4px 6px'}}>
                          <select
                            aria-label={`Branch for ${account.name}`}
                            value={account.branch ? String(account.branch) : ''}
                            disabled={busy || account.role === 'owner'}
                            onChange={e => assign(account, {branch: e.target.value})}
                          >
                            <option value="">—</option>
                            {branches.map(branch => (
                              <option key={branch._id} value={String(branch._id)}>{branch.name}</option>
                            ))}
                          </select>
                        </td>
                        <td style={{padding: '4px 6px'}}>
                          {account.active === false
                            ? <Pill tone="amber">deactivated</Pill>
                            : <Pill tone="green">active</Pill>}
                          {canDeactivate && account.role !== 'owner' && (
                            <div style={{marginTop: '4px'}}>
                              {confirming === account._id ? (
                                <span style={{fontSize: '11px'}}>
                                  Deactivate {account.name}? Their sessions end immediately.{' '}
                                  <button onClick={() => setActive(account, false)} disabled={busy}>
                                    Confirm
                                  </button>{' '}
                                  <button onClick={() => setConfirming(null)} disabled={busy}>Cancel</button>
                                </span>
                              ) : account.active === false ? (
                                <button onClick={() => setActive(account, true)} disabled={busy}>
                                  Reactivate
                                </button>
                              ) : (
                                <button onClick={() => setConfirming(account._id)} disabled={busy}>
                                  Deactivate
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h2 style={{fontSize: '15px', marginTop: '20px'}}>Recent access changes</h2>
          {audit.length === 0 && <p style={{opacity: 0.7, fontSize: '13px'}}>No access changes recorded yet.</p>}
          <ul style={{fontSize: '12px', lineHeight: 1.7}}>
            {audit.map(event => (
              <li key={event._id}>
                <strong>{String(event.action || '').replace(/_/g, ' ')}</strong>
                {' — '}
                {event.user?.name || 'system'}
                {' · '}
                {new Date(event.at).toLocaleString('en-NP')}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
