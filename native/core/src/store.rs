// The open document, owned by the server: agents and the editor read and write it here, and the file follows (store.mjs).
// The file stays pretty-printed JSON (it is tracked in git), written at most DELAY after a change; the server flushes
// it on exit. Every change is announced as a patch (`seq` is monotonic) with only the roots that changed.
// Timers are std threads (one short sleeper per pending write), so the store needs no async runtime.
use crate::doc::{self, Exec, Loaded};
use anyhow::{Result, anyhow, bail};
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant, SystemTime};

const META: [&str; 4] = ["variables", "themes", "fonts", "imports"];
const DELAY: u64 = 300;
const RETRY_MAX: u64 = 10_000;
const REPORT_EVERY: Duration = Duration::from_secs(10);

fn meta_of(d: &Value) -> String {
    Value::Array(META.iter().map(|k| d.get(*k).cloned().unwrap_or(Value::Null)).collect()).to_string()
}
fn id_of(c: &Value) -> String {
    c["id"].as_str().map(str::to_string).unwrap_or_else(|| c["id"].to_string())
}
fn children(d: &Value) -> &[Value] {
    d["children"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn mtime(f: &Path) -> Option<SystemTime> {
    fs::metadata(f).and_then(|m| m.modified()).ok()
}

#[derive(Default)]
struct Edits {
    roots: HashSet<String>,
    meta: bool,
    order: bool,
}

// What differs from the last sync: roots (by content), order, meta.
struct Diff {
    now: IndexMap<String, String>,
    changed: Vec<Value>,
    deleted: Vec<String>,
    ids: Vec<String>,
    meta: String,
    order_changed: bool,
    meta_changed: bool,
}

#[derive(Default)]
struct State {
    file: Option<PathBuf>,
    doc: Value, // Null until open()
    lib: Value,
    lib_files: Vec<PathBuf>,
    libs: String,
    own_write: Option<SystemTime>,
    dirty: bool,
    timer: u64, // the pending timer's generation, 0 = none
    timers: u64,
    seq: u64,
    retry: u64,
    reported: Option<Instant>,
    edits: Edits, // what changed since the last write (for the merge in flush)
    // what the document looked like at the last sync, as strings: the diff base
    roots: IndexMap<String, String>,
    order: Vec<String>,
    meta: String,
}

impl State {
    fn file(&self) -> Result<&Path> {
        self.file.as_deref().ok_or_else(|| anyhow!("No file is open"))
    }
    fn snapshot(&mut self) {
        self.roots = children(&self.doc).iter().map(|c| (id_of(c), c.to_string())).collect();
        self.order = children(&self.doc).iter().map(id_of).collect();
        self.meta = meta_of(&self.doc);
    }
    fn set_libs(&mut self, l: Loaded) {
        (self.doc, self.lib, self.lib_files) = (l.doc, l.lib, l.files);
    }
    fn attach(&mut self) -> Result<()> {
        let (lib, files) = doc::attach_libs(&self.doc, self.file()?)?;
        (self.lib, self.lib_files) = (lib, files);
        self.libs = doc::lib_stamp(&self.lib_files);
        Ok(())
    }
    fn diff(&self) -> Diff {
        let (mut now, mut changed) = (IndexMap::new(), vec![]);
        for c in children(&self.doc) {
            let j = c.to_string();
            if self.roots.get(&id_of(c)) != Some(&j) {
                changed.push(c.clone());
            }
            now.insert(id_of(c), j);
        }
        let ids: Vec<String> = now.keys().cloned().collect();
        let m = meta_of(&self.doc);
        Diff {
            deleted: self.roots.keys().filter(|id| !now.contains_key(*id)).cloned().collect(),
            order_changed: ids != self.order,
            meta_changed: m != self.meta,
            now,
            changed,
            ids,
            meta: m,
        }
    }
    // `imports` decide the libraries attached to the document: refresh them when they change
    fn set_meta(&mut self, values: &[Value]) -> Result<()> {
        let imports = self.doc.get("imports").map(Value::to_string);
        let d = self.doc.as_object_mut().ok_or_else(|| anyhow!("No file is open"))?;
        for (k, v) in META.iter().zip(values) {
            if v.is_null() {
                d.shift_remove(*k);
            } else {
                d.insert(k.to_string(), v.clone());
            }
        }
        if self.doc.get("imports").map(Value::to_string) != imports {
            self.attach()?;
        }
        Ok(())
    }
}

type Callback<A> = Box<dyn Fn(A) + Send + Sync>;

struct Inner {
    st: Mutex<State>,
    emit: Mutex<()>, // patches are announced in seq order, outside the state lock (callbacks may read the store)
    on_patch: Callback<Value>,
    on_external: Box<dyn Fn() + Send + Sync>,
    on_save_error: Callback<String>,
}

enum Notice {
    External,
    SaveError(String),
}

/// The server's copy of the open document. Cheap to clone; all clones share it.
#[derive(Clone)]
pub struct Store(Arc<Inner>);

impl Store {
    /// on_patch({ seq, roots: [root | { id, deleted: true }], order?: [ids], meta?: { variables, themes, fonts, imports } })
    /// on_external(): another app wrote the file while changes were waiting; both were merged and the editor must reload.
    /// on_save_error(message): a write failed (it is retried, backing off up to RETRY_MAX ms) so the editor can say so.
    pub fn new(
        on_patch: impl Fn(Value) + Send + Sync + 'static,
        on_external: impl Fn() + Send + Sync + 'static,
        on_save_error: impl Fn(String) + Send + Sync + 'static,
    ) -> Store {
        Store(Arc::new(Inner {
            st: Mutex::new(State::default()),
            emit: Mutex::new(()),
            on_patch: Box::new(on_patch),
            on_external: Box::new(on_external),
            on_save_error: Box::new(on_save_error),
        }))
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The document (without its libraries). Null before open().
    pub fn doc(&self) -> Value {
        self.lock().doc.clone()
    }
    /// The document and its libraries (pen-core's `_lib`), for the tools.
    pub(crate) fn doc_and_lib(&self) -> (Value, Value) {
        let st = self.lock();
        (st.doc.clone(), st.lib.clone())
    }
    pub fn seq(&self) -> u64 {
        self.lock().seq
    }
    pub fn file(&self) -> Option<PathBuf> {
        self.lock().file.clone()
    }
    /// The mtime of our last write (or of the file when it was opened): an mtime equal to it is not an external change.
    pub fn own_write(&self) -> Option<SystemTime> {
        self.lock().own_write
    }
    pub fn pending(&self) -> bool {
        self.lock().dirty
    }

    /// (the document with its libraries as "_lib", pen-core expandDoc(doc) without connections): what the renderer draws.
    pub fn render_input(&self) -> (Value, Value) {
        let (mut doc, lib) = self.doc_and_lib();
        if doc.is_null() {
            return (doc, json!([]));
        }
        let expanded = match crate::js::call("expand", vec![Some(doc.to_string()), doc::lib_arg(&lib)]) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|_| json!([])),
            Err(e) => {
                eprintln!("Pena: could not expand the document: {e}");
                json!([])
            }
        };
        if let Some(d) = doc.as_object_mut() {
            d.insert("_lib".into(), lib);
        }
        (doc, expanded)
    }

    fn notify(&self, n: Option<Notice>) {
        match n {
            Some(Notice::External) => (self.0.on_external)(),
            Some(Notice::SaveError(m)) => (self.0.on_save_error)(m),
            None => {}
        }
    }

    /// Writes what is pending now (atomic, so a reader of the file never sees half a document).
    pub fn flush(&self) {
        let n = flush_locked(&self.0, &mut self.lock());
        self.notify(n);
    }

    /// Switch files (File > Open): what is pending goes to the old one first.
    pub fn open(&self, next: &Path) -> Result<()> {
        self.flush();
        let mut st = self.lock();
        if st.dirty {
            bail!("Could not save {} before opening another file", st.file()?.display());
        }
        let d = doc::load_full(next)?;
        let m = fs::metadata(next).and_then(|m| m.modified())?; // if either throws, nothing below happened
        st.file = Some(next.to_path_buf());
        st.set_libs(d);
        st.own_write = Some(m);
        st.dirty = false;
        st.timer = 0;
        st.retry = 0;
        st.edits = Edits::default();
        st.libs = doc::lib_stamp(&st.lib_files);
        st.snapshot();
        Ok(())
    }

    /// The file changed under us (another app) and nothing was waiting to be written: take it. (With writes waiting, flush() merges.)
    pub fn reload(&self) -> Result<()> {
        let mut st = self.lock();
        st.timer = 0;
        st.dirty = false;
        st.edits = Edits::default();
        let file = st.file()?.to_path_buf();
        let d = doc::load_full(&file)?;
        st.set_libs(d);
        st.own_write = Some(fs::metadata(&file).and_then(|m| m.modified())?);
        st.libs = doc::lib_stamp(&st.lib_files);
        st.snapshot();
        Ok(())
    }

    /// An agent snippet, on the document in memory. Atomic: if it throws, nothing changes.
    pub fn execute(&self, args: &Value, rects: &Value) -> Result<Exec> {
        let mut st = self.lock();
        let file = st.file()?.to_path_buf();
        if doc::lib_stamp(&st.lib_files) != st.libs {
            st.attach()?; // a library changed on disk
        }
        let (r, next) = doc::run(&st.doc, &st.lib, &file, args, rects)?; // a throw leaves st.doc as it was
        st.doc = next;
        let d = st.diff();
        let old_imports = serde_json::from_str::<Value>(&st.meta).ok().map(|m| m[3].to_string());
        if d.meta_changed && old_imports != Some(st.doc.get("imports").unwrap_or(&Value::Null).to_string()) {
            st.attach()?;
        }
        let mut roots: Vec<Value> = d.changed;
        roots.extend(d.deleted.iter().map(|id| json!({ "id": id, "deleted": true })));
        if roots.is_empty() && !d.order_changed && !d.meta_changed {
            return Ok(r);
        }
        st.roots = d.now;
        st.order = d.ids.clone();
        st.meta = d.meta;
        for r in &roots {
            st.edits.roots.insert(id_of(r));
        }
        st.edits.order |= d.order_changed;
        st.edits.meta |= d.meta_changed;
        touch(&self.0, &mut st);
        st.seq += 1;
        let mut p = Map::new();
        p.insert("seq".into(), st.seq.into());
        p.insert("roots".into(), roots.into());
        if d.order_changed {
            p.insert("order".into(), json!(d.ids));
        }
        if d.meta_changed {
            let meta: Map<String, Value> = META.iter().filter_map(|k| st.doc.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
            p.insert("meta".into(), meta.into());
        }
        let order = self.0.emit.lock().unwrap_or_else(|e| e.into_inner());
        drop(st);
        (self.0.on_patch)(Value::Object(p));
        drop(order);
        Ok(r)
    }

    /// The editor's save: roots it edited (whole), ids it deleted, and the order / meta when they changed.
    /// Not announced as a patch (the editor already has it); returns the current seq so it can order patches against it.
    pub fn put(&self, body: &Value) -> Result<u64> {
        let mut st = self.lock();
        if st.doc.is_null() {
            bail!("No file is open");
        }
        let edited = body["roots"].as_array().cloned().unwrap_or_default();
        let deleted: Vec<String> = body["deleted"].as_array().map(|a| a.iter().map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).collect()).unwrap_or_default();
        let ids: Option<Vec<String>> = body["order"].as_array().map(|a| a.iter().map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())).collect());
        let mut by_id: IndexMap<String, Value> = children(&st.doc).iter().map(|c| (id_of(c), c.clone())).collect();
        for r in &edited {
            by_id.insert(id_of(r), r.clone());
            st.roots.insert(id_of(r), r.to_string());
        }
        for id in &deleted {
            by_id.shift_remove(id);
            st.roots.shift_remove(id);
        }
        // the editor's order, then roots it does not know yet (an agent's patch still on its way)
        let kids: Vec<Value> = match &ids {
            Some(ids) => {
                let known: HashSet<&String> = ids.iter().collect();
                let mut k: Vec<Value> = ids.iter().filter_map(|id| by_id.get(id).cloned()).collect();
                k.extend(by_id.iter().filter(|(id, _)| !known.contains(id)).map(|(_, c)| c.clone()));
                k
            }
            None => by_id.into_values().collect(),
        };
        st.order = kids.iter().map(id_of).collect();
        st.doc["children"] = Value::Array(kids);
        if let Some(m) = body.get("meta").filter(|m| m.is_object()) {
            st.set_meta(&META.map(|k| m.get(k).cloned().unwrap_or(Value::Null)))?;
            st.meta = meta_of(&st.doc);
        }
        for id in edited.iter().map(id_of).chain(deleted) {
            st.edits.roots.insert(id);
        }
        st.edits.order |= ids.is_some();
        st.edits.meta |= body.get("meta").is_some_and(|m| m.is_object());
        touch(&self.0, &mut st);
        Ok(st.seq)
    }
}

