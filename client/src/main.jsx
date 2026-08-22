import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LayoutDashboard, Package, ShoppingCart, ChefHat, UtensilsCrossed, Armchair, BarChart3, Receipt, LogOut, CalendarCheck2, Users, Bike, ClipboardList, PackageSearch, Gauge, Download, ShieldCheck} from 'lucide-react';
import Purchasing from './Purchasing.jsx';
import StockOps from './StockOps.jsx';
import SupplierCatalog from './SupplierCatalog.jsx';
import Kds from './Kds.jsx';
import Tables from './Tables.jsx';
import Analytics from './Analytics.jsx';
import Inventory from './Inventory.jsx';
import Reorder from './Reorder.jsx';
import SupplierPerformance from './SupplierPerformance.jsx';
import AnalyticsReports from './AnalyticsReports.jsx';
import Exports from './Exports.jsx';
import AccessControl from './AccessControl.jsx';
import Dashboard from './Dashboard.jsx';
import Ingredients from './Ingredients.jsx';
import Recipes from './Recipes.jsx';
import POS from './Pos.jsx';
import Expenses from './Expenses.jsx';
import MonthClose from './MonthClose.jsx';
import Reservations from './Reservations.jsx';
import Customers from './Customers.jsx';
import Deliveries from './Deliveries.jsx';
import PosAdmin from './PosAdmin.jsx';
import RiderApp from './RiderApp.jsx';
import Storefront from './Storefront.jsx';
import './style.css';

const API = String(import.meta.env.VITE_API_URL || '/api').replace(/\/$/, '');

function App() {
  const [token, setToken] = useState(localStorage.token);
  const [user, setUser] = useState(JSON.parse(localStorage.user || 'null'));
  const [page, setPage] = useState('Dashboard');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  // Phase 20: the caller's real permissions, resolved server-side. Used only
  // to decide what to SHOW; the backend enforces every one of them again.
  const [permissions, setPermissions] = useState([]);

  const call = async (path, opts = {}) => {
    const {raw, ...init} = opts;
    const r = await fetch(API + path, {
      ...init,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...init.headers}
    });
    if (!r.ok) {
      // Error bodies are JSON even when the success body is not (e.g. receipts).
      let message = 'Request failed';
      try { message = (await r.json()).message || message; } catch { message = await r.text() || message; }
      throw new Error(message);
    }
    if (raw) return r.text();
    return r.status === 204 ? null : r.json();
  };

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [menu, branches, me] = await Promise.all([
        call('/menu-items'),
        call('/branches'),
        // A principal always has this; failing soft keeps the shell usable if
        // an older server has not shipped the endpoint yet.
        call('/me/permissions').catch(() => ({permissions: []}))
      ]);
      // /menu-items is paginated ({items, pagination}); older builds returned a bare array.
      setData({menu: Array.isArray(menu) ? menu : (menu?.items || []), branches});
      setPermissions(me?.permissions || []);
    } catch (e) {
      if (e.message === 'Authentication required') logout();
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [token]);

  const logout = () => {
    localStorage.clear();
    setToken(null);
  };

  // Phase 8A: the storefront is public and must render before the login gate.
  if (typeof window !== 'undefined' && window.location.pathname.startsWith('/order')) {
    return <Storefront/>;
  }

  if (!token) {
    return <Login onLogin={x => {
      localStorage.token = x.token;
      localStorage.user = JSON.stringify(x.user);
      setToken(x.token);
      setUser(x.user);
    }}/>;
  }

  // Phase 11: a rider gets the courier workspace instead of the staff shell.
  // The backend refuses them every operational endpoint regardless; this stops
  // a phone user staring at a navigation menu where nothing works.
  if (user?.role === 'rider') {
    return <RiderApp call={call} user={user} token={token} onLogout={logout}/>;
  }

  // An owner is unrestricted, so the nav must not hide anything from them
  // even before /me/permissions resolves.
  const can = key => user?.role === 'owner' || permissions.includes(key);

  const nav = [
    ['Dashboard', LayoutDashboard],
    ['Inventory', Package],
    ['Ingredients', Package],
    ['Recipes', ChefHat],
    ['Stock Ops', Package],
    ['Purchases', ShoppingCart],
    ['Reorder', PackageSearch],
    ['Supplier Performance', Gauge],
    ['Reports', BarChart3],
    ...(can('reports.export') ? [['Exports', Download]] : []),
    ['Expenses', Receipt],
    ['Supplier Catalog', ShoppingCart],
    ['Tables', Armchair],
    ['Reservations', CalendarCheck2],
    ['Customers', Users],
    ['Deliveries', Bike],
    ['POS', ChefHat],
    ['POS Admin', ClipboardList],
    ['KDS', UtensilsCrossed],
    ...(can('monthclose.manage') ? [['Month Close', CalendarCheck2]] : []),
    ...(can('users.manage') || can('roles.manage') ? [['Access Control', ShieldCheck]] : []),
    ['Analytics', BarChart3]
  ];

  return (
    <div className="shell">
      <aside>
        <div className="brand"><span>mittho</span><small>OPS · Nepal</small></div>
        {nav.map(([x, I]) => (
          <button key={x} className={page === x ? 'active' : ''} onClick={() => setPage(x)}><I size={18}/>{x}</button>
        ))}
        <div className="asidebottom">
          <small>{user?.name} · {user?.role}</small>
          <button onClick={logout}><LogOut size={17}/> Sign out</button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <p className="eyebrow">MITTHO BIRYANI HOUSE</p>
            <h1>{page}</h1>
          </div>
          <div className="date">Aaja · {new Date().toLocaleDateString('en-NP', {dateStyle: 'full'})}</div>
        </header>
        {loading
          ? <p>Updating live data…</p>
          : <Page page={page} data={data} call={call} user={user} token={token} permissions={permissions}/>}
      </main>
    </div>
  );
}

