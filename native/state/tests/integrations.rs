// Port of integrations.test.mjs: a client left pointing at a binary that no longer exists (the app moved or was
// updated) starts its sessions with no design tools, silently. repair_integrations() re-points it at this build and
// leaves valid ones alone. Runs in a throwaway HOME (and CODEX_HOME) so it never touches the real configs.
use pena_state::settings::{integrations, pena_launch, repair_integrations, test_mcp};
use serde_json::{Value, json};

#[tokio::test]
async fn repair_points_stale_clients_at_this_build() {
    let home = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pena-integrations-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("CODEX_HOME", home.join(".codex"));
        std::env::remove_var("PENA_ROOT");
    }

    let cfg = home.join(".config").join("opencode").join("opencode.json");
    let entry = || integrations().into_iter().find(|c| c["id"] == "opencode").unwrap();
    std::fs::create_dir_all(cfg.parent().unwrap()).unwrap();
    std::fs::write(&cfg, json!({ "mcp": { "servers": { "pena": { "type": "local", "command": ["/nope/pena-server", "mcp"] } } } }).to_string()).unwrap();

    assert_eq!(entry()["registered"], true);
    assert_eq!(repair_integrations().await, ["OpenCode"]);
    assert_eq!(entry()["current"], true, "the entry points at this build now");
    assert!(repair_integrations().await.is_empty(), "a working entry is left alone");

    let data: Value = serde_json::from_str(&std::fs::read_to_string(&cfg).unwrap()).unwrap();
    assert_eq!(data["mcp"]["servers"].as_object().unwrap().keys().collect::<Vec<_>>(), ["pena"]);
    // the native binary in `mcp` mode, as OpenCode's local-server shape
    let launch = pena_launch();
    assert_eq!(launch.args, ["mcp"]);
    assert_eq!(data["mcp"]["servers"]["pena"], json!({ "type": "local", "command": [launch.command, "mcp"] }));
    assert!(home.join(".config").join("opencode").join("opencode.json.pena-backup").exists());

    // test_mcp reports a server that can't start instead of failing
    let r = test_mcp(&json!({ "command": "/nope/missing-mcp-server" })).await;
    assert_eq!(r["ok"], false);
    assert!(r["error"].as_str().is_some_and(|e| !e.is_empty()));

    std::fs::remove_dir_all(&home).unwrap();
}
