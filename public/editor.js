// Pena editor: canvas, selection, tools, layers, components, chat. Every edit goes through the same
// document API the agents use (pen-core.js), so humans and agents follow identical rules.
import { META, ORDER, newState, route, begin, settle, failed, reset } from './patch-sync.js';
import { createApi, migrate, expandDoc, expandNode, indexNodes, themeDefaults, sizeNumber, loadImports, setLib, resolveProps, mergeDocs, joinPath, isConnection, connectionsTouching, anchorsFor } from './pen-core.js';
import { renderDoc, loadDocFonts, loadedFonts } from './render.js';
import { initSkia, fonts } from './skia.js';
import { Scene, nodeSVG, refreshShaderSources, shaderError } from './scene.js';
import { createView } from './view.js';
import { $, $$, h, ic, hydrateIcons, menu, busy as busyOverlay, modelLabel, pickModel, pickEffort, pref, timeAgo, EFFORT_LABEL } from './ui.js';
import { brandIcon } from './brands.js';
import { renderProps } from './props.js';
import { slashSkills, agentsButton, agentsPref, designButtons, designPref } from './composer.js';
import { openSettings } from './settings.js';
import { createChatLog, copyBtn, handoffRoute } from './chatlog.js';
import { createPresence } from './presence.js';
import { pushBounded } from './history.js';
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

// Library components (`alias:id`) live in the file the alias imports; editing them means opening that file.
const libFile = (id) => doc.imports?.[id.split(':')[0]] ?? 'a biblioteca';
function openLib(id) {
  const file = docFile.replaceAll('\\', '/'), path = (file.startsWith('/') ? '/' : '') + joinPath(file, libFile(id));
  if (window.__TAURI__) return __TAURI__.core.invoke('open_path', { path });
  post('/api/open', { path }).then(async (r) => (r.ok ? (location.href = '/') : toast(t(await r.text()))));
}

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
  // library nodes (imports) are read-only here: edits would show but never be saved. Instance overrides are fine.
  const libPath = (path) => { let n = index().get(path?.split('/')[0]); while (n && n.parent !== doc && n.parent !== doc._lib) n = index().get(n.parent.id); return !!n && n.parent === doc._lib; };
  const own = (...paths) => { const p = paths.find(libPath); if (p) throw new Error(t(`“${index().get(p.split('/')[0]).node.name ?? p}” é um componente da biblioteca: abra ${libFile(p)} para editar`)); };
  const api = createApi(doc);
  const tracked = {
    ...api,
    touch: (path) => { own(path); touch(path); watch(path); ops.push({ t: 'update', id: path }); },
    Insert: (p, d) => { own(p); touch(p); watch(p); const id = restructured(api.Insert(p, d)); created(p, id); ops.push({ t: 'insert', id }); return id; },
    Copy: (path, p, d) => { own(p); touch(p); watch(p); const id = restructured(api.Copy(path, p, d)); created(p, id); ops.push({ t: 'insert', id }); return id; },
    Update: (path, d) => { own(path); touch(path); watch(path); api.Update(path, d); ops.push({ t: 'update', id: path, keys: Object.keys(d) }); },
    Replace: (path, d) => { own(path); const root = rootIdOf(path, index()); touch(path); watch(path); const id = restructured(api.Replace(path, d)); if (root === path) snap(id, true); ops.push({ t: 'remove', id: path }, { t: 'insert', id }); return id; },
    Move: (path, p, i) => { own(path, p); touch(path); touch(p); watch(path); watch(p); restructured(api.Move(path, p, i)); ops.push({ t: 'remove', id: path }, { t: 'insert', id: path }); },
    Delete: (path) => {
      own(path); touch(path); watch(path);
      const n = index().get(path)?.node;
      if (n) connectionsTouching(doc, new Set(indexNodes({ children: [n] }).keys())).forEach((c) => snap(c.id)); // removed with it
      restructured(api.Delete(path)); ops.push({ t: 'remove', id: path });
    },
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
  pushBounded(undo, entry);
  redo.length = 0;
  if (sel !== undefined) {
    const ids = [].concat((typeof sel === 'function' ? sel(result) : sel) ?? []);
    selected = ids[0] ?? null;
    extra.clear();
    ids.slice(1).forEach((id) => extra.add(id));
  }
  markUnsaved(dirty, full, entry.order);
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
  markUnsaved(dirty, full, back.order);
  pushBounded(to, back);
  update(dirty, { full });
  scheduleSave();
}

// Saves are coalesced (typing, nudging, dragging); while an agent is working we save immediately so its next
// read of the document includes your edits.
// A save sends only what was edited since the last one: commit() and undo/redo record the roots (and META / ORDER) in
// `feed.unsaved`, the server puts them on its copy of the document, which keeps the agents' edits to other roots.
// The server's own changes come back as patches (see patch-sync.js). Saves and reloads run one at a time on `saving`.
const markUnsaved = (roots, meta, was) => {
  roots.forEach((id) => feed.unsaved.add(id));
  if (meta) feed.unsaved.add(META);
  if (was.join() !== doc.children.map((c) => c.id).join()) feed.unsaved.add(ORDER);
};
const feed = newState();
let saveTimer = null, saving = Promise.resolve(), patching = Promise.resolve();
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, busy ? 0 : 300);
}
// the body of a save for these keys: the roots as they are now, the ids that are gone, the order / meta if they changed
function saveBody(keys) {
  const byId = new Map(doc.children.map((c) => [c.id, c])), ids = [...keys].filter((k) => k !== META && k !== ORDER);
  return JSON.stringify({
    roots: ids.filter((id) => byId.has(id)).map((id) => byId.get(id)),
    deleted: ids.filter((id) => !byId.has(id)),
    ...(keys.has(ORDER) && { order: doc.children.map((c) => c.id) }),
    ...(keys.has(META) && { meta: { variables: doc.variables, themes: doc.themes, fonts: doc.fonts, imports: doc.imports } }),
  });
}
function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(async () => {
    if (!feed.unsaved.size) return;
    const body = saveBody(begin(feed));
    let seq;
    try {
      const res = await fetch(docUrl('/doc'), { method: 'PUT', body });
      if (res.status === 409) { feed.flight = null; feed.deferred = []; return; } // another document is open now: these edits belong to the one we left
      if (!res.ok) throw new Error(await res.text());
      ({ seq } = await res.json());
    } catch (e) { failed(feed); throw e; }
    await applyParts(settle(feed, seq)); // patches that happened after our PUT and waited for it
  }).catch(() => toast('Falha ao salvar — o app ainda está rodando?'));
  return saving;
}
// the document the editor shows travels with every save: after File > Open a late save of the old one is refused
const docUrl = (path) => (docFile ? `${path}?file=${encodeURIComponent(docFile)}` : path);
addEventListener('beforeunload', () => { if (feed.unsaved.size) navigator.sendBeacon?.(docUrl('/doc-beacon'), saveBody(begin(feed))); });

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

