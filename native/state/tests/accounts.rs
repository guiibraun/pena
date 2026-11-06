// Port of accounts.test.mjs: an extra login of a provider gets its own CLI config dir (env var), the defaults keep the
// CLI's own login, and the default account can't be removed. Runs in a throwaway HOME so it never touches ~/.pena.
use pena_state::settings::{accounts, add_account, remove_account};
use serde_json::json;

#[test]
fn accounts_per_provider() {
    let home = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pena-accounts-{}", std::process::id()));
    std::fs::create_dir_all(&home).unwrap();
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("USERPROFILE", &home);
    }
    let ids = || accounts().iter().map(|a| a["id"].as_str().unwrap().to_string()).collect::<Vec<_>>().join(" ");
    assert_eq!(ids(), "claude codex opencode");
    assert_eq!(accounts().iter().map(|a| a["env"].clone()).collect::<Vec<_>>(), [json!({}), json!({}), json!({})]);

    let work = add_account("claude", Some("Trabalho")).unwrap();
    assert_eq!(work["id"], "claude-2");
    let dir = home.join(".pena").join("accounts").join("claude-2");
    assert_eq!(work["env"]["CLAUDE_CONFIG_DIR"], json!(dir.to_string_lossy()));
    assert!(dir.exists());

    let personal = add_account("codex", Some("Pessoal")).unwrap();
    assert_eq!(personal["id"], "codex-2");
    assert_eq!(personal["env"]["CODEX_HOME"], json!(home.join(".pena").join("accounts").join("codex-2").to_string_lossy()));
    assert_eq!(add_account("claude", Some("")).unwrap()["id"], "claude-3");
    assert_eq!(accounts().iter().find(|a| a["id"] == "claude-3").unwrap()["name"], "Conta 3");

    assert_eq!(add_account("opencode", Some("x")).unwrap_err().to_string(), "OpenCode usa um único login do CLI");
    assert_eq!(remove_account("claude").unwrap_err().to_string(), "A conta padrão não pode ser removida");
    remove_account("claude-2").unwrap();
    assert_eq!(ids(), "claude codex opencode codex-2 claude-3");

    // same file the Bun server reads: a pretty-printed array of { id, provider, name }
    let saved = std::fs::read_to_string(home.join(".pena").join("accounts.json")).unwrap();
    assert!(saved.starts_with("[\n  {\n    \"id\": \"codex-2\",\n    \"provider\": \"codex\",\n    \"name\": \"Pessoal\"\n  },"), "{saved}");

    std::fs::remove_dir_all(&home).unwrap();
}
