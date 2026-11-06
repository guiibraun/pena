// The server the editor talks to (port of server.mjs minus the agents, which are in chat.rs): the open document,
// SSE, the editor's HTTP API, rendering, the dashboard library, settings and the remote MCP.
use crate::{chat, mcp};
use anyhow::{Result, anyhow, bail};
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderValue, Method, Request, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use pena_core::{Store, expand, tools};
use pena_render::Renderer;
use pena_state::{chats, fonts, library, settings, skills};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, utf8_percent_encode};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, oneshot};

pub struct App {
    pub port: OnceLock<u16>,
    pub file: RwLock<Option<PathBuf>>, // the open .pen; switchable at runtime (File > Open)
    // The open document lives in memory: the editor, the agents and the file watcher all go through the store, which
    // writes the file behind them and announces what changed (SSE `patch`).
    pub store: Store,
    sse: broadcast::Sender<(String, String)>,
    clients: AtomicUsize,
    editor_ready: AtomicBool, // an editor finished loading the document (posts /ready); false when the last one leaves
    editor_state: Mutex<Value>,
    renders: Mutex<HashMap<u64, oneshot::Sender<Result<Vec<Value>, String>>>>,
    render_seq: AtomicU64,
    renderer: Mutex<Renderer>,
    rects: Mutex<Option<(u64, Value)>>, // rects() by store revision
    pub mcp_state: Mutex<Value>,
    kept_figma: Mutex<Option<Value>>, // a dashboard Figma import waiting for the editor
    focused_at: AtomicU64,
    pub tools: OnceLock<tools::Env>,
    claude_models: Mutex<HashMap<String, Vec<Value>>>,
    opencode_models: Mutex<Option<Vec<Value>>>,
    jwks: Mutex<Option<jsonwebtoken::jwk::JwkSet>>,
    pub http: reqwest::Client,
}

static APP: OnceLock<App> = OnceLock::new();
pub fn app() -> &'static App { APP.get().expect("app started") }

pub fn now_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64 }
pub fn file() -> Option<PathBuf> { app().file.read().unwrap().clone() }
pub fn port() -> u16 { *app().port.get().unwrap_or(&0) }

// --- server-sent events: document changes + agent stream -----------------------------------------------------------
pub fn emit(event: &str, data: Value) {
    let _ = app().sse.send((event.to_string(), data.to_string()));
    if event == "agent" { chat::remember(&data) }
}

struct Client;
impl Drop for Client {
    fn drop(&mut self) {
        if app().clients.fetch_sub(1, Ordering::SeqCst) == 1 { app().editor_ready.store(false, Ordering::SeqCst) }
    }
}
fn events() -> Response {
    app().clients.fetch_add(1, Ordering::SeqCst);
    let guard = Client;
    let rx = tokio_stream::wrappers::BroadcastStream::new(app().sse.subscribe());
    use futures::StreamExt;
    let stream = rx.filter_map(move |m| {
        let _keep = &guard; // the client counts as connected while its stream lives
        futures::future::ready(m.ok().map(|(e, d)| Ok::<_, std::convert::Infallible>(Event::default().event(e).data(d))))
    });
    // proxies (Cloudflare) drop a stream that stays silent for ~100 s
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(30)).text("ping")).into_response()
}

// --- files ---------------------------------------------------------------------------------------------------------
/// path.resolve(): absolute and with `..` folded, without touching the disk.
pub fn resolve(base: &Path, rel: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for c in base.join(rel).components() {
        match c {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}
fn home_path(p: &str) -> PathBuf {
    let p = if let Some(rest) = p.strip_prefix("~/") { pena_state::home().join(rest).to_string_lossy().into_owned() } else { p.to_string() };
    resolve(&std::env::current_dir().unwrap_or_default(), &p)
}
fn public() -> PathBuf { pena_core::root().join("public") }

// Image fills and shaders use paths relative to the .pen file (pen.dev convention).
fn asset_bytes(rel: &str) -> Option<Vec<u8>> {
    let f = file()?;
    let base = f.parent()?.to_path_buf();
    let p = resolve(&base, rel);
    if p.starts_with(&base) && p != base && p.is_file() { return std::fs::read(p).ok() }
    // files made in pen.dev point at its built-in library (goodies/...): read it from the local Pen install
    (rel.starts_with("goodies/") && !rel.split('/').any(|s| s == "..")).then(|| library::pen_app_file(&format!("out/editor/{rel}"))).flatten()
}
// Icon libraries (see ICON_DIRS in public/render.js), from node_modules. Material Symbols files carry no fill: give
// them currentColor, like the others, so the canvas can recolor them.
fn icon_bytes(path: &str) -> Option<Vec<u8>> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"^/icons/(lucide-static/icons|feather-icons/dist/icons|@phosphor-icons/core/assets/regular|@material-symbols/svg-400/(outlined|rounded|sharp))/[\w-]+\.svg$").unwrap());
    if !re.is_match(path) { return None }
    let svg = std::fs::read_to_string(pena_core::root().join("node_modules").join(&path[7..])).ok()?;
    Some(if svg.contains("currentColor") { svg } else { svg.replacen("<svg", "<svg fill=\"currentColor\"", 1) }.into_bytes())
}
/// Run a future from sync code (the renderer's fetch, tool callbacks), on or off a runtime worker.
pub fn block<F: std::future::Future>(f: F) -> F::Output { tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(f)) }

