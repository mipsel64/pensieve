/** Whole minutes to read `text` at 220 words a minute; at least one. */
export function readingMinutes(text) {
  const words = text.replace(/```[\s\S]*?```/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(words / 220));
}
