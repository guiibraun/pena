//! OpenCode (v2): one `opencode run --standalone --format json` per turn, resumed by session id. --standalone runs a
//! private server, so the config in OPENCODE_CONFIG_CONTENT (merged over yours, your files untouched) applies; the
//! background service would ignore it. Pena's MCP server, your global MCP servers off, and every other tool on "ask",
//! which `opencode run` rejects by itself. Not "deny" for all: that drops the tools from the request, and OpenCode
//! Zen's free models refuse requests without its own tools. Since OpenCode 2.1 an MCP server with codemode off never
//! reaches the model, so Pena's tools live in CodeMode's catalog (tools.pena.*, called from its `execute` tool), and a
//! bare { disabled: true } is skipped as malformed: it needs a type and command to apply.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::*;

/// OpenCode's answer when the session never had the tool (it is not in that session's catalog).
static NO_TOOL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)no tool named|is currently available|not available").unwrap());

const CODE_HINT: &str = "\n\nIn this session the pena tools are in the catalog of your `execute` (code) tool: call them from code as `await tools.pena.get_app_state()`, `await tools.pena.execute({ description, input })`, `tools.pena.read_skill(...)`. They connect a moment after the turn starts: if the first call says \"Unknown tool\", make the same call again.";

// --- catalog -------------------------------------------------------------------------------

/// `opencode api model.list` returns every model of the providers you logged into. Variants are its reasoning
/// levels. Only models that can call tools can design. Caching is the caller's.
pub async fn list_opencode_models(bin: &Path) -> Result<Vec<Value>> {
    let run = Command::new(bin).args(["api", "model.list"]).stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(60), run).await.map_err(|_| anyhow!("Command failed: {} api model.list (timed out)", bin.display()))??;
    if !out.status.success() {
        bail!("Command failed: {} api model.list\n{}", bin.display(), String::from_utf8_lossy(&out.stderr).trim());
    }
    Ok(parse_models(&serde_json::from_slice(&out.stdout)?))
}

