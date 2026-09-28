import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { api, Unauthorized } from './api.js';
import { RouteContext, usePageHref } from './router.js';

export const KINDS = ['topic', 'entity', 'source', 'synthesis', 'runbook', 'incident', 'audit'];
// Muted like the mist, but far enough apart in hue to tell the types apart.
export const KIND_COLORS = {
  topic: '#8fb6dc',
  entity: '#b3a4e0',
  source: '#d9bd86',
  synthesis: '#87cbbd',
  runbook: '#a3c98f',
  incident: '#df9696',
  audit: '#d59fc2',
  untyped: '#8d9797',
  missing: '#5c6868',
};

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

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

export function timeAgo(iso) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000;
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1];
  return Math.abs(seconds) < 45 ? 'just now' : relative.format(Math.round(seconds / size), unit);
}

export function RelTime({ iso }) {
  if (!iso) return <span className="muted">never</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()}>
      {timeAgo(iso)}
    </time>
  );
}

export const formatNumber = (n) => new Intl.NumberFormat().format(n);

export function TypeBadge({ kind }) {
  const name = kind ?? 'untyped';
  return (
    <span className="badge" style={{ '--kind': KIND_COLORS[name] ?? KIND_COLORS.untyped }}>
      {name}
    </span>
  );
}

export function PageLink({ title, missing, children }) {
  const pageHref = usePageHref();
  return (
    <a href={pageHref(title)} className={missing ? 'page-link missing' : 'page-link'} title={missing ? `${title} (no page yet)` : undefined}>
      {children ?? title}
    </a>
  );
}

export function Card({ title, icon: Icon, action, className = '', children }) {
  return (
    <section className={`card ${className}`} aria-label={title}>
      {title && (
        <header className="card-header">
          <h2>
            {Icon && <Icon aria-hidden="true" size={16} />}
            {title}
          </h2>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Loading({ label = 'Loading' }) {
  return (
    <div className="state" role="status">
      <Loader2 className="spin" aria-hidden="true" size={18} />
      {label}…
    </div>
  );
}

export function ErrorNote({ error, onRetry }) {
  if (error instanceof Unauthorized) return null;
  return (
    <div className="state error" role="alert">
      <AlertTriangle aria-hidden="true" size={18} />
      <span>{error.message}</span>
      {onRetry && (
        <button type="button" className="ghost" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ children }) {
  return <p className="state muted">{children}</p>;
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

/** Page Markdown with GFM and working [[links]]; raw HTML is not rendered. `missing` holds lowercased targets. */
export function Markdown({ children, missing = new Set() }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkWikilinks]}
      components={{
        a({ href = '', children }) {
          const title = href.startsWith('#wiki/') ? safeDecode(href.slice(6)) : null;
          if (title !== null) {
            return (
              <PageLink title={title} missing={missing.has(title.toLowerCase())}>
                {children}
              </PageLink>
            );
          }
          const external = /^https?:/i.test(href);
          return (
            <a href={href} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>
              {children}
            </a>
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
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

export function Logo({ size = 28 }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
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
