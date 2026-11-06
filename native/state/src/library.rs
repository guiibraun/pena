//! Document library for the dashboard: recents, drafts, previews and a small file browser.
//! Pena keeps its own state in ~/.pena and also reads (never writes) pen.dev's recents and previews,
//! so files you used in pen.dev show up here too. Every path is derived from HOME at call time.

use crate::{home, path_str, pretty, read_dir_sorted};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{MAIN_SEPARATOR, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

pub fn pena_dir() -> PathBuf {
    home().join(".pena")
}
fn recent_file() -> PathBuf {
    pena_dir().join("recent.json")
}
pub fn drafts_dir() -> PathBuf {
    pena_dir().join("documents")
}
fn previews_dir() -> PathBuf {
    pena_dir().join("previews")
}
// pen.dev locations (read-only)
fn pen_recent() -> PathBuf {
    home().join("Library").join("Application Support").join("Pen").join("recent-documents.json")
}
fn pen_drafts() -> PathBuf {
    home().join(".pencil").join("documents")
}
fn pen_previews() -> PathBuf {
    home().join(".pencil").join("previews")
}
// pen.dev's app bundle: files made in pen.dev use its built-in shader library (`goodies/shader-library/...`)
// ponytail: macOS install paths only; add the Windows/Linux ones when someone opens such a file there
fn pen_asar_paths() -> [PathBuf; 2] {
    [PathBuf::from("/Applications"), home().join("Applications")].map(|d| d.join("Pen.app").join("Contents").join("Resources").join("app.asar"))
}

fn read_json(f: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()
}
fn read_recent() -> Vec<Value> {
    read_json(&recent_file()).and_then(|v| v.as_array().cloned()).unwrap_or_default()
}
fn is_draft(file: &str) -> bool {
    [drafts_dir(), pen_drafts()].iter().any(|d| file.starts_with(&format!("{}{MAIN_SEPARATOR}", d.display())))
}
// Same id scheme as pen.dev: drafts use their folder uuid, other files a sha256 of the path.
fn preview_id(file: &str) -> String {
    if is_draft(file) {
        Path::new(file).parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        hex::encode(Sha256::digest(file.as_bytes()))[..32].to_string()
    }
}

pub fn preview_file(file: &str) -> Option<PathBuf> {
    [previews_dir(), pen_previews()].into_iter().map(|d| d.join(format!("{}.png", preview_id(file)))).find(|f| f.exists())
}

pub fn save_preview(file: &str, png: &[u8]) -> std::io::Result<()> {
    std::fs::create_dir_all(previews_dir())?;
    std::fs::write(previews_dir().join(format!("{}.png", preview_id(file))), png)
}

fn write_recent(list: &[Value]) -> std::io::Result<()> {
    std::fs::write(recent_file(), pretty(&Value::Array(list.to_vec()), b" "))
}

pub fn record_opened(file: &str) -> std::io::Result<()> {
    let mut list: Vec<Value> = read_recent().into_iter().filter(|r| r.get("path").and_then(Value::as_str) != Some(file)).collect();
    list.insert(0, json!({ "path": file, "openedAt": crate::now_ms() }));
    list.truncate(200);
    std::fs::create_dir_all(pena_dir())?;
    write_recent(&list)
}

pub fn forget(file: &str) -> std::io::Result<()> {
    let list: Vec<Value> = read_recent().into_iter().filter(|r| r.get("path").and_then(Value::as_str) != Some(file)).collect();
    write_recent(&list)
}

fn ms(t: std::io::Result<std::time::SystemTime>) -> Option<f64> {
    t.ok()?.duration_since(UNIX_EPOCH).ok().map(|d| d.as_secs_f64() * 1000.0)
}
fn ctime_ms(st: &std::fs::Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        st.ctime() as f64 * 1000.0 + st.ctime_nsec() as f64 / 1e6
    }
    #[cfg(not(unix))]
    {
        ms(st.modified()).unwrap_or(0.0)
    }
}

