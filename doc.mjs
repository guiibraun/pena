// File IO + sandboxed `execute` for .pen documents. The document model itself lives in public/pen-core.js
// so the editor and the agents share one implementation.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './root.mjs';
import { createApi, migrate, loadImportsSync, VERSION } from './public/pen-core.js';

export { createApi };
export const EMPTY = { version: VERSION, children: [] };

export const load = (file) => {
  const doc = migrate(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(EMPTY));
  return loadImportsSync(doc, (p) => fs.readFileSync(path.resolve(path.dirname(file), p), 'utf8')); // libraries (`imports`), never saved
};

// Atomic write so the editor's file watcher never sees a half-written document.
export const save = (file, doc) => {
  fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2));
  fs.renameSync(file + '.tmp', file);
};

// Failed snippets, kept so the agent can patch them with `edits` instead of resending (pen.dev's editId flow).
const failed = new Map();

function patch(editId, edits) {
  let code = failed.get(editId);
  if (code === undefined) throw new Error(`Unknown editId ${editId}: resend the full snippet in \`input\`.`);
  for (const { find, replace, all } of edits) {
    const count = code.split(find).length - 1;
    if (!count) throw new Error(`Edit not applied, \`find\` not found: ${JSON.stringify(find.slice(0, 80))}`);
    if (count > 1 && !all) throw new Error(`\`find\` matches ${count} times; make it unique or set all: true: ${JSON.stringify(find.slice(0, 80))}`);
    code = all ? code.split(find).join(replace) : code.replace(find, () => replace);
  }
  return code;
}

// Runs an agent snippet against a copy of the document; nothing is written if it throws (same contract as pen.dev).
// Returns the printed output plus async work (screenshots/exports) the snippet requested.
// ponytail: vm is scoping, not a security sandbox — fine for a local agent you already trust with your machine.
export function execute(file, { input, edits, editId }, rects) {
  const code = edits?.length ? patch(editId, edits) : input;
  if (typeof code !== 'string') throw new Error('Provide `input`, or `edits` with `editId`.');
  const doc = load(file);
  const out = [], host = { rects };
  // which nodes the snippet wrote or read, for the agent cursor/flash on the canvas (pen.dev shows the same)
  const touched = [];
  const api = createApi(doc, out, host);
  const mark = (kind, id) => typeof id === 'string' && id !== 'document' && touched.push({ kind, id });
  const wrap = (name, kind, pick) => { const fn = api[name]; api[name] = (...a) => { const r = fn(...a); mark(kind, pick(a, r)); return r; }; };
  wrap('Insert', 'insert', (a, r) => r);
  wrap('Copy', 'insert', (a, r) => r);
  wrap('Replace', 'update', (a, r) => r);
  wrap('Update', 'update', (a) => a[0]);
  wrap('Move', 'update', (a) => a[0]);
  wrap('Get', 'read', (a) => (typeof a[0] === 'string' ? a[0] : a[0]?.id ?? a[0]?.path));
  const shot = api.TakeScreenshot;
  api.TakeScreenshot = (ids) => { [].concat(ids).forEach((id) => mark('read', id)); return shot(ids); };
  try {
    const result = vm.runInNewContext(`(() => {\n${code}\n})()`, api, { timeout: 5000 });
    if (result !== undefined) out.push(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (e) {
    const id = editId ?? crypto.randomBytes(3).toString('hex');
    failed.set(id, code);
    throw new Error(`${e.message ?? e}\nNothing was saved. Fix it with \`edits\` and editId "${id}" (do not resend the snippet).`);
  }
  if (editId) failed.delete(editId);
  save(file, doc);
  return { text: out.join('\n') || 'ok', host, touched };
}

// --- skills: same layering as pen.dev — core files go in the system prompt, guides are read on demand ---
const SKILL_DIRS = [path.join(ROOT, 'skills', 'pena'), path.join(os.homedir(), '.pena', 'skills')];
const CORE = ['SKILL.md', 'execute.md', 'schema.md'];

const listSkills = () =>
  SKILL_DIRS.flatMap((dir) =>
    fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => f.split(path.sep).join('/')) : [],
  );

export function readSkill(rel) {
  if (!rel) return `Available files:\n${listSkills().map((f) => `- ${f}`).join('\n')}\n\n${readSkill('SKILL.md')}`;
  for (const dir of SKILL_DIRS) {
    const file = path.resolve(dir, rel);
    if (file.startsWith(path.resolve(dir) + path.sep) && fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  throw new Error(`Skill file not found: ${rel}. Call read_skill() to list files.`);
}

export const systemPrompt = () => CORE.map((f) => `<path>${f}</path>\n<content>${readSkill(f)}</content>`).join('\n\n');
