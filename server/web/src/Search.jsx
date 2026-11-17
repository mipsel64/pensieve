import { useContext, useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowUpRight, Check, Copy, FileText, Layers, ListTree, Sparkles } from 'lucide-react';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { Center } from '@astryxdesign/core/Center';
import { Badge } from '@astryxdesign/core/Badge';
import { ClickableCard } from '@astryxdesign/core/ClickableCard';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent, LayoutFooter } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Tab, TabList } from '@astryxdesign/core/TabList';
import { Heading, Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Token } from '@astryxdesign/core/Token';
import { api, query, Unauthorized } from './api.js';
import { href, usePageHref } from './router.js';
import { AuthContext, Empty, ErrorNote, formatNumber, Loading, Markdown, PageLink, RelTime, TypeBadge } from './ui.jsx';
import { Toggle, useSettings } from './settings.jsx';
import { withoutTitle } from './Page.jsx';

// The server drops everything but letters and digits, so `???` would otherwise list recent pages as matches.
const searchable = (q) => /[\p{L}\p{N}]/u.test(q);

const MODES = [
  ['ask', 'Answer', Sparkles],
  ['keywords', 'Pages', FileText],
];

export function Search({ params }) {
  const { settings } = useSettings();
  const q = (params.q ?? '').trim();
  const mode = (params.mode ?? settings.search.mode) === 'ask' ? 'ask' : 'keywords';
  const rerank = params.jev ? params.jev !== '0' : settings.search.rerank;
  const go = (value, nextMode = mode) => {
    if (value.trim()) location.hash = href('search', { ...params, q: value.trim(), mode: nextMode });
  };

  if (!q) return <SearchHome initialMode={settings.search.mode} onSubmit={go} />;

  return (
    <Layout
      height="fill"
      contentWidth={800}
      padding={4}
      content={
        <LayoutContent>
          <VStack gap={4} width="100%">
            <Heading level={1} wordBreak="break-word">
              {q}
            </Heading>
            <HStack gap={3} align="center" justify="between" wrap="wrap">
              <VStack as="nav" aria-label="Result type">
                <TabList value={mode} onChange={(value) => (location.hash = href('search', { ...params, mode: value }))} hasDivider>
                  {MODES.map(([value, label, ModeIcon]) => (
                    <Tab
                      key={value}
                      value={value}
                      label={label}
                      href={href('search', { ...params, mode: value })}
                      icon={<Icon icon={ModeIcon} size="sm" />}
                    />
                  ))}
                </TabList>
              </VStack>
              {mode === 'keywords' && (
                <Toggle id="thread-rerank" label="Rerank with Jev" checked={rerank} onChange={(v) => (location.hash = href('search', { ...params, jev: v ? '1' : '0' }))} />
              )}
            </HStack>
            <Results q={q} mode={mode} rerank={rerank} params={params} />
          </VStack>
        </LayoutContent>
      }
      footer={
        <LayoutFooter padding={4}>
          <AskBox key={q} initial={q} placeholder="Ask a follow-up or search again" onSubmit={(value) => go(value)} />
        </LayoutFooter>
      }
    />
  );
}

function SearchHome({ initialMode, onSubmit }) {
  const [mode, setMode] = useState(initialMode);
  return (
    <Center width="100%" minHeight="100%" padding={6}>
      <VStack gap={6} hAlign="center" width="100%">
        <VStack gap={2} hAlign="center">
          <Heading level={1} type="display-2" justify="center">
            What would you like to recall?
          </Heading>
        </VStack>
        <VStack width="100%" maxWidth={768}>
          <AskBox big initial="" autoFocus placeholder="Ask memory anything, or look up a page" onSubmit={(value) => onSubmit(value, mode)}>
            <SegmentedControl value={mode} onChange={setMode} label="Show" size="sm">
              {MODES.map(([value, label, ModeIcon]) => (
                <SegmentedControlItem key={value} value={value} label={label} icon={<Icon icon={ModeIcon} size="sm" />} />
              ))}
            </SegmentedControl>
          </AskBox>
        </VStack>
        <Text as="p" type="supporting" color="secondary" justify="center">
          <Text weight="semibold">Answer</Text> shows the passages an agent's recall would get, with their sources. <Text weight="semibold">Pages</Text> ranks whole pages by their words.
        </Text>
      </VStack>
    </Center>
  );
}

