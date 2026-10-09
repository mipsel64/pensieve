import { useLayoutEffect, useRef } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal dialog: focus moves in, Tab stays inside, Escape or a click outside closes it, and focus returns to where it was. */
export function Modal({ label, onClose, className = '', children }) {
  const box = useRef(null);

  useLayoutEffect(() => {
    const opener = document.activeElement;
    const target = box.current.querySelector('[data-autofocus]') ?? box.current.querySelector(FOCUSABLE) ?? box.current;
    target.focus();
    return () => {
      if (opener && opener !== document.body && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event) => {
    if (event.key === 'Escape') {
      // Stops the page panel behind the dialog from closing on the same key.
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...box.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={box} className={`dialog ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  );
}
