//! The agent runners of server.mjs (runClaude, runCodex, runOpencode) and the model catalogs, without the JS SDKs:
//! each CLI is spawned with the arguments its SDK would pass and spoken to over its stdio JSON protocol.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

mod claude;
mod codex;
mod opencode;

pub use claude::{list_claude_models, run_claude};
pub use codex::{CodexOptions, CodexThread, list_codex_models, run_codex};
pub use opencode::{list_opencode_models, run_opencode};

/// An MCP server launch (stdio).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Mcp {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// One agent turn: what the JS runners read from `req`, FILE, settings and the chat's group.
#[derive(Clone, Debug, Default)]
pub struct Turn {
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    /// data URLs
    pub images: Vec<String>,
    /// PDFs, base64
    pub docs: Vec<String>,
    /// the account's env; laid over this process's env (settings.accountEnv)
    pub env: BTreeMap<String, String>,
    /// the open .pen
    pub file: PathBuf,
    pub attach_dir: PathBuf,
    /// SYSTEM(group)
    pub system: String,
    pub group_key: String,
    pub group_sync: String,
    /// the design-tool MCP launch, already with PENA_FILE/PENA_URL/PENA_AGENT/PENA_CONV
    pub pena: Mcp,
    /// settings.agentMcpServers(): { name: { command, args, env } | { url, type, headers } }
    pub extra_servers: Value,
    pub claude_bin: PathBuf,
    pub codex_bin: PathBuf,
    pub opencode_bin: PathBuf,
    pub codex_home: Option<PathBuf>,
    pub global_codex_servers: Vec<String>,
    pub global_opencode_servers: Vec<String>,
}

/// What the JS keeps on `session` between turns of one agent.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Session {
    /// Claude session id (resume)
    pub claude: Option<String>,
    /// the live Codex thread (session.codex)
    pub codex: Option<CodexThread>,
    /// a Codex thread id restored from the chat history (session.codexId)
    pub codex_id: Option<String>,
    /// the thread options the live thread last ran with (session.codexKey)
    pub codex_key: Option<String>,
    /// OpenCode session id
    pub opencode: Option<String>,
    /// the group context the Codex/OpenCode thread last saw (groupKey)
    pub group: Option<String>,
    /// the last turn's usage; the server sends it with `end` and clears it
    pub usage: Option<Value>,
    /// Claude TodoWrite calls: their results are not tool cards
    pub todo_ids: BTreeSet<String>,
    /// { name, color }: the server's agent profile
    pub profile: Option<Value>,
}

impl Session {
    /// runTurn's reset before retrying on a fresh native session.
    pub fn forget_native(&mut self) {
        self.claude = None;
        self.codex = None;
        self.codex_id = None;
        self.codex_key = None;
        self.opencode = None;
    }
}

/// say(kind, data, throttleKey): the server throttles by key and keeps the history.
pub type Say<'a> = &'a (dyn Fn(&str, Value, Option<String>) + Send + Sync);

/// nativeOf(): the CLI's own session id for this provider.
pub fn native_session(provider: &str, s: &Session) -> Option<String> {
    match provider {
        "codex" => s.codex.as_ref().and_then(|t| t.id.clone()).or_else(|| s.codex_id.clone()),
        "opencode" => s.opencode.clone(),
        _ => s.claude.clone(),
    }
}

// --- shared helpers -------------------------------------------------------------------------

pub(crate) fn data_url(d: &str) -> Option<(String, String)> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)^data:([^;]+);base64,(.*)$").unwrap());
    RE.captures(d).map(|c| (c[1].to_string(), c[2].to_string()))
}

pub(crate) fn short_tool(n: &str) -> String {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^mcp__.+?__").unwrap());
    RE.replace(n, "").into_owned()
}

pub(crate) fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub(crate) fn tail(s: &str, n: usize) -> String {
    let len = s.chars().count();
    s.chars().skip(len.saturating_sub(n)).collect()
}

/// textOf: an MCP/Anthropic tool result's text, capped.
pub(crate) fn text_of(c: &Value) -> String {
    let t = match c {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter(|x| x["type"] == "text")
            .map(|x| str_of(&x["text"]))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    head(&t, 4000)
}

/// imagesOf: a tool result's images as data URLs (Anthropic `source` or MCP `data`/`mimeType` shape).
pub(crate) fn images_of(c: &Value) -> Vec<Value> {
    let Value::Array(a) = c else { return vec![] };
    a.iter()
        .filter(|x| x["type"] == "image")
        .map(|x| {
            let mime = x["source"]["media_type"].as_str().or(x["mimeType"].as_str()).unwrap_or("image/png");
            let data = if x["source"]["data"].is_null() { &x["data"] } else { &x["source"]["data"] };
            Value::String(format!("data:{mime};base64,{}", str_of(data)))
        })
        .collect()
}

/// JS String(v) for the values the CLIs send (undefined/null → "").
pub(crate) fn str_of(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// JS truthiness, for `c.url ? … : …` and `c.env && …`.
pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// An object without the keys whose value is None (JS drops undefined when it serializes the event).
pub(crate) fn obj<const N: usize>(pairs: [(&str, Option<Value>); N]) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        if let Some(v) = v {
            m.insert(k.to_string(), v);
        }
    }
    Value::Object(m)
}

pub(crate) fn some(v: &Value) -> Option<Value> {
    (!v.is_null()).then(|| v.clone())
}

