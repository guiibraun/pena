// Performance benchmark: drives a running Pena (Electron started with --remote-debugging-port) through CDP.
// usage: node scripts/bench.mjs <cdp-port> [label]
const [port = 9340, label = ''] = process.argv.slice(2);
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.result.value;
await send('Page.bringToFront'); await send('Performance.enable');

// 1. cold load: reload the page, wait for the first render
await ev(`location.reload()`);
await new Promise((r) => setTimeout(r, 300));
for (let i = 0; i < 200 && !(await ev(`!!performance.getEntriesByName('pena:load-end').length`).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 1500));
const out = {};
out.load_ms = await ev(`Math.round(performance.measure('l','pena:load-start','pena:load-end').duration)`);
out.first_paint_ms = await ev(`performance.getEntriesByName('pena:first-paint').length ? Math.round(performance.measure('f','pena:load-start','pena:first-paint').duration) : null`);

const time = async (name, js, reps = 3) => {
  const ts = [];
  for (let i = 0; i < reps; i++) ts.push(await ev(`(async () => { const t = performance.now(); ${js}; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return performance.now() - t; })()`));
  out[name] = Math.round(ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)]);
};
await time('render_ms', `__pena.render()`);
// pick a text node inside the largest root frame for selection/edit tests
await ev(`window.__t = (() => { for (const n of __pena.expanded()) { const st=[...(n.children??[])]; while (st.length) { const c = st.shift(); if (c.type === 'text' && !c.id.includes('/')) return c.id; st.push(...(c.children??[])); } } })(); window.__root = __pena.expanded()[0].id; 1`);
await time('select_ms', `__pena.select(__t)`);
await time('select_root_ms', `__pena.select(__root)`);
// edits: move a plain frame, change a property of a child, edit a component used across the file
await ev(`window.__plain = __pena.expanded().find((n) => !n.reusable && !n._ref && (n.children?.length ?? 0) > 3).id;
  window.__child = __pena.info(__plain).node.children[1].id;
  window.__comp = (() => { const counts = {}; for (const [, { node }] of [...document.querySelectorAll('[data-instance]')].map((e) => [0, { node: { _ref: e.dataset.instance } }])) counts[node._ref] = (counts[node._ref] ?? 0) + 1; return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]; })(); 1`);
await time('edit_move_frame_ms', `await __pena.commit((api) => api.Update(__plain, { x: (__pena.info(__plain).node.x ?? 0) + 1 }))`);
await time('edit_child_prop_ms', `await __pena.commit((api) => api.Update(__child, { opacity: Math.random() * 0.5 + 0.5 }))`);
await time('edit_component_ms', `await __pena.commit((api) => api.Update(__comp, { opacity: Math.random() * 0.5 + 0.5 }))`);
out.component_instances = await ev(`document.querySelectorAll('[data-instance="' + __comp + '"]').length`);
await time('pan_frame_ms', `__pena.setCam({ ...__pena.getCam(), x: __pena.getCam().x + 37 })`, 9);
await time('zoom_frame_ms', `__pena.setCam({ ...__pena.getCam(), z: __pena.getCam().z * 1.07 })`, 9);
await time('hover_ms', `document.querySelector('#canvas').dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 900, clientY: 500 }))`, 5);
const m = Object.fromEntries((await send('Performance.getMetrics')).result.metrics.map((x) => [x.name, x.value]));
out.dom_nodes = m.Nodes; out.js_heap_mb = Math.round(m.JSHeapUsedSize / 1e6); out.layout_count = m.LayoutCount;
console.log(label, JSON.stringify(out));
ws.close();
