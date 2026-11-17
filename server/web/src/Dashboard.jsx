import { useMemo } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Card as AstryxCard } from '@astryxdesign/core/Card';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { AlertTriangle, CalendarDays, Clock, Eye, FileText, GitCommitHorizontal, Link2, Network, Unlink, Users } from 'lucide-react';
import { href } from './router.js';
import { Card, Empty, ErrorNote, formatNumber, KIND_COLORS, Loading, PageLink, RelTime, TypeBadge, useResource, useStats } from './ui.jsx';
import './Dashboard.css';

const WEEKS = 53;
const DAY = 86400000;
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const dateFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function Dashboard() {
  const stats = useStats();
  const recent = useResource('/history?limit=8');
  if (stats.loading && !stats.data) return <Loading label="Loading memory" variant="cards" />;
  if (stats.error) return <ErrorNote error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;
  const lastWrite = recent.data?.[0]?.at;

  return (
    <VStack gap={6}>
      <VStack as="header" gap={1}>
        <Heading level={1}>Memory</Heading>
        <Text color="secondary">
          {formatNumber(s.pages)} pages · {formatNumber(s.links)} links{lastWrite && <> · last write <RelTime iso={lastWrite} /></>}
        </Text>
      </VStack>

      <Grid columns={{ minWidth: 180, max: 4 }} gap={4}>
        <Stat icon={FileText} label="Pages" value={s.pages} />
        <Stat icon={Link2} label="Links" value={s.links} hint={s.pages ? `${(s.links / s.pages).toFixed(1)} per page` : undefined} />
        <Stat icon={GitCommitHorizontal} label="Revisions" value={s.revisions} />
        <Stat icon={Eye} label="Never visited" value={s.never_visited} hint={s.pages ? `${Math.round((100 * s.never_visited) / s.pages)}% of pages` : undefined} />
      </Grid>

      <Card title="Writes per day" icon={CalendarDays}>
        <Heatmap days={s.days} />
      </Card>

      <Grid columns={{ minWidth: 320, max: 2 }} gap={4} align="start">
        <Card title="Page types" icon={Network}>
          <Bars
            items={s.kinds.map((k) => ({ name: k.name, count: k.count, color: KIND_COLORS[k.name], label: <TypeBadge kind={k.name} /> }))}
            total={s.pages}
          />
        </Card>

        <Card title="Recent writes" icon={Clock} action={<Link href={href('timeline')}>Timeline</Link>}>
          {recent.error && <ErrorNote error={recent.error} onRetry={recent.reload} />}
          {recent.data?.length === 0 && <Empty>Nothing written yet.</Empty>}
          {recent.data?.length > 0 && (
            <List hasDividers edge="flush">
              {recent.data.map((r) => (
                <ListItem
                  key={r.seq}
                  align="start"
                  label={<PageLink title={r.title} />}
                  description={
                    <VStack gap={1}>
                      <Text color={r.summary ? 'primary' : 'secondary'}>{r.summary ?? 'No summary'}</Text>
                      <Text type="supporting" color="secondary">
                        <Text type="code">{r.by}</Text> · <RelTime iso={r.at} />
                      </Text>
                    </VStack>
                  }
                />
              ))}
            </List>
          )}
        </Card>

        <Card title="Most linked" icon={Link2}>
          <List hasDividers edge="flush" listStyle="decimal">
            {s.hubs.map((h) => (
              <ListItem key={h.name} label={<PageLink title={h.name} />} endContent={<Text type="code" color="secondary">{h.count}</Text>} />
            ))}
          </List>
        </Card>

        <Card title="Agents" icon={Users} action={<Link href={href('activity')}>Activity</Link>}>
          <List hasDividers edge="flush">
            {s.authors.slice(0, 8).map((a) => (
              <ListItem
                key={a.name}
                align="start"
                label={<Link type="code" href={href('timeline', { author: a.name })}>{a.name}</Link>}
                description={
                  <Text type="supporting" color="secondary">
                    {formatNumber(a.writes)} {a.writes === 1 ? 'write' : 'writes'} · <RelTime iso={a.last_at} />
                  </Text>
                }
              />
            ))}
          </List>
        </Card>

        <Card title="Recently visited" icon={Eye}>
          {s.recent_visits.length === 0 ? (
            <Empty>No page has been read through the API yet.</Empty>
          ) : (
            <List hasDividers edge="flush">
              {s.recent_visits.map((v) => (
                <ListItem key={v.title} label={<PageLink title={v.title} />} endContent={<RelTime iso={v.at} />} />
              ))}
            </List>
          )}
        </Card>

        <GridSpan columns="full">
          <Card title="Needs attention" icon={AlertTriangle}>
            <Grid columns={{ minWidth: 220, max: 3 }} gap={5} align="start">
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
            </Grid>
          </Card>
        </GridSpan>
      </Grid>
    </VStack>
  );
}

