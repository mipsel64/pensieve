import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveTheme} from '../pensieve/pensieve.theme';

// Accent shades from `astryx experimental theme editor` with --accent #9d88bd and the Pensieve neutral.
export const pensieveLavenderTheme = defineTheme({
  extends: pensieveTheme,
  name: 'pensieve-lavender',
  tokens: {
    '--color-accent': ['#9d88bd', '#9d88bd'],
    '--color-on-accent': ['#141008', '#141109'],
    '--color-accent-muted': ['#dec9ff', '#523773'],
    '--color-text-accent': ['#6d4a97', '#d1baf6'],
    '--color-icon-accent': ['#6d4a97', '#d1baf6'],
    '--focus-outline-color': ['#907ab3', '#9d88bd'],
  },
});
