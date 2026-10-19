// Pena editor: canvas, selection, tools, layers, components, chat. Every edit goes through the same
// document API the agents use (pen-core.js), so humans and agents follow identical rules.
import { createApi, migrate, expandDoc, expandNode, indexNodes, themeDefaults, sizeNumber, loadImports, setLib, resolveProps, mergeDocs } from './pen-core.js';
import { renderDoc, loadDocFonts, loadedFonts } from './render.js';
import { initSkia, fonts } from './skia.js';
import { Scene } from './scene.js';
import { createView } from './view.js';
import { $, $$, h, ic, hydrateIcons, menu, busy as busyOverlay, modelLabel, pickModel, pickEffort, pref, timeAgo, EFFORT_LABEL } from './ui.js';
import { renderProps } from './props.js';
import { slashSkills, agentsButton, agentsPref } from './composer.js';
import { openSettings } from './settings.js';
import { createChatLog, copyBtn } from './chatlog.js';
import { createPresence } from './presence.js';
import { t } from './i18n.js';
window.penaSettings = openSettings;
$('#open-settings').onclick = () => openSettings();

hydrateIcons();
$('#send').append(ic('arrow-up', 15));

// ---------------------------------------------------------------- state
let doc = migrate({ children: [] }), expanded = [], view = new Map();
let selected = null, hovered = null, tool = 'select', theme = {};
const extra = new Set(); // other selected nodes (shift-click / marquee); `selected` is the primary one the panel edits
const selection = () => (selected ? [selected, ...extra] : []);
const isSel = (id) => !!id && (id === selected || extra.has(id));
const pruneSelection = () => {
  for (const id of extra) if (!view.has(id)) extra.delete(id);
  if (selected && !view.has(selected)) selected = null;
  if (!selected && extra.size) { selected = [...extra].at(-1); extra.delete(selected); }
};
let cam = { x: 80, y: 80, z: 0.5 };
const undo = [], redo = [];
const open = new Set(); // expanded rows in the layers tree
const canvas = $('#canvas'), world = $('#world'), overlay = $('#overlay');
const isPath = (id) => id?.includes('/');
const info = (id) => view.get(id);
// The canvas is drawn by Skia (scene.js/view.js); there are no DOM elements per node. `elOf` returns a small
// element-like view of a node's measured box for code that only needs sizes and screen rects (panels, fit, export).
let scene;
const elOf = (id) => {
  const n = id && scene?.node(id);
  if (!n) return null;
  const [w, hh] = n.dims();
  return {
    id, offsetWidth: w, offsetHeight: hh,
    getBoundingClientRect: () => { const b = n.bounds(), r = toScreen(b); return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top }; },
  };
};
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
  // one index of the document for the whole edit, rebuilt only after structural changes (it walks every node)
  let idx = null;
  const index = () => (idx ??= indexNodes(doc));
  const restructured = (v) => ((idx = null), v);
  const touch = (path) => snap(rootIdOf(path, index()));
  const created = (parent, id) => (rootIdOf(parent, index()) ? null : snap(id, true));
  // Operations are recorded so the DOM can be patched node by node (see patch()).
  const ops = [];
  const comps = new Set(); // components whose definition changed
  const watch = (path) => {
    const ix = index();
    for (let n = ix.get(path?.split('/')[0]); n; n = n.parent && n.parent !== doc ? ix.get(n.parent.id) : null) if (n.node.reusable) comps.add(n.node.id);
  };
  const api = createApi(doc);
  const tracked = {
    ...api,
    touch: (path) => { touch(path); watch(path); ops.push({ t: 'update', id: path }); },
    Insert: (p, d) => { touch(p); watch(p); const id = restructured(api.Insert(p, d)); created(p, id); ops.push({ t: 'insert', id }); return id; },
    Copy: (path, p, d) => { touch(p); watch(p); const id = restructured(api.Copy(path, p, d)); created(p, id); ops.push({ t: 'insert', id }); return id; },
    Update: (path, d) => { touch(path); watch(path); api.Update(path, d); ops.push({ t: 'update', id: path, keys: Object.keys(d) }); },
    Replace: (path, d) => { const root = rootIdOf(path, index()); touch(path); watch(path); const id = restructured(api.Replace(path, d)); if (root === path) snap(id, true); ops.push({ t: 'remove', id: path }, { t: 'insert', id }); return id; },
    Move: (path, p, i) => { touch(path); touch(p); watch(path); watch(p); restructured(api.Move(path, p, i)); ops.push({ t: 'remove', id: path }, { t: 'insert', id: path }); },
    Delete: (path) => { touch(path); watch(path); restructured(api.Delete(path)); ops.push({ t: 'remove', id: path }); },
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
  if (sel !== undefined) {
    const ids = [].concat((typeof sel === 'function' ? sel(result) : sel) ?? []);
    selected = ids[0] ?? null;
    extra.clear();
    ids.slice(1).forEach((id) => extra.add(id));
  }
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
// `rev`/`base`: the server version this editor last synced with. A save says which roots changed since then, so
// when an agent wrote the file meanwhile the server merges instead of overwriting (mergeDocs). Saves and reloads
// run one at a time on the `saving` chain.
const snapshot = (d) => ({ roots: new Map(d.children.map((c) => [c.id, JSON.stringify(c)])), meta: metaOf(d), order: d.children.map((c) => c.id).join() });
const changesSince = (b, s = snapshot(doc)) => ({
  roots: [...new Set([...s.roots.keys(), ...b.roots.keys()])].filter((id) => s.roots.get(id) !== b.roots.get(id)),
  meta: s.meta !== b.meta,
  order: s.order !== b.order,
});
const changed = (c) => c.roots.length > 0 || c.meta || c.order;
const saveUrl = (path, changes) => `${path}?rev=${encodeURIComponent(rev)}&changes=${encodeURIComponent(JSON.stringify(changes))}`;
let rev = '', base = snapshot(doc);
let saveTimer = null, saving = Promise.resolve();
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, busy ? 0 : 300);
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(async () => {
    const sent = snapshot(doc), changes = changesSince(base, sent);
    if (!changed(changes)) return;
    const res = await fetch(saveUrl('/doc', changes), { method: 'PUT', body: JSON.stringify(doc, null, 2) });
    if (!res.ok) throw new Error(await res.text());
    const r = await res.json();
    rev = r.rev;
    base = sent;
    if (r.merged) await sync(); // an agent wrote meanwhile: show the merged document
  }).catch(() => toast('Falha ao salvar — o app ainda está rodando?'));
  return saving;
}
addEventListener('beforeunload', () => { if (saveTimer) navigator.sendBeacon?.(saveUrl('/doc-beacon', changesSince(base)), JSON.stringify(doc, null, 2)); });

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
function measure(ids) {
  for (const id of ids) {
    const b = scene.bounds(id);
    b ? rootRect.set(id, b) : rootRect.delete(id);
  }
  postRects();
}
// Rendered sizes of top-level frames for the agents' FindEmptySpace: the server has no layout, so a hug-content
// frame would otherwise count as 0 px tall and new screens would be placed on top of it.
let rectsTimer;
const postRects = () => {
  clearTimeout(rectsTimer);
  rectsTimer = setTimeout(() => post('/rects', Object.fromEntries([...rootRect].map(([id, r]) => [id, { w: Math.round(r.w), h: Math.round(r.h) }]))).catch(() => {}), 300);
};
async function needFonts() {
  const list = scene.fontsNeeded();
  loadFonts(list.map(([f]) => f)); // CSS copies for the text editor overlay and HTML export
  await Promise.race([Promise.all(list.map(([f, w, i]) => fonts.ensure(f, w, i))), new Promise((r) => setTimeout(r, 4000))]);
}

// Full render: first load, theme/variable changes.
export function render() {
  rootMeta.clear();
  expanded = expandDoc(doc);
  indexView();
  pruneSelection();
  for (const raw of doc.children) rootMeta.set(raw.id, metaFor(raw));
  Object.assign(scene, { doc, themeOverride: theme });
  scene.build(expanded);
  rootRect.clear();
  measure(expanded.map((n) => n.id));
  needFonts();
  canvasView.invalidate();
  afterRender();
}

