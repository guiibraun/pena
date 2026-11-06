//! Claude Code over its SDK protocol: `claude --output-format stream-json --input-format stream-json …`, a control
//! channel on the same stdio (initialize, can_use_tool, mcp_reconnect, interrupt) and the stream of SDK messages.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::*;

/// The SDK version whose CLI contract this mirrors (sent as CLAUDE_AGENT_SDK_VERSION, like the SDK).
const SDK_VERSION: &str = "0.3.301";

/// Searching the code needs Bash (Claude Code has no Grep/Glob tools anymore). It only runs inside the OS sandbox
/// (macOS seatbelt): no network, writes only in the project, secrets untouchable. Elsewhere the agent gets no Bash.
const SANDBOXED_BASH: bool = cfg!(target_os = "macos");

/// canUseTool: answers one can_use_tool control request with the `response` object.
type Permit = Arc<dyn Fn(&str, &Value) -> Value + Send + Sync>;

struct Claude {
    child: Child,
    stdin: Arc<Mutex<Option<ChildStdin>>>,
    pending: Arc<StdMutex<HashMap<String, oneshot::Sender<Value>>>>,
    rx: mpsc::UnboundedReceiver<Value>,
    stderr: tokio::task::JoinHandle<String>,
    next_id: u64,
}

async fn write_line(stdin: &Mutex<Option<ChildStdin>>, v: &Value) -> Result<()> {
    let mut g = stdin.lock().await;
    let w = g.as_mut().ok_or_else(|| anyhow!("ProcessTransport is not ready for writing"))?;
    w.write_all(format!("{v}\n").as_bytes()).await?;
    w.flush().await?;
    Ok(())
}

/// The env the SDK gives the CLI: the account's env over ours, its entrypoint markers, no NODE_OPTIONS/DEBUG.
fn claude_env(over: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    env.extend(over.iter().map(|(k, v)| (k.clone(), v.clone())));
    env.entry("CLAUDE_CODE_ENTRYPOINT".into()).or_insert_with(|| "sdk-ts".into());
    env.entry("CLAUDE_AGENT_SDK_VERSION".into()).or_insert_with(|| SDK_VERSION.into());
    if !env.keys().any(|k| k.eq_ignore_ascii_case("CLAUDE_CODE_SDK_READS_SESSION_STATE")) {
        env.insert("CLAUDE_CODE_SDK_READS_SESSION_STATE".into(), "1".into());
    }
    env.remove("NODE_OPTIONS");
    if env.get("DEBUG_CLAUDE_AGENT_SDK").is_some_and(|v| !v.is_empty() && v != "0" && v != "false") {
        env.insert("DEBUG".into(), "1".into());
    } else {
        env.remove("DEBUG");
    }
    env
}

