import { useMemo } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Grid } from '@astryxdesign/core/Grid';
import { List, ListItem } from '@astryxdesign/core/List';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
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
    <Grid columns={{ minWidth: 320, max: 2 }} gap={6} align="start">
      <VStack as="article" aria-labelledby="page-title" gap={5}>
        {day ? (
          <Day key={day} day={day} />
        ) : (
          <>
            <Heading level={1} id="page-title">Journal</Heading>
            <Empty icon={NotebookPen} title="No journal yet">
              pi-pensieve adds a summary of each Pi session here when the session ends.
            </Empty>
          </>
        )}
      </VStack>
      <VStack as="aside" aria-label="Scratchpad and days" gap={5}>
        <Card>
          <VStack gap={3}>
            <Heading level={2}><PageLink title="Scratchpad" /></Heading>
            <PageBody resource={scratchpad} empty="Nothing on the Scratchpad." />
          </VStack>
        </Card>
        {days.length > 0 && (
          <VStack as="section" gap={2}>
            <Heading level={2}>Days</Heading>
            <List hasDividers edge="flush">
              {days.map((d) => (
                <ListItem key={d} label={d} href={href('journal', { ...params, day: d })} isSelected={d === day} />
              ))}
            </List>
          </VStack>
        )}
      </VStack>
    </Grid>
  );
}

// Keyed by day, so switching days never shows the previous day's page while the next one loads.
function Day({ day }) {
  const entry = useResource(`/pages/${encodeURIComponent(`Journal ${day}`)}`);
  return (
    <>
      <VStack as="header" gap={3}>
        <Heading level={1} id="page-title">{formatDay(day)}</Heading>
        {entry.data && (
          <HStack gap={3} align="center" wrap="wrap">
            <Text type="supporting" color="secondary">
              updated <RelTime iso={entry.data.updated_at} /> by <Text type="code">{entry.data.updated_by}</Text>
            </Text>
            <PageLink title={entry.data.title}>Open page</PageLink>
          </HStack>
        )}
      </VStack>
      <PageBody resource={entry} empty="No journal for this day." newestFirst={isDailyJournal(entry.data)} />
    </>
  );
}

function PageBody({ resource, empty, newestFirst = false }) {
  if (resource.loading) return <Loading variant="article" />;
  if (resource.error) {
    return /cannot find page/i.test(resource.error.message) ? <Empty>{empty}</Empty> : <ErrorNote error={resource.error} onRetry={resource.reload} />;
  }
  if (!resource.data) return null;
  const { title, content, links } = resource.data;
  const missing = new Set(links.filter((l) => !l.exists).map((l) => l.title.toLowerCase()));
  return <Markdown missing={missing} newestFirst={newestFirst}>{withoutTitle(splitFrontmatter(content)[1], title)}</Markdown>;
}
