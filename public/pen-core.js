// .pen document core, shared by the editor (browser) and the MCP server (Node).
// Format-compatible with pen.dev files (2.6 – 2.21): legacy nodes are migrated on load,
// component instances (`ref` + `descendants`) are expanded with slash id paths (`instanceId/childId`).

export const VERSION = '2.21';
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const newId = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => ALPHABET[b % 62]).join('');

const kids = (n) => n.children ?? [];
export const sizeNumber = (v) => (typeof v === 'number' ? v : Number(/\(([\d.]+)\)/.exec(v ?? '')?.[1] ?? 0));

// ---------- legacy migration (older pen.dev files) ----------
const migrated = new WeakSet(); // documents already migrated (the editor calls createApi on every edit)
export function migrate(doc) {
  if (migrated.has(doc)) return doc;
  const node = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'icon_font') {
      Object.assign(n, { type: 'icon', icon: n.iconFontName, library: n.iconFontFamily });
      delete n.iconFontName, delete n.iconFontFamily;
    }
    const s = n.stroke;
    if (s && typeof s === 'object' && !Array.isArray(s) && !s.type && ('thickness' in s || 'align' in s || 'fill' in s)) {
      delete n.stroke;
      if (s.fill !== undefined) n.stroke = s.fill;
      if (s.thickness !== undefined) n.strokeWidth = s.thickness;
      if (s.align) n.strokeAlignment = { inside: 'inner', outside: 'outer' }[s.align] ?? s.align;
      if (s.join) n.strokeLinejoin = s.join;
      if (s.cap) n.strokeLinecap = s.cap;
    }
    // Pena 0.1 draft format -> pen.dev format
    const effects = [].concat(n.effect ?? []);
    for (const sh of [].concat(n.shadow ?? [])) effects.push({ type: 'shadow', shadowType: 'outer', offset: { x: sh.x ?? 0, y: sh.y ?? 4 }, blur: sh.blur ?? 12, color: sh.color ?? '#00000026' });
    if (n.blur) effects.push({ type: 'blur', radius: n.blur });
    if (n.backgroundBlur) effects.push({ type: 'background_blur', radius: n.backgroundBlur });
    if (n.shadow || n.blur || n.backgroundBlur) (n.effect = effects), delete n.shadow, delete n.blur, delete n.backgroundBlur;
    for (const e of [].concat(n.effect ?? [])) if (e?.type === 'shadow') delete e.spread; // dropped in 2.21 (pen.dev no longer reads it)
    if (n.textDecoration) (n.textDecoration === 'underline' ? (n.underline = true) : n.textDecoration === 'line-through' && (n.strikethrough = true)), delete n.textDecoration;
    n.fill = Array.isArray(n.fill) ? n.fill.map(draftFill) : draftFill(n.fill);
    if (n.fill === undefined) delete n.fill;
    for (const f of [].concat(n.fill ?? []))
      if (f?.type === 'image' && f.mode) f.mode = { fill: 'cover', fit: 'contain' }[f.mode] ?? f.mode;
    kids(n).forEach(node);
    for (const o of Object.values(n.descendants ?? {})) node(o);
  };
  doc.children ??= [];
  doc.children.forEach(node);
  doc.version = VERSION; // migrated documents are written in the current format (validated against pen.dev's schema)
  migrated.add(doc);
  return doc;
}

function draftFill(f) {
  if (f?.type !== 'linear_gradient' && f?.type !== 'radial_gradient') return f;
  return { type: 'gradient', gradientType: f.type === 'linear_gradient' ? 'linear' : 'radial', rotation: (360 - (f.angle ?? 180)) % 360, colors: (f.stops ?? []).map((st) => ({ color: st.color, position: st.position ?? 0 })) };
}

// ---------- variables & themes ----------
export const themeDefaults = (doc) => Object.fromEntries(Object.entries({ ...doc._lib?.themes, ...doc.themes }).map(([axis, values]) => [axis, values[0]]));

export function resolveValue(doc, v, theme = themeDefaults(doc), depth = 0) {
  if (typeof v !== 'string' || !v.startsWith('$') || depth > 10) return v;
  const def = doc.variables?.[v.slice(1)] ?? doc._lib?.variables[v.slice(1)];
  if (!def) return undefined;
  let val = def.value;
  if (Array.isArray(val)) {
    const fits = val.filter((e) => !e.theme || Object.entries(e.theme).every(([k, x]) => theme[k] === x));
    val = (fits.sort((a, b) => Object.keys(b.theme ?? {}).length - Object.keys(a.theme ?? {}).length)[0] ?? val[0])?.value;
  }
  return resolveValue(doc, val, theme, depth + 1);
}

