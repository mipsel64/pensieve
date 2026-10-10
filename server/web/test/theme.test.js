import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { THEME_COLORS, THEME_KEY, applyTheme, nextPreference, normalizePreference, readPreference, resolveTheme, writePreference } from '../src/theme.js';

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

test('applyTheme sets data-theme, color-scheme and the theme-color meta', () => {
  for (const theme of ['light', 'dark']) {
    const root = { dataset: {}, style: {} };
    const attributes = {};
    applyTheme(root, { setAttribute: (name, value) => (attributes[name] = value) }, theme);
    assert.equal(root.dataset.theme, theme);
    assert.equal(root.style.colorScheme, theme);
    assert.equal(attributes.content, THEME_COLORS[theme]);
  }
  assert.doesNotThrow(() => applyTheme({ dataset: {}, style: {} }, null, 'dark'));
});

test('the pre-paint script agrees with resolveTheme and the theme colors', () => {
  const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  for (const stored of [null, 'system', 'light', 'dark', 'junk']) {
    for (const systemDark of [false, true]) {
      const root = { dataset: {}, style: {} };
      const attributes = {};
      const context = {
        document: { documentElement: root, querySelector: () => ({ setAttribute: (name, value) => (attributes[name] = value) }) },
        localStorage: { getItem: () => stored },
        matchMedia: () => ({ matches: systemDark }),
      };
      vm.runInNewContext(script, context);
      const expected = resolveTheme(stored, systemDark);
      assert.equal(root.dataset.theme, expected, `${stored} / dark=${systemDark}`);
      assert.equal(root.style.colorScheme, expected);
      assert.equal(attributes.content, THEME_COLORS[expected]);
    }
  }
});

test('the pre-paint script follows the system when storage throws', () => {
  const script = readFileSync(new URL('../public/theme-init.js', import.meta.url), 'utf8');
  const root = { dataset: {}, style: {} };
  vm.runInNewContext(script, {
    document: { documentElement: root, querySelector: () => null },
    localStorage: { getItem: () => { throw new Error('blocked'); } },
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(root.dataset.theme, 'dark');
});
