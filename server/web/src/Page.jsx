import { useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FileQuestion, History, Link2, Maximize2, Network, X } from 'lucide-react';
import { query } from './api.js';
import { href, RouteContext } from './router.js';
import { isDailyJournal } from './journal.js';
import { Menu, MenuItem } from './Menu.jsx';
import { ReadingProgress, scrollToHeading, TocMenu, TocSide, useActiveHeading, useHeadings } from './Toc.jsx';
import { useCopy } from './Toast.jsx';
import { readingMinutes } from './toc.js';
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
    minutes: data ? readingMinutes(body) : 0,
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
    const onKey = (e) => e.key === 'Escape' && !e.defaultPrevented && (location.hash = closeHref);
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
          {p.data && <PageMeta data={p.data} minutes={p.minutes} />}
        </div>
        <a className="icon-button" href={href('page', { title: p.data?.title ?? title })} aria-label="Open as full page" title="Open as full page">
          <Maximize2 size={16} aria-hidden="true" />
        </a>
        {p.data && <PageMenu title={p.data.title} />}
        <a className="icon-button" href={closeHref} aria-label="Close page" title="Close (Esc)">
          <X size={18} aria-hidden="true" />
        </a>
      </header>

      <div className="drawer-body">
        <PageStatus page={p.page} title={title} />
        {p.data && (
          <>
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
  const { params } = useContext(RouteContext);
  const copy = useCopy();
  const heading = useRef(null);
  const prose = useRef(null);
  const name = p.data?.title ?? title;
  const sectionHref = useCallback((id) => href('page', { title: name, section: id }), [name]);
  const copySection = useCallback((id) => copy(new URL(sectionHref(id), location.href).href, 'Link to section copied'), [copy, sectionHref]);
  const headings = useHeadings(prose, p.body);
  const active = useActiveHeading(prose, headings);
  const toc = {
    items: headings,
    active,
    hrefFor: sectionHref,
    onPick: (id) => {
      if (scrollToHeading(prose, id)) history.replaceState(null, '', sectionHref(id));
    },
  };

  useEffect(() => {
    heading.current?.focus();
  }, [title]);

  useEffect(() => {
    if (p.data && params.section) scrollToHeading(prose, params.section);
  }, [p.data, params.section]);

  return (
    <>
      <ReadingProgress />
      <div className="view page-view">
        <article className="page-main" aria-labelledby="page-title">
          <header className="page-header">
            <div className="page-crumbs">
              <nav aria-label="Breadcrumb">
                <ol>
                  <li>
                    <a href={href('search')}>Memory</a>
                  </li>
                  {p.data && (
                    <li>
                      <TypeBadge kind={p.data.kind} />
                    </li>
                  )}
                </ol>
              </nav>
              {p.data && <PageMenu title={p.data.title} />}
            </div>
            <h1 id="page-title" tabIndex={-1} ref={heading}>
              {name}
            </h1>
            {p.data && <PageMeta data={p.data} minutes={p.minutes} badge={false} />}
          </header>
          <PageStatus page={p.page} title={title} />
          {p.data && (
            <>
              {headings.length > 1 && <TocMenu {...toc} />}
              <Properties fields={p.fields} missing={p.missing} />
              <div ref={prose} className="prose page-prose">
                <Markdown missing={p.missing} newestFirst={isDailyJournal(p.data)} onAnchor={copySection}>
                  {p.body}
                </Markdown>
              </div>
              <footer className="page-foot">
                <LinkLists data={p.data} as="h2" />
                <RecentChanges changes={p.changes} as="h2" />
              </footer>
            </>
          )}
        </article>
        {headings.length > 1 && <TocSide {...toc} />}
      </div>
    </>
  );
}

function PageMeta({ data, minutes, badge = true }) {
  return (
    <div className="meta-row">
      {badge && <TypeBadge kind={data.kind} />}
      {data.confidence && <span className="chip">confidence {data.confidence}</span>}
      <span>rev {data.rev}</span>
      <span>
        updated <RelTime iso={data.updated_at} /> by <span className="mono">{data.updated_by}</span>
      </span>
      <span>{minutes} min read</span>
      <span>
        visited <RelTime iso={data.visited_at} />
      </span>
    </div>
  );
}

function PageStatus({ page, title }) {
  if (page.loading) return <Loading variant="article" label="Loading page" />;
  if (!page.error) return null;
  if (/cannot find page/i.test(page.error.message)) {
    return (
      <Empty icon={FileQuestion} title={`No page called “${title}” yet`} action={{ href: href('search', { q: title, mode: 'keywords' }), label: 'Search for it' }}>
        Pages link to it, but nobody has written it.
      </Empty>
    );
  }
  return <ErrorNote error={page.error} onRetry={page.reload} />;
}

function PageMenu({ title }) {
  const copy = useCopy();
  return (
    <Menu label="Page actions">
      <MenuItem icon={History} href={href('timeline', { title })}>
        History
      </MenuItem>
      <MenuItem icon={Network} href={href('graph', { focus: title, page: title })}>
        Show in graph
      </MenuItem>
      <MenuItem icon={Link2} onSelect={() => copy(new URL(href('page', { title }), location.href).href, 'Link copied')}>
        Copy link
      </MenuItem>
    </Menu>
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

function LinkLists({ data, as: Heading = 'h3' }) {
  const ids = useId();
  const lists = [
    ['Backlinks', data.backlinks.map((t) => ({ title: t, missing: false })), 'No other page links here yet.'],
    ['Links', data.links.map((l) => ({ title: l.title, missing: !l.exists })), 'This page links to nothing.'],
  ];
  return (
    <div className="link-lists">
      {lists.map(([label, items, none]) => (
        <section key={label} aria-labelledby={`${ids}-${label}`}>
          <Heading id={`${ids}-${label}`}>
            {label} <span className="count">{items.length}</span>
          </Heading>
          {items.length ? (
            <ul className="link-chips">
              {items.map((item) => (
                <li key={item.title}>
                  <PageLink title={item.title} missing={item.missing} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{none}</p>
          )}
        </section>
      ))}
    </div>
  );
}

function RecentChanges({ changes, as: Heading = 'h3' }) {
  if (changes.error) return <ErrorNote error={changes.error} onRetry={changes.reload} />;
  if (!changes.data?.length) return null;
  return (
    <section className="recent-changes">
      <Heading>Recent changes</Heading>
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
