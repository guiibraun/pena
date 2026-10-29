// Drag benchmark: grabs a screen by its label on a fresh page and drags it, in the overview (fit) and at 50% zoom.
// Frame intervals and whether the screen moved. usage: [LINKS_HIDDEN=1] bun scripts/bench-drag.mjs <pena-url> <pristine.pen>
import fs from 'node:fs';
import * as pw from 'playwright-core';
const [url, pristine] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.copyFileSync(pristine, (await (await fetch(`${url}/api/current`)).json()).file); await sleep(2500);
const b = await pw.webkit.launch({ headless: false });
const page = await b.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
if (process.env.LINKS_HIDDEN) await page.addInitScript(() => localStorage.setItem('pena.linksHidden', '1'));
const ev = (f, a) => page.evaluate(f, a);
await page.goto(url);
await page.waitForFunction(() => performance.getEntriesByName('pena:load-end').length, null, { timeout: 60000 });
await sleep(5000);
const id = await ev(() => { const s = __pena.expanded().filter((n) => n.type === 'frame' && n.children?.length).map((n) => [n.id, JSON.stringify(n).length]).sort((a, b) => a[1] - b[1]); return s[s.length >> 1][0]; });
const out = {};
for (const [tag, place] of [['overview', () => ev(() => { __pena.select(null); __pena.fit(); })], ['work', () => ev((id) => { const b = __pena.scene().bounds(id), z = 0.5; __pena.select(null); __pena.setCam({ x: innerWidth / 2 - (b.x + b.w / 2) * z, y: innerHeight / 2 - (b.y + b.h / 2) * z, z }); }, id)]]) {
  await place(); await sleep(2500);
  const g = await ev((id) => {
    const b = __pena.scene().bounds(id), c = __pena.getCam(), x = c.x + b.x * c.z, y = c.y + b.y * c.z;
    return [...document.querySelectorAll('.flabel')].map((l) => [l, l.getBoundingClientRect()]).filter(([l, r]) => r.width && document.elementFromPoint(r.left + 4, r.top + r.height / 2) === l).map(([, r]) => [r.left + 4, r.top + r.height / 2]).sort((p, q) => Math.hypot(p[0] - x, p[1] - y) - Math.hypot(q[0] - x, q[1] - y))[0];
  }, id);
  const xs = () => ev(() => __pena.doc().children.map((n) => `${n.id}:${n.x}`));
  const before = await xs();
  await page.mouse.move(...g); await page.mouse.down();
  await ev(() => { window.__rec = []; window.__on = true; let last = performance.now(); const f = (t) => { __rec.push(t - last); last = t; if (__on) requestAnimationFrame(f); }; requestAnimationFrame(f); });
  for (let i = 0; i < 120; i++) { await page.mouse.move(g[0] + i * 2, g[1] + i); await sleep(8); }
  await sleep(200);
  const rec = (await ev(() => ((__on = false), __rec.slice(1)))).sort((a, b) => a - b);
  await page.mouse.up(); await sleep(1500);
  const after = await xs();
  const q = (p) => +rec[Math.min(rec.length - 1, Math.floor(p * rec.length))].toFixed(1);
  out[tag] = { p50: q(0.5), p95: q(0.95), max: q(0.9999), slow: rec.filter((x) => x > 25).length, jank_ms: Math.round(rec.reduce((s, x) => s + Math.max(0, x - 16.7), 0)), moved: after.filter((v, i) => v !== before[i]).length };
}
console.log(JSON.stringify(out));
await b.close();
