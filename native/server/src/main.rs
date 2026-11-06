// Pena's native server. One binary, two modes:
//   pena [file.pen]   the server (PORT, default 4500; HOST, default 127.0.0.1)
//   pena mcp [file]   the stdio design-tool MCP server agent CLIs spawn
mod app;
mod chat;
mod mcp;

// returns freed memory to the system (glibc and macOS malloc kept hundreds of MB after each big document parse)
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let arg = std::env::args().nth(1);
    if arg.as_deref() == Some("mcp") { return mcp::stdio().await }
    let port = std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4500);
    app::start(arg, port).await
}
