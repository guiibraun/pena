//! Codex over `codex exec --experimental-json` (what @openai/codex-sdk spawns): one process per turn, the prompt
//! on stdin, `resume <thread>` to continue, config as `--config key=toml` overrides, events as JSON lines.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;

use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::*;

/// Codex reads the whole disk and writes in the project; a permission profile also makes the secrets untouchable
/// by its sandbox. Windows keeps the plain workspace-write sandbox (no deny globs there).
const CODEX_PROFILE: bool = !cfg!(windows);

/// The SDK's ThreadOptions as runCodex sets them.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct CodexOptions {
    pub working_directory: PathBuf,
    pub skip_git_repo_check: bool,
    pub additional_directories: Vec<PathBuf>,
    pub sandbox_mode: Option<String>,
    pub web_search_mode: String,
    pub approval_policy: String,
    pub model: Option<String>,
    pub model_reasoning_effort: Option<String>,
}

/// The SDK's Thread: its id once the first turn started, and the options it runs with.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CodexThread {
    pub id: Option<String>,
    pub options: CodexOptions,
}

// --- catalog -------------------------------------------------------------------------------

/// The CLI caches your account's model list (with per-model reasoning levels) after `codex login`. A missing cache
/// is an empty list; borrowing the default account's is the caller's.
pub fn list_codex_models(codex_home: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(codex_home.join("models_cache.json")) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
    v["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|m| m["visibility"] == "list")
        .map(|m| {
            let efforts: Vec<Value> = m["supported_reasoning_levels"].as_array().cloned().unwrap_or_default().iter().map(|l| l["effort"].clone()).collect();
            obj([("id", some(&m["slug"])), ("name", some(&m["display_name"])), ("efforts", Some(json!(efforts))), ("defaultEffort", some(&m["default_reasoning_level"]))])
        })
        .collect()
}

// --- config --------------------------------------------------------------------------------

fn toml_key(k: &str) -> String {
    static BARE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
    if BARE.is_match(k) { k.into() } else { json!(k).to_string() }
}

/// The SDK's toTomlValue.
fn toml_value(v: &Value) -> String {
    match v {
        Value::String(_) => v.to_string(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => format!("[{}]", a.iter().map(toml_value).collect::<Vec<_>>().join(", ")),
        Value::Object(m) => format!("{{{}}}", m.iter().map(|(k, v)| format!("{} = {}", toml_key(k), toml_value(v))).collect::<Vec<_>>().join(", ")),
        Value::Null => String::new(),
    }
}

/// The SDK's flattenConfigOverrides: nested objects become dotted keys (`mcp_servers.pena.env.PENA_FILE="…"`).
fn flatten(v: &Value, prefix: &str, out: &mut Vec<String>) {
    match v {
        Value::Object(m) if m.is_empty() && !prefix.is_empty() => out.push(format!("{prefix}={{}}")),
        Value::Object(m) => {
            for (k, c) in m {
                let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                if c.is_object() { flatten(c, &p, out) } else { out.push(format!("{p}={}", toml_value(c))) }
            }
        }
        _ => out.push(format!("{prefix}={}", toml_value(v))),
    }
}

/// Extra MCP servers you gave Pena's agents (Settings › MCP), in Codex's config shape.
fn codex_server(c: &Value) -> Value {
    if truthy(&c["url"]) {
        let mut v = json!({ "url": c["url"] });
        if truthy(&c["headers"]) {
            v["http_headers"] = c["headers"].clone();
        }
        v
    } else {
        let mut v = json!({ "command": c["command"], "args": some(&c["args"]).unwrap_or(json!([])) });
        if truthy(&c["env"]) {
            v["env"] = c["env"].clone();
        }
        v
    }
}

/// Codex also loads every MCP server from your global ~/.codex/config.toml (e.g. pen.dev's own `pencil`), and the
/// agent may call their tools instead of ours: they are disabled for Pena sessions only, your file is untouched.
pub(crate) fn codex_config(t: &Turn) -> Value {
    let mut servers = Map::new();
    for name in &t.global_codex_servers {
        servers.insert(name.clone(), json!({ "enabled": false }));
    }
    for (n, c) in extra_entries(&t.extra_servers) {
        // a server you also have in config.toml gets its own name: Codex merges same-named entries (url + command fails)
        let name = if t.global_codex_servers.contains(&n) { format!("{n}-pena") } else { n };
        let mut v = codex_server(&c);
        v["default_tools_approval_mode"] = json!("approve");
        servers.insert(name, v);
    }
    let mut pena = pena_json(&t.pena);
    pena["default_tools_approval_mode"] = json!("approve");
    pena["tool_timeout_sec"] = json!(300);
    servers.insert("pena".into(), pena);
    json!({ "mcp_servers": servers })
}

/// Raw TOML overrides: the SDK's `config` splits keys on dots, which breaks path keys like `/x/**/.env`.
pub(crate) fn codex_permissions(root: &Path) -> Vec<String> {
    let r = root.to_string_lossy();
    let deny: Vec<String> = SECRETS.iter().map(|p| format!("{r}/**/{p}")).chain(home_secrets()).map(|p| format!("{} = \"deny\"", json!(p))).collect();
    vec![
        "default_permissions=\"pena\"".into(),
        "permissions.pena.extends=\":workspace\"".into(),
        format!("permissions.pena.filesystem={{glob_scan_max_depth = 8, {}}}", deny.join(", ")),
    ]
}

pub(crate) fn codex_options(t: &Turn, root: &Path) -> CodexOptions {
    CodexOptions {
        working_directory: parent_dir(&t.file),
        skip_git_repo_check: true,
        additional_directories: vec![root.to_path_buf()], // the git root may be above the .pen's folder
        sandbox_mode: (!CODEX_PROFILE).then(|| "workspace-write".into()), // the profile already sets it; Codex refuses both
        web_search_mode: "live".into(), // research on the web, like Claude's WebSearch
        approval_policy: "never".into(),
        model: t.model.clone().filter(|m| !m.is_empty()),
        model_reasoning_effort: t.effort.clone().filter(|e| !e.is_empty()),
    }
}

/// CodexExec.run's argv.
pub(crate) fn codex_args(t: &Turn, root: &Path, o: &CodexOptions, thread: Option<&str>, images: &[PathBuf]) -> Vec<String> {
    let mut a: Vec<String> = vec!["exec".into(), "--experimental-json".into()];
    let mut cfg = vec![];
    flatten(&codex_config(t), "", &mut cfg);
    if CODEX_PROFILE {
        cfg.extend(codex_permissions(root));
    }
    for c in cfg {
        a.extend(["--config".into(), c]);
    }
    if let Some(m) = &o.model {
        a.extend(["--model".into(), m.clone()]);
    }
    if let Some(s) = &o.sandbox_mode {
        a.extend(["--sandbox".into(), s.clone()]);
    }
    a.extend(["--cd".into(), o.working_directory.to_string_lossy().into_owned()]);
    for d in &o.additional_directories {
        a.extend(["--add-dir".into(), d.to_string_lossy().into_owned()]);
    }
    if o.skip_git_repo_check {
        a.push("--skip-git-repo-check".into());
    }
    if let Some(e) = &o.model_reasoning_effort {
        a.extend(["--config".into(), format!("model_reasoning_effort=\"{e}\"")]);
    }
    a.extend(["--config".into(), format!("web_search=\"{}\"", o.web_search_mode)]);
    a.extend(["--config".into(), format!("approval_policy=\"{}\"", o.approval_policy)]);
    if let Some(id) = thread {
        a.extend(["resume".into(), id.into()]);
    }
    for f in images {
        a.extend(["--image".into(), f.to_string_lossy().into_owned()]);
    }
    a
}

/// Which thread this turn runs on, and the prompt it gets (SYSTEM on a new thread, the group change otherwise).
pub(crate) fn codex_thread(t: &Turn, s: &mut Session, o: CodexOptions) -> String {
    let key = serde_json::to_string(&o).unwrap();
    let mut prompt = t.prompt.clone();
    if s.codex.is_none() && s.codex_id.is_some() {
        s.codex = Some(CodexThread { id: s.codex_id.clone(), options: o }); // conversation restored from the chat history
    } else if s.codex.is_none() {
        s.codex = Some(CodexThread { id: None, options: o });
        prompt = format!("{}\n\n---\n\n{prompt}", t.system); // first turn only; codex persists the thread
        s.group = Some(t.group_key.clone());
    } else if s.codex_key.as_deref() != Some(&key) && s.codex.as_ref().is_some_and(|c| c.id.is_some()) {
        let id = s.codex.as_ref().unwrap().id.clone();
        s.codex = Some(CodexThread { id, options: o }); // switch model/effort, keep the conversation
    }
    s.codex_key = Some(key);
    if s.group.as_deref() != Some(&t.group_key) {
        prompt = format!("{}\n\n---\n\n{prompt}", t.group_sync);
        s.group = Some(t.group_key.clone());
    }
    prompt
}

fn status(it: &Value) -> &'static str {
    match it["status"].as_str() {
        Some("failed") => "error",
        Some("completed") => "done",
        _ => "running",
    }
}

/// One `--experimental-json` event → say() events.
pub(crate) fn codex_event(e: &Value, s: &mut Session, say: Say) -> Result<()> {
    let ty = e["type"].as_str().unwrap_or("");
    if ty == "thread.started" {
        if let Some(th) = s.codex.as_mut() {
            th.id = e["thread_id"].as_str().map(String::from);
        }
    }
    let it = &e["item"];
    if it.is_object() && ty.starts_with("item.") {
        let done = ty == "item.completed";
        let id = some(&it["id"]);
        let throttle = (!done).then(|| str_of(&it["id"]));
        match it["type"].as_str().unwrap_or("") {
            "agent_message" => say("text", obj([("id", id), ("text", some(&it["text"])), ("done", Some(json!(done)))]), throttle),
            "reasoning" => say("thinking", obj([("id", id), ("text", some(&it["text"])), ("done", Some(json!(done)))]), throttle),
            "mcp_tool_call" => {
                let text = text_of(&it["result"]["content"]);
                let output = if text.is_empty() { some(&it["error"]["message"]) } else { Some(json!(text)) };
                let images = images_of(&it["result"]["content"]);
                say("tool", obj([("id", id), ("name", some(&it["tool"])), ("input", some(&it["arguments"])), ("status", Some(json!(status(it)))), ("output", output), ("images", Some(json!(images)))]), None)
            }
            "command_execution" => {
                let out = tail(&str_of(&it["aggregated_output"]), 4000);
                say("tool", obj([("id", id), ("name", Some(json!("shell"))), ("input", Some(obj([("command", some(&it["command"]))]))), ("status", Some(json!(status(it)))), ("output", Some(json!(out)))]), None)
            }
            "web_search" => say("tool", obj([("id", id), ("name", Some(json!("web_search"))), ("input", Some(obj([("query", some(&it["query"]))]))), ("status", Some(json!(if done { "done" } else { "running" })))]), None),
            "todo_list" => {
                let items: Vec<Value> = it["items"].as_array().cloned().unwrap_or_default().iter().map(|t| obj([("text", some(&t["text"])), ("status", Some(json!(if t["completed"] == true { "completed" } else { "pending" })))])).collect();
                say("todos", json!({ "items": items }), None)
            }
            _ => {}
        }
    }
    if ty == "turn.completed" {
        let u = &e["usage"];
        s.usage = Some(obj([("input", some(&u["input_tokens"])), ("cacheRead", some(&u["cached_input_tokens"])), ("output", some(&u["output_tokens"]))]));
    }
    if ty == "turn.failed" {
        bail!("{}", str_of(&e["error"]["message"]));
    }
    Ok(())
}

pub async fn run_codex(t: &Turn, s: &mut Session, cancel: CancellationToken, say: Say<'_>) -> Result<()> {
    let root = project_root(&parent_dir(&t.file));
    let prompt = codex_thread(t, s, codex_options(t, &root));
    let th = s.codex.clone().unwrap();
    // Codex takes images as local files.
    let files = image_files(&t.images)?;
    let args = codex_args(t, &root, &th.options, th.id.as_deref(), &files);
    say("model", json!({ "model": t.model.clone().unwrap_or_else(|| "codex".into()) }), None);

    let mut env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
    env.extend(t.env.clone());
    env.entry("CODEX_INTERNAL_ORIGINATOR_OVERRIDE".into()).or_insert_with(|| "codex_sdk_ts".into());
    let mut child = Command::new(&t.codex_bin)
        .args(&args)
        .env_clear()
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    stdin.write_all(prompt.as_bytes()).await?;
    drop(stdin);
    let mut err = child.stderr.take().unwrap();
    let stderr = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b).await;
        String::from_utf8_lossy(&b).into_owned()
    });
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    loop {
        let line = tokio::select! {
            l = lines.next_line() => l?,
            _ = cancel.cancelled() => { let _ = child.kill().await; bail!("The operation was aborted"); }
        };
        let Some(line) = line else { break };
        let e: Value = serde_json::from_str(&line).map_err(|_| anyhow!("Failed to parse item: {line}"))?;
        if let Err(err) = codex_event(&e, s, say) {
            let _ = child.kill().await;
            return Err(err);
        }
    }
    let st = child.wait().await?;
    let code = st.code();
    if code != Some(0) {
        let detail = match exit_signal(&st) {
            Some(sig) => format!("signal {}", signal_name(sig)),
            None => format!("code {}", code.unwrap_or(1)),
        };
        bail!("Codex Exec exited with {detail}: {}", stderr.await.unwrap_or_default());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn turn() -> Turn {
        Turn {
            prompt: "do it".into(),
            model: Some("gpt-6".into()),
            effort: Some("low".into()),
            file: "/w/proj/sub/a.pen".into(),
            system: "SYSTEM".into(),
            group_key: "".into(),
            group_sync: "SYNC".into(),
            pena: Mcp { command: "pena".into(), args: vec![], env: [("PENA_FILE".to_string(), "/w/a.pen".to_string())].into() },
            extra_servers: json!({ "pencil": { "url": "https://p", "headers": { "X": "1" } }, "local": { "command": "srv", "args": ["-a"] } }),
            global_codex_servers: vec!["pencil".into(), "pena".into()],
            ..Default::default()
        }
    }

    #[test]
    fn config_overrides() {
        let mut cfg = vec![];
        flatten(&codex_config(&turn()), "", &mut cfg);
        assert_eq!(cfg, [
            "mcp_servers.pencil.enabled=false",
            "mcp_servers.pena.command=\"pena\"", // your global `pena` is replaced in place by ours
            "mcp_servers.pena.args=[]",
            "mcp_servers.pena.env.PENA_FILE=\"/w/a.pen\"",
            "mcp_servers.pena.default_tools_approval_mode=\"approve\"",
            "mcp_servers.pena.tool_timeout_sec=300",
            "mcp_servers.pencil-pena.url=\"https://p\"",
            "mcp_servers.pencil-pena.http_headers.X=\"1\"",
            "mcp_servers.pencil-pena.default_tools_approval_mode=\"approve\"",
            "mcp_servers.local.command=\"srv\"",
            "mcp_servers.local.args=[\"-a\"]",
            "mcp_servers.local.default_tools_approval_mode=\"approve\"",
        ]);
        let p = codex_permissions(Path::new("/w/proj"));
        assert_eq!(p[0], "default_permissions=\"pena\"");
        assert!(p[2].starts_with("permissions.pena.filesystem={glob_scan_max_depth = 8, \"/w/proj/**/.env\" = \"deny\", "));
        assert!(p[2].ends_with("/.pena/mcp.json\" = \"deny\"}"));
    }

    #[test]
    fn args_and_threads() {
        let t = turn();
        let root = Path::new("/w/proj");
        let mut s = Session::default();
        let prompt = codex_thread(&t, &mut s, codex_options(&t, root));
        assert_eq!(prompt, "SYSTEM\n\n---\n\ndo it");
        let th = s.codex.clone().unwrap();
        let a = codex_args(&t, root, &th.options, th.id.as_deref(), &["/tmp/i.png".into()]);
        assert_eq!(&a[..2], ["exec", "--experimental-json"]);
        let tail: Vec<&str> = a.iter().skip_while(|x| *x != "--model").map(String::as_str).collect();
        assert_eq!(tail, [
            "--model", "gpt-6", "--cd", "/w/proj/sub", "--add-dir", "/w/proj", "--skip-git-repo-check",
            "--config", "model_reasoning_effort=\"low\"", "--config", "web_search=\"live\"", "--config", "approval_policy=\"never\"",
            "--image", "/tmp/i.png",
        ]);

        // the first turn's thread.started gives the id; the next turn resumes it without SYSTEM
        codex_event(&json!({ "type": "thread.started", "thread_id": "T1" }), &mut s, &|_, _, _| {}).unwrap();
        assert_eq!(native_session("codex", &s).as_deref(), Some("T1"));
        assert_eq!(codex_thread(&t, &mut s, codex_options(&t, root)), "do it");
        let a = codex_args(&t, root, &s.codex.as_ref().unwrap().options, Some("T1"), &[]);
        assert_eq!(&a[a.len() - 2..], ["resume", "T1"]);

        // another model keeps the thread with the new options
        let t2 = Turn { model: Some("gpt-7".into()), ..t.clone() };
        codex_thread(&t2, &mut s, codex_options(&t2, root));
        assert_eq!(s.codex.as_ref().unwrap().options.model.as_deref(), Some("gpt-7"));
        assert_eq!(s.codex.as_ref().unwrap().id.as_deref(), Some("T1"));

        // a group change since the thread last saw it rides along
        let t3 = Turn { group_key: "g1".into(), ..t2.clone() };
        assert_eq!(codex_thread(&t3, &mut s, codex_options(&t3, root)), "SYNC\n\n---\n\ndo it");

        // restored from history: resumed, no SYSTEM; its group is unknown, so the sync text goes along
        let mut r = Session { codex_id: Some("OLD".into()), ..Default::default() };
        assert_eq!(codex_thread(&t, &mut r, codex_options(&t, root)), "SYNC\n\n---\n\ndo it");
        assert_eq!(r.codex.unwrap().id.as_deref(), Some("OLD"));
    }

    #[test]
    fn events() {
        let ev = Mutex::new(vec![]);
        let say = |k: &str, d: Value, key: Option<String>| ev.lock().unwrap().push((k.to_string(), d, key));
        let mut s = Session { codex: Some(CodexThread::default()), ..Default::default() };
        let mut last = Ok(());
        for l in include_str!("../tests/fixtures/codex_items.jsonl").lines().chain(include_str!("../tests/fixtures/codex_failed.jsonl").lines()) {
            last = codex_event(&serde_json::from_str(l).unwrap(), &mut s, &say);
            if last.is_err() {
                break;
            }
        }
        assert_eq!(last.unwrap_err().to_string(), "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.");
        assert_eq!(native_session("codex", &s).as_deref(), Some("01a1b085-cc2a-7722-bdf3-b29da56a8a94")); // the recorded failure's thread
        let ev = ev.into_inner().unwrap();
        let want = [
            ("thinking", json!({ "id": "item_0", "text": "Plan", "done": false }), Some("item_0")),
            ("thinking", json!({ "id": "item_0", "text": "Plan it", "done": true }), None),
            ("tool", json!({ "id": "item_1", "name": "shell", "input": { "command": "echo hi" }, "status": "running", "output": "" }), None),
            ("tool", json!({ "id": "item_1", "name": "shell", "input": { "command": "echo hi" }, "status": "done", "output": "hi\n" }), None),
            ("tool", json!({ "id": "item_2", "name": "execute", "input": { "description": "x" }, "status": "done", "output": "made it", "images": ["data:image/png;base64,AA"] }), None),
            ("tool", json!({ "id": "item_3", "name": "get_node", "input": {}, "status": "error", "output": "no node", "images": [] }), None),
            ("tool", json!({ "id": "item_4", "name": "web_search", "input": { "query": "pena" }, "status": "running" }), None),
            ("todos", json!({ "items": [{ "text": "a", "status": "completed" }, { "text": "b", "status": "pending" }] }), None),
            ("text", json!({ "id": "item_6", "text": "ok", "done": true }), None),
        ];
        assert_eq!(ev.len(), want.len());
        for (got, (k, d, key)) in ev.iter().zip(want) {
            assert_eq!(got, &(k.to_string(), d, key.map(String::from)));
        }
        assert_eq!(s.usage.unwrap(), json!({ "input": 120, "cacheRead": 100, "output": 7 }));
    }

    #[test]
    fn catalog() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/test-codex-home");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("models_cache.json"), r#"{"models":[{"slug":"a","display_name":"A","visibility":"list","default_reasoning_level":"low","supported_reasoning_levels":[{"effort":"low"},{"effort":"high"}]},{"slug":"h","visibility":"hide"}]}"#).unwrap();
        assert_eq!(list_codex_models(&dir), vec![json!({ "id": "a", "name": "A", "efforts": ["low", "high"], "defaultEffort": "low" })]);
        assert!(list_codex_models(Path::new("/nonexistent")).is_empty());
    }
}
