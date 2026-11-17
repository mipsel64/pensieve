import { Grid } from '@astryxdesign/core/Grid';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { VStack } from '@astryxdesign/core/Stack';
import { pixel, Table } from '@astryxdesign/core/Table';
import { Heading, Text } from '@astryxdesign/core/Text';
import { CalendarDays, Eye, Network, Users } from 'lucide-react';
import { href } from './router.js';
import { Bars, Heatmap } from './Dashboard.jsx';
import { Card, Empty, ErrorNote, formatNumber, KIND_COLORS, Loading, PageLink, RelTime, TypeBadge, useStats } from './ui.jsx';

const AUTHOR_COLUMNS = [
  {
    key: 'agent',
    header: 'Agent',
    width: pixel(120),
    renderCell: (a) => <Link type="code" maxLines={1} href={href('timeline', { author: a.name })}>{a.agent}</Link>,
  },
  { key: 'device', header: 'Device', width: pixel(90), renderCell: (a) => <Text type="code" color="secondary" maxLines={1}>{a.device || '—'}</Text> },
  { key: 'writes', header: 'Writes', width: pixel(70), align: 'end', renderCell: (a) => formatNumber(a.writes) },
  { key: 'pages', header: 'Pages', width: pixel(70), align: 'end', renderCell: (a) => formatNumber(a.pages) },
  { key: 'last_at', header: 'Last write', width: pixel(130), renderCell: (a) => <Text maxLines={1}><RelTime iso={a.last_at} /></Text> },
];

export function Activity() {
  const stats = useStats();
  if (stats.loading && !stats.data) return <Loading label="Loading activity" variant="cards" />;
  if (stats.error) return <ErrorNote error={stats.error} onRetry={stats.reload} />;
  const s = stats.data;
  const authors = s.authors.map((a) => {
    const at = a.name.indexOf('@');
    return { ...a, agent: at < 0 ? a.name : a.name.slice(0, at), device: at < 0 ? '' : a.name.slice(at + 1) };
  });

  return (
    <VStack gap={6}>
      <VStack as="header" gap={1}>
        <Heading level={1}>Activity</Heading>
        <Text color="secondary">How memory is written and read, by day, agent and type.</Text>
      </VStack>
      <Card title="Writes per day" icon={CalendarDays}>
        <Heatmap days={s.days} />
      </Card>
      <Grid columns={{ minWidth: 320, max: 2 }} gap={4} align="start">
        <Card title="Writes by agent" icon={Users}>
          {s.authors.length === 0 ? <Empty>No writes yet.</Empty> : <Table data={authors} columns={AUTHOR_COLUMNS} idKey="name" density="compact" textOverflow="truncate" hasHover />}
        </Card>
        <Card title="Pages by type" icon={Network}>
          <Bars
            items={s.kinds.map((k) => ({ name: k.name, count: k.count, color: KIND_COLORS[k.name], label: <TypeBadge kind={k.name} /> }))}
            total={s.pages}
          />
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
          <Text as="p" type="supporting" color="secondary">
            {formatNumber(s.never_visited)} of {formatNumber(s.pages)} pages have never been read.
          </Text>
        </Card>
      </Grid>
    </VStack>
  );
}