// What the native renderer fetches: the same urls the browser editor would.
fn fetch_asset(url: &str) -> Option<Vec<u8>> {
    let dec = |s: &str| percent_decode_str(s).decode_utf8_lossy().into_owned();
    if let Some(rel) = url.strip_prefix("/asset/") { return asset_bytes(&dec(rel)) }
    if url.starts_with("/icons/") { return icon_bytes(&dec(url)) }
    if let Some(q) = url.strip_prefix("/fonts/faces?") {
        let family = url::form_urlencoded::parse(q.as_bytes()).find(|(k, _)| k == "family").map(|(_, v)| v.into_owned()).unwrap_or_default();
        return block(fonts::faces(&family)).ok().map(|v| serde_json::to_vec(&v).unwrap_or_default());
    }
    if let Some(t) = url.strip_prefix("/fonts/file/") { return block(fonts::file(t)).ok() }
    if url.starts_with("/shaders/") { return std::fs::read(public().join(dec(&url[1..]))).ok() }
    if url.starts_with("http://") || url.starts_with("https://") {
        return block(async { app().http.get(url).timeout(Duration::from_secs(15)).send().await.ok()?.error_for_status().ok()?.bytes().await.ok() }).map(|b| b.to_vec());
    }
    if let Some(d) = url.strip_prefix("data:") {
        let (meta, data) = d.split_once(',')?;
        use base64::Engine;
        return if meta.ends_with(";base64") { base64::engine::general_purpose::STANDARD.decode(data).ok() } else { Some(dec(data).into_bytes()) };
    }
    None
}

// --- rendering -----------------------------------------------------------------------------------------------------
// PNG/JPEG/WebP (every screenshot) are drawn here with native Skia; SVG/PDF/HTML/.fig exports need the browser editor.
const RASTER: [&str; 4] = ["png", "jpg", "jpeg", "webp"];
pub async fn render(job: Value) -> Result<Vec<Value>> {
    let format = job["format"].as_str().unwrap_or("png").to_string();
    if RASTER.contains(&format.as_str()) && file().is_some() {
        let ids: Vec<String> = job["ids"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        let scale = job["options"]["scale"].as_f64().unwrap_or(2.0) as f32;
        let quality = job["options"]["quality"].as_u64().unwrap_or(92) as u32;
        let r = tokio::task::spawn_blocking(move || {
            // only the layers holding the ids are expanded and laid out, not the whole document
            let (doc, lib, _) = app().store.snapshot();
            let index = expand::Index::new(&doc, &lib);
            let mut layers: Vec<&Value> = vec![];
            for l in ids.iter().filter_map(|id| index.root_of(id)) {
                if !layers.iter().any(|x| std::ptr::eq(*x, l)) { layers.push(l) }
            }
            let roots: Vec<Value> = layers.into_iter().filter(|l| l["type"] != "connection").map(|l| expand::expand_node(l, &index, "", 0)).collect();
            app().renderer.lock().unwrap().render(&render_meta(&doc, &lib), &Value::Array(roots), &ids, &format, scale, quality, &fetch_asset)
        }).await?;
        match r {
            Ok(v) => return Ok(v),
            Err(e) if e.to_string().starts_with("Node not found") => return Err(e),
            Err(e) if !app().editor_ready.load(Ordering::SeqCst) => return Err(e),
            Err(e) => eprintln!("Pena: server render failed, using the editor: {e:#}"),
        }
    }
    if !app().editor_ready.load(Ordering::SeqCst) { bail!("Open the Pena editor in a browser to render screenshots/exports.") }
    let req_id = app().render_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let (tx, rx) = oneshot::channel();
    app().renders.lock().unwrap().insert(req_id, tx);
    let mut msg = job.clone();
    msg["reqId"] = json!(req_id);
    emit("render", msg);
    match tokio::time::timeout(Duration::from_secs(60), rx).await {
        Ok(Ok(r)) => r.map_err(|e| anyhow!(e)),
        _ => { app().renders.lock().unwrap().remove(&req_id); bail!("Render timed out (is the editor open?)") }
    }
}
// Laid-out size of each top-level frame, for the agents' FindEmptySpace (the store has no layout of its own). Laying
// out the whole document took seconds on a big file and every execute asks: kept until the document changes.
// ponytail: a font or image that arrives later (sizes change) shows only after the next edit.
fn rects() -> Value {
    if file().is_none() { return json!({}) }
    let (doc, lib, rev) = app().store.snapshot();
    if let Some((r, v)) = &*app().rects.lock().unwrap() { if *r == rev { return v.clone() } }
    let (index, meta) = (expand::Index::new(&doc, &lib), render_meta(&doc, &lib));
    let mut renderer = app().renderer.lock().unwrap();
    let mut sizes = serde_json::Map::new();
    // one layer at a time: the whole document expanded at once is hundreds of MB on a big file
    for layer in expand::layers(&doc) {
        let root = Value::Array(vec![expand::expand_node(layer, &index, "", 0)]);
        if let Value::Object(m) = renderer.root_sizes(&meta, &root, &fetch_asset) { sizes.extend(m) }
    }
    let v = Value::Object(sizes);
    *app().rects.lock().unwrap() = Some((rev, v.clone()));
    v
}
// What the renderer reads of the document besides its layers (variables, themes, fonts, and the libraries' variables
// and themes as "_lib"): passed instead of the whole document.
fn render_meta(doc: &Value, lib: &Value) -> Value {
    let mut m: serde_json::Map<String, Value> = ["variables", "themes", "fonts"].iter().filter_map(|k| doc.get(*k).map(|v| (k.to_string(), v.clone()))).collect();
    m.insert("_lib".into(), json!({ "variables": lib.get("variables"), "themes": lib.get("themes") }));
    Value::Object(m)
}

// --- open document -------------------------------------------------------------------------------------------------
// Switch the open document (File > Open / New). Agent conversations are per document.
pub fn open(path: &str) -> Result<PathBuf> {
    let file = home_path(path);
    if !file.exists() { pena_core::save(&file, &pena_core::empty())? }
    app().store.open(&file)?; // writes what is pending to the previous file first; fails (changing nothing) if not a document
    *app().file.write().unwrap() = Some(file.clone());
    // its images and fonts live next to it: a fresh renderer never draws the previous file's assets for this one's urls
    *app().renderer.lock().unwrap() = Renderer::new();
    let _ = library::record_opened(&file.to_string_lossy());
    emit("file", json!({ "name": file.file_name().map(|n| n.to_string_lossy()), "path": file }));
    Ok(file)
}

// Polling, like watchFile: survives the atomic rename of a write. Only for other apps: our own writes are recognized by
// their mtime. The file wins over memory (if changes are waiting to be written, flush() merges them with the file).
async fn watch() {
    let mut seen: Option<(PathBuf, SystemTime)> = None;
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some(f) = file() else { continue };
        let Ok(mtime) = std::fs::metadata(&f).and_then(|m| m.modified()) else { continue };
        let changed = matches!(&seen, Some((p, t)) if *p == f && *t != mtime);
        seen = Some((f.clone(), mtime));
        if !changed || Some(mtime) == app().store.own_write() { continue }
        let store = app().store.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if store.pending() { return store.flush() }
            // half written: the next change retries
            match store.reload() { Ok(()) => emit("doc", json!({})), Err(e) => eprintln!("Pena: {} changed on disk but cannot be read: {e}", f.display()) }
        }).await;
    }
}

