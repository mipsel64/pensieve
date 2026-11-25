import {defineTheme} from '@astryxdesign/core/theme';
import {pensieveTheme} from '../pensieve/pensieve.theme';

const PAPER: [string, string] = ['#fcfcf8', '#181c1a'];
const INK: [string, string] = ['#20231e', '#edf1eb'];
const SECONDARY: [string, string] = ['#555d57', '#adb7ae'];
const WASH: [string, string] = ['#edf1ea', '#1e2620'];
const LINK: [string, string] = ['#164ca3', '#a4c5ff'];
const GREEN_INK: [string, string] = ['#006e00', '#9ad09a'];

const FONTS = {
  '--font-family-body': 'system-ui, sans-serif',
  '--font-family-heading': 'var(--font-family-body)',
  '--font-family-code': 'ui-monospace, SFMono-Regular, Consolas, monospace',
};

export const pensieveManualTheme = defineTheme({
  extends: pensieveTheme,
  name: 'pensieve-manual',
  tokens: {
    '--color-background-body': PAPER,
    '--color-background-surface': PAPER,
    '--color-background-card': PAPER,
    '--color-background-popover': PAPER,
    '--color-background-muted': WASH,
    '--color-skeleton': WASH,
    '--color-text-primary': INK,
    '--color-icon-primary': INK,
    '--color-text-secondary': SECONDARY,
    '--color-icon-secondary': SECONDARY,
    '--color-text-disabled': SECONDARY,
    '--color-icon-disabled': SECONDARY,
    '--color-border': ['#cbd1c8', '#404c44'],
    '--color-border-emphasized': ['#757d75', '#8e9a90'],
    '--color-accent': '#008000',
    '--color-on-accent': '#ffffff',
    '--color-accent-muted': WASH,
    // Filled actions and large titles keep the exact green; small text needs more contrast.
    '--color-text-accent': GREEN_INK,
    '--color-icon-accent': GREEN_INK,
    '--focus-outline-color': LINK,
    ...FONTS,
    '--size-element-sm': '28px',
    '--size-element-md': '34px',
    '--size-element-lg': '40px',
    '--radius-inner': '2px',
    '--radius-element': '3px',
    '--radius-container': '3px',
    '--shadow-low': 'none',
  },
  localTokens: {
    '--color-text-link': LINK,
    '--color-text-manual-section': ['#873327', '#efa99c'],
    '--font-family-manual-serif': 'Georgia, "Times New Roman", serif',
  },
  components: {
    button: {
      'variant:secondary': {
        backgroundColor: 'var(--color-background-surface)',
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: 'var(--color-border-emphasized)',
      },
    },
  },
  adaptations: {
    rules: [{
      when: { pointer: 'coarse' },
      value: {
        tokens: {
          ...FONTS,
          '--size-element-sm': '36px',
          '--size-element-md': '40px',
          '--size-element-lg': '44px',
        },
      },
    }],
  },
});
