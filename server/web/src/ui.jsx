import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card as AstryxCard } from '@astryxdesign/core/Card';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Grid } from '@astryxdesign/core/Grid';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Link } from '@astryxdesign/core/Link';
import { Markdown as AstryxMarkdown } from '@astryxdesign/core/Markdown';
import { createMarkdownPlugin } from '@astryxdesign/core/Markdown/plugins';
import { createMarkdownRemarkTransform } from '@astryxdesign/core/Markdown/remark';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { Token } from '@astryxdesign/core/Token';
import { Link2, RefreshCw } from 'lucide-react';
import { remarkNewestFirst } from './journal.js';
import { api, Unauthorized } from './api.js';
import { RouteContext, usePageHref } from './router.js';

export const KINDS = ['topic', 'entity', 'source', 'synthesis', 'runbook', 'incident', 'audit', 'journal'];
/** Astryx palette color of each page type: Token colors, and the graph's node colors through --color-text-<color>. */
export const KIND_PALETTE = {
  topic: 'blue',
  entity: 'green',
  source: 'purple',
  synthesis: 'teal',
  runbook: 'yellow',
  incident: 'red',
  audit: 'orange',
  journal: 'pink',
  untyped: 'gray',
  missing: 'gray',
};
// Values are CSS variables, so they follow the theme; the canvas reads them with cssColor.
export const KIND_COLORS = Object.fromEntries(Object.entries(KIND_PALETTE).map(([kind, color]) => [kind, `var(--color-text-${color})`]));

export const AuthContext = createContext(() => {});

/** GET `path` (null skips), re-fetching when it changes. A 401 sends the app back to the login screen. */
export function useResource(path) {
  const lock = useContext(AuthContext);
  const [state, setState] = useState({ data: null, error: null, loading: path !== null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (path === null) return;
    let current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api(path)
      .then((data) => current && setState({ data, error: null, loading: false }))
      .catch((error) => {
        if (!current) return;
        if (error instanceof Unauthorized) lock();
        setState({ data: null, error, loading: false });
      });
    return () => {
      current = false;
    };
  }, [path, nonce, lock]);
  return { ...state, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/** `/stats`, refreshed when the page drawer closes, since reading a page records a visit. */
export function useStats() {
  const stats = useResource('/stats');
  const open = Boolean(useContext(RouteContext).params.page);
  const wasOpen = useRef(open);
  const { reload } = stats;
  useEffect(() => {
    if (wasOpen.current && !open) reload();
    wasOpen.current = open;
  }, [open, reload]);
  return stats;
}

/** Relative time ("3 hours ago") with the full time on hover; it takes the surrounding text style. */
export function RelTime({ iso }) {
  if (!iso) return <Text type="inherit" color="secondary">never</Text>;
  return <Timestamp value={iso} format="relative" type="inherit" color="inherit" />;
}

export const formatNumber = (n) => new Intl.NumberFormat().format(n);

export function TypeBadge({ kind }) {
  const name = kind ?? 'untyped';
  return <Token label={name} size="sm" color={KIND_PALETTE[name] ?? KIND_PALETTE.untyped} />;
}

export function PageLink({ title, missing, children }) {
  const pageHref = usePageHref();
  return (
    <Link href={pageHref(title)} type="inherit" color={missing ? 'secondary' : 'accent'} tooltip={missing ? `${title} (no page yet)` : undefined}>
      {children ?? title}
    </Link>
  );
}

/** A dashboard widget: a titled Card with an optional `action` at the end of the title row. */
export function Card({ title, icon, action, children }) {
  return (
    <AstryxCard>
      <VStack gap={3}>
        {title && (
          <HStack gap={2} align="center" justify="between">
            <HStack gap={2} align="center">
              {icon && <Icon icon={icon} size="sm" color="secondary" />}
              <Heading level={2}>{title}</Heading>
            </HStack>
            {action}
          </HStack>
        )}
        {children}
      </VStack>
    </AstryxCard>
  );
}

const lines = (widths, height = 14) => widths.map((width, i) => <Skeleton key={i} width={width} height={height} index={i} />);

const ARTICLE_SKELETON = (
  <VStack gap={2}>
    <HStack gap={2}>{lines([64, 72, 56], 22)}</HStack>
    {lines(['100%', '96%', '88%', '100%', '62%'])}
    <Skeleton width="38%" height={20} />
    {lines(['100%', '92%', '70%'])}
  </VStack>
);

const SKELETONS = {
  // The page header already shows the title, so `article` leaves out the title bar.
  article: ARTICLE_SKELETON,
  page: (
    <VStack gap={3}>
      <Skeleton width="55%" height={28} />
      {ARTICLE_SKELETON}
    </VStack>
  ),
  list: (
    <VStack gap={3}>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <HStack key={i} gap={3} align="center">
          <Skeleton width={10} height={10} radius="rounded" index={i} />
          <VStack gap={1} width="100%">
            <Skeleton width={`${70 - i * 6}%`} height={14} index={i} />
            <Skeleton width="40%" height={11} index={i} />
          </VStack>
        </HStack>
      ))}
    </VStack>
  ),
  cards: (
    <VStack gap={4}>
      <Grid columns={{ minWidth: 160 }} gap={4}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={84} index={i} />
        ))}
      </Grid>
      <Grid columns={{ minWidth: 320 }} gap={4}>
        <Skeleton height={220} />
        <Skeleton height={220} index={1} />
      </Grid>
    </VStack>
  ),
};

