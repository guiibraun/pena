//! Settings backend (pen.dev's Settings › Agents and Settings › MCP, observed with REA):
//!  - provider status from the CLIs' own login stores (free), plus an on-demand live probe (one tiny request)
//!  - registering Pena's MCP server in external agents (Claude Code, Codex, Gemini, Cursor, ...)
//!  - extra MCP servers that Pena's own agents may use (~/.pena/mcp.json)
//! The CLIs are the ones you installed (`claude`, `codex`, `opencode`), not copies shipped with the app.

use crate::{home, js_str, path_str, pretty};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{LazyLock, OnceLock};
use std::time::{Duration, Instant};

const WIN: bool = cfg!(windows);
const SEP: char = if WIN { ';' } else { ':' };

// ---------------------------------------------------------------- CLIs and PATH
// An app opened from Finder doesn't get the shell PATH: add the usual install dirs, and ask the login shell
// only when a CLI isn't there. The agents' own children (MCP servers via npx, ...) get the same PATH.
struct Bins {
    path: String,
    claude: String,
    codex: String,
    opencode: String,
}
static BINS: OnceLock<Bins> = OnceLock::new();

fn is_exe(f: &Path) -> bool {
    let Ok(m) = std::fs::metadata(f) else { return false };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    m.is_file()
}
fn dirs(p: &str) -> Vec<String> {
    p.split(SEP).filter(|d| !d.is_empty()).map(String::from).collect()
}
fn join_unique(parts: impl IntoIterator<Item = String>) -> String {
    let mut seen = Vec::new();
    for p in parts {
        if !seen.contains(&p) {
            seen.push(p);
        }
    }
    seen.join(&SEP.to_string())
}
// Windows: npm installs CLIs as .cmd shims, which can't be spawned without a shell: use the .exe the package ships.
fn shim_exe(shim: PathBuf, name: &str) -> PathBuf {
    fn walk(d: &Path, want: &str, depth: usize) -> Option<PathBuf> {
        for e in std::fs::read_dir(d).ok()?.flatten() {
            let p = e.path();
            if p.file_name().is_some_and(|n| n.to_string_lossy().to_lowercase() == want) && is_exe(&p) {
                return Some(p);
            }
            if depth < 8 && e.file_type().is_ok_and(|t| t.is_dir())
                && let Some(hit) = walk(&p, want, depth + 1)
            {
                return Some(hit);
            }
        }
        None
    }
    shim.parent().and_then(|d| walk(&d.join("node_modules"), &format!("{name}.exe"), 0)).unwrap_or(shim)
}
fn find(path: &str, name: &str) -> Option<String> {
    let exts: &[&str] = if WIN { &[".exe", ".cmd", ""] } else { &[""] };
    let hit = exts.iter().flat_map(|x| dirs(path).into_iter().map(move |d| Path::new(&d).join(format!("{name}{x}")))).find(|f| is_exe(f))?;
    let hit = if WIN && hit.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd")) { shim_exe(hit, name) } else { hit };
    Some(path_str(&hit))
}

/// Runs a command to completion (sync), killing it after `timeout`. -> stdout when it exited 0.
fn output_within(mut cmd: std::process::Command, timeout: Duration) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut stdout, &mut s);
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait().ok()? {
            Some(st) => return st.success().then(|| reader.join().ok()).flatten(),
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}
fn version(bin: &str) -> String {
    static V: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(\.\d+)*").unwrap());
    let mut c = std::process::Command::new(bin);
    c.arg("--version");
    output_within(c, Duration::from_secs(5)).and_then(|o| V.find(&o).map(|m| m.as_str().to_string())).unwrap_or_default()
}
/// localeCompare(.., { numeric: true }) for version strings
fn cmp_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parts = |s: &str| s.split('.').filter(|x| !x.is_empty()).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parts(a).cmp(&parts(b))
}

fn bins() -> &'static Bins {
    BINS.get_or_init(|| {
        let h = home();
        let extra: Vec<PathBuf> = if WIN {
            [Some(h.join(".local").join("bin")), Some(h.join(".opencode").join("bin")), std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("npm"))].into_iter().flatten().collect()
        } else {
            vec![h.join(".local").join("bin"), h.join(".claude").join("local"), h.join(".opencode").join("bin"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()]
        };
        let cur = std::env::var("PATH").unwrap_or_default();
        let mut path = join_unique(dirs(&cur).into_iter().chain(extra.iter().map(|p| path_str(p))));
        if !WIN && (find(&path, "claude").is_none() || find(&path, "codex").is_none()) {
            let mut c = std::process::Command::new(std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into()));
            c.args(["-lic", "printf \"\\n%s\" \"$PATH\""]);
            if let Some(out) = output_within(c, Duration::from_secs(5)) {
                let shell_path = out.split('\n').next_back().unwrap_or("").to_string();
                path = join_unique(dirs(&path).into_iter().chain(dirs(&shell_path)));
            }
        }
        // OpenCode can be installed twice (curl in ~/.opencode/bin, Homebrew) and Pena speaks the v2 CLI: take the newest.
        let mut opencodes: Vec<String> = Vec::new();
        for d in dirs(&path) {
            let f = Path::new(&d).join(if WIN { "opencode.exe" } else { "opencode" });
            if is_exe(&f) && !opencodes.contains(&path_str(&f)) {
                opencodes.push(path_str(&f));
            }
        }
        let newest = (opencodes.len() > 1).then(|| {
            let mut v: Vec<(String, String)> = opencodes.iter().map(|b| (b.clone(), version(b))).collect();
            v.sort_by(|a, b| cmp_versions(&b.1, &a.1));
            v.swap_remove(0).0
        });
        // Not installed: keep the bare name, so the status shows "not installed" instead of crashing.
        Bins {
            claude: find(&path, "claude").unwrap_or_else(|| "claude".into()),
            codex: find(&path, "codex").unwrap_or_else(|| "codex".into()),
            opencode: newest.or_else(|| find(&path, "opencode")).unwrap_or_else(|| "opencode".into()),
            path,
        }
    })
}

