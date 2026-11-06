//! The agent tools, mirroring pen.dev's MCP surface (execute, get_app_state, read_skill, spawn_agents...), port of
//! tools.mjs. Implemented once; the server runs them in-process (so parallel agents' edits are serialized in its Store)
//! and a standalone MCP runs them on the file without the editor-only features.
use crate::doc::{self, Loaded};
use crate::{Store, js, resolve};
use anyhow::{Result, anyhow, bail};
use base64::Engine;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// One MCP tool definition per tool: { name, description, inputSchema, annotations? }. The input schemas are what the
/// MCP SDK generated from tools.mjs' zod schemas (same names, descriptions and constraints).
pub fn schemas() -> Vec<Value> {
    static S: LazyLock<Vec<Value>> = LazyLock::new(|| serde_json::from_str(include_str!("tools.json")).expect("tools.json"));
    S.clone()
}

/// Who is calling: `_agent`, `_conv`, `_file` of the call (the stdio MCP adds them).
#[derive(Debug, Clone, Default)]
pub struct CallCtx {
    pub agent: Option<String>,
    pub conv: Option<String>,
    pub file: Option<String>,
}

/// render(job) -> [{ id, data, warnings? }]: job is { ids, format, options } (screenshots) or an Export job
/// { ids, format, outputPath, options }; data is a data: URL or text.
pub type Render = Arc<dyn Fn(Value) -> BoxFuture<'static, Result<Vec<Value>>> + Send + Sync>;

/// The `env` of tools.mjs createTools(env). Without `store` (standalone) everything goes through the file.
#[derive(Clone)]
pub struct Env {
    pub file: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    pub store: Option<Store>,
    pub render: Option<Render>,
    /// -> { selection, rects: { id: { w, h } }, ... }
    pub state: Option<Arc<dyn Fn() -> Value + Send + Sync>>,
    /// (config, { agent, conv }) -> text
    pub spawn: Option<Arc<dyn Fn(Value, CallCtx) -> String + Send + Sync>>,
    /// (args, { conv, file }) -> text
    pub chat: Option<Arc<dyn Fn(Value, CallCtx) -> String + Send + Sync>>,
    /// (agent, [{ kind, id }])
    pub touched: Option<Arc<dyn Fn(Option<String>, Vec<Value>) + Send + Sync>>,
    /// generate_image/upscale_image run `codex exec` with the user's Codex login: the binary and the account's env
    /// (added on top of this process' env)
    pub codex_bin: PathBuf,
    pub codex_env: Vec<(String, String)>,
}

impl Env {
    /// Standalone: a fixed file, no app features.
    pub fn new(file: impl Into<PathBuf>) -> Env {
        let file = file.into();
        Env {
            file: Arc::new(move || file.clone()),
            store: None,
            render: None,
            state: None,
            spawn: None,
            chat: None,
            touched: None,
            codex_bin: "codex".into(),
            codex_env: vec![],
        }
    }
}

fn text(t: impl Into<String>) -> Value {
    json!({ "type": "text", "text": t.into() })
}
fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
fn str_arg(args: &Value, k: &str) -> Option<String> {
    args[k].as_str().map(str::to_string)
}
// the JS side is synchronous work: keep it off the async workers
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| anyhow!("{e}"))?
}

