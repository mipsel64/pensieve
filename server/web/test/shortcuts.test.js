import assert from 'node:assert/strict';
import test from 'node:test';
import { isApple, modifierLabel, resolveKey } from '../src/shortcuts.js';
import { parseRecent, pushRecent } from '../src/recent.js';

const key = (k, extra = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...extra });
const textField = { tagName: 'INPUT', type: 'text' };

test('Cmd or Ctrl+K opens the palette, even while typing', () => {
  assert.deepEqual(resolveKey(key('k', { metaKey: true }), null, textField).action, { type: 'palette' });
  assert.deepEqual(resolveKey(key('K', { ctrlKey: true })).action, { type: 'palette' });
  assert.equal(resolveKey(key('k', { metaKey: true, shiftKey: true })).action, null);
});

test('single keys act only when not typing and without modifiers', () => {
  assert.deepEqual(resolveKey(key('/')).action, { type: 'search' });
  assert.deepEqual(resolveKey(key('?', { shiftKey: true })).action, { type: 'help' });
  assert.equal(resolveKey(key('t')).action, null);
  assert.equal(resolveKey(key('/'), null, textField).action, null);
  assert.equal(resolveKey(key('/', { ctrlKey: true })).action, null);
  assert.equal(resolveKey(key('/', { altKey: true })).action, null);
});

test('slash focuses search from a radio or checkbox, but does not interrupt text entry', () => {
  for (const type of ['radio', 'checkbox']) {
    assert.deepEqual(resolveKey(key('/'), null, { tagName: 'INPUT', type }).action, { type: 'search' });
  }
  for (const field of [textField, { tagName: 'INPUT', type: 'search' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }]) {
    assert.equal(resolveKey(key('/'), null, field).action, null);
  }
});

test('a held key does not repeat its shortcut', () => {
  assert.deepEqual(resolveKey(key('/', { repeat: true })), { action: null, pending: null });
  assert.deepEqual(resolveKey(key('d', { repeat: true }), 'g'), { action: null, pending: 'g' });
  assert.deepEqual(resolveKey(key('k', { metaKey: true, repeat: true })).action, { type: 'palette' });
});

test('g waits for a second key', () => {
  const first = resolveKey(key('g'));
  assert.deepEqual(first, { action: null, pending: 'g' });
  assert.deepEqual(resolveKey(key('d'), first.pending), { action: { type: 'go', view: 'dashboard' }, pending: null });
  assert.deepEqual(resolveKey(key('g'), 'g').action, { type: 'go', view: 'graph' });
  for (const [k, view] of [['s', 'search'], ['t', 'timeline'], ['j', 'journal'], ['a', 'activity']]) {
    assert.deepEqual(resolveKey(key(k), 'g').action, { type: 'go', view });
  }
});

test('an unknown second key cancels g and does nothing', () => {
  assert.deepEqual(resolveKey(key('x'), 'g'), { action: null, pending: null });
  assert.deepEqual(resolveKey(key('D', { shiftKey: true }), 'g'), { action: null, pending: null });
  assert.deepEqual(resolveKey(key('d'), 'g', textField), { action: null, pending: null });
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
