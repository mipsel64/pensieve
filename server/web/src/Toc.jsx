import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outline, useOutlineFromMarkdown } from '@astryxdesign/core/Outline';
import { VStack } from '@astryxdesign/core/Stack';
import { Heading } from '@astryxdesign/core/Text';
import { markdownPlugins } from './ui.jsx';

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollElement(heading) {
  heading?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  return Boolean(heading);
}

/** The scroll region that contains the article. */
export function useScrollContainer(root, content) {
  const scrollContainer = useRef(null);
  useLayoutEffect(() => {
    let node = root.current?.parentElement;
    while (node && !/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY)) node = node.parentElement;
    scrollContainer.current = node ?? document.scrollingElement;
  }, [root, content]);
  return scrollContainer;
}

export function scrollToHeading(root, id) {
  const find = (key) => root.current?.querySelector(`[id="${CSS.escape(key)}"]`);
  // Links copied before Astryx carry the old `sec-` heading ids.
  return scrollElement(find(id) ?? (id.startsWith('sec-') ? find(id.slice(4)) : null));
}

/** Contents generated with the same Markdown plugins and heading ids as the article. */
export function PageOutline({ body, newestFirst, scrollContainerRef, params, onNavigate }) {
  const items = useOutlineFromMarkdown(body, { plugins: markdownPlugins(newestFirst) });
  const hasOutline = items.length >= 2;
  const [canScroll, setCanScroll] = useState(true);
  const [selection, setSelection] = useState(null);

  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!hasOutline || !scroller) return;
    const update = () => setCanScroll(scroller.scrollHeight > scroller.clientHeight);
    const resize = new ResizeObserver(update);
    resize.observe(scroller);
    const page = scroller.querySelector('.page-view');
    if (page) resize.observe(page);
    update();
    return () => resize.disconnect();
  }, [hasOutline, scrollContainerRef]);

  if (!hasOutline) return null;
  // A short page is already "at the bottom" to the scroll spy. Use the route
  // instead, including local selections made with replaceState (no hashchange).
  const section = selection?.params === params ? selection.id : params.section;
  const activeId = canScroll ? undefined : (
    items.find(({ id }) => id === section)?.id
    ?? (section?.startsWith('sec-') ? items.find(({ id }) => id === section.slice(4))?.id : undefined)
    ?? items[0].id
  );
  const navigate = (event) => {
    const anchor = event.target.closest('.astryx-outline a[href^="#"]');
    if (!anchor) return;
    event.preventDefault();
    const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
    scrollElement(document.getElementById(id));
    setSelection({ params, id });
    onNavigate(id);
  };
  return (
    // Keep Outline's scroll spy, but scroll here so fragment links (click or Space) cannot replace the app route.
    <VStack
      gap={2}
      onClickCapture={navigate}
      onKeyDownCapture={(event) => {
        if (event.key !== ' ') return;
        navigate(event);
        // Outline's own Space handler would push the bare `#id` fragment.
        if (event.defaultPrevented) event.stopPropagation();
      }}
    >
      <Heading level={2}>On this page</Heading>
      <Outline items={items} activeId={activeId} label="On this page" density="compact" scrollContainerRef={scrollContainerRef} hasScrollOnClick={false} />
    </VStack>
  );
}
