// Against the real CLIs on this machine (read-only: --version, auth/login status). `cargo test -- --ignored`
#[tokio::test]
#[ignore]
async fn provider_status_from_installed_clis() {
    let s = pena_state::settings::provider_status().await;
    println!("{}", serde_json::to_string_pretty(&s).unwrap());
    for id in ["claude", "codex", "opencode"] {
        assert!(s[id]["installed"].is_boolean());
    }
}
