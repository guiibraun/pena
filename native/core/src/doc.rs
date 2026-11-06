// File IO + sandboxed `execute` for .pen documents (doc.mjs). The document model itself lives in public/pen-core.js.
use crate::js::{self, Fail};
use anyhow::{Result, anyhow, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

/// pen-core's VERSION, read from the embedded source so the two never drift
fn version() -> &'static str {
    static V: LazyLock<String> = LazyLock::new(|| {
        let src = include_str!("../../../public/pen-core.js");
        let at = src.find("export const VERSION = '").expect("pen-core VERSION") + 24;
        src[at..at + src[at..].find('\'').unwrap()].to_string()
    });
    &V
}

pub fn empty() -> Value {
    json!({ "version": version(), "children": [] })
}

/// A document as loaded: its libraries (`imports`, flattened: pen-core's non-enumerable `_lib`, never saved) and the
/// files they came from.
pub(crate) struct Loaded {
    pub doc: Value,
    pub lib: Value,
    pub files: Vec<PathBuf>,
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub(crate) fn load_full(file: &Path) -> Result<Loaded> {
    let src = if file.exists() { Some(fs::read_to_string(file)?) } else { None };
    let mut out: Value = serde_json::from_str(&js::call("load", vec![src, Some(path_str(file))]).map_err(|e| anyhow!("{e}"))?)?;
    let libs = libs_of(&mut out);
    Ok(Loaded { doc: out["doc"].take(), lib: libs.0, files: libs.1 })
}

fn libs_of(v: &mut Value) -> (Value, Vec<PathBuf>) {
    let files = v["files"].as_array().map(|a| a.iter().filter_map(|f| f.as_str().map(PathBuf::from)).collect()).unwrap_or_default();
    (v["lib"].take(), files)
}

/// Re-reads the libraries of `doc` (call again when `imports` changes).
pub(crate) fn attach_libs(doc: &Value, file: &Path) -> Result<(Value, Vec<PathBuf>)> {
    let mut out: Value = serde_json::from_str(&js::call("attach", vec![Some(doc.to_string()), Some(path_str(file))]).map_err(|e| anyhow!("{e}"))?)?;
    Ok(libs_of(&mut out))
}

/// Changes when a library file does (another tab or app edited it): the libraries are read again then.
pub(crate) fn lib_stamp(files: &[PathBuf]) -> String {
    let ms = |f: &PathBuf| fs::metadata(f).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
    files.iter().map(|f| ms(f).to_string()).collect::<Vec<_>>().join(",")
}

pub fn load(file: &Path) -> Result<Value> {
    Ok(load_full(file)?.doc)
}

pub(crate) fn tmp_of(file: &Path) -> PathBuf {
    let mut t = file.as_os_str().to_owned();
    t.push(".tmp");
    PathBuf::from(t)
}

/// Atomic write so the editor's file watcher never sees a half-written document.
pub fn save(file: &Path, doc: &Value) -> Result<()> {
    let tmp = tmp_of(file);
    fs::write(&tmp, serde_json::to_string_pretty(doc)?)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

pub(crate) fn merge(theirs: &Loaded, mine: &Value, changes: &Value) -> Result<Value> {
    let out = js::call("merge", vec![Some(theirs.doc.to_string()), lib_arg(&theirs.lib), Some(mine.to_string()), Some(changes.to_string())]).map_err(|e| anyhow!("{e}"))?;
    Ok(serde_json::from_str(&out)?)
}

pub(crate) fn lib_arg(lib: &Value) -> Option<String> {
    (!lib.is_null()).then(|| lib.to_string())
}

/// What a snippet printed, the async work it asked for (`screenshots`, `exports`) and the nodes it touched.
#[derive(Debug, Clone)]
pub struct Exec {
    pub text: String,
    pub host: Value,
    pub touched: Vec<Value>,
}

// Failed snippets, kept so the agent can patch them with `edits` instead of resending (pen.dev's editId flow).
static FAILED: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);

fn snippet(s: &str) -> String {
    serde_json::to_string(&s.chars().take(80).collect::<String>()).unwrap()
}

fn patch(edit_id: Option<&str>, edits: &[Value]) -> Result<String> {
    let Some(mut code) = edit_id.and_then(|id| FAILED.lock().unwrap().get(id).cloned()) else {
        bail!("Unknown editId {}: resend the full snippet in `input`.", edit_id.unwrap_or("undefined"));
    };
    for e in edits {
        let (find, replace, all) = (e["find"].as_str().unwrap_or(""), e["replace"].as_str().unwrap_or(""), e["all"].as_bool().unwrap_or(false));
        let count = code.matches(find).count();
        if count == 0 {
            bail!("Edit not applied, `find` not found: {}", snippet(find));
        }
        if count > 1 && !all {
            bail!("`find` matches {count} times; make it unique or set all: true: {}", snippet(find));
        }
        code = if all { code.replace(find, replace) } else { code.replacen(find, replace, 1) };
    }
    Ok(code)
}

/// Runs an agent snippet on a copy of `doc` and returns the edited copy: when it throws nothing changed (same contract
/// as pen.dev: nothing is saved). Returns the printed output plus async work (screenshots/exports) the snippet requested.
/// ponytail: QuickJS is scoping, not a security sandbox — fine for an agent you already trust with the machine.
pub(crate) fn run(doc: &Value, lib: &Value, file: &Path, args: &Value, rects: &Value) -> Result<(Exec, Value)> {
    let edit_id = args["editId"].as_str();
    let code = match args["edits"].as_array().filter(|e| !e.is_empty()) {
        Some(edits) => patch(edit_id, edits)?,
        None => args["input"].as_str().ok_or_else(|| anyhow!("Provide `input`, or `edits` with `editId`."))?.to_string(),
    };
    // .glsl files live next to the .pen (shaders/), like images, so pen.dev opens them too
    let shaders = file.parent().unwrap_or(Path::new("")).join("shaders");
    let lib_dir = crate::root().join("public").join("shaders");
    let out = js::call("run", vec![Some(doc.to_string()), lib_arg(lib), Some(code.clone()), Some(rects.to_string()), Some(path_str(&shaders)), Some(path_str(&lib_dir))]);
    let failure = match out {
        Ok(s) => {
            let mut v: Value = serde_json::from_str(&s)?;
            match v["error"].as_str() {
                Some(m) => m.to_string(),
                None => {
                    if let Some(id) = edit_id {
                        FAILED.lock().unwrap().remove(id);
                    }
                    let touched = v["touched"].as_array().cloned().unwrap_or_default();
                    let text = v["text"].as_str().unwrap_or("ok").to_string();
                    return Ok((Exec { text, host: v["host"].take(), touched }, v["doc"].take()));
                }
            }
        }
        Err(Fail::Timeout) => js::TIMEOUT.to_string(),
        Err(Fail::Js(m)) => m,
    };
    let id = edit_id.map(str::to_string).unwrap_or_else(|| (0..3).map(|_| format!("{:02x}", rand::random::<u8>())).collect());
    FAILED.lock().unwrap().insert(id.clone(), code);
    bail!("{failure}\nNothing was saved. Fix it with `edits` and editId \"{id}\" (do not resend the snippet).")
}

/// Without a running app (standalone MCP): on a copy read from the file, written back only if the snippet succeeds.
pub fn execute(file: &Path, args: &Value, rects: &Value) -> Result<Exec> {
    let l = load_full(file)?;
    let (r, doc) = run(&l.doc, &l.lib, file, args, rects)?;
    save(file, &doc)?;
    Ok(r)
}

// --- skills: same layering as pen.dev — core files go in the system prompt, guides are read on demand ---
const CORE: [&str; 3] = ["SKILL.md", "execute.md", "schema.md"];

fn skill_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    vec![crate::root().join("skills").join("pena"), home.join(".pena").join("skills")]
}