// Deep-resolve every $variable in a node's own props (not children).
export function resolveProps(doc, node, theme) {
  const r = (v) => (Array.isArray(v) ? v.map(r) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, r(x)])) : resolveValue(doc, v, theme));
  const { children, descendants, ...props } = node;
  return { ...r(props), ...(children && { children }), ...(descendants && { descendants }) };
}

// ---------- component instances ----------
export function indexNodes(doc) {
  const index = new Map();
  const walk = (n, parent) => {
    index.set(n.id, { node: n, parent });
    kids(n).forEach((c) => walk(c, n));
  };
  kids(doc).forEach((c) => walk(c, doc));
  for (const c of doc._lib?.nodes ?? []) walk(c, doc._lib);
  return index;
}

// ---------- imports (libraries) ----------
// `imports: { alias: 'path/to/lib.pen' }` (relative to the file). Like pen.dev, a library's node ids, component
// refs and variables are addressed as `alias:name` (e.g. `$q:--background`, ref `q:uOGCI`). Libraries are flattened
// (nested imports included) and attached to the document non-enumerably, so they are never saved into it.
export async function loadImports(doc, read, base = '') {
  const libs = [];
  for (const [alias, rel] of importList(doc)) {
    const file = joinPath(base, rel);
    let src;
    try { src = migrate(JSON.parse(await read(file))); } catch { continue; }
    await loadImports(src, read, file);
    libs.push([alias, src]);
  }
  return attachLibs(doc, libs);
}
// Same for synchronous readers (the server and the agents' tools)
export function loadImportsSync(doc, read, base = '') {
  const libs = [];
  for (const [alias, rel] of importList(doc)) {
    const file = joinPath(base, rel);
    let src;
    try { src = migrate(JSON.parse(read(file))); } catch { continue; }
    loadImportsSync(src, read, file);
    libs.push([alias, src]);
  }
  return attachLibs(doc, libs);
}
const importList = (doc) => Object.entries(doc.imports ?? {}).filter(([, rel]) => typeof rel === 'string' && !rel.startsWith('pencil:'));
function attachLibs(doc, libs) {
  const lib = { nodes: [], variables: {}, themes: {} };
  for (const [alias, src] of libs) {
    const own = { nodes: [...(src.children ?? []), ...(src._lib?.nodes ?? [])], variables: { ...src._lib?.variables, ...src.variables }, themes: { ...src._lib?.themes, ...src.themes } };
    const p = prefixLib(own, alias);
    lib.nodes.push(...p.nodes);
    Object.assign(lib.variables, p.variables);
    lib.themes = { ...p.themes, ...lib.themes };
  }
  setLib(doc, lib.nodes.length || Object.keys(lib.variables).length ? lib : null);
  return doc;
}
export const setLib = (doc, lib) => Object.defineProperty(doc, '_lib', { value: lib, writable: true, configurable: true, enumerable: false });
const joinPath = (base, rel) => {
  const parts = [...base.split('/').slice(0, -1), ...rel.split('/')], out = [];
  for (const x of parts) x === '..' ? (out.length && out.at(-1) !== '..' ? out.pop() : out.push(x)) : x && x !== '.' && out.push(x);
  return out.join('/');
};
function prefixLib(lib, a) {
  const id = (x) => `${a}:${x}`;
  const vars = new Set(Object.keys(lib.variables));
  const val = (v) => (typeof v === 'string' && v.startsWith('$') && vars.has(v.slice(1)) ? `$${a}:${v.slice(1)}` : Array.isArray(v) ? v.map(val) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])) : v);
  const node = (n) => {
    const out = {};
    for (const [k, v] of Object.entries(n)) {
      if (k === 'id' || k === 'ref') out[k] = id(v);
      else if (k === 'children') out[k] = v.map(node);
      else if (k === 'slot' && Array.isArray(v)) out[k] = v.map(id);
      else if (k === 'descendants') out[k] = Object.fromEntries(Object.entries(v).map(([path, o]) => [path.split('/').map(id).join('/'), o?.type ? node(o) : val(o)]));
      else out[k] = val(v);
    }
    return out;
  };
  return {
    nodes: lib.nodes.map(node),
    variables: Object.fromEntries(Object.entries(lib.variables).map(([k, d]) => [id(k), val(d)])),
    themes: lib.themes,
  };
}