// --- design-tool health --------------------------------------------------------------------------------------------
// The design tools are a separate MCP process the agent's CLI spawns. When it doesn't come up, the turn runs with no
// design tools at all. Prove the connection end to end, and let the UI show that instead of failing silently.
pub fn launch_json() -> Value {
    let l = settings::pena_launch();
    json!({ "command": l.command, "args": l.args, "env": l.env })
}
pub async fn mcp_check(reset: bool) -> Value {
    let fixed = settings::repair_integrations().await;
    let r = settings::test_mcp(&launch_json()).await;
    let ok = r["ok"].as_bool().unwrap_or(false);
    let state = json!({ "ok": ok, "tools": r["tools"].as_array().map_or(0, |t| t.len()), "error": if ok { Value::Null } else { r["error"].clone() }, "fixed": fixed, "at": now_ms() });
    // A CLI session keeps the tool list it started with: dropping the saved sessions makes the next turn start a new
    // one; the handoff still gives it the whole conversation. That is "start a new chat" without losing the chat.
    if reset && ok { chat::forget_sessions() }
    *app().mcp_state.lock().unwrap() = state.clone();
    emit("mcp", state.clone());
    state
}

// --- remote MCP ----------------------------------------------------------------------------------------------------
// The same tools over HTTP (`/mcp`), for agents on other machines when Pena is hosted. Off unless PENA_TOKEN or the
// Access settings are set. With PENA_TOKEN, a request carries `Authorization: Bearer <PENA_TOKEN>`. Or, behind
// Cloudflare Access with Managed OAuth: the JWT Access adds, checked against the team's keys and the app's AUD tag.
const REMOTE_HINT: &str = "Hosted Pena: one document is open at a time, for the browser and every agent. To work on another file, pass its absolute path on the server as filePath (get_app_state shows the open one); that switches the open document, and a path that does not exist yet creates a new .pen there.";
fn env_var(k: &str) -> Option<String> { std::env::var(k).ok().filter(|v| !v.is_empty()) }
fn token_ok(h: &HeaderMap) -> bool {
    let Some(token) = env_var("PENA_TOKEN") else { return false };
    use sha2::{Digest, Sha256};
    let got = Sha256::digest(h.get(header::AUTHORIZATION).map(|v| v.as_bytes()).unwrap_or_default());
    let want = Sha256::digest(format!("Bearer {token}"));
    got.iter().zip(want.iter()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0 // constant time
}
async fn access_ok(h: &HeaderMap) -> bool {
    let (Some(team), Some(aud), Some(jwt)) = (env_var("PENA_ACCESS_TEAM"), env_var("PENA_ACCESS_AUD"), h.get("cf-access-jwt-assertion").and_then(|v| v.to_str().ok())) else { return false };
    let Ok(head) = jsonwebtoken::decode_header(jwt) else { return false };
    let kid = head.kid.unwrap_or_default();
    // the team's keys, fetched again when a token names one we don't have (Access rotates them)
    let mut key = app().jwks.lock().unwrap().as_ref().and_then(|s| s.find(&kid).cloned());
    if key.is_none() {
        let url = format!("https://{team}.cloudflareaccess.com/cdn-cgi/access/certs");
        let Ok(Ok(set)) = (async { app().http.get(&url).send().await?.json::<jsonwebtoken::jwk::JwkSet>().await }).await.map(Ok::<_, ()>) else { return false };
        key = set.find(&kid).cloned();
        *app().jwks.lock().unwrap() = Some(set);
    }
    let Some(Ok(dk)) = key.map(|k| jsonwebtoken::DecodingKey::from_jwk(&k)) else { return false };
    let mut v = jsonwebtoken::Validation::new(head.alg);
    v.set_audience(&[aud]);
    v.set_issuer(&[format!("https://{team}.cloudflareaccess.com")]);
    jsonwebtoken::decode::<Value>(jwt, &dk, &v).is_ok()
}
fn tool_error(msg: &str) -> Value { json!({ "content": [{ "type": "text", "text": msg }], "isError": true }) }
async fn remote_call(name: String, args: Value) -> Value {
    if let Some(fp) = args["filePath"].as_str() {
        if Some(resolve(Path::new("/"), fp)) != file() {
            if !fp.ends_with(".pen") { return tool_error("filePath must be a .pen file") }
            if let Err(e) = open(fp) { return tool_error(&format!("Cannot open {fp}: {e}")) }
        }
    }
    if file().is_none() { return tool_error("No document open: pass filePath, or open a .pen in the Pena dashboard.") }
    tools::call(app().tools.get().unwrap(), &name, args).await
}
// rmcp's streamable HTTP, stateless with JSON answers: every request stands alone; the document lives in the store
// either way. Host checks off: behind the tunnel the Host is your own domain, and the token/Access check guards it.
type McpHttp = rmcp::transport::streamable_http_server::StreamableHttpService<mcp::Pena, rmcp::transport::streamable_http_server::session::local::LocalSessionManager>;
async fn remote_mcp(req: Request<Body>) -> Response {
    use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
    if env_var("PENA_TOKEN").is_none() && !(env_var("PENA_ACCESS_TEAM").is_some() && env_var("PENA_ACCESS_AUD").is_some()) { return StatusCode::NOT_FOUND.into_response() }
    if !(token_ok(req.headers()) || access_ok(req.headers()).await) { return (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")], "Unauthorized").into_response() }
    static SVC: OnceLock<McpHttp> = OnceLock::new();
    let svc = SVC.get_or_init(|| {
        let handler = mcp::Pena { call: Arc::new(|name, args, _| Box::pin(remote_call(name, args))), instructions: Some(REMOTE_HINT) };
        let config = StreamableHttpServerConfig::default().with_legacy_session_mode(false).with_json_response(true).with_sse_keep_alive(None).disable_allowed_hosts();
        StreamableHttpService::new(move || Ok(handler.clone()), Default::default(), config)
    }).clone();
    use tower::ServiceExt;
    match svc.oneshot(req).await { Ok(r) => r.map(Body::new), Err(e) => status(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()) }
}

// --- model catalogs: read from your own accounts, never hardcoded ---------------------------------------------------
fn str_env(m: std::collections::HashMap<String, String>) -> std::collections::BTreeMap<String, String> { m.into_iter().collect() }
// One catalog per account: an extra account that isn't logged in yet borrows the default account's list.
async fn claude_models(acc: &Value) -> Result<Vec<Value>> {
    let id = acc["id"].as_str().unwrap_or("claude").to_string();
    if let Some(m) = app().claude_models.lock().unwrap().get(&id) { return Ok(m.clone()) }
    match pena_agents::list_claude_models(Path::new(settings::claude_bin()), &str_env(settings::account_env(acc))).await {
        Ok(m) => { app().claude_models.lock().unwrap().insert(id, m.clone()); Ok(m) }
        Err(_) if id != "claude" => Box::pin(claude_models(&settings::account_of("claude").unwrap_or_default())).await,
        Err(_) => bail!("Claude não conectado"),
    }
}
// Codex: the CLI caches your account's model list (with per-model reasoning levels) after `codex login`.
fn codex_models(acc: &Value) -> Vec<Value> {
    let home = acc["env"]["CODEX_HOME"].as_str().map(PathBuf::from).unwrap_or_else(settings::codex_home);
    let list = pena_agents::list_codex_models(&home);
    if list.is_empty() && acc["id"] != "codex" { return codex_models(&settings::account_of("codex").unwrap_or_default()) }
    list
}
async fn opencode_models() -> Result<Vec<Value>> {
    if let Some(m) = app().opencode_models.lock().unwrap().clone() { return Ok(m) }
    let m = pena_agents::list_opencode_models(Path::new(settings::opencode_bin())).await?;
    *app().opencode_models.lock().unwrap() = Some(m.clone());
    Ok(m)
}

// --- http ----------------------------------------------------------------------------------------------------------
fn mime(p: &str) -> &'static str {
    match Path::new(p).extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("html") => "text/html", Some("js") => "text/javascript", Some("css") => "text/css", Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg", Some("webp") => "image/webp", Some("gif") => "image/gif", Some("svg") => "image/svg+xml",
        Some("glsl") => "text/plain; charset=utf-8", Some("json") => "application/json", Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}
fn json_res(v: Value) -> Response { ([(header::CONTENT_TYPE, "application/json")], v.to_string()).into_response() }
fn bytes_res(ct: &str, cache: &str, b: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, ct.to_string()), (header::CACHE_CONTROL, cache.to_string())], b).into_response()
}
fn ok() -> Response { "ok".into_response() }
fn status(code: StatusCode, msg: &str) -> Response { (code, msg.to_string()).into_response() }
// encodeURIComponent
const URI: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
pub fn enc(s: &str) -> String { utf8_percent_encode(s, URI).to_string() }
fn parse(body: &[u8]) -> Result<Value> { Ok(if body.is_empty() { json!({}) } else { serde_json::from_slice(body)? }) }

