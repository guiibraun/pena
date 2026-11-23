// Antigravity (Google's `agy` CLI), driven over ACP like T3 Code does (pingdotgg/t3code, AntigravityAcpSupport):
// `agy acp` on stdio, `oauth-personal` auth (the login `agy` already holds), the system prompt appended through
// _meta.antigravity, MCP servers handed over in session/new. One process per turn; the session is resumed by id.
import crypto from 'node:crypto';
import path from 'node:path';
import { openAcp } from './acp.mjs';

// Pena's own MCP server. agy also loads ~/.gemini/config/mcp_config.json, where a `pena` of the installed app may
// live, and a global server beats a session's one of the same name: this one has its own name.
export const AGY_SERVER = 'pena-agy';
const LEVELS = ['low', 'medium', 'high', 'xhigh'];

// `agy models` prints "<id>\t<name>" per line, one per thinking level (`gemini-4-neon-high`). ACP sets the level apart
// (config option thought_level), so models with several levels become one entry with efforts.
export function parseModels(text) {
  const groups = new Map();
  for (const line of text.split('\n')) {
    const [id, name] = line.split('\t').map((s) => s?.trim());
    if (!id || !name) continue;
    const level = LEVELS.find((l) => id.endsWith(`-${l}`));
    const base = level ? id.slice(0, -level.length - 1) : id;
    (groups.get(base) ?? groups.set(base, []).get(base)).push({ id, name, level });
  }
  return [...groups].flatMap(([base, items]) => {
    const efforts = LEVELS.filter((l) => items.some((i) => i.level === l));
    if (efforts.length < 2) return items.map(({ id, name }) => ({ id, name, efforts: [] }));
    return [{ id: base, name: items[0].name.replace(/\s*\([^)]*\)$/, ''), efforts, defaultEffort: efforts.includes('high') ? 'high' : efforts[0] }];
  });
}

export async function handshake(acp) {
  const init = await acp.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'pena', version: '0.1.0' } });
  const auth = await acp.request('authenticate', { methodId: 'oauth-personal' });
  return { init, tier: auth?._meta?.antigravity?.tier?.name };
}

