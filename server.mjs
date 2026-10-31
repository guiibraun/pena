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
import { save, EMPTY, systemPrompt, readSkill } from './doc.mjs';
import { createStore } from './store.mjs';
import { createTools, callTool } from './tools.mjs';
import * as library from './library.mjs';
import * as fonts from './fonts.mjs';
import * as chats from './chats.mjs';
import { planHandoff, readChat } from './handoff.mjs';
import { createLimiter } from './limiter.mjs';
import { listSkills, skillContent, addSkill, removeSkill } from './skills.mjs';
import * as settings from './settings.mjs';
import { importFigma, exportFigma } from './figma.mjs';
import { readBrowserClipboard, importBrowserSnapshot } from './browser-import.mjs';
import { ROOT, COMPILED } from './root.mjs';

let keptFigma = null; // a dashboard Figma import waiting for the editor
let FILE; // the open .pen file; switchable at runtime (File > Open)
// The open document lives in memory: the editor, the agents and the file watcher all go through the store, which
// writes the file behind them and announces what changed (SSE `patch`).
const store = createStore({ onPatch: (p) => emit('patch', p), onExternal: () => emit('doc', {}), onSaveError: (message) => emit('save-error', { message }) });
let PORT;

const mcp = (agent, conv) => {
  const { command, args, env } = settings.penaLaunch();
  return { command, args, env: { ...env, PENA_FILE: FILE, PENA_URL: `http://127.0.0.1:${PORT}`, ...(agent && { PENA_AGENT: agent }), ...(conv && { PENA_CONV: conv }) } };
};
// Re-read per session so edits to skills/ apply without restarting.
// Group instructions go after the stable part, so every chat and group still shares the same cached prefix.
const groupBlock = (g) => (g?.brief ? `\n\nShared context for every chat in the group "${g.name}". Follow it in this chat:\n${g.brief}` : '');
const SYSTEM = (group) => `You are a product designer working inside Pena, a visual design tool.
You run inside the Pena app, in this chat: the user is already in Pena and sees the canvas. Never ask them to open Pena, reconnect the MCP or start a new chat. If your tool list has no pena tools, say that in one line and stop: Pena notices it and starts a new session on the next message.
Design only through the pena MCP tools (get_app_state, execute, read_skill, spawn_agents); never edit .pen files directly.
You may read the code of the project the .pen file belongs to, to match the real app, and change it when the user asks or the design needs it: use whatever file and search tools you have (or shell commands). Secrets such as .env files and keys are unreadable and can't be changed.
Reply in the user's language with one or two short sentences about what you did.

The pena skill is loaded below. Read guide files with read_skill when the task matches them.

${systemPrompt()}${groupBlock(group)}`;
// Codex and OpenCode only get SYSTEM() on their first turn, and their thread survives edits to the group. When the
// group changed since the thread last saw it, the next turn carries the new text instead of silently keeping the old.
const groupKey = (g) => (g?.brief ? `${g.id}\n${g.brief}` : '');
const groupSync = (g) => (g?.brief
  ? `The shared group context for this chat changed ("${g.name}"). It applies from now on:\n${g.brief}`
  : 'The shared group context for this chat was removed. Ignore any group instructions from earlier turns.');
const groupFor = (conv) => (conv ? chats.groupOf(FILE, conv) : null);

// --- server-sent events: document changes + agent stream ---------------------------------
const clients = new Set();
const emit = (event, data) => {
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  if (event === 'agent') remember(data);
};
// Chat history keeps finished items only (streaming sends many partial updates of the same text/card).
const toolParts = new Map(); // tool card id -> merged updates until it finishes
function remember(d) {
  const st = d.conv && liveChats.get(d.conv);
  const file = st?.file ?? FILE;
  if (!file) return;
  const keep = (m) => chats.append(file, m, d.conv);
  if (d.kind === 'text' || d.kind === 'thinking') { if (d.done) keep(d); return; }
  if (d.kind === 'tool') {
    const known = toolParts.has(d.id);
    const t = { ...toolParts.get(d.id), ...d };
    if (d.status !== 'done' && d.status !== 'error') {
      toolParts.set(d.id, t);
      // keep the card as soon as it starts, so another chat switched to mid-run shows what the agent is doing
      if (!known) keep({ ...t, images: t.images?.length ?? 0 });
      return;
    }
    toolParts.delete(d.id);
    const input = t.input && typeof t.input === 'object' ? Object.fromEntries(Object.entries(t.input).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 8000) : v])) : t.input;
    return keep({ ...t, input, images: t.images?.length ?? 0, output: String(t.output ?? '').slice(0, 4000) });
  }
  if (['start', 'model', 'end', 'todos', 'error', 'handoff'].includes(d.kind)) keep(d);
}
// Conversations are independent: each keeps its own agent sessions, running turns and agent names. A chat that is
// still working in the background keeps receiving its events into its own history after the user switches away.
const liveChats = new Map(); // conversation id -> runtime state
// Agent CLIs running at once per chat (each is a ~300 MB process); the rest of a 5x/8x request waits its turn.
// ponytail: per chat, so a busy background chat never queues the one you are typing in; make it module-level for a global cap.
const MAX_PARALLEL_AGENTS = 3;
function stateOf(id, file = FILE) {
  if (!id) return null;
  let st = liveChats.get(id);
  if (st) return st;
  const c = file && chats.byId(file, id);
  st = {
    id, file, main: {}, profiles: new Map(), running: new Set(), active: new Map(), // active: agents working now (the UI restores them on switch)
    lastChat: { provider: 'claude' }, spawnBudget: 0, split: null, variations: null, picked: null,
    slots: createLimiter(MAX_PARALLEL_AGENTS),
  };
  const s = c?.sessions ?? {};
  for (const [pid, v] of Object.entries(s)) {
    const provider = settings.accountOf(pid)?.provider;
    if (!provider || !v) continue;
    // OpenCode keeps the tool list a session was created with, and a saved session always comes from an earlier app
    // process (this one never wrote it). If that process's MCP server was down when the session was born, resuming it
    // keeps the agent tool-less forever. Start a new session instead: the handoff gives it the whole conversation.
    if (provider === 'opencode') continue;
    st.main[pid] = provider === 'codex' ? { codexId: v } : { claude: v };
  }
  // the chat's agents keep their names and colors, so a new agent never reuses one (handoffs name who did what)
  for (const m of c?.messages ?? []) if (m.kind === 'start' && m.agent) {
    const p = { name: m.agent, color: m.color };
    st.profiles.set(p.name, p);
    if (!m.parent && !(m.variation > 1) && st.main[m.provider ?? 'claude']) st.main[m.provider ?? 'claude'].profile = p;
  }
  liveChats.set(id, st);
  return st;
}
const currentState = () => (FILE ? stateOf(chats.current(FILE)?.id) : null);
const runningInfo = (id) => [...(liveChats.get(id)?.active.values() ?? [])];
// The main chat's agent sessions, saved with their conversation so a reopened chat resumes with its context.
// Keyed by provider id, which is the account id for extra accounts.
const saveSessions = (st) => st?.file && chats.setSessions(st.file, Object.fromEntries(Object.entries(st.main).map(([id, s]) => [id, s.claude ?? s.codex?.id ?? s.codexId ?? s.opencode]).filter(([, v]) => v)), st.id);
// watchFile (polling) survives the atomic rename in save(); fs.watch loses the inode.

