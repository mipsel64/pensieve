import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import { JOURNAL_DAY, isDailyJournal, remarkNewestFirst } from '../src/journal.js';

const render = (body, newestFirst = true) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: newestFirst ? [remarkNewestFirst] : [] }, body));

test('only exact daily journal pages enable sorting', () => {
  assert.equal(JOURNAL_DAY.exec('Journal 2026-09-30')?.[1], '2026-09-30');
  assert.equal(isDailyJournal({ title: 'Journal 2026-09-30', kind: 'journal' }), true);
  assert.equal(isDailyJournal({ title: 'Journal 2026-09-30', kind: 'topic' }), false);
  assert.equal(isDailyJournal(null), false);
  assert.equal(isDailyJournal(undefined), false);
  for (const title of ['Journal Notes', 'Scratchpad', 'Journal 2026-09-30 notes', 'Journal 2026-9-30']) {
    assert.equal(JOURNAL_DAY.test(title), false);
    assert.equal(isDailyJournal({ title, kind: 'journal' }), false);
  }
});

test('journal entries render newest first without separating their summaries', () => {
  const intro = '# Journal 2026-09-30\n\nDaily notes.';
  const early = '## 09:09 personal (early)\n\n### Decisions\n\n- Keep [links](https://example.com).\n\n```md\n## 23:59 not an entry\n```';
  const latest = '## 15:00 personal (latest)\n\n### Lessons\n\nNewest summary.';
  const middle = '## 14:59 projects (middle)\n\n### Follow-ups\n\nMiddle summary.\n\n### 23:59 nested heading\n\nStill middle.';
  const tied = '## 14:59 infra (tied)\n\nAnother summary.';
  const join = (...parts) => parts.join('\n\n');
  const body = join(intro, early, middle, latest, tied);
  const expected = render(join(intro, latest, middle, tied, early), false);
  assert.equal(render(body), expected);
  assert.equal(render(join(intro, latest, middle, tied, early)), expected);
  assert.notEqual(render(body, false), expected);

  for (const unchanged of ['', intro, early, '- [ ] Scratchpad item\n\n## Notes\n\nKeep this order.', '## 25:99 not a time\n\nKeep this too.']) {
    assert.equal(render(unchanged), render(unchanged, false));
  }
});
