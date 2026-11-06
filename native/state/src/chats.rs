//! Chat history per .pen file, in ~/.pena/chats/<hash>.json: every conversation's messages plus the agent session
//! ids (Claude session / Codex thread), so reopening a file shows the chat and the agent keeps its context.
//! One file is held in memory at a time; writes are debounced 500 ms. Call flush() before the process exits.

use crate::{js_str, nn, now_ms, slice16, truthy};
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_TEXT: usize = 20_000; // per message; tool output can be huge

struct State {
    doc: Option<String>,
    store: Value,
    timer: bool,
}

static STATE: Mutex<State> = Mutex::new(State { doc: None, store: Value::Null, timer: false });

fn dir() -> PathBuf {
    crate::library::pena_dir().join("chats")
}
fn file_of(doc: &str) -> PathBuf {
    dir().join(format!("{}.json", &hex::encode(Sha1::digest(doc.as_bytes()))[..16]))
}

fn load<'a>(st: &'a mut State, file: &str) -> &'a mut Map<String, Value> {
    if st.doc.as_deref() != Some(file) {
        flush_locked(st);
        st.doc = Some(file.to_string());
        st.store = std::fs::read_to_string(file_of(file))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({ "file": file, "current": null, "list": [] }));
    }
    let s = st.store.as_object_mut().unwrap();
    if !s.get("list").is_some_and(Value::is_array) {
        s.insert("list".into(), json!([]));
    }
    s
}

fn flush_locked(st: &mut State) {
    st.timer = false;
    let (Some(doc), true) = (&st.doc, st.store.is_object()) else { return };
    let f = file_of(doc);
    let tmp = PathBuf::from(format!("{}.tmp", f.display()));
    let _ = std::fs::create_dir_all(dir());
    if std::fs::write(&tmp, serde_json::to_string(&st.store).unwrap()).is_ok() {
        let _ = std::fs::rename(&tmp, &f);
    }
}

/// Writes the open file's chats now (the Bun server does this on process exit).
pub fn flush() {
    flush_locked(&mut STATE.lock().unwrap());
}

fn save(st: &mut State) {
    if !st.timer {
        st.timer = true;
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(500));
            let mut st = STATE.lock().unwrap();
            if st.timer {
                flush_locked(&mut st);
            }
        });
    }
}

