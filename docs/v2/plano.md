# Pena v2: plano

Rascunho de 2026-10-28, para decidir e ajustar antes de começar. Base: `docs/research/figcraft.md` (por que o FigCraft é mais leve) e `docs/research/plano-desempenho.md` (medições no seu documento real, com protótipos).

## 1. Decisões já tomadas

- **Interface:** Vue 3 + TypeScript (strict), build com Vite.
- **Migração:** tudo de uma vez, em uma branch longa (`v2`), sem convivência de v1 e v2 no mesmo app.
- **Shell:** continua Tauri 2, com o WebKit do sistema.

## 2. Correção importante da minha recomendação anterior

Eu tinha sugerido mover o núcleo para Rust para eliminar o Bun. **Depois de ler o código, isso não vale a pena**, por três motivos:

1. **Os agentes dependem de SDKs em TypeScript.** `server.mjs` importa `query` de `@anthropic-ai/claude-agent-sdk` e `Codex` de `@openai/codex-sdk`. Em Rust seria preciso reimplementar o protocolo de cada CLI.
2. **O `execute` roda JavaScript do agente.** `doc.mjs` usa `vm.runInNewContext` sobre a API do documento. Em Rust seria preciso embutir um motor JS (QuickJS ou V8) e reexpor a API.
3. **O modelo do documento é compartilhado entre o editor e os agentes** (`public/pen-core.js`, citado no próprio `doc.mjs`). Em TypeScript é um pacote só. Em Rust viraria duas implementações ou um WASM.

**Decisão proposta:** o servidor continua em TypeScript. O ganho de memória do Bun vem de outro lugar: **um único servidor para todas as abas** (hoje é um por aba, `src-tauri/src/main.rs:20`), o que tira ~75 MB de RAM por aba extra. Rust fica no shell do Tauri (menus, abas, atualização), como já é.

## 3. O que a v2 não pode quebrar

Estas são as restrições de compatibilidade, tiradas do README e do código. Cada uma vira um teste de paridade.

| Contrato | Origem | Como validar |
|---|---|---|
| Formato `.pen` 2.21; arquivos 2.6–2.13 são migrados; o arquivo salvo valida no JSON Schema do pen.dev | `README.md`, `compat.test.mjs`, `migrate()` | `compat.test.mjs` portado; abrir e salvar `examples/*.pen` sem mudança de conteúdo |
| O arquivo no disco continua **indentado com 2 espaços** | `doc.mjs: save`; os `.pen` ficam em repositórios git | diff de um arquivo aberto e salvo sem edição deve ser vazio |
| 6 ferramentas MCP: `execute` (com `edits`/`editId`), `get_app_state`, `get_node`, `read_skill`, `read_chat`, `spawn_agents` | `tools.mjs` | `integrations.test.mjs` e `doc.test.mjs` portados |
| MCP funciona com o app aberto (descoberta por `~/.pena/servers/`) e sem ele (`PENA_FILE`) | `mcp.mjs`, `library.mjs` | teste de integração nos dois modos |
| Links `pena://node/<id>?file=<path>` | README | `get_node` com o app fechado |
| Skills em `skills/pena/` e `~/.pena/skills/` | `skills.mjs` | `read_skill` lista as de usuário |
| Agentes via CLI instalado: Claude, Codex, OpenCode; várias contas; sandbox e caminhos negados | `server.mjs`, `settings.mjs`, README | `accounts.test.mjs`, `integrations.test.mjs`; revisão manual do sandbox |
| Importar Figma (colar e `.fig`), importar do navegador, exportar `.fig` | `figma.mjs`, `browser-import.mjs` | `figma.test.mjs`, `browser-import.test.mjs` |
| Shaders (efeito e preenchimento, anotações do pen.dev), 15 shaders da biblioteca | `public/shader.js`, `public/shaders/` | `shader.test.mjs` |
| Estado em `~/.pena` (recentes, rascunhos, chats, contas, fontes, previews) e leitura (só leitura) dos recentes do pen.dev | `library.mjs`, `chats.mjs` | abrir a v2 sobre um `~/.pena` da v1 sem perder chats |
| Português e inglês | `public/i18n.js` | tradução por chave, sem texto solto |
| Janela com abas, menus nativos, associação de `.pen`, atualização automática, instaladores macOS, Windows, Linux | `src-tauri/`, `release.yml` | build e smoke test nos 3 sistemas |

