// Pena editor: canvas, selection, tools, layers, components, chat. Every edit goes through the same
// document API the agents use (pen-core.js), so humans and agents follow identical rules.
import { createApi, migrate, expandDoc, expandNode, indexNodes, themeDefaults, sizeNumber } from './pen-core.js';
import { renderDoc, fitPathViewBoxes, loadDocFonts, loadedFonts } from './render.js';
import { $, $$, h, ic, hydrateIcons, menu, modelLabel, pickModel, pickEffort, pref } from './ui.js';
import { renderProps } from './props.js';
import { slashSkills, agentsButton, agentsPref } from './composer.js';
import { openSettings } from './settings.js';
window.penaSettings = openSettings;
$('#open-settings').onclick = () => openSettings();

hydrateIcons();
$('#send').append(ic('arrow-up', 15));

// ---------------------------------------------------------------- state
let doc = migrate({ children: [] }), expanded = [], view = new Map();
let selected = null, hovered = null, tool = 'select', theme = {};
let cam = { x: 80, y: 80, z: 0.5 };
const undo = [], redo = [];
const open = new Set(); // expanded rows in the layers tree
const canvas = $('#canvas'), world = $('#world'), overlay = $('#overlay');
const isPath = (id) => id?.includes('/');
const info = (id) => view.get(id);
// id -> element, filled by the renderer. Querying the DOM (100k+ nodes in big files) per lookup was a hot spot.
const els = new Map();
const elOf = (id) => els.get(id);
const post = (url, body) => fetch(url, { method: 'POST', body: body instanceof Blob || typeof body === 'string' ? body : JSON.stringify(body ?? {}) });

function indexView() {
  view = new Map();
  const walk = (list, parent) => { for (const n of list ?? []) { view.set(n.id, { node: n, parent }); walk(n.children, n); } };
  walk(expanded, null);
}

// ---------------------------------------------------------------- persistence
// Edits are tracked per top-level frame ("root"): only touched roots are re-rendered, undo stores just those roots,
// and saves are coalesced. Big files used to re-render and snapshot the whole document on every edit.
const metaOf = (d) => JSON.stringify([d.variables, d.themes, d.fonts, d.imports]);
const rootIdOf = (path, index = indexNodes(doc)) => {
  if (!path || path === 'document') return null;
  let n = index.get(path.split('/')[0]);
  while (n && n.parent && n.parent !== doc) n = index.get(n.parent.id);
  return n?.node.id ?? null;
};

export async function commit(mutate, { select: sel } = {}) {
  const entry = { order: doc.children.map((c) => c.id), roots: new Map(), meta: metaOf(doc) };
  const dirty = new Set();
  let full = false;
  const snap = (rootId, absent = false) => {
    if (!rootId) return;
    if (!entry.roots.has(rootId)) {
      const r = absent ? null : doc.children.find((c) => c.id === rootId);
      entry.roots.set(rootId, r ? JSON.stringify(r) : null);
    }
    dirty.add(rootId);
  };
  const touch = (path) => snap(rootIdOf(path));
  const created = (parent, id) => (rootIdOf(parent) ? null : snap(id, true));
  // Operations are recorded so the DOM can be patched node by node (see patch()).
  const ops = [];
  const comps = new Set(); // components whose definition changed
  const watch = (path) => {
    const index = indexNodes(doc);
    for (let n = index.get(path?.split('/')[0]); n; n = n.parent && n.parent !== doc ? index.get(n.parent.id) : null) if (n.node.reusable) comps.add(n.node.id);
  };
  const api = createApi(doc);
  const tracked = {
    ...api,
    touch: (path) => { touch(path); watch(path); ops.push({ t: 'update', id: path }); },
    Insert: (p, d) => { touch(p); watch(p); const id = api.Insert(p, d); created(p, id); ops.push({ t: 'insert', id }); return id; },
    Copy: (path, p, d) => { touch(p); watch(p); const id = api.Copy(path, p, d); created(p, id); ops.push({ t: 'insert', id }); return id; },
    Update: (path, d) => { touch(path); watch(path); api.Update(path, d); ops.push({ t: 'update', id: path, keys: Object.keys(d) }); },
    Replace: (path, d) => { const root = rootIdOf(path); touch(path); watch(path); const id = api.Replace(path, d); if (root === path) snap(id, true); ops.push({ t: 'remove', id: path }, { t: 'insert', id }); return id; },
    Move: (path, p, i) => { touch(path); touch(p); watch(path); watch(p); api.Move(path, p, i); ops.push({ t: 'remove', id: path }, { t: 'insert', id: path }); },
    Delete: (path) => { touch(path); watch(path); api.Delete(path); ops.push({ t: 'remove', id: path }); },
    SetVariables: (...a) => { full = true; return api.SetVariables(...a); },
  };
  let result;
  try {
    result = mutate(tracked);
  } catch (e) {
    applyEntry(entry);
    toast(e.message);
    return;
  }
  if (metaOf(doc) !== entry.meta) full = true;
  if (!dirty.size && !full && entry.order.join() === doc.children.map((c) => c.id).join()) return result;
  undo.push(entry);
  if (undo.length > 300) undo.shift();
  redo.length = 0;
  if (sel !== undefined) selected = typeof sel === 'function' ? sel(result) : sel;
  if (full) update(dirty, { full });
  else patch(dirty, ops, comps);
  schedulePreview();
  scheduleSave();
  return result;
}

// Restore the roots/order/meta stored in an entry; returns the entry that undoes this restore.
function applyEntry(entry) {
  const back = { order: doc.children.map((c) => c.id), roots: new Map(), meta: metaOf(doc) };
  const byId = new Map(doc.children.map((c) => [c.id, c]));
  for (const [id, json] of entry.roots) {
    back.roots.set(id, byId.has(id) ? JSON.stringify(byId.get(id)) : null);
    if (json) byId.set(id, JSON.parse(json));
    else byId.delete(id);
  }
  const ordered = entry.order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  for (const [id, n] of byId) if (!entry.order.includes(id)) ordered.push(n);
  doc.children = ordered;
  const [variables, themes, fonts, imports] = JSON.parse(entry.meta);
  Object.assign(doc, { variables, themes, fonts, imports });
  for (const k of ['variables', 'themes', 'fonts', 'imports']) if (doc[k] === undefined || doc[k] === null) delete doc[k];
  return { back, dirty: new Set(entry.roots.keys()), full: back.meta !== entry.meta };
}
function restore(from, to) {
  if (!from.length) return;
  const { back, dirty, full } = applyEntry(from.pop());
  to.push(back);
  update(dirty, { full });
  scheduleSave();
}

// Saves are coalesced (typing, nudging, dragging); while an agent is working we save immediately so its next
// read of the file includes your edits.
let saveTimer = null, saving = Promise.resolve();
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, busy ? 0 : 300);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const body = JSON.stringify(doc, null, 2);
  saving = saving.then(() => fetch('/doc', { method: 'PUT', body }).catch(() => toast('Falha ao salvar — o app ainda está rodando?')));
  return saving;
}
addEventListener('beforeunload', () => { if (saveTimer) navigator.sendBeacon?.('/doc-beacon', JSON.stringify(doc, null, 2)); });

// ---------------------------------------------------------------- rendering
const assetUrl = (u) => (/^(https?:|data:|blob:)/.test(u) ? u : `/asset/${u.replace(/^\.\//, '')}`);
const loadFonts = (fonts) => loadDocFonts(doc, fonts, assetUrl);