fn list_mut(s: &mut Map<String, Value>) -> &mut Vec<Value> {
    s.get_mut("list").and_then(Value::as_array_mut).unwrap()
}
fn id_of(c: &Value) -> Option<&Value> {
    c.get("id")
}
fn is_id(c: &Value, id: &str) -> bool {
    c.get("id").and_then(Value::as_str) == Some(id)
}
fn messages(c: &Value) -> &[Value] {
    c.get("messages").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// String(v ?? '')
fn str_or_empty(v: Option<&Value>) -> String {
    nn(v).map(|v| js_str(Some(v))).unwrap_or_default()
}

fn new_conv(group: Value) -> Value {
    let now = now_ms();
    json!({ "id": &uuid::Uuid::new_v4().to_string()[..8], "group": group, "title": "Novo agente", "created": now, "updated": now, "sessions": {}, "messages": [] })
}
// A chat is history only after a user message: one left without a single interaction is deleted, not kept in the sidebar.
fn was_used(c: &Value) -> bool {
    messages(c).iter().any(|m| m.get("kind").and_then(Value::as_str) == Some("user"))
}

fn idx_current(s: &Map<String, Value>) -> Option<usize> {
    let cur = s.get("current")?;
    s["list"].as_array()?.iter().position(|x| id_of(x) == Some(cur))
}
fn idx_by_id(s: &Map<String, Value>, id: &str) -> Option<usize> {
    s["list"].as_array()?.iter().position(|x| is_id(x, id))
}

pub fn by_id(file: &str, id: &str) -> Option<Value> {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    idx_by_id(s, id).map(|i| s["list"][i].clone())
}

fn current_locked(st: &mut State, file: &str, create: bool) -> Option<usize> {
    let s = load(st, file);
    let i = idx_current(s);
    if i.is_none() && create {
        let c = new_conv(Value::Null);
        s.insert("current".into(), c["id"].clone());
        list_mut(s).insert(0, c);
        save(st);
        return Some(0);
    }
    i
}

pub fn current(file: &str, create: bool) -> Option<Value> {
    let mut st = STATE.lock().unwrap();
    let i = current_locked(&mut st, file, create)?;
    Some(load(&mut st, file)["list"][i].clone())
}

pub fn start_new(file: &str) -> Value {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    let cur = idx_current(s).map(|i| s["list"][i].clone());
    if let Some(c) = &cur
        && messages(c).is_empty()
    {
        return c.clone(); // reuse an empty one
    }
    // a new chat stays in the group the user is working in
    let c = new_conv(cur.and_then(|c| nn(c.get("group")).cloned()).unwrap_or(Value::Null));
    s.insert("current".into(), c["id"].clone());
    list_mut(s).insert(0, c.clone());
    save(&mut st);
    c
}

pub fn select(file: &str, id: &str) -> Result<Value> {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    if idx_by_id(s, id).is_none() {
        bail!("Conversa não encontrada");
    }
    if let Some(p) = idx_current(s)
        && !is_id(&s["list"][p], id)
        && !was_used(&s["list"][p])
    {
        list_mut(s).remove(p); // closing an untouched chat deletes it
    }
    s.insert("current".into(), json!(id));
    save(&mut st);
    let i = idx_current(load(&mut st, file)).unwrap();
    Ok(load(&mut st, file)["list"][i].clone())
}

pub fn remove(file: &str, id: &str) {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    list_mut(s).retain(|x| !is_id(x, id));
    if s.get("current").and_then(Value::as_str) == Some(id) {
        let first = s["list"].get(0).and_then(id_of).cloned().unwrap_or(Value::Null);
        s.insert("current".into(), first);
    }
    save(&mut st);
}

/// -> { current, list: [{ id, title, created, updated, group, pinned, count }] }
pub fn list(file: &str) -> Value {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    // Leftovers from older sessions: an untouched chat only stays while it is the open one.
    let cur = s.get("current").cloned();
    let before = s["list"].as_array().unwrap().len();
    list_mut(s).retain(|c| id_of(c) == cur.as_ref() || was_used(c));
    let changed = s["list"].as_array().unwrap().len() != before;
    let mut sorted = s["list"].as_array().unwrap().clone();
    let current = s.get("current").cloned().unwrap_or(Value::Null);
    if changed {
        save(&mut st);
    }
    // the sidebar is ordered by activity, like T3 Code/ChatGPT; only the open conversation may still be empty
    let upd = |c: &Value| nn(c.get("updated")).and_then(Value::as_f64).unwrap_or(0.0);
    sorted.sort_by(|a, b| upd(b).partial_cmp(&upd(a)).unwrap_or(std::cmp::Ordering::Equal));
    let list: Vec<Value> = sorted
        .iter()
        .map(|c| {
            let mut o = Map::new();
            for k in ["id", "title", "created", "updated"] {
                if let Some(v) = c.get(k) {
                    o.insert(k.into(), v.clone());
                }
            }
            o.insert("group".into(), nn(c.get("group")).cloned().unwrap_or(Value::Null));
            o.insert("pinned".into(), json!(truthy(c.get("pinned"))));
            o.insert("count".into(), json!(messages(c).len()));
            Value::Object(o)
        })
        .collect();
    json!({ "current": current, "list": list })
}

fn with_conv<T>(file: &str, id: &str, f: impl FnOnce(&mut Map<String, Value>) -> T) -> Result<T> {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    let Some(i) = idx_by_id(s, id) else { bail!("Conversa não encontrada") };
    let r = f(s["list"][i].as_object_mut().unwrap());
    save(&mut st);
    Ok(r)
}

/// Pinned conversations sit in their own section of the sidebar, outside the group lists.
pub fn pin(file: &str, id: &str, pinned: bool) -> Result<Value> {
    with_conv(file, id, |c| {
        if pinned {
            c.insert("pinned".into(), json!(true));
        } else {
            c.shift_remove("pinned");
        }
        Value::Object(c.clone())
    })
}

// Groups (a named project context): one shared instructions text, injected into every agent of every chat in the
// group, instead of each chat keeping its own copy.
fn groups_mut(s: &mut Map<String, Value>) -> &mut Vec<Value> {
    if !s.get("groups").is_some_and(Value::is_array) {
        s.insert("groups".into(), json!([]));
    }
    s.get_mut("groups").and_then(Value::as_array_mut).unwrap()
}

pub fn groups(file: &str) -> Vec<Value> {
    let mut st = STATE.lock().unwrap();
    groups_mut(load(&mut st, file)).clone()
}

pub fn group_of(file: &str, conv_id: Option<&str>) -> Option<Value> {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    let c = conv_id.filter(|x| !x.is_empty()).and_then(|id| idx_by_id(s, id)).map(|i| &s["list"][i])?;
    let g = c.get("group").filter(|g| truthy(Some(g)))?;
    s.get("groups")?.as_array()?.iter().find(|x| x.get("id") == Some(g)).cloned()
}

/// `group` is { id?, name, brief }.
pub fn save_group(file: &str, group: &Value) -> Result<Value> {
    let clean_name = slice16(str_or_empty(group.get("name")).trim(), 80).to_string();
    let brief = slice16(str_or_empty(group.get("brief")).trim(), 4000).to_string();
    if clean_name.is_empty() {
        bail!("Dê um nome ao grupo");
    }
    let mut st = STATE.lock().unwrap();
    let list = groups_mut(load(&mut st, file));
    let id = group.get("id").filter(|v| truthy(Some(v)));
    let g = match id.and_then(|id| list.iter_mut().find(|x| x.get("id") == Some(id))) {
        Some(g) => {
            g["name"] = json!(clean_name);
            g["brief"] = json!(brief);
            g.clone()
        }
        None => {
            let g = json!({ "id": &uuid::Uuid::new_v4().to_string()[..8], "created": now_ms(), "name": clean_name, "brief": brief });
            list.push(g.clone());
            g
        }
    };
    save(&mut st);
    Ok(g)
}

pub fn remove_group(file: &str, id: &str) {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    groups_mut(s).retain(|g| g.get("id").and_then(Value::as_str) != Some(id));
    for c in list_mut(s) {
        if c.get("group").and_then(Value::as_str) == Some(id) {
            c.as_object_mut().unwrap().shift_remove("group");
        }
    }
    save(&mut st);
}

pub fn set_group(file: &str, conv_id: &str, group_id: Option<&str>) -> Result<Value> {
    let group_id = group_id.filter(|g| !g.is_empty());
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    let Some(i) = idx_by_id(s, conv_id) else { bail!("Conversa não encontrada") };
    if let Some(g) = group_id
        && !s.get("groups").and_then(Value::as_array).is_some_and(|l| l.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(g)))
    {
        bail!("Grupo não encontrado");
    }
    let c = s["list"][i].as_object_mut().unwrap();
    match group_id {
        Some(g) => {
            c.insert("group".into(), json!(g));
        }
        None => {
            c.shift_remove("group");
        }
    }
    let c = Value::Object(c.clone());
    save(&mut st);
    Ok(c)
}

