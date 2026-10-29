// Interaction benchmark: real mouse/wheel input on a running Pena (`bun start`), in WebKit (the engine of the app's
// WKWebView) or Chromium, driven by Playwright (`playwright-core` plus its browsers, not a dependency of Pena).
// Per gesture: frame intervals (p50/p95/max, frames over 25 ms), main-thread time blocked beyond one frame, and the
// CPU every browser process used. Also what one editor save blocks and how long an agent edit takes to show up.
// usage: bun scripts/bench-ui.mjs <webkit|chromium> <pena-url> [runs] [pristine.pen]
//   pristine.pen: copied over the open document before each run (the run edits it)
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as pw from 'playwright-core';

const [engine = 'webkit', url = 'http://127.0.0.1:4600', runs = 3, pristine] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CPU seconds of every process of this Playwright browser (renderer, GPU, network: they live under its folder)
const cpu = () => execSync('ps -axo time=,command=').toString().split('\n').filter((l) => l.includes(`ms-playwright/${engine}`))
  .reduce((s, l) => { const [m, sec] = l.trim().split(/\s+/)[0].split(':'); return s + Number(m) * 60 + Number(sec); }, 0);
const memMB = () => Math.round(execSync('ps -axo rss=,command=').toString().split('\n').filter((l) => l.includes(`ms-playwright/${engine}`))
  .reduce((s, l) => s + Number(l.trim().split(/\s+/)[0]), 0) / 1024);

const browser = await pw[engine].launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
const ev = (fn, arg) => page.evaluate(fn, arg);
// median of each number across repetitions
const med = (vals) => { const n = vals.filter((v) => typeof v === 'number').sort((a, b) => a - b); return n.length ? n[n.length >> 1] : vals[0]; };
const merge = (objs) => Object.fromEntries(Object.keys(objs[0]).map((k) => [k, typeof objs[0][k] === 'object' && objs[0][k] ? merge(objs.map((o) => o[k])) : med(objs.map((o) => o[k]))]));
// LINKS_HIDDEN=1: start with the screen connections hidden (the ⇧L toggle)
if (process.env.LINKS_HIDDEN) await page.addInitScript(() => localStorage.setItem('pena.linksHidden', '1'));

// frames recorded in the page; jank_ms = time past a 60 fps frame (16.7 ms), summed, so it doesn't depend on the display rate
const recStart = () => ev(() => { window.__rec = []; window.__on = true; let last = performance.now(); const f = (t) => { __rec.push(t - last); last = t; if (__on) requestAnimationFrame(f); }; requestAnimationFrame(f); });
const recStop = async () => {
  const rec = (await ev(() => ((__on = false), __rec.slice(1)))).sort((a, b) => a - b);
  const q = (p) => +rec[Math.min(rec.length - 1, Math.floor(p * rec.length))].toFixed(1);
  return { p50: q(0.5), p95: q(0.95), max: q(0.9999), slow: rec.filter((x) => x > 25).length, jank_ms: Math.round(rec.reduce((s, x) => s + Math.max(0, x - 16.7), 0)) };
};
async function measure(input, n = 150, gap = 8) {
  await recStart();
  const c0 = cpu(), t0 = performance.now();
  for (let i = 0; i < n; i++) { await input(i); await sleep(gap); }
  await sleep(300);
  const wall = (performance.now() - t0) / 1000;
  return { ...(await recStop()), cpu_pct: Math.round((100 * (cpu() - c0)) / wall) };
}

