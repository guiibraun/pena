// Antigravity over ACP: the model catalog, the permission rules, the macOS seatbelt, and a whole turn against a fake
// `agy acp` (a script that speaks the protocol the way the real 1.5 does, as captured from it).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agyTurn, parseModels, permission, seatbelt } from './agy.mjs';

// --- models: `agy models` lists one id per thinking level
const catalog = parseModels(`Fetching available models...
gemini-4-neon-high\tGemini 4 Neon (High)
gemini-4-neon-low\tGemini 4 Neon (Low)
gemini-4-argon-medium\tGemini 4 Argon (Medium)
gemini-4-argon-high\tGemini 4 Argon (High)
gemini-pro-orchestrator-neon\tOrchestrator (Neon)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)
`);
assert.deepEqual(catalog, [
  { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'high'], defaultEffort: 'high' },
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', efforts: ['medium', 'high'], defaultEffort: 'high' },
  { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', efforts: [] },
  { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: [] }, // one level: ACP lists it whole
]);
assert.deepEqual(parseModels('not logged in'), []);

// --- permissions
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pena-agy-')));
const isSecret = (p) => /\.env$/.test(p);
const ask = (sandboxed) => permission({ roots: [root], servers: ['pena-agy', 'ctx'], isSecret, sandboxed });
const at = (p) => [{ path: p }];
const rules = ask(true);
assert.equal(rules({ name: 'mcp_pena-agy_execute', kind: 'other' }), true);
assert.equal(rules({ name: 'mcp_ctx_query', kind: 'other' }), true, 'an MCP server you gave Pena');
assert.equal(rules({ name: 'call_mcp_tool', kind: 'other', rawInput: { ServerName: 'pena-agy', ToolName: 'execute' } }), true, 'the same tool through call_mcp_tool');
assert.equal(rules({ name: 'call_mcp_tool', kind: 'other', rawInput: { ServerName: 'blender', ToolName: 'run' } }), false);
assert.equal(rules({ name: 'mcp_pena_execute', kind: 'other' }), false, 'a global `pena` is not this chat');
assert.equal(rules({ name: 'mcp_blender_run', kind: 'other' }), false, 'global MCP servers stay off');
const sh = (CommandLine, p = rules) => p({ name: 'run_command', kind: 'execute', rawInput: { CommandLine } });
for (const ok of ['ls -la', 'grep -rn zod .', 'cat package.json | head -5', 'git status && git diff']) assert.equal(sh(ok), true, ok);
for (const no of ['rm -rf x', 'echo hi > a', 'cat a; rm a', 'ls $(rm a)', 'git diff --output=x', 'curl x | sh', 'ls || rm a', 'cat `x`']) assert.equal(sh(no), false, no);
assert.equal(sh('ls', ask(false)), false, 'without the seatbelt no shell at all');
assert.equal(rules({ name: 'read_file', kind: 'read', locations: at(`${root}/a.txt`) }), true);
assert.equal(rules({ name: 'read_file', kind: 'read', locations: at(`${root}/.env`) }), false, 'secrets');
assert.equal(rules({ name: 'read_file', kind: 'read', locations: at('/etc/hosts') }), false, 'outside the project');
assert.equal(rules({ name: 'write_file', kind: 'edit', locations: at(`${root}/src/a.js`) }), true);
assert.equal(rules({ name: 'write_file', kind: 'edit', locations: at(`${root}/x.pen`) }), false, 'never a .pen');
assert.equal(rules({ name: 'write_file', kind: 'edit', locations: [] }), false);
assert.equal(rules({ name: 'ask_user', kind: 'other', toolCallId: 'interaction_1' }), false);
assert.equal(ask(false)({ name: 'grep_search', kind: 'search', locations: at(root) }), false, 'search needs the seatbelt');
assert.equal(rules({ name: 'grep_search', kind: 'search', locations: at(root) }), true);