/// Puts the widened PATH (install dirs + login shell's) into this process's env, like settings.mjs does on load, so
/// every child spawned anywhere inherits it. Call once at startup, before other threads read the environment.
pub fn init_path() {
    // SAFETY: meant for startup, before threads that read the environment exist.
    unsafe { std::env::set_var("PATH", &bins().path) };
}
/// The widened PATH (see init_path).
pub fn path_env() -> &'static str {
    &bins().path
}
pub fn claude_bin() -> &'static str {
    &bins().claude
}
pub fn codex_bin() -> &'static str {
    &bins().codex
}
pub fn opencode_bin() -> &'static str {
    &bins().opencode
}
pub fn codex_home() -> PathBuf {
    std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| home().join(".codex"))
}

// ---------------------------------------------------------------- accounts
// Extra logins of the same provider: one CLI config dir per account, chosen by the env var the CLI reads.
// The first account of a provider is the CLI's own login (no env); extras live in ~/.pena/accounts/<id>.
fn accounts_file() -> PathBuf {
    home().join(".pena").join("accounts.json")
}
fn account_dir() -> PathBuf {
    home().join(".pena").join("accounts")
}
/// The env var that selects a provider's config dir (only Claude and Codex have extra accounts).
pub fn account_env_var(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("CLAUDE_CONFIG_DIR"),
        "codex" => Some("CODEX_HOME"),
        _ => None,
    }
}
const PROVIDERS: [(&str, &str); 3] = [("claude", "Claude"), ("codex", "Codex"), ("opencode", "OpenCode")];
fn provider_name(p: &str) -> Option<&'static str> {
    PROVIDERS.iter().find(|x| x.0 == p).map(|x| x.1)
}

fn read_accounts_file() -> Vec<Value> {
    static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9-]+$").unwrap());
    let Some(Value::Array(v)) = std::fs::read_to_string(accounts_file()).ok().and_then(|t| serde_json::from_str(&t).ok()) else { return vec![] };
    v.into_iter()
        .filter(|a| {
            let id = a.get("id").and_then(Value::as_str);
            id.is_some_and(|id| provider_name(id).is_none() && ID.is_match(id)) && a.get("provider").and_then(Value::as_str).and_then(account_env_var).is_some()
        })
        .collect()
}
fn write_accounts_file(list: &[Value]) -> Result<()> {
    let f = accounts_file();
    std::fs::create_dir_all(f.parent().unwrap())?;
    let tmp = PathBuf::from(format!("{}.tmp", f.display()));
    std::fs::write(&tmp, pretty(&Value::Array(list.to_vec()), b"  "))?;
    std::fs::rename(tmp, f)?;
    Ok(())
}

/// -> [{ id, provider, name, env: { VAR: dir } }]: the three CLI logins, then the extra accounts.
pub fn accounts() -> Vec<Value> {
    let mut out: Vec<Value> = PROVIDERS.iter().map(|(p, n)| json!({ "id": p, "provider": p, "name": n, "env": {} })).collect();
    for a in read_accounts_file() {
        let mut o = a.as_object().cloned().unwrap();
        let id = js_str(o.get("id"));
        let var = account_env_var(o["provider"].as_str().unwrap()).unwrap();
        let name = crate::nn(o.get("name")).map(|n| js_str(Some(n))).unwrap_or_default();
        o.insert("name".into(), json!(name));
        o.insert("env".into(), json!({ var: path_str(&account_dir().join(id)) }));
        out.push(Value::Object(o));
    }
    out
}
pub fn account_of(id: &str) -> Option<Value> {
    accounts().into_iter().find(|a| a["id"].as_str() == Some(id))
}
/// The process env (with the widened PATH) plus the account's own vars.
pub fn account_env(acc: &Value) -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    env.insert("PATH".into(), path_env().to_string());
    if let Some(e) = acc.get("env").and_then(Value::as_object) {
        for (k, v) in e {
            env.insert(k.clone(), js_str(Some(v)));
        }
    }
    env
}
pub fn add_account(provider: &str, name: Option<&str>) -> Result<Value> {
    if account_env_var(provider).is_none() {
        bail!("{} usa um único login do CLI", provider_name(provider).unwrap_or(provider));
    }
    let mut list = read_accounts_file();
    let mut n = 2;
    while list.iter().any(|a| a["id"].as_str() == Some(&format!("{provider}-{n}"))) {
        n += 1;
    }
    let id = format!("{provider}-{n}");
    let name = name.map(str::trim).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| format!("Conta {n}"));
    list.push(json!({ "id": id, "provider": provider, "name": name }));
    write_accounts_file(&list)?;
    std::fs::create_dir_all(account_dir().join(&id))?;
    account_of(&id).ok_or_else(|| anyhow!("Conta desconhecida"))
}
pub fn remove_account(id: &str) -> Result<()> {
    let list = read_accounts_file();
    if !list.iter().any(|a| a["id"].as_str() == Some(id)) {
        bail!("A conta padrão não pode ser removida");
    }
    write_accounts_file(&list.into_iter().filter(|a| a["id"].as_str() != Some(id)).collect::<Vec<_>>())
}

