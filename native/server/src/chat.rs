// The embedded agents (port of the agent half of server.mjs): conversations, turns, context handoffs between
// providers, parallel agents (spawn_agents), side-by-side variations, and the chat history they leave.
use crate::app::{self, app, emit, file, now_ms};
use anyhow::Result;
use pena_agents::{Mcp, Session, Turn};
use pena_core::tools::{self, CallCtx};
use pena_state::{chats, handoff, library, limiter::Limiter, settings, skills};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

type Sess = Arc<AsyncMutex<Session>>;

// Agent CLIs running at once per chat (each is a ~300 MB process); the rest of a 5x/8x request waits its turn.
// ponytail: per chat, so a busy background chat never queues the one you are typing in; make it global for a cap.
const MAX_PARALLEL_AGENTS: usize = 3;

struct Variation { i: usize, agent: String, session: Sess, provider: String }
struct Variations { before: HashSet<String>, list: Vec<Variation> }
struct Split { kids: Mutex<Vec<JoinHandle<Value>>> }

#[derive(Default)]
struct Inner {
    main: HashMap<String, Sess>,       // provider (account) id -> the chat's session with it
    natives: HashMap<String, String>,  // provider id -> its CLI session id, what the chat history keeps
    profiles: Vec<(String, String)>,   // agent names and colors, in order of appearance
    running: HashMap<u64, CancellationToken>,
    active: Vec<(String, Value)>,      // agents working now (the UI restores them on switch)
    last_chat: Value,
    spawn_budget: usize,
    split: Option<Arc<Split>>,
    variations: Option<Variations>,
    picked: Option<String>,
}
/// One conversation's runtime state. A chat still working in the background keeps receiving its events into its own
/// history after the user switches away.
pub struct Chat { id: String, file: String, inner: Mutex<Inner>, slots: Limiter }

static LIVE: LazyLock<Mutex<HashMap<String, Arc<Chat>>>> = LazyLock::new(Default::default);
static RUN_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn file_str() -> Option<String> { file().map(|f| f.to_string_lossy().into_owned()) }

fn state_of(id: &str, file: &str) -> Arc<Chat> {
    if let Some(st) = LIVE.lock().unwrap().get(id) { return st.clone() }
    let c = chats::by_id(file, id).unwrap_or_default();
    let mut inner = Inner { last_chat: json!({ "provider": "claude" }), ..Default::default() };
    for (pid, v) in c["sessions"].as_object().cloned().unwrap_or_default() {
        let (Some(provider), Some(v)) = (settings::account_of(&pid).and_then(|a| a["provider"].as_str().map(String::from)), v.as_str()) else { continue };
        // OpenCode keeps the tool list a session was created with, and a saved session always comes from an earlier
        // app process. If that one's MCP server was down when the session was born, resuming it keeps the agent
        // tool-less forever. Start a new session instead: the handoff gives it the whole conversation.
        if provider == "opencode" { continue }
        let s = if provider == "codex" { Session { codex_id: Some(v.into()), ..Default::default() } } else { Session { claude: Some(v.into()), ..Default::default() } };
        inner.main.insert(pid.clone(), Arc::new(AsyncMutex::new(s)));
        inner.natives.insert(pid, v.into());
    }
    // the chat's agents keep their names and colors, so a new agent never reuses one (handoffs name who did what)
    for m in c["messages"].as_array().cloned().unwrap_or_default() {
        let Some(agent) = m["agent"].as_str().filter(|_| m["kind"] == "start") else { continue };
        let color = m["color"].as_str().unwrap_or("").to_string();
        if !inner.profiles.iter().any(|(n, _)| n == agent) { inner.profiles.push((agent.into(), color.clone())) }
        let provider = m["provider"].as_str().unwrap_or("claude");
        if m["parent"].is_null() && m["variation"].as_u64().unwrap_or(0) <= 1 {
            if let Some(s) = inner.main.get(provider) { s.try_lock().map(|mut s| s.profile = Some(json!({ "name": agent, "color": color }))).ok(); }
        }
    }
    let st = Arc::new(Chat { id: id.into(), file: file.into(), inner: Mutex::new(inner), slots: Limiter::new(MAX_PARALLEL_AGENTS) });
    LIVE.lock().unwrap().insert(id.into(), st.clone());
    st
}
fn current_state() -> Option<Arc<Chat>> {
    let f = file_str()?;
    let id = chats::current(&f, false)?["id"].as_str()?.to_string();
    Some(state_of(&id, &f))
}
pub fn running_info(id: &str) -> Vec<Value> {
    LIVE.lock().unwrap().get(id).map(|st| st.inner.lock().unwrap().active.iter().map(|(_, v)| v.clone()).collect()).unwrap_or_default()
}
pub fn profile_color(agent: &str) -> Value {
    for st in LIVE.lock().unwrap().values() {
        if let Some((_, c)) = st.inner.lock().unwrap().profiles.iter().find(|(n, _)| n == agent) { return json!(c) }
    }
    Value::Null
}
// The main chat's agent sessions, saved with their conversation so a reopened chat resumes with its context.
fn save_sessions(st: &Chat) {
    let natives = st.inner.lock().unwrap().natives.clone();
    chats::set_sessions(&st.file, &json!(natives), Some(&st.id));
}
pub fn drop_chat(id: &str) {
    if let Some(st) = LIVE.lock().unwrap().remove(id) { st.inner.lock().unwrap().running.values().for_each(|c| c.cancel()) }
}
pub fn stop_current() {
    if let Some(st) = current_state() { st.inner.lock().unwrap().running.values().for_each(|c| c.cancel()) }
}
/// A CLI session keeps the tool list it started with: forget them all, so the next turn starts new ones.
pub fn forget_sessions() {
    if let Some(f) = file_str() {
        for c in chats::list(&f)["list"].as_array().cloned().unwrap_or_default() { chats::set_sessions(&f, &json!({}), c["id"].as_str()) }
    }
    for st in LIVE.lock().unwrap().values() {
        let mut i = st.inner.lock().unwrap();
        i.natives.clear();
        for s in i.main.values() { if let Ok(mut s) = s.try_lock() { s.forget_native() } }
    }
}

