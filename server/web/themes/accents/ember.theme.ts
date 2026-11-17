import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveTheme} from '../pensieve/pensieve.theme';

// Accent shades from `astryx experimental theme editor` with --accent #c9763f and the Pensieve neutral.
export const pensieveEmberTheme = defineTheme({
  extends: pensieveTheme,
  name: 'pensieve-ember',
  tokens: {
    '--color-accent': ['#c9763f', '#c9763f'],
    '--color-on-accent': ['#141008', '#141109'],
    '--color-accent-muted': ['#ffc7a5', '#752e00'],
    '--color-text-accent': ['#974206', '#feb283'],
    '--color-icon-accent': ['#974206', '#feb283'],
    '--focus-outline-color': ['#c9763f', '#c9763f'],
  },
});
