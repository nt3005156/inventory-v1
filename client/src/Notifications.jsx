import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Bell} from 'lucide-react';

/**
 * Phase 23 — the notification centre.
 *
 * Read and acknowledge only. Notifications are written by the services that
 * perform the underlying act; there is no endpoint to author one, so this
 * screen has no "create" control. Scope (restaurant, branch, and personal
 * addressing) is enforced by the API — the tabs here are convenience.
 */

const TABS = [
  {key: 'unread', label: 'Unread', query: 'unread=true'},
  {key: 'read', label: 'Read', query: 'unread=false'},
  {key: 'all', label: 'All', query: ''}
];

const stamp = value => {
  if (!value) return '';
  // Kathmandu local time, matching every other operational screen.
  return new Date(new Date(value).getTime() + 5.75 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 16);
};

function Severity({level}) {
  const tones = {
    info: {background: '#e0f2fe', color: '#075985'},
    warning: {background: '#fef3c7', color: '#92400e'},
    critical: {background: '#fee2e2', color: '#991b1b'}
  };
  return (
    <span style={{
      ...(tones[level] || tones.info), padding: '1px 7px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap'
    }}>{level}</span>
  );
}

export default function Notifications({call, user, permissions = [], branches = []}) {
  const allowed = user?.role === 'owner' || permissions.includes('notifications.view');

  const [tab, setTab] = useState('unread');
  const [type, setType] = useState('');
  const [branch, setBranch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [catalogue, setCatalogue] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const parts = [`page=${page}`, 'limit=25'];
    const active = TABS.find(entry => entry.key === tab);
    if (active?.query) parts.push(active.query);
    if (type) parts.push(`type=${encodeURIComponent(type)}`);
    if (branch) parts.push(`branch=${encodeURIComponent(branch)}`);
    return `?${parts.join('&')}`;
  }, [tab, type, branch, page]);

  const load = useCallback(async () => {
    if (!allowed) return;
    setBusy(true);
    setError('');
    try {
      const [inbox, types] = await Promise.all([
        call(`/notifications${query}`),
        catalogue ? Promise.resolve(catalogue) : call('/notifications/types').catch(() => null)
      ]);
      setData(inbox);
      if (types) setCatalogue(types);
    } catch (e) {
      setError(e.message || 'Could not load notifications');
    } finally {
      setBusy(false);
    }
  }, [call, query, allowed, catalogue]);

  useEffect(() => { load(); }, [load]);

  const markRead = async (notification, read = true) => {
    setBusy(true);
    setError('');
    try {
      await call(`/notifications/${notification._id}/read`, {
        method: 'PATCH', body: JSON.stringify({read})
      });
      await load();
    } catch (e) {
      setError(e.message || 'Could not update the notification');
    } finally {
      setBusy(false);
    }
  };

  const markAll = async () => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const result = await call(`/notifications/read-all${branch ? `?branch=${encodeURIComponent(branch)}` : ''}`, {
        method: 'POST', body: JSON.stringify({})
      });
      setNote(result.updated
        ? `Marked ${result.updated} notification(s) read`
        : 'Nothing left to mark');
      await load();
    } catch (e) {
      setError(e.message || 'Could not mark everything read');
    } finally {
      setBusy(false);
    }
  };

  if (!allowed) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Notifications</h1>
        <p>You do not have access to the notification centre.</p>
      </div>
    );
  }

  return (
    <div style={{padding: '16px'}}>
      <header style={{display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}}>
        <Bell size={20}/>
        <h1 style={{margin: 0}}>Notifications</h1>
        {data?.unreadCount > 0 && (
          <span style={{
            background: '#991b1b', color: '#fff', borderRadius: '999px',
            padding: '1px 8px', fontSize: '12px', fontWeight: 700
          }}>{data.unreadCount}</span>
        )}
        <button onClick={markAll} disabled={busy || !data?.unreadCount} style={{marginLeft: 'auto'}}>
          Mark all read
        </button>
      </header>

      {error && <p style={{color: '#991b1b'}}>{error}</p>}
      {note && <p style={{color: '#065f46'}}>{note}</p>}

      <nav style={{display: 'flex', gap: '6px', margin: '12px 0', flexWrap: 'wrap'}}>
        {TABS.map(entry => (
          <button key={entry.key}
            onClick={() => { setTab(entry.key); setPage(1); }}
            style={{
              fontWeight: tab === entry.key ? 700 : 400,
              borderBottom: tab === entry.key ? '2px solid #111' : '2px solid transparent'
            }}>
            {entry.label}
          </button>
        ))}
        <select aria-label="Type" value={type}
          onChange={e => { setType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          {(catalogue?.types || []).map(entry => (
            <option key={entry.key} value={entry.key}>{entry.label}</option>
          ))}
        </select>
        {user?.role === 'owner' && (
          <select aria-label="Branch" value={branch}
            onChange={e => { setBranch(e.target.value); setPage(1); }}>
            <option value="">All branches</option>
            {branches.map(item => (
              <option key={item._id} value={String(item._id)}>{item.name}</option>
            ))}
          </select>
        )}
      </nav>

      {data && (
        <>
          <div style={{fontSize: '12px', opacity: 0.7, marginBottom: '6px'}}>
            {data.pagination.total} notification(s) · scope: {data.scope}
          </div>
          {data.notifications.length === 0 && (
            <p style={{opacity: 0.7}}>
              {tab === 'unread' ? 'Nothing unread.' : 'No notifications match.'}
            </p>
          )}
          <ul style={{listStyle: 'none', padding: 0, margin: 0}}>
            {data.notifications.map(item => (
              <li key={item._id} style={{
                border: '1px solid #e5e7eb', borderLeft: `4px solid ${item.read ? '#e5e7eb' : '#2563eb'}`,
                borderRadius: '8px', padding: '10px', marginBottom: '8px',
                background: item.read ? '#fff' : '#f8fafc'
              }}>
                <div style={{display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}}>
                  <strong style={{fontWeight: item.read ? 500 : 700}}>{item.title}</strong>
                  <Severity level={item.severity}/>
                  <span style={{fontSize: '11px', opacity: 0.6}}>{item.type}</span>
                  {item.branchName && (
                    <span style={{fontSize: '11px', opacity: 0.6}}>· {item.branchName}</span>
                  )}
                  <span style={{marginLeft: 'auto', fontSize: '11px', opacity: 0.6}}>
                    {stamp(item.createdAt)}
                  </span>
                </div>
                {item.body && <div style={{fontSize: '13px', marginTop: '4px'}}>{item.body}</div>}
                <div style={{display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px'}}>
                  {item.reference && (
                    <span style={{fontSize: '11px', opacity: 0.7}}>ref {item.reference}</span>
                  )}
                  {/* Channels are shown honestly: only in-app is delivered. */}
                  <span style={{fontSize: '11px', opacity: 0.55}}>
                    {(item.delivery || []).map(d => `${d.channel}:${d.status}`).join(' · ')}
                  </span>
                  <button style={{marginLeft: 'auto', fontSize: '12px'}} disabled={busy}
                    onClick={() => markRead(item, !item.read)}>
                    {item.read ? 'Mark unread' : 'Mark read'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div style={{display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center'}}>
            <button disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span style={{fontSize: '12px'}}>
              Page {data.pagination.page} of {data.pagination.pages}
            </span>
            <button disabled={busy || page >= data.pagination.pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
