// store.test.mjs: the server's copy of the open document — agents' snippets, the editor's saves, the file behind them.
use pena_core::{Store, expand, load, save};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn node(id: &str) -> Value {
    json!({ "id": id, "type": "frame", "name": id, "x": 0, "y": 0, "width": 100, "height": 100, "children": [{ "id": format!("{id}c"), "type": "text", "name": "T", "content": id }] })
}
fn node_with(id: &str, extra: Value) -> Value {
    let mut n = node(id);
    n.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    n
}
fn doc(children: Vec<Value>) -> Value {
    json!({ "version": "2.21", "children": children })
}
fn on_disk(f: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(f).unwrap()).unwrap()
}
fn ids(d: &Value) -> Vec<String> {
    d["children"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect()
}
fn root_ids(p: &Value) -> Vec<String> {
    p["roots"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_string()).collect()
}
fn sleep(ms: u64) {
    std::thread::sleep(Duration::from_millis(ms));
}

#[test]
fn store() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.pen");
    save(&file, &doc(vec![node("A"), node("B"), node("C")])).unwrap();

    let patches = Arc::new(Mutex::new(Vec::<Value>::new()));
    let p2 = patches.clone();
    let store = Store::new(move |p| p2.lock().unwrap().push(p), || {}, |_| {});
    store.open(&file).unwrap();
    let run = |input: &str| store.execute(&json!({ "input": input }), &Value::Null);
    let last = || patches.lock().unwrap().last().cloned().unwrap();
    let count = || patches.lock().unwrap().len();
    let snap = || store.doc().to_string();

    // a read-only snippet announces nothing and writes nothing
    run("return Get('A', { depth: 0 })").unwrap();
    assert_eq!(count(), 0);
    assert_eq!(store.seq(), 0);
    assert!(!store.pending());

    // Update: only the root that changed, whole; the file is written later, pretty-printed, and is not seen as external
    run("Update('Ac', { content: 'changed' })").unwrap();
    assert_eq!(store.seq(), 1);
    assert_eq!(root_ids(&last()), ["A"]);
    assert_eq!(last()["roots"][0]["children"][0]["content"], "changed");
    assert!(last().get("order").is_none() && last().get("meta").is_none(), "order and meta only when they changed");
    assert_eq!(on_disk(&file)["children"][0]["children"][0]["content"], "A", "debounced: not written yet");
    assert!(store.pending());
    sleep(450);
    assert!(!store.pending());
    assert_eq!(on_disk(&file)["children"][0]["children"][0]["content"], "changed");
    assert!(std::fs::read_to_string(&file).unwrap().starts_with("{\n  \"version\""), "still pretty-printed JSON (it is tracked in git)");
    assert_eq!(store.own_write(), std::fs::metadata(&file).unwrap().modified().ok());

    // Insert: the new root, and the order
    let d = run("return Insert(document, { type: 'frame', name: 'D', width: 10, height: 10 })").unwrap().text;
    assert_eq!(root_ids(&last()), [d.clone()]);
    assert_eq!(last()["order"], json!(["A", "B", "C", d]));

    // Delete: the id, and the order
    run(&format!("Delete('{d}')")).unwrap();
    assert_eq!(last()["roots"], json!([{ "id": d, "deleted": true }]));
    assert_eq!(last()["order"], json!(["A", "B", "C"]));

    // a cross-root Move changes both roots
    run("Move('Ac', 'B')").unwrap();
    let mut r = root_ids(&last());
    r.sort();
    assert_eq!(r, ["A", "B"]);
    assert!(last().get("order").is_none());
    assert_eq!(store.doc()["children"][1]["children"].as_array().unwrap().len(), 2);

    // meta: variables and themes, and no root
    run("SetVariables({ bg: { type: 'color', value: [{ value: '#fff' }, { value: '#000', theme: { Mode: 'Dark' } }] } })").unwrap();
    assert_eq!(last()["roots"], json!([]));
    assert_eq!(last()["meta"]["variables"].as_object().unwrap().keys().collect::<Vec<_>>(), ["bg"]);
    assert_eq!(last()["meta"]["themes"], json!({ "Mode": ["Dark"] }));

    // root order alone
    run("Move('C', 'document', 0)").unwrap();
    assert_eq!(last()["roots"], json!([]));
    assert_eq!(last()["order"], json!(["C", "A", "B"]));

    // seq is monotonic: one per announced change
    assert_eq!(patches.lock().unwrap().iter().map(|p| p["seq"].as_u64().unwrap()).collect::<Vec<_>>(), [1, 2, 3, 4, 5, 6]);

    // atomic: a snippet that throws after editing, inserting, deleting, moving across roots and changing meta changes nothing
    let (before, seq, announced) = (snap(), store.seq(), count());
    let failure = run("Update('A', { name: 'x' }); Insert(document, { type: 'frame', name: 'N' }); Delete('B'); Move('Cc', 'A'); SetVariables({ z: { type: 'number', value: 1 } }); Move('A', 'document', 2); throw new Error('boom')").unwrap_err();
    assert!(failure.to_string().contains("boom"));
    assert_eq!(snap(), before, "document restored");
    assert_eq!(store.seq(), seq);
    assert_eq!(count(), announced, "nothing announced");
    run("Update('A', { name: 'again' })").unwrap();
    assert_eq!(last()["roots"].as_array().unwrap().iter().map(|r| (r["id"].clone(), r["name"].clone())).collect::<Vec<_>>(), [(json!("A"), json!("again"))], "the baseline is the restored document");

    // the editId flow still works: the failed snippet is patched with edits, not resent
    let msg = run("Update('A', { name: 'late' }); nope()").unwrap_err().to_string();
    let edit_id = msg.split("editId \"").nth(1).unwrap().split('"').next().unwrap().to_string();
    let name_of_a = || store.doc()["children"].as_array().unwrap().iter().find(|c| c["id"] == "A").unwrap()["name"].clone();
    assert_eq!(name_of_a(), "again", "the failed snippet changed nothing");
    store.execute(&json!({ "editId": edit_id, "edits": [{ "find": "nope()", "replace": "Print(\"ok\")" }] }), &Value::Null).unwrap();
    assert_eq!(name_of_a(), "late");

    // a snippet that never ends is cut off and rolled back too
    let hang = snap();
    assert!(run("Update('A', { name: 'hang' }); while (true) {}").unwrap_err().to_string().contains("timed out"));
    assert_eq!(snap(), hang);

    // the editor's save: whole roots, deleted ids, order, meta. Not announced; answers with the current seq.
    let (n, s) = (count(), store.seq());
    let mine = node_with("E", json!({ "name": "mine" }));
    assert_eq!(store.put(&json!({ "roots": [mine, node_with("B", json!({ "name": "edited" }))], "deleted": ["A"], "order": ["E", "B", "C"] })).unwrap(), s);
    assert_eq!(count(), n);
    assert_eq!(ids(&store.doc()), ["E", "B", "C"]);
    assert_eq!(store.doc()["children"][1]["name"], "edited");
    run("Update('C', { name: 'by agent' })").unwrap(); // the next snippet diffs against what the save left
    assert_eq!(root_ids(&last()), ["C"]);
    // a root the editor does not know yet (its patch is still on the way) survives the editor's order
    let f = run("return Insert(document, { type: 'frame', name: 'F' })").unwrap().text;
    store.put(&json!({ "roots": [], "deleted": [], "order": ["C", "B", "E"] })).unwrap();
    assert_eq!(ids(&store.doc()), ["C", "B", "E", &f]);
    // no order sent: positions stay, new roots go last
    store.put(&json!({ "roots": [node("G")], "deleted": ["B"] })).unwrap();
    assert_eq!(ids(&store.doc()), ["C", "E", &f, "G"]);

    // `imports` decide the libraries: a save (or a snippet) that changes them re-attaches `_lib`
    std::fs::write(dir.path().join("lib.pen"), json!({ "version": "2.21", "variables": { "brand": { "type": "color", "value": "#f00" } }, "children": [node_with("K", json!({ "reusable": true }))] }).to_string()).unwrap();
    assert!(store.snapshot().1.is_null());
    let d = store.doc();
    store.put(&json!({ "roots": [], "deleted": [], "meta": { "variables": d["variables"], "themes": d["themes"], "imports": { "q": "./lib.pen" } } })).unwrap();
    let (open_doc, lib, _) = store.snapshot();
    let index = expand::Index::new(&open_doc, &lib);
    let expanded: Vec<Value> = expand::layers(&open_doc).map(|n| expand::expand_node(n, &index, "", 0)).collect();
    assert!(lib["variables"]["q:brand"].is_object(), "library attached");
    assert_eq!(lib["nodes"].as_array().unwrap().len(), 1);
    assert!(!store.doc().to_string().contains("\"q:K\""), "never serialized into the document");
    assert!(!json!(expanded).to_string().contains("q:K"), "library nodes are not drawn as layers");
    store.put(&json!({ "roots": [], "deleted": [], "meta": { "variables": d["variables"], "themes": d["themes"] } })).unwrap();
    assert!(store.snapshot().1.is_null(), "library detached");
    store.flush();
    assert_eq!(ids(&on_disk(&file)), ["C", "E", &f, "G"]);

    // the file wins over memory when another app writes it: reload drops what was pending
    run("Update('C', { name: 'pending' })").unwrap();
    save(&file, &doc(vec![node("X")])).unwrap();
    store.reload().unwrap();
    assert_eq!(ids(&store.doc()), ["X"]);
    assert!(!store.pending());
    run("Update('X', { name: 'x2' })").unwrap();
    assert_eq!(root_ids(&last()), ["X"], "the diff base is the reloaded file");

    // another app writes the file while changes wait: its roots stay, the ones changed here win, the editor is told
    {
        let external = Arc::new(Mutex::new(0));
        let e2 = external.clone();
        let m = Store::new(|_| {}, move || *e2.lock().unwrap() += 1, |_| {});
        m.open(&file).unwrap();
        m.execute(&json!({ "input": "Update('X', { name: 'mine' })" }), &Value::Null).unwrap();
        let mut theirs = on_disk(&file);
        theirs["children"].as_array_mut().unwrap().push(node("Y"));
        theirs["children"][0]["name"] = json!("theirs");
        sleep(20); // a different mtime than our own write
        save(&file, &theirs).unwrap();
        m.flush();
        assert_eq!(*external.lock().unwrap(), 1);
        let names: Vec<(Value, Value)> = on_disk(&file)["children"].as_array().unwrap().iter().map(|c| (c["id"].clone(), c["name"].clone())).collect();
        assert_eq!(names, [(json!("X"), json!("mine")), (json!("Y"), json!("Y"))]);
        m.execute(&json!({ "input": "Update('Y', { name: 'y2' })" }), &Value::Null).unwrap();
        m.flush();
        assert_eq!(*external.lock().unwrap(), 1, "our own writes are not external");
        store.reload().unwrap();
    }

    // opening another file writes what is pending to the previous one first
    let other = dir.path().join("other.pen");
    save(&other, &doc(vec![node("O")])).unwrap();
    run("Update('X', { name: 'x3' })").unwrap();
    store.open(&other).unwrap();
    assert_eq!(on_disk(&file)["children"][0]["name"], "x3");
    assert_eq!(ids(&store.doc()), ["O"]);
    store.flush();

    // File > Open on a file that cannot be read changes nothing: the current document keeps being saved to its own file
    {
        let bad = dir.path().join("bad.pen");
        std::fs::write(&bad, "<<<<<<< HEAD\n{\"version\":\"2.21\"}\n=======\n").unwrap();
        let s = Store::new(|_| {}, || {}, |_| {});
        s.open(&file).unwrap();
        assert!(s.open(&bad).is_err());
        assert_eq!(s.file().as_deref(), Some(file.as_path()), "still the old file");
        s.execute(&json!({ "input": "Update('X', { name: 'still saved' })" }), &Value::Null).unwrap();
        s.flush();
        assert_eq!(load(&file).unwrap()["children"][0]["name"], "still saved");
    }

    // an async snippet is refused (it would keep editing past the diff and the rollback)
    {
        let before = snap();
        assert!(run("return (async () => { Update('O', { name: 'late' }); })()").unwrap_err().to_string().contains("synchronous"));
        assert!(run("return (async () => { throw new Error('boom'); })()").unwrap_err().to_string().contains("synchronous"), "a rejecting promise does not crash the process");
        assert_eq!(snap(), before, "nothing changed");
    }

    // a library that changed on disk is read again by the next snippet
    {
        let lib = dir.path().join("l.lib.pen");
        let f = dir.path().join("withlib.pen");
        save(&lib, &doc(vec![node_with("L1", json!({ "reusable": true }))])).unwrap();
        save(&f, &json!({ "version": "2.21", "imports": { "l": "./l.lib.pen" }, "children": [node("A")] })).unwrap();
        let s = Store::new(|_| {}, || {}, |_| {});
        s.open(&f).unwrap();
        let get = || s.execute(&json!({ "input": "return JSON.stringify(Get('l:L1', { depth: 0 }))" }), &Value::Null).unwrap().text;
        assert!(get().contains("L1"));
        sleep(20);
        save(&lib, &doc(vec![node_with("L1", json!({ "reusable": true, "name": "renamed" }))])).unwrap();
        assert!(get().contains("renamed"));
    }
}