/** Shown while data loads. `variant` picks a placeholder shaped like the content: inline, article, page, list or cards. */
export function Loading({ label = 'Loading', variant = 'inline' }) {
  if (variant === 'inline') {
    return (
      <HStack gap={2} align="center" padding={4} role="status">
        <Spinner size="sm" aria-label={label} />
        <Text color="secondary">{label}…</Text>
      </HStack>
    );
  }
  return (
    <VStack role="status" aria-busy="true" aria-label={label}>
      {SKELETONS[variant]}
    </VStack>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (error instanceof Unauthorized) return null;
  return (
    <Banner
      status="error"
      title="Something went wrong"
      description={error.message}
      endContent={onRetry && <Button label="Retry" size="sm" icon={<Icon icon={RefreshCw} />} onClick={onRetry} />}
    />
  );
}

/** Nothing to show. With a `title` it becomes an EmptyState: icon, title, hint (children, a string) and one `action` `{ href, label }`. */
export function Empty({ children, title, icon, action }) {
  if (!title) {
    return (
      <Text as="p" color="secondary">
        {children}
      </Text>
    );
  }
  return (
    <EmptyState
      title={title}
      description={children}
      icon={icon && <Icon icon={icon} size="lg" color="secondary" />}
      actions={action && <Button label={action.label} href={action.href} />}
    />
  );
}

/** Splits `[[Target#heading|alias]]` into its target page and display text. */
export function splitWikilink(inner) {
  const [left, ...alias] = inner.split('|');
  const target = left.split('#')[0].trim().replace(/\\$/, '').replace(/\.md$/, '');
  return [target, alias.length ? alias.join('|').trim() : left.trim()];
}

const WIKILINK = /\[\[([^\]\n]+?)\]\]/g;

// Rewrites [[links]] in text nodes into links; code and inline code are separate node types, so they stay literal.
function remarkWikilinks() {
  const walk = (node) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      // Inside a link, a rewritten [[link]] would nest anchors.
      if (child.type === 'link' || child.type === 'linkReference') return [child];
      if (child.type !== 'text') {
        walk(child);
        return [child];
      }
      const parts = [];
      let last = 0;
      for (const match of child.value.matchAll(WIKILINK)) {
        const [target, label] = splitWikilink(match[1]);
        if (!target) continue;
        if (match.index > last) parts.push({ type: 'text', value: child.value.slice(last, match.index) });
        parts.push({ type: 'link', url: `#wiki/${encodeURIComponent(target)}`, children: [{ type: 'text', value: label }] });
        last = match.index + match[0].length;
      }
      if (!parts.length) return [child];
      if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) });
      return parts;
    });
  };
  return walk;
}