// not restarted by later changes: <= DELAY after the first
fn touch(inner: &Arc<Inner>, st: &mut State) {
    st.dirty = true;
    if st.timer == 0 {
        schedule(inner, st, DELAY);
    }
}

fn schedule(inner: &Arc<Inner>, st: &mut State, ms: u64) {
    st.timers += 1;
    let (generation, weak): (u64, Weak<Inner>) = (st.timers, Arc::downgrade(inner));
    st.timer = generation;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ms));
        let Some(inner) = weak.upgrade() else { return };
        let store = Store(inner);
        let n = {
            let mut st = store.lock();
            if st.timer != generation {
                return; // cleared (flushed, reloaded) or replaced since
            }
            flush_locked(&store.0, &mut st)
        };
        store.notify(n);
    });
}

fn flush_locked(inner: &Arc<Inner>, st: &mut State) -> Option<Notice> {
    st.timer = 0;
    if !st.dirty || st.doc.is_null() {
        return None;
    }
    let attempt = (|| -> Result<bool> {
        let file = st.file()?.to_path_buf();
        // the file is not the one we wrote last: another app got in. Their roots stay, the ones changed here win (mergeDocs).
        let m = mtime(&file);
        let external = m.is_some() && m != st.own_write;
        if external {
            let theirs = doc::load_full(&file)?;
            let changes = json!({ "roots": st.edits.roots.iter().collect::<Vec<_>>(), "meta": st.edits.meta, "order": st.edits.order });
            let merged = doc::merge(&theirs, &st.doc, &changes)?;
            st.set_libs(Loaded { doc: merged, ..theirs });
            st.snapshot();
        }
        doc::save(&file, &st.doc)?;
        st.own_write = mtime(&file); // our own write must not come back as a "changed on disk" event
        st.dirty = false;
        st.edits = Edits::default();
        st.retry = 0;
        Ok(external)
    })();
    match attempt {
        Ok(external) => external.then_some(Notice::External),
        Err(e) => {
            // stays dirty and is tried again (a virus scanner or sync client may hold the file for a moment)
            let file = st.file.as_deref().map(|f| f.display().to_string()).unwrap_or_default();
            eprintln!("Pena: could not save {file}: {e}");
            st.retry = RETRY_MAX.min(if st.retry == 0 { 500 } else { st.retry } * 2);
            let retry = st.retry;
            schedule(inner, st, retry);
            if st.reported.is_none_or(|t| t.elapsed() > REPORT_EVERY) {
                st.reported = Some(Instant::now());
                return Some(Notice::SaveError(e.to_string()));
            }
            None
        }
    }
}
