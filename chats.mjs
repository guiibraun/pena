// Chat history per .pen file, in ~/.pena/chats/<hash>.json: every conversation's messages plus the agent session
// ids (Claude session / Codex thread), so reopening a file shows the chat and the agent keeps its context.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PENA_DIR } from './library.mjs';

const DIR = path.join(PENA_DIR, 'chats');
const fileOf = (doc) => path.join(DIR, `${crypto.createHash('sha1').update(doc).digest('hex').slice(0, 16)}.json`);
const MAX_TEXT = 20_000; // per message; tool output can be huge

let doc = null, store = null, saveTimer = null;

function load(file) {
  if (doc === file) return store;
  flush();
  doc = file;
  try { store = JSON.parse(fs.readFileSync(fileOf(file), 'utf8')); } catch { store = { file, current: null, list: [] }; }
  return store;
}
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!doc || !store) return;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileOf(doc) + '.tmp', JSON.stringify(store));
  fs.renameSync(fileOf(doc) + '.tmp', fileOf(doc));
}
const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 500); };
process.on('exit', flush);

const newConv = (group = null) => ({ id: crypto.randomUUID().slice(0, 8), group, title: 'Novo agente', created: Date.now(), updated: Date.now(), sessions: {}, messages: [] });

export const byId = (file, id) => load(file).list.find((x) => x.id === id) ?? null;
export function current(file, { create = false } = {}) {
  const s = load(file);
  let c = s.list.find((x) => x.id === s.current);
  if (!c && create) { c = newConv(); s.list.unshift(c); s.current = c.id; save(); }
  return c ?? null;
}
export function startNew(file) {
  const s = load(file);
  if (current(file)?.messages.length === 0) return current(file); // reuse an empty one
  const c = newConv(current(file)?.group ?? null); // a new chat stays in the group the user is working in
  s.list.unshift(c); s.current = c.id; save();
  return c;
}
export function select(file, id) {
  const s = load(file);
  if (!s.list.some((x) => x.id === id)) throw new Error('Conversa não encontrada');
  s.current = id; save();
  return current(file);
}
export function remove(file, id) {
  const s = load(file);
  s.list = s.list.filter((x) => x.id !== id);
  if (s.current === id) s.current = s.list[0]?.id ?? null;
  save();
}
export const list = (file) => {
  const s = load(file);
  return { current: s.current, list: s.list.filter((c) => c.messages.length).map(({ id, title, created, updated, messages, group }) => ({ id, title, created, updated, group: group ?? null, count: messages.length })) };
};

// Groups (a named project context): one shared instructions text, injected into every agent of every chat in the
// group, instead of each chat keeping its own copy.
export const groups = (file) => (load(file).groups ??= []);
export function groupOf(file, convId) {
  const s = load(file);
  const c = convId ? s.list.find((x) => x.id === convId) : null;
  return c?.group ? (s.groups ?? []).find((g) => g.id === c.group) ?? null : null;
}
export function saveGroup(file, { id, name, brief }) {
  const s = load(file);
  const list = (s.groups ??= []);
  const clean = { name: String(name ?? '').trim().slice(0, 80), brief: String(brief ?? '').trim().slice(0, 4000) };
  if (!clean.name) throw new Error('Dê um nome ao grupo');
  let g = id && list.find((x) => x.id === id);
  if (g) Object.assign(g, clean);
  else list.push(g = { id: crypto.randomUUID().slice(0, 8), created: Date.now(), ...clean });
  save();
  return g;
}
export function removeGroup(file, id) {
  const s = load(file);
  s.groups = (s.groups ?? []).filter((g) => g.id !== id);
  for (const c of s.list) if (c.group === id) delete c.group;
  save();
}
export function setGroup(file, convId, groupId) {
  const s = load(file);
  const c = s.list.find((x) => x.id === convId);
  if (!c) throw new Error('Conversa não encontrada');
  if (groupId && !(s.groups ?? []).some((g) => g.id === groupId)) throw new Error('Grupo não encontrado');
  if (groupId) c.group = groupId; else delete c.group;
  c.updated = Date.now();
  save();
  return c;
}
// `id` is the conversation the agent belongs to: a turn running in the background still writes to its own chat after
// the user switched to another one. A deleted conversation is gone: its late events go nowhere instead of into `current`.
export function append(file, msg, id) {
  const c = id ? byId(file, id) : current(file, { create: true });
  if (!c) return;
  if (msg.kind === 'user' && !c.messages.some((m) => m.kind === 'user')) c.title = (msg.text || 'Arquivos anexados').slice(0, 60);
  const item = { ...msg, text: String(msg.text ?? '').slice(0, msg.kind === 'handoff' ? Infinity : MAX_TEXT), t: Date.now() }; // a handoff is kept as sent
  // a tool card is saved when it starts and updated in place when it finishes, so a chat switched to mid-run shows the
  // current step and the handoff history has one card per tool
  const running = msg.kind === 'tool' && msg.id != null ? c.messages.findLastIndex((m) => m.kind === 'tool' && m.id === msg.id && m.status === 'running') : -1;
  if (running >= 0) c.messages[running] = item; else c.messages.push(item);
  c.updated = Date.now();
  save();
}
export function setSessions(file, sessions, id) {
  const c = id ? byId(file, id) : current(file, { create: true });
  if (!c) return;
  c.sessions = sessions;
  save();
}
// A run stopped or failing between a tool's start and its result would leave that card spinning in the saved chat.
export function closeTools(file, id, agent) {
  const c = byId(file, id);
  let hit = false;
  for (const m of c?.messages ?? []) if (m.kind === 'tool' && m.agent === agent && m.status === 'running') (m.status = 'error'), (hit = true);
  if (hit) save();
}
