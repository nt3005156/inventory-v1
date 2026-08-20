import React, {useCallback, useEffect, useState} from 'react';
import {Gauge} from 'lucide-react';

/**
 * Phase 16B — supplier delivery performance.
 *
 * The rule this screen exists to enforce visually: a CATALOG lead time is a
 * claim, a MEASURED lead time is a fact, and the two must never be shown as
 * though they were the same thing. Where there is not enough history the
 * screen says so rather than rendering a number that looks authoritative.
 */

const days = value => (value === null || value === undefined ? '—' : `${value}d`);
const pct = value => (value === null || value === undefined ? 'N/A' : `${value}%`);

export default function SupplierPerformance({call, branches = [], user}) {
  const isManager = ['owner', 'manager'].includes(user?.role);
  const [suppliers, setSuppliers] = useState([]);
  const [supplierId, setSupplierId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!isManager) return;
    call('/suppliers?limit=200')
      .then(rows => setSuppliers(Array.isArray(rows) ? rows : rows?.items || []))
      .catch(e => setError(e.message || 'Could not load suppliers'));
  }, [call, isManager]);

  const load = useCallback(async () => {
    if (!supplierId) { setReport(null); return; }
    setLoading(true);
    setError('');
    try {
      const query = branchId ? `?branch=${encodeURIComponent(branchId)}` : '';
      setReport(await call(`/suppliers/${supplierId}/performance${query}`));
    } catch (e) {
      setError(e.message || 'Could not load supplier performance');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [call, supplierId, branchId]);

  useEffect(() => { load(); }, [load]);

  if (!isManager) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Supplier performance</h1>
        <p>Supplier performance is available to managers and owners.</p>
      </div>
    );
  }

  const measured = report && !report.insufficientData;

  return (
    <div style={{padding: '16px'}}>
      <header>
        <h1 style={{margin: 0, display: 'flex', alignItems: 'center', gap: '8px'}}>
          <Gauge size={20}/> Supplier performance
        </h1>
        <p style={{margin: '4px 0 12px', opacity: 0.7, fontSize: '13px'}}>
          Actual lead time is measured from purchase order approval to goods receipt.
        </p>
      </header>

      <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px'}}>
        <select value={supplierId} onChange={e => setSupplierId(e.target.value)}>
          <option value="">Select a supplier…</option>
          {suppliers.map(s => <option key={s._id} value={String(s._id)}>{s.name}</option>)}
        </select>
        <select value={branchId} onChange={e => setBranchId(e.target.value)}>
          <option value="">All branches</option>
          {branches.map(b => <option key={b._id} value={String(b._id)}>{b.name}</option>)}
        </select>
        <button onClick={load} disabled={loading || !supplierId}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <p style={{color: '#991b1b'}}>{error}</p>}
      {!supplierId && <p style={{opacity: 0.7}}>Choose a supplier to see its delivery history.</p>}

      {report && (
        <>
          <div style={{display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '12px'}}>
            {[
              ['Purchase orders', report.totalPurchaseOrders ?? 0],
              ['Received POs', report.receivedPurchaseOrders ?? 0],
              ['Late deliveries', report.lateCount ?? '—'],
              ['On-time rate', pct(report.onTimeRate)],
              ['Partial first receipts', report.partialFirstReceipts ?? 0]
            ].map(([label, value]) => (
              <div key={label} style={{padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: '8px', minWidth: '120px'}}>
                <div style={{fontSize: '11px', opacity: 0.6, textTransform: 'uppercase'}}>{label}</div>
                <div style={{fontSize: '18px', fontWeight: 700}}>{value}</div>
              </div>
            ))}
          </div>

          {/* The distinction the brief insists on: claim vs measurement. */}
          <div style={{display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))'}}>
            <section style={{border: '1px solid #e5e7eb', borderRadius: '8px', padding: '12px'}}>
              <h3 style={{margin: '0 0 6px', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '.4px', opacity: 0.7}}>
                Catalog lead time (declared)
              </h3>
              <div style={{fontSize: '24px', fontWeight: 700}}>{days(report.declaredLeadDays || null)}</div>
              <p style={{fontSize: '12px', opacity: 0.7, margin: '6px 0 0'}}>
                What the supplier promises. A claim, not a measurement.
              </p>
            </section>

            <section style={{
              border: `1px solid ${measured ? '#16a34a' : '#d97706'}`, borderRadius: '8px', padding: '12px',
              background: measured ? '#f0fdf4' : '#fffbeb'
            }}>
              <h3 style={{margin: '0 0 6px', fontSize: '13px', textTransform: 'uppercase', letterSpacing: '.4px', opacity: 0.7}}>
                Actual lead time (measured)
              </h3>
              {measured ? (
                <>
                  <div style={{fontSize: '24px', fontWeight: 700}}>{days(report.averageLeadDays)} average</div>
                  <p style={{fontSize: '12px', margin: '6px 0 0'}}>
                    Median {days(report.medianLeadDays)} · range {days(report.minLeadDays)}–{days(report.maxLeadDays)}
                    {' '}· from {report.samples} deliveries
                  </p>
                  <p style={{fontSize: '12px', margin: '6px 0 0', opacity: 0.75}}>
                    Measured to the <b>first receipt</b> — when goods first arrived.
                  </p>
                  <p style={{fontSize: '12px', margin: '4px 0 0', opacity: 0.75}}>
                    Fully received: {report.averageFullLeadDays === null
                      ? 'no order has completed yet'
                      : `${days(report.averageFullLeadDays)} average (median ${days(report.medianFullLeadDays)}), from ${report.fullyReceivedSamples} completed order(s)`}
                  </p>
                </>
              ) : (
                <>
                  <div style={{fontSize: '18px', fontWeight: 700}}>Insufficient data</div>
                  <p style={{fontSize: '12px', margin: '6px 0 0'}}>{report.reason}</p>
                  <p style={{fontSize: '12px', margin: '6px 0 0', opacity: 0.75}}>
                    The reorder engine falls back to the catalog lead time until enough
                    deliveries have been recorded.
                  </p>
                </>
              )}
            </section>
          </div>

          {report.onTimeRate === null && (
            <p style={{
              fontSize: '12px', marginTop: '10px', padding: '8px', borderRadius: '6px',
              background: '#f8fafc', border: '1px solid #e5e7eb'
            }}>
              <b>On-time rate N/A.</b> {report.onTimeBasis}
            </p>
          )}

          {!!report.deliveries?.length && (
            <section style={{marginTop: '14px'}}>
              <h3>Recent deliveries</h3>
              <div style={{overflowX: 'auto'}}>
                <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
                  <thead>
                    <tr style={{textAlign: 'left', borderBottom: '2px solid #e5e7eb'}}>
                      <th>PO</th><th>Approved</th><th>First receipt</th>
                      <th style={{textAlign: 'right'}}>Lead (first)</th>
                      <th style={{textAlign: 'right'}}>Lead (complete)</th>
                      <th style={{textAlign: 'right'}}>Promised</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.deliveries.map(row => (
                      <tr key={String(row.purchaseOrder)} style={{borderBottom: '1px solid #f1f5f9'}}>
                        <td>{row.poNo}</td>
                        <td>{new Date(row.approvedAt).toLocaleDateString('en-NP')}</td>
                        <td>{new Date(row.receivedAt).toLocaleDateString('en-NP')}</td>
                        <td style={{textAlign: 'right'}}>{days(row.actualLeadDays)}</td>
                        <td style={{textAlign: 'right'}}>
                          {row.fullLeadDays === null
                            ? <span title="Still short delivered" style={{opacity: 0.6}}>—</span>
                            : days(row.fullLeadDays)}
                        </td>
                        <td style={{textAlign: 'right'}}>
                          {row.promisedLeadDays === null ? 'none' : days(row.promisedLeadDays)}
                        </td>
                        <td>
                          {row.partialFirstReceipt && (
                            <span style={{
                              padding: '1px 6px', borderRadius: '999px', fontSize: '10px',
                              background: '#fffbeb', border: '1px solid #d97706', color: '#92400e'
                            }}>partial</span>
                          )}
                          {row.late && (
                            <span style={{
                              marginLeft: '4px', padding: '1px 6px', borderRadius: '999px', fontSize: '10px',
                              background: '#fef2f2', border: '1px solid #dc2626', color: '#991b1b'
                            }}>late</span>
                          )}
                          {!row.partialFirstReceipt && !row.late && (
                            <span style={{opacity: 0.6, fontSize: '11px'}}>complete</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
