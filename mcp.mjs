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

// Which window serves this call: the one with the file it targets (PENA_FILE, or a get_node link), else the
// last focused window that has a file open. PENA_URL (Pena's own agents) always wins.
async function target(name, args) {
  if (process.env.PENA_URL) return process.env.PENA_URL;
  const link = name === 'get_node' && URL.parse(args?.link?.trim() ?? '')?.searchParams.get('file');
  const want = link ? path.resolve(link) : name !== 'get_node' && fixedFile ? path.resolve(fixedFile) : null;
  const open = (await servers()).filter((s) => s.file);
  if (want) return open.find((s) => s.file === want)?.url;
  if (name === 'get_node') return null; // malformed link: let the tool explain
  return open.sort((a, b) => (b.focusedAt ?? 0) - (a.focusedAt ?? 0))[0]?.url;
}

async function call(name, args) {
  const url = await target(name, args);
  if (url) {
    try {
      // who is calling: Pena's own agents get a name in PENA_AGENT; external clients are named after themselves
      const agent = process.env.PENA_AGENT ?? server.server.getClientVersion()?.name ?? 'agente externo';
      const res = await fetch(`${url}/tool/${name}`, { method: 'POST', body: JSON.stringify({ ...args, _agent: agent }) });
      if (res.status !== 409) return await res.json();
    } catch {} // app not reachable: fall through to the file
  }
  if (!fixedFile && name !== 'get_node') return { content: [{ type: 'text', text: 'Open a file in the Pena app (npm run app), or set PENA_FILE to a .pen file.' }], isError: true };
  return callTool(createTools({ file: fixedFile && path.resolve(fixedFile) }), name, args);
}

const server = new McpServer({ name: 'pena', version: '0.3.0' });
for (const [name, schema] of Object.entries(schemas)) server.registerTool(name, schema, (args) => call(name, args));
await server.connect(new StdioServerTransport());
