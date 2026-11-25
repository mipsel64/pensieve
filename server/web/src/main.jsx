import './layers.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './themes/pensieve/pensieve.css';
import './Manual.css';
import { Fragment, lazy, StrictMode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { VStack } from '@astryxdesign/core/Stack';
import { Theme } from '@astryxdesign/core/theme';
import { FileQuestion, Keyboard, Settings as SettingsIcon } from 'lucide-react';
import { pensieveTheme } from './themes/pensieve/pensieve.js';
import { api, authMethods, logout, Unauthorized } from './api.js';
import { href, RouteContext, useHashRoute } from './router.js';
import { AuthContext, Empty, ErrorNote, Loading } from './ui.jsx';
import { Login } from './Login.jsx';
import { Dashboard } from './Dashboard.jsx';
import { Timeline } from './Timeline.jsx';
import { Journal } from './Journal.jsx';
import { Activity } from './Activity.jsx';
import { Search } from './Search.jsx';
import { PageDrawer, PageView } from './Page.jsx';
import { Settings } from './SettingsPage.jsx';
import { SettingsProvider, useSettings } from './settings.jsx';
import { NAV, VIEW_LABELS } from './nav.js';
import { Palette } from './Palette.jsx';
import { ShortcutsHelp, useShortcuts } from './Shortcuts.jsx';
import { modifierLabel } from './shortcuts.js';
import { ToastProvider } from './Toast.jsx';

// The graph library is most of the bundle; other views shouldn't wait for it.
const GraphView = lazy(() => import('./Graph.jsx').then((m) => ({ default: m.GraphView })));

function App() {
  const [auth, setAuth] = useState({ state: 'checking' });
  // Any auth change outdates a check still in flight, e.g. a 401 arriving after sign-in.
  const latest = useRef(0);
  const settle = useCallback((next) => {
    latest.current++;
    setAuth((current) => ({ ...next, methods: next.methods ?? current.methods }));
  }, []);
  // Loading the settings doubles as the session check: it's the first thing a signed-in UI needs.
  const check = useCallback(() => {
    const request = ++latest.current;
    setAuth({ state: 'checking' });
    authMethods()
      .then(({ methods }) => {
        api('/settings')
          .then((settings) => request === latest.current && setAuth({ state: 'in', settings, methods }))
          .catch((error) => request === latest.current && setAuth(error instanceof Unauthorized ? { state: 'out', methods } : { state: 'error', error, methods }));
      })
      .catch((error) => request === latest.current && setAuth({ state: 'error', error }));
  }, []);
  useEffect(check, [check]);
  const lock = useCallback(() => settle({ state: 'out' }), [settle]);
  // Only a cleared cookie signs out; otherwise the next reload would silently be signed in again.
  const signOut = () =>
    logout().then(lock, (error) => {
      if (!(error instanceof Unauthorized)) throw error;
      lock();
    });

  if (auth.state === 'out') return <Login methods={auth.methods ?? []} onSuccess={check} />;
  if (auth.state !== 'in') {
    return (
      <VStack height="100%" justify="center" align="center" padding={4}>
        {auth.state === 'checking' ? <Loading label="Connecting" /> : <ErrorNote error={auth.error} onRetry={check} />}
      </VStack>
    );
  }
  return (
    <AuthContext.Provider value={lock}>
      <SettingsProvider initial={auth.settings}>
        <ToastProvider>
          <Shell methods={auth.methods} onSignOut={signOut} />
        </ToastProvider>
      </SettingsProvider>
    </AuthContext.Provider>
  );
}

function Shell({ methods, onSignOut }) {
  const route = useHashRoute();
  const { view, params } = route;
  const [overlay, setOverlay] = useState(null);
  const { flush } = useSettings();
  const main = useRef(null);
  const modifier = useMemo(() => modifierLabel(navigator.platform), []);
  // Signing out ends the session, so a change still being saved has to land first.
  const signOut = () => flush().then(onSignOut);

  useEffect(() => {
    const name = params.page || (view === 'page' && params.title) || (view === 'search' && params.q) || VIEW_LABELS[view];
    document.title = `${name} · Pensieve`;
  }, [view, params.page, params.title, params.q]);

  // A drawer keeps the scroll position of its view; a new view starts at the top.
  useLayoutEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [view]);

  const openHelp = useCallback(() => setOverlay('help'), []);
  const commands = useMemo(
    () => [
      ...NAV.map(([id, label, Icon, key]) => ({ id: `go-${id}`, group: 'Go to', label: `Go to ${label}`, keywords: label, hint: `g ${key}`, icon: Icon, run: () => (location.hash = href(id)) })),
      { id: 'go-settings', group: 'Go to', label: 'Open Settings', keywords: 'preferences tokens apps', icon: SettingsIcon, run: () => (location.hash = href('settings')) },
      { id: 'shortcuts', group: 'Help', label: 'Show keyboard shortcuts', keywords: 'keys help hotkeys', hint: '?', icon: Keyboard, run: openHelp },
    ],
    [openHelp],
  );

  useShortcuts({
    palette: () => setOverlay((open) => (open === 'palette' ? null : 'palette')),
    help: () => setOverlay((open) => (open === 'help' ? null : open ? open : 'help')),
    search: () => {
      if (overlay) return;
      const input = document.getElementById('search-q');
      // The search home focuses its own box when it opens.
      if (input) {
        input.focus();
        input.select();
      } else location.hash = href('search');
    },
    go: ({ view: target }) => !overlay && (location.hash = href(target)),
  });

  const content = {
    dashboard: <Dashboard />,
    graph: <GraphView params={params} />,
    timeline: <Timeline params={params} />,
    journal: <Journal params={params} />,
    activity: <Activity />,
    search: <Search params={params} />,
    settings: <Settings oauth={methods.includes('google')} onSignOut={signOut} />,
    page: params.title ? (
      <PageView key={params.title} title={params.title} />
    ) : (
      <Empty icon={FileQuestion} title="No page open" action={{ href: href('search'), label: 'Search memory' }}>
        Open a page from search, the graph or a list to read it here.
      </Empty>
    ),
  }[view];

  return (
    <RouteContext.Provider value={route}>
      <div className="manual-shell">
        <header className="manual-header">
          <button className="skip-nav" onClick={() => main.current.focus()}>Skip to content</button>
          <a className="wordmark" href={href('search')}>Pensieve</a>
          <nav aria-label="Main">
            {NAV.map(([id, label]) => (
              <a key={id} href={href(id)} aria-current={view === id ? 'page' : undefined}>{label}</a>
            ))}
            <a href={href('settings')} aria-current={view === 'settings' ? 'page' : undefined}>Settings</a>
          </nav>
          <button type="button" className="commands" onClick={() => setOverlay('palette')} title={`Open command palette (${modifier} K)`}>Commands</button>
        </header>
        <main ref={main} tabIndex={-1} className={view === 'graph' ? 'graph-main' : undefined}>
          <Fragment key={view}>
            <Suspense fallback={<Loading variant="page" />}>{content}</Suspense>
          </Fragment>
        </main>
      </div>
      {params.page && <PageDrawer key={params.page} title={params.page} closeHref={href(view, { ...params, page: undefined })} />}
      {/* A command the palette runs may open another overlay before the palette reports its own close. */}
      {overlay === 'palette' && <Palette commands={commands} onClose={() => setOverlay((open) => (open === 'palette' ? null : open))} />}
      {overlay === 'help' && <ShortcutsHelp modifier={modifier} onClose={() => setOverlay(null)} />}
    </RouteContext.Provider>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Theme theme={pensieveTheme} mode="system">
      <App />
    </Theme>
  </StrictMode>,
);
