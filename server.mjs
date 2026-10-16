#!/usr/bin/env node
// Pena: local design editor + embedded agents that run on YOUR subscriptions.
//   Claude -> @anthropic-ai/claude-agent-sdk reuses the `claude` CLI login (Pro/Max). No API key.
//   Codex  -> @openai/codex-sdk reuses `codex login` (ChatGPT plan). No API key.
// Both get the design tools through the same stdio MCP server (mcp.mjs), like pen.dev does.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Codex } from '@openai/codex-sdk';
import { load, save, EMPTY, systemPrompt } from './doc.mjs';
import { createTools, callTool } from './tools.mjs';
import * as library from './library.mjs';
import * as fonts from './fonts.mjs';
import { listSkills, skillContent, addSkill, removeSkill } from './skills.mjs';
import * as settings from './settings.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
let FILE; // the open .pen file; switchable at runtime (File > Open)
let ownWrite = 0; // mtime of the editor's last save
let PORT;

// Inside Electron, process.execPath is the app binary: ELECTRON_RUN_AS_NODE makes it behave as plain node.
const mcp = () => ({
  command: process.execPath,
  args: [path.join(ROOT, 'mcp.mjs')],
  env: { PENA_FILE: FILE, PENA_URL: `http://127.0.0.1:${PORT}`, ...(process.versions.electron && { ELECTRON_RUN_AS_NODE: '1' }) },
});
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
};
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
    const q = query({ prompt: (async function* () { await new Promise(() => {}); })() });
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

// Images from the chat (data URLs): Claude takes them as content blocks of a streamed user message.
const dataUrl = (d) => { const m = /^data:([^;]+);base64,(.*)$/s.exec(d); return m && { mime: m[1], b64: m[2] }; };
function claudePrompt(prompt, images = []) {
  if (!images.length) return prompt;
  const content = [
    ...images.map(dataUrl).filter(Boolean).map(({ mime, b64 }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } })),
    { type: 'text', text: prompt },
  ];
  return (async function* () { yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }; })();
}

const claudeExtraServers = () =>
  Object.fromEntries(Object.entries(settings.agentMcpServers()).map(([n, c]) => [n, c.url ? { type: c.type === 'sse' ? 'sse' : 'http', url: c.url, ...(c.headers && { headers: c.headers }) } : { command: c.command, args: c.args ?? [], ...(c.env && { env: c.env }) }]));

async function runClaude({ prompt, model, effort, images }, session, signal, say) {
  const q = query({
    prompt: claudePrompt(prompt, images),
    options: {
      cwd: path.dirname(FILE),
      mcpServers: { ...claudeExtraServers(), pena: mcp() },
      pathToClaudeCodeExecutable: settings.CLAUDE_BIN,
      // Only the design tools; everything else (Bash, Write, ...) is refused.
      canUseTool: async (name, input) =>
        name.startsWith('mcp__pena__') || Object.keys(settings.agentMcpServers()).some((s) => name.startsWith(`mcp__${s}__`))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Only the pena design tools and the MCP servers configured in Pena are available.' },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM() },
      ...(model && model !== 'default' && { model }),
      ...(effort && { effort }),
      resume: session.claude,
      abortController: signal,
    },
  });
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') (session.claude = m.session_id), say('tool', `modelo: ${m.model}`);
    if (m.type === 'assistant')
      for (const b of m.message.content) {
        if (b.type === 'text') say('text', b.text);
        if (b.type === 'tool_use') say('tool', toolLabel(b.name.replace('mcp__pena__', ''), b.input));
      }
    if (m.type === 'result' && m.subtype !== 'success') say('error', m.subtype);
  }
}

// Codex also loads every MCP server from your global ~/.codex/config.toml (e.g. pen.dev's own `pencil`), and the
// agent may call their tools instead of ours. Disable them for Pena sessions only; your config file is untouched.
const { CODEX_HOME, globalCodexServers } = settings;
// Extra MCP servers you gave Pena's agents (Settings › MCP), in Codex's config shape.
const codexServer = (c) => (c.url ? { url: c.url, ...(c.headers && { http_headers: c.headers }) } : { command: c.command, args: c.args ?? [], ...(c.env && { env: c.env }) });
let codexClient, codexKey;
const codex = () => {
  const extra = settings.agentMcpServers();
  const key = JSON.stringify(extra);
  if (codexKey !== key) codexClient = null;
  codexKey = key;
  return (codexClient ??= new Codex({
    codexPathOverride: settings.CODEX_BIN,
    config: {
      mcp_servers: {
        ...Object.fromEntries(globalCodexServers().map((name) => [name, { enabled: false }])),
        ...Object.fromEntries(Object.entries(extra).map(([n, c]) => [n, { ...codexServer(c), default_tools_approval_mode: 'approve' }])),
        pena: { ...mcp(), default_tools_approval_mode: 'approve', tool_timeout_sec: 300 },
      },
    },
  }));
};