// Saves next to the .pen (images/, shaders/) and returns the relative url. A file with the same name and bytes is
// reused (adding the same library shader twice); a different one gets a free name.
pub fn save_asset(folder: &str, name: &str, data: &[u8]) -> Result<String> {
    let dir = file().ok_or_else(|| anyhow!("No document open"))?.parent().unwrap().join(folder);
    std::fs::create_dir_all(&dir)?;
    static BAD: OnceLock<regex::Regex> = OnceLock::new();
    let name = BAD.get_or_init(|| regex::Regex::new(r"[^\w.-]+").unwrap()).replace_all(Path::new(name).file_name().and_then(|n| n.to_str()).unwrap_or("file"), "-").into_owned();
    let mut target = dir.join(&name);
    let mut i = 2;
    while target.exists() && std::fs::read(&target).ok().as_deref() != Some(data) {
        target = dir.join(match name.rsplit_once('.') { Some((s, e)) => format!("{s}-{i}.{e}"), None => format!("{name}-{i}") });
        i += 1;
    }
    std::fs::write(&target, data)?;
    Ok(format!("./{folder}/{}", target.file_name().unwrap().to_string_lossy()))
}
fn save_image(name: &str, data: &[u8]) -> String { save_asset("images", name, data).unwrap_or_default() }

pub async fn handle(req: Request<Body>) -> Response {
    if req.uri().path() == "/mcp" { return remote_mcp(req).await }
    let (parts, body) = req.into_parts();
    let raw_path = parts.uri.path().to_string();
    let path = percent_decode_str(&raw_path).decode_utf8_lossy().into_owned();
    let q: HashMap<String, String> = parts.uri.query().map(|q| url::form_urlencoded::parse(q.as_bytes()).into_owned().collect()).unwrap_or_default();
    let body = axum::body::to_bytes(body, 1 << 30).await.unwrap_or_default();
    match route(&parts.method, &path, &q, &parts.headers, body).await {
        Ok(r) => r,
        Err(e) => status(StatusCode::BAD_REQUEST, &e.to_string()),
    }
}

