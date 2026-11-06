//! Pena's on-disk state and settings, ported from the Bun server's chats/handoff/library/settings/fonts/skills/limiter
//! modules. Files keep the exact formats and paths, so the native server and the Bun server share ~/.pena.

pub mod chats;
pub mod fonts;
pub mod handoff;
pub mod library;
pub mod limiter;
pub mod settings;
pub mod skills;

use serde_json::Value;
use std::path::{Path, PathBuf};

/// The home dir, read at call time (like os.homedir(): HOME first) so tests can point it at a temp dir.
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|h| !h.is_empty()))
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Where public/, skills/ and node_modules/ live: PENA_ROOT, else the first dir holding public/pen-core.js walking up
/// from the executable's dir, then from the cwd.
pub fn root() -> PathBuf {
    if let Some(r) = std::env::var_os("PENA_ROOT").filter(|r| !r.is_empty()) {
        return PathBuf::from(r);
    }
    let exe = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf));
    let cwd = std::env::current_dir().ok();
    for start in [exe, cwd.clone()].into_iter().flatten() {
        if let Some(d) = start.ancestors().find(|d| d.join("public").join("pen-core.js").is_file()) {
            return d.to_path_buf();
        }
    }
    cwd.unwrap_or_else(|| PathBuf::from("."))
}

// ---- small JS-semantics helpers shared by the modules

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// JS truthiness of an optional JSON value (missing = undefined).
pub(crate) fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `${v}` / String(v) for a JSON value; missing = "undefined".
pub(crate) fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| if x.is_null() { String::new() } else { js_str(Some(x)) }).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `v ?? fallback`: the value unless it's missing or null.
pub(crate) fn nn(v: Option<&Value>) -> Option<&Value> {
    v.filter(|x| !x.is_null())
}

/// String length in UTF-16 code units, like JS `.length` (budgets are counted the way the Bun server counts them).
pub(crate) fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, n)` in UTF-16 units (never splits a surrogate pair).
pub(crate) fn slice16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

/// JSON.stringify(v, null, indent).
pub(crate) fn pretty(v: &Value, indent: &[u8]) -> String {
    use serde::Serialize;
    let mut out = Vec::new();
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(indent));
    v.serialize(&mut ser).expect("json");
    String::from_utf8(out).expect("utf8")
}

/// readdirSync order: libuv sorts scandir results bytewise.
pub(crate) fn read_dir_sorted(dir: &Path) -> std::io::Result<Vec<std::fs::DirEntry>> {
    let mut v: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    v.sort_by_key(|e| e.file_name());
    Ok(v)
}

/// path.resolve: absolute against the cwd, `.` and `..` folded lexically.
pub(crate) fn resolve(p: &Path) -> PathBuf {
    use std::path::Component;
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    let mut out = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
