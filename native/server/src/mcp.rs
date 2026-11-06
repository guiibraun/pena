// The design-tool MCP on rmcp (the official Rust SDK): one handler for stdio (`pena mcp`, what agent CLIs spawn) and
// streamable HTTP (`/mcp`, hosted Pena). The tools themselves are pena_core::tools.
use futures::future::BoxFuture;
use pena_core::tools::{self, Env};
use rmcp::model::{CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData, ServerHandler, ServiceExt};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Runs a tool: (name, arguments, calling client's name) → the CallToolResult JSON of pena_core::tools::call.
pub type Call = Arc<dyn Fn(String, Value, Option<String>) -> BoxFuture<'static, Value> + Send + Sync>;

#[derive(Clone)]
pub struct Pena { pub call: Call, pub instructions: Option<&'static str> }

impl ServerHandler for Pena {
    fn get_info(&self) -> ServerConfig {
        let c = ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(Implementation::new("pena", "0.3.0"));
        match self.instructions { Some(i) => c.with_instructions(i), None => c }
    }
    async fn list_tools(&self, _: Option<PaginatedRequestParams>, _: RequestContext<RoleServer>) -> Result<ListToolsResult, ErrorData> {
        let tools = tools::schemas().into_iter().filter_map(|t| serde_json::from_value::<Tool>(t).ok()).collect();
        Ok(ListToolsResult::with_all_items(tools))
    }
    async fn call_tool(&self, req: CallToolRequestParams, ctx: RequestContext<RoleServer>) -> Result<CallToolResponse, ErrorData> {
        let client = ctx.peer.peer_info().map(|i| i.client_info.name.clone());
        let args = req.arguments.map(Value::Object).unwrap_or_else(|| json!({}));
        let out = (self.call)(req.name.to_string(), args, client).await;
        let result: CallToolResult = serde_json::from_value(out).map_err(|e| ErrorData::internal_error(e.to_string(), None))?;
        Ok(result.into())
    }
}

// --- `pena mcp`: the stdio server agents spawn (port of mcp.mjs) -----------------------------------------------------
// It talks to the running Pena app when there is one (PENA_URL, or the servers listed in ~/.pena/servers, one per
// window): edits are serialized in the app, show up live, and TakeScreenshot/Export render there. Without the app it
// edits PENA_FILE directly.
pub async fn stdio() -> anyhow::Result<()> {
    let fixed = std::env::var("PENA_FILE").ok().or_else(|| std::env::args().nth(2));
    let http = reqwest::Client::new();
    let call: Call = Arc::new(move |name, args, client| Box::pin(call(name, args, client, fixed.clone(), http.clone())));
    Pena { call, instructions: None }.serve(rmcp::transport::stdio()).await?.waiting().await?;
    Ok(())
}

struct Open { url: String, file: String, focused_at: f64 }

// Running Pena servers with the file each has open and when its window last had focus.
async fn servers(http: &reqwest::Client) -> Vec<Open> {
    let mut out = vec![];
    let Ok(dir) = std::fs::read_dir(pena_state::library::pena_dir().join("servers")) else { return out };
    for e in dir.flatten() {
        let entry: Value = std::fs::read_to_string(e.path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let pid = entry["pid"].as_i64().unwrap_or(0) as i32;
        // crashed: stale entry
        if pid <= 0 || (unsafe { libc::kill(pid, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)) {
            let _ = std::fs::remove_file(e.path());
            continue;
        }
        let url = entry["url"].as_str().unwrap_or("").to_string();
        let Ok(r) = http.get(format!("{url}/api/current")).timeout(Duration::from_secs(2)).send().await else { continue };
        let Ok(cur) = r.json::<Value>().await else { continue };
        if let Some(file) = cur["file"].as_str() { out.push(Open { url, file: file.into(), focused_at: cur["focusedAt"].as_f64().unwrap_or(0.0) }) }
    }
    out
}

fn absolute(p: &str) -> String { std::path::absolute(p).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| p.into()) }

fn wanted(name: &str, args: &Value, fixed: Option<&str>) -> Option<String> {
    if name == "get_node" {
        let link = url::Url::parse(args["link"].as_str().unwrap_or("").trim()).ok()?;
        return link.query_pairs().find(|(k, _)| k == "file").map(|(_, v)| absolute(&v));
    }
    args["filePath"].as_str().filter(|s| !s.is_empty()).or(fixed).map(absolute)
}

async fn call(name: String, args: Value, client: Option<String>, fixed: Option<String>, http: reqwest::Client) -> Value {
    let pena_url = std::env::var("PENA_URL").ok();
    let open = if pena_url.is_some() { vec![] } else { servers(&http).await };
    // Which tab serves this call: the one with the file it targets, else the last focused one. PENA_URL always wins.
    let target = match (&pena_url, wanted(&name, &args, fixed.as_deref())) {
        (Some(u), _) => Some(u.clone()),
        (None, Some(w)) => open.iter().find(|s| s.file == w).map(|s| s.url.clone()),
        (None, None) if name == "get_node" => None, // malformed link: let the tool explain
        (None, None) => open.iter().max_by(|a, b| a.focused_at.total_cmp(&b.focused_at)).map(|s| s.url.clone()),
    };
    let via = match target { Some(url) => via_app(&http, &url, &name, &args, client).await, None => None };
    let mut result = match via { Some(r) => r, None => direct(&name, args, fixed.as_deref()).await };
    // external agents can pick another tab with filePath: tell them which ones there are
    if name == "get_app_state" && open.len() > 1 {
        let list = open.iter().map(|s| s.file.as_str()).collect::<Vec<_>>().join("\n");
        if let Some(c) = result["content"].as_array_mut() {
            c.push(json!({ "type": "text", "text": format!("Files open in Pena tabs (pass one as filePath to target it):\n{list}") }));
        }
    }
    result
}

async fn via_app(http: &reqwest::Client, url: &str, name: &str, args: &Value, client: Option<String>) -> Option<Value> {
    // who is calling: Pena's own agents get a name in PENA_AGENT; external clients are named after themselves
    let mut body = args.clone();
    body["_agent"] = json!(std::env::var("PENA_AGENT").ok().or(client).unwrap_or_else(|| "agente externo".into()));
    if let Ok(c) = std::env::var("PENA_CONV") { body["_conv"] = json!(c) }
    if let Ok(f) = std::env::var("PENA_FILE") { body["_file"] = json!(f) }
    let res = http.post(format!("{url}/tool/{name}")).body(body.to_string()).send().await.ok()?;
    if res.status() == 409 { return None } // no document open there: fall through to the file
    res.json().await.ok()
}

// No tab has the file: edit it on disk (filePath or PENA_FILE).
async fn direct(name: &str, args: Value, fixed: Option<&str>) -> Value {
    let file = if name == "get_node" { Some(fixed.map(absolute).unwrap_or_default()) } else { wanted(name, &args, fixed) };
    let Some(file) = file else {
        return json!({ "content": [{ "type": "text", "text": "Open a file in the Pena app, or set PENA_FILE to a .pen file." }], "isError": true });
    };
    tools::call(&Env::new(PathBuf::from(&file)), name, args).await
}