// Per-root facts used to find which roots an edit affects: components defined inside, components referenced.
const rootMeta = new Map(); // rootId -> { comps: Set, refs: Set }
const rootRect = new Map(); // rootId -> world-space rect, measured once after render (pan/zoom never measure)
function metaFor(raw) {
  const comps = new Set(), refs = new Set();
  const walk = (n) => {
    if (n.reusable) comps.add(n.id);
    if (n.type === 'ref') refs.add(n.ref);
    n.children?.forEach(walk);
    for (const o of Object.values(n.descendants ?? {})) if (o?.type) walk(o);
  };
  walk(raw);
  return { comps, refs };
}
function renderRoots(list, parent = null, inherited = null) {
  const { elements, fonts } = renderDoc(doc, list, { theme, assetUrl, onElement: (id, el) => els.set(id, el), parent, inheritedTheme: inherited });
  loadFonts(fonts);
  if (!parent)
    for (const [i, el] of elements.entries()) {
      // a root's internal changes don't relayout the others; off-screen roots are neither laid out nor painted
      el.style.contain = 'layout style';
      if (!window.__noCV) el.style.contentVisibility = 'auto';
      const n = list[i];
      el.style.containIntrinsicSize = `auto ${sizeNumber(n.width) || 400}px auto ${sizeNumber(n.height) || 400}px`;
    }
  return elements;
}
function measure(ids) {
  for (const id of ids) {
    const el = els.get(id);
    if (!el || !el.isConnected) { rootRect.delete(id); continue; }
    const r = el.getBoundingClientRect();
    rootRect.set(id, { x: (r.left - cam.x) / cam.z, y: (r.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z });
  }
}

// Full render: first load, theme/variable changes.
export function render() {
  els.clear();
  rootMeta.clear();
  expanded = expandDoc(doc);
  indexView();
  if (selected && !view.has(selected)) selected = null;
  for (const raw of doc.children) rootMeta.set(raw.id, metaFor(raw));
  world.replaceChildren(...renderRoots(expanded));
  fitPathViewBoxes(world);
  rootRect.clear();
  measure(expanded.map((n) => n.id));
  afterRender();
}

// First load of a file: frame the camera from the frames' own sizes, then build the canvas in batches (one per
// animation frame) so a big file shows up immediately and fills in without freezing the window.
async function renderProgressive() {
  els.clear(); rootMeta.clear(); rootRect.clear();
  expanded = expandDoc(doc);
  indexView();
  for (const raw of doc.children) rootMeta.set(raw.id, metaFor(raw));
  world.replaceChildren();
  const est = expanded.filter((n) => n.enabled !== false).map((n) => ({ x: n.x ?? 0, y: n.y ?? 0, w: sizeNumber(n.width) || 400, h: sizeNumber(n.height) || 400 }));
  if (est.length) fitRect(Math.min(...est.map((r) => r.x)), Math.min(...est.map((r) => r.y)), Math.max(...est.map((r) => r.x + r.w)), Math.max(...est.map((r) => r.y + r.h)), est.length === 1);
  const weight = (n) => 1 + (n.children ?? []).reduce((a, c) => a + weight(c), 0);
  let batch = [], load = 0;
  const flush = () => {
    const fresh = renderRoots(batch);
    world.append(...fresh);
    fresh.forEach((el) => fitPathViewBoxes(el));
    batch = []; load = 0;
  };
  for (const n of expanded) {
    batch.push(n);
    load += weight(n);
    if (load > 2500) { flush(); if (!performance.getEntriesByName('pena:first-paint').length) performance.mark('pena:first-paint'); await new Promise((r) => requestAnimationFrame(r)); }
  }
  flush();
  measure(expanded.map((n) => n.id));
  afterRender();
}

// Incremental render: only the given roots, plus roots that use components defined in them.
function update(dirty, { full = false } = {}) {
  if (full) return render();
  const ids = new Set(dirty);
  // dependents: roots referencing a component that lives in a dirty root (transitively)
  for (let grew = true; grew; ) {
    grew = false;
    const comps = new Set([...ids].flatMap((id) => [...(rootMeta.get(id)?.comps ?? [])]));
    for (const [id, m] of rootMeta) if (!ids.has(id) && [...m.refs].some((r) => comps.has(r))) ids.add(id), (grew = true);
  }
  const index = indexNodes(doc);
  const byId = new Map(expanded.map((n) => [n.id, n]));
  for (const id of ids) {
    const old = byId.get(id);
    if (old) forget(old);
    els.get(id)?.remove();
    els.delete(id);
    const raw = doc.children.find((c) => c.id === id);
    if (!raw) { byId.delete(id); rootMeta.delete(id); rootRect.delete(id); continue; }
    rootMeta.set(id, metaFor(raw));
    byId.set(id, expandNode(raw, index));
  }
  expanded = doc.children.map((c) => byId.get(c.id)).filter(Boolean);
  const fresh = expanded.filter((n) => ids.has(n.id));
  const newEls = renderRoots(fresh);
  newEls.forEach((el) => fitPathViewBoxes(el));
  // keep DOM order = document order (paint order), moving as few elements as possible
  let prev = null;
  for (const n of expanded) {
    const el = els.get(n.id);
    if (!el || n.enabled === false) continue;
    if ((prev ? prev.nextElementSibling : world.firstElementChild) !== el) prev ? prev.after(el) : world.prepend(el);
    prev = el;
  }
  indexView();
  if (selected && !view.has(selected)) selected = null;
  measure(fresh.map((n) => n.id));
  afterRender();
}
const forget = (n) => { els.delete(n.id); n.children?.forEach(forget); };

// Node-level patch for ordinary edits: only the changed nodes are rebuilt; flex layout around them reflows by itself.
const QUIET = new Set(['name', 'context', 'metadata']); // no visual effect
function patch(dirtyRoots, ops, comps = new Set()) {
  const oldView = view;
  // roots that use an edited component (transitively) get re-expanded; only their instances are redrawn
  dirtyRoots = new Set(dirtyRoots);
  if (comps.size) {
    // a component that contains an instance of an edited component changed too (nested components)
    const uses = new Map(); // component id -> refs inside it
    indexNodes(doc).forEach(({ node }) => { if (node.reusable) uses.set(node.id, metaFor(node).refs); });
    for (let grew = true; grew; ) {
      grew = false;
      for (const [c, refs] of uses) if (!comps.has(c) && [...refs].some((r) => comps.has(r))) comps.add(c), (grew = true);
    }
    for (const [id, m] of rootMeta) if ([...m.refs].some((r) => comps.has(r))) dirtyRoots.add(id);
  }
  // 1. removals first, while the old element map still describes the DOM
  for (const op of ops) if (op.t === 'remove') { els.get(op.id)?.remove(); const o = oldView.get(op.id); if (o) forget(o.node); }
  // 2. re-expand the touched roots and rebuild the index
  const index = indexNodes(doc);
  const byId = new Map(expanded.map((n) => [n.id, n]));
  for (const id of dirtyRoots) {
    const raw = doc.children.find((c) => c.id === id);
    if (raw) byId.set(id, expandNode(raw, index)), rootMeta.set(id, metaFor(raw));
    else byId.delete(id), rootMeta.delete(id), rootRect.delete(id), labels.get(id)?.remove(), labels.delete(id);
  }
  expanded = doc.children.map((c) => byId.get(c.id)).filter(Boolean);
  indexView();
  // 3. what to rebuild: inserted nodes and visually changed nodes (dedupe nested ones)
  const todo = new Map(); // id -> 'insert' | 'rerender'
  for (const op of ops) {
    if (op.t === 'insert') todo.set(op.id, 'insert');
    else if (op.t === 'update' && !todo.has(op.id)) {
      const n = info(op.id)?.node, el = els.get(op.id);
      if (!n) continue;
      if (op.keys?.every((k) => QUIET.has(k))) continue;
      // moving a freely positioned node: just move its element
      if (el && op.keys?.every((k) => k === 'x' || k === 'y') && isFree(op.id) && typeof (n.x ?? 0) === 'number' && typeof (n.y ?? 0) === 'number') {
        el.style.left = `${n.x ?? 0}px`; el.style.top = `${n.y ?? 0}px`;
        continue;
      }
      todo.set(op.id, el ? 'rerender' : 'insert');
    }
  }
  if (comps.size) for (const [id, { node }] of view) if (node._ref && comps.has(node._ref) && !todo.has(id)) todo.set(id, els.get(id) ? 'rerender' : 'insert');
  const covered = (id) => { for (let p = info(id)?.parent; p; p = info(p.id)?.parent) if (todo.has(p.id)) return true; return false; };
  for (const [id, kind] of todo) {
    const hit = info(id);
    if (!hit || covered(id)) continue;
    const { node, parent } = hit;
    const oldEl = els.get(id);
    if (kind === 'rerender' && oldEl) { const o = oldView.get(id); if (o) forget(o.node); }
    const [el] = renderRoots([node], parent, inheritedTheme(id));
    if (el) fitPathViewBoxes(el);
    if (kind === 'rerender' && oldEl) { el ? oldEl.replaceWith(el) : oldEl.remove(); continue; }
    if (!el) continue;
    if (!parent) { world.append(el); continue; } // new root: placed by the order sync below
    const parentEl = els.get(parent.id);
    if (!parentEl) continue;
    const siblings = parent.children ?? [];
    let before = null;
    for (let i = siblings.findIndex((c) => c.id === id) + 1; i < siblings.length && !before; i++) {
      const s = els.get(siblings[i].id);
      if (s?.parentElement === parentEl) before = s;
    }
    parentEl.insertBefore(el, before);
  }
  // 4. root order (paint order) and the measurements of touched roots only
  let prev = null;
  for (const n of expanded) {
    const el = els.get(n.id);
    if (!el || !el.isConnected) continue;
    if ((prev ? prev.nextElementSibling : world.firstElementChild) !== el) prev ? prev.after(el) : world.prepend(el);
    prev = el;
  }
  if (selected && !view.has(selected)) selected = null;
  measure([...dirtyRoots]);
  syncLabels();
  drawOverlay({ remeasure: true });
  renderLayers();
  renderComponents();
  renderPanel();
}
// Theme in effect at a node: document defaults, the preview theme, then every ancestor's own `theme`.
function inheritedTheme(id) {
  const chain = [];
  for (let p = info(id)?.parent; p; p = info(p.id)?.parent) if (p.theme) chain.unshift(p.theme);
  return Object.assign({}, theme, ...chain);
}
function afterRender() {
  syncLabels();
  applyCam();
  drawOverlay({ remeasure: true });
  renderLayers();
  renderComponents();
  renderPanel();
}
const renderPanel = () => renderProps({ doc, view, selected, info, elOf, commit, select, exportNode, theme, isPath, toast, download });

function applyCam() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
  world.classList.toggle('far', cam.z < 0.12);
  $('#zoom-pct').textContent = `${Math.round(cam.z * 100)}%`;
  drawOverlay();
}

