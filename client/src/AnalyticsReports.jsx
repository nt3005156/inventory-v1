import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {BarChart3} from 'lucide-react';

/**
 * Phase 18 — reporting workspace.
 *
 * Deliberately SEPARATE from the existing `Analytics.jsx`, which already served
 * menu engineering and a P&L summary. That screen is untouched; this one adds
 * the sales / inventory / customer report families the brief asks for.
 *
 * Binds to the existing report endpoints; no figure is recomputed on the
 * client, so the screen cannot disagree with the API. Management only, and the
 * component does not fetch at all for a role that may not see it (the backend
 * 403 remains the authoritative control).
 */

const rs = value => `Rs ${Number(value || 0).toLocaleString('en-NP', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
})}`;
const num = value => Number(value || 0).toLocaleString('en-NP', {maximumFractionDigits: 3});

const TABS = ['Overview', 'Sales', 'Inventory', 'Customers'];

function Kpi({label, value, hint}) {
  return (
    <div style={{padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: '8px', minWidth: '140px'}}>
      <div style={{fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '.4px'}}>{label}</div>
      <div style={{fontSize: '20px', fontWeight: 700}}>{value}</div>
      {hint && <div style={{fontSize: '11px', opacity: 0.6}}>{hint}</div>}
    </div>
  );
}

