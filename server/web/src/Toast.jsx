import { createContext, useCallback, useContext, useMemo } from 'react';
import { useToast as useAstryxToast } from '@astryxdesign/core/Toast';
import { copyText } from './clipboard.js';

const ToastContext = createContext(() => {});

/** Shows one short message at the bottom of the screen; a new message replaces the old one. */
export function ToastProvider({ children }) {
  const showToast = useAstryxToast();
  const show = useCallback(
    (message, { error = false } = {}) => {
      showToast({
        body: message,
        type: error ? 'error' : 'info',
        isAutoHide: true,
        autoHideDuration: 2400,
        uniqueID: 'pensieve-notice',
        collisionBehavior: 'overwrite',
      });
    },
    [showToast],
  );
  return <ToastContext.Provider value={show}>{children}</ToastContext.Provider>;
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