// a failed write is retried and reported, not swallowed; the change is not lost
#[test]
fn retry() {
    let dir = tempfile::tempdir().unwrap();
    let (f, other) = (dir.path().join("retry.pen"), dir.path().join("other.pen"));
    save(&f, &doc(vec![node("A")])).unwrap();
    save(&other, &doc(vec![])).unwrap();
    let tmp = dir.path().join("retry.pen.tmp");
    std::fs::create_dir(&tmp).unwrap(); // the temp file cannot be created: the write fails
    let reported = Arc::new(Mutex::new(Vec::<String>::new()));
    let r2 = reported.clone();
    let s = Store::new(|_| {}, || {}, move |m| r2.lock().unwrap().push(m));
    s.open(&f).unwrap();
    s.execute(&json!({ "input": "Update('A', { name: 'kept' })" }), &Value::Null).unwrap();
    s.flush();
    assert!(s.pending(), "still dirty after a failed write");
    assert_eq!(reported.lock().unwrap().len(), 1);
    assert!(s.open(&other).unwrap_err().to_string().contains("Could not save"), "does not switch away from unsaved changes");
    std::fs::remove_dir(&tmp).unwrap();
    for _ in 0..60 {
        if !s.pending() {
            break;
        }
        sleep(100); // the retry backs off: 1 s, then 2 s
    }
    assert!(!s.pending(), "written by a retry");
    assert_eq!(load(&f).unwrap()["children"][0]["name"], "kept");
    assert_eq!(reported.lock().unwrap().len(), 1, "reported once, not on every retry");
}