// First load of a file: Skia + fonts, then one layout of the whole document (pen.dev renders the same way).
async function renderProgressive() {
  rootMeta.clear(); rootRect.clear();
  expanded = expandDoc(doc);
  indexView();
  for (const raw of doc.children) rootMeta.set(raw.id, metaFor(raw));
  performance.mark('pena:expanded');
  await initSkia();
  performance.mark('pena:skia');
  fonts.setDocFonts(doc.fonts, assetUrl);
  if (!scene) {
    scene = new Scene(doc, { theme, assetUrl, onChange: () => canvasView?.invalidate() });
    scene.onLayout = () => { measure(expanded.map((n) => n.id)); drawOverlay({ remeasure: true }); };
    canvasView = createView($('#gl'), scene, { background: [0, 0, 0, 0], overlay: (c, cam, d) => presence?.draw(c, cam, d) });
    presence = createPresence(scene, { wake: () => canvasView.redraw() });
  }
  Object.assign(scene, { doc, themeOverride: theme });
  scene.build(expanded, { layout: false }); // fonts first: text is measured once, with the real fonts
  performance.mark('pena:built');
  await needFonts();
  performance.mark('pena:fonts');
  scene.relayoutAll();
  performance.mark('pena:layout');
  measure(expanded.map((n) => n.id));
  const est = [...rootRect.values()];
  if (est.length) fitRect(Math.min(...est.map((r) => r.x)), Math.min(...est.map((r) => r.y)), Math.max(...est.map((r) => r.x + r.w)), Math.max(...est.map((r) => r.y + r.h)), est.length === 1);
  canvasView.renderNow();
  performance.mark('pena:first-paint');
  afterRender();
}
let canvasView, presence;

// Incremental render: the given roots, plus roots that use components defined in them. Layout runs per root.
// ponytail: a root is rebuilt whole on each edit (fast for screens); pen.dev-style dirty-subtree layout if huge roots lag.
function update(dirty, { full = false } = {}) {
  if (full) return render();
  const ids = new Set(dirty);
  for (let grew = true; grew; ) {
    grew = false;
    const comps = new Set([...ids].flatMap((id) => [...(rootMeta.get(id)?.comps ?? [])]));
    for (const [id, m] of rootMeta) if (!ids.has(id) && [...m.refs].some((r) => comps.has(r))) ids.add(id), (grew = true);
  }
  const index = indexNodes(doc);
  const byId = new Map(expanded.map((n) => [n.id, n]));
  const oldRoots = new Map([...ids].map((id) => [id, byId.get(id)]));
  for (const id of ids) {
    const raw = doc.children.find((c) => c.id === id);
    if (!raw) { byId.delete(id); rootMeta.delete(id); rootRect.delete(id); labels.get(id)?.remove(); labels.delete(id); continue; }
    rootMeta.set(id, metaFor(raw));
    byId.set(id, expandNode(raw, index));
  }
  // view index: drop the old subtrees of the rebuilt roots, add the new ones (a full walk costs ~25 ms on big files)
  const drop = (n) => { view.delete(n.id); n.children?.forEach(drop); };
  const add = (n, parent) => { view.set(n.id, { node: n, parent }); n.children?.forEach((c) => add(c, n)); };
  for (const id of ids) { const old = oldRoots.get(id); if (old) drop(old); }
  expanded = doc.children.map((c) => byId.get(c.id)).filter(Boolean);
  for (const id of ids) if (byId.has(id)) add(byId.get(id), null);
  pruneSelection();
  scene.doc = doc;
  const before = [...ids].map((id) => scene.node(id)?.extentWorld()).filter(Boolean);
  scene.rebuild(expanded, ids);
  if (scene.fontsNeeded([...ids]).some(([f, w, i]) => !fonts.loaded.has(`${f}|${w}|${i}`))) needFonts();
  measure([...ids]);
  // redraw only where the edited roots were and are now
  const area = [...before, ...[...ids].map((id) => scene.node(id)?.extentWorld()).filter(Boolean)];
  if (area.length) canvasView.damage([Math.min(...area.map((r) => r[0])), Math.min(...area.map((r) => r[1])), Math.max(...area.map((r) => r[2])), Math.max(...area.map((r) => r[3]))]);
  afterRender();
}

// Ordinary edits: same as update() for the touched roots (components used elsewhere pull their roots in).
function patch(dirtyRoots, ops, comps = new Set()) {
  dirtyRoots = new Set(dirtyRoots);
  if (comps.size) {
    const uses = new Map();
    indexNodes(doc).forEach(({ node }) => { if (node.reusable) uses.set(node.id, metaFor(node).refs); });
    for (let grew = true; grew; ) {
      grew = false;
      for (const [c, refs] of uses) if (!comps.has(c) && [...refs].some((r) => comps.has(r))) comps.add(c), (grew = true);
    }
    for (const [id, m] of rootMeta) if ([...m.refs].some((r) => comps.has(r))) dirtyRoots.add(id);
  }
  update(dirtyRoots);
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
const renderPanel = () => renderProps({ doc, view, selected, info, elOf, commit, select, exportNode, theme, isPath, toast, download, copyLink });

function applyCam() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; // only hosts the text editor overlay
  canvasView?.setCamera(cam);
  $('#zoom-pct').textContent = `${Math.round(cam.z * 100)}%`;
  drawOverlay();
}


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
      // Double click renames, like pen.dev. Counted by hand: the overlay re-attaches labels between clicks, so no dblclick.
      l = h('div', { class: 'flabel', onpointerdown: (e) => {
        e.stopPropagation();
        if (e.timeStamp - (l.lastDown ?? -1e9) < 400) return e.preventDefault(), renameLabel(l, n.id); // no mousedown: it would steal the focus
        l.lastDown = e.timeStamp;
        if (e.shiftKey) return select(n.id, true);
        if (!isSel(n.id)) select(n.id);
        startMove(e, n.id);
      } });
      labels.set(n.id, l);
    }
    l.textContent = (n.reusable ? '◆ ' : '') + (n.name ?? n.type);
    l.className = `flabel${isSel(n.id) ? ' sel' : ''}${n.reusable || n._ref ? ' comp' : ''}`;
  }
  for (const [id, l] of labels) if (!keep.has(id)) l.remove(), labels.delete(id);
}
// The field lives outside #overlay: redrawing the overlay would detach it and end the edit.
function renameLabel(l, id) {
  const n = info(id)?.node;
  if (!n) return;
  const r = l.getBoundingClientRect(), host = $('#canvas').getBoundingClientRect();
  const input = h('input', { class: 'flabel-edit', value: n.name ?? '', style: { left: `${r.left - host.left}px`, top: `${r.top - host.top}px`, width: `${Math.max(r.width, 80)}px` } });
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.remove();
    if (save && input.value.trim() && input.value !== (n.name ?? '')) commit((api) => api.Update(id, { name: input.value.trim() }));
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onpointerdown = (e) => e.stopPropagation();
  input.onblur = () => finish(true);
  $('#canvas').append(input);
  setTimeout(() => (input.focus(), input.select())); // after this click's mouseup/click, which would blur it
}
const sel = { box: h('div', { class: 'sel-box' }), badge: h('div', { class: 'size-badge' }), hover: h('div', { class: 'hover-box' }),
  handles: [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => h('div', { class: 'handle', style: { cursor: cx === cy ? 'nwse-resize' : 'nesw-resize' }, onpointerdown: (e) => startResize(e, cx, cy) })) };