// ---------------------------------------------------------------- running CLIs
#[derive(Debug, Clone, Serialize)]
pub struct RunResult {
    pub ok: bool,
    pub out: String,
    pub err: String,
}

/// execFile with a timeout: { ok, out, err } (trimmed), never fails. stdin is closed (`opencode run` waits for it).
pub async fn run<S: AsRef<str>>(bin: &str, args: &[S], timeout: Duration, env: Option<&HashMap<String, String>>) -> RunResult {
    let mut cmd = tokio::process::Command::new(bin);
    let args: Vec<&str> = args.iter().map(AsRef::as_ref).collect();
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Some(env) = env {
        cmd.env_clear().envs(env);
    }
    let failed = || format!("Command failed: {bin} {}", args.join(" ")).trim_end().to_string();
    match cmd.spawn() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => RunResult { ok: false, out: String::new(), err: format!("spawn {bin} ENOENT") },
        Err(e) => RunResult { ok: false, out: String::new(), err: e.to_string() },
        Ok(child) => match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Err(_) => RunResult { ok: false, out: String::new(), err: failed() },
            Ok(Err(e)) => RunResult { ok: false, out: String::new(), err: e.to_string() },
            Ok(Ok(o)) => {
                let out = String::from_utf8_lossy(&o.stdout).trim().to_string();
                let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
                let ok = o.status.success();
                let err = if !stderr.is_empty() { stderr } else if ok { String::new() } else { failed() };
                RunResult { ok, out, err }
            }
        },
    }
}
fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}
const T20: Duration = Duration::from_secs(20);

// Codex loads every MCP server from ~/.codex/config.toml; Pena turns them off for its own sessions.
pub fn global_codex_servers(home: Option<&Path>) -> Vec<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^\[mcp_servers\.(?:"([^"]+)"|([^.\]\s]+))\]\s*$"#).unwrap());
    let toml = home.map(Path::to_path_buf).unwrap_or_else(codex_home).join("config.toml");
    let Ok(text) = std::fs::read_to_string(toml) else { return vec![] };
    RE.captures_iter(&text).map(|c| c.get(1).or(c.get(2)).unwrap().as_str().to_string()).collect()
}

// OpenCode loads the MCP servers of ~/.config/opencode/opencode.json(c) too (under mcp.servers); same treatment.
fn strip_jsonc(t: &str) -> String {
    static COMMENTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"("(?:[^"\\]|\\.)*")|//[^\n]*|/\*(?s:.*?)\*/"#).unwrap());
    static TRAILING: LazyLock<Regex> = LazyLock::new(|| Regex::new(r",(\s*[}\]])").unwrap());
    let t = COMMENTS.replace_all(t, |c: &regex::Captures| c.get(1).map_or(String::new(), |s| s.as_str().to_string()));
    TRAILING.replace_all(&t, "$1").into_owned()
}
pub fn global_opencode_servers() -> Vec<String> {
    ["opencode.json", "opencode.jsonc"]
        .iter()
        .flat_map(|f| {
            std::fs::read_to_string(home().join(".config").join("opencode").join(f))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&strip_jsonc(&t)).ok())
                .and_then(|v| v.get("mcp")?.get("servers")?.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()))
                .unwrap_or_default()
        })
        .collect()
}

