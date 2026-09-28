import { useContext, useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquareText, Search as SearchIcon } from 'lucide-react';
import { api, query, Unauthorized } from './api.js';
import { href } from './router.js';
import { AuthContext, Empty, ErrorNote, formatNumber, Markdown, PageLink, RelTime, TypeBadge } from './ui.jsx';

export function Search({ params }) {
  const lock = useContext(AuthContext);
  const q = params.q ?? '';
  const mode = params.mode === 'ask' ? 'ask' : 'keywords';
  const jev = params.jev !== '0';
  // Results remember what they answer: for one render after a change, the previous results are still here.
  const key = `${mode}\n${jev}\n${q}`;
  const [result, setResult] = useState({ loading: false, error: null, data: null, key });
  const latest = useRef(0);

  useEffect(() => {
    if (!q.trim()) {
      latest.current++;
      setResult({ loading: false, error: null, data: null, key });
      return;
    }
    // Only the newest query may update the results, so a slow response can't replace a newer one.
    const request = ++latest.current;
    setResult((r) => ({ ...r, loading: true, error: null }));
    const path = mode === 'ask' ? `/recall${query({ q, budget: 3000 })}` : `/search${query({ q, limit: 30, rerank: jev })}`;
    api(path)
      .then((data) => request === latest.current && setResult({ loading: false, error: null, data, key }))
      .catch((error) => {
        if (request !== latest.current) return;
        if (error instanceof Unauthorized) lock();
        setResult({ loading: false, error, data: null, key });
      });
  }, [q, mode, jev, key, lock]);

  const tab = (value, label, Icon) => (
    <a className="tab" href={href('search', { ...params, mode: value })} aria-current={mode === value ? 'page' : undefined}>
      <Icon size={16} aria-hidden="true" />
      {label}
    </a>
  );

  return (
    <div className="view">
      <header className="view-header">
        <h1>{q ? `“${q}”` : 'Search'}</h1>
        <p className="muted">{mode === 'ask' ? 'Passages the recall tool would give an agent, ranked and packed into a token budget.' : 'Pages whose title or text contains the words.'}</p>
      </header>

      <div className="toolbar">
        <nav className="tabs" aria-label="Search mode">
          {tab('keywords', 'Keywords', SearchIcon)}
          {tab('ask', 'Ask', MessageSquareText)}
        </nav>
        {mode === 'keywords' && (
          <label className="checkbox">
            <input type="checkbox" checked={jev} onChange={(e) => (location.hash = href('search', { ...params, jev: e.target.checked ? undefined : '0' }))} />
            Rerank with Jev
          </label>
        )}
      </div>

      {!q.trim() && <Empty>Type in the search box at the top. Press / to jump there.</Empty>}
      {result.loading && (
        <div className="state" role="status">
          <Loader2 className="spin" size={18} aria-hidden="true" />
          {mode === 'ask' ? 'Recalling…' : 'Searching…'}
        </div>
      )}
      {result.error && <ErrorNote error={result.error} />}
      {result.data && !result.loading && result.key === key && (mode === 'ask' ? <Answer data={result.data} /> : <Hits data={result.data} />)}
    </div>
  );
}

function Hits({ data }) {
  if (!data.hits.length) return <Empty>No pages match.</Empty>;
  return (
    <>
      <p className="muted small" role="status">
        {data.hits.length} pages, ranked by {data.reranked ? 'Jev relevance' : 'BM25'}
      </p>
      <ol className="results">
        {data.hits.map((hit) => (
          <li key={hit.title}>
            <div className="result-head">
              <PageLink title={hit.title} />
              <span className="muted small">
                rev {hit.rev} · updated <RelTime iso={hit.updated_at} />
                {data.reranked && <> · relevance {hit.score.toFixed(2)}</>}
              </span>
            </div>
            <p className="snippet">
              {hit.snippet.split(/[«»]/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}

function Answer({ data }) {
  const pages = new Set(data.passages.map((p) => p.title));
  return (
    <>
      <p className="muted small" role="status">
        {data.passages.length
          ? `${data.passages.length} passages from ${pages.size} pages, about ${formatNumber(data.tokens)} tokens, ranked by ${data.reranked ? 'Jev relevance' : 'BM25'}`
          : 'Nothing in memory answers this.'}
      </p>
      <ol className="passages">
        {data.passages.map((p) => (
          <li key={`${p.title}:${p.ord}`} className="card passage">
            <header className="passage-head">
              <h2>
                <PageLink title={p.title} />
                {p.heading && <span className="muted"> › {p.heading}</span>}
              </h2>
              <div className="meta-row">
                <TypeBadge kind={p.kind} />
                {p.confidence && <span className="chip">confidence {p.confidence}</span>}
                <span>rev {p.rev}</span>
                <span>
                  updated <RelTime iso={p.updated_at} />
                </span>
                {data.reranked && <span className="mono">relevance {p.score.toFixed(2)}</span>}
              </div>
            </header>
            <div className="prose">
              <Markdown>{p.text}</Markdown>
            </div>
          </li>
        ))}
      </ol>
      {data.leads.length > 0 && (
        <p className="leads">
          <span className="muted">More pages: </span>
          {data.leads.map((t, i) => (
            <span key={t}>
              {i > 0 && ', '}
              <PageLink title={t} />
            </span>
          ))}
        </p>
      )}
    </>
  );
}
