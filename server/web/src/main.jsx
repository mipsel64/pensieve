import { lazy, StrictMode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity as ActivityIcon, History, LayoutDashboard, LogOut, Network, Search as SearchIcon, Settings as SettingsIcon } from 'lucide-react';
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
import { Settings } from './SettingsPage.jsx';
import { SettingsProvider, useSettings } from './settings.jsx';

// The graph library is most of the bundle; other views shouldn't wait for it.
const GraphView = lazy(() => import('./Graph.jsx').then((m) => ({ default: m.GraphView })));

const NAV = [
  ['dashboard', 'Dashboard', LayoutDashboard],
  ['search', 'Search', SearchIcon],
  ['graph', 'Graph', Network],
  ['timeline', 'Timeline', History],
  ['activity', 'Activity', ActivityIcon],
];
const LABELS = { ...Object.fromEntries(NAV.map(([id, label]) => [id, label])), settings: 'Settings' };

function App() {
  const [auth, setAuth] = useState({ state: 'checking' });
  // Any auth change outdates a check still in flight, e.g. a 401 arriving after sign-in.
  const latest = useRef(0);
  const settle = useCallback((next) => {
    latest.current++;
    setAuth(next);
  }, []);
  // Loading the settings doubles as the session check: it's the first thing a signed-in UI needs.
  const check = useCallback(() => {
    const request = ++latest.current;
    setAuth({ state: 'checking' });
    api('/settings')
      .then((settings) => request === latest.current && setAuth({ state: 'in', settings }))
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
  if (auth.state === 'out') return <Login onSuccess={check} />;
  return (
    <AuthContext.Provider value={lock}>
      <SettingsProvider initial={auth.settings}>
        <Shell onSignOut={signOut} />
      </SettingsProvider>
    </AuthContext.Provider>
  );
}

function Shell({ onSignOut }) {
  const route = useHashRoute();
  const { view, params } = route;
  const main = useRef(null);
  const [signOutError, setSignOutError] = useState(null);
  const { flush } = useSettings();
  // Signing out ends the session, so a change still being saved has to land first.
  const signOut = () => flush().then(onSignOut);

  useEffect(() => {
    document.title = params.page ? `${params.page} · Pensieve` : view === 'search' && params.q ? `${params.q} · Pensieve` : `${LABELS[view]} · Pensieve`;
  }, [view, params.page, params.q]);

  useEffect(() => {
    const onKey = (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (e.key !== '/' || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      const input = document.getElementById('search-q');
      // The search home focuses its own box when it opens.
      if (input) {
        input.focus();
        input.select();
      } else location.hash = href('search');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const content = {
    dashboard: <Dashboard />,
    graph: <GraphView params={params} />,
    timeline: <Timeline params={params} />,
    activity: <Activity />,
    search: <Search params={params} />,
    settings: <Settings onSignOut={signOut} />,
  }[view];

  const link = (id, label, Icon) => (
    <a href={href(id)} aria-current={view === id ? 'page' : undefined}>
      <Icon size={18} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );

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
              <li key={id}>{link(id, label, Icon)}</li>
            ))}
            <li className="nav-settings">{link('settings', 'Settings', SettingsIcon)}</li>
          </ul>
          <div className="sidebar-foot">
            {signOutError && (
              <p className="field-error" role="alert">
                Couldn't sign out: {signOutError.message}
              </p>
            )}
            <button
              type="button"
              className="signout"
              onClick={() => {
                setSignOutError(null);
                signOut().catch(setSignOutError);
              }}
            >
              <LogOut size={18} aria-hidden="true" />
              <span>Sign out</span>
            </button>
          </div>
        </nav>
        <main ref={main} tabIndex={-1} className={`content content-${view}`}>
          <Suspense fallback={<Loading />}>{content}</Suspense>
        </main>
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