function AskBox({ initial, big, autoFocus, placeholder, onSubmit, children }) {
  const [value, setValue] = useState(initial);
  const field = (
    <TextInput
      id="search-q"
      type="search"
      label="Search memory"
      isLabelHidden
      value={value}
      onChange={setValue}
      controlClassName="ask-box-input"
      placeholder={placeholder}
      autoComplete="off"
      enterKeyHint="search"
      hasClear
      hasAutoFocus={autoFocus}
      size={big ? 'lg' : 'md'}
      width="100%"
    />
  );
  const submit = (
    <IconButton label="Search" tooltip="Search" type="submit" variant="primary" icon={<Icon icon={ArrowUp} />} isDisabled={!value.trim()} />
  );
  return (
    <VStack
      as="form"
      role="search"
      width="100%"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <Card width="100%" padding={big ? 3 : 2} elevation="low">
        {big ? (
          <VStack gap={3}>
            {field}
            <HStack gap={2} align="center" justify="between" wrap="wrap">
              {children}
              {submit}
            </HStack>
          </VStack>
        ) : (
          <HStack gap={2} align="center">
            <StackItem size="fill">{field}</StackItem>
            {submit}
          </HStack>
        )}
      </Card>
    </VStack>
  );
}

function Results({ q, mode, rerank, params }) {
  const lock = useContext(AuthContext);
  // Results remember what they answer: for one render after a change, the previous results are still here.
  const key = `${mode}\n${rerank}\n${q}`;
  const [result, setResult] = useState({ loading: false, error: null, data: null, key: null });
  const [attempt, setAttempt] = useState(0);
  const valid = searchable(q);

  useEffect(() => {
    if (!valid) return;
    let current = true;
    const started = performance.now();
    setResult((r) => ({ ...r, loading: true, error: null }));
    const path = mode === 'ask' ? `/recall${query({ q })}` : `/search${query({ q, limit: 30, rerank })}`;
    api(path)
      .then((data) => current && setResult({ loading: false, error: null, data, key, seconds: (performance.now() - started) / 1000 }))
      .catch((error) => {
        if (!current) return;
        if (error instanceof Unauthorized) lock();
        setResult({ loading: false, error, data: null, key });
      });
    return () => {
      current = false;
    };
  }, [q, mode, rerank, key, valid, lock, attempt]);

  if (!valid) return <Text as="p">Type a word or a name to search for.</Text>;
  const fresh = result.key === key && !result.loading;
  return (
    <VStack gap={4} width="100%" aria-busy={result.loading}>
      {result.loading && <Loading label={mode === 'ask' ? 'Recalling' : 'Searching'} variant={mode === 'ask' ? 'cards' : 'list'} />}
      {result.error && fresh && <ErrorNote error={result.error} onRetry={() => setAttempt((n) => n + 1)} />}
      {result.data && fresh && (mode === 'ask' ? <Answer data={result.data} took={result.seconds} /> : <Hits data={result.data} took={result.seconds} q={q} params={params} />)}
    </VStack>
  );
}

const seconds = (s) => `${s.toFixed(2)} seconds`;
const plural = (n, word) => `${formatNumber(n)} ${n === 1 ? word : `${word}s`}`;

function Answer({ data, took }) {
  const pageHref = usePageHref();
  // Sources are numbered by the first passage that cites them, like footnotes.
  const sources = useMemo(() => {
    const byTitle = new Map();
    for (const p of data.passages) {
      const source = byTitle.get(p.title) ?? { title: p.title, kind: p.kind, n: byTitle.size + 1, passages: 0 };
      source.passages++;
      byTitle.set(p.title, source);
    }
    return byTitle;
  }, [data]);

  return (
    <VStack gap={6} width="100%">
      {data.passages.length ? (
        <>
          <Sources sources={[...sources.values()]} />
          <Section variant="transparent" padding={0} aria-labelledby="answer-title">
            <VStack gap={3} width="100%">
              <HStack gap={2} align="center">
                <Icon icon={Sparkles} size="sm" color="secondary" />
                <Heading level={2} id="answer-title">
                  Answer
                </Heading>
              </HStack>
              <Text as="p" type="supporting" color="secondary" role="status">
                What recall gives an agent: {plural(data.passages.length, 'passage')} · about {formatNumber(data.tokens)} tokens · ranked by{' '}
                {data.reranked ? 'Jev relevance' : 'BM25'} ({seconds(took)})
              </Text>
              <List hasDividers edge="flush" density="spacious">
                {data.passages.map((p) => (
                  <ListItem
                    key={`${p.title}:${p.ord}`}
                    align="start"
                    label={
                      <VStack gap={2} width="100%">
                        <HStack gap={1} align="center" wrap="wrap">
                          <Token label={p.title} size="sm" href={pageHref(p.title)} />
                          {p.heading && <Text type="supporting" color="secondary">› {p.heading}</Text>}
                          {data.reranked && <Text type="code" color="secondary">· relevance {p.score.toFixed(2)}</Text>}
                        </HStack>
                        <Markdown>{withoutTitle(p.text, p.title)}</Markdown>
                      </VStack>
                    }
                  />
                ))}
              </List>
              <HStack><CopyButton key={asMarkdown(data.passages)} text={asMarkdown(data.passages)} /></HStack>
            </VStack>
          </Section>
        </>
      ) : (
        <Empty title="Nothing in memory answers this" icon={Sparkles}>
          Try other words, or look for a page title under Pages.
        </Empty>
      )}
      {data.leads.length > 0 && (
        <Section variant="transparent" padding={0} aria-labelledby="related-title">
          <VStack gap={3} width="100%">
            <HStack gap={2} align="center">
              <Icon icon={ListTree} size="sm" color="secondary" />
              <Heading level={2} id="related-title">
                Related pages
              </Heading>
            </HStack>
            <List hasDividers edge="flush">
              {data.leads.map((title) => (
                <ListItem key={title} href={pageHref(title)} label={title} endContent={<Icon icon={ArrowUpRight} size="sm" color="secondary" />} />
              ))}
            </List>
          </VStack>
        </Section>
      )}
    </VStack>
  );
}

