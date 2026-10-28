#!/usr/bin/env node
// stdio MCP server for agents: the embedded Claude/Codex, or an external Claude Code / Codex / Cursor.
// It talks to the running Pena app when there is one (PENA_URL, or the servers listed in ~/.pena/servers, one per
// window, like pen.dev's socket): edits are serialized in the app, show up live, and TakeScreenshot/Export render
// in the editor. Without the app it edits PENA_FILE directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas, createTools, callTool } from './tools.mjs';

const fixedFile = process.env.PENA_FILE ?? process.argv[2];
const SERVERS = path.join(os.homedir(), '.pena', 'servers');

// Running Pena servers (one per window) with the file each has open and when its window last had focus.
async function servers() {
  const out = [];
  for (const f of fs.existsSync(SERVERS) ? fs.readdirSync(SERVERS) : []) {
    try {
      const { url, pid } = JSON.parse(fs.readFileSync(path.join(SERVERS, f), 'utf8'));
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') fs.rmSync(path.join(SERVERS, f), { force: true }); continue; } // crashed: stale entry
      out.push({ url, ...(await (await fetch(`${url}/api/current`, { signal: AbortSignal.timeout(2000) })).json()) });
    } catch {}
  }
  return out;
}

// Which tab serves this call: the one with the file it targets (filePath, PENA_FILE, or a get_node link), else
// the last focused tab that has a file open. PENA_URL (Pena's own agents) always wins.
function target(name, args, open) {
  if (process.env.PENA_URL) return process.env.PENA_URL;
  const want = wanted(name, args);
  if (want) return open.find((s) => s.file === want)?.url;
  if (name === 'get_node') return null; // malformed link: let the tool explain
  return open.sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0))[0]?.url;
}

function wanted(name, args) {
  if (name === 'get_node') { const link = URL.parse(args?.link?.trim() ?? '')?.searchParams.get('file'); return link && path.resolve(link); }
  const f = args?.filePath || fixedFile;
  return f ? path.resolve(f) : null;
}

async function call(name, args) {
  const open = process.env.PENA_URL ? [] : (await servers()).filter((s) => s.file);
  const url = target(name, args, open);
  const result = (url && (await viaApp(url, name, args))) || (await direct(name, args));
  // external agents can pick another tab with filePath: tell them which ones there are
  if (name === 'get_app_state' && open.length > 1) result.content?.push({ type: 'text', text: `Files open in Pena tabs (pass one as filePath to target it):\n${open.map((s) => s.file).join('\n')}` });
  return result;
}

async function viaApp(url, name, args) {
  try {
    // who is calling: Pena's own agents get a name in PENA_AGENT; external clients are named after themselves
    const agent = process.env.PENA_AGENT ?? server.server.getClientVersion()?.name ?? 'agente externo';
    const res = await fetch(`${url}/tool/${name}`, { method: 'POST', body: JSON.stringify({ ...args, _agent: agent, ...(process.env.PENA_CONV && { _conv: process.env.PENA_CONV }), ...(process.env.PENA_FILE && { _file: process.env.PENA_FILE }) }) });
    if (res.status !== 409) return await res.json();
  } catch {} // app not reachable: fall through to the file
}

// No tab has the file: edit it on disk (filePath or PENA_FILE).
function direct(name, args) {
  const file = name === 'get_node' ? fixedFile && path.resolve(fixedFile) : wanted(name, args);
  if (!file && name !== 'get_node') return { content: [{ type: 'text', text: 'Open a file in the Pena app (npm run app), or set PENA_FILE to a .pen file.' }], isError: true };
  return callTool(createTools({ file }), name, args);
}

const server = new McpServer({ name: 'pena', version: '0.3.0' });
for (const [name, schema] of Object.entries(schemas)) server.registerTool(name, schema, (args) => call(name, args));
await server.connect(new StdioServerTransport());