// --- chat history: finished items only (streaming sends many partial updates of the same text/card) ---------------
static TOOL_PARTS: LazyLock<Mutex<HashMap<String, Value>>> = LazyLock::new(Default::default);
fn merge(a: &Value, b: &Value) -> Value {
    let mut out = a.as_object().cloned().unwrap_or_default();
    for (k, v) in b.as_object().cloned().unwrap_or_default() { out.insert(k, v); }
    Value::Object(out)
}
fn cut(s: &str, n: usize) -> String { s.chars().take(n).collect() }
pub fn remember(d: &Value) {
    let conv = d["conv"].as_str();
    let file = conv.and_then(|c| LIVE.lock().unwrap().get(c).map(|st| st.file.clone())).or_else(file_str);
    let Some(file) = file else { return };
    let keep = |m: &Value| chats::append(&file, m, conv);
    match d["kind"].as_str().unwrap_or("") {
        "text" | "thinking" => { if d["done"] == true { keep(d) } }
        "tool" => {
            let id = d["id"].as_str().unwrap_or("").to_string();
            let mut parts = TOOL_PARTS.lock().unwrap();
            let known = parts.contains_key(&id);
            let mut t = merge(parts.get(&id).unwrap_or(&json!({})), d);
            let images = t["images"].as_array().map_or(0, |a| a.len());
            if d["status"] != "done" && d["status"] != "error" {
                parts.insert(id, t.clone());
                // keep the card as soon as it starts, so another chat switched to mid-run shows what the agent is doing
                if !known { t["images"] = json!(images); keep(&t) }
                return;
            }
            parts.remove(&id);
            if let Some(input) = t["input"].as_object().cloned() {
                t["input"] = Value::Object(input.into_iter().map(|(k, v)| match v { Value::String(s) => (k, json!(cut(&s, 8000))), v => (k, v) }).collect());
            }
            t["images"] = json!(images);
            t["output"] = json!(cut(&match &t["output"] { Value::String(s) => s.clone(), Value::Null => String::new(), v => v.to_string() }, 4000));
            keep(&t);
        }
        "start" | "model" | "end" | "todos" | "error" | "handoff" => keep(d),
        _ => {}
    }
}

// --- prompts -------------------------------------------------------------------------------------------------------
// Group instructions go after the stable part, so every chat and group still shares the same cached prefix.
fn group_block(g: &Value) -> String {
    g["brief"].as_str().filter(|b| !b.is_empty()).map(|b| format!("\n\nShared context for every chat in the group \"{}\". Follow it in this chat:\n{b}", g["name"].as_str().unwrap_or(""))).unwrap_or_default()
}
fn system(group: &Value) -> String {
    format!(r#"You are a product designer working inside Pena, a visual design tool.
You run inside the Pena app, in this chat: the user is already in Pena and sees the canvas. Never ask them to open Pena, reconnect the MCP or start a new chat. If your tool list has no pena tools, say that in one line and stop: Pena notices it and starts a new session on the next message.
Design only through the pena MCP tools (get_app_state, execute, read_skill, spawn_agents, generate_image, upscale_image); never edit .pen files directly.
You may read the code of the project the .pen file belongs to, to match the real app, and change it when the user asks or the design needs it: use whatever file and search tools you have (or shell commands). Secrets such as .env files and keys are unreadable and can't be changed.
Reply in the user's language with one or two short sentences about what you did.

The pena skill is loaded below. Read guide files with read_skill when the task matches them.

{}{}"#, pena_core::system_prompt(), group_block(group))
}
// Codex and OpenCode only get the system text on their first turn, and their thread survives edits to the group. When
// the group changed since the thread last saw it, the next turn carries the new text instead of silently keeping the old.
fn group_key(g: &Value) -> String { g["brief"].as_str().filter(|b| !b.is_empty()).map(|b| format!("{}\n{b}", g["id"].as_str().unwrap_or(""))).unwrap_or_default() }
fn group_sync(g: &Value) -> String {
    match g["brief"].as_str().filter(|b| !b.is_empty()) {
        Some(b) => format!("The shared group context for this chat changed (\"{}\"). It applies from now on:\n{b}", g["name"].as_str().unwrap_or("")),
        None => "The shared group context for this chat was removed. Ignore any group instructions from earlier turns.".into(),
    }
}
fn group_for(st: &Chat) -> Value { chats::group_of(&st.file, Some(&st.id)).unwrap_or(Value::Null) }

// The composer's "states and flows" switches: the guide rides along with the message (and with spawned agents).
fn design_rules(req: &Value) -> String {
    let (states, flows) = (req["states"] == true, req["flows"] == true);
    if !states && !flows { return String::new() }
    let on = if states {
        "ON for this message: \"Draw states\" and \"Link screens\". Draw the interactive states of everything you design, and link every trigger to the screen or state it opens with connections."
    } else {
        "ON for this message: \"Link screens\". Link every trigger to the screen it opens with connections. Draw extra state variants only if the user asks."
    };
    format!("\n\n<design-rules>\nThe user turned these rules {on} Follow the guide below.\n\n{}\n</design-rules>", pena_core::read_skill(Some("guide/states-and-flows.md")).unwrap_or_default())
}
// The attached skills, appended to a prompt: the chat's own agent gets them, and so does every agent it spawns.
fn with_skills(mut prompt: String, names: &[String], conv: &str) -> String {
    for name in names {
        match skills::skill_content(name, None) {
            Ok(sk) => prompt += &format!("\n\n<skill name=\"{}\" source=\"{}\">\n{}\n</skill>", sk["name"].as_str().unwrap_or(""), sk["source"].as_str().unwrap_or(""), sk["content"].as_str().unwrap_or("")),
            Err(e) => emit("agent", json!({ "conv": conv, "agent": "Pena", "kind": "error", "text": e.to_string() })),
        }
    }
    if names.is_empty() { return prompt }
    format!("{prompt}\n\nFollow the attached skill{} ({}) for this request.", if names.len() > 1 { "s" } else { "" }, names.join(", "))
}
fn strings(v: &Value) -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default() }

