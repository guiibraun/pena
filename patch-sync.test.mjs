// How the editor takes the server's patches next to its own edits (public/patch-sync.js).
import assert from 'node:assert/strict';
import { META, ORDER, newState, route, begin, settle, failed, reset } from './public/patch-sync.js';

const root = (id, v = 0) => ({ id, type: 'frame', v });
const patch = (seq, ids, extra = {}) => ({ seq, roots: ids.map((id) => (typeof id === 'string' ? root(id, seq) : id)), ...extra });
const keys = (parts) => parts.map((p) => p.key);
const loaded = (seq = 10) => { const st = newState(); reset(st, seq); return st; };

// nothing is applied before a document is loaded; patches the fetched document already has are skipped
assert.equal(route(patch(1, ['A']), newState()).type, 'skip');
let st = loaded(10);
assert.equal(route(patch(10, ['A']), st).type, 'skip');
assert.equal(route(patch(7, ['A']), st).type, 'skip');
assert.equal(st.seq, 10);

// the next one applies, in order; a missed one means reload
let r = route(patch(11, ['A', 'B']), st);
assert.equal(r.type, 'ok');
assert.deepEqual(keys(r.apply), ['A', 'B']);
assert.equal(st.seq, 11);
assert.equal(route(patch(13, ['A']), st).type, 'reload');
assert.equal(st.seq, 11, 'a gap changes nothing: the reload resets it');
assert.equal(route(patch(11, ['A']), st).type, 'skip', 'duplicate');

// order and meta are parts of their own
r = route(patch(12, ['A'], { order: ['B', 'A'], meta: { variables: {} } }), st);
assert.deepEqual(keys(r.apply), ['A', ORDER, META]);
assert.deepEqual(r.apply[1].value, ['B', 'A']);

// an edit not saved yet wins: the patch for that root is skipped, the others apply
st = loaded();
st.unsaved.add('A');
r = route(patch(11, ['A', 'B'], { order: ['A', 'B'] }), st);
assert.deepEqual(keys(r.apply), ['B', ORDER]);
st.unsaved.add(ORDER).add(META);
r = route(patch(12, ['B'], { order: ['B', 'A'], meta: {} }), st);
assert.deepEqual(keys(r.apply), ['B'], 'unsaved order and meta win too');

// a root whose PUT is in flight waits for the answer: later patches are applied after it, earlier ones were overwritten
st = loaded(10);
st.unsaved.add('A').add('B');
assert.deepEqual([...begin(st)], ['A', 'B']);
assert.equal(st.unsaved.size, 0);
r = route(patch(11, ['A', 'C']), st); // happened before the server applied our PUT
assert.deepEqual(keys(r.apply), ['C']);
assert.deepEqual(keys(r.defer), ['A']);
r = route(patch(12, ['B']), st); // after it
assert.deepEqual(keys(r.defer), ['B']);
assert.deepEqual(keys(settle(st, 11)), ['B'], 'the server had sent 11 patches when it applied the PUT: 11 is stale, 12 is newer');
assert.equal(st.flight, null);
assert.equal(st.deferred.length, 0);

// ... unless the root was edited again meanwhile (unsaved wins)
st = loaded(10);
st.unsaved.add('A');
begin(st);
route(patch(11, ['A']), st);
st.unsaved.add('A');
assert.deepEqual(settle(st, 10), []);

// a patch that overtakes the PUT's answer on the wire is still stale afterwards
st = loaded(10);
st.unsaved.add('A');
begin(st);
assert.deepEqual(settle(st, 11), []); // the answer came first: the server had already sent patch 11
r = route(patch(11, ['A', 'B']), st); // and now patch 11 arrives
assert.deepEqual(keys(r.apply), ['B']);
r = route(patch(12, ['A']), st); // a newer one is fine
assert.deepEqual(keys(r.apply), ['A']);

// a failed PUT: its keys are unsaved again (and win over what waited)
st = loaded(10);
st.unsaved.add('A').add(ORDER);
begin(st);
route(patch(11, ['A']), st);
failed(st);
assert.deepEqual([...st.unsaved].sort(), ['A', ORDER].sort());
assert.equal(st.flight, null);
assert.equal(st.deferred.length, 0);

// a fetched document ends the history: floors and parked patches go, the seq is the fetched one
st = loaded(10);
st.unsaved.add('A');
begin(st);
settle(st, 10);
assert.equal(st.floor.get('A'), 10);
reset(st, 20);
assert.equal(st.floor.size, 0);
assert.equal(route(patch(21, ['A']), st).apply.length, 1);

console.log('ok    patch-sync (unsaved wins, in-flight deferral by seq, gap detection)');
