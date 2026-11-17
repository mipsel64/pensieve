import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveTheme} from '../pensieve/pensieve.theme';

// Accent shades from `astryx experimental theme editor` with --accent #7b98bd and the Pensieve neutral.
export const pensieveMoonlightTheme = defineTheme({
  extends: pensieveTheme,
  name: 'pensieve-moonlight',
  tokens: {
    '--color-accent': ['#7b98bd', '#7b98bd'],
    '--color-on-accent': ['#141008', '#141109'],
    '--color-accent-muted': ['#b8d7ff', '#16477f'],
    '--color-text-accent': ['#0f5299', '#a3cafc'],
    '--color-icon-accent': ['#0f5299', '#a3cafc'],
    '--focus-outline-color': ['#6a8ab5', '#7b98bd'],
  },
});
