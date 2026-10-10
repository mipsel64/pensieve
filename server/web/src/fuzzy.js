const GAP_PENALTY = 3;
const CONSECUTIVE_BONUS = 10;
const BOUNDARY_BONUS = 8;
const BOUNDARY = /[\s\-_/.:#()[\]]/;

/** Fuzzy subsequence match of `query` in `text`: `{ score, indices }` (code point positions), or null when it does not match. */
export function fuzzyMatch(query, text) {
  const needle = [...query.toLowerCase()].filter((c) => !/\s/.test(c));
  if (!needle.length) return { score: 0, indices: [] };
  const chars = [...text];
  const hay = chars.map((c) => c.toLowerCase());
  const n = needle.length;
  const m = hay.length;
  if (n > m) return null;

  // best[i][j]: highest score with needle[i] matched at hay[j]; from[i][j]: where needle[i - 1] matched.
  const best = Array.from({ length: n }, () => new Float64Array(m).fill(-Infinity));
  const from = Array.from({ length: n }, () => new Int32Array(m).fill(-1));
  for (let i = 0; i < n; i++) {
    // Best earlier match that leaves a gap: updated one step behind, so a consecutive match is never counted as a gap.
    let gapBest = -Infinity;
    let gapAt = -1;
    for (let j = 0; j < m; j++) {
      if (i > 0 && j >= 2 && best[i - 1][j - 2] > gapBest) {
        gapBest = best[i - 1][j - 2];
        gapAt = j - 2;
      }
      if (hay[j] !== needle[i]) continue;
      const boundary = j === 0 || BOUNDARY.test(chars[j - 1]) || (chars[j - 1] === chars[j - 1].toLowerCase() && chars[j] !== chars[j].toLowerCase());
      const here = 1 + (boundary ? BOUNDARY_BONUS : 0);
      if (i === 0) {
        best[i][j] = here - Math.min(j, 10) * 0.3;
        continue;
      }
      const consecutive = j >= 1 ? best[i - 1][j - 1] + CONSECUTIVE_BONUS : -Infinity;
      const gapped = gapBest - GAP_PENALTY;
      if (consecutive === -Infinity && gapped === -Infinity) continue;
      if (consecutive >= gapped) {
        best[i][j] = consecutive + here;
        from[i][j] = j - 1;
      } else {
        best[i][j] = gapped + here;
        from[i][j] = gapAt;
      }
    }
  }

  let end = -1;
  for (let j = 0; j < m; j++) if (best[n - 1][j] > (end < 0 ? -Infinity : best[n - 1][end])) end = j;
  if (end < 0) return null;
  const indices = new Array(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    indices[i] = j;
    j = from[i][j];
  }
  // Shorter text wins a tie: "Graph" over "Graph of everything".
  return { score: best[n - 1][end] - m * 0.01, indices };
}

/**
 * Items that match `query`, best first. An empty query keeps every item in its order.
 * `minPerChar` drops loose matches whose score is under that many points per query letter.
 */
export function fuzzyFilter(items, query, getText, { minPerChar = -Infinity } = {}) {
  if (!query.trim()) return items.map((item) => ({ item, score: 0, indices: [] }));
  const letters = [...query.replace(/\s+/g, '')].length;
  return items
    .map((item, order) => ({ item, order, match: fuzzyMatch(query, getText(item)) }))
    .filter((entry) => entry.match && entry.match.score >= letters * minPerChar)
    .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    .map(({ item, match }) => ({ item, ...match }));
}

/** Splits `text` into `{ text, hit }` runs for the code point `indices` a match returned. */
export function highlightRuns(text, indices) {
  const marked = new Set(indices);
  const runs = [];
  [...text].forEach((char, i) => {
    const hit = marked.has(i);
    const last = runs.at(-1);
    if (last && last.hit === hit) last.text += char;
    else runs.push({ text: char, hit });
  });
  return runs;
}
