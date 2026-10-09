import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Copy, FileText, Layers, ListTree, Sparkles, X } from 'lucide-react';
import { api, query, Unauthorized } from './api.js';
import { href, usePageHref } from './router.js';
import { AuthContext, ErrorNote, formatNumber, KIND_COLORS, Logo, Markdown, PageLink, RelTime } from './ui.jsx';
import { Toggle, useSettings } from './settings.jsx';
import { withoutTitle } from './Page.jsx';

// The server drops everything but letters and digits, so `???` would otherwise list recent pages as matches.
const searchable = (q) => /[\p{L}\p{N}]/u.test(q);

const MODES = [
  ['ask', 'Answer', Sparkles],
  ['keywords', 'Pages', FileText],
];

export function Search({ params }) {
  const { settings } = useSettings();
  const q = (params.q ?? '').trim();
  const mode = (params.mode ?? settings.search.mode) === 'ask' ? 'ask' : 'keywords';
  const rerank = params.jev ? params.jev !== '0' : settings.search.rerank;
  const go = (value, nextMode = mode) => {
    if (value.trim()) location.hash = href('search', { ...params, q: value.trim(), mode: nextMode });
  };

  if (!q) return <SearchHome initialMode={settings.search.mode} onSubmit={go} />;

  return (
    <div className="thread">
      <div className="thread-body">
        <h1 className="thread-query">{q}</h1>
        <div className="thread-tabs">
          <nav aria-label="Result type">
            {MODES.map(([value, label, Icon]) => (
              <a key={value} className="thread-tab" href={href('search', { ...params, mode: value })} aria-current={mode === value ? 'page' : undefined}>
                <Icon size={16} aria-hidden="true" /> {label}
              </a>
            ))}
          </nav>
          {mode === 'keywords' && (
            <Toggle id="thread-rerank" label="Rerank with Jev" checked={rerank} onChange={(v) => (location.hash = href('search', { ...params, jev: v ? '1' : '0' }))} />
          )}
        </div>
        <Results q={q} mode={mode} rerank={rerank} params={params} />
      </div>
      <div className="followup">
        <AskBox key={q} initial={q} placeholder="Ask a follow-up or search again" onSubmit={(value) => go(value)} />
      </div>
    </div>
  );
}

function SearchHome({ initialMode, onSubmit }) {
  const [mode, setMode] = useState(initialMode);
  return (
    <div className="search-home">
      <div className="search-hero">
        <Logo size={84} />
        <h1>Pensieve</h1>
      </div>
      <AskBox big initial="" autoFocus placeholder="Ask memory anything, or look up a page" onSubmit={(value) => onSubmit(value, mode)}>
        <div className="modes" role="radiogroup" aria-label="Show">
          {MODES.map(([value, label, Icon]) => (
            <label key={value} className="mode">
              <input type="radio" name="search-mode-pick" value={value} checked={mode === value} onChange={() => setMode(value)} />
              <Icon size={15} aria-hidden="true" /> {label}
            </label>
          ))}
        </div>
      </AskBox>
      <p className="search-hint">
        <strong>Answer</strong> shows the passages an agent's recall would get, with their sources. <strong>Pages</strong> ranks whole pages by their words.
      </p>
    </div>
  );
}

function AskBox({ initial, big, autoFocus, placeholder, onSubmit, children }) {
  const [value, setValue] = useState(initial);
  const input = useRef(null);
  return (
    <form
      className={`ask-box${big ? ' big' : ''}`}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <div className="ask-field">
        <input
          ref={input}
          id="search-q"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Search memory"
          placeholder={placeholder}
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
      <div className="ask-bar">
        {children}
        <button type="submit" className="ask-submit" aria-label="Search" disabled={!value.trim()}>
          <ArrowRight size={18} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

function Results({ q, mode, rerank, params }) {
  const lock = useContext(AuthContext);
  // Results remember what they answer: for one render after a change, the previous results are still here.
  const key = `${mode}\n${rerank}\n${q}`;
  const [result, setResult] = useState({ loading: false, error: null, data: null, key: null });
  const [attempt, setAttempt] = useState(0);
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
  }, [q, mode, rerank, key, valid, lock, attempt]);

  if (!valid) return <p className="thread-note">Type a word or a name to search for.</p>;
  const fresh = result.key === key && !result.loading;
  return (
    <div className="thread-results" aria-busy={result.loading}>
      {result.loading && <Skeleton mode={mode} />}
      {result.error && fresh && <ErrorNote error={result.error} onRetry={() => setAttempt((n) => n + 1)} />}
      {result.data && fresh && (mode === 'ask' ? <Answer data={result.data} took={result.seconds} /> : <Hits data={result.data} took={result.seconds} q={q} params={params} />)}
    </div>
  );
}

function Skeleton({ mode }) {
  return (
    <div className="skeleton" role="status" aria-label={mode === 'ask' ? 'Recalling' : 'Searching'}>
      {mode === 'ask' && (
        <div className="skeleton-cards">
          <span />
          <span />
          <span />
          <span />
        </div>
      )}
      <span className="skeleton-line" />
      <span className="skeleton-line" />
      <span className="skeleton-line" />
      <span className="skeleton-line short" />
    </div>
  );
}

const seconds = (s) => `${s.toFixed(2)} seconds`;
const plural = (n, word) => `${formatNumber(n)} ${n === 1 ? word : `${word}s`}`;