// --- attachments: any file from the chat is saved under ~/.pena/attachments; text goes into the prompt, PDFs also go
// to Claude as documents, other binaries are read by the agent from the saved path ---------------------------------
fn attach_dir() -> PathBuf { library::pena_dir().join("attachments") }
static TEXT_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(html?|css|scss|js|mjs|cjs|ts|tsx|jsx|json|md|mdx|txt|csv|tsv|xml|svg|ya?ml|toml|ini|env|py|rb|go|rs|java|kt|swift|php|sql|sh|vue|svelte|astro|pen|log)$").unwrap());
const MAX_INLINE: usize = 200_000; // characters of a text file placed in the prompt
fn data_url(d: &str) -> Option<(String, String)> {
    let rest = d.strip_prefix("data:")?;
    let (mime, b64) = rest.split_once(";base64,")?;
    Some((mime.into(), b64.into()))
}
// Office documents as plain text: Word/RTF/ODT through macOS's textutil, Excel/PowerPoint/ODF from their XML.
fn office_text(file: &Path, name: &str) -> Option<String> {
    let n = name.to_lowercase();
    let ext = |l: &[&str]| l.iter().any(|e| n.ends_with(e));
    if cfg!(target_os = "macos") && ext(&[".doc", ".docx", ".rtf", ".rtfd", ".odt", ".webarchive"]) {
        let out = std::process::Command::new("/usr/bin/textutil").args(["-convert", "txt", "-stdout"]).arg(file).output().ok()?;
        return out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned());
    }
    if !ext(&[".xlsx", ".xlsm", ".pptx", ".ods", ".odp", ".docx", ".odt"]) { return None }
    // unzip exits non-zero when a pattern is missing (xlsx has no slides): keep whatever it printed
    let parts = ["xl/sharedStrings.xml", "xl/worksheets/*.xml", "ppt/slides/*.xml", "word/document.xml", "content.xml"];
    let out = std::process::Command::new("unzip").arg("-p").arg(file).args(parts).output().ok()?;
    let xml = String::from_utf8_lossy(&out.stdout);
    if xml.is_empty() { return None }
    static RS: LazyLock<[Regex; 4]> = LazyLock::new(|| [r"</(a:p|w:p|row|text:p|si)>", r"</(c|a:t|t)>", r"<[^>]+>", r"[ \t]*\n\s*"].map(|r| Regex::new(r).unwrap()));
    let t = RS[0].replace_all(&xml, "\n");
    let t = RS[1].replace_all(&t, "\t");
    let t = RS[2].replace_all(&t, "").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
    Some(RS[3].replace_all(&t, "\n").trim().to_string())
}
fn attach_files(files: &[Value]) -> (String, Vec<String>) {
    if files.is_empty() { return (String::new(), vec![]) }
    let _ = std::fs::create_dir_all(attach_dir());
    let (mut parts, mut docs) = (vec![], vec![]);
    static BAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^\w.\- ]+").unwrap());
    use base64::Engine;
    for f in files {
        let Some((mime, b64)) = data_url(f["data"].as_str().unwrap_or("")) else { continue };
        let name = f["name"].as_str().unwrap_or("arquivo").to_string();
        let Ok(buf) = base64::engine::general_purpose::STANDARD.decode(&b64) else { continue };
        let base = Path::new(&name).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let path = attach_dir().join(format!("{}-{}", now_ms(), BAD.replace_all(&base, "_")));
        let _ = std::fs::write(&path, &buf);
        let p = path.display();
        let office = office_text(&path, &name);
        let is_text = office.is_none() && (Regex::new(r"^text/|^application/(json|xml|javascript)|\+(xml|json)$|^image/svg").unwrap().is_match(&mime) || TEXT_NAME.is_match(&name) || (std::str::from_utf8(&buf).is_ok() && !buf.contains(&0)));
        if is_text {
            let t = String::from_utf8_lossy(&buf);
            let n = t.chars().count();
            parts.push(format!("<attachment name=\"{name}\" path=\"{p}\">\n{}{}\n</attachment>", cut(&t, MAX_INLINE), if n > MAX_INLINE { format!("\n[truncated: {n} characters in total, the full file is at the path above]") } else { String::new() }));
        } else if mime == "application/pdf" || name.to_lowercase().ends_with(".pdf") {
            docs.push(b64);
            parts.push(format!("<attachment name=\"{name}\" type=\"application/pdf\" path=\"{p}\">PDF (Claude receives it as a document; other agents can read it from the path).</attachment>"));
        } else if let Some(text) = office {
            parts.push(format!("<attachment name=\"{name}\" path=\"{p}\" extracted=\"text\">\n{}{}\n</attachment>", cut(&text, MAX_INLINE), if text.chars().count() > MAX_INLINE { "\n[truncated]" } else { "" }));
        } else {
            let hex = buf.iter().take(256).map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ");
            parts.push(format!("<attachment name=\"{name}\" type=\"{mime}\" path=\"{p}\" bytes=\"{}\">Binary file. First bytes (hex): {hex}</attachment>", buf.len()));
        }
    }
    (format!("\n\nFiles attached by the user:\n{}", parts.join("\n")), docs)
}

