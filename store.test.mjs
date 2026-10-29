// The server's copy of the open document (store.mjs): agents' snippets, the editor's saves, the file behind them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { save, load } from './doc.mjs';
import { createStore } from './store.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-store-'));
const file = path.join(dir, 't.pen');
const node = (id, extra = {}) => ({ id, type: 'frame', name: id, x: 0, y: 0, width: 100, height: 100, children: [{ id: id + 'c', type: 'text', name: 'T', content: id }], ...extra });
save(file, { version: '2.21', children: [node('A'), node('B'), node('C')] });

const patches = [];
const store = createStore({ onPatch: (p) => patches.push(p) });
store.open(file);
const run = (input) => store.execute({ input });
const last = () => patches.at(-1);
const onDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const snap = () => JSON.stringify(store.doc);

// a read-only snippet announces nothing and writes nothing
run(`return Get('A', { depth: 0 })`);
assert.equal(patches.length, 0);
assert.equal(store.seq, 0);
assert.equal(store.pending, false);

// Update: only the root that changed, whole; the file is written later, pretty-printed, and is not seen as external
run(`Update('Ac', { content: 'changed' })`);
assert.equal(store.seq, 1);
assert.deepEqual(last().roots.map((r) => r.id), ['A']);
assert.equal(last().roots[0].children[0].content, 'changed');
assert.ok(!('order' in last()) && !('meta' in last()), 'order and meta only when they changed');
assert.equal(onDisk().children[0].children[0].content, 'A', 'debounced: not written yet');
assert.equal(store.pending, true);
await new Promise((r) => setTimeout(r, 450));
assert.equal(store.pending, false);
assert.equal(onDisk().children[0].children[0].content, 'changed');
assert.match(fs.readFileSync(file, 'utf8'), /^\{\n {2}"version"/, 'still pretty-printed JSON (it is tracked in git)');
assert.equal(store.ownWrite, fs.statSync(file).mtimeMs);

// Insert: the new root, and the order
const D = run(`return Insert(document, { type: 'frame', name: 'D', width: 10, height: 10 })`).text;
assert.deepEqual(last().roots.map((r) => r.id), [D]);
assert.deepEqual(last().order, ['A', 'B', 'C', D]);

// Delete (which `touched` does not report for a whole root): the id, and the order
run(`Delete('${D}')`);
assert.deepEqual(last().roots, [{ id: D, deleted: true }]);
assert.deepEqual(last().order, ['A', 'B', 'C']);

// a cross-root Move changes both roots
run(`Move('Ac', 'B')`);
assert.deepEqual(last().roots.map((r) => r.id).sort(), ['A', 'B']);
assert.ok(!('order' in last()));
assert.equal(store.doc.children[1].children.length, 2);

// meta: variables and themes, and no root
run(`SetVariables({ bg: { type: 'color', value: [{ value: '#fff' }, { value: '#000', theme: { Mode: 'Dark' } }] } })`);
assert.deepEqual(last().roots, []);
assert.deepEqual(Object.keys(last().meta.variables), ['bg']);
assert.deepEqual(last().meta.themes, { Mode: ['Dark'] });

// root order alone
run(`Move('C', 'document', 0)`);
assert.deepEqual(last().roots, []);
assert.deepEqual(last().order, ['C', 'A', 'B']);

// seq is monotonic: one per announced change
assert.deepEqual(patches.map((p) => p.seq), [1, 2, 3, 4, 5, 6]);

// atomic: a snippet that throws after editing, inserting, deleting, moving across roots and changing meta changes nothing
const before = snap(), seq = store.seq, announced = patches.length;
const failure = (() => { try { run(`Update('A', { name: 'x' }); Insert(document, { type: 'frame', name: 'N' }); Delete('B'); Move('Cc', 'A'); SetVariables({ z: { type: 'number', value: 1 } }); Move('A', 'document', 2); throw new Error('boom')`); } catch (e) { return e.message; } })();
assert.match(failure, /boom/);
assert.equal(snap(), before, 'document restored');
assert.equal(store.seq, seq);
assert.equal(patches.length, announced, 'nothing announced');
run(`Update('A', { name: 'again' })`);
assert.deepEqual(last().roots.map((r) => [r.id, r.name]), [['A', 'again']], 'the baseline is the restored document');

// the editId flow still works: the failed snippet is patched with edits, not resent
const msg = (() => { try { run(`Update('A', { name: 'late' }); nope()`); } catch (e) { return e.message; } })();
const editId = /editId "(\w+)"/.exec(msg)[1];
assert.equal(store.doc.children.find((c) => c.id === 'A').name, 'again', 'the failed snippet changed nothing');
store.execute({ editId, edits: [{ find: 'nope()', replace: 'Print("ok")' }] });
assert.equal(store.doc.children.find((c) => c.id === 'A').name, 'late');

// a snippet that never ends is cut off and rolled back too
const hang = snap();
assert.throws(() => run(`Update('A', { name: 'hang' }); while (true) {}`), /timed out|Script execution/i);
assert.equal(snap(), hang);

// the editor's save: whole roots, deleted ids, order, meta. Not announced; answers with the current seq.
const n = patches.length, s = store.seq;
const mine = { ...node('E'), name: 'mine' };
assert.equal(store.put({ roots: [mine, { ...node('B'), name: 'edited' }], deleted: ['A'], order: ['E', 'B', 'C'] }), s);
assert.equal(patches.length, n);
assert.deepEqual(store.doc.children.map((c) => c.id), ['E', 'B', 'C']);
assert.equal(store.doc.children[1].name, 'edited');
run(`Update('C', { name: 'by agent' })`); // the next snippet diffs against what the save left
assert.deepEqual(last().roots.map((r) => r.id), ['C']);
// a root the editor does not know yet (its patch is still on the way) survives the editor's order
const F = run(`return Insert(document, { type: 'frame', name: 'F' })`).text;
store.put({ roots: [], deleted: [], order: ['C', 'B', 'E'] });
assert.deepEqual(store.doc.children.map((c) => c.id), ['C', 'B', 'E', F]);
// no order sent: positions stay, new roots go last
store.put({ roots: [node('G')], deleted: ['B'] });
assert.deepEqual(store.doc.children.map((c) => c.id), ['C', 'E', F, 'G']);

// `imports` decide the libraries: a save (or a snippet) that changes them re-attaches `_lib`
fs.writeFileSync(path.join(dir, 'lib.pen'), JSON.stringify({ version: '2.21', variables: { brand: { type: 'color', value: '#f00' } }, children: [node('K', { reusable: true })] }));
assert.equal(store.doc._lib, null);
store.put({ roots: [], deleted: [], meta: { variables: store.doc.variables, themes: store.doc.themes, imports: { q: './lib.pen' } } });
assert.ok(store.doc._lib?.variables['q:brand'], 'library attached');
assert.equal(store.doc._lib.nodes.length, 1);
assert.ok(!JSON.stringify(store.doc).includes('"q:K"'), 'never serialized into the document');
store.put({ roots: [], deleted: [], meta: { variables: store.doc.variables, themes: store.doc.themes } });
assert.equal(store.doc._lib, null, 'library detached');
store.flush();
assert.deepEqual(onDisk().children.map((c) => c.id), ['C', 'E', F, 'G']);

// the file wins over memory when another app writes it: reload drops what was pending
run(`Update('C', { name: 'pending' })`);
save(file, { version: '2.21', children: [node('X')] });
store.reload();
assert.deepEqual(store.doc.children.map((c) => c.id), ['X']);
assert.equal(store.pending, false);
run(`Update('X', { name: 'x2' })`);
assert.deepEqual(last().roots.map((r) => r.id), ['X'], 'the diff base is the reloaded file');

// another app writes the file while changes wait: its roots stay, the ones changed here win, the editor is told
{
  let external = 0;
  const m = createStore({ onExternal: () => external++ });
  m.open(file);
  m.execute({ input: `Update('X', { name: 'mine' })` });
  const theirs = JSON.parse(fs.readFileSync(file, 'utf8'));
  theirs.children.push(node('Y'));
  theirs.children[0].name = 'theirs';
  save(file, theirs);
  m.flush();
  assert.equal(external, 1);
  assert.deepEqual(onDisk().children.map((c) => [c.id, c.name]), [['X', 'mine'], ['Y', 'Y']]);
  m.execute({ input: `Update('Y', { name: 'y2' })` });
  m.flush();
  assert.equal(external, 1, 'our own writes are not external');
  store.reload();
}

// opening another file writes what is pending to the previous one first
const other = path.join(dir, 'other.pen');
save(other, { version: '2.21', children: [node('O')] });
run(`Update('X', { name: 'x3' })`);
store.open(other);
assert.equal(onDisk().children[0].name, 'x3');
assert.deepEqual(store.doc.children.map((c) => c.id), ['O']);
store.flush();

// the process exits right after an edit (the app closed stdin, or SIGTERM): the edit is in the file
const exitFile = path.join(dir, 'exit.pen');
save(exitFile, { version: '2.21', children: [node('A')] });
execFileSync('bun', ['-e', `
  import { createStore } from ${JSON.stringify(path.resolve('store.mjs'))};
  const s = createStore();
  s.open(${JSON.stringify(exitFile)});
  s.execute({ input: "Update('A', { name: 'before exit' })" });
  process.exit(0);
`]);
assert.equal(load(exitFile).children[0].name, 'before exit');
assert.ok(!fs.existsSync(exitFile + '.tmp'));

// File > Open on a file that cannot be read changes nothing: the current document keeps being saved to its own file
{
  const bad = path.join(dir, 'bad.pen');
  fs.writeFileSync(bad, '<<<<<<< HEAD\n{"version":"2.21"}\n=======\n');
  const s = createStore();
  s.open(file);
  assert.throws(() => s.open(bad));
  assert.equal(s.file, file, 'still the old file');
  s.execute({ input: `Update('X', { name: 'still saved' })` });
  s.flush();
  assert.equal(load(file).children[0].name, 'still saved');
}

// a failed write is retried and reported, not swallowed; the change is not lost
{
  const errors = [], reported = [];
  const f = path.join(dir, 'retry.pen');
  save(f, { version: '2.21', children: [node('A')] });
  fs.mkdirSync(f + '.tmp'); // the temp file cannot be created: the write fails
  const s = createStore({ onError: (m) => errors.push(m), onSaveError: (m) => reported.push(m) });
  s.open(f);
  s.execute({ input: `Update('A', { name: 'kept' })` });
  s.flush();
  assert.equal(s.pending, true, 'still dirty after a failed write');
  assert.equal(reported.length, 1);
  assert.throws(() => s.open(file), /Could not save/, 'does not switch away from unsaved changes');
  fs.rmdirSync(f + '.tmp');
  for (let i = 0; i < 60 && s.pending; i++) await new Promise((r) => setTimeout(r, 100)); // the retry backs off: 1 s, then 2 s
  assert.equal(s.pending, false, 'written by a retry');
  assert.equal(load(f).children[0].name, 'kept');
  assert.equal(reported.length, 1, 'reported once, not on every retry');
}

// an async snippet is refused (it would keep editing past the diff and the rollback)
{
  const before = snap();
  assert.throws(() => run(`return (async () => { Update('O', { name: 'late' }); })()`), /synchronous/);
  assert.throws(() => run(`return (async () => { throw new Error('boom'); })()`), /synchronous/, 'a rejecting promise does not crash the process');
  assert.equal(snap(), before, 'nothing changed');
}

// a library that changed on disk is read again by the next snippet
{
  const lib = path.join(dir, 'l.lib.pen'), f = path.join(dir, 'withlib.pen');
  save(lib, { version: '2.21', children: [node('L1', { reusable: true })] });
  save(f, { version: '2.21', imports: { l: './l.lib.pen' }, children: [node('A')] });
  const s = createStore();
  s.open(f);
  assert.ok(String(s.execute({ input: `return JSON.stringify(Get('l:L1', { depth: 0 }))` }).text).includes('L1'));
  await new Promise((r) => setTimeout(r, 20));
  save(lib, { version: '2.21', children: [node('L1', { reusable: true, name: 'renamed' })] });
  assert.ok(String(s.execute({ input: `return JSON.stringify(Get('l:L1', { depth: 0 }))` }).text).includes('renamed'));
}

console.log('ok    store (atomic execute, diff, patches, editor saves, debounced pretty write, flush on exit)');