const WIKILINKS = createMarkdownPlugin({ name: 'wikilinks', apiVersion: 1, transform: createMarkdownRemarkTransform(remarkWikilinks) });
const NEWEST_FIRST = createMarkdownPlugin({ name: 'newest-first', apiVersion: 1, transform: createMarkdownRemarkTransform(remarkNewestFirst) });
const PLAIN_PLUGINS = [WIKILINKS];
const JOURNAL_PLUGINS = [WIKILINKS, NEWEST_FIRST];

/** The plugins <Markdown> renders with; pass the same list to useOutlineFromMarkdown so outline ids match the headings. */
export const markdownPlugins = (newestFirst = false) => (newestFirst ? JOURNAL_PLUGINS : PLAIN_PLUGINS);

const EMPTY_SET = new Set();

/**
 * Page Markdown (Astryx Markdown: GFM, no raw HTML) with working [[links]]. `missing` holds lowercased targets.
 * `onAnchor(id)` adds a copy-link button to headings; ids are Astryx's, the same ones useOutlineFromMarkdown returns.
 */
export function Markdown({ children, missing = EMPTY_SET, newestFirst = false, onAnchor }) {
  const components = useMemo(
    () => ({
      link({ href = '', children }) {
        const title = href.startsWith('#wiki/') ? safeDecode(href.slice(6)) : null;
        if (title !== null) {
          return (
            <PageLink title={title} missing={missing.has(title.toLowerCase())}>
              {children}
            </PageLink>
          );
        }
        return (
          <Link href={href} type="inherit" isExternalLink={/^https?:/i.test(href)}>
            {children}
          </Link>
        );
      },
      ...(onAnchor && {
        heading({ level, id, children }) {
          return (
            <Heading level={level} id={id}>
              {children}
              {id && <IconButton label="Copy link to section" size="sm" variant="ghost" icon={<Icon icon={Link2} />} onClick={() => onAnchor(id)} />}
            </Heading>
          );
        },
      }),
    }),
    [missing, onAnchor],
  );
  return (
    <AstryxMarkdown plugins={markdownPlugins(newestFirst)} components={components} autolink="gfm">
      {children}
    </AstryxMarkdown>
  );
}

// Agent-written Markdown can hold any `#wiki/` link, and a malformed escape must not crash the render.
function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/** Leading `---` frontmatter as `[key, value]` pairs, and the body after it. */
export function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return [[], content];
  const fields = match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^([\w-]+):\s*(.*)$/))
    .filter(Boolean)
    .map(([, key, value]) => [key, unquoteList(value)]);
  return [fields, content.slice(match[0].length)];
}

// `[a, "b, c"]` → `a, b, c`: YAML flow lists read better as plain text, and `[[links]]` inside still render.
function unquoteList(value) {
  const list = !value.startsWith('[[') && value.match(/^\[(.*)\]$/);
  const items = list ? [...list[1].matchAll(/"([^"]*)"|'([^']*)'|([^,]+)/g)].map((m) => (m[1] ?? m[2] ?? m[3]).trim()) : [value];
  return items
    .map((item) => item.replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .join(', ');
}

/** The Pensieve mark: a basin with mist. It takes the surrounding text color. */
export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M12.8 13.2c-2.4-2.6.2-4.7 2.3-6.4 1.7-1.4 1.3-3.3-.3-4.3M18.6 13.4c1.7-2-.1-3.6 1.5-5.4.9-1 2.1-1.3 3.1-1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
      <ellipse cx="16" cy="16" rx="12.5" ry="3.2" fill="currentColor" />
      <path d="M3.5 16.6C4.6 22.7 9.8 27 16 27s11.4-4.3 12.5-10.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.7" />
    </svg>
  );
}
