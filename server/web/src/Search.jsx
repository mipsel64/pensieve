import { useContext, useEffect, useRef, useState } from 'react';
import { FileText, Loader2, MessageSquareText, Search as SearchIcon, Sparkles, X } from 'lucide-react';
import { api, query, Unauthorized } from './api.js';
import { href } from './router.js';
import { AuthContext, ErrorNote, formatNumber, KIND_COLORS, Logo, Markdown, PageLink, RelTime, TypeBadge } from './ui.jsx';
import { useSettings } from './settings.jsx';

// The server drops everything but letters and digits, so `???` would otherwise list recent pages as matches.
const searchable = (q) => /[\p{L}\p{N}]/u.test(q);

export function Search({ params }) {
  const { settings } = useSettings();
  const q = (params.q ?? '').trim();
  const mode = (params.mode ?? settings.search.mode) === 'ask' ? 'ask' : 'keywords';
  const rerank = params.jev ? params.jev !== '0' : settings.search.rerank;
  const go = (value, nextMode = mode) => {
    if (value.trim()) location.hash = href('search', { ...params, q: value.trim(), mode: nextMode });
  };

  if (!q) {
    return (
      <div className="search-home">
        <div className="search-hero">
          <Logo size={84} />
          <h1>Pensieve</h1>
        </div>
        <SearchBox initial="" big autoFocus onSubmit={(value) => go(value, settings.search.mode)}>
          {(value) => (
            <div className="search-actions">
              <button type="button" className="pill" onClick={() => go(value, 'keywords')}>
                Search memory
              </button>
              <button type="button" className="pill" onClick={() => go(value, 'ask')}>
                Ask a question
              </button>
            </div>
          )}
        </SearchBox>
        <p className="search-hint">
          <strong>Search</strong> ranks whole pages by their words. <strong>Ask</strong> returns the passages an agent's recall would get.
        </p>
      </div>
    );
  }

  const tab = (value, label, Icon) => (
    <a className="serp-tab" href={href('search', { ...params, mode: value })} aria-current={mode === value ? 'page' : undefined}>
      <Icon size={16} aria-hidden="true" />
      {label}
    </a>
  );

  return (
    <div className="serp">
      <header className="serp-header">
        <a className="serp-brand" href={href('search')} aria-label="New search">
          <Logo size={30} />
          <span>Pensieve</span>
        </a>
        <SearchBox key={q} initial={q} onSubmit={(value) => go(value)} />
      </header>
      <div className="serp-tabs">
        <nav aria-label="Search mode">
          {tab('keywords', 'Pages', FileText)}
          {tab('ask', 'Ask', MessageSquareText)}
        </nav>
        {mode === 'keywords' && (
          <label className="checkbox">
            <input type="checkbox" checked={rerank} onChange={(e) => (location.hash = href('search', { ...params, jev: e.target.checked ? '1' : '0' }))} />
            Rerank with Jev
          </label>
        )}
      </div>
      <Results q={q} mode={mode} rerank={rerank} params={params} />
    </div>
  );
}