function Table({columns, rows, empty}) {
  if (!rows?.length) return <p style={{opacity: 0.7}}>{empty}</p>;
  return (
    <div style={{overflowX: 'auto'}}>
      <table style={{width: '100%', borderCollapse: 'collapse', fontSize: '13px'}}>
        <thead>
          <tr style={{textAlign: 'left', borderBottom: '2px solid #e5e7eb'}}>
            {columns.map(col => (
              <th key={col.key} style={{textAlign: col.right ? 'right' : 'left', padding: '4px 6px'}}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row._key || index} style={{borderBottom: '1px solid #f1f5f9'}}>
              {columns.map(col => (
                <td key={col.key} style={{textAlign: col.right ? 'right' : 'left', padding: '4px 6px'}}>
                  {col.render ? col.render(row) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AnalyticsReports({call, branches = [], user}) {
  const isManager = ['owner', 'manager'].includes(user?.role);
  const [tab, setTab] = useState('Overview');
  const [branchId, setBranchId] = useState(() => (branches[0]?._id ? String(branches[0]._id) : ''));
  const [granularity, setGranularity] = useState('daily');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState({pnl: null, sales: null, inventory: null, customers: null});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const parts = [];
    if (branchId) parts.push(`branch=${encodeURIComponent(branchId)}`);
    if (from) parts.push(`from=${encodeURIComponent(from)}`);
    if (to) parts.push(`to=${encodeURIComponent(to)}`);
    return parts.length ? `?${parts.join('&')}` : '';
  }, [branchId, from, to]);

  const load = useCallback(async () => {
    if (!isManager) return;
    setLoading(true);
    setError('');
    try {
      const salesQuery = query
        ? `${query}&granularity=${granularity}`
        : `?granularity=${granularity}`;
      const [pnl, sales, inventory, customers] = await Promise.all([
        call(`/reports/pnl${query}`),
        call(`/reports/sales${salesQuery}`),
        call(`/reports/inventory${query}`),
        call(`/reports/customers${query}`)
      ]);
      setData({pnl, sales, inventory, customers});
    } catch (e) {
      setError(e.message || 'Could not load analytics');
    } finally {
      setLoading(false);
    }
  }, [call, query, granularity, isManager]);

  useEffect(() => { load(); }, [load]);

  if (!isManager) {
    return (
      <div style={{padding: '16px'}}>
        <h1>Reports</h1>
        <p>Reporting is available to managers and owners.</p>
      </div>
    );
  }

  const {pnl, sales, inventory, customers} = data;

  return (
    <div style={{padding: '16px'}}>
      <header style={{display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap'}}>
        <h1 style={{margin: 0, display: 'flex', alignItems: 'center', gap: '8px'}}>
          <BarChart3 size={20}/> Reports
        </h1>
        <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center'}}>
          <select value={branchId} onChange={e => setBranchId(e.target.value)}>
            {user?.role === 'owner' && <option value="">All branches</option>}
            {branches.map(b => <option key={b._id} value={String(b._id)}>{b.name}</option>)}
          </select>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="From"/>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="To"/>
          <button onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
        </div>
      </header>

      <nav style={{display: 'flex', gap: '6px', margin: '12px 0'}}>
        {TABS.map(name => (
          <button key={name} onClick={() => setTab(name)}
            style={{
              fontWeight: tab === name ? 700 : 400,
              borderBottom: tab === name ? '2px solid #111' : '2px solid transparent'
            }}>
            {name}
          </button>
        ))}
      </nav>

      {error && <p style={{color: '#991b1b'}}>{error}</p>}

      {tab === 'Overview' && pnl && (
        <section>
          <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px'}}>
            <Kpi label="Net revenue" value={rs(pnl.revenue)} hint="after refunds"/>
            <Kpi label="Gross revenue" value={rs(pnl.grossRevenue)}/>
            <Kpi label="Refunds" value={rs(pnl.refunds)}/>
            <Kpi label="Discounts" value={rs(pnl.discounts)}/>
            <Kpi label="VAT" value={rs(pnl.vat)}/>
            <Kpi label="COGS" value={rs(pnl.cogs)}/>
            <Kpi label="Gross profit" value={rs(pnl.grossProfit)}/>
            <Kpi label="Purchases" value={rs(pnl.purchases)}/>
            <Kpi label="Waste" value={rs(pnl.waste)}/>
            <Kpi label="Inventory value" value={rs(pnl.inventoryValue)}/>
            <Kpi label="Net profit" value={rs(pnl.netProfit)}/>
          </div>
          <p style={{fontSize: '12px', opacity: 0.7}}>
            Revenue, COGS and waste come from orders and the inventory ledger; purchases from
            the purchasing report. No figure is recomputed on this screen.
          </p>
        </section>
      )}

      {tab === 'Sales' && sales && (
        <section>
          <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px'}}>
            <Kpi label="Orders" value={sales.totals.orders}/>
            <Kpi label="Net revenue" value={rs(sales.totals.netRevenue)}/>
            <Kpi label="Avg order" value={rs(sales.totals.averageOrderValue)}/>
            <Kpi label="Gross profit" value={rs(sales.totals.grossProfit)}/>
          </div>
          <div style={{display: 'flex', gap: '8px', marginBottom: '10px'}}>
            {['daily', 'weekly', 'monthly'].map(option => (
              <button key={option} onClick={() => setGranularity(option)}
                style={{fontWeight: granularity === option ? 700 : 400}}>
                {option}
              </button>
            ))}
          </div>

          <h3>By period</h3>
          <Table
            empty="No sales in this period."
            rows={sales.byPeriod.map(row => ({...row, _key: row.period}))}
            columns={[
              {key: 'period', label: 'Period'},
              {key: 'orders', label: 'Orders', right: true},
              {key: 'netRevenue', label: 'Net revenue', right: true, render: r => rs(r.netRevenue)},
              {key: 'grossProfit', label: 'Gross profit', right: true, render: r => rs(r.grossProfit)}
            ]}
          />

          <h3>By item</h3>
          <Table
            empty="No items sold."
            rows={sales.byItem.slice(0, 20).map(row => ({...row, _key: row.menuItem}))}
            columns={[
              {key: 'name', label: 'Item'},
              {key: 'category', label: 'Category'},
              {key: 'qty', label: 'Qty', right: true, render: r => num(r.qty)},
              {key: 'revenue', label: 'Revenue', right: true, render: r => rs(r.revenue)}
            ]}
          />

          <h3>By category</h3>
          <Table
            empty="No categories."
            rows={sales.byCategory.map(row => ({...row, _key: row.category}))}
            columns={[
              {key: 'category', label: 'Category'},
              {key: 'qty', label: 'Qty', right: true, render: r => num(r.qty)},
              {key: 'revenue', label: 'Revenue', right: true, render: r => rs(r.revenue)}
            ]}
          />

          <h3>By payment method</h3>
          <Table
            empty="No payments recorded."
            rows={sales.byPaymentMethod.map(row => ({...row, _key: row.method}))}
            columns={[
              {key: 'method', label: 'Method'},
              {key: 'count', label: 'Tenders', right: true},
              {key: 'amount', label: 'Amount', right: true, render: r => rs(r.amount)}
            ]}
          />
        </section>
      )}

      {tab === 'Inventory' && inventory && (
        <section>
          <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px'}}>
            <Kpi label="Stock value" value={rs(inventory.stockValue)}/>
            <Kpi label="Waste" value={rs(inventory.waste.value)} hint={`${inventory.waste.events} event(s)`}/>
            <Kpi label="Adjustments" value={rs(inventory.adjustments.value)} hint={`${inventory.adjustments.events} event(s)`}/>
            <Kpi label="Count variance" value={rs(inventory.countVariance.varianceValue)}
              hint={`${inventory.countVariance.counts} approved count(s)`}/>
            <Kpi label="Expired stock" value={rs(inventory.expiry.expired.value)}
              hint={`${inventory.expiry.expired.count} lot(s)`}/>
            <Kpi label="Expiring soon" value={rs(inventory.expiry.expiring.value)}
              hint={`${inventory.expiry.expiring.count} lot(s)`}/>
          </div>

          <h3>Movement by type</h3>
          <Table
            empty="No stock movement in this period."
            rows={inventory.movement.byType.map(row => ({...row, _key: row.type}))}
            columns={[
              {key: 'type', label: 'Type'},
              {key: 'count', label: 'Rows', right: true},
              {key: 'quantity', label: 'Quantity', right: true, render: r => num(r.quantity)},
              {key: 'value', label: 'Value', right: true, render: r => rs(r.value)}
            ]}
          />

          <h3>Highest value on hand</h3>
          <Table
            empty="No stock on hand."
            rows={inventory.topValue.slice(0, 15).map(row => ({...row, _key: row.ingredient}))}
            columns={[
              {key: 'name', label: 'Ingredient'},
              {key: 'quantity', label: 'Qty', right: true, render: r => `${num(r.quantity)} ${r.unit}`},
              {key: 'value', label: 'Value', right: true, render: r => rs(r.value)}
            ]}
          />

          <h3>Waste by ingredient</h3>
          <Table
            empty="No waste recorded."
            rows={inventory.waste.byIngredient.map(row => ({...row, _key: row.ingredient}))}
            columns={[
              {key: 'name', label: 'Ingredient'},
              {key: 'quantity', label: 'Qty', right: true, render: r => num(r.quantity)},
              {key: 'value', label: 'Value', right: true, render: r => rs(r.value)}
            ]}
          />
        </section>
      )}

      {tab === 'Customers' && customers && (
        <section>
          <div style={{display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '10px'}}>
            <Kpi label="Customers" value={customers.totals.customers}/>
            <Kpi label="Repeat" value={customers.totals.repeatCustomers}
              hint={`${customers.totals.repeatRate}% of identified`}/>
            <Kpi label="Avg order" value={rs(customers.totals.averageOrderValue)}/>
            <Kpi label="Walk-in orders" value={customers.totals.anonymousOrders}
              hint={rs(customers.totals.anonymousRevenue)}/>
          </div>
          <p style={{fontSize: '12px', opacity: 0.7}}>
            Repeat basis: {customers.totals.repeatBasis}.
          </p>

          <h3>Top customers</h3>
          <Table
            empty="No identified customers in this period."
            rows={customers.topCustomers.map(row => ({...row, _key: row.customer}))}
            columns={[
              {key: 'name', label: 'Customer'},
              {key: 'phone', label: 'Phone'},
              {key: 'orders', label: 'Orders', right: true},
              {key: 'revenue', label: 'Revenue', right: true, render: r => rs(r.revenue)},
              {key: 'averageOrderValue', label: 'Avg order', right: true, render: r => rs(r.averageOrderValue)}
            ]}
          />
        </section>
      )}
    </div>
  );
}
