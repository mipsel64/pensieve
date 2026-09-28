import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Crosshair } from 'lucide-react';
import { href } from './router.js';
import { ErrorNote, formatNumber, KIND_COLORS, KINDS, Loading, useResource } from './ui.jsx';

const kindOf = (node) => (node.missing ? 'missing' : (node.kind ?? 'untyped'));
const endpoint = (end) => (typeof end === 'object' ? end.id : end);

export function GraphView({ params }) {
  const graph = useResource('/graph');
  const box = useRef(null);
  const fg = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hidden, setHidden] = useState(() => new Set(['missing']));
  const [hover, setHover] = useState(null);
  const [find, setFind] = useState('');
  const focused = useRef(null);
  const settled = useRef(false);
  const requested = params.page ?? params.focus;

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
  const selected = model?.nodes.find((n) => n.id.toLowerCase() === requested?.toLowerCase())?.id ?? requested;

  const data = useMemo(() => {
    if (!model) return { nodes: [], links: [] };
    const nodes = model.nodes.filter((n) => !hidden.has(kindOf(n)));
    const visible = new Set(nodes.map((n) => n.id));
    const links = model.links.filter((l) => visible.has(l.source) && visible.has(l.target)).map((l) => ({ source: l.source, target: l.target }));
    return { nodes, links };
  }, [model, hidden]);

  // Only visible nodes: a hidden one keeps coordinates from when it was last shown.
  const centerOn = (id) => {
    const node = data.nodes.find((n) => n.id === id);
    if (node?.x === undefined || !fg.current) return false;
    fg.current.centerAt(node.x, node.y, 600);
    fg.current.zoom(3, 600);
    return true;
  };

  useEffect(() => {
    if (selected && focused.current !== selected && centerOn(selected)) focused.current = selected;
  });

  const selectedNode = model?.nodes.find((n) => n.id === selected);
  const selectedKind = selectedNode ? kindOf(selectedNode) : null;
  const reveal = (kind) =>
    setHidden((prev) => {
      if (!prev.has(kind)) return prev;
      const next = new Set(prev);
      next.delete(kind);
      return next;
    });
  useEffect(() => {
    if (selectedKind) reveal(selectedKind);
  }, [selectedKind]);

  if (graph.loading && !graph.data) return <Loading label="Loading graph" />;
  if (graph.error) return <ErrorNote error={graph.error} onRetry={graph.reload} />;

  const active = hover ?? selected;
  const near = active ? model.neighbours.get(active) : null;
  const matches = find.trim().toLowerCase();
  const isLit = (id) => !active || id === active || near?.has(id);

  function toggle(kind) {
    setHidden((prev) => {
      const next = new Set(prev);
      next.has(kind) ? next.delete(kind) : next.add(kind);
      return next;
    });
  }

  function locate(event) {
    event.preventDefault();
    const node = model.nodes.find((n) => n.id.toLowerCase() === matches) ?? model.nodes.find((n) => n.id.toLowerCase().includes(matches));
    if (!node) return;
    // Re-centre even when this page is already selected and the hash won't change; a hidden
    // node is revealed and centred on the next render.
    reveal(kindOf(node));
    focused.current = centerOn(node.id) ? node.id : '';
    location.hash = href('graph', { focus: node.id, page: node.id });
  }

  const kinds = [...KINDS, 'untyped', 'missing'].filter((k) => model.counts[k]);

  return (
    <div className="graph-view">
      <div className="graph-canvas" ref={box} aria-label="Link graph of all pages. Use Find to locate a page, or the page drawer for its links.">
        {size.width > 0 && (
          <ForceGraph2D
            ref={fg}
            graphData={data}
            width={size.width}
            height={size.height}
            backgroundColor="#0b1220"
            nodeRelSize={3}
            nodeVal={(n) => 1 + Math.sqrt(n.degree)}
            nodeLabel={() => ''}
            nodeColor={(n) => {
              const color = KIND_COLORS[kindOf(n)];
              return isLit(n.id) ? color : `${color}33`;
            }}
            nodeCanvasObjectMode={() => 'after'}
            nodeCanvasObject={(n, ctx, scale) => {
              const lit = active ? isLit(n.id) : false;
              const found = matches.length > 1 && n.id.toLowerCase().includes(matches);
              if (!(scale > 2.2 || lit || found || n.id === selected)) return;
              if (n.id === selected) {
                ctx.beginPath();
                ctx.arc(n.x, n.y, Math.sqrt(1 + Math.sqrt(n.degree)) * 3 + 2 / scale, 0, 2 * Math.PI);
                ctx.strokeStyle = '#f8fafc';
                ctx.lineWidth = 1.5 / scale;
                ctx.stroke();
              }
              ctx.font = `${12 / scale}px "IBM Plex Sans Variable", system-ui, sans-serif`;
              ctx.textAlign = 'center';
              ctx.fillStyle = isLit(n.id) ? '#e2e8f0' : '#e2e8f055';
              ctx.fillText(n.id, n.x, n.y + Math.sqrt(1 + Math.sqrt(n.degree)) * 3 + 11 / scale);
            }}
            linkColor={(l) => (active && (endpoint(l.source) === active || endpoint(l.target) === active) ? 'rgba(248, 250, 252, 0.55)' : active ? 'rgba(148, 163, 184, 0.05)' : 'rgba(148, 163, 184, 0.16)')}
            linkDirectionalArrowLength={2.5}
            linkDirectionalArrowRelPos={1}
            onNodeHover={(n) => setHover(n?.id ?? null)}
            onNodeClick={(n) => (location.hash = href('graph', { ...params, focus: undefined, page: n.id }))}
            onBackgroundClick={() => setHover(null)}
            cooldownTicks={200}
            onEngineStop={() => {
              // The first layout moves every node, so centre or fit once it settles; later stops
              // (after a filter change) keep the user's viewport.
              if (!settled.current) {
                settled.current = true;
                if (selected && centerOn(selected)) focused.current = selected;
                else fg.current?.zoomToFit(400, 40);
              } else if (selected && focused.current !== selected && centerOn(selected)) focused.current = selected;
            }}
          />
        )}
      </div>

      <aside className="graph-panel" aria-label="Graph controls">
        <form className="find" onSubmit={locate} role="search">
          <label htmlFor="graph-find">Find a page</label>
          <div className="field">
            <input
              id="graph-find"
              list="graph-titles"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              // WebKit keeps Enter for the suggestion list, so the form would never submit.
              onKeyDown={(e) => e.key === 'Enter' && locate(e)}
              placeholder="Title"
              autoComplete="off"
            />
            <button className="icon-button" aria-label="Center on page" disabled={!matches}>
              <Crosshair size={16} aria-hidden="true" />
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

        <div>
          <h2 className="panel-title">Types</h2>
          <ul className="legend">
            {kinds.map((kind) => (
              <li key={kind}>
                <button type="button" className="legend-item" aria-pressed={!hidden.has(kind)} onClick={() => toggle(kind)}>
                  <span className="dot" style={{ background: KIND_COLORS[kind] }} aria-hidden="true" />
                  <span className="legend-name">{kind === 'missing' ? 'missing page' : kind}</span>
                  <span className="mono muted">{formatNumber(model.counts[kind])}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">Select a type to show or hide it.</p>
        </div>

        <dl className="graph-stats">
          <div>
            <dt>Shown</dt>
            <dd className="mono">
              {formatNumber(data.nodes.length)} pages · {formatNumber(data.links.length)} links
            </dd>
          </div>
          {active && (
            <div>
              <dt>{hover ? 'Hovering' : 'Selected'}</dt>
              <dd>
                {active} <span className="muted">· {near?.size ?? 0} connections</span>
              </dd>
            </div>
          )}
        </dl>
      </aside>
    </div>
  );
}