// --- agents ----------------------------------------------------------------------------------
// `st.main` holds each provider's session for one conversation; spawn_agents adds parallel ones.

// --- model catalogs: read from your own accounts, never hardcoded (pen.dev ships fixed lists) ---
// Claude: the SDK asks the logged-in CLI which models your plan has, and which efforts each supports.
// One catalog per account: an extra account that isn't logged in yet borrows the default account's list, so it
// still shows up in the picker (and its "not logged in" error is what the user gets when they pick it).
const claudeModels = new Map();
// "Opus" → "Opus 5.5" and "Default (recommended)" → "… · Opus 5.5": a logged-out CLI and the default row name the
// alias, not the model it runs. resolvedModel says which.
const claudeModelName = (m) => {
  const v = m.resolvedModel?.replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  if (!v || /\d/.test(m.displayName)) return m.displayName;
  const resolved = `${v[0][0].toUpperCase()}${v[0].slice(1)} ${v.slice(1).join('.')}`.trim();
  return m.value === 'default' ? `${m.displayName} · ${resolved}` : resolved;
};
const listClaudeModels = (acc) => {
  if (claudeModels.has(acc.id)) return claudeModels.get(acc.id);
  const fallback = () => (acc.id === 'claude' ? Promise.reject(new Error('Claude não conectado')) : listClaudeModels(settings.accountOf('claude')));
  const p = (async () => {
    // the CLI you installed: the compiled app has no node_modules for the SDK to find its own copy in
    const q = query({ prompt: (async function* () { await new Promise(() => {}); })(), options: { pathToClaudeCodeExecutable: settings.CLAUDE_BIN, env: settings.accountEnv(acc) } });
    let timer;
    const timeout = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error('Tempo esgotado (20 s)')), 20000)));
    try {
      const models = await Promise.race([q.supportedModels(), timeout]);
      return models.map((m) => ({ id: m.value, name: claudeModelName(m), efforts: m.supportedEffortLevels ?? [], defaultEffort: 'high' }));
    } finally {
      clearTimeout(timer);
      q.close();
    }
  })().catch((e) => { claudeModels.delete(acc.id); return fallback(); });
  claudeModels.set(acc.id, p);
  return p;
};

// Codex: the CLI caches your account's model list (with per-model reasoning levels) after `codex login`.
function listCodexModels(acc) {
  const cache = path.join(acc.env.CODEX_HOME ?? CODEX_HOME, 'models_cache.json');
  if (!fs.existsSync(cache)) return acc.id === 'codex' ? [] : listCodexModels(settings.accountOf('codex'));
  return JSON.parse(fs.readFileSync(cache, 'utf8'))
    .models.filter((m) => m.visibility === 'list')
    .map((m) => ({
      id: m.slug,
      name: m.display_name,
      efforts: (m.supported_reasoning_levels ?? []).map((l) => l.effort),
      defaultEffort: m.default_reasoning_level,
    }));
}