/// Normalize a tool call to MCP content (CallToolResult); errors become isError results the agent can act on.
pub async fn call(env: &Env, name: &str, args: Value) -> Value {
    let args = if args.is_null() { json!({}) } else { args };
    let r = match name {
        "execute" => execute(env, args).await,
        "generate_image" => generate(env, str_arg(&args, "prompt"), str_arg(&args, "path"), args["references"].as_array().cloned().unwrap_or_default()).await,
        "upscale_image" => {
            let notes = args["notes"].as_str().filter(|n| !n.is_empty()).map(|n| format!(" {n}")).unwrap_or_default();
            let prompt = format!(
                "Re-render the attached image at the highest resolution you can, as a sharp, clean, high-quality version of the SAME image. \
                 Keep exactly the same composition, framing, aspect ratio, colors, layout, text, logos and proportions; do not add, remove or restyle anything. \
                 Only remove blur, noise and compression artifacts and sharpen fine detail.{notes}"
            );
            generate(env, Some(prompt), str_arg(&args, "output"), vec![args["path"].clone()]).await
        }
        "get_app_state" => get_app_state(env).await,
        "get_node" => get_node(env, args["link"].as_str().unwrap_or("")).await,
        "read_skill" => doc::read_skill(args["path"].as_str()).map(|t| vec![text(t)]),
        "read_chat" => Ok(vec![text(match &env.chat {
            None => "read_chat is only available inside the Pena app.".into(),
            Some(chat) => chat(args.clone(), CallCtx { conv: str_arg(&args, "_conv"), file: str_arg(&args, "_file"), agent: None }),
        })]),
        "spawn_agents" => Ok(vec![text(match &env.spawn {
            None => "spawn_agents is only available inside the Pena app.".into(),
            Some(spawn) => spawn(args["config"].clone(), CallCtx { agent: str_arg(&args, "_agent"), conv: str_arg(&args, "_conv"), file: None }),
        })]),
        _ => Err(anyhow!("Unknown tool {name}")),
    };
    match r {
        Ok(content) => json!({ "content": content }),
        Err(e) => json!({ "content": [text(e.to_string())], "isError": true }),
    }
}

// the open document in memory when `file` is the store's, else read from disk
fn open(env: &Env, file: &Path) -> Result<Loaded> {
    if let Some(store) = &env.store {
        if resolve(Path::new(""), file) == resolve(Path::new(""), &(env.file)()) {
            let (doc, lib) = store.doc_and_lib();
            return Ok(Loaded { doc, lib, files: vec![] });
        }
    }
    doc::load_full(file)
}

