import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ScrollText} from 'lucide-react';

/**
 * Phase 21 — audit log and compliance search.
 *
 * READ ONLY. There is no control here that edits or deletes a record, because
 * no such endpoint exists: audit rows are append-only and the API refuses any
 * mutation. This screen searches and displays; the backend enforces both the
 * permission (`audit.view`) and the tenant/branch scope independently.
 */

const PAGE_SIZE = 25;

const stamp = value => {
  if (!value) return '';
  // Kathmandu local time, matching every other operational screen.
  return new Date(new Date(value).getTime() + 5.75 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 16);
};

function Pill({children, tone = 'grey'}) {
  const tones = {
    grey: {background: '#f1f5f9', color: '#334155'},
    green: {background: '#dcfce7', color: '#166534'},
    red: {background: '#fee2e2', color: '#991b1b'},
    amber: {background: '#fef3c7', color: '#92400e'}
  };
  return (
    <span style={{
      ...tones[tone], padding: '1px 7px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap'
    }}>{children}</span>
  );
}

/** Renders a before/after pair compactly; full JSON on demand. */
function Delta({before, after}) {
  const [open, setOpen] = useState(false);
  if (before === null && after === null) return <span style={{opacity: 0.5}}>—</span>;
  const summary = () => {
    const keys = [...new Set([
      ...Object.keys(before || {}), ...Object.keys(after || {})
    ])].filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
    if (!keys.length) return 'no field change';
    return keys.slice(0, 3).map(key => {
      const from = before?.[key];
      const to = after?.[key];
      const short = value => {
        if (value === undefined) return '∅';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return text.length > 24 ? `${text.slice(0, 24)}…` : text;
      };
      return `${key}: ${short(from)} → ${short(to)}`;
    }).join(', ') + (keys.length > 3 ? ` (+${keys.length - 3})` : '');
  };
  return (
    <div style={{fontSize: '12px'}}>
      <span>{summary()}</span>{' '}
      <button style={{fontSize: '11px'}} onClick={() => setOpen(!open)}>
        {open ? 'hide' : 'detail'}
      </button>
      {open && (
        <pre style={{
          whiteSpace: 'pre-wrap', wordBreak: 'break-all', background: '#f8fafc',
          padding: '6px', borderRadius: '6px', fontSize: '11px', marginTop: '4px'
        }}>{JSON.stringify({before, after}, null, 2)}</pre>
      )}
    </div>
  );
}

