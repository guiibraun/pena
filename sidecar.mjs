// Entry of the compiled sidecar the desktop app runs (src-tauri). One binary, two modes:
//   pena-server [file.pen]  -> the server; prints its URL on stdout, exits when the app closes stdin
//   pena-server mcp         -> the stdio MCP server (what mcp.mjs is in a checkout)
if (process.argv.includes('mcp')) await import('./mcp.mjs');
else {
  const { start } = await import('./server.mjs');
  console.log(await start({ file: process.argv.find((a) => a.endsWith('.pen')), port: [4517, 4518, 4519, 0] }));
  process.stdin.on('end', () => process.exit(0)).resume(); // the app quit (or crashed): don't linger
}
