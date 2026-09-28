import { createContext, useContext, useEffect, useState } from 'react';
import { query } from './api.js';

export const VIEWS = ['search', 'dashboard', 'graph', 'timeline', 'activity', 'settings', 'page'];

// Routes live in the hash, e.g. #/timeline?author=x&page=Redis, so every view and open page can be linked.
export function parseHash(hash = location.hash) {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?');
  return { view: VIEWS.includes(path) ? path : 'search', params: Object.fromEntries(new URLSearchParams(search)) };
}

export function href(view, params = {}) {
  return `#/${view}${query(params)}`;
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseHash());
  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    addEventListener('hashchange', onChange);
    return () => removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const RouteContext = createContext({ view: 'search', params: {} });

/** Link target that keeps the current view and opens `title` in the page drawer; a full page links on to full pages. */
export function usePageHref() {
  const { view, params } = useContext(RouteContext);
  return (title) => (view === 'page' ? href('page', { title }) : href(view, { ...params, page: title }));
}
