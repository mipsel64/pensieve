const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const link = (title, missing, label = title) =>
  `<a href="#" data-title="${esc(title)}"${missing ? ' class="missing"' : ''}>${esc(label)}</a>`;

let token = localStorage.getItem('pensieve-token') || '';
let nodes = [];
let hits = new Set();
let selected = null;

async function api(path) {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    $('login').hidden = false;
    throw new Error('Enter the server token.');
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

const graph = ForceGraph()($('graph'))
  .nodeLabel((n) => esc(n.id))
  .nodeRelSize(3)
  .nodeVal((n) => 1 + Math.sqrt(n.degree))
  .nodeColor((n) => (n.id === selected ? '#f7768e' : hits.has(n.id) ? '#e0af68' : n.missing ? '#3b4252' : '#7aa2f7'))
  .linkColor(() => 'rgba(150, 160, 185, 0.18)')
  .linkDirectionalArrowLength(3)
  .linkDirectionalArrowRelPos(1)
  .nodeCanvasObjectMode(() => 'after')
  .nodeCanvasObject((n, ctx, scale) => {
    if (scale < 2 && n.id !== selected && !hits.has(n.id)) return;
    ctx.font = `${11 / scale}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#c8d0e0';
    ctx.fillText(n.id, n.x, n.y + Math.sqrt(1 + Math.sqrt(n.degree)) * 3 + 10 / scale);
  })
  .onNodeClick((n) => openPage(n.id));

const redraw = () => graph.nodeColor(graph.nodeColor());
const fit = () => graph.width($('graph').clientWidth).height($('graph').clientHeight);
addEventListener('resize', fit);

async function load() {
  const data = await api('/api/graph');
  const degree = {};
  for (const l of data.links) {
    degree[l.source] = (degree[l.source] || 0) + 1;
    degree[l.target] = (degree[l.target] || 0) + 1;
  }
  for (const n of data.nodes) n.degree = degree[n.id] || 0;
  nodes = data.nodes;
  graph.onEngineStop(() => {
    graph.onEngineStop(() => {});
    graph.zoomToFit(400, 40);
  });
  graph.graphData(data);
  fit();
  $('status').textContent = `${nodes.filter((n) => !n.missing).length} pages · ${data.links.length} links`;
}

async function openPage(title) {
  try {
    const p = await api(`/api/pages/${encodeURIComponent(title)}`);
    selected = p.title;
    let body = '';
    let last = 0;
    for (const m of p.content.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
      const target = m[1].split(/[|#]/)[0].trim();
      body += esc(p.content.slice(last, m.index)) + (target ? link(target, false, m[0]) : esc(m[0]));
      last = m.index + m[0].length;
    }
    body += esc(p.content.slice(last));
    $('page').innerHTML = `<h2>${esc(p.title)}</h2>
      <p class="meta">rev ${p.rev} · ${esc(p.updated_at)} · ${esc(p.updated_by)}</p>
      <p class="meta">Links: ${p.links.map((l) => link(l.title, !l.exists)).join(', ') || '—'}</p>
      <p class="meta">Backlinks: ${p.backlinks.map((t) => link(t)).join(', ') || '—'}</p>
      <pre>${body}</pre>`;
    $('page').scrollTop = 0;
    const node = nodes.find((n) => n.id === p.title);
    if (node) {
      graph.centerAt(node.x, node.y, 600);
      graph.zoom(2.5, 600);
    }
    redraw();
  } catch (err) {
    $('status').textContent = `${title}: ${err.message}`;
  }
}

$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const params = new URLSearchParams({ q: $('q').value, limit: '20', rerank: String($('rerank').checked) });
  $('status').textContent = 'Searching…';
  try {
    const res = await api(`/api/search?${params}`);
    hits = new Set(res.hits.map((h) => h.title));
    $('status').textContent = `${res.hits.length} results · ${res.reranked ? 'ranked by Jev' : 'BM25'}`;
    $('results').innerHTML = res.hits
      .map((h) => {
        const snippet = esc(h.snippet).replaceAll('«', '<mark>').replaceAll('»', '</mark>');
        return `<a class="hit" href="#" data-title="${esc(h.title)}"><b>${esc(h.title)}</b> <small>${h.score.toFixed(2)}</small><p>${snippet}</p></a>`;
      })
      .join('');
    redraw();
  } catch (err) {
    $('status').textContent = err.message;
  }
});

$('login').addEventListener('submit', (e) => {
  e.preventDefault();
  token = $('token').value.trim();
  localStorage.setItem('pensieve-token', token);
  $('login').hidden = true;
  load().catch((err) => ($('status').textContent = err.message));
});

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-title]');
  if (!target) return;
  e.preventDefault();
  openPage(target.dataset.title);
});

load().catch((err) => ($('status').textContent = err.message));
