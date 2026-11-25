import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Collapsible, CollapsibleGroup } from '@astryxdesign/core/Collapsible';
import { TextInput } from '@astryxdesign/core/TextInput';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { HStack, VStack } from '@astryxdesign/core/Stack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { ToggleButton } from '@astryxdesign/core/ToggleButton';
import { Circle, Crosshair, RotateCcw, Settings2, X } from 'lucide-react';
import { href } from './router.js';
import { ErrorNote, formatNumber, KIND_COLORS, KIND_PALETTE, KINDS, Loading, useResource } from './ui.jsx';
import { GraphControls, resetGraph, useSettings } from './settings.jsx';
import { useTheme } from '@astryxdesign/core/theme';
import './Graph.css';

const kindOf = (node) => (node.missing ? 'missing' : (node.kind ?? 'untyped'));
const endpoint = (end) => (typeof end === 'object' ? end.id : end);
const nodeVal = (node) => 1 + Math.sqrt(node.degree);
const noLabel = () => '';
const noop = () => {};

// Labels are sized in graph units, so they grow as you zoom in.
const LABEL_SIZE = 5;
const FONT = 'sans-serif';
const BASE_FONT = `${LABEL_SIZE}px ${FONT}`;

// Canvas paint needs color values instead of CSS variable references.
function graphPalette(token) {
  const kinds = {};
  for (const [kind, color] of Object.entries(KIND_PALETTE)) kinds[kind] = token(`--color-text-${color}`);
  return {
    kinds,
    link: token('--color-border-emphasized'),
    linkDim: token('--color-border'),
    label: token('--color-text-secondary'),
    halo: token('--color-background-surface'),
    ring: token('--color-border'),
    highlight: token('--color-accent'),
  };
}

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
  const { token } = useTheme();
  const palette = useMemo(() => graphPalette(token), [token]);
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
      const color = n.id === active ? palette.highlight : g.colorByType ? palette.kinds[kindOf(n)] : n.missing ? palette.kinds.missing : palette.kinds.untyped;
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
        ctx.strokeStyle = palette.label;
        ctx.stroke();
      } else if (!n.missing) {
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = palette.ring;
        ctx.stroke();
      }
      const emphasised = (active && lit) || matched || n.id === selected;
      const alpha = emphasised && !dim ? 1 : dim ? 0 : Math.min(1, Math.max(0, (scale - g.textFade) / 0.6));
      if (alpha > 0.02) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = palette.label;
        ctx.strokeStyle = palette.halo;
        // Highlighted labels stay readable when zoomed out; the rest share the frame's font.
        const small = emphasised && LABEL_SIZE * scale < 11;
        if (small) ctx.font = `${11 / scale}px ${FONT}`;
        ctx.lineWidth = (small ? 3.5 : 2) / (small ? scale : 1);
        ctx.strokeText(n.id, n.x, n.y + r + 1.5);
        ctx.fillText(n.id, n.x, n.y + r + 1.5);
        if (small) ctx.font = BASE_FONT;
      }
      ctx.globalAlpha = 1;
    },
    [active, near, searching, query, selected, palette, relSize, g.colorByType, g.textFade],
  );

  const incident = useCallback((l) => active && (endpoint(l.source) === active || endpoint(l.target) === active), [active]);
  const linkColor = useCallback((l) => (incident(l) ? palette.highlight : active || searching ? palette.linkDim : palette.link), [incident, palette, active, searching]);
  const linkWidth = useCallback((l) => (incident(l) ? g.linkWidth * 1.6 : g.linkWidth), [incident, g.linkWidth]);
  const beforeFrame = useCallback((ctx) => {
    ctx.font = BASE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
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
    <VStack className="graph-view">
      <VStack className="graph-canvas" ref={box} aria-label="Link graph of all pages. Use Filters to find a page, or the page panel for its links.">
        {size.width > 0 && (
          <ForceGraph2D
            ref={fg}
            graphData={data}
            width={size.width}
            height={size.height}
            backgroundColor="transparent"
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
      </VStack>

      <VStack className="graph-count" aria-live="polite">
        <Text type="code" size="sm" color="secondary">
          {formatNumber(data.nodes.length)} pages · {formatNumber(data.links.length)} links
        </Text>
      </VStack>

      {panel ? (
        <VStack as="aside" className="graph-panel" aria-label="Graph settings" padding={2} gap={2}>
          <HStack align="center" justify="between" gap={1} width="100%">
            <Heading level={2}>Graph</Heading>
            <HStack gap={1}>
              <IconButton
                label="Restore default graph settings"
                tooltip="Restore defaults"
                variant="ghost"
                size="sm"
                icon={<Icon icon={RotateCcw} />}
                onClick={() => resetGraph(update)}
              />
              <IconButton label="Close graph settings" variant="ghost" size="sm" icon={<Icon icon={X} />} onClick={() => setPanel(false)} />
            </HStack>
          </HStack>

          {status.state === 'error' && (
            <VStack role="alert">
              <Banner status="error" title="Couldn't save settings" endContent={<Button label="Retry" size="sm" onClick={retry} />} />
            </VStack>
          )}

          <CollapsibleGroup type="multiple" defaultValue={['filters', 'groups']} hasDividers density="compact">
            <Collapsible value="filters" trigger="Filters">
              <VStack gap={3} paddingBlock={2}>
                <VStack as="form" onSubmit={locate} role="search" gap={1}>
                  <HStack align="end" gap={1} width="100%">
                    <TextInput
                      id="graph-find"
                      label="Search pages in the graph"
                      isLabelHidden
                      list="graph-titles"
                      value={find}
                      onChange={setFind}
                      // WebKit keeps Enter for the suggestion list, so the form would never submit.
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                        locate(e);
                      }}
                      placeholder="Search pages…"
                      autoComplete="off"
                      width="100%"
                    />
                    <IconButton type="submit" label="Center on page" variant="ghost" size="sm" isDisabled={!query} icon={<Icon icon={Crosshair} />} />
                  </HStack>
                  <datalist id="graph-titles">
                    {model.nodes
                      .filter((n) => !n.missing)
                      .map((n) => (
                        <option key={n.id} value={n.id} />
                      ))}
                  </datalist>
                </VStack>
                <GraphControls section="filters" idPrefix="graph" />
              </VStack>
            </Collapsible>

            <Collapsible value="groups" trigger="Groups">
              <VStack gap={3} paddingBlock={2}>
                <GraphControls section="groups" idPrefix="graph" />
                <VStack gap={1} width="100%">
                  {kinds.map((kind) => (
                    <ToggleButton
                      key={kind}
                      label={kind}
                      size="sm"
                      isPressed={!hidden.has(kind)}
                      onPressedChange={() => toggleKind(kind)}
                      icon={<Icon icon={Circle} style={{ color: g.colorByType ? KIND_COLORS[kind] : KIND_COLORS.untyped, fill: 'currentColor' }} />}
                    >
                      <HStack gap={2} align="center">
                        <Text>{kind}</Text>
                        <Text type="code" color="secondary">
                          {formatNumber(model.counts[kind])}
                        </Text>
                      </HStack>
                    </ToggleButton>
                  ))}
                </VStack>
              </VStack>
            </Collapsible>

            <Collapsible value="display" trigger="Display">
              <VStack paddingBlock={2}>
                <GraphControls section="display" idPrefix="graph" />
              </VStack>
            </Collapsible>

            <Collapsible value="forces" trigger="Forces">
              <VStack paddingBlock={2}>
                <GraphControls section="forces" idPrefix="graph" />
              </VStack>
            </Collapsible>
          </CollapsibleGroup>
        </VStack>
      ) : (
        <VStack className="graph-panel-open">
          <IconButton
            label="Open graph settings"
            tooltip="Graph settings"
            variant="secondary"
            elevation="med"
            icon={<Icon icon={Settings2} />}
            onClick={() => setPanel(true)}
          />
        </VStack>
      )}
    </VStack>
  );
}

