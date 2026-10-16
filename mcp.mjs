#!/usr/bin/env node
// stdio MCP server for agents: the embedded Claude/Codex, or an external Claude Code / Codex / Cursor.
// It talks to the running Pena app when there is one (found via PENA_URL or ~/.pena/server.json, like pen.dev's
// socket): edits are serialized in the app, show up live, and TakeScreenshot/Export render in the editor.
// Without the app it edits PENA_FILE directly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { schemas, createTools, callTool } from './tools.mjs';

const fixedFile = process.env.PENA_FILE ?? process.argv[2];
const appUrl = () => {
  if (process.env.PENA_URL) return process.env.PENA_URL;
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.pena', 'server.json'), 'utf8')).url;
  } catch {
    return null;
  }
};

async function call(name, args) {
  const url = appUrl();
  if (url) {
    try {
      // An external agent pinned to a file only goes through the app if that file is the one open there.
      const open = fixedFile && !process.env.PENA_URL ? (await (await fetch(`${url}/api/current`)).json()).file : null;
      if (!fixedFile || process.env.PENA_URL || (open && path.resolve(fixedFile) === open)) {
        // who is calling: Pena's own agents get a name in PENA_AGENT; external clients are named after themselves
        const agent = process.env.PENA_AGENT ?? server.server.getClientVersion()?.name ?? 'agente externo';
        const res = await fetch(`${url}/tool/${name}`, { method: 'POST', body: JSON.stringify({ ...args, _agent: agent }) });
        if (res.status !== 409) return await res.json();
      }
    } catch {} // app not reachable: fall through to the file
  }
  if (!fixedFile) return { content: [{ type: 'text', text: 'Open a file in the Pena app (npm run app), or set PENA_FILE to a .pen file.' }], isError: true };
  return callTool(createTools({ file: path.resolve(fixedFile) }), name, args);
}

const server = new McpServer({ name: 'pena', version: '0.3.0' });
for (const [name, schema] of Object.entries(schemas)) server.registerTool(name, schema, (args) => call(name, args));
await server.connect(new StdioServerTransport());
