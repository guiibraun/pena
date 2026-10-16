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

const newConv = () => ({ id: crypto.randomUUID().slice(0, 8), title: 'Novo agente', created: Date.now(), updated: Date.now(), sessions: {}, messages: [] });

export function current(file, { create = false } = {}) {
  const s = load(file);
  let c = s.list.find((x) => x.id === s.current);
  if (!c && create) { c = newConv(); s.list.unshift(c); s.current = c.id; save(); }
  return c ?? null;
}
export function startNew(file) {
  const s = load(file);
  if (current(file)?.messages.length === 0) return current(file); // reuse an empty one
  const c = newConv();
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
  return { current: s.current, list: s.list.filter((c) => c.messages.length).map(({ id, title, created, updated, messages }) => ({ id, title, created, updated, count: messages.length })) };
};
export function append(file, msg) {
  const c = current(file, { create: true });
  if (msg.kind === 'user' && !c.messages.some((m) => m.kind === 'user')) c.title = (msg.text || 'Arquivos anexados').slice(0, 60);
  c.messages.push({ ...msg, text: String(msg.text ?? '').slice(0, MAX_TEXT), t: Date.now() });
  c.updated = Date.now();
  save();
}
export function setSessions(file, sessions) {
  const c = current(file, { create: true });
  c.sessions = sessions;
  save();
}
