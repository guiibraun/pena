import assert from 'node:assert/strict';
import { searchFiles } from './public/file-search.js';

const f = (path, folder, openedAt = 0) => ({ path, folder, name: path.split('/').pop(), openedAt });
const items = [
  f('/Users/a/Clientes/Acme/landing.pen', 'Acme', 3),
  f('/Users/a/Clientes/Acme/Dashboard.pen', 'Acme', 2),
  f('/Users/a/Pessoal/Currículo.pen', 'Pessoal', 1),
  f('/Users/a/.pena/documents/x/untitled.pen', 'Rascunho', 4),
];
const names = (q) => searchFiles(items, q).map((d) => d.name);

assert.deepEqual(names(''), items.map((d) => d.name)); // no query: untouched
assert.deepEqual(names('acme'), ['landing.pen', 'Dashboard.pen']); // folder name finds its files, newest first
assert.deepEqual(names('curriculo'), ['Currículo.pen']); // accents ignored
assert.deepEqual(names('acme dash'), ['Dashboard.pen']); // every word must match, name or folder
assert.deepEqual(names('clientes land'), ['landing.pen']); // a grandparent folder counts
assert.deepEqual(names('lndg'), ['landing.pen']); // gaps in the word
assert.deepEqual(names('rascunho'), ['untitled.pen']); // the dashboard's folder label
assert.deepEqual(names('zzz'), []);
assert.equal(searchFiles([f('/a/Acme/x.pen', 'Acme'), f('/a/b/acme.pen', 'b')], 'acme')[0].name, 'acme.pen'); // name beats folder
console.log('file-search ok');
