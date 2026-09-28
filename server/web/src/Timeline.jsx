import { useContext, useEffect, useRef, useState } from 'react';
import { History, Loader2, X } from 'lucide-react';
import { api, query, Unauthorized } from './api.js';
import { href } from './router.js';
import { AuthContext, Empty, ErrorNote, formatNumber, PageLink, RelTime, useResource } from './ui.jsx';

const PAGE = 50;
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export function Timeline({ params }) {
  const lock = useContext(AuthContext);
  const { author, title } = params;
  const stats = useResource('/stats');
  const [entries, setEntries] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, done: false });
  const latest = useRef(0);

  async function load(before) {
    // Only the newest request may update the list, so a slow response can't overwrite a newer filter.
    const request = ++latest.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const page = await api(`/history${query({ author, title, before, limit: PAGE })}`);
      if (request !== latest.current) return;
      setEntries((prev) => (before ? [...prev, ...page] : page));
      setState({ loading: false, error: null, done: page.length < PAGE });
    } catch (error) {
      if (request !== latest.current) return;
      if (error instanceof Unauthorized) lock();
      setState({ loading: false, error, done: false, before });
    }
  }

  useEffect(() => {
    setEntries([]);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [author, title]);

  const groups = [];
  for (const entry of entries) {
    const day = dayFormat.format(new Date(entry.at));
    if (groups.at(-1)?.day !== day) groups.push({ day, entries: [] });
    groups.at(-1).entries.push(entry);
  }

  return (
    <div className="view">
      <header className="view-header">
        <h1>Timeline</h1>
        <p className="muted">Every write, newest first, with the summary the agent gave.</p>
      </header>

      <div className="toolbar">
        <label htmlFor="author-filter">Agent</label>
        <select
          id="author-filter"
          value={author ?? ''}
          onChange={(e) => (location.hash = href('timeline', { ...params, author: e.target.value || undefined }))}
        >
          <option value="">All agents</option>
          {/* Stats list only the most active agents; an older one can still come from a link. */}
          {author && stats.data && !stats.data.authors.some((a) => a.name === author) && <option value={author}>{author}</option>}
          {(stats.data?.authors ?? []).map((a) => (
            <option key={a.name} value={a.name}>
              {a.name} ({formatNumber(a.writes)})
            </option>
          ))}
        </select>
        {title && (
          <a className="chip removable" href={href('timeline', { ...params, title: undefined })} aria-label={`Stop filtering by page ${title}`}>
            page: {title} <X size={14} aria-hidden="true" />
          </a>
        )}
      </div>

      {state.error && <ErrorNote error={state.error} onRetry={() => load(state.before)} />}
      {!state.loading && !state.error && entries.length === 0 && <Empty>No writes match these filters.</Empty>}

      <div className="timeline">
        {groups.map((group) => (
          <section key={group.day} aria-label={group.day}>
            <h2 className="timeline-day">{group.day}</h2>
            <ol>
              {group.entries.map((r) => (
                <li key={r.seq} className="timeline-entry">
                  <time className="mono muted" dateTime={r.at} title={new Date(r.at).toLocaleString()}>
                    {timeFormat.format(new Date(r.at))}
                  </time>
                  <div className="timeline-main">
                    <div className="timeline-title">
                      <PageLink title={r.title} />
                      <span className="chip">{r.rev === 1 ? 'created' : `rev ${r.rev}`}</span>
                    </div>
                    <p className="timeline-summary">{r.summary ?? <span className="muted">No summary</span>}</p>
                  </div>
                  <div className="timeline-meta">
                    <a className="mono" href={href('timeline', { ...params, author: r.by })}>
                      {r.by}
                    </a>
                    <span className="muted">{formatNumber(r.bytes)} bytes</span>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>

      {state.loading && (
        <div className="state" role="status">
          <Loader2 className="spin" size={18} aria-hidden="true" />
          Loading writes…
        </div>
      )}
      {!state.loading && !state.done && entries.length > 0 && (
        <button type="button" className="ghost load-more" onClick={() => load(entries.at(-1).seq)}>
          <History size={16} aria-hidden="true" /> Older writes
        </button>
      )}
      {state.done && entries.length > 0 && (
        <p className="muted small center">
          Start of history · <RelTime iso={entries.at(-1).at} />
        </p>
      )}
    </div>
  );
}
