import { useMemo } from 'react';
import { NotebookPen } from 'lucide-react';
import { query } from './api.js';
import { href } from './router.js';
import { Empty, ErrorNote, Loading, Markdown, PageLink, RelTime, splitFrontmatter, useResource } from './ui.jsx';
import { withoutTitle } from './Page.jsx';
import { JOURNAL_DAY, isDailyJournal } from './journal.js';
// Titles carry the writer's local date; reading it as UTC midnight keeps the day from shifting.
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
// `day` comes from the URL: an invalid date throws, and Date rolls 2026-02-30 over into March.
const formatDay = (day) => {
  const date = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(`${day}T`) ? dayFormat.format(date) : day;
};

export function Journal({ params }) {
  // TODO: search returns at most 50 journal pages, about seven weeks of days; page through them if that's too short.
  const list = useResource(`/search${query({ type: 'journal', limit: 50 })}`);
  const days = useMemo(
    () =>
      (list.data?.hits ?? [])
        .map((h) => JOURNAL_DAY.exec(h.title)?.[1])
        .filter(Boolean)
        .sort()
        .reverse(),
    [list.data],
  );
  const day = params.day ?? days[0];
  const scratchpad = useResource('/pages/Scratchpad');

  if (list.loading && !list.data) return <Loading label="Loading journal" variant="page" />;
  if (list.error) return <ErrorNote error={list.error} onRetry={list.reload} />;

  return (
    <div className="view page-view">
      <article className="page-main" aria-labelledby="page-title">
        {day ? (
          <Day key={day} day={day} />
        ) : (
          <>
            <header className="page-header">
              <h1 id="page-title">Journal</h1>
            </header>
            <Empty icon={NotebookPen} title="No journal yet">
              pi-pensieve adds a summary of each Pi session here when the session ends.
            </Empty>
          </>
        )}
      </article>
      <aside className="page-side" aria-label="Scratchpad and days">
        <section className="journal-scratchpad">
          <h3>
            <PageLink title="Scratchpad" />
          </h3>
          <PageBody resource={scratchpad} className="prose" empty="Nothing on the Scratchpad." />
        </section>
        {days.length > 0 && (
          <div className="link-lists journal-days">
            <section>
              <h3>Days</h3>
              <ul>
                {days.map((d) => (
                  <li key={d}>
                    <a href={href('journal', { ...params, day: d })} aria-current={d === day ? 'page' : undefined}>
                      {d}
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}

// Keyed by day, so switching days never shows the previous day's page while the next one loads.
function Day({ day }) {
  const entry = useResource(`/pages/${encodeURIComponent(`Journal ${day}`)}`);
  return (
    <>
      <header className="page-header">
        <h1 id="page-title">{formatDay(day)}</h1>
        {entry.data && (
          <div className="meta-row">
            <span>
              updated <RelTime iso={entry.data.updated_at} /> by <span className="mono">{entry.data.updated_by}</span>
            </span>
            <PageLink title={entry.data.title}>Open page</PageLink>
          </div>
        )}
      </header>
      <PageBody resource={entry} className="prose page-prose" empty="No journal for this day." newestFirst={isDailyJournal(entry.data)} />
    </>
  );
}

function PageBody({ resource, className, empty, newestFirst = false }) {
  if (resource.loading) return <Loading variant="article" />;
  if (resource.error) {
    return /cannot find page/i.test(resource.error.message) ? <Empty>{empty}</Empty> : <ErrorNote error={resource.error} onRetry={resource.reload} />;
  }
  if (!resource.data) return null;
  const { title, content, links } = resource.data;
  const missing = new Set(links.filter((l) => !l.exists).map((l) => l.title.toLowerCase()));
  return (
    <div className={className}>
      <Markdown missing={missing} newestFirst={newestFirst}>{withoutTitle(splitFrontmatter(content)[1], title)}</Markdown>
    </div>
  );
}