world.addEventListener('contentvisibilityautostatechange', (e) => {
  const id = e.target.dataset?.id;
  if (!e.skipped && id && rootRect.has(id)) { measure([id]); drawOverlay(); }
});

// ---------------------------------------------------------------- overlay (screen space, no layout reads)
// Frame labels keep a constant size like pen.dev. Elements are reused and only moved with transforms.
const labels = new Map(); // rootId -> label element
function syncLabels() {
  const keep = new Set();
  for (const n of expanded) {
    if (n.enabled === false || n.type === 'note' || n.type === 'prompt' || n.type === 'context') continue;
    keep.add(n.id);
    let l = labels.get(n.id);
    if (!l) {
      l = h('div', { class: 'flabel', onpointerdown: (e) => { e.stopPropagation(); select(n.id); startMove(e, n.id); } });
      labels.set(n.id, l);
    }
    l.textContent = (n.reusable ? '◆ ' : '') + (n.name ?? n.type);
    l.className = `flabel${n.id === selected ? ' sel' : ''}${n.reusable || n._ref ? ' comp' : ''}`;
  }
  for (const [id, l] of labels) if (!keep.has(id)) l.remove(), labels.delete(id);
}
const sel = { box: h('div', { class: 'sel-box' }), badge: h('div', { class: 'size-badge' }), hover: h('div', { class: 'hover-box' }),
  handles: [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => h('div', { class: 'handle', style: { cursor: cx === cy ? 'nwse-resize' : 'nesw-resize' }, onpointerdown: (e) => startResize(e, cx, cy) })) };
