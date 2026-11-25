import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pensieveTheme } from '../src/themes/pensieve/pensieve.js';

const tokens = { ...pensieveTheme.tokens, ...pensieveTheme.localTokens };

function luminance(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map((pair) => {
    const srgb = parseInt(pair, 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function colorPair(token) {
  const pair = /^light-dark\((#[\da-f]{6}), (#[\da-f]{6})\)$/.exec(tokens[token]);
  assert.ok(pair, `${token} must define a light and dark color`);
  return pair.slice(1);
}

function assertContrast(foreground, background, minimum) {
  const against = colorPair(background);
  for (const [index, color] of colorPair(foreground).entries()) {
    const values = [luminance(color), luminance(against[index])];
    const ratio = (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
    assert.ok(ratio >= minimum, `${foreground} on ${background} in ${index ? 'dark' : 'light'}: ${ratio.toFixed(2)} < ${minimum}`);
  }
}

test('text, links, and controls maintain contrast in both system schemes', () => {
  const paper = '--color-background-surface';
  for (const background of [paper, '--color-background-card', '--color-background-popover', '--color-background-muted', '--color-accent-muted']) {
    for (const foreground of ['--color-text-primary', '--color-text-secondary', '--color-text-link']) {
      assertContrast(foreground, background, 4.5);
    }
    assertContrast('--focus-outline-color', background, 3);
    assertContrast('--color-border-emphasized', background, 3);
  }
  assertContrast('--color-text-manual-section', paper, 4.5);
  assertContrast('--color-on-accent', '--color-accent', 4.5);
});
