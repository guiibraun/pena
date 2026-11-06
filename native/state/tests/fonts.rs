// fonts.rs from its cache (no network): ~/.pena/fonts/<sha1(family)>.css -> faces with /fonts/file/<base64url> urls.
use pena_state::fonts;
use serde_json::json;

#[tokio::test]
async fn faces_from_cached_css() {
    let home = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pena-fonts-{}", std::process::id()));
    let dir = home.join(".pena").join("fonts");
    std::fs::create_dir_all(&dir).unwrap();
    unsafe { std::env::set_var("HOME", &home) };
    let css = "@font-face {\n  font-family: 'Inter';\n  font-style: italic;\n  font-weight: 100 900;\n  src: url(https://fonts.gstatic.com/s/inter/v1/a.ttf) format('truetype');\n}\n@font-face {\n  font-family: 'Inter';\n  src: url(https://fonts.gstatic.com/s/inter/v1/b.ttf);\n}\n";
    std::fs::write(dir.join(format!("{}.css", sha1_hex("Inter"))), css).unwrap();
    let f = fonts::faces("Inter").await.unwrap();
    assert_eq!(
        f,
        [
            json!({ "weight": "100 900", "style": "italic", "url": "/fonts/file/aHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbS9zL2ludGVyL3YxL2EudHRm" }),
            json!({ "weight": "400", "style": "normal", "url": "/fonts/file/aHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbS9zL2ludGVyL3YxL2IudHRm" }),
        ]
    );
    // the file proxy only serves fonts.gstatic.com, from the cache when it's there
    std::fs::write(dir.join(format!("{}.ttf", sha1_hex("https://fonts.gstatic.com/s/inter/v1/a.ttf"))), b"TTF").unwrap();
    assert_eq!(fonts::file("aHR0cHM6Ly9mb250cy5nc3RhdGljLmNvbS9zL2ludGVyL3YxL2EudHRm").await.unwrap(), b"TTF");
    assert_eq!(fonts::file("aHR0cHM6Ly9ldmlsLmNvbS94LnR0Zg").await.unwrap_err().to_string(), "not a Google font");
    std::fs::write(dir.join("lato2-Lato-SemiboldItalic.ttf"), b"L").unwrap();
    assert_eq!(fonts::lato2(550.0, true).await.unwrap(), ("Lato-SemiboldItalic.ttf".to_string(), b"L".to_vec()));
    std::fs::remove_dir_all(&home).unwrap();
}

fn sha1_hex(s: &str) -> String {
    use sha1::Digest;
    hex::encode(sha1::Sha1::digest(s.as_bytes()))
}