pub(crate) fn parse_models(v: &Value) -> Vec<Value> {
    v["data"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter(|m| truthy(&m["capabilities"]["tools"]) && m["enabled"] != false && m["status"] != "deprecated")
        .map(|m| {
            let efforts: Vec<Value> = m["variants"].as_array().cloned().unwrap_or_default().iter().map(|v| v["id"].clone()).collect();
            json!({ "id": format!("{}/{}", str_of(&m["providerID"]), str_of(&m["id"])), "name": format!("{} · {}", str_of(&m["name"]), str_of(&m["providerID"])), "efforts": efforts })
        })
        .collect()
}

// --- config --------------------------------------------------------------------------------

fn server(c: &Value) -> Value {
    if truthy(&c["url"]) {
        let mut v = json!({ "type": "remote", "url": c["url"] });
        if truthy(&c["headers"]) {
            v["headers"] = c["headers"].clone();
        }
        v
    } else {
        let mut cmd = vec![c["command"].clone()];
        cmd.extend(c["args"].as_array().cloned().unwrap_or_default());
        let mut v = json!({ "type": "local", "command": cmd });
        if truthy(&c["env"]) {
            v["environment"] = c["env"].clone();
        }
        v
    }
}

fn rule(action: &str, resource: &str, effect: &str) -> Value {
    json!({ "action": action, "resource": resource, "effect": effect })
}

pub(crate) fn opencode_config(t: &Turn) -> Value {
    let extra = extra_entries(&t.extra_servers);
    let mut servers = Map::new();
    for n in &t.global_opencode_servers {
        servers.insert(n.clone(), json!({ "type": "local", "command": ["true"], "disabled": true }));
    }
    for (n, c) in &extra {
        servers.insert(n.clone(), server(c));
    }
    let mut pena = server(&pena_json(&t.pena));
    pena["timeout"] = json!({ "catalog": 30000, "execution": 300000 });
    servers.insert("pena".into(), pena);

    // last matching rule wins
    let mut rules = vec![rule("*", "*", "ask")];
    let allowed = ["pena_*".to_string()].into_iter().chain(extra.iter().map(|(n, _)| format!("{n}_*"))).chain(["webfetch", "websearch", "todowrite"].map(String::from));
    rules.extend(allowed.map(|a| rule(&a, "*", "allow")));
    // the project's files. shell stays off (unsandboxed) and grep too: its rules match the search pattern, not the
    // files, so it would print .env contents. Searching is glob + read (which also lists folders).
    rules.extend([rule("read", "*", "allow"), rule("glob", "*", "allow"), rule("grep", "*", "deny"), rule("edit", "*", "allow"), rule("edit", "*.pen", "deny")]);
    rules.push(rule("external_directory", &format!("{}/*", t.attach_dir.display()), "allow")); // the project itself is the workspace (cwd), not external
    let home = home_secrets();
    for a in ["read", "edit"] {
        for p in SECRETS {
            rules.push(rule(a, &if p.starts_with('*') { p.to_string() } else { format!("*{p}") }, "deny"));
        }
        for d in &home {
            rules.push(rule(a, d, "deny"));
            rules.push(rule(a, &format!("{d}/*"), "deny"));
        }
    }
    rules.extend(home.iter().map(|d| rule("external_directory", &format!("{d}/*"), "deny")));
    json!({ "mcp": { "servers": servers }, "permissions": rules })
}

/// The turn's prompt: SYSTEM on a new session, the group change otherwise, and where the pena tools are.
pub(crate) fn opencode_prompt(t: &Turn, s: &mut Session) -> String {
    let mut prompt = t.prompt.clone();
    if s.opencode.is_none() {
        prompt = format!("{}\n\n---\n\n{prompt}", t.system); // first turn only; opencode keeps the session
        s.group = Some(t.group_key.clone());
    }
    if s.group.as_deref() != Some(&t.group_key) {
        prompt = format!("{}\n\n---\n\n{prompt}", t.group_sync);
        s.group = Some(t.group_key.clone());
    }
    prompt + CODE_HINT
}

pub(crate) fn opencode_args(t: &Turn, s: &Session, prompt: &str, files: &[PathBuf]) -> Vec<String> {
    let mut a: Vec<String> = ["run", "--standalone", "--format", "json", "--thinking"].map(String::from).to_vec();
    if let Some(id) = &s.opencode {
        a.extend(["-s".into(), id.clone()]);
    }
    if let Some(m) = t.model.as_deref().filter(|m| !m.is_empty()) {
        let m = match t.effort.as_deref().filter(|e| !e.is_empty()) {
            Some(e) => format!("{m}#{e}"), // provider/model#variant
            None => m.into(),
        };
        a.extend(["-m".into(), m]);
    }
    for f in files {
        a.extend(["-f".into(), f.to_string_lossy().into_owned()]);
    }
    a.extend(["--".into(), prompt.into()]);
    a
}

/// One turn's running state: usage summed over steps, and the first failure.
pub(crate) struct OpencodeRun {
    pub usage: Value,
    pub failure: Option<String>,
    /// the NO_TOOL case: stop the CLI now
    pub kill: bool,
}

impl OpencodeRun {
    pub(crate) fn new() -> Self {
        OpencodeRun { usage: json!({ "costUsd": 0, "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "turns": 0 }), failure: None, kill: false }
    }

    fn add(&mut self, k: &str, v: &Value) {
        let sum = self.usage[k].as_f64().unwrap_or(0.0) + v.as_f64().unwrap_or(0.0);
        self.usage[k] = if sum.fract() == 0.0 && sum.abs() < 9e15 { json!(sum as i64) } else { json!(sum) };
    }

    /// One `--format json` line → say() events.
    pub(crate) fn event(&mut self, e: &Value, s: &mut Session, say: Say) {
        if let Some(id) = e["sessionID"].as_str().filter(|x| !x.is_empty()) {
            s.opencode = Some(id.into());
        }
        let p = &e["part"];
        let st = &p["state"];
        match e["type"].as_str().unwrap_or("") {
            "text" => say("text", obj([("id", some(&p["id"])), ("text", some(&p["text"])), ("done", Some(json!(true)))]), None),
            "reasoning" => say("thinking", obj([("id", some(&p["id"])), ("text", some(&p["text"])), ("done", Some(json!(true)))]), None),
            "tool_use" if p["tool"] == "todowrite" => {
                let items: Vec<Value> = st["input"]["todos"].as_array().cloned().unwrap_or_default().iter().map(|t| obj([("text", some(&t["content"])), ("status", some(&t["status"]))])).collect();
                say("todos", json!({ "items": items }), None);
            }
            "tool_use" => {
                let tool = str_of(&p["tool"]);
                let err = if st["status"] == "error" { str_of(if st["error"]["message"].is_null() { &st["error"] } else { &st["error"]["message"] }) } else { String::new() };
                // A session created while the design-tool server was down keeps that tool list forever: every call
                // comes back "No tool named pena_execute". Fail the turn here so runTurn retries it on a fresh session.
                if self.failure.is_none() && NO_TOOL.is_match(&err) && format!("{tool} {err}").to_lowercase().contains("pena") {
                    self.failure = Some(format!("As ferramentas de design não conectaram nesta sessão ({})", head(&err, 160)));
                    self.kill = true;
                }
                // CodeMode's execute runs a script that calls the MCP tools: name the card after the one pena tool it calls
                let script = (tool == "execute").then(|| st["input"]["code"].as_str()).flatten();
                let name = match script {
                    Some(code) => {
                        static CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"tools\.pena\.(\w+)").unwrap());
                        let mut called: Vec<&str> = vec![];
                        for c in CALL.captures_iter(code) {
                            let n = c.get(1).unwrap().as_str();
                            if !called.contains(&n) {
                                called.push(n);
                            }
                        }
                        if called.len() == 1 { called[0].to_string() } else { "code".into() }
                    }
                    None => tool.strip_prefix("pena_").unwrap_or(&tool).to_string(),
                };
                let input = match script {
                    Some(code) => Some(json!({ "input": code })),
                    None => some(&st["input"]),
                };
                let status = match st["status"].as_str() {
                    Some("error") => "error",
                    Some("completed") => "done",
                    _ => "running",
                };
                let output = head(&str_of(if st["output"].is_null() { &st["error"] } else { &st["output"] }), 4000);
                // OpenCode 2.2 names the call `id` (older: `callID`)
                let id = some(&p["callID"]).or_else(|| some(&p["id"]));
                say("tool", obj([("id", id), ("name", Some(json!(name))), ("input", input), ("status", Some(json!(status))), ("output", Some(json!(output)))]), None);
            }
            "step_finish" => {
                let t = &p["tokens"];
                self.add("costUsd", &p["cost"]);
                self.add("input", &t["input"]);
                let out = t["output"].as_f64().unwrap_or(0.0) + t["reasoning"].as_f64().unwrap_or(0.0);
                self.add("output", &json!(out));
                self.add("cacheRead", &t["cache"]["read"]);
                self.add("cacheWrite", &t["cache"]["write"]);
                self.add("turns", &json!(1));
                s.usage = Some(self.usage.clone());
            }
            "error" if self.failure.is_none() => {
                let er = &e["error"];
                let msg = er["data"]["message"].as_str().or(er["name"].as_str()).unwrap_or("OpenCode falhou");
                self.failure = Some(msg.into());
            }
            _ => {}
        }
    }
}

pub async fn run_opencode(t: &Turn, s: &mut Session, cancel: CancellationToken, say: Say<'_>) -> Result<()> {
    let config = opencode_config(t);
    let prompt = opencode_prompt(t, s);
    let files = image_files(&t.images)?;
    let args = opencode_args(t, s, &prompt, &files);
    // opencode takes its workspace from PWD, not the process cwd; real path, or symlinked files look external
    let dir = std::fs::canonicalize(parent_dir(&t.file))?;
    let mut child = Command::new(&t.opencode_bin)
        .args(&args)
        .current_dir(&dir)
        .env("PWD", &dir)
        .env("OPENCODE_CONFIG_CONTENT", config.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut err = child.stderr.take().unwrap();
    let stderr = tokio::spawn(async move {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b).await;
        tail(&String::from_utf8_lossy(&b), 4000)
    });
    say("model", json!({ "model": t.model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| "opencode".into()) }), None);
    let mut run = OpencodeRun::new();
    s.usage = Some(run.usage.clone());
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    loop {
        let line = tokio::select! {
            l = lines.next_line() => l?,
            _ = cancel.cancelled() => { let _ = child.kill().await; bail!("The operation was aborted"); }
        };
        let Some(line) = line else { break };
        let Ok(e) = serde_json::from_str::<Value>(&line) else { continue };
        run.event(&e, s, say);
        if std::mem::take(&mut run.kill) {
            let _ = child.start_kill();
        }
    }
    let status = child.wait().await?;
    if let Some(f) = run.failure {
        bail!("{f}");
    }
    if let Some(code) = status.code().filter(|c| *c != 0) {
        let err = stderr.await.unwrap_or_default();
        let last = err.trim().split('\n').next_back().unwrap_or("").to_string();
        bail!("{}", if last.is_empty() { format!("opencode saiu com código {code}") } else { last });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn maps_a_recorded_run() {
        let ev = Mutex::new(vec![]);
        let say = |k: &str, d: Value, key: Option<String>| ev.lock().unwrap().push((k.to_string(), d, key));
        let mut s = Session::default();
        let mut run = OpencodeRun::new();
        for l in include_str!("../tests/fixtures/opencode_tools.jsonl").lines() {
            run.event(&serde_json::from_str(l).unwrap(), &mut s, &say);
        }
        assert!(run.failure.is_none());
        assert_eq!(s.opencode.as_deref(), Some("ses_e4f78fe20ffeyQ9JC23Y7C0bSE"));
        let ev = ev.into_inner().unwrap();
        assert_eq!(ev[1], ("tool".into(), json!({ "id": "chatcmpl-tool-972a6ccdfde74366", "name": "read", "input": { "path": "hello.txt" }, "status": "error", "output": "File not found: hello.txt" }), None));
        // CodeMode scripts are named after the pena tool they call, else "code"
        assert!(ev.iter().any(|e| e.1["name"] == "code" && e.1["input"] == json!({ "input": "return \"ping\";" }) && e.1["status"] == "done"));
        assert!(ev.iter().any(|e| e.0 == "thinking" && e.1["done"] == true));
        let last = ev.last().unwrap();
        assert_eq!(last.0, "text");
        assert!(last.1["text"].as_str().unwrap().starts_with("ok"));
        let u = s.usage.unwrap();
        assert_eq!(u["turns"], 11);
        assert_eq!(u["input"], 30089 + 2684 + 305 + 245 + 403 + 254 + 651 + 515 + 1525 + 775 + 1019);
        assert_eq!(u["cacheRead"], 3072 + 33088 + 35648 + 35840 + 35968 + 36288 + 36416 + 36992 + 37440 + 38848 + 39552);
        assert_eq!(u["costUsd"], 0);
    }

    #[test]
    fn no_tool_and_errors() {
        let mut s = Session::default();
        let mut run = OpencodeRun::new();
        let ev = Mutex::new(vec![]);
        let say = |_: &str, d: Value, _: Option<String>| ev.lock().unwrap().push(d);
        let call = json!({ "type": "tool_use", "sessionID": "S", "part": { "callID": "c1", "tool": "pena_execute", "state": { "status": "error", "input": {}, "error": "No tool named pena_execute" } } });
        run.event(&call, &mut s, &say);
        assert!(run.kill);
        assert_eq!(run.failure.as_deref(), Some("As ferramentas de design não conectaram nesta sessão (No tool named pena_execute)"));
        assert_eq!(ev.lock().unwrap()[0], json!({ "id": "c1", "name": "execute", "input": {}, "status": "error", "output": "No tool named pena_execute" }));
        let mut run = OpencodeRun::new();
        run.event(&json!({ "type": "error", "error": { "name": "APIError", "data": { "message": "quota" } } }), &mut s, &say);
        run.event(&json!({ "type": "error", "error": { "name": "Other" } }), &mut s, &say);
        assert_eq!(run.failure.as_deref(), Some("quota"));
        let script = json!({ "type": "tool_use", "part": { "id": "c2", "tool": "execute", "state": { "status": "completed", "input": { "code": "await tools.pena.execute({}); await tools.pena.execute({})" }, "output": "done" } } });
        run.event(&script, &mut s, &say);
        assert_eq!(ev.lock().unwrap().last().unwrap()["name"], "execute");
    }

    #[test]
    fn config_prompt_and_args() {
        let t = Turn {
            prompt: "go".into(),
            model: Some("opencode/big".into()),
            effort: Some("high".into()),
            system: "SYS".into(),
            group_key: "g".into(),
            group_sync: "SYNC".into(),
            attach_dir: "/h/.pena/attachments".into(),
            pena: Mcp { command: "pena".into(), args: vec!["mcp".into()], env: [("A".to_string(), "1".to_string())].into() },
            extra_servers: json!({ "figma": { "url": "https://f" } }),
            global_opencode_servers: vec!["old".into()],
            ..Default::default()
        };
        let c = opencode_config(&t);
        assert_eq!(c["mcp"]["servers"]["old"], json!({ "type": "local", "command": ["true"], "disabled": true }));
        assert_eq!(c["mcp"]["servers"]["figma"], json!({ "type": "remote", "url": "https://f" }));
        assert_eq!(c["mcp"]["servers"]["pena"], json!({ "type": "local", "command": ["pena", "mcp"], "environment": { "A": "1" }, "timeout": { "catalog": 30000, "execution": 300000 } }));
        let r = c["permissions"].as_array().unwrap();
        assert_eq!(r[0], rule("*", "*", "ask"));
        assert_eq!(r[1], rule("pena_*", "*", "allow"));
        assert_eq!(r[2], rule("figma_*", "*", "allow"));
        assert!(r.contains(&rule("grep", "*", "deny")) && r.contains(&rule("edit", "*.pen", "deny")));
        assert!(r.contains(&rule("external_directory", "/h/.pena/attachments/*", "allow")));
        assert!(r.contains(&rule("read", "*.env", "deny")) && r.contains(&rule("edit", "*.env.*", "deny")) && r.contains(&rule("read", "*.key", "deny")));

        let mut s = Session::default();
        let p = opencode_prompt(&t, &mut s);
        assert!(p.starts_with("SYS\n\n---\n\ngo\n\nIn this session the pena tools"));
        assert_eq!(opencode_args(&t, &s, "P", &["/tmp/a.png".into()]), ["run", "--standalone", "--format", "json", "--thinking", "-m", "opencode/big#high", "-f", "/tmp/a.png", "--", "P"]);
        s.opencode = Some("ses".into());
        let t2 = Turn { group_key: "".into(), ..t.clone() };
        assert!(opencode_prompt(&t2, &mut s).starts_with("SYNC\n\n---\n\ngo\n\n"));
        assert_eq!(&opencode_args(&t2, &s, "P", &[])[5..7], ["-s", "ses"]);
    }

    #[test]
    fn catalog() {
        let v = json!({ "data": [
            { "id": "a", "providerID": "p", "name": "A", "capabilities": { "tools": true }, "variants": [{ "id": "high" }] },
            { "id": "b", "providerID": "p", "name": "B", "capabilities": { "tools": false } },
            { "id": "c", "providerID": "p", "name": "C", "capabilities": { "tools": true }, "status": "deprecated" },
            { "id": "d", "providerID": "p", "name": "D", "capabilities": { "tools": true }, "enabled": false },
        ] });
        assert_eq!(parse_models(&v), vec![json!({ "id": "p/a", "name": "A · p", "efforts": ["high"] })]);
    }
}
