// Integrations: a client left pointing at a binary that no longer exists (the app moved or was updated) starts its
// sessions with no design tools, silently. repairIntegrations() re-points it at this build and leaves valid ones alone.
// Runs in a throwaway HOME so it never touches the real configs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-integrations-'));
const script = `
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { integrations, repairIntegrations, setIntegration } from './settings.mjs';

const cfg = path.join(process.env.HOME, '.config', 'opencode', 'opencode.json');
const entry = () => integrations().find((c) => c.id === 'opencode');
fs.mkdirSync(path.dirname(cfg), { recursive: true });
fs.writeFileSync(cfg, JSON.stringify({ mcp: { servers: { pena: { type: 'local', command: ['/nope/pena-server', 'mcp'] } } } }));

assert.equal(entry().registered, true);
assert.deepEqual(await repairIntegrations(), ['OpenCode']);
assert.equal(entry().current, true, 'the entry points at this build now');
assert.deepEqual(await repairIntegrations(), [], 'a working entry is left alone');

// another client's servers and settings survive the rewrite
const data = JSON.parse(fs.readFileSync(cfg, 'utf8'));
assert.deepEqual(Object.keys(data.mcp.servers), ['pena']);

// Antigravity (CLI) keeps its MCP servers in a JSON file other servers share: add and remove only ours
const agy = path.join(process.env.HOME, '.gemini', 'config', 'mcp_config.json');
const names = () => Object.keys(JSON.parse(fs.readFileSync(agy, 'utf8')).mcpServers);
fs.mkdirSync(path.dirname(agy), { recursive: true });
fs.writeFileSync(agy, JSON.stringify({ mcpServers: { lerd: { command: 'lerd', args: ['mcp'] } } }));
assert.equal(integrations().find((c) => c.id === 'agy').present, true);
await setIntegration('agy', true);
assert.deepEqual(names(), ['lerd', 'pena']);
await setIntegration('agy', false);
assert.deepEqual(names(), ['lerd']);
`;
try {
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('ok    integrations');