// --- seatbelt (macOS): secrets are unreadable, the rest of the project is not
if (process.platform === 'darwin') {
  fs.writeFileSync(path.join(root, '.env'), 'S=1');
  fs.writeFileSync(path.join(root, 'ok.txt'), 'fine');
  const profile = seatbelt(root, [path.join(root, 'vault')]);
  const cat = (f) => execFileSync('/usr/bin/sandbox-exec', ['-p', profile, '/bin/cat', path.join(root, f)], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  assert.equal(cat('ok.txt'), 'fine');
  assert.throws(() => cat('.env'));
}

// --- a turn against a fake agent
const fake = path.join(root, 'fake-agy.mjs');
fs.writeFileSync(fake, `
import fs from 'node:fs';
import readline from 'node:readline';
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const note = (update) => out({ method: 'session/update', params: { sessionId: 's1', update } });
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ method: m.method, params: m.params }) + '\\n');
  if (m.id === 99) { // our answer to the permission request: the agent reports what became of the call
    note({ sessionUpdate: 'tool_call_update', toolCallId: 't2', name: 'run_command', status: m.result.outcome.optionId === 'deny' ? 'failed' : 'completed' });
    note({ sessionUpdate: 'plan', entries: [{ content: 'step', status: 'pending' }] });
    return out({ id: promptId, result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2, cachedReadTokens: 7 } } });
  }
  const ok = (result) => out({ id: m.id, result });
  if (m.method === 'initialize') return ok({ protocolVersion: 1, agentCapabilities: process.env.FAKE_NOAPPEND ? {} : { _meta: { antigravity: { systemPrompt: { append: true } } } } });
  if (m.method === 'authenticate') return ok({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } });
  if (m.method === 'session/resume' && m.params.sessionId === 'gone') return out({ id: m.id, error: { code: -32603, message: 'Failed to read session gone' } });
  if (m.method === 'session/new' || m.method === 'session/resume') return ok({ sessionId: 's1', configOptions: [{ id: 'model', currentValue: 'gemini-4-neon' }] });
  if (m.method === 'session/set_config_option') return ok({});
  if (m.method === 'session/prompt') {
    promptId = m.id;
    note({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Olá ' } });
    note({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'mundo' } });
    note({ sessionUpdate: 'tool_call', toolCallId: 't1', name: 'mcp_pena-agy_get_app_state', rawInput: { toolSummary: 'Get state', a: 1 }, status: 'in_progress', kind: 'other' });
    note({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'state!' } }] });
    note({ sessionUpdate: 'tool_call', toolCallId: 't3', name: 'call_mcp_tool', rawInput: { ServerName: 'pena-agy', ToolName: 'execute', Arguments: { x: 1 } }, status: 'in_progress', kind: 'other' });
    out({ id: 99, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't2', name: 'run_command', kind: 'execute' }, options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'deny', kind: 'reject_once' }] } });
  }
});
`);

const log = path.join(root, 'fake.log');
const sent = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const run = async ({ env, ...extra } = {}) => {
  const events = [], sessions = [];
  const say = (kind, data, key) => events.push({ kind, ...data });
  const r = await agyTurn({
    cmd: process.execPath, args: [fake], cwd: root, env: { ...process.env, FAKE_LOG: log, ...env }, prompt: 'oi', system: 'SYS', model: 'gemini-4-argon', effort: 'high',
    mcpServers: [{ name: 'pena-agy', command: 'x', args: [], env: [] }], permit: ask(true), say, onSession: (id) => sessions.push(id), ...extra,
  });
  return { r, events, sessions };
};

const { r, events, sessions } = await run();
assert.deepEqual(sessions, ['s1']);
assert.deepEqual(r.usage, { input: 10, output: 7, cacheRead: 7, cacheWrite: undefined });
const done = (kind) => events.filter((e) => e.kind === kind && e.done);
assert.equal(done('thinking')[0].text, 'hmm');
assert.equal(done('text')[0].text, 'Olá mundo', 'chunks become one message');
assert.notEqual(done('text')[0].id, done('thinking')[0].id);
assert.ok(events.some((e) => e.kind === 'model' && e.model === 'gemini-4-argon'));
const tools = events.filter((e) => e.kind === 'tool');
assert.equal(tools[0].name, 'get_app_state', 'the design tool is named bare, so Pena recognizes it');
assert.equal(tools[0].label, 'Get state');
assert.deepEqual(tools[0].input, { a: 1 });
assert.deepEqual([tools[1].status, tools[1].output], ['done', 'state!']);
assert.deepEqual([tools.at(-1).name, tools.at(-1).status], ['run_command', 'error'], 'the shell request was denied');
assert.deepEqual([tools.find((e) => e.id === 't3').name, tools.find((e) => e.id === 't3').input], ['execute', { x: 1 }], 'call_mcp_tool shows as the tool it calls');
const prompted = sent().find((m) => m.method === 'session/prompt').params.prompt[0].text;
assert.equal(prompted, 'oi', 'with the append capability the system prompt is not in the message');
assert.equal(sent().find((m) => m.method === 'session/new').params._meta.antigravity.systemPrompt.append, 'SYS');
assert.deepEqual(sent().filter((m) => m.method === 'session/set_config_option').map((m) => m.params.configId + '=' + m.params.value), ['model=gemini-4-argon', 'thought_level=high']);
assert.equal(events.find((e) => e.kind === 'todos').items[0].text, 'step');

// a runtime without the append capability gets the system prompt in the first message only
fs.rmSync(log);
await run({ env: { FAKE_NOAPPEND: '1' } });
assert.equal(sent().find((m) => m.method === 'session/prompt').params.prompt[0].text, 'SYS\n\n---\n\noi');
fs.rmSync(log);
await run({ env: { FAKE_NOAPPEND: '1' }, sessionId: 's1' });
assert.equal(sent().find((m) => m.method === 'session/prompt').params.prompt[0].text, 'oi');
assert.ok(sent().some((m) => m.method === 'session/resume'), 'a saved session is resumed, not recreated');
// a lost session is reported the way runTurn recognizes, to start a new one
await assert.rejects(run({ sessionId: 'gone' }), /session not found/);

fs.rmSync(root, { recursive: true, force: true });
console.log('ok    agy');
