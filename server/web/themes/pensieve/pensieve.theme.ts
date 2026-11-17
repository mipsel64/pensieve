// The pensieve theme. `astryx experimental theme editor` wrote this file once and never changes it again.
// The checked settings live in pensieve.settings.json and the generated pensieve.settings.ts;
// change them with `astryx experimental theme editor set pensieve ...`. Add your own changes below: they win over the settings.
import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveSettings} from './pensieve.settings';

const HEADING_WEIGHTS = {
  '--text-heading-1-weight': 'var(--font-weight-normal)',
  '--text-heading-2-weight': 'var(--font-weight-normal)',
  '--text-heading-3-weight': 'var(--font-weight-normal)',
  '--text-heading-4-weight': 'var(--font-weight-normal)',
  '--text-heading-5-weight': 'var(--font-weight-normal)',
  '--text-heading-6-weight': 'var(--font-weight-normal)',
};

export const pensieveTheme = defineTheme({
  extends: pensieveSettings,
  name: 'pensieve',
  typography: {
    heading: {
      family: 'Iowan Old Style',
      fallbacks: 'Palatino Linotype, Book Antiqua, Georgia, serif',
    },
  },
  tokens: {
    '--color-background-body': ['#f5f4ed', '#111111'],
    '--color-background-surface': ['#faf9f5', '#151515'],
    '--color-background-card': ['#f5f4ed', '#20201f'],
    '--color-background-popover': ['#faf9f5', '#20201f'],
    '--color-background-muted': ['#f0eee6', '#212121'],
    '--color-text-primary': ['#141413', '#f0efec'],
    '--color-text-secondary': ['#6b6a65', '#c3c2b8'],
    '--color-text-disabled': ['#6b6a65', '#898781'],
    '--color-icon-primary': ['#141413', '#f0efec'],
    '--color-icon-secondary': ['#6b6a65', '#c3c2b8'],
    '--color-icon-disabled': ['#6b6a65', '#898781'],
    '--color-border': ['#e3e1d9', '#292929'],
    '--color-border-emphasized': ['#6b6a65', '#898781'],
    '--color-skeleton': ['#f0eee6', '#292929'],
    '--color-accent': ['#c6613f', '#d97757'],
    '--color-on-accent': ['#141413', '#141413'],
    '--color-accent-muted': ['#f0ddd3', '#4a2d24'],
    '--color-text-accent': ['#9e4a2f', '#d97757'],
    '--color-icon-accent': ['#9e4a2f', '#d97757'],
    '--focus-outline-color': ['#c6613f', '#d97757'],
    '--radius-container': '16px',
    '--radius-page': '0px',
    ...HEADING_WEIGHTS,
  },
  components: {
    'top-nav-heading': {
      base: {
        fontFamily: 'var(--font-family-heading)',
        fontSize: '1.25rem',
        fontWeight: 400,
      },
    },
    'side-nav-item': {
      base: { borderRadius: '8px' },
      selected: { backgroundColor: 'var(--color-background-muted)' },
    },
    item: {
      selected: { '--color-text-secondary': 'light-dark(#3d3d3a, #c3c2b8)' },
    },
    'segmented-control-item': {
      base: { '--color-text-secondary': 'light-dark(#3d3d3a, #c3c2b8)' },
    },
  },
  adaptations: {
    rules: [
      {
        when: { width: { below: 'lg' }, pointer: 'coarse' },
        value: { tokens: HEADING_WEIGHTS },
      },
    ],
  },
});
