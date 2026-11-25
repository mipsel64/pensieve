import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outline, useOutlineFromMarkdown } from '@astryxdesign/core/Outline';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { VStack } from '@astryxdesign/core/Stack';
import { Heading } from '@astryxdesign/core/Text';
import { readingProgress } from './toc.js';
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

/** A bar at the top of the reading area that fills as the page scrolls. */
export function ReadingProgress({ scrollContainerRef, content }) {
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const scroller = scrollContainerRef.current;
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = readingProgress(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight);
      setProgress((previous) => (previous === next ? previous : next));
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(update);
    };
    update();
    scroller.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(scroller);
    const page = scroller.querySelector('.page-view');
    if (page) resize.observe(page);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      resize.disconnect();
    };
  }, [scrollContainerRef, content]);
  return (
    <VStack className="reading-progress" gap={0}>
      <ProgressBar label="Reading progress" value={progress} max={1} isLabelHidden />
    </VStack>
  );
}

/** Contents generated with the same Markdown plugins and heading ids as the article. */
export function PageOutline({ body, newestFirst, scrollContainerRef, onNavigate }) {
  const items = useOutlineFromMarkdown(body, { plugins: markdownPlugins(newestFirst) });
  if (items.length < 2) return null;
  const navigate = (event) => {
    const anchor = event.target.closest('.astryx-outline a[href^="#"]');
    if (!anchor) return;
    event.preventDefault();
    const id = decodeURIComponent(anchor.getAttribute('href').slice(1));
    scrollElement(document.getElementById(id));
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
      <Outline items={items} label="On this page" density="compact" scrollContainerRef={scrollContainerRef} hasScrollOnClick={false} />
    </VStack>
  );
}
