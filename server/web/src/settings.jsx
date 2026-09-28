import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, Unauthorized } from './api.js';
import { AuthContext } from './ui.jsx';

export const ACCENTS = {
  silver: { label: 'Silver', color: '#dfe5e4' },
  seaglass: { label: 'Sea glass', color: '#9fd3ca' },
  moonlight: { label: 'Moonlight', color: '#a9c1ea' },
  lavender: { label: 'Lavender', color: '#c3b3ea' },
  ember: { label: 'Ember', color: '#e6c28f' },
};

export const DEFAULT_SETTINGS = {
  accent: 'silver',
  search: { mode: 'ask', rerank: true },
  graph: {
    missing: false,
    orphans: true,
    hidden: [],
    colorByType: true,
    arrows: false,
    textFade: 1.6,
    nodeSize: 1,
    linkWidth: 1,
    center: 0.08,
    repel: 90,
    linkForce: 1,
    linkDistance: 45,
  },
};

export const GRAPH_TOGGLES = {
  filters: [
    ['missing', 'Missing pages'],
    ['orphans', 'Orphans'],
  ],
  groups: [['colorByType', 'Color by type']],
  display: [['arrows', 'Arrows']],
};

export const GRAPH_SLIDERS = {
  display: [
    ['textFade', 'Text fade threshold', 0.2, 4, 0.1],
    ['nodeSize', 'Node size', 0.4, 3, 0.1],
    ['linkWidth', 'Link thickness', 0.2, 4, 0.1],
  ],
  forces: [
    ['center', 'Center force', 0, 0.5, 0.01],
    ['repel', 'Repel force', 0, 400, 5],
    ['linkForce', 'Link force', 0, 2, 0.05],
    ['linkDistance', 'Link distance', 10, 200, 5],
  ],
};

export const SEARCH_MODES = ['ask', 'keywords'];

// Stored settings may be old or hand-edited: keep only values the UI can use.
function withDefaults(stored) {
  const settings = merge(stored, DEFAULT_SETTINGS);
  if (!Object.hasOwn(ACCENTS, settings.accent)) settings.accent = DEFAULT_SETTINGS.accent;
  if (!SEARCH_MODES.includes(settings.search.mode)) settings.search.mode = DEFAULT_SETTINGS.search.mode;
  for (const [key, , min, max] of Object.values(GRAPH_SLIDERS).flat()) settings.graph[key] = Math.min(max, Math.max(min, settings.graph[key]));
  return settings;
}

function merge(stored, defaults) {
  const out = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = stored?.[key];
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) out[key] = merge(value, fallback);
    else if (Array.isArray(fallback)) out[key] = Array.isArray(value) ? value.filter((v) => typeof v === 'string') : fallback;
    else out[key] = typeof value === typeof fallback && (typeof value !== 'number' || Number.isFinite(value)) ? value : fallback;
  }
  return out;
}

const SettingsContext = createContext(null);

export function useSettings() {
  return useContext(SettingsContext);
}

export function SettingsProvider({ initial, children }) {
  const lock = useContext(AuthContext);
  const [settings, setSettings] = useState(() => withDefaults(initial));
  const [status, setStatus] = useState({ state: 'idle' });
  const current = useRef(settings);
  const timer = useRef(null);
  const saving = useRef(Promise.resolve());
  const sent = useRef(settings);

  // keepalive lets a save already on its way finish if the tab closes.
  const put = useCallback(() => {
    const body = current.current;
    sent.current = body;
    return api('/settings', { method: 'PUT', body, keepalive: true }).then(
      () => current.current === body && setStatus({ state: 'saved' }),
      (error) => {
        if (error instanceof Unauthorized) lock();
        if (current.current === body) setStatus({ state: 'error', error });
      },
    );
  }, [lock]);

  // One save at a time, so an older one can't land after a newer one.
  const send = useCallback(() => (saving.current = saving.current.then(put)), [put]);

  // Sliders change many times a second; save once they settle.
  const update = useCallback(
    (section, patch) => {
      const next = section ? { ...current.current, [section]: { ...current.current[section], ...patch } } : { ...current.current, ...patch };
      current.current = next;
      setSettings(next);
      setStatus({ state: 'saving' });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        send();
      }, 400);
    },
    [send],
  );

  const retry = useCallback(() => {
    setStatus({ state: 'saving' });
    send();
  }, [send]);

  /** Sends a change still waiting out the debounce, and resolves once every save has finished. */
  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
      send();
    }
    return saving.current;
  }, [send]);

  useEffect(() => {
    // A closing tab can't wait its turn in the queue, so the latest state goes now.
    const onHide = () => {
      clearTimeout(timer.current);
      timer.current = null;
      if (current.current !== sent.current) put();
    };
    addEventListener('pagehide', onHide);
    return () => {
      removeEventListener('pagehide', onHide);
      flush();
    };
  }, [flush, put]);

  const accent = accentColor(settings);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--accent', accent);
    return () => root.removeProperty('--accent');
  }, [accent]);

  const value = useMemo(() => ({ settings, update, status, retry, flush }), [settings, update, status, retry, flush]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function accentColor(settings) {
  return ACCENTS[settings.accent].color;
}

export function Toggle({ id, label, checked, onChange }) {
  return (
    <label className="toggle" htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function Slider({ id, label, min, max, step, value, onChange }) {
  return (
    <div className="slider">
      <label htmlFor={id}>
        <span>{label}</span>
        <output htmlFor={id} className="mono muted">
          {+value.toFixed(2)}
        </output>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </div>
  );
}

/** The graph's toggles and sliders for one panel section, shared by the graph panel and the settings page. */
export function GraphControls({ section, idPrefix }) {
  const { settings, update } = useSettings();
  const g = settings.graph;
  return (
    <>
      {(GRAPH_TOGGLES[section] ?? []).map(([key, label]) => (
        <Toggle key={key} id={`${idPrefix}-${key}`} label={label} checked={g[key]} onChange={(v) => update('graph', { [key]: v })} />
      ))}
      {(GRAPH_SLIDERS[section] ?? []).map(([key, label, min, max, step]) => (
        <Slider key={key} id={`${idPrefix}-${key}`} label={label} min={min} max={max} step={step} value={g[key]} onChange={(v) => update('graph', { [key]: v })} />
      ))}
    </>
  );
}

export function resetGraph(update) {
  update('graph', DEFAULT_SETTINGS.graph);
}