function Sources({ sources }) {
  const [all, setAll] = useState(false);
  const pageHref = usePageHref();
  const folded = !all && sources.length > 4;
  const shown = folded ? sources.slice(0, 3) : sources;
  return (
    <Section variant="transparent" padding={0} aria-labelledby="sources-title">
      <VStack gap={3} width="100%">
        <HStack gap={2} align="center">
          <Icon icon={Layers} size="sm" color="secondary" />
          <Heading level={2} id="sources-title">
            Sources
          </Heading>
          <Text type="supporting" color="secondary">
            {sources.length}
          </Text>
        </HStack>
        <Grid columns={{ minWidth: 140, max: 4 }} gap={2} width="100%">
          {shown.map((source) => (
            <ClickableCard key={source.title} label={`Open ${source.title}`} href={pageHref(source.title)} padding={3} height="100%">
              <VStack gap={3} justify="between" height="100%">
                <Text weight="medium" maxLines={2} wordBreak="break-word">
                  {source.title}
                </Text>
                <HStack gap={2} align="end" justify="between" wrap="wrap">
                  <VStack gap={1}>
                    <TypeBadge kind={source.kind} />
                    <Text type="supporting" color="secondary">
                      {plural(source.passages, 'passage')}
                    </Text>
                  </VStack>
                  <Badge label={source.n} />
                </HStack>
              </VStack>
            </ClickableCard>
          ))}
          {folded && (
            <ClickableCard label={`Show ${sources.length - 3} more sources`} onClick={() => setAll(true)} padding={3} height="100%">
              <VStack gap={2} justify="center" height="100%">
                <Text weight="medium">+{sources.length - 3} more</Text>
                <Text type="supporting" color="secondary">
                  Show all sources
                </Text>
              </VStack>
            </ClickableCard>
          )}
        </Grid>
      </VStack>
    </Section>
  );
}

const asMarkdown = (passages) => passages.map((p) => `## ${p.title}${p.heading ? ` › ${p.heading}` : ''}\n\n${p.text.trim()}`).join('\n\n');

function CopyButton({ text }) {
  const [state, setState] = useState('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy passages';
  return (
    <Button
      variant="ghost"
      size="sm"
      label={label}
      icon={<Icon icon={state === 'copied' ? Check : Copy} size="sm" />}
      // The clipboard API is missing outside HTTPS and localhost; that should read as a failed copy, not an error.
      onClick={() =>
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => setState('copied'),
            () => setState('failed'),
          )
      }
    >
      <Text aria-live="polite">{label}</Text>
    </Button>
  );
}

function Hits({ data, took, q, params }) {
  if (!data.hits.length) {
    return (
      <Empty
        title={`No pages match ${q}`}
        icon={FileText}
        action={{ href: href('search', { ...params, mode: 'ask' }), label: 'See the answer' }}
      >
        Try different or fewer words. Recall matches sections rather than whole pages.
      </Empty>
    );
  }
  return (
    <VStack gap={4} width="100%">
      <Text as="p" type="supporting" color="secondary" role="status">
        {plural(data.hits.length, 'page')} · ranked by {data.reranked ? 'Jev relevance' : 'BM25'} ({seconds(took)})
      </Text>
      <List hasDividers edge="flush" density="spacious">
        {data.hits.map((hit) => (
          <ListItem
            key={hit.title}
            align="start"
            label={
              <VStack gap={2} width="100%">
                <HStack gap={2} align="center" wrap="wrap">
                  <TypeBadge kind={hit.kind} />
                  <Text type="supporting" color="secondary">
                    memory › rev {hit.rev}
                    {data.reranked && <> · relevance {hit.score.toFixed(2)}</>}
                  </Text>
                </HStack>
                <Heading level={3}>
                  <PageLink title={hit.title} />
                </Heading>
                <Text as="p" wordBreak="break-word">
                  <Text color="secondary">
                    <RelTime iso={hit.updated_at} /> —{' '}
                  </Text>
                  {hit.snippet.split(/[«»]/).map((part, i) => (i % 2 ? <Text key={i} weight="semibold">{part}</Text> : part))}
                </Text>
              </VStack>
            }
          />
        ))}
      </List>
      {data.hits.length === 30 && <Text type="supporting" color="secondary">Showing the 30 best matches. Add words to narrow the search.</Text>}
    </VStack>
  );
}
