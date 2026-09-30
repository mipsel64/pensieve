export const JOURNAL_DAY = /^Journal (\d{4}-\d{2}-\d{2})$/;

export function isDailyJournal(page) {
  return page?.kind === 'journal' && JOURNAL_DAY.test(page.title);
}

export function remarkNewestFirst() {
  return (tree) => {
    const intro = [];
    const entries = [];
    for (const node of tree.children) {
      const time = node.type === 'heading' && node.depth === 2 && node.children[0]?.type === 'text'
        ? /^((?:[01]\d|2[0-3]):[0-5]\d)(?:\s|$)/.exec(node.children[0].value)?.[1]
        : null;
      if (time) entries.push({ time, nodes: [] });
      (entries.at(-1)?.nodes ?? intro).push(node);
    }
    tree.children = [...intro, ...entries.sort((a, b) => b.time.localeCompare(a.time)).flatMap((entry) => entry.nodes)];
  };
}
