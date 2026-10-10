/** Anchor id for a heading's text: lowercase words joined by hyphens, accents and punctuation dropped. */
export function slugify(text) {
  return (
    text
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-') || 'section'
  );
}

/** Returns slugs that stay unique within one document: the second "Notes" becomes "notes-1". */
export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
}

/** Plain text of a Markdown syntax tree node, as the browser shows it. */
export function nodeText(node) {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value;
  return (node.children ?? []).map(nodeText).join('');
}

/** Prefix of generated heading ids, so they never equal a fixed id such as `page-title`. */
export const HEADING_ID_PREFIX = 'sec-';

/** Remark plugin: gives every heading an id, so the table of contents and copied links can point at it. */
export function remarkHeadingIds() {
  return (tree) => {
    const slug = createSlugger();
    const walk = (node) => {
      if (node.type === 'heading') {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: HEADING_ID_PREFIX + slug(nodeText(node)) } };
        return;
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

/** Table of contents entries from the rendered headings `[{ id, text, level }]`; empty ones are dropped. */
export function buildToc(headings, levels = [2, 3]) {
  return headings.filter((h) => levels.includes(h.level) && h.id && h.text.trim()).map((h) => ({ id: h.id, text: h.text.trim(), level: h.level }));
}

/** Index of the last heading whose top has passed `offset`, or -1 before the first one. At the end of the page the last heading counts, since it may never reach `offset`. */
export function activeHeadingIndex(tops, offset, atEnd = false) {
  if (atEnd && tops.length) return tops.length - 1;
  let active = -1;
  for (let i = 0; i < tops.length; i++) if (tops[i] <= offset) active = i;
  return active;
}

/** Share of the scrollable length already scrolled, 0 to 1. */
export function readingProgress(scrollTop, scrollHeight, clientHeight) {
  const range = scrollHeight - clientHeight;
  return range > 0 ? Math.min(1, Math.max(0, scrollTop / range)) : 0;
}

/** Whole minutes to read `text` at 220 words a minute; at least one. */
export function readingMinutes(text) {
  const words = text.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(words / 220));
}
