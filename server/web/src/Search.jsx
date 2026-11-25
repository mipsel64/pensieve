import { useContext, useEffect, useState } from 'react';
import { api, query, Unauthorized } from './api.js';
import { href } from './router.js';
import { useCopy } from './Toast.jsx';
import { AuthContext, ErrorNote, formatNumber, Markdown, PageLink, RelTime } from './ui.jsx';
import { useSettings } from './settings.jsx';
import { withoutTitle } from './Page.jsx';
import './Search.css';

// The server drops everything but letters and digits, so `???` would otherwise list recent pages as matches.
const searchable = (q) => /[\p{L}\p{N}]/u.test(q);

const MODES = [
  ['ask', 'Answer'],
  ['keywords', 'Pages'],
];

export function Search({ params }) {
  const { settings } = useSettings();
  const q = (params.q ?? '').trim();
  const mode = (params.mode ?? settings.search.mode) === 'ask' ? 'ask' : 'keywords';
  const rerank = params.jev ? params.jev !== '0' : settings.search.rerank;
  const go = (value, nextMode) => {
    location.hash = href('search', { ...params, q: value, mode: nextMode });
  };

  return (
    <section className="search-view" aria-labelledby="search-title">
      <h1 id="search-title">{q || 'Search'}</h1>
      {q && (
        <nav className="search-navigation" aria-label="Result type">
          {MODES.map(([value, label]) => (
            <a key={value} href={href('search', { ...params, mode: value })} aria-current={mode === value ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
      )}
      <SearchForm key={q} q={q} mode={mode} onSubmit={go} />
      {q && mode === 'keywords' && (
        <label className="search-option" htmlFor="thread-rerank">
          <input
            id="thread-rerank"
            type="checkbox"
            checked={rerank}
            onChange={(event) => (location.hash = href('search', { ...params, jev: event.target.checked ? '1' : '0' }))}
          />
          Rerank with Jev
        </label>
      )}
      {q && <Results key={JSON.stringify([q, mode, rerank])} q={q} mode={mode} rerank={rerank} params={params} />}
    </section>
  );
}

function SearchForm({ q, mode, onSubmit }) {
  return (
    <search>
      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const value = data.get('q').trim();
          if (value) onSubmit(value, data.get('mode') ?? mode);
        }}
      >
        <label htmlFor="search-q">{q ? 'Follow-up query' : 'Query'}</label>
        <input
          id="search-q"
          name="q"
          type="search"
          defaultValue={q}
          autoFocus={!q}
          autoComplete="off"
          enterKeyHint="search"
          required
        />
        <button className="search-button" type="submit">Search</button>
        {!q && (
          <fieldset>
            <legend>Search mode</legend>
            {MODES.map(([value, label]) => (
              <label key={value} className="search-option" htmlFor={`search-mode-${value}`}>
                <input id={`search-mode-${value}`} type="radio" name="mode" value={value} defaultChecked={mode === value} />
                {label}
              </label>
            ))}
          </fieldset>
        )}
      </form>
    </search>
  );
}

function Results({ q, mode, rerank, params }) {
  const lock = useContext(AuthContext);
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const valid = searchable(q);

  useEffect(() => {
    if (!valid) return;
    let current = true;
    const started = performance.now();
    const path = mode === 'ask' ? `/recall${query({ q })}` : `/search${query({ q, limit: 30, rerank })}`;
    api(path)
      .then((data) => current && setResult({ data, attempt, seconds: (performance.now() - started) / 1000 }))
      .catch((error) => {
        if (!current) return;
        if (error instanceof Unauthorized) lock();
        setResult({ error, attempt });
      });
    return () => {
      current = false;
    };
  }, [q, mode, rerank, valid, lock, attempt]);

  if (!valid) return <p role="status">Type a word or a name to search for.</p>;
  if (result?.attempt !== attempt) return <p role="status">{mode === 'ask' ? 'Recalling…' : 'Searching…'}</p>;
  if (result.error) return <ErrorNote error={result.error} onRetry={() => setAttempt((n) => n + 1)} />;
  return mode === 'ask'
    ? <Answer data={result.data} took={result.seconds} />
    : <Hits data={result.data} took={result.seconds} q={q} params={params} />;
}

const seconds = (s) => `${s.toFixed(2)} seconds`;
const plural = (n, word) => `${formatNumber(n)} ${n === 1 ? word : `${word}s`}`;

function Answer({ data, took }) {
  const copy = useCopy();
  // Sources are numbered by the order in which the passages first cite them.
  const sources = new Map();
  for (const passage of data.passages) {
    let source = sources.get(passage.title);
    if (!source) {
      source = { title: passage.title, kind: passage.kind, number: sources.size + 1, passages: 0 };
      sources.set(passage.title, source);
    }
    source.passages++;
  }

  return (
    <>
      {sources.size > 0 && <Sources sources={[...sources.values()]} />}
      <section className="search-results" aria-labelledby="answer-title">
        <h2 id="answer-title">Answer</h2>
        {data.passages.length ? (
          <>
            <p className="search-note" role="status">
              {plural(data.passages.length, 'passage')} · about {formatNumber(data.tokens)} tokens · ranked by{' '}
              {data.reranked ? 'Jev relevance' : 'BM25'} ({seconds(took)})
            </p>
            {data.passages.map((p) => (
              <article key={`${p.title}:${p.ord}`} className="search-passage" aria-label={p.heading ? `${p.title}: ${p.heading}` : p.title}>
                <header className="search-citation">
                  [{sources.get(p.title).number}] <PageLink title={p.title} />
                  {p.heading && <> › {p.heading}</>}
                  {data.reranked && <> · relevance {p.score.toFixed(2)}</>}
                </header>
                <Markdown>{withoutTitle(p.text, p.title)}</Markdown>
              </article>
            ))}
            <button className="search-button" type="button" onClick={() => copy(asMarkdown(data.passages), 'Passages copied')}>
              Copy passages
            </button>
          </>
        ) : (
          <p role="status">Nothing in memory answers this. Try other words, or look for a title under Pages.</p>
        )}
      </section>
      {data.leads.length > 0 && (
        <section className="search-results" aria-labelledby="related-title">
          <h2 id="related-title">Related pages</h2>
          <ul className="search-related-list">
            {data.leads.map((title) => <li key={title}><PageLink title={title} /></li>)}
          </ul>
        </section>
      )}
    </>
  );
}

function Sources({ sources }) {
  const shown = sources.length > 4 ? 3 : sources.length;
  return (
    <section className="search-results" aria-labelledby="sources-title">
      <h2 id="sources-title">Sources</h2>
      <SourceList sources={sources.slice(0, shown)} start={1} />
      {shown < sources.length && (
        <details>
          <summary>{sources.length - shown} more sources</summary>
          <SourceList sources={sources.slice(shown)} start={shown + 1} />
        </details>
      )}
    </section>
  );
}

function SourceList({ sources, start }) {
  return (
    <ol className="search-source-list" start={start}>
      {sources.map((source) => (
        <li key={source.title}>
          <PageLink title={source.title} />{' '}
          <small className="search-note">({source.kind ?? 'untyped'} · {plural(source.passages, 'passage')})</small>
        </li>
      ))}
    </ol>
  );
}

const asMarkdown = (passages) => passages.map((p) => `## ${p.title}${p.heading ? ` › ${p.heading}` : ''}\n\n${p.text.trim()}`).join('\n\n');

function Hits({ data, took, q, params }) {
  return (
    <section className="search-results" aria-labelledby="pages-title">
      <h2 id="pages-title">Pages</h2>
      {data.hits.length ? (
        <>
          <p className="search-note" role="status">
            {plural(data.hits.length, 'page')} · ranked by {data.reranked ? 'Jev relevance' : 'BM25'} ({seconds(took)})
          </p>
          <ul className="search-hits" role="list">
            {data.hits.map((hit) => (
              <li key={hit.title}>
                <h3><PageLink title={hit.title} /></h3>
                <p className="search-note">
                  {hit.kind ?? 'untyped'} · rev {hit.rev} · updated <RelTime iso={hit.updated_at} />
                  {data.reranked && <> · relevance {hit.score.toFixed(2)}</>}
                </p>
                <p>
                  {hit.snippet.split(/[«»]/).map((part, i) => (i % 2 ? <strong key={i}>{part}</strong> : part))}
                </p>
              </li>
            ))}
          </ul>
          {data.hits.length === 30 && <p className="search-note">Showing the 30 best matches. Add words to narrow the search.</p>}
        </>
      ) : (
        <>
          <p role="status">No pages match “{q}”. Try different or fewer words.</p>
          <a href={href('search', { ...params, mode: 'ask' })}>See the answer</a>
        </>
      )}
    </section>
  );
}