let selRect = null, hoverRect = null; // world-space rects of the selection/hover, measured when they change
const worldRectOf = (id) => {
  const el = id && elOf(id);
  if (!el?.isConnected) return null;
  const r = el.getBoundingClientRect();
  return { x: (r.left - cam.x) / cam.z, y: (r.top - cam.y) / cam.z, w: r.width / cam.z, h: r.height / cam.z };
};
const toScreen = (r) => ({ left: cam.x + r.x * cam.z, top: cam.y + r.y * cam.z, width: r.w * cam.z, height: r.h * cam.z });
const place = (el, r) => Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
function drawOverlay({ remeasure = false } = {}) {
  if (remeasure) { selRect = worldRectOf(selected); hoverRect = hovered !== selected ? worldRectOf(hovered) : null; }
  const W = innerWidth, H = innerHeight, nodes = [];
  for (const [id, l] of labels) {
    const r = rootRect.get(id);
    if (!r) continue;
    const s = toScreen(r);
    if (s.left + s.width < 0 || s.top + s.height < 0 || s.left > W || s.top > H || s.width < 24) continue;
    l.style.transform = `translate(${s.left}px, ${s.top}px) translateY(-100%)`;
    l.style.maxWidth = `${Math.max(24, s.width)}px`;
    nodes.push(l);
  }
  if (hoverRect && hovered !== selected) nodes.push(place(sel.hover, toScreen(hoverRect)) && sel.hover);
  if (selected && selRect) {
    const s = toScreen(selRect), n = info(selected)?.node;
    sel.box.className = `sel-box${isPath(selected) || n?._ref ? ' inst' : ''}`;
    nodes.push(place(sel.box, s) && sel.box);
    if (!isPath(selected)) sel.handles.forEach((hd, i) => { const [cx, cy] = [[0, 0], [1, 0], [0, 1], [1, 1]][i]; hd.style.left = `${s.left + cx * s.width}px`; hd.style.top = `${s.top + cy * s.height}px`; nodes.push(hd); });
    sel.badge.style.left = `${s.left + s.width / 2}px`;
    sel.badge.style.top = `${s.top + s.height}px`;
    sel.badge.textContent = `${Math.round(selRect.w)} × ${Math.round(selRect.h)}`;
    nodes.push(sel.badge);
  }
  // only touch the overlay DOM when the set of visible items changed
  if (nodes.length !== overlay.childElementCount || nodes.some((n, i) => overlay.children[i] !== n)) overlay.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- selection
export function select(id) {
  selected = id ?? null;
  if (id) for (const anc of ancestors(id)) open.add(anc);
  for (const [rid, l] of labels) l.classList.toggle('sel', rid === selected);
  drawOverlay({ remeasure: true });
  renderLayers();
  renderPanel();
  renderAttachments();
  const n = id && info(id)?.node;
  post('/state', { selection: n ? [{ id, name: n.name, type: n.type }] : [] }).catch(() => {});
  if (id) $(`.row[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
}
const ancestors = (id) => {
  const out = [];
  for (let p = info(id)?.parent; p; p = info(p.id)?.parent) out.push(p.id);
  return out;
};
const toWorld = (sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z });

// Selection rules (Figma/pen.dev): a click selects at the current selection's level — the child of the deepest
// common ancestor — so clicking inside a screen picks its direct children; frame labels select the frame itself;
// double-click goes one level deeper. Component instances act as one block until you enter them.
function chainOf(target) {
  const chain = [];
  for (let el = target.closest?.('[data-id]'); el && world.contains(el); el = el.parentElement.closest('[data-id]')) chain.unshift(el.dataset.id);
  const inst = chain.findIndex((id) => info(id)?.node._ref);
  if (inst >= 0 && !(selected === chain[inst] || selected?.startsWith(chain[inst] + '/'))) chain.length = inst + 1;
  return chain;
}
function pick(target) {
  const chain = chainOf(target);
  if (!chain.length) return null;
  if (selected && chain.includes(selected)) return selected;
  const context = selected ? [selected, ...ancestors(selected)] : [];
  const common = chain.filter((id) => context.includes(id)).at(-1);
  if (common) return chain[chain.indexOf(common) + 1] ?? common;
  return chain[1] ?? chain[0];
}

// ---------------------------------------------------------------- canvas interaction
let spaceDown = false;
const DRAW = new Set(['frame', 'rectangle', 'ellipse', 'line', 'text', 'icon', 'note', 'prompt', 'browser']);
function setTool(t) {
  tool = t;
  $$('#tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  canvas.classList.toggle('tool-hand', t === 'hand');
  canvas.classList.toggle('tool-draw', DRAW.has(t));
}
$$('#tools [data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-e.deltaY * 0.01));
  else { cam.x -= e.deltaX; cam.y -= e.deltaY; applyCam(); }
}, { passive: false });
function zoomAt(sx, sy, z) {
  z = Math.min(32, Math.max(0.01, z));
  cam = { x: sx - ((sx - cam.x) * z) / cam.z, y: sy - ((sy - cam.y) * z) / cam.z, z };
  applyCam();
}

canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const id = tool === 'select' ? pick(e.target) : null;
  if (id !== hovered) { hovered = id; drawOverlay({ remeasure: true }); }
});
canvas.addEventListener('pointerleave', () => { hovered = null; drawOverlay({ remeasure: true }); });

canvas.addEventListener('pointerdown', (e) => {
  if (e.target.isContentEditable) return;
  if (e.button === 1 || tool === 'hand' || spaceDown) return pan(e);
  if (DRAW.has(tool)) return startDraw(e);
  const id = pick(e.target);
  if (!id) { select(null); return marquee(e); }
  select(id);
  startMove(e, id);
});

function pan(e) {
  const start = { x: e.clientX - cam.x, y: e.clientY - cam.y };
  canvas.classList.add('panning');
  const move = (ev) => { cam.x = ev.clientX - start.x; cam.y = ev.clientY - start.y; applyCam(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => (removeEventListener('pointermove', move), canvas.classList.remove('panning')), { once: true });
}
// ponytail: single selection; a marquee only clears it. Multi-select is the next step if needed.
function marquee() {}

// Children laid out by flex can't be dragged freely (same as pen.dev); absolute ones and root nodes can.
const isFree = (id) => {
  const { node, parent } = info(id) ?? {};
  return node && !isPath(id) && (!parent || parent.type === 'group' || (parent.layout ?? 'horizontal') === 'none' || node.layoutPosition === 'absolute');
};
function startMove(e, id) {
  if (!isFree(id)) return;
  const n = info(id).node, el = elOf(id), start = { x: e.clientX, y: e.clientY }, x0 = n.x ?? 0, y0 = n.y ?? 0;
  let x = x0, y = y0, moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
    moved = true;
    x = Math.round(x0 + (ev.clientX - start.x) / cam.z);
    y = Math.round(y0 + (ev.clientY - start.y) / cam.z);
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    if (rootRect.has(id)) measure([id]);
    drawOverlay({ remeasure: true });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    if (moved && (x !== x0 || y !== y0)) commit((api) => api.Update(id, { x, y }));
  }, { once: true });
}

function startResize(e, cx, cy) {
  e.stopPropagation();
  const id = selected, n = info(id).node, el = elOf(id), r = el.getBoundingClientRect();
  const w0 = r.width / cam.z, h0 = r.height / cam.z, x0 = n.x ?? 0, y0 = n.y ?? 0, start = { x: e.clientX, y: e.clientY };
  const free = isFree(id);
  let next = {};
  const move = (ev) => {
    const dx = (ev.clientX - start.x) / cam.z, dy = (ev.clientY - start.y) / cam.z;
    const w = Math.max(1, Math.round(cx ? w0 + dx : w0 - dx)), hh = Math.max(1, Math.round(cy ? h0 + dy : h0 - dy));
    next = { width: w, height: hh };
    if (free && !cx) next.x = Math.round(x0 + (w0 - w));
    if (free && !cy) next.y = Math.round(y0 + (h0 - hh));
    if (n.type === 'text') next.textGrowth = 'fixed-width-height';
    Object.assign(el.style, { width: `${w}px`, height: `${hh}px`, ...(next.x !== undefined && { left: `${next.x}px` }), ...(next.y !== undefined && { top: `${next.y}px` }), flex: 'none' });
    if (rootRect.has(id)) measure([id]);
    drawOverlay({ remeasure: true });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => (removeEventListener('pointermove', move), Object.keys(next).length && commit((api) => api.Update(id, next))), { once: true });
}

// Draw tools: drag to size, click for a default size. The new node goes into the frame under the cursor.
const DEFAULTS = {
  frame: { name: 'Frame', width: 390, height: 844, fill: '#FFFFFF', layout: 'none', clip: true },
  rectangle: { name: 'Retângulo', width: 100, height: 100, fill: '#D9D9D9' },
  ellipse: { name: 'Elipse', width: 100, height: 100, fill: '#D9D9D9' },
  line: { name: 'Linha', width: 120, height: 0, stroke: '#000000', strokeWidth: 1 },
  text: { name: 'Texto', content: 'Texto', fontFamily: 'Inter', fontSize: 16, fill: '#000000' },
  icon: { name: 'Ícone', library: 'lucide', icon: 'star', width: 24, height: 24, fill: '#000000' },
  note: { name: 'Nota', width: 240, height: 140, content: '' },
  prompt: { name: 'Prompt', width: 320, height: 160, content: 'Descreva o que o agente deve criar aqui…' },
  browser: { name: 'Página web', width: 1280, height: 800 },
};
function frameAt(sx, sy) {
  for (const el of document.elementsFromPoint(sx, sy)) {
    if (!world.contains(el)) continue;
    const id = el.closest('[data-id]')?.dataset.id;
    if (!id || isPath(id)) continue;
    const n = info(id)?.node;
    if (n?.type === 'frame' || n?.type === 'group') return id;
  }
  return null;
}
function startDraw(e) {
  const type = tool, start = { x: e.clientX, y: e.clientY };
  const ghost = h('div', { class: 'ghost' });
  overlay.append(ghost);
  const move = (ev) => Object.assign(ghost.style, { left: `${Math.min(start.x, ev.clientX)}px`, top: `${Math.min(start.y, ev.clientY)}px`, width: `${Math.abs(ev.clientX - start.x)}px`, height: `${Math.abs(ev.clientY - start.y)}px` });
  addEventListener('pointermove', move);
  addEventListener('pointerup', async (ev) => {
    removeEventListener('pointermove', move);
    ghost.remove();
    const dragged = Math.abs(ev.clientX - start.x) > 4 || Math.abs(ev.clientY - start.y) > 4;
    const parentId = type === 'frame' && !frameAt(start.x, start.y) ? null : frameAt(start.x, start.y);
    const origin = parentId ? elOf(parentId).getBoundingClientRect() : { left: cam.x, top: cam.y };
    const x = Math.round((Math.min(start.x, ev.clientX) - origin.left) / cam.z), y = Math.round((Math.min(start.y, ev.clientY) - origin.top) / cam.z);
    const node = { type, ...DEFAULTS[type], x, y };
    if (dragged) Object.assign(node, { width: Math.round(Math.abs(ev.clientX - start.x) / cam.z), height: type === 'line' ? 0 : Math.round(Math.abs(ev.clientY - start.y) / cam.z) });
    if (dragged && type === 'text') node.textGrowth = 'fixed-width';
    if (type === 'browser') {
      const url = prompt('URL da página:', 'https://');
      if (!url) return setTool('select');
      node.url = url;
    }
    setTool('select');
    const id = await commit((api) => api.Insert(parentId ?? 'document', node), { select: (id) => id });
    if (type === 'text' && id) editText(id);
  }, { once: true });
}

canvas.addEventListener('dblclick', (e) => {
  const chain = chainOf(e.target);
  if (selected && chain.includes(selected) && chain.indexOf(selected) < chain.length - 1) return select(chain[chain.indexOf(selected) + 1]);
  const n = selected && info(selected)?.node;
  if (!n) return;
  if (n.type === 'prompt') return sendPrompt(`${n.content}\n\n(This request comes from a prompt node on the canvas: ${n.id})`, n.content);
  if (n.type === 'text' || n.type === 'note') editText(n.id);
});
function editText(id) {
  const el = elOf(id);
  if (!el) return;
  select(id);
  el.contentEditable = 'plaintext-only';
  el.focus();
  getSelection().selectAllChildren(el);
  el.addEventListener('blur', () => {
    el.contentEditable = 'false';
    const content = el.innerText.replace(/^✦.*\n/, '');
    if (content !== info(id)?.node.content) commit((api) => api.Update(id, { content }));
  }, { once: true });
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) el.blur(); e.stopPropagation(); });
}

// ---------------------------------------------------------------- view helpers
function fitRect(x0, y0, x1, y1, single) {
  const left = document.body.classList.contains('no-left') ? 60 : 420, right = document.body.classList.contains('no-props') ? 20 : 290;
  const aw = innerWidth - left - right, ah = innerHeight - 100, ww = x1 - x0 || 1, wh = y1 - y0 || 1;
  const z = Math.min(single ? 4 : 1, 0.9 * Math.min(aw / ww, ah / wh));
  cam = { z, x: left + (aw - ww * z) / 2 - x0 * z, y: 60 + (ah - wh * z) / 2 - y0 * z };
  applyCam();
}
export function fit(els = $$(':scope > [data-id]', world)) {
  els = els.filter(Boolean);
  if (!els.length) return;
  const rs = els.map((el) => el.getBoundingClientRect());
  const l = Math.min(...rs.map((r) => r.left)), t = Math.min(...rs.map((r) => r.top));
  const rr = Math.max(...rs.map((r) => r.right)), b = Math.max(...rs.map((r) => r.bottom));
  const [wx0, wy0] = [(l - cam.x) / cam.z, (t - cam.y) / cam.z];
  const [ww, wh] = [(rr - l) / cam.z, (b - t) / cam.z];
  const left = document.body.classList.contains('no-left') ? 60 : 420, right = document.body.classList.contains('no-props') ? 20 : 290;
  const aw = innerWidth - left - right, ah = innerHeight - 100;
  const z = Math.min(els.length === 1 ? 4 : 1, 0.9 * Math.min(aw / (ww || 1), ah / (wh || 1)));
  cam = { z, x: left + (aw - ww * z) / 2 - wx0 * z, y: 60 + (ah - wh * z) / 2 - wy0 * z };
  applyCam();
}
const fitSelection = () => selected && fit([elOf(selected)]);
$('#zoom-in').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.25);
$('#zoom-out').onclick = () => zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.25);
$('#zoom-pct').onclick = (e) => menu(e.currentTarget, [
  { label: 'Ajustar tudo (⇧1)', icon: 'maximize', run: () => fit() },
  { label: 'Zoom na seleção (⇧2)', icon: 'scan', run: fitSelection },
  'sep',
  ...[0.5, 1, 2].map((z) => ({ label: `${z * 100}%`, run: () => zoomAt(innerWidth / 2, innerHeight / 2, z) })),
], { above: true, align: 'right' });

// ---------------------------------------------------------------- layers
const TYPE_ICON = { frame: 'frame', group: 'group', text: 'type', rectangle: 'square', ellipse: 'circle', path: 'pen-tool', icon: 'star', polygon: 'pentagon', line: 'minus', note: 'sticky-note', prompt: 'sparkles', context: 'file-text', browser: 'globe', script: 'braces', ref: 'diamond' };
const layerIcon = (n) => {
  if (n.reusable) return 'component';
  if (n._ref) return 'diamond';
  if (n.type === 'frame') return { vertical: 'rows-3', horizontal: 'columns-3' }[n.layout ?? 'horizontal'] ?? 'frame';
  if (n.type === 'rectangle' && [].concat(n.fill ?? []).some((f) => f?.type === 'image')) return 'image';
  return TYPE_ICON[n.type] ?? 'square';
};
function renderLayers() {
  if (!$('#pane-layers').classList.contains('on')) return;
  const rows = [];
  const add = (n, depth) => {
    const kids = n.children?.length > 0, isOpen = open.has(n.id);
    const row = h('div', {
      class: `row${n.id === selected ? ' sel' : ''}${n.reusable ? ' comp' : isPath(n.id) || n._ref ? ' inst' : ''}${n.enabled === false ? ' hidden' : ''}`,
      'data-id': n.id, style: { paddingLeft: `${4 + depth * 14}px` },
      onclick: () => select(n.id),
      ondblclick: (e) => { if (!e.target.closest('.tw')) rename(row, n); },
      onpointerenter: () => { hovered = n.id; drawOverlay({ remeasure: true }); },
    },
      h('span', { class: `tw${isOpen ? ' open' : ''}`, onclick: (e) => { e.stopPropagation(); isOpen ? open.delete(n.id) : open.add(n.id); renderLayers(); } }, kids && ic('chevron-right')),
      ic(layerIcon(n), 15),
      h('span', { class: 'nm' }, n.name ?? n.content?.slice(0, 40) ?? n.type),
      h('span', { class: 'eye', title: 'Mostrar/ocultar', onclick: (e) => { e.stopPropagation(); commit((api) => api.Update(n.id, { enabled: n.enabled === false })); } }, ic(n.enabled === false ? 'eye-off' : 'eye', 14)));
    rows.push(row);
    if (kids && isOpen) for (const c of n.children) add(c, depth + 1);
  };
  for (const n of expanded) add(n, 0);
  $('#layers').replaceChildren(...rows);
}
function rename(row, n) {
  const input = h('input', { value: n.name ?? '' });
  row.querySelector('.nm').replaceWith(input);
  input.focus(); input.select();
  const done = () => (input.value !== (n.name ?? '') ? commit((api) => api.Update(n.id, { name: input.value })) : renderLayers());
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') (input.value = n.name ?? ''), input.blur(); };
  input.onblur = done;
}
$('#layers').addEventListener('pointerleave', () => { hovered = null; drawOverlay({ remeasure: true }); });

// ---------------------------------------------------------------- components
const components = () => { const out = []; indexNodes(doc).forEach(({ node }) => node.reusable && out.push(node)); return out; };
const countInstances = (id) => { let c = 0; indexNodes(doc).forEach(({ node }) => node.type === 'ref' && node.ref === id && c++); return c; };
async function insertInstance(comp) {
  const sel = selected && !isPath(selected) && info(selected)?.node;
  const parent = sel?.type === 'frame' && !sel.reusable ? sel.id : 'document';
  await commit((api) => {
    const pos = parent === 'document' ? toWorld(innerWidth / 2, innerHeight / 2) : { x: 20, y: 20 };
    return api.Insert(parent, { type: 'ref', ref: comp.id, name: comp.name, x: Math.round(pos.x), y: Math.round(pos.y) });
  }, { select: (id) => id });
}
function renderComponents() {
  if (!$('#pane-components').classList.contains('on')) return;
  const list = components();
  $('#components').replaceChildren(
    ...(list.length ? list.map((c) => h('div', { class: 'comp-card', onclick: () => { select(c.id); fitSelection(); } },
      ic('component'), h('span', {}, c.name ?? c.id), h('small', {}, `${countInstances(c.id)} inst.`),
      h('button', { class: 'btn icon', title: 'Inserir instância', onclick: (e) => { e.stopPropagation(); insertInstance(c); } }, ic('plus'))))
      : [h('div', { class: 'hint', style: { padding: '16px 10px' } }, 'Nenhum componente. Selecione um frame e clique em “Criar componente” no painel de propriedades (⌘⌥K).')]));
}
$('#tool-component').onclick = (e) => {
  const list = components();
  menu(e.currentTarget, list.length ? [{ head: 'Inserir componente' }, ...list.map((c) => ({ label: c.name ?? c.id, icon: 'component', run: () => insertInstance(c) }))] : [{ head: 'Nenhum componente no arquivo' }]);
};

// tabs
$$('.tabs [data-tab]').forEach((b) => (b.onclick = () => {
  $$('.tabs [data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  $$('#left .pane').forEach((p) => p.classList.toggle('on', p.id === `pane-${b.dataset.tab}`));
  renderLayers(); renderComponents();
}));

// ---------------------------------------------------------------- images
async function importImage(file, at) {
  const res = await fetch(`/upload?name=${encodeURIComponent(file.name || 'image.png')}`, { method: 'POST', body: file });
  if (!res.ok) return toast(await res.text());
  const { url } = await res.json();
  const img = await createImageBitmap(file).catch(() => ({ width: 400, height: 300 }));
  const k = Math.min(1, 800 / Math.max(img.width, img.height));
  const sel = selected && !isPath(selected) && info(selected)?.node;
  const parent = sel?.type === 'frame' ? selected : 'document';
  const pos = at ?? toWorld(innerWidth / 2, innerHeight / 2);
  await commit((api) => api.Insert(parent, {
    type: 'rectangle', name: file.name?.replace(/\.\w+$/, '') || 'Imagem', width: Math.round(img.width * k), height: Math.round(img.height * k),
    fill: { type: 'image', url, mode: 'cover' }, ...(parent === 'document' ? { x: Math.round(pos.x), y: Math.round(pos.y) } : { x: 0, y: 0 }),
  }), { select: (id) => id });
}
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) await importImage(f, toWorld(e.clientX, e.clientY));
});
$('#tool-image').onclick = () => {
  const pick = h('input', { type: 'file', accept: 'image/*', multiple: true });
  pick.onchange = async () => { for (const f of pick.files) await importImage(f); };
  pick.click();
};

// ---------------------------------------------------------------- clipboard + keyboard
addEventListener('copy', (e) => {
  if (e.target.matches?.('input, textarea, [contenteditable="plaintext-only"]') || !selected) return;
  const n = isPath(selected) ? info(selected).node : indexNodes(doc).get(selected).node;
  e.clipboardData.setData('text/plain', JSON.stringify({ pena: 1, nodes: [stripInternal(n)] }));
  e.preventDefault();
});
addEventListener('paste', async (e) => {
  if (e.target.matches?.('input, textarea, [contenteditable]')) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return files.forEach((f) => importImage(f));
  let data;
  try { data = JSON.parse(e.clipboardData.getData('text/plain')); } catch { return; }
  if (!data?.pena) return;
  e.preventDefault();
  const sel = selected && !isPath(selected) && info(selected)?.node;
  const parent = sel?.type === 'frame' || sel?.type === 'group' ? sel.id : info(selected)?.parent?.id && !isPath(info(selected).parent.id) ? info(selected).parent.id : 'document';
  await commit((api) => {
    let last;
    for (const n of data.nodes) last = api.Insert(parent, { ...n, x: (n.x ?? 0) + 20, y: (n.y ?? 0) + 20 });
    return last;
  }, { select: (id) => id });
});
const stripInternal = (n) => { const { _ref, ...rest } = n; return { ...rest, ...(n.children && { children: n.children.map(stripInternal) }) }; };

addEventListener('keydown', (e) => {
  if (e.target.matches?.('input, textarea, select, [contenteditable="plaintext-only"]')) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (e.code === 'Space' && !spaceDown) { spaceDown = true; canvas.classList.add('tool-hand'); return; }
  if (mod && k === 'z') { e.preventDefault(); return e.shiftKey ? restore(redo, undo) : restore(undo, redo); }
  if (mod && k === 'y') { e.preventDefault(); return restore(redo, undo); }
  if (mod && (k === '=' || k === '+')) { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, cam.z * 1.25); }
  if (mod && k === '-') { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, cam.z / 1.25); }
  if (mod && k === '0') { e.preventDefault(); return zoomAt(innerWidth / 2, innerHeight / 2, 1); }
  if (mod && k === '\\') { e.preventDefault(); return document.body.classList.toggle('no-left'); }
  if (mod && k === '.') { e.preventDefault(); return document.body.classList.toggle('hide-ui'); }
  if (e.shiftKey && e.code === 'Digit1') return fit();
  if (e.shiftKey && e.code === 'Digit2') return fitSelection();
  if (!mod && !e.altKey) {
    const t = { v: 'select', f: 'frame', r: 'rectangle', o: 'ellipse', l: 'line', t: 'text', i: 'icon', n: 'note', p: 'prompt', w: 'browser', h: 'hand' }[k];
    if (t && !e.shiftKey) return setTool(t);
  }
  if (e.key === 'Escape') {
    if (tool !== 'select') return setTool('select');
    return select(selected && info(selected)?.parent ? info(selected).parent.id : null);
  }
  if (e.key === 'Enter' && selected) {
    const n = info(selected).node;
    if (n.type === 'text' || n.type === 'note') { e.preventDefault(); return editText(selected); }
    if (n.children?.length) return select(n.children[0].id);
  }
  if (!selected) return;
  const id = selected, path = isPath(id);
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    const parent = info(id)?.parent?.id ?? null;
    return commit((api) => (path ? api.Update(id, { enabled: false }) : api.Delete(id)), { select: path ? id : parent });
  }
  if (mod && k === 'd' && !e.shiftKey && !path) {
    e.preventDefault();
    const free = isFree(id), n = info(id).node;
    return commit((api) => api.Copy(id, info(id).parent?.id ?? 'document', free ? { x: (n.x ?? 0) + 20, y: (n.y ?? 0) + 20 } : {}), { select: (nid) => nid });
  }
  if (mod && e.altKey && k === 'k' && !path) { e.preventDefault(); return commit((api) => api.Update(id, { reusable: !info(id).node.reusable })); }
  if (mod && e.altKey && k === 'g' && !path) { e.preventDefault(); return wrapInFrame(id); }
  if (mod && e.shiftKey && k === 'h') { e.preventDefault(); return commit((api) => api.Update(id, { enabled: info(id).node.enabled === false })); }
  if (mod && (k === ']' || k === '[') && !path) {
    e.preventDefault();
    const siblings = info(id).parent?.children ?? expanded, i = siblings.findIndex((c) => c.id === id);
    const to = k === ']' ? (e.altKey ? siblings.length - 1 : Math.min(siblings.length - 1, i + 1)) : (e.altKey ? 0 : Math.max(0, i - 1));
    return commit((api) => api.Move(id, undefined, to));
  }
  if (e.key.startsWith('Arrow') && isFree(id)) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1, n = info(id).node;
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
    return commit((api) => api.Update(id, { x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy }));
  }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; canvas.classList.toggle('tool-hand', tool === 'hand'); } });

function wrapInFrame(id) {
  const { node, parent } = info(id), el = elOf(id);
  const w = Math.round(el.offsetWidth), hh = Math.round(el.offsetHeight);
  return commit((api) => {
    const parentId = parent?.id ?? 'document', index = (parent?.children ?? expanded).findIndex((c) => c.id === id);
    const frame = api.Insert(parentId, { type: 'frame', name: 'Frame', layout: 'none', x: node.x ?? 0, y: node.y ?? 0, width: w, height: hh });
    api.Move(frame, parentId, index);
    api.Move(id, frame);
    api.Update(id, { x: 0, y: 0 });
    return frame;
  }, { select: (fid) => fid });
}

// ---------------------------------------------------------------- top bar
$('#hide-props').onclick = () => document.body.classList.toggle('no-props');
$('#panels-toggle').onclick = () => document.body.classList.toggle('no-left');
$('#go-dashboard').onclick = () => (location.href = '/dashboard');
$('#docname').onclick = (e) => menu(e.currentTarget, [
  { label: 'Dashboard', icon: 'layout-grid', run: () => (location.href = '/dashboard') },
  { label: 'Abrir arquivo…', icon: 'folder-open', run: async () => { const r = await post('/api/dialog', { kind: 'open' }); if (!r.ok) location.href = '/dashboard'; } },
  { label: 'Novo arquivo', icon: 'file-plus', run: () => post('/api/new') },
  'sep',
  { label: 'Exportar seleção…', icon: 'share', run: () => $('#export-btn').click() },
]);
$('#theme-btn').onclick = (e) => {
  const axes = Object.entries(doc.themes ?? {});
  if (!axes.length) return menu(e.currentTarget, [{ head: 'Este arquivo não tem temas' }]);
  const base = { ...themeDefaults(doc), ...theme };
  menu(e.currentTarget, axes.flatMap(([axis, values]) => [{ head: `${axis} (pré-visualização)` }, ...values.map((v) => ({ label: v, on: base[axis] === v, run: () => { theme = { ...theme, [axis]: v }; render(); } }))]), { align: 'right' });
};
const FORMATS = [['PNG', 'png'], ['JPEG', 'jpeg'], ['WebP', 'webp'], ['PDF', 'pdf'], ['HTML + CSS', 'html-css']];
$('#export-btn').onclick = (e) => {
  const id = selected ?? expanded[0]?.id;
  if (!id) return toast('Nada para exportar');
  menu(e.currentTarget, [{ head: `Exportar “${info(id).node.name ?? id}”` }, ...FORMATS.map(([label, f]) => ({ label, run: () => download(id, f) }))], { align: 'right' });
};
export async function download(id, format, scale = 2) {
  const data = await exportNode(id, format, { scale });
  const name = `${info(id)?.node.name ?? 'export'}.${format === 'html-css' ? 'html' : format}`;
  const a = h('a', { download: name, href: data.startsWith('data:') ? data : URL.createObjectURL(new Blob([data], { type: 'text/html' })) });
  a.click();
}
$('#preview').onclick = async () => {
  let id = selected ?? expanded[0]?.id;
  while (id && info(id)?.parent) id = info(id).parent.id;
  if (!id) return;
  const html = await exportNode(id, 'html-css', {});
  const close = () => bg.remove();
  const bg = h('div', { class: 'modal-bg', onclick: (e) => e.target === bg && close() },
    h('div', { class: 'modal', style: { width: '92vw', maxHeight: '92vh', height: '92vh' } },
      h('header', {}, ic('play'), info(id).node.name ?? 'Pré-visualização', h('div', { style: { flex: 1 } }), h('button', { class: 'btn icon', onclick: close }, ic('x'))),
      h('iframe', { srcdoc: html, style: { flex: 1, border: 0, background: '#fff' } })));
  document.body.append(bg);
};

// ---------------------------------------------------------------- export (also used by agents: TakeScreenshot/Export)
export async function exportNode(id, format, { scale = 2, quality = 92, includeHtmlScaffold = true, includeLayerNames = true, includeLayerIds = false } = {}) {
  const el = elOf(id);
  if (!el) throw new Error(`Node not found on canvas: ${id}`);
  const reset = { left: '0', top: '0', margin: '0', position: 'relative', width: `${el.offsetWidth}px`, height: `${el.offsetHeight}px`, flex: 'none', outline: 'none' };
  if (format.startsWith('html')) {
    const clone = el.cloneNode(true);
    Object.assign(clone.style, reset);
    for (const n of [clone, ...clone.querySelectorAll('[data-id]')]) {
      const node = info(n.dataset.id)?.node;
      if (includeLayerNames && node?.name) n.dataset.name = node.name;
      if (!includeLayerIds) delete n.dataset.id;
      delete n.dataset.instance; delete n.dataset.component;
    }
    const fonts = [...loadedFonts].map((f) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@100..900&display=swap">`).join('\n');
    return includeHtmlScaffold ? `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${fonts}\n<style>body{margin:0}</style>\n</head>\n<body>\n${clone.outerHTML}\n</body>\n</html>\n` : clone.outerHTML;
  }
  // Render a detached copy: inside the zoomed canvas the capture comes out blank.
  const { toCanvas } = await import('https://esm.sh/html-to-image@1.11.13');
  const host = h('div', { style: { position: 'fixed', left: '-100000px', top: '0' } });
  const copy = el.cloneNode(true);
  Object.assign(copy.style, reset);
  host.append(copy);
  document.body.append(host);
  let cv;
  try { cv = await toCanvas(copy, { pixelRatio: scale, cacheBust: true }); } finally { host.remove(); }
  if (format === 'pdf') {
    const { jsPDF } = await import('https://esm.sh/jspdf@2.5.2');
    const pdf = new jsPDF({ unit: 'px', format: [el.offsetWidth, el.offsetHeight], orientation: el.offsetWidth > el.offsetHeight ? 'l' : 'p', hotfixes: ['px_scaling'] });
    pdf.addImage(cv.toDataURL('image/png'), 'PNG', 0, 0, el.offsetWidth, el.offsetHeight);
    return pdf.output('datauristring');
  }
  return cv.toDataURL(`image/${format === 'jpg' ? 'jpeg' : format}`, quality / 100);
}

