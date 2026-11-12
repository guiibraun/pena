# Pena hosted on a server, for one person: the editor in any browser, agents on the CLIs logged in here, the MCP at
# /mcp and a headless Chromium that renders screenshots/exports on the CPU. See "Hosting" in the README.
FROM oven/bun:1-debian

# Node 22 for the claude, codex and opencode CLIs: Debian's node 20 / npm 9 is too old (claude-code needs >=22, and codex needs its own install or npm skips its platform package).
COPY --from=node:22-slim /usr/local/ /usr/local/

# chromium: the renderer. git: agents reading project code.
RUN apt-get update && apt-get install -y --no-install-recommends chromium git ca-certificates fonts-noto-core fonts-noto-color-emoji \
  && npm install -g @anthropic-ai/claude-code opencode-ai \
  && npm install -g @openai/codex \
  && rm -rf /var/lib/apt/lists/* /root/.npm

RUN mkdir -p /data
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

ENV HOST=0.0.0.0 PORT=4500 PENA_RENDERER=/usr/bin/chromium
# /root keeps the CLI logins and ~/.pena (chats, settings); /data the .pen files. Both are volumes.
CMD ["bun", "server.mjs", "/data/main.pen"]
