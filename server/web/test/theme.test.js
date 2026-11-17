import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { THEME_COLORS, THEME_KEY, applyThemeColor, nextPreference, normalizePreference, readPreference, resolveTheme, writePreference } from '../src/theme.js';

const memoryStorage = (initial = {}) => {
  const data = { ...initial };
  return { getItem: (key) => data[key] ?? null, setItem: (key, value) => void (data[key] = value), data };
};
const throwingStorage = {
  getItem() {
    throw new Error('blocked');
  },
  setItem() {
    throw new Error('blocked');
  },
};

test('resolveTheme follows the system only for the system choice', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
});

test('unknown choices fall back to system', () => {
  for (const value of [undefined, null, '', 'Dark', 'sepia', 42]) {
    assert.equal(normalizePreference(value), 'system');
    assert.equal(resolveTheme(value, true), 'dark');
  }
});

test('nextPreference cycles system, light, dark', () => {
  assert.equal(nextPreference('system'), 'light');
  assert.equal(nextPreference('light'), 'dark');
  assert.equal(nextPreference('dark'), 'system');
  assert.equal(nextPreference('bogus'), 'light');
});

test('the preference is stored under pensieve.theme and survives bad storage', () => {
  const storage = memoryStorage();
  assert.equal(readPreference(storage), 'system');
  writePreference(storage, 'dark');
  assert.equal(storage.data[THEME_KEY], 'dark');
  assert.equal(readPreference(storage), 'dark');
  writePreference(storage, 'nonsense');
  assert.equal(storage.data[THEME_KEY], 'system');
  assert.equal(readPreference(memoryStorage({ [THEME_KEY]: 'nonsense' })), 'system');
  assert.equal(readPreference(throwingStorage), 'system');
  assert.equal(readPreference(null), 'system');
  assert.doesNotThrow(() => writePreference(throwingStorage, 'dark'));
  assert.doesNotThrow(() => writePreference(null, 'dark'));
});

test('applyThemeColor paints the theme-color meta', () => {
  for (const theme of ['light', 'dark']) {
    const attributes = {};
    applyThemeColor({ setAttribute: (name, value) => (attributes[name] = value) }, theme);
    assert.equal(attributes.content, THEME_COLORS[theme]);
  }
  assert.doesNotThrow(() => applyThemeColor(null, 'dark'));
});

const fakeRoot = () => {
  const attributes = {};
  return { attributes, setAttribute: (name, value) => (attributes[name] = String(value)) };
};

// The script runs before Astryx's <Theme>, so it must set what <Theme mode> will: data-theme only for an explicit choice.
test('the pre-paint script sets the Astryx theme attributes and the theme color', () => {
  const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  for (const stored of [null, 'system', 'light', 'dark', 'junk']) {
    for (const systemDark of [false, true]) {
      const root = fakeRoot();
      const meta = {};
      vm.runInNewContext(script, {
        document: { documentElement: root, querySelector: () => ({ setAttribute: (name, value) => (meta[name] = value) }) },
        localStorage: { getItem: () => stored },
        matchMedia: () => ({ matches: systemDark }),
      });
      const label = `${stored} / dark=${systemDark}`;
      assert.equal(root.attributes['data-astryx-theme'], 'pensieve', label);
      assert.equal(root.attributes['data-theme'], stored === 'light' || stored === 'dark' ? stored : undefined, label);
      assert.equal(meta.content, THEME_COLORS[resolveTheme(stored, systemDark)], label);
    }
  }
});

test('the pre-paint script follows the system when storage throws', () => {
  const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  const root = fakeRoot();
  const meta = {};
  vm.runInNewContext(script, {
    document: { documentElement: root, querySelector: () => ({ setAttribute: (name, value) => (meta[name] = value) }) },
    localStorage: {
      getItem: () => {
        throw new Error('blocked');
      },
    },
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(root.attributes['data-theme'], undefined);
  assert.equal(meta.content, THEME_COLORS.dark);
});
