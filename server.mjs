#!/usr/bin/env node
// Pena: local design editor + embedded agents that run on YOUR subscriptions.
//   Claude -> @anthropic-ai/claude-agent-sdk reuses the `claude` CLI login (Pro/Max). No API key.
//   Codex  -> @openai/codex-sdk reuses `codex login` (ChatGPT plan). No API key.
//   OpenCode -> the `opencode` CLI with your `opencode auth login` credentials (Zen, Go, OpenRouter, ...).
//     pen.dev runs OpenCode Zen/Go through its own agent with an API key (REA: @earendil-works/pi-ai); here
//     it's the CLI you already use, so every provider you logged into there shows up.
// Both get the design tools through the same stdio MCP server (mcp.mjs), like pen.dev does.
import http from 'node:http';
import readline from 'node:readline';
import buffer from 'node:buffer';
import { execFile, execFileSync, spawn as spawnProcess, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { load, save, EMPTY, systemPrompt, mergeDocs } from './doc.mjs';
import { createTools, callTool } from './tools.mjs';
import * as library from './library.mjs';
import * as fonts from './fonts.mjs';
import * as chats from './chats.mjs';
import { listSkills, skillContent, addSkill, removeSkill } from './skills.mjs';
import * as settings from './settings.mjs';
import { importFigma, exportFigma } from './figma.mjs';
import { readBrowserClipboard, importBrowserSnapshot } from './browser-import.mjs';
import { ROOT, COMPILED } from './root.mjs';

let keptFigma = null; // a dashboard Figma import waiting for the editor
let FILE; // the open .pen file; switchable at runtime (File > Open)
let ownWrite = 0; // mtime of the editor's last save
// The document's revision is its mtime: every writer (editor, agents, other apps) bumps it with no bookkeeping.
const revOf = (file) => String(fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? '');
let PORT;

const mcp = (agent) => {
  const { command, args, env } = settings.penaLaunch();
  return { command, args, env: { ...env, PENA_FILE: FILE, PENA_URL: `http://127.0.0.1:${PORT}`, ...(agent && { PENA_AGENT: agent }) } };
};
// Re-read per session so edits to skills/ apply without restarting.
const SYSTEM = () => `You are a product designer working inside Pena, a visual design tool.
Design only through the pena MCP tools (get_app_state, execute, read_skill, spawn_agents). Do not write files or run shell commands.
Reply in the user's language with one or two short sentences about what you did.

The pena skill is loaded below. Read guide files with read_skill when the task matches them.

${systemPrompt()}`;

// --- server-sent events: document changes + agent stream ---------------------------------
const clients = new Set();
const emit = (event, data) => {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (event === 'agent' && FILE) remember(data);
};
// Chat history keeps finished items only (streaming sends many partial updates of the same text/card).
const toolParts = new Map(); // tool card id -> merged updates until it finishes
function remember(d) {
  const keep = (m) => chats.append(FILE, m);
  if (d.kind === 'text' || d.kind === 'thinking') { if (d.done) keep(d); return; }
  if (d.kind === 'tool') {
    const t = { ...toolParts.get(d.id), ...d };
    if (d.status !== 'done' && d.status !== 'error') return void toolParts.set(d.id, t);
    toolParts.delete(d.id);
    const input = t.input && typeof t.input === 'object' ? Object.fromEntries(Object.entries(t.input).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 8000) : v])) : t.input;
    return keep({ ...t, input, images: t.images?.length ?? 0, output: String(t.output ?? '').slice(0, 4000) });
  }
  if (['start', 'model', 'end', 'todos', 'error'].includes(d.kind)) keep(d);
}
// The main chat's agent sessions, saved with the conversation so a reopened chat resumes with its context.
const saveSessions = () => FILE && chats.setSessions(FILE, { claude: main.claude?.claude, codex: main.codex?.codex?.id ?? main.codex?.codexId, opencode: main.opencode?.opencode });
function restoreSessions() {
  for (const k in main) delete main[k];
  const s = FILE && chats.current(FILE)?.sessions;
  if (s?.claude) main.claude = { claude: s.claude };
  if (s?.codex) main.codex = { codexId: s.codex };
  if (s?.opencode) main.opencode = { opencode: s.opencode };
}
// watchFile (polling) survives the atomic rename in save(); fs.watch loses the inode.

// --- agents ----------------------------------------------------------------------------------
// A session holds one agent conversation. `main` is the chat panel; spawn_agents adds parallel ones.
const main = {};
const running = new Set(); // AbortControllers of every live agent run
let lastChat = { provider: 'claude' };

// --- model catalogs: read from your own accounts, never hardcoded (pen.dev ships fixed lists) ---
// Claude: the SDK asks the logged-in CLI which models your plan has, and which efforts each supports.
let claudeModels;
const listClaudeModels = () =>
  (claudeModels ??= (async () => {
    // the CLI you installed: the compiled app has no node_modules for the SDK to find its own copy in
    const q = query({ prompt: (async function* () { await new Promise(() => {}); })(), options: { pathToClaudeCodeExecutable: settings.CLAUDE_BIN } });
    try {
      const models = await q.supportedModels();
      return models.map((m) => ({ id: m.value, name: m.displayName, efforts: m.supportedEffortLevels ?? [], defaultEffort: 'high' }));
    } finally {
      q.close();
    }
  })().catch((e) => ((claudeModels = undefined), Promise.reject(e))));

// Codex: the CLI caches your account's model list (with per-model reasoning levels) after `codex login`.
function listCodexModels() {
  const cache = path.join(CODEX_HOME, 'models_cache.json');
  if (!fs.existsSync(cache)) return [];
  return JSON.parse(fs.readFileSync(cache, 'utf8'))
    .models.filter((m) => m.visibility === 'list')
    .map((m) => ({
      id: m.slug,
      name: m.display_name,
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level,
    }));
}