let selRect = null, hoverRect = null, extraRects = []; // world-space rects of the selection/hover, measured when they change
const extraBoxes = []; // one box per extra selected node, reused
let band = null; // marquee: { el, r } with r in world space
const worldRectOf = (id) => (id && scene?.bounds(id)) || null;
const toScreen = (r) => ({ left: cam.x + r.x * cam.z, top: cam.y + r.y * cam.z, width: r.w * cam.z, height: r.h * cam.z });
const place = (el, r) => Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
function drawOverlay({ remeasure = false } = {}) {
  if (remeasure) { selRect = worldRectOf(selected); extraRects = [...extra].map(worldRectOf); hoverRect = !isSel(hovered) ? worldRectOf(hovered) : null; }
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
  if (hoverRect && !isSel(hovered)) nodes.push(place(sel.hover, toScreen(hoverRect)) && sel.hover);
  extraRects.forEach((r, i) => r && nodes.push(place((extraBoxes[i] ??= h('div', { class: 'sel-box' })), toScreen(r)) && extraBoxes[i]));
  if (band) nodes.push(place(band.el, toScreen(band.r)) && band.el);
  nodes.push(...guideNodes(altDown && !band ? measureSegs() : guides));
  if (selected && selRect) {
    const s = toScreen(selRect), n = info(selected)?.node;
    sel.box.className = `sel-box${isPath(selected) || n?._ref ? ' inst' : ''}`;
    nodes.push(place(sel.box, s) && sel.box);
    if (!isPath(selected) && !extra.size) sel.handles.forEach((hd, i) => { const [cx, cy] = [[0, 0], [1, 0], [0, 1], [1, 1]][i]; hd.style.left = `${s.left + cx * s.width}px`; hd.style.top = `${s.top + cy * s.height}px`; nodes.push(hd); });
    sel.badge.style.left = `${s.left + s.width / 2}px`;
    sel.badge.style.top = `${s.top + s.height}px`;
    sel.badge.textContent = `${Math.round(selRect.w)} × ${Math.round(selRect.h)}`;
    if (!extra.size) nodes.push(sel.badge);
  }
  // only touch the overlay DOM when the set of visible items changed
  if (nodes.length !== overlay.childElementCount || nodes.some((n, i) => overlay.children[i] !== n)) overlay.replaceChildren(...nodes);
}

