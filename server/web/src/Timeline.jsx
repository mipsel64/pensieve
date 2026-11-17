import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Badge } from '@astryxdesign/core/Badge';
import { Button } from '@astryxdesign/core/Button';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { Link } from '@astryxdesign/core/Link';
import { List, ListItem } from '@astryxdesign/core/List';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { History, ScrollText } from 'lucide-react';
import { api, query, Unauthorized } from './api.js';
import { href } from './router.js';
import { AuthContext, Empty, ErrorNote, formatNumber, Loading, PageLink, RelTime } from './ui.jsx';

const PAGE = 50;
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

export function Timeline({ params }) {
  const lock = useContext(AuthContext);
  const { author, title } = params;
  const [entries, setEntries] = useState([]);
  const [state, setState] = useState({ loading: true, error: null, done: false });
  const latest = useRef(0);
  const updateFilter = useCallback((field, value) => {
    location.hash = href('timeline', { ...params, [field]: value || undefined });
  }, [params]);

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
    <VStack gap={6}>
      <VStack as="header" gap={1}>
        <Heading level={1}>Timeline</Heading>
        <Text color="secondary">Every write, newest first, with the summary the agent gave.</Text>
      </VStack>

      <Grid columns={{ minWidth: 220, max: 2 }} gap={3}>
        <TimelineFilter field="author" label="Agent" placeholder="All agents" value={author} onFilter={updateFilter} />
        <TimelineFilter field="title" label="Page title" placeholder="All pages" value={title} onFilter={updateFilter} />
      </Grid>

      {state.error && <ErrorNote error={state.error} onRetry={() => load(state.before)} />}
      {!state.loading && !state.error && entries.length === 0 && (
        <Empty icon={ScrollText} title="No writes match" action={params.author || params.title ? { href: href('timeline'), label: 'Clear filters' } : undefined}>
          {params.author || params.title ? 'Try other filters.' : 'Nothing has been written yet.'}
        </Empty>
      )}

      <VStack gap={5}>
        {groups.map((group) => (
          <VStack as="section" key={group.day} aria-label={group.day} gap={2}>
            <Heading level={2}>{group.day}</Heading>
            <List hasDividers edge="flush">
              {group.entries.map((r) => (
                <ListItem
                  key={r.seq}
                  align="start"
                  startContent={<Timestamp value={r.at} format="time" type="code" color="secondary" />}
                  label={
                    <HStack gap={2} align="center" wrap="wrap">
                      <PageLink title={r.title} />
                      <Badge variant="neutral" label={r.rev === 1 ? 'created' : `rev ${r.rev}`} />
                    </HStack>
                  }
                  description={<Text as="p" color={r.summary ? 'primary' : 'secondary'}>{r.summary ?? 'No summary'}</Text>}
                  endContent={
                    <VStack gap={1} align="end">
                      <Link type="code" maxLines={1} href={href('timeline', { ...params, author: r.by })}>{r.by}</Link>
                      <Text type="supporting" color="secondary">{formatNumber(r.bytes)} bytes</Text>
                    </VStack>
                  }
                />
              ))}
            </List>
          </VStack>
        ))}
      </VStack>

      {state.loading && <Loading label="Loading writes" variant={entries.length ? 'inline' : 'list'} />}
      {!state.loading && !state.done && entries.length > 0 && (
        <HStack justify="center">
          <Button label="Older writes" variant="ghost" icon={<Icon icon={History} size="sm" />} onClick={() => load(entries.at(-1).seq)} />
        </HStack>
      )}
      {state.done && entries.length > 0 && (
        <Text as="p" type="supporting" color="secondary" justify="center">
          Start of history · <RelTime iso={entries.at(-1).at} />
        </Text>
      )}
    </VStack>
  );
}

function TimelineFilter({ field, label, placeholder, value, onFilter }) {
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  useEffect(() => {
    if (draft === (value ?? '')) return undefined;
    const timeout = setTimeout(() => onFilter(field, draft), 300);
    return () => clearTimeout(timeout);
  }, [draft, field, value, onFilter]);
  return (
    <TextInput
      type="search"
      enterKeyHint="search"
      label={label}
      placeholder={placeholder}
      value={draft}
      hasClear
      onChange={setDraft}
      onEnter={() => onFilter(field, draft)}
    />
  );
}
