// Minimal ACP client (Agent Client Protocol, agentclientprotocol.com): JSON-RPC lines over a child's stdio, the same
// transport T3 Code uses for its Antigravity provider. `onRequest` answers the agent's own requests (permissions);
// `onNotify` receives its notifications (session/update).
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export function openAcp(cmd, args, { cwd, env, signal, onRequest, onNotify }) {
  const child = spawn(cmd, args, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
  const waits = new Map();
  let next = 0, stderr = '', closed;
  const write = (msg) => child.stdin.writable && child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const end = (e) => { closed ??= e; for (const w of waits.values()) w.reject(e); waits.clear(); };
  child.stdin.on('error', () => {}); // the agent died while we were writing: `close` reports it
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  child.on('error', end);
  child.on('close', (code) => end(new Error(stderr.trim().split('\n').pop() || `${cmd} saiu com código ${code}`)));
  readline.createInterface({ input: child.stdout }).on('line', async (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.method && m.id != null) {
      try { write({ id: m.id, result: await onRequest(m.method, m.params) }); }
      catch (e) { write({ id: m.id, error: { code: -32601, message: String(e.message ?? e) } }); }
    } else if (m.method) onNotify?.(m.method, m.params);
    else if (waits.has(m.id)) {
      const w = waits.get(m.id);
      waits.delete(m.id);
      m.error ? w.reject(Object.assign(new Error(m.error.message ?? 'ACP error'), { code: m.error.code })) : w.resolve(m.result);
    }
  });
  return {
    request: (method, params) => (closed ? Promise.reject(closed) : new Promise((resolve, reject) => { const id = ++next; waits.set(id, { resolve, reject }); write({ id, method, params }); })),
    close: () => child.kill(),
  };
}