// the screenshot, plus why a shader in it is not drawn (load/compile errors), if any
async fn png(render: &Render, id: &str) -> Result<Vec<Value>> {
    let shots = render(json!({ "ids": [id], "format": "png", "options": { "scale": 1 } })).await?;
    let shot = shots.into_iter().next().ok_or_else(|| anyhow!("No screenshot of {id}"))?;
    let data = shot["data"].as_str().unwrap_or("").split(',').nth(1).unwrap_or("").to_string();
    let mut out = vec![json!({ "type": "image", "data": data, "mimeType": "image/png" })];
    let warnings: Vec<&str> = shot["warnings"].as_array().map(|w| w.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if !warnings.is_empty() {
        out.push(text(warnings.join("\n")));
    }
    Ok(out)
}

async fn execute(env: &Env, mut args: Value) -> Result<Vec<Value>> {
    let file = (env.file)();
    let agent = str_arg(&args, "_agent");
    if let Some(o) = args.as_object_mut() {
        for k in ["_agent", "_conv", "_file"] {
            o.remove(k);
        }
    }
    let rects = env.state.as_ref().map(|s| s()["rects"].clone()).unwrap_or(Value::Null);
    let (store, f) = (env.store.clone(), file.clone());
    let r = blocking(move || match store {
        Some(store) => store.execute(&args, &rects),
        None => doc::execute(&f, &args, &rects),
    })
    .await?;
    if !r.touched.is_empty() {
        if let Some(t) = &env.touched {
            t(agent, r.touched.clone());
        }
    }
    let mut content = vec![text(r.text)];
    let shots = r.host["screenshots"].as_array().cloned().unwrap_or_default();
    if !shots.is_empty() {
        match &env.render {
            None => content.push(text("TakeScreenshot needs the Pena editor open in a browser.")),
            Some(render) => {
                for id in shots {
                    content.extend(png(render, id.as_str().unwrap_or(&id.to_string())).await?);
                }
            }
        }
    }
    for job in r.host["exports"].as_array().cloned().unwrap_or_default() {
        let Some(render) = &env.render else {
            content.push(text(format!("Export to {} needs the Pena editor open in a browser.", job["outputPath"].as_str().unwrap_or("undefined"))));
            continue;
        };
        let results = render(job.clone()).await?;
        // Same as pen.dev: outputPath is a folder and each node is written as <id>.<ext>.
        let out = job["outputPath"].as_str().ok_or_else(|| anyhow!("Export needs an outputPath (a folder)"))?;
        let dir = resolve(file.parent().unwrap_or(Path::new("")), Path::new(out));
        let format = job["format"].as_str().unwrap_or("undefined");
        let ext = match format {
            "html-css" | "html-tailwind" => "html",
            f => f,
        };
        let mut written = vec![];
        for r in results {
            let id = r["id"].as_str().map(str::to_string).unwrap_or_else(|| r["id"].to_string());
            let target = dir.join(format!("{}.{ext}", id.replace('/', "_")));
            std::fs::create_dir_all(&dir)?;
            let data = r["data"].as_str().unwrap_or("");
            if data.starts_with("data:") {
                std::fs::write(&target, base64::engine::general_purpose::STANDARD.decode(data.split(',').nth(1).unwrap_or(""))?)?;
            } else {
                std::fs::write(&target, data)?;
            }
            written.push(s(&target));
        }
        content.push(text(format!("Exported {format}: {}", written.join(", "))));
    }
    Ok(content)
}

async fn generate(env: &Env, prompt: Option<String>, rel: Option<String>, references: Vec<Value>) -> Result<Vec<Value>> {
    let dir = resolve(Path::new(""), &(env.file)()).parent().map(Path::to_path_buf).unwrap_or_default();
    let inside = |p: &str| -> Result<PathBuf> {
        let r = resolve(&dir, Path::new(p));
        if r != dir && !r.starts_with(&dir) {
            bail!("{p} is outside the .pen folder");
        }
        Ok(r)
    };
    let rel = rel.ok_or_else(|| anyhow!("path must be a string"))?;
    let out = inside(&rel)?;
    let refs = references.iter().map(|r| inside(r.as_str().unwrap_or("undefined"))).collect::<Result<Vec<_>>>()?;
    if !s(&out).to_lowercase().ends_with(".png") {
        bail!("path must end in .png");
    }
    if out.exists() {
        bail!("{rel} already exists: pick another path");
    }
    for r in &refs {
        if !r.exists() {
            bail!("Reference not found: {}", s(r));
        }
    }
    std::fs::create_dir_all(out.parent().unwrap_or(&dir))?;
    let brief = format!(
        "Use your image generation tool to create this image:\n{}\n\n{}No text in the image unless the description asks for it. \
         Save the final PNG as {} (copy it from the generated images folder). Reply only with the saved path.",
        prompt.as_deref().unwrap_or("undefined"),
        if refs.is_empty() { "" } else { "Base it on the attached reference image(s).\n" },
        s(&out)
    );
    // ponytail: the prompt goes through stdin because -i takes every following argument as a file
    let mut cmd = tokio::process::Command::new(&env.codex_bin);
    cmd.args(["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-C"]).arg(&dir);
    for r in &refs {
        cmd.arg("-i").arg(r);
    }
    cmd.envs(env.codex_env.iter().cloned()).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).kill_on_drop(true);
    let mut p = cmd.spawn().map_err(|e| anyhow!("Could not run codex ({e}). Install it and run `codex login`."))?;
    let mut stdin = p.stdin.take().unwrap();
    let (mut so, mut se) = (p.stdout.take().unwrap(), p.stderr.take().unwrap());
    // the last 4000 characters of both streams, interleaved as they come
    let buf = Arc::new(Mutex::new(String::new()));
    let pump = |mut r: Box<dyn tokio::io::AsyncRead + Unpin + Send>, buf: Arc<Mutex<String>>| async move {
        let mut chunk = [0u8; 4096];
        while let Ok(n) = r.read(&mut chunk).await {
            if n == 0 {
                break;
            }
            let mut b = buf.lock().unwrap();
            b.push_str(&String::from_utf8_lossy(&chunk[..n]));
            let len = b.chars().count();
            if len > 4000 {
                *b = b.chars().skip(len - 4000).collect();
            }
        }
    };
    let run = async {
        let _ = stdin.write_all(brief.as_bytes()).await;
        drop(stdin);
        tokio::join!(pump(Box::new(&mut so), buf.clone()), pump(Box::new(&mut se), buf.clone()));
        p.wait().await
    };
    if tokio::time::timeout(Duration::from_secs(300), run).await.is_err() {
        bail!("Image generation timed out after 5 minutes"); // p is killed on drop
    }
    if !out.exists() {
        let log = buf.lock().unwrap().trim().to_string();
        let lines: Vec<&str> = log.split('\n').collect();
        bail!("Codex did not save the image. Is `codex login` done with a ChatGPT plan?\n{}", lines[lines.len().saturating_sub(8)..].join("\n"));
    }
    let png = std::fs::read(&out)?;
    let head = png.get(16..24).ok_or_else(|| anyhow!("{rel} is not a PNG"))?;
    let (w, h) = (u32::from_be_bytes(head[0..4].try_into()?), u32::from_be_bytes(head[4..8].try_into()?));
    Ok(vec![text(format!("Saved {rel} ({w}x{h}). Fill: {{ \"type\": \"image\", \"url\": \"{rel}\", \"mode\": \"cover\" }}"))])
}