// every .md under the skill folders, as "guide/x.md"
fn list_skills() -> Vec<String> {
    let mut out = vec![];
    for dir in skill_dirs() {
        let mut queue = vec![PathBuf::new()];
        while let Some(rel) = queue.pop() {
            let Ok(entries) = fs::read_dir(dir.join(&rel)) else { continue };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for e in entries {
                let r = rel.join(e.file_name());
                if e.path().is_dir() {
                    queue.insert(0, r);
                } else if r.extension().is_some_and(|x| x == "md") {
                    out.push(r.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/"));
                }
            }
        }
    }
    out
}

pub fn read_skill(rel: Option<&str>) -> Result<String> {
    let Some(rel) = rel.filter(|r| !r.is_empty()) else {
        let list = list_skills().iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n");
        return Ok(format!("Available files:\n{list}\n\n{}", read_skill(Some("SKILL.md"))?));
    };
    for dir in skill_dirs() {
        let base = crate::resolve(&dir, Path::new(""));
        let file = crate::resolve(&dir, Path::new(rel));
        if file.starts_with(&base) && file != base && file.exists() {
            return Ok(fs::read_to_string(file)?);
        }
    }
    bail!("Skill file not found: {rel}. Call read_skill() to list files.")
}

pub fn system_prompt() -> String {
    CORE.iter().map(|f| format!("<path>{f}</path>\n<content>{}</content>", read_skill(Some(f)).unwrap_or_default())).collect::<Vec<_>>().join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    // mergeDocs: an agent wrote the file while the editor had unsaved edits; both survive (per root)
    #[test]
    fn merge_docs() {
        let r = |id: &str, v: &str| json!({ "type": "frame", "id": id, "name": v });
        let theirs = |d: Value| Loaded { doc: d, lib: Value::Null, files: vec![] };
        let disk = json!({ "variables": { "a": 1 }, "children": [r("A", "agent"), r("B", "old"), r("C", "old"), r("N", "agent new")] }); // agent: edited A, added N, deleted D
        let mine = json!({ "variables": { "a": 2 }, "children": [r("A", "old"), r("B", "mine"), r("D", "old"), r("E", "mine new")] }); // editor: edited B, deleted C, added E
        let out = merge(&theirs(disk), &mine, &json!({ "roots": ["B", "C", "E"], "meta": false, "order": false })).unwrap();
        let names: Vec<String> = out["children"].as_array().unwrap().iter().map(|c| format!("{}:{}", c["id"].as_str().unwrap(), c["name"].as_str().unwrap())).collect();
        assert_eq!(names, ["A:agent", "B:mine", "N:agent new", "E:mine new"]);
        assert_eq!(out["variables"]["a"], 1, "meta untouched by the editor stays");
        let same = merge(&theirs(json!({ "children": [r("A", "agent")] })), &json!({ "variables": { "a": 2 }, "children": [r("A", "mine")] }), &json!({ "roots": ["A"], "meta": true })).unwrap();
        assert_eq!(same["children"][0]["name"], "mine", "same root: editor wins");
        assert_eq!(same["variables"]["a"], 2);
    }
}