fn describe(file: &str, opened_at: Option<f64>, source: &str) -> std::io::Result<Value> {
    let st = std::fs::metadata(file)?;
    let mtime = ms(st.modified()).unwrap_or(0.0);
    let p = Path::new(file);
    let folder = if is_draft(file) {
        if file.starts_with(&path_str(&pen_drafts())) { "Rascunho do Pen".to_string() } else { "Rascunho".to_string() }
    } else {
        p.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    };
    Ok(json!({
        "path": file,
        "name": p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        "folder": folder,
        "openedAt": opened_at.filter(|o| *o != 0.0).unwrap_or(mtime),
        "modifiedAt": mtime,
        "createdAt": ms(st.created()).filter(|c| *c != 0.0).unwrap_or_else(|| ctime_ms(&st)),
        "hasPreview": preview_file(file).is_some(),
        "source": source,
    }))
}

fn opened_at(v: &Value) -> Option<f64> {
    v.get("openedAt").and_then(Value::as_f64)
}

pub fn recents() -> Vec<Value> {
    let pena = read_recent().into_iter().filter_map(|r| Some((r.get("path")?.as_str()?.to_string(), opened_at(&r), "pena")));
    let pen_docs = read_json(&pen_recent()).and_then(|v| v.get("documents")?.as_array().cloned()).unwrap_or_default();
    let pen = pen_docs.into_iter().filter_map(|d| {
        let u = url::Url::parse(d.get("uri")?.as_str()?).ok()?;
        let p = percent_encoding::percent_decode_str(u.path()).decode_utf8().ok()?.into_owned();
        Some((p, opened_at(&d), "pen"))
    });
    let mut seen: Vec<(String, Option<f64>, &str)> = Vec::new();
    for r in pena.chain(pen) {
        if !r.0.ends_with(".pen") || !Path::new(&r.0).exists() || is_draft(&r.0) {
            continue;
        }
        match seen.iter_mut().find(|s| s.0 == r.0) {
            None => seen.push(r),
            Some(prev) => {
                if let (Some(a), Some(b)) = (r.1, prev.1)
                    && a > b
                {
                    *prev = r;
                }
            }
        }
    }
    let mut out: Vec<Value> = seen.into_iter().filter_map(|(p, o, s)| describe(&p, o, s).ok()).collect();
    out.sort_by(|a, b| opened_at(b).partial_cmp(&opened_at(a)).unwrap_or(std::cmp::Ordering::Equal));
    out
}

pub fn drafts() -> Vec<Value> {
    let mut out = Vec::new();
    for (d, source) in [(drafts_dir(), "pena"), (pen_drafts(), "pen")] {
        for id in read_dir_sorted(&d).unwrap_or_default() {
            let dir = id.path();
            if !dir.is_dir() {
                continue;
            }
            for f in read_dir_sorted(&dir).unwrap_or_default() {
                if f.file_name().to_string_lossy().ends_with(".pen")
                    && let Ok(v) = describe(&path_str(&f.path()), None, source)
                {
                    out.push(v);
                }
            }
        }
    }
    let m = |v: &Value| v.get("modifiedAt").and_then(Value::as_f64);
    out.sort_by(|a, b| m(b).partial_cmp(&m(a)).unwrap_or(std::cmp::Ordering::Equal));
    out
}

pub fn new_draft() -> std::io::Result<PathBuf> {
    let dir = drafts_dir().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join("untitled.pen"))
}

// --- files inside pen.dev's app.asar (read-only): header = 16 bytes of sizes + a JSON tree of { offset, size }
struct Asar {
    file: PathBuf,
    mtime: Option<std::time::SystemTime>,
    base: u64,
    files: Vec<(String, u64, u64)>, // path, offset, size
}
static ASAR: Mutex<Option<std::sync::Arc<Asar>>> = Mutex::new(None);