// Red guides (Figma/pen.dev): alignment lines while dragging, distances while Alt is held.
// Segments are [x1, y1, x2, y2, label?] in world space; elements are pooled like the rest of the overlay.
let guides = [], altDown = false;
const lineEls = [], labelEls = [];
function guideNodes(segs) {
  const out = [];
  segs.forEach(([x1, y1, x2, y2, label], i) => {
    const [a, b, c, d] = [cam.x + x1 * cam.z, cam.y + y1 * cam.z, cam.x + x2 * cam.z, cam.y + y2 * cam.z];
    const line = (lineEls[i] ??= h('div', { class: 'guide' }));
    Object.assign(line.style, { left: `${Math.min(a, c)}px`, top: `${Math.min(b, d)}px`, width: `${Math.max(1, Math.abs(c - a))}px`, height: `${Math.max(1, Math.abs(d - b))}px` });
    out.push(line);
    if (label === undefined) return;
    const t = (labelEls[i] ??= h('div', { class: 'guide-label' }));
    t.textContent = label;
    Object.assign(t.style, { left: `${(a + c) / 2}px`, top: `${(b + d) / 2}px` });
    out.push(t);
  });
  return out;
}
// Alt: distances from the selection to the hovered node (to each edge when the hovered node contains it);
// over the selection itself or an overlapping node, to the parent's edges.
function measureSegs() {
  const t = hovered && !isSel(hovered) ? hoverRect : null, segs = selRect && t ? gaps(selRect, t) : [];
  const parent = selected && info(selected)?.parent;
  return segs.length || !selRect || !parent ? segs : gaps(selRect, worldRectOf(parent.id) ?? selRect);
}
function gaps(s, t) {
  const cx = s.x + s.w / 2, cy = s.y + s.h / 2, segs = [];
  if (t.x <= s.x && t.y <= s.y && t.x + t.w >= s.x + s.w && t.y + t.h >= s.y + s.h) {
    segs.push([t.x, cy, s.x, cy], [s.x + s.w, cy, t.x + t.w, cy], [cx, t.y, cx, s.y], [cx, s.y + s.h, cx, t.y + t.h]);
  } else {
    if (t.x >= s.x + s.w) segs.push([s.x + s.w, cy, t.x, cy]);
    else if (t.x + t.w <= s.x) segs.push([t.x + t.w, cy, s.x, cy]);
    if (t.y >= s.y + s.h) segs.push([cx, s.y + s.h, cx, t.y]);
    else if (t.y + t.h <= s.y) segs.push([cx, t.y + t.h, cx, s.y]);
  }
  return segs.map((g) => [...g, Math.round(Math.abs(g[2] - g[0]) + Math.abs(g[3] - g[1]))]).filter((g) => g[4] > 0);
}
// Drag snapping: the offset that puts one of the box's edges/centre on another box's (within 6 screen px).
const stops = (r, ax) => (ax === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h]);
function snapOffset(box, others, ax) {
  let best = null;
  for (const o of others) for (const t of stops(o, ax)) for (const m of stops(box, ax)) {
    const d = t - m;
    if (Math.abs(d) <= 6 / cam.z && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best ?? 0;
}
function alignSegs(b, others) {
  const segs = [], hit = (o, v, ax) => stops(o, ax).some((t) => Math.abs(t - v) < 1);
  for (const o of others) {
    for (const x of stops(b, 'x')) if (hit(o, x, 'x')) segs.push([x, Math.min(b.y, o.y), x, Math.max(b.y + b.h, o.y + o.h)]);
    for (const y of stops(b, 'y')) if (hit(o, y, 'y')) segs.push([Math.min(b.x, o.x), y, Math.max(b.x + b.w, o.x + o.w), y]);
  }
  return segs;
}
addEventListener('keydown', (e) => { if (e.key === 'Alt' && !altDown) { altDown = true; drawOverlay(); } });
addEventListener('keyup', (e) => { if (e.key === 'Alt') { altDown = false; drawOverlay(); } });
addEventListener('blur', () => { if (altDown) { altDown = false; drawOverlay(); } });

// ---------------------------------------------------------------- selection
// `add` (shift-click) toggles id in the selection. A node and its ancestor are never selected together.
export function select(id, add = false) {
  if (!add || !id) return setSelection(id ? [id] : []);
  if (id === selected) { selected = [...extra].at(-1) ?? null; extra.delete(selected); }
  else if (extra.has(id)) extra.delete(id);
  else {
    const anc = ancestors(id);
    for (const s of selection()) if (anc.includes(s) || ancestors(s).includes(id)) { extra.delete(s); if (s === selected) selected = null; }
    if (selected) extra.add(selected);
    selected = id;
  }
  refreshSelection();
}
function setSelection(ids, light = false) {
  selected = ids[0] ?? null;
  extra.clear();
  ids.slice(1).forEach((id) => extra.add(id));
  refreshSelection(light);
}
// light: canvas only (live marquee); the panels follow on pointerup
function refreshSelection(light = false) {
  for (const [rid, l] of labels) l.classList.toggle('sel', isSel(rid));
  drawOverlay({ remeasure: true });
  if (light) return;
  const opened = open.size;
  for (const id of selection()) for (const anc of ancestors(id)) open.add(anc);
  // same rows on screen: only the highlight moves (rebuilding the whole tree on every click scales with the tree)
  if (open.size === opened) $$('#layers .row').forEach((r) => r.classList.toggle('sel', isSel(r.dataset.id)));
  else renderLayers();
  renderPanel();
  renderAttachments();
  post('/state', { selection: selection().map((id) => { const n = info(id).node; return { id, name: n.name, type: n.type }; }) }).catch(() => {});
  if (selected) $(`.row[data-id="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: 'nearest' });
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
function chainAt(sx, sy) {
  if (!scene) return [];
  const p = toWorld(sx, sy);
  const chain = scene.hitChain(p.x, p.y);
  const inst = chain.findIndex((id) => info(id)?.node._ref);
  if (inst >= 0 && !(selected === chain[inst] || selected?.startsWith(chain[inst] + '/'))) chain.length = inst + 1;
  return chain;
}
function pick(sx, sy) {
  const chain = chainAt(sx, sy);
  if (!chain.length) return null;
  const hit = chain.find(isSel);
  if (hit) return hit;
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
  const id = tool === 'select' && (e.target === canvas || e.target.id === 'gl') ? clickTarget(e.clientX, e.clientY, e.metaKey) : null;
  if (id !== hovered) { hovered = id; drawOverlay({ remeasure: true }); }
});
canvas.addEventListener('pointerleave', () => { hovered = null; drawOverlay({ remeasure: true }); });

canvas.addEventListener('pointerdown', (e) => {
  if (e.target.isContentEditable) return;
  if (e.button === 1 || tool === 'hand' || spaceDown) return pan(e);
  if (DRAW.has(tool)) return startDraw(e);
  const id = pick(e.clientX, e.clientY);
  if (!id) { if (!e.shiftKey) select(null); return marquee(e); }
  if (e.shiftKey) return select(id, true);
  if (e.metaKey) { const deep = clickTarget(e.clientX, e.clientY, true); select(deep); return startMove(e, deep); }
  // a click (no drag) on the selection goes straight to the layer under the cursor: anything is at most 2 clicks away
  const again = isSel(id) && !extra.size;
  if (!isSel(id)) select(id);
  startMove(e, id, again && (() => { const deep = clickTarget(e.clientX, e.clientY); if (deep !== selected) select(deep); }));
});
// What a click selects: the layer at the selection's level, or the deepest one under the cursor when clicking
// on the selection again (or with Cmd). Hover shows the same target.
function clickTarget(sx, sy, deep = false) {
  const id = pick(sx, sy);
  return id && (deep || (isSel(id) && !extra.size)) ? chainAt(sx, sy).at(-1) : id;
}

function pan(e) {
  const start = { x: e.clientX - cam.x, y: e.clientY - cam.y };
  canvas.classList.add('panning');
  const move = (ev) => { cam.x = ev.clientX - start.x; cam.y = ev.clientY - start.y; applyCam(); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => (removeEventListener('pointermove', move), canvas.classList.remove('panning')), { once: true });
}
// Marquee selects the top-level nodes it touches (shift adds to the selection), like pen.dev.
function marquee(e) {
  const start = toWorld(e.clientX, e.clientY), base = selection();
  band = { el: h('div', { class: 'ghost' }), r: { ...start, w: 0, h: 0 } };
  const move = (ev) => {
    const p = toWorld(ev.clientX, ev.clientY);
    const r = (band.r = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) });
    const hit = expanded.filter((n) => {
      const b = n.enabled !== false && rootRect.get(n.id);
      return b && b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y;
    }).map((n) => n.id);
    setSelection([...new Set([...base, ...hit])], true);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => { removeEventListener('pointermove', move); band = null; refreshSelection(); }, { once: true });
}

// Children laid out by flex can't be dragged freely (same as pen.dev); absolute ones and root nodes can.
const isFree = (id) => {
  const { node, parent } = info(id) ?? {};
  return node && !isPath(id) && (!parent || parent.type === 'group' || (parent.layout ?? 'horizontal') === 'none' || node.layoutPosition === 'absolute');
};
// Drags every free node of the selection; a click without dragging on a multi-selection keeps just that node.
function startMove(e, id, onClick) {
  const origin = new Map((isSel(id) ? selection() : [id]).filter(isFree).map((i) => { const n = info(i).node; return [i, [n.x ?? 0, n.y ?? 0]]; }));
  const start = { x: e.clientX, y: e.clientY }, roots = [...origin.keys()].filter((i) => rootRect.has(i));
  // snap targets: the dragged node's siblings and its parent, measured once
  const parent = info(id)?.parent, rects = [...origin.keys()].map(worldRectOf).filter(Boolean);
  const others = [...(parent?.children ?? expanded).filter((n) => !origin.has(n.id) && n.enabled !== false).map((n) => n.id), ...(parent ? [parent.id] : [])].map(worldRectOf).filter(Boolean);
  const box = rects.length && { x: Math.min(...rects.map((r) => r.x)), y: Math.min(...rects.map((r) => r.y)) };
  if (box) Object.assign(box, { w: Math.max(...rects.map((r) => r.x + r.w)) - box.x, h: Math.max(...rects.map((r) => r.y + r.h)) - box.y });
  let dx = 0, dy = 0, moved = false;
  const move = (ev) => {
    if (!origin.size || (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3)) return;
    moved = true;
    dx = (ev.clientX - start.x) / cam.z;
    dy = (ev.clientY - start.y) / cam.z;
    if (box && !ev.metaKey && !ev.ctrlKey) { // Cmd/Ctrl drags without snapping
      dx += snapOffset({ ...box, x: box.x + dx }, others, 'x');
      dy += snapOffset({ ...box, y: box.y + dy }, others, 'y');
    }
    dx = Math.round(dx);
    dy = Math.round(dy);
    guides = box && !ev.metaKey && !ev.ctrlKey ? alignSegs({ ...box, x: box.x + dx, y: box.y + dy }, others) : [];
    for (const [i, [x, y]] of origin) scene.previewMove(i, x + dx, y + dy);
    canvasView.invalidate();
    if (roots.length) measure(roots);
    drawOverlay({ remeasure: true });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    if (guides.length) { guides = []; drawOverlay(); }
    if (!moved && extra.size) return select(id);
    if (!moved) return onClick?.();
    if (moved && (dx || dy)) commit((api) => { for (const [i, [x, y]] of origin) api.Update(i, { x: x + dx, y: y + dy }); });
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
    scene.previewSize(id, next);
    canvasView.invalidate();
    measure([scene.rootOf(scene.node(id)).id]);
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
  const p = toWorld(sx, sy), chain = scene.hitChain(p.x, p.y);
  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i], n = info(id)?.node;
    if (!isPath(id) && (n?.type === 'frame' || n?.type === 'group')) return id;
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
    node.name = node.name ? t(node.name) : node.name;
    if (type === 'text' || type === 'prompt') node.content = t(node.content);
    if (dragged) Object.assign(node, { width: Math.round(Math.abs(ev.clientX - start.x) / cam.z), height: type === 'line' ? 0 : Math.round(Math.abs(ev.clientY - start.y) / cam.z) });
    if (dragged && type === 'text') node.textGrowth = 'fixed-width';
    if (type === 'browser') {
      const url = prompt(t('Page URL:'), 'https://');
      if (!url) return setTool('select');
      node.url = url;
    }
    setTool('select');
    const id = await commit((api) => api.Insert(parentId ?? 'document', node), { select: (id) => id });
    if (type === 'text' && id) editText(id);
  }, { once: true });
}

canvas.addEventListener('dblclick', (e) => {
  const chain = chainAt(e.clientX, e.clientY);
  if (selected && chain.includes(selected) && chain.indexOf(selected) < chain.length - 1) return select(chain[chain.indexOf(selected) + 1]);
  const n = selected && info(selected)?.node;
  if (!n) return;
  if (n.type === 'prompt') return sendPrompt(`${n.content}\n\n(This request comes from a prompt node on the canvas: ${n.id})`, n.content);
  if (n.type === 'text' || n.type === 'note') editText(n.id);
});
// Text editing: a DOM editor laid over the Skia text (pen.dev does the same), in world coordinates inside #world.
function editText(id) {
  const n = scene.node(id), node = info(id)?.node;
  if (!n || !node) return;
  select(id);
  const [w, hh] = n.dims(), b = n.bounds(), t = (n.textKey(), n.textStyle);
  loadFonts([t.family]);
  const note = node.type === 'note';
  const ed = h('div', { class: 'text-edit', style: {
    position: 'absolute', left: `${b.x}px`, top: `${b.y}px`, minWidth: `${w}px`, minHeight: `${hh}px`,
    ...((node.textGrowth ?? 'auto') !== 'auto' || note ? { width: `${w}px` } : {}),
    font: `${t.italic ? 'italic ' : ''}${t.weight} ${t.size}px "${t.family}", Inter, system-ui, sans-serif`,
    lineHeight: t.lh ? `${Math.round(t.lh * t.size)}px` : 'normal', letterSpacing: `${t.ls}px`, textAlign: t.align, color: t.color,
    whiteSpace: (node.textGrowth ?? 'auto') === 'auto' && !note ? 'pre' : 'pre-wrap', outline: 'none', caretColor: '#3b82f6',
    ...(note && { padding: '14px 16px', boxSizing: 'border-box' }),
  } }, node.content ?? '');
  world.append(ed);
  scene.hidden.add(id);
  scene.touch(id);
  canvasView.invalidate();
  ed.contentEditable = 'plaintext-only';
  ed.focus();
  getSelection().selectAllChildren(ed);
  ed.addEventListener('blur', () => {
    const content = ed.innerText;
    ed.remove();
    scene.hidden.delete(id);
    scene.touch(id);
    canvasView.invalidate();
    if (content !== info(id)?.node.content) commit((api) => api.Update(id, { content }));
  }, { once: true });
  ed.addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) ed.blur(); e.stopPropagation(); });
}

// ---------------------------------------------------------------- view helpers
function fitRect(x0, y0, x1, y1, single) {
  const left = document.body.classList.contains('no-left') ? 60 : 420, right = document.body.classList.contains('no-props') ? 20 : 290;
  const aw = innerWidth - left - right, ah = innerHeight - 100, ww = x1 - x0 || 1, wh = y1 - y0 || 1;
  const z = Math.min(single ? 4 : 1, 0.9 * Math.min(aw / ww, ah / wh));
  cam = { z, x: left + (aw - ww * z) / 2 - x0 * z, y: 60 + (ah - wh * z) / 2 - y0 * z };
  applyCam();
}
export function fit(els = expanded.filter((n) => n.enabled !== false).map((n) => elOf(n.id))) {
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
const fitSelection = () => selected && fit(selection().map(elOf).filter(Boolean));
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
      class: `row${isSel(n.id) ? ' sel' : ''}${n.reusable ? ' comp' : isPath(n.id) || n._ref ? ' inst' : ''}${n.enabled === false ? ' hidden' : ''}`,
      'data-id': n.id, style: { paddingLeft: `${4 + depth * 14}px` },
      onclick: (e) => select(n.id, e.shiftKey || e.metaKey || e.ctrlKey),
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
      ic('component'), h('span', { 'data-i18n-ignore': true }, c.name ?? c.id), h('small', {}, `${countInstances(c.id)} inst.`),
      h('button', { class: 'btn icon', title: 'Inserir instância', onclick: (e) => { e.stopPropagation(); insertInstance(c); } }, ic('plus'))))
      : [h('div', { class: 'hint', style: { padding: '16px 10px' } }, 'Nenhum componente. Selecione um frame e clique em “Criar componente” no painel de propriedades (⌘⌥K).')]));
}
$('#tool-component').onclick = (e) => {
  const list = components();
  menu(e.currentTarget, list.length ? [{ head: 'Inserir componente' }, ...list.map((c) => ({ label: c.name ?? c.id, raw: true, icon: 'component', run: () => insertInstance(c) }))] : [{ head: 'Nenhum componente no arquivo' }]);
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
// Figma (as pen.dev): a .fig file (File > Save local copy, with images) or layers copied in Figma (without images).
// The server decodes it into .pen nodes per page; they keep their layout, centered on `at`.
// `source`: the bytes, or a local path (the desktop app's menu, so big files aren't copied through the page).
async function importFigma(source, at) {
  const b = busyOverlay('Importando do Figma…');
  const path = typeof source === 'string';
  const res = await fetch(`/import-figma${path ? `?path=${encodeURIComponent(source)}` : ''}`, { method: 'POST', body: path ? undefined : source }).catch((e) => ({ ok: false, text: () => e.message }));
  if (!res.ok) return b.fail(await res.text());
  const { pages, fonts: figFonts } = await res.json();
  b.done();
  return placeFigma(pages, at, figFonts);
}
// `figFonts`: font files the import put next to the document (Figma's Lato 2.0), merged into doc.fonts
async function placeFigma(pages, at, figFonts = []) {
  pages = pages.filter((p) => p.nodes.length); // Figma files often keep an empty page
  const page = pages.length > 1 ? await new Promise((ok) => menu({ getBoundingClientRect: () => new DOMRect(innerWidth / 2 - 120, innerHeight / 3, 0, 0) },
    [{ head: 'Página do Figma para importar' }, ...pages.map((p) => ({ label: p.name, raw: true, icon: 'file', run: () => ok(p) }))])) : pages[0];
  if (!page?.nodes.length) return toast('Nada para importar do Figma');
  const b = busyOverlay(`Inserindo “${page.name}”…`);
  await new Promise((r) => setTimeout(r, 30)); // let the overlay paint before the (long) insert
  const num = (v) => (typeof v === 'number' ? v : 0);
  const x0 = Math.min(...page.nodes.map((n) => n.x ?? 0)), y0 = Math.min(...page.nodes.map((n) => n.y ?? 0));
  const w = Math.max(...page.nodes.map((n) => (n.x ?? 0) + num(n.width))) - x0, hh = Math.max(...page.nodes.map((n) => (n.y ?? 0) + num(n.height))) - y0;
  const pos = at ?? toWorld(innerWidth / 2, innerHeight / 2);
  await commit((api) => {
    if (figFonts.length) doc.fonts = [...(doc.fonts ?? []).filter((f) => !figFonts.some((g) => g.url === f.url)), ...figFonts];
    return page.nodes.map((n) => api.Insert('document', { ...n, x: Math.round(pos.x - w / 2 + (n.x ?? 0) - x0), y: Math.round(pos.y - hh / 2 + (n.y ?? 0) - y0) }));
  }, { select: (ids) => ids });
  b.done();
  if (pages.length > 1) toast(`Importada a página “${page.name}” do Figma`);
}
const isFig = (f) => /\.fig$/i.test(f.name);
const importFile = async (f, at) => (isFig(f) ? importFigma(await f.arrayBuffer(), at) : f.type.startsWith('image/') && importImage(f, at));
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const f of e.dataTransfer.files) await importFile(f, toWorld(e.clientX, e.clientY));
});
$('#tool-image').onclick = () => {
  const pick = h('input', { type: 'file', accept: 'image/*,.fig', multiple: true });
  pick.onchange = async () => { for (const f of pick.files) await importFile(f); };
  pick.click();
};

// ---------------------------------------------------------------- clipboard + keyboard
addEventListener('copy', (e) => {
  if (e.target.matches?.('input, textarea, [contenteditable="plaintext-only"]') || !selected || !getSelection().isCollapsed) return; // selected text (e.g. in the chat) copies natively
  const index = indexNodes(doc), nodes = selection().map((id) => (isPath(id) ? info(id).node : index.get(id).node));
  e.clipboardData.setData('text/plain', JSON.stringify({ pena: 1, nodes: nodes.map(stripInternal) }));
  e.preventDefault();
});
addEventListener('paste', async (e) => {
  if (e.target.matches?.('input, textarea, [contenteditable]')) return;
  // Figma puts its layers on the clipboard as HTML: data-buffer="<!--(figma)BASE64(/figma)-->"
  const fig = /\(figma\)([A-Za-z0-9+/=]+)\(\/figma\)/.exec(e.clipboardData.getData('text/html'));
  if (fig) return e.preventDefault(), importFigma(Uint8Array.from(atob(fig[1]), (c) => c.charCodeAt(0)));
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return files.forEach((f) => importImage(f));
  let data;
  try { data = JSON.parse(e.clipboardData.getData('text/plain')); } catch { return; }
  if (!data?.pena) return;
  e.preventDefault();
  const sel = selected && !isPath(selected) && info(selected)?.node;
  const parent = sel?.type === 'frame' || sel?.type === 'group' ? sel.id : info(selected)?.parent?.id && !isPath(info(selected).parent.id) ? info(selected).parent.id : 'document';
  await commit((api) => data.nodes.map((n) => api.Insert(parent, { ...n, x: (n.x ?? 0) + 20, y: (n.y ?? 0) + 20 })), { select: (ids) => ids });
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
  if (mod && k === 'a') {
    e.preventDefault();
    return setSelection((info(selected)?.parent?.children ?? expanded).filter((n) => n.enabled !== false).map((n) => n.id));
  }
  if (!selected) return;
  if (mod && k === 'l') { e.preventDefault(); return copyLink(); }
  const id = selected, path = isPath(id), ids = selection();
  if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    const parent = info(id)?.parent?.id ?? null;
    return commit((api) => { for (const i of ids) isPath(i) ? api.Update(i, { enabled: false }) : api.Delete(i); }, { select: ids.every(isPath) ? ids : parent });
  }
  if (mod && k === 'd' && !e.shiftKey && ids.some((i) => !isPath(i))) {
    e.preventDefault();
    return commit((api) => ids.filter((i) => !isPath(i)).map((i) => {
      const n = info(i).node;
      return api.Copy(i, info(i).parent?.id ?? 'document', isFree(i) ? { x: (n.x ?? 0) + 20, y: (n.y ?? 0) + 20 } : {});
    }), { select: (nids) => nids });
  }
  if (mod && e.altKey && k === 'k' && !path) { e.preventDefault(); return commit((api) => api.Update(id, { reusable: !info(id).node.reusable })); }
  if (mod && e.altKey && k === 'g' && !path) { e.preventDefault(); return wrapInFrame(id); }
  if (mod && e.shiftKey && k === 'h') { e.preventDefault(); const on = info(id).node.enabled === false; return commit((api) => ids.forEach((i) => api.Update(i, { enabled: on }))); }
  if (mod && (k === ']' || k === '[') && !path) {
    e.preventDefault();
    const siblings = info(id).parent?.children ?? expanded, i = siblings.findIndex((c) => c.id === id);
    const to = k === ']' ? (e.altKey ? siblings.length - 1 : Math.min(siblings.length - 1, i + 1)) : (e.altKey ? 0 : Math.max(0, i - 1));
    return commit((api) => api.Move(id, undefined, to));
  }
  if (e.key.startsWith('Arrow') && ids.some(isFree)) {
    e.preventDefault();
    const d = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
    return commit((api) => ids.filter(isFree).forEach((i) => { const n = info(i).node; api.Update(i, { x: (n.x ?? 0) + dx, y: (n.y ?? 0) + dy }); }));
  }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') { spaceDown = false; canvas.classList.toggle('tool-hand', tool === 'hand'); } });

function wrapInFrame(id) {
  const { node, parent } = info(id), el = elOf(id);
  const w = Math.round(el.offsetWidth), hh = Math.round(el.offsetHeight);
  return commit((api) => {
    const parentId = parent?.id ?? 'document', index = (parent?.children ?? expanded).findIndex((c) => c.id === id);
    const frame = api.Insert(parentId, { type: 'frame', name: t('Frame'), layout: 'none', x: node.x ?? 0, y: node.y ?? 0, width: w, height: hh });
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
  { label: 'Abrir arquivo…', icon: 'folder-open', run: () => (window.__TAURI__ ? __TAURI__.core.invoke('pick_pen', { kind: 'open' }) : (location.href = '/dashboard')) },
  { label: 'Novo arquivo', icon: 'file-plus', run: () => post('/api/new') },
  'sep',
  { label: 'Exportar seleção…', icon: 'share', run: () => $('#export-btn').click() },
]);
$('#theme-btn').onclick = (e) => {
  const axes = Object.entries(doc.themes ?? {});
  if (!axes.length) return menu(e.currentTarget, [{ head: 'Este arquivo não tem temas' }]);
  const base = { ...themeDefaults(doc), ...theme };
  menu(e.currentTarget, axes.flatMap(([axis, values]) => [{ head: `${axis} (pré-visualização)`, raw: true }, ...values.map((v) => ({ label: v, raw: true, on: base[axis] === v, run: () => { theme = { ...theme, [axis]: v }; render(); } }))]), { align: 'right' });
};
const FORMATS = [['PNG', 'png'], ['JPEG', 'jpeg'], ['WebP', 'webp'], ['PDF', 'pdf'], ['HTML + CSS', 'html-css'], ['Figma (.fig)', 'fig']];
$('#export-btn').onclick = (e) => {
  const id = selected ?? expanded[0]?.id;
  if (!id) return toast('Nada para exportar');
  // .fig without a selection: the whole document
  menu(e.currentTarget, [{ head: `Exportar “${info(id).node.name ?? id}”` }, ...FORMATS.map(([label, f]) => ({ label: f === 'fig' && !selected ? `${label} — documento inteiro` : label, run: () => download(f === 'fig' ? selected : id, f) }))], { align: 'right' });
};
export async function download(id, format, scale = 2) {
  const data = await exportNode(id, format, { scale });
  const name = `${format === 'fig' ? docName() : info(id)?.node.name ?? 'export'}.${format === 'html-css' ? 'html' : format}`;
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
  if (format === 'fig') return exportFig(id ? [scene.node(id)] : scene.roots);
  const sn = scene?.node(id), hit = info(id);
  if (!sn || !hit) throw new Error(`Node not found on canvas: ${id}`);
  const [w, hh] = sn.dims();
  if (format.startsWith('html')) {
    // HTML/CSS: the DOM renderer is the serializer (flex layout maps onto CSS flexbox)
    const { elements: [el], fonts: used } = renderDoc(doc, [hit.node], { theme, assetUrl, parent: hit.parent, inheritedTheme: inheritedTheme(id) });
    if (!el) throw new Error('Nada para exportar');
    Object.assign(el.style, { left: '0', top: '0', margin: '0', position: 'relative', width: `${w}px`, height: `${hh}px`, flex: 'none', outline: 'none' });
    for (const n of [el, ...el.querySelectorAll('[data-id]')]) {
      const node = info(n.dataset.id)?.node;
      if (includeLayerNames && node?.name) n.dataset.name = node.name;
      if (!includeLayerIds) delete n.dataset.id;
      delete n.dataset.instance; delete n.dataset.component; delete n.dataset.k;
    }
    const families = [...new Set([...used, ...loadedFonts])];
    const links = families.map((f) => `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}:wght@100..900&display=swap">`).join('\n');
    return includeHtmlScaffold ? `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${links}\n<style>body{margin:0}</style>\n</head>\n<body>\n${el.outerHTML}\n</body>\n</html>\n` : el.outerHTML;
  }
  await document.fonts.ready;
  const raster = format === 'pdf' ? 'png' : format;
  const bytes = await canvasView.exportImage(sn, scale, raster, quality);
  const url = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([bytes], { type: `image/${raster === 'jpg' ? 'jpeg' : raster}` })); });
  if (format === 'pdf') {
    const { jsPDF } = await import('https://esm.sh/jspdf@2.5.2');
    const b = sn.bounds();
    const pdf = new jsPDF({ unit: 'px', format: [b.w, b.h], orientation: b.w > b.h ? 'l' : 'p', hotfixes: ['px_scaling'] });
    pdf.addImage(url, 'PNG', 0, 0, b.w, b.h);
    return pdf.output('datauristring');
  }
  return url;
}

