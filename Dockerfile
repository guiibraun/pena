# Pena hosted on a server, for one person: the editor in any browser, agents on the CLIs logged in here, the MCP at
# /mcp, screenshots drawn by the native renderer. No Node, Bun or browser at runtime. See "Hosting" in the README.

# The native server (Rust). libfontconfig: Skia's text layout.
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends libfontconfig1-dev clang && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY public public
COPY skills skills
COPY native native
# 4 jobs: Skia + LTO linking runs out of memory in a small builder VM with more
RUN cd native/server && cargo build --release -j 4 && cp target/release/pena /pena

# The browser editor's files from npm: CanvasKit (its canvas) and the icon libraries. Only these are kept.
FROM oven/bun:1 AS assets
WORKDIR /a
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN mkdir -p /out && cd node_modules && cp -r --parents canvaskit-wasm/bin lucide-static/icons feather-icons/dist/icons \
  @phosphor-icons/core/assets/regular @material-symbols/svg-400/outlined @material-symbols/svg-400/rounded @material-symbols/svg-400/sharp /out/

FROM debian:bookworm-slim
# git: agents reading project code; unzip: text from office attachments
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git unzip libfontconfig1 fonts-noto-core fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*
# The agent CLIs from their official installers (native binaries), moved out of /root: /root is a volume (the logins).
RUN curl -fsSL https://claude.ai/install.sh | bash && cp -L /root/.local/bin/claude /usr/local/bin/claude \
  && A=$(uname -m) && curl -fsSL "https://github.com/openai/codex/releases/latest/download/codex-$A-unknown-linux-musl.tar.gz" | tar -xz -C /tmp \
  && mv "/tmp/codex-$A-unknown-linux-musl" /usr/local/bin/codex \
  && curl -fsSL https://opencode.ai/install | bash && cp -L /root/.opencode/bin/opencode /usr/local/bin/opencode \
  && rm -rf /root/.local /root/.claude /root/.claude.json /root/.opencode /root/.cache
WORKDIR /app
COPY public public
COPY skills skills
COPY --from=assets /out node_modules
COPY --from=build /pena /usr/local/bin/pena
RUN mkdir -p /data
# DISABLE_AUTOUPDATER: the CLI is part of the image; update it by rebuilding. MALLOC_ARENA_MAX: glibc gives each
# thread its own heap and keeps what was freed in each; on a big document that held 1.3 GB instead of 0.7.
ENV HOST=0.0.0.0 PORT=4500 PENA_ROOT=/app DISABLE_AUTOUPDATER=1 MALLOC_ARENA_MAX=2
# /root keeps the CLI logins and ~/.pena (chats, settings); /data the .pen files. Both are volumes.
CMD ["pena", "/data/main.pen"]
