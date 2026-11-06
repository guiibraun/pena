//! Skills you can attach to a message with "/" (like pen.dev's skill picker). A skill is a folder with a SKILL.md
//! whose frontmatter has `name` and `description`; the chosen skill's content rides along with the message.
//! Sources: Pena's own guides, ~/.pena/skills, your Claude Code skills, skills pen.dev installed on this Mac
//! (read-only), plus any SKILL.md you add by path (~/.pena/config.json customSkills).

use crate::{home, js_str, nn, path_str, read_dir_sorted};
use anyhow::{Result, anyhow, bail};
use regex::Regex;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

fn config_file() -> PathBuf {
    home().join(".pena").join("config.json")
}
fn sources() -> [(&'static str, PathBuf); 3] {
    let h = home();
    [("Pena", h.join(".pena").join("skills")), ("Claude Code", h.join(".claude").join("skills")), ("pen.dev", h.join(".pencil").join("skills"))]
}

fn config() -> Map<String, Value> {
    std::fs::read_to_string(config_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}
fn save_config(c: Map<String, Value>) -> Result<()> {
    std::fs::create_dir_all(config_file().parent().unwrap())?;
    std::fs::write(config_file(), crate::pretty(&Value::Object(c), b"  "))?;
    Ok(())
}
fn custom_skills(c: &Map<String, Value>) -> Vec<String> {
    c.get("customSkills").and_then(Value::as_array).map(|a| a.iter().map(|x| js_str(Some(x))).collect()).unwrap_or_default()
}

fn frontmatter(content: &str) -> Value {
    static FM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A---\r?\n((?s:.*?))\r?\n---").unwrap());
    let Some(m) = FM.captures(content) else { return json!({}) };
    serde_yaml::from_str::<serde_yaml::Value>(&m[1]).ok().and_then(|y| serde_json::to_value(y).ok()).filter(|v| !v.is_null()).unwrap_or_else(|| json!({}))
}
fn first_line(content: &str) -> String {
    static FM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\A---(?s:.*?)---").unwrap());
    static HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^#+\s*").unwrap());
    FM.replace(content, "").split('\n').map(|l| HASH.replace(l, "").trim().to_string()).find(|l| !l.is_empty()).unwrap_or_default()
}

fn read(file: &Path, source: &str, fallback_name: &str) -> Option<Value> {
    let content = std::fs::read_to_string(file).ok()?;
    let fm = frontmatter(&content);
    let name = nn(fm.get("name")).map(|v| js_str(Some(v))).unwrap_or_else(|| fallback_name.to_string());
    let description = nn(fm.get("description")).map(|v| js_str(Some(v))).unwrap_or_else(|| first_line(&content));
    Some(json!({ "name": name, "description": description.trim(), "source": source, "path": path_str(file) }))
}

/// -> [{ name, description, source, path }]
pub fn list_skills() -> Vec<Value> {
    let mut out = Vec::new();
    // Pena's built-in design guides (also readable by the agent through read_skill)
    let guides = crate::root().join("skills").join("pena").join("guide");
    for f in read_dir_sorted(&guides).unwrap_or_default() {
        let n = f.file_name().to_string_lossy().into_owned();
        if let Some(stem) = n.strip_suffix(".md") {
            out.push(read(&f.path(), "Pena · guia", stem));
        }
    }
    for (label, dir) in sources() {
        for d in read_dir_sorted(&dir).unwrap_or_default() {
            let n = d.file_name().to_string_lossy().into_owned();
            let t = d.file_type().ok();
            if t.is_some_and(|t| t.is_dir() || t.is_symlink()) && !n.starts_with('.') {
                out.push(read(&d.path().join("SKILL.md"), label, &n));
            }
        }
    }
    for p in custom_skills(&config()) {
        let p = PathBuf::from(p);
        let fallback = p.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        out.push(read(&p, "Adicionada", &fallback));
    }
    let mut seen = std::collections::HashSet::new();
    out.into_iter().flatten().filter(|s| seen.insert(format!("{}:{}", js_str(s.get("source")), js_str(s.get("name"))))).collect()
}

/// The skill plus its file's `content`.
pub fn skill_content(name: &str, source: Option<&str>) -> Result<Value> {
    let all = list_skills();
    let named = |s: &&Value| s.get("name").and_then(Value::as_str) == Some(name);
    let source = source.filter(|s| !s.is_empty());
    let s = all
        .iter()
        .filter(named)
        .find(|s| source.is_none() || s.get("source").and_then(Value::as_str) == source)
        .or_else(|| all.iter().find(named))
        .ok_or_else(|| anyhow!("Skill não encontrada: {name}"))?;
    let mut s = s.clone();
    let content = std::fs::read_to_string(s["path"].as_str().unwrap())?;
    s["content"] = json!(content);
    Ok(s)
}

/// Adds a SKILL.md (or a folder holding one) by path; `~/` is the home dir. -> the skill, or null if unreadable.
pub fn add_skill(p: &str) -> Result<Value> {
    let p = match p.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => PathBuf::from(p),
    };
    let mut p = crate::resolve(&p);
    if p.file_name().and_then(|n| n.to_str()) != Some("SKILL.md") {
        p = p.join("SKILL.md");
    }
    if !p.exists() {
        bail!("O caminho escolhido não tem um SKILL.md");
    }
    let mut c = config();
    // [...new Set([...customSkills, p])]
    let mut list: Vec<String> = Vec::new();
    for x in custom_skills(&c).into_iter().chain([path_str(&p)]) {
        if !list.contains(&x) {
            list.push(x);
        }
    }
    c.insert("customSkills".into(), json!(list));
    save_config(c)?;
    let fallback = p.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(read(&p, "Adicionada", &fallback).unwrap_or(Value::Null))
}

pub fn remove_skill(p: &str) -> Result<()> {
    let mut c = config();
    let list: Vec<String> = custom_skills(&c).into_iter().filter(|x| x != p).collect();
    c.insert("customSkills".into(), json!(list));
    save_config(c)
}