const inside = (p, dir) => { const r = path.relative(dir, p); return !r.startsWith('..') && !path.isAbsolute(r); };
// A command that only reads: no redirects, substitutions or chaining beyond `&&` and pipes.
// shortcut: a short allowlist, not a shell parser; widen it when agents miss a command.
const READ_ONLY = /^(ls|cat|head|tail|wc|grep|pwd|git (status|diff|log|show))(\s[^;&|<>$`\n(){}\\]*)?$/;
const readOnly = (cmd = '') => !/--output|--ext-diff|--textconv/.test(cmd) && cmd.split(/&&|\|/).every((c) => READ_ONLY.test(c.trim()));

// What agy may do, answered from its permission requests (mode `default`). Refusing one makes agy end the whole turn
// (it cancels the invocation), so the rules let it search and read the way it likes and refuse only what is off limits.
// Reads inside the workspace never ask, so secrets there are the seatbelt's job: searching and shell reads are
// allowed only when `sandboxed` says the seatbelt is on. Pena's tools, and the MCP servers you gave Pena, are the only MCP tools allowed.
export const permission = ({ roots, servers, isSecret, sandboxed }) => ({ name = '', kind, locations = [], toolCallId = '', rawInput }) => {
  if (toolCallId.startsWith('interaction_')) return false; // a question for the user: Pena has no way to show it
  if (servers.some((s) => name.startsWith(`mcp_${s}_`)) || servers.includes(rawInput?.ServerName)) return true; // direct, or through `call_mcp_tool`
  const paths = locations.map((l) => l.path);
  const ok = paths.every((p) => roots.some((r) => inside(p, r)) && !isSecret(p));
  if (kind === 'fetch') return true;
  if (kind === 'read') return ok;
  if (kind === 'search') return sandboxed && ok;
  if (kind === 'execute') return sandboxed && readOnly(rawInput?.CommandLine);
  if (kind === 'edit') return paths.length > 0 && ok && !paths.some((p) => /\.pen$/i.test(p));
  return false;
};

// macOS seatbelt profile (what Claude's sandbox is made of): secrets in the project and the home folders that hold
// credentials can't be read by agy, nor by the shell and MCP servers it starts. `root` must be a real path.
export const seatbelt = (root, secretDirs) => {
  const re = `^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.*/)?(\\.env(\\.[^/]*)?|[^/]*\\.(key|pem|p12))$`;
  return `(version 1)(allow default)(deny file-read* (regex #"${re}") ${secretDirs.map((d) => `(subpath ${JSON.stringify(d)})`).join(' ')})`;
};

const STATUS = { completed: 'done', failed: 'error' };
const textOf = (u) => (u.content ?? []).flatMap((c) => (c.type === 'content' && c.content?.type === 'text' ? [c.content.text] : [])).join('\n') || (typeof u.rawOutput?.output === 'string' ? u.rawOutput.output : '');
const imagesOf = (u) => (u.content ?? []).flatMap((c) => (c.type === 'content' && c.content?.type === 'image' ? [`data:${c.content.mimeType};base64,${c.content.data}`] : []));

// One turn. `say` is the run's event emitter (text/thinking/tool/todos/model). Returns the session id and usage.
export async function agyTurn({ cmd, args, cwd, env, signal, sessionId, onSession, model, effort, system, mcpServers, prompt, images = [], permit, say }) {
  const run = crypto.randomUUID().slice(0, 8); // ids are unique per chat: the history drops a repeated one
  const names = mcpServers.map((s) => s.name);
  let seg = null, n = 0;
  const flush = () => { if (seg) say(seg.kind, { id: seg.id, text: seg.text, done: true }); seg = null; };
  const stream = (kind, text) => {
    if (seg?.kind !== kind) flush(), (seg = { kind, id: `${run}:${++n}`, text: '' });
    seg.text += text;
    say(kind, { id: seg.id, text: seg.text }, seg.id);
  };
  // mcp_<server>_<tool> -> <tool>: the design tools are told apart by their bare name
  const bare = (name = '') => { const s = names.find((x) => name.startsWith(`mcp_${x}_`)); return s ? name.slice(`mcp_${s}_`.length) : name; };
  const tool = (u) => {
    flush();
    const { toolSummary, ...raw } = u.rawInput ?? {};
    // agy may reach an MCP tool through its own `call_mcp_tool`: show the card as the tool it calls
    const via = raw.ServerName && raw.ToolName ? raw : null;
    const input = via ? via.Arguments ?? {} : raw, called = via?.ToolName ?? ((u.name ?? u.title) && bare(u.name ?? u.title));
    const out = textOf(u).slice(0, 4000), imgs = imagesOf(u);
    say('tool', { id: u.toolCallId, status: STATUS[u.status] ?? 'running', ...(called && { name: called }), ...(u.rawInput && { input }), ...(toolSummary && { label: toolSummary }), ...(out && { output: out }), ...(imgs.length && { images: imgs }) });
  };
  const acp = openAcp(cmd, args, {
    cwd, env, signal,
    onRequest: async (method, p) => {
      if (method !== 'session/request_permission') throw new Error(`Método não suportado: ${method}`);
      const pick = p.options.find((o) => o.kind === (permit(p.toolCall) ? 'allow_once' : 'reject_once'));
      return { outcome: pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' } };
    },
    onNotify: (method, p) => {
      if (method !== 'session/update') return;
      const u = p.update;
      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') stream('text', u.content.text);
      else if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') stream('thinking', u.content.text);
      else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') tool(u);
      else if (u.sessionUpdate === 'plan') (flush(), say('todos', { items: (u.entries ?? []).map((e) => ({ text: e.content, status: e.status })) }));
    },
  });
  try {
    const { init } = await handshake(acp);
    const appends = init.agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true; // older runtimes: the prompt carries it
    const params = { cwd, mcpServers, ...(appends && { _meta: { antigravity: { systemPrompt: { append: system } } } }) };
    const s = sessionId
      // a session agy no longer has comes back as a JSON-RPC error: say it the way runTurn recognizes, to start a new one
      ? await acp.request('session/resume', { sessionId, ...params }).catch((e) => { throw typeof e.code === 'number' ? new Error(`session not found (${e.message})`) : e; })
      : await acp.request('session/new', params);
    const id = s.sessionId ?? sessionId;
    onSession?.(id);
    const set = (configId, value) => acp.request('session/set_config_option', { sessionId: id, configId, value });
    if (model) await set('model', model);
    if (effort) await set('thought_level', effort).catch(() => {}); // a model without levels refuses; the turn doesn't need it
    say('model', { model: model ?? s.configOptions?.find((o) => o.id === 'model')?.currentValue ?? 'agy' });
    const text = appends || sessionId ? prompt : `${system}\n\n---\n\n${prompt}`;
    const r = await acp.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }, ...images.map(({ mime, b64 }) => ({ type: 'image', mimeType: mime, data: b64 }))] });
    flush();
    if (!['end_turn', 'cancelled'].includes(r.stopReason)) throw new Error(`O Antigravity parou: ${r.stopReason}`);
    const u = r.usage ?? {};
    return { sessionId: id, usage: { input: u.inputTokens, output: (u.outputTokens ?? 0) + (u.thoughtTokens ?? 0), cacheRead: u.cachedReadTokens, cacheWrite: u.cachedWriteTokens } };
  } finally {
    acp.close();
  }
}