fn pen_asar() -> Option<std::sync::Arc<Asar>> {
    use std::io::{Read, Seek, SeekFrom};
    let file = pen_asar_paths().into_iter().find(|f| f.exists())?;
    let mtime = std::fs::metadata(&file).ok()?.modified().ok();
    let mut cache = ASAR.lock().unwrap();
    if let Some(a) = cache.as_ref()
        && a.file == file
        && a.mtime == mtime
    {
        return Some(a.clone());
    }
    let mut fd = std::fs::File::open(&file).ok()?;
    let mut head = [0u8; 16];
    fd.read_exact(&mut head).ok()?;
    let u32le = |o: usize| u32::from_le_bytes(head[o..o + 4].try_into().unwrap()) as u64;
    let mut json = vec![0u8; u32le(12) as usize];
    fd.seek(SeekFrom::Start(16)).ok()?;
    fd.read_exact(&mut json).ok()?;
    let tree: Value = serde_json::from_slice(&json).ok()?;
    fn walk(node: &Value, prefix: &str, out: &mut Vec<(String, u64, u64)>) {
        let Some(files) = node.get("files").and_then(Value::as_object) else { return };
        for (name, e) in files {
            if e.get("files").is_some() {
                walk(e, &format!("{prefix}{name}/"), out);
            } else if !crate::truthy(e.get("unpacked")) {
                // offsets are strings in asar headers (Number(e.offset))
                let offset = e.get("offset").and_then(|o| o.as_u64().or_else(|| o.as_str()?.parse().ok())).unwrap_or(0);
                out.push((format!("{prefix}{name}"), offset, e.get("size").and_then(Value::as_u64).unwrap_or(0)));
            }
        }
    }
    let mut files = Vec::new();
    walk(&tree, "", &mut files);
    let a = std::sync::Arc::new(Asar { file, mtime, base: 8 + u32le(4), files });
    *cache = Some(a.clone());
    Some(a)
}

fn read_entry(a: &Asar, offset: u64, size: u64) -> Option<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut fd = std::fs::File::open(&a.file).ok()?;
    fd.seek(SeekFrom::Start(a.base + offset)).ok()?;
    let mut b = vec![0u8; size as usize];
    fd.read_exact(&mut b).ok()?;
    Some(b)
}

/// one file of the installed pen.dev app ('out/editor/goodies/...'), or None
pub fn pen_app_file(rel: &str) -> Option<Vec<u8>> {
    let a = pen_asar()?;
    let (_, offset, size) = a.files.iter().find(|f| f.0 == rel)?;
    read_entry(&a, *offset, *size)
}

/// every file whose path matches: [(path, bytes)] (tests)
pub fn pen_app_files(re: &regex::Regex) -> Vec<(String, Vec<u8>)> {
    let Some(a) = pen_asar() else { return vec![] };
    a.files.iter().filter(|f| re.is_match(&f.0)).filter_map(|(p, o, s)| Some((p.clone(), read_entry(&a, *o, *s)?))).collect()
}

/// Minimal file browser for the browser build (the desktop app uses native dialogs). Default dir: ~/Documents.
/// -> { dir, parent, home, entries: [{ name, path, kind: 'dir' | 'pen' }] }
pub fn browse(dir: Option<&str>) -> std::io::Result<Value> {
    let dir = crate::resolve(&dir.map(PathBuf::from).unwrap_or_else(|| home().join("Documents")));
    let mut entries: Vec<(String, bool)> = std::fs::read_dir(&dir)?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().ok()?.is_dir();
            (!name.starts_with('.') && (is_dir || name.ends_with(".pen"))).then_some((name, is_dir))
        })
        .collect();
    // ponytail: approximates localeCompare with a case-insensitive compare (no accent folding)
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())).then_with(|| a.0.cmp(&b.0)));
    let parent = dir.parent().map(path_str);
    Ok(json!({
        "dir": path_str(&dir),
        "parent": parent,
        "home": path_str(&home()),
        "entries": entries.into_iter().map(|(name, is_dir)| json!({ "name": name, "path": path_str(&dir.join(&name)), "kind": if is_dir { "dir" } else { "pen" } })).collect::<Vec<_>>(),
    }))
}