impl Claude {
    fn spawn(bin: &Path, args: &[String], cwd: Option<&Path>, env: BTreeMap<String, String>, permit: Option<Permit>) -> Result<Self> {
        let mut cmd = Command::new(bin);
        cmd.args(args).env_clear().envs(env).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        let mut child = cmd.spawn().map_err(|e| anyhow!("Failed to spawn Claude Code process: {e}"))?;
        let stdin = Arc::new(Mutex::new(child.stdin.take()));
        let pending: Arc<StdMutex<HashMap<String, oneshot::Sender<Value>>>> = Default::default();
        let (tx, rx) = mpsc::unbounded_channel();
        let mut err = child.stderr.take().unwrap();
        let stderr = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = err.read_to_end(&mut buf).await;
            String::from_utf8_lossy(&buf).into_owned()
        });
        let out = child.stdout.take().unwrap();
        let (w, p) = (stdin.clone(), pending.clone());
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(m) = serde_json::from_str::<Value>(&line) else { continue };
                match m["type"].as_str() {
                    Some("control_response") => {
                        let id = str_of(&m["response"]["request_id"]);
                        if let Some(s) = p.lock().unwrap().remove(&id) {
                            let _ = s.send(m["response"].clone());
                        }
                    }
                    Some("control_request") => {
                        if let Some(r) = answer(&m, permit.as_ref()) {
                            let _ = write_line(&w, &r).await;
                        }
                    }
                    Some("control_cancel_request") | Some("keep_alive") => {}
                    _ => {
                        let _ = tx.send(m);
                    }
                }
            }
            p.lock().unwrap().clear(); // the CLI is gone: pending requests fail
        });
        Ok(Claude { child, stdin, pending, rx, stderr, next_id: 0 })
    }

    fn send_request(&mut self) -> (String, oneshot::Receiver<Value>) {
        self.next_id += 1;
        let id = format!("pena{}", self.next_id);
        let (s, r) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), s);
        (id, r)
    }

    /// A control request; resolves with its `response` payload.
    async fn request(&mut self, req: Value) -> Result<Value> {
        let subtype = str_of(&req["subtype"]);
        let (id, r) = self.send_request();
        write_line(&self.stdin, &json!({ "request_id": id, "type": "control_request", "request": req })).await?;
        let res = r.await.map_err(|_| anyhow!("Claude Code control request failed ({subtype}): the process exited"))?;
        if res["subtype"] == "success" { Ok(res["response"].clone()) } else { Err(anyhow!("{}", str_of(&res["error"]))) }
    }

    async fn end_input(&self) {
        self.stdin.lock().await.take();
    }

    /// Wait for the exit; a failed exit carries the stderr tail, like the SDK's ProcessTransport.
    async fn finish(mut self) -> Result<()> {
        let status = self.child.wait().await?;
        let tail = tail(self.stderr.await.unwrap_or_default().trim(), 2048);
        let tail = if tail.trim().is_empty() { String::new() } else { format!(". stderr: {}", tail.trim()) };
        if let Some(code) = status.code().filter(|c| *c != 0) {
            bail!("Claude Code process exited with code {code}{tail}");
        }
        if let Some(sig) = exit_signal(&status) {
            bail!("Claude Code process terminated by signal {}{tail}", signal_name(sig));
        }
        Ok(())
    }

    /// Stop: interrupt the turn so the CLI can wind down, then close it.
    async fn stop(mut self) {
        let (id, _r) = self.send_request();
        let _ = write_line(&self.stdin, &json!({ "request_id": id, "type": "control_request", "request": { "subtype": "interrupt" } })).await;
        self.end_input().await;
        if tokio::time::timeout(Duration::from_secs(2), self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
        }
    }
}

/// The SDK's processControlRequest for what Pena uses: can_use_tool goes to our rules, the remote_* requests are
/// left unanswered, anything else is refused.
fn answer(m: &Value, permit: Option<&Permit>) -> Option<Value> {
    let req = &m["request"];
    let sub = str_of(&req["subtype"]);
    if ["remote_tool_call", "remote_plumbing_call", "remote_tools_probe", "remote_tools_reannounce"].contains(&sub.as_str()) {
        return None;
    }
    let id = m["request_id"].clone();
    let result = match (sub.as_str(), permit) {
        ("can_use_tool", Some(p)) => {
            let mut r = p(req["tool_name"].as_str().unwrap_or(""), &req["input"]);
            r["toolUseID"] = req["tool_use_id"].clone();
            Ok(r)
        }
        ("can_use_tool", None) => Err("canUseTool callback is not provided.".to_string()),
        _ => Err(format!("Unsupported control request subtype: {sub}")),
    };
    Some(match result {
        Ok(r) => json!({ "type": "control_response", "response": { "subtype": "success", "request_id": id, "response": r } }),
        Err(e) => json!({ "type": "control_response", "response": { "subtype": "error", "request_id": id, "error": e } }),
    })
}

/// The SDK's fixed argv head.
fn base_args() -> Vec<String> {
    ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json"].map(String::from).to_vec()
}

/// `--flag value`, or `--flag=value` when the value looks like a flag (the SDK's q_).
fn flag_value(args: &mut Vec<String>, flag: &str, v: String) {
    if v.len() > 1 && v.starts_with('-') {
        args.push(format!("{flag}={v}"));
    } else {
        args.push(flag.into());
        args.push(v);
    }
}

// --- catalog -------------------------------------------------------------------------------

