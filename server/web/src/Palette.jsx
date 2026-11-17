import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CommandPalette, CommandPaletteInput, useCommandPaletteContext } from '@astryxdesign/core/CommandPalette';
import { Icon } from '@astryxdesign/core/Icon';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Text } from '@astryxdesign/core/Text';
import { FileText, Search } from 'lucide-react';
import { api, query, Unauthorized } from './api.js';
import { fuzzyFilter, fuzzyMatch, highlightRuns } from './fuzzy.js';
import { pushRecent, readRecent, writeRecent } from './recent.js';
import { href } from './router.js';
import { AuthContext, TypeBadge, useResource } from './ui.jsx';

const storage = () => {
  try {
    return localStorage;
  } catch {
    return null;
  }
};

// The server drops everything but letters and digits, so punctuation alone would list recent pages as matches.
const searchable = (q) => /[\p{L}\p{N}]/u.test(q);

function Highlighted({ text, indices }) {
  if (!indices.length) return text;
  return highlightRuns(text, indices).map((run, i) =>
    run.hit ? (
      <Text key={i} type="inherit" color="accent" weight="semibold">
        {run.text}
      </Text>
    ) : (
      run.text
    ),
  );
}

const pageItem = (hit, indices = []) => ({
  key: `page:${hit.title}`,
  type: 'page',
  id: hit.title,
  label: hit.title,
  kind: hit.kind ?? null,
  icon: FileText,
  indices,
});
const commandItem = (command, indices = []) => ({
  key: `command:${command.id}`,
  type: 'command',
  id: command.id,
  label: command.label,
  hint: command.hint,
  icon: command.icon,
  indices,
  run: command.run,
});
const flattenGroups = (groups) => groups.flatMap((group) => group.items.map((item) => ({ ...item, id: item.key, target: item.id, auxiliaryData: { group: group.title } })));

// Astryx starts each result list with nothing highlighted; Enter should open the first row, as before.
function PaletteInput() {
  const palette = useCommandPaletteContext();
  const rows = palette?.selectableItems.length ?? 0;
  const highlighted = palette?.highlightedIndex ?? 0;
  useEffect(() => {
    if (rows && highlighted < 0) palette.setHighlightedIndex(0);
  }, [palette, rows, highlighted]);
  return <CommandPaletteInput label="Search pages and commands" placeholder="Search pages, commands" />;
}

/**
 * Command palette: pages (recently written ones filtered here, the rest looked up on the server after a pause), views, appearance and help.
 * `commands` is `[{ id, group, label, keywords, hint, icon, run }]`.
 */
export function Palette({ commands, onClose }) {
  const lock = useContext(AuthContext);
  const [recent, setRecent] = useState(() => readRecent(storage()));
  const index = useResource('/search?q=&limit=50&rerank=false');
  // Every row the palette has been given, by id, so a selection can find its command or page.
  const shown = useRef(new Map());

  const searchSource = useMemo(() => {
    const indexHits = index.data?.hits ?? [];
    const groups = (term, found = []) => {
      const out = [];
      const add = (title, items) => items.length && out.push({ title, items });
      if (!term) {
        const known = new Map(commands.map((command) => [command.id, command]));
        const recents = recent
          .map((entry) =>
            entry.type === 'page'
              ? pageItem(indexHits.find((hit) => hit.title === entry.id) ?? { title: entry.id })
              : known.has(entry.id)
                ? commandItem(known.get(entry.id))
                : null,
          )
          .filter(Boolean)
          .slice(0, 5);
        const seen = new Set(recents.map((item) => item.key));
        add('Recent', recents);
        add('Recently written', indexHits.map((hit) => pageItem(hit)).filter((page) => !seen.has(page.key)).slice(0, 4));
        for (const title of ['Go to', 'Appearance', 'Help']) add(title, commands.filter((command) => command.group === title).map((command) => commandItem(command)));
        return out;
      }
      const pages = fuzzyFilter(indexHits, term, (hit) => hit.title, { minPerChar: 2 })
        .slice(0, 6)
        .map((result) => pageItem(result.item, result.indices));
      const seen = new Set(pages.map((page) => page.key));
      add('Pages', [...pages, ...found.map((hit) => pageItem(hit)).filter((page) => !seen.has(page.key))].slice(0, 9));
      const matched = fuzzyFilter(commands, term, (command) => `${command.label} ${command.keywords ?? ''}`, { minPerChar: 2 }).slice(0, 6);
      add(
        'Commands',
        matched.map((result) => commandItem(result.item, fuzzyMatch(term, result.item.label)?.indices ?? [])),
      );
      if (searchable(term)) add('Search', [{ key: `search:${term}`, type: 'search', id: term, label: `Search memory for “${term}”`, icon: Search, indices: [] }]);
      return out;
    };
    const remember = (items) => {
      for (const item of items) shown.current.set(item.id, item);
      return items;
    };
    // The server lookup waits for a pause in typing; a newer query releases the wait without fetching.
    let timer = 0;
    let release = null;
    const pause = () =>
      new Promise((resolve) => {
        release = () => resolve(false);
        timer = setTimeout(() => resolve(true), 220);
      });
    return {
      bootstrap: () => remember(flattenGroups(groups(''))),
      async search(value, context) {
        const term = value.trim();
        const local = remember(flattenGroups(groups(term)));
        if (!searchable(term)) return local;
        context?.update(local);
        if (!(await pause())) return local;
        try {
          const { hits = [] } = await api(`/search${query({ q: term, limit: 8, rerank: false })}`);
          return remember(flattenGroups(groups(term, hits)));
        } catch (error) {
          if (error instanceof Unauthorized) lock();
          return local;
        }
      },
      cancel() {
        clearTimeout(timer);
        release?.();
      },
    };
  }, [commands, recent, index.data, lock]);

  const choose = (item) => {
    if (item.type !== 'search') {
      const next = pushRecent(recent, { type: item.type, id: item.target });
      writeRecent(storage(), next);
      setRecent(next);
    }
    onClose();
    if (item.type === 'page') location.hash = href('page', { title: item.target });
    else if (item.type === 'search') location.hash = href('search', { q: item.target, mode: 'keywords' });
    else item.run();
  };

  const emptyBootstrap = index.loading ? 'Loading pages…' : index.error ? `Couldn’t load pages: ${index.error.message}` : 'No pages or commands yet.';

  return (
    <CommandPalette
      isOpen
      label="Command palette"
      onOpenChange={(open) => !open && onClose()}
      searchSource={searchSource}
      input={<PaletteInput />}
      renderItem={(item) => (
        <>
          <Icon icon={item.icon} size="sm" />
          <Text type="body" maxLines={1} style={{ flex: 1, minWidth: 0 }}>
            <Highlighted text={item.label} indices={item.indices} />
          </Text>
          {item.type === 'page' && item.kind && <TypeBadge kind={item.kind} />}
          {item.hint && <Kbd keys={item.hint.replaceAll(' ', '+')} />}
        </>
      )}
      emptySearchText="No pages or commands match."
      emptyBootstrapText={emptyBootstrap}
      onValueChange={(id) => {
        const item = shown.current.get(id);
        if (item) choose(item);
      }}
    />
  );
}