// Returns a copy of `node` with every `ref` replaced by the full component tree.
// Ids inside an instance become `instanceId/childId` (nested instances keep extending the path).
export function expandNode(node, index, prefix = '', depth = 0) {
  if (node.type === 'ref') return instantiate(node, prefix + node.id, {}, index, depth);
  return { ...node, id: prefix + node.id, ...(node.children && { children: node.children.map((c) => expandNode(c, index, prefix, depth)) }) };
}

function instantiate(ref, fullId, outer, index, depth) {
  const comp = index.get(ref.ref)?.node;
  const { ref: refId, descendants = {}, type, id, ...props } = ref;
  if (!comp || depth > 20) return { type: 'frame', id: fullId, name: `Missing component ${refId}`, width: 40, height: 40, fill: '#FF000033', _ref: refId };
  const desc = { ...descendants, ...outer }; // the outer instance wins over inner overrides
  let base;
  if (comp.type === 'ref') base = instantiate(comp, fullId, desc, index, depth + 1);
  else base = { ...comp, children: comp.children?.map((c) => applyOverrides(c, fullId, desc, index, depth + 1)) };
  const out = { ...base, ...props, id: fullId, _ref: refId };
  // Slots: children on the instance replace the component's children. They are real nodes owned by the
  // instance, so they keep their own ids (editable directly).
  if (ref.children) out.children = ref.children.map((c) => expandNode(c, index, '', depth + 1));
  if (!props.reusable) delete out.reusable;
  if (!out.children) delete out.children;
  return out;
}

function applyOverrides(child, instId, desc, index, depth) {
  const o = desc[child.id] ?? (child.name && desc[child.name]);
  if (o?.type) return expandNode({ ...o, id: child.id }, index, `${instId}/`, depth); // full replacement
  const n = o ? { ...child, ...o } : child;
  if (n.type === 'ref') {
    const nested = Object.fromEntries(
      Object.entries(desc).filter(([k]) => k.startsWith(child.id + '/')).map(([k, v]) => [k.slice(child.id.length + 1), v]),
    );
    return instantiate(n, `${instId}/${child.id}`, nested, index, depth);
  }
  return { ...n, id: `${instId}/${child.id}`, ...(n.children && { children: n.children.map((c) => applyOverrides(c, instId, desc, index, depth)) }) };
}

export const expandDoc = (doc, index = indexNodes(doc)) => doc.children.map((c) => expandNode(c, index));