// The JS side keeps the document between snippets (js.rs call_doc): every way the document changes must reach it,
// and a snippet that fails must not leave its half-made edits in what is kept.
#[test]
fn kept_document_follows_every_change() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("kept.pen");
    save(&f, &doc(vec![node("A")])).unwrap();
    let s = Store::new(|_| {}, || {}, |_| {});
    s.open(&f).unwrap();
    let run = |input: &str| s.execute(&json!({ "input": input }), &Value::Null);
    let text = || run("return Get('Ac').content").unwrap().text;
    let with_text = |t: &str| node_with("A", json!({ "children": [{ "id": "Ac", "type": "text", "name": "T", "content": t }] }));
    assert_eq!(text(), "A");
    // a snippet that changes nothing keeps the revision (caches keyed by it, like the server's layout, stay valid)
    let rev = s.rev();
    assert_eq!(text(), "A");
    assert_eq!(s.rev(), rev);

    // the editor's save (not announced, no seq): the next snippet sees it
    s.put(&json!({ "roots": [with_text("editor")], "deleted": [] })).unwrap();
    assert_eq!(text(), "editor");

    // a snippet that throws after editing, and one that times out after editing: neither edit is kept
    assert!(run("Update('Ac', { content: 'half' }); throw new Error('no')").is_err());
    assert_eq!(text(), "editor");
    assert!(run("Update('Ac', { content: 'half' }); while (true) {}").unwrap_err().to_string().contains("timed out"));
    assert_eq!(text(), "editor");

    // a snippet's own edit, then the file changed by another app
    run("Update('Ac', { content: 'agent' })").unwrap();
    assert_eq!(text(), "agent");
    s.flush();
    save(&f, &doc(vec![with_text("disk")])).unwrap();
    s.reload().unwrap();
    assert_eq!(text(), "disk");
}
