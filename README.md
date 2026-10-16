# Pena

Editor de design com agente, inspirado no pen.dev. Ele usa as suas assinaturas, sem API key:

- **Claude**: usa o login do `claude` (Pro/Max) via `@anthropic-ai/claude-agent-sdk`
- **Codex**: usa o `codex login` (ChatGPT) via `@openai/codex-sdk`
- **OpenCode**: usa o `opencode` CLI com os seus logins (`opencode auth login`: Zen, Go, OpenRouter, OpenAI…), um `opencode run --format json` por turno

O Pena usa os CLIs `claude`, `codex` e `opencode` que você já tem instalados (não traz cópias deles). Mesmo aberto pelo Finder,
ele os encontra pelo PATH do seu shell de login.

```bash
bun install
bun run app                      # app de desktop (Tauri; abre no dashboard)
bun start                        # ou no navegador: http://localhost:4500
bun start meu-design.pen         # abrindo direto um arquivo
bun run test                     # (`bun test` é o test runner do Bun, não este script)
bun run install-app              # gera o Pena.app (~85 MB) e copia para /Applications
bun run package                  # no Windows: gera o instalador em src-tauri/target/release/bundle/nsis/
```

Precisa do [Bun](https://bun.sh) e, para compilar o app de desktop, do Rust (`curl https://sh.rustup.rs -sSf | sh`). O app compila para a máquina onde roda: o instalador do Windows sai de um Windows (com Rust/MSVC e o WebView2, que já vem no Windows 10/11). Lá, prefira os instaladores nativos dos CLIs (`claude.exe`, `opencode.exe`); com o `codex` do npm, o Pena usa o `codex.exe` que vem dentro do pacote.

## Compatibilidade com pen.dev

- Abre e salva arquivos `.pen` do pen.dev (formato 2.21; arquivos antigos 2.6–2.13 são migrados como o pen.dev faz).
- `bun run test` valida os arquivos contra o JSON Schema oficial do pen.dev, lido da sua instalação do Pen (não é distribuído com o Pena).
- Arquivos 2.21 abertos e salvos pelo Pena ficam byte a byte iguais no conteúdo, e os renders batem com os do pen.dev.
- O dashboard mostra também os recentes, rascunhos e miniaturas do pen.dev (só leitura).

## Modelos e effort

No chat, você escolhe provedor, modelo e effort. A escolha fica salva para cada provedor. As listas vêm das suas contas, não de uma lista fixa:

- **Claude**: `supportedModels()` do SDK, com os efforts suportados por cada modelo.
- **OpenCode**: `opencode models --verbose`, só os modelos que chamam ferramentas; os `variants` viram os níveis de raciocínio.
- **Codex**: `~/.codex/models_cache.json`, que o `codex` CLI atualiza para a sua conta. Mostra só os modelos visíveis e os níveis de reasoning de cada um.

Trocar de modelo ou effort no meio da conversa mantém o contexto.
Nas sessões do Pena, o Codex desliga os servidores MCP globais do seu `config.toml`, assim o agente usa só as ferramentas do Pena. O arquivo de configuração não é alterado. O OpenCode faz o mesmo com o `~/.config/opencode/opencode.json` (via `OPENCODE_CONFIG_CONTENT`) e deixa as outras ferramentas em `ask`, que o `opencode run` recusa sozinho.

## Como funciona

```
WebKit / navegador (public/)    ⇄ SSE/HTTP ⇄  server.mjs ── agentes (Claude / Codex / OpenCode)
                                                 │                 │ stdio MCP
                                          arquivo .pen  ⇄  mcp.mjs (get_document, execute, read_skill)
```

O arquivo `.pen` (JSON) é o meio de transporte. O agente escreve nele pelo MCP, e o servidor percebe a mudança e atualiza o canvas na hora.

No app de desktop, `src-tauri/` abre uma janela do WebKit do sistema (sem Chromium embutido), com os menus e diálogos nativos.
O servidor roda como `pena-server`, um binário único compilado com `bun build --compile` a partir de `sidecar.mjs`.
O mesmo binário, com o argumento `mcp`, é o servidor MCP dos agentes.

## Skills

Segue o mesmo modelo do pen.dev. `skills/pena/SKILL.md`, `execute.md` e `schema.md` vão no system prompt. Os guias em `guide/` são lidos sob demanda com `read_skill`.
Para adicionar skills suas, coloque arquivos `.md` em `skills/pena/guide/` ou em `~/.pena/skills/`. Elas aparecem sozinhas no `read_skill()`.

## MCP (agentes externos: Claude Code, Codex, Cursor…)

Mesmas ferramentas do pen.dev: `execute` (com `edits`/`editId`), `get_app_state`, `read_skill`, `spawn_agents`.

```bash
claude mcp add pena -s user -- "$(which bun)" "$PWD/mcp.mjs"
codex mcp add pena -- "$(which bun)" "$PWD/mcp.mjs"
```

- Com o app aberto, o MCP o encontra sozinho (`~/.pena/server.json`) e edita o arquivo aberto nele: mudanças aparecem ao vivo,
  edições de vários agentes são serializadas e `TakeScreenshot`/`Export` funcionam.
- Sem o app, use `PENA_FILE=/caminho/arquivo.pen`: o MCP edita o arquivo direto (sem screenshots).
- Se mover a pasta do projeto, registre de novo.
