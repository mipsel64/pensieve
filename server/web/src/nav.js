import { Activity, History, LayoutDashboard, Network, NotebookPen, Search } from 'lucide-react';

/** Navigation links: id, label, palette icon and the key that follows `g`. */
export const NAV = [
  ['search', 'Search', Search, 's'],
  ['dashboard', 'Dashboard', LayoutDashboard, 'd'],
  ['graph', 'Graph', Network, 'g'],
  ['timeline', 'Timeline', History, 't'],
  ['journal', 'Journal', NotebookPen, 'j'],
  ['activity', 'Activity', Activity, 'a'],
];

export const VIEW_LABELS = { ...Object.fromEntries(NAV.map(([id, label]) => [id, label])), settings: 'Settings', page: 'Page' };
