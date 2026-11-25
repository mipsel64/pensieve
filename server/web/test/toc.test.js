import assert from 'node:assert/strict';
import test from 'node:test';
import { readingMinutes } from '../src/toc.js';

test('readingMinutes rounds up, ignores code blocks and never returns zero', () => {
  assert.equal(readingMinutes(''), 1);
  assert.equal(readingMinutes('word '.repeat(220)), 1);
  assert.equal(readingMinutes('word '.repeat(221)), 2);
  assert.equal(readingMinutes(`short\n\`\`\`\n${'code '.repeat(1000)}\n\`\`\`\n`), 1);
});