// --- one agent run -------------------------------------------------------------------------------------------------
// Agent profiles like pen.dev's: a name and a color per agent, in order of appearance.
const AGENT_NAMES: [&str; 10] = ["Phantom", "Drift", "Flare", "Onyx", "Nova", "Hex", "Echo", "Mirage", "Cosmo", "Reef"];
const AGENT_COLORS: [&str; 20] = ["#aab9e1", "#5acdd2", "#ffaf3c", "#9b8cbe", "#ff73a0", "#b96ef0", "#78c8f0", "#dcb48c", "#6496ff", "#46d2c3", "#ffa08c", "#ff8c55", "#96d2ff", "#9bcdaa", "#64c882", "#c38ce6", "#6e8ceb", "#ffd76e", "#ff6961", "#ffd278"];
fn new_profile(st: &Chat) -> Value {
    let name_of = |i: usize| format!("{}{}", AGENT_NAMES[i % 10], if i >= 10 { format!(" {}", i / 10 + 1) } else { String::new() });
    let mut inner = st.inner.lock().unwrap();
    let mut i = inner.profiles.len();
    while inner.profiles.iter().any(|(n, _)| *n == name_of(i)) { i += 1 } // names restored from the chat may not be the first ones
    let (name, color) = (name_of(i), AGENT_COLORS[i % 20].to_string());
    inner.profiles.push((name.clone(), color.clone()));
    json!({ "name": name, "color": color })
}
// The session's agent name and color, made once (a run names its session before it starts).
async fn ensure_profile(st: &Chat, session: &Sess) -> (String, String) {
    let mut s = session.lock().await;
    let known = |p: &Value| st.inner.lock().unwrap().profiles.iter().any(|(n, _)| Some(n.as_str()) == p["name"].as_str());
    if !s.profile.as_ref().is_some_and(known) { s.profile = Some(new_profile(st)) }
    let p = s.profile.clone().unwrap();
    (p["name"].as_str().unwrap_or("").into(), p["color"].as_str().unwrap_or("").into())
}

static GONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)no (conversation|session|thread) found|\b(conversation|session|thread)\b[^\n]{0,40}\bnot found").unwrap());
// the design tools did not load: a new session is what makes the CLI pick them up again
static TOOLS_DOWN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)ferramentas de design|pena MCP|mcp__pena|server process exited|não (está|foi) carregad|not loaded").unwrap());
// tools that only exist while the design-tool server is up (mcp__pena__execute, pena_execute, pena.execute)
fn is_design_tool(name: &str) -> bool {
    let last = name.rsplit(['.', ':']).next().unwrap_or("");
    let last = last.strip_prefix("mcp__pena__").or_else(|| last.strip_prefix("pena_")).unwrap_or(last);
    ["execute", "get_app_state", "read_skill", "spawn_agents", "get_node", "read_chat", "generate_image", "upscale_image"].contains(&last)
}
// a reply that says it could not use the design tools: the session's catalog never had them
static TOOLS_DOWN_TEXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!("(?i){}", [
    r"ferramentas?[^.\n]{0,50}(n[ãa]o (est[ãa]o|est[áa]|foram|consegui|consigo|tenho|vejo)|fora do cat[áa]logo|indispon[íi]ve|sem acesso)",
    r"ferramentas? (do|da|de) (pena|design|canvas)[^.\n]{0,40}(n[ãa]o (est[ãa]o|est[áa]|foram|tenho|consigo)|sem |indispon|fora)",
    r"(sem|n[ãa]o tenho|n[ãa]o vejo)[^.\n]{0,40}ferramentas?",
    r"(no|don.t have|do not have|without|missing)[^.\n]{0,40}(pena|design) tools?",
    r"(pena|design) tools?[^.\n]{0,40}(not|no|missing|unavailable)",
    r"pena_execute[^.\n]{0,60}(n[ãa]o|fora|indispon)",
    r"pena[^.\n]{0,40}n[ãa]o est[áa] registrad",
    "no tool named",
].join("|"))).unwrap());

fn mcp_launch(agent: &str, conv: &str) -> Mcp {
    let l = settings::pena_launch();
    let mut env = l.env.clone();
    env.insert("PENA_FILE".into(), file_str().unwrap_or_default());
    env.insert("PENA_URL".into(), format!("http://127.0.0.1:{}", app::port()));
    env.insert("PENA_AGENT".into(), agent.into());
    env.insert("PENA_CONV".into(), conv.into());
    Mcp { command: l.command, args: l.args, env }
}
fn turn_for(req: &Value, acc: &Value, st: &Chat, agent: &str) -> Turn {
    let group = group_for(st);
    let env: std::collections::BTreeMap<_, _> = settings::account_env(acc).into_iter().collect();
    let codex_home = acc["env"]["CODEX_HOME"].as_str().map(PathBuf::from);
    Turn {
        prompt: req["prompt"].as_str().unwrap_or("").into(),
        model: req["model"].as_str().map(String::from),
        effort: req["effort"].as_str().filter(|e| !e.is_empty()).map(String::from),
        images: strings(&req["images"]),
        docs: strings(&req["docs"]),
        env,
        file: file().unwrap_or_default(),
        attach_dir: attach_dir(),
        system: system(&group),
        group_key: group_key(&group),
        group_sync: group_sync(&group),
        pena: mcp_launch(agent, &st.id),
        extra_servers: settings::agent_mcp_servers(),
        claude_bin: settings::claude_bin().into(),
        codex_bin: settings::codex_bin().into(),
        opencode_bin: settings::opencode_bin().into(),
        global_codex_servers: settings::global_codex_servers(codex_home.as_deref()),
        codex_home: Some(codex_home.unwrap_or_else(settings::codex_home)),
        global_opencode_servers: settings::global_opencode_servers(),
    }
}