## 4. Inventário da v1 e destino na v2

~20 mil linhas no total (sem lockfiles), em ~13 arquivos que concentram quase tudo.

| Módulo v1 | Linhas | Destino v2 |
|---|---|---|
| `public/editor.js` | 2.154 | dividido: estado e comandos do editor (TS), camada de overlay (imperativa), painéis (Vue) |
| `public/scene.js` | 1.265 | pacote `canvas` (porte direto, depois otimizado) |
| `server.mjs` | 1.122 | pacote `server`, dividido em rotas, sessões de documento e agentes |
| `figma.mjs` | 953 | `server/importers/figma` |
| `public/props.js` | 518 | componentes Vue do painel de propriedades |
| `public/pen-core.js` | 441 | pacote `core` (tipos e API do documento) |
| `public/render.js`, `view.js`, `skia.js`, `shader.js` | ~840 | pacote `canvas` |
| `public/chatlog.js`, `composer.js`, `presence.js`, `ui.js` | ~750 | Vue (chat, composer) e overlay (presença) |
| `public/settings.js`, `dashboard.html`, `tabbar.html`, `index.html` | ~1.100 | Vue (configurações, dashboard, barra de abas) |
| `public/i18n.js` | 796 | `vue-i18n` ou o mesmo mecanismo, com as chaves tipadas |
| `settings.mjs`, `library.mjs`, `chats.mjs`, `handoff.mjs`, `skills.mjs`, `fonts.mjs`, `browser-import.mjs`, `mcp.mjs`, `tools.mjs`, `doc.mjs` | ~1.600 | pacote `server` |
| `src-tauri/src/main.rs` | 782 | shell, simplificado para um sidecar só |
| 10 arquivos `*.test.mjs` | ~850 | testes por pacote |

## 5. Arquitetura alvo

```
packages/
  core/      tipos do .pen, API do documento (Insert/Update/...), migrate, merge, patches. Sem DOM, sem Node.
  canvas/    CanvasKit: cena, view, render, shaders. Só DOM/WebGL. Depende de core.
  server/    sessões de documento, agentes, MCP, chats, biblioteca, importadores. Só Node/Bun. Depende de core.
  ui/        Vue 3: editor, painéis, chat, dashboard, configurações. Depende de core e canvas.
src-tauri/   shell: janela, abas, menus, atualizador, sidecar.
```

**Regras de dependência verificadas por ferramenta** (a prática do FigCraft que vale copiar): `core` não importa nada de DOM nem de Node; `ui` não importa `server`; `canvas` não importa Vue. Um passo de CI falha se alguém quebrar isso.

**Fluxo de dados (as etapas 1 a 3 do plano de desempenho, agora de fábrica):**

- O servidor guarda **cada documento aberto em memória**, numa sessão (`DocSession`). O arquivo é gravado depois, com debounce, **indentado e fora do caminho da edição**.
- O editor e os agentes falam com a sessão por **patches** (roots alterados + ordem + meta), nunca o documento inteiro. O SSE manda `patch` para os editores abertos.
- O `execute` do agente roda na sessão em memória e **desfaz se o snippet lançar erro** (guarda os roots tocados antes).
- Edições externas ao arquivo (outro app) entram por `fs.watch` e viram um patch.
- Um servidor para todas as abas; cada rota recebe o id da sessão. A descoberta do MCP passa a listar documentos, não processos.

**Interface:**

- O documento **não entra no estado reativo do Vue.** Fica em um store externo; os componentes recebem fatias pequenas via `shallowRef`/`computed` (a doc do Vue avisa que a reatividade profunda cobra por acesso a propriedade em estruturas grandes).
- O que roda a cada frame (rótulos das telas, seleção, conexões, guias) fica **fora do Vue**, em uma camada imperativa que reutiliza elementos, ou é desenhado no canvas.
- Vue cuida de: chat, composer, painel de propriedades, dashboard, configurações, barra de abas, menus de contexto.

