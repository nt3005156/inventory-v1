import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AlertTriangle, PackageSearch, RefreshCw, ShoppingCart} from 'lucide-react';
import {connectBranchSocket} from './socket.js';

/**
 * Phase 16A — reorder workspace.
 *
 * The reorder engine was API-only. This binds to the existing endpoints; no
 * new backend capability is introduced here, and nothing bypasses the purchase
 * order approval chain: creating an order from a recommendation opens a DRAFT
 * that still has to be submitted and approved exactly as a hand-typed one does.
 */

const rs = value => `Rs ${Number(value || 0).toLocaleString('en-NP', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
})}`;
const qty = value => Number(value || 0).toLocaleString('en-NP', {maximumFractionDigits: 3});

const URGENCY_STYLE = {
  critical: {label: 'Out of stock', background: '#fef2f2', border: '#dc2626', text: '#991b1b'},
  reorder: {label: 'Low stock', background: '#fffbeb', border: '#d97706', text: '#92400e'},
  ok: {label: 'Healthy', background: '#f0fdf4', border: '#16a34a', text: '#166534'}
};

export default function Reorder({call, branches = [], user, token}) {
  const [branchId, setBranchId] = useState(() => branches[0]?._id ? String(branches[0]._id) : '');
  const [plan, setPlan] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [scheduler, setScheduler] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [urgencyFilter, setUrgencyFilter] = useState('');
  const [confirm, setConfirm] = useState(null);
  const loadRef = useRef(null);

  const isManager = ['owner', 'manager'].includes(user?.role);

  const load = useCallback(async () => {
    // Do not fetch purchasing data for a role that cannot see the workspace.
    // The backend already answers 403 — this is the authoritative control — but
    // firing the request anyway wastes a round trip and puts a guaranteed
    // failure in the operator's console on every render.
    if (!branchId || !isManager) return;
    setLoading(true);
    setError('');
    try {
      const [planned, alerted, sched] = await Promise.all([
        call(`/purchasing/reorder-plan?branch=${encodeURIComponent(branchId)}`),
        call(`/alerts?branch=${encodeURIComponent(branchId)}`).catch(() => []),
        call('/purchasing/reorder-scheduler').catch(() => null)
      ]);
      setPlan(planned);
      setAlerts(Array.isArray(alerted) ? alerted : []);
      setScheduler(sched);
    } catch (e) {
      setError(e.message || 'Could not load the reorder plan');
    } finally {
      setLoading(false);
    }
  }, [branchId, call, isManager]);

  loadRef.current = load;
  useEffect(() => { load(); }, [load]);

  // Live alerts: the same inventory:alert event the Inventory screen uses.
  useEffect(() => {
    if (!branchId || !token || !isManager) return undefined;
    const socket = connectBranchSocket(token, branchId);
    const onAlert = event => {
      if (String(event?.branch || '') !== String(branchId)) return;
      setNotice(`${event.ingredientName} — ${String(event.type).replaceAll('_', ' ')}`);
      loadRef.current?.();
    };
    socket.on('connect', () => socket.emit('join:branch', branchId, () => {}));
    socket.on('inventory:alert', onAlert);
    return () => {
      socket.off('inventory:alert', onAlert);
      socket.emit('leave:branch', branchId);
      socket.disconnect();
    };
  }, [branchId, token, isManager]);

  const suppliers = useMemo(() => {
    const seen = new Map();
    for (const line of plan?.lines || []) {
      if (line.supplier) seen.set(String(line.supplier), line.supplierName);
    }
    return [...seen.entries()];
  }, [plan]);

  const visible = useMemo(() => (plan?.lines || []).filter(line => {
    if (supplierFilter && String(line.supplier || '') !== supplierFilter) return false;
    if (urgencyFilter && line.urgency !== urgencyFilter) return false;
    return true;
  }), [plan, supplierFilter, urgencyFilter]);

  const openAlerts = useMemo(
    () => alerts.filter(a => ['low_stock', 'out_of_stock', 'high_waste', 'unusual_consumption'].includes(a.type)),
    [alerts]
  );

  const runSweep = async () => {
    setBusy('sweep');
    setError('');
    try {
      const out = await call(`/purchasing/reorder-alerts/run?branch=${encodeURIComponent(branchId)}`, {method: 'POST'});
      setNotice(`Sweep complete — ${out.raised} alert(s) raised from ${out.evaluated} line(s)`);
      await load();
    } catch (e) {
      setError(e.message || 'Sweep failed');
    } finally {
      setBusy('');
    }
  };

  const act = async (alertId, action) => {
    setBusy(alertId + action);
    setError('');
    try {
      await call(`/alerts/${alertId}/${action}`, {method: 'POST', body: JSON.stringify({})});
      setNotice(`Alert ${action === 'acknowledge' ? 'acknowledged' : 'resolved'}`);
      await load();
    } catch (e) {
      setError(e.message || `Could not ${action} the alert`);
    } finally {
      setBusy('');
    }
  };

  // Never silent: a PO is only created after explicit confirmation.
  const createOrder = async group => {
    setBusy('po');
    setError('');
    try {
      const out = await call('/purchasing/suggested-orders', {
        method: 'POST',
        headers: {'Idempotency-Key': `ui-reorder-${branchId}-${group.supplier}-${Date.now()}`},
        body: JSON.stringify({branch: branchId, supplier: String(group.supplier)})
      });
      setNotice(
        `Draft ${out.purchaseOrder?.poNo || 'purchase order'} created. `
        + 'It still needs submitting and approving before it can be received.'
      );
      setConfirm(null);
      await load();
    } catch (e) {
      setError(e.message || 'Could not create the purchase order');
    } finally {
      setBusy('');
    }
  };

  if (!isManager) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Reorder</h1>
        <p>Reorder planning is available to managers and owners.</p>
      </div>
    );
  }

  return (
    <div style={{padding: '16px'}}>
      <header style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap'}}>
        <div>
          <h1 style={{margin: 0, display: 'flex', alignItems: 'center', gap: '8px'}}>
            <PackageSearch size={20}/> Reorder plan
          </h1>
          <p style={{margin: '4px 0 0', opacity: 0.7, fontSize: '13px'}}>
            {plan?.formula || 'reorderPoint = averageDailyUsage x leadTimeDays + safetyStock'}
          </p>
        </div>
        <div style={{display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}}>
          <select value={branchId} onChange={e => setBranchId(e.target.value)}>
            {branches.map(b => <option key={b._id} value={String(b._id)}>{b.name}</option>)}
          </select>
          <button onClick={load} disabled={loading}>
            <RefreshCw size={14}/> {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button onClick={runSweep} disabled={busy === 'sweep'}>
            {busy === 'sweep' ? 'Sweeping…' : 'Run sweep now'}
          </button>
        </div>
      </header>

      {scheduler && (
        <p style={{fontSize: '12px', opacity: 0.7, marginTop: '8px'}}>
          Scheduler: {scheduler.running ? `every ${scheduler.intervalMinutes}m` : 'disabled'}
          {scheduler.running && scheduler.lastRunAt
            ? ` · last run ${new Date(scheduler.lastRunAt).toLocaleString('en-NP')}` : ''}
          {scheduler.running && scheduler.scope === 'in-process'
            ? ' · in-process (single API instance)' : ''}
        </p>
      )}

      {error && <p style={{color: '#991b1b'}}>{error}</p>}
      {notice && (
        <p style={{color: '#166534', display: 'flex', gap: '8px', alignItems: 'center'}}>
          {notice} <button onClick={() => setNotice('')} style={{fontSize: '11px'}}>dismiss</button>
        </p>
      )}

      {plan && (
        <div style={{display: 'flex', gap: '12px', margin: '12px 0', flexWrap: 'wrap'}}>
          {[
            ['Lines', plan.counts.total],
            ['Out of stock', plan.counts.critical],
            ['Below point', plan.counts.reorder],
            ['Actionable', plan.counts.actionable],
            ['No supplier', plan.counts.blocked],
            ['Estimated', rs(plan.expectedTotal)]
          ].map(([label, value]) => (
            <div key={label} style={{padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', minWidth: '110px'}}>
              <div style={{fontSize: '11px', opacity: 0.6, textTransform: 'uppercase'}}>{label}</div>
              <div style={{fontSize: '18px', fontWeight: 700}}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {!!openAlerts.length && (
        <section style={{margin: '12px 0'}}>
          <h3 style={{display: 'flex', alignItems: 'center', gap: '6px'}}>
            <AlertTriangle size={16}/> Active alerts ({openAlerts.length})
          </h3>
          <div style={{display: 'grid', gap: '6px', maxHeight: '220px', overflow: 'auto'}}>
            {openAlerts.map(alert => (
              <div key={String(alert._id)} style={{
                display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center',
                padding: '8px', borderRadius: '6px', border: '1px solid #e5e7eb',
                background: alert.severity === 'critical' ? '#fef2f2' : '#fffbeb'
              }}>
                <span style={{fontSize: '13px'}}>
                  <b style={{textTransform: 'uppercase', fontSize: '10px', letterSpacing: '.4px'}}>
                    {String(alert.type).replaceAll('_', ' ')}
                  </b>{' — '}{alert.body || alert.title}
                  {alert.status && alert.status !== 'open' && (
                    <em style={{marginLeft: '6px', opacity: 0.7}}>({alert.status})</em>
                  )}
                </span>
                {!alert.synthetic && alert.status !== 'resolved' && (
                  <span style={{display: 'flex', gap: '6px'}}>
                    {alert.status !== 'acknowledged' && (
                      <button disabled={busy === alert._id + 'acknowledge'}
                        onClick={() => act(alert._id, 'acknowledge')}>Acknowledge</button>
                    )}
                    <button disabled={busy === alert._id + 'resolve'}
                      onClick={() => act(alert._id, 'resolve')}>Resolve</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section style={{display: 'flex', gap: '8px', margin: '12px 0', flexWrap: 'wrap'}}>
        <select value={urgencyFilter} onChange={e => setUrgencyFilter(e.target.value)}>
          <option value="">All stock states</option>
          <option value="critical">Out of stock</option>
          <option value="reorder">Low stock</option>
          <option value="ok">Healthy</option>
        </select>
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}>
          <option value="">All suppliers</option>
          {suppliers.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </section>

      {!!plan?.suggestedOrders?.length && (
        <section style={{margin: '12px 0'}}>
          <h3>Suggested purchase orders</h3>
          {plan.suggestedOrders.map(group => (
            <div key={String(group.supplier)} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px',
              padding: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', marginBottom: '6px'
            }}>
              <span>
                <b>{group.supplierName}</b> · {group.lineCount} line(s) · {rs(group.expectedCost)}
              </span>
              <button onClick={() => setConfirm(group)}>
                <ShoppingCart size={14}/> Create draft PO
              </button>
            </div>
          ))}
        </section>
      )}

      <section>
        <h3>Recommendations</h3>
        {!visible.length && <p style={{opacity: 0.7}}>Nothing needs reordering for this branch.</p>}
        {!!visible.length && (
          <div style={{overflowX: 'auto'}}>
            <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
              <thead>
                <tr style={{textAlign: 'left', borderBottom: '2px solid #e5e7eb'}}>
                  <th>Status</th><th>Ingredient</th><th>Branch</th>
                  <th style={{textAlign: 'right'}}>On hand</th>
                  <th style={{textAlign: 'right'}}>Reorder point</th>
                  <th style={{textAlign: 'right'}}>Target</th>
                  <th style={{textAlign: 'right'}}>Suggested</th>
                  <th>Supplier</th><th>SKU</th>
                  <th style={{textAlign: 'right'}}>Price/unit</th>
                  <th style={{textAlign: 'right'}}>Lead</th>
                  <th style={{textAlign: 'right'}}>Est. value</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(line => {
                  const style = URGENCY_STYLE[line.urgency] || URGENCY_STYLE.ok;
                  return (
                    <tr key={`${line.branch}:${line.ingredient}`} style={{borderBottom: '1px solid #f1f5f9'}}>
                      <td>
                        <span style={{
                          padding: '1px 6px', borderRadius: '999px', fontSize: '10px',
                          textTransform: 'uppercase', letterSpacing: '.4px',
                          background: style.background, border: `1px solid ${style.border}`, color: style.text
                        }}>{style.label}</span>
                      </td>
                      <td>{line.ingredientName}</td>
                      <td>{line.branchName || line.branchCode || ''}</td>
                      <td style={{textAlign: 'right'}}>{qty(line.currentStock)} {line.unit}</td>
                      <td style={{textAlign: 'right'}}>{qty(line.reorderPoint)}</td>
                      <td style={{textAlign: 'right'}}>{qty(line.orderUpTo)}</td>
                      <td style={{textAlign: 'right'}}><b>{qty(line.suggestedQty)}</b></td>
                      <td>{line.supplierName || <em style={{opacity: 0.6}}>none</em>}</td>
                      <td>{line.supplierSku || ''}</td>
                      <td style={{textAlign: 'right'}}>{line.unitCost === null ? '—' : rs(line.unitCost)}</td>
                      <td style={{textAlign: 'right'}}>
                        {line.leadTimeDays}d
                        {line.leadTimeSource === 'measured' && (
                          <span title={`Measured from ${line.leadTimeSamples} deliveries`} style={{opacity: 0.6}}> ✓</span>
                        )}
                      </td>
                      <td style={{textAlign: 'right'}}>{line.expectedCost === null ? '—' : rs(line.expectedCost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {confirm && (
        <div role="dialog" aria-modal="true" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50
        }}>
          <div style={{background: '#fff', padding: '18px', borderRadius: '10px', maxWidth: '460px', width: '90%'}}>
            <h3 style={{marginTop: 0}}>Create a draft purchase order?</h3>
            <p style={{fontSize: '13px'}}>
              <b>{confirm.supplierName}</b> — {confirm.lineCount} line(s), estimated {rs(confirm.expectedCost)}.
            </p>
            <ul style={{fontSize: '12px', maxHeight: '160px', overflow: 'auto', paddingLeft: '18px'}}>
              {confirm.items.map(item => (
                <li key={String(item.ingredient)}>
                  {item.ingredientName} — {qty(item.suggestedQty)} {item.unit} ({rs(item.expectedCost)})
                </li>
              ))}
            </ul>
            <p style={{fontSize: '12px', color: '#92400e', background: '#fffbeb', padding: '8px', borderRadius: '6px'}}>
              This creates a <b>draft</b> only. It must still be submitted and approved before
              any stock can be received against it.
            </p>
            <div style={{display: 'flex', justifyContent: 'flex-end', gap: '8px'}}>
              <button onClick={() => setConfirm(null)} disabled={busy === 'po'}>Cancel</button>
              <button onClick={() => createOrder(confirm)} disabled={busy === 'po'}>
                {busy === 'po' ? 'Creating…' : 'Create draft PO'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