// OpenCode: `opencode models --verbose` prints "provider/model" then that model's JSON, for every provider you
// logged into. Variants are its reasoning levels. Only models that can call tools can design.
let opencodeModels;
const listOpencodeModels = () =>
  (opencodeModels ??= new Promise((ok, fail) =>
    execFile(settings.OPENCODE_BIN, ['models', '--verbose'], { maxBuffer: 256 << 20, timeout: 60000 }, (err, out) => {
      if (err) return (opencodeModels = undefined), fail(err);
      ok(out.split(/^\S+\/\S+\n(?=\{)/m).filter((x) => x.trim()).flatMap((j) => { try { return [JSON.parse(j)]; } catch { return []; } })
        .filter((m) => m.capabilities?.toolcall && m.status !== 'deprecated')
        .map((m) => ({ id: `${m.providerID}/${m.id}`, name: `${m.name} · ${m.providerID}`, efforts: Object.keys(m.variants ?? {}), defaultEffort: undefined })));
    })));

// Images from the chat (data URLs): Claude takes them as content blocks of a streamed user message.
const dataUrl = (d) => { const m = /^data:([^;]+);base64,(.*)$/s.exec(d); return m && { mime: m[1], b64: m[2] }; };
function claudePrompt(prompt, images = [], docs = []) {
  if (!images.length && !docs.length) return prompt;
  const content = [
    ...images.map(dataUrl).filter(Boolean).map(({ mime, b64 }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } })),
    ...docs.map((b64) => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } })),
    { type: 'text', text: prompt },
  ];
  return (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }; })();
}

// Any other file from the chat: saved under ~/.pena/attachments; text goes into the prompt, PDFs also go to Claude
// as documents, other binaries are read by the agent from the saved path (Claude may Read only that folder).
const ATTACH_DIR = path.join(library.PENA_DIR, 'attachments');
const TEXT_NAME = /\.(html?|css|scss|js|mjs|cjs|ts|tsx|jsx|json|md|mdx|txt|csv|tsv|xml|svg|ya?ml|toml|ini|env|py|rb|go|rs|java|kt|swift|php|sql|sh|vue|svelte|astro|pen|log)$/i;
const MAX_INLINE = 200_000; // characters of a text file placed in the prompt
// Office documents as plain text: Word/RTF/ODT through macOS's textutil, Excel/PowerPoint/ODF from their XML.
function officeText(file, name) {
  try {
    const mac = process.platform === 'darwin';
    if (mac && /\.(docx?|rtf|rtfd|odt|webarchive)$/i.test(name)) return execFileSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], { maxBuffer: 64 << 20 }).toString();
    if (/\.(xlsx|xlsm|pptx|ods|odp|docx|odt)$/i.test(name)) {
      // unzip (tar on Windows) exits non-zero when a pattern is missing (xlsx has no slides): keep whatever it printed
      const parts = ['xl/sharedStrings.xml', 'xl/worksheets/*.xml', 'ppt/slides/*.xml', 'word/document.xml', 'content.xml'];
      const [bin, args] = process.platform === 'win32' ? ['tar', ['-xOf', file, ...parts]] : ['/usr/bin/unzip', ['-p', file, ...parts]];
      const xml = spawnSync(bin, args, { maxBuffer: 64 << 20, windowsHide: true }).stdout?.toString() ?? '';
      if (!xml) return null;
      return xml.replace(/<\/(a:p|w:p|row|text:p|si)>/g, '\n').replace(/<\/(c|a:t|t)>/g, '\t').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/[ \t]*\n\s*/g, '\n').trim();
    }
  } catch {}
  return null;
}
function attachFiles(files = []) {
  if (!files.length) return { text: '', docs: [] };
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const parts = [], docs = [];
  for (const f of files) {
    const d = dataUrl(f.data ?? '');
    if (!d) continue;
    const buf = Buffer.from(d.b64, 'base64');
    const file = path.join(ATTACH_DIR, `${Date.now()}-${path.basename(f.name ?? 'arquivo').replace(/[^\w.\- ]+/g, '_')}`);
    fs.writeFileSync(file, buf);
    const office = officeText(file, f.name ?? '');
    const isText = office == null && (/^text\/|^application\/(json|xml|javascript)|\+(xml|json)$|^image\/svg/.test(d.mime) || TEXT_NAME.test(f.name ?? '') || (buffer.isUtf8(buf) && !buf.includes(0)));
    if (isText) {
      const t = buf.toString('utf8');
      parts.push(`<attachment name="${f.name}" path="${file}">\n${t.slice(0, MAX_INLINE)}${t.length > MAX_INLINE ? `\n[truncated: ${t.length} characters in total, the full file is at the path above]` : ''}\n</attachment>`);
    } else if (d.mime === 'application/pdf' || /\.pdf$/i.test(f.name ?? '')) {
      docs.push(d.b64);
      parts.push(`<attachment name="${f.name}" type="application/pdf" path="${file}">PDF (Claude receives it as a document; other agents can read it from the path).</attachment>`);
    } else {
      const text = office;
      parts.push(text != null
        ? `<attachment name="${f.name}" path="${file}" extracted="text">\n${text.slice(0, MAX_INLINE)}${text.length > MAX_INLINE ? '\n[truncated]' : ''}\n</attachment>`
        : `<attachment name="${f.name}" type="${d.mime}" path="${file}" bytes="${buf.length}">Binary file. First bytes (hex): ${buf.subarray(0, 256).toString('hex').replace(/(..)/g, '$1 ').trim()}</attachment>`);
    }
  }
  return { text: `\n\nFiles attached by the user:\n${parts.join('\n')}`, docs };
}

const claudeExtraServers = () =>
  Object.fromEntries(Object.entries(settings.agentMcpServers()).map(([n, c]) => [n, c.url ? { type: c.type === 'sse' ? 'sse' : 'http', url: c.url, ...(c.headers && { headers: c.headers }) } : { command: c.command, args: c.args ?? [], ...(c.env && { env: c.env }) }]));

