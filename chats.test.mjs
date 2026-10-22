// Chat history per conversation: a background turn keeps writing to its own chat after the user switches away.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-chats-'));
process.env.HOME = tmp; // PENA_DIR is read when chats.mjs loads, right below
const chats = await import(`./chats.mjs?${Date.now()}`);
const file = path.join(tmp, 'x.pen');

const a = chats.startNew(file);
chats.append(file, { kind: 'user', text: 'a1' }, a.id);
const b = chats.startNew(file);
chats.append(file, { kind: 'user', text: 'b1' }, b.id);
// the run of A is still streaming: its events must not land in B
chats.append(file, { kind: 'text', text: 'a2', agent: 'Phantom' }, a.id);
assert.deepEqual(chats.byId(file, a.id).messages.map((m) => m.text), ['a1', 'a2']);
assert.deepEqual(chats.byId(file, b.id).messages.map((m) => m.text), ['b1']);

// agent sessions are saved per conversation too
chats.setSessions(file, { opencode: 'ses_a' }, a.id);
assert.deepEqual(chats.byId(file, a.id).sessions, { opencode: 'ses_a' });
assert.deepEqual(chats.byId(file, b.id).sessions, {});

// a tool card saved when it starts is updated in place when it finishes (no duplicate in the handoff)
chats.append(file, { kind: 'tool', id: 't1', name: 'execute', status: 'running' }, a.id);
chats.append(file, { kind: 'tool', id: 't1', name: 'execute', status: 'done', output: 'ok' }, a.id);
const cards = chats.byId(file, a.id).messages.filter((m) => m.kind === 'tool');
assert.equal(cards.length, 1);
assert.equal(cards[0].status, 'done');

// a deleted conversation's late events must not fall into the chat that became current
chats.remove(file, b.id);
assert.equal(chats.current(file).id, a.id);
chats.append(file, { kind: 'text', text: 'late', agent: 'Phantom' }, b.id);
assert.deepEqual(chats.byId(file, a.id).messages.map((m) => m.text), ['a1', 'a2', '']);

// a tool still running when the agent stops must not stay spinning in the saved chat
chats.append(file, { kind: 'tool', id: 't2', name: 'execute', status: 'running', agent: 'Phantom' }, a.id);
chats.closeTools(file, a.id, 'Phantom');
assert.equal(chats.byId(file, a.id).messages.filter((m) => m.id === 't2')[0].status, 'error');

// groups: one shared instructions text, and a new chat stays in the group the current one belongs to
const g = chats.saveGroup(file, { name: 'Landing', brief: 'hero em 2 colunas' });
chats.setGroup(file, a.id, g.id);
const c = chats.startNew(file);
chats.append(file, { kind: 'user', text: 'c1' }, c.id);
assert.equal(c.group, g.id);
assert.equal(chats.groupOf(file, c.id)?.brief, 'hero em 2 colunas');
// editing the group reaches every chat in it (the brief is stored once, not copied per chat)
chats.saveGroup(file, { id: g.id, name: 'Landing', brief: 'hero em 3 colunas' });
assert.equal(chats.groupOf(file, a.id).brief, 'hero em 3 colunas');
assert.equal(chats.groups(file).length, 1);
// deleting the group keeps the chats, without a group
chats.removeGroup(file, g.id);
assert.equal(chats.groupOf(file, c.id), null);
assert.ok(chats.byId(file, c.id));
assert.equal(chats.groupOf(file, a.id), null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok    chats');
