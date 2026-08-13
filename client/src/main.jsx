import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {LayoutDashboard, Package, ShoppingCart, ChefHat, UtensilsCrossed, Armchair, BarChart3, Receipt, LogOut} from 'lucide-react';
import Purchasing from './Purchasing.jsx';
import StockOps from './StockOps.jsx';
import SupplierCatalog from './SupplierCatalog.jsx';
import Kds from './Kds.jsx';
import Tables from './Tables.jsx';
import Analytics from './Analytics.jsx';
import Inventory from './Inventory.jsx';
import Dashboard from './Dashboard.jsx';
import POS from './Pos.jsx';
import Expenses from './Expenses.jsx';
import './style.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

function App() {
  const [token, setToken] = useState(localStorage.token);
  const [user, setUser] = useState(JSON.parse(localStorage.user || 'null'));
  const [page, setPage] = useState('Dashboard');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);

  const call = async (path, opts = {}) => {
    const r = await fetch(API + path, {
      ...opts,
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...opts.headers}
    });
    if (!r.ok) throw new Error((await r.json()).message);
    return r.status === 204 ? null : r.json();
  };

  const load = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const [menu, branches] = await Promise.all(['/menu-items', '/branches'].map(call));
      setData({menu, branches});
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

  if (!token) {
    return <Login onLogin={x => {
      localStorage.token = x.token;
      localStorage.user = JSON.stringify(x.user);
      setToken(x.token);
      setUser(x.user);
    }}/>;
  }

  const nav = [
    ['Dashboard', LayoutDashboard],
    ['Inventory', Package],
    ['Stock Ops', Package],
    ['Purchases', ShoppingCart],
    ['Expenses', Receipt],
    ['Supplier Catalog', ShoppingCart],
    ['Tables', Armchair],
    ['POS', ChefHat],
    ['KDS', UtensilsCrossed],
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
        {loading ? <p>Updating live data…</p> : <Page page={page} data={data} call={call} user={user} token={token}/>}
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

function Page({page, data, call, user, token}) {
  const branches = data.branches || [];
  if (page === 'Dashboard') return <Dashboard call={call} branches={branches} user={user}/>;
  if (page === 'Stock Ops') return <StockOps call={call} branches={branches} user={user}/>;
  if (page === 'Inventory') return <Inventory call={call} branches={branches} user={user}/>;
  if (page === 'Tables') return <Tables call={call} branches={branches} user={user} token={token}/>;
  if (page === 'POS') return <POS menu={data.menu || []} branches={branches} user={user} call={call}/>;
  if (page === 'KDS') return <Kds call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Purchases') return <Purchasing call={call} branches={branches} user={user} token={token}/>;
  if (page === 'Expenses') return <Expenses call={call} branches={branches} user={user}/>;
  if (page === 'Supplier Catalog') return <SupplierCatalog call={call}/>;
  return <Analytics call={call} branches={branches} user={user}/>;
}

createRoot(document.getElementById('root')).render(<App/>);