/// "Opus" → "Opus 5.5" and "Default (recommended)" → "… · Opus 5.5": a logged-out CLI and the default row name the
/// alias, not the model it runs. resolvedModel says which.
pub(crate) fn claude_model_name(m: &Value) -> String {
    static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-\d{8}$").unwrap());
    let display = str_of(&m["displayName"]);
    let Some(resolved) = m["resolvedModel"].as_str() else { return display };
    if display.chars().any(|c| c.is_ascii_digit()) {
        return display;
    }
    let r = resolved.strip_prefix("claude-").unwrap_or(resolved);
    let r = DATE.replace(r, "");
    let v: Vec<&str> = r.split('-').collect();
    let mut first = v[0].chars();
    let cap = first.next().map(|c| c.to_uppercase().collect::<String>() + first.as_str()).unwrap_or_default();
    let resolved = format!("{cap} {}", v[1..].join(".")).trim().to_string();
    if m["value"] == "default" { format!("{display} · {resolved}") } else { resolved }
}

/// The SDK asks the logged-in CLI which models your plan has, and which efforts each supports (the initialize
/// response). Caching and the default-account fallback are the caller's (they need the account list).
pub async fn list_claude_models(bin: &Path, env: &BTreeMap<String, String>) -> Result<Vec<Value>> {
    let mut c = Claude::spawn(bin, &base_args(), None, claude_env(env), None)?;
    // no systemPrompt option: the SDK sends [""]
    let init = tokio::time::timeout(Duration::from_secs(20), c.request(json!({ "subtype": "initialize", "systemPrompt": [""] }))).await;
    let _ = c.child.kill().await;
    let init = init.map_err(|_| anyhow!("Tempo esgotado (20 s)"))??;
    Ok(init["models"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            json!({ "id": m["value"], "name": claude_model_name(m), "efforts": m.get("supportedEffortLevels").cloned().unwrap_or(json!([])), "defaultEffort": "high" })
        })
        .collect())
}

// --- run -----------------------------------------------------------------------------------

/// The design tools plus the project's files; everything else is refused.
pub(crate) fn claude_allows(name: &str, input: &Value, root: &Path, attach: &Path, extra: &[String]) -> bool {
    let path = |k: &str| str_of(&input[k]);
    let edit_path = if input["file_path"].is_null() { path("notebook_path") } else { path("file_path") };
    name.starts_with("mcp__pena__")
        || extra.iter().any(|s| name.starts_with(&format!("mcp__{s}__")))
        || ["WebSearch", "WebFetch", "TodoWrite"].contains(&name) // research and the agent's plan
        || (name == "Bash" && SANDBOXED_BASH)
        || (name == "Read" && [root, attach].iter().any(|d| inside(&path("file_path"), d)))
        || (["Edit", "Write", "NotebookEdit"].contains(&name) && inside(&edit_path, root) && !path("file_path").to_lowercase().ends_with(".pen"))
}

fn deny_message(root: &Path) -> String {
    format!(
        "Only the pena design tools, web search/fetch, the MCP servers configured in Pena, attached files and the project at {} (no secrets, no .pen files) are available.",
        root.display()
    )
}

/// Deny rules beat every allow, so the file tools never open a secret (Edit rules also cover Write).
pub(crate) fn disallowed_tools() -> Vec<String> {
    let home = home_secrets();
    ["Read", "Edit"]
        .iter()
        .flat_map(|t| {
            SECRETS.iter().map(move |p| format!("{t}(//**/{p})")).chain(home.iter().flat_map(move |d| [format!("{t}(/{d})"), format!("{t}(/{d}/**)")])).collect::<Vec<_>>()
        })
        .collect()
}

/// settings.agentMcpServers() in Claude's --mcp-config shape, then pena.
pub(crate) fn claude_mcp_config(t: &Turn) -> Value {
    let mut servers = Map::new();
    for (n, c) in extra_entries(&t.extra_servers) {
        let v = if truthy(&c["url"]) {
            let mut v = json!({ "type": if c["type"] == "sse" { "sse" } else { "http" }, "url": c["url"] });
            if truthy(&c["headers"]) {
                v["headers"] = c["headers"].clone();
            }
            v
        } else {
            let mut v = json!({ "command": c["command"], "args": some(&c["args"]).unwrap_or(json!([])) });
            if truthy(&c["env"]) {
                v["env"] = c["env"].clone();
            }
            v
        };
        servers.insert(n, v);
    }
    servers.insert("pena".into(), pena_json(&t.pena));
    json!({ "mcpServers": servers })
}

