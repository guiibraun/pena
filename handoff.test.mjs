// Context handoff between agents (handoff.mjs): what each provider's session missed, and read_chat.
import assert from 'node:assert/strict';
import { planHandoff, readChat, seenUntil } from './handoff.mjs';

const run = (agent, provider, model, items, reason = 'finished') => [
  { kind: 'start', agent, provider, model },
  { kind: 'model', agent, model },
  ...items.map((m) => ({ agent, ...m })),
  { kind: 'end', agent, reason, ...(reason === 'failed' && { message: 'rate limited' }) },
];
const chat = [
  { kind: 'user', text: 'Faça uma landing de café' }, // 0
  ...run('Phantom', 'claude', 'opus', [{ kind: 'text', text: 'Fiz a landing.' }, { kind: 'tool', name: 'execute', label: 'Add hero', status: 'done', input: { input: 'Insert(...)' }, output: 'hero=abc' }]), // 1-5
  { kind: 'user', text: 'Agora mais escuro' }, // 6
  ...run('Drift', 'codex', 'gpt-5.5', [
    { kind: 'todos', items: [{ text: 'Escurecer', status: 'in_progress' }] },
    { kind: 'thinking', text: 'segredo' },
    { kind: 'tool', name: 'execute', label: 'Darken theme', status: 'done', input: { input: 'SetVariables(...)' }, output: 'x'.repeat(2000) },
    { kind: 'todos', items: [{ text: 'Escurecer', status: 'completed' }] },
    { kind: 'text', id: 'r1', text: 'Escureci tudo.' },
    { kind: 'text', id: 'r1', text: 'Escureci tudo.' }, // saved again when the message completes
  ]), // 7-15
  { kind: 'user', text: 'Volta pro Claude' }, // 16: the turn being sent
];
const until = 16;

// Claude saw up to its last run; Codex up to now.
assert.equal(seenUntil(chat.slice(0, until), 'claude'), 6);
assert.equal(seenUntil(chat.slice(0, until), 'codex'), 16);

// Back to Claude: only what Codex did, as it was written.
const back = planHandoff({ messages: chat, until, provider: 'claude', model: 'opus', fresh: false });
assert.deepEqual(back.range, [6, 15]);
assert.equal(back.text.match(/Escureci tudo/g).length, 1);
assert.deepEqual(back.from.map((r) => r.provider), ['codex']);
assert.match(back.text, /Other agents \(Codex gpt-5\.5\)/);
assert.match(back.text, /\[#6 user\]\nAgora mais escuro/);
assert.match(back.text, /\[#13 Drift · Codex gpt-5\.5 · reply\]\nEscureci tudo\./);
assert.match(back.text, /tool execute "Darken theme" · done\]\nx{600}… \[shortened\]/);
assert.doesNotMatch(back.text, /Fiz a landing|segredo|SetVariables/); // Claude's own turn, reasoning, scripts
assert.equal(back.text.match(/· plan\]/g).length, 1); // the superseded plan is dropped
assert.match(back.text, /- \[x\] Escurecer/);
assert.equal(back.omitted, 0);

// Codex is caught up; the same provider retrying after its own failure gets nothing either.
assert.equal(planHandoff({ messages: chat, until, provider: 'codex', fresh: false }), null);
const failed = [chat[0], ...run('Phantom', 'claude', 'opus', [], 'failed'), { kind: 'user', text: 'De novo' }];
assert.equal(planHandoff({ messages: failed, until: 5, provider: 'claude', fresh: false }), null);
// ...but another provider does get the failed turn.
assert.match(planHandoff({ messages: failed, until: 5, provider: 'codex', fresh: false }).text, /run failed\]\nrate limited/);

// A handoff item goes before its run's start: it isn't credited to the agent's previous run.
const renamed = [...chat.slice(0, 7), { kind: 'handoff', agent: 'Phantom', to: { provider: 'codex' }, range: [0, 5] }, ...run('Phantom', 'codex', 'gpt-5.5', [{ kind: 'text', text: 'Escureci.' }]), { kind: 'user', text: 'Volta' }];
assert.deepEqual(planHandoff({ messages: renamed, until: renamed.length - 1, provider: 'claude', fresh: false }).from.map((r) => r.provider), ['codex']);

// A new session gets the whole conversation, even its own provider's turns.
const fresh = planHandoff({ messages: chat, until, provider: 'claude', fresh: true, replaced: true });
assert.deepEqual(fresh.range, [0, 15]);
assert.match(fresh.text, /no longer exists/);
assert.match(fresh.text, /Fiz a landing/);

// Under a small budget: whole items only, the latest request and reply first, and it fits.
const small = planHandoff({ messages: chat, until, provider: 'claude', fresh: true, budget: 1300 });
assert.ok(small.text.length <= 1300, small.text.length);
assert.ok(small.omitted > 0 && small.included > 0);
assert.match(small.text, /\[#6 user\]/);
assert.match(small.text, /Escureci tudo\./);
assert.match(small.text, /read_chat\(\{ from: 0, to: 15 \}\)/);

// read_chat: whole items with their scripts and results, paged.
const read = readChat(chat, { from: 9, to: 13 });
assert.match(read, /^Chat items #9–#13/);
assert.match(read, /Input:\nSetVariables\(\.\.\.\)\nResult:\nx{2000}/);
assert.doesNotMatch(read, /segredo/);
assert.match(readChat(chat.concat(Array.from({ length: 40 }, () => ({ kind: 'user', text: 'y'.repeat(2000) })))), /Continue with read_chat\(\{ from: \d+, to: 56 \}\)/);
assert.equal(readChat([]), 'The chat is empty.');

console.log('ok    handoff');
