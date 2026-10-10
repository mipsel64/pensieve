import { useRef } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { THEME_CHOICES, useTheme } from './theme.js';

export const THEME_OPTIONS = {
  system: { label: 'System', Icon: Monitor },
  light: { label: 'Light', Icon: Sun },
  dark: { label: 'Dark', Icon: Moon },
};

/** System, Light and Dark as one radio group; arrow keys move and select. */
export function ThemeSegmented({ labels = true, labelledBy }) {
  const { preference, setPreference } = useTheme();
  const group = useRef(null);

  function onKeyDown(event) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    const target = step
      ? THEME_CHOICES[(THEME_CHOICES.indexOf(preference) + step + THEME_CHOICES.length) % THEME_CHOICES.length]
      : { Home: THEME_CHOICES[0], End: THEME_CHOICES.at(-1) }[event.key];
    if (!target) return;
    event.preventDefault();
    setPreference(target);
    group.current?.querySelector(`[data-choice="${target}"]`)?.focus();
  }

  return (
    <div ref={group} className="segmented" role="radiogroup" aria-label={labelledBy ? undefined : 'Appearance'} aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {THEME_CHOICES.map((choice) => {
        const { label, Icon } = THEME_OPTIONS[choice];
        const checked = preference === choice;
        return (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={labels ? undefined : label}
            data-choice={choice}
            tabIndex={checked ? 0 : -1}
            title={label}
            onClick={() => setPreference(choice)}
          >
            <Icon size={15} aria-hidden="true" />
            {labels && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