async fn route(m: &Method, url: &str, q: &HashMap<String, String>, _h: &HeaderMap, body: Bytes) -> Result<Response> {
    let get = m == Method::GET;
    let post = m == Method::POST;
    let has_file = file().is_some();
    let qs = |k: &str| q.get(k).cloned().unwrap_or_default();
    if get && url == "/" && !has_file { return Ok((StatusCode::FOUND, [(header::LOCATION, "/dashboard")]).into_response()) }
    static UI: OnceLock<regex::Regex> = OnceLock::new();
    if get && (url == "/" || url == "/dashboard" || UI.get_or_init(|| regex::Regex::new(r"^/[\w-]+\.(js|html|css|svg)$").unwrap()).is_match(url)) {
        let f = match url { "/" => "index.html".into(), "/dashboard" => "dashboard.html".into(), u => u[1..].to_string() };
        // always revalidate the UI so updates show up
        return Ok(bytes_res(&format!("{}; charset=utf-8", mime(&f)), "no-cache", std::fs::read(public().join(&f))?));
    }
    if get && url.starts_with("/icons/") {
        return Ok(icon_bytes(url).map_or_else(|| StatusCode::NOT_FOUND.into_response(), |b| bytes_res("image/svg+xml", "public, max-age=86400", b)));
    }
    // Skia (CanvasKit) for the browser's canvas renderer.
    if get && (url == "/vendor/canvaskit.js" || url == "/vendor/canvaskit.wasm") {
        let f = pena_core::root().join("node_modules/canvaskit-wasm/bin").join(&url[8..]);
        return Ok(bytes_res(mime(url), "public, max-age=86400", std::fs::read(f)?));
    }
    // Imported libraries (`imports` in the .pen), relative to the open file; only .pen files.
    if get && url == "/import" && has_file {
        let f = resolve(file().unwrap().parent().unwrap(), &qs("path"));
        if !f.to_string_lossy().ends_with(".pen") || !f.exists() { return Ok(StatusCode::NOT_FOUND.into_response()) }
        return Ok(bytes_res("application/json", "no-store", std::fs::read(f)?));
    }
    if get && url.starts_with("/asset/") {
        return Ok(match asset_bytes(&url[7..]) { Some(b) => bytes_res(mime(url), "no-cache", b), None => StatusCode::NOT_FOUND.into_response() });
    }
    // Pena's shader library (public/shaders): listed in library.json; adding one copies it next to the .pen
    static SH: OnceLock<regex::Regex> = OnceLock::new();
    if get && SH.get_or_init(|| regex::Regex::new(r"^/shaders/[\w-]+\.(glsl|json)$").unwrap()).is_match(url) {
        return Ok(bytes_res(mime(url), "no-cache", std::fs::read(public().join(&url[1..]))?));
    }
    if url == "/shader-copy" && post && has_file {
        let name = qs("name");
        let src = public().join("shaders").join(format!("{name}.glsl"));
        if !regex::Regex::new(r"^[\w-]+$")?.is_match(&name) || !src.exists() { return Ok(status(StatusCode::NOT_FOUND, "Unknown shader")) }
        return Ok(json_res(json!({ "url": save_asset("shaders", &format!("{name}.glsl"), &std::fs::read(src)?)? })));
    }
    // --- dashboard / document library ---
    if url == "/api/recent" { return Ok(json_res(json!({ "current": file(), "recents": library::recents(), "drafts": library::drafts() }))) }
    if url == "/api/browse" { return Ok(json_res(library::browse(q.get("dir").filter(|d| !d.is_empty()).map(|s| s.as_str()))?)) }
    if url == "/preview" {
        return Ok(match library::preview_file(&qs("path")) { Some(f) => bytes_res("image/png", "no-cache", std::fs::read(f)?), None => StatusCode::NOT_FOUND.into_response() });
    }
    if url == "/api/open" && post {
        let f = parse(&body)?["path"].as_str().unwrap_or("").to_string();
        if !f.ends_with(".pen") { return Ok(status(StatusCode::BAD_REQUEST, "Escolha um arquivo .pen")) }
        return Ok(json_res(json!({ "path": open(&f)? })));
    }
    if url == "/api/new" && post {
        let f = match parse(&body)?["path"].as_str() { Some(p) => p.to_string(), None => library::new_draft()?.to_string_lossy().into_owned() };
        return Ok(json_res(json!({ "path": open(&f)? })));
    }
    // A .pen dropped on the dashboard: the webview gives the content, not the path, so it becomes a draft with the same name.
    if url == "/api/import-pen" && post {
        if serde_json::from_slice::<Value>(&body).is_err() { return Ok(status(StatusCode::BAD_REQUEST, "Arquivo .pen inválido")) }
        let name = q.get("name").map(|n| Path::new(n).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()).unwrap_or_else(|| "untitled.pen".into());
        let f = library::new_draft()?.parent().unwrap().join(name);
        std::fs::write(&f, &body)?;
        return Ok(json_res(json!({ "path": open(&f.to_string_lossy())? })));
    }
    if url == "/api/forget" && post { library::forget(parse(&body)?["path"].as_str().unwrap_or(""))?; return Ok(ok()) }
    if url == "/api/preview" && post {
        if let Some(f) = file() { library::save_preview(&f.to_string_lossy(), &body)? }
        return Ok(ok());
    }
    if url == "/fonts/faces" { return Ok(json_res(json!(fonts::faces(&qs("family")).await?))) }
    if let Some(t) = url.strip_prefix("/fonts/file/") { return Ok(bytes_res("font/ttf", "public, max-age=31536000, immutable", fonts::file(t).await?)) }
    if !has_file && (["/doc", "/doc-beacon", "/state"].contains(&url) || url.starts_with("/tool/")) { return Ok(status(StatusCode::CONFLICT, "No document open")) }
    // The document as the server has it (the file may lag a few hundred ms). `x-pena-seq`: the last patch it includes.
    if url == "/doc" && get {
        let f = file().unwrap();
        let mut r = bytes_res("application/json", "no-store", app().store.doc().to_string().into_bytes());
        let hd = r.headers_mut();
        hd.insert("x-pena-name", HeaderValue::from_str(&enc(&f.file_name().unwrap().to_string_lossy()))?);
        hd.insert("x-pena-file", HeaderValue::from_str(&enc(&f.to_string_lossy()))?);
        hd.insert("x-pena-seq", HeaderValue::from(app().store.seq()));
        return Ok(r);
    }
    // Editor saves: only the roots it edited since its last save, the ids it deleted, and the order / meta when they
    // changed. `file`: the document the editor was showing; after File > Open a late save from the old one must not land.
    if (url == "/doc" && m == Method::PUT) || (url == "/doc-beacon" && post) {
        if let Some(sent) = q.get("file") { if Some(PathBuf::from(sent)) != file() { return Ok(status(StatusCode::CONFLICT, "Another document is open")) } }
        return Ok(json_res(json!({ "seq": app().store.put(&parse(&body)?)? })));
    }
    if url == "/chat" && post { return Ok(chat::post(parse(&body)?).await?.map_or_else(ok, json_res)) }
    if url == "/api/variation" && post { return Ok(json_res(chat::pick_variation(parse(&body)?["agent"].as_str().unwrap_or("")))) }
    if url == "/api/current" { return Ok(json_res(json!({ "file": file(), "focusedAt": app().focused_at.load(Ordering::SeqCst) }))) }
    if url == "/api/focus" && post {
        let now = now_ms();
        app().focused_at.store(now, Ordering::SeqCst); // the app's window got focus
        // the user is back: notice, and surface, a design-tool server that died while they were away
        if now.saturating_sub(app().mcp_state.lock().unwrap()["at"].as_u64().unwrap_or(0)) > 60000 { tokio::spawn(mcp_check(false)); }
        return Ok(ok());
    }
    // --- chat history (per open file); every conversation is independent and may keep running in the background ---
    if let Some(f) = file().map(|f| f.to_string_lossy().into_owned()) {
        let b = || parse(&body);
        match url {
            "/api/chats" => {
                let mut l = chats::list(&f);
                if let Some(list) = l["list"].as_array_mut() { for c in list { c["running"] = json!(chat::running_info(c["id"].as_str().unwrap_or("")).len()) } }
                l["groups"] = json!(chats::groups(&f));
                return Ok(json_res(l));
            }
            "/api/chats/current" => return Ok(json_res(match chats::current(&f, false) {
                Some(mut c) => { let id = c["id"].as_str().unwrap_or("").to_string(); c["running"] = json!(chat::running_info(&id)); c["group"] = json!(chats::group_of(&f, Some(&id))); c }
                None => json!({ "messages": [], "running": [], "group": null }),
            })),
            // Groups: a name plus one shared instructions text, injected into every agent of every chat in it.
            "/api/groups/save" if post => { let g = chats::save_group(&f, &b()?)?; return Ok(json_res(json!({ "group": g, "groups": chats::groups(&f) }))) }
            "/api/groups/delete" if post => { chats::remove_group(&f, b()?["id"].as_str().unwrap_or("")); return Ok(json_res(json!({ "groups": chats::groups(&f) }))) }
            "/api/chats/group" if post => {
                let v = b()?;
                let c = chats::set_group(&f, v["id"].as_str().unwrap_or(""), v["group"].as_str())?;
                return Ok(json_res(json!({ "group": chats::group_of(&f, c["id"].as_str()) })));
            }
            "/api/chats/pin" if post => {
                let v = b()?;
                let c = chats::pin(&f, v["id"].as_str().unwrap_or(""), v["pinned"].as_bool().unwrap_or(false))?;
                return Ok(json_res(json!({ "pinned": c["pinned"].as_bool().unwrap_or(false) })));
            }
            // the handoff the next message would carry with this provider/model (the composer shows it before sending)
            "/api/handoff" => return Ok(json_res(chat::handoff_preview(q.get("provider").filter(|p| !p.is_empty()).map_or("claude", |s| s.as_str()), q.get("model").filter(|p| !p.is_empty()).map(|s| s.as_str())).await)),
            // Switching never waits: the other conversation's agents keep running and their events stay in their own chat.
            "/api/chats/select" if post => {
                let mut c = chats::select(&f, b()?["id"].as_str().unwrap_or(""))?;
                c["running"] = json!(chat::running_info(c["id"].as_str().unwrap_or("")));
                return Ok(json_res(c));
            }
            "/api/chats/delete" if post => {
                let id = b()?["id"].as_str().unwrap_or("").to_string();
                chat::drop_chat(&id);
                chats::remove(&f, &id);
                return Ok(json_res(chats::list(&f)));
            }
            _ => {}
        }
    }
    // --- settings (providers, MCP) ---
    match url {
        "/api/mcp/health" => return Ok(json_res(app().mcp_state.lock().unwrap().clone())),
        "/api/mcp/reconnect" if post => return Ok(json_res(mcp_check(true).await)),
        "/api/settings/providers" => return Ok(json_res(settings::provider_status().await)),
        "/api/settings/probe" if post => return Ok(json_res(settings::probe(parse(&body)?["provider"].as_str().unwrap_or("")).await?)),
        "/api/settings/login" if post => {
            let r = settings::open_login_terminal(parse(&body)?["provider"].as_str().unwrap_or("")).await?;
            return Ok(json_res(json!({ "ok": r.ok, "out": r.out, "err": r.err })));
        }
        "/api/settings/accounts" if post => {
            let b = parse(&body)?;
            if let Some(id) = b["remove"].as_str() { settings::remove_account(id)?; return Ok(json_res(json!({ "ok": true }))) }
            return Ok(json_res(settings::add_account(b["provider"].as_str().unwrap_or(""), b["name"].as_str())?));
        }
        "/api/settings/integrations" if get => return Ok(json_res(json!({ "launch": launch_json(), "clients": settings::integrations() }))),
        "/api/settings/integrations" if post => {
            let b = parse(&body)?;
            return Ok(json_res(settings::set_integration(b["id"].as_str().unwrap_or(""), b["on"].as_bool().unwrap_or(false)).await?));
        }
        "/api/settings/integrations/test" if post => {
            let id = parse(&body)?["id"].as_str().unwrap_or("").to_string();
            let c = settings::integrations().into_iter().find(|x| x["id"] == id.as_str());
            let Some(mut entry) = c.map(|c| c["entry"].clone()).filter(|e| !e.is_null()) else { return Ok(json_res(json!({ "ok": false, "error": "Não configurado" }))) };
            entry["env"] = launch_json()["env"].clone();
            return Ok(json_res(settings::test_mcp(&entry).await));
        }
        "/api/settings/agent-mcp" if get => return Ok(json_res(json!({ "text": settings::read_agent_mcp_text() }))),
        "/api/settings/agent-mcp" if post => { settings::write_agent_mcp_text(parse(&body)?["text"].as_str().unwrap_or(""))?; return Ok(json_res(json!({ "ok": true }))) }
        "/api/settings/agent-mcp/test" if post => {
            let name = parse(&body)?["name"].as_str().unwrap_or("").to_string();
            let c = settings::agent_mcp_servers()[&name].clone();
            return Ok(json_res(if c.is_null() { json!({ "ok": false, "error": "Servidor não encontrado" }) } else { settings::test_mcp(&c).await }));
        }
        "/api/skills" => return Ok(json_res(json!(skills::list_skills()))),
        "/api/skills/add" if post => return Ok(json_res(skills::add_skill(parse(&body)?["path"].as_str().unwrap_or(""))?)),
        "/api/skills/remove" if post => { skills::remove_skill(parse(&body)?["path"].as_str().unwrap_or(""))?; return Ok(ok()) }
        _ => {}
    }
    if let (Some(name), true) = (url.strip_prefix("/tool/"), post) {
        return Ok(json_res(tools::call(app().tools.get().unwrap(), name, parse(&body)?).await));
    }
    // Imported images live next to the document (./images/...), like pen.dev's relative image fills.
    if url == "/upload" && post {
        let name = Path::new(q.get("name").map_or("image.png", |s| s.as_str())).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let lower = name.to_lowercase();
        if lower.ends_with(".glsl") || lower.ends_with(".frag") {
            let n = if lower.ends_with(".frag") { format!("{}.glsl", &name[..name.len() - 5]) } else { name };
            return Ok(json_res(json!({ "url": save_asset("shaders", &n, &body)? })));
        }
        if ![".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"].iter().any(|e| lower.ends_with(e)) { return Ok(status(StatusCode::BAD_REQUEST, "Only png, jpg, webp, gif and svg images, or .glsl shaders")) }
        return Ok(json_res(json!({ "url": save_asset("images", &name, &body)? })));
    }
    // Figma: a .fig file or the buffer Figma puts on the clipboard. ?path= reads a local .fig; ?keep=1 holds the result
    // for the editor the dashboard opens next (GET /import-figma/last), too big to hand over in sessionStorage.
    if url == "/import-figma" && post {
        let path = q.get("path").cloned();
        if path.as_ref().is_some_and(|p| !p.to_lowercase().ends_with(".fig")) { return Ok(status(StatusCode::BAD_REQUEST, "Escolha um arquivo .fig")) }
        let bytes = match &path { Some(p) => std::fs::read(p)?, None => body.to_vec() };
        let mut result = tokio::task::spawn_blocking(move || pena_figma::import_figma(&bytes, &mut |n, d| save_image(n, d))).await??;
        // Lato: the document carries Figma's Lato 2.0 (./fonts/), so text measures and wraps as in Figma
        let mut faces = vec![];
        for f in result["faces"].as_array().cloned().unwrap_or_default().iter().filter(|f| f["family"] == "Lato") {
            let Ok((name, data)) = fonts::lato2(f["weight"].as_f64().unwrap_or(400.0), f["italic"].as_bool().unwrap_or(false)).await else { continue };
            if let Some(dir) = file().map(|f| f.parent().unwrap().join("fonts")) {
                std::fs::create_dir_all(&dir)?;
                if !dir.join(&name).exists() { std::fs::write(dir.join(&name), data)? }
            }
            faces.push(json!({ "name": "Lato", "url": format!("./fonts/{name}"), "weight": f["weight"], "style": if f["italic"].as_bool() == Some(true) { "italic" } else { "normal" } }));
        }
        result["fonts"] = json!(faces);
        if q.contains_key("keep") {
            let pages = result["pages"].as_array().map_or(0, |p| p.len());
            *app().kept_figma.lock().unwrap() = Some(result);
            return Ok(json_res(json!({ "pages": pages })));
        }
        return Ok(json_res(result));
    }
    // pen.dev's browser extension: the payload from the paste event or, when the webview can't see it, the OS clipboard
    if url == "/import-browser" && post {
        let payload = if body.is_empty() { pena_figma::read_browser_clipboard() } else { Some(String::from_utf8_lossy(&body).into_owned()) };
        return Ok(match payload {
            Some(p) => json_res(tokio::task::spawn_blocking(move || pena_figma::import_browser_snapshot(&p, &mut |n, d| save_image(n, d))).await??),
            None => StatusCode::NO_CONTENT.into_response(),
        });
    }
    if url == "/import-figma/last" { return Ok(app().kept_figma.lock().unwrap().take().map_or_else(|| StatusCode::NOT_FOUND.into_response(), json_res)) }
    // .fig from the editor's laid-out tree; image fills are read from next to the document (or fetched).
    if url == "/export-figma" && post {
        let b = parse(&body)?;
        let name = file().and_then(|f| f.file_stem().map(|s| s.to_string_lossy().into_owned())).unwrap_or_default();
        use base64::Engine;
        let thumb = b["thumbnail"].as_str().and_then(|t| t.split_once(',')).and_then(|(_, d)| base64::engine::general_purpose::STANDARD.decode(d).ok());
        let fig = tokio::task::spawn_blocking(move || {
            let read = |u: &str| if u.starts_with("http") { fetch_asset(u) } else { file().and_then(|f| std::fs::read(resolve(f.parent().unwrap(), u)).ok()) };
            pena_figma::export_figma(&b["roots"], &name, &read, thumb.as_deref())
        }).await??;
        return Ok(bytes_res("application/zip", "no-store", fig));
    }
    if url == "/state" && post { *app().editor_state.lock().unwrap() = parse(&body)?; return Ok(ok()) }
    if url == "/ready" && post { app().editor_ready.store(true, Ordering::SeqCst); return Ok(ok()) }
    if url == "/rects" && post { return Ok(ok()) } // the server lays out on its own now (rects())
    if url == "/render-result" && post {
        let b = parse(&body)?;
        if let Some(tx) = b["reqId"].as_u64().and_then(|id| app().renders.lock().unwrap().remove(&id)) {
            let _ = tx.send(match b["error"].as_str() { Some(e) => Err(e.to_string()), None => Ok(b["results"].as_array().cloned().unwrap_or_default()) });
        }
        return Ok(ok());
    }
    if url == "/models" {
        let list = settings::accounts();
        let mut out = json!({ "accounts": list.iter().map(|a| json!({ "id": a["id"], "provider": a["provider"], "name": a["name"] })).collect::<Vec<_>>() });
        let lists = futures::future::join_all(list.iter().map(|a| async move {
            match a["provider"].as_str() {
                Some("claude") => claude_models(a).await.unwrap_or_default(),
                Some("codex") => codex_models(a),
                _ => opencode_models().await.unwrap_or_default(),
            }
        })).await;
        for (a, l) in list.iter().zip(lists) { out[a["id"].as_str().unwrap_or("")] = json!(l) }
        return Ok(json_res(out));
    }
    if url == "/stop" && post { chat::stop_current(); return Ok(ok()) }
    if url == "/events" { return Ok(events()) }
    Ok(StatusCode::NOT_FOUND.into_response())
}

