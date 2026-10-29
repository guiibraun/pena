// How the editor takes the server's patches (SSE `patch`: { seq, roots, order?, meta? }) while it has edits of its own.
// The editor owns the state `st`; these functions only decide. Everything a patch can change is a key: a root id,
// META (variables/themes/fonts/imports) or ORDER (the order of the roots). A patch is split into parts, one per key.
//
//   st.seq       last patch seen, or the one the fetched document already includes (null: nothing loaded yet)
//   st.unsaved   keys edited here and not sent yet — they win over the server's version
//   st.flight    keys in the PUT being sent; the patches for them wait (st.deferred) for the PUT's answer
//   st.floor     key -> seq the server had reached when it applied our last PUT of that key: older patches are stale
export const META = '\0meta', ORDER = '\0order';

export const newState = () => ({ seq: null, unsaved: new Set(), flight: null, floor: new Map(), deferred: [] });

const partsOf = (p) => [
  ...p.roots.map((r) => ({ seq: p.seq, key: r.id, value: r })),
  ...(p.order ? [{ seq: p.seq, key: ORDER, value: p.order }] : []),
  ...(p.meta ? [{ seq: p.seq, key: META, value: p.meta }] : []),
];

// A patch arrived. -> { type: 'skip' }   the document we fetched already has it
//                     { type: 'reload' } one was missed: fetch the whole document
//                     { type: 'ok', apply, defer } parts to apply now / parts parked until the PUT answers (already in st.deferred)
export function route(p, st) {
  if (st.seq == null || p.seq <= st.seq) return { type: 'skip' };
  if (p.seq !== st.seq + 1) return { type: 'reload' };
  st.seq = p.seq;
  const apply = [], defer = [];
  for (const part of partsOf(p)) {
    if (st.unsaved.has(part.key)) continue; // a local edit not saved yet wins, like mergeDocs
    if (part.seq <= (st.floor.get(part.key) ?? 0)) continue; // our PUT came after this patch (it overtook it on the wire)
    (st.flight?.has(part.key) ? defer : apply).push(part);
  }
  st.deferred.push(...defer);
  return { type: 'ok', apply, defer };
}

// A save starts: what was unsaved is now in flight.
export function begin(st) {
  st.flight = st.unsaved;
  st.unsaved = new Set();
  return st.flight;
}

// The PUT was answered; the server had sent `q` patches when it applied it. Patches after that happened later and
// win (unless we edited the key again meanwhile); the ones up to `q` were overwritten by the PUT. -> parts to apply
export function settle(st, q) {
  for (const key of st.flight) st.floor.set(key, q);
  st.flight = null;
  const later = st.deferred.filter((part) => part.seq > q && !st.unsaved.has(part.key));
  st.deferred = [];
  return later;
}

// The PUT failed: its keys are unsaved again (a retry sends them), and whatever waited for it is dropped, since they win.
export function failed(st) {
  for (const key of st.flight) st.unsaved.add(key);
  st.flight = null;
  st.deferred = [];
}

// A whole document was fetched at patch `seq`: patches and PUT bookkeeping before it are history.
export function reset(st, seq) {
  st.seq = seq;
  st.floor.clear();
  st.deferred = [];
}
