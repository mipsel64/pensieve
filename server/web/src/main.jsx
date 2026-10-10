import { lazy, StrictMode, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FileQuestion, Keyboard, LogOut, Search as SearchIcon, Settings as SettingsIcon } from 'lucide-react';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import './style.css';
import { initTheme, nextPreference, useTheme } from './theme.js';
import { api, logout, Unauthorized } from './api.js';
import { href, RouteContext, useHashRoute } from './router.js';
import { AuthContext, Empty, ErrorNote, Loading, Logo } from './ui.jsx';
import { Login } from './Login.jsx';
import { Dashboard } from './Dashboard.jsx';
import { Timeline } from './Timeline.jsx';
import { Journal } from './Journal.jsx';
import { Activity } from './Activity.jsx';
import { Search } from './Search.jsx';
import { PageDrawer, PageView } from './Page.jsx';
import { Settings } from './SettingsPage.jsx';
import { SettingsProvider, useSettings } from './settings.jsx';
import { THEME_OPTIONS } from './ThemeSwitch.jsx';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from './Menu.jsx';
import { NAV, VIEW_LABELS } from './nav.js';
import { Palette } from './Palette.jsx';
import { ShortcutsHelp, useShortcuts } from './Shortcuts.jsx';
import { modifierLabel } from './shortcuts.js';
import { ToastProvider, useToast } from './Toast.jsx';

// The graph library is most of the bundle; other views shouldn't wait for it.
const GraphView = lazy(() => import('./Graph.jsx').then((m) => ({ default: m.GraphView })));

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
        <ToastProvider>
          <Shell onSignOut={signOut} />
        </ToastProvider>
      </SettingsProvider>
    </AuthContext.Provider>
  );
}

function Shell({ onSignOut }) {
  const route = useHashRoute();
  const { view, params } = route;
  const main = useRef(null);
  const [overlay, setOverlay] = useState(null);
  const { flush } = useSettings();
  const { preference, setPreference } = useTheme();
  const toast = useToast();
  const modifier = useMemo(() => modifierLabel(navigator.platform), []);
  // Signing out ends the session, so a change still being saved has to land first.
  const signOut = () => flush().then(onSignOut);

  useEffect(() => {
    const name = params.page || (view === 'page' && params.title) || (view === 'search' && params.q) || VIEW_LABELS[view];
    document.title = `${name} · Pensieve`;
  }, [view, params.page, params.title, params.q]);

  const openHelp = useCallback(() => setOverlay('help'), []);
  const commands = useMemo(
    () => [
      ...NAV.map(([id, label, Icon, key]) => ({ id: `go-${id}`, group: 'Go to', label: `Go to ${label}`, keywords: label, hint: `g ${key}`, icon: Icon, run: () => (location.hash = href(id)) })),
      { id: 'go-settings', group: 'Go to', label: 'Open Settings', keywords: 'preferences accent', icon: SettingsIcon, run: () => (location.hash = href('settings')) },
      ...Object.entries(THEME_OPTIONS).map(([id, { label, Icon }]) => ({
        id: `theme-${id}`,
        group: 'Appearance',
        label: `Appearance: ${label}`,
        keywords: 'theme color mode dark light',
        icon: Icon,
        run: () => {
          setPreference(id);
          toast(`Appearance: ${label}`);
        },
      })),
      { id: 'shortcuts', group: 'Help', label: 'Show keyboard shortcuts', keywords: 'keys help hotkeys', hint: '?', icon: Keyboard, run: openHelp },
    ],
    [setPreference, toast, openHelp],
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
    theme: () => {
      if (overlay) return;
      const next = nextPreference(preference);
      setPreference(next);
      toast(`Appearance: ${THEME_OPTIONS[next].label}`);
    },
  });

  const [signOutError, setSignOutError] = useState(null);
  useEffect(() => {
    if (signOutError) toast(`Couldn't sign out: ${signOutError.message}`, { error: true });
  }, [signOutError, toast]);

  const content = {
    dashboard: <Dashboard />,
    graph: <GraphView params={params} />,
    timeline: <Timeline params={params} />,
    journal: <Journal params={params} />,
    activity: <Activity />,
    search: <Search params={params} />,
    settings: <Settings onSignOut={signOut} />,
    page: params.title ? (
      <PageView key={params.title} title={params.title} />
    ) : (
      <Empty icon={FileQuestion} title="No page open" action={{ href: href('search'), label: 'Search memory' }}>
        Open a page from search, the graph or a list to read it here.
      </Empty>
    ),
  }[view];

  const link = (id, label, Icon, key) => (
    <a href={href(id)} aria-current={view === id ? 'page' : undefined} title={key ? `${label} (g ${key})` : label}>
      <Icon size={17} aria-hidden="true" />
      <span>{label}</span>
    </a>
  );

  return (
    <RouteContext.Provider value={route}>
      <div className={`shell${params.page ? ' with-drawer' : ''}`}>
        <a
          className="skip"
          href="#main-content"
          onClick={(event) => {
            event.preventDefault();
            main.current?.focus();
          }}
        >
          Skip to content
        </a>
        <nav className="sidebar" aria-label="Main">
          <a className="brand" href={href('search')}>
            <Logo size={24} />
            <span>Pensieve</span>
          </a>
          <ul>
            {NAV.map(([id, label, Icon, key]) => (
              <li key={id}>{link(id, label, Icon, key)}</li>
            ))}
            <li className="nav-settings">{link('settings', 'Settings', SettingsIcon)}</li>
          </ul>
        </nav>
        <div className="main-col">
          <header className="topbar">
            <a className="topbar-brand" href={href('search')} aria-label="Pensieve home">
              <Logo size={22} />
            </a>
            <span className="topbar-title">{VIEW_LABELS[view]}</span>
            <button type="button" className="palette-trigger" onClick={() => setOverlay('palette')} aria-label="Search pages, commands" title={`Command palette (${modifier} K)`}>
              <SearchIcon size={14} aria-hidden="true" />
              <span>Search pages, commands</span>
              <kbd>{modifier} K</kbd>
            </button>
            <Menu label="More options">
              <MenuLabel>Appearance</MenuLabel>
              {Object.entries(THEME_OPTIONS).map(([id, { label, Icon }]) => (
                <MenuItem key={id} icon={Icon} checked={preference === id} onSelect={() => setPreference(id)}>
                  {label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem icon={Keyboard} hint="?" onSelect={openHelp}>
                Keyboard shortcuts
              </MenuItem>
              <MenuItem icon={SettingsIcon} href={href('settings')}>
                Settings
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={LogOut}
                onSelect={() => {
                  setSignOutError(null);
                  signOut().catch(setSignOutError);
                }}
              >
                Sign out
              </MenuItem>
            </Menu>
          </header>
          <main key={view} id="main-content" ref={main} tabIndex={-1} className={`content content-${view}`}>
            <Suspense fallback={<Loading variant="page" />}>{content}</Suspense>
          </main>
        </div>
        {params.page && <PageDrawer key={params.page} title={params.page} closeHref={href(view, { ...params, page: undefined })} />}
      </div>
      {overlay === 'palette' && <Palette commands={commands} onClose={() => setOverlay(null)} />}
      {overlay === 'help' && <ShortcutsHelp modifier={modifier} onClose={() => setOverlay(null)} />}
    </RouteContext.Provider>
  );
}

initTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