export default function AuditLog({call, user, permissions = [], branches = []}) {
  const allowed = user?.role === 'owner' || permissions.includes('audit.view');

  const [filters, setFilters] = useState({
    action: '', user: '', entity: '', reference: '', branch: '', from: '', to: ''
  });
  const [catalogue, setCatalogue] = useState(null);
  const [data, setData] = useState(null);
  const [people, setPeople] = useState([]);
  const [page, setPage] = useState(1);
  const [integrity, setIntegrity] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const query = useMemo(() => {
    const parts = [`page=${page}`, `limit=${PAGE_SIZE}`];
    for (const [key, value] of Object.entries(filters)) {
      if (value) parts.push(`${key}=${encodeURIComponent(value)}`);
    }
    return `?${parts.join('&')}`;
  }, [filters, page]);

  const load = useCallback(async () => {
    if (!allowed) return;
    setBusy(true);
    setError('');
    try {
      const [events, actions, roster] = await Promise.all([
        call(`/audit${query}`),
        catalogue ? Promise.resolve(catalogue) : call('/audit/actions').catch(() => null),
        people.length ? Promise.resolve(people) : call('/accounts').catch(() => [])
      ]);
      setData(events);
      if (actions) setCatalogue(actions);
      if (Array.isArray(roster)) setPeople(roster);
    } catch (e) {
      setError(e.message || 'Could not load the audit log');
    } finally {
      setBusy(false);
    }
  }, [call, query, allowed, catalogue, people.length]);

  useEffect(() => { load(); }, [load]);

  const verify = async () => {
    setBusy(true);
    setError('');
    try {
      setIntegrity(await call('/audit/verify'));
    } catch (e) {
      setError(e.message || 'Could not verify the audit chain');
    } finally {
      setBusy(false);
    }
  };

  const set = (key, value) => {
    setPage(1);
    setFilters(current => ({...current, [key]: value}));
  };

  if (!allowed) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Audit log</h1>
        <p>You do not have permission to view the audit log.</p>
      </div>
    );
  }

  return (
    <div style={{padding: '16px'}}>
      <header style={{display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}}>
        <ScrollText size={20}/>
        <h1 style={{margin: 0}}>Audit log</h1>
        <button onClick={verify} disabled={busy} style={{marginLeft: 'auto'}}>
          Verify integrity
        </button>
      </header>
      <p style={{fontSize: '12px', opacity: 0.7}}>
        Append-only. Records cannot be edited or deleted through the application, and every
        row is hash-chained so tampering made directly against the database is detectable.
      </p>

      {error && <p style={{color: '#991b1b'}}>{error}</p>}

      {integrity && (
        <div style={{
          border: '1px solid #e5e7eb', borderRadius: '8px', padding: '10px', marginBottom: '12px'
        }}>
          <strong>
            {integrity.verified
              ? <Pill tone="green">chain verified</Pill>
              : <Pill tone="red">tampering detected</Pill>}
          </strong>{' '}
          <span style={{fontSize: '12px'}}>{integrity.checked} record(s) checked.</span>
          {!integrity.verified && (
            <ul style={{fontSize: '12px', marginBottom: 0}}>
              {integrity.problems.map(problem => (
                <li key={`${problem.type}-${problem.id}`}>
                  <strong>{problem.type}</strong> at sequence {problem.sequence}
                  {problem.detail ? ` — ${problem.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
          <div style={{fontSize: '11px', opacity: 0.65, marginTop: '4px'}}>{integrity.guarantee}</div>
        </div>
      )}

      <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px'}}>
        <select aria-label="Action" value={filters.action} onChange={e => set('action', e.target.value)}>
          <option value="">All actions</option>
          {Object.entries(catalogue?.groups || {}).map(([group, actions]) => (
            <optgroup key={group} label={group}>
              {actions.map(action => <option key={action} value={action}>{action}</option>)}
            </optgroup>
          ))}
        </select>
        <select aria-label="User" value={filters.user} onChange={e => set('user', e.target.value)}>
          <option value="">All users</option>
          {people.map(person => (
            <option key={person._id} value={String(person._id)}>{person.name}</option>
          ))}
        </select>
        {user?.role === 'owner' && (
          <select aria-label="Branch" value={filters.branch} onChange={e => set('branch', e.target.value)}>
            <option value="">All branches</option>
            {branches.map(branch => (
              <option key={branch._id} value={String(branch._id)}>{branch.name}</option>
            ))}
          </select>
        )}
        <input aria-label="Entity" placeholder="Entity" value={filters.entity}
          onChange={e => set('entity', e.target.value)}/>
        <input aria-label="Reference" placeholder="Reference" value={filters.reference}
          onChange={e => set('reference', e.target.value)}/>
        <input aria-label="From" type="date" value={filters.from} onChange={e => set('from', e.target.value)}/>
        <input aria-label="To" type="date" value={filters.to} onChange={e => set('to', e.target.value)}/>
        <button onClick={load} disabled={busy}>{busy ? 'Searching…' : 'Search'}</button>
      </div>

      {data && (
        <>
          <div style={{fontSize: '12px', opacity: 0.7, marginBottom: '6px'}}>
            {data.pagination.total} record(s) · scope: {data.scope}
          </div>
          <div style={{overflowX: 'auto'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
              <thead>
                <tr style={{textAlign: 'left', borderBottom: '2px solid #e5e7eb'}}>
                  <th style={{padding: '4px 6px'}}>When</th>
                  <th style={{padding: '4px 6px'}}>Who</th>
                  <th style={{padding: '4px 6px'}}>What</th>
                  <th style={{padding: '4px 6px'}}>Reference</th>
                  <th style={{padding: '4px 6px'}}>Change</th>
                  <th style={{padding: '4px 6px'}}>Where</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map(event => (
                  <tr key={event._id} style={{borderBottom: '1px solid #f1f5f9', verticalAlign: 'top'}}>
                    <td style={{padding: '4px 6px', whiteSpace: 'nowrap'}}>{stamp(event.at)}</td>
                    <td style={{padding: '4px 6px'}}>
                      {event.actor.name || <span style={{opacity: 0.5}}>system</span>}
                      {event.actor.role && (
                        <div style={{fontSize: '11px', opacity: 0.6}}>{event.actor.role}</div>
                      )}
                    </td>
                    <td style={{padding: '4px 6px'}}>
                      <Pill tone={String(event.action).includes('fail') ? 'amber' : 'grey'}>
                        {event.action}
                      </Pill>
                      <div style={{fontSize: '11px', opacity: 0.6}}>{event.entity}</div>
                    </td>
                    <td style={{padding: '4px 6px'}}>{event.reference || '—'}</td>
                    <td style={{padding: '4px 6px', maxWidth: '320px'}}>
                      <Delta before={event.before} after={event.after}/>
                      {event.reason && (
                        <div style={{fontSize: '11px', opacity: 0.7}}>reason: {event.reason}</div>
                      )}
                    </td>
                    <td style={{padding: '4px 6px', fontSize: '11px'}}>{event.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.events.length === 0 && <p style={{opacity: 0.7}}>No matching records.</p>}
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
