import { useSyncExternalStore } from 'react';

export const THEME_KEY = 'pensieve.theme';
export const THEME_CHOICES = ['system', 'light', 'dark'];
// Match --bg in style.css; the browser chrome (address bar) takes this color.
export const THEME_COLORS = { light: '#f5ecd4', dark: '#1f1d1b' };

export function normalizePreference(value) {
  return THEME_CHOICES.includes(value) ? value : 'system';
}

export function resolveTheme(preference, systemDark) {
  const choice = normalizePreference(preference);
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

export function nextPreference(preference) {
  return THEME_CHOICES[(THEME_CHOICES.indexOf(normalizePreference(preference)) + 1) % THEME_CHOICES.length];
}

// Storage can be missing or throw (private windows, blocked cookies); the choice then lasts until reload.
export function readPreference(storage) {
  try {
    return normalizePreference(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

export function writePreference(storage, preference) {
  try {
    storage?.setItem(THEME_KEY, normalizePreference(preference));
  } catch {
    // Same as no storage.
  }
}

/** Marks the root element and the browser chrome with the resolved theme. */
export function applyTheme(root, meta, resolved) {
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved]);
}

const listeners = new Set();
let preference = 'system';
let resolved = 'light';
let started = false;
let switching = 0;

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');

function sync(animate) {
  const next = resolveTheme(preference, darkQuery().matches);
  if (next !== resolved || document.documentElement.dataset.theme !== next) {
    const root = document.documentElement;
    if (animate) {
      root.dataset.themeSwitching = '';
      clearTimeout(switching);
      switching = setTimeout(() => delete root.dataset.themeSwitching, 220);
    }
    resolved = next;
    applyTheme(root, document.querySelector('meta[name="theme-color"]'), next);
  }
  for (const listener of listeners) listener();
}

/** Reads the stored choice and starts following the system setting and other tabs. Call once, before first render. */
export function initTheme() {
  if (started) return;
  started = true;
  preference = readPreference(storage());
  resolved = resolveTheme(preference, darkQuery().matches);
  applyTheme(document.documentElement, document.querySelector('meta[name="theme-color"]'), resolved);
  // Only the system choice follows the media query; resolveTheme ignores it otherwise.
  darkQuery().addEventListener('change', () => preference === 'system' && sync(true));
  addEventListener('storage', (event) => {
    if (event.key !== THEME_KEY) return;
    preference = normalizePreference(event.newValue);
    sync(true);
  });
}

export function setPreference(choice) {
  const next = normalizePreference(choice);
  if (next === preference) return;
  preference = next;
  writePreference(storage(), next);
  sync(true);
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The stored choice, the theme it resolves to, and a setter. Re-renders when either changes. */
export function useTheme() {
  const choice = useSyncExternalStore(subscribe, () => preference);
  const theme = useSyncExternalStore(subscribe, () => resolved);
  return { preference: choice, resolved: theme, setPreference };
}

/** Computed value of a CSS custom property, for the canvas, which cannot read var(). */
export function cssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
