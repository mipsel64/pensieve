import { useState } from 'react';
import { Check, Loader2, LogOut, RotateCcw } from 'lucide-react';
import { ThemeSegmented } from './ThemeSwitch.jsx';
import { ACCENTS, GraphControls, resetGraph, SEARCH_MODES, Toggle, useSettings } from './settings.jsx';

const MODE_LABELS = {
  ask: 'Answer: the passages recall would give an agent, with their sources',
  keywords: 'Pages: whole pages ranked by their words',
};

export function Settings({ onSignOut }) {
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