async function runClaude({ prompt, model, effort, images, docs }, session, signal, say, agent) {
  const q = query({
    prompt: claudePrompt(prompt, images, docs),
    options: {
      cwd: path.dirname(FILE),
      mcpServers: { ...claudeExtraServers(), pena: mcp(agent) },
      pathToClaudeCodeExecutable: settings.CLAUDE_BIN,
      includePartialMessages: true, // token-by-token text, thinking and tool input, like pen.dev's chat
      // Only the design tools; everything else (Bash, Write, ...) is refused.
      canUseTool: async (name, input) =>
        name.startsWith('mcp__pena__') || Object.keys(settings.agentMcpServers()).some((s) => name.startsWith(`mcp__${s}__`)) ||
        name === 'WebSearch' || name === 'WebFetch' || name === 'TodoWrite' || // research and the agent's plan
        (name === 'Read' && path.resolve(String(input.file_path ?? '')).startsWith(ATTACH_DIR + path.sep))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Only the pena design tools, web search/fetch, the MCP servers configured in Pena and reading attached files are available.' },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM() },
      ...(model && model !== 'default' && { model }),
      ...(effort && { effort }),
      resume: session.claude,
      abortController: signal,
    },
  });
  let msgId = '';
  const blocks = new Map(); // stream index -> block being streamed
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') (session.claude = m.session_id), say('model', { model: m.model });
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'message_start') (msgId = e.message.id), blocks.clear();
      else if (e.type === 'content_block_start') {
        const b = e.content_block, blk = { type: b.type, id: b.type === 'tool_use' ? b.id : `${msgId}:${e.index}`, name: shortTool(b.name ?? ''), text: '', json: '' };
        blocks.set(e.index, blk);
        if (b.type === 'tool_use' && blk.name !== 'TodoWrite') say('tool', { id: blk.id, name: blk.name, status: 'running' });
        if (b.type === 'thinking') say('thinking', { id: blk.id, text: '' });
      } else if (e.type === 'content_block_delta') {
        const blk = blocks.get(e.index), d = e.delta;
        if (!blk) continue;
        if (d.type === 'text_delta') say('text', { id: blk.id, text: (blk.text += d.text) }, blk.id);
        if (d.type === 'thinking_delta') say('thinking', { id: blk.id, text: (blk.text += d.thinking) }, blk.id);
        if (d.type === 'input_json_delta' && blk.name !== 'TodoWrite') {
          blk.json += d.partial_json;
          // the execute tool's `description` names the card while the script is still being written
          const desc = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(blk.json)?.[1];
          if (desc && desc !== blk.desc) say('tool', { id: blk.id, name: blk.name, status: 'running', label: (blk.desc = desc).replace(/\\(.)/g, '$1') });
        }
      } else if (e.type === 'content_block_stop') {
        const blk = blocks.get(e.index);
        if (blk?.type === 'text') say('text', { id: blk.id, text: blk.text, done: true });
        if (blk?.type === 'thinking') say('thinking', { id: blk.id, text: blk.text, done: true });
      }
    }
    if (m.type === 'assistant')
      m.message.content.forEach((b, i) => {
        if (b.type === 'tool_use' && b.name === 'TodoWrite') (session.todoIds ??= new Set()).add(b.id), say('todos', { items: (b.input.todos ?? []).map((t) => ({ text: t.content, status: t.status })) });
        else if (b.type === 'tool_use') say('tool', { id: b.id, name: shortTool(b.name), input: b.input, status: 'running' });
        if (b.type === 'text' && b.text) say('text', { id: `${m.message.id}:${i}`, text: b.text, done: true }); // also covers runs without stream events
      });
    if (m.type === 'user' && Array.isArray(m.message.content))
      for (const b of m.message.content)
        if (b.type === 'tool_result' && !session.todoIds?.has(b.tool_use_id)) say('tool', { id: b.tool_use_id, status: b.is_error ? 'error' : 'done', output: textOf(b.content), images: imagesOf(b.content) });
    if (m.type === 'result') {
      session.usage = { costUsd: m.total_cost_usd, turns: m.num_turns, input: m.usage?.input_tokens, output: m.usage?.output_tokens, cacheRead: m.usage?.cache_read_input_tokens, cacheWrite: m.usage?.cache_creation_input_tokens };
      if (m.subtype !== 'success') throw new Error(m.subtype === 'error_max_turns' ? 'Limite de turnos atingido' : m.subtype);
    }
  }
}
const shortTool = (n) => n.replace(/^mcp__.+?__/, '');
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x.type === 'text').map((x) => x.text).join('\n') : '').slice(0, 4000);
const imagesOf = (c) => (Array.isArray(c) ? c.filter((x) => x.type === 'image').map((x) => `data:${x.source?.media_type ?? x.mimeType ?? 'image/png'};base64,${x.source?.data ?? x.data}`) : []);

// Codex also loads every MCP server from your global ~/.codex/config.toml (e.g. pen.dev's own `pencil`), and the
// agent may call their tools instead of ours. Disable them for Pena sessions only; your config file is untouched.
const { CODEX_HOME, globalCodexServers } = settings;
// Extra MCP servers you gave Pena's agents (Settings › MCP), in Codex's config shape.
const codexServer = (c) => (c.url ? { url: c.url, ...(c.headers && { http_headers: c.headers }) } : { command: c.command, args: c.args ?? [], ...(c.env && { env: c.env }) });
// One client per agent name: the pena MCP server tells the app which agent made each edit (canvas cursors).
const codexClients = new Map();
const codex = (agent) => {
  const extra = settings.agentMcpServers();
  const key = JSON.stringify([extra, agent]);
  if (codexClients.has(key)) return codexClients.get(key);
  const client = (new Codex({
    codexPathOverride: settings.CODEX_BIN,
    config: {
      mcp_servers: {
        ...Object.fromEntries(globalCodexServers().map((name) => [name, { enabled: false }])),
        ...Object.fromEntries(Object.entries(extra).map(([n, c]) => [n, { ...codexServer(c), default_tools_approval_mode: 'approve' }])),
        pena: { ...mcp(agent), default_tools_approval_mode: 'approve', tool_timeout_sec: 300 },
      },
    },
  }));
  codexClients.set(key, client);
  return client;
};

