import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';

const CloseContext = createContext(() => {});
const ITEMS = '[role^="menuitem"]:not([disabled])';

/** An icon button that opens a small menu of actions. Arrow keys move, Escape closes and returns focus to the button. */
export function Menu({ label, icon: Icon = MoreHorizontal, className = '', children }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const trigger = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const items = [...root.current.querySelectorAll(ITEMS)];
    (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    const onPointer = (event) => !root.current?.contains(event.target) && setOpen(false);
    addEventListener('pointerdown', onPointer);
    return () => removeEventListener('pointerdown', onPointer);
  }, [open]);

  const onKeyDown = (event) => {
    if (!open) {
      if (event.key === 'ArrowDown' && event.target === trigger.current) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    const items = [...root.current.querySelectorAll(ITEMS)];
    const at = items.indexOf(document.activeElement);
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (next === undefined || !items.length) return;
    event.preventDefault();
    items[(next + items.length) % items.length].focus();
  };

  return (
    <div ref={root} className={`menu ${className}`} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon size={17} aria-hidden="true" />
      </button>
      {open && (
        <CloseContext.Provider
          value={() => {
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <div id={menuId} className="popover menu-list" role="menu" aria-label={label}>
            {children}
          </div>
        </CloseContext.Provider>
      )}
    </div>
  );
}

/** A link (`href`) or a button (`onSelect`) in a menu; `checked` makes it a radio choice. Selecting closes the menu. */
export function MenuItem({ icon: Icon, hint, checked, href, onSelect, children }) {
  const close = useContext(CloseContext);
  const radio = checked !== undefined;
  const props = {
    className: 'menu-item',
    role: radio ? 'menuitemradio' : 'menuitem',
    'aria-checked': radio ? checked : undefined,
    tabIndex: -1,
    onClick: () => {
      close();
      onSelect?.();
    },
  };
  const body = (
    <>
      {Icon && <Icon size={16} aria-hidden="true" />}
      <span>{children}</span>
      {hint && <kbd>{hint}</kbd>}
      {checked && <Check className="menu-check" size={15} aria-hidden="true" />}
    </>
  );
  return href ? (
    <a href={href} {...props}>
      {body}
    </a>
  ) : (
    <button type="button" {...props}>
      {body}
    </button>
  );
}

export function MenuLabel({ children }) {
  return (
    <p className="menu-label" role="presentation">
      {children}
    </p>
  );
}

export function MenuSeparator() {
  return <hr className="menu-separator" role="separator" />;
}