// ---------- execute API ----------
// `host` lets the environment add async work collected during the (synchronous) snippet: screenshots, exports.
export function createApi(doc, out = [], host = {}) {
  migrate(doc);
  const index = () => indexNodes(doc);
  const raw = (id) => {
    if (id === 'document') return { node: doc, parent: null };
    const hit = index().get(id);
    if (!hit) throw new Error(`Node not found: ${id}`);
    return hit;
  };
  const split = (path) => {
    const i = path.indexOf('/');
    return i < 0 ? null : { inst: raw(path.slice(0, i)).node, rel: path.slice(i + 1) };
  };
  const findExpanded = (path) => {
    const stack = expandDoc(doc);
    while (stack.length) {
      const n = stack.pop();
      if (n.id === path) return n;
      stack.push(...kids(n));
    }
    throw new Error(`Node not found: ${path}`);
  };
  const clean = (n) => {
    const { _ref, ...rest } = n;
    return { ...rest, ...(n.children && { children: n.children.map(clean) }) };
  };
  // New ids for a subtree; refs pointing inside the subtree follow their component.
  const reId = (tree) => {
    const map = new Map();
    const assign = (n) => {
      const id = newId();
      if (n.id) map.set(n.id, id);
      return { ...n, id, ...(n.children && { children: n.children.map(assign) }) };
    };
    const fresh = assign(tree);
    const fix = (n) => {
      if (n.type === 'ref' && map.has(n.ref)) n.ref = map.get(n.ref);
      kids(n).forEach(fix);
    };
    fix(fresh);
    return fresh;
  };
  const strip = ({ id, ...n }) => ({ ...n, ...(n.children && { children: n.children.map(strip) }) });
  const place = (parent, node, index) => {
    if (parent && parent.includes('/')) throw new Error('Cannot insert into a component instance; insert into the component itself.');
    const p = parent && parent !== 'document' ? raw(parent).node : doc;
    if (p !== doc && !['frame', 'group'].includes(p.type)) throw new Error(`Node ${parent} (${p.type}) cannot have children`);
    const list = (p.children ??= []);
    list.splice(index ?? list.length, 0, node);
    return node.id;
  };
  const detach = (id) => {
    const { node, parent } = raw(id);
    if (!parent) throw new Error('Cannot remove the document');
    parent.children.splice(parent.children.indexOf(node), 1);
    return node;
  };
  // `descendants` on Copy: keys are ids, unique names, or `instanceId/childId` paths inside the copied subtree.
  const applyDescendants = (tree, descendants = {}) => {
    const all = indexNodes({ children: [tree] });
    const byKey = (k) => all.get(k)?.node ?? [...all.values()].find((h) => h.node.name === k)?.node;
    const mergeInto = (ref, k, o) => ((ref.descendants ??= {})[k] = o.type ? o : { ...ref.descendants[k], ...o });
    for (const [key, o] of Object.entries(descendants)) {
      const [head, ...rest] = key.split('/');
      const target = byKey(head);
      if (target && rest.length) {
        if (target.type !== 'ref') throw new Error(`${head} is not a component instance`);
        mergeInto(target, rest.join('/'), o);
      } else if (target && o.type) {
        Object.keys(target).forEach((k) => k !== 'id' && delete target[k]);
        Object.assign(target, o, { id: target.id });
      } else if (target) Object.assign(target, o);
      else if (tree.type === 'ref') mergeInto(tree, key, o); // a descendant of the copied instance's component
      else throw new Error(`Descendant not found in copy: ${key}`);
    }
    return tree;
  };
  const bounds = (n) => ({ x: n.x ?? 0, y: n.y ?? 0, width: sizeNumber(n.width), height: sizeNumber(n.height) });

  function visitAll(roots, visit, { depth: maxDepth = Infinity } = {}) {
    const results = [];
    const walk = (n, parentCtx, depth, i) => {
      let skip = false;
      const ctx = { node: n, parentCtx, depth, index: i, bounds: bounds(n), skipChildren: () => (skip = true) };
      const r = visit(n, ctx);
      if (r !== undefined) results.push(r);
      if (!skip && depth < maxDepth) kids(n).forEach((c, j) => walk(c, ctx, depth + 1, j));
    };
    roots.forEach((n, i) => walk(n, undefined, 0, i));
    return results;
  }
  const trim = (n, d) => ({
    ...n,
    ...(n.children && { children: d > 0 ? n.children.map((c) => trim(c, d - 1)) : '...' }),
  });
  const read = (path, opts = {}) => {
    let node = path.includes('/') || opts.resolveInstances ? findExpanded(path) : raw(path).node;
    if (path === 'document') node = opts.resolveInstances ? { ...doc, children: expandDoc(doc) } : doc;
    node = structuredClone(clean(node));
    if (opts.resolveVariables) {
      const rv = (n) => ({ ...resolveProps(doc, n), ...(n.children && { children: n.children.map(rv) }) });
      node = path === 'document' ? { ...node, children: node.children.map(rv) } : rv(node);
    }
    if (!opts.includePathGeometry) {
      const g = (n) => (n.type === 'path' && n.geometry?.length > 200 && (n.geometry = `${n.geometry.slice(0, 60)}… (${n.geometry.length} chars)`), kids(n).forEach(g));
      g(node);
    }
    return opts.depth !== undefined ? trim(node, opts.depth) : node;
  };

  return {
    document: 'document',
    Insert: (parent, data) => place(parent, reId(strip(data))),
    Copy: (path, parent, data = {}) => {
      const { descendants, ...props } = data;
      const src = structuredClone(clean(path.includes('/') ? findExpanded(path) : raw(path).node));
      return place(parent, reId({ ...applyDescendants(src, descendants), ...props }));
    },
    Update: (path, data) => {
      const { id, children, type, ...props } = data;
      const s = split(path);
      if (s) s.inst.descendants = { ...s.inst.descendants, [s.rel]: { ...s.inst.descendants?.[s.rel], ...props } };
      else {
        const node = raw(path).node;
        if (node.type === 'ref' && props.descendants) props.descendants = { ...node.descendants, ...props.descendants };
        Object.assign(node, props);
      }
    },
    Replace: (path, data) => {
      const s = split(path);
      if (s) {
        const fresh = { ...reId(strip(data)), id: s.rel.split('/').pop() };
        s.inst.descendants = { ...s.inst.descendants, [s.rel]: fresh };
        return path;
      }
      const { parent } = raw(path);
      const i = parent.children.findIndex((c) => c.id === path);
      detach(path);
      return place(parent === doc ? 'document' : parent.id, reId(strip(data)), i);
    },
    Move: (path, parent, index) => {
      if (path.includes('/')) throw new Error('Cannot move descendants of a component instance');
      if (parent && parent !== 'document' && indexNodes({ children: [raw(path).node] }).has(parent)) throw new Error('Cannot move a node into itself');
      place(parent ?? raw(path).parent?.id ?? 'document', detach(path), index);
    },
    Delete: (path) => {
      if (path.includes('/')) throw new Error('Cannot delete descendants of component instances; Update them with { enabled: false } instead.');
      detach(path);
    },
    Get: (a, b, c) => {
      if (typeof a === 'function') return visitAll(read('document', b).children, a, b);
      if (typeof b === 'function') return visitAll([read(a ?? 'document', c)], b, c);
      return read(a ?? 'document', b);
    },
    GetVariables: () => structuredClone({ variables: doc.variables ?? {}, ...(doc.themes && { themes: doc.themes }) }),
    SetVariables: (vars, replace = false) => {
      doc.variables = replace ? vars : { ...doc.variables, ...vars };
      for (const def of Object.values(vars))
        for (const e of Array.isArray(def.value) ? def.value : [])
          for (const [axis, v] of Object.entries(e.theme ?? {})) {
            const axisValues = ((doc.themes ??= {})[axis] ??= []);
            if (!axisValues.includes(v)) axisValues.push(v);
          }
    },
    FindEmptySpace: ({ width, height, direction = 'right', padding = 100, nodeId }) => {
      const nodes = nodeId ? [raw(nodeId).node] : doc.children;
      if (!nodes.length) return { x: 0, y: 0 };
      // hug-content sizes are only known after layout: use the editor's rendered size when it is open
      const b = nodes.map((n) => {
        const d = bounds(n), r = host.rects?.[n.id];
        return r ? { ...d, width: Math.max(d.width, r.w), height: Math.max(d.height, r.h) } : d;
      });
      const [l, t] = [Math.min(...b.map((r) => r.x)), Math.min(...b.map((r) => r.y))];
      const [r, btm] = [Math.max(...b.map((q) => q.x + q.width)), Math.max(...b.map((q) => q.y + q.height))];
      return { right: { x: r + padding, y: t }, bottom: { x: l, y: btm + padding }, left: { x: l - padding - width, y: t }, top: { x: l, y: t - padding - height } }[direction];
    },
    TakeScreenshot: (ids) => void (host.screenshots ??= []).push(...[].concat(ids)),
    Export: (ids, format, outputPath, options = {}) => void (host.exports ??= []).push({ ids: [].concat(ids), format, outputPath, options }),
    Print: (...v) => void out.push(v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
  };
}

// Content key of a rendered top-level frame (expanded tree + document variables/themes/fonts + preview theme).
// The tile cache is keyed by it, so the editor and the rasterizer must compute it identically.
export function rootHash(doc, expandedRoot, themeJson = '{}') {
  const s = JSON.stringify([doc.variables, doc.themes, doc.fonts, doc.imports, themeJson, expandedRoot]);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57; // cyrb53
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + s.length.toString(36);
}

// Merge at top-level frame ("root") granularity, for concurrent writes (you in the editor, an agent through the
// server): `changes` says what `mine` changed since its last sync — roots (edited, added or deleted), document meta,
// root order. Everything else comes from `theirs`. Merges into `theirs` in place (keeps its non-enumerable _lib).
// ponytail: same root (or meta) changed on both sides → mine wins the whole root; merge per node if that bites.
export function mergeDocs(theirs, mine, { roots = [], meta = false, order = false }) {
  const touched = new Set(roots), m = new Map(mine.children.map((c) => [c.id, c])), t = new Map(theirs.children.map((c) => [c.id, c]));
  const ids = new Set(order ? [...m.keys(), ...t.keys()] : [...t.keys(), ...m.keys()]);
  theirs.children = [...ids].map((id) => (touched.has(id) ? m : t).get(id)).filter(Boolean);
  if (meta) for (const k of ['variables', 'themes', 'fonts', 'imports']) mine[k] === undefined ? delete theirs[k] : (theirs[k] = mine[k]);
  return theirs;
}
