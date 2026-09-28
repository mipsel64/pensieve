import { useEffect, useMemo, useRef } from 'react';
import { History, Network, X } from 'lucide-react';
import { query } from './api.js';
import { href } from './router.js';
import { Empty, ErrorNote, Loading, Markdown, PageLink, RelTime, splitFrontmatter, TypeBadge, useResource } from './ui.jsx';

export function PageDrawer({ title, closeHref }) {
  const page = useResource(`/pages/${encodeURIComponent(title)}`);
  const changes = useResource(`/history${query({ title, limit: 5 })}`);
  const heading = useRef(null);

  useEffect(() => {
    heading.current?.focus();
    const onKey = (e) => e.key === 'Escape' && (location.hash = closeHref);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [title, closeHref]);

  const data = page.data;
  const [fields, body] = useMemo(() => (data ? splitFrontmatter(data.content) : [[], '']), [data]);
  const missing = useMemo(() => new Set((data?.links ?? []).filter((l) => !l.exists).map((l) => l.title.toLowerCase())), [data]);
  const shown = fields.filter(([key]) => !['type', 'confidence'].includes(key));

  return (
    <aside className="drawer" aria-labelledby="drawer-title">
      <header className="drawer-header">
        <div className="drawer-title">
          <h2 id="drawer-title" tabIndex={-1} ref={heading}>
            {data?.title ?? title}
          </h2>
          {data && (
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
          )}
        </div>
        <a className="icon-button" href={closeHref} aria-label="Close page">
          <X size={20} aria-hidden="true" />
        </a>
      </header>

      <div className="drawer-body">
        {page.loading && <Loading label="Loading page" />}
        {page.error && (/cannot find page/i.test(page.error.message) ? <Empty>No page called “{title}” yet. Pages link to it, but nobody has written it.</Empty> : <ErrorNote error={page.error} onRetry={page.reload} />)}
        {data && (
          <>
            <nav className="drawer-actions" aria-label="Page actions">
              <a className="ghost" href={href('timeline', { title: data.title })}>
                <History size={16} aria-hidden="true" /> History
              </a>
              <a className="ghost" href={href('graph', { focus: data.title, page: data.title })}>
                <Network size={16} aria-hidden="true" /> Show in graph
              </a>
            </nav>
            {shown.length > 0 && (
              <dl className="properties">
                {shown.map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>
                      <Markdown missing={missing}>{value}</Markdown>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            <article className="prose">
              <Markdown missing={missing}>{body}</Markdown>
            </article>
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
            {changes.error && <ErrorNote error={changes.error} onRetry={changes.reload} />}
            {changes.data?.length > 0 && (
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
            )}
          </>
        )}
      </div>
    </aside>
  );
}
