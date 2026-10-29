// The open document, owned by the server: agents and the editor read and write it here, and the file follows.
// The file stays pretty-printed JSON (it is tracked in git), written at most DELAY ms after a change and flushed
// when the process exits. Every change is announced as a patch (`seq` is monotonic) with only the roots that changed.
import fs from 'node:fs';
import { load, run, attachLibs, libStamp, mergeDocs } from './doc.mjs';

const META = ['variables', 'themes', 'fonts', 'imports'];
const metaOf = (d) => JSON.stringify(META.map((k) => d[k]));
const DELAY = 300, RETRY_MAX = 10_000, REPORT_EVERY = 10_000;

// onPatch({ seq, roots: [root | { id, deleted: true }], order?: [ids], meta?: { variables, themes, fonts, imports } })
// onExternal(): another app wrote the file while changes were waiting; both were merged and the editor must reload.
// onSaveError(message): a write failed (it is retried, backing off up to RETRY_MAX ms) so the editor can say so.
export function createStore({ onPatch = () => {}, onExternal = () => {}, onSaveError = () => {}, onError = console.error } = {}) {
  let file = null, doc = null, ownWrite = 0, dirty = false, timer = 0, seq = 0, retry = 0, reported = 0, libs = '';
  let edits = { roots: new Set(), meta: false, order: false }; // what changed since the last write (for the merge below)
  // what the document looked like at the last sync, as strings: the diff base and the undo of a failed snippet
  let roots = new Map(), order = [], meta = '';

  const snapshot = () => {
    roots = new Map(doc.children.map((c) => [c.id, JSON.stringify(c)]));
    order = doc.children.map((c) => c.id);
    meta = metaOf(doc);
  };

  // atomic, so a reader of the file never sees half a document
  function flush() {
    clearTimeout(timer);
    timer = 0;
    if (!dirty || !doc) return;
    try {
      // the file is not the one we wrote last: another app got in. Their roots stay, the ones changed here win (mergeDocs).
      const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      const external = mtime && mtime !== ownWrite;
      if (external) { doc = mergeDocs(load(file), doc, { ...edits, roots: [...edits.roots] }); snapshot(); }
      fs.writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2));
      fs.renameSync(file + '.tmp', file);
      ownWrite = fs.statSync(file).mtimeMs; // our own write must not come back as a "changed on disk" event
      dirty = false;
      edits = { roots: new Set(), meta: false, order: false };
      retry = 0;
      if (external) onExternal();
    } catch (e) {
      // stays dirty and is tried again (a virus scanner or sync client may hold the file for a moment); exit tries once more
      onError(`Pena: could not save ${file}: ${e.message}`);
      if (Date.now() - reported > REPORT_EVERY) (reported = Date.now(), onSaveError(e.message));
      retry = Math.min(RETRY_MAX, (retry || 500) * 2);
      timer = setTimeout(flush, retry);
    }
  }
  const touch = () => { dirty = true; timer ||= setTimeout(flush, DELAY); }; // not restarted by later changes: <= DELAY after the first
  process.on('exit', flush); // SIGTERM/SIGINT/stdin end all end in process.exit()

  // What differs from the last sync: roots (by content), order, meta.
  function diff() {
    const now = new Map(), changed = [];
    for (const c of doc.children) {
      const j = JSON.stringify(c);
      now.set(c.id, j);
      if (roots.get(c.id) !== j) changed.push(c);
    }
    const ids = doc.children.map((c) => c.id), m = metaOf(doc);
    return { now, changed, deleted: [...roots.keys()].filter((id) => !now.has(id)), ids, meta: m,
      orderChanged: ids.join() !== order.join(), metaChanged: m !== meta };
  }

  // Put the document back as it was at the last sync (a snippet threw): only what differs is parsed again.
  function rollback(d) {
    const byId = new Map(doc.children.map((c) => [c.id, c]));
    for (const c of d.changed) roots.has(c.id) ? byId.set(c.id, JSON.parse(roots.get(c.id))) : byId.delete(c.id);
    for (const id of d.deleted) byId.set(id, JSON.parse(roots.get(id)));
    doc.children = order.map((id) => byId.get(id));
    if (d.metaChanged) setMeta(JSON.parse(meta));
  }
  // `imports` decide the libraries attached to the document: refresh them when they change
  function setMeta(values) {
    const imports = JSON.stringify(doc.imports);
    META.forEach((k, i) => (values[i] == null ? delete doc[k] : (doc[k] = values[i])));
    if (JSON.stringify(doc.imports) !== imports) (attachLibs(doc, file), libs = libStamp(doc));
  }

  return {
    get doc() { return doc; },
    get seq() { return seq; },
    get file() { return file; },
    get ownWrite() { return ownWrite; },
    get pending() { return dirty; },

    // Switch files (File > Open): what is pending goes to the old one first.
    open(next) {
      flush();
      if (dirty) throw new Error(`Could not save ${file} before opening another file`);
      const d = load(next), m = fs.statSync(next).mtimeMs; // if either throws, nothing below happened
      file = next;
      doc = d;
      ownWrite = m;
      dirty = false;
      retry = 0;
      edits = { roots: new Set(), meta: false, order: false };
      libs = libStamp(doc);
      snapshot();
    },
    // The file changed under us (another app) and nothing was waiting to be written: take it. (With writes waiting, flush() merges.)
    reload() {
      clearTimeout(timer);
      timer = 0;
      dirty = false;
      edits = { roots: new Set(), meta: false, order: false };
      doc = load(file);
      ownWrite = fs.statSync(file).mtimeMs;
      libs = libStamp(doc);
      snapshot();
    },
    flush,

    // An agent snippet, on the document in memory. Atomic: if it throws, nothing changes.
    execute(args, rects) {
      let r;
      if (libStamp(doc) !== libs) (attachLibs(doc, file), libs = libStamp(doc)); // a library changed on disk
      try { r = run(doc, file, args, rects); } catch (e) { rollback(diff()); throw e; }
      const d = diff();
      if (d.metaChanged && JSON.stringify(JSON.parse(meta)[3] ?? null) !== JSON.stringify(doc.imports ?? null)) (attachLibs(doc, file), libs = libStamp(doc));
      const rootPatches = [...d.changed, ...d.deleted.map((id) => ({ id, deleted: true }))];
      if (rootPatches.length || d.orderChanged || d.metaChanged) {
        roots = d.now;
        order = d.ids;
        meta = d.meta;
        rootPatches.forEach((r) => edits.roots.add(r.id));
        edits.order ||= d.orderChanged;
        edits.meta ||= d.metaChanged;
        touch();
        onPatch({
          seq: ++seq,
          roots: rootPatches,
          ...(d.orderChanged && { order: d.ids }),
          ...(d.metaChanged && { meta: Object.fromEntries(META.map((k) => [k, doc[k]])) }),
        });
      }
      return r;
    },

    // The editor's save: roots it edited (whole), ids it deleted, and the order / meta when they changed.
    // Not announced as a patch (the editor already has it); returns the current seq so it can order patches against it.
    put({ roots: edited = [], deleted = [], order: ids, meta: m }) {
      const byId = new Map(doc.children.map((c) => [c.id, c]));
      for (const r of edited) byId.set(r.id, r), roots.set(r.id, JSON.stringify(r));
      for (const id of deleted) byId.delete(id), roots.delete(id);
      // the editor's order, then roots it does not know yet (an agent's patch still on its way)
      const known = new Set(ids);
      doc.children = ids ? [...ids.filter((id) => byId.has(id)).map((id) => byId.get(id)), ...[...byId.values()].filter((c) => !known.has(c.id))] : [...byId.values()];
      order = doc.children.map((c) => c.id);
      if (m) setMeta(META.map((k) => m[k]));
      if (m) meta = metaOf(doc);
      [...edited.map((r) => r.id), ...deleted].forEach((id) => edits.roots.add(id));
      edits.order ||= !!ids;
      edits.meta ||= !!m;
      touch();
      return seq;
    },
  };
}