#[derive(Default, Clone)]
struct RunOpts { parent: Option<String>, variation: Option<usize>, handoff: Option<Value> }

// Streaming updates of the same text/card are throttled to one per 60 ms.
struct Throttle { last: Mutex<HashMap<String, Instant>>, pending: Mutex<HashMap<String, JoinHandle<()>>> }

// One agent run. Events go to the editor as `agent` SSE messages: start, model, text/thinking (accumulated text,
// streamed), tool (card updates by id), todos, end (reason, duration, usage). Its events carry the conversation id
// so other chats ignore them.
async fn run(req: Value, session: Sess, st: Arc<Chat>, opts: RunOpts) -> Value {
    let (agent, color) = ensure_profile(&st, &session).await;
    let token = CancellationToken::new();
    let run_id = RUN_SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    st.inner.lock().unwrap().running.insert(run_id, token.clone());
    let base = json!({ "conv": st.id, "agent": agent, "color": color });
    let send = { let base = base.clone(); move |kind: &str, data: &Value| { let mut m = merge(&base, data); m["kind"] = json!(kind); emit("agent", m) } };
    let throttle = Arc::new(Throttle { last: Mutex::default(), pending: Mutex::default() });
    // did this turn actually design? and what did the agent say last? (a session without the design tools only talks)
    let designed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let said = Arc::new(Mutex::new(String::new()));
    let say = {
        let (throttle, designed, said, send) = (throttle.clone(), designed.clone(), said.clone(), send.clone());
        move |kind: &str, data: Value, key: Option<String>| {
            if kind == "tool" && is_design_tool(data["name"].as_str().unwrap_or("")) { designed.store(true, std::sync::atomic::Ordering::SeqCst) }
            if kind == "text" { if let Some(t) = data["text"].as_str() { let n = t.chars().count(); *said.lock().unwrap() = t.chars().skip(n.saturating_sub(2000)).collect() } }
            let Some(key) = key else {
                if let Some(id) = data["id"].as_str() { if let Some(h) = throttle.pending.lock().unwrap().remove(id) { h.abort() } }
                return send(kind, &data);
            };
            let wait = Duration::from_millis(60).saturating_sub(throttle.last.lock().unwrap().get(&key).map_or(Duration::MAX, |t| t.elapsed()));
            if let Some(h) = throttle.pending.lock().unwrap().remove(&key) { h.abort() }
            if wait.is_zero() { throttle.last.lock().unwrap().insert(key, Instant::now()); return send(kind, &data) }
            let (t, send, kind) = (throttle.clone(), send.clone(), kind.to_string());
            let k2 = key.clone();
            let h = tokio::spawn(async move { tokio::time::sleep(wait).await; t.last.lock().unwrap().insert(k2, Instant::now()); send(&kind, &data) });
            throttle.pending.lock().unwrap().insert(key, h);
        }
    };
    let mut t0 = now_ms();
    if let Some(h) = &opts.handoff { send("handoff", h) }
    let provider = req["provider"].as_str().unwrap_or("claude").to_string();
    let acc = settings::account_of(&provider);
    // over the chat's parallel limit the run waits (shown as queued until its CLI reports the model); stop cancels it
    let queued = st.slots.full();
    let info = json!({ "agent": agent, "color": color, "model": req["model"], "provider": req["provider"], "parent": opts.parent, "t0": t0, "queued": queued });
    st.inner.lock().unwrap().active.push((agent.clone(), info));
    send("start", &json!({ "provider": req["provider"], "label": acc.as_ref().map(|a| a["name"].clone()), "model": req["model"], "effort": req["effort"], "parent": opts.parent, "variation": opts.variation, "queued": queued }));
    let mut end = json!({ "reason": "finished" });
    let result: Result<()> = async {
        let acc = acc.ok_or_else(|| anyhow::anyhow!("Esta conta foi removida. Escolha outro modelo no seletor."))?;
        let _release = st.slots.acquire(Some(&token)).await?;
        t0 = now_ms();
        if let Some((_, i)) = st.inner.lock().unwrap().active.iter_mut().find(|(a, _)| *a == agent) { i["queued"] = json!(false); i["t0"] = json!(t0) }
        let turn = turn_for(&req, &acc, &st, &agent);
        let mut s = session.lock().await;
        let r = match acc["provider"].as_str() {
            Some("codex") => pena_agents::run_codex(&turn, &mut s, token.clone(), &say).await,
            Some("opencode") => pena_agents::run_opencode(&turn, &mut s, token.clone(), &say).await,
            _ => pena_agents::run_claude(&turn, &mut s, token.clone(), &say).await,
        };
        // the CLI session id the chat history keeps, when this is the chat's own (not a spawned) session
        let is_main = st.inner.lock().unwrap().main.values().any(|m| Arc::ptr_eq(m, &session));
        if is_main {
            let mut i = st.inner.lock().unwrap();
            match pena_agents::native_session(acc["provider"].as_str().unwrap_or("claude"), &s) { Some(n) => i.natives.insert(provider.clone(), n), None => i.natives.remove(&provider) };
        }
        r
    }.await;
    if let Err(e) = result {
        let message = e.to_string();
        end = if token.is_cancelled() { json!({ "reason": "stopped" }) } else {
            let mut f = json!({ "reason": "failed", "message": message, "provider": req["provider"] });
            if TOOLS_DOWN.is_match(&message) { f["tools"] = json!(true) }
            f
        };
    }
    {
        let mut i = st.inner.lock().unwrap();
        i.running.remove(&run_id);
        i.active.retain(|(a, _)| *a != agent);
    }
    for (_, h) in throttle.pending.lock().unwrap().drain() { h.abort() }
    chats::close_tools(&st.file, &st.id, &agent);
    if st.inner.lock().unwrap().main.values().any(|m| Arc::ptr_eq(m, &session)) { save_sessions(&st) }
    // A session that never had the design tools answers in prose ("I can't edit the file") and the turn looks fine.
    // Treat that as a failed turn so run_turn retries it on a fresh session, which loads the tools.
    let said = said.lock().unwrap().clone();
    if end["reason"] == "finished" && !designed.load(std::sync::atomic::Ordering::SeqCst) && TOOLS_DOWN_TEXT.is_match(&said) {
        end = json!({ "reason": "failed", "message": cut(&said, 400), "provider": req["provider"], "tools": true });
    }
    let usage = session.lock().await.usage.take();
    let mut fin = end.clone();
    fin["ms"] = json!(now_ms().saturating_sub(t0));
    fin["usage"] = json!(usage);
    fin["variation"] = json!(opts.variation);
    send("end", &fin);
    end
}