async function runCodex({ prompt, model, effort, images = [] }, session, signal, say) {
  const options = {
    workingDirectory: path.dirname(FILE),
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    ...(model && { model }),
    ...(effort && { modelReasoningEffort: effort }),
  };
  const key = JSON.stringify(options);
  if (!session.codex) {
    session.codex = codex().startThread(options);
    prompt = `${SYSTEM()}\n\n---\n\n${prompt}`; // first turn only; codex persists the thread
  } else if (session.codexKey !== key && session.codex.id) {
    session.codex = codex().resumeThread(session.codex.id, options); // switch model/effort, keep the conversation
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
  for await (const e of events) {
    if (e.type === 'item.completed' && e.item.type === 'agent_message') say('text', e.item.text);
    if (e.type === 'item.started' && e.item.type === 'mcp_tool_call') say('tool', toolLabel(e.item.tool, e.item.arguments));
    if (e.type === 'turn.failed') say('error', e.error.message);
  }
}

const toolLabel = (name, input) => (name === 'execute' && input?.description ? input.description : name);

async function run(req, session, agent) {
  const controller = new AbortController();
  running.add(controller);
  const say = (kind, text) => emit('agent', { agent, kind, text });
  say('busy', [req.provider, req.model, req.effort].filter(Boolean).join(' · '));
  try {
    await (req.provider === 'codex' ? runCodex : runClaude)(req, session, controller, say);
  } catch (e) {
    if (!controller.signal.aborted) say('error', String(e.message ?? e));
  } finally {
    running.delete(controller);
  }
  say('done');
}

// One chat turn, shaped like pen.dev's: attached skills, the app state prefetched into the prompt, and the
// "Nx" parallel setting — split (one agent divides the work with spawn_agents) or side-by-side (N variations).
let spawnBudget = 0;
async function chat(req) {
  const { agents = 1, parallel = 'split', skills: skillNames = [] } = req;
  lastChat = req;
  let prompt = req.prompt;
  for (const name of skillNames) {
    try {
      const sk = skillContent(name);
      prompt += `\n\n<skill name="${sk.name}" source="${sk.source}">\n${sk.content}\n</skill>`;
    } catch (e) {
      emit('agent', { agent: 'main', kind: 'error', text: e.message });
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
        i === 1 ? (main[req.provider] ??= {}) : {}, i === 1 ? 'main' : `variação ${i}`);
    return;
  }
  spawnBudget = n - 1;
  if (n > 1) prompt = `Do this task by splitting the work across at most ${n - 1} extra designer agent${n > 2 ? 's' : ''} with the spawn_agents tool, besides you. Create the container frames first, spawn the agents for the other parts, then design the last part yourself.\n\n${prompt}`;
  run({ ...req, prompt }, (main[req.provider] ??= {}), 'main');
}

// spawn_agents: extra agents with the chat's provider/model/effort, each confined to its container nodes.
// Limited by the "Nx" setting; spawned agents can't spawn more (their budget is the chat's, already spent).
let spawned = 0;
function spawn(config) {
  if (spawnBudget <= 0) return 'Parallel agents are off for this request (1x). Do the whole task yourself, without spawn_agents.';
  const accepted = config.slice(0, spawnBudget);
  spawnBudget -= accepted.length;
  for (const { prompt, containerNodes } of accepted) {
    const agent = `agente ${++spawned}`;
    run(
      { ...lastChat, skills: [], prompt: `${prompt}\n\nWork ONLY inside these nodes: ${containerNodes.join(', ')}. Other agents are editing the rest of the document in parallel; never touch nodes outside your containers. Do not call spawn_agents. Remove placeholder: true from your containers when done.` },
      {},
      agent,
    );
  }
  const dropped = config.length - accepted.length;
  return `Spawned ${accepted.length} designer agent(s); they are working in parallel now. Do your own part.${dropped ? ` ${dropped} request(s) over the limit were not started — do those parts yourself.` : ''}`;
}

// --- editor bridge: selection state + rendering (screenshots/exports happen in the browser) ---
let editorState = {};
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

const tools = createTools({ file: () => FILE, render, state: () => editorState, spawn });

// --- http ------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
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
      // Image fills use paths relative to the .pen file (pen.dev convention).
      if (req.method === 'GET' && url.startsWith('/asset/')) {
        const base = path.dirname(FILE), f = path.resolve(base, url.slice(7));
        if (!f.startsWith(base + path.sep) || !fs.existsSync(f)) return res.writeHead(404).end();
        res.setHeader('content-type', MIME[path.extname(f).toLowerCase()] ?? 'application/octet-stream');
        return fs.createReadStream(f).pipe(res);
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
      // Native file dialogs when running inside the desktop app.
      if (url === '/api/dialog' && req.method === 'POST') {
        if (!process.versions.electron) return res.writeHead(404).end();
        const { dialog, BrowserWindow } = await import('electron');
        const { kind } = JSON.parse(await body(req));
        const filters = [{ name: 'Pen design', extensions: ['pen'] }];
        const win = BrowserWindow.getFocusedWindow();
        const r = kind === 'save'
          ? await dialog.showSaveDialog(win, { filters, defaultPath: path.join(os.homedir(), 'Documents', 'Sem título.pen') })
          : await dialog.showOpenDialog(win, { filters, properties: ['openFile'] });
        const file = r.canceled ? null : r.filePath ?? r.filePaths[0];
        return json({ path: file ? open(file) : null });
      }
      if (url === '/fonts/faces') return json(await fonts.faces(new URL(req.url, 'http://x').searchParams.get('family') ?? ''));
      if (url.startsWith('/fonts/file/')) {
        res.writeHead(200, { 'content-type': 'font/ttf', 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(await fonts.file(url.slice('/fonts/file/'.length)));
      }
      if (!FILE && (['/doc', '/state'].includes(url) || url.startsWith('/tool/'))) return res.writeHead(409).end('No document open');
      // The raw file goes to the editor (it migrates on its side): no parse/serialize of big documents here.
      if (req.url === '/doc' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-pena-name': encodeURIComponent(path.basename(FILE)), 'cache-control': 'no-store' });
        return fs.createReadStream(FILE).pipe(res);
      }
      // Editor saves: validate, then write the text as sent (already pretty-printed by the editor).
      // ponytail: last write wins between you and an agent editing the same moment; add revisions if that bites.
      if ((url === '/doc' && req.method === 'PUT') || (url === '/doc-beacon' && req.method === 'POST')) {
        const text = await body(req);
        JSON.parse(text);
        fs.writeFileSync(FILE + '.tmp', text);
        fs.renameSync(FILE + '.tmp', FILE);
        ownWrite = fs.statSync(FILE).mtimeMs; // our own save must not bounce back as a "changed on disk" event
        return res.end('ok');
      }
      if (req.url === '/chat' && req.method === 'POST') {
        const msg = JSON.parse(await body(req));
        if (msg.provider === 'reset') for (const k in main) delete main[k];
        else chat(msg);
        return res.end('ok');
      }
      if (url === '/api/current') return json({ file: FILE ?? null });
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
        const name = path.basename(new URL(req.url, 'http://x').searchParams.get('name') ?? 'image.png').replace(/[^\w.-]+/g, '-');
        if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(name)) return res.writeHead(400).end('Only png, jpg, webp, gif and svg images');
        const dir = path.join(path.dirname(FILE), 'images');
        fs.mkdirSync(dir, { recursive: true });
        let target = path.join(dir, name);
        for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, name.replace(/(\.\w+)$/, `-${i}$1`));
        const chunks = [];
        for await (const c of req) chunks.push(c);
        fs.writeFileSync(target, Buffer.concat(chunks));
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ url: `./images/${path.basename(target)}` }));
      }
      if (url === '/state' && req.method === 'POST') return (editorState = JSON.parse(await body(req))), res.end('ok');
      if (url === '/render-result' && req.method === 'POST') {
        const { reqId, results, error } = JSON.parse(await body(req));
        const pending = renders.get(reqId);
        if (pending) renders.delete(reqId), clearTimeout(pending.timer), error ? pending.reject(new Error(error)) : pending.resolve(results);
        return res.end('ok');
      }
      if (req.url === '/models') {
        const [claude, codexModels] = await Promise.allSettled([listClaudeModels(), listCodexModels()]);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ claude: claude.value ?? [], codex: codexModels.value ?? [] }));
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
  file = path.resolve(file.replace(/^~(?=\/)/, os.homedir()));
  if (!fs.existsSync(file)) save(file, EMPTY);
  if (FILE) fs.unwatchFile(FILE);
  FILE = file;
  for (const k in main) delete main[k];
  // watchFile (polling) survives the atomic rename in save(); fs.watch loses the inode.
  fs.watchFile(FILE, { interval: 250 }, (curr) => curr.mtimeMs !== ownWrite && emit('doc', {}));
  library.recordOpened(FILE);
  emit('file', { name: path.basename(FILE), path: FILE });
  return FILE;
}
export const currentFile = () => FILE;
const DISCOVERY = path.join(library.PENA_DIR, 'server.json');

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
      fs.mkdirSync(library.PENA_DIR, { recursive: true });
      fs.writeFileSync(DISCOVERY, JSON.stringify({ url: `http://127.0.0.1:${PORT}`, pid: process.pid }));
      process.on('exit', () => { try { if (JSON.parse(fs.readFileSync(DISCOVERY, 'utf8')).pid === process.pid) fs.rmSync(DISCOVERY); } catch {} });
      for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => process.exit(0));
      resolve(`http://127.0.0.1:${PORT}`);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = await start({ file: process.argv[2], port: Number(process.env.PORT ?? 4500) });
  console.log(`Pena → ${url.replace('127.0.0.1', 'localhost')}  (${FILE ?? 'dashboard'})`);
}
