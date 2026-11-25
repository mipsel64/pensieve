import { defineTheme } from '@astryxdesign/core/theme';

const paper: [string, string] = ['#ffffff', '#181818'];
const chrome: [string, string] = ['#e8e8e8', '#282828'];
const ink: [string, string] = ['#181818', '#eeeeee'];
const secondary: [string, string] = ['#505050', '#c2c2c2'];
const blue: [string, string] = ['#1030ff', '#a4c5ff'];
const green: [string, string] = ['#008000', '#99d599'];

const typography = {
  '--font-family-body': 'sans-serif',
  '--font-family-heading': 'Helvetica, sans-serif',
  '--font-family-code': 'monospace, courier',
  '--text-heading-1-weight': 'var(--font-weight-normal)',
  '--text-heading-2-weight': 'var(--font-weight-normal)',
  '--text-heading-3-weight': 'var(--font-weight-normal)',
  '--text-heading-4-weight': 'var(--font-weight-normal)',
  '--text-heading-5-weight': 'var(--font-weight-normal)',
  '--text-heading-6-weight': 'var(--font-weight-normal)',
};

export const pensieveTheme = defineTheme({
  name: 'pensieve',
  tokens: {
    ...typography,
    '--color-background-body': paper,
    '--color-background-surface': paper,
    '--color-background-card': paper,
    '--color-background-popover': paper,
    '--color-background-muted': chrome,
    '--color-skeleton': chrome,
    '--color-text-primary': ink,
    '--color-icon-primary': ink,
    '--color-text-secondary': secondary,
    '--color-icon-secondary': secondary,
    '--color-text-disabled': secondary,
    '--color-icon-disabled': secondary,
    '--color-border': ['#adadad', '#666666'],
    '--color-border-emphasized': ['#666666', '#aaaaaa'],
    '--color-accent': blue,
    '--color-on-accent': paper,
    '--color-accent-muted': ['#e8edff', '#253447'],
    '--color-text-accent': blue,
    '--color-icon-accent': blue,
    '--focus-outline-color': blue,
    '--radius-inner': '0px',
    '--radius-element': '0px',
    '--radius-container': '0px',
    '--radius-page': '0px',
    '--shadow-low': 'none',
    '--shadow-med': 'none',
    '--shadow-high': 'none',
  },
  localTokens: {
    '--color-text-link': blue,
    '--color-text-manual-section': green,
  },
  components: {
    button: {
      base: { borderRadius: 'var(--radius-element)' },
      'variant:secondary': {
        border: '1px solid var(--color-border-emphasized)',
      },
    },
  },
  adaptations: {
    rules: [{
      when: { width: { below: 'lg' }, pointer: 'coarse' },
      value: { tokens: typography },
    }],
  },
});
