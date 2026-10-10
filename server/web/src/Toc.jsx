import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ListTree } from 'lucide-react';
import { activeHeadingIndex, buildToc, readingProgress } from './toc.js';

const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The h2 and h3 headings inside `root`, read from the page after each render of `content`. */
export function useHeadings(root, content) {
  const [items, setItems] = useState([]);
  useLayoutEffect(() => {
    const found = [...(root.current?.querySelectorAll('h2[id], h3[id]') ?? [])].map((h) => ({ id: h.id, text: h.textContent, level: Number(h.tagName[1]) }));
    const next = buildToc(found);
    setItems((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [root, content]);
  return items;
}

/** The id of the heading being read: the last one above a line 20% down the scroll area. An IntersectionObserver re-checks when a heading crosses that line. */
export function useActiveHeading(root, items) {
  const [active, setActive] = useState(null);
  useEffect(() => {
    const scroller = root.current?.closest('.content');
    const headings = items.map((item) => root.current.querySelector(`[id="${CSS.escape(item.id)}"]`));
    if (!scroller || !items.length || headings.some((h) => !h)) {
      setActive(null);
      return;
    }
    const update = () => {
      const top = scroller.getBoundingClientRect().top;
      const index = activeHeadingIndex(
        headings.map((h) => h.getBoundingClientRect().top - top),
        scroller.clientHeight * 0.2,
        scroller.scrollTop > 0 && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2,
      );
      setActive(index < 0 ? null : items[index].id);
    };
    const observer = new IntersectionObserver(update, { root: scroller, rootMargin: '0px 0px -80% 0px', threshold: [0, 1] });
    headings.forEach((h) => observer.observe(h));
    // A jump (End key, scrollbar drag) can cross the line without any heading crossing the band, so scrolling checks too.
    let frame = 0;
    const onScroll = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', update);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', onScroll);
      removeEventListener('resize', update);
    };
  }, [root, items]);
  return active;
}

export function scrollToHeading(root, id) {
  const heading = root.current?.querySelector(`[id="${CSS.escape(id)}"]`);
  heading?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  return Boolean(heading);
}

/** A thin bar at the top of the reading area that fills as the page scrolls. */
export function ReadingProgress() {
  const bar = useRef(null);
  useEffect(() => {
    const scroller = bar.current.closest('.content');
    if (!scroller) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      bar.current.style.transform = `scaleX(${readingProgress(scroller.scrollTop, scroller.scrollHeight, scroller.clientHeight)})`;
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
  }, []);
  return <div ref={bar} className="read-progress" aria-hidden="true" />;
}

function TocList({ items, active, hrefFor, onPick }) {
  return (
    <ol className="toc-list">
      {items.map((item) => (
        <li key={item.id} className={`toc-level-${item.level}`}>
          <a
            href={hrefFor(item.id)}
            aria-current={item.id === active ? 'location' : undefined}
            onClick={(event) => {
              event.preventDefault();
              onPick(item.id);
            }}
          >
            {item.text}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** Wide screens: the contents list beside the page. */
export function TocSide({ items, active, hrefFor, onPick }) {
  return (
    <aside className="page-side toc-side" aria-labelledby="toc-side-title">
      <h2 id="toc-side-title" className="toc-title">
        On this page
      </h2>
      <TocList items={items} active={active} hrefFor={hrefFor} onPick={onPick} />
    </aside>
  );
}

/** Narrow screens: one button that shows the current section and opens the list. */
export function TocMenu({ items, active, hrefFor, onPick }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const button = useRef(null);
  const listId = useId();
  const current = items.find((item) => item.id === active);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event) => !root.current?.contains(event.target) && setOpen(false);
    addEventListener('pointerdown', onPointer);
    return () => removeEventListener('pointerdown', onPointer);
  }, [open]);

  return (
    <nav
      ref={root}
      className="toc-menu"
      aria-label="On this page"
      onBlur={(event) => open && !root.current?.contains(event.relatedTarget) && setOpen(false)}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }}
    >
      <button ref={button} type="button" className="toc-toggle" aria-expanded={open} aria-controls={open ? listId : undefined} onClick={() => setOpen((v) => !v)}>
        <ListTree size={15} aria-hidden="true" />
        <span>{current?.text ?? 'On this page'}</span>
        <ChevronDown size={15} aria-hidden="true" className="toc-chevron" />
      </button>
      {open && (
        <div id={listId} className="popover toc-popover">
          <TocList
            items={items}
            active={active}
            hrefFor={hrefFor}
            onPick={(id) => {
              setOpen(false);
              onPick(id);
            }}
          />
        </div>
      )}
    </nav>
  );
}
