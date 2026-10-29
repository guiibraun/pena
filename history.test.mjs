import assert from 'node:assert/strict';
import { pushBounded, entrySize } from './public/history.js';

const entry = (chars, tag = '') => ({ order: [], roots: new Map([['r' + tag, 'x'.repeat(chars)], ['gone', null]]), meta: '[]' });
const opts = { max: 300, budget: 1000, keep: 3 };

assert.equal(entrySize(entry(10)), 12);

// count cap
let s = [];
for (let i = 0; i < 305; i++) pushBounded(s, entry(1), { ...opts, budget: 1e9 });
assert.equal(s.length, 300);

// byte budget drops the oldest, keeps order
s = [];
for (let i = 0; i < 20; i++) pushBounded(s, entry(98, i), opts); // 100 each
assert.equal(s.length, 10);
assert.deepEqual([...s.at(0).roots.keys()], ['r10', 'gone']);
assert.deepEqual([...s.at(-1).roots.keys()], ['r19', 'gone']);

// the newest `keep` entries survive even when each one is over budget
s = [];
for (let i = 0; i < 6; i++) pushBounded(s, entry(5000, i), opts);
assert.equal(s.length, 3);
assert.deepEqual([...s.at(0).roots.keys()], ['r3', 'gone']);

// one huge entry on a short stack is kept
s = [];
pushBounded(s, entry(5000), opts);
assert.equal(s.length, 1);

// size is computed once and reused
const e = entry(10); e.size = 7;
pushBounded((s = []), e, opts);
assert.equal(e.size, 7);
console.log('history ok');
