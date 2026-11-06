// Pena's native server. One binary, two modes:
//   pena [file.pen]   the server (PORT, default 4500; HOST, default 127.0.0.1)
//   pena mcp [file]   the stdio design-tool MCP server agent CLIs spawn
mod app;
mod chat;
mod mcp;

// returns freed memory to the system (glibc and macOS malloc kept hundreds of MB after each big document parse)
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
// mi_option_purge_delay in mimalloc v3 (what the crate builds; the Rust bindings lack the constant). 0: freed pages go
// back right away instead of 1 s later on the thread's next allocation, which idle worker threads never make (~250 MB
// more held on a big file)
const MI_OPTION_PURGE_DELAY: libmimalloc_sys::mi_option_t = 15;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    unsafe { libmimalloc_sys::mi_option_set(MI_OPTION_PURGE_DELAY, 0) };
    let arg = std::env::args().nth(1);
    if arg.as_deref() == Some("mcp") { return mcp::stdio().await }
    let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4500);
    app::start(arg, port).await
}