// .fig: the canvas as laid out (numeric sizes and positions, flex included) with resolved props; the server encodes it.
const docName = () => $('#docname span').textContent.replace(/\.pen$/, '') || 'Pena';
const dataUrl = (bytes, type) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(new Blob([bytes], { type })); });
// Figma keeps only PNG/JPEG/GIF images (it converts the rest on import): WebP, SVG, AVIF… go as PNG, decoded here.
const figImages = new Map(); // url -> Promise<url>, per export
const figImage = (url) => {
  if (!url || /\.(png|jpe?g|gif)$/i.test(url) || /^data:image\/(png|jpeg|gif)/.test(url)) return url;
  if (!figImages.has(url)) figImages.set(url, (async () => {
    const im = new Image();
    im.src = assetUrl(url);
    await im.decode();
    const c = new OffscreenCanvas(im.naturalWidth || 1024, im.naturalHeight || 1024);
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    return dataUrl(await c.convertToBlob({ type: 'image/png' }), 'image/png');
  })().catch(() => url));
  return figImages.get(url);
};
const figFills = async (v) => (Array.isArray(v) ? Promise.all(v.map(figFills)) : v?.type === 'image' ? { ...v, url: await figImage(v.url) } : v);
async function figTree(sn) {
  const [w, hh] = sn.dims(), { children, descendants, ...props } = resolveProps(doc, sn.src, sn.theme);
  const out = { ...props, type: sn.type, x: sn.x, y: sn.y, w, h: hh, fill: await figFills(props.fill), stroke: await figFills(props.stroke) };
  if (sn.type === 'icon') out.png = await dataUrl(await canvasView.exportImage(sn, 4, 'png'), 'image/png');
  if (sn.children.length) out.children = await Promise.all(sn.children.map(figTree));
  return out;
}
async function exportFig(nodes) {
  if (!nodes.length || nodes.some((n) => !n)) throw new Error('Nada para exportar');
  figImages.clear();
  await document.fonts.ready;
  const big = nodes.reduce((a, n) => (n.dims()[0] * n.dims()[1] > a.dims()[0] * a.dims()[1] ? n : a));
  const thumb = await canvasView.exportImage(big, Math.min(1, 400 / Math.max(...big.dims(), 1)), 'png');
  const res = await fetch('/export-figma', { method: 'POST', body: JSON.stringify({ roots: await Promise.all(nodes.map(figTree)), thumbnail: await dataUrl(thumb, 'image/png') }) });
  if (!res.ok) throw new Error(await res.text());
  return dataUrl(await res.arrayBuffer(), 'application/zip');
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
  if (kind === 'tool') el.append(h('div', { class: 'msg tool' }, ic('wand-sparkles'), t(text)));
  else if (kind === 'busy') el.append(h('div', { class: 'msg tool busy' }, h('span', { class: 'spinner' }), t(text)));
  else el.append(h('div', { class: `msg ${kind}`, innerHTML: kind === 'text' ? md(text) : undefined }, kind === 'text' ? null : kind === 'error' ? t(text) : text, (kind === 'text' || kind === 'user') && copyBtn(() => text)));
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
    SUGGESTIONS.map((s) => h('button', { class: 'suggest', onclick: () => { $('#prompt').value = t(s); $('#prompt').focus(); autoGrow(); } }, s)),
    h('div', { class: 'tip' }, h('b', {}, 'Gerar código'), 'Peça ao agente para implementar o design em React, Tailwind, Next.js ou a stack que preferir. Para um HTML, selecione um frame e use “Exportar HTML” no painel de propriedades.'),
    h('div', { class: 'tip' }, h('b', {}, 'Anexar contexto'), 'Arraste qualquer arquivo (HTML, PDF, imagens, código, CSV…) para o compositor, cole com ⌘V no campo ou anexe pelo +.')));
}
// While agents run, Enter queues the message (sent when they finish) and ⌘Enter steers: stops the turn and sends it now.
// `sending`: posted but not started yet, so a second Enter can't race it. `paused`: Stop holds the queue until the next send.
let busy = 0, sending = false, paused = false, queue = [];
// streamed agent activity (chatlog.js): cards, thinking, plan, per-agent headers and the running-agents strip
const chat = createChatLog({
  log: $('#log'), strip: $('#agent-strip'), todosEl: $('#todo-panel'),
  onRunning: (d, ev) => setBusy(d, ev), onStop: () => stop(),
  onLogin: (provider) => post('/api/settings/login', { provider }),
});
const stop = () => { paused = true; post('/stop'); };
const setBusy = (d, ev) => {
  busy = Math.max(0, busy + d);
  if (d > 0 && !ev?.parent) sending = false;
  $('#send').replaceChildren(ic(busy ? 'square' : 'arrow-up', busy ? 12 : 15));
  $('#send').title = busy ? 'Parar' : 'Enviar (Enter)';
  $('#prompt').placeholder = busy ? t('Press Enter to queue · ⌘Enter to steer now') : t('Draw anything… (/ for skills)');
  if (!busy && !sending && !paused && queue.length) sendPrompt(...queue.shift().args), renderQueue();
};
function renderQueue() {
  $('#queue').replaceChildren(...queue.map((q, i) => h('div', { class: 'q', title: q.label, 'data-i18n-ignore-attrs': true },
    ic('list-end', 12), h('span', { 'data-i18n-ignore': true }, q.label),
    h('button', { title: 'Enviar agora (redireciona o agente)', onclick: () => { queue.splice(i, 1); renderQueue(); sendPrompt(...q.args, true); } }, ic('corner-down-left', 12)),
    h('button', { title: 'Tirar da fila', onclick: () => { queue.splice(i, 1); renderQueue(); } }, ic('x', 12)))));
}
let attachments = [], skills = [];
function renderAttachments() {
  $('#attachments').replaceChildren(
    ...skills.map((s, i) => h('span', { class: 'att skill', title: s.description, 'data-i18n-ignore-attrs': true }, ic('sparkles', 12), h('span', { 'data-i18n-ignore': true }, s.name), h('button', { onclick: () => { skills.splice(i, 1); renderAttachments(); } }, ic('x', 12)))),
    ...attachments.map((a, i) => h('span', { class: 'att', title: `${a.name} · ${Math.ceil(a.size / 1024)} KB`, 'data-i18n-ignore-attrs': true }, ic(fileIcon(a), 12), h('span', { 'data-i18n-ignore': true }, a.name), h('button', { onclick: () => { attachments.splice(i, 1); renderAttachments(); } }, ic('x', 12)))),
    ...(selected ? [h('span', { class: 'att', title: 'Seleção atual vai junto com a mensagem' }, ic('frame', 12), extra.size ? `${extra.size + 1} camadas` : h('span', { 'data-i18n-ignore': true }, info(selected)?.node.name ?? selected))] : []));
}
// Images the models see as pictures; every other file is sent as a file (text inlined, PDFs as documents, the rest by path).
const isImage = (a) => /^data:image\/(png|jpe?g|gif|webp);/.test(a.data);
const fileIcon = (a) => (isImage(a) ? 'image' : /\.(html?|css|jsx?|tsx?|json|mjs|vue|svelte|py|go|rs|php|sql|sh)$/i.test(a.name) ? 'file-code' : /\.pdf$/i.test(a.name) ? 'file-text' : /\.(md|txt|csv)$/i.test(a.name) ? 'file-text' : 'file');
// A user message in the log: text, then what went along (images, files, selected layer).
// `files` are names (history) or attachments; `images` are data URLs, or a count when loaded from history.
function logUser(text, skillNames, images, files, context) {
  chat.newTurn();
  log('user', skillNames.length ? `${skillNames.map((s) => `/${s}`).join(' ')}\n${text}` : text);
  if (Array.isArray(images)) for (const im of images) $('#log').append(h('img', { src: im.data, class: 'msg', style: { alignSelf: 'flex-end', maxWidth: '60%' } }));
  const chips = [
    ...(typeof images === 'number' && images ? [h('span', { class: 'att' }, ic('image', 12), `${images} imagem${images > 1 ? 'ns' : ''}`)] : []),
    ...files.map((f) => h('span', { class: 'att' }, ic(fileIcon(typeof f === 'string' ? { name: f, data: '' } : f), 12), typeof f === 'string' ? f : f.name)),
    ...(context ? [h('span', { class: 'att', title: 'Camada selecionada, enviada junto' }, ic('frame', 12), context)] : []),
  ];
  if (chips.length) $('#log').append(h('div', { class: 'msg files' }, ...chips));
}
function sendPrompt(prompt, shown = prompt, attached = [], skillNames = [], context = null, steer = false) {
  sending = true; paused = false;
  const images = attached.filter(isImage), files = attached.filter((a) => !isImage(a));
  logUser(shown, skillNames, images, files, context);
  const p = pref();
  post('/chat', { provider: p.provider, model: p.model, effort: p.effort, prompt, shown, context, images, files: files.map(({ name, data }) => ({ name, data })), skills: skillNames, steer, ...agentsPref() });
  setConversationName(shown.slice(0, 40));
}
function setConversationName(value, localized = false) {
  const input = $('#conv-name');
  if (localized) {
    input.dataset.i18nValue = '';
    input.defaultValue = value;
    input.value = t(value);
  } else {
    input.removeAttribute('data-i18n-value');
    input.value = value;
  }
}
function submit(steer = false) {
  const text = $('#prompt').value.trim();
  if (!text && !attachments.length && !skills.length) return;
  const sels = selection().map((id) => info(id)?.node).filter(Boolean);
  const body = text || (skills.length ? 'Apply the attached skill to the current design.' : 'Look at the attached files.');
  const listed = sels.map((n) => `${n.id} "${n.name ?? n.type}"`).join(', ');
  const args = [sels.length ? `${body}\n\n(Selected node${sels.length > 1 ? 's' : ''}: ${listed})` : body, text, attachments, skills.map((s) => s.name), sels.length ? sels.map((n) => n.name ?? n.type).join(', ') : null];
  if ((busy || sending) && !steer) queue.push({ args, label: text || attachments[0]?.name || skills.map((s) => `/${s.name}`).join(' ') }), renderQueue();
  else sendPrompt(...args, steer);
  $('#prompt').value = ''; attachments = []; skills = []; renderAttachments(); autoGrow();
}
const autoGrow = () => { const t = $('#prompt'); t.style.height = 'auto'; t.style.height = `${Math.min(200, t.scrollHeight)}px`; };
$('#prompt').addEventListener('input', autoGrow);
$('#prompt').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e.metaKey || e.ctrlKey); } });
$('#send').onclick = () => (busy && !$('#prompt').value.trim() && !attachments.length && !skills.length ? stop() : submit());
$('#attach').onclick = () => $('#attach-file').click();
const MAX_FILE = 30 * 1024 * 1024;
const readFile = (f) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r({ name: f.name, size: f.size, data: fr.result }); fr.readAsDataURL(f); });
async function addFiles(list) {
  for (const f of list) {
    if (f.size > MAX_FILE) { toast(`${f.name}: maior que 30 MB`); continue; }
    attachments.push(await readFile(f));
  }
  renderAttachments();
}
$('#attach-file').onchange = async () => { await addFiles($('#attach-file').files); $('#attach-file').value = ''; };
$('#composer').addEventListener('dragover', (e) => e.preventDefault());
$('#composer').addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); });
// pasting files into the prompt attaches them (images pasted on the canvas still become image layers)
$('#prompt').addEventListener('paste', (e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
$('#new-chat').onclick = () => { post('/chat', { provider: 'reset' }); chat.clear(); emptyChat(); setConversationName('New agent', true); };

// Chat history: the file's current conversation is restored on open; "Conversa" lists the earlier ones.
async function loadChat() {
  const c = await fetch('/api/chats/current').then((r) => (r.ok ? r.json() : { messages: [] })).catch(() => ({ messages: [] }));
  if (!c.messages?.length) { emptyChat(); setConversationName('New agent', true); return; }
  $('#log').replaceChildren();
  chat.clear();
  for (const m of c.messages) {
    if (m.kind === 'user') logUser(m.text, m.skills ?? [], m.images ?? 0, m.files ?? [], m.context);
    else if (!(m.id || ['start', 'model', 'end', 'todos'].includes(m.kind)) || !chat.event(m, { live: false })) log(m.kind, m.text, m.agent); // older history entries
  }
  setConversationName(c.title ?? 'Conversation', !c.title);
}
$('#conv-name').style.cursor = 'pointer';
$('#conv-name').onclick = async (e) => {
  const anchor = e.currentTarget; // currentTarget is gone after the await
  const { current, list } = await fetch('/api/chats').then((r) => r.json());
  const pick = async (id) => {
    const r = await post('/api/chats/select', { id });
    if (!r.ok) return toast(await r.text());
    loadChat();
  };
  menu(anchor, list.length
    ? [{ head: 'Conversas deste arquivo' }, ...list.map((c) => ({ label: `${c.title} · ${timeAgo(c.updated)}`, raw: true, icon: 'message-circle', on: c.id === current, run: () => pick(c.id) })),
      'sep', { label: 'Apagar a conversa atual', icon: 'trash-2', run: async () => { if (current && confirm(t('Delete this conversation?'))) { await post('/api/chats/delete', { id: current }); loadChat(); } } }]
    : [{ head: 'Nenhuma conversa salva ainda' }]);
};
const refreshModel = async () => {
  $('#model').replaceChildren(h('span', { 'data-i18n-ignore': true }, await modelLabel()), ic('chevron-down', 12));
  $('#effort').replaceChildren(ic('zap', 12), t(EFFORT_LABEL[pref().effort] ?? pref().effort ?? '—'));
};
$('#model').onclick = (e) => pickModel(e.currentTarget, refreshModel);
agentsButton($('#agents'));
slashSkills($('#prompt'), (s) => { if (!skills.some((x) => x.name === s.name)) skills.push(s); renderAttachments(); });
$('#effort').onclick = (e) => pickEffort(e.currentTarget, refreshModel);

// ---------------------------------------------------------------- live sync with the server
const events = new EventSource('/events');
events.addEventListener('doc', () => reload());
events.addEventListener('file', () => { selected = null; extra.clear(); undo.length = redo.length = 0; loadChat(); reload(true); });
events.addEventListener('agent', (e) => {
  const d = JSON.parse(e.data);
  presence?.agent(d);
  if (!chat.event(d)) log(d.kind, d.text, d.agent);
});
// which nodes an agent just wrote or read: cursor + flash on the canvas
events.addEventListener('agent-nodes', (e) => presence?.nodes(JSON.parse(e.data)));
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

let docFile = ''; // absolute path of the open .pen, for links
// Link to a node, like Figma's "Copy link to selection": agents read it with the pena MCP's get_node.
// Synchronous, so the clipboard write stays inside the click/keypress (WebKit drops it after an await).
function copyLink(id = selected) {
  if (!id) return toast('Selecione um elemento');
  navigator.clipboard.writeText(`pena://node/${encodeURIComponent(id)}?file=${encodeURIComponent(docFile)}`)
    .then(() => toast('Link copiado'), (e) => toast(`Não foi possível copiar: ${e.message}`));
}

// Load, or re-read after a change on disk (agent, other app): queued behind saves in flight so they never cross.
function reload(first) {
  const p = saving.then(() => sync(first));
  saving = p.catch(() => {});
  return p;
}

async function sync(first) {
  if (first) performance.mark('pena:load-start');
  const res = await fetch('/doc');
  if (res.status === 409) return (location.href = '/dashboard');
  const name = decodeURIComponent(res.headers.get('x-pena-name') ?? '');
  docFile = decodeURIComponent(res.headers.get('x-pena-file') ?? '');
  const nextRev = res.headers.get('x-pena-rev') ?? '';
  const next = migrate(await res.json());
  if (first) performance.mark('pena:parsed');
  // libraries (`imports`): loaded once; reused while the import list doesn't change
  if (!first && JSON.stringify(next.imports ?? {}) === JSON.stringify(doc.imports ?? {})) setLib(next, doc._lib);
  else await loadImports(next, (p) => fetch(`/import?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(p)))));
  $('#docname span').textContent = name;
  document.title = `${name} — Pena`;
  rev = nextRev;
  if (first) {
    doc = next;
    base = snapshot(next);
    await renderProgressive();
    performance.mark('pena:load-end');
    schedulePreview(1500);
    return;
  }
  // Changed by an agent or another app. Local edits not on the server yet (save pending) go on top of its version
  // — no await from here on, so an edit can't slip in between — then re-render only the roots that differ.
  const local = changesSince(base);
  base = snapshot(next);
  if (changed(local)) mergeDocs(next, doc, local), scheduleSave();
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
window.__pena = { scene: () => scene, view: () => canvasView, render, select, commit, drawOverlay, reload, fit, getCam: () => cam, setCam: (c) => { cam = c; applyCam(); }, doc: () => doc, expanded: () => expanded, info };

// Hooks for the desktop app's native menus.
window.pena = {
  exportSelection: (format, scale = 2) => {
    const id = format === 'fig' ? selected : selected ?? expanded[0]?.id; // .fig without a selection: the whole document
    if (!id && format !== 'fig') throw new Error('Nada para exportar');
    return exportNode(id, format, { scale }).then((data) => ({ data, name: format === 'fig' ? docName() : info(id)?.node.name ?? 'export' }));
  },
  importFigma: (path) => importFigma(path),
  importImage: (bytes, name) => importFile(new File([new Uint8Array(bytes)], name, { type: `image/${name.split('.').pop().replace('jpg', 'jpeg').replace('svg', 'svg+xml')}` })),
  fit: () => fit(),
};

// ---------------------------------------------------------------- start
loadChat();
refreshModel();
setBusy(0);
await reload(true);
// Prompt/image handed over by the dashboard.
const start = JSON.parse(sessionStorage.getItem('pena.startPrompt') ?? 'null');
const startImage = JSON.parse(sessionStorage.getItem('pena.startImage') ?? 'null');
const startFigma = sessionStorage.getItem('pena.startFigma');
sessionStorage.removeItem('pena.startPrompt'); sessionStorage.removeItem('pena.startImage'); sessionStorage.removeItem('pena.startFigma');
if (start) sendPrompt(start.text, start.text, start.image ? [start.image] : [], start.skills ?? []);
if (startFigma) { const r = await fetch('/import-figma/last'); if (r.ok) { const { pages, fonts: figFonts } = await r.json(); await placeFigma(pages, undefined, figFonts); fit(); } }
if (startImage) importImage(await (await fetch(startImage.data)).blob().then((b) => new File([b], startImage.name, { type: b.type })));