/// Seatbelt needs absolute paths: a bare **/.env pattern doesn't match.
pub(crate) fn sandbox_settings(root: &Path, file: &Path) -> Value {
    let r = root.to_string_lossy();
    let deny_read: Vec<String> = secrets(&r).into_iter().chain(home_secrets()).collect();
    let deny_write: Vec<String> = secrets(&r).into_iter().chain([file.to_string_lossy().into_owned()]).collect();
    json!({ "sandbox": {
        "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
        "filesystem": { "allowWrite": [r], "denyRead": deny_read, "denyWrite": deny_write },
    } })
}

/// The argv the SDK builds for runClaude's options, in the SDK's order.
pub(crate) fn claude_args(t: &Turn, s: &Session, root: &Path) -> Vec<String> {
    let mut a = base_args();
    if let Some(e) = t.effort.as_deref().filter(|e| !e.is_empty()) {
        a.push(format!("--effort={e}"));
    }
    if let Some(m) = t.model.as_deref().filter(|m| !m.is_empty() && *m != "default") {
        a.push(format!("--model={m}"));
    }
    a.push("--permission-prompt-tool=stdio".into());
    if let Some(r) = &s.claude {
        a.push(format!("--resume={r}"));
    }
    a.push(format!("--disallowedTools={}", disallowed_tools().join(",")));
    flag_value(&mut a, "--mcp-config", claude_mcp_config(t).to_string());
    a.push("--include-partial-messages".into()); // token-by-token text, thinking and tool input
    for d in [root, t.attach_dir.as_path()] {
        a.push(format!("--add-dir={}", d.display()));
    }
    if SANDBOXED_BASH {
        flag_value(&mut a, "--settings", sandbox_settings(root, &t.file).to_string());
    }
    a
}