// ---------------------------------------------------------------- providers
// One status per account, keyed by account id (the default account's id is the provider name).
async fn status_of(acc: Value) -> Value {
    let env = account_env(&acc);
    let provider = acc["provider"].as_str().unwrap_or("").to_string();
    let id = js_str(acc.get("id"));
    let label = acc.get("name").cloned().unwrap_or(Value::Null);
    if provider == "claude" {
        let bin = claude_bin();
        let (cv, cs) = tokio::join!(run(bin, &["--version"], T20, Some(&env)), run(bin, &["auth", "status"], T20, Some(&env)));
        let auth: Value = serde_json::from_str(&cs.out).unwrap_or(json!({}));
        let logged = crate::truthy(auth.get("loggedIn"));
        static CC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*\(Claude Code\)").unwrap());
        let or_null = |k: &str| crate::nn(auth.get(k)).cloned().unwrap_or(Value::Null);
        return json!({
            "name": "Anthropic Claude Code",
            "provider": "claude",
            "label": label,
            "extra": id != "claude",
            "installed": cv.ok,
            "version": CC.replace(&cv.out, ""),
            "binary": bin,
            "connected": logged,
            "method": if logged { if auth.get("authMethod").and_then(Value::as_str) == Some("claude.ai") { json!("Assinatura Claude") } else { auth.get("authMethod").cloned().unwrap_or(Value::Null) } } else { Value::Null },
            "plan": or_null("subscriptionType"),
            "account": or_null("email"),
            "org": or_null("orgName"),
            "detail": if logged { Value::Null } else { json!(if cs.err.is_empty() { "Não está logado no Claude Code".to_string() } else { cs.err }) },
        });
    }
    if provider == "codex" {
        let bin = codex_bin();
        let (xv, xs) = tokio::join!(run(bin, &["--version"], T20, Some(&env)), run(bin, &["login", "status"], T20, Some(&env)));
        let login = format!("{}\n{}", xs.out, xs.err);
        let has = |re: &str| Regex::new(re).unwrap().is_match(&login);
        let logged = xs.ok && has(r"(?i)Logged in");
        static FAILED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^Command failed:[^\n]*\n?").unwrap());
        static CLI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^codex-cli\s*").unwrap());
        let detail = FAILED.replace(&login, "").trim().to_string();
        return json!({
            "name": "OpenAI Codex / ChatGPT",
            "provider": "codex",
            "label": label,
            "extra": id != "codex",
            "installed": xv.ok,
            "version": CLI.replace(&xv.out, ""),
            "binary": bin,
            "connected": logged,
            "method": if has(r"(?i)ChatGPT") { json!("Assinatura ChatGPT") } else if has(r"(?i)API key") { json!("API key") } else { Value::Null },
            "plan": null,
            "account": null,
            "org": null,
            "detail": if logged { Value::Null } else { json!(if detail.is_empty() { "Não está logado no Codex".to_string() } else { detail }) },
        });
    }
    let bin = opencode_bin();
    let (ov, ol) = tokio::join!(run(bin, &["--version"], T20, None), run(bin, &["auth", "list"], T20, None));
    // `opencode auth list` prints one "Name  Account  status" line per credential, columns padded with spaces
    static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());
    static ROW: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\S\s{2,}\S").unwrap());
    static COLS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s{2,}").unwrap());
    let clean = ANSI.replace_all(&ol.out, "");
    let creds: Vec<String> = clean.split('\n').filter(|l| ROW.is_match(l)).map(|l| COLS.split(l.trim()).next().unwrap_or("").to_string()).collect();
    json!({
        "name": "OpenCode",
        "provider": "opencode",
        "label": label,
        "extra": false,
        "installed": ov.ok,
        "version": ov.out,
        "binary": bin,
        // the free OpenCode Zen models work without any credential
        "connected": ov.ok,
        "method": if creds.is_empty() { "Modelos grátis da OpenCode Zen".to_string() } else { creds.join(" · ") },
        "plan": null,
        "account": null,
        "org": null,
        "detail": if ov.ok { Value::Null } else { json!("OpenCode não encontrado (instale em opencode.ai)") },
    })
}

/// -> { <account id>: status }
pub async fn provider_status() -> Value {
    let accs = accounts();
    let tasks: Vec<_> = accs.iter().map(|a| tokio::spawn(status_of(a.clone()))).collect();
    let mut out = Map::new();
    for (a, t) in accs.iter().zip(tasks) {
        out.insert(js_str(a.get("id")), t.await.unwrap_or(Value::Null));
    }
    Value::Object(out)
}

const PROBE_PROMPT: &str = "Reply with the single word OK.";
const PROBE_TIMEOUT: Duration = Duration::from_secs(90);

fn jsonl(out: &str) -> Vec<Value> {
    out.lines().map(|l| serde_json::from_str(l).unwrap_or(json!({}))).collect()
}
fn obj(pairs: Vec<(&str, Option<Value>)>) -> Value {
    Value::Object(pairs.into_iter().filter_map(|(k, v)| Some((k.to_string(), v?))).collect())
}
fn first40(s: &str) -> Value {
    json!(crate::slice16(s, 40))
}
fn first300(s: &str) -> Value {
    json!(crate::slice16(s, 300))
}