async fn get_app_state(env: &Env) -> Result<Vec<Value>> {
    let file = (env.file)();
    let state = env.state.as_ref().map(|s| s()).unwrap_or(Value::Null);
    let env2 = env.clone();
    let summary = blocking(move || {
        let l = open(&env2, &file)?;
        js::call("appState", vec![Some(l.doc.to_string()), doc::lib_arg(&l.lib), Some(s(&file)), Some(state.to_string())]).map_err(|e| anyhow!("{e}"))
    })
    .await?;
    let docs = format!("<execute-documentation>\n{}\n\n{}\n</execute-documentation>", doc::read_skill(Some("execute.md"))?, doc::read_skill(Some("schema.md"))?);
    Ok(vec![text(summary), text(docs)])
}

// The link names its own file, so it works on any .pen, open or not (screenshots only for the open one).
async fn get_node(env: &Env, link: &str) -> Result<Vec<Value>> {
    let bad = || anyhow!("Expected a link like pena://node/<id>?file=/path/to/file.pen");
    let url = url::Url::parse(link.trim()).map_err(|_| bad())?;
    let id = percent_encoding::percent_decode_str(url.path().get(1..).unwrap_or("")).decode_utf8().map_err(|_| anyhow!("URI malformed"))?.into_owned();
    let file = url.query_pairs().find(|(k, _)| k == "file").map(|(_, v)| v.into_owned()).unwrap_or_default();
    if url.scheme() != "pena" || url.host_str() != Some("node") || id.is_empty() || file.is_empty() {
        return Err(bad());
    }
    if !Path::new(&file).exists() {
        bail!("File not found: {file}");
    }
    let (env2, f, i) = (env.clone(), file.clone(), id.clone());
    let out = blocking(move || {
        let l = open(&env2, Path::new(&f))?;
        js::call("getNode", vec![Some(l.doc.to_string()), doc::lib_arg(&l.lib), Some(i), Some(f)]).map_err(|e| anyhow!("{e}"))
    })
    .await?;
    let out: Value = serde_json::from_str(&out)?;
    let mut content: Vec<Value> = out["texts"].as_array().into_iter().flatten().filter_map(Value::as_str).map(text).collect();
    let shown = env.render.as_ref().filter(|_| resolve(Path::new(""), Path::new(&file)) == resolve(Path::new(""), &(env.file)()));
    let shot = |id: String| async move {
        match png(shown.unwrap(), &id).await {
            Ok(c) => c,
            Err(e) => vec![text(format!("No screenshot: {e}"))],
        }
    };
    if shown.is_some() {
        content.extend(shot(id.clone()).await);
    }
    if let Some(flow) = out["flow"].as_str() {
        content.push(text(flow));
        if shown.is_some() {
            for sc in out["screens"].as_array().into_iter().flatten() {
                let sid = sc["id"].as_str().unwrap_or("").to_string();
                content.push(text(format!("Screenshot of screen \"{}\" ({sid}) in this flow:", sc["name"].as_str().unwrap_or(&sid))));
                content.extend(shot(sid).await);
            }
        }
    }
    Ok(content)
}
