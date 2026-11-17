import { pensieveTheme } from './themes/pensieve/pensieve.js';
import { pensieveSilverTheme } from './themes/accents/pensieve-silver.js';
import { pensieveMoonlightTheme } from './themes/accents/pensieve-moonlight.js';
import { pensieveLavenderTheme } from './themes/accents/pensieve-lavender.js';
import { pensieveEmberTheme } from './themes/accents/pensieve-ember.js';
import './themes/pensieve/pensieve.css';
import './themes/accents/pensieve-silver.css';
import './themes/accents/pensieve-moonlight.css';
import './themes/accents/pensieve-lavender.css';
import './themes/accents/pensieve-ember.css';

// Sea glass is the editor's base theme; the others extend it from themes/accents (npm run themes rebuilds them).
export const ACCENT_THEMES = {
  silver: pensieveSilverTheme,
  seaglass: pensieveTheme,
  moonlight: pensieveMoonlightTheme,
  lavender: pensieveLavenderTheme,
  ember: pensieveEmberTheme,
};