/// Live check like pen.dev's "probe": one minimal request with the cheapest settings and a timeout.
/// -> { status: 'connected' | 'not-connected', model?, ms, reply?, error? }
/// Same answers as the SDK-based probe, from one `claude -p` / `codex exec` / `opencode run` call.
pub async fn probe(id: &str) -> Result<Value> {
    let acc = account_of(id).ok_or_else(|| anyhow!("Conta desconhecida"))?;
    let env = account_env(&acc);
    let started = Instant::now();
    let ms = || json!(started.elapsed().as_millis() as u64);
    let timed_out = |r: &RunResult| !r.ok && started.elapsed() >= PROBE_TIMEOUT;
    let err_of = |r: &RunResult| if timed_out(r) { json!("Tempo esgotado (90 s)") } else { first300(&r.err) };
    match acc["provider"].as_str().unwrap_or("") {
        "claude" => {
            let a = args(&["-p", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-turns=1", "--setting-sources=", "--system-prompt=Reply briefly.", "--", PROBE_PROMPT]);
            let r = run(claude_bin(), &a, PROBE_TIMEOUT, Some(&env)).await;
            let ev = jsonl(&r.out);
            let model = ev.iter().find(|m| m["type"] == "system" && m["subtype"] == "init").map(|m| m.get("model").cloned().unwrap_or(Value::Null));
            if let Some(m) = ev.iter().find(|m| m["type"] == "result") {
                let ok = m["subtype"] == "success" && !crate::truthy(m.get("is_error"));
                let reply = m.get("result").and_then(Value::as_str).map(first40);
                return Ok(obj(vec![("status", Some(json!(if ok { "connected" } else { "not-connected" }))), ("model", Some(model.unwrap_or(Value::Null))), ("ms", Some(ms())), ("reply", reply)]));
            }
            if r.ok {
                return Ok(json!({ "status": "not-connected", "ms": ms() }));
            }
            Ok(json!({ "status": "not-connected", "ms": ms(), "error": err_of(&r) }))
        }
        "opencode" => {
            let r = run(opencode_bin(), &args(&["run", "--format", "json", PROBE_PROMPT]), PROBE_TIMEOUT, Some(&env)).await;
            let ev = jsonl(&r.out);
            let reply = ev.iter().find(|e| e["type"] == "text").and_then(|e| e.get("part")?.get("text")?.as_str().map(String::from));
            let err = ev.iter().find(|e| e["type"] == "error").and_then(|e| e.get("error").cloned());
            let error = reply.is_none().then(|| {
                let e = err.as_ref();
                let msg = e.and_then(|e| crate::nn(e.get("data")?.get("message"))).or_else(|| e.and_then(|e| crate::nn(e.get("name")))).map(|v| js_str(Some(v))).unwrap_or_else(|| r.err.clone());
                first300(&msg)
            });
            Ok(obj(vec![
                ("status", Some(json!(if reply.is_some() { "connected" } else { "not-connected" }))),
                ("ms", Some(ms())),
                ("reply", reply.as_deref().map(first40)),
                ("error", error),
            ]))
        }
        _ => {
            // what the Codex SDK runs for a read-only, no-approval, low-effort thread with every global MCP server off
            let mut a = args(&["exec", "--experimental-json"]);
            let home = acc.get("env").and_then(|e| e.get("CODEX_HOME")).and_then(Value::as_str).map(PathBuf::from);
            static BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
            for n in global_codex_servers(home.as_deref()) {
                let key = if BARE.is_match(&n) { n } else { json!(n).to_string() };
                a.extend(["--config".into(), format!("mcp_servers.{key}.enabled=false")]);
            }
            let tmp = path_str(&std::env::temp_dir());
            a.extend(args(&["--sandbox", "read-only", "--cd", &tmp, "--skip-git-repo-check", "--config", "model_reasoning_effort=\"low\"", "--config", "approval_policy=\"never\"", "--", PROBE_PROMPT]));
            let mut env = env;
            env.entry("CODEX_INTERNAL_ORIGINATOR_OVERRIDE".into()).or_insert_with(|| "codex_sdk_ts".into());
            let r = run(codex_bin(), &a, PROBE_TIMEOUT, Some(&env)).await;
            let ev = jsonl(&r.out);
            if let Some(f) = ev.iter().find(|e| e["type"] == "turn.failed") {
                return Ok(json!({ "status": "not-connected", "ms": ms(), "error": first300(&js_str(f.get("error").and_then(|e| e.get("message")))) }));
            }
            if !r.ok {
                let error = if timed_out(&r) { json!("Tempo esgotado (90 s)") } else { first300(&format!("Codex Exec exited with code 1: {}", r.err)) };
                return Ok(json!({ "status": "not-connected", "ms": ms(), "error": error }));
            }
            let reply = ev.iter().filter(|e| e["type"] == "item.completed" && e["item"]["type"] == "agent_message").filter_map(|e| e["item"]["text"].as_str()).next_back().unwrap_or("");
            let reply = (!reply.is_empty()).then(|| first40(reply));
            Ok(obj(vec![("status", Some(json!(if reply.is_some() { "connected" } else { "not-connected" }))), ("ms", Some(ms())), ("reply", reply)]))
        }
    }
}

/// Sign-in happens in the CLI itself (same as pen.dev's "Install Claude Code and log in"): open a Terminal running it.
/// Extra accounts run the CLI with their own config dir, so their login never touches the default one.
pub async fn open_login_terminal(id: &str) -> Result<RunResult> {
    let acc = account_of(id).ok_or_else(|| anyhow!("Conta desconhecida"))?;
    let (bin, cli_args): (&str, &[&str]) = match acc["provider"].as_str().unwrap_or("") {
        "claude" => (claude_bin(), &[]),
        "opencode" => (opencode_bin(), &["auth", "login"]),
        _ => (codex_bin(), &["login"]),
    };
    let envs: Vec<(String, String)> = acc["env"].as_object().map(|o| o.iter().map(|(k, v)| (k.clone(), js_str(Some(v)))).collect()).unwrap_or_default();
    for (_, dir) in &envs {
        std::fs::create_dir_all(dir)?; // Codex refuses a CODEX_HOME that doesn't exist
    }
    if WIN {
        // A .cmd file keeps the env values and the CLI path quoted correctly inside `start`
        let bat = std::env::temp_dir().join(format!("pena-login-{}-{}.cmd", std::process::id(), crate::now_ms()));
        let mut lines: Vec<String> = envs.iter().map(|(k, v)| format!("set \"{k}={v}\"")).collect();
        lines.push(format!("\"{bin}\" {}", cli_args.join(" ")));
        std::fs::write(&bat, lines.join("\r\n"))?;
        let r = run_verbatim_cmd(&format!("start \"Pena\" \"{}\"", bat.display())).await;
        let _ = std::fs::remove_file(&bat);
        return Ok(r);
    }
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let mut parts: Vec<String> = Vec::new();
    if !envs.is_empty() {
        parts.push("env".into());
    }
    parts.extend(envs.iter().map(|(k, v)| format!("{k}={}", q(v))));
    parts.push(q(bin));
    parts.extend(cli_args.iter().map(|s| s.to_string()));
    let cmd = parts.join(" ");
    let script = format!("tell application \"Terminal\" to do script \"{}\"", cmd.replace('"', "\\\""));
    Ok(run("osascript", &[String::from("-e"), script, "-e".into(), "tell application \"Terminal\" to activate".into()], T20, None).await)
}

#[cfg(windows)]
async fn run_verbatim_cmd(line: &str) -> RunResult {
    let mut cmd = tokio::process::Command::new("cmd.exe");
    cmd.arg("/c").raw_arg(line).stdin(Stdio::null());
    match tokio::time::timeout(T20, cmd.output()).await {
        Ok(Ok(o)) => RunResult { ok: o.status.success(), out: String::from_utf8_lossy(&o.stdout).trim().into(), err: String::from_utf8_lossy(&o.stderr).trim().into() },
        Ok(Err(e)) => RunResult { ok: false, out: String::new(), err: e.to_string() },
        Err(_) => RunResult { ok: false, out: String::new(), err: "Command failed: cmd.exe".into() },
    }
}
#[cfg(not(windows))]
async fn run_verbatim_cmd(_line: &str) -> RunResult {
    unreachable!("Windows only")
}

// ---------------------------------------------------------------- Pena's MCP inside external agents
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Launch {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

/// How Pena's design-tool MCP server is launched: this native binary in `mcp` mode (stdio).
pub fn pena_launch() -> Launch {
    let command = std::env::current_exe().map(|p| path_str(&p)).unwrap_or_default();
    let env = std::env::var("PENA_ROOT").ok().filter(|r| !r.is_empty()).map(|r| BTreeMap::from([("PENA_ROOT".to_string(), r)])).unwrap_or_default();
    Launch { command, args: vec!["mcp".into()], env }
}

struct ClientDef {
    id: &'static str,
    name: &'static str,
    file: PathBuf,
    key: &'static str, // where JSON clients keep servers ("" = OpenCode's mcp.servers, or TOML for Codex)
    via: Option<&'static str>,
}

fn clients() -> Vec<ClientDef> {
    let h = home();
    let app_support = if WIN { std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| h.join("AppData").join("Roaming")) } else { h.join("Library").join("Application Support") };
    let c = |id, name, file, key, via| ClientDef { id, name, file, key, via };
    vec![
        c("claude", "Claude Code CLI", h.join(".claude.json"), "mcpServers", Some("claude")),
        c("codex", "Codex CLI", codex_home().join("config.toml"), "", Some("codex")),
        c("gemini", "Gemini CLI", h.join(".gemini").join("settings.json"), "mcpServers", None),
        c("cursor", "Cursor", h.join(".cursor").join("mcp.json"), "mcpServers", None),
        c("opencode", "OpenCode", h.join(".config").join("opencode").join("opencode.json"), "", None),
        c("kiro", "Kiro", h.join(".kiro").join("settings").join("mcp.json"), "mcpServers", None),
        c("claudeDesktop", "Claude Desktop", app_support.join("Claude").join("claude_desktop_config.json"), "mcpServers", None),
    ]
}

fn read_json(f: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(f).ok()?).ok()
}
fn as_obj(v: &mut Value) -> &mut Map<String, Value> {
    if !v.is_object() {
        *v = json!({});
    }
    v.as_object_mut().unwrap()
}
// where a client keeps its servers: OpenCode (v2) nests them under mcp.servers
fn servers_of<'a>(data: &'a mut Value, c: &ClientDef) -> &'a mut Map<String, Value> {
    if c.id == "opencode" {
        let mcp = as_obj(data).entry("mcp").or_insert(Value::Null);
        if mcp.is_null() {
            *mcp = json!({});
        }
        let servers = as_obj(mcp).entry("servers").or_insert(Value::Null);
        if servers.is_null() {
            *servers = json!({});
        }
        as_obj(servers)
    } else {
        let s = as_obj(data).entry(c.key).or_insert(Value::Null);
        if s.is_null() {
            *s = json!({});
        }
        as_obj(s)
    }
}

