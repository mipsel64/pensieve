import { useSyncExternalStore } from 'react';

export const THEME_KEY = 'pensieve.theme';
export const THEME_CHOICES = ['system', 'light', 'dark'];

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

const listeners = new Set();
let preference = 'system';
let resolved = 'light';
let started = false;

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};
const darkQuery = () => matchMedia('(prefers-color-scheme: dark)');

function sync() {
  resolved = resolveTheme(preference, darkQuery().matches);
  for (const listener of listeners) listener();
}

/** Reads the stored choice and starts following the system setting and other tabs. Call once, before first render. */
export function initTheme() {
  if (started) return;
  started = true;
  preference = readPreference(storage());
  sync();
  darkQuery().addEventListener('change', sync);
  addEventListener('storage', (event) => {
    if (event.key !== THEME_KEY) return;
    preference = normalizePreference(event.newValue);
    sync();
  });
}

export function setPreference(choice) {
  const next = normalizePreference(choice);
  if (next === preference) return;
  preference = next;
  writePreference(storage(), next);
  sync();
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The stored choice (pass it to <Theme mode>), the theme it resolves to, and a setter. Re-renders when either changes. */
export function useTheme() {
  const choice = useSyncExternalStore(subscribe, () => preference);
  const theme = useSyncExternalStore(subscribe, () => resolved);
  return { preference: choice, resolved: theme, setPreference };
}

/**
 * The computed color of a theme token, for the canvas, which cannot read var().
 * Tokens are light-dark() pairs, so a probe element resolves them under the current color scheme.
 */
export function cssColor(name) {
  const probe = document.createElement('span');
  probe.style.color = `var(${name})`;
  probe.hidden = true;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}
