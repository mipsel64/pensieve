import { useState } from 'react';
import { Check, Copy, Loader2, LogOut, RotateCcw } from 'lucide-react';
import { ThemeSegmented } from './ThemeSwitch.jsx';
import { api } from './api.js';
import { Empty, ErrorNote, Loading, RelTime, useResource } from './ui.jsx';
import { useCopy } from './Toast.jsx';
import { ACCENTS, GraphControls, resetGraph, SEARCH_MODES, Toggle, useSettings } from './settings.jsx';

const MODE_LABELS = {
  ask: 'Answer: the passages recall would give an agent, with their sources',
  keywords: 'Pages: whole pages ranked by their words',
};

export function Settings({ oauth, onSignOut }) {
  const { settings, update, status, retry } = useSettings();
  const [signOutError, setSignOutError] = useState(null);

  return (
    <div className="view settings">
      <header className="view-header">
        <h1>Settings</h1>
        <p className="muted">Saved on the server, so every browser you sign in from uses them.</p>
      </header>
      <SaveStatus status={status} onRetry={retry} />

      <section className="card settings-section" aria-labelledby="appearance-title">
        <h2 id="appearance-title">Appearance</h2>
        <div className="appearance-row">
          <span id="theme-label">Theme</span>
          <ThemeSegmented labelledBy="theme-label" />
        </div>
        <p className="muted small">Saved in this browser only. System follows your device setting.</p>
        <fieldset className="swatches">
          <legend>Accent</legend>
          {Object.entries(ACCENTS).map(([id, { label }]) => (
            <label key={id} className="swatch">
              <input type="radio" name="accent" value={id} checked={settings.accent === id} onChange={() => update(null, { accent: id })} />
              <span className="swatch-color" style={{ background: `var(--accent-${id})` }} aria-hidden="true" />
              {label}
            </label>
          ))}
        </fieldset>
      </section>

      <section className="card settings-section" aria-labelledby="search-title">
        <h2 id="search-title">Search</h2>
        <fieldset className="choices">
          <legend>When you press Enter</legend>
          {SEARCH_MODES.map((id) => (
            <label key={id} className="choice">
              <input type="radio" name="search-mode" value={id} checked={settings.search.mode === id} onChange={() => update('search', { mode: id })} />
              {MODE_LABELS[id]}
            </label>
          ))}
        </fieldset>
        <Toggle id="settings-rerank" label="Rerank page results with Jev, when the server has a key" checked={settings.search.rerank} onChange={(v) => update('search', { rerank: v })} />
      </section>

      <section className="card settings-section" aria-labelledby="graph-title">
        <div className="settings-section-head">
          <h2 id="graph-title">Graph</h2>
          <button type="button" className="ghost" onClick={() => resetGraph(update)}>
            <RotateCcw size={15} aria-hidden="true" /> Restore defaults
          </button>
        </div>
        <div className="settings-columns">
          <div>
            <h3>Filters and groups</h3>
            <GraphControls section="filters" idPrefix="settings" />
            <GraphControls section="groups" idPrefix="settings" />
          </div>
          <div>
            <h3>Display</h3>
            <GraphControls section="display" idPrefix="settings" />
          </div>
          <div>
            <h3>Forces</h3>
            <GraphControls section="forces" idPrefix="settings" />
          </div>
        </div>
      </section>

      {oauth && (
        <>
          <ConnectedApps />
          <ApiTokens />
        </>
      )}

      <section className="card settings-section" aria-labelledby="session-title">
        <h2 id="session-title">Session</h2>
        <p className="muted">This browser stays signed in for 30 days. Signing out here doesn't affect other browsers or agents.</p>
        {signOutError && (
          <p className="field-error" role="alert">
            Couldn't sign out: {signOutError.message}
          </p>
        )}
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setSignOutError(null);
            onSignOut().catch(setSignOutError);
          }}
        >
          <LogOut size={16} aria-hidden="true" /> Sign out
        </button>
      </section>
    </div>
  );
}