async function runCodex({ prompt, model, effort, images = [] }, session, signal, say, agent) {
  const options = {
    workingDirectory: path.dirname(FILE),
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    webSearchMode: 'live', // research on the web, like Claude's WebSearch
    approvalPolicy: 'never',
    ...(model && { model }),
    ...(effort && { modelReasoningEffort: effort }),
  };
  const key = JSON.stringify(options);
  if (!session.codex && session.codexId) {
    session.codex = codex(agent).resumeThread(session.codexId, options); // conversation restored from the chat history
  } else if (!session.codex) {
    session.codex = codex(agent).startThread(options);
    prompt = `${SYSTEM()}\n\n---\n\n${prompt}`; // first turn only; codex persists the thread
  } else if (session.codexKey !== key && session.codex.id) {
    session.codex = codex(agent).resumeThread(session.codex.id, options); // switch model/effort, keep the conversation
  }
  session.codexKey = key;
  // Codex takes images as local files.
  const files = images.map(dataUrl).filter(Boolean).map(({ mime, b64 }, i) => {
    const f = path.join(os.tmpdir(), `pena-${Date.now()}-${i}.${mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    return f;
  });
  const input = files.length ? [{ type: 'text', text: prompt }, ...files.map((f) => ({ type: 'local_image', path: f }))] : prompt;
  const { events } = await session.codex.runStreamed(input, { signal: signal.signal });
  say('model', { model: model ?? 'codex' });
  const status = (it) => (it.status === 'failed' ? 'error' : it.status === 'completed' ? 'done' : 'running');
  for await (const e of events) {
    const it = e.item;
    if (it && e.type.startsWith('item.')) {
      const done = e.type === 'item.completed';
      if (it.type === 'agent_message') say('text', { id: it.id, text: it.text, done }, done ? null : it.id);
      if (it.type === 'reasoning') say('thinking', { id: it.id, text: it.text, done }, done ? null : it.id);
      if (it.type === 'mcp_tool_call') say('tool', { id: it.id, name: it.tool, input: it.arguments, status: status(it), output: textOf(it.result?.content) || it.error?.message, images: imagesOf(it.result?.content) });
      if (it.type === 'command_execution') say('tool', { id: it.id, name: 'shell', input: { command: it.command }, status: status(it), output: (it.aggregated_output ?? '').slice(-4000) });
      if (it.type === 'web_search') say('tool', { id: it.id, name: 'web_search', input: { query: it.query }, status: done ? 'done' : 'running' });
      if (it.type === 'todo_list') say('todos', { items: it.items.map((t) => ({ text: t.text, status: t.completed ? 'completed' : 'pending' })) });
    }
    if (e.type === 'turn.completed') session.usage = { input: e.usage?.input_tokens, cacheRead: e.usage?.cached_input_tokens, output: e.usage?.output_tokens };
    if (e.type === 'turn.failed') throw new Error(e.error.message);
  }
}

// OpenCode: one `opencode run --format json` per turn, resumed by session id. The config goes in through
// OPENCODE_CONFIG_CONTENT (merged over yours, your files untouched): Pena's MCP server, your global MCP servers off,
// and every other tool on "ask", which `opencode run` rejects by itself (last matching rule wins). Not "deny": that
// drops the tools from the request, and OpenCode Zen's free models refuse requests without its own tools.
async function runOpencode({ prompt, model, effort, images = [] }, session, signal, say, agent) {
  const extra = settings.agentMcpServers();
  const local = (c) => (c.url ? { type: 'remote', url: c.url, ...(c.headers && { headers: c.headers }) } : { type: 'local', command: [c.command, ...(c.args ?? [])], ...(c.env && { environment: c.env }) });
  const { command, args, env } = mcp(agent);
  const config = {
    mcp: {
      ...Object.fromEntries(settings.globalOpencodeServers().map((n) => [n, { enabled: false }])),
      ...Object.fromEntries(Object.entries(extra).map(([n, c]) => [n, local(c)])),
      pena: { type: 'local', command: [command, ...args], environment: env, timeout: 30000 },
    },
    permission: { '*': 'ask', 'pena_*': 'allow', ...Object.fromEntries(Object.keys(extra).map((n) => [`${n}_*`, 'allow'])), webfetch: 'allow', websearch: 'allow', todowrite: 'allow' },
  };
  if (!session.opencode) prompt = `${SYSTEM()}\n\n---\n\n${prompt}`; // first turn only; opencode keeps the session
  const files = images.map(dataUrl).filter(Boolean).map(({ mime, b64 }, i) => {
    const f = path.join(os.tmpdir(), `pena-${Date.now()}-${i}.${mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    return f;
  });
  const argv = ['run', '--format', 'json', '--thinking', '--dir', path.dirname(FILE),
    ...(session.opencode ? ['-s', session.opencode] : []), ...(model ? ['-m', model] : []), ...(effort ? ['--variant', effort] : []),
    ...files.flatMap((f) => ['-f', f]), '--', prompt];
  const child = spawnProcess(settings.OPENCODE_BIN, argv, { env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'], signal: signal.signal });
  let stderr = '', failure;
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const exited = new Promise((ok) => child.on('close', ok).on('error', (e) => ((failure ??= e), ok())));
  say('model', { model: model ?? 'opencode' });
  const usage = (session.usage = { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
  for await (const line of readline.createInterface({ input: child.stdout })) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.sessionID) session.opencode = e.sessionID;
    const p = e.part ?? {};
    if (e.type === 'text') say('text', { id: p.id, text: p.text, done: true });
    if (e.type === 'reasoning') say('thinking', { id: p.id, text: p.text, done: true });
    if (e.type === 'tool_use' && p.tool === 'todowrite') say('todos', { items: (p.state?.input?.todos ?? []).map((t) => ({ text: t.content, status: t.status })) });
    else if (e.type === 'tool_use') say('tool', { id: p.callID, name: p.tool.replace(/^pena_/, ''), input: p.state?.input, status: p.state?.status === 'error' ? 'error' : p.state?.status === 'completed' ? 'done' : 'running', output: String(p.state?.output ?? p.state?.error ?? '').slice(0, 4000) });
    if (e.type === 'step_finish') {
      const t = p.tokens ?? {};
      Object.assign(usage, { costUsd: usage.costUsd + (p.cost ?? 0), input: usage.input + (t.input ?? 0), output: usage.output + (t.output ?? 0) + (t.reasoning ?? 0), cacheRead: usage.cacheRead + (t.cache?.read ?? 0), cacheWrite: usage.cacheWrite + (t.cache?.write ?? 0), turns: usage.turns + 1 });
    }
    if (e.type === 'error') failure ??= new Error(e.error?.data?.message ?? e.error?.name ?? 'OpenCode falhou');
  }
  const code = await exited;
  if (failure) throw failure;
  if (code) throw new Error(stderr.trim().split('\n').pop() || `opencode saiu com código ${code}`);
}

// Agent profiles like pen.dev's: a name and a color per agent, in order of appearance (reset with a new chat).
const AGENT_NAMES = ['Phantom', 'Drift', 'Flare', 'Onyx', 'Nova', 'Hex', 'Echo', 'Mirage', 'Cosmo', 'Reef'];
const AGENT_COLORS = ['#aab9e1', '#5acdd2', '#ffaf3c', '#9b8cbe', '#ff73a0', '#b96ef0', '#78c8f0', '#dcb48c', '#6496ff', '#46d2c3', '#ffa08c', '#ff8c55', '#96d2ff', '#9bcdaa', '#64c882', '#c38ce6', '#6e8ceb', '#ffd76e', '#ff6961', '#ffd278'];
const profiles = new Map();
const newProfile = () => {
  const i = profiles.size;
  const p = { name: AGENT_NAMES[i % AGENT_NAMES.length] + (i >= AGENT_NAMES.length ? ` ${Math.floor(i / AGENT_NAMES.length) + 1}` : ''), color: AGENT_COLORS[i % AGENT_COLORS.length] };
  profiles.set(p.name, p);
  return p;
};
const profileOf = (name) => profiles.get(name);

// One agent run. Events go to the editor as `agent` SSE messages: start, model, text/thinking (accumulated text,
// streamed), tool (card updates by id), todos, end (reason, duration, usage). Streaming updates are throttled.
async function run(req, session, { parent } = {}) {
  if (!session.profile || !profiles.has(session.profile.name)) session.profile = newProfile();
  const profile = session.profile, agent = profile.name;
  const controller = new AbortController();
  running.add(controller);
  const last = new Map(), pending = new Map();
  const send = (kind, data) => emit('agent', { agent, color: profile.color, kind, ...data });
  const say = (kind, data, throttleKey = null) => {
    if (!throttleKey) { if (data?.id) clearTimeout(pending.get(data.id)), pending.delete(data.id); return send(kind, data); }
    const wait = 60 - (Date.now() - (last.get(throttleKey) ?? 0));
    clearTimeout(pending.get(throttleKey));
    if (wait <= 0) return last.set(throttleKey, Date.now()), send(kind, data);
    pending.set(throttleKey, setTimeout(() => (last.set(throttleKey, Date.now()), send(kind, data)), wait));
  };
  const t0 = Date.now();
  send('start', { provider: req.provider, model: req.model, effort: req.effort, parent });
  let end = { reason: 'finished' };
  try {
    await ({ codex: runCodex, opencode: runOpencode }[req.provider] ?? runClaude)(req, session, controller, say, agent);
  } catch (e) {
    end = controller.signal.aborted ? { reason: 'stopped' } : { reason: 'failed', message: String(e.message ?? e), provider: req.provider };
  } finally {
    running.delete(controller);
  }
  for (const t of pending.values()) clearTimeout(t);
  if (Object.values(main).includes(session)) saveSessions();
  send('end', { ...end, ms: Date.now() - t0, usage: session.usage });
  session.usage = null;
}

// One chat turn, shaped like pen.dev's: attached skills, the app state prefetched into the prompt, and the
// "Nx" parallel setting — split (one agent divides the work with spawn_agents) or side-by-side (N variations).
let spawnBudget = 0;
async function chat(req) {
  const { agents = 1, parallel = 'split', skills: skillNames = [] } = req;
  if (FILE) chats.append(FILE, { kind: 'user', text: req.shown ?? req.prompt, files: (req.files ?? []).map((f) => f.name), images: (req.images ?? []).length, context: req.context ?? null, skills: req.skills ?? [] });
  const attached = attachFiles(req.files);
  let prompt = req.prompt + attached.text;
  req = { ...req, files: undefined, docs: attached.docs };
  lastChat = { ...req, docs: undefined }; // spawned agents get the text (in their prompts), not the PDFs again
  for (const name of skillNames) {
    try {
      const sk = skillContent(name);
      prompt += `\n\n<skill name="${sk.name}" source="${sk.source}">\n${sk.content}\n</skill>`;
    } catch (e) {
      emit('agent', { agent: 'Pena', kind: 'error', text: e.message });
    }
  }
  if (skillNames.length) prompt += `\n\nFollow the attached skill${skillNames.length > 1 ? 's' : ''} (${skillNames.join(', ')}) for this request.`;
  try {
    const [state] = await tools.get_app_state();
    prompt += `\n\nCurrent app state (fetched right before this turn; no need to call get_app_state first):\n${state.text}`;
  } catch {}
  const n = Math.max(1, Math.min(8, Number(agents) || 1));
  if (n > 1 && parallel === 'side-by-side') {
    spawnBudget = 0;
    for (let i = 1; i <= n; i++)
      run({ ...req, prompt: `${prompt}\n\nYou are designer ${i} of ${n} working at the same time on this same request; each creates an independent VARIATION. Make your own top-level frame named with " — Variação ${i}" at FindEmptySpace (other designers are placing theirs too), explore a direction distinct from a typical solution, and never touch other designers' frames.` },
        i === 1 ? (main[req.provider] ??= {}) : {});
    return;
  }
  spawnBudget = n - 1;
  if (n > 1) prompt = `Do this task by splitting the work across at most ${n - 1} extra designer agent${n > 2 ? 's' : ''} with the spawn_agents tool, besides you. Create the container frames first, spawn the agents for the other parts, then design the last part yourself.\n\n${prompt}`;
  run({ ...req, prompt }, (main[req.provider] ??= {}));
}

// spawn_agents: extra agents with the chat's provider/model/effort, each confined to its container nodes.
// Limited by the "Nx" setting; spawned agents can't spawn more (their budget is the chat's, already spent).
function spawn(config) {
  if (spawnBudget <= 0) return 'Parallel agents are off for this request (1x). Do the whole task yourself, without spawn_agents.';
  const accepted = config.slice(0, spawnBudget);
  spawnBudget -= accepted.length;
  for (const { prompt, containerNodes } of accepted) {
    run(
      { ...lastChat, skills: [], prompt: `${prompt}\n\nWork ONLY inside these nodes: ${containerNodes.join(', ')}. Other agents are editing the rest of the document in parallel; never touch nodes outside your containers. Do not call spawn_agents. Remove placeholder: true from your containers when done.` },
      {},
      { parent: main[lastChat.provider]?.profile?.name },
    );
  }
  const dropped = config.length - accepted.length;
  return `Spawned ${accepted.length} designer agent(s); they are working in parallel now. Do your own part.${dropped ? ` ${dropped} request(s) over the limit were not started — do those parts yourself.` : ''}`;
}

// --- editor bridge: selection state + rendering (screenshots/exports happen in the browser) ---
let editorState = {}, editorRects = {}; // rects: rendered size of each top-level frame, posted by the editor
const renders = new Map();
let renderSeq = 0;
function render(job) {
  if (!clients.size) return Promise.reject(new Error('Open the Pena editor in a browser to render screenshots/exports.'));
  const reqId = ++renderSeq;
  emit('render', { reqId, ...job });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => renders.delete(reqId) && reject(new Error('Render timed out (is the editor open?)')), 60000);
    renders.set(reqId, { resolve, reject, timer });
  });
}

const tools = createTools({ file: () => FILE, render, state: () => ({ ...editorState, rects: editorRects }), spawn, touched: (agent, nodes) => emit('agent-nodes', { agent: agent ?? 'agente externo', color: profileOf(agent)?.color, nodes }) });

// --- http ------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glsl': 'text/plain; charset=utf-8', '.json': 'application/json' };
const bytes = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
// Saves next to the .pen (images/, shaders/) and returns the relative url. A file with the same name and bytes is
// reused (adding the same library shader twice); a different one gets a free name.
const saveAsset = (folder, name, data) => {
  const dir = path.join(path.dirname(FILE), folder);
  fs.mkdirSync(dir, { recursive: true });
  name = path.basename(name).replace(/[^\w.-]+/g, '-');
  let target = path.join(dir, name);
  for (let i = 2; fs.existsSync(target) && !fs.readFileSync(target).equals(data); i++) target = path.join(dir, name.replace(/(\.\w+)$/, `-${i}$1`));
  fs.writeFileSync(target, data);
  return `./${folder}/${path.basename(target)}`;
};
const saveImage = (name, data) => saveAsset('images', name, data);
// Decode once at the end: concatenating chunks as strings corrupts multi-byte characters (accents) split across chunks.
const body = (req) => new Promise((ok, fail) => { const chunks = []; req.on('data', (c) => chunks.push(c)).on('end', () => ok(Buffer.concat(chunks).toString('utf8'))).on('error', fail); });

const server = http.createServer(async (req, res) => {
    try {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const q = new URL(req.url, 'http://x').searchParams;
      const json = (data) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(data)));
      if (req.method === 'GET' && url === '/' && !FILE) return res.writeHead(302, { location: '/dashboard' }).end();
      if (req.method === 'GET' && (url === '/' || url === '/dashboard' || /^\/[\w-]+\.(js|html|css|svg)$/.test(url))) {
        const f = path.join(ROOT, 'public', url === '/' ? 'index.html' : url === '/dashboard' ? 'dashboard.html' : url);
        res.setHeader('content-type', `${MIME[path.extname(f)]}; charset=utf-8`);
        res.setHeader('cache-control', 'no-cache'); // always revalidate the UI so updates show up
        return res.end(fs.readFileSync(f));
      }
      // Skia (CanvasKit) for the canvas renderer.
      if (req.method === 'GET' && /^\/vendor\/canvaskit\.(js|wasm)$/.test(url)) {
        res.setHeader('content-type', url.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.setHeader('cache-control', 'public, max-age=86400');
        return fs.createReadStream(path.join(ROOT, 'node_modules/canvaskit-wasm/bin', path.basename(url))).pipe(res);
      }
      // Imported libraries (`imports` in the .pen), relative to the open file; only .pen files.
      if (req.method === 'GET' && url === '/import' && FILE) {
        const f = path.resolve(path.dirname(FILE), q.get('path') ?? '');
        if (!f.endsWith('.pen') || !fs.existsSync(f)) return res.writeHead(404).end();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return fs.createReadStream(f).pipe(res);
      }
      // Image fills and shaders use paths relative to the .pen file (pen.dev convention).
      if (req.method === 'GET' && url.startsWith('/asset/')) {
        const base = path.dirname(FILE), f = path.resolve(base, url.slice(7));
        res.setHeader('content-type', MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream');
        if (f.startsWith(base + path.sep) && fs.existsSync(f)) return fs.createReadStream(f).pipe(res);
        // files made in pen.dev point at its built-in library (goodies/...): read it from the local Pen install
        const rel = url.slice(7);
        const own = rel.startsWith('goodies/') && !rel.split('/').includes('..') && library.penAppFile(`out/editor/${rel}`);
        return own ? res.end(own) : res.writeHead(404).end();
      }
      // Pena's shader library (public/shaders): listed in library.json; adding one copies it next to the .pen
      if (req.method === 'GET' && /^\/shaders\/[\w-]+\.(glsl|json)$/.test(url)) {
        res.setHeader('content-type', MIME[path.extname(url)]);
        return res.end(fs.readFileSync(path.join(ROOT, 'public', url)));
      }
      if (url === '/shader-copy' && req.method === 'POST' && FILE) {
        const name = q.get('name') ?? '';
        if (!/^[\w-]+$/.test(name) || !fs.existsSync(path.join(ROOT, 'public', 'shaders', `${name}.glsl`))) return res.writeHead(404).end('Unknown shader');
        return json({ url: saveAsset('shaders', `${name}.glsl`, fs.readFileSync(path.join(ROOT, 'public', 'shaders', `${name}.glsl`))) });
      }
      // --- dashboard / document library ---
      if (url === '/api/recent') return json({ current: FILE ?? null, recents: library.recents(), drafts: library.drafts() });
      if (url === '/api/browse') return json(library.browse(q.get('dir') || undefined));
      if (url === '/preview') {
        const f = library.previewFile(q.get('path') ?? '');
        if (!f) return res.writeHead(404).end();
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'no-cache');
        return fs.createReadStream(f).pipe(res);
      }
      if (url === '/api/open' && req.method === 'POST') {
        const { path: file } = JSON.parse(await body(req));
        if (!file.endsWith('.pen')) return res.writeHead(400).end('Escolha um arquivo .pen');
        return json({ path: open(file) });
      }
      if (url === '/api/new' && req.method === 'POST') {
        const { path: file } = JSON.parse((await body(req)) || '{}');
        return json({ path: open(file ?? library.newDraft()) });
      }
      if (url === '/api/forget' && req.method === 'POST') return library.forget(JSON.parse(await body(req)).path), res.end('ok');
      if (url === '/api/preview' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        if (FILE) library.savePreview(FILE, Buffer.concat(chunks));
        return res.end('ok');
      }
      if (url === '/fonts/faces') return json(await fonts.faces(new URL(req.url, 'http://x').searchParams.get('family') ?? ''));
      if (url.startsWith('/fonts/file/')) {
        res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(await fonts.file(url.slice('/fonts/file/'.length)));
      }
      if (!FILE && (['/doc', '/state'].includes(url) || url.startsWith('/tool/'))) return res.writeHead(409).end('No document open');
      // The raw file goes to the editor (it migrates on its side): no parse/serialize of big documents here.
      if (req.url === '/doc' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-pena-name': encodeURIComponent(path.basename(FILE)), 'x-pena-file': encodeURIComponent(FILE), 'x-pena-rev': revOf(FILE), 'cache-control': 'no-store' });
        return fs.createReadStream(FILE).pipe(res);
      }
      // Editor saves: validate, then write the text as sent (already pretty-printed by the editor). If the file
      // changed since the editor's last sync (`rev`: an agent or another app wrote it), merge instead: the roots the
      // editor changed (`changes`) on top of what is on disk. Agent writes are synchronous, so they can't interleave.
      if ((url === '/doc' && req.method === 'PUT') || (url === '/doc-beacon' && req.method === 'POST')) {
        let text = await body(req);
        const mine = JSON.parse(text), changes = q.get('changes');
        const merged = !!changes && q.get('rev') !== revOf(FILE);
        if (merged) text = JSON.stringify(mergeDocs(load(FILE), mine, JSON.parse(changes)), null, 2);
        fs.writeFileSync(FILE + '.tmp', text);
        fs.renameSync(FILE + '.tmp', FILE);
        ownWrite = fs.statSync(FILE).mtimeMs; // our own save must not bounce back as a "changed on disk" event
        return json({ rev: String(ownWrite), merged });
      }
      if (req.url === '/chat' && req.method === 'POST') {
        const msg = JSON.parse(await body(req));
        if (msg.provider === 'reset') { for (const k in main) delete main[k]; profiles.clear(); if (FILE) chats.startNew(FILE); }
        else if (msg.steer && running.size) {
          // Steer: stop the turn in progress and send this one as soon as every run has wound down (same session).
          running.forEach((c) => c.abort());
          (async () => { while (running.size) await new Promise((r) => setTimeout(r, 50)); chat(msg); })();
        } else chat(msg);
        return res.end('ok');
      }
      if (url === '/api/current') return json({ file: FILE ?? null, focusedAt });
      if (url === '/api/focus' && req.method === 'POST') return (focusedAt = Date.now()), res.end('ok'); // the app's window got focus
      // --- chat history (per open file) ---
      if (url === '/api/chats' && FILE) return json(chats.list(FILE));
      if (url === '/api/chats/current' && FILE) return json(chats.current(FILE) ?? { messages: [] });
      if (url === '/api/chats/select' && req.method === 'POST' && FILE) {
        if (running.size) return res.writeHead(409).end('Espere o agente terminar para trocar de conversa');
        const c = chats.select(FILE, JSON.parse(await body(req)).id);
        restoreSessions();
        return json(c);
      }
      if (url === '/api/chats/delete' && req.method === 'POST' && FILE) { chats.remove(FILE, JSON.parse(await body(req)).id); restoreSessions(); return json(chats.list(FILE)); }
      // --- settings (providers, MCP) ---
      if (url === '/api/settings/providers') return json(await settings.providerStatus());
      if (url === '/api/settings/probe' && req.method === 'POST') return json(await settings.probe(JSON.parse(await body(req)).provider));
      if (url === '/api/settings/login' && req.method === 'POST') return json(await settings.openLoginTerminal(JSON.parse(await body(req)).provider));
      if (url === '/api/settings/integrations' && req.method === 'GET') return json({ launch: settings.penaLaunch(), clients: settings.integrations() });
      if (url === '/api/settings/integrations' && req.method === 'POST') { const { id, on } = JSON.parse(await body(req)); return json(await settings.setIntegration(id, on)); }
      if (url === '/api/settings/integrations/test' && req.method === 'POST') {
        const { id } = JSON.parse(await body(req));
        const c = settings.integrations().find((x) => x.id === id);
        if (!c?.entry) return json({ ok: false, error: 'Não configurado' });
        return json(await settings.testMcp({ ...c.entry, env: settings.penaLaunch().env }));
      }
      if (url === '/api/settings/agent-mcp' && req.method === 'GET') return json({ text: settings.readAgentMcpText() });
      if (url === '/api/settings/agent-mcp' && req.method === 'POST') { settings.writeAgentMcpText(JSON.parse(await body(req)).text); return json({ ok: true }); }
      if (url === '/api/settings/agent-mcp/test' && req.method === 'POST') { const { name } = JSON.parse(await body(req)); const c = settings.agentMcpServers()[name]; return json(c ? await settings.testMcp(c) : { ok: false, error: 'Servidor não encontrado' }); }
      if (url === '/api/skills') return json(listSkills());
      if (url === '/api/skills/add' && req.method === 'POST') return json(addSkill(JSON.parse(await body(req)).path));
      if (url === '/api/skills/remove' && req.method === 'POST') return removeSkill(JSON.parse(await body(req)).path), res.end('ok');
      if (url.startsWith('/tool/') && req.method === 'POST') {
        const result = await callTool(tools, url.slice(6), JSON.parse((await body(req)) || '{}'));
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(result));
      }
      // Imported images live next to the document (./images/...), like pen.dev's relative image fills.
      if (url === '/upload' && req.method === 'POST') {
        const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') ?? 'image.png');
        if (/\.(glsl|frag)$/i.test(name)) return json({ url: saveAsset('shaders', name.replace(/\.frag$/i, '.glsl'), await bytes(req)) });
        if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) return res.writeHead(400).end('Only png, jpg, webp, gif and svg images, or .glsl shaders');
        return json({ url: saveImage(name, await bytes(req)) });
      }
      // Figma: a .fig file or the buffer Figma puts on the clipboard. Returns the .pen nodes of each page.
      // ?path= reads a local .fig (the desktop app's own dialog: no 250 MB upload); ?keep=1 holds the result for the
      // editor the dashboard opens next (GET /import-figma/last), since it is too big to hand over in sessionStorage.
      if (url === '/import-figma' && req.method === 'POST') {
        const file = q.get('path');
        if (file && !file.toLowerCase().endsWith('.fig')) return res.writeHead(400).end('Escolha um arquivo .fig');
        const result = importFigma(file ? fs.readFileSync(file) : await bytes(req), saveImage);
        // Lato: the document carries Figma's Lato 2.0 (./fonts/), so text measures and wraps as in Figma
        result.fonts = [];
        for (const f of result.faces.filter((f) => f.family === 'Lato')) {
          const { file: name, bytes: data } = await fonts.lato2(f.weight, f.italic).catch(() => ({}));
          if (!data) continue;
          const dir = path.join(path.dirname(FILE), 'fonts');
          fs.mkdirSync(dir, { recursive: true });
          if (!fs.existsSync(path.join(dir, name))) fs.writeFileSync(path.join(dir, name), data);
          result.fonts.push({ name: 'Lato', url: `./fonts/${name}`, weight: f.weight, style: f.italic ? 'italic' : 'normal' });
        }
        if (q.get('keep')) return (keptFigma = result), json({ pages: result.pages.length });
        return json(result);
      }
      // pen.dev's browser extension: the payload from the paste event (Chrome) or, when the webview can't see it, the OS clipboard
      if (url === '/import-browser' && req.method === 'POST') {
        const payload = (await body(req)) || (await readBrowserClipboard());
        return payload ? json(importBrowserSnapshot(payload, saveImage)) : res.writeHead(204).end();
      }
      if (url === '/import-figma/last') { const r = keptFigma; keptFigma = null; return r ? json(r) : res.writeHead(404).end(); }
      // .fig from the editor's laid-out tree; image fills are read from next to the document (or fetched).
      if (url === '/export-figma' && req.method === 'POST') {
        const { roots, thumbnail } = JSON.parse(await body(req));
        const readImage = async (u) => {
          if (/^https?:/.test(u)) return fetch(u).then((r) => (r.ok ? r.arrayBuffer() : undefined)).then((b) => b && Buffer.from(b)).catch(() => undefined);
          const f = path.resolve(path.dirname(FILE), u);
          return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
        };
        const fig = await exportFigma(roots, { name: path.basename(FILE, '.pen'), readImage, thumbnail: thumbnail && Buffer.from(thumbnail.split(',')[1], 'base64') });
        res.setHeader('content-type', 'application/zip');
        return res.end(fig);
      }
      if (url === '/state' && req.method === 'POST') return (editorState = JSON.parse(await body(req))), res.end('ok');
      if (url === '/rects' && req.method === 'POST') return (editorRects = JSON.parse(await body(req))), res.end('ok');
      if (url === '/render-result' && req.method === 'POST') {
        const { reqId, results, error } = JSON.parse(await body(req));
        const pending = renders.get(reqId);
        if (pending) renders.delete(reqId), clearTimeout(pending.timer), error ? pending.reject(new Error(error)) : pending.resolve(results);
        return res.end('ok');
      }
      if (req.url === '/models') {
        const [claude, codexModels, oc] = await Promise.allSettled([listClaudeModels(), listCodexModels(), listOpencodeModels()]);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ claude: claude.value ?? [], codex: codexModels.value ?? [], opencode: oc.value ?? [] }));
      }
      if (req.url === '/stop' && req.method === 'POST') return running.forEach((c) => c.abort()), res.end('ok');
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        clients.add(res);
        return req.on('close', () => clients.delete(res));
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(400).end(String(e.message ?? e));
    }
});

