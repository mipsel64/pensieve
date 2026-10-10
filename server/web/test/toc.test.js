import assert from 'node:assert/strict';
import test from 'node:test';
import { activeHeadingIndex, buildToc, createSlugger, nodeText, readingMinutes, readingProgress, remarkHeadingIds, slugify } from '../src/toc.js';

test('slugify keeps letters and digits and joins words with hyphens', () => {
  assert.equal(slugify('Deploy or upgrade'), 'deploy-or-upgrade');
  assert.equal(slugify('  What’s new? (v2.1) '), 'whats-new-v21');
  assert.equal(slugify('Café déjà vu'), 'cafe-deja-vu');
  assert.equal(slugify('日本語 notes'), '日本語-notes');
  assert.equal(slugify('???'), 'section');
});

test('createSlugger numbers repeated headings', () => {
  const slug = createSlugger();
  assert.deepEqual([slug('Notes'), slug('Notes'), slug('Other'), slug('Notes')], ['notes', 'notes-1', 'other', 'notes-2']);
});

test('nodeText joins text and inline code and skips markup', () => {
  const node = {
    type: 'heading',
    children: [
      { type: 'text', value: 'Use ' },
      { type: 'inlineCode', value: 'make' },
      { type: 'emphasis', children: [{ type: 'text', value: ' now' }] },
    ],
  };
  assert.equal(nodeText(node), 'Use make now');
});

test('remarkHeadingIds sets a unique id on every heading', () => {
  const heading = (depth, value) => ({ type: 'heading', depth, children: [{ type: 'text', value }] });
  const tree = {
    type: 'root',
    children: [heading(2, 'Setup'), { type: 'blockquote', children: [heading(3, 'Setup')] }, { type: 'paragraph', children: [{ type: 'text', value: 'x' }] }],
  };
  remarkHeadingIds()(tree);
  assert.equal(tree.children[0].data.hProperties.id, 'sec-setup');
  assert.equal(tree.children[1].children[0].data.hProperties.id, 'sec-setup-1');
  assert.equal(tree.children[2].data, undefined);
});

test('buildToc keeps level 2 and 3 headings with an id and text', () => {
  const toc = buildToc([
    { id: 'a', text: 'Intro', level: 1 },
    { id: 'b', text: ' Setup ', level: 2 },
    { id: 'c', text: 'Steps', level: 3 },
    { id: 'd', text: 'Deep', level: 4 },
    { id: '', text: 'No id', level: 2 },
    { id: 'e', text: '  ', level: 2 },
  ]);
  assert.deepEqual(toc, [
    { id: 'b', text: 'Setup', level: 2 },
    { id: 'c', text: 'Steps', level: 3 },
  ]);
});

test('activeHeadingIndex picks the last heading above the offset', () => {
  assert.equal(activeHeadingIndex([300, 600, 900], 100), -1);
  assert.equal(activeHeadingIndex([-500, 40, 900], 100), 1);
  assert.equal(activeHeadingIndex([-500, -40, -10], 100), 2);
  assert.equal(activeHeadingIndex([], 100), -1);
  assert.equal(activeHeadingIndex([-500, 300, 600], 100, true), 2);
  assert.equal(activeHeadingIndex([], 100, true), -1);
});

test('readingProgress is a clamped share of the scroll range', () => {
  assert.equal(readingProgress(0, 2000, 1000), 0);
  assert.equal(readingProgress(500, 2000, 1000), 0.5);
  assert.equal(readingProgress(1200, 2000, 1000), 1);
  assert.equal(readingProgress(-20, 2000, 1000), 0);
  assert.equal(readingProgress(0, 800, 1000), 0);
});

test('readingMinutes rounds up, ignores code blocks and never returns zero', () => {
  assert.equal(readingMinutes(''), 1);
  assert.equal(readingMinutes('word '.repeat(220)), 1);
  assert.equal(readingMinutes('word '.repeat(221)), 2);
  assert.equal(readingMinutes(`short\n\`\`\`\n${'code '.repeat(1000)}\n\`\`\`\n`), 1);
});