function Stat({ icon, label, value, hint }) {
  return (
    <AstryxCard>
      <VStack gap={1}>
        <HStack gap={2} align="center">
          <Icon icon={icon} size="sm" color="secondary" />
          <Text type="label" color="secondary">{label}</Text>
        </HStack>
        <Text type="display-3" hasTabularNumbers>{formatNumber(value)}</Text>
        {hint && <Text type="supporting" color="secondary">{hint}</Text>}
      </VStack>
    </AstryxCard>
  );
}

export function Bars({ items, total }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="dashboard-bars">
      {items.map((item) => (
        <li key={item.name}>
          <span className="dashboard-bar-label">{item.label ?? item.name}</span>
          <span className="dashboard-bar-track" aria-hidden="true">
            <span className="dashboard-bar-fill" style={{ width: `${(100 * item.count) / max}%`, background: item.color ?? 'var(--color-accent)' }} />
          </span>
          <span className="dashboard-bar-value">
            {formatNumber(item.count)}
            {total ? ` · ${Math.round((100 * item.count) / total)}%` : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HealthList({ icon, title, total, hint, items }) {
  return (
    <VStack gap={2}>
      <HStack gap={2} align="center">
        <Icon icon={icon} size="sm" color="secondary" />
        <Heading level={3}>{title}</Heading>
        {total !== undefined && <Badge variant="neutral" label={formatNumber(total)} />}
      </HStack>
      <Text as="p" type="supporting" color="secondary">{hint}</Text>
      {items.length ? (
        <List density="compact" edge="flush">
          {items.map((item) => (
            <ListItem
              key={item.key}
              label={item.label}
              endContent={item.value && <Text type="supporting" color="secondary">{item.value}</Text>}
            />
          ))}
        </List>
      ) : (
        <Text as="p" type="supporting" color="secondary">None</Text>
      )}
    </VStack>
  );
}

export function Heatmap({ days }) {
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
        return { date, count: counts.get(date) ?? 0, future: time > today.getTime() };
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
    return { weeks, months, total, active: cells.filter((c) => c.count > 0).length, busiest };
  }, [days]);

  const summary = busiest
    ? `${formatNumber(total)} writes on ${active} ${active === 1 ? 'day' : 'days'} in these 53 weeks; the busiest day was ${dateFormat.format(new Date(busiest.date))} with ${formatNumber(busiest.count)}.`
    : 'No writes in the last year.';

  return (
    <VStack gap={3}>
      <Text as="p" type="supporting" color="secondary">{summary}</Text>
      <div className="dashboard-heatmap-scroll">
        <div className="dashboard-heatmap" role="img" aria-label={summary}>
          <div className="dashboard-heatmap-months" aria-hidden="true">
            {months.map((m, i) => <span key={i}>{m}</span>)}
          </div>
          <div className="dashboard-heatmap-days" aria-hidden="true">
            <span>Mon</span><span /><span>Wed</span><span /><span>Fri</span><span /><span />
          </div>
          <div className="dashboard-heatmap-grid">
            {weeks.flat().map((cell) => (
              <span
                key={cell.date}
                className={`dashboard-heat-cell level-${cell.future ? 'none' : cell.level}`}
                title={cell.future ? undefined : `${formatNumber(cell.count)} ${cell.count === 1 ? 'write' : 'writes'} on ${dateFormat.format(new Date(cell.date))}`}
              />
            ))}
          </div>
        </div>
      </div>
      <HStack gap={1} align="center" justify="end" aria-hidden="true">
        <Text type="supporting" color="secondary">Less</Text>
        {[0, 1, 2, 3, 4].map((level) => <span key={level} className={`dashboard-heat-cell dashboard-legend-cell level-${level}`} />)}
        <Text type="supporting" color="secondary">More</Text>
      </HStack>
    </VStack>
  );
}