/// Images from the chat and PDFs as content blocks of the user message.
pub(crate) fn claude_user_message(prompt: &str, images: &[String], docs: &[String]) -> Value {
    let mut content: Vec<Value> = images
        .iter()
        .filter_map(|d| data_url(d))
        .map(|(mime, b64)| json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": b64 } }))
        .collect();
    content.extend(docs.iter().map(|b64| json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": b64 } })));
    content.push(json!({ "type": "text", "text": prompt }));
    json!({ "type": "user", "session_id": "", "message": { "role": "user", "content": content }, "parent_tool_use_id": null })
}

struct Blk {
    kind: String,
    id: String,
    name: String,
    text: String,
    json: String,
    desc: Option<String>,
}

/// SDK messages → say() events, the body of runClaude's `for await`.
#[derive(Default)]
pub(crate) struct ClaudeMapper {
    msg_id: String,
    blocks: HashMap<i64, Blk>,
}

impl ClaudeMapper {
    /// Ok(Some(status)) when the init message says the pena server failed to start.
    pub(crate) fn handle(&mut self, m: &Value, s: &mut Session, say: Say) -> Result<Option<String>> {
        let ty = m["type"].as_str().unwrap_or("");
        if ty == "system" && m["subtype"] == "init" {
            s.claude = m["session_id"].as_str().map(String::from);
            say("model", obj([("model", some(&m["model"]))]), None);
            // the design tools come from a child process: if it did not start, this turn cannot edit the file at all
            if let Some(p) = m["mcp_servers"].as_array().and_then(|a| a.iter().find(|x| x["name"] == "pena")) {
                let st = str_of(&p["status"]);
                if st == "failed" || st == "needs-auth" {
                    return Ok(Some(st));
                }
            }
        }
        if ty == "stream_event" {
            let e = &m["event"];
            match e["type"].as_str().unwrap_or("") {
                "message_start" => {
                    self.msg_id = str_of(&e["message"]["id"]);
                    self.blocks.clear();
                }
                "content_block_start" => {
                    let b = &e["content_block"];
                    let idx = e["index"].as_i64().unwrap_or(0);
                    let kind = str_of(&b["type"]);
                    let id = if kind == "tool_use" { str_of(&b["id"]) } else { format!("{}:{idx}", self.msg_id) };
                    let blk = Blk { kind, id, name: short_tool(&str_of(&b["name"])), text: String::new(), json: String::new(), desc: None };
                    if blk.kind == "tool_use" && blk.name != "TodoWrite" {
                        say("tool", json!({ "id": blk.id, "name": blk.name, "status": "running" }), None);
                    }
                    if blk.kind == "thinking" {
                        say("thinking", json!({ "id": blk.id, "text": "" }), None);
                    }
                    self.blocks.insert(idx, blk);
                }
                "content_block_delta" => {
                    let Some(blk) = self.blocks.get_mut(&e["index"].as_i64().unwrap_or(0)) else { return Ok(None) };
                    let d = &e["delta"];
                    match d["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            blk.text += &str_of(&d["text"]);
                            say("text", json!({ "id": blk.id, "text": blk.text }), Some(blk.id.clone()));
                        }
                        "thinking_delta" => {
                            blk.text += &str_of(&d["thinking"]);
                            say("thinking", json!({ "id": blk.id, "text": blk.text }), Some(blk.id.clone()));
                        }
                        "input_json_delta" if blk.name != "TodoWrite" => {
                            static DESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""description"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap());
                            static ESC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());
                            blk.json += &str_of(&d["partial_json"]);
                            // the execute tool's `description` names the card while the script is still being written
                            let desc = DESC.captures(&blk.json).map(|c| c[1].to_string());
                            if let Some(desc) = desc.filter(|d| !d.is_empty() && Some(d) != blk.desc.as_ref()) {
                                let label = ESC.replace_all(&desc, "$1").into_owned();
                                blk.desc = Some(desc);
                                say("tool", json!({ "id": blk.id, "name": blk.name, "status": "running", "label": label }), None);
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    if let Some(blk) = self.blocks.get(&e["index"].as_i64().unwrap_or(0)) {
                        if blk.kind == "text" || blk.kind == "thinking" {
                            say(&blk.kind, json!({ "id": blk.id, "text": blk.text, "done": true }), None);
                        }
                    }
                }
                _ => {}
            }
        }
        if ty == "assistant" {
            let content = m["message"]["content"].as_array().cloned().unwrap_or_default();
            for (i, b) in content.iter().enumerate() {
                if b["type"] == "tool_use" && b["name"] == "TodoWrite" {
                    s.todo_ids.insert(str_of(&b["id"]));
                    let items: Vec<Value> = b["input"]["todos"].as_array().cloned().unwrap_or_default().iter().map(|t| obj([("text", some(&t["content"])), ("status", some(&t["status"]))])).collect();
                    say("todos", json!({ "items": items }), None);
                } else if b["type"] == "tool_use" {
                    say("tool", obj([("id", some(&b["id"])), ("name", Some(json!(short_tool(&str_of(&b["name"]))))), ("input", some(&b["input"])), ("status", Some(json!("running")))]), None);
                }
                if b["type"] == "text" && truthy(&b["text"]) {
                    // also covers runs without stream events
                    say("text", json!({ "id": format!("{}:{i}", str_of(&m["message"]["id"])), "text": b["text"], "done": true }), None);
                }
            }
        }
        if ty == "user" {
            if let Some(content) = m["message"]["content"].as_array() {
                for b in content {
                    if b["type"] == "tool_result" && !s.todo_ids.contains(&str_of(&b["tool_use_id"])) {
                        let status = if b["is_error"] == true { "error" } else { "done" };
                        say("tool", json!({ "id": b["tool_use_id"], "status": status, "output": text_of(&b["content"]), "images": images_of(&b["content"]) }), None);
                    }
                }
            }
        }
        if ty == "result" {
            let u = &m["usage"];
            s.usage = Some(obj([
                ("costUsd", some(&m["total_cost_usd"])),
                ("turns", some(&m["num_turns"])),
                ("input", some(&u["input_tokens"])),
                ("output", some(&u["output_tokens"])),
                ("cacheRead", some(&u["cache_read_input_tokens"])),
                ("cacheWrite", some(&u["cache_creation_input_tokens"])),
            ]));
            let sub = str_of(&m["subtype"]);
            if sub != "success" {
                bail!("{}", if sub == "error_max_turns" { "Limite de turnos atingido".into() } else { sub });
            }
        }
        Ok(None)
    }
}

pub async fn run_claude(t: &Turn, s: &mut Session, cancel: CancellationToken, say: Say<'_>) -> Result<()> {
    let cwd = parent_dir(&t.file);
    let root = project_root(&cwd);
    let extra: Vec<String> = extra_entries(&t.extra_servers).into_iter().map(|(n, _)| n).collect();
    let (r, a): (PathBuf, PathBuf) = (root.clone(), t.attach_dir.clone());
    let permit: Permit = Arc::new(move |name, input| {
        if claude_allows(name, input, &r, &a, &extra) {
            json!({ "behavior": "allow", "updatedInput": input })
        } else {
            json!({ "behavior": "deny", "message": deny_message(&r) })
        }
    });
    let mut c = Claude::spawn(&t.claude_bin, &claude_args(t, s, &root), Some(&cwd), claude_env(&t.env), Some(permit))?;
    let init = json!({ "subtype": "initialize", "appendSystemPrompt": t.system }); // preset claude_code + append
    tokio::select! {
        r = c.request(init) => { r?; }
        _ = cancel.cancelled() => { c.stop().await; bail!("Claude Code process aborted by user"); }
    }
    write_line(&c.stdin, &claude_user_message(&t.prompt, &t.images, &t.docs)).await?;
    let mut mapper = ClaudeMapper::default();
    let (mut state, mut result) = (None::<String>, false);
    loop {
        let m = tokio::select! {
            m = c.rx.recv() => m,
            _ = cancel.cancelled() => { c.stop().await; bail!("Claude Code process aborted by user"); }
        };
        let Some(m) = m else { break };
        // one turn: stdin closes once the result is in and the session is idle, so the CLI exits
        if m["type"] == "system" && m["subtype"] == "session_state_changed" {
            state = m["state"].as_str().map(String::from);
            if result && state.as_deref() == Some("idle") {
                c.end_input().await;
            }
        }
        if m["type"] == "result" {
            result = true;
            if state.is_none() || state.as_deref() == Some("idle") {
                c.end_input().await;
            }
        }
        match mapper.handle(&m, s, say) {
            Ok(None) => {}
            Ok(Some(status)) => {
                let _ = tokio::time::timeout(Duration::from_secs(10), c.request(json!({ "subtype": "mcp_reconnect", "serverName": "pena" }))).await;
                let _ = c.child.kill().await;
                bail!("As ferramentas de design não conectaram nesta sessão (pena: {status}).");
            }
            Err(e) => {
                let _ = c.child.kill().await;
                return Err(e);
            }
        }
    }
    c.finish().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn record(lines: &str, s: &mut Session) -> (Vec<(String, Value, Option<String>)>, Result<()>) {
        let events = Mutex::new(vec![]);
        let say = |k: &str, d: Value, key: Option<String>| events.lock().unwrap().push((k.to_string(), d, key));
        let mut m = ClaudeMapper::default();
        let mut res = Ok(());
        for l in lines.lines().filter(|l| !l.trim().is_empty()) {
            let v: Value = serde_json::from_str(l).unwrap();
            if let Err(e) = m.handle(&v, s, &say) {
                res = Err(e);
                break;
            }
        }
        (events.into_inner().unwrap(), res)
    }

    #[test]
    fn maps_a_recorded_text_turn() {
        let mut s = Session::default();
        let (ev, res) = record(include_str!("../tests/fixtures/claude_text.jsonl"), &mut s);
        res.unwrap();
        assert_eq!(s.claude.as_deref(), Some("134de7fa-4c92-49a1-9a9c-333f9cbba28d"));
        assert_eq!(ev[0], ("model".into(), json!({ "model": "claude-haiku-5-5" }), None));
        let id = "msg_011CgmZQtidTDW343T6eS7ap:0";
        assert!(ev.contains(&("text".into(), json!({ "id": id, "text": "ok" }), Some(id.into()))));
        assert_eq!(ev.iter().filter(|e| e.1 == json!({ "id": id, "text": "ok", "done": true })).count(), 2); // assistant + block stop
        let u = s.usage.unwrap();
        assert_eq!(u["output"], 4);
        assert_eq!(u["turns"], 1);
        assert!(u["costUsd"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn maps_a_recorded_tool_turn() {
        let mut s = Session::default();
        let (ev, res) = record(include_str!("../tests/fixtures/claude_tool.jsonl"), &mut s);
        res.unwrap();
        let tool = "toolu_01NrVZLaK37AWwkLBTTrkph2";
        assert!(ev.contains(&("tool".into(), json!({ "id": tool, "name": "Bash", "status": "running" }), None)));
        // the description streamed in the input names the card
        assert!(ev.iter().any(|e| e.0 == "tool" && e.1["label"] == "Print hi"));
        assert!(ev.contains(&("tool".into(), json!({ "id": tool, "name": "Bash", "input": { "command": "echo hi", "description": "Print hi" }, "status": "running" }), None)));
        assert!(ev.contains(&("tool".into(), json!({ "id": tool, "status": "done", "output": "hi", "images": [] }), None)));
        assert!(ev.iter().any(|e| e.0 == "thinking" && e.1["done"] == true));
    }

    #[test]
    fn todos_errors_and_pena_down() {
        let mut s = Session::default();
        let lines = [
            json!({ "type": "assistant", "message": { "id": "m1", "content": [{ "type": "tool_use", "id": "t1", "name": "TodoWrite", "input": { "todos": [{ "content": "A", "status": "pending" }] } }, { "type": "tool_use", "id": "t2", "name": "mcp__pena__execute", "input": { "x": 1 } }] } }),
            json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "ok" }, { "type": "tool_result", "tool_use_id": "t2", "is_error": true, "content": [{ "type": "text", "text": "boom" }, { "type": "image", "source": { "media_type": "image/png", "data": "AA" } }] }] } }),
            json!({ "type": "result", "subtype": "error_max_turns", "num_turns": 3 }),
        ]
        .map(|v| v.to_string())
        .join("\n");
        let (ev, res) = record(&lines, &mut s);
        assert_eq!(ev[0], ("todos".into(), json!({ "items": [{ "text": "A", "status": "pending" }] }), None));
        assert_eq!(ev[1].1, json!({ "id": "t2", "name": "execute", "input": { "x": 1 }, "status": "running" }));
        assert_eq!(ev[2].1, json!({ "id": "t2", "status": "error", "output": "boom", "images": ["data:image/png;base64,AA"] }));
        assert_eq!(ev.len(), 3); // the TodoWrite result is no card
        assert_eq!(res.unwrap_err().to_string(), "Limite de turnos atingido");
        assert_eq!(s.usage.take().unwrap(), json!({ "turns": 3 }));

        let init = json!({ "type": "system", "subtype": "init", "session_id": "S", "model": "m", "mcp_servers": [{ "name": "pena", "status": "failed" }] });
        let mut m = ClaudeMapper::default();
        assert_eq!(m.handle(&init, &mut s, &|_, _, _| {}).unwrap().as_deref(), Some("failed"));
    }

    #[test]
    fn permissions() {
        let (root, attach) = (Path::new("/w/proj"), Path::new("/h/.pena/attachments"));
        let extra = vec!["figma".to_string()];
        let ok = |n: &str, i: Value| claude_allows(n, &i, root, attach, &extra);
        assert!(ok("mcp__pena__execute", json!({})));
        assert!(ok("mcp__figma__get", json!({})));
        assert!(!ok("mcp__other__get", json!({})));
        assert!(ok("WebFetch", json!({})) && ok("TodoWrite", json!({})));
        assert_eq!(ok("Bash", json!({ "command": "ls" })), cfg!(target_os = "macos"));
        assert!(ok("Read", json!({ "file_path": "/w/proj/src/a.ts" })));
        assert!(ok("Read", json!({ "file_path": "/h/.pena/attachments/1-x.pdf" })));
        assert!(!ok("Read", json!({ "file_path": "/etc/hosts" })));
        assert!(ok("Edit", json!({ "file_path": "/w/proj/a.ts" })));
        assert!(!ok("Write", json!({ "file_path": "/w/proj/design.PEN" })));
        assert!(!ok("Edit", json!({ "file_path": "/h/.pena/attachments/a.ts" })));
        assert!(ok("NotebookEdit", json!({ "notebook_path": "/w/proj/n.ipynb" })));
        assert!(!ok("Glob", json!({})));
        assert!(deny_message(root).contains("the project at /w/proj (no secrets"));

        let permit: Permit = Arc::new(|n, i| if n == "Bash" { json!({ "behavior": "allow", "updatedInput": i }) } else { json!({ "behavior": "deny", "message": "no" }) });
        let req = json!({ "type": "control_request", "request_id": "r1", "request": { "subtype": "can_use_tool", "tool_name": "Glob", "input": {}, "tool_use_id": "tu" } });
        assert_eq!(
            answer(&req, Some(&permit)).unwrap(),
            json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "r1", "response": { "behavior": "deny", "message": "no", "toolUseID": "tu" } } })
        );
        let hook = json!({ "request_id": "r2", "request": { "subtype": "hook_callback" } });
        assert_eq!(answer(&hook, None).unwrap()["response"]["error"], "Unsupported control request subtype: hook_callback");
    }

    #[test]
    fn args_and_config() {
        let t = Turn {
            model: Some("default".into()),
            effort: Some("high".into()),
            file: "/w/proj/a.pen".into(),
            attach_dir: "/h/.pena/attachments".into(),
            pena: Mcp { command: "pena-mcp".into(), args: vec!["--stdio".into()], env: [("PENA_FILE".to_string(), "/w/proj/a.pen".to_string())].into() },
            extra_servers: json!({ "pena": { "url": "x" }, "figma": { "url": "https://f", "type": "sse", "headers": { "A": "b" } }, "local": { "command": "srv" } }),
            ..Default::default()
        };
        let s = Session { claude: Some("sess".into()), ..Default::default() };
        let a = claude_args(&t, &s, Path::new("/w/proj"));
        assert_eq!(&a[..7], ["--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--effort=high", "--permission-prompt-tool=stdio"]);
        assert!(a.contains(&"--resume=sess".into()));
        assert!(!a.iter().any(|x| x.starts_with("--model")));
        let i = a.iter().position(|x| x == "--mcp-config").unwrap();
        let cfg: Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(cfg["mcpServers"]["figma"], json!({ "type": "sse", "url": "https://f", "headers": { "A": "b" } }));
        assert_eq!(cfg["mcpServers"]["local"], json!({ "command": "srv", "args": [] }));
        assert_eq!(cfg["mcpServers"]["pena"], json!({ "command": "pena-mcp", "args": ["--stdio"], "env": { "PENA_FILE": "/w/proj/a.pen" } })); // ours wins
        assert!(a.contains(&"--add-dir=/w/proj".into()) && a.contains(&"--add-dir=/h/.pena/attachments".into()));
        let d = a.iter().find(|x| x.starts_with("--disallowedTools=")).unwrap();
        assert!(d.contains("Read(//**/.env),") && d.contains("Edit(//**/*.p12)") && d.contains("/.ssh/**)"));
        let sb = sandbox_settings(Path::new("/w/proj"), Path::new("/w/proj/a.pen"));
        assert_eq!(sb["sandbox"]["filesystem"]["denyWrite"][1], "/w/proj/**/.env");
        assert_eq!(sb["sandbox"]["filesystem"]["denyWrite"].as_array().unwrap().last().unwrap(), "/w/proj/a.pen");

        let msg = claude_user_message("hi", &["data:image/png;base64,AA".into(), "bad".into()], &["PDF".into()]);
        assert_eq!(msg["message"]["content"], json!([
            { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "AA" } },
            { "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": "PDF" } },
            { "type": "text", "text": "hi" },
        ]));
    }

    #[test]
    fn model_names() {
        let models: Value = serde_json::from_str(include_str!("../tests/fixtures/claude_text.jsonl").lines().next().unwrap()).unwrap();
        let names: Vec<String> = models["response"]["response"]["models"].as_array().unwrap().iter().map(claude_model_name).collect();
        assert_eq!(names[0], "Default (recommended) · Opus 5.5");
        assert_eq!(names[1], "Opus 5.5");
        assert_eq!(claude_model_name(&json!({ "value": "opus", "displayName": "Opus", "resolvedModel": "claude-opus-4-1-20250805" })), "Opus 4.1");
        assert_eq!(claude_model_name(&json!({ "value": "x", "displayName": "Custom" })), "Custom");
    }
}