// Context handoff: each provider's session only saw its own turns, so before a turn it gets what it missed of the
// chat. A session its CLI no longer has is replaced once by a new one that gets the whole conversation.
async fn handoff_for(req: &Value, session: &Sess, until: usize, replaced: bool, st: &Chat) -> Option<Value> {
    let messages = chats::by_id(&st.file, &st.id).and_then(|c| c["messages"].as_array().cloned()).unwrap_or_default();
    let provider = req["provider"].as_str().unwrap_or("claude");
    let label = settings::account_of(provider).and_then(|a| a["name"].as_str().map(String::from));
    let fresh = pena_agents::native_session(provider, &*session.lock().await).is_none();
    let mut a = handoff::HandoffArgs::new(&messages, provider);
    a.until = Some(until.min(messages.len()));
    a.model = req["model"].as_str();
    a.label = label.as_deref();
    a.fresh = fresh;
    a.replaced = replaced;
    handoff::plan_handoff(&a)
}
pub async fn handoff_preview(provider: &str, model: Option<&str>) -> Value {
    let Some(st) = current_state() else { return Value::Null };
    let session = st.inner.lock().unwrap().main.get(provider).cloned().unwrap_or_default();
    match handoff_for(&json!({ "provider": provider, "model": model }), &session, usize::MAX, false, &st).await {
        Some(h) => json!({ "from": h["from"], "to": h["to"], "fresh": h["fresh"] }),
        None => Value::Null,
    }
}
fn run_turn(req: Value, session: Sess, until: usize, st: Arc<Chat>, opts: RunOpts, replaced: bool) -> futures::future::BoxFuture<'static, Value> {
    Box::pin(async move {
        let handoff = handoff_for(&req, &session, until, replaced, &st).await;
        let mut r = req.clone();
        if let Some(h) = &handoff { r["prompt"] = json!(format!("{}\n\nUser message:\n{}", h["text"].as_str().unwrap_or(""), req["prompt"].as_str().unwrap_or(""))) }
        let end = run(r, session.clone(), st.clone(), RunOpts { handoff, ..opts.clone() }).await;
        let message = end["message"].as_str().unwrap_or("");
        let failed = end["reason"] == "failed";
        let down = failed && (end["tools"] == true || TOOLS_DOWN.is_match(message));
        let provider = req["provider"].as_str().unwrap_or("claude");
        let native = pena_agents::native_session(provider, &*session.lock().await).is_some();
        if replaced || !failed || !native || !(GONE.is_match(message) || down) { return end }
        if down { tokio::spawn(app::mcp_check(false)); } // say it in the UI while the new session starts
        session.lock().await.forget_native();
        run_turn(req, session, until, st, opts, true).await
    })
}

// --- chat turns ----------------------------------------------------------------------------------------------------
// POST /chat. Steer: stop this conversation's turn and send this one as soon as its runs have wound down.
pub async fn post(msg: Value) -> Result<Option<Value>> {
    let Some(f) = file_str() else { return Ok(None) };
    if msg["provider"] == "reset" { return Ok(Some(json!({ "id": chats::start_new(&f)["id"] }))) }
    let conv = chats::current(&f, true).and_then(|c| c["id"].as_str().map(String::from)).unwrap_or_default();
    let st = state_of(&conv, &f);
    let running: Vec<_> = st.inner.lock().unwrap().running.values().cloned().collect();
    if msg["steer"] == true && !running.is_empty() {
        running.iter().for_each(|c| c.cancel());
        tokio::spawn(async move {
            while !st.inner.lock().unwrap().running.is_empty() { tokio::time::sleep(Duration::from_millis(50)).await }
            chat(msg, conv).await
        });
    } else {
        tokio::spawn(chat(msg, conv));
    }
    Ok(None)
}

