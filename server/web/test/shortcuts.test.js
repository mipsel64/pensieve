import assert from 'node:assert/strict';
import test from 'node:test';
import { isApple, modifierLabel, resolveKey } from '../src/shortcuts.js';
import { parseRecent, pushRecent } from '../src/recent.js';

const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });

test('Cmd or Ctrl+K opens the palette, even while typing', () => {
  assert.deepEqual(resolveKey(key('k', { metaKey: true }), null, true).action, { type: 'palette' });
  assert.deepEqual(resolveKey(key('K', { ctrlKey: true }), null, false).action, { type: 'palette' });
  assert.equal(resolveKey(key('k', { metaKey: true, shiftKey: true }), null, false).action, null);
});

test('single keys act only when not typing and without modifiers', () => {
  assert.deepEqual(resolveKey(key('/'), null, false).action, { type: 'search' });
  assert.deepEqual(resolveKey(key('?', { shiftKey: true }), null, false).action, { type: 'help' });
  assert.deepEqual(resolveKey(key('t'), null, false).action, { type: 'theme' });
  assert.equal(resolveKey(key('/'), null, true).action, null);
  assert.equal(resolveKey(key('t', { ctrlKey: true }), null, false).action, null);
  assert.equal(resolveKey(key('t', { altKey: true }), null, false).action, null);
});

test('a held key does not repeat its shortcut', () => {
  assert.deepEqual(resolveKey(key('t', { repeat: true }), null, false), { action: null, pending: null });
  assert.deepEqual(resolveKey(key('d', { repeat: true }), 'g', false), { action: null, pending: 'g' });
  assert.deepEqual(resolveKey(key('k', { metaKey: true, repeat: true }), null, false).action, { type: 'palette' });
});

test('g waits for a second key', () => {
  const first = resolveKey(key('g'), null, false);
  assert.deepEqual(first, { action: null, pending: 'g' });
  assert.deepEqual(resolveKey(key('d'), first.pending, false), { action: { type: 'go', view: 'dashboard' }, pending: null });
  assert.deepEqual(resolveKey(key('g'), 'g', false).action, { type: 'go', view: 'graph' });
  for (const [k, view] of [['s', 'search'], ['t', 'timeline'], ['j', 'journal'], ['a', 'activity']]) {
    assert.deepEqual(resolveKey(key(k), 'g', false).action, { type: 'go', view });
  }
});

test('an unknown second key cancels g and does nothing', () => {
  assert.deepEqual(resolveKey(key('x'), 'g', false), { action: null, pending: null });
  assert.deepEqual(resolveKey(key('D', { shiftKey: true }), 'g', false), { action: null, pending: null });
  assert.deepEqual(resolveKey(key('d'), 'g', true), { action: null, pending: null });
});

test('modifierLabel follows the platform', () => {
  assert.equal(isApple('MacIntel'), true);
  assert.equal(modifierLabel('MacIntel'), '⌘');
  assert.equal(modifierLabel('Win32'), 'Ctrl');
  assert.equal(modifierLabel(), 'Ctrl');
});

test('pushRecent puts the newest first, drops copies and caps the list', () => {
  let list = [];
  for (const id of ['a', 'b', 'c']) list = pushRecent(list, { type: 'page', id });
  list = pushRecent(list, { type: 'page', id: 'a' });
  assert.deepEqual(list.map((e) => e.id), ['a', 'c', 'b']);
  list = pushRecent(list, { type: 'command', id: 'a' });
  assert.equal(list.length, 4);
  assert.equal(pushRecent(list, { type: 'page', id: 'z' }, 2).length, 2);
});

test('parseRecent keeps valid entries and survives bad input', () => {
  assert.deepEqual(parseRecent('[{"type":"page","id":"A","x":1},{"type":"bad","id":"B"},{"type":"command","id":""},null]'), [{ type: 'page', id: 'A' }]);
  assert.deepEqual(parseRecent('{'), []);
  assert.deepEqual(parseRecent('{"a":1}'), []);
  assert.deepEqual(parseRecent(null), []);
});
