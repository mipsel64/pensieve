import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs';
import { Badge } from '@astryxdesign/core/Badge';
import { Drawer, DrawerHeader } from '@astryxdesign/core/Drawer';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { List, ListItem } from '@astryxdesign/core/List';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Copy, FileQuestion, History, Link2, Maximize2, Network } from 'lucide-react';
import { query } from './api.js';
import { href, RouteContext } from './router.js';
import { isDailyJournal } from './journal.js';
import { PageOutline, ReadingProgress, scrollToHeading, useScrollContainer } from './Toc.jsx';
import { useCopy } from './Toast.jsx';
import { readingMinutes } from './toc.js';
import { Empty, ErrorNote, Loading, Markdown, PageLink, RelTime, splitFrontmatter, TypeBadge, useResource } from './ui.jsx';
import './Page.css';

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
const DEFAULT_WIDTH = 640;

function storedDrawerWidth() {
  try {
    const saved = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(saved) && saved >= MIN_WIDTH ? saved : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

export function PageDrawer({ title, closeHref }) {
  const p = usePage(title);
  const [width] = useState(storedDrawerWidth);
  const name = p.data?.title ?? title;
  const onOpenChange = useCallback(
    (open) => {
      if (!open) location.hash = closeHref;
    },
    [closeHref],
  );

  return (
    <Drawer isOpen hasScrim={false} side="end" width={width} label={name} onOpenChange={onOpenChange}>
      <Layout
        header={
          <DrawerHeader
            title={
              <Text type="inherit" data-autofocus tabIndex={-1}>
                {name}
              </Text>
            }
            subtitle={p.data && <PageMeta data={p.data} minutes={p.minutes} />}
            endContent={
              <HStack gap={1} align="center">
                <IconButton
                  label="Open as full page"
                  tooltip="Open as full page"
                  variant="ghost"
                  href={href('page', { title: name })}
                  icon={<Icon icon={Maximize2} />}
                />
                {p.data && <PageMenu title={p.data.title} />}
              </HStack>
            }
            onOpenChange={onOpenChange}
          />
        }
        content={
          <LayoutContent>
            <VStack gap={6}>
              <PageStatus page={p.page} title={title} />
              {p.data && (
                <>
                  <Properties fields={p.fields} missing={p.missing} />
                  <VStack as="article" aria-label="Page content">
                    <Markdown missing={p.missing} newestFirst={isDailyJournal(p.data)}>
                      {p.body}
                    </Markdown>
                  </VStack>
                  <LinkLists data={p.data} />
                  <RecentChanges changes={p.changes} />
                </>
              )}
            </VStack>
          </LayoutContent>
        }
      />
    </Drawer>
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
  const newestFirst = p.data ? isDailyJournal(p.data) : false;
  const scrollContainer = useScrollContainer(prose, p.body);
  const sectionHref = useCallback((id) => href('page', { title: name, section: id }), [name]);
  const copySection = useCallback((id) => copy(new URL(sectionHref(id), location.href).href, 'Link to section copied'), [copy, sectionHref]);
  const showSection = useCallback((id) => history.replaceState(null, '', sectionHref(id)), [sectionHref]);

  useEffect(() => {
    heading.current?.focus();
  }, [title]);

  useEffect(() => {
    if (p.data && params.section) scrollToHeading(prose, params.section);
  }, [p.data, params.section]);

  return (
    <>
      <ReadingProgress scrollContainerRef={scrollContainer} content={p.body} />
      <VStack as="article" className="page-view" gap={0} aria-labelledby="page-title">
        <Layout
          height="auto"
          padding={0}
          contentWidth="47.5rem"
          content={
            <LayoutContent isScrollable={false} padding={0}>
              <VStack gap={6}>
                <VStack as="header" gap={3}>
                  <HStack justify="between" align="center" wrap="wrap" gap={2}>
                    <Breadcrumbs variant="supporting">
                      <BreadcrumbItem href={href('search')}>Memory</BreadcrumbItem>
                      {p.data && (
                        <BreadcrumbItem isCurrent>
                          <TypeBadge kind={p.data.kind} />
                        </BreadcrumbItem>
                      )}
                    </Breadcrumbs>
                    {p.data && <PageMenu title={p.data.title} />}
                  </HStack>
                  <Heading level={1} id="page-title" tabIndex={-1} ref={heading} textWrap="balance">
                    {name}
                  </Heading>
                  {p.data && <PageMeta data={p.data} minutes={p.minutes} badge={false} />}
                </VStack>
                <PageStatus page={p.page} title={title} />
                {p.data && (
                  <>
                    <Properties fields={p.fields} missing={p.missing} />
                    <VStack ref={prose} gap={0}>
                      <Markdown missing={p.missing} newestFirst={newestFirst} onAnchor={copySection}>
                        {p.body}
                      </Markdown>
                    </VStack>
                  </>
                )}
              </VStack>
            </LayoutContent>
          }
        />
        {p.data && (
          <VStack as="aside" className="page-sidebar" gap={6} aria-label="Page details">
            <PageOutline body={p.body} newestFirst={newestFirst} scrollContainerRef={scrollContainer} onNavigate={showSection} />
            <LinkLists data={p.data} as={2} />
            <RecentChanges changes={p.changes} as={2} />
          </VStack>
        )}
      </VStack>
    </>
  );
}

function PageMeta({ data, minutes, badge = true }) {
  return (
    <Text type="supporting" color="secondary">
      {badge && (
        <>
          <TypeBadge kind={data.kind} />{' '}
        </>
      )}
      {data.confidence && <>confidence {data.confidence} · </>}
      rev {data.rev} · updated <RelTime iso={data.updated_at} /> by <Text type="code" color="inherit">{data.updated_by}</Text> · {minutes} min read · visited{' '}
      <RelTime iso={data.visited_at} />
    </Text>
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
  const items = [
    { label: 'History', icon: History, href: href('timeline', { title }) },
    { label: 'Show in graph', icon: Network, href: href('graph', { focus: title, page: title }) },
    { label: 'Copy link', icon: Link2, onClick: () => copy(new URL(href('page', { title }), location.href).href, 'Link copied') },
    { label: 'Copy title', icon: Copy, onClick: () => copy(title, 'Title copied') },
  ];
  return <MoreMenu label="Page actions" items={items} alignment="end" presentation="adaptive" variant="ghost" size="sm" />;
}

function Properties({ fields, missing }) {
  if (!fields.length) return null;
  return (
    <MetadataList columns="multi" label={{ position: 'top' }}>
      {fields.map(([key, value]) => (
        <MetadataListItem key={key} label={key}>
          <Markdown missing={missing}>{value}</Markdown>
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}

function LinkLists({ data, as = 3 }) {
  const ids = useId();
  const lists = [
    ['Backlinks', data.backlinks.map((title) => ({ title, missing: false })), 'No other page links here yet.'],
    ['Links', data.links.map((link) => ({ title: link.title, missing: !link.exists })), 'This page links to nothing.'],
  ];
  return (
    <Grid columns={{ minWidth: 240, max: 2 }} gap={4}>
      {lists.map(([label, items, none]) => (
        <VStack key={label} as="section" gap={2} aria-labelledby={`${ids}-${label}`}>
          <HStack gap={2} align="center">
            <Heading level={as} id={`${ids}-${label}`}>
              {label}
            </Heading>
            <Badge label={items.length} />
          </HStack>
          {items.length ? (
            <List density="compact" edge="flush">
              {items.map((item) => (
                <ListItem key={item.title} label={<PageLink title={item.title} missing={item.missing} />} />
              ))}
            </List>
          ) : (
            <Text type="supporting" color="secondary">
              {none}
            </Text>
          )}
        </VStack>
      ))}
    </Grid>
  );
}

function RecentChanges({ changes, as = 3 }) {
  if (changes.error) return <ErrorNote error={changes.error} onRetry={changes.reload} />;
  if (!changes.data?.length) return null;
  return (
    <VStack as="section" gap={2}>
      <Heading level={as}>Recent changes</Heading>
      <List density="compact" edge="flush">
        {changes.data.map((change) => (
          <ListItem
            key={change.seq}
            align="start"
            label={change.summary ?? <Text color="secondary">No summary</Text>}
            description={
              <Text type="supporting" color="secondary">
                <Text type="code" color="inherit">rev {change.rev}</Text> · {change.by} · <RelTime iso={change.at} />
              </Text>
            }
          />
        ))}
      </List>
    </VStack>
  );
}
