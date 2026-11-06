// library.rs and skills.rs against a throwaway HOME: the files they write keep the Bun server's formats.
use pena_state::{library, skills};
use serde_json::json;

#[test]
fn library_and_skills() {
    let home = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pena-library-{}", std::process::id()));
    std::fs::create_dir_all(home.join("Documents").join("Sub")).unwrap();
    unsafe { std::env::set_var("HOME", &home) };
    let s = |p: &std::path::Path| p.to_string_lossy().into_owned();

    // recents: JSON.stringify(list, null, 1), newest first, only existing .pen files outside the drafts
    let a = home.join("Documents").join("a.pen");
    std::fs::write(&a, "{}").unwrap();
    library::record_opened(&s(&a)).unwrap();
    library::record_opened("/nope/gone.pen").unwrap();
    let saved = std::fs::read_to_string(home.join(".pena").join("recent.json")).unwrap();
    assert!(saved.starts_with("[\n {\n  \"path\": \"/nope/gone.pen\",\n  \"openedAt\": "), "{saved}");
    let r = library::recents();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0]["name"], "a.pen");
    assert_eq!(r[0]["folder"], "Documents");
    assert_eq!(r[0]["source"], "pena");
    assert_eq!(r[0]["hasPreview"], false);
    library::forget(&s(&a)).unwrap();
    assert!(library::recents().is_empty());

    // previews: sha256(path)[0..32].png for files, the folder uuid for drafts
    library::save_preview(&s(&a), b"png").unwrap();
    let pid = &sha_hex(&s(&a))[..32];
    assert_eq!(library::preview_file(&s(&a)), Some(home.join(".pena").join("previews").join(format!("{pid}.png"))));
    let d = library::new_draft().unwrap();
    std::fs::write(&d, "{}").unwrap();
    library::save_preview(&s(&d), b"png").unwrap();
    let uuid = d.parent().unwrap().file_name().unwrap().to_string_lossy().into_owned();
    assert!(home.join(".pena").join("previews").join(format!("{uuid}.png")).exists());
    let drafts = library::drafts();
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0]["folder"], "Rascunho");
    assert_eq!(drafts[0]["hasPreview"], true);

    // browse: folders first, then .pen files; dotfiles and other files hidden
    std::fs::write(home.join("Documents").join("notes.txt"), "").unwrap();
    std::fs::write(home.join("Documents").join(".hidden.pen"), "").unwrap();
    let b = library::browse(None).unwrap();
    assert_eq!(b["dir"], json!(s(&home.join("Documents"))));
    assert_eq!(b["parent"], json!(s(&home)));
    let names: Vec<_> = b["entries"].as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap(), e["kind"].as_str().unwrap())).collect();
    assert_eq!(names, [("Sub", "dir"), ("a.pen", "pen")]);
    assert_eq!(library::browse(Some(&format!("{}/Sub/..", s(&home.join("Documents"))))).unwrap()["dir"], b["dir"]);

    // skills: ~/.pena/skills/<name>/SKILL.md with front matter; added paths are kept in config.json
    let sk = home.join(".pena").join("skills").join("brand");
    std::fs::create_dir_all(&sk).unwrap();
    std::fs::write(sk.join("SKILL.md"), "---\nname: Brand\ndescription: Our colors\n---\n# Body").unwrap();
    let extra = home.join("extra");
    std::fs::create_dir_all(&extra).unwrap();
    std::fs::write(extra.join("SKILL.md"), "# Extra things\nmore").unwrap();
    assert_eq!(skills::add_skill("~/extra").unwrap(), json!({ "name": "extra", "description": "Extra things", "source": "Adicionada", "path": s(&extra.join("SKILL.md")) }));
    assert_eq!(skills::add_skill("~/nope").unwrap_err().to_string(), "O caminho escolhido não tem um SKILL.md");
    let list = skills::list_skills();
    let mine: Vec<_> = list.iter().filter(|x| x["source"] != "Pena · guia").map(|x| (x["name"].as_str().unwrap(), x["source"].as_str().unwrap())).collect();
    assert_eq!(mine, [("Brand", "Pena"), ("extra", "Adicionada")]);
    assert_eq!(skills::skill_content("Brand", None).unwrap()["content"], "---\nname: Brand\ndescription: Our colors\n---\n# Body");
    assert_eq!(skills::skill_content("Nada", None).unwrap_err().to_string(), "Skill não encontrada: Nada");
    let cfg = std::fs::read_to_string(home.join(".pena").join("config.json")).unwrap();
    assert_eq!(cfg, format!("{{\n  \"customSkills\": [\n    \"{}\"\n  ]\n}}", s(&extra.join("SKILL.md"))));
    skills::remove_skill(&s(&extra.join("SKILL.md"))).unwrap();
    assert!(skills::list_skills().iter().all(|x| x["source"] != "Adicionada"));

    std::fs::remove_dir_all(&home).unwrap();
}

fn sha_hex(s: &str) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(s.as_bytes()))
}
