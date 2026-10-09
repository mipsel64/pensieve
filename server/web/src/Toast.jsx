import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { copyText } from './clipboard.js';

const ToastContext = createContext(() => {});

/** Shows one short message at the bottom of the screen; a new message replaces the old one. */
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef(0);
  const show = useCallback((message, { error = false } = {}) => {
    clearTimeout(timer.current);
    setToast({ message, error, id: Math.random() });
    timer.current = setTimeout(() => setToast(null), 2400);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <p key={toast.id} className={`toast${toast.error ? ' error' : ''}`}>
            {toast.message}
          </p>
        )}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/** `copy(text, 'Link copied')` copies and tells the reader whether it worked. */
export function useCopy() {
  const toast = useToast();
  return useMemo(
    () => async (text, done) => {
      const ok = await copyText(text);
      toast(ok ? done : "Couldn't copy: the browser blocked it", { error: !ok });
    },
    [toast],
  );
}
