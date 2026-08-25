import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Building2, Gauge, ScrollText, ShieldAlert, Users
} from 'lucide-react';

/**
 * P2B — the platform administration area.
 *
 * DELIBERATELY A SEPARATE WORKSPACE, not a page inside the restaurant shell.
 * A platform operator is not an employee of any restaurant, and mixing the
 * two surfaces is how "suspend restaurant" ends up two clicks from "print
 * receipt". The shell swaps entirely when the operator enters `/platform`.
 *
 * THE FRONTEND IS NOT A SECURITY BOUNDARY. Everything here is presentation:
 * the navigation is hidden from restaurant users as a courtesy, and every
 * single request below is re-authorized server-side against the DATABASE
 * `platformRole`. Hiding a button stops an honest user from being confused;
 * it stops an attacker from nothing.
 *
 * Capability is driven by the permissions `/platform/me` reports, so a
 * `platform_support` operator sees read-only screens without the client
 * needing to know what "support" means.
 */

const PAGE_SIZE = 20;

const STATUS_TONES = {
  active: {background: '#dcfce7', color: '#166534'},
  trial: {background: '#dbeafe', color: '#1e40af'},
  suspended: {background: '#fee2e2', color: '#991b1b'},
  cancelled: {background: '#e2e8f0', color: '#475569'}
};

const stamp = value => {
  if (!value) return '—';
  // Kathmandu local time, matching every other screen in the product.
  return new Date(new Date(value).getTime() + 5.75 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 16);
};

function Pill({children, tone}) {
  const style = STATUS_TONES[tone] || {background: '#f1f5f9', color: '#334155'};
  return (
    <span style={{
      ...style, padding: '2px 9px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap', textTransform: 'uppercase'
    }}>{children}</span>
  );
}

function Stat({label, value, hint}) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px',
      padding: '14px 16px', minWidth: '140px', flex: '1 1 140px'
    }}>
      <div style={{fontSize: '11px', textTransform: 'uppercase', letterSpacing: '.06em', color: '#64748b'}}>
        {label}
      </div>
      <div style={{fontSize: '26px', fontWeight: 700, lineHeight: 1.2}}>{value}</div>
      {hint ? <div style={{fontSize: '11px', color: '#94a3b8'}}>{hint}</div> : null}
    </div>
  );
}

// ── dashboard ────────────────────────────────────────────────────────────────

