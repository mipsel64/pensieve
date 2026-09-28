import { useState } from 'react';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { login, Unauthorized } from './api.js';
import { Logo } from './ui.jsx';

export function Login({ onSuccess }) {
  const [token, setToken] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(token.trim());
      onSuccess();
    } catch (err) {
      setError(err instanceof Unauthorized ? "That token doesn't match the server's." : `Couldn't reach the server: ${err.message}`);
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="login-card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <Logo size={40} />
          <h1>Pensieve</h1>
          <p className="muted">Shared memory for your agents</p>
        </div>
        <label htmlFor="token">Server token</label>
        <div className={`field${error ? ' invalid' : ''}`}>
          <input
            id="token"
            type={visible ? 'text' : 'password'}
            autoComplete="current-password"
            spellCheck="false"
            autoFocus
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'token-error token-help' : 'token-help'}
          />
          <button type="button" className="icon-button" onClick={() => setVisible((v) => !v)} aria-label={visible ? 'Hide token' : 'Show token'}>
            {visible ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          </button>
        </div>
        {error && (
          <p id="token-error" className="field-error" role="alert">
            {error}
          </p>
        )}
        <p id="token-help" className="help">
          It's <code>server.token</code> in <code>~/.config/pensieve/config.toml</code> on the server. You stay signed in on this browser for 30 days.
        </p>
        <button className="primary" disabled={busy || !token.trim()}>
          {busy && <Loader2 className="spin" size={16} aria-hidden="true" />}
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