// OpenCode: `opencode api model.list` returns every model of the providers you logged into, as JSON.
// Variants are its reasoning levels. Only models that can call tools can design.
let opencodeModels;
const listOpencodeModels = () =>
  (opencodeModels ??= new Promise((ok, fail) =>
    execFile(settings.OPENCODE_BIN, ['api', 'model.list'], { maxBuffer: 256 << 20, timeout: 60000 }, (err, out) => {
      if (err) return (opencodeModels = undefined), fail(err);
      try {
        ok(JSON.parse(out).data
          .filter((m) => m.capabilities?.tools && m.enabled !== false && m.status !== 'deprecated')
          .map((m) => ({ id: `${m.providerID}/${m.id}`, name: `${m.name} · ${m.providerID}`, efforts: (m.variants ?? []).map((v) => v.id), defaultEffort: undefined })));
      } catch (e) { (opencodeModels = undefined), fail(e); }
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

// Every agent may read and change the code of the project the .pen belongs to (its git root, else its folder), like
// pen.dev's agents, but never touch its secrets nor the ones in your home folder.
const projectRoot = (dir) => {
  let root = dir;
  try { root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() || dir; } catch {}
  return fs.realpathSync(root); // the sandboxes match real paths (/private/var, not /var)
};
const SECRETS = ['.env', '.env.*', '*.key', '*.pem', '*.p12'];
const HOME_SECRETS = ['.ssh', '.aws', '.gnupg', '.config', '.netrc', '.docker', '.kube', '.pena/mcp.json'].map((d) => path.join(os.homedir(), d));
// Searching the code needs Bash (Claude Code has no Grep/Glob tools anymore). It only runs inside the OS sandbox
// (macOS seatbelt): no network, writes only in the project, secrets untouchable. Elsewhere the agent gets no Bash.
const SANDBOXED_BASH = process.platform === 'darwin';
const secrets = (root) => SECRETS.flatMap((p) => [`${root}/${p}`, `${root}/**/${p}`]);
const inside = (p, dir) => { const r = path.relative(dir, path.resolve(dir, String(p))); return !r.startsWith('..') && !path.isAbsolute(r); };

async function runClaude({ prompt, model, effort, images, docs, provider }, session, signal, say, agent, conv) {
  const cwd = path.dirname(FILE), root = projectRoot(cwd);
  const q = query({
    prompt: claudePrompt(prompt, images, docs),
    options: {
      cwd,
      env: settings.accountEnv(settings.accountOf(provider) ?? { env: {} }),
      additionalDirectories: [root, ATTACH_DIR],
      // deny rules beat every allow, so the file tools never open a secret (Edit rules also cover Write)
      disallowedTools: ['Read', 'Edit'].flatMap((t) => [...SECRETS.map((p) => `${t}(//**/${p})`), ...HOME_SECRETS.flatMap((d) => [`${t}(/${d})`, `${t}(/${d}/**)`])]),
      ...(SANDBOXED_BASH && {
        sandbox: {
          enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
          // seatbelt needs absolute paths: a bare **/.env pattern doesn't match
          filesystem: { allowWrite: [root], denyRead: [...secrets(root), ...HOME_SECRETS], denyWrite: [...secrets(root), FILE] },
        },
      }),
      mcpServers: { ...claudeExtraServers(), pena: mcp(agent, conv) },
      pathToClaudeCodeExecutable: settings.CLAUDE_BIN,
      includePartialMessages: true, // token-by-token text, thinking and tool input, like pen.dev's chat
      // The design tools plus the project's files; everything else is refused.
      canUseTool: async (name, input) =>
        name.startsWith('mcp__pena__') || Object.keys(settings.agentMcpServers()).some((s) => name.startsWith(`mcp__${s}__`)) ||
        name === 'WebSearch' || name === 'WebFetch' || name === 'TodoWrite' || // research and the agent's plan
        (name === 'Bash' && SANDBOXED_BASH) ||
        (name === 'Read' && [root, ATTACH_DIR].some((d) => inside(input.file_path ?? '', d))) ||
        (['Edit', 'Write', 'NotebookEdit'].includes(name) && inside(input.file_path ?? input.notebook_path ?? '', root) && !/\.pen$/i.test(input.file_path ?? ''))
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: `Only the pena design tools, web search/fetch, the MCP servers configured in Pena, attached files and the project at ${root} (no secrets, no .pen files) are available.` },
      systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM(groupFor(conv)) },
      ...(model && model !== 'default' && { model }),
      ...(effort && { effort }),
      resume: session.claude,
      abortController: signal,
    },
  });
  let msgId = '';
  const blocks = new Map(); // stream index -> block being streamed
  for await (const m of q) {
    if (m.type === 'system' && m.subtype === 'init') {
      (session.claude = m.session_id), say('model', { model: m.model });
      // the design tools come from a child process: if it did not start, this turn cannot edit the file at all
      const pena = m.mcp_servers?.find((s) => s.name === 'pena');
      if (pena && ['failed', 'needs-auth'].includes(pena.status)) {
        await q.reconnectMcpServer('pena').catch(() => {});
        q.close();
        throw new Error(`As ferramentas de design não conectaram nesta sessão (pena: ${pena.status}).`);
      }
    }
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
// Codex reads the whole disk and writes in the project (additionalDirectories); this permission profile also makes
// the secrets untouchable by its sandbox.
// It goes in as raw TOML: the SDK's `config` splits keys on dots, which breaks path keys like `/x/**/.env`.
// Windows keeps the plain workspace-write sandbox (no deny globs there).
const CODEX_PROFILE = process.platform !== 'win32';
const codexPermissions = (root) => {
  const deny = [...SECRETS.map((p) => `${root}/**/${p}`), ...HOME_SECRETS].map((p) => `${JSON.stringify(p)} = "deny"`);
  return ['default_permissions="pena"', 'permissions.pena.extends=":workspace"', `permissions.pena.filesystem={glob_scan_max_depth = 8, ${deny.join(', ')}}`];
};
// One client per agent name: the pena MCP server tells the app which agent made each edit (canvas cursors).
const codexClients = new Map();
const codex = (agent, root, acc, conv) => {
  const extra = settings.agentMcpServers();
  const key = JSON.stringify([extra, agent, root, acc.id, conv]);
  if (codexClients.has(key)) return codexClients.get(key);
  const globals = globalCodexServers(acc.env.CODEX_HOME);
  const client = (new Codex({
    codexPathOverride: settings.CODEX_BIN,
    env: settings.accountEnv(acc),
    ...(CODEX_PROFILE && { configOverrides: codexPermissions(root) }),
    config: {
      mcp_servers: {
        ...Object.fromEntries(globals.map((name) => [name, { enabled: false }])),
        // a server you also have in config.toml gets its own name: Codex merges same-named entries (url + command fails)
        ...Object.fromEntries(Object.entries(extra).map(([n, c]) => [globals.includes(n) ? `${n}-pena` : n, { ...codexServer(c), default_tools_approval_mode: 'approve' }])),
        pena: { ...mcp(agent, conv), default_tools_approval_mode: 'approve', tool_timeout_sec: 300 },
      },
    },
  }));
  codexClients.set(key, client);
  return client;
};

async function runCodex({ prompt, model, effort, images = [], provider }, session, signal, say, agent, conv) {
  const root = projectRoot(path.dirname(FILE));
  const acc = settings.accountOf(provider) ?? { id: 'codex', env: {} };
  const options = {
    workingDirectory: path.dirname(FILE),
    skipGitRepoCheck: true,
    additionalDirectories: [root], // the git root may be above the .pen's folder
    ...(!CODEX_PROFILE && { sandboxMode: 'workspace-write' }), // the profile already sets it; Codex refuses both
    webSearchMode: 'live', // research on the web, like Claude's WebSearch
    approvalPolicy: 'never',
    ...(model && { model }),
    ...(effort && { modelReasoningEffort: effort }),
  };
  const key = JSON.stringify(options);
  const group = groupFor(conv), gkey = groupKey(group);
  if (!session.codex && session.codexId) {
    session.codex = codex(agent, root, acc, conv).resumeThread(session.codexId, options); // conversation restored from the chat history
  } else if (!session.codex) {
    session.codex = codex(agent, root, acc, conv).startThread(options);
    prompt = `${SYSTEM(group)}\n\n---\n\n${prompt}`; // first turn only; codex persists the thread
    session.group = gkey;
  } else if (session.codexKey !== key && session.codex.id) {
    session.codex = codex(agent, root, acc, conv).resumeThread(session.codex.id, options); // switch model/effort, keep the conversation
  }
  session.codexKey = key;
  if (session.group !== gkey) { prompt = `${groupSync(group)}\n\n---\n\n${prompt}`; session.group = gkey; }
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

// OpenCode (v2): one `opencode run --standalone --format json` per turn, resumed by session id. --standalone runs a
// private server, so the config in OPENCODE_CONFIG_CONTENT (merged over yours, your files untouched) applies; the
// background service would ignore it. Pena's MCP server, your global MCP servers off, and every other tool on "ask",
// which `opencode run` rejects by itself. Not "deny" for all: that drops the tools from the request, and OpenCode
// Zen's free models refuse requests without its own tools. Since OpenCode 2.1 an MCP server with codemode off never
// reaches the model, so Pena's tools live in CodeMode's catalog (tools.pena.*, called from its `execute` tool), and a
// bare { disabled: true } is skipped as malformed: it needs a type and command to apply.
async function runOpencode({ prompt, model, effort, images = [] }, session, signal, say, agent, conv) {
  const extra = settings.agentMcpServers();
  const server = (c) => ({ ...(c.url ? { type: 'remote', url: c.url, ...(c.headers && { headers: c.headers }) } : { type: 'local', command: [c.command, ...(c.args ?? [])], ...(c.env && { environment: c.env }) }) });
  const { command, args, env } = mcp(agent, conv);
  const rule = (action, resource, effect) => ({ action, resource, effect });
  const config = {
    mcp: {
      servers: {
        ...Object.fromEntries(settings.globalOpencodeServers().map((n) => [n, { type: 'local', command: ['true'], disabled: true }])),
        ...Object.fromEntries(Object.entries(extra).map(([n, c]) => [n, server(c)])),
        pena: { ...server({ command, args, env }), timeout: { catalog: 30000, execution: 300000 } },
      },
    },
    // last matching rule wins
    permissions: [
      rule('*', '*', 'ask'),
      ...['pena_*', ...Object.keys(extra).map((n) => `${n}_*`), 'webfetch', 'websearch', 'todowrite'].map((a) => rule(a, '*', 'allow')),
      // the project's files. shell stays off (unsandboxed) and grep too: its rules match the search pattern, not the
      // files, so it would print .env contents. Searching is glob + read (which also lists folders).
      rule('read', '*', 'allow'), rule('glob', '*', 'allow'), rule('grep', '*', 'deny'), rule('edit', '*', 'allow'), rule('edit', '*.pen', 'deny'),
      rule('external_directory', `${ATTACH_DIR}/*`, 'allow'), // the project itself is the workspace (cwd), not external
      ...['read', 'edit'].flatMap((a) => [
        ...SECRETS.map((p) => rule(a, p.startsWith('*') ? p : `*${p}`, 'deny')),
        ...HOME_SECRETS.flatMap((d) => [rule(a, d, 'deny'), rule(a, `${d}/*`, 'deny')]),
      ]),
      ...HOME_SECRETS.map((d) => rule('external_directory', `${d}/*`, 'deny')),
    ],
  };
  const group = groupFor(conv), gkey = groupKey(group);
  if (!session.opencode) { prompt = `${SYSTEM(group)}\n\n---\n\n${prompt}`; session.group = gkey; } // first turn only; opencode keeps the session
  if (session.group !== gkey) { prompt = `${groupSync(group)}\n\n---\n\n${prompt}`; session.group = gkey; }
  prompt += `\n\nIn this session the pena tools are in the catalog of your \`execute\` (code) tool: call them from code as \`await tools.pena.get_app_state()\`, \`await tools.pena.execute({ description, input })\`, \`tools.pena.read_skill(...)\`. They connect a moment after the turn starts: if the first call says "Unknown tool", make the same call again.`;
  const files = images.map(dataUrl).filter(Boolean).map(({ mime, b64 }, i) => {
    const f = path.join(os.tmpdir(), `pena-${Date.now()}-${i}.${mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'}`);
    fs.writeFileSync(f, Buffer.from(b64, 'base64'));
    return f;
  });
  const argv = ['run', '--standalone', '--format', 'json', '--thinking',
    ...(session.opencode ? ['-s', session.opencode] : []), ...(model ? ['-m', effort ? `${model}#${effort}` : model] : []), // provider/model#variant
    ...files.flatMap((f) => ['-f', f]), '--', prompt];
  // opencode takes its workspace from PWD, not the process cwd; real path, or symlinked files look external
  const dir = fs.realpathSync(path.dirname(FILE));
  const child = spawnProcess(settings.OPENCODE_BIN, argv, { cwd: dir, env: { ...process.env, PWD: dir, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe'], signal: signal.signal });
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
    else if (e.type === 'tool_use') {
      const err = p.state?.status === 'error' ? String(p.state?.error?.message ?? p.state?.error ?? '') : '';
      // A session created while the design-tool server was down keeps that tool list forever: every call comes back
      // "No tool named pena_execute". Fail the turn here so runTurn retries it on a fresh session.
      if (!failure && NO_TOOL.test(err) && /pena/i.test(`${p.tool} ${err}`)) {
        failure = new Error(`As ferramentas de design não conectaram nesta sessão (${err.slice(0, 160)})`);
        child.kill();
      }
      // CodeMode's execute runs a script that calls the MCP tools: name the card after the one pena tool it calls
      const script = p.tool === 'execute' && typeof p.state?.input?.code === 'string' ? p.state.input.code : null;
      const called = script && [...new Set([...script.matchAll(/tools\.pena\.(\w+)/g)].map((m) => m[1]))];
      const name = script ? (called.length === 1 ? called[0] : 'code') : p.tool.replace(/^pena_/, '');
      say('tool', { id: p.callID, name, input: script ? { input: script } : p.state?.input, status: p.state?.status === 'error' ? 'error' : p.state?.status === 'completed' ? 'done' : 'running', output: String(p.state?.output ?? p.state?.error ?? '').slice(0, 4000) });
    }
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
const newProfile = (st) => {
  const nameOf = (i) => AGENT_NAMES[i % AGENT_NAMES.length] + (i >= AGENT_NAMES.length ? ` ${Math.floor(i / AGENT_NAMES.length) + 1}` : '');
  let i = st.profiles.size;
  while (st.profiles.has(nameOf(i))) i++; // names restored from the chat may not be the first ones
  const p = { name: nameOf(i), color: AGENT_COLORS[i % AGENT_COLORS.length] };
  st.profiles.set(p.name, p);
  return p;
};
const profileOf = (name) => {
  for (const st of liveChats.values()) if (st.profiles.has(name)) return st.profiles.get(name);
};

// One agent run. Events go to the editor as `agent` SSE messages: start, model, text/thinking (accumulated text,
// streamed), tool (card updates by id), todos, end (reason, duration, usage). Streaming updates are throttled.
// `st` is the conversation the run belongs to; its events carry the conversation id so other chats ignore them.
async function run(req, session, st, { parent, variation, handoff } = {}) {
  if (!session.profile || !st.profiles.has(session.profile.name)) session.profile = newProfile(st);
  const profile = session.profile, agent = profile.name;
  const controller = new AbortController();
  st.running.add(controller);
  const last = new Map(), pending = new Map();
  const send = (kind, data) => emit('agent', { conv: st.id, agent, color: profile.color, kind, ...data });
  // did this turn actually design? and what did the agent say last? (a session without the design tools only talks)
  let designed = false, said = '';
  const say = (kind, data, throttleKey = null) => {
    if (kind === 'tool' && isDesignTool(data?.name)) designed = true;
    if (kind === 'text' && data?.text) said = String(data.text).slice(-2000);
    if (!throttleKey) { if (data?.id) clearTimeout(pending.get(data.id)), pending.delete(data.id); return send(kind, data); }
    const wait = 60 - (Date.now() - (last.get(throttleKey) ?? 0));
    clearTimeout(pending.get(throttleKey));
    if (wait <= 0) return last.set(throttleKey, Date.now()), send(kind, data);
    pending.set(throttleKey, setTimeout(() => (last.set(throttleKey, Date.now()), send(kind, data)), wait));
  };
  let t0 = Date.now();
  if (handoff) send('handoff', handoff);
  const acc = settings.accountOf(req.provider ?? 'claude'), label = acc?.name;
  // over the chat's parallel limit the run waits (shown as queued until its CLI reports the model); stop cancels it
  const queued = st.slots.full;
  const info = { agent, color: profile.color, model: req.model, provider: req.provider, parent, t0, queued };
  st.active.set(agent, info);
  send('start', { provider: req.provider, label, model: req.model, effort: req.effort, parent, variation, queued });
  let end = { reason: 'finished' }, release;
  try {
    if (!acc) throw new Error('Esta conta foi removida. Escolha outro modelo no seletor.');
    release = await st.slots.acquire(controller.signal);
    info.queued = false;
    info.t0 = t0 = Date.now();
    await ({ codex: runCodex, opencode: runOpencode }[acc.provider] ?? runClaude)(req, session, controller, say, agent, st.id);
  } catch (e) {
    const message = String(e.message ?? e);
    end = controller.signal.aborted ? { reason: 'stopped' } : { reason: 'failed', message, provider: req.provider, ...(TOOLS_DOWN.test(message) && { tools: true }) };
  } finally {
    release?.();
    st.running.delete(controller);
    st.active.delete(agent);
  }
  for (const t of pending.values()) clearTimeout(t);
  chats.closeTools(st.file, st.id, agent);
  if (Object.values(st.main).includes(session)) saveSessions(st);
  // A session that never had the design tools answers in prose ("I can't edit the file") and the turn looks fine.
  // Treat that as a failed turn so runTurn retries it on a fresh session, which loads the tools.
  if (end.reason === 'finished' && !designed && TOOLS_DOWN_TEXT.test(said)) end = { reason: 'failed', message: said.slice(0, 400), provider: req.provider, tools: true };
  send('end', { ...end, ms: Date.now() - t0, usage: session.usage, variation });
  session.usage = null;
  return end;
}

// The attached skills, appended to a prompt: the chat's own agent gets them, and so does every agent it spawns.
// The composer's "states and flows" switches: the guide rides along with the message (and with spawned agents).
// Drawing states always links them too, whatever the client sent.
function designRules({ states, flows } = {}) {
  if (!states && !flows) return '';
  const on = states
    ? 'ON for this message: "Draw states" and "Link screens". Draw the interactive states of everything you design, and link every trigger to the screen or state it opens with connections.'
    : 'ON for this message: "Link screens". Link every trigger to the screen it opens with connections. Draw extra state variants only if the user asks.';
  return `\n\n<design-rules>\nThe user turned these rules ${on} Follow the guide below.\n\n${readSkill('guide/states-and-flows.md')}\n</design-rules>`;
}

function withSkills(prompt, names = [], conv) {
  for (const name of names) {
    try {
      const sk = skillContent(name);
      prompt += `\n\n<skill name="${sk.name}" source="${sk.source}">\n${sk.content}\n</skill>`;
    } catch (e) {
      emit('agent', { conv, agent: 'Pena', kind: 'error', text: e.message });
    }
  }
  return names.length ? `${prompt}\n\nFollow the attached skill${names.length > 1 ? 's' : ''} (${names.join(', ')}) for this request.` : prompt;
}

// Context handoff (handoff.mjs): each provider's session only saw its own turns, so before a turn it gets what it
// missed of the chat. A session its CLI no longer has (the .pen moved, the CLI's history was cleaned) is replaced
// once by a new one that gets the whole conversation, like T3 Code's fallback.
const nativeOf = (provider, s) => (provider === 'codex' ? s.codex?.id ?? s.codexId : provider === 'opencode' ? s.opencode : s.claude);
const GONE = /no (conversation|session|thread) found|\b(conversation|session|thread)\b[^\n]{0,40}\bnot found/i;
// the design tools did not load: a new session is what makes the CLI pick them up again
const TOOLS_DOWN = /ferramentas de design|pena MCP|mcp__pena|server process exited|não (está|foi) carregad|not loaded/i;
// OpenCode's answer when the session never had the tool (it is not in that session's catalog)
const NO_TOOL = /no tool named|is currently available|not available/i;
// tools that only exist while the design-tool server is up (names arrive as mcp__pena__execute, pena_execute, pena.execute)
const isDesignTool = (name) => /^(execute|get_app_state|read_skill|spawn_agents|get_node|read_chat)$/.test(String(name ?? '').split(/[.:]/).pop());
// a reply that says it could not use the design tools: the session's catalog never had them
const TOOLS_DOWN_TEXT = new RegExp([
  'ferramentas?[^.\\n]{0,50}(n[ãa]o (est[ãa]o|est[áa]|foram|consegui|consigo|tenho|vejo)|fora do cat[áa]logo|indispon[íi]ve|sem acesso)',
  'ferramentas? (do|da|de) (pena|design|canvas)[^.\\n]{0,40}(n[ãa]o (est[ãa]o|est[áa]|foram|tenho|consigo)|sem |indispon|fora)',
  '(sem|n[ãa]o tenho|n[ãa]o vejo)[^.\\n]{0,40}ferramentas?',
  '(no|don.t have|do not have|without|missing)[^.\\n]{0,40}(pena|design) tools?',
  '(pena|design) tools?[^.\\n]{0,40}(not|no|missing|unavailable)',
  'pena_execute[^.\\n]{0,60}(n[ãa]o|fora|indispon)',
  'pena[^.\\n]{0,40}n[ãa]o est[áa] registrad',
  'no tool named',
].join('|'), 'i');
const handoffFor = (req, session, until, replaced = false, st = currentState()) => {
  const messages = (st?.file && chats.byId(st.file, st.id)?.messages) || [];
  return planHandoff({ messages, until: Math.min(until, messages.length), provider: req.provider ?? 'claude', model: req.model, label: settings.accountOf(req.provider ?? 'claude')?.name, fresh: !nativeOf(req.provider, session), replaced });
};
async function runTurn(req, session, until, st, opts = {}, replaced = false) {
  const handoff = handoffFor(req, session, until, replaced, st);
  const end = await run(handoff ? { ...req, prompt: `${handoff.text}\n\nUser message:\n${req.prompt}` } : req, session, st, { ...opts, handoff });
  const down = end.reason === 'failed' && (end.tools || TOOLS_DOWN.test(end.message ?? ''));
  if (replaced || end.reason !== 'failed' || !nativeOf(req.provider, session) || !(GONE.test(end.message ?? '') || down)) return end;
  if (down) mcpCheck().catch(() => {}); // say it in the UI while the new session starts
  for (const k of ['claude', 'codex', 'codexId', 'codexKey', 'opencode']) delete session[k];
  return runTurn(req, session, until, st, opts, true);
}

// One chat turn, shaped like pen.dev's: attached skills, the app state prefetched into the prompt, and the
// "Nx" parallel setting — split (one agent divides the work with spawn_agents) or side-by-side (N variations).
// `id` pins the conversation: a turn queued behind a stop must land in the chat it was typed in.
async function chat(req, id) {
  if (!FILE) return;
  const conv = (id && chats.byId(FILE, id)) || chats.current(FILE, { create: true });
  const st = stateOf(conv.id);
  const { agents = 1, parallel = 'split', skills: skillNames = [] } = req;
  chats.append(FILE, { kind: 'user', text: req.shown ?? req.prompt, files: (req.files ?? []).map((f) => f.name), images: (req.images ?? []).length, context: req.context ?? null, skills: req.skills ?? [] }, conv.id);
  const until = conv.messages.length - 1; // this turn's user message: handoffs cover what came before
  const attached = attachFiles(req.files);
  let prompt = withSkills((st.picked ? `${st.picked}\n\n` : '') + req.prompt + attached.text, skillNames, st.id) + designRules(req);
  st.picked = null;
  req = { ...req, files: undefined, docs: attached.docs };
  st.lastChat = { ...req, prompt: req.prompt + attached.text, docs: undefined }; // spawned agents get the text (in their prompts), not the PDFs again
  try {
    const [state] = await tools.get_app_state();
    prompt += `\n\nYou are inside the Pena app, in this chat: the user is already here, looking at the canvas.\nCurrent app state (fetched right before this turn; no need to call get_app_state first):\n${state.text}`;
  } catch {}
  const n = Math.max(1, Math.min(8, Number(agents) || 1));
  if (n > 1 && parallel === 'side-by-side') {
    st.spawnBudget = 0;
    st.split = null;
    st.variations = { before: new Set(store.doc.children.map((c) => c.id)), list: [] };
    for (let i = 1; i <= n; i++) {
      const session = i === 1 ? (st.main[req.provider] ??= {}) : {};
      runTurn({ ...req, prompt: `${prompt}\n\nYou are designer ${i} of ${n} working at the same time on this same request; each creates an independent VARIATION. Make your own top-level frame named with " — Variação ${i}" at FindEmptySpace (other designers are placing theirs too), explore a direction distinct from a typical solution, and never touch other designers' frames.` },
        session, until, st, { variation: i });
      st.variations.list.push({ i, agent: session.profile.name, session, provider: req.provider }); // runTurn() names the session synchronously
    }
    return;
  }
  st.spawnBudget = n - 1;
  const round = (st.split = n > 1 ? { kids: [] } : null);
  if (round) prompt = `Do this task by splitting the work across at most ${n - 1} extra designer agent${n > 2 ? 's' : ''} with the spawn_agents tool, besides you. ` +
    'First set up what every part shares: the variables (colors, typography, spacing, radii) and the reusable components (header, buttons, cards, inputs...). ' +
    'Then create the container frames, spawn the agents for the other parts — telling each which variables and components to build with, so the parts look like one design — and design the last part yourself. ' +
    `When they are all done you will get a turn to review the whole thing, so don't wait for them.\n\n${prompt}`;
  const session = (st.main[req.provider] ??= {});
  const end = await runTurn({ ...req, prompt }, session, until, st);
  if (!round?.kids.length) return;
  const ends = await Promise.all(round.kids);
  // a new turn or a stop since then cancels the review
  if (st.split !== round || end.reason !== 'finished' || ends.some((e) => e.reason === 'stopped')) return;
  st.split = null;
  run({ ...req, images: [], docs: [], prompt: 'The designer agents you spawned have finished. Review the whole design as one: TakeScreenshot of every part, compare them, and fix what diverges between parts — colors, typography, spacing, alignment, components redrawn instead of reused, leftover placeholder: true. Keep each part\'s content; only make them consistent. Reply in a sentence or two.' }, session, st);
}

// spawn_agents: extra agents with the chat's provider/model/effort, each confined to its container nodes.
// Limited by the "Nx" setting; spawned agents can't spawn more (their budget is the chat's, already spent).
// Each gets the user's whole request and the attached skills, not just the main agent's summary of its part.
// `ctx.conv` comes from the MCP env (PENA_CONV): the right chat even when others are running in the background.
function spawn(config, ctx = {}) {
  const st = (ctx.conv && liveChats.get(ctx.conv)) || currentState();
  if (!st) return 'Open the chat you want to split across agents.';
  if (st.spawnBudget <= 0) return 'Parallel agents are off for this request (1x). Do the whole task yourself, without spawn_agents.';
  const accepted = config.slice(0, st.spawnBudget);
  st.spawnBudget -= accepted.length;
  for (const { prompt, containerNodes } of accepted) {
    const brief = `${prompt}\n\nThe user's whole request, for context (your part is only the one above):\n<request>\n${st.lastChat.prompt}\n</request>`;
    const kid = run(
      { ...st.lastChat, skills: [], prompt: `${withSkills(brief, st.lastChat.skills, st.id)}\n\nWork ONLY inside these nodes: ${containerNodes.join(', ')}. Other agents are editing the rest of the document in parallel; never touch nodes outside your containers. Use the document's variables and reusable components instead of redrawing them. Do not call spawn_agents. Remove placeholder: true from your containers when done.${designRules(st.lastChat)}` },
      {},
      st,
      { parent: st.main[st.lastChat.provider]?.profile?.name },
    );
    st.split?.kids.push(kid);
  }
  const dropped = config.length - accepted.length;
  const waiting = st.slots.waiting;
  return `Spawned ${accepted.length} designer agent(s); they are working in parallel now${waiting ? ` (${st.slots.max} at a time: ${waiting} start as others finish)` : ''}. Do your own part.${dropped ? ` ${dropped} request(s) over the limit were not started — do those parts yourself.` : ''}`;
}

// The user picked a side-by-side variation: delete the others and keep chatting with the agent that made it.
function pickVariation(agent) {
  const st = currentState();
  const v = st?.variations?.list.find((x) => x.agent === agent);
  if (!v) return { error: 'Essa rodada de variações não está mais ativa.' };
  if (st.running.size) return { error: 'Espere todas as variações terminarem.' };
  const others = store.doc.children.filter((c) => {
    const m = /Variação\s*(\d+)\s*$/i.exec(c.name ?? '');
    return m && Number(m[1]) !== v.i && !st.variations.before.has(c.id);
  });
  if (others.length) store.execute({ input: others.map((c) => `Delete(${JSON.stringify(c.id)})`).join('\n') });
  st.main[v.provider] = v.session;
  saveSessions(st);
  st.picked = `The user chose your variation (${v.i}); the other variations were deleted. Keep working on your design.`;
  st.variations = null;
  return { ok: true, deleted: others.length };
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

// read_chat reads the conversation of the agent that called it (PENA_CONV), not whichever chat is on screen.
const messagesFor = (ctx = {}) => {
  const st = (ctx.conv && liveChats.get(ctx.conv)) || currentState();
  return (st?.file && chats.byId(st.file, st.id)?.messages) || (FILE && chats.current(FILE)?.messages) || [];
};
const tools = createTools({ file: () => FILE, doc: () => store.doc, execute: (args, rects) => store.execute(args, rects), render, state: () => ({ ...editorState, rects: editorRects }), spawn, chat: (args, ctx) => readChat(messagesFor(ctx), args), touched: (agent, nodes) => emit('agent-nodes', { agent: agent ?? 'agente externo', color: profileOf(agent)?.color, nodes }) });

// --- design-tool health -------------------------------------------------------------------------------------------
// The design tools are a separate MCP process the agent's CLI spawns. When it doesn't come up, the turn runs with no
// design tools at all and the agent can only say it cannot edit the file. Prove the connection end to end, and let the
// UI show that instead of failing silently.
let mcpState = { ok: null, tools: 0, error: null, fixed: [], at: 0 };
async function mcpCheck({ reset = false } = {}) {
  const fixed = await settings.repairIntegrations().catch(() => []);
  const r = await settings.testMcp(settings.penaLaunch());
  mcpState = { ok: r.ok, tools: r.tools?.length ?? 0, error: r.ok ? null : r.error, fixed, at: Date.now() };
  // A CLI session keeps the tool list it started with, so a broken one stays broken even after the server is back.
  // Dropping the saved sessions makes the next turn start a new one; the handoff still gives it the whole conversation.
  // That is "start a new chat" without losing the chat.
  if (reset && r.ok && FILE) {
    for (const c of chats.list(FILE).list) chats.setSessions(FILE, {}, c.id);
    for (const st of liveChats.values()) for (const s of Object.values(st.main)) for (const k of ['claude', 'codex', 'codexId', 'codexKey', 'opencode']) delete s[k];
  }
  emit('mcp', mcpState);
  return mcpState;
}

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
      // A .pen dropped on the dashboard: the webview gives the content, not the path, so it becomes a draft with the same name.
      if (url === '/api/import-pen' && req.method === 'POST') {
        const text = await body(req);
        try { JSON.parse(text); } catch { return res.writeHead(400).end('Arquivo .pen inválido'); }
        const file = path.join(path.dirname(library.newDraft()), path.basename(q.get('name') ?? 'untitled.pen'));
        fs.writeFileSync(file, text);
        return json({ path: open(file) });
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
      if (!FILE && (['/doc', '/doc-beacon', '/state'].includes(url) || url.startsWith('/tool/'))) return res.writeHead(409).end('No document open');
      // The document as the server has it (the file may lag a few hundred ms). `x-pena-seq`: the last patch it includes.
      if (req.url === '/doc' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'x-pena-name': encodeURIComponent(path.basename(FILE)), 'x-pena-file': encodeURIComponent(FILE), 'x-pena-seq': store.seq, 'cache-control': 'no-store' });
        return res.end(JSON.stringify(store.doc));
      }
      // Editor saves: only the roots it edited since its last save (whole), the ids it deleted, and the order / meta
      // when they changed. They land on the document in memory, so an agent's edits to other roots are kept.
      // The answer says how many patches the server had sent by then: the editor orders its own save against them.
      // `file`: the document the editor was showing. After File > Open a late save from the old one must not land in the new.
      if ((url === '/doc' && req.method === 'PUT') || (url === '/doc-beacon' && req.method === 'POST')) {
        const sent = q.get('file');
        const text = await body(req);
        if (sent && sent !== FILE) return res.writeHead(409).end('Another document is open');
        return json({ seq: store.put(JSON.parse(text)) });
      }
      if (req.url === '/chat' && req.method === 'POST') {
        const msg = JSON.parse(await body(req));
        const conv = FILE ? chats.current(FILE, { create: true }) : null;
        if (msg.provider === 'reset') { if (FILE) return json({ id: chats.startNew(FILE).id }); }
        else if (msg.steer) {
          // Steer: stop this conversation's turn and send this one as soon as its runs have wound down (same session).
          const st = stateOf(conv?.id);
          if (st?.running.size) {
            st.running.forEach((c) => c.abort());
            (async () => { while (st.running.size) await new Promise((r) => setTimeout(r, 50)); chat(msg, conv.id); })();
          } else chat(msg, conv?.id);
        } else chat(msg, conv?.id);
        return res.end('ok');
      }
      if (url === '/api/variation' && req.method === 'POST') return json(pickVariation(JSON.parse(await body(req)).agent));
      if (url === '/api/current') return json({ file: FILE ?? null, focusedAt });
      if (url === '/api/focus' && req.method === 'POST') {
        focusedAt = Date.now(); // the app's window got focus
        // the user is back at the window: notice, and surface, a design-tool server that died while they were away
        if (focusedAt - mcpState.at > 60000) mcpCheck().catch(() => {});
        return res.end('ok');
      }
      // --- chat history (per open file); every conversation is independent and may keep running in the background ---
      if (url === '/api/chats' && FILE) {
        const l = chats.list(FILE);
        return json({ ...l, groups: chats.groups(FILE), list: l.list.map((c) => ({ ...c, running: runningInfo(c.id).length })) });
      }
      if (url === '/api/chats/current' && FILE) {
        const c = chats.current(FILE);
        return json(c ? { ...c, running: runningInfo(c.id), group: chats.groupOf(FILE, c.id) } : { messages: [], running: [], group: null });
      }
      // Groups: a name plus one shared instructions text, injected into every agent of every chat in it.
      if (url === '/api/groups/save' && req.method === 'POST' && FILE) {
        const group = chats.saveGroup(FILE, JSON.parse(await body(req)));
        return json({ group, groups: chats.groups(FILE) });
      }
      if (url === '/api/groups/delete' && req.method === 'POST' && FILE) {
        chats.removeGroup(FILE, JSON.parse(await body(req)).id);
        return json({ groups: chats.groups(FILE) });
      }
      if (url === '/api/chats/group' && req.method === 'POST' && FILE) {
        const b = JSON.parse(await body(req));
        const c = chats.setGroup(FILE, b.id, b.group ?? null);
        return json({ group: chats.groupOf(FILE, c.id) });
      }
      if (url === '/api/chats/pin' && req.method === 'POST' && FILE) {
        const b = JSON.parse(await body(req));
        const c = chats.pin(FILE, b.id, b.pinned);
        return json({ pinned: !!c.pinned });
      }
      // the handoff the next message would carry with this provider/model (the composer shows it before sending)
      if (url === '/api/handoff' && FILE) {
        const provider = q.get('provider') || 'claude', st = currentState();
        const h = st && handoffFor({ provider, model: q.get('model') || undefined }, st.main[provider] ?? {}, Infinity, false, st);
        return json(h && { from: h.from, to: h.to, fresh: h.fresh });
      }
      if (url === '/api/chats/select' && req.method === 'POST' && FILE) {
        // Switching never waits: the other conversation's agents keep running and their events stay in their own chat.
        const c = chats.select(FILE, JSON.parse(await body(req)).id);
        return json({ ...c, running: runningInfo(c.id) });
      }
      if (url === '/api/chats/delete' && req.method === 'POST' && FILE) {
        const id = JSON.parse(await body(req)).id;
        liveChats.get(id)?.running.forEach((c) => c.abort());
        liveChats.delete(id);
        chats.remove(FILE, id);
        return json(chats.list(FILE));
      }
      // --- settings (providers, MCP) ---
      if (url === '/api/mcp/health') return json(mcpState);
      if (url === '/api/mcp/reconnect' && req.method === 'POST') return json(await mcpCheck({ reset: true }));
      if (url === '/api/settings/providers') return json(await settings.providerStatus());
      if (url === '/api/settings/probe' && req.method === 'POST') return json(await settings.probe(JSON.parse(await body(req)).provider));
      if (url === '/api/settings/login' && req.method === 'POST') return json(await settings.openLoginTerminal(JSON.parse(await body(req)).provider));
      if (url === '/api/settings/accounts' && req.method === 'POST') {
        const b = JSON.parse(await body(req));
        if (b.remove) { settings.removeAccount(b.remove); return json({ ok: true }); }
        return json(settings.addAccount(b.provider, b.name));
      }
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
        const list = settings.accounts();
        const settled = await Promise.allSettled(list.map((a) => (a.provider === 'claude' ? listClaudeModels(a) : a.provider === 'codex' ? listCodexModels(a) : listOpencodeModels())));
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          accounts: list.map(({ id, provider, name }) => ({ id, provider, name })),
          ...Object.fromEntries(list.map((a, i) => [a.id, settled[i].status === 'fulfilled' ? settled[i].value : []])),
        }));
      }
      if (req.url === '/stop' && req.method === 'POST') { currentState()?.running.forEach((c) => c.abort()); return res.end('ok'); }
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
  store.open(file); // writes what is pending to the previous file first; throws (and changes nothing) if it is not a document
  if (FILE) fs.unwatchFile(FILE);
  FILE = file;
  editorRects = {};
  // watchFile (polling) survives the atomic rename of a write; fs.watch loses the inode. Only for other apps: our own
  // writes are recognized by their mtime. The file wins over memory: reload it and tell the editor to do the same
  // (if changes are waiting to be written, flush() merges them with the file and tells the editor itself).
  fs.watchFile(FILE, { interval: 1000 }, (curr) => {
    if (!curr.mtimeMs || curr.mtimeMs === store.ownWrite) return;
    if (store.pending) return store.flush();
    try { store.reload(); } catch (e) { return console.error(`Pena: ${FILE} changed on disk but cannot be read: ${e.message}`); } // half written: the next change retries
    emit('doc', {});
  });
  library.recordOpened(FILE);
  emit('file', { name: path.basename(FILE), path: FILE });
  return FILE;
}
export const currentFile = () => FILE;
// One entry per running server (the desktop app runs one per window); mcp.mjs reads them all.
const DISCOVERY = path.join(library.PENA_DIR, 'servers', `${process.pid}.json`);
let focusedAt = 0; // when this server's window last got focus: external agents talk to the last focused window

export function start({ file, port = 4500 } = {}) {
  if (file) try { open(file); } catch (e) { console.error(`Pena: cannot open ${file}: ${e.message}`); } // the dashboard instead of a crash
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
      mcpCheck().catch(() => {}); // know before the first turn whether the design tools can start at all
      resolve(`http://127.0.0.1:${PORT}`);
    });
  });
}

if (!COMPILED && import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = await start({ file: process.argv[2], port: Number(process.env.PORT ?? 4500) });
  console.log(`Pena → ${url.replace('127.0.0.1', 'localhost')}  (${FILE ?? 'dashboard'})`);
}