async function run() {
  if (pristine) fs.copyFileSync(pristine, (await (await fetch(`${url}/api/current`)).json()).file), await sleep(2500); // the server watcher (polls every 1 s) picks it up
  await page.goto(url);
  await page.waitForFunction(() => performance.getEntriesByName('pena:load-end').length, null, { timeout: 60000 });
  await sleep(6000); // fonts, images, icons
  const out = { load_ms: await ev(() => Math.round(performance.measure('l', 'pena:load-start', 'pena:load-end').duration)) };
  // working view: a median-size screen centered at 50% zoom, its neighbors around it
  const id = await ev(() => { const s = __pena.expanded().filter((n) => n.type === 'frame' && n.children?.length).map((n) => [n.id, JSON.stringify(n).length]).sort((a, b) => a[1] - b[1]); return s[s.length >> 1][0]; });
  const work = () => ev((id) => { const b = __pena.scene().bounds(id), z = 0.5; __pena.select(null); __pena.setCam({ x: innerWidth / 2 - (b.x + b.w / 2) * z, y: innerHeight / 2 - (b.y + b.h / 2) * z, z }); }, id);
  // middle of the visible canvas (the chat and properties panels cover its sides)
  const [cx, cy] = await ev(() => { const xs = []; for (let x = 0; x < innerWidth; x += 10) if (document.elementFromPoint(x, innerHeight / 2)?.id === 'gl') xs.push(x); return [xs[xs.length >> 1], innerHeight / 2]; });
  for (const [tag, place] of [['work', work], ['overview', () => ev(() => { __pena.select(null); __pena.fit(); })]]) {
    await place(); await sleep(2500);
    await page.mouse.move(cx, cy);
    out[`${tag}_pan`] = await measure(() => page.mouse.wheel(24, 6));
    await place(); await sleep(1500);
    await page.keyboard.down('Control');
    out[`${tag}_zoom`] = await measure((i) => page.mouse.wheel(0, i < 75 ? -4 : 4));
    await page.keyboard.up('Control');
    await place(); await sleep(1500);
    out[`${tag}_hover`] = await measure((i) => page.mouse.move(cx - 400 + (i % 75) * 11, cy - 150 + (i % 75) * 4));
    await place(); await sleep(1500);
    // grab the screen by its name label, like a person would (connection pills can cover its middle)
    const grabs = await ev((id) => {
      const b = __pena.scene().bounds(id), c = __pena.getCam(), x = c.x + b.x * c.z, y = c.y + b.y * c.z;
      return [...document.querySelectorAll('.flabel')].map((l) => [l, l.getBoundingClientRect()]).filter(([l, r]) => r.width && document.elementFromPoint(r.left + 4, r.top + r.height / 2) === l)
        .map(([, r]) => r).sort((p, q) => Math.hypot(p.left - x, p.bottom - y) - Math.hypot(q.left - x, q.bottom - y)).map((r) => [r.left + 4, r.top + r.height / 2]);
    }, id);
    let grab;
    for (const g of grabs.slice(0, 4)) { // a press that didn't select a screen (covered, mid-update) tries the next label
      await page.mouse.move(...g); await page.mouse.down();
      if (await ev(() => !!document.querySelector('.flabel.sel'))) { grab = g; break; }
      await page.mouse.up(); await sleep(300);
    }
    if (!grab) throw new Error(`${tag}: no screen label to drag`);
    const xs = () => ev(() => __pena.doc().children.map((n) => `${n.id}:${n.x}`));
    const before = await xs();
    out[`${tag}_drag`] = await measure((i) => page.mouse.move(grab[0] + i * 2, grab[1] + i));
    await page.mouse.up(); await sleep(1500);
    const after = await xs();
    out[`${tag}_drag`].moved_roots = after.filter((v, i) => v !== before[i]).length; // 0 = the drag missed
  }
  await work(); await sleep(1500);

  // one editor save: what the 300 ms debounce after an edit blocks (5 edits, median)
  const saves = [];
  for (let i = 0; i < 5; i++) {
    await recStart();
    const c0 = cpu();
    await ev(([id, o]) => __pena.commit((api) => api.Update(id, { opacity: o })), [id, 0.9 + i / 100]);
    await sleep(1500);
    saves.push({ ...(await recStop()), cpu_s: +(cpu() - c0).toFixed(2) });
  }
  out.save = merge(saves);

  // agent edit: POST /tool/execute like the MCP does, until the editor's doc has it (5 edits, median)
  const edits = [];
  for (let i = 0; i < 5; i++) {
    const v = `bench-${i}-${Math.round(Math.random() * 1e6)}`;
    await recStart();
    const c1 = cpu(), t = performance.now();
    const seen = ev(async ([id, v]) => { while (__pena.info(id)?.node.name !== v) await new Promise((r) => setTimeout(r, 2)); }, [id, v]);
    const res = await fetch(`${url}/tool/execute`, { method: 'POST', body: JSON.stringify({ input: `Update(${JSON.stringify(id)}, { name: ${JSON.stringify(v)} })` }) });
    const executeMs = performance.now() - t;
    await seen;
    const visibleMs = performance.now() - t;
    await sleep(800);
    edits.push({ ok: res.ok, execute_ms: Math.round(executeMs), visible_ms: Math.round(visibleMs), ...(await recStop()), cpu_s: +(cpu() - c1).toFixed(2) });
  }
  out.agent_edit = merge(edits);
  out.wasm_heap_mb = await ev(async () => Math.round((await import('/skia.js')).CK().HEAPU8.length / 1e6));
  out.js_heap_mb = await ev(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null));
  out.browser_rss_mb = memMB();
  return out;
}

const all = [];
for (let i = 0; i < Number(runs); i++) all.push(await run());
console.log(engine, `runs=${runs}`, JSON.stringify(merge(all), null, 1));
await browser.close();
