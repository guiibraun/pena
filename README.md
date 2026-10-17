# Pena

An agent-powered design editor inspired by [pen.dev](https://pen.dev), that runs on the AI subscriptions you already pay for. No API keys.

- **Claude**: your `claude` login (Pro/Max), through `@anthropic-ai/claude-agent-sdk`
- **Codex**: your `codex login` (ChatGPT), through `@openai/codex-sdk`
- **OpenCode**: the `opencode` CLI with your own logins (`opencode auth login`: Zen, Go, OpenRouter, OpenAI…), one `opencode run --format json` per turn

Pena drives the `claude`, `codex` and `opencode` CLIs you have installed; it doesn't ship copies of them. Even when launched from Finder, it finds them through your login shell's `PATH`.

## 100% vibecoded

Every line of this app was written by AI agents (Claude Code and friends), steered by prompts, screenshots and "no, not like that". No line was typed by hand. Read the code with that in mind.

## How we built it: reverse engineering pen.dev with REA

pen.dev's `.pen` format, its MCP tools and its agent skills aren't publicly documented. To stay compatible, we used **REA (Reverse Engineer Anything)**, a reverse-engineering MCP server, to study the pen.dev desktop app we had installed. REA let the agent inspect the Electron bundle, recover the JavaScript sources, and trace how features work. That's how we matched:

- the `.pen` document format (version 2.21) and how older files (2.6–2.13) are migrated,
- the JSON Schema the files are validated against,
- the MCP tools agents use (`execute`, `get_app_state`, `read_skill`, `spawn_agents`) and the skills model,
- the rendering, so Pena's renders match pen.dev's,
- the Figma import (paste and `.fig`).

Pena is an independent reimplementation. It contains no pen.dev code or assets, and the official schema is read from your own pen.dev installation at test time, not redistributed. It is not affiliated with or endorsed by pen.dev.

## Download

Grab the installer for your system from the [latest release](https://github.com/guiibraun/pena/releases/latest): `.dmg` for macOS (14+), `-setup.exe` for Windows, `.AppImage` or `.deb` for Linux. The app checks for new releases when it starts and offers to install them (AppImage only on Linux; `.deb` users update by hand).

## Development

```bash
bun install
bun run app                      # desktop app (Tauri; opens on the dashboard)
bun start                        # or in the browser: http://localhost:4500
bun start my-design.pen          # opening a file directly
bun run test                     # (`bun test` is Bun's test runner, not this script)
bun run install-app              # builds Pena.app (~85 MB) and copies it to /Applications
bun run package                  # builds the installer for the current OS
```

You need [Bun](https://bun.sh) and, to build the desktop app, Rust (`curl https://sh.rustup.rs -sSf | sh`). The app builds for the machine it runs on: the Windows installer is built on Windows (with Rust/MSVC and WebView2, which ships with Windows 10/11). There, prefer the native CLI installers (`claude.exe`, `opencode.exe`); with `codex` from npm, Pena uses the `codex.exe` bundled inside the package.

Releases are built by GitHub Actions on every `v*` tag (`.github/workflows/release.yml`).

## pen.dev compatibility

- Opens and saves pen.dev `.pen` files (format 2.21; older 2.6–2.13 files are migrated the way pen.dev does it).
- `bun run test` validates files against pen.dev's official JSON Schema, read from your Pen installation.
- 2.21 files opened and saved by Pena keep byte-identical content, and renders match pen.dev's.
- Figma import, like pen.dev: copy layers in Figma and paste them on the canvas (no images), or drop/import a `.fig` (File > Save local copy, with images). Components become plain frames; multi-page files ask which page to import.
- Figma export: Export › Figma (.fig) writes a `.fig` (the whole document when nothing is selected) to drag into Figma. Keeps auto layout, editable text, vectors, gradients, shadows and images; icons go in as images.
- The dashboard also shows pen.dev's recents, drafts and thumbnails (read-only).

## Models and effort

In the chat you pick provider, model and effort; the choice is saved per provider. The lists come from your accounts, not a hardcoded list:

- **Claude**: the SDK's `supportedModels()`, with each model's supported efforts.
- **OpenCode**: `opencode models --verbose`, only models that call tools; `variants` become reasoning levels.
- **Codex**: `~/.codex/models_cache.json`, which the `codex` CLI keeps up to date for your account; only visible models and their reasoning levels.

Switching model or effort mid-conversation keeps the context.
In Pena sessions, Codex turns off the global MCP servers from your `config.toml`, so the agent only sees Pena's tools; the file itself isn't changed. OpenCode does the same with `~/.config/opencode/opencode.json` (via `OPENCODE_CONFIG_CONTENT`) and leaves other tools on `ask`, which `opencode run` refuses on its own.

## How it works

```
WebKit / browser (public/)   ⇄ SSE/HTTP ⇄  server.mjs ── agents (Claude / Codex / OpenCode)
                                               │                 │ stdio MCP
                                          .pen file  ⇄  mcp.mjs (get_document, execute, read_skill)
```

The `.pen` file (JSON) is the transport. The agent writes to it through MCP; the server notices the change and updates the canvas live.

The desktop app (`src-tauri/`) opens a window using the system's WebKit (no bundled Chromium), with native menus and dialogs.
The server runs as `pena-server`, a single binary compiled with `bun build --compile` from `sidecar.mjs`.
The same binary, with the `mcp` argument, is the agents' MCP server.

## Skills

Same model as pen.dev. `skills/pena/SKILL.md`, `execute.md` and `schema.md` go into the system prompt; the guides in `guide/` are read on demand with `read_skill`.
To add your own skills, drop `.md` files in `skills/pena/guide/` or `~/.pena/skills/`. They show up in `read_skill()` automatically.

## MCP (external agents: Claude Code, Codex, Cursor…)

Same tools as pen.dev: `execute` (with `edits`/`editId`), `get_app_state`, `read_skill`, `spawn_agents`.

```bash
claude mcp add pena -s user -- "$(which bun)" "$PWD/mcp.mjs"
codex mcp add pena -- "$(which bun)" "$PWD/mcp.mjs"
```

- With the app open, the MCP server finds it on its own (`~/.pena/servers/`, one entry per window) and edits the file open in the
  last focused window (or the window that has `PENA_FILE` open): changes show up live, edits from several agents are serialized,
  and `TakeScreenshot`/`Export` work. Each window runs its own server, so several files can be open at once; opening a file that is
  already open focuses its window.
- Without the app, set `PENA_FILE=/path/to/file.pen`: the MCP server edits the file directly (no screenshots).
- If you move the project folder, register it again.
- Links, like Figma's "Copy link to selection": select a layer and press ⌘L (or "Copiar link para o agente" in the Código panel) to copy `pena://node/<id>?file=<path>`. Paste it in the agent ("implement this in Next.js") and the `get_node` tool returns that node's tree with variables and components resolved, plus a screenshot when the file is open in the app. It works with the app closed too.