function SearchBox({ initial, big, autoFocus, onSubmit, children }) {
  const [value, setValue] = useState(initial);
  const input = useRef(null);
  return (
    <form
      className={`search-form${big ? ' big' : ''}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <div className="search-box">
        <SearchIcon size={big ? 20 : 18} aria-hidden="true" />
        <input
          ref={input}
          id="search-q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Search memory"
          placeholder={big ? 'Search memory or ask a question' : undefined}
          autoComplete="off"
          enterKeyHint="search"
          autoFocus={autoFocus}
        />
        {value && (
          <button
            type="button"
            className="icon-button"
            aria-label="Clear search"
            onClick={() => {
              setValue('');
              input.current.focus();
            }}
          >
            <X size={18} aria-hidden="true" />
          </button>
        )}
      </div>
      {children?.(value)}
    </form>
  );
}

function Results({ q, mode, rerank, params }) {
  const lock = useContext(AuthContext);
  // Results remember what they answer: for one render after a change, the previous results are still here.
  const key = `${mode}\n${rerank}\n${q}`;
  const [result, setResult] = useState({ loading: false, error: null, data: null, key: null });
  const valid = searchable(q);

  useEffect(() => {
    if (!valid) return;
    let current = true;
    const started = performance.now();
    setResult((r) => ({ ...r, loading: true, error: null }));
    const path = mode === 'ask' ? `/recall${query({ q })}` : `/search${query({ q, limit: 30, rerank })}`;
    api(path)
      .then((data) => current && setResult({ loading: false, error: null, data, key, seconds: (performance.now() - started) / 1000 }))
      .catch((error) => {
        if (!current) return;
        if (error instanceof Unauthorized) lock();
        setResult({ loading: false, error, data: null, key });
      });
    return () => {
      current = false;
    };
  }, [q, mode, rerank, key, valid, lock]);

  if (!valid) return <p className="serp-note">Type a word or a name to search for.</p>;
  const fresh = result.key === key && !result.loading;
  return (
    <div className="serp-body" aria-busy={result.loading}>
      {result.loading && (
        <p className="serp-stats" role="status">
          <Loader2 className="spin" size={15} aria-hidden="true" /> {mode === 'ask' ? 'Recalling…' : 'Searching…'}
        </p>
      )}
      {result.error && fresh && <ErrorNote error={result.error} />}
      {result.data && fresh && (mode === 'ask' ? <Answer data={result.data} seconds={result.seconds} /> : <Hits data={result.data} seconds={result.seconds} q={q} params={params} />)}
    </div>
  );
}

const seconds = (s) => `${s.toFixed(2)} seconds`;

function Hits({ data, seconds: took, q, params }) {
  if (!data.hits.length) {
    return (
      <div className="serp-empty">
        <p>
          No pages match <strong>{q}</strong>.
        </p>
        <ul>
          <li>Try different or fewer words.</li>
          <li>
            Or <a href={href('search', { ...params, mode: 'ask' })}>ask it as a question</a>: recall matches sections rather than whole pages.
          </li>
        </ul>
      </div>
    );
  }
  return (
    <>
      <p className="serp-stats" role="status">
        {data.hits.length} {data.hits.length === 1 ? 'page' : 'pages'} ({seconds(took)}) · ranked by {data.reranked ? 'Jev relevance' : 'BM25'}
      </p>
      <ol className="serp-list">
        {data.hits.map((hit) => (
          <li key={hit.title} className="serp-item">
            <div className="serp-source">
              <span className="serp-icon" style={{ '--kind': KIND_COLORS[hit.kind] ?? KIND_COLORS.untyped }} aria-hidden="true">
                {(hit.kind ?? 'page')[0].toUpperCase()}
              </span>
              <span className="serp-site">
                <span>{hit.kind ?? 'untyped'}</span>
                <span className="serp-crumb">
                  memory › rev {hit.rev}
                  {data.reranked && <> · relevance {hit.score.toFixed(2)}</>}
                </span>
              </span>
            </div>
            <h3>
              <PageLink title={hit.title} />
            </h3>
            <p className="serp-snippet">
              <span className="serp-date">
                <RelTime iso={hit.updated_at} /> —{' '}
              </span>
              {hit.snippet.split(/[«»]/).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
            </p>
          </li>
        ))}
      </ol>
      {data.hits.length === 30 && <p className="serp-note">Showing the 30 best matches. Add words to narrow the search.</p>}
    </>
  );
}

function Answer({ data, seconds: took }) {
  return (
    <>
      {data.passages.length ? <Recall data={data} took={took} /> : <p className="serp-note">Nothing in memory answers this. Try other words, or search for a page title.</p>}
      {data.leads.length > 0 && (
        <section className="related" aria-labelledby="related-title">
          <h2 id="related-title">Related pages</h2>
          <ul>
            {data.leads.map((t) => (
              <li key={t}>
                <PageLink title={t}>
                  <SearchIcon size={15} aria-hidden="true" /> {t}
                </PageLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Recall({ data, took }) {
  const pages = new Set(data.passages.map((p) => p.title));
  return (
    <section className="recall-box" aria-labelledby="recall-title">
      <h2 id="recall-title">
        <Sparkles size={17} aria-hidden="true" /> What an agent would recall
      </h2>
      <p className="serp-stats" role="status">
        {data.passages.length} passages from {pages.size} {pages.size === 1 ? 'page' : 'pages'} · about {formatNumber(data.tokens)} tokens ({seconds(took)}) · ranked by{' '}
        {data.reranked ? 'Jev relevance' : 'BM25'}
      </p>
      <ol className="passages">
        {data.passages.map((p) => (
          <li key={`${p.title}:${p.ord}`} className="passage">
            <header className="passage-head">
              <h3>
                <PageLink title={p.title} />
                {p.heading && <span className="muted"> › {p.heading}</span>}
              </h3>
              <div className="meta-row">
                <TypeBadge kind={p.kind} />
                {p.confidence && <span className="chip">confidence {p.confidence}</span>}
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
    </section>
  );
}