/// -> { command?, args } of the "pena" server registered in a client, or None.
fn entry_of(c: &ClientDef) -> Option<Value> {
    if c.id == "codex" {
        static CMD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^command\s*=\s*"([^"]*)""#).unwrap());
        static ARGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^args\s*=\s*\[([^\]]*)\]").unwrap());
        static STR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""([^"]*)""#).unwrap());
        let text = std::fs::read_to_string(&c.file).unwrap_or_default();
        let lines: Vec<&str> = if text.is_empty() { vec![] } else { text.split('\n').collect() };
        let start = lines.iter().position(|l| l.trim() == "[mcp_servers.pena]")?;
        let end = lines.iter().enumerate().position(|(i, l)| i > start && l.trim().starts_with('[') && !l.trim().starts_with("[mcp_servers.pena.")).unwrap_or(lines.len());
        let block = lines[start + 1..end].join("\n");
        let command = CMD.captures(&block).map(|m| m[1].to_string());
        let args: Vec<String> = ARGS.captures(&block).map(|m| STR.captures_iter(&m[1]).map(|s| s[1].to_string()).collect()).unwrap_or_default();
        return Some(obj(vec![("command", command.map(Value::from)), ("args", Some(json!(args)))]));
    }
    let mut data = read_json(&c.file)?;
    if !data.is_object() {
        return None;
    }
    let e = servers_of(&mut data, c).get("pena").filter(|e| crate::truthy(Some(e)))?.clone();
    if c.id == "opencode" {
        let cmd = e.get("command").and_then(Value::as_array).cloned().unwrap_or_default();
        return Some(obj(vec![("command", cmd.first().cloned()), ("args", Some(json!(cmd.get(1..).unwrap_or(&[]))))]));
    }
    Some(obj(vec![("command", e.get("command").cloned()), ("args", Some(crate::nn(e.get("args")).cloned().unwrap_or(json!([]))))]))
}