**Qualidade de código (o motivo declarado da v2):**

- TypeScript `strict`, sem `any` (lint falha).
- Tudo que entra por uma fronteira é validado com `zod` (já é dependência): rotas HTTP, argumentos do MCP, o `.pen` ao carregar, mensagens do SSE. Os tipos TS saem dos schemas.
- Testes ao lado do código, um comando só de CI (`typecheck`, `lint`, `test`, `layers`, `bench`), como o `cargo xtask ci` do FigCraft.
- Arquivos pequenos e módulos com interface estreita. O `editor.js` de 2.154 linhas e o `server.mjs` de 1.122 não podem ser reproduzidos como estão.
- Um `AGENTS.md` com essas regras, já que o README diz que todo o código foi escrito por agentes: a convenção precisa estar escrita para eles seguirem.

## 6. Orçamentos de desempenho (portão de aceite)

Medidos no seu `consumer.pen` (26,7 MB, 1.327 roots, 795 conexões), com `scripts/bench-ui.mjs`, `bench-drag.mjs` e `bench-data.mjs`, que passam a rodar na CI. Os valores são **propostas**, derivadas da v1 e do protótipo.

| Cenário | v1 hoje | Protótipo | Orçamento v2 |
|---|---|---|---|
| Arrastar na visão geral, frame p50 | 196 ms | 48 ms (6 ms sem conexões) | ≤ 17 ms |
| Zoom na visão geral, travada em 150 eventos | 1.403 ms | n/a | ≤ 300 ms |
| Travada da UI por salvamento | 465 ms | 75 ms | ≤ 50 ms |
| Edição do agente até aparecer | 383–914 ms | 76–85 ms | ≤ 100 ms |
| Execução do `execute` no servidor | 133–352 ms | 19–31 ms | ≤ 40 ms |
| Tamanho do PUT de salvamento | 26,7 MB | 17 KB | ≤ 100 KB |
| Memória do WebContent, documento aberto e ocioso | ~0,9–1,4 GB | não medido | **definir após o heap snapshot** |
| Processos do servidor por app | 1 por aba | 1 por aba | 1 |

## 7. Como fazer "tudo de uma vez" sem se perder

Uma reescrita de uma vez é a opção de maior risco, e ainda mais num app de 20 mil linhas sem a v1 ao lado como referência viva. Para reduzir isso sem mudar a decisão:

- **Congelar a v1.** Só correção de bug e segurança na `main`. Nada de funcionalidade nova até o corte.
- **A v1 continua instalável.** Como o formato do arquivo não muda, quem voltar para a v1 não perde nada.
- **Lista de paridade viva** (`docs/v2/paridade.md`): cada funcionalidade da v1 (a tabela da seção 3 mais cada item da barra, dos menus e atalhos) com estado `não feito / feito / verificado`. Só se corta a v2 com tudo `verificado`.
- **Fases internas com saída verificável**, mesmo sendo uma entrega só:

| Fase | Entrega | Como saber que acabou |
|---|---|---|
| 0. Base | monorepo, Vite, tsconfig strict, lint, regra de camadas, CI, `AGENTS.md` | `bun run ci` passa num projeto vazio |
| 1. Core | `pen-core` em TS com tipos e zod; migrate, merge, API, patches | testes portados (`doc`, `scene` lógica, `compat`) passam; abrir e salvar `examples/*.pen` não muda nada |
| 2. Servidor | sessões em memória, protocolo de patch, persistência, `execute` com rollback, MCP, agentes, chats, biblioteca, settings, Figma, importação do navegador | testes portados passam; MCP responde nos dois modos; `bench-data` dentro do orçamento |
| 3. Canvas | porte de `scene/view/render/shader/skia` para pacote `canvas`; só depois otimizar (damage no arrasto, LOD, conexões) | renders iguais aos da v1 (comparar PNGs dos `examples/`); `bench-drag` dentro do orçamento |
| 4. Interface | editor, overlay, painéis e chat em Vue; dashboard; configurações; abas | lista de paridade 100% `verificado`; `bench-ui` dentro do orçamento |
| 5. Shell e empacotamento | Tauri com um sidecar, menus, abas, atualizador, instaladores nos 3 sistemas | instalar, abrir, editar com agente, atualizar, em macOS, Windows e Linux |
| 6. Corte | migração do `~/.pena`, notas de versão, tag `v2.0.0` | usar a v2 por alguns dias nos seus projetos reais antes de publicar |