// Switch the open document (File > Open / New). Agent conversations are per document.
export function open(file) {
  file = path.resolve(file.replace(/^~(?=[\\/])/, os.homedir()));
  if (!fs.existsSync(file)) save(file, EMPTY);
  if (FILE) fs.unwatchFile(FILE);
  FILE = file;
  editorRects = {};
  restoreSessions();
  // watchFile (polling) survives the atomic rename in save(); fs.watch loses the inode.
  fs.watchFile(FILE, { interval: 250 }, (curr) => curr.mtimeMs !== ownWrite && emit('doc', {}));
  library.recordOpened(FILE);
  emit('file', { name: path.basename(FILE), path: FILE });
  return FILE;
}
export const currentFile = () => FILE;
// One entry per running server (the desktop app runs one per window); mcp.mjs reads them all.
const DISCOVERY = path.join(library.PENA_DIR, 'servers', `${process.pid}.json`);
let focusedAt = 0; // when this server's window last got focus: external agents talk to the last focused window

export function start({ file, port = 4500 } = {}) {
  if (file) open(file);
  // `port` may be a list: the first free one wins (a stable port keeps the browser's caches — compiled WASM,
  // fonts — valid across launches, since they are keyed by origin)
  const ports = [].concat(port);
  return new Promise((resolve) => {
    server.on('error', (e) => { if (e.code === 'EADDRINUSE' && ports.length > 1) { ports.shift(); server.listen(ports[0], '127.0.0.1'); } else throw e; });
    server.listen(ports[0], '127.0.0.1', () => {
      PORT = server.address().port;
      // Let external agents' MCP servers (Claude Code, Codex, ...) find the running app, like pen.dev's socket.
      fs.mkdirSync(path.dirname(DISCOVERY), { recursive: true });
      fs.writeFileSync(DISCOVERY, JSON.stringify({ url: `http://127.0.0.1:${PORT}`, pid: process.pid }));
      process.on('exit', () => fs.rmSync(DISCOVERY, { force: true }));
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(0));
      resolve(`http://127.0.0.1:${PORT}`);
    });
  });
}

if (!COMPILED && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = await start({ file: process.argv[2], port: Number(process.env.PORT ?? 4500) });
  console.log(`Pena → ${url.replace('127.0.0.1', 'localhost')}  (${FILE ?? 'dashboard'})`);
}