function Login({onLogin}) {
  const [email, setEmail] = useState('owner@mittho.com');
  const [password, setPassword] = useState('mittho123');
  const [error, setError] = useState('');
  return (
    <div className="login">
      <form onSubmit={async e => {
        e.preventDefault();
        try {
          const r = await fetch(API + '/auth/login', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({email, password})
          });
          if (!r.ok) throw Error('Incorrect credentials');
          onLogin(await r.json());
        } catch (e) {
          setError(e.message);
        }
      }}>
        <div className="loginbrand">mittho <span>OPS</span></div>
        <h1>Restaurant, in control.</h1>
        <p>Inventory · costing · sales · profit</p>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Email"/>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"/>
        {error && <p className="danger">{error}</p>}
        <button>Sign in to workspace</button>
        <small>Demo: owner@mittho.com / mittho123</small>
      </form>
    </div>
  );
}

function Page({page, data, call, user, token, permissions = []}) {
  const branches = data.branches || [];
  if (page === 'Dashboard') return <Dashboard call={call} branches={branches} user={user}/>;
  if (page === 'Stock Ops') return <StockOps call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Inventory') return <Inventory call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Ingredients') return <Ingredients call={call}/>;
  if (page === 'Recipes') return <Recipes call={call}/>;
  if (page === 'Tables') return <Tables call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Reservations') return <Reservations call={call} branches={branches} user={user}/>;
  if (page === 'Customers') return <Customers call={call} branches={branches} user={user}/>;
  if (page === 'Deliveries') return <Deliveries call={call} branches={branches} user={user} token={token}/>;
  if (page === 'POS Admin') return <PosAdmin call={call} branches={branches} user={user}/>;
  if (page === 'POS') return <POS menu={data.menu || []} branches={branches} user={user} call={call}/>;
  if (page === 'KDS') return <Kds call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Purchases') return <Purchasing call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Reorder') return <Reorder call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Supplier Performance') return <SupplierPerformance call={call} branches={branches} user={user}/>;
  if (page === 'Reports') return <AnalyticsReports call={call} branches={branches} user={user}/>;
  if (page === 'Exports') return <Exports call={call} token={token} user={user} apiBase={API}/>;
  if (page === 'Access Control') {
    const effective = user?.role === 'owner' && permissions.length === 0
      ? ['users.manage', 'roles.manage']
      : permissions;
    return <AccessControl call={call} user={user} permissions={effective}/>;
  }
  if (page === 'Expenses') return <Expenses call={call} branches={branches} user={user}/>;
  if (page === 'Month Close') return <MonthClose call={call} branches={branches} user={user}/>;
  if (page === 'Supplier Catalog') return <SupplierCatalog call={call}/>;
  return <Analytics call={call} branches={branches} user={user}/>;
}

createRoot(document.getElementById('root')).render(<App/>);
