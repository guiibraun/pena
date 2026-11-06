//! Live turns against the installed CLIs. They spend the account's quota: ignored by default.
//! `CARGO_TARGET_DIR=target cargo test --test live -- --ignored --nocapture --test-threads=1`

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use pena_agents::*;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn which(bin: &str) -> PathBuf {
    let out = std::process::Command::new("which").arg(bin).output().unwrap();
    PathBuf::from(String::from_utf8_lossy(&out.stdout).trim())
}

/// A throwaway project in the temp folder (outside any git repo, so the agent's project root is just this folder):
/// the .pen, the attachments folder, and Pena's real MCP server (bun mcp.mjs).
fn turn(name: &str) -> Turn {
    let dir = std::env::temp_dir().join("pena-agents-live").join(name);
    std::fs::create_dir_all(dir.join("attachments")).unwrap();
    let file = dir.join("a.pen");
    std::fs::write(&file, r#"{"version":"2.6","children":[]}"#).unwrap();
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().unwrap();
    Turn {
        prompt: "Reply with the word ok and nothing else. Do not call any tool.".into(),
        file: file.clone(),
        attach_dir: dir.join("attachments"),
        system: "Reply tersely.".into(),
        pena: Mcp {
            command: which("bun").to_string_lossy().into(),
            args: vec![repo.join("mcp.mjs").to_string_lossy().into()],
            env: [("PENA_FILE".to_string(), file.to_string_lossy().into_owned()), ("PENA_AGENT".to_string(), "Phantom".to_string())].into(),
        },
        extra_servers: json!({}),
        claude_bin: which("claude"),
        codex_bin: which("codex"),
        opencode_bin: which("opencode"),
        ..Default::default()
    }
}

async fn go(provider: &str, t: Turn) -> (Session, Vec<(String, Value)>, anyhow::Result<()>) {
    let ev = Mutex::new(vec![]);
    let say = |k: &str, d: Value, _: Option<String>| ev.lock().unwrap().push((k.to_string(), d));
    let mut s = Session::default();
    let r = match provider {
        "claude" => run_claude(&t, &mut s, CancellationToken::new(), &say).await,
        "codex" => run_codex(&t, &mut s, CancellationToken::new(), &say).await,
        _ => run_opencode(&t, &mut s, CancellationToken::new(), &say).await,
    };
    let ev = ev.into_inner().unwrap();
    for e in &ev {
        println!("{} {}", e.0, e.1);
    }
    println!("result: {r:?}\nsession: {}", serde_json::to_string(&s).unwrap());
    (s, ev, r)
}

#[tokio::test]
#[ignore]
async fn live_claude() {
    let t = Turn { model: Some("haiku".into()), ..turn("claude") };
    let (s, ev, r) = go("claude", t).await;
    r.unwrap();
    assert!(native_session("claude", &s).is_some());
    assert!(ev.iter().any(|e| e.0 == "text" && e.1["done"] == true && e.1["text"].as_str().unwrap().to_lowercase().contains("ok")));
    assert!(s.usage.unwrap()["output"].as_u64().unwrap() > 0);
}

/// Pena's own MCP server through --mcp-config, a can_use_tool answer, and a refused tool.
#[tokio::test]
#[ignore]
async fn live_claude_tools() {
    let prompt = "First call the get_app_state tool of the pena MCP server. Then try to read /etc/hosts with the Read tool. Then reply ok.";
    let t = Turn { model: Some("haiku".into()), prompt: prompt.into(), ..turn("claude-tools") };
    let (_, ev, r) = go("claude", t).await;
    r.unwrap();
    // results carry only the card id
    let id = &ev.iter().find(|e| e.0 == "tool" && e.1["name"] == "get_app_state").unwrap().1["id"];
    assert!(ev.iter().any(|e| e.0 == "tool" && &e.1["id"] == id && e.1["status"] == "done"));
    assert!(ev.iter().any(|e| e.0 == "tool" && e.1["status"] == "error" && e.1["output"].as_str().unwrap_or("").contains("Only the pena design tools")));
}

#[tokio::test]
#[ignore]
async fn live_claude_cancel() {
    let t = Turn { model: Some("haiku".into()), prompt: "Count slowly from 1 to 200, one number per line.".into(), ..turn("claude-cancel") };
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        c.cancel();
    });
    let mut s = Session::default();
    let t0 = std::time::Instant::now();
    let r = run_claude(&t, &mut s, cancel, &|_, _, _| {}).await;
    println!("{r:?} after {:?}", t0.elapsed());
    assert!(r.is_err() && t0.elapsed().as_secs() < 15);
}

#[tokio::test]
#[ignore]
async fn live_claude_models() {
    let models = list_claude_models(&which("claude"), &Default::default()).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&models).unwrap());
    assert!(models.iter().any(|m| m["id"] == "default"));
}

#[tokio::test]
#[ignore]
async fn live_codex() {
    let t = Turn { effort: Some("low".into()), global_codex_servers: global_codex(), ..turn("codex") };
    let (s, ev, r) = go("codex", t).await;
    r.unwrap();
    assert!(native_session("codex", &s).is_some());
    assert!(ev.iter().any(|e| e.0 == "text" && e.1["done"] == true));
}

/// settings.globalCodexServers, read-only, so the live turn runs with your config.toml's servers off.
fn global_codex() -> Vec<String> {
    let toml = std::fs::read_to_string(Path::new(&std::env::var("HOME").unwrap()).join(".codex/config.toml")).unwrap_or_default();
    toml.lines()
        .filter_map(|l| l.trim_end().strip_prefix("[mcp_servers.")?.strip_suffix(']').map(|n| n.trim_matches('"').to_string()))
        .filter(|n| !n.contains('.'))
        .collect()
}

#[tokio::test]
#[ignore]
async fn live_opencode() {
    let (s, ev, r) = go("opencode", turn("opencode")).await;
    r.unwrap();
    assert!(native_session("opencode", &s).is_some());
    assert!(ev.iter().any(|e| e.0 == "text"));
}

#[tokio::test]
#[ignore]
async fn live_opencode_models() {
    let models = list_opencode_models(&which("opencode")).await.unwrap();
    println!("{} models", models.len());
    assert!(!models.is_empty());
}
