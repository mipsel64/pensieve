/** Share of the scrollable length already scrolled, 0 to 1. */
export function readingProgress(scrollTop, scrollHeight, clientHeight) {
  const range = scrollHeight - clientHeight;
  return range > 0 ? Math.min(1, Math.max(0, scrollTop / range)) : 0;
}

/** Whole minutes to read `text` at 220 words a minute; at least one. */
export function readingMinutes(text) {
  const words = text.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(words / 220));
}
