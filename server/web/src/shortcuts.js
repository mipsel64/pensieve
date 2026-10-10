/** `g` then one of these keys opens the view. */
export const GO_KEYS = { d: 'dashboard', s: 'search', g: 'graph', t: 'timeline', j: 'journal', a: 'activity' };

export const isApple = (platform = '') => /Mac|iPhone|iPad|iPod/i.test(platform);
export const modifierLabel = (platform) => (isApple(platform) ? '⌘' : 'Ctrl');

export const SHORTCUT_GROUPS = (mod) => [
  {
    title: 'General',
    items: [
      { keys: [mod, 'K'], label: 'Open the command palette' },
      { keys: ['/'], label: 'Focus search' },
      { keys: ['t'], label: 'Cycle appearance: System, Light, Dark' },
      { keys: ['?'], label: 'Show this help' },
      { keys: ['Esc'], label: 'Close a dialog, menu or page panel' },
    ],
  },
  {
    title: 'Go to',
    items: [
      { keys: ['g', 'd'], label: 'Dashboard' },
      { keys: ['g', 's'], label: 'Search' },
      { keys: ['g', 'g'], label: 'Graph' },
      { keys: ['g', 't'], label: 'Timeline' },
      { keys: ['g', 'j'], label: 'Journal' },
      { keys: ['g', 'a'], label: 'Activity' },
    ],
  },
];

/**
 * One key press → `{ action, pending }`. `pending` is the key waiting for a second one, to pass back on the next call.
 * Actions: `{ type: 'palette' | 'help' | 'search' | 'theme' }` or `{ type: 'go', view }`.
 */
export function resolveKey(event, pending, typing) {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const modified = event.metaKey || event.ctrlKey;
  if (modified && !event.altKey && !event.shiftKey && key === 'k') return { action: { type: 'palette' }, pending: null };
  if (modified || event.altKey || typing) return { action: null, pending: null };
  if (event.repeat) return { action: null, pending };
  if (pending === 'g') {
    const view = !event.shiftKey && GO_KEYS[key];
    return { action: view ? { type: 'go', view } : null, pending: null };
  }
  if (key === '/') return { action: { type: 'search' }, pending: null };
  if (key === '?') return { action: { type: 'help' }, pending: null };
  if (key === 't' && !event.shiftKey) return { action: { type: 'theme' }, pending: null };
  if (key === 'g' && !event.shiftKey) return { action: null, pending: 'g' };
  return { action: null, pending: null };
}
