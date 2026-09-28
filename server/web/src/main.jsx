import React, { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ForceGraph2D from 'react-force-graph-2d';
import './style.css';

const TOKEN_KEY = 'pensieve-token';
const WIKILINK = /\[\[([^\]\n]+?)\]\]/g;

class Unauthorized extends Error {}

async function api(path, token) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Unauthorized('Enter the server token.');
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const pageHref = (title) => `#${encodeURIComponent(title)}`;

function hashTitle() {
  try {
    return decodeURIComponent(location.hash.slice(1));
  } catch {
    return '';
  }
}

// force-graph renders node tooltips as HTML, and missing-page ids come from unvalidated link text.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function PageLink({ title, missing, children }) {
  return <a href={pageHref(title)} className={missing ? 'missing' : undefined}>{children ?? title}</a>;
}

function List({ items }) {
  return items.length ? items.map((item, i) => <Fragment key={i}>{i > 0 && ', '}{item}</Fragment>) : '—';
}

// Same link rules as the server: targets before `|` or `#`, outside fenced code.
function Content({ text }) {
  return text.split('```').map((block, i) => {
    const fence = i ? '```' : '';
    if (i % 2) return <Fragment key={i}>{fence}{block}</Fragment>;
    const parts = [];
    let last = 0;
    for (const m of block.matchAll(WIKILINK)) {
      const target = m[1].split(/[|#]/)[0].trim().replace(/\\$/, '').replace(/\.md$/, '');
      parts.push(block.slice(last, m.index), target ? <PageLink key={m.index} title={target}>{m[0]}</PageLink> : m[0]);
      last = m.index + m[0].length;
    }
    parts.push(block.slice(last));
    return <Fragment key={i}>{fence}{parts}</Fragment>;
  });
}

function Snippet({ text }) {
  return text.split(/[«»]/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function Graph({ data, selected, hits }) {
  const box = useRef();
  const graph = useRef();
  const fitted = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = data.nodes.find((n) => n.id === selected);
    if (node?.x === undefined || !graph.current) return;
    graph.current.centerAt(node.x, node.y, 600);
    graph.current.zoom(2.5, 600);
  }, [data, selected]);

  const nodeColor = (n) => (n.id === selected ? '#f7768e' : hits.has(n.id) ? '#e0af68' : n.missing ? '#3b4252' : '#7aa2f7');
  const drawLabel = (n, ctx, scale) => {
    if (scale < 2 && n.id !== selected && !hits.has(n.id)) return;
    ctx.font = `${11 / scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c8d0e0';
    ctx.fillText(n.id, n.x, n.y + Math.sqrt(1 + Math.sqrt(n.degree)) * 3 + 10 / scale);
  };

  return (
    <main ref={box} className="graph" aria-label="Page link graph">
      {size.width > 0 && (
        <ForceGraph2D
          ref={graph}
          graphData={data}
          width={size.width}
          height={size.height}
          nodeRelSize={3}
          nodeVal={(n) => 1 + Math.sqrt(n.degree)}
          nodeLabel={(n) => escapeHtml(n.id)}
          nodeColor={nodeColor}
          nodeCanvasObjectMode={() => 'after'}
          nodeCanvasObject={drawLabel}
          linkColor={() => 'rgba(150, 160, 185, 0.18)'}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          onNodeClick={(n) => (location.hash = pageHref(n.id))}
          onEngineStop={() => {
            if (fitted.current) return;
            fitted.current = true;
            graph.current.zoomToFit(400, 40);
          }}
        />
      )}
    </main>
  );
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [locked, setLocked] = useState(false);
  const [status, setStatus] = useState('');
  const [graph, setGraph] = useState(null);
  const [results, setResults] = useState([]);
  const [title, setTitle] = useState(hashTitle);
  const [page, setPage] = useState(null);

  const call = useCallback(
    (path) =>
      api(path, token).catch((err) => {
        if (err instanceof Unauthorized) setLocked(true);
        throw err;
      }),
    [token],
  );

  useEffect(() => {
    call('/api/graph')
      .then((data) => {
        const degree = {};
        for (const l of data.links) {
          degree[l.source] = (degree[l.source] || 0) + 1;
          degree[l.target] = (degree[l.target] || 0) + 1;
        }
        for (const n of data.nodes) n.degree = degree[n.id] || 0;
        setGraph(data);
        setStatus(`${data.nodes.filter((n) => !n.missing).length} pages · ${data.links.length} links`);
      })
      .catch((err) => setStatus(err.message));
  }, [call]);

  useEffect(() => {
    const onHash = () => setTitle(hashTitle());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!title) return;
    let current = true;
    call(`/api/pages/${encodeURIComponent(title)}`)
      .then((p) => current && setPage(p))
      .catch((err) => current && setStatus(`${title}: ${err.message}`));
    return () => {
      current = false;
    };
  }, [call, title]);

  const pageBox = useRef();
  useEffect(() => pageBox.current?.scrollTo(0, 0), [page]);

  async function search(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const params = new URLSearchParams({ q: form.get('q'), limit: '20', rerank: String(form.has('rerank')) });
    setStatus('Searching…');
    try {
      const res = await call(`/api/search?${params}`);
      setResults(res.hits);
      setStatus(`${res.hits.length} results · ${res.reranked ? 'ranked by Jev' : 'BM25'}`);
    } catch (err) {
      setStatus(err.message);
    }
  }

  function unlock(e) {
    e.preventDefault();
    const value = new FormData(e.currentTarget).get('token').trim();
    localStorage.setItem(TOKEN_KEY, value);
    setLocked(false);
    setToken(value);
  }

  return (
    <>
      <aside>
        {locked && (
          <form onSubmit={unlock}>
            <input name="token" type="password" placeholder="Server token" aria-label="Server token" autoComplete="current-password" required />
            <button>Unlock</button>
          </form>
        )}
        <form onSubmit={search}>
          <input name="q" type="search" placeholder="Search memory…" aria-label="Search memory" autoComplete="off" />
          <label title="Rerank with Jev when the server has a key">
            <input name="rerank" type="checkbox" defaultChecked />
            Jev
          </label>
          <button>Search</button>
        </form>
        <div className="status" role="status">{status}</div>
        {results.length > 0 && (
          <nav className="results" aria-label="Search results">
            {results.map((hit) => (
              <a key={hit.title} className="hit" href={pageHref(hit.title)}>
                <b>{hit.title}</b> <small>{hit.score.toFixed(2)}</small>
                <p><Snippet text={hit.snippet} /></p>
              </a>
            ))}
          </nav>
        )}
        <article ref={pageBox} className="page">
          {page && (
            <>
              <h2>{page.title}</h2>
              <p className="meta">rev {page.rev} · {page.updated_at} · {page.updated_by}</p>
              <p className="meta">Links: <List items={page.links.map((l) => <PageLink title={l.title} missing={!l.exists} />)} /></p>
              <p className="meta">Backlinks: <List items={page.backlinks.map((t) => <PageLink title={t} />)} /></p>
              <pre><Content text={page.content} /></pre>
            </>
          )}
        </article>
      </aside>
      {graph && <Graph data={graph} selected={page?.title} hits={new Set(results.map((h) => h.title))} />}
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