// Dashboard thumbnails: the largest top-level frame, rendered small, a few seconds after changes.
let previewTimer;
function schedulePreview(delay = 4000) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const frames = expanded.filter((n) => n.enabled !== false && elOf(n.id));
    if (!frames.length) return;
    const big = frames.map((n) => [n, elOf(n.id)]).sort((a, b) => b[1].offsetWidth * b[1].offsetHeight - a[1].offsetWidth * a[1].offsetHeight)[0];
    try {
      const data = await exportNode(big[0].id, 'png', { scale: Math.min(1, 480 / Math.max(big[1].offsetWidth, big[1].offsetHeight)) });
      await post('/api/preview', await (await fetch(data)).blob());
    } catch {}
  }, delay);
}

// ---------------------------------------------------------------- agent chat
const log = (kind, text, who) => {
  const el = $('#log');
  el.querySelector('.empty-chat')?.remove();
  if (who && who !== 'main' && el.lastChild?.dataset.who !== who) el.append(h('div', { class: 'msg who', 'data-who': who }, who));
  if (kind === 'tool') el.append(h('div', { class: 'msg tool' }, ic('wand-sparkles'), text));
  else if (kind === 'busy') el.append(h('div', { class: 'msg tool busy' }, h('span', { class: 'spinner' }), text));
  else el.append(h('div', { class: `msg ${kind}`, innerHTML: kind === 'text' ? md(text) : undefined }, kind === 'text' ? null : text));
  el.scrollTop = 1e9;
};
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
const SUGGESTIONS = [
  'Terminal de trading em tempo real, alto contraste',
  'Landing page retrô-futurista para uma estação espacial privada',
  'App divertido de pedidos para bolos de matcha',
  'App de meditação neumórfico suave',
  'Portfólio editorial para uma marca de moda de vanguarda',
  'App mobile aconchegante para cuidar de plantas',
];
function emptyChat() {
  $('#log').replaceChildren(h('div', { class: 'empty-chat' },
    h('h4', {}, 'Peça para desenhar qualquer coisa'),
    SUGGESTIONS.map((s) => h('button', { class: 'suggest', onclick: () => { $('#prompt').value = s; $('#prompt').focus(); autoGrow(); } }, s)),
    h('div', { class: 'tip' }, h('b', {}, 'Gerar código'), 'Peça ao agente para implementar o design em React, Tailwind, Next.js ou a stack que preferir. Para um HTML, selecione um frame e use “Exportar HTML” no painel de propriedades.'),
    h('div', { class: 'tip' }, h('b', {}, 'Anexar contexto'), 'Arraste um PNG/JPG para o compositor ou anexe pelo +. Use ⌘V para colar imagens no canvas.')));
}
let busy = 0;
const setBusy = (d) => { busy = Math.max(0, busy + d); $('#send').replaceChildren(ic(busy ? 'square' : 'arrow-up', busy ? 12 : 15)); $('#send').title = busy ? 'Parar' : 'Enviar (Enter)'; };
let attachments = [], skills = [];
function renderAttachments() {
  $('#attachments').replaceChildren(
    ...skills.map((s, i) => h('span', { class: 'att skill', title: s.description }, ic('sparkles', 12), s.name, h('button', { onclick: () => { skills.splice(i, 1); renderAttachments(); } }, ic('x', 12)))),
    ...attachments.map((a, i) => h('span', { class: 'att' }, ic('image', 12), a.name, h('button', { onclick: () => { attachments.splice(i, 1); renderAttachments(); } }, ic('x', 12)))),
    ...(selected ? [h('span', { class: 'att', title: 'Seleção atual vai junto com a mensagem' }, ic('frame', 12), info(selected)?.node.name ?? selected)] : []));
}
function sendPrompt(prompt, shown = prompt, images = [], skillNames = []) {
  log('user', skillNames.length ? `${skillNames.map((s) => `/${s}`).join(' ')}\n${shown}` : shown);
  for (const im of images) $('#log').append(h('img', { src: im.data, class: 'msg', style: { alignSelf: 'flex-end', maxWidth: '60%' } }));
  const p = pref();
  post('/chat', { provider: p.provider, model: p.model, effort: p.effort, prompt, images, skills: skillNames, ...agentsPref() });
  $('#conv-name').value = shown.slice(0, 40);
}
function submit() {
  if (busy) return post('/stop');
  const text = $('#prompt').value.trim();
  if (!text && !attachments.length && !skills.length) return;
  const sel = selected && info(selected)?.node;
  const body = text || 'Apply the attached skill to the current design.';
  sendPrompt(sel ? `${body}\n\n(Selected node: ${selected} "${sel.name ?? sel.type}")` : body, text, attachments, skills.map((s) => s.name));
  $('#prompt').value = ''; attachments = []; skills = []; renderAttachments(); autoGrow();
}
const autoGrow = () => { const t = $('#prompt'); t.style.height = 'auto'; t.style.height = `${Math.min(200, t.scrollHeight)}px`; };
$('#prompt').addEventListener('input', autoGrow);
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
$('#send').onclick = submit;
$('#attach').onclick = () => $('#attach-file').click();
const readFile = (f) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r({ name: f.name, data: fr.result }); fr.readAsDataURL(f); });
$('#attach-file').onchange = async () => { for (const f of $('#attach-file').files) attachments.push(await readFile(f)); renderAttachments(); $('#attach-file').value = ''; };
$('#composer').addEventListener('dragover', (e) => e.preventDefault());
$('#composer').addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) attachments.push(await readFile(f)); renderAttachments(); });
$('#new-chat').onclick = () => { post('/chat', { provider: 'reset' }); emptyChat(); $('#conv-name').value = 'Novo agente'; };
const refreshModel = async () => {
  $('#model').replaceChildren(await modelLabel(), ic('chevron-down', 12));
  $('#effort').replaceChildren(ic('zap', 12), pref().effort ?? '—');
};
$('#model').onclick = (e) => pickModel(e.currentTarget, refreshModel);
agentsButton($('#agents'));
slashSkills($('#prompt'), (s) => { if (!skills.some((x) => x.name === s.name)) skills.push(s); renderAttachments(); });
$('#effort').onclick = (e) => pickEffort(e.currentTarget, refreshModel);

