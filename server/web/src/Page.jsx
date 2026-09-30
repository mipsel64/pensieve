import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { History, Maximize2, Network, X } from 'lucide-react';
import { query } from './api.js';
import { href } from './router.js';
import { isDailyJournal } from './journal.js';
import { Empty, ErrorNote, Loading, Markdown, PageLink, RelTime, splitFrontmatter, TypeBadge, useResource } from './ui.jsx';

function usePage(title) {
  const page = useResource(`/pages/${encodeURIComponent(title)}`);
  const changes = useResource(`/history${query({ title, limit: 5 })}`);
  const data = page.data;
  const [fields, body] = useMemo(() => (data ? splitFrontmatter(data.content) : [[], '']), [data]);
  const missing = useMemo(() => new Set((data?.links ?? []).filter((l) => !l.exists).map((l) => l.title.toLowerCase())), [data]);
  return {
    page,
    changes,
    data,
    fields: fields.filter(([key]) => !['type', 'confidence'].includes(key)),
    body: data ? withoutTitle(body, data.title) : '',
    missing,
  };
}

// Pages usually open with their title as a heading, which the header above already shows.
export function withoutTitle(body, title) {
  const heading = /^(?:[ \t]*\r?\n)*[ ]{0,3}#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
  return heading && heading[1].trim().toLowerCase() === title.toLowerCase() ? body.slice(heading[0].length) : body;
}

const WIDTH_KEY = 'pensieve.drawerWidth';
const MIN_WIDTH = 320;
// The view beside the panel keeps at least this much room.
const MIN_CONTENT = 360;

function applyWidth(px) {
  if (px) document.documentElement.style.setProperty('--drawer-w', `${px}px`);
  else document.documentElement.style.removeProperty('--drawer-w');
}

// Per browser rather than in settings: the right width depends on this screen.
function saveWidth(px) {
  try {
    if (px) localStorage.setItem(WIDTH_KEY, px);
    else localStorage.removeItem(WIDTH_KEY);
  } catch {
    // Without storage (some private windows) the width lasts until reload.
  }
}

try {
  const saved = Number(localStorage.getItem(WIDTH_KEY));
  if (Number.isFinite(saved) && saved >= MIN_WIDTH) applyWidth(saved);
} catch {
  // Same as no stored width.
}

function ResizeHandle() {
  const handle = useRef(null);
  const drag = useRef(null);
  const [aria, setAria] = useState({ now: 0, max: 0 });

  const limit = () => {
    const nav = document.querySelector('.sidebar')?.getBoundingClientRect().right ?? 0;
    return Math.round(matchMedia('(max-width: 1180px)').matches ? innerWidth * 0.92 : innerWidth - nav - MIN_CONTENT);
  };
  const clamp = (px, max) => Math.round(Math.min(Math.max(px, MIN_WIDTH), max));
  const commit = (px) => {
    applyWidth(px);
    saveWidth(px);
    setAria({ now: px ?? handle.current.parentElement.offsetWidth, max: limit() });
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('resizing');
    if (!d) return;
    cancelAnimationFrame(d.frame);
    if (d.width) commit(d.width);
  };

  useLayoutEffect(() => setAria({ now: handle.current.parentElement.offsetWidth, max: limit() }), []);
  // Escape can close the panel mid-drag, before the pointer capture is released.
  useEffect(() => endDrag, []);

  return (
    <div
      ref={handle}
      className="drawer-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize page panel"
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={aria.max}
      aria-valuenow={aria.now}
      title="Drag to resize. Double-click to reset."
      tabIndex={0}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { max: limit(), width: 0, frame: 0 };
        document.body.classList.add('resizing');
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.width = clamp(innerWidth - e.clientX, d.max);
        d.frame ||= requestAnimationFrame(() => {
          d.frame = 0;
          applyWidth(d.width);
          setAria({ now: d.width, max: d.max });
        });
      }}
      onLostPointerCapture={endDrag}
      onDoubleClick={() => commit(null)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 96 : 32;
        const width = handle.current.parentElement.offsetWidth;
        if (e.key === 'ArrowLeft') commit(clamp(width + step, limit()));
        else if (e.key === 'ArrowRight') commit(clamp(width - step, limit()));
        else if (e.key === 'Enter') commit(null);
        else return;
        e.preventDefault();
      }}
    />
  );
}