/// -> [{ id, name, file, present, registered, current, entry }]
pub fn integrations() -> Vec<Value> {
    let want = pena_launch();
    clients()
        .iter()
        .map(|c| {
            let entry = entry_of(c);
            let present = c.file.parent().is_some_and(Path::exists) || c.via.is_some_and(|v| Path::new(if v == "claude" { claude_bin() } else { codex_bin() }).exists());
            let current = entry.as_ref().is_some_and(|e| e.get("command").and_then(Value::as_str) == Some(want.command.as_str()) && e["args"] == json!(want.args));
            json!({ "id": c.id, "name": c.name, "file": path_str(&c.file), "present": present, "registered": entry.is_some(), "current": current, "entry": entry })
        })
        .collect()
}

/// Register/remove "pena" in one client. Claude Code and Codex go through their own CLIs (which keep the
/// rest of your config intact); JSON clients get a one-time backup before the first edit.
pub async fn set_integration(id: &str, on: bool) -> Result<Value> {
    let all = clients();
    let c = all.iter().find(|x| x.id == id).ok_or_else(|| anyhow!("Cliente desconhecido: {id}"))?;
    let Launch { command, args: launch_args, env } = pena_launch();
    match c.via {
        Some("claude") => {
            run(claude_bin(), &["mcp", "remove", "pena", "-s", "user"], T20, None).await;
            if on {
                let mut a = args(&["mcp", "add", "pena", "-s", "user"]);
                for (k, v) in &env {
                    a.extend(["-e".into(), format!("{k}={v}")]);
                }
                a.extend(["--".into(), command]);
                a.extend(launch_args);
                let r = run(claude_bin(), &a, T20, None).await;
                if !r.ok {
                    bail!("{}", if r.err.is_empty() { "claude mcp add falhou" } else { &r.err });
                }
            }
        }
        Some(_) => {
            run(codex_bin(), &["mcp", "remove", "pena"], T20, None).await;
            if on {
                let mut a = args(&["mcp", "add", "pena"]);
                for (k, v) in &env {
                    a.extend(["--env".into(), format!("{k}={v}")]);
                }
                a.extend(["--".into(), command]);
                a.extend(launch_args);
                let r = run(codex_bin(), &a, T20, None).await;
                if !r.ok {
                    bail!("{}", if r.err.is_empty() { "codex mcp add falhou" } else { &r.err });
                }
            }
        }
        None => {
            let mut data = read_json(&c.file).filter(|d| !d.is_null()).unwrap_or(json!({}));
            let backup = PathBuf::from(format!("{}.pena-backup", c.file.display()));
            if c.file.exists() && !backup.exists() {
                std::fs::copy(&c.file, &backup)?;
            }
            let servers = servers_of(&mut data, c);
            if on {
                let mut e = Map::new();
                if c.id == "opencode" {
                    e.insert("type".into(), json!("local"));
                    e.insert("command".into(), json!(std::iter::once(command).chain(launch_args).collect::<Vec<_>>()));
                    if !env.is_empty() {
                        e.insert("environment".into(), json!(env));
                    }
                } else {
                    e.insert("command".into(), json!(command));
                    e.insert("args".into(), json!(launch_args));
                    if !env.is_empty() {
                        e.insert("env".into(), json!(env));
                    }
                    if c.id == "claudeDesktop" {
                        e.insert("type".into(), json!("stdio"));
                    }
                }
                servers.insert("pena".into(), Value::Object(e));
            } else {
                servers.shift_remove("pena");
            }
            std::fs::create_dir_all(c.file.parent().unwrap())?;
            std::fs::write(&c.file, pretty(&data, b"  "))?;
        }
    }
    integrations().into_iter().find(|x| x["id"] == id).ok_or_else(|| anyhow!("Cliente desconhecido: {id}"))
}

