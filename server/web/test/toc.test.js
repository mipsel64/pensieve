import assert from 'node:assert/strict';
import test from 'node:test';
import { readingMinutes, readingProgress } from '../src/toc.js';

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