export function PageDrawer({ title, closeHref }) {
  const p = usePage(title);
  const heading = useRef(null);

  useEffect(() => {
    heading.current?.focus();
    const onKey = (e) => e.key === 'Escape' && (location.hash = closeHref);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [title, closeHref]);

  return (
    <aside className="drawer" aria-labelledby="drawer-title">
      <ResizeHandle />
      <header className="drawer-header">
        <div className="drawer-title">
          <h2 id="drawer-title" tabIndex={-1} ref={heading}>
            {p.data?.title ?? title}
          </h2>
          {p.data && <PageMeta data={p.data} />}
        </div>
        <a className="icon-button" href={href('page', { title: p.data?.title ?? title })} aria-label="Open as full page" title="Open as full page">
          <Maximize2 size={18} aria-hidden="true" />
        </a>
        <a className="icon-button" href={closeHref} aria-label="Close page">
          <X size={20} aria-hidden="true" />
        </a>
      </header>

      <div className="drawer-body">
        <PageStatus page={p.page} title={title} />
        {p.data && (
          <>
            <PageActions data={p.data} />
            <Properties fields={p.fields} missing={p.missing} />
            <article className="prose">
              <Markdown missing={p.missing} newestFirst={isDailyJournal(p.data)}>
                {p.body}
              </Markdown>
            </article>
            <LinkLists data={p.data} />
            <RecentChanges changes={p.changes} />
          </>
        )}
      </div>
    </aside>
  );
}

/** A page on its own, for reading: links inside it open further full pages. */
export function PageView({ title }) {
  const p = usePage(title);
  const heading = useRef(null);

  useEffect(() => {
    heading.current?.focus();
  }, [title]);

  return (
    <div className="view page-view">
      <article className="page-main" aria-labelledby="page-title">
        <header className="page-header">
          <h1 id="page-title" tabIndex={-1} ref={heading}>
            {p.data?.title ?? title}
          </h1>
          {p.data && <PageMeta data={p.data} />}
          {p.data && <PageActions data={p.data} />}
        </header>
        <PageStatus page={p.page} title={title} />
        {p.data && (
          <>
            <Properties fields={p.fields} missing={p.missing} />
            <div className="prose page-prose">
              <Markdown missing={p.missing} newestFirst={isDailyJournal(p.data)}>
                {p.body}
              </Markdown>
            </div>
          </>
        )}
      </article>
      {p.data && (
        <aside className="page-side" aria-label="Links and changes">
          <LinkLists data={p.data} />
          <RecentChanges changes={p.changes} />
        </aside>
      )}
    </div>
  );
}

function PageMeta({ data }) {
  return (
    <div className="meta-row">
      <TypeBadge kind={data.kind} />
      {data.confidence && <span className="chip">confidence {data.confidence}</span>}
      <span>rev {data.rev}</span>
      <span>
        updated <RelTime iso={data.updated_at} /> by <span className="mono">{data.updated_by}</span>
      </span>
      <span>
        last visit <RelTime iso={data.visited_at} />
      </span>
    </div>
  );
}

function PageStatus({ page, title }) {
  if (page.loading) return <Loading label="Loading page" />;
  if (!page.error) return null;
  if (/cannot find page/i.test(page.error.message)) return <Empty>No page called “{title}” yet. Pages link to it, but nobody has written it.</Empty>;
  return <ErrorNote error={page.error} onRetry={page.reload} />;
}

function PageActions({ data }) {
  return (
    <nav className="drawer-actions" aria-label="Page actions">
      <a className="ghost" href={href('timeline', { title: data.title })}>
        <History size={16} aria-hidden="true" /> History
      </a>
      <a className="ghost" href={href('graph', { focus: data.title, page: data.title })}>
        <Network size={16} aria-hidden="true" /> Show in graph
      </a>
    </nav>
  );
}

function Properties({ fields, missing }) {
  if (!fields.length) return null;
  return (
    <dl className="properties">
      {fields.map(([key, value]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <Markdown missing={missing}>{value}</Markdown>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function LinkLists({ data }) {
  return (
    <div className="link-lists">
      <section>
        <h3>Links ({data.links.length})</h3>
        {data.links.length ? (
          <ul>
            {data.links.map((l) => (
              <li key={l.title}>
                <PageLink title={l.title} missing={!l.exists} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None</p>
        )}
      </section>
      <section>
        <h3>Backlinks ({data.backlinks.length})</h3>
        {data.backlinks.length ? (
          <ul>
            {data.backlinks.map((t) => (
              <li key={t}>
                <PageLink title={t} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None</p>
        )}
      </section>
    </div>
  );
}

function RecentChanges({ changes }) {
  if (changes.error) return <ErrorNote error={changes.error} onRetry={changes.reload} />;
  if (!changes.data?.length) return null;
  return (
    <section className="recent-changes">
      <h3>Recent changes</h3>
      <ol>
        {changes.data.map((r) => (
          <li key={r.seq}>
            <span className="mono">rev {r.rev}</span> {r.summary ?? <span className="muted">No summary</span>}
            <span className="muted">
              {' '}
              · {r.by} · <RelTime iso={r.at} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