// ---------------------------------------------------------------- live sync with the server
const events = new EventSource('/events');
events.addEventListener('doc', () => reload());
events.addEventListener('file', () => { selected = null; undo.length = redo.length = 0; emptyChat(); reload(true); });
events.addEventListener('agent', (e) => {
  const { agent, kind, text } = JSON.parse(e.data);
  if (kind === 'busy') { setBusy(1); return log('busy', `${text} trabalhando…`, agent); }
  if (kind === 'done') { setBusy(-1); $$('#log .busy').forEach((b) => b.remove()); return; }
  log(kind, text, agent);
});
events.addEventListener('render', async (e) => {
  const { reqId, ids, format, options = {} } = JSON.parse(e.data);
  try {
    await reload(); // the agent's last edit was saved just before this request: draw it first
    await document.fonts.ready;
    const results = [];
    for (const id of ids) results.push({ id, data: await exportNode(id, format, options) });
    post('/render-result', { reqId, results });
  } catch (err) {
    post('/render-result', { reqId, error: String(err.message ?? err) });
  }
});

async function reload(first) {
  if (first) performance.mark('pena:load-start');
  const res = await fetch('/doc');
  if (res.status === 409) return (location.href = '/dashboard');
  const name = decodeURIComponent(res.headers.get('x-pena-name') ?? '');
  const next = migrate(await res.json());
  $('#docname span').textContent = name;
  document.title = `${name} — Pena`;
  if (first) {
    doc = next;
    await renderProgressive();
    performance.mark('pena:load-end');
    schedulePreview(1500);
    return;
  }
  // Changed by an agent or another app: re-render only the roots that differ.
  if (saveTimer) await flushSave(); // never drop local edits that were about to be saved
  const now = new Map(doc.children.map((c) => [c.id, JSON.stringify(c)]));
  const dirty = new Set();
  for (const c of next.children) if (now.get(c.id) !== JSON.stringify(c)) dirty.add(c.id);
  for (const id of now.keys()) if (!next.children.some((c) => c.id === id)) dirty.add(id);
  const full = metaOf(next) !== metaOf(doc);
  const reordered = next.children.map((c) => c.id).join() !== doc.children.map((c) => c.id).join();
  if (!dirty.size && !full && !reordered) return;
  doc = next;
  update(dirty, { full });
}
addEventListener('resize', drawOverlay);
toast.timer = 0;
function toast(msg) {
  $('.toast')?.remove();
  const t = h('div', { class: 'toast', style: { position: 'fixed', left: '50%', bottom: '64px', transform: 'translateX(-50%)', padding: '8px 14px', borderRadius: '10px', background: '#3f3f46', color: '#fff', zIndex: 60 } }, msg);
  document.body.append(t);
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.remove(), 3500);
}