// --- start ---------------------------------------------------------------------------------------------------------
fn discovery() -> PathBuf { library::pena_dir().join("servers").join(format!("{}.json", std::process::id())) }

pub fn shutdown() -> ! {
    app().store.flush();
    chats::flush();
    let _ = std::fs::remove_file(discovery());
    std::process::exit(0)
}

pub async fn start(file_arg: Option<String>, port: u16) -> Result<()> {
    settings::init_path();
    let (sse, _) = broadcast::channel(4096);
    let store = Store::new(|p| emit("patch", p), || emit("doc", json!({})), |message| emit("save-error", json!({ "message": message })));
    let _ = APP.set(App {
        port: OnceLock::new(), file: RwLock::new(None), store, sse, clients: AtomicUsize::new(0), editor_ready: AtomicBool::new(false),
        editor_state: Mutex::new(json!({})), renders: Mutex::default(), render_seq: AtomicU64::new(0), renderer: Mutex::new(Renderer::new()), rects: Mutex::default(),
        mcp_state: Mutex::new(json!({ "ok": null, "tools": 0, "error": null, "fixed": [], "at": 0 })), kept_figma: Mutex::default(),
        focused_at: AtomicU64::new(0), tools: OnceLock::new(), claude_models: Mutex::default(), opencode_models: Mutex::default(),
        jwks: Mutex::default(), http: reqwest::Client::new(),
    });
    let codex = settings::account_of("codex").unwrap_or_default();
    let _ = app().tools.set(tools::Env {
        file: Arc::new(|| file().unwrap_or_default()),
        store: Some(app().store.clone()),
        render: Some(Arc::new(|job| Box::pin(render(job)))),
        state: Some(Arc::new(|| { let mut s = app().editor_state.lock().unwrap().clone(); s["rects"] = rects(); s })),
        spawn: Some(Arc::new(chat::spawn)),
        chat: Some(Arc::new(chat::read_chat_tool)),
        touched: Some(Arc::new(|agent, nodes| {
            let agent = agent.unwrap_or_else(|| "agente externo".into());
            emit("agent-nodes", json!({ "color": chat::profile_color(&agent), "agent": agent, "nodes": nodes }));
        })),
        codex_bin: PathBuf::from(settings::codex_bin()),
        codex_env: settings::account_env(&codex).into_iter().collect(),
    });
    if let Some(f) = file_arg { if let Err(e) = open(&f) { eprintln!("Pena: cannot open {f}: {e}") } } // the dashboard instead of a crash
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".into()); // 0.0.0.0 in the container
    let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
    let port = listener.local_addr()?.port();
    let _ = app().port.set(port);
    // Let external agents' MCP servers (Claude Code, Codex, ...) find the running app, like pen.dev's socket.
    std::fs::create_dir_all(discovery().parent().unwrap())?;
    std::fs::write(discovery(), json!({ "url": format!("http://127.0.0.1:{port}"), "pid": std::process::id() }).to_string())?;
    tokio::spawn(async { let _ = tokio::signal::ctrl_c().await; shutdown() });
    #[cfg(unix)]
    tokio::spawn(async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) { s.recv().await; shutdown() }
    });
    tokio::spawn(watch());
    tokio::spawn(mcp_check(false)); // know before the first turn whether the design tools can start at all
    println!("Pena → http://localhost:{port}  ({})", file().map_or("dashboard".into(), |f| f.display().to_string()));
    let router = axum::Router::new().fallback(handle);
    axum::serve(listener, router).await?;
    Ok(())
}
