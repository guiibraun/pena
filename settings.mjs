// Settings backend (pen.dev's Settings › Agents and Settings › MCP, observed with REA):
//  - provider status from the CLIs' own login stores (free), plus an on-demand live probe (one tiny request)
//  - registering Pena's MCP server in external agents (Claude Code, Codex, Gemini, Cursor, ...)
//  - extra MCP servers that Pena's own agents may use (~/.pena/mcp.json)
// The CLIs are the ones you installed (`claude`, `codex`, `opencode`), not copies shipped with the app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ROOT, COMPILED } from './root.mjs';

const HOME = os.homedir();
// An app opened from Finder doesn't get the shell PATH: add the usual install dirs, and ask the login shell
// only when a CLI isn't there. The agents' own children (MCP servers via npx, ...) get the same PATH.
const WIN = process.platform === 'win32';
const isExe = (f) => { try { return fs.statSync(f).isFile() && (fs.accessSync(f, fs.constants.X_OK), true); } catch { return false; } };
const dirs = (p) => (p ?? '').split(path.delimiter).filter(Boolean);
const extra = WIN ? [path.join(HOME, '.local', 'bin'), path.join(HOME, '.opencode', 'bin'), process.env.APPDATA && path.join(process.env.APPDATA, 'npm')] : [path.join(HOME, '.local', 'bin'), path.join(HOME, '.claude', 'local'), path.join(HOME, '.opencode', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
process.env.PATH = [...new Set([...dirs(process.env.PATH), ...extra.filter(Boolean)])].join(path.delimiter);
// Windows: npm installs CLIs as .cmd shims, which the SDKs can't spawn without a shell: use the .exe the package ships.
const shimExe = (shim, name) => {
  try { return fs.readdirSync(path.join(path.dirname(shim), 'node_modules'), { recursive: true }).map((f) => path.join(path.dirname(shim), 'node_modules', f)).find((f) => path.basename(f).toLowerCase() === `${name}.exe` && isExe(f)) ?? shim; } catch { return shim; }
};
const find = (name) => {
  const exts = WIN ? ['.exe', '.cmd', ''] : [''];
  const hit = exts.flatMap((x) => dirs(process.env.PATH).map((d) => path.join(d, name + x))).find(isExe);
  return hit && WIN && /\.cmd$/i.test(hit) ? shimExe(hit, name) : hit;
};
if (!WIN && (!find('claude') || !find('codex'))) {
  try {
    const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-lic', 'printf "\n%s" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').pop();
    process.env.PATH = [...new Set([...dirs(process.env.PATH), ...dirs(shellPath)])].join(path.delimiter);
  } catch {}
}
// Not installed: keep the bare name, so the status shows "not installed" instead of crashing.
export const CLAUDE_BIN = find('claude') ?? 'claude';
export const CODEX_BIN = find('codex') ?? 'codex';
export const OPENCODE_BIN = find('opencode') ?? 'opencode';
export const CODEX_HOME = process.env.CODEX_HOME ?? path.join(HOME, '.codex');

const run = (bin, args, timeout = 20000, opts = {}) =>
  new Promise((resolve) => execFile(bin, args, { timeout, windowsHide: true, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}`.trim(), err: `${stderr || err?.message || ''}`.trim() })).stdin?.end()); // `opencode run` waits for stdin to close

// Codex loads every MCP server from ~/.codex/config.toml; Pena turns them off for its own sessions.
export const globalCodexServers = () => {
  const toml = path.join(CODEX_HOME, 'config.toml');
  if (!fs.existsSync(toml)) return [];
  return [...fs.readFileSync(toml, 'utf8').matchAll(/^\[mcp_servers\.(?:"([^"]+)"|([^.\]\s]+))\]\s*$/gm)].map((m) => m[1] ?? m[2]);
};

// OpenCode loads the MCP servers of ~/.config/opencode/opencode.json(c) too (under mcp.servers); same treatment.
const stripJsonc = (t) => t.replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? '').replace(/,(\s*[}\]])/g, '$1');
export const globalOpencodeServers = () =>
  ['opencode.json', 'opencode.jsonc'].flatMap((f) => { try { return Object.keys(JSON.parse(stripJsonc(fs.readFileSync(path.join(HOME, '.config', 'opencode', f), 'utf8'))).mcp?.servers ?? {}); } catch { return []; } });

// ---------------------------------------------------------------- providers
export async function providerStatus() {
  const [cv, cs, xv, xs, ov, os_] = await Promise.all([run(CLAUDE_BIN, ['--version']), run(CLAUDE_BIN, ['auth', 'status']), run(CODEX_BIN, ['--version']), run(CODEX_BIN, ['login', 'status']), run(OPENCODE_BIN, ['--version']), run(OPENCODE_BIN, ['auth', 'list'])]);
  // `opencode auth list` prints one "Name  Account  status" line per credential, columns padded with spaces
  const ocCreds = os_.out.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => /\S\s{2,}\S/.test(l)).map((l) => l.trim().split(/\s{2,}/)[0]);
  let auth = {};
  try { auth = JSON.parse(cs.out); } catch {}
  const codexLogin = `${xs.out}\n${xs.err}`;
  return {
    claude: {
      name: 'Anthropic Claude Code',
      installed: cv.ok,
      version: cv.out.replace(/\s*\(Claude Code\)/, ''),
      binary: CLAUDE_BIN,
      connected: !!auth.loggedIn,
      method: auth.loggedIn ? (auth.authMethod === 'claude.ai' ? 'Assinatura Claude' : auth.authMethod) : null,
      plan: auth.subscriptionType ?? null,
      account: auth.email ?? null,
      org: auth.orgName ?? null,
      detail: auth.loggedIn ? null : cs.err || 'Não está logado no Claude Code',
    },
    codex: {
      name: 'OpenAI Codex / ChatGPT',
      installed: xv.ok,
      version: xv.out.replace(/^codex-cli\s*/, ''),
      binary: CODEX_BIN,
      connected: /Logged in/i.test(codexLogin),
      method: /ChatGPT/i.test(codexLogin) ? 'Assinatura ChatGPT' : /API key/i.test(codexLogin) ? 'API key' : null,
      plan: null,
      account: null,
      org: null,
      detail: /Logged in/i.test(codexLogin) ? null : codexLogin.trim() || 'Não está logado no Codex',
    },
    opencode: {
      name: 'OpenCode',
      installed: ov.ok,
      version: ov.out,
      binary: OPENCODE_BIN,
      // the free OpenCode Zen models work without any credential
      connected: ov.ok,
      method: ocCreds.length ? ocCreds.join(' · ') : 'Modelos grátis da OpenCode Zen',
      plan: null,
      account: null,
      org: null,
      detail: ov.ok ? null : 'OpenCode não encontrado (instale em opencode.ai)',
    },
  };
}

// Live check like pen.dev's "probe": one minimal request with the cheapest settings and a timeout.
export async function probe(provider) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    if (provider === 'claude') {
      let model = null;
      for await (const m of query({ prompt: 'Reply with the single word OK.', options: { model: 'haiku', maxTurns: 1, allowedTools: [], mcpServers: {}, settingSources: [], systemPrompt: 'Reply briefly.', pathToClaudeCodeExecutable: CLAUDE_BIN, abortController: controller } })) {
        if (m.type === 'system' && m.subtype === 'init') model = m.model;
        if (m.type === 'result') return { status: m.subtype === 'success' && !m.is_error ? 'connected' : 'not-connected', model, ms: Date.now() - started, reply: m.result?.slice(0, 40) };
      }
      return { status: 'not-connected', ms: Date.now() - started };
    }
    if (provider === 'opencode') {
      const r = await run(OPENCODE_BIN, ['run', '--format', 'json', 'Reply with the single word OK.'], 90000);
      const ev = r.out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return {}; } });
      const reply = ev.find((e) => e.type === 'text')?.part?.text;
      const err = ev.find((e) => e.type === 'error')?.error;
      return { status: reply ? 'connected' : 'not-connected', ms: Date.now() - started, reply: reply?.slice(0, 40), error: reply ? undefined : (err?.data?.message ?? err?.name ?? r.err).slice(0, 300) };
    }
    const codex = new Codex({ codexPathOverride: CODEX_BIN, config: { mcp_servers: Object.fromEntries(globalCodexServers().map((n) => [n, { enabled: false }])) } });
    const thread = codex.startThread({ skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', workingDirectory: os.tmpdir(), modelReasoningEffort: 'low' });
    const turn = await thread.run('Reply with the single word OK.', { signal: controller.signal });
    return { status: turn.finalResponse ? 'connected' : 'not-connected', ms: Date.now() - started, reply: turn.finalResponse?.slice(0, 40) };
  } catch (e) {
    return { status: 'not-connected', ms: Date.now() - started, error: controller.signal.aborted ? 'Tempo esgotado (90 s)' : String(e.message ?? e).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// Sign-in happens in the CLI itself (same as pen.dev's "Install Claude Code and log in"): open a Terminal running it.
export function openLoginTerminal(provider) {
  const [bin, ...args] = provider === 'claude' ? [CLAUDE_BIN] : provider === 'opencode' ? [OPENCODE_BIN, 'auth', 'login'] : [CODEX_BIN, 'login'];
  // Windows: a new console window (start "title" cmd /k "<cmd>"), quoted verbatim since cmd has its own rules
  if (WIN) return run('cmd.exe', ['/c', `start "Pena" cmd /k ""${bin}" ${args.join(' ')}"`], 20000, { windowsVerbatimArguments: true });
  const cmd = [`'${bin}'`, ...args].join(' ');
  return run('osascript', ['-e', `tell application "Terminal" to do script "${cmd.replaceAll('"', '\\"')}"`, '-e', 'tell application "Terminal" to activate']);
}

// ---------------------------------------------------------------- Pena's MCP inside external agents
// How Pena's MCP server is launched right now: inside the app, the sidecar binary in `mcp` mode.
export const penaLaunch = () => ({
  command: process.execPath,
  args: COMPILED ? ['mcp'] : [path.join(ROOT, 'mcp.mjs')],
  env: process.env.PENA_ROOT ? { PENA_ROOT: process.env.PENA_ROOT } : {},
});
const appSupport = WIN ? (process.env.APPDATA ?? path.join(HOME, 'AppData', 'Roaming')) : path.join(HOME, 'Library', 'Application Support');
export const CLIENTS = [
  { id: 'claude', name: 'Claude Code CLI', file: path.join(HOME, '.claude.json'), key: 'mcpServers', via: 'claude' },
  { id: 'codex', name: 'Codex CLI', file: path.join(CODEX_HOME, 'config.toml'), via: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', file: path.join(HOME, '.gemini', 'settings.json'), key: 'mcpServers' },
  { id: 'cursor', name: 'Cursor', file: path.join(HOME, '.cursor', 'mcp.json'), key: 'mcpServers' },
  { id: 'opencode', name: 'OpenCode', file: path.join(HOME, '.config', 'opencode', 'opencode.json'), shape: 'opencode' },
  { id: 'kiro', name: 'Kiro', file: path.join(HOME, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers' },
  { id: 'claudeDesktop', name: 'Claude Desktop', file: path.join(appSupport, 'Claude', 'claude_desktop_config.json'), key: 'mcpServers' },
];
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
// where a client keeps its servers: OpenCode (v2) nests them under mcp.servers
const serversOf = (data, c) => (c.shape === 'opencode' ? ((data.mcp ??= {}).servers ??= {}) : (data[c.key] ??= {}));

function entryOf(c) {
  if (c.id === 'codex') {
    const lines = fs.existsSync(c.file) ? fs.readFileSync(c.file, 'utf8').split('\n') : [];
    const start = lines.findIndex((l) => l.trim() === '[mcp_servers.pena]');
    if (start < 0) return null;
    const end = lines.findIndex((l, i) => i > start && l.trim().startsWith('[') && !l.trim().startsWith('[mcp_servers.pena.'));
    const block = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
    const command = /^command\s*=\s*"([^"]*)"/m.exec(block)?.[1];
    const args = (/^args\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1] ?? '').match(/"([^"]*)"/g)?.map((s) => s.slice(1, -1)) ?? [];
    return { command, args };
  }
  const data = readJson(c.file);
  const e = data && serversOf(data, c).pena;
  if (!e) return null;
  return c.shape === 'opencode' ? { command: e.command?.[0], args: e.command?.slice(1) ?? [] } : { command: e.command, args: e.args ?? [] };
}

export function integrations() {
  const want = penaLaunch();
  return CLIENTS.map((c) => {
    const entry = entryOf(c);
    const present = fs.existsSync(path.dirname(c.file)) || (c.via && fs.existsSync(c.via === 'claude' ? CLAUDE_BIN : CODEX_BIN));
    const current = !!entry && entry.command === want.command && JSON.stringify(entry.args) === JSON.stringify(want.args);
    return { id: c.id, name: c.name, file: c.file, present, registered: !!entry, current, entry };
  });
}

// Register/remove "pena" in one client. Claude Code and Codex go through their own CLIs (which keep the
// rest of your config intact); JSON clients get a one-time backup before the first edit.
export async function setIntegration(id, on) {
  const c = CLIENTS.find((x) => x.id === id);
  if (!c) throw new Error(`Cliente desconhecido: ${id}`);
  const { command, args, env } = penaLaunch();
  if (c.via === 'claude') {
    await run(CLAUDE_BIN, ['mcp', 'remove', 'pena', '-s', 'user']);
    if (on) {
      const r = await run(CLAUDE_BIN, ['mcp', 'add', 'pena', '-s', 'user', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', command, ...args]);
      if (!r.ok) throw new Error(r.err || 'claude mcp add falhou');
    }
  } else if (c.via === 'codex') {
    await run(CODEX_BIN, ['mcp', 'remove', 'pena']);
    if (on) {
      const r = await run(CODEX_BIN, ['mcp', 'add', 'pena', ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]), '--', command, ...args]);
      if (!r.ok) throw new Error(r.err || 'codex mcp add falhou');
    }
  } else {
    const data = readJson(c.file) ?? {};
    if (fs.existsSync(c.file) && !fs.existsSync(`${c.file}.pena-backup`)) fs.copyFileSync(c.file, `${c.file}.pena-backup`);
    const servers = serversOf(data, c);
    if (on)
      servers.pena = c.shape === 'opencode'
        ? { type: 'local', command: [command, ...args], ...(Object.keys(env).length && { environment: env }) }
        : { command, args, ...(Object.keys(env).length && { env }), ...(c.id === 'claudeDesktop' && { type: 'stdio' }) };
    else delete servers.pena;
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    fs.writeFileSync(c.file, JSON.stringify(data, null, 2));
  }
  return integrations().find((x) => x.id === id);
}

// ---------------------------------------------------------------- extra MCP servers for Pena's agents
const AGENT_MCP = path.join(HOME, '.pena', 'mcp.json');
export const readAgentMcpText = () => (fs.existsSync(AGENT_MCP) ? fs.readFileSync(AGENT_MCP, 'utf8') : '{\n  "mcpServers": {}\n}\n');
export function writeAgentMcpText(text) {
  const parsed = JSON.parse(text);
  if (typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) throw new Error('O JSON precisa ter um objeto "mcpServers"');
  if (parsed.mcpServers.pena) throw new Error('"pena" é reservado para o servidor do próprio Pena');
  fs.mkdirSync(path.dirname(AGENT_MCP), { recursive: true });
  fs.writeFileSync(AGENT_MCP, text.endsWith('\n') ? text : `${text}\n`);
}
export const agentMcpServers = () => { try { return JSON.parse(readAgentMcpText()).mcpServers ?? {}; } catch { return {}; } };

// Start one MCP server the way a client would and list its tools: proves the connection end to end.
export async function testMcp(config) {
  const started = Date.now();
  const client = new Client({ name: 'pena-settings', version: '1' });
  const transport = config.url
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } })
    : new StdioClientTransport({ command: config.command, args: config.args ?? [], env: { ...process.env, ...(config.env ?? {}) }, stderr: 'ignore' });
  try {
    await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error('Tempo esgotado (20 s)')), 20000))]);
    const { tools } = await client.listTools();
    return { ok: true, tools: tools.map((t) => t.name), ms: Date.now() - started };
  } catch (e) {
    const msg = String(e.message ?? e);
    return { ok: false, error: /401|unauthori[sz]ed/i.test(msg) ? 'Precisa de autenticação (OAuth/token)' : msg.slice(0, 300), ms: Date.now() - started };
  } finally {
    client.close().catch(() => {});
  }
}
