// Reference renders for the comparison test (tests/compare.rs): the Bun server's own renderer (headless.mjs: CanvasKit
// running public/scene.js) draws the example frames. Every relative fetch it makes is recorded, so the Rust renderer
// gets byte-identical inputs (fonts, images, icons, shaders) without a server.
//   bun native/render/tests/reference.mjs   (from the repo root; needs `bun install`)
// Writes native/render/target/ref/: <pen>/<id>@<scale>.png, <pen>/doc.json, roots.json, bounds.json, jobs.json, fetch/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const out = path.resolve(here, '../target/ref');
const PORT = 4617;
fs.mkdirSync(path.join(out, 'fetch'), { recursive: true });
const examples = path.join(out, 'examples');
fs.cpSync(path.join(repo, 'examples'), examples, { recursive: true }); // the server reads a copy, never the repo
fs.cpSync(path.join(here, 'fixtures'), examples, { recursive: true }); // features.pen: what the examples don't cover

// a home of its own (fonts.mjs caches under ~/.pena), seeded with the real font cache so it works offline
const realFonts = path.join(process.env.HOME, '.pena', 'fonts'), home = path.join(out, 'home');
if (fs.existsSync(realFonts)) fs.cpSync(realFonts, path.join(home, '.pena', 'fonts'), { recursive: true });
process.env.HOME = home;
const fonts = await import(path.join(repo, 'fonts.mjs'));
const { migrate, expandDoc, isConnection } = await import(path.join(repo, 'public/pen-core.js'));
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glsl': 'text/plain' };
const server = Bun.serve({
  port: PORT, hostname: '127.0.0.1',
  async fetch(req) {
    const url = decodeURIComponent(new URL(req.url).pathname), q = new URL(req.url).searchParams;
    if (url.startsWith('/asset/')) {
      const f = path.resolve(examples, url.slice(7));
      if (!f.startsWith(examples + path.sep) || !fs.existsSync(f)) return new Response(null, { status: 404 });
      return new Response(fs.readFileSync(f), { headers: { 'content-type': MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream' } });
    }
    if (url.startsWith('/icons/')) {
      const f = path.join(repo, 'node_modules', url.slice(7));
      if (!/^[\w@/.-]+\.svg$/.test(url) || url.includes('..') || !fs.existsSync(f)) return new Response(null, { status: 404 });
      const svg = fs.readFileSync(f, 'utf8');
      return new Response(svg.includes('currentColor') ? svg : svg.replace('<svg', '<svg fill="currentColor"'), { headers: { 'content-type': 'image/svg+xml' } });
    }
    if (url === '/fonts/faces') return Response.json(await fonts.faces(q.get('family') ?? ''));
    if (url.startsWith('/fonts/file/')) return new Response(await fonts.file(url.slice(12)), { headers: { 'content-type': 'font/ttf' } });
    return new Response(null, { status: 404 });
  },
});
const base = `http://127.0.0.1:${PORT}`;

// record every fetch to this server: url -> file in fetch/ (null: not found)
const index = {};
let seq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, o) => {
  const s = typeof u === 'string' ? u : u.url, key = s.slice(base.length);
  const fresh = s.startsWith(base) && !(key in index), name = String(seq++);
  if (fresh) index[key] = name; // claimed before awaiting: concurrent fetches must not share a file
  const r = await realFetch(u, o);
  if (fresh) {
    if (r.ok) fs.writeFileSync(path.join(out, 'fetch', name), Buffer.from(await r.clone().arrayBuffer()));
    else index[key] = null;
  }
  return r;
};

const headless = await import(path.join(repo, 'headless.mjs'));
const { Scene } = await import(path.join(repo, 'public/scene.js'));

// frames: every root, plus the image-heavy imported page of shaders.pen (whole at 1/4, and one child per image type)
const jobs = [];
const docs = {};
for (const name of ['welcome', 'demo', 'shaders', 'features']) {
  const doc = migrate(JSON.parse(fs.readFileSync(path.join(examples, `${name}.pen`), 'utf8')));
  docs[name] = doc;
  const roots = expandDoc(doc).filter((n) => !isConnection(n));
  fs.mkdirSync(path.join(out, name), { recursive: true });
  fs.writeFileSync(path.join(out, name, 'doc.json'), JSON.stringify(doc));
  fs.writeFileSync(path.join(out, name, 'roots.json'), JSON.stringify(roots));
  for (const r of roots) {
    if (r.id === '6p8Uk') {
      jobs.push({ pen: name, id: r.id, format: 'png', scale: 0.25 });
      const exts = (n, s = new Set()) => { for (const f of [].concat(n.fill ?? [])) if (f?.type === 'image') s.add(f.url.split('.').pop()); (n.children ?? []).forEach((c) => exts(c, s)); return s; };
      const seen = new Set();
      for (const c of r.children) for (const e of exts(c)) if (!seen.has(e) && c.type === 'frame') { seen.add(e); jobs.push({ pen: name, id: c.id, format: 'png', scale: 1 }); }
    } else if (!r.reusable) jobs.push({ pen: name, id: r.id, format: 'png', scale: 1 });
  }
}
jobs.push({ pen: 'demo', id: 'tmQpG', format: 'png', scale: 2 }, { pen: 'features', id: 'media', format: 'png', scale: 2 }, { pen: 'features', id: 'shapes', format: 'png', scale: 0.5 });
// PNG only: CanvasKit's build has no JPEG/WebP encoder (headless.render fails on them; the server falls back to a browser)
const ids = [...new Set(jobs.map((j) => `${j.pen}/${j.id}`))];
console.log(`${jobs.length} jobs, ${ids.length} frames`);

const run = async (j) => (console.log(j.pen, j.id, j.format, j.scale), await headless.render({ ids: [j.id], format: j.format, options: { scale: j.scale, quality: j.quality ?? 92 } }, docs[j.pen], base))[0];
// first round loads every font (late ones re-lay the scene out), the second is what the editor shows once settled
for (const j of jobs) await run(j);
await new Promise((r) => setTimeout(r, 500));
const results = [];
for (const j of jobs) {
  const r = await run(j);
    fs.writeFileSync(path.join(out, j.pen, `${j.id}@${j.scale}.png`), Buffer.from(r.data.split(',')[1], 'base64'));
  results.push({ ...j, file: `${j.pen}/${j.id}@${j.scale}.png`, warnings: r.warnings });
}
fs.writeFileSync(path.join(out, 'jobs.json'), JSON.stringify(results, null, 1));

// laid-out world bounds of every node, with the same fonts loaded
for (const name of Object.keys(docs)) {
  const scene = new Scene(docs[name], { assetUrl: (u) => `/asset/${u.replace(/^\.\//, '')}` });
  scene.build(expandDoc(docs[name]).filter((n) => !isConnection(n)), { layout: false });
  scene.relayoutAll();
  const bounds = {};
  for (const [id, n] of scene.byId) { const b = n.bounds(); bounds[id] = [b.x, b.y, b.w, b.h]; }
  fs.writeFileSync(path.join(out, name, 'bounds.json'), JSON.stringify(bounds));
}
fs.writeFileSync(path.join(out, 'fetch', 'index.json'), JSON.stringify(index, null, 1));
server.stop(true);
console.log('done', Object.keys(index).length, 'fetches');
process.exit(0);
