// Port of chats.test.mjs: a background turn keeps writing to its own chat after the user switches away.
// Own test binary (= own process): HOME points at a temp dir before anything reads it.
use pena_state::chats;
use serde_json::{Value, json};

fn texts(c: &Value) -> Vec<String> {
    c["messages"].as_array().unwrap().iter().map(|m| m["text"].as_str().unwrap().to_string()).collect()
}
fn id(c: &Value) -> String {
    c["id"].as_str().unwrap().to_string()
}

#[test]
fn chats() {
    let tmp = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("pena-chats-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).unwrap();
    unsafe { std::env::set_var("HOME", &tmp) };
    let file = tmp.join("x.pen").to_string_lossy().into_owned();
    let file = file.as_str();

    let a = id(&chats::start_new(file));
    chats::append(file, &json!({ "kind": "user", "text": "a1" }), Some(&a));
    let b = id(&chats::start_new(file));
    chats::append(file, &json!({ "kind": "user", "text": "b1" }), Some(&b));
    // the run of A is still streaming: its events must not land in B
    chats::append(file, &json!({ "kind": "text", "text": "a2", "agent": "Phantom" }), Some(&a));
    assert_eq!(texts(&chats::by_id(file, &a).unwrap()), ["a1", "a2"]);
    assert_eq!(texts(&chats::by_id(file, &b).unwrap()), ["b1"]);

    // agent sessions are saved per conversation too
    chats::set_sessions(file, &json!({ "opencode": "ses_a" }), Some(&a));
    assert_eq!(chats::by_id(file, &a).unwrap()["sessions"], json!({ "opencode": "ses_a" }));
    assert_eq!(chats::by_id(file, &b).unwrap()["sessions"], json!({}));

    // a tool card saved when it starts is updated in place when it finishes (no duplicate in the handoff)
    chats::append(file, &json!({ "kind": "tool", "id": "t1", "name": "execute", "status": "running" }), Some(&a));
    chats::append(file, &json!({ "kind": "tool", "id": "t1", "name": "execute", "status": "done", "output": "ok" }), Some(&a));
    let conv = chats::by_id(file, &a).unwrap();
    let cards: Vec<&Value> = conv["messages"].as_array().unwrap().iter().filter(|m| m["kind"] == "tool").collect();
    assert_eq!(cards.len(), 1);
    assert_eq!(cards[0]["status"], "done");

    // a deleted conversation's late events must not fall into the chat that became current
    chats::remove(file, &b);
    assert_eq!(id(&chats::current(file, false).unwrap()), a);
    chats::append(file, &json!({ "kind": "text", "text": "late", "agent": "Phantom" }), Some(&b));
    assert_eq!(texts(&chats::by_id(file, &a).unwrap()), ["a1", "a2", ""]); // the tool card's text is ''

    // a tool still running when the agent stops must not stay spinning in the saved chat
    chats::append(file, &json!({ "kind": "tool", "id": "t2", "name": "execute", "status": "running", "agent": "Phantom" }), Some(&a));
    chats::close_tools(file, &a, "Phantom");
    let conv = chats::by_id(file, &a).unwrap();
    assert_eq!(conv["messages"].as_array().unwrap().iter().find(|m| m["id"] == "t2").unwrap()["status"], "error");

    // groups: one shared instructions text, and a new chat stays in the group the current one belongs to
    let g = chats::save_group(file, &json!({ "name": "Landing", "brief": "hero em 2 colunas" })).unwrap();
    chats::set_group(file, &a, g["id"].as_str()).unwrap();
    let c = chats::start_new(file);
    let cid = id(&c);
    chats::append(file, &json!({ "kind": "user", "text": "c1" }), Some(&cid));
    assert_eq!(c["group"], g["id"]);
    assert_eq!(chats::group_of(file, Some(&cid)).unwrap()["brief"], "hero em 2 colunas");
    // editing the group reaches every chat in it (the brief is stored once, not copied per chat)
    chats::save_group(file, &json!({ "id": g["id"], "name": "Landing", "brief": "hero em 3 colunas" })).unwrap();
    assert_eq!(chats::group_of(file, Some(&a)).unwrap()["brief"], "hero em 3 colunas");
    assert_eq!(chats::groups(file).len(), 1);
    assert_eq!(chats::save_group(file, &json!({ "name": "  " })).unwrap_err().to_string(), "Dê um nome ao grupo");
    // deleting the group keeps the chats, without a group
    chats::remove_group(file, g["id"].as_str().unwrap());
    assert_eq!(chats::group_of(file, Some(&cid)), None);
    assert!(chats::by_id(file, &cid).is_some());
    assert_eq!(chats::group_of(file, Some(&a)), None);

    // pinned chats are listed with the flag and the sidebar includes empty conversations (ordered by activity)
    chats::pin(file, &a, true).unwrap();
    assert_eq!(chats::by_id(file, &a).unwrap()["pinned"], true);
    let find = |id: &str| chats::list(file)["list"].as_array().unwrap().iter().find(|x| x["id"] == id).cloned();
    assert_eq!(find(&a).unwrap()["pinned"], true);
    let empty = id(&chats::start_new(file));
    assert!(find(&empty).is_some());
    std::thread::sleep(std::time::Duration::from_millis(5)); // updated is a millisecond clock: make the next turn strictly newer
    chats::append(file, &json!({ "kind": "user", "text": "recente" }), Some(&a));
    assert_eq!(chats::list(file)["list"][0]["id"], json!(a));
    chats::pin(file, &a, false).unwrap();
    assert_eq!(chats::by_id(file, &a).unwrap().get("pinned"), None);
    assert_eq!(find(&a).unwrap()["pinned"], false);

    // closing an untouched chat (no message at all) deletes it instead of leaving "Novo agente" in the sidebar
    let untouched = chats::current(file, false).unwrap();
    assert_eq!(untouched["messages"].as_array().unwrap().len(), 0);
    chats::select(file, &a).unwrap();
    assert_eq!(chats::by_id(file, &id(&untouched)), None);
    assert!(find(&id(&untouched)).is_none());
    assert_eq!(chats::select(file, "nope").unwrap_err().to_string(), "Conversa não encontrada");

    // on disk: the same file and shape the Bun server writes (~/.pena/chats/<sha1 16>.json)
    chats::flush();
    let dir = tmp.join(".pena").join("chats");
    let files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(files.len(), 1);
    assert!(Regex::new(r"^[0-9a-f]{16}\.json$").unwrap().is_match(&files[0]));
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(&files[0])).unwrap()).unwrap();
    assert_eq!(saved["file"], json!(file));
    assert_eq!(saved["current"], json!(a));
    let first_keys: Vec<&String> = saved["list"][0].as_object().unwrap().keys().collect();
    assert_eq!(first_keys[..3], ["id", "title", "created"]); // `delete c.group` keeps the other keys in place

    // reopening reads it back
    chats::current(&tmp.join("other.pen").to_string_lossy(), false);
    assert_eq!(texts(&chats::by_id(file, &a).unwrap())[0], "a1");

    std::fs::remove_dir_all(&tmp).unwrap();
}

use regex::Regex;