// Connections are top-level nodes but not layers: the overlay draws them (see drawLinks).
const layersOf = (d) => expandDoc(d).filter((n) => !isConnection(n));
// Full render: first load, theme/variable changes.
export function render() {
  rootMeta.clear();
  expanded = layersOf(doc);
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
  expanded = layersOf(doc);
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
    if (!raw || isConnection(raw)) { byId.delete(id); rootMeta.delete(id); rootRect.delete(id); labels.get(id)?.remove(); labels.delete(id); continue; }
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
const renderPanel = () => renderProps({ doc, view, selected, info, elOf, commit, select, exportNode, theme, isPath, toast, download, copyLink, openLib, assetUrl });

function applyCam() {
  world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`; // only hosts the text editor overlay
  canvasView?.setCamera(cam);
  $('#zoom-pct').textContent = `${Math.round(cam.z * 100)}%`;
  overlayFrame ||= requestAnimationFrame(() => { overlayFrame = 0; drawOverlay(); }); // a trackpad sends several wheel events per frame
}
let overlayFrame = 0;


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
  if (remeasure) { selRect = worldRectOf(selected); extraRects = [...extra].map(worldRectOf); hoverRect = !isSel(hovered) ? worldRectOf(hovered) : null; if (!linksHidden) measureLinks(); }
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
  if ((linkRects.length && !linksHidden) || linking) nodes.push(...drawLinks());
  if (hoverRect && !isSel(hovered)) nodes.push(place(sel.hover, toScreen(hoverRect)) && sel.hover);
  extraRects.forEach((r, i) => r && nodes.push(place((extraBoxes[i] ??= h('div', { class: 'sel-box' })), toScreen(r)) && extraBoxes[i]));
  if (band) nodes.push(place(band.el, toScreen(band.r)) && band.el);
  nodes.push(...guideNodes(altDown && !band ? measureSegs() : guides));
  if (selected && selRect) {
    const s = toScreen(selRect), n = info(selected)?.node;
    sel.box.className = `sel-box${isPath(selected) || n?._ref ? ' inst' : ''}`;
    nodes.push(place(sel.box, s) && sel.box);
    if (!extra.size) sel.handles.forEach((hd, i) => { const [cx, cy] = [[0, 0], [1, 0], [0, 1], [1, 1]][i]; hd.style.left = `${s.left + cx * s.width}px`; hd.style.top = `${s.top + cy * s.height}px`; nodes.push(hd); });
    sel.badge.style.left = `${s.left + s.width / 2}px`;
    sel.badge.style.top = `${s.top + s.height}px`;
    sel.badge.textContent = `${Math.round(selRect.w)} × ${Math.round(selRect.h)}`;
    if (!extra.size) nodes.push(sel.badge);
    if (!extra.size && !linking) nodes.push(Object.assign(linkHandle.style, { left: `${s.left + s.width}px`, top: `${s.top + s.height / 2}px` }) && linkHandle);
  }
  // only touch the overlay DOM when the set of visible items changed
  if (nodes.length !== overlay.childElementCount || nodes.some((n, i) => overlay.children[i] !== n)) overlay.replaceChildren(...nodes);
}

// ---------------------------------------------------------------- connections (prototype links)
// Drag the dot on the selection's right edge onto another screen to link them (a button → the modal-open variant).
// Stored as pen.dev `connection` nodes; agents read them as "this layer leads to that state" (get_node).
// Drawn as SVG in screen space with the rest of the overlay; click a line to select it, Delete removes it.
// Each link can be named like in draw.io (stored in `context`): the name is a pill on the line, double-click edits it.
// A selected link shows its two ends: drag them to change sides or reattach; drag the name to bend the line.
const linkHandle = h('div', { class: 'link-handle', title: t('Drag onto another screen to link them'), onpointerdown: (e) => startLink(e) });
const links = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
links.classList.add('links');
let linkRects = [], linking = null, selConn = null, editingConn = null; // linking: { from, to, p } while dragging a new link (p in world space)
const linkLabels = new Map(); // connection id -> pill element, reused
// Hiding the connections skips drawing and measuring them (the SVG is rebuilt and every pill laid out on each pan/zoom frame).
let linksHidden = localStorage.getItem('pena.linksHidden') === '1';
function measureLinks() {
  linkRects = doc.children.filter(isConnection).map((c) => ({ c, a: worldRectOf(c.source?.path), b: worldRectOf(c.target?.path) })).filter((l) => l.a && l.b);
}
// Reshaping a link (draw.io-like): drag an end to change its side or reattach it, drag the name to bend the line.
// Pena-only extras live in `metadata` (pen.dev keeps it as is): `fixedAnchors` makes the stored anchors win over the
// automatic sides, `bend` moves the curve's middle by [x, y] in world units.
let linkDrag = null; // { id, c, a?, b? }: preview of the link being dragged (a/b: a free end's point rect)
const linkMeta = (c) => (c.metadata?.type === 'pena-link' ? c.metadata : { type: 'pena-link' });
const shape = (l) => (linkDrag?.id === l.c.id ? { c: linkDrag.c, a: linkDrag.a ?? worldRectOf(linkDrag.c.source.path), b: linkDrag.b ?? worldRectOf(linkDrag.c.target.path) } : l);
const SIDE = { right: [1, 0.5, 1, 0], left: [0, 0.5, -1, 0], bottom: [0.5, 1, 0, 1], top: [0.5, 0, 0, -1], center: [0.5, 0.5, 0, 0] };
function curve(a, b, c) { // world rects → screen-space cubic from a's side to b's, plus its midpoint
  const m = c ? linkMeta(c) : {};
  const [sa, sb] = (m.fixedAnchors ? [c.source.anchor, c.target.anchor] : anchorsFor(a, b)).map((k) => SIDE[k] ?? SIDE.center), A = toScreen(a), B = toScreen(b);
  const p = [A.left + sa[0] * A.width, A.top + sa[1] * A.height], q = [B.left + sb[0] * B.width, B.top + sb[1] * B.height];
  // moving both control points by 4/3·v moves the midpoint by v
  const k = Math.max(30, Math.hypot(q[0] - p[0], q[1] - p[1]) * 0.4), v = (m.bend ?? [0, 0]).map((d) => (d * cam.z * 4) / 3);
  const c1 = [p[0] + sa[2] * k + v[0], p[1] + sa[3] * k + v[1]], c2 = [q[0] + sb[2] * k + v[0], q[1] + sb[3] * k + v[1]];
  const xs = [p[0], c1[0], c2[0], q[0]], ys = [p[1], c1[1], c2[1], q[1]]; // a Bézier stays inside its control points' box
  return { d: `M${p} C${c1} ${c2} ${q}`, p, q, mid: [0, 1].map((i) => (p[i] + 3 * c1[i] + 3 * c2[i] + q[i]) / 8), box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}
const nameAt = (path) => info(path)?.node.name ?? path;
const linkEnds = { source: h('div', { class: 'link-end', onpointerdown: (e) => dragLinkEnd(e, 'source') }), target: h('div', { class: 'link-end', onpointerdown: (e) => dragLinkEnd(e, 'target') }) };
// Few DOM nodes on purpose: one path per state (normal / touching the selection / selected) holds every curve, another
// its end dots (zero-length segments with round caps), and each link keeps only a transparent path to click.
const LINK_CLASS = { '': 'link', on: 'link on', sel: 'link on sel' };
function drawLinks() {
  const near = (path) => isSel(path) || ancestors(path).some(isSel), extras = [], paths = { '': '', on: '', sel: '' }, dots = { '': '', on: '', sel: '' }, hits = [];
  for (const { c, a, b } of linkRects.map(shape)) {
    if (!a || !b) continue;
    const { d, p, q, mid, box } = curve(a, b, c), picked = c.id === selConn;
    if (!picked && (box[2] < 0 || box[3] < 0 || box[0] > innerWidth || box[1] > innerHeight)) continue; // off screen: no SVG, no pill
    const on = picked || near(c.source.path) || near(c.target.path), k = picked ? 'sel' : on ? 'on' : '';
    paths[k] += d; dots[k] += `M${p}h0M${q}h0`;
    hits.push(`<path class="hit" data-id="${esc(c.id)}" d="${d}"/>`);
    // the name, or a "Name" pill on the selected link so naming is one click away; dragging it bends the line
    if ((c.context || picked) && c.id !== editingConn) extras.push(linkLabel(c, mid, on));
    if (picked) for (const [end, [x, y]] of [['source', p], ['target', q]]) extras.push(Object.assign(linkEnds[end].style, { left: `${x}px`, top: `${y}px` }) && linkEnds[end]);
  }
  const svg = Object.keys(paths).filter((k) => paths[k]).map((k) => `<path class="${LINK_CLASS[k]}" d="${paths[k]}"/><path class="dot ${k}" d="${dots[k]}"/>`);
  svg.push(...hits);
  if (linking) {
    const a = worldRectOf(linking.from), b = linking.to ? worldRectOf(linking.to) : { ...linking.p, w: 0, h: 0 };
    if (a && b) { const { d, p } = curve(a, b); svg.push(`<g class="link on drawing"><path d="${d}"/><circle cx="${p[0]}" cy="${p[1]}" r="4"/></g>`); }
  }
  links.innerHTML = svg.join('');
  for (const [id, el] of linkLabels) if (!extras.includes(el)) linkLabels.delete(id);
  return [links, ...extras];
}
// The hover text is built when the pointer gets there, not for every link on every frame.
links.addEventListener('pointerover', (e) => {
  const el = e.target, c = el.classList?.contains('hit') && !el.firstChild && linkRects.find((l) => l.c.id === el.dataset.id)?.c;
  if (c) el.innerHTML = `<title>${esc(`${nameAt(c.source.path)} → ${nameAt(c.target.path)}${c.context ? ` (${c.context})` : ''}\n${t('Double-click to describe · Delete removes')}`)}</title>`;
});
let bent = false; // the pointerup that ends a bend drag must not count as a click on the name
function linkLabel(c, [x, y], on) {
  let el = linkLabels.get(c.id);
  if (!el) {
    el = h('div', { class: 'link-label', onpointerdown: (e) => { e.stopPropagation(); if (selConn !== c.id) { select(null); selConn = c.id; drawOverlay(); } dragBend(e, c.id); },
      onclick: () => !bent && !doc.children.find((n) => n.id === c.id)?.context && editLink(c.id), ondblclick: (e) => (e.stopPropagation(), editLink(c.id)) });
    linkLabels.set(c.id, el);
  }
  const text = c.context || t('Name this link'), cls = `link-label${on ? ' on' : ''}${c.context ? '' : ' empty'}`;
  if (el.textContent !== text) el.textContent = text;
  if (el.className !== cls) el.className = cls;
  el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  return el;
}
function dragBend(e, id) {
  const c = doc.children.find((n) => n.id === id), start = { x: e.clientX, y: e.clientY }, [bx, by] = linkMeta(c).bend ?? [0, 0];
  bent = false;
  const move = (ev) => {
    if (!bent && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 3) return;
    bent = true;
    linkDrag = { id, c: { ...c, metadata: { ...linkMeta(c), bend: [Math.round(bx + (ev.clientX - start.x) / cam.z), Math.round(by + (ev.clientY - start.y) / cam.z)] } } };
    drawOverlay();
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    if (linkDrag) commit((api) => api.Update(id, { metadata: linkDrag.c.metadata }));
    linkDrag = null;
    setTimeout(() => (bent = false));
  }, { once: true });
}
// The side of rect r closest to point w.
const nearestSide = (r, w) => Object.entries({ left: w.x - r.x, right: r.x + r.w - w.x, top: w.y - r.y, bottom: r.y + r.h - w.y }).sort((x, y) => Math.abs(x[1]) - Math.abs(y[1]))[0][0];
// Drop an end on the side it should use; over another layer it reattaches (the target end: a screen, as when linking).
function dragLinkEnd(e, end) {
  e.stopPropagation();
  const c = doc.children.find((n) => n.id === selConn), l = linkRects.find((r) => r.c.id === selConn);
  if (!c || !l) return;
  const other = end === 'source' ? 'target' : 'source', screenOf = (p) => ancestors(p).at(-1) ?? p, box = end === 'source' ? 'a' : 'b';
  const [sa, sb] = linkMeta(c).fixedAnchors ? [c.source.anchor, c.target.anchor] : anchorsFor(l.a, l.b); // keep the other end where it is
  const base = { ...c, source: { ...c.source, anchor: sa }, target: { ...c.target, anchor: sb }, metadata: { ...linkMeta(c), fixedAnchors: true } };
  linkDrag = { id: c.id, c: base };
  const move = (ev) => {
    const w = toWorld(ev.clientX, ev.clientY), chain = chainAt(ev.clientX, ev.clientY);
    const at = end === 'target' ? chain[0] : chain.includes(c.source.path) ? c.source.path : chain.at(-1);
    const ok = at && screenOf(at) !== screenOf(base[other].path);
    linkDrag = ok ? { id: c.id, c: { ...base, [end]: { path: at, anchor: nearestSide(worldRectOf(at), w) } } } : { id: c.id, c: base, [box]: { ...w, w: 0, h: 0 } };
    hovered = ok && at !== c[end].path ? at : null;
    drawOverlay({ remeasure: true });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    const done = linkDrag;
    linkDrag = hovered = null;
    if (done && !done[box] && done.c !== base) commit((api) => api.Update(c.id, { [end]: done.c[end], [other]: done.c[other], metadata: done.c.metadata }));
    else drawOverlay({ remeasure: true });
  }, { once: true });
}
// Inline name editor on the line's midpoint; Enter or click outside saves, Esc cancels, empty removes the name.
// Like renameLabel, the field lives outside #overlay so redraws don't end the edit.
function editLink(id) {
  const l = linkRects.find((r) => r.c.id === id);
  if (!l) return;
  const [x, y] = curve(l.a, l.b, l.c).mid, host = $('#canvas').getBoundingClientRect();
  const input = h('input', { class: 'link-edit', value: l.c.context ?? '', placeholder: t('Describe the interaction (e.g. on click, after submit)'),
    style: { left: `${x - host.left}px`, top: `${y - host.top}px` } });
  editingConn = id;
  drawOverlay();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.remove();
    editingConn = null;
    const v = input.value.trim(), c = doc.children.find((n) => n.id === id);
    if (save && c && v !== (c.context ?? '')) commit((api) => api.Update(id, { context: v || undefined }));
    else drawOverlay();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
  input.onpointerdown = (e) => e.stopPropagation();
  input.onblur = () => finish(true);
  $('#canvas').append(input);
  setTimeout(() => (input.focus(), input.select()));
}
links.addEventListener('pointerdown', (e) => {
  const id = e.target.dataset?.id;
  if (!id) return;
  e.stopPropagation();
  select(null);
  selConn = id;
  drawOverlay();
});
links.addEventListener('dblclick', (e) => {
  if (!e.target.dataset?.id) return;
  e.stopPropagation();
  editLink(e.target.dataset.id);
});
// The target is the screen (top-level layer) under the cursor, never the source's own screen.
function startLink(e) {
  e.stopPropagation();
  const from = selected, own = ancestors(from).at(-1) ?? from;
  linking = { from, to: null, p: toWorld(e.clientX, e.clientY) };
  const move = (ev) => {
    const to = chainAt(ev.clientX, ev.clientY)[0];
    linking.p = toWorld(ev.clientX, ev.clientY);
    linking.to = to && to !== own ? to : null;
    hovered = linking.to;
    drawOverlay({ remeasure: true });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', async () => {
    removeEventListener('pointermove', move);
    const { to } = linking;
    linking = null;
    hovered = null;
    drawOverlay({ remeasure: true });
    if (!to) return;
    if (doc.children.some((c) => isConnection(c) && c.source?.path === from && c.target?.path === to)) return toast(t('These layers are already linked'));
    const [sa, sb] = anchorsFor(worldRectOf(from), worldRectOf(to));
    const id = await commit((api) => api.Insert('document', { type: 'connection', source: { path: from, anchor: sa }, target: { path: to, anchor: sb } }));
    selConn = id;
    editLink(id); // name it right away (optional: Esc or click outside leaves it unnamed)
  }, { once: true });
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
  selConn = null;
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
  selConn = null;
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

// One hit test per frame, however many pointermoves came in (a mouse reports faster than a screen draws).
let hoverAt = null;
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const idle = !hoverAt;
  hoverAt = { x: e.clientX, y: e.clientY, meta: e.metaKey, over: e.target === canvas || e.target.id === 'gl' };
  if (idle) requestAnimationFrame(() => {
    const at = hoverAt;
    hoverAt = null;
    if (!at) return; // the pointer left meanwhile
    const id = tool === 'select' && at.over ? clickTarget(at.x, at.y, at.meta) : null;
    if (id !== hovered) { hovered = id; drawOverlay({ remeasure: true }); }
  });
});
canvas.addEventListener('pointerleave', () => { hoverAt = null; hovered = null; drawOverlay({ remeasure: true }); });

canvas.addEventListener('pointerdown', (e) => {
  if (e.target.isContentEditable) return;
  if (e.button === 2) { const id = pick(e.clientX, e.clientY); if (id && !isSel(id)) select(id); return; } // the menu acts on what's under the cursor
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

// What a preview move/resize repaints: the drawing area of the roots holding these nodes (call before and after).
const rootExtents = (ids) => [...new Set([...ids].map((i) => scene.node(i)).filter(Boolean).map((n) => scene.rootOf(n)))].map((r) => r.extentWorld());
// Children laid out by flex can't be dragged freely (same as pen.dev); absolute ones and root nodes can.
const isFree = (id) => {
  const { node, parent } = info(id) ?? {};
  return node && (!parent || parent.type === 'group' || (parent.layout ?? 'horizontal') === 'none' || node.layoutPosition === 'absolute');
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
    const was = rootExtents(origin.keys());
    for (const [i, [x, y]] of origin) scene.previewMove(i, x + dx, y + dy);
    for (const r of [...was, ...rootExtents(origin.keys())]) canvasView.damage(r);
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
    let w = Math.max(1, Math.round(cx ? w0 + dx : w0 - dx)), hh = Math.max(1, Math.round(cy ? h0 + dy : h0 - dy));
    if (ev.shiftKey) { // keep the aspect ratio, following the axis dragged the most
      const k = Math.abs(w / w0 - 1) > Math.abs(hh / h0 - 1) ? w / w0 : hh / h0;
      w = Math.max(1, Math.round(w0 * k)); hh = Math.max(1, Math.round(h0 * k));
    }
    next = { width: w, height: hh };
    if (free && !cx) next.x = Math.round(x0 + (w0 - w));
    if (free && !cy) next.y = Math.round(y0 + (h0 - hh));
    if (n.type === 'text') next.textGrowth = 'fixed-width-height';
    const was = rootExtents([id]);
    scene.previewSize(id, next);
    for (const r of [...was, ...rootExtents([id])]) canvasView.damage(r);
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
// Where the canvas starts, past the panels that are still on screen.
const canvasLeft = () => {
  if (document.body.classList.contains('no-left')) return 60;
  const side = document.body.classList.contains('no-convs') ? 0 : parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w')) || 210;
  return document.body.classList.contains('no-chat') ? side + 25 : side + 210;
};
function fitRect(x0, y0, x1, y1, single) {
  const left = canvasLeft(), right = document.body.classList.contains('no-props') ? 20 : 290;
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
  const left = canvasLeft(), right = document.body.classList.contains('no-props') ? 20 : 290;
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
const layerLabel = (n) => n.name ?? n.content?.slice(0, 40) ?? n.type;
// While searching (⌘F) the tree becomes a flat list of every layer whose name matches, at any depth.
let layerQuery = '';
const layerMatches = () => {
  const out = [], walk = (n) => { if (layerLabel(n).toLowerCase().includes(layerQuery)) out.push(n); n.children?.forEach(walk); };
  expanded.forEach(walk);
  return out;
};
function renderLayers() {
  if (!$('#pane-layers').classList.contains('on')) return;
  const rows = [];
  const add = (n, depth) => {
    const kids = n.children?.length > 0, isOpen = open.has(n.id);
    const row = h('div', {
      class: `row${isSel(n.id) ? ' sel' : ''}${n.reusable ? ' comp' : isPath(n.id) || n._ref ? ' inst' : ''}${n.enabled === false ? ' hidden' : ''}`,
      'data-id': n.id, style: { paddingLeft: `${4 + depth * 14}px` },
      onclick: (e) => { const multi = e.shiftKey || e.metaKey || e.ctrlKey; select(n.id, multi); if (layerQuery && !multi) fitSelection(); },
      ondblclick: (e) => { if (!e.target.closest('.tw')) rename(row, n); },
      onpointerenter: () => { hovered = n.id; drawOverlay({ remeasure: true }); },
    },
      h('span', { class: `tw${isOpen ? ' open' : ''}`, onclick: (e) => { e.stopPropagation(); isOpen ? open.delete(n.id) : open.add(n.id); renderLayers(); } }, kids && ic('chevron-right')),
      ic(layerIcon(n), 15),
      h('span', { class: 'nm' }, layerLabel(n)),
      h('span', { class: 'eye', title: 'Mostrar/ocultar', onclick: (e) => { e.stopPropagation(); commit((api) => api.Update(n.id, { enabled: n.enabled === false })); } }, ic(n.enabled === false ? 'eye-off' : 'eye', 14)));
    rows.push(row);
    if (kids && isOpen && !layerQuery) for (const c of n.children) add(c, depth + 1);
  };
  if (layerQuery) layerMatches().forEach((n) => add(n, 0));
  else for (const n of expanded) add(n, 0);
  $('#layers').replaceChildren(...(rows.length || !layerQuery ? rows : [h('div', { class: 'hint', style: { padding: '12px 10px' } }, 'Nenhuma camada encontrada')]));
}
// Enter jumps to the next match (cycling), Escape clears the search.
$('#layer-q').oninput = (e) => { layerQuery = e.target.value.trim().toLowerCase(); renderLayers(); };
$('#layer-q').onkeydown = (e) => {
  if (e.key === 'Escape') { e.target.value = ''; layerQuery = ''; renderLayers(); return e.target.blur(); }
  if (e.key !== 'Enter' || !layerQuery) return;
  const list = layerMatches();
  if (!list.length) return;
  const i = list.findIndex((n) => n.id === selected);
  select(list[(i + (e.shiftKey ? list.length - 1 : 1)) % list.length].id);
  fitSelection();
};
function openLayerSearch() {
  document.body.classList.remove('no-left');
  if (!$('#pane-layers').classList.contains('on')) $('.tabs [data-tab="layers"]').click();
  $('#layer-q').focus(); $('#layer-q').select();
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
// pen.dev's browser extension ("copy to Pen"). Chrome hands us the payload; the desktop webview can't see Chrome's
// custom clipboard type, so with an empty body the server reads the OS clipboard (204: nothing from the extension).
async function importBrowser(payload) {
  const res = await fetch('/import-browser', { method: 'POST', body: payload || '' }).catch((e) => ({ ok: false, text: () => e.message }));
  if (res.status === 204) return;
  if (!res.ok) return toast(await res.text());
  const { pages, fonts } = await res.json();
  return placeFigma(pages, undefined, fonts);
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
addEventListener('paste', (e) => {
  if (e.target.matches?.('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  pasteData((type) => e.clipboardData.getData(type), [...e.clipboardData.files]);
});
// The context menu's Paste: no paste event there, so the clipboard is read (WebKit may ask first).
async function pasteFromMenu() {
  const items = await navigator.clipboard.read().catch(() => null);
  if (!items) return toast('Use ⌘V para colar');
  const texts = {}, files = [];
  for (const it of items) for (const type of it.types) {
    const b = await it.getType(type);
    if (type.startsWith('image/')) files.push(new File([b], `colado.${type.split('/')[1]}`, { type }));
    else texts[type] = await b.text();
  }
  pasteData((type) => texts[type] ?? '', files);
}
async function pasteData(getData, allFiles) {
  // Figma puts its layers on the clipboard as HTML: data-buffer="<!--(figma)BASE64(/figma)-->"
  const fig = /\(figma\)([A-Za-z0-9+/=]+)\(\/figma\)/.exec(getData('text/html'));
  if (fig) return importFigma(Uint8Array.from(atob(fig[1]), (c) => c.charCodeAt(0)));
  const files = allFiles.filter((f) => f.type.startsWith('image/'));
  if (files.length) return files.forEach((f) => importImage(f));
  let data;
  try { data = JSON.parse(getData('text/plain')); } catch {}
  if (!data?.pena) return importBrowser(getData('web application/vnd.pen.dev.browser-import+json'));
  const sel = selected && !isPath(selected) && info(selected)?.node;
  const parent = sel?.type === 'frame' || sel?.type === 'group' ? sel.id : info(selected)?.parent?.id && !isPath(info(selected).parent.id) ? info(selected).parent.id : 'document';
  await commit((api) => data.nodes.map((n) => api.Insert(parent, { ...n, x: (n.x ?? 0) + 20, y: (n.y ?? 0) + 20 })), { select: (ids) => ids });
}
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
  if (mod && k === 'f') { e.preventDefault(); return openLayerSearch(); }
  if (e.shiftKey && !mod && k === 'l') return setLinksHidden(!linksHidden);
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
  if (selConn && (e.key === 'Backspace' || e.key === 'Delete')) { e.preventDefault(); const id = selConn; selConn = null; return commit((api) => api.Delete(id)); }
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
    return commit((api) => api.Move(id, undefined, info(id).parent ? to : doc.children.indexOf(doc.children.find((c) => c.id === siblings[to].id))));
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
    const parentId = parent?.id ?? 'document', index = (parent?.children ?? doc.children).findIndex((c) => c.id === id);
    const frame = api.Insert(parentId, { type: 'frame', name: t('Frame'), layout: 'none', x: node.x ?? 0, y: node.y ?? 0, width: w, height: hh });
    api.Move(frame, parentId, index);
    api.Move(id, frame);
    api.Update(id, { x: 0, y: 0 });
    return frame;
  }, { select: (fid) => fid });
}

// ---------------------------------------------------------------- top bar
$('#hide-props').onclick = () => document.body.classList.toggle('no-props');
const setConvs = (hidden) => { document.body.classList.toggle('no-convs', hidden); localStorage.setItem('pena.convsHidden', hidden ? '1' : ''); };
setConvs(localStorage.getItem('pena.convsHidden') === '1');
$('#list-hide').onclick = () => setConvs(true);
$('#list-show').onclick = () => setConvs(false);
function setLinksHidden(v) {
  linksHidden = v; selConn = null;
  localStorage.setItem('pena.linksHidden', v ? '1' : '');
  $('#hide-links').classList.toggle('on', v);
  if (v) { links.replaceChildren(); linkLabels.clear(); }
  drawOverlay({ remeasure: true });
}
$('#hide-links').onclick = () => setLinksHidden(!linksHidden);
$('#hide-links').classList.toggle('on', linksHidden);
$('#hide-chat').onclick = () => document.body.classList.toggle('no-chat');
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
const FORMATS = [['PNG', 'png'], ['JPEG', 'jpeg'], ['WebP', 'webp'], ['SVG', 'svg'], ['PDF', 'pdf'], ['HTML + CSS', 'html-css'], ['Figma (.fig)', 'fig']];
$('#export-btn').onclick = (e) => {
  const id = selected ?? expanded[0]?.id;
  if (!id) return toast('Nada para exportar');
  // .fig without a selection: the whole document
  menu(e.currentTarget, [{ head: `Exportar “${info(id).node.name ?? id}”` }, ...FORMATS.map(([label, f]) => ({ label: f === 'fig' && !selected ? `${label} — documento inteiro` : label, run: () => download(f === 'fig' ? selected : id, f) }))], { align: 'right' });
};
// Right-click anywhere on the canvas: copy/paste, the link for agents, export, and a chat about the selection.
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const at = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) };
  const k = navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl+', id = selected;
  menu(at, [
    ...(id ? [{ label: 'Copiar', icon: 'copy', note: `${k}C`, run: () => document.execCommand('copy') }] : []),
    { label: 'Colar', icon: 'clipboard-paste', note: `${k}V`, run: pasteFromMenu },
    ...(id ? ['sep',
      { label: 'Copiar link para o agente', icon: 'link', note: `${k}L`, run: () => copyLink() },
      { label: 'Exportar', icon: 'download', run: () => {}, sub: FORMATS.map(([label, f]) => ({ label, run: () => download(id, f) })) },
      { label: 'Ligar a outra tela', icon: 'spline', run: () => linkFromMenu(e) },
      'sep',
      { label: 'Novo chat com a seleção', icon: 'message-square-plus', run: chatWithSelection }] : []),
  ]);
});
// Like dragging the link dot, without the drag: the line follows the pointer and the next click picks the screen.
function linkFromMenu(e) {
  addEventListener('pointerdown', (ev) => ev.stopPropagation(), { capture: true, once: true }); // that click only links
  startLink({ clientX: e.clientX, clientY: e.clientY, stopPropagation() {} });
}
// A new chat that starts from the selection: it goes along with the first message (its chip in the composer).
async function chatWithSelection() {
  ctxOff = '';
  await newChat();
  renderAttachments();
  $('#prompt').focus();
}
export async function download(id, format, scale = 2) {
  const data = await exportNode(id, format, { scale });
  const name = `${format === 'fig' ? docName() : info(id)?.node.name ?? 'export'}.${format === 'html-css' ? 'html' : format}`;
  const a = h('a', { download: name, href: data.startsWith('data:') ? data : URL.createObjectURL(new Blob([data], { type: format === 'svg' ? 'image/svg+xml' : 'text/html' })) });
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
  if (format === 'svg') return nodeSVG(sn);
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
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const md = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
const SUGGESTIONS = [
  'Terminal de trading em tempo real, alto contraste',
  'Landing page retrô-futurista para uma estação espacial privada',
  'App divertido de pedidos para bolos de matcha',
  'App de meditação neumórfico suave',
  'Portfólio editorial para uma marca de moda de vanguarda',
  'App mobile aconchegante para cuidar de plantas',
];
// What the next chats inherit from here, without opening a menu: the group and the instructions it shares.
function groupCard() {
  const g = currentGroup;
  if (!g) return h('button', { class: 'group-card empty', onclick: () => editGroup(null) },
    ic('folder-plus', 13), h('span', {}, 'Criar um grupo para compartilhar contexto entre chats'));
  return h('div', { class: 'group-card' },
    h('div', { class: 'gc-head' }, ic('folder', 13), h('b', { 'data-i18n-ignore': true }, g.name),
      h('button', { class: 'gc-edit', onclick: () => editGroup(g) }, ic('pencil', 11), g.brief ? 'Editar' : 'Adicionar instruções')),
    h('p', { 'data-i18n-ignore': true }, g.brief || 'Sem instruções ainda: este grupo não compartilha contexto entre os chats.'));
}
function emptyChat() {
  $('#log').replaceChildren(h('div', { class: 'empty-chat' },
    h('h4', {}, 'Peça para desenhar qualquer coisa'),
    SUGGESTIONS.map((s) => h('button', { class: 'suggest', onclick: () => { $('#prompt').value = t(s); $('#prompt').focus(); autoGrow(); } }, s)),
    groupCard(),
    h('div', { class: 'tip' }, h('b', {}, 'Gerar código'), 'Peça ao agente para implementar o design em React, Tailwind, Next.js ou a stack que preferir. Para um HTML, selecione um frame e use “Exportar HTML” no painel de propriedades.'),
    h('div', { class: 'tip' }, h('b', {}, 'Anexar contexto'), 'Arraste qualquer arquivo (HTML, PDF, imagens, código, CSV…) para o compositor, cole com ⌘V no campo ou anexe pelo +.')));
}
// While agents run, Enter queues the message (sent when they finish) and ⌘Enter steers: stops the turn and sends it now.
// `sending`: posted but not started yet, so a second Enter can't race it. `paused`: Stop holds the queue until the next send.
// `queue` belongs to the conversation on screen: switching chats saves it and restores the other chat's queue.
let busy = 0, sending = false, paused = false, queue = [], currentChatId = null, currentGroup = null, currentPinned = false, loadingChat = false;
const queues = new Map();
function useChat(id) {
  if (id === currentChatId) return;
  if (currentChatId) queues.set(currentChatId, queue);
  currentChatId = id;
  queue = queues.get(id) ?? [];
  queues.delete(id);
  sending = false;
  paused = false;
  renderQueue();
}
// streamed agent activity (chatlog.js): cards, thinking, plan, per-agent headers and the running-agents strip
const chat = createChatLog({
  log: $('#log'), strip: $('#agent-strip'), todosEl: $('#todo-panel'),
  onRunning: (n, ev) => setBusy(n, ev), onStop: () => stop(),
  onLogin: (provider) => post('/api/settings/login', { provider }),
  onPickVariation: (agent) => post('/api/variation', { agent }).then((r) => r.json()),
  onReconnect: () => reconnectTools(),
});
const stop = () => { paused = true; post('/stop'); };
const flushQueue = () => { if (!busy && !sending && !paused && !loadingChat && queue.length) sendPrompt(...queue.shift().args), renderQueue(); };
const setBusy = (n, ev) => {
  busy = Math.max(0, n);
  if (n > 0 && !ev?.parent) sending = false;
  $('#send').replaceChildren(ic(busy ? 'square' : 'arrow-up', busy ? 12 : 15));
  $('#send').title = busy ? 'Parar' : 'Enviar (Enter)';
  $('#prompt').placeholder = busy ? t('Press Enter to queue · ⌘Enter to steer now') : t('Draw anything… (/ for skills)');
  flushQueue();
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
    ...(selected && ctxOff !== selKey() ? [h('span', { class: 'att', title: 'Seleção atual vai junto com a mensagem' }, ic('frame', 12), extra.size ? `${extra.size + 1} camadas` : h('span', { 'data-i18n-ignore': true }, info(selected)?.node.name ?? selected),
      h('button', { title: 'Não enviar a seleção', onclick: () => { ctxOff = selKey(); renderAttachments(); } }, ic('x', 12)))] : []));
}
// The selection the user took out of the message (× on its chip); selecting something else brings the chip back.
let ctxOff = '';
const selKey = () => selection().join();
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
  $('#handoff-pending').replaceChildren(); // it goes with this message
  const p = pref();
  post('/chat', { provider: p.provider, model: p.model, effort: p.effort, prompt, shown, context, images, files: files.map(({ name, data }) => ({ name, data })), skills: skillNames, steer, ...agentsPref(), ...designPref() });
  setConversationName(shown.slice(0, 40));
}
// Design-tool health: the design tools are a separate MCP process that the agent's CLI spawns. When it does not come
// up, the agent can only say it cannot edit the file. Show that (red composer + banner) and fix it from here: the old
// sessions are dropped, so the next message starts a new one with the tools and the handoff keeps the conversation.
let mcpTimer = 0;
function renderMcp(s = {}) {
  const bar = $('#mcp-banner'), offline = s.ok === false;
  $('#composer').classList.toggle('offline', offline);
  bar.classList.toggle('ok', s.ok === true);
  clearTimeout(mcpTimer);
  if (s.ok === true) {
    bar.replaceChildren(ic('circle-check', 13), h('span', {}, `Ferramentas de design reconectadas · ${s.tools} disponíveis`));
    mcpTimer = setTimeout(() => renderMcp({ ok: null }), 5000);
  } else if (offline) bar.replaceChildren(ic('alert-triangle', 13),
    h('span', {}, `As ferramentas de design não conectaram${s.error ? `: ${s.error}` : ''}. Os agentes não conseguem editar o .pen até reconectar.`),
    h('button', { class: 'btn solid', onclick: reconnectTools }, 'Reconectar'));
  else bar.replaceChildren();
}
async function reconnectTools() {
  const bar = $('#mcp-banner');
  bar.classList.remove('ok');
  bar.replaceChildren(ic('refresh-cw', 13), h('span', {}, 'Reconectando as ferramentas de design…'));
  const r = await post('/api/mcp/reconnect').then((x) => x.json()).catch((e) => ({ ok: false, error: e.message }));
  renderMcp(r);
  if (r.ok && r.fixed?.length) toast(`Integração atualizada (${r.fixed.join(', ')}). Sessões já abertas em outros apps pegam as ferramentas num chat novo.`);
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
  input.title = input.value;
}
function submit(steer = false) {
  const text = $('#prompt').value.trim();
  if (!text && !attachments.length && !skills.length) return;
  const sels = ctxOff === selKey() ? [] : selection().map((id) => info(id)?.node).filter(Boolean);
  const body = text || (skills.length ? 'Apply the attached skill to the current design.' : 'Look at the attached files.');
  const listed = sels.map((n) => `${n.id} "${n.name ?? n.type}"`).join(', ');
  const args = [sels.length ? `${body}\n\n(Selected node${sels.length > 1 ? 's' : ''}: ${listed})` : body, text, attachments, skills.map((s) => s.name), sels.length ? sels.map((n) => n.name ?? n.type).join(', ') : null];
  if ((busy || sending) && !steer) queue.push({ args, label: text || attachments[0]?.name || skills.map((s) => `/${s.name}`).join(' ') }), renderQueue();
  else sendPrompt(...args, steer);
  $('#prompt').value = ''; attachments = []; skills = []; renderAttachments(); autoGrow();
}
// The prompt grows with its text (capped by the CSS max-height); the grip on top sets its resting height, kept across sessions.
const autoGrow = () => { const t = $('#prompt'); t.style.height = 'auto'; if (t.value) t.style.height = `${t.scrollHeight}px`; };
const setPromptMin = (px) => { $('#prompt').style.minHeight = px ? `${px}px` : ''; autoGrow(); };
setPromptMin(Number(localStorage.getItem('pena.promptHeight')) || 0);
$('#composer-grip').onpointerdown = (e) => {
  const grip = e.currentTarget, y0 = e.clientY, h0 = $('#prompt').offsetHeight;
  grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
  grip.onpointermove = (m) => setPromptMin(Math.max(38, Math.min(innerHeight / 2, h0 + y0 - m.clientY)));
  grip.onpointerup = () => { grip.onpointermove = grip.onpointerup = null; grip.classList.remove('drag'); localStorage.setItem('pena.promptHeight', parseFloat($('#prompt').style.minHeight) || 0); };
};
$('#composer-grip').ondblclick = () => { localStorage.removeItem('pena.promptHeight'); setPromptMin(0); };
// the chat panel ends right above the composer, however tall it gets
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--composer-h', `${e.target.offsetHeight}px`)).observe($('#composer'));
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
// files dropped anywhere on the chat panel or the composer attach to the prompt (the canvas imports them as layers instead)
for (const el of [$('#left'), $('#composer')]) {
  const isFiles = (e) => e.dataTransfer?.types.includes('Files');
  el.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); $('#left').classList.add('drop-hint'); $('#composer').classList.add('drop-hint'); });
  el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) document.querySelectorAll('.drop-hint').forEach((x) => x.classList.remove('drop-hint')); });
  el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); document.querySelectorAll('.drop-hint').forEach((x) => x.classList.remove('drop-hint')); addFiles(e.dataTransfer.files); });
}
// pasting files into the prompt attaches them (images pasted on the canvas still become image layers)
$('#prompt').addEventListener('paste', (e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } });
// --- conversations sidebar (T3 Code/ChatGPT style): groups own chats, pinned chats sit on top -----------
let convData = { current: null, list: [], groups: [] }, convQuery = '';
const collapsedGroups = new Set((() => { try { const v = JSON.parse(localStorage.getItem('pena.groupsCollapsed') ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } })());
const groupNameOf = (id) => (convData.groups ?? []).find((g) => g.id === id)?.name ?? null;
const saveCollapsed = () => localStorage.setItem('pena.groupsCollapsed', JSON.stringify([...collapsedGroups]));
function toggleGroup(id) {
  collapsedGroups.has(id) ? collapsedGroups.delete(id) : collapsedGroups.add(id);
  saveCollapsed();
  drawConvList();
}
function convRow(c, pinned = false) {
  const group = groupNameOf(c.group);
  const more = h('button', { class: 'row-act', title: 'Opções da conversa', onclick: (e) => { e.stopPropagation(); chatMenu(c, more); } }, ic('more-horizontal', 13));
  const row = h('div', {
    class: `conv-row${c.id === convData.current ? ' on' : ''}${pinned ? ' has-sub' : ''}`,
    title: `${c.title} · ${timeAgo(c.updated)}${group ? ` · ${group}` : ''}`,
    'data-i18n-ignore-attrs': '',
    onclick: () => openChat(c.id),
    oncontextmenu: (e) => { e.preventDefault(); chatMenu(c, more); },
  },
    h('span', { class: 'dot-slot' }, c.running ? h('span', { class: 'dot' }) : null),
    h('div', { class: 'col' },
      h('span', { class: 't', 'data-i18n-ignore': true }, c.title),
      pinned ? h('span', { class: 'sub', 'data-i18n-ignore': true }, group ?? 'Sem grupo') : null),
    more);
  return row;
}
function sectionHead({ icon, name, count, title, arrow = false, static: isStatic = false, onclick, actions = [] }) {
  return h('div', { class: `section-head${isStatic ? ' static' : ''}`, title, onclick },
    h('span', { class: 'arrow' }, arrow ? ic('chevron-down', 12) : null),
    ic(icon, 12),
    h('span', { class: 'name', 'data-i18n-ignore': true }, name),
    h('span', { class: 'count' }, String(count ?? '')),
    ...actions);
}
function pinnedSection(chats) {
  return h('div', { class: 'conv-section' },
    sectionHead({ icon: 'pin', name: 'Fixados', count: chats.length, static: true }),
    h('div', { class: 'section-body' }, ...chats.map((c) => convRow(c, true))));
}
function groupSection(g, chats, total) {
  const collapsed = !convQuery && collapsedGroups.has(g.id);
  const count = convQuery ? chats.length : total;
  const actions = [
    h('button', { class: 'head-act', title: 'Nova conversa', onclick: (e) => { e.stopPropagation(); newChat(g.id); } }, ic('plus', 13)),
    h('button', { class: 'head-act', title: 'Editar grupo', onclick: (e) => { e.stopPropagation(); editGroup(g); } }, ic('pencil', 13)),
  ];
  return h('div', { class: `conv-section${collapsed ? ' collapsed' : ''}` },
    sectionHead({ icon: 'folder', name: g.name, count, arrow: true, title: g.brief ? `${g.name} — ${g.brief.slice(0, 300)}` : `${g.name} — sem instruções compartilhadas`, onclick: () => toggleGroup(g.id), actions }),
    h('div', { class: 'section-body' }, ...chats.map((c) => convRow(c))));
}
function looseSection(chats, total) {
  return h('div', { class: 'conv-section' },
    sectionHead({ icon: 'message-circle', name: 'Sem grupo', count: convQuery ? chats.length : total, static: true }),
    h('div', { class: 'section-body' }, ...chats.map((c) => convRow(c))));
}
function drawConvList() {
  const groups = convData.groups ?? [], all = convData.list ?? [];
  const q = convQuery;
  const list = q ? all.filter((c) => `${c.title} ${groupNameOf(c.group) ?? ''}`.toLowerCase().includes(q)) : all;
  if (!all.length) {
    return $('#convs').replaceChildren(h('div', { class: 'conv-empty' }, 'Nenhuma conversa ainda'),
      h('button', { class: 'btn primary conv-new', onclick: () => newChat() }, ic('plus', 13), 'Nova conversa'));
  }
  const nodes = [], pinned = list.filter((c) => c.pinned);
  if (pinned.length) nodes.push(pinnedSection(pinned));
  for (const g of groups) {
    const chats = list.filter((c) => !c.pinned && c.group === g.id);
    if (chats.length || !q) nodes.push(groupSection(g, chats, all.filter((c) => c.group === g.id).length));
  }
  const loose = list.filter((c) => !c.pinned && !groups.some((g) => g.id === c.group));
  if (!groups.length) nodes.push(...loose.map((c) => convRow(c)));
  else if (loose.length) nodes.push(looseSection(loose, all.filter((c) => !c.group).length));
  if (!nodes.length) nodes.push(h('div', { class: 'conv-empty' }, 'Nenhuma conversa encontrada'));
  $('#convs').replaceChildren(...nodes);
}
async function renderConvList() {
  const data = await fetch('/api/chats').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (data) convData = data;
  drawConvList();
}
function activateChatTab() {
  document.body.classList.remove('no-chat'); // a conversation picked in the sidebar brings the chat back
  const b = $('.tabs [data-tab="chat"]');
  if (!b.classList.contains('on')) b.click();
}
async function newChat(groupId = null) {
  const r = await post('/chat', { provider: 'reset' });
  const { id } = await r.json();
  if (groupId) await post('/api/chats/group', { id, group: groupId });
  await loadChat();
  activateChatTab();
}
async function openChat(id) {
  activateChatTab();
  if (id === currentChatId) return;
  const r = await post('/api/chats/select', { id });
  if (!r.ok) return toast(await r.text());
  await loadChat();
}
async function togglePin(c) {
  const r = await post('/api/chats/pin', { id: c.id, pinned: !c.pinned });
  if (!r.ok) return toast(await r.text());
  c.pinned = !c.pinned;
  if (c.id === currentChatId) { currentPinned = c.pinned; setPinUI(currentPinned); }
  renderConvList();
}
async function moveChat(c, groupId) {
  const r = await post('/api/chats/group', { id: c.id, group: groupId });
  if (!r.ok) return toast(await r.text());
  c.group = groupId;
  if (c.id === currentChatId) {
    const { group } = await r.json();
    renderGroup(group ?? null);
    if ($('.empty-chat')) emptyChat();
  }
  renderConvList();
}
async function deleteChat(c) {
  if (!confirm('Apagar esta conversa?')) return;
  const r = await post('/api/chats/delete', { id: c.id });
  if (!r.ok) return toast(await r.text());
  if (c.id !== currentChatId) return renderConvList();
  await loadChat(); // the next chat opens in the same pane
}
async function deleteGroup(g) {
  if (!confirm('Apagar este grupo? As conversas continuam, sem grupo.')) return false;
  const r = await post('/api/groups/delete', { id: g.id });
  if (!r.ok) { toast(await r.text()); return false; }
  if (currentGroup?.id === g.id) { renderGroup(null); if ($('.empty-chat')) emptyChat(); }
  renderConvList();
  return true;
}
function chatMenu(c, anchor) {
  menu(anchor, [
    { label: c.pinned ? 'Desafixar' : 'Fixar', icon: 'pin', run: () => togglePin(c) },
    { label: 'Mover para grupo', icon: 'folder', sub: [
      ...(convData.groups ?? []).map((g) => ({ label: g.name, raw: true, icon: 'folder', on: g.id === c.group, run: () => moveChat(c, g.id) })),
      { label: 'Sem grupo', icon: 'message-circle', on: !c.group, run: () => moveChat(c, null) },
    ] },
    'sep',
    { label: 'Apagar conversa', icon: 'trash-2', run: () => deleteChat(c) },
  ]);
}
function setPinUI(pinned) {
  const b = $('#pin-chat');
  b.classList.toggle('pinned', pinned);
  b.title = pinned ? 'Desafixar conversa' : 'Fixar conversa';
  b.replaceChildren(ic('pin', 14));
}
$('#list-new').onclick = () => newChat();
$('#new-chat').onclick = () => newChat();
$('#new-group').onclick = () => editGroup(null, { join: false });
$('#list-search').prepend(ic('search', 13));
$('#conv-search').oninput = (e) => { convQuery = e.target.value.trim().toLowerCase(); drawConvList(); };
$('#conv-search').onkeydown = (e) => { if (e.key === 'Escape') { e.target.value = ''; convQuery = ''; drawConvList(); } };
$('#pin-chat').onclick = async () => {
  if (!currentChatId) return;
  const r = await post('/api/chats/pin', { id: currentChatId, pinned: !currentPinned });
  if (!r.ok) return toast(await r.text());
  currentPinned = !currentPinned;
  setPinUI(currentPinned);
  renderConvList();
};

// The sidebar and the chat are two independent widths (the composer follows the chat). Persisted per machine.
let sideW = Math.min(360, Math.max(190, Number(localStorage.getItem('pena.sidebarW')) || 210));
let chatW = Math.min(760, Math.max(340, Number(localStorage.getItem('pena.chatW')) || 356));
const setVar = (name, value) => document.documentElement.style.setProperty(name, `${value}px`);
setVar('--side-w', sideW);
setVar('--chat-w', chatW);
function dragResize(el, read, write, min, max) {
  el.onpointerdown = (e) => {
    e.preventDefault();
    const start = { x: e.clientX, v: read() };
    el.classList.add('drag');
    el.setPointerCapture(e.pointerId);
    const move = (ev) => write(Math.min(max, Math.max(min, start.v + ev.clientX - start.x)));
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
}
dragResize($('#side-resize'), () => sideW, (v) => { sideW = v; setVar('--side-w', v); localStorage.setItem('pena.sidebarW', v); }, 190, 360);
dragResize($('#chat-resize'), () => chatW, (v) => { chatW = v; setVar('--chat-w', v); localStorage.setItem('pena.chatW', v); }, 340, 760);

// Groups: a name plus one shared instructions text, injected into every agent of every chat in the group.
function renderGroup(g) {
  currentGroup = g ?? null;
  const btn = $('#group-btn');
  btn.classList.toggle('none', !g);
  btn.title = g ? `Grupo “${g.name}”${g.brief ? ` — ${g.brief.slice(0, 240)}` : ' — sem instruções compartilhadas'}` : 'Grupo de chats: instruções compartilhadas por todo agente';
  btn.replaceChildren(ic('folder', 12), h('span', { 'data-i18n-ignore': true }, g?.name ?? 'Sem grupo'), ic('chevron-down', 10));
  $('#new-chat').title = g ? `Nova conversa em “${g.name}”` : 'Nova conversa';
}
async function joinGroup(id) {
  if (!currentChatId) { await post('/chat', { provider: 'reset' }); await loadChat(); }
  const r = await post('/api/chats/group', { id: currentChatId, group: id });
  if (!r.ok) return toast(await r.text());
  renderGroup((await r.json()).group);
  if ($('.empty-chat')) emptyChat(); // the empty chat explains the group the next turn will use
}
function editGroup(g, { join = true } = {}) {
  const close = () => bg.remove();
  const name = h('input', { value: g?.name ?? '', placeholder: 'Ex.: Landing do cliente X', maxlength: 80 });
  const brief = h('textarea', { rows: 8, maxlength: 4000, value: g?.brief ?? '', placeholder: 'Ex.: app de finanças pessoais. Paleta azul (#2563eb), Inter, cantos de 12px. Decisões já tomadas: header fixo, hero em duas colunas…' });
  const save = async () => {
    const r = await post('/api/groups/save', { id: g?.id, name: name.value, brief: brief.value });
    if (!r.ok) return toast(await r.text());
    const { group } = await r.json();
    close();
    if (!g) { if (join) await joinGroup(group.id); else renderConvList(); }
    else {
      if (currentGroup?.id === group.id) { renderGroup(group); if ($('.empty-chat')) emptyChat(); }
      renderConvList();
    }
  };
  const bg = h('div', { class: 'modal-bg', onclick: (e) => e.target === bg && close() },
    h('div', { class: 'modal', style: { width: 'min(520px, 92vw)' } },
      h('header', {}, ic('folder'), g ? 'Editar grupo' : 'Novo grupo', h('div', { style: { flex: 1 } }), h('button', { class: 'btn icon', onclick: close }, ic('x'))),
      h('div', { class: 'group-form' },
        h('label', {}, 'Nome', name),
        h('label', {}, 'Instruções compartilhadas', brief),
        h('div', { class: 'hint' }, 'Todo agente dos chats deste grupo recebe estas instruções em todo turno — inclusive os criados por spawn_agents. Vale para chats novos e para os próximos turnos dos existentes.')),
      h('footer', {},
        g && h('button', { class: 'btn', style: { color: 'var(--danger)' }, onclick: async () => { if (await deleteGroup(g)) close(); } }, ic('trash-2'), 'Apagar'),
        h('div', { style: { flex: 1 } }),
        h('button', { class: 'btn', onclick: close }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: save }, 'Salvar'))));
  document.body.append(bg);
  name.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
  brief.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } };
  addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { removeEventListener('keydown', esc); close(); } });
  (g ? brief : name).focus();
}
$('#group-btn').onclick = async (e) => {
  const btn = e.currentTarget;
  const { groups = [], list = [] } = await fetch('/api/chats').then((r) => r.json());
  const g = currentGroup;
  const count = (id) => list.filter((c) => (c.group ?? null) === id).length;
  menu(btn, [
    { head: 'Grupos deste arquivo', icon: 'folder' },
    ...(groups.length ? groups.map((x) => ({ label: x.name, raw: true, icon: 'folder', on: x.id === g?.id, note: count(x.id) ? `${count(x.id)} chat${count(x.id) > 1 ? 's' : ''}` : '', run: () => joinGroup(x.id) })) : [{ head: 'Nenhum grupo ainda' }]),
    'sep',
    { label: 'Novo grupo…', icon: 'plus', run: () => editGroup(null) },
    ...(g ? [
      { label: 'Editar instruções…', icon: 'pencil', run: () => editGroup(g) },
      { label: 'Tirar esta conversa do grupo', icon: 'x', run: () => joinGroup(null) },
    ] : []),
  ]);
};

// Chat history: the file's current conversation is restored on open; the sidebar lists the others.
async function loadChat() {
  let c = await fetch('/api/chats/current').then((r) => (r.ok ? r.json() : { messages: [] })).catch(() => ({ messages: [] }));
  if (!c.id) {
    // the chat pane always has a conversation, like a new chat in ChatGPT; the sidebar lists it
    await post('/chat', { provider: 'reset' });
    c = await fetch('/api/chats/current').then((r) => (r.ok ? r.json() : c)).catch(() => c);
  }
  loadingChat = true;
  try {
    useChat(c.id ?? null);
    renderGroup(c.group ?? null);
    currentPinned = !!c.pinned;
    setPinUI(currentPinned);
    $('#log').replaceChildren();
    chat.clear();
    if (!c.messages?.length) {
      emptyChat();
      setConversationName('New agent', true);
    } else {
      for (const m of c.messages) {
        if (m.kind === 'user') logUser(m.text, m.skills ?? [], m.images ?? 0, m.files ?? [], m.context);
        else if (!(m.id || ['start', 'model', 'end', 'todos', 'handoff'].includes(m.kind)) || !chat.event(m, { live: false })) log(m.kind, m.text, m.agent); // older history entries
      }
      setConversationName(c.title ?? 'Conversation', !c.title);
    }
    // a background chat's agents keep running: show them as working as soon as this chat is on screen
    chat.setRunning(c.running ?? []);
  } finally {
    loadingChat = false;
  }
  renderConvList();
  flushQueue();
  refreshHandoff();
}
// Like T3 Code, the composer says when the next message hands the conversation to another agent (or a new session).
async function refreshHandoff() {
  const p = pref();
  const d = await fetch(`/api/handoff?provider=${encodeURIComponent(p.provider)}&model=${encodeURIComponent(p.model ?? '')}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // A session the CLI no longer has gets the whole history again: say so instead of drawing "same model → same model".
  const same = d?.from.length && d.from.every((r) => r.provider === d.to.provider && r.model === d.to.model);
  $('#handoff-pending').replaceChildren(...(d ? [h('div', { class: 'q', title: 'A próxima mensagem leva o contexto da conversa para este agente' }, ic('arrow-right-left', 12),
    h('span', {}, same ? 'Nova sessão deste agente: o contexto será transferido' : 'Contexto será transferido'),
    handoffRoute(same ? { from: [], to: d.to } : d))] : []));
}
const refreshModel = async () => {
  refreshHandoff();
  const p = pref();
  $('#model').replaceChildren(...[brandIcon(p.provider.split('-')[0], 14), h('span', { 'data-i18n-ignore': true }, await modelLabel()), ic('chevron-down', 12)].filter(Boolean));
  $('#effort').replaceChildren(ic('zap', 12), t(EFFORT_LABEL[p.effort] ?? p.effort ?? '—'));
};
$('#model').onclick = (e) => pickModel(e.currentTarget, refreshModel);
agentsButton($('#agents'));
designButtons($('#rule-states'), $('#rule-flows'));
slashSkills($('#prompt'), (s) => { if (!skills.some((x) => x.name === s.name)) skills.push(s); renderAttachments(); });
$('#effort').onclick = (e) => pickEffort(e.currentTarget, refreshModel);

// ---------------------------------------------------------------- live sync with the server
const events = new EventSource('/events');
let listTimer = 0;
// The connection came back after a drop: patches may have been missed in between.
let opened = false;
events.onopen = () => { if (opened) reload(); opened = true; };
events.addEventListener('doc', () => reload());
// An agent (or the server) changed roots: swap them in without fetching the document. In order, one at a time, and
// behind any reload (reload() parks this chain until it is done). What the editor has edited and not saved wins.
events.addEventListener('patch', (e) => {
  const p = JSON.parse(e.data);
  patching = patching.then(async () => {
    const r = route(p, feed);
    if (r.type === 'reload') return reload();
    try { await applyParts(r.apply); } catch { await reload(); }
  }).catch(() => {}); // a failed reload (server gone) must not stop the chain: the next patch or reconnect tries again
});
const META_KEYS = ['variables', 'themes', 'fonts', 'imports'];
// Put parts of the server's version (from route() or settle()) into the document and redraw what they touch.
async function applyParts(parts) {
  if (!parts.length) return;
  const byId = new Map(doc.children.map((c) => [c.id, c])), dirty = new Set();
  let order = null, meta = null;
  for (const { key, value } of parts) {
    if (key === ORDER) order = value;
    else if (key === META) meta = value;
    else if (value.deleted) byId.delete(key), dirty.add(key);
    else byId.set(key, value), dirty.add(key);
  }
  doc.children = order ? [...order.filter((id) => byId.has(id)).map((id) => byId.get(id)), ...[...byId.values()].filter((c) => !order.includes(c.id))] : [...byId.values()];
  if (meta) {
    const imports = JSON.stringify(doc.imports ?? {});
    for (const k of META_KEYS) meta[k] === undefined || meta[k] === null ? delete doc[k] : (doc[k] = meta[k]);
    if (JSON.stringify(doc.imports ?? {}) !== imports) await loadImportsFor(doc);
  }
  update(dirty, { full: !!meta });
  refreshShaders();
}
const loadImportsFor = (d) => loadImports(d, (p) => fetch(`/import?path=${encodeURIComponent(p)}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(p)))));
// an agent may have rewritten a .glsl (WriteShader): redraw the roots that use shaders
async function refreshShaders() {
  if (!(await refreshShaderSources().catch(() => false))) return;
  const ids = doc.children.filter((c) => JSON.stringify(c).includes('"type":"shader"')).map((c) => c.id);
  if (ids.length) update(new Set(ids));
}
events.addEventListener('save-error', (e) => toast(`Não foi possível gravar o arquivo (${JSON.parse(e.data).message}) — tentando de novo`));
events.addEventListener('file', () => { selected = null; extra.clear(); undo.length = redo.length = 0; loadChat(); reload(true); });
events.addEventListener('agent', (e) => {
  const d = JSON.parse(e.data);
  presence?.agent(d);
  // the sidebar shows a dot per running chat: refresh it when a turn starts or finishes, even in the background
  if (d.kind === 'start' || d.kind === 'end') {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => renderConvList(), 350);
  }
  if (currentChatId && d.conv && d.conv !== currentChatId) return; // a background chat keeps working in its own history
  if (!chat.event(d)) log(d.kind, d.text, d.agent);
  if (d.kind === 'end') refreshHandoff();
  if (d.kind === 'end' && d.reason === 'failed' && d.tools) renderMcp({ ok: false }); // the composer goes red too
});
// the app's own view of the design-tool connection (checked on startup and when the user reconnects)
events.addEventListener('mcp', (e) => renderMcp(JSON.parse(e.data)));
fetch('/api/mcp/health').then((r) => r.json()).then((s) => s.at && renderMcp(s)).catch(() => {});
// which nodes an agent just wrote or read: cursor + flash on the canvas
events.addEventListener('agent-nodes', (e) => presence?.nodes(JSON.parse(e.data)));
// shaders in a subtree that fail to load or compile (drawn without them), so an agent's screenshot says why
function shaderProblems(id) {
  const out = new Set();
  const walk = (n) => {
    for (const s of [...[].concat(n.src.fill ?? []), ...[].concat(n.src.effect ?? [])])
      if (s?.type === 'shader' && s.url) { const err = shaderError(assetUrl(s.url)); if (err) out.add(`Shader ${s.url} (${n.id}): ${err}`); }
    n.children.forEach(walk);
  };
  const sn = scene?.node(id);
  if (sn) walk(sn);
  return [...out];
}
events.addEventListener('render', async (e) => {
  const { reqId, ids, format, options = {} } = JSON.parse(e.data);
  try {
    // The agent's last edit was applied just before this request, and its patch came ahead of this event on the same
    // stream: wait for our own save in flight (it may park a patch) and for the patches still being applied.
    await saving;
    await patching;
    await refreshShaders();
    await document.fonts.ready;
    const results = [];
    for (const id of ids) results.push({ id, data: await exportNode(id, format, options), warnings: shaderProblems(id) });
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
  patching = patching.then(() => p).catch(() => {}); // patches that come meanwhile are judged against the document it fetches
  return p;
}

async function sync(first) {
  if (first) performance.mark('pena:load-start');
  const res = await fetch('/doc');
  if (res.status === 409) return (location.href = '/dashboard');
  const name = decodeURIComponent(res.headers.get('x-pena-name') ?? '');
  const nextFile = decodeURIComponent(res.headers.get('x-pena-file') ?? '');
  if (!first && docFile && nextFile !== docFile) first = true; // File > Open raced with this reload: never merge the old document's edits into the new one
  docFile = nextFile;
  const seq = Number(res.headers.get('x-pena-seq') ?? 0);
  const next = migrate(await res.json());
  if (first) performance.mark('pena:parsed');
  // libraries (`imports`): loaded once; reused while the import list doesn't change
  if (!first && JSON.stringify(next.imports ?? {}) === JSON.stringify(doc.imports ?? {})) setLib(next, doc._lib);
  else await loadImportsFor(next);
  const shadersChanged = !first && (await refreshShaderSources());
  $('#docname span').textContent = name;
  document.title = `${name} — Pena`;
  if (first) {
    doc = next;
    feed.unsaved.clear(); // edits of the file we just left
    reset(feed, seq);
    await renderProgressive();
    performance.mark('pena:load-end');
    schedulePreview(1500);
    return;
  }
  // Changed by an agent or another app. Local edits not on the server yet (save pending) go on top of its version
  // — no await from here on, so an edit can't slip in between — then re-render only the roots that differ.
  reset(feed, seq);
  const local = { roots: [...feed.unsaved].filter((k) => k !== META && k !== ORDER), meta: feed.unsaved.has(META), order: feed.unsaved.has(ORDER) };
  if (local.roots.length || local.meta || local.order) mergeDocs(next, doc, local), scheduleSave();
  const now = new Map(doc.children.map((c) => [c.id, JSON.stringify(c)]));
  const dirty = new Set();
  for (const c of next.children) if (now.get(c.id) !== JSON.stringify(c)) dirty.add(c.id);
  for (const id of now.keys()) if (!next.children.some((c) => c.id === id)) dirty.add(id);
  // an agent may have rewritten a .glsl (WriteShader): redraw the roots that use shaders
  if (shadersChanged) for (const c of next.children) if (JSON.stringify(c).includes('"type":"shader"')) dirty.add(c.id);
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