// Internals for profiling (scripts/bench.mjs drives these through the DevTools protocol).
window.__pena = { render, select, commit, drawOverlay, reload, fit, getCam: () => cam, setCam: (c) => { cam = c; applyCam(); }, doc: () => doc, expanded: () => expanded, info };

// Hooks for the desktop app's native menus.
window.pena = {
  exportSelection: (format) => {
    const id = selected ?? expanded[0]?.id;
    if (!id) throw new Error('Nada para exportar');
    return exportNode(id, format, { scale: 2 }).then((data) => ({ data, name: info(id)?.node.name ?? 'export' }));
  },
  importImage: (bytes, name) => importImage(new File([new Uint8Array(bytes)], name, { type: `image/${name.split('.').pop().replace('jpg', 'jpeg').replace('svg', 'svg+xml')}` })),
  fit: () => fit(),
};

// ---------------------------------------------------------------- start
emptyChat();
refreshModel();
setBusy(0);
await reload(true);
// Prompt/image handed over by the dashboard.
const start = JSON.parse(sessionStorage.getItem('pena.startPrompt') ?? 'null');
const startImage = JSON.parse(sessionStorage.getItem('pena.startImage') ?? 'null');
sessionStorage.removeItem('pena.startPrompt'); sessionStorage.removeItem('pena.startImage');
if (start) sendPrompt(start.text, start.text, start.image ? [start.image] : [], start.skills ?? []);
if (startImage) importImage(await (await fetch(startImage.data)).blob().then((b) => new File([b], startImage.name, { type: b.type })));
