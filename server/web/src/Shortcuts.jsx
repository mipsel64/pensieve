import { useEffect, useId, useRef } from 'react';
import { Modal } from './Overlay.jsx';
import { resolveKey, SHORTCUT_GROUPS } from './shortcuts.js';

const typingIn = (el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || Boolean(el?.isContentEditable);

/** Global keyboard shortcuts. `on[type]` handlers run for the actions `resolveKey` names; `g` waits 1.5 seconds for its second key. */
export function useShortcuts(handlers) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    let pending = null;
    let timer = 0;
    const onKey = (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      const result = resolveKey(event, pending, typingIn(document.activeElement));
      pending = result.pending;
      clearTimeout(timer);
      if (pending) timer = setTimeout(() => (pending = null), 1500);
      if (!result.action && !result.pending) return;
      const handler = latest.current[result.action?.type];
      if (result.action && !handler) return;
      event.preventDefault();
      handler?.(result.action);
    };
    addEventListener('keydown', onKey);
    return () => {
      removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, []);
}

function Keys({ keys }) {
  return (
    <span className="keys">
      {keys.map((key, i) => (
        <span key={i}>
          {i > 0 && keys[0] === 'g' && <span className="then"> then </span>}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  );
}

export function ShortcutsHelp({ modifier, onClose }) {
  const ids = useId();
  return (
    <Modal label="Keyboard shortcuts" onClose={onClose} className="shortcuts">
      <header className="dialog-header">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="ghost" data-autofocus onClick={onClose}>
          Close
        </button>
      </header>
      <div className="shortcut-groups">
        {SHORTCUT_GROUPS(modifier).map((group, index) => (
          <section key={group.title} aria-labelledby={`${ids}-${index}`}>
            <h3 id={`${ids}-${index}`}>{group.title}</h3>
            <dl>
              {group.items.map((item) => (
                <div key={item.label}>
                  <dt>
                    <Keys keys={item.keys} />
                  </dt>
                  <dd>{item.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="muted small dialog-note">Shortcuts pause while you type in a field.</p>
    </Modal>
  );
}
