import { createContext, useContext, useEffect, useState } from 'react';
import { query } from './api.js';

export const VIEWS = ['dashboard', 'search', 'graph', 'timeline', 'activity', 'settings'];

// Routes live in the hash, e.g. #/timeline?author=x&page=Redis, so every view and open page can be linked.
export function parseHash(hash = location.hash) {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?');
  return { view: VIEWS.includes(path) ? path : 'dashboard', params: Object.fromEntries(new URLSearchParams(search)) };
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

export const RouteContext = createContext({ view: 'dashboard', params: {} });

/** Link target that keeps the current view and opens `title` in the page drawer. */
export function usePageHref() {
  const { view, params } = useContext(RouteContext);
  return (title) => href(view, { ...params, page: title });
}