function PlatformDashboard({call}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    call('/platform/dashboard')
      .then(result => { if (live) setData(result); })
      .catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [call]);

  if (error) return <p className="danger">{error}</p>;
  if (!data) return <p>Loading platform overview…</p>;

  return (
    <div>
      <h2 style={{marginTop: 0}}>Restaurants</h2>
      <div style={{display: 'flex', gap: '12px', flexWrap: 'wrap'}}>
        <Stat label="Total" value={data.restaurants.total}/>
        <Stat label="Operational" value={data.restaurants.operational} hint="trial + active"/>
        <Stat label="Active" value={data.restaurants.active}/>
        <Stat label="Trial" value={data.restaurants.trial}/>
        <Stat label="Suspended" value={data.restaurants.suspended}/>
        <Stat label="Cancelled" value={data.restaurants.cancelled}/>
      </div>

      <h2>Branches and people</h2>
      <div style={{display: 'flex', gap: '12px', flexWrap: 'wrap'}}>
        <Stat label="Branches" value={data.branches.total}/>
        <Stat label="Users" value={data.users.total}/>
        <Stat label="Active users" value={data.users.active}/>
        <Stat label="Deactivated" value={data.users.inactive}/>
        <Stat label="Platform operators" value={data.users.platformOperators}/>
      </div>

      <h2>Newest restaurants</h2>
      <table>
        <thead>
          <tr><th>Restaurant</th><th>Slug</th><th>Status</th><th>Created</th></tr>
        </thead>
        <tbody>
          {data.recentRestaurants.map(row => (
            <tr key={row._id}>
              <td>{row.name}</td>
              <td>{row.slug || '—'}</td>
              <td><Pill tone={row.status}>{row.status}</Pill></td>
              <td>{stamp(row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{fontSize: '11px', color: '#94a3b8'}}>
        Aggregate figures only. No restaurant's sales, payments or customer data is shown here.
      </p>
    </div>
  );
}

// ── restaurants ──────────────────────────────────────────────────────────────

function RestaurantDetail({call, id, permissions, onClose, onChanged}) {
  const [row, setRow] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');

  const maySuspend = permissions.includes('platform.restaurants.suspend');
  const mayActivate = permissions.includes('platform.restaurants.activate');

  const load = useCallback(() => {
    call(`/platform/restaurants/${id}`).then(setRow).catch(e => setError(e.message));
  }, [call, id]);

  useEffect(() => { load(); }, [load]);

  const act = async action => {
    setError('');
    // Suspension and cancellation need a justification. Enforced server-side
    // too — this check only spares the operator a pointless round trip.
    if ((action === 'suspend' || action === 'cancel') && reason.trim().length < 3) {
      setError('A reason is required to suspend or cancel a restaurant.');
      return;
    }
    setBusy(true);
    try {
      await call(`/platform/restaurants/${id}/status`, {
        method: 'POST',
        body: JSON.stringify({action, ...(reason.trim() ? {reason: reason.trim()} : {})})
      });
      setReason('');
      load();
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !row) return <p className="danger">{error}</p>;
  if (!row) return <p>Loading…</p>;

  return (
    <div style={{border: '1px solid #e2e8f0', borderRadius: '12px', padding: '16px', background: '#fff'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
        <h2 style={{margin: 0}}>{row.name} <Pill tone={row.status}>{row.status}</Pill></h2>
        <button onClick={onClose}>Close</button>
      </div>

      <dl style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: '13px'}}>
        <dt style={{color: '#64748b'}}>Legal name</dt><dd>{row.legalName || '—'}</dd>
        <dt style={{color: '#64748b'}}>Slug</dt><dd>{row.slug || '—'}</dd>
        <dt style={{color: '#64748b'}}>Timezone</dt><dd>{row.timezone || '—'}</dd>
        <dt style={{color: '#64748b'}}>Branches</dt><dd>{row.branchCount ?? '—'}</dd>
        <dt style={{color: '#64748b'}}>Users</dt><dd>{row.userCount ?? '—'}</dd>
        <dt style={{color: '#64748b'}}>Owner</dt>
        <dd>{row.owner ? `${row.owner.name} (${row.owner.email})` : '—'}</dd>
        <dt style={{color: '#64748b'}}>Created</dt><dd>{stamp(row.createdAt)}</dd>
      </dl>

      {(mayActivate || maySuspend) && (
        <div style={{borderTop: '1px solid #e2e8f0', paddingTop: '12px', marginTop: '8px'}}>
          <h3 style={{margin: '0 0 6px'}}>Lifecycle</h3>
          <input
            aria-label="Reason"
            placeholder="Reason (required to suspend or cancel)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{width: '100%', marginBottom: '8px'}}
          />
          <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
            {mayActivate && (
              <button disabled={busy} onClick={() => act('activate')}>Activate</button>
            )}
            {mayActivate && (
              <button disabled={busy} onClick={() => act('trial')}>Move to trial</button>
            )}
            {maySuspend && (
              <button disabled={busy} onClick={() => act('suspend')}>Suspend</button>
            )}
            {maySuspend && (
              <button disabled={busy} onClick={() => act('cancel')}>Cancel</button>
            )}
          </div>
          <p style={{fontSize: '11px', color: '#94a3b8', marginBottom: 0}}>
            Suspending a restaurant stops its staff from using the product immediately.
            Every lifecycle change is audited.
          </p>
        </div>
      )}
      {error && <p className="danger">{error}</p>}
    </div>
  );
}

function PlatformRestaurants({call, permissions}) {
  const [rows, setRows] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    const parts = [`page=${page}`, `limit=${PAGE_SIZE}`];
    if (q.trim()) parts.push(`q=${encodeURIComponent(q.trim())}`);
    if (status) parts.push(`status=${encodeURIComponent(status)}`);
    try {
      const result = await call(`/platform/restaurants?${parts.join('&')}`);
      setRows(result.restaurants);
      setPagination(result.pagination);
    } catch (e) {
      setError(e.message);
    }
  }, [call, page, q, status]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px'}}>
        <input
          aria-label="Search restaurants"
          placeholder="Search by name or slug"
          value={q}
          onChange={e => { setPage(1); setQ(e.target.value); }}
        />
        <select aria-label="Status filter" value={status}
          onChange={e => { setPage(1); setStatus(e.target.value); }}>
          <option value="">All statuses</option>
          <option value="trial">Trial</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      {error && <p className="danger">{error}</p>}

      {selected && (
        <div style={{marginBottom: '16px'}}>
          <RestaurantDetail
            call={call} id={selected} permissions={permissions}
            onClose={() => setSelected(null)} onChanged={load}
          />
        </div>
      )}

      {!rows ? <p>Loading restaurants…</p> : (
        <>
          <table>
            <thead>
              <tr>
                <th>Restaurant</th><th>Slug</th><th>Status</th>
                <th>Branches</th><th>Users</th><th>Created</th><th/>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row._id}>
                  <td>{row.name}</td>
                  <td>{row.slug || '—'}</td>
                  <td><Pill tone={row.status}>{row.status}</Pill></td>
                  <td>{row.branchCount ?? '—'}</td>
                  <td>{row.userCount ?? '—'}</td>
                  <td>{stamp(row.createdAt)}</td>
                  <td>
                    <button onClick={() => setSelected(row._id)}>Open</button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={7}>No restaurants match that search.</td></tr>
              )}
            </tbody>
          </table>
          {pagination && pagination.pages > 1 && (
            <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span style={{fontSize: '12px'}}>Page {pagination.page} of {pagination.pages}</span>
              <button disabled={page >= pagination.pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── users ────────────────────────────────────────────────────────────────────

function PlatformUsers({call, permissions}) {
  const [rows, setRows] = useState(null);
  const [pagination, setPagination] = useState(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(null);
  const [reason, setReason] = useState('');

  const mayManage = permissions.includes('platform.users.manage');

  const load = useCallback(async () => {
    setError('');
    const parts = [`page=${page}`, `limit=${PAGE_SIZE}`];
    if (q.trim()) parts.push(`q=${encodeURIComponent(q.trim())}`);
    try {
      const result = await call(`/platform/users?${parts.join('&')}`);
      setRows(result.users);
      setPagination(result.pagination);
    } catch (e) {
      setError(e.message);
    }
  }, [call, page, q]);

  useEffect(() => { load(); }, [load]);

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError('A reason is required to change an account status.');
      return;
    }
    try {
      await call(`/platform/users/${pending.user._id}/active`, {
        method: 'PATCH',
        body: JSON.stringify({active: pending.active, reason: reason.trim()})
      });
      setPending(null);
      setReason('');
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div>
      <input
        aria-label="Search users"
        placeholder="Search by name or email"
        value={q}
        onChange={e => { setPage(1); setQ(e.target.value); }}
        style={{marginBottom: '12px'}}
      />
      {error && <p className="danger">{error}</p>}

      {pending && (
        <div style={{
          border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: '10px',
          padding: '12px', marginBottom: '12px'
        }}>
          <strong>
            {pending.active ? 'Reactivate' : 'Deactivate'} {pending.user.email}?
          </strong>
          <input
            aria-label="Status change reason"
            placeholder="Reason (required, recorded in the audit trail)"
            value={reason} onChange={e => setReason(e.target.value)}
            style={{width: '100%', margin: '8px 0'}}
          />
          <button onClick={submit}>Confirm</button>{' '}
          <button onClick={() => { setPending(null); setReason(''); }}>Cancel</button>
        </div>
      )}

      {!rows ? <p>Loading users…</p> : (
        <>
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Restaurant</th><th>Branch</th>
                <th>Role</th><th>Platform</th><th>Status</th>{mayManage && <th/>}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row._id}>
                  <td>{row.name}</td>
                  <td>{row.email}</td>
                  <td>{row.restaurant?.name || <span style={{color: '#94a3b8'}}>—</span>}</td>
                  <td>{row.branch?.name || '—'}</td>
                  <td>{row.roleKey && row.roleKey !== row.role ? `${row.role} · ${row.roleKey}` : row.role}</td>
                  <td>
                    {row.platformRole
                      ? <Pill tone="trial">{row.platformRole}</Pill>
                      : <span style={{color: '#94a3b8'}}>—</span>}
                  </td>
                  <td>
                    <Pill tone={row.active ? 'active' : 'suspended'}>
                      {row.active ? 'active' : 'deactivated'}
                    </Pill>
                  </td>
                  {mayManage && (
                    <td>
                      <button onClick={() => { setPending({user: row, active: !row.active}); setReason(''); }}>
                        {row.active ? 'Deactivate' : 'Reactivate'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={mayManage ? 8 : 7}>No users match that search.</td></tr>
              )}
            </tbody>
          </table>
          {pagination && pagination.pages > 1 && (
            <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span style={{fontSize: '12px'}}>Page {pagination.page} of {pagination.pages}</span>
              <button disabled={page >= pagination.pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
          <p style={{fontSize: '11px', color: '#94a3b8'}}>
            Platform authority is granted separately from restaurant roles and never through this screen.
          </p>
        </>
      )}
    </div>
  );
}

// ── audit ────────────────────────────────────────────────────────────────────

function PlatformAudit({call}) {
  const [data, setData] = useState(null);
  const [action, setAction] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    const parts = [`page=${page}`, `limit=${PAGE_SIZE}`];
    if (action) parts.push(`action=${encodeURIComponent(action)}`);
    try {
      setData(await call(`/platform/audit?${parts.join('&')}`));
    } catch (e) {
      setError(e.message);
    }
  }, [call, page, action]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <select aria-label="Action filter" value={action}
        onChange={e => { setPage(1); setAction(e.target.value); }}
        style={{marginBottom: '12px'}}>
        <option value="">All platform actions</option>
        {(data?.actions || []).map(key => <option key={key} value={key}>{key}</option>)}
      </select>

      {error && <p className="danger">{error}</p>}
      {!data ? <p>Loading platform audit…</p> : (
        <>
          <table>
            <thead>
              <tr><th>When</th><th>Action</th><th>Restaurant</th><th>Actor</th><th>Reason</th><th>Change</th></tr>
            </thead>
            <tbody>
              {data.events.map(row => (
                <tr key={row._id}>
                  <td>{stamp(row.at)}</td>
                  <td>{row.action}</td>
                  <td>{row.restaurant?.name || <span style={{color: '#94a3b8'}}>platform</span>}</td>
                  <td>{row.actor.name || '—'}</td>
                  <td>{row.reason || '—'}</td>
                  <td style={{fontSize: '11px'}}>
                    {JSON.stringify(row.before)} → {JSON.stringify(row.after)}
                  </td>
                </tr>
              ))}
              {!data.events.length && (
                <tr><td colSpan={6}>No platform actions recorded yet.</td></tr>
              )}
            </tbody>
          </table>
          {data.pagination.pages > 1 && (
            <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
              <button disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <span style={{fontSize: '12px'}}>Page {data.pagination.page} of {data.pagination.pages}</span>
              <button disabled={page >= data.pagination.pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          )}
          <p style={{fontSize: '11px', color: '#94a3b8'}}>
            Platform actions only. A restaurant's own operational history stays with that restaurant.
          </p>
        </>
      )}
    </div>
  );
}

// ── shell ────────────────────────────────────────────────────────────────────

/**
 * The platform workspace.
 *
 * `access` comes from `/platform/me`. A caller with no platform authority is
 * shown a refusal rather than a blank screen — they reached this URL somehow,
 * and pretending the area does not exist while they are staring at it is
 * unhelpful. It discloses nothing: they already know whether they are an
 * operator, and every endpoint refuses them regardless.
 */
export default function Platform({call, user, access, onExit}) {
  const [page, setPage] = useState('Dashboard');
  const permissions = useMemo(() => access?.permissions || [], [access]);

  if (!access?.platform) {
    return (
      <div style={{padding: '40px', maxWidth: '520px', margin: '0 auto', textAlign: 'center'}}>
        <ShieldAlert size={40} color="#b91c1c"/>
        <h1>Platform administration</h1>
        <p>This account does not hold platform authority.</p>
        <p style={{fontSize: '12px', color: '#64748b'}}>
          Platform administration is separate from your restaurant role. Being an owner of a
          restaurant does not grant it.
        </p>
        <button onClick={onExit}>Back to my restaurant</button>
      </div>
    );
  }

  const nav = [
    ...(permissions.includes('platform.dashboard.view') ? [['Dashboard', Gauge]] : []),
    ...(permissions.includes('platform.restaurants.view') ? [['Restaurants', Building2]] : []),
    ...(permissions.includes('platform.users.view') ? [['Users', Users]] : []),
    ...(permissions.includes('platform.audit.view') ? [['Audit', ScrollText]] : [])
  ];

  return (
    <div className="shell">
      <aside>
        <div className="brand">
          <span>platform</span>
          <small>SaaS operations</small>
        </div>
        {nav.map(([label, Icon]) => (
          <button key={label} className={page === label ? 'active' : ''} onClick={() => setPage(label)}>
            <Icon size={18}/>{label}
          </button>
        ))}
        <div className="asidebottom">
          <small>{user?.name} · {access.platformRoleName || access.platformRole}</small>
          <button onClick={onExit}>Leave platform area</button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">PLATFORM ADMINISTRATION</p>
            <h1>{page}</h1>
          </div>
          <div className="date">{access.platformRoleName || access.platformRole}</div>
        </header>
        {page === 'Dashboard' && <PlatformDashboard call={call}/>}
        {page === 'Restaurants' && <PlatformRestaurants call={call} permissions={permissions}/>}
        {page === 'Users' && <PlatformUsers call={call} permissions={permissions}/>}
        {page === 'Audit' && <PlatformAudit call={call}/>}
      </main>
    </div>
  );
}

export {PlatformDashboard, PlatformRestaurants, PlatformUsers, PlatformAudit};