// One chat turn, shaped like pen.dev's: attached skills, the app state prefetched into the prompt, and the "Nx"
// parallel setting — split (one agent divides the work with spawn_agents) or side-by-side (N variations).
async fn chat(req: Value, id: String) {
    let Some(f) = file_str() else { return };
    let st = state_of(&id, &f);
    let shown = if req["shown"].is_string() { &req["shown"] } else { &req["prompt"] };
    let names: Vec<_> = req["files"].as_array().map(|a| a.iter().map(|f| f["name"].clone()).collect()).unwrap_or_default();
    chats::append(&f, &json!({ "kind": "user", "text": shown, "files": names, "images": req["images"].as_array().map_or(0, |a| a.len()), "context": req["context"], "skills": req["skills"].as_array().cloned().unwrap_or_default() }), Some(&id));
    // this turn's user message: handoffs cover what came before
    let until = chats::by_id(&f, &id).and_then(|c| c["messages"].as_array().map(|m| m.len())).unwrap_or(1).saturating_sub(1);
    let (attached, docs) = attach_files(req["files"].as_array().map(Vec::as_slice).unwrap_or(&[]));
    let skill_names = strings(&req["skills"]);
    let picked = st.inner.lock().unwrap().picked.take().map(|p| format!("{p}\n\n")).unwrap_or_default();
    let mut prompt = with_skills(format!("{picked}{}{attached}", req["prompt"].as_str().unwrap_or("")), &skill_names, &id) + &design_rules(&req);
    let mut req = req.clone();
    req.as_object_mut().map(|o| o.remove("files"));
    let mut last = req.clone();
    last["prompt"] = json!(format!("{}{attached}", req["prompt"].as_str().unwrap_or("")));
    req["docs"] = json!(docs);
    st.inner.lock().unwrap().last_chat = last; // spawned agents get the text (in their prompts), not the PDFs again
    let state = tools::call(app().tools.get().unwrap(), "get_app_state", json!({})).await;
    if let Some(text) = state["content"][0]["text"].as_str() {
        prompt += &format!("\n\nYou are inside the Pena app, in this chat: the user is already here, looking at the canvas.\nCurrent app state (fetched right before this turn; no need to call get_app_state first):\n{text}");
    }
    let n = req["agents"].as_u64().unwrap_or(1).clamp(1, 8) as usize;
    let provider = req["provider"].as_str().unwrap_or("claude").to_string();
    let main = || st.inner.lock().unwrap().main.entry(provider.clone()).or_default().clone();
    if n > 1 && req["parallel"] == "side-by-side" {
        let before = app().store.doc()["children"].as_array().map(|c| c.iter().filter_map(|c| c["id"].as_str().map(String::from)).collect()).unwrap_or_default();
        {
            let mut i = st.inner.lock().unwrap();
            i.spawn_budget = 0;
            i.split = None;
            i.variations = Some(Variations { before, list: vec![] });
        }
        for i in 1..=n {
            let session: Sess = if i == 1 { main() } else { Default::default() };
            let (agent, _) = ensure_profile(&st, &session).await;
            let mut r = req.clone();
            r["prompt"] = json!(format!("{prompt}\n\nYou are designer {i} of {n} working at the same time on this same request; each creates an independent VARIATION. Make your own top-level frame named with \" — Variação {i}\" at FindEmptySpace (other designers are placing theirs too), explore a direction distinct from a typical solution, and never touch other designers' frames."));
            tokio::spawn(run_turn(r, session.clone(), until, st.clone(), RunOpts { variation: Some(i), ..Default::default() }, false));
            if let Some(v) = st.inner.lock().unwrap().variations.as_mut() { v.list.push(Variation { i, agent, session, provider: provider.clone() }) }
        }
        return;
    }
    let round = (n > 1).then(|| Arc::new(Split { kids: Mutex::default() }));
    {
        let mut i = st.inner.lock().unwrap();
        i.spawn_budget = n - 1;
        i.split = round.clone();
    }
    if round.is_some() {
        prompt = format!("Do this task by splitting the work across at most {} extra designer agent{} with the spawn_agents tool, besides you. First set up what every part shares: the variables (colors, typography, spacing, radii) and the reusable components (header, buttons, cards, inputs...). Then create the container frames, spawn the agents for the other parts — telling each which variables and components to build with, so the parts look like one design — and design the last part yourself. When they are all done you will get a turn to review the whole thing, so don't wait for them.\n\n{prompt}", n - 1, if n > 2 { "s" } else { "" });
    }
    let session = main();
    let mut r = req.clone();
    r["prompt"] = json!(prompt);
    let end = run_turn(r, session.clone(), until, st.clone(), RunOpts::default(), false).await;
    let Some(round) = round else { return };
    let kids: Vec<_> = round.kids.lock().unwrap().drain(..).collect();
    if kids.is_empty() { return }
    let ends: Vec<Value> = futures::future::join_all(kids).await.into_iter().map(|r| r.unwrap_or_default()).collect();
    // a new turn or a stop since then cancels the review
    {
        let mut i = st.inner.lock().unwrap();
        if !i.split.as_ref().is_some_and(|s| Arc::ptr_eq(s, &round)) || end["reason"] != "finished" || ends.iter().any(|e| e["reason"] == "stopped") { return }
        i.split = None;
    }
    let mut r = req.clone();
    r["images"] = json!([]);
    r["docs"] = json!([]);
    r["prompt"] = json!("The designer agents you spawned have finished. Review the whole design as one: TakeScreenshot of every part, compare them, and fix what diverges between parts — colors, typography, spacing, alignment, components redrawn instead of reused, leftover placeholder: true. Keep each part's content; only make them consistent. Reply in a sentence or two.");
    run(r, session, st, RunOpts::default()).await;
}

