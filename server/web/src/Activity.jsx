import { useMemo } from 'react';
import { CalendarDays, Eye, Network, Users } from 'lucide-react';
import { href } from './router.js';
import { Bars } from './Dashboard.jsx';
import { Card, Empty, ErrorNote, formatNumber, KIND_COLORS, Loading, PageLink, RelTime, useStats } from './ui.jsx';

const WEEKS = 53;
const DAY = 86400000;
const monthFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  timeZone: 'UTC',
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function Activity() {
  const stats = useStats();
  if (stats.loading && !stats.data) return <Loading label="Loading activity" />;
  if (stats.error) return <ErrorNote error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;

  return (
    <div className="view">
      <header className="view-header">
        <h1>Activity</h1>
        <p className="muted">How memory is written and read, by day, agent and type.</p>
      </header>
      <Card title="Writes per day" icon={CalendarDays}>
        <Heatmap days={s.days} />
      </Card>
      <div className="dashboard-grid">
        <Card title="Writes by agent" icon={Users} className="span-2">
          {s.authors.length === 0 ? (
            <Empty>No writes yet.</Empty>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Agent</th>
                    <th scope="col">Device</th>
                    <th scope="col" className="num">
                      Writes
                    </th>
                    <th scope="col" className="num">
                      Pages
                    </th>
                    <th scope="col">Last write</th>
                  </tr>
                </thead>
                <tbody>
                  {s.authors.map((a) => {
                    const at = a.name.indexOf('@');
                    const [agent, device] = at < 0 ? [a.name, ''] : [a.name.slice(0, at), a.name.slice(at + 1)];
                    return (
                      <tr key={a.name}>
                        <td>
                          <a className="mono" href={href('timeline', { author: a.name })}>
                            {agent}
                          </a>
                        </td>
                        <td className="mono muted">{device || '—'}</td>
                        <td className="num mono">{formatNumber(a.writes)}</td>
                        <td className="num mono">{formatNumber(a.pages)}</td>
                        <td>
                          <RelTime iso={a.last_at} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Pages by type" icon={Network} className="span-2">
          <Bars
            items={s.kinds.map((k) => ({
              name: k.name,
              count: k.count,
              color: KIND_COLORS[k.name],
            }))}
            total={s.pages}
          />
        </Card>
        <Card title="Recently visited" icon={Eye} className="span-2">
          {s.recent_visits.length === 0 ? (
            <Empty>No page has been read through the API yet.</Empty>
          ) : (
            <ul className="ranked">
              {s.recent_visits.map((v) => (
                <li key={v.title}>
                  <PageLink title={v.title} />
                  <RelTime iso={v.at} />
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">
            {formatNumber(s.never_visited)} of {formatNumber(s.pages)} pages have never been read.
          </p>
        </Card>
      </div>
    </div>
  );
}

function Heatmap({ days }) {
  const { weeks, months, total, active, busiest } = useMemo(() => {
    const counts = new Map(days.map((d) => [d.name, d.count]));
    // Server days are UTC dates; columns are Monday-first weeks ending with the current week.
    const today = new Date(new Date().toISOString().slice(0, 10));
    const monday = today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY;
    const start = monday - (WEEKS - 1) * 7 * DAY;
    const weeks = Array.from({ length: WEEKS }, (_, w) =>
      Array.from({ length: 7 }, (_, d) => {
        const time = start + (w * 7 + d) * DAY;
        const date = new Date(time).toISOString().slice(0, 10);
        return {
          date,
          count: counts.get(date) ?? 0,
          future: time > today.getTime(),
        };
      }),
    );
    // The server sends a few more days than the grid shows; everything below describes the grid only.
    const cells = weeks.flat();
    const max = Math.max(1, ...cells.map((c) => c.count));
    for (const c of cells) c.level = c.count === 0 ? 0 : Math.min(4, Math.ceil((4 * c.count) / max));
    const monthOf = (i) => new Date(weeks[i][0].date).getUTCMonth();
    // A label needs about three columns; the first week's month rarely gets them before the next month starts.
    const months = weeks.map((week, i) => {
      if (i === 0) return monthOf(0) === monthOf(Math.min(3, weeks.length - 1)) ? monthFormat.format(new Date(week[0].date)) : '';
      return monthOf(i) !== monthOf(i - 1) ? monthFormat.format(new Date(week[0].date)) : '';
    });
    const busiest = cells.reduce((best, c) => (c.count > (best?.count ?? 0) ? c : best), null);
    const total = cells.reduce((sum, c) => sum + c.count, 0);
    return {
      weeks,
      months,
      total,
      active: cells.filter((c) => c.count > 0).length,
      busiest,
    };
  }, [days]);

  const summary = busiest
    ? `${formatNumber(total)} writes on ${active} ${active === 1 ? 'day' : 'days'} in these 53 weeks; the busiest day was ${dateFormat.format(new Date(busiest.date))} with ${formatNumber(busiest.count)}.`
    : 'No writes in the last year.';

  return (
    <div className="heatmap-wrap">
      <p className="muted small">{summary}</p>
      <div className="heatmap-scroll">
        <div className="heatmap" role="img" aria-label={summary}>
          <div className="heatmap-months" aria-hidden="true">
            {months.map((m, i) => (
              <span key={i}>{m}</span>
            ))}
          </div>
          <div className="heatmap-days" aria-hidden="true">
            <span>Mon</span>
            <span />
            <span>Wed</span>
            <span />
            <span>Fri</span>
            <span />
            <span />
          </div>
          <div className="heatmap-grid">
            {weeks.flat().map((cell) => (
              <span
                key={cell.date}
                className={`cell level-${cell.future ? 'none' : cell.level}`}
                title={
                  cell.future ? undefined : `${formatNumber(cell.count)} ${cell.count === 1 ? 'write' : 'writes'} on ${dateFormat.format(new Date(cell.date))}`
                }
              />
            ))}
          </div>
        </div>
      </div>
      <div className="heatmap-legend" aria-hidden="true">
        Less
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} className={`cell level-${level}`} />
        ))}
        More
      </div>
    </div>
  );
}
