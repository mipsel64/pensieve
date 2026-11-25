import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pensieveManualTheme } from '../src/themes/accents/pensieve-manual.js';

// The theme build emits sRGB hex colors, either alone or as a light-dark() pair.
function luminance(token, mode) {
  const key = `--color-${token}`;
  const value = pensieveManualTheme.tokens[key] ?? pensieveManualTheme.localTokens[key];
  const pair = /^light-dark\((#[\da-f]+),\s*(#[\da-f]+)\)$/i.exec(value);
  const color = pair ? pair[mode === 'light' ? 1 : 2] : value;
  assert.match(color, /^#(?:[\da-f]{3}|[\da-f]{6})$/i, `${token}: ${color}`);
  const hex = color.length === 4 ? color.slice(1).replace(/./g, '$&$&') : color.slice(1);
  const [r, g, b] = hex.match(/../g).map((s) => {
    const c = parseInt(s, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const mode of ['light', 'dark']) {
  test(`Manual text and primary controls have sufficient contrast in ${mode} mode`, () => {
    for (const [foreground, background, minimum] of [
      ['text-primary', 'background-body', 4.5],
      ['text-secondary', 'background-body', 4.5],
      ['text-link', 'background-body', 4.5],
      ['text-manual-section', 'background-body', 4.5],
      ['accent', 'background-body', 3], // Large page titles; small text needs 4.5:1.
      ['on-accent', 'accent', 4.5],
    ]) {
      const a = luminance(foreground, mode), b = luminance(background, mode);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      assert.ok(ratio >= minimum, `${foreground} on ${background}: ${ratio.toFixed(2)}:1 (needs ${minimum}:1)`);
    }
  });
}
