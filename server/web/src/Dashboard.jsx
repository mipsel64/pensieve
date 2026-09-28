import { AlertTriangle, Clock, Eye, FileText, GitCommitHorizontal, Link2, Network, Unlink, Users } from 'lucide-react';
import { href } from './router.js';
import { Card, Empty, ErrorNote, formatNumber, KIND_COLORS, Loading, PageLink, RelTime, useResource, useStats } from './ui.jsx';

export function Dashboard() {
  const stats = useStats();
  const recent = useResource('/history?limit=8');
  if (stats.loading && !stats.data) return <Loading label="Loading memory" />;
  if (stats.error) return <ErrorNote error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;
  const lastWrite = recent.data?.[0]?.at;

  return (
    <div className="view">
      <header className="view-header">
        <h1>Memory</h1>
        <p className="muted">
          {formatNumber(s.pages)} pages · {formatNumber(s.links)} links{lastWrite && <> · last write <RelTime iso={lastWrite} /></>}
        </p>
      </header>

      <div className="stats-grid">
        <Stat icon={FileText} label="Pages" value={s.pages} />
        <Stat icon={Link2} label="Links" value={s.links} hint={s.pages ? `${(s.links / s.pages).toFixed(1)} per page` : undefined} />
        <Stat icon={GitCommitHorizontal} label="Revisions" value={s.revisions} />
        <Stat icon={Eye} label="Never visited" value={s.never_visited} hint={s.pages ? `${Math.round((100 * s.never_visited) / s.pages)}% of pages` : undefined} />
      </div>

      <div className="dashboard-grid">
        <Card title="Page types" icon={Network} className="span-2">
          <Bars items={s.kinds.map((k) => ({ name: k.name, count: k.count, color: KIND_COLORS[k.name] }))} total={s.pages} />
        </Card>

        <Card title="Recent writes" icon={Clock} className="span-2" action={<a className="card-link" href={href('timeline')}>Timeline</a>}>
          {recent.error && <ErrorNote error={recent.error} onRetry={recent.reload} />}
          {recent.data?.length === 0 && <Empty>Nothing written yet.</Empty>}
          <ol className="feed">
            {(recent.data ?? []).map((r) => (
              <li key={r.seq}>
                <div className="feed-main">
                  <PageLink title={r.title} />
                  <span className="feed-summary">{r.summary ?? <span className="muted">No summary</span>}</span>
                </div>
                <div className="feed-meta">
                  <span className="mono">{r.by}</span> · <RelTime iso={r.at} />
                </div>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Most linked" icon={Link2}>
          <ol className="ranked">
            {s.hubs.map((h) => (
              <li key={h.name}>
                <PageLink title={h.name} />
                <span className="mono muted">{h.count}</span>
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Agents" icon={Users} action={<a className="card-link" href={href('activity')}>Activity</a>}>
          <ul className="feed">
            {s.authors.slice(0, 8).map((a) => (
              <li key={a.name}>
                <a className="mono" href={href('timeline', { author: a.name })}>
                  {a.name}
                </a>
                <span className="feed-meta">
                  {formatNumber(a.writes)} {a.writes === 1 ? 'write' : 'writes'} · <RelTime iso={a.last_at} />
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Recently visited" icon={Eye} className="span-2">
          {s.recent_visits.length === 0 ? (
            <Empty>No page has been read through the API yet.</Empty>
          ) : (
            <ul className="ranked two-col">
              {s.recent_visits.map((v) => (
                <li key={v.title}>
                  <PageLink title={v.title} />
                  <RelTime iso={v.at} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Needs attention" icon={AlertTriangle} className="span-4">
          <div className="health">
            <HealthList
              icon={Unlink}
              title="Missing pages"
              total={s.missing_total}
              hint="Linked to, but never written"
              items={s.missing.map((m) => ({ key: m.name, label: <PageLink title={m.name} missing />, value: `${m.count} ${m.count === 1 ? 'link' : 'links'}` }))}
            />
            <HealthList
              icon={FileText}
              title="Orphans"
              total={s.orphans_total}
              hint="No other page links here"
              items={s.orphans.map((t) => ({ key: t, label: <PageLink title={t} /> }))}
            />
            <HealthList
              icon={Clock}
              title="Least recently used"
              hint="Oldest last write or visit"
              items={s.stale.map((p) => ({ key: p.title, label: <PageLink title={p.title} />, value: <RelTime iso={p.visited_at && p.visited_at > p.updated_at ? p.visited_at : p.updated_at} /> }))}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value, hint }) {
  return (
    <div className="stat">
      <div className="stat-label">
        <Icon size={16} aria-hidden="true" />
        {label}
      </div>
      <div className="stat-value">{formatNumber(value)}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Bars({ items, total }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="bars">
      {items.map((item) => (
        <li key={item.name}>
          <span className="bar-label">
            {item.color && <span className="dot" style={{ background: item.color }} aria-hidden="true" />}
            {item.label ?? item.name}
          </span>
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${(100 * item.count) / max}%`, background: item.color ?? 'var(--accent)' }} />
          </span>
          <span className="bar-value mono">
            {formatNumber(item.count)}
            {total ? <span className="muted"> · {Math.round((100 * item.count) / total)}%</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HealthList({ icon: Icon, title, total, hint, items }) {
  return (
    <div className="health-list">
      <h3>
        <Icon size={15} aria-hidden="true" />
        {title}
        {total !== undefined && <span className="count">{formatNumber(total)}</span>}
      </h3>
      <p className="muted small">{hint}</p>
      {items.length ? (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              {item.label}
              {item.value && <span className="muted small">{item.value}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">None</p>
      )}
    </div>
  );
}