/// Chat images saved as local files (Codex and OpenCode take paths). Like the JS, they stay in the temp folder.
pub(crate) fn image_files(images: &[String]) -> anyhow::Result<Vec<PathBuf>> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis();
    let mut out = vec![];
    for (i, (mime, b64)) in images.iter().filter_map(|d| data_url(d)).enumerate() {
        let ext = mime.split('/').nth(1).map(|e| e.replace("jpeg", "jpg")).unwrap_or_else(|| "png".into());
        let f = std::env::temp_dir().join(format!("pena-{now}-{i}.{ext}"));
        std::fs::write(&f, base64::engine::general_purpose::STANDARD.decode(b64.trim()).unwrap_or_default())?;
        out.push(f);
    }
    Ok(out)
}

pub(crate) fn signal_name(n: i32) -> String {
    match n {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        11 => "SIGSEGV".into(),
        13 => "SIGPIPE".into(),
        15 => "SIGTERM".into(),
        n => format!("signal {n}"),
    }
}

#[cfg(unix)]
pub(crate) fn exit_signal(s: &std::process::ExitStatus) -> Option<i32> {
    std::os::unix::process::ExitStatusExt::signal(s)
}
#[cfg(not(unix))]
pub(crate) fn exit_signal(_: &std::process::ExitStatus) -> Option<i32> {
    None
}

pub(crate) fn parent_dir(file: &Path) -> PathBuf {
    file.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))
}

// --- the project the .pen belongs to, and the secrets no agent may touch ----------------------

/// Every agent may read and change the code of the project the .pen belongs to (its git root, else its folder).
/// Real path: the sandboxes match real paths (/private/var, not /var).
pub fn project_root(dir: &Path) -> PathBuf {
    let mut root = dir.to_path_buf();
    if let Ok(o) = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
    {
        let top = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if o.status.success() && !top.is_empty() {
            root = PathBuf::from(top);
        }
    }
    std::fs::canonicalize(&root).unwrap_or(root)
}

pub(crate) const SECRETS: [&str; 5] = [".env", ".env.*", "*.key", "*.pem", "*.p12"];

pub(crate) fn home_secrets() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    [".ssh", ".aws", ".gnupg", ".config", ".netrc", ".docker", ".kube", ".pena/mcp.json"]
        .iter()
        .map(|d| Path::new(&home).join(d).to_string_lossy().into_owned())
        .collect()
}

pub(crate) fn secrets(root: &str) -> Vec<String> {
    SECRETS.iter().flat_map(|p| [format!("{root}/{p}"), format!("{root}/**/{p}")]).collect()
}

/// path.resolve without touching the disk.
fn resolve(dir: &Path, p: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for c in dir.join(p).components() {
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

/// inside(p, dir): `path.relative(dir, path.resolve(dir, p))` neither climbs out nor is absolute.
pub(crate) fn inside(p: &str, dir: &Path) -> bool {
    let full = resolve(dir, p);
    match full.strip_prefix(resolve(dir, "")) {
        Ok(rel) => !rel.to_string_lossy().starts_with(".."),
        Err(_) => false,
    }
}

/// The extra servers' names (settings.agentMcpServers()).
pub(crate) fn extra_entries(v: &Value) -> Vec<(String, Value)> {
    v.as_object().map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default()
}

pub(crate) fn pena_json(m: &Mcp) -> Value {
    json!({ "command": m.command, "args": m.args, "env": m.env })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn helpers() {
        assert_eq!(short_tool("mcp__pena__execute"), "execute");
        assert_eq!(short_tool("mcp__a__b__c"), "b__c");
        assert_eq!(short_tool("Bash"), "Bash");
        assert_eq!(data_url("data:image/png;base64,QUJD"), Some(("image/png".into(), "QUJD".into())));
        assert_eq!(data_url("nope"), None);
        assert_eq!(text_of(&json!([{ "type": "text", "text": "a" }, { "type": "image" }, { "type": "text", "text": "b" }])), "a\nb");
        assert_eq!(text_of(&json!("x")), "x");
        assert_eq!(text_of(&Value::Null), "");
        assert_eq!(
            images_of(&json!([{ "type": "image", "source": { "media_type": "image/jpeg", "data": "AA" } }, { "type": "image", "data": "BB", "mimeType": "image/webp" }])),
            vec![json!("data:image/jpeg;base64,AA"), json!("data:image/webp;base64,BB")]
        );
    }

    #[test]
    fn inside_matches_path_relative() {
        let root = Path::new("/p/root");
        assert!(inside("/p/root/a/b.ts", root));
        assert!(inside("a/b.ts", root));
        assert!(inside("", root));
        assert!(!inside("/p/root/../x", root));
        assert!(!inside("/p/rootx/a", root));
        assert!(!inside("/etc/passwd", root));
        assert!(!inside("../x", root));
        assert!(!inside("..foo", root)); // JS's startsWith('..') check
    }

    /// The server spawns the runners on tokio: their futures must be Send.
    #[allow(dead_code, unused_must_use)]
    fn runners_are_send(t: &Turn, s: &mut Session, say: Say<'_>) {
        fn send<T: Send>(_: T) {}
        send(run_claude(t, s, Default::default(), say));
        send(run_codex(t, s, Default::default(), say));
        send(run_opencode(t, s, Default::default(), say));
        send(list_claude_models(Path::new(""), &t.env));
        send(list_opencode_models(Path::new("")));
    }

    #[test]
    fn native_of() {
        let mut s = Session { codex_id: Some("old".into()), claude: Some("c".into()), ..Default::default() };
        assert_eq!(native_session("codex", &s).as_deref(), Some("old"));
        s.codex = Some(CodexThread { id: Some("new".into()), options: Default::default() });
        assert_eq!(native_session("codex", &s).as_deref(), Some("new"));
        assert_eq!(native_session("claude", &s).as_deref(), Some("c"));
        assert_eq!(native_session("acc-123", &s).as_deref(), Some("c")); // extra Claude accounts
        s.forget_native();
        assert_eq!(native_session("codex", &s), None);
    }
}
