import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { CornerDownLeft, FileText, Search } from 'lucide-react';
import { query } from './api.js';
import { fuzzyFilter, fuzzyMatch, highlightRuns } from './fuzzy.js';
import { Modal } from './Overlay.jsx';
import { pushRecent, readRecent, writeRecent } from './recent.js';
import { href } from './router.js';
import { TypeBadge, useResource } from './ui.jsx';

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

// The server drops everything but letters and digits, so punctuation alone would list recent pages as matches.
const searchable = (q) => /[\p{L}\p{N}]/u.test(q);

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function Highlighted({ text, indices }) {
  if (!indices.length) return text;
  return highlightRuns(text, indices).map((run, i) => (run.hit ? <mark key={i}>{run.text}</mark> : run.text));
}

const pageItem = (hit, indices = []) => ({ key: `page:${hit.title}`, type: 'page', id: hit.title, label: hit.title, kind: hit.kind ?? null, icon: FileText, indices });
const commandItem = (command, indices = []) => ({ key: `command:${command.id}`, type: 'command', id: command.id, label: command.label, hint: command.hint, icon: command.icon, indices, run: command.run });

/**
 * Command palette: pages (recently written ones filtered here, the rest looked up on the server after a pause), views, appearance and help.
 * `commands` is `[{ id, group, label, keywords, hint, icon, run }]`.
 */
export function Palette({ commands, onClose }) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(() => readRecent(storage()));
  const list = useRef(null);
  const listId = useId();
  const term = text.trim();
  const settled = useDebounced(term, 220);

  const index = useResource('/search?q=&limit=50&rerank=false');
  const lookup = useResource(searchable(settled) ? `/search${query({ q: settled, limit: 8, rerank: false })}` : null);
  const waiting = searchable(term) && (term !== settled || lookup.loading);

  const groups = useMemo(() => {
    const indexHits = index.data?.hits ?? [];
    const out = [];
    const add = (title, items) => items.length && out.push({ title, items });
    if (!term) {
      const known = new Map(commands.map((c) => [c.id, c]));
      const seen = new Set();
      const recents = recent
        .map((e) => (e.type === 'page' ? pageItem(indexHits.find((h) => h.title === e.id) ?? { title: e.id }) : known.has(e.id) ? commandItem(known.get(e.id)) : null))
        .filter(Boolean);
      recents.forEach((r) => seen.add(r.key));
      add('Recent', recents.slice(0, 5));
      add('Recently written', indexHits.map((h) => pageItem(h)).filter((p) => !seen.has(p.key)).slice(0, 4));
      for (const title of ['Go to', 'Appearance', 'Help']) add(title, commands.filter((c) => c.group === title).map((c) => commandItem(c)));
      return out;
    }
    const byTitle = fuzzyFilter(indexHits, term, (h) => h.title, { minPerChar: 2 }).slice(0, 6);
    const pages = byTitle.map((r) => pageItem(r.item, r.indices));
    const seen = new Set(pages.map((p) => p.key));
    const found = searchable(term) && term === settled ? (lookup.data?.hits ?? []) : [];
    add('Pages', [...pages, ...found.map((h) => pageItem(h)).filter((p) => !seen.has(p.key))].slice(0, 9));
    const matched = fuzzyFilter(commands, term, (c) => `${c.label} ${c.keywords ?? ''}`, { minPerChar: 2 }).slice(0, 6);
    add('Commands', matched.map((r) => commandItem(r.item, fuzzyMatch(term, r.item.label)?.indices ?? [])));
    if (searchable(term)) add('Search', [{ key: 'search', type: 'search', id: term, label: `Search memory for “${term}”`, icon: Search, indices: [] }]);
    return out;
  }, [term, settled, commands, recent, index.data, lookup.data]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = Math.min(active, Math.max(flat.length - 1, 0));
  const activeId = flat.length ? `${listId}-${current}` : undefined;

  useEffect(() => {
    list.current?.querySelector(`[id="${activeId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const choose = (item) => {
    if (item.type !== 'search') {
      const next = pushRecent(recent, { type: item.type, id: item.id });
      writeRecent(storage(), next);
      setRecent(next);
    }
    onClose();
    if (item.type === 'page') location.hash = href('page', { title: item.id });
    else if (item.type === 'search') location.hash = href('search', { q: item.id, mode: 'keywords' });
    else item.run();
  };

  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length) setActive((current + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (event.key === 'Enter' && flat[current]) {
      event.preventDefault();
      choose(flat[current]);
    }
  };

  let position = -1;
  return (
    <Modal label="Command palette" onClose={onClose} className="palette">
      <div className="palette-input">
        <Search size={16} aria-hidden="true" />
        <input
          data-autofocus
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-autocomplete="list"
          aria-label="Search pages and commands"
          placeholder="Search pages, commands"
          autoComplete="off"
          spellCheck="false"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {waiting && <span className="palette-busy" aria-hidden="true" />}
      </div>
      <div ref={list} id={listId} className="palette-list" role="listbox" aria-label="Results" aria-busy={waiting}>
        {groups.map((group) => (
          <div key={group.title} role="group" aria-label={group.title} className="palette-group">
            <p className="palette-heading" aria-hidden="true">
              {group.title}
            </p>
            {group.items.map((item) => {
              position++;
              const at = position;
              const Icon = item.icon;
              return (
                <div
                  key={item.key}
                  id={`${listId}-${at}`}
                  role="option"
                  aria-selected={at === current}
                  className="palette-item"
                  onMouseMove={() => at !== active && setActive(at)}
                  onClick={() => choose(item)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="palette-label">
                    <Highlighted text={item.label} indices={item.indices} />
                  </span>
                  {item.type === 'page' && item.kind && <TypeBadge kind={item.kind} />}
                  {item.hint && <kbd>{item.hint}</kbd>}
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && (
          <p className="palette-empty" role="status">
            {waiting || index.loading ? 'Searching…' : index.error ? `Couldn’t load pages: ${index.error.message}` : 'No pages or commands match.'}
          </p>
        )}
      </div>
      <footer className="palette-foot" aria-hidden="true">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>
            <CornerDownLeft size={11} />
          </kbd>{' '}
          open
        </span>
        <span>
          <kbd>esc</kbd> close
        </span>
      </footer>
    </Modal>
  );
}
