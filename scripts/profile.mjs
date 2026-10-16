// CPU profile of one JS expression in the running editor; prints the hottest functions (self time).
// usage: node scripts/profile.mjs <cdp-port> "<expression>"
const [port, expr] = process.argv.slice(2);
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 100 }); await send('Profiler.start');
await send('Runtime.evaluate', { expression: expr, awaitPromise: true });
const { profile } = (await send('Profiler.stop')).result;
const self = new Map(), byId = new Map(profile.nodes.map((n) => [n.id, n]));
const dt = profile.timeDeltas; profile.samples.forEach((s, i) => { const n = byId.get(s); const f = n.callFrame; const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0)); });
console.log([...self].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, us]) => `${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`).join('\n'));
// callers of the hottest native function (who forced layout)
const parentOf = new Map(); for (const n of profile.nodes) for (const c of n.children ?? []) parentOf.set(c, n.id);
const callers = new Map();
profile.samples.forEach((s, i) => { const n = byId.get(s); if (n.callFrame.functionName !== 'getBoundingClientRect') return; let chain = [], p = parentOf.get(s); while (p && chain.length < 4) { const f = byId.get(p).callFrame; chain.push(`${f.functionName || '(anon)'}:${f.lineNumber + 1}`); p = parentOf.get(p); } const k = chain.join(' < '); callers.set(k, (callers.get(k) ?? 0) + (dt[i] ?? 0)); });
if (callers.size) console.log('\ngetBoundingClientRect callers:\n' + [...callers].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, us]) => `${(us / 1000).toFixed(1).padStart(7)} ms  ${k}`).join('\n'));
ws.close();
