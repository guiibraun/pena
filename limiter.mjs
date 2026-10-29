// At most `max` jobs at once, the rest wait in arrival order. Every agent CLI is a ~300 MB process.
// acquire() resolves to a release(); an aborted signal takes a waiting job out of the line (and rejects).
export function createLimiter(max = 3) {
  let active = 0;
  const line = [];
  const grant = () => {
    while (active < max && line.length) {
      const w = line.shift();
      active++;
      w.resolve(w.release);
    }
  };
  return {
    max,
    get active() { return active; },
    get waiting() { return line.length; },
    // true when a job that asks now has to wait
    get full() { return active >= max || line.length > 0; },
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
      return new Promise((resolve, reject) => {
        let done = false;
        const release = () => { if (!done) { done = true; active--; grant(); } };
        const w = { resolve: (r) => { signal?.removeEventListener('abort', onAbort); resolve(r); }, release };
        const onAbort = () => { line.splice(line.indexOf(w), 1); reject(signal.reason ?? new Error('aborted')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        line.push(w);
        grant();
      });
    },
  };
}
