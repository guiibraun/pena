// Remote MCP (/mcp): off without PENA_TOKEN, refuses a wrong token, and with the right one the tools edit the open
// document. Runs the real server in a throwaway HOME so it never touches the real configs.
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-mcp-http-'));
const file = path.join(home, 'test.pen');

async function serve(port, env = {}) {
  const p = spawn(process.execPath, ['server.mjs', file], { env: { ...process.env, HOME: home, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((ok) => p.stdout.on('data', (d) => String(d).includes('Pena →') && ok()));
  return p;
}
const connect = (url, token) => {
  const client = new Client({ name: 'test', version: '1' });
  return client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } })).then(() => client);
};

let p = await serve(4591);
try {
  assert.equal((await fetch('http://127.0.0.1:4591/mcp', { method: 'POST' })).status, 404, 'no PENA_TOKEN: no remote MCP');
} finally { p.kill(); }

p = await serve(4592, { PENA_TOKEN: 'secret' });
try {
  const url = 'http://127.0.0.1:4592/mcp';
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  await assert.rejects(connect(url, 'wrong'));

  const client = await connect(url, 'secret');
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes('execute') && names.includes('get_app_state'), names.join());
  const r = await client.callTool({ name: 'execute', arguments: { input: 'Insert(document, { type: "frame", name: "Remote", width: 100, height: 100 })' } });
  assert.ok(!r.isError, JSON.stringify(r.content));
  const state = await client.callTool({ name: 'get_app_state', arguments: {} });
  assert.ok(JSON.stringify(state.content).includes('Remote'), 'the insert reached the open document');

  // filePath switches the open document; a new path creates the file
  const other = path.join(home, 'other.pen');
  assert.ok(!(await client.callTool({ name: 'execute', arguments: { filePath: other, input: 'Insert(document, { type: "frame", name: "Other", width: 10, height: 10 })' } })).isError);
  const now = JSON.stringify((await client.callTool({ name: 'get_app_state', arguments: {} })).content);
  assert.ok(now.includes('other.pen') && now.includes('Other') && !now.includes('Remote'), now);
  assert.ok((await client.callTool({ name: 'get_app_state', arguments: { filePath: path.join(home, 'x.txt') } })).isError, 'only .pen files');
  await client.close();

  // icons come from the local packages; Material Symbols get currentColor; nothing else under /icons/ is served
  const icon = (p) => fetch(`http://127.0.0.1:4592/icons/${p}`);
  assert.ok((await (await icon('lucide-static/icons/check.svg')).text()).includes('currentColor'));
  assert.ok((await (await icon('@material-symbols/svg-400/rounded/home.svg')).text()).includes('fill="currentColor"'));
  assert.equal((await icon('lucide-static/icons/nope-xyz.svg')).status, 404);
  assert.equal((await icon('lucide-static/package.json')).status, 404);
  assert.equal((await icon('lucide-static/icons/..%2F..%2F..%2Fpackage.json')).status, 404);
} finally { p.kill(); }
fs.rmSync(home, { recursive: true, force: true });
console.log('mcp-http ok');
