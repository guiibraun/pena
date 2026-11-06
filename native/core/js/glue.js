// Runs inside QuickJS, between Rust and the editor's own document model (public/pen-core.js, public/shader.js), so the
// browser and the server keep one implementation. Everything crosses the boundary as JSON text. Ported from doc.mjs
// run()/shaderApi() and the document parts of tools.mjs (flows, get_app_state, get_node).
import * as core from './pen-core.js';
import { parseUniforms, controls, toSkSL } from './shader.js';

// the Rust host functions (files, randomness, the snippet timeout): hidden from snippets, which see only the api
const host = globalThis.__host;
delete globalThis.__host;
const { parse, stringify } = JSON;
const geval = eval;
// what pen-core expects from a browser/Node global scope
globalThis.crypto = { getRandomValues: (a) => { host.random(a.length).forEach((b, i) => (a[i] = b)); return a; } };
globalThis.structuredClone = (v) => (v === undefined ? undefined : parse(stringify(v))); // documents are plain JSON

// One context serves every snippet (node:vm gave each a new one): put the global scope back as it was before each.
// ponytail: changes to builtin prototypes (Array.prototype.x = ...) would persist; a fresh context per snippet if that bites.
const baseline = new Map(Reflect.ownKeys(globalThis).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
function resetGlobals() {
  for (const k of Reflect.ownKeys(globalThis)) if (!baseline.has(k)) try { delete globalThis[k]; } catch {}
  for (const [k, d] of baseline) if (globalThis[k] !== d.value && 'value' in d) Object.defineProperty(globalThis, k, d);
}

const docOf = (json, lib) => core.setLib(parse(json), lib == null ? null : parse(lib));
const text = (t) => ({ type: 'text', text: t });

// doc.mjs load()/attachLibs(): the libraries (`imports`), flattened, and the files they came from (for libStamp)
function libsOf(doc, file) {
  const files = [];
  core.loadImportsSync(doc, (p) => (files.push(host.resolve(file, p)), host.read(files.at(-1))));
  return { lib: doc._lib ?? null, files };
}
export function load(src, file) {
  const doc = core.migrate(src == null ? { version: core.VERSION, children: [] } : parse(src));
  return stringify({ doc, ...libsOf(doc, file) });
}
export const attach = (docJson, file) => stringify(libsOf(parse(docJson), file));

// doc.mjs run(): the snippet on the document, with the api as its global scope. Returns { error } when it throws.
export function run(docJson, libJson, code, rectsJson, shaderDir, shaderLib) {
  const doc = docOf(docJson, libJson);
  const out = [], host_ = { rects: parse(rectsJson) };
  // which nodes the snippet wrote or read, for the agent cursor/flash on the canvas (pen.dev shows the same)
  const touched = [];
  const api = core.createApi(doc, out, host_);
  const mark = (kind, id) => typeof id === 'string' && id !== 'document' && touched.push({ kind, id });
  const wrap = (name, kind, pick) => { const fn = api[name]; api[name] = (...a) => { const r = fn(...a); mark(kind, pick(a, r)); return r; }; };
  wrap('Insert', 'insert', (a, r) => r);
  wrap('Copy', 'insert', (a, r) => r);
  wrap('Replace', 'update', (a, r) => r);
  wrap('Update', 'update', (a) => a[0]);
  wrap('Move', 'update', (a) => a[0]);
  wrap('Get', 'read', (a) => (typeof a[0] === 'string' ? a[0] : a[0]?.id ?? a[0]?.path));
  const shot = api.TakeScreenshot;
  api.TakeScreenshot = (ids) => { [].concat(ids).forEach((id) => mark('read', id)); return shot(ids); };
  Object.assign(api, shaderApi(shaderDir, shaderLib));
  try {
    resetGlobals();
    Object.assign(globalThis, api);
    host.arm(5000);
    let result;
    try { result = geval(`(() => {\n${code}\n})()`); } finally { host.disarm(); }
    // an async snippet would keep editing after this returns, past the diff and the rollback: refuse it
    if (typeof result?.then === 'function') { result.then?.(null, () => {}); throw new Error('The snippet must be synchronous: no async/await, no returned Promise.'); }
    if (result !== undefined) out.push(typeof result === 'string' ? result : stringify(result));
  } catch (e) {
    return stringify({ error: String(e?.message ?? e) });
  }
  delete host_.rects;
  return stringify({ doc, text: out.join('\n') || 'ok', host: host_, touched });
}

// --- shaders for agents: .glsl files live next to the .pen (shaders/), like images, so pen.dev opens them too.
// Written right away, not with the document: a snippet that throws later leaves the file (harmless, unreferenced).
function shaderApi(dir, lib) {
  const write = (name, src) => {
    if (!/^[\w-]+$/.test(name ?? '')) throw new Error('Shader name: letters, digits, - and _ only, e.g. "glow"');
    host.mkdirp(dir);
    host.write(`${dir}/${name}.glsl`, src);
    return `./shaders/${name}.glsl`;
  };
  return {
    // Pena's library: [{ name, label, kind: "effect" | "fill", uniforms: [{ name, type, label, default, min, max, color }] }]
    ListShaders: () => parse(host.read(`${lib}/library.json`)).map((s) => ({
      ...s, uniforms: controls(parseUniforms(host.read(`${lib}/${s.name}.glsl`))).map(({ name, type, label, default: d, min, max, color }) => ({ name, type, label, default: d, min, max, color })),
    })),
    // copies a library shader next to the document and returns its url, for { type: "shader", url }
    UseShader: (name) => {
      const src = `${lib}/${name}.glsl`;
      if (!/^[\w-]+$/.test(name ?? '') || !host.exists(src)) throw new Error(`Unknown shader "${name}". ListShaders() lists them.`);
      const own = `${dir}/${name}.glsl`;
      if (host.exists(own) && host.read(own) !== host.read(src)) return `./shaders/${name}.glsl`; // keep local edits
      return write(name, host.read(src));
    },
    // writes your own GLSL shader (overwrites the same name) and returns its url; structure is checked here, the
    // compile itself happens in the editor (TakeScreenshot reports compile errors)
    WriteShader: (name, source) => { toSkSL(String(source ?? '')); return write(name, String(source)); },
  };
}

export const merge = (theirs, theirsLib, mine, changes) => stringify(core.mergeDocs(docOf(theirs, theirsLib), parse(mine), parse(changes)));
// what the native renderer draws: every top-level layer, instances expanded; connections are never drawn
export const expand = (docJson, libJson) => stringify(core.expandDoc(docOf(docJson, libJson)).filter((n) => !core.isConnection(n)));

// --- tools.mjs
// Connections in a readable form; dangling ones (an end that no longer exists) are skipped.
// Each end names its screen (top-level frame) when it sits inside one: "Login" › "Entrar" → "Home".
function flows(doc, list = doc.children.filter(core.isConnection)) {
  const api = core.createApi(doc), index = core.indexNodes(doc);
  const screenOf = (p) => { let n = index.get(String(p).split('/')[0]); while (n?.parent && n.parent !== doc) n = index.get(n.parent.id); return n?.parent === doc ? n.node : null; };
  const end = (p) => {
    try {
      const name = (index.get(p)?.node ?? api.Get(p, { depth: 0 })).name ?? p, screen = screenOf(p); // instance paths: expanded
      return { id: p, name, screen: screen?.id, label: screen && screen.id !== p ? `"${screen.name ?? screen.id}" › "${name}"` : `"${name}"` };
    } catch { return null; }
  };
  return list.map((c) => ({ id: c.id, from: end(c.source?.path), to: end(c.target?.path), ...(c.context && { context: c.context }) }))
    .filter((c) => c.from && c.to)
    .map((c) => ({ ...c, text: `${c.from.label} (${c.from.id}) → ${c.to.label} (${c.to.id})${c.context ? `: ${c.context}` : ''}` }));
}

// Connections, plus (once there are any) the screens no connection reaches or leaves: what is still unlinked.
function flowSummary(doc, frames) {
  const list = flows(doc);
  if (!list.length) return {};
  const linked = new Set(list.flatMap((c) => [c.from.screen, c.to.screen]));
  const unlinked = frames.filter((f) => f.type === 'frame' && !f.reusable && !linked.has(f.id)).map((f) => `"${f.name ?? f.id}" (${f.id})`);
  return { connections: list.map((c) => c.text), ...(unlinked.length && { unlinked }) };
}

// get_app_state's summary text
export function appState(docJson, libJson, file, stateJson) {
  const doc = docOf(docJson, libJson);
  const state = parse(stateJson) ?? {}, rects = state.rects ?? {};
  const frames = doc.children.filter((n) => !core.isConnection(n)).map((n) => ({ id: n.id, type: n.type, name: n.name, x: n.x, y: n.y, width: n.width, height: n.height, ...(n.reusable && { reusable: true }), ...(n.placeholder && { placeholder: true }), ...(rects[n.id] && { rendered: { width: rects[n.id].w, height: rects[n.id].h } }) }));
  const summary = {
    file,
    selection: state.selection ?? [],
    themes: doc.themes ?? {},
    variables: Object.keys(doc.variables ?? {}).length,
    topLevel: frames,
    ...flowSummary(doc, frames), // prototype links between layers
  };
  return stringify(summary, null, 1);
}

// get_node's texts; the host adds the screenshots. { texts, flow?, screens: [{ id, name }] }
export function getNode(docJson, libJson, id, file) {
  const doc = docOf(docJson, libJson), api = core.createApi(doc);
  // Variables stay as "$name" (design tokens for the code); their values, per theme, are listed below the tree.
  const node = api.Get(id, { resolveInstances: true, includePathGeometry: true });
  const { variables = {}, themes } = api.GetVariables();
  const used = Object.fromEntries([...new Set(stringify(node).match(/(?<=")\$[^"]+(?=")/g) ?? [])]
    .map((v) => [v.slice(1), variables[v.slice(1)]]).filter(([, def]) => def));
  // The resolved tree hides component boundaries; list the instances (from the raw tree) so code can reuse them.
  const uses = new Map();
  api.Get(id, (n) => (n.type === 'ref' ? n : undefined)).forEach((n) => uses.set(n.ref, [...(uses.get(n.ref) ?? []), n]));
  const comps = [...uses].map(([ref, insts]) => {
    let name = '?';
    try { name = api.Get(ref).name; } catch {}
    const list = insts.map((i) => `${i.id}${i.descendants ? ` (overrides: ${Object.entries(i.descendants).map(([k, v]) => (v.enabled === false ? `${k} hidden` : k)).join(', ')})` : ''}`);
    return `- "${name}" pena://node/${encodeURIComponent(ref)}?file=${encodeURIComponent(file)}: ${insts.length}× ${list.join('; ')}`;
  });
  const texts = [`${file}\n${stringify(node, null, 1)}`];
  if (Object.keys(used).length) texts.push(`Variables used (${themes ? `themes: ${stringify(themes)}` : 'no themes'}):\n${stringify(used, null, 1)}`);
  if (comps.length) texts.push(`Component instances in this node (ids match the tree above; read a component with get_node):\n${comps.join('\n')}`);
  const flow = core.flowOf(doc, id);
  if (!flow.connections.length) return stringify({ texts, screens: [] });
  const link = (nid) => `pena://node/${encodeURIComponent(nid)}?file=${encodeURIComponent(file)}`;
  return stringify({
    texts,
    flow:
      'Prototype flow: the user linked these layers on the canvas (source → target). Implement every link as the interaction it ' +
      'describes: the source triggers the target (a button opens the modal, a tab switches the content, a link goes to the next ' +
      'step). Each interaction reads "<trigger> [condition] → <type>" where type is navegar (new route), overlay (on top of the source, ' +
      'which stays), estado (same screen changes in place) or voltar (back/close); read guide/code.md in read_skill for how to build each. ' +
      'A target that is a variant of the same screen (modal open, item selected, empty/error state) is a state of the same ' +
      'code, not a new page. Read each linked screen with get_node for its exact values.\n' +
      flows(doc, flow.connections).map((c) => `- ${c.text}\n  target: ${link(c.to.id)}`).join('\n'),
    screens: flow.screens.filter((s) => s !== id).map((s) => ({ id: s, name: api.Get(s).name ?? s })),
  });
}
