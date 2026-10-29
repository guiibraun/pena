import assert from 'node:assert/strict';
import { createLimiter } from './limiter.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

// fake turns: each one records start order and finishes when told to
async function demo() {
  const lim = createLimiter(3);
  const started = [], finish = [];
  const job = (i, signal) => lim.acquire(signal).then(async (release) => {
    started.push(i);
    await new Promise((r) => finish.push(r));
    release();
  }, () => started.push(`x${i}`));
  const ctl = Array.from({ length: 8 }, () => new AbortController());
  const jobs = ctl.map((c, i) => job(i, c.signal));
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(lim.active, 3);
  assert.equal(lim.waiting, 5);
  assert.equal(lim.full, true);

  // a waiting job that is stopped leaves the line without taking a slot, the others keep their order
  ctl[4].abort();
  await tick();
  assert.deepEqual(started, [0, 1, 2, 'x4']);
  assert.equal(lim.waiting, 4);

  finish[1](); // job 1 ends: job 3 starts (FIFO)
  await tick();
  assert.deepEqual(started.slice(4), [3]);
  finish[0](); finish[2]();
  await tick();
  assert.deepEqual(started.slice(5), [5, 6]);
  assert.equal(lim.active, 3);
  assert.equal(lim.waiting, 1);

  // aborting a running job's signal does nothing to the slot: release() frees it
  ctl[3].abort();
  await tick();
  assert.equal(lim.active, 3);
  finish.slice(3).forEach((f) => f());
  await tick();
  assert.deepEqual(started.slice(7), [7]);
  finish.slice(-1)[0]();
  await Promise.all(jobs.filter((_, i) => i !== 4));
  assert.equal(lim.active, 0);
  assert.equal(lim.full, false);
}
await demo();

// release twice frees one slot; an already aborted signal rejects at once and takes nothing
const lim = createLimiter(1);
const r1 = await lim.acquire();
r1(); r1();
assert.equal(lim.active, 0);
const c = new AbortController(); c.abort();
await assert.rejects(lim.acquire(c.signal));
assert.equal(lim.active + lim.waiting, 0);

// max 1 is strictly sequential
const one = createLimiter(1), order = [];
const a = await one.acquire();
const second = one.acquire().then((rel) => (order.push('b'), rel()));
const third = one.acquire().then((rel) => (order.push('c'), rel()));
order.push('a'); a();
await Promise.all([second, third]);
assert.deepEqual(order, ['a', 'b', 'c']);
console.log('limiter ok');
