import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Download} from 'lucide-react';

/**
 * Phase 19 — export workspace.
 *
 * Downloads are authenticated fetches, not plain anchor clicks: the API is
 * bearer-token guarded, and a bare `<a href>` would arrive with no
 * Authorization header and 401. The response is read as a Blob and handed to
 * the browser through an object URL, which is also what lets the filename the
 * server chose survive.
 *
 * The dataset list comes from `GET /api/exports/datasets`, which the server
 * already filters by role. The screen therefore cannot advertise something the
 * caller may not download — but hiding a card is presentation only; the
 * backend refuses regardless, which is the control that counts.
 */

const FORMATS = [
  {key: 'csv', label: 'CSV'},
  {key: 'xlsx', label: 'Excel'},
  {key: 'pdf', label: 'PDF'}
];

const REPORT_PACKS = [
  {key: 'full', label: 'Full management pack'},
  {key: 'pnl', label: 'Profit and loss'},
  {key: 'sales', label: 'Sales report'},
  {key: 'inventory', label: 'Inventory report'},
  {key: 'customers', label: 'Customer report'}
];

export default function Exports({call, token, user, apiBase = '/api'}) {
  const isManager = ['owner', 'manager'].includes(user?.role);
  const [catalogue, setCatalogue] = useState(null);
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!isManager) return;
    let cancelled = false;
    call('/exports/datasets')
      .then(data => {
        if (cancelled) return;
        setCatalogue(data);
        // A manager only ever has one branch; preselect it so the first
        // download is not accidentally scoped wider than they can see.
        if (data.branches?.length === 1) setBranchId(String(data.branches[0]._id));
      })
      .catch(e => { if (!cancelled) setError(e.message || 'Could not load the export catalogue'); });
    return () => { cancelled = true; };
  }, [call, isManager]);

  const query = useMemo(() => {
    const parts = [];
    if (branchId) parts.push(`branch=${encodeURIComponent(branchId)}`);
    if (from) parts.push(`from=${encodeURIComponent(from)}`);
    if (to) parts.push(`to=${encodeURIComponent(to)}`);
    return parts.length ? `?${parts.join('&')}` : '';
  }, [branchId, from, to]);

  const download = useCallback(async (path, busyKey) => {
    setBusy(busyKey);
    setError('');
    setNote('');
    try {
      const response = await fetch(`${apiBase}${path}`, {
        headers: {Authorization: `Bearer ${token}`}
      });
      if (!response.ok) {
        // An export failure is JSON; do not save the error body as a file.
        let message = `Export failed (${response.status})`;
        try { message = (await response.json()).message || message; } catch { /* non-JSON */ }
        throw new Error(message);
      }
      const disposition = response.headers.get('content-disposition') || '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = match ? match[1] : 'export';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNote(`Downloaded ${match ? match[1] : 'export'}`);
    } catch (e) {
      setError(e.message || 'Export failed');
    } finally {
      setBusy('');
    }
  }, [apiBase, token]);

  if (!isManager) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Exports</h1>
        <p>Exports are available to managers and owners.</p>
      </div>
    );
  }

  return (
    <div style={{padding: '16px'}}>
      <header style={{display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
        <h1 style={{margin: 0, display: 'flex', alignItems: 'center', gap: '8px'}}>
          <Download size={20}/> Exports
        </h1>
        <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center'}}>
          <select value={branchId} onChange={e => setBranchId(e.target.value)} aria-label="Branch">
            {user?.role === 'owner' && <option value="">All branches</option>}
            {(catalogue?.branches || []).map(branch => (
              <option key={branch._id} value={String(branch._id)}>{branch.name}</option>
            ))}
          </select>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From"/>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To"/>
        </div>
      </header>

      {error && <p style={{color: '#991b1b'}}>{error}</p>}
      {note && <p style={{color: '#065f46'}}>{note}</p>}
      {!catalogue && !error && <p>Loading the export catalogue…</p>}

      {catalogue && (
        <>
          <h2 style={{fontSize: '15px', marginTop: '16px'}}>Data extracts</h2>
          <p style={{fontSize: '12px', opacity: 0.7, marginTop: 0}}>
            Streamed straight from the database. CSV and Excel carry every row in scope;
            PDF is capped and says so on the page.
          </p>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '10px'}}>
            {catalogue.datasets.map(dataset => (
              <div key={dataset.key}
                style={{border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px'}}>
                <div style={{fontWeight: 700}}>{dataset.title}</div>
                <div style={{fontSize: '11px', opacity: 0.65, margin: '4px 0 8px'}}>
                  {dataset.columns.length} columns
                  {dataset.dateless ? ' · current position, not a period' : ''}
                </div>
                <div style={{display: 'flex', gap: '6px'}}>
                  {FORMATS.map(format => {
                    const key = `${dataset.key}.${format.key}`;
                    return (
                      <button key={format.key} disabled={Boolean(busy)}
                        onClick={() => download(
                          `/exports/${dataset.key}.${format.key}${dataset.dateless ? (branchId ? `?branch=${encodeURIComponent(branchId)}` : '') : query}`,
                          key
                        )}>
                        {busy === key ? '…' : format.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          <h2 style={{fontSize: '15px', marginTop: '20px'}}>Report documents</h2>
          <p style={{fontSize: '12px', opacity: 0.7, marginTop: 0}}>
            Formatted PDFs built from the same figures the Reports screen shows.
          </p>
          <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
            {REPORT_PACKS.map(pack => (
              <button key={pack.key} disabled={Boolean(busy)}
                onClick={() => download(`/exports/reports/${pack.key}.pdf${query}`, `report-${pack.key}`)}>
                {busy === `report-${pack.key}` ? 'Preparing…' : pack.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