/// The conversation `id` (when given) or the current one, created if needed; None when `id` was deleted.
fn target(st: &mut State, file: &str, id: Option<&str>) -> Option<usize> {
    match id.filter(|x| !x.is_empty()) {
        Some(id) => idx_by_id(load(st, file), id),
        None => current_locked(st, file, true),
    }
}

/// `id` is the conversation the agent belongs to: a turn running in the background still writes to its own chat after
/// the user switched to another one. A deleted conversation is gone: its late events go nowhere instead of into `current`.
pub fn append(file: &str, msg: &Value, id: Option<&str>) {
    let mut st = STATE.lock().unwrap();
    let Some(i) = target(&mut st, file, id) else { return };
    let c = load(&mut st, file).get_mut("list").unwrap()[i].as_object_mut().unwrap();
    let kind = msg.get("kind").and_then(Value::as_str);
    if !c.get("messages").is_some_and(Value::is_array) {
        c.insert("messages".into(), json!([]));
    }
    let used = c["messages"].as_array().unwrap().iter().any(|m| m.get("kind").and_then(Value::as_str) == Some("user"));
    if kind == Some("user") && !used {
        let t = if truthy(msg.get("text")) { js_str(msg.get("text")) } else { "Arquivos anexados".into() };
        c.insert("title".into(), json!(slice16(&t, 60)));
    }
    let text = str_or_empty(msg.get("text"));
    let mut item = msg.as_object().cloned().unwrap_or_default();
    // a handoff is kept as sent
    item.insert("text".into(), json!(if kind == Some("handoff") { text.as_str() } else { slice16(&text, MAX_TEXT) }));
    item.insert("t".into(), json!(now_ms()));
    let item = Value::Object(item);
    let msgs = c.get_mut("messages").and_then(Value::as_array_mut).unwrap();
    // a tool card is saved when it starts and updated in place when it finishes, so a chat switched to mid-run shows the
    // current step and the handoff history has one card per tool
    let running = match nn(msg.get("id")) {
        Some(mid) if kind == Some("tool") => msgs.iter().rposition(|m| {
            m.get("kind").and_then(Value::as_str) == Some("tool") && m.get("id") == Some(mid) && m.get("status").and_then(Value::as_str) == Some("running")
        }),
        _ => None,
    };
    match running {
        Some(r) => msgs[r] = item,
        None => msgs.push(item),
    }
    c.insert("updated".into(), json!(now_ms()));
    save(&mut st);
}

pub fn set_sessions(file: &str, sessions: &Value, id: Option<&str>) {
    let mut st = STATE.lock().unwrap();
    let Some(i) = target(&mut st, file, id) else { return };
    load(&mut st, file).get_mut("list").unwrap()[i]["sessions"] = sessions.clone();
    save(&mut st);
}

/// A run stopped or failing between a tool's start and its result would leave that card spinning in the saved chat.
pub fn close_tools(file: &str, id: &str, agent: &str) {
    let mut st = STATE.lock().unwrap();
    let s = load(&mut st, file);
    let Some(i) = idx_by_id(s, id) else { return };
    let mut hit = false;
    if let Some(msgs) = s.get_mut("list").unwrap()[i].get_mut("messages").and_then(Value::as_array_mut) {
        for m in msgs {
            if m.get("kind").and_then(Value::as_str) == Some("tool")
                && m.get("agent").and_then(Value::as_str) == Some(agent)
                && m.get("status").and_then(Value::as_str) == Some("running")
            {
                m["status"] = json!("error");
                hit = true;
            }
        }
    }
    if hit {
        save(&mut st);
    }
}