function ConnectedApps() {
  const { data, error, loading, reload } = useResource('/grants');
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState(null);

  async function revoke(id) {
    setRevoking(id);
    setRevokeError(null);
    try {
      await api(`/grants/${encodeURIComponent(id)}`, { method: 'DELETE' });
      reload();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  return (
    <section className="card settings-section" aria-labelledby="connected-apps-title">
      <h2 id="connected-apps-title">Connected apps</h2>
      <p className="muted">Apps you approved can read and change all of Pensieve's memory.</p>
      {loading && !data && <Loading label="Loading connected apps" />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data?.length === 0 && <Empty>No connected apps.</Empty>}
      {data?.length > 0 && (
        <ul className="grant-list">
          {data.map((grant) => (
            <li className="grant" key={grant.id}>
              <div className="grant-details">
                <strong>{grant.client_name}</strong>
                <span className="muted">{grant.email}</span>
                <span className="muted small">
                  Approved <RelTime iso={grant.created_at} /> · Last refreshed <RelTime iso={grant.refreshed_at} />
                </span>
              </div>
              <button type="button" className="ghost" disabled={revoking !== null} onClick={() => revoke(grant.id)}>
                {revoking === grant.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {revokeError && (
        <p className="field-error" role="alert">
          Couldn't revoke the app: {revokeError.message}
        </p>
      )}
    </section>
  );
}

function ApiTokens() {
  const { data, error, loading, reload } = useResource('/tokens');
  const [revoking, setRevoking] = useState(null);
  const [revokeError, setRevokeError] = useState(null);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [created, setCreated] = useState(null);
  const copy = useCopy();

  async function revoke(id) {
    setRevoking(id);
    setRevokeError(null);
    try {
      await api(`/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setCreated((current) => (current?.id === id ? null : current));
      reload();
    } catch (err) {
      setRevokeError(err);
    } finally {
      setRevoking(null);
    }
  }

  async function create(event) {
    event.preventDefault();
    setCreating(true);
    setCreateError(null);
    try {
      const token = await api('/tokens', { method: 'POST', body: { name } });
      setCreated(token);
      setName('');
      reload();
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="card settings-section" aria-labelledby="api-tokens-title">
      <h2 id="api-tokens-title">API tokens</h2>
      <p className="muted">Tokens act like you on /api and /mcp until revoked. Use them for scripts and plugins such as pi-pensieve.</p>
      {loading && !data && <Loading label="Loading API tokens" />}
      {error && <ErrorNote error={error} onRetry={reload} />}
      {data?.length === 0 && <Empty>No API tokens.</Empty>}
      {data?.length > 0 && (
        <ul className="grant-list">
          {data.map((token) => (
            <li className="grant" key={token.id}>
              <div className="grant-details">
                <strong>{token.name}</strong>
                <span className="muted">{token.email}</span>
                <span className="muted small">
                  Created <RelTime iso={token.created_at} />
                </span>
              </div>
              <button type="button" className="ghost" disabled={revoking !== null} onClick={() => revoke(token.id)}>
                {revoking === token.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {revokeError && (
        <p className="field-error" role="alert">
          Couldn't revoke the API token: {revokeError.message}
        </p>
      )}
      <form className="api-token-form" onSubmit={create}>
        <label className="api-token-name" htmlFor="api-token-name">
          <span>Name</span>
          <span className="field">
            <input id="api-token-name" value={name} required maxLength={100} disabled={creating} onChange={(event) => setName(event.target.value)} />
          </span>
        </label>
        <button type="submit" className="primary" disabled={creating}>
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>
      {createError && (
        <p className="field-error" role="alert">
          {createError.message}
        </p>
      )}
      {created && (
        <div className="api-token-created">
          <label htmlFor="created-api-token">New API token</label>
          <div className="api-token-value">
            <span className="field">
              <input id="created-api-token" readOnly value={created.token} onFocus={(event) => event.target.select()} />
            </span>
            <button type="button" className="ghost" onClick={() => copy(created.token, 'API token copied')}>
              <Copy size={15} aria-hidden="true" /> Copy
            </button>
          </div>
          <p className="muted small">Copy it now. Pensieve shows it only once.</p>
        </div>
      )}
    </section>
  );
}

function SaveStatus({ status, onRetry }) {
  if (status.state === 'saving')
    return (
      <p className="save-status" role="status">
        <Loader2 className="spin" size={14} aria-hidden="true" /> Saving…
      </p>
    );
  if (status.state === 'saved')
    return (
      <p className="save-status" role="status">
        <Check size={14} aria-hidden="true" /> Saved
      </p>
    );
  if (status.state === 'error')
    return (
      <p className="save-status error" role="alert">
        Couldn't save: {status.error.message}{' '}
        <button type="button" className="ghost" onClick={onRetry}>
          Retry
        </button>
      </p>
    );
  return <p className="save-status" aria-hidden="true" />;
}
