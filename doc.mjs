// File IO + sandboxed `execute` for .pen documents. The document model itself lives in public/pen-core.js
// so the editor and the agents share one implementation.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './root.mjs';
import { createApi, mergeDocs, migrate, loadImportsSync, VERSION } from './public/pen-core.js';
import { parseUniforms, controls, toSkSL } from './public/shader.js';

export { createApi, mergeDocs };
export const EMPTY = { version: VERSION, children: [] };

// libraries (`imports`) are attached non-enumerably, so they are never saved; call again when `imports` changes
export const attachLibs = (doc, file) => {
  const files = [];
  loadImportsSync(doc, (p) => (files.push(path.resolve(path.dirname(file), p)), fs.readFileSync(files.at(-1), 'utf8')));
  return Object.defineProperty(doc, '_libFiles', { value: files, writable: true, configurable: true, enumerable: false });
};
// changes when a library file does (another tab or app edited it): the server re-reads the libraries then
export const libStamp = (doc) => (doc._libFiles ?? []).map((f) => fs.statSync(f, { throwIfNoEntry: false })?.mtimeMs ?? 0).join();
export const load = (file) => attachLibs(migrate(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : structuredClone(EMPTY)), file);

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

// Runs an agent snippet on `doc` in place. On a throw the document may be half edited: the caller undoes that (same
// contract as pen.dev: nothing is saved). Returns the printed output plus async work (screenshots/exports) the snippet requested.
// ponytail: vm is scoping, not a security sandbox — fine for a local agent you already trust with your machine.
export function run(doc, file, { input, edits, editId }, rects) {
  const code = edits?.length ? patch(editId, edits) : input;
  if (typeof code !== 'string') throw new Error('Provide `input`, or `edits` with `editId`.');
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
  Object.assign(api, shaderApi(file));
  try {
    const result = vm.runInNewContext(`(() => {\n${code}\n})()`, api, { timeout: 5000 });
    // an async snippet would keep editing after this returns, past the diff and the rollback: refuse it
    if (typeof result?.then === 'function') { result.then?.(null, () => {}); throw new Error('The snippet must be synchronous: no async/await, no returned Promise.'); } // (a rejection of the dropped promise must not crash the server)
    if (result !== undefined) out.push(typeof result === 'string' ? result : JSON.stringify(result));
  } catch (e) {
    const id = editId ?? crypto.randomBytes(3).toString('hex');
    failed.set(id, code);
    throw new Error(`${e.message ?? e}\nNothing was saved. Fix it with \`edits\` and editId "${id}" (do not resend the snippet).`);
  }
  if (editId) failed.delete(editId);
  return { text: out.join('\n') || 'ok', host, touched };
}

// Without a running app (standalone mcp.mjs): on a copy read from the file, written back only if the snippet succeeds.
export function execute(file, args, rects) {
  const doc = load(file), r = run(doc, file, args, rects);
  save(file, doc);
  return r;
}

// --- shaders for agents: .glsl files live next to the .pen (shaders/), like images, so pen.dev opens them too.
// Written right away, not with the document: a snippet that throws later leaves the file (harmless, unreferenced).
const SHADER_LIB = path.join(ROOT, 'public', 'shaders');
function shaderApi(file) {
  const dir = path.join(path.dirname(file), 'shaders');
  const write = (name, src) => {
    if (!/^[\w-]+$/.test(name ?? '')) throw new Error('Shader name: letters, digits, - and _ only, e.g. "glow"');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.glsl`), src);
    return `./shaders/${name}.glsl`;
  };
  return {
    // Pena's library: [{ name, label, kind: "effect" | "fill", uniforms: [{ name, type, label, default, min, max, color }] }]
    ListShaders: () => JSON.parse(fs.readFileSync(path.join(SHADER_LIB, 'library.json'), 'utf8')).map((s) => ({
      ...s, uniforms: controls(parseUniforms(fs.readFileSync(path.join(SHADER_LIB, `${s.name}.glsl`), 'utf8'))).map(({ name, type, label, default: d, min, max, color }) => ({ name, type, label, default: d, min, max, color })),
    })),
    // copies a library shader next to the document and returns its url, for { type: "shader", url }
    UseShader: (name) => {
      const src = path.join(SHADER_LIB, `${name}.glsl`);
      if (!/^[\w-]+$/.test(name ?? '') || !fs.existsSync(src)) throw new Error(`Unknown shader "${name}". ListShaders() lists them.`);
      const own = path.join(dir, `${name}.glsl`);
      if (fs.existsSync(own) && fs.readFileSync(own, 'utf8') !== fs.readFileSync(src, 'utf8')) return `./shaders/${name}.glsl`; // keep local edits
      return write(name, fs.readFileSync(src, 'utf8'));
    },
    // writes your own GLSL shader (overwrites the same name) and returns its url; structure is checked here, the
    // compile itself happens in the editor (TakeScreenshot reports compile errors)
    WriteShader: (name, source) => { toSkSL(String(source ?? '')); return write(name, String(source)); },
  };
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