A ordem importa: a fase 2 define o protocolo que as fases 3 e 4 consomem, e a fase 3 define o que o Vue pode e não pode tocar.

## 8. Riscos e critérios para parar

| Risco | Probabilidade/impacto | Mitigação |
|---|---|---|
| A paridade esconde funcionalidade que ninguém lembra (atalhos, gestos, estados de erro) | alta / médio | lista de paridade gerada do código (cada `addEventListener`, cada item de menu), não da memória |
| O Vue pesa no editor se o documento ou o overlay entrarem no estado reativo | média / alto | regra de camadas, `bench-ui` na CI desde a fase 4 |
| Regressão no render (CanvasKit) ao portar | média / alto | comparar PNGs dos exemplos pixel a pixel, na fase 3, antes de otimizar |
| Quebrar a compatibilidade com o pen.dev | baixa / alto | `compat.test.mjs` na CI; arquivo indentado igual |
| Sandbox dos agentes mais frouxo ao reescrever | baixa / alto | tratar `server/agents` como porte literal, com revisão manual das listas de caminhos negados |
| Windows e Linux só testados no fim | alta / médio | CI nos 3 sistemas já na fase 0 (hoje o `release.yml` só roda em tag) |
| O WebKit continua perto de 1 GB e a v2 não resolve a memória | média / médio | heap snapshot **antes** da fase 3; se a causa for a CanvasKit/WebKit, reavaliar o renderer (worker, ou nativo como o FigCraft) |

**Parar e reavaliar se:** a fase 3 terminar e o `bench-drag` na visão geral não chegar a ≤ 30 ms por frame; ou se a fase 4 passar de 2× o tempo da fase 3 sem a lista de paridade avançar.

## 9. Decisões em aberto

Cada uma com meu padrão sugerido, para você só mudar o que discordar.

| Decisão | Opções | Padrão sugerido |
|---|---|---|
| Runtime do sidecar | Bun compilado (hoje, ~90 MB) ou Node empacotado | Bun compilado, um processo só; reavaliar se o tamanho incomodar |
| Abas | um webview por aba (hoje) ou um webview com abas virtuais | um webview por aba: isola o estado e deixa a aba em segundo plano "dormir" a GPU como hoje (`public/view.js:77-91`) |
| Estado da interface | Pinia ou composables simples | composables simples; documento fora do Vue |
| CSS | CSS escrito à mão (hoje), Tailwind, componentes prontos | manter CSS próprio com variáveis; sem biblioteca de componentes até haver necessidade |
| Testes | `bun test` ou Vitest | Vitest para a UI (Vue), `bun test` para core e server |
| i18n | `vue-i18n` ou o mecanismo atual (`public/i18n.js`) | `vue-i18n`, com chaves em inglês e catálogo tipado |
| Nome e versão | `2.0.0` no mesmo repositório e identificador | mesmo `dev.pena.app`, para o atualizador entregar a v2 |

## 10. Antes de começar (barato, e muda o plano)

1. **Heap snapshot do WebKit** com o documento aberto, para saber do que são os ~0,9–1,4 GB. É o dado que mais pode mudar a decisão do renderer.
2. **Gerar a lista de paridade** do código atual (eventos, menus, atalhos, rotas), para ela existir antes da primeira linha da v2.
3. **Provar o protocolo de patch no código atual** (o protótipo já mostrou o ganho). A v2 só o formaliza.
