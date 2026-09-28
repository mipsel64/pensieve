import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Crosshair, RotateCcw, Settings2, X } from 'lucide-react';
import { href } from './router.js';
import { ErrorNote, formatNumber, KIND_COLORS, KINDS, Loading, useResource } from './ui.jsx';
import { accentColor, GraphControls, resetGraph, useSettings } from './settings.jsx';

const kindOf = (node) => (node.missing ? 'missing' : (node.kind ?? 'untyped'));
const endpoint = (end) => (typeof end === 'object' ? end.id : end);
const nodeVal = (node) => 1 + Math.sqrt(node.degree);
const noLabel = () => '';
const noop = () => {};

const GREY = '#9aa4a3';
const TEXT = '#e6ebea';
const LINK = 'rgba(190, 206, 204, 0.16)';
const LINK_DIM = 'rgba(190, 206, 204, 0.045)';
// Labels are sized in graph units, so they grow as you zoom in.
const LABEL_SIZE = 5;
const FONT = '"IBM Plex Sans Variable", system-ui, sans-serif';
const BASE_FONT = `${LABEL_SIZE}px ${FONT}`;

// Pulls every node toward the centre, so separate clusters and orphans don't drift away.
function gravity(strength) {
  let nodes = [];
  const force = (alpha) => {
    for (const n of nodes) {
      n.vx -= n.x * strength * alpha;
      n.vy -= n.y * strength * alpha;
    }
  };
  force.initialize = (all) => (nodes = all);
  return force;
}