function Answer({ data, took }) {
  // Sources are numbered by the first passage that cites them, like footnotes.
  const sources = useMemo(() => {
    const byTitle = new Map();
    for (const p of data.passages) {
      const source = byTitle.get(p.title) ?? { title: p.title, kind: p.kind, n: byTitle.size + 1, passages: 0 };
      source.passages++;
      byTitle.set(p.title, source);
    }
    return byTitle;
  }, [data]);

  return (
    <>
      {data.passages.length ? (
        <>
          <Sources sources={[...sources.values()]} />
          <section className="answer" aria-labelledby="answer-title">
            <h2 id="answer-title" className="thread-heading">
              <Sparkles size={17} aria-hidden="true" /> Answer
            </h2>
            <p className="thread-meta" role="status">
              What recall gives an agent: {plural(data.passages.length, 'passage')} · about {formatNumber(data.tokens)} tokens · ranked by{' '}
              {data.reranked ? 'Jev relevance' : 'BM25'} ({seconds(took)})
            </p>
            <ol className="passages">
              {data.passages.map((p) => (
                <li key={`${p.title}:${p.ord}`} className="passage">
                  <p className="passage-source">
                    <PageLink title={p.title}>
                      <span className="cite">{sources.get(p.title).n}</span>
                      {p.title}
                    </PageLink>
                    {p.heading && <span className="muted"> › {p.heading}</span>}
                    {data.reranked && <span className="mono muted"> · relevance {p.score.toFixed(2)}</span>}
                  </p>
                  <div className="prose">
                    <Markdown>{withoutTitle(p.text, p.title)}</Markdown>
                  </div>
                </li>
              ))}
            </ol>
            <div className="answer-actions">
              <CopyButton key={asMarkdown(data.passages)} text={asMarkdown(data.passages)} />
            </div>
          </section>
        </>
      ) : (
        <p className="thread-note">Nothing in memory answers this. Try other words, or look for a page title under Pages.</p>
      )}
      {data.leads.length > 0 && (
        <section className="related" aria-labelledby="related-title">
          <h2 id="related-title" className="thread-heading">
            <ListTree size={17} aria-hidden="true" /> Related pages
          </h2>
          <ul>
            {data.leads.map((t) => (
              <li key={t}>
                <PageLink title={t}>
                  <span>{t}</span>
                  <ArrowUpRight size={16} aria-hidden="true" />
                </PageLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Sources({ sources }) {
  const [all, setAll] = useState(false);
  const pageHref = usePageHref();
  const folded = !all && sources.length > 4;
  const shown = folded ? sources.slice(0, 3) : sources;
  return (
    <section className="sources" aria-labelledby="sources-title">
      <h2 id="sources-title" className="thread-heading">
        <Layers size={17} aria-hidden="true" /> Sources <span className="count">{sources.length}</span>
      </h2>
      <ol className="source-cards">
        {shown.map((s) => (
          <li key={s.title}>
            <a className="source-card" href={pageHref(s.title)}>
              <span className="source-title">{s.title}</span>
              <span className="source-meta">
                <span className="dot" style={{ background: KIND_COLORS[s.kind] ?? KIND_COLORS.untyped }} aria-hidden="true" />
                <span className="source-kind">
                  {s.kind ?? 'untyped'} · {plural(s.passages, 'passage')}
                </span>
                <span className="source-n">{s.n}</span>
              </span>
            </a>
          </li>
        ))}
        {folded && (
          <li>
            <button type="button" className="source-card more" onClick={() => setAll(true)}>
              <span className="source-title">+{sources.length - 3} more</span>
              <span className="source-meta">
                {sources.slice(3, 9).map((s) => (
                  <span key={s.title} className="dot" style={{ background: KIND_COLORS[s.kind] ?? KIND_COLORS.untyped }} aria-hidden="true" />
                ))}
              </span>
            </button>
          </li>
        )}
      </ol>
    </section>
  );
}

const asMarkdown = (passages) => passages.map((p) => `## ${p.title}${p.heading ? ` › ${p.heading}` : ''}\n\n${p.text.trim()}`).join('\n\n');

function CopyButton({ text }) {
  const [state, setState] = useState('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="ghost"
      // The clipboard API is missing outside HTTPS and localhost; that should read as a failed copy, not an error.
      onClick={() =>
        Promise.resolve()
          .then(() => navigator.clipboard.writeText(text))
          .then(
            () => setState('copied'),
            () => setState('failed'),
          )
      }
    >
      {state === 'copied' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span aria-live="polite">{state === 'copied' ? 'Copied' : state === 'failed' ? "Couldn't copy" : 'Copy passages'}</span>
    </button>
  );
}

function Hits({ data, took, q, params }) {
  if (!data.hits.length) {
    return (
      <div className="thread-note">
        <p>
          No pages match <strong>{q}</strong>.
        </p>
        <ul>
          <li>Try different or fewer words.</li>
          <li>
            Or <a href={href('search', { ...params, mode: 'ask' })}>see the answer</a>: recall matches sections rather than whole pages.
          </li>
        </ul>
      </div>
    );
  }
  return (
    <>
      <p className="thread-meta" role="status">
        {plural(data.hits.length, 'page')} · ranked by {data.reranked ? 'Jev relevance' : 'BM25'} ({seconds(took)})
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
      {data.hits.length === 30 && <p className="thread-note">Showing the 30 best matches. Add words to narrow the search.</p>}
    </>
  );
}
