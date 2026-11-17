import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveTheme} from '../pensieve/pensieve.theme';

// Accent shades from `astryx experimental theme editor` with --accent #9aa1a7 and the Pensieve neutral.
export const pensieveSilverTheme = defineTheme({
  extends: pensieveTheme,
  name: 'pensieve-silver',
  tokens: {
    '--color-accent': ['#9aa1a7', '#9aa1a7'],
    '--color-on-accent': ['#141008', '#141109'],
    '--color-accent-muted': ['#d0d5da', '#43474b'],
    '--color-text-accent': ['#4d5358', '#c2c8cc'],
    '--color-icon-accent': ['#4d5358', '#c2c8cc'],
    '--focus-outline-color': ['#7f868b', '#9aa1a7'],
  },
});
