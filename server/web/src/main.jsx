import './layers.css';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import './Manual.css';
import '@fontsource-variable/ibm-plex-sans/wght.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import { Fragment, lazy, StrictMode, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AppShell, useAppShellMobile } from '@astryxdesign/core/AppShell';
import { Button } from '@astryxdesign/core/Button';
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Kbd } from '@astryxdesign/core/Kbd';
import { MobileNavToggle } from '@astryxdesign/core/MobileNav';
import { SideNav, SideNavItem, SideNavSection } from '@astryxdesign/core/SideNav';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Theme } from '@astryxdesign/core/theme';
import { TopNav, TopNavHeading } from '@astryxdesign/core/TopNav';
import { FileQuestion, Keyboard, LogOut, MoreHorizontal, Search as SearchIcon, Settings as SettingsIcon } from 'lucide-react';
import { ACCENT_THEMES } from './accents.js';
import { initTheme, nextPreference, useTheme } from './theme.js';
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
import { THEME_OPTIONS } from './ThemeSwitch.jsx';
import { NAV, VIEW_LABELS } from './nav.js';
import { Palette } from './Palette.jsx';
import { ShortcutsHelp, useShortcuts } from './Shortcuts.jsx';
import { modifierLabel } from './shortcuts.js';
import { ToastProvider, useToast } from './Toast.jsx';

// The graph library is most of the bundle; other views shouldn't wait for it.
const GraphView = lazy(() => import('./Graph.jsx').then((m) => ({ default: m.GraphView })));

/** The Astryx theme for an accent, in the stored appearance (System, Light or Dark). */
function AppTheme({ accent = 'claude', children }) {
  const { preference, resolved } = useTheme();
  useLayoutEffect(() => {
    // Astryx applies the selected theme to <html> before this effect runs.
    document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).backgroundColor;
  }, [accent, resolved]);
  return (
    <Theme theme={ACCENT_THEMES[accent] ?? ACCENT_THEMES.claude} mode={preference}>
      {children}
    </Theme>
  );
}

function SettingsTheme({ children }) {
  return <AppTheme accent={useSettings().settings.accent}>{children}</AppTheme>;
}

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

  if (auth.state !== 'in') {
    return (
      <AppTheme>
        {auth.state === 'out' ? (
          <Login methods={auth.methods ?? []} onSuccess={check} />
        ) : (
          <VStack height="100%" justify="center" align="center" padding={4}>
            {auth.state === 'checking' ? <Loading label="Connecting" /> : <ErrorNote error={auth.error} onRetry={check} />}
          </VStack>
        )}
      </AppTheme>
    );
  }
  return (
    <AuthContext.Provider value={lock}>
      <SettingsProvider initial={auth.settings}>
        <SettingsTheme>
          <ToastProvider>
            <Shell methods={auth.methods} onSignOut={signOut} />
          </ToastProvider>
        </SettingsTheme>
      </SettingsProvider>
    </AuthContext.Provider>
  );
}

function PaletteButton({ manual, modifier, onClick }) {
  const { isMobile } = useAppShellMobile();
  return (
    <Button
      className={manual ? 'manual-palette' : undefined}
      label="Search"
      size="sm"
      isIconOnly={manual && isMobile}
      icon={<Icon icon={SearchIcon} />}
      endContent={manual && !isMobile ? (
        <span className="manual-shortcut" aria-hidden="true">{modifier} K</span>
      ) : undefined}
      tooltip={`Command palette (${modifier} K)`}
      onClick={onClick}
    />
  );
}

