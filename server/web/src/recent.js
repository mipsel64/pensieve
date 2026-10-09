export const RECENT_KEY = 'pensieve.recent';
const MAX_RECENT = 8;

const valid = (entry) => entry && (entry.type === 'page' || entry.type === 'command') && typeof entry.id === 'string' && entry.id;

/** `entry` first, without an earlier copy of itself, capped at `max`. */
export function pushRecent(list, entry, max = MAX_RECENT) {
  return [entry, ...list.filter((e) => !(e.type === entry.type && e.id === entry.id))].slice(0, max);
}

export function parseRecent(raw) {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(valid).map(({ type, id }) => ({ type, id })).slice(0, MAX_RECENT) : [];
  } catch {
    return [];
  }
}

// Per browser, like the theme: what was opened here is no business of the server.
export function readRecent(storage) {
  try {
    return parseRecent(storage?.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export function writeRecent(storage, list) {
  try {
    storage?.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Same as no storage: the list lasts until reload.
  }
}
