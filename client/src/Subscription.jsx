import React, {useCallback, useEffect, useState} from 'react';
import {CreditCard} from 'lucide-react';

/**
 * P2C — the TENANT's view of their own subscription.
 *
 * READ ONLY, and deliberately so. There is no control here that changes a
 * plan, starts a trial or cancels anything, because there is no tenant-side
 * write endpoint to call: self-service billing is a commercial design that
 * does not exist yet (no gateway, no dunning, no proration). Rendering a
 * "Upgrade" button that posts to a platform-only endpoint would produce a 403
 * and teach the owner that the product is broken.
 *
 * What it does show is everything the owner needs to understand a refusal:
 * which plan they are on, whether it is operational, what it includes, and how
 * close they are to each limit. When the POS refuses to add a branch, this is
 * the screen that explains why.
 *
 * NOT A SECURITY BOUNDARY. Every figure here comes from `/my/entitlements`,
 * which resolves the tenant from the authenticated principal; the same
 * entitlements are re-checked server-side on every write.
 */

const stamp = value => {
  if (!value) return '—';
  // Kathmandu local time, matching every other screen.
  return new Date(new Date(value).getTime() + 5.75 * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 16);
};

const STATUS_TONES = {
  active: {background: '#dcfce7', color: '#166534'},
  trialing: {background: '#dbeafe', color: '#1e40af'},
  past_due: {background: '#fef3c7', color: '#92400e'},
  cancelled: {background: '#fee2e2', color: '#991b1b'},
  expired: {background: '#fee2e2', color: '#991b1b'}
};

function Pill({children, tone}) {
  const style = STATUS_TONES[tone] || {background: '#f1f5f9', color: '#334155'};
  return (
    <span style={{
      ...style, padding: '2px 9px', borderRadius: '999px',
      fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', whiteSpace: 'nowrap'
    }}>{children}</span>
  );
}

/**
 * One limit row with a usage bar.
 *
 * `null` is unlimited and is rendered as the word, never as a bar at 0% or
 * 100% — both would be lies about a limit that does not exist.
 */
function LimitRow({label, used, limit}) {
  const unlimited = limit === null || limit === undefined;
  const usedValue = used === null || used === undefined ? null : Number(used);
  const pct = unlimited || usedValue === null || limit === 0
    ? 0
    : Math.min(100, Math.round((usedValue / limit) * 100));
  // Amber from 80%, red at the ceiling: an owner should see it coming.
  const tone = pct >= 100 ? '#dc2626' : pct >= 80 ? '#d97706' : '#2563eb';

  return (
    <tr>
      <td style={{whiteSpace: 'nowrap'}}>{label}</td>
      <td style={{whiteSpace: 'nowrap'}}>
        {usedValue === null ? '—' : usedValue}{unlimited ? '' : ` / ${limit}`}
      </td>
      <td style={{width: '45%'}}>
        {unlimited
          ? <span style={{fontSize: '11px', color: '#64748b'}}>unlimited</span>
          : (
            <div style={{background: '#e2e8f0', borderRadius: '999px', height: '8px', width: '100%'}}>
              <div style={{
                width: `${pct}%`, background: tone, height: '8px', borderRadius: '999px'
              }}/>
            </div>
          )}
      </td>
    </tr>
  );
}

const LIMIT_LABELS = {
  maxBranches: 'Branches',
  maxUsers: 'User accounts',
  maxManagers: 'Managers',
  maxStaff: 'Staff',
  maxRiders: 'Riders',
  maxMenuItems: 'Menu items',
  maxCustomers: 'Customers',
  maxTables: 'Tables',
  maxStations: 'Kitchen stations',
  maxMonthlyOrders: 'Orders this month',
  maxMonthlyOnlineOrders: 'Online orders this month'
};

export default function Subscription({call}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try { setData(await call('/my/entitlements')); }
    catch (e) { setError(e.message); }
  }, [call]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="danger">{error}</p>;
  if (!data) return <p>Loading your subscription…</p>;

  const enabled = Object.entries(data.features).filter(([, on]) => on).map(([key]) => key);
  const disabled = Object.entries(data.features).filter(([, on]) => !on).map(([key]) => key);

  return (
    <div>
      <div style={{
        background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px',
        padding: '16px', marginBottom: '16px'
      }}>
        <div style={{display: 'flex', alignItems: 'center', gap: '10px'}}>
          <CreditCard size={20}/>
          <h2 style={{margin: 0}}>
            {data.planName || 'No plan'}{' '}
            {data.status && <Pill tone={data.status}>{data.status}</Pill>}
          </h2>
        </div>

        {!data.operational && (
          /**
           * The actionable message. An owner seeing a refusal elsewhere in the
           * product needs to know it is commercial, not a permission fault,
           * and that the platform administrator is who resolves it.
           */
          <p style={{color: '#991b1b', marginBottom: 0}}>
            Your subscription does not currently permit new records
            {data.reason ? ` (${data.reason.replace(/_/g, ' ')})` : ''}.
            Your existing data remains available. Contact the platform administrator.
          </p>
        )}

        <dl style={{display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px', fontSize: '13px'}}>
          <dt style={{color: '#64748b'}}>Plan code</dt><dd>{data.planCode || '—'}</dd>
          <dt style={{color: '#64748b'}}>Trial ends</dt><dd>{stamp(data.trialEnd)}</dd>
          <dt style={{color: '#64748b'}}>Billing period ends</dt><dd>{stamp(data.currentPeriodEnd)}</dd>
        </dl>
      </div>

      <h3>Usage against your plan</h3>
      <table>
        <thead><tr><th>Resource</th><th>Used</th><th/></tr></thead>
        <tbody>
          {Object.keys(LIMIT_LABELS).map(key => (
            <LimitRow
              key={key} label={LIMIT_LABELS[key]}
              used={data.usage?.[key]} limit={data.limits?.[key]}
            />
          ))}
        </tbody>
      </table>

      <h3>Included in your plan</h3>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: '6px'}}>
        {enabled.length
          ? enabled.map(key => <Pill key={key} tone="active">{key}</Pill>)
          : <span style={{color: '#64748b'}}>No features are currently enabled.</span>}
      </div>

      {disabled.length > 0 && (
        <>
          <h3>Not included</h3>
          <div style={{display: 'flex', flexWrap: 'wrap', gap: '6px'}}>
            {disabled.map(key => <Pill key={key} tone="cancelled">{key}</Pill>)}
          </div>
        </>
      )}

      <p style={{fontSize: '11px', color: '#94a3b8', marginTop: '16px'}}>
        Plan changes are made by the platform administrator. This screen is read only.
      </p>
    </div>
  );
}
