// Data-path benchmark: what saving, an agent edit and the editor's reload cost today on a real .pen, next to the
// cheaper path each fix would take. Bun runs JavaScriptCore, the engine inside the app's WKWebView.
// usage: bun scripts/bench-data.mjs <file.pen> [runs]   (writes only <file.pen>.bench, next to it)
import fs from 'node:fs';
import vm from 'node:vm';
import { load, save } from '../doc.mjs';
import { createApi, migrate } from '../public/pen-core.js';

const [file, runs = 15] = process.argv.slice(2);
const out = file + '.bench';
const median = (a) => a.sort((x, y) => x - y)[a.length >> 1];
const time = (fn, n = Number(runs)) => { fn(); const t = []; for (let i = 0; i < n; i++) { const s = performance.now(); fn(); t.push(performance.now() - s); } return +median(t).toFixed(1); };
const MB = (n) => +(n / 1e6).toFixed(1);

// the editor's own helpers (public/editor.js:62,177)
const metaOf = (d) => JSON.stringify([d.variables, d.themes, d.fonts, d.imports]);
const snapshot = (d) => ({ roots: new Map(d.children.map((c) => [c.id, JSON.stringify(c)])), meta: metaOf(d), order: d.children.map((c) => c.id).join() });

const doc = load(file);
const text = fs.readFileSync(file, 'utf8');
// screens (frames with content) are what people and agents edit; the many tiny connection roots would skew the median
const screens = doc.children.filter((c) => c.type === 'frame' && c.children?.length);
const sizes = screens.map((c) => JSON.stringify(c).length).sort((a, b) => a - b);
const pick = (q) => screens.find((c) => JSON.stringify(c).length === sizes[Math.floor(q * (sizes.length - 1))]);
const typical = pick(0.5), big = pick(1);
const r = {
  file_mb: MB(text.length), compact_mb: MB(JSON.stringify(doc).length), roots: doc.children.length, screens: screens.length,
  root_kb_median: Math.round(sizes[sizes.length >> 1] / 1e3), root_kb_max: Math.round(sizes.at(-1) / 1e3),
};

// --- 1. editor save (public/editor.js:193-200): snapshot every root + changesSince + pretty body, on the UI thread
let base = snapshot(doc);
r.save_ui_now_ms = time(() => { const s = snapshot(doc); [...s.roots.keys()].filter((id) => s.roots.get(id) !== base.roots.get(id)); JSON.stringify(doc, null, 2); });
// fix: commit() already knows the dirty roots, so only those are serialized
r.save_ui_fix_ms = time(() => JSON.stringify({ roots: [typical], order: doc.children.map((c) => c.id) }));
r.save_ui_fix_big_root_ms = time(() => JSON.stringify({ roots: [big], order: doc.children.map((c) => c.id) }));
r.save_body_now_mb = MB(JSON.stringify(doc, null, 2).length);
r.save_body_fix_kb = Math.round(JSON.stringify({ roots: [typical] }).length / 1e3);

// --- 2. server side of a save (server.mjs:899-907): parse the whole body, write the whole file
const body = JSON.stringify(doc, null, 2);
r.save_server_now_ms = time(() => { JSON.parse(body); fs.writeFileSync(out, body); });
// fix: swap the root in the in-memory doc now, write compact JSON later (debounced, off the edit path)
const live = structuredClone(doc), patchBody = JSON.stringify({ roots: [typical] });
r.save_server_fix_ms = time(() => { const [n] = JSON.parse(patchBody).roots; live.children[live.children.findIndex((c) => c.id === n.id)] = n; });
r.write_compact_ms = time(() => fs.writeFileSync(out, JSON.stringify(live)));
r.write_pretty_ms = time(() => fs.writeFileSync(out, JSON.stringify(live, null, 2)));

// --- 3. agent execute (doc.mjs:44-76): load + new vm context + save the whole file, per call
const snippet = `Update(${JSON.stringify(typical.id)}, { opacity: 0.9 })`;
fs.writeFileSync(out, text);
r.agent_execute_now_ms = time(() => {
  const d = load(out);
  vm.runInNewContext(`(() => {\n${snippet}\n})()`, createApi(d, []), { timeout: 5000 });
  save(out, d);
});
// fix: run against the server's in-memory doc; keep the touched root so a throwing snippet can roll back
const ctxApi = createApi(live, []), ctx = vm.createContext(ctxApi);
r.agent_execute_fix_ms = time(() => {
  const i = live.children.findIndex((c) => c.id === typical.id), keep = structuredClone(live.children[i]);
  vm.runInContext(`(() => {\n${snippet}\n})()`, ctx, { timeout: 5000 });
  JSON.stringify(live.children[i]); // the patch sent to the editor
  void keep;
});
r.vm_new_context_ms = time(() => vm.runInNewContext('1', createApi(live, [])));

// --- 4. editor reload after an agent write (public/editor.js:2071-2114): download, parse, snapshot, diff
const docNow = structuredClone(doc);
r.reload_ui_now_ms = time(() => {
  const next = migrate(JSON.parse(text));
  snapshot(next); // base = snapshot(next)
  const now = new Map(docNow.children.map((c) => [c.id, JSON.stringify(c)]));
  for (const c of next.children) if (now.get(c.id) !== JSON.stringify(c)) void 0;
  for (const c of next.children) JSON.stringify(c).includes('"type":"shader"');
  metaOf(next) !== metaOf(docNow);
});
// fix: the SSE event carries the touched root; parse it and swap it in
const patchMsg = JSON.stringify({ roots: [typical] });
r.reload_ui_fix_ms = time(() => { const [n] = JSON.parse(patchMsg).roots; docNow.children[docNow.children.findIndex((c) => c.id === n.id)] = n; });
r.reload_transfer_now_mb = r.file_mb;
r.watch_latency_now_ms = '0-250 (fs.watchFile interval: 250, server.mjs:1089)';

// --- 5. memory the editor keeps alive besides the doc itself
r.base_snapshot_mb = MB([...base.roots.values()].reduce((s, v) => s + v.length, 0)); // `base`, held forever
r.undo_entry_kb_typical = Math.round(sizes[sizes.length >> 1] / 1e3); // one stringified root per edit, up to 300
r.undo_300_typical_mb = MB(sizes[sizes.length >> 1] * 300);
r.undo_300_big_mb = MB(sizes.at(-1) * 300);

fs.rmSync(out, { force: true });
console.log(JSON.stringify(r, null, 1));
