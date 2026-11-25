import { useCallback, useContext, useEffect, useId, useMemo, useRef } from 'react';
import { Drawer, DrawerHeader } from '@astryxdesign/core/Drawer';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Layout, LayoutContent } from '@astryxdesign/core/Layout';
import { MetadataList, MetadataListItem } from '@astryxdesign/core/MetadataList';
import { MoreMenu } from '@astryxdesign/core/MoreMenu';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';
import { Copy, History, Link2, Maximize2, Network } from 'lucide-react';
import { query } from './api.js';
import { href, RouteContext } from './router.js';
import { isDailyJournal } from './journal.js';
import { PageOutline, ReadingProgress, scrollToHeading, useScrollContainer } from './Toc.jsx';
import { useCopy } from './Toast.jsx';
import { readingMinutes } from './toc.js';
import { ErrorNote, Markdown, PageLink, RelTime, splitFrontmatter, useResource } from './ui.jsx';
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

export function PageDrawer({ title, closeHref }) {
  const p = usePage(title);
  const name = p.data?.title ?? title;
  const onOpenChange = useCallback(
    (open) => {
      if (!open) location.hash = closeHref;
    },
    [closeHref],
  );

  return (
    <Drawer isOpen hasScrim={false} side="end" width="40rem" label={name} onOpenChange={onOpenChange}>
      <Layout
        header={
          <DrawerHeader
            className="page-drawer-header"
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
          <LayoutContent className="page-drawer-content">
            <VStack gap={4}>
              <PageStatus page={p.page} title={title} />
              {p.data && (
                <>
                  <Properties fields={p.fields} missing={p.missing} />
                  <VStack as="article" aria-label="Page content" className="page-prose">
                    <Markdown missing={p.missing} newestFirst={isDailyJournal(p.data)}>
                      {p.body}
                    </Markdown>
                  </VStack>
                  <LinkLists data={p.data} heading="h3" />
                  <RecentChanges changes={p.changes} heading="h3" />
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
      <article className="page-view" aria-labelledby="page-title">
        <VStack gap={4}>
          <header className="page-header">
            <HStack justify="between" align="start" gap={2}>
              <h1 id="page-title" tabIndex={-1} ref={heading}>{name}</h1>
              {p.data && <PageMenu title={p.data.title} />}
            </HStack>
            {p.data && <PageMeta data={p.data} minutes={p.minutes} />}
          </header>
          <PageStatus page={p.page} title={title} />
          {p.data && (
            <>
              <Properties fields={p.fields} missing={p.missing} />
              <VStack ref={prose} className="page-prose" gap={0}>
                <Markdown missing={p.missing} newestFirst={newestFirst} onAnchor={copySection}>
                  {p.body}
                </Markdown>
              </VStack>
            </>
          )}
        </VStack>
        {p.data && (
          <VStack as="aside" className="page-sidebar" gap={4} aria-label="Page details">
            <PageOutline body={p.body} newestFirst={newestFirst} scrollContainerRef={scrollContainer} onNavigate={showSection} />
            <LinkLists data={p.data} />
            <RecentChanges changes={p.changes} />
          </VStack>
        )}
      </article>
    </>
  );
}

function PageMeta({ data, minutes }) {
  return (
    <Text className="page-meta" type="supporting" color="secondary">
      {data.kind ?? 'untyped'} ·{' '}
      {data.confidence && <>confidence {data.confidence} · </>}
      rev {data.rev} · updated <RelTime iso={data.updated_at} /> by <Text type="code" color="inherit">{data.updated_by}</Text> · {minutes} min read · visited{' '}
      <RelTime iso={data.visited_at} />
    </Text>
  );
}

function PageStatus({ page, title }) {
  if (page.loading) return <p role="status">Loading page…</p>;
  if (!page.error) return null;
  if (/cannot find page/i.test(page.error.message)) {
    return (
      <p>
        No page called “{title}”.{' '}
        <a href={href('search', { q: title, mode: 'keywords' })}>Search for it</a>.
      </p>
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
    <MetadataList className="page-properties" label={{ position: 'top' }}>
      {fields.map(([key, value]) => (
        <MetadataListItem key={key} label={key}>
          <Markdown missing={missing}>{value}</Markdown>
        </MetadataListItem>
      ))}
    </MetadataList>
  );
}

function LinkLists({ data, heading: Heading = 'h2' }) {
  const ids = useId();
  const lists = [
    ['Backlinks', data.backlinks.map((title) => ({ title, missing: false })), 'No other page links here yet.'],
    ['Links', data.links.map((link) => ({ title: link.title, missing: !link.exists })), 'This page links to nothing.'],
  ];
  return (
    <>
      {lists.map(([label, items, none]) => (
        <section className="page-links" key={label} aria-labelledby={`${ids}-${label}`}>
          <Heading id={`${ids}-${label}`}>{label}</Heading>
          {items.length ? (
            <ul className="page-references">
              {items.map((item) => (
                <li key={item.title}><PageLink title={item.title} missing={item.missing} /></li>
              ))}
            </ul>
          ) : (
            <p className="page-note">{none}</p>
          )}
        </section>
      ))}
    </>
  );
}

function RecentChanges({ changes, heading: Heading = 'h2' }) {
  if (changes.error) return <ErrorNote error={changes.error} onRetry={changes.reload} />;
  if (!changes.data?.length) return null;
  return (
    <section className="page-changes">
      <Heading>Recent changes</Heading>
      <ul>
        {changes.data.map((change) => (
          <li key={change.seq}>
            <p>{change.summary ?? 'No summary'}</p>
            <p className="page-note">
              rev {change.rev} · {change.by} · <RelTime iso={change.at} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
