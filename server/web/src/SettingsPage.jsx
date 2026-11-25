import { useState } from 'react';
import { api, Unauthorized } from './api.js';
import { RelTime, useResource } from './ui.jsx';
import { useCopy } from './Toast.jsx';
import { SEARCH_MODES, useSettings } from './settings.jsx';
import './SettingsPage.css';

const MODE_LABELS = {
  ask: 'Answer (passages with sources)',
  keywords: 'Pages (keyword matches)',
};

export function Settings({ oauth, onSignOut }) {
  const { settings, update, status, retry } = useSettings();
  const [signOutError, setSignOutError] = useState(null);

  return (
    <div className="settings-page">
      <h1>Settings</h1>
      <section aria-labelledby="search-title">
        <h2 id="search-title">Search options</h2>
        <fieldset>
          <legend>Default search mode</legend>
          {SEARCH_MODES.map((mode) => (
            <div key={mode}>
              <input
                type="radio"
                id={`search-mode-${mode}`}
                name="search-mode"
                value={mode}
                checked={settings.search.mode === mode}
                onChange={() => update('search', { mode })}
              />{' '}
              <label htmlFor={`search-mode-${mode}`}>{MODE_LABELS[mode]}</label>
            </div>
          ))}
        </fieldset>
        <p>
          <input
            type="checkbox"
            id="settings-rerank"
            checked={settings.search.rerank}
            onChange={(event) => update('search', { rerank: event.target.checked })}
          />{' '}
          <label htmlFor="settings-rerank">Rerank page results with Jev (when available)</label>
        </p>
        <SaveStatus status={status} onRetry={retry} />
      </section>
      {oauth && (
        <>
          <ApiTokens />
          <ConnectedApps />
        </>
      )}
      {signOutError && <InlineError title="Couldn't sign out" message={signOutError.message} />}
      <p>
        <button
          type="button"
          onClick={() => {
            setSignOutError(null);
            onSignOut().catch(setSignOutError);
          }}
        >
          Sign out
        </button>
      </p>
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
    <section aria-labelledby="connected-apps-title">
      <h2 id="connected-apps-title">Connected apps</h2>
      <p>Approved apps can read and change your memory.</p>
      {loading && !data && <p role="status">Loading connected apps…</p>}
      {error && !(error instanceof Unauthorized) && <InlineError title="Couldn't load connected apps" message={error.message} onRetry={reload} />}
      {data?.length === 0 && <p>No connected apps.</p>}
      {data?.length > 0 && (
        <ul>
          {data.map((grant) => (
            <li key={grant.id}>
              <strong>{grant.client_name}</strong> · {grant.email}
              <br />
              Approved <RelTime iso={grant.created_at} /> · Last refreshed <RelTime iso={grant.refreshed_at} />{' '}
              <button
                type="button"
                disabled={revoking !== null}
                aria-label={`${revoking === grant.id ? 'Revoking' : 'Revoke'} ${grant.client_name}`}
                onClick={() => revoke(grant.id)}
              >
                {revoking === grant.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {revokeError && <InlineError title="Couldn't revoke the app" message={revokeError.message} />}
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
    <section aria-labelledby="api-tokens-title">
      <h2 id="api-tokens-title">API tokens</h2>
      <p>Sign in with Google to create a token for a script or plugin.</p>
      {loading && !data && <p role="status">Loading API tokens…</p>}
      {error && !(error instanceof Unauthorized) && <InlineError title="Couldn't load API tokens" message={error.message} onRetry={reload} />}
      {data?.length === 0 && <p>No API tokens.</p>}
      {data?.length > 0 && (
        <ul>
          {data.map((token) => (
            <li key={token.id}>
              <strong>{token.name}</strong> · {token.email}
              <br />
              Created <RelTime iso={token.created_at} />{' '}
              <button
                type="button"
                disabled={revoking !== null}
                aria-label={`${revoking === token.id ? 'Revoking' : 'Revoke'} ${token.name}`}
                onClick={() => revoke(token.id)}
              >
                {revoking === token.id ? 'Revoking…' : 'Revoke'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {revokeError && <InlineError title="Couldn't revoke the API token" message={revokeError.message} />}
      <form method="post" onSubmit={create}>
        <label htmlFor="api-token-name">Token name (required)</label>
        <br />
        <input
          type="text"
          id="api-token-name"
          name="name"
          required
          maxLength={100}
          disabled={creating}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />{' '}
        <button type="submit" disabled={creating}>
          {creating ? 'Creating…' : 'Create token'}
        </button>
      </form>
      {createError && <InlineError title="Couldn't create the API token" message={createError.message} />}
      {created && (
        <p>
          <label htmlFor="created-api-token">New API token</label>
          <br />
          <input
            type="text"
            id="created-api-token"
            readOnly
            value={created.token}
            onFocus={(event) => event.target.select()}
            aria-describedby="created-token-note"
          />{' '}
          <button type="button" onClick={() => copy(created.token, 'API token copied')}>
            Copy
          </button>
          <br />
          <small id="created-token-note">Copy it now. Pensieve shows it only once.</small>
        </p>
      )}
    </section>
  );
}

function InlineError({ title, message, onRetry }) {
  return (
    <p role="alert">
      <strong>{title}:</strong> {message}{' '}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </p>
  );
}

function SaveStatus({ status, onRetry }) {
  if (status.state === 'saving') return <p role="status">Saving…</p>;
  if (status.state === 'saved') return <p role="status">Saved</p>;
  if (status.state === 'error') return <InlineError title="Couldn't save settings" message={status.error.message} onRetry={onRetry} />;
  return null;
}
