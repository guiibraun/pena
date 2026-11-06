# Pena hosted on a server, for one person: the editor in any browser, agents on the CLIs logged in here, the MCP at
# /mcp and a headless Chromium that renders screenshots/exports on the CPU. See "Hosting" in the README.
FROM oven/bun:1-debian

# chromium: the renderer. nodejs/npm: the claude and codex CLIs. git: agents reading project code.
RUN apt-get update && apt-get install -y --no-install-recommends chromium nodejs npm git ca-certificates fonts-noto-core fonts-noto-color-emoji \
  && npm install -g @anthropic-ai/claude-code @openai/codex \
  && rm -rf /var/lib/apt/lists/* /root/.npm

RUN mkdir -p /data
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

ENV HOST=0.0.0.0 PORT=4500 PENA_RENDERER=/usr/bin/chromium
# /root keeps the CLI logins and ~/.pena (chats, settings); /data the .pen files. Both are volumes.
CMD ["bun", "server.mjs", "/data/main.pen"]