export function GraphView({ params }) {
  const graph = useResource('/graph');
  const { settings, update, status, retry } = useSettings();
  const g = settings.graph;
  const accent = accentColor(settings);
  const box = useRef(null);
  const fg = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panel, setPanel] = useState(() => matchMedia('(min-width: 760px)').matches);
  const [hover, setHover] = useState(null);
  const [find, setFind] = useState('');
  const focused = useRef(null);
  const settled = useRef(false);

  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [graph.data]);

  // Nodes and neighbour lists are built once; filters then pick subsets of the same node objects so positions persist.
  const model = useMemo(() => {
    if (!graph.data) return null;
    const neighbours = new Map(graph.data.nodes.map((n) => [n.id, new Set()]));
    for (const l of graph.data.links) {
      neighbours.get(l.source)?.add(l.target);
      neighbours.get(l.target)?.add(l.source);
    }
    const nodes = graph.data.nodes.map((n) => ({ ...n, degree: neighbours.get(n.id).size }));
    const counts = {};
    for (const n of nodes) counts[kindOf(n)] = (counts[kindOf(n)] ?? 0) + 1;
    return { nodes, links: graph.data.links, neighbours, counts };
  }, [graph.data]);

  // Page titles match case-insensitively, so `[[redis]]` selects the node `Redis`.
  const requested = params.page ?? params.focus;
  const selectedNode = model?.nodes.find((n) => n.id.toLowerCase() === requested?.toLowerCase());
  const selected = selectedNode?.id ?? requested;

  const hidden = useMemo(() => new Set(g.hidden), [g.hidden]);
  const filtered = useMemo(() => {
    if (!model) return new Set();
    const kept = new Set(model.nodes.filter((n) => (n.missing ? g.missing : !hidden.has(kindOf(n)))).map((n) => n.id));
    if (g.orphans) return kept;
    // An orphan is a page with no links left on screen, not only one with no links at all.
    const linked = new Set();
    for (const l of model.links) {
      if (kept.has(l.source) && kept.has(l.target)) linked.add(l.source).add(l.target);
    }
    return linked;
  }, [model, hidden, g.missing, g.orphans]);
  // A page opened from elsewhere stays visible even when a filter would hide it.
  const pinned = selectedNode && !filtered.has(selectedNode.id) ? selectedNode.id : null;

  const data = useMemo(() => {
    if (!model) return { nodes: [], links: [] };
    const nodes = model.nodes.filter((n) => n.id === pinned || filtered.has(n.id));
    const visible = new Set(nodes.map((n) => n.id));
    const links = model.links.filter((l) => visible.has(l.source) && visible.has(l.target)).map((l) => ({ source: l.source, target: l.target }));
    return { nodes, links };
  }, [model, filtered, pinned]);

  const ready = size.width > 0 && Boolean(model);
  useEffect(() => {
    const graph = fg.current;
    if (!ready || !graph) return;
    graph.d3Force('charge').strength(-g.repel);
    graph
      .d3Force('link')
      .distance(g.linkDistance)
      .strength((l) => g.linkForce / Math.max(1, Math.min(l.source.degree ?? 1, l.target.degree ?? 1)));
    graph.d3Force('gravity', gravity(g.center));
    graph.d3ReheatSimulation();
  }, [ready, g.repel, g.linkDistance, g.linkForce, g.center]);

  // Only visible nodes: a hidden one keeps coordinates from when it was last shown.
  const centerOn = (id) => {
    const node = data.nodes.find((n) => n.id === id);
    if (node?.x === undefined || !fg.current) return false;
    fg.current.centerAt(node.x, node.y, 600);
    fg.current.zoom(Math.max(fg.current.zoom(), 2.5), 600);
    return true;
  };

  useEffect(() => {
    if (settled.current && selected && focused.current !== selected && centerOn(selected)) focused.current = selected;
  });

  const active = hover ?? selected;
  const near = active ? model?.neighbours.get(active) : null;
  const query = find.trim().toLowerCase();
  const searching = query.length > 1;
  const relSize = 3 * g.nodeSize;

  // Painting reads these through closures; a new callback is what tells the canvas to redraw.
  const paintNode = useCallback(
    (n, ctx, scale) => {
      const lit = !active || n.id === active || near?.has(n.id);
      const matched = searching && n.id.toLowerCase().includes(query);
      // A search in progress decides what stands out, even over the selected page's neighbourhood.
      const dim = searching ? !matched : !lit;
      const r = Math.sqrt(nodeVal(n)) * relSize;
      const color = n.id === active ? accent : g.colorByType ? KIND_COLORS[kindOf(n)] : n.missing ? KIND_COLORS.missing : GREY;
      ctx.globalAlpha = dim ? 0.16 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, 2 * Math.PI);
      if (n.missing) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = color;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
      if (n.id === selected) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 2.4, 0, 2 * Math.PI);
        ctx.lineWidth = 1;
        ctx.strokeStyle = TEXT;
        ctx.stroke();
      }
      const emphasised = (active && lit) || matched || n.id === selected;
      const alpha = emphasised && !dim ? 1 : dim ? 0 : Math.min(1, Math.max(0, (scale - g.textFade) / 0.6));
      if (alpha > 0.02) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = TEXT;
        // Highlighted labels stay readable when zoomed out; the rest share the frame's font.
        const small = emphasised && LABEL_SIZE * scale < 11;
        if (small) ctx.font = `${11 / scale}px ${FONT}`;
        ctx.fillText(n.id, n.x, n.y + r + 1.5);
        if (small) ctx.font = BASE_FONT;
      }
      ctx.globalAlpha = 1;
    },
    [active, near, searching, query, selected, accent, relSize, g.colorByType, g.textFade],
  );

  const incident = useCallback((l) => active && (endpoint(l.source) === active || endpoint(l.target) === active), [active]);
  const linkColor = useCallback((l) => (incident(l) ? `${accent}cc` : active || searching ? LINK_DIM : LINK), [incident, accent, active, searching]);
  const linkWidth = useCallback((l) => (incident(l) ? g.linkWidth * 1.6 : g.linkWidth), [incident, g.linkWidth]);
  const beforeFrame = useCallback((ctx) => {
    ctx.font = BASE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
  }, []);

  if (graph.loading && !graph.data) return <Loading label="Loading graph" />;
  if (graph.error) return <ErrorNote error={graph.error} onRetry={graph.reload} />;

  function locate(event) {
    event.preventDefault();
    const node = model.nodes.find((n) => n.id.toLowerCase() === query) ?? model.nodes.find((n) => n.id.toLowerCase().includes(query));
    if (!node) return;
    // Re-centre even when this page is already selected and the hash won't change.
    focused.current = centerOn(node.id) ? node.id : '';
    location.hash = href('graph', { focus: node.id, page: node.id });
  }

  function toggleKind(kind) {
    update('graph', { hidden: hidden.has(kind) ? g.hidden.filter((k) => k !== kind) : [...g.hidden, kind] });
  }

  const kinds = [...KINDS, 'untyped'].filter((k) => model.counts[k]);

  return (
    <div className="graph-view">
      <div className="graph-canvas" ref={box} aria-label="Link graph of all pages. Use Filters to find a page, or the page panel for its links.">
        {size.width > 0 && (
          <ForceGraph2D
            ref={fg}
            graphData={data}
            width={size.width}
            height={size.height}
            backgroundColor="rgba(0, 0, 0, 0)"
            nodeRelSize={relSize}
            nodeVal={nodeVal}
            nodeLabel={noLabel}
            nodeCanvasObject={paintNode}
            linkColor={linkColor}
            linkWidth={linkWidth}
            linkDirectionalArrowLength={g.arrows ? 3.5 : 0}
            linkDirectionalArrowRelPos={1}
            // Nothing is done with links under the pointer, and hit-testing 2,000+ links is the costliest paint.
            linkPointerAreaPaint={noop}
            onRenderFramePre={beforeFrame}
            onNodeHover={(n) => setHover(n?.id ?? null)}
            onNodeClick={(n) => (location.hash = href('graph', { ...params, focus: undefined, page: n.id }))}
            onBackgroundClick={() => setHover(null)}
            warmupTicks={40}
            cooldownTicks={250}
            minZoom={0.15}
            maxZoom={12}
            onEngineStop={() => {
              // The first layout moves every node, so centre or fit once it settles; later stops
              // (after a filter change) keep the user's viewport.
              if (!settled.current) {
                settled.current = true;
                if (selected && centerOn(selected)) focused.current = selected;
                else fg.current?.zoomToFit(400, 60);
              } else if (selected && focused.current !== selected && centerOn(selected)) focused.current = selected;
            }}
          />
        )}
      </div>

      <p className="graph-count mono" aria-live="polite">
        {formatNumber(data.nodes.length)} pages · {formatNumber(data.links.length)} links
      </p>

      {panel ? (
        <aside className="graph-panel" aria-label="Graph settings">
          <div className="graph-panel-head">
            <h2>Graph</h2>
            <button type="button" className="icon-button" onClick={() => resetGraph(update)} aria-label="Restore default graph settings" title="Restore defaults">
              <RotateCcw size={15} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button" onClick={() => setPanel(false)} aria-label="Close graph settings">
              <X size={16} aria-hidden="true" />
            </button>
          </div>

          {status.state === 'error' && (
            <p className="graph-panel-error" role="alert">
              Couldn't save settings.{' '}
              <button type="button" className="link-button" onClick={retry}>
                Retry
              </button>
            </p>
          )}

          <details open>
            <summary>Filters</summary>
            <form className="find" onSubmit={locate} role="search">
              <div className="field">
                <input
                  id="graph-find"
                  list="graph-titles"
                  value={find}
                  onChange={(e) => setFind(e.target.value)}
                  // WebKit keeps Enter for the suggestion list, so the form would never submit.
                  onKeyDown={(e) => e.key === 'Enter' && locate(e)}
                  placeholder="Search pages…"
                  aria-label="Search pages in the graph"
                  autoComplete="off"
                />
                <button className="icon-button" aria-label="Center on page" disabled={!query}>
                  <Crosshair size={15} aria-hidden="true" />
                </button>
              </div>
              <datalist id="graph-titles">
                {model.nodes
                  .filter((n) => !n.missing)
                  .map((n) => (
                    <option key={n.id} value={n.id} />
                  ))}
              </datalist>
            </form>
            <GraphControls section="filters" idPrefix="graph" />
          </details>

          <details open>
            <summary>Groups</summary>
            <GraphControls section="groups" idPrefix="graph" />
            <ul className="legend">
              {kinds.map((kind) => (
                <li key={kind}>
                  <button type="button" className="legend-item" aria-pressed={!hidden.has(kind)} onClick={() => toggleKind(kind)}>
                    <span className="dot" style={{ background: g.colorByType ? KIND_COLORS[kind] : GREY }} aria-hidden="true" />
                    <span className="legend-name">{kind}</span>
                    <span className="mono muted">{formatNumber(model.counts[kind])}</span>
                  </button>
                </li>
              ))}
            </ul>
          </details>

          <details>
            <summary>Display</summary>
            <GraphControls section="display" idPrefix="graph" />
          </details>

          <details>
            <summary>Forces</summary>
            <GraphControls section="forces" idPrefix="graph" />
          </details>
        </aside>
      ) : (
        <button type="button" className="graph-panel-open icon-button" onClick={() => setPanel(true)} aria-label="Open graph settings" title="Graph settings">
          <Settings2 size={18} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