function Shell({ methods, onSignOut }) {
  const route = useHashRoute();
  const { view, params } = route;
  const [overlay, setOverlay] = useState(null);
  const { flush, settings } = useSettings();
  const manual = settings.accent === 'manual';
  const { preference, setPreference } = useTheme();
  const toast = useToast();
  const modifier = useMemo(() => modifierLabel(navigator.platform), []);
  // Signing out ends the session, so a change still being saved has to land first.
  const signOut = () => flush().then(onSignOut);

  useEffect(() => {
    const name = params.page || (view === 'page' && params.title) || (view === 'search' && params.q) || VIEW_LABELS[view];
    document.title = `${name} · Pensieve`;
  }, [view, params.page, params.title, params.q]);

  // AppShell keeps one main scroller (a role="main" region) for every view, so a new view would open at the old view's scroll position.
  useLayoutEffect(() => {
    document.querySelector('[role="main"]')?.scrollTo(0, 0);
  }, [view]);

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
    settings: <Settings oauth={methods.includes('google')} onSignOut={signOut} />,
    page: params.title ? (
      <PageView key={params.title} title={params.title} />
    ) : (
      <Empty icon={FileQuestion} title="No page open" action={{ href: href('search'), label: 'Search memory' }}>
        Open a page from search, the graph or a list to read it here.
      </Empty>
    ),
  }[view];

  const wordmark = <TopNavHeading className={manual ? 'manual-wordmark' : undefined} heading="Pensieve" headingHref={href('search')} />;
  const topNav = (
    <TopNav
      label="Pensieve"
      className={manual ? 'manual-top-nav' : undefined}
      heading={manual ? (
        <HStack gap={1} align="center">
          <MobileNavToggle className="manual-nav-toggle" />
          {wordmark}
        </HStack>
      ) : wordmark}
      endContent={
        <HStack gap={1} align="center">
          <PaletteButton manual={manual} modifier={modifier} onClick={() => setOverlay('palette')} />
          <DropdownMenu
            hasChevron={false}
            alignment="end"
            renderTrigger={(props) => (
              <IconButton
                {...props}
                className={manual ? 'manual-phone-control' : props.className}
                label="More options"
                variant="ghost"
                icon={<Icon icon={MoreHorizontal} />}
              />
            )}
          >
            <DropdownMenuGroup title="Appearance">
              <DropdownMenuRadioGroup label="Appearance" value={preference} onChange={setPreference}>
                {Object.entries(THEME_OPTIONS).map(([id, { label, Icon: ChoiceIcon }]) => (
                  <DropdownMenuRadioItem key={id} value={id} label={label} icon={ChoiceIcon} />
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuDivider />
            <DropdownMenuItem label="Keyboard shortcuts" icon={Keyboard} endContent={<Kbd keys="?" />} onClick={openHelp} />
            <DropdownMenuItem label="Settings" icon={SettingsIcon} href={href('settings')} />
            <DropdownMenuDivider />
            <DropdownMenuItem
              label="Sign out"
              icon={LogOut}
              onClick={() => {
                setSignOutError(null);
                signOut().catch(setSignOutError);
              }}
            />
          </DropdownMenu>
        </HStack>
      }
    />
  );

  const sideNav = (
    <SideNav
      className={manual ? 'manual-rail' : undefined}
      footer={
        <SideNavItem
          label="Settings"
          icon={manual ? undefined : SettingsIcon}
          href={href('settings')}
          isSelected={view === 'settings'}
          className={manual ? 'manual-nav-row' : undefined}
        />
      }
    >
      <SideNavSection className={manual ? 'manual-nav-section' : undefined} title="Views" isHeaderHidden={!manual}>
        {NAV.map(([id, label, NavIcon, key]) => (
          <SideNavItem
            key={id}
            className={manual ? 'manual-nav-row' : undefined}
            label={label}
            icon={manual ? undefined : NavIcon}
            href={href(id)}
            isSelected={view === id}
            endContent={manual ? <span className="manual-shortcut" aria-hidden="true">g {key}</span> : undefined}
          />
        ))}
      </SideNavSection>
    </SideNav>
  );

  return (
    <RouteContext.Provider value={route}>
      <AppShell
        topNav={topNav}
        sideNav={sideNav}
        mobileNav={manual ? { hasToggle: false } : undefined}
        contentPadding={view === 'graph' ? 0 : 6}
        variant={manual ? 'section' : 'wash'}
      >
        <Fragment key={view}>
          <Suspense fallback={<Loading variant="page" />}>{content}</Suspense>
        </Fragment>
      </AppShell>
      {params.page && <PageDrawer key={params.page} title={params.page} closeHref={href(view, { ...params, page: undefined })} />}
      {/* A command the palette runs may open another overlay before the palette reports its own close. */}
      {overlay === 'palette' && <Palette commands={commands} onClose={() => setOverlay((open) => (open === 'palette' ? null : open))} />}
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