// spawn_agents: extra agents with the chat's provider/model/effort, each confined to its container nodes. Limited by
// the "Nx" setting; spawned agents can't spawn more (their budget is the chat's, already spent). Each gets the user's
// whole request and the attached skills. `ctx.conv` comes from the MCP env (PENA_CONV): the right chat even when
// others run in the background.
pub fn spawn(config: Value, ctx: CallCtx) -> String {
    let st = ctx.conv.as_deref().and_then(|c| LIVE.lock().unwrap().get(c).cloned()).or_else(current_state);
    let Some(st) = st else { return "Open the chat you want to split across agents.".into() };
    let config = config.as_array().cloned().unwrap_or_default();
    let (accepted, last, parent, split) = {
        let mut i = st.inner.lock().unwrap();
        if i.spawn_budget == 0 { return "Parallel agents are off for this request (1x). Do the whole task yourself, without spawn_agents.".into() }
        let accepted: Vec<Value> = config.iter().take(i.spawn_budget).cloned().collect();
        i.spawn_budget -= accepted.len();
        let last = i.last_chat.clone();
        let provider = last["provider"].as_str().unwrap_or("claude").to_string();
        let parent = i.main.get(&provider).and_then(|s| s.try_lock().ok().and_then(|s| s.profile.as_ref().and_then(|p| p["name"].as_str().map(String::from))));
        (accepted, last, parent, i.split.clone())
    };
    for a in &accepted {
        let containers = strings(&a["containerNodes"]).join(", ");
        let brief = format!("{}\n\nThe user's whole request, for context (your part is only the one above):\n<request>\n{}\n</request>", a["prompt"].as_str().unwrap_or(""), last["prompt"].as_str().unwrap_or(""));
        let mut r = last.clone();
        r["skills"] = json!([]);
        r["prompt"] = json!(format!("{}\n\nWork ONLY inside these nodes: {containers}. Other agents are editing the rest of the document in parallel; never touch nodes outside your containers. Use the document's variables and reusable components instead of redrawing them. Do not call spawn_agents. Remove placeholder: true from your containers when done.{}", with_skills(brief, &strings(&last["skills"]), &st.id), design_rules(&last)));
        let kid = tokio::spawn(run(r, Default::default(), st.clone(), RunOpts { parent: parent.clone(), ..Default::default() }));
        if let Some(s) = &split { s.kids.lock().unwrap().push(kid) }
    }
    let dropped = config.len() - accepted.len();
    let waiting = st.slots.waiting();
    format!("Spawned {} designer agent(s); they are working in parallel now{}. Do your own part.{}", accepted.len(),
        if waiting > 0 { format!(" ({} at a time: {waiting} start as others finish)", st.slots.max()) } else { String::new() },
        if dropped > 0 { format!(" {dropped} request(s) over the limit were not started — do those parts yourself.") } else { String::new() })
}

// The user picked a side-by-side variation: delete the others and keep chatting with the agent that made it.
pub fn pick_variation(agent: &str) -> Value {
    let Some(st) = current_state() else { return json!({ "error": "Essa rodada de variações não está mais ativa." }) };
    let mut i = st.inner.lock().unwrap();
    let Some(vs) = i.variations.as_ref() else { return json!({ "error": "Essa rodada de variações não está mais ativa." }) };
    let Some(v) = vs.list.iter().find(|x| x.agent == agent) else { return json!({ "error": "Essa rodada de variações não está mais ativa." }) };
    if !i.running.is_empty() { return json!({ "error": "Espere todas as variações terminarem." }) }
    static VAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)Variação\s*(\d+)\s*$").unwrap());
    let others: Vec<String> = app().store.doc()["children"].as_array().cloned().unwrap_or_default().into_iter().filter(|c| {
        let id = c["id"].as_str().unwrap_or("");
        VAR.captures(c["name"].as_str().unwrap_or("")).is_some_and(|m| m[1].parse::<usize>().ok() != Some(v.i) && !vs.before.contains(id))
    }).filter_map(|c| c["id"].as_str().map(String::from)).collect();
    if !others.is_empty() {
        let input = others.iter().map(|id| format!("Delete({})", json!(id))).collect::<Vec<_>>().join("\n");
        let _ = app().store.execute(&json!({ "input": input }), &json!({}));
    }
    let (provider, session, n) = (v.provider.clone(), v.session.clone(), v.i);
    if let Ok(s) = session.try_lock() { match pena_agents::native_session(&provider, &s) { Some(id) => { i.natives.insert(provider.clone(), id); } None => {} } }
    i.main.insert(provider, session);
    i.picked = Some(format!("The user chose your variation ({n}); the other variations were deleted. Keep working on your design."));
    i.variations = None;
    drop(i);
    save_sessions(&st);
    json!({ "ok": true, "deleted": others.len() })
}

// read_chat reads the conversation of the agent that called it (PENA_CONV), not whichever chat is on screen.
pub fn read_chat_tool(args: Value, ctx: CallCtx) -> String {
    let st = ctx.conv.as_deref().and_then(|c| LIVE.lock().unwrap().get(c).cloned()).or_else(current_state);
    let messages = st.and_then(|st| chats::by_id(&st.file, &st.id)).or_else(|| file_str().and_then(|f| chats::current(&f, false)))
        .and_then(|c| c["messages"].as_array().cloned()).unwrap_or_default();
    handoff::read_chat(&messages, args["from"].as_i64(), args["to"].as_i64())
}
