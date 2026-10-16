# Pena

Editor de design com agente, inspirado no pen.dev. Ele usa as suas assinaturas, sem API key:

- **Claude**: usa o login do `claude` (Pro/Max) via `@anthropic-ai/claude-agent-sdk`
- **Codex**: usa o `codex login` (ChatGPT) via `@openai/codex-sdk`

```bash
npm install
npm run app                      # app de desktop (abre no dashboard)
npm start                        # ou no navegador: http://localhost:4500
npm start -- meu-design.pen      # abrindo direto um arquivo
npm test
```

## Compatibilidade com pen.dev

- Abre e salva arquivos `.pen` do pen.dev (formato 2.21; arquivos antigos 2.6–2.13 são migrados como o pen.dev faz).
- `npm test` valida os arquivos contra o JSON Schema oficial do pen.dev, lido da sua instalação do Pen (não é distribuído com o Pena).
- Arquivos 2.21 abertos e salvos pelo Pena ficam byte a byte iguais no conteúdo, e os renders batem com os do pen.dev.
- O dashboard mostra também os recentes, rascunhos e miniaturas do pen.dev (só leitura).

## Modelos e effort

No chat, você escolhe provedor, modelo e effort. A escolha fica salva para cada provedor. As listas vêm das suas contas, não de uma lista fixa:

- **Claude**: `supportedModels()` do SDK, com os efforts suportados por cada modelo.
- **Codex**: `~/.codex/models_cache.json`, que o `codex` CLI atualiza para a sua conta. Mostra só os modelos visíveis e os níveis de reasoning de cada um.

Trocar de modelo ou effort no meio da conversa mantém o contexto.
Nas sessões do Pena, o Codex desliga os servidores MCP globais do seu `config.toml`, assim o agente usa só as ferramentas do Pena. O arquivo de configuração não é alterado.

## Como funciona

```
navegador (public/index.html)  ⇄ SSE/HTTP ⇄  server.mjs ── agentes (Claude / Codex)
                                                 │                 │ stdio MCP
                                          arquivo .pen  ⇄  mcp.mjs (get_document, execute, read_skill)
```

O arquivo `.pen` (JSON) é o meio de transporte. O agente escreve nele pelo MCP, e o servidor percebe a mudança e atualiza o canvas na hora.

## Skills

Segue o mesmo modelo do pen.dev. `skills/pena/SKILL.md`, `execute.md` e `schema.md` vão no system prompt. Os guias em `guide/` são lidos sob demanda com `read_skill`.
Para adicionar skills suas, coloque arquivos `.md` em `skills/pena/guide/` ou em `~/.pena/skills/`. Elas aparecem sozinhas no `read_skill()`.

## MCP (agentes externos: Claude Code, Codex, Cursor…)

Mesmas ferramentas do pen.dev: `execute` (com `edits`/`editId`), `get_app_state`, `read_skill`, `spawn_agents`.

```bash
claude mcp add pena -s user -- "$(node -p process.execPath)" "$PWD/mcp.mjs"
codex mcp add pena -- "$(node -p process.execPath)" "$PWD/mcp.mjs"
```

- Com o app aberto, o MCP o encontra sozinho (`~/.pena/server.json`) e edita o arquivo aberto nele: mudanças aparecem ao vivo,
  edições de vários agentes são serializadas e `TakeScreenshot`/`Export` funcionam.
- Sem o app, use `PENA_FILE=/caminho/arquivo.pen`: o MCP edita o arquivo direto (sem screenshots).
- Se mover a pasta do projeto, registre de novo.
