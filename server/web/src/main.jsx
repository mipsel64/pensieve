import { lazy, StrictMode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity as ActivityIcon, History, LayoutDashboard, LogOut, Network, Search as SearchIcon } from 'lucide-react';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';
import { api, logout, Unauthorized } from './api.js';
import { href, RouteContext, useHashRoute } from './router.js';
import { AuthContext, ErrorNote, Loading, Logo } from './ui.jsx';
import { Login } from './Login.jsx';
import { Dashboard } from './Dashboard.jsx';
import { Timeline } from './Timeline.jsx';
import { Activity } from './Activity.jsx';
import { Search } from './Search.jsx';
import { PageDrawer } from './PageDrawer.jsx';

// The graph library is most of the bundle; other views shouldn't wait for it.
const GraphView = lazy(() => import('./Graph.jsx').then((m) => ({ default: m.GraphView })));

const NAV = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['graph', 'Graph', Network],
  ['timeline', 'Timeline', History],
  ['activity', 'Activity', ActivityIcon],
  ['search', 'Search', SearchIcon],
];

function App() {
  const [auth, setAuth] = useState({ state: 'checking' });
  // Any auth change outdates a session check still in flight, e.g. a 401 arriving after sign-in.
  const latest = useRef(0);
  const settle = useCallback((next) => {
    latest.current++;
    setAuth(next);
  }, []);
  const check = useCallback(() => {
    const request = ++latest.current;
    setAuth({ state: 'checking' });
    api('/session')
      .then(() => request === latest.current && setAuth({ state: 'in' }))
      .catch((error) => request === latest.current && setAuth(error instanceof Unauthorized ? { state: 'out' } : { state: 'error', error }));
  }, []);
  useEffect(check, [check]);
  const lock = useCallback(() => settle({ state: 'out' }), [settle]);
  // Only a cleared cookie signs out; otherwise the next reload would silently be signed in again.
  const signOut = () =>
    logout().then(lock, (error) => {
      if (!(error instanceof Unauthorized)) throw error;
      lock();
    });

  if (auth.state === 'checking') return <Loading label="Connecting" />;
  if (auth.state === 'error') return <ErrorNote error={auth.error} onRetry={check} />;
  if (auth.state === 'out') return <Login onSuccess={() => settle({ state: 'in' })} />;
  return (
    <AuthContext.Provider value={lock}>
      <Shell onSignOut={signOut} />
    </AuthContext.Provider>
  );
}

function Shell({ onSignOut }) {
  const route = useHashRoute();
  const { view, params } = route;
  const search = useRef(null);
  const main = useRef(null);
  const [signOutError, setSignOutError] = useState(null);

  useEffect(() => {
    const label = NAV.find(([id]) => id === view)[1];
    document.title = params.page ? `${params.page} · Pensieve` : `${label} · Pensieve`;
  }, [view, params.page]);

  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        search.current?.focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  function submit(event) {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q').trim();
    if (q) location.hash = href('search', { q, mode: view === 'search' ? params.mode : undefined, jev: view === 'search' ? params.jev : undefined });
  }

  const content = {
    dashboard: <Dashboard />,
    graph: <GraphView params={params} />,
    timeline: <Timeline params={params} />,
    activity: <Activity />,
    search: <Search params={params} />,
  }[view];

  return (
    <RouteContext.Provider value={route}>
      <div className={`shell${params.page ? ' with-drawer' : ''}`}>
        <button type="button" className="skip" onClick={() => main.current?.focus()}>
          Skip to content
        </button>
        <nav className="sidebar" aria-label="Main">
          <a className="brand" href={href('dashboard')}>
            <Logo size={26} />
            <span>Pensieve</span>
          </a>
          <ul>
            {NAV.map(([id, label, Icon]) => (
              <li key={id}>
                <a href={href(id)} aria-current={view === id ? 'page' : undefined}>
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="main">
          <header className="topbar">
            <form className="search-form" role="search" onSubmit={submit}>
              <SearchIcon size={16} aria-hidden="true" />
              <input
                ref={search}
                key={view === 'search' ? params.q : ''}
                name="q"
                type="search"
                placeholder="Search memory"
                aria-label="Search memory"
                defaultValue={view === 'search' ? (params.q ?? '') : ''}
                autoComplete="off"
              />
              <kbd aria-hidden="true">/</kbd>
            </form>
            {signOutError && (
              <span className="signout-error" role="alert">
                Couldn't sign out: {signOutError.message}
              </span>
            )}
            <button
              type="button"
              className="ghost signout"
              onClick={() => {
                setSignOutError(null);
                onSignOut().catch(setSignOutError);
              }}
              aria-label="Sign out"
            >
              <LogOut size={16} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </header>
          <main ref={main} tabIndex={-1} className={`content content-${view}`}>
            <Suspense fallback={<Loading />}>{content}</Suspense>
          </main>
        </div>
        {params.page && <PageDrawer key={params.page} title={params.page} closeHref={href(view, { ...params, page: undefined })} />}
      </div>
    </RouteContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
