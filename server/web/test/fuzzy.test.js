import assert from 'node:assert/strict';
import test from 'node:test';
import { fuzzyFilter, fuzzyMatch, highlightRuns } from '../src/fuzzy.js';

test('fuzzyMatch finds a subsequence and reports where it matched', () => {
  const match = fuzzyMatch('dsh', 'Dashboard');
  assert.deepEqual(match.indices, [0, 2, 3]);
  assert.equal(fuzzyMatch('xyz', 'Dashboard'), null);
  assert.equal(fuzzyMatch('dashboards', 'Dash'), null);
});

test('fuzzyMatch ignores case and whitespace in the query', () => {
  assert.deepEqual(fuzzyMatch('GO  gr', 'go to graph').indices, [0, 1, 6, 7]);
});

test('fuzzyMatch prefers a word start and a run of letters', () => {
  assert.ok(fuzzyMatch('gr', 'Graph').score > fuzzyMatch('gr', 'Programming').score);
  assert.ok(fuzzyMatch('time', 'Timeline').score > fuzzyMatch('time', 'Team improvement').score);
  assert.ok(fuzzyMatch('rb', 'Redis Backup').score > fuzzyMatch('rb', 'Rebuild').score);
});

test('fuzzyMatch ranks a shorter text first on a tie', () => {
  assert.ok(fuzzyMatch('graph', 'Graph').score > fuzzyMatch('graph', 'Graph of everything').score);
});

test('fuzzyMatch handles an empty query and astral characters', () => {
  assert.deepEqual(fuzzyMatch('', 'anything'), { score: 0, indices: [] });
  assert.deepEqual(fuzzyMatch('b', '😀b').indices, [1]);
});

test('fuzzyFilter drops non-matches and sorts best first', () => {
  const items = ['Programming', 'Graph', 'Settings'];
  assert.deepEqual(
    fuzzyFilter(items, 'gr', (s) => s).map((r) => r.item),
    ['Graph', 'Programming'],
  );
  assert.deepEqual(
    fuzzyFilter(items, ' ', (s) => s).map((r) => r.item),
    items,
  );
});

test('fuzzyFilter can drop loose matches', () => {
  const items = ['Appearance: Dark theme colour mode', 'Reading Test'];
  assert.equal(fuzzyFilter(items, 'read', (s) => s).length, 2);
  assert.deepEqual(
    fuzzyFilter(items, 'read', (s) => s, { minPerChar: 2 }).map((r) => r.item),
    ['Reading Test'],
  );
  assert.equal(fuzzyFilter(['Dashboard'], 'dsh', (s) => s, { minPerChar: 2 }).length, 1);
});

test('highlightRuns groups the matched characters', () => {
  assert.deepEqual(highlightRuns('Dashboard', [0, 2, 3]), [
    { text: 'D', hit: true },
    { text: 'a', hit: false },
    { text: 'sh', hit: true },
    { text: 'board', hit: false },
  ]);
});