// A build that moved (checkout ↔ installed app, app updated) leaves a client pointing at a binary that no longer
// exists: its sessions then start with no design tools and never say why. Point those clients back at this build.
fn missing(entry: &Value) -> bool {
    let Some(cmd) = entry.get("command").filter(|c| crate::truthy(Some(c))) else { return true };
    let args = entry.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
    std::iter::once(cmd).chain(args.iter()).any(|p| p.as_str().is_some_and(|p| p.starts_with('/') && !Path::new(p).exists()))
}
/// -> names of the clients that were re-pointed
pub async fn repair_integrations() -> Vec<String> {
    let mut fixed = Vec::new();
    for c in integrations() {
        if c["registered"] != json!(true) || !missing(&c["entry"]) {
            continue;
        }
        if set_integration(c["id"].as_str().unwrap(), true).await.is_ok() {
            fixed.push(js_str(c.get("name")));
        }
    }
    fixed
}

// ---------------------------------------------------------------- extra MCP servers for Pena's agents
fn agent_mcp() -> PathBuf {
    home().join(".pena").join("mcp.json")
}
pub fn read_agent_mcp_text() -> String {
    std::fs::read_to_string(agent_mcp()).unwrap_or_else(|_| "{\n  \"mcpServers\": {}\n}\n".into())
}
pub fn write_agent_mcp_text(text: &str) -> Result<()> {
    let parsed: Value = serde_json::from_str(text)?;
    let Some(servers) = parsed.get("mcpServers").and_then(Value::as_object) else { bail!("O JSON precisa ter um objeto \"mcpServers\"") };
    if servers.get("pena").is_some_and(|p| crate::truthy(Some(p))) {
        bail!("\"pena\" é reservado para o servidor do próprio Pena");
    }
    std::fs::create_dir_all(agent_mcp().parent().unwrap())?;
    std::fs::write(agent_mcp(), if text.ends_with('\n') { text.to_string() } else { format!("{text}\n") })?;
    Ok(())
}
pub fn agent_mcp_servers() -> Value {
    serde_json::from_str::<Value>(&read_agent_mcp_text()).ok().and_then(|v| crate::nn(v.get("mcpServers")).cloned()).unwrap_or(json!({}))
}

/// Start one MCP server the way a client would and list its tools: proves the connection end to end.
/// `config` is { command, args?, env? } or { url, headers? }. -> { ok: true, tools, ms } | { ok: false, error, ms }
pub async fn test_mcp(config: &Value) -> Value {
    let started = Instant::now();
    let ms = || started.elapsed().as_millis() as u64;
    match connect_and_list(config).await {
        Ok(tools) => json!({ "ok": true, "tools": tools, "ms": ms() }),
        Err(e) => {
            static AUTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)401|unauthori[sz]ed").unwrap());
            let msg = format!("{e:#}");
            let error = if AUTH.is_match(&msg) { json!("Precisa de autenticação (OAuth/token)") } else { first300(&msg) };
            json!({ "ok": false, "error": error, "ms": ms() })
        }
    }
}

async fn connect_and_list(config: &Value) -> Result<Vec<String>> {
    use rmcp::ServiceExt;
    use rmcp::model::{ClientCapabilities, ClientConfig, Implementation};
    let info = ClientConfig::new(ClientCapabilities::default(), Implementation::new("pena-settings", "1"));
    let timeout = Duration::from_secs(20);
    let timed_out = || anyhow!("Tempo esgotado (20 s)");
    let client = if let Some(url) = config.get("url").and_then(Value::as_str).filter(|u| !u.is_empty()) {
        use rmcp::transport::StreamableHttpClientTransport;
        use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
        let mut headers = HashMap::new();
        for (k, v) in config.get("headers").and_then(Value::as_object).into_iter().flatten() {
            headers.insert(reqwest::header::HeaderName::from_bytes(k.as_bytes())?, reqwest::header::HeaderValue::from_str(&js_str(Some(v)))?);
        }
        let transport = StreamableHttpClientTransport::from_config(StreamableHttpClientTransportConfig::with_uri(url).custom_headers(headers));
        tokio::time::timeout(timeout, info.serve(transport)).await.map_err(|_| timed_out())??
    } else {
        use rmcp::transport::TokioChildProcess;
        let command = config.get("command").and_then(Value::as_str).ok_or_else(|| anyhow!("The \"command\" argument must be of type string"))?;
        let mut cmd = tokio::process::Command::new(command);
        for a in config.get("args").and_then(Value::as_array).into_iter().flatten() {
            cmd.arg(js_str(Some(a)));
        }
        for (k, v) in config.get("env").and_then(Value::as_object).into_iter().flatten() {
            cmd.env(k, js_str(Some(v)));
        }
        let (transport, _) = TokioChildProcess::builder(cmd).stderr(Stdio::null()).spawn()?;
        tokio::time::timeout(timeout, info.serve(transport)).await.map_err(|_| timed_out())??
    };
    let tools = client.list_tools(Default::default()).await;
    let _ = client.cancel().await;
    Ok(tools?.tools.into_iter().map(|t| t.name.to_string()).collect())
}
