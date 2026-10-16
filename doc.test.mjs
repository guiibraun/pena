import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, load, readSkill, systemPrompt } from './doc.mjs';
import { expandDoc, resolveValue, migrate } from './public/pen-core.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-'));
const file = path.join(dir, 't.pen');
const run = (input) => execute(file, { input }).text;

// basic editing
assert.equal(run(`
  const s = Insert(document, { type: 'frame', name: 'Tela', width: 390, height: 844, layout: 'vertical', children: [{ type: 'text', name: 'T', content: 'Oi' }] });
  Update(Get(s).children[0].id, { content: 'Olá', id: 'hack' });
  Copy(s, document, { x: 500 });
  return Get(document, { depth: 0 }).children;`), '...');
let doc = load(file);
assert.equal(doc.children[0].children[0].content, 'Olá');
assert.notEqual(doc.children[1].children[0].id, doc.children[0].children[0].id, 'copy gets fresh ids');

// failure saves nothing and can be patched with edits/editId
const msg = (() => { try { run(`Delete('${doc.children[0].id}'); boom()`); } catch (e) { return e.message; } })();
assert.equal(load(file).children.length, 2, 'failed snippet saves nothing');
const editId = /editId "(\w+)"/.exec(msg)[1];
execute(file, { editId, edits: [{ find: 'boom()', replace: 'Print("fixed")' }] });
assert.equal(load(file).children.length, 1, 'patched snippet ran');

// components: ref + descendants overrides + slash paths
run(`
  const card = Insert(document, { type: 'frame', name: 'Card', reusable: true, layout: 'vertical', children: [
    { type: 'text', name: 'Title', content: 'Default' }, { type: 'text', name: 'Body', content: 'b' }] });
  const titleId = Get(card).children[0].id;
  const a = Insert(document, { type: 'ref', ref: card, name: 'A', descendants: { [titleId]: { content: 'Custom' } } });
  const b = Insert(document, { type: 'ref', ref: card, name: 'B' });
  Update(b + '/' + titleId, { content: 'Via path' });
  Print(Get(a + '/' + titleId).content, Get(b + '/' + titleId).content);
  Copy(a, document, { name: 'A2', descendants: { Body: { content: 'renamed by name' } } });
`);
doc = load(file);
const expanded = expandDoc(doc);
const [A, B] = expanded.filter((n) => n.name === 'A' || n.name === 'B');
assert.equal(A.children[0].content, 'Custom');
assert.equal(B.children[0].content, 'Via path');
assert.match(A.children[0].id, /^\w+\/\w+$/, 'instance children use slash paths');
assert.throws(() => run(`Delete('${A.id}/${A.children[0].id.split('/')[1]}')`), /enabled: false/);

// variables + themes
run(`SetVariables({ bg: { type: 'color', value: [{ value: '#fff' }, { value: '#000', theme: { Mode: 'Dark' } }] } })`);
doc = load(file);
assert.deepEqual(doc.themes, { Mode: ['Dark'] });
assert.equal(resolveValue(doc, '$bg', { Mode: 'Light' }), '#fff');
assert.equal(resolveValue(doc, '$bg', { Mode: 'Dark' }), '#000');

// visitor + FindEmptySpace
assert.match(run(`return Get((n) => n.type === 'text' ? n.content : undefined)`), /Olá/);
assert.ok(JSON.parse(run(`return FindEmptySpace({ width: 100, height: 100 })`)).x > 0);

// legacy pen.dev files open and expand without missing components
for (const f of fs.readdirSync('/tmp/pen-extract/app/out/data').filter((f) => f.endsWith('.pen'))) {
  const d = migrate(JSON.parse(fs.readFileSync(`/tmp/pen-extract/app/out/data/${f}`, 'utf8')));
  const json = JSON.stringify(expandDoc(d));
  assert.ok(!json.includes('Missing component'), `${f}: missing component`);
  assert.ok(!json.includes('"icon_font"'), `${f}: legacy icon_font left`);
}

assert.match(systemPrompt(), /<path>schema.md<\/path>/);
assert.match(readSkill(), /guide\/mobile-app.md/);
assert.throws(() => readSkill('../../package.json'), /not found/);
console.log('all ok');
