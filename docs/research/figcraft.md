# Por que o FigCraft parece mais leve que o Pena, e o que isso significa para um Pena v2

Pesquisa feita em 2026-10-28. FigCraft analisado na v0.12.1 (clone `--depth 50` de `storytold/figcraft`, commit `2af5e232`). Pena analisado no `main` (`b91b8bf`), com o app instalado na v0.1.40 aberto num documento real.

"Mais leve" aqui quer dizer **uso de recursos em execução e fluidez**, não tamanho de download (esse aparece só de passagem na seção 2).

## 1. TL;DR

- **Quase todo o peso do Pena está no processo WebKit, não no Rust nem no Bun.** Com uma aba aberta (documento de 23,9 MB, ~50 mil nós) e ociosa, o `WebContent` do Pena tinha **1,42 GB** de footprint, com **pico de 5,3 GB**. O processo GPU do WebKit tinha 99 MB (pico 1,3 GB), o sidecar Bun 94 MB (pico 750 MB) e o shell Tauri 50 MB. O FigCraft é um processo nativo só, sem webview, sem heap JS e sem WASM.
- **O documento inteiro trafega como JSON de 24 MB a cada salvamento e a cada edição do agente.** O arquivo é JSON indentado (8,3 MB compacto contra 23,9 MB indentado). Cada salvamento do editor serializa tudo duas vezes na thread principal (~45 ms medidos). Cada `execute` do agente lê e grava o arquivo inteiro no Bun (~55 ms). O webview só descobre a mudança por polling do arquivo a cada 250 ms, e aí baixa, faz parse e re-serializa o documento todo para diffar (~85 ms ou mais de jank por escrita do agente). No FigCraft o documento fica na memória como um mapa persistente (`imbl`), e o agente manda comandos para o app em execução.
- **Toda a renderização do Pena roda na thread principal do webview.** A CanvasKit/WebGL já tem bastante coisa boa (textura offscreen, SkPicture por root, tiles, render sob demanda), mas layout, shaping de texto, gravação de pictures e re-render ao sair da margem de pan bloqueiam a mesma thread do input. O FigCraft renderiza num worker thread: só a "última requisição" vale, o pan renderiza só as faixas descobertas, a edição só a área do que mudou, e há preview grosseiro quando o render é lento.
- **O agente embutido custa mais caro que o editor.** Cada chat ou agente paralelo do Pena sobe um `claude` CLI (~300 MB de footprint medido) mais um `pena-server mcp` (~23 MB). Com `spawn_agents` em 4, isso dá ~1,3 GB só de agentes. O FigCraft **não tem agente embutido**: ele expõe MCP e o agente é externo (Claude Code etc.). Ou seja, ele não elimina esse custo, só não o conta como dele.
- **A causa não é a linguagem.** Ela está no modelo de dados (JSON imutável no disco como fonte da verdade) e na topologia (webview ↔ HTTP/SSE ↔ Bun ↔ disco ↔ polling). Correções pontuais resolvem a maior parte. Reescrever em Rust/egui só compensaria se você aceitar também trocar a UI web inteira e reimplementar o renderer (o FigCraft tem ~288 mil linhas de Rust; o Pena tem ~12,5 mil de JS).

## 2. Lado a lado

| | Pena (v0.1.40) | FigCraft (v0.12.1) |
|---|---|---|
| Linguagem | JS (`.mjs` sem bundler) + Rust só no shell (782 linhas) | Rust puro, ~288 mil linhas (`find -name '*.rs' \| xargs wc -l`), "Rust only (no handwritten JS/TS)" (`AGENTS.md`) |
| Shell | Tauri 2, WKWebView do sistema, **um webview por aba** (`src-tauri/src/main.rs:1-3,20`) | eframe/winit nativo, renderer `Wgpu` (`apps/figcraft/src/main.rs:260`) |
| UI | DOM/HTML/CSS escrito à mão (`public/*.js`) | egui 0.37, modo imediato (`Cargo.toml:94-96`) |
| Renderer do canvas | CanvasKit (Skia WASM, 7,0 MB) em WebGL, na thread principal (`public/view.js:28-32`) | tiny-skia (CPU) num worker thread, com renderização retida (`crates/ui-egui/src/canvas/render_worker.rs:1-13`; `docs/architecture.md:25`) |
| Modelo do documento | Árvore JS simples; JSON indentado no disco como fonte da verdade; undo = strings JSON por root (`public/editor.js:79-89,134`) | `imbl::OrdMap<NodeId, Arc<Node>>` com nós sujos rastreados; undo = snapshots `Arc` com compartilhamento estrutural (`crates/doc/src/lib.rs:173-176`; `docs/architecture.md:30,45-46`) |
| Integração do agente | Embutida: `claude-agent-sdk` / `codex-sdk` / `opencode` disparam o CLI instalado, que por sua vez dispara `pena-server mcp` (`server.mjs:274-290,386-395,504`; `server.mjs:38-41`) | Nenhuma embutida. MCP via `figcraft-cli mcp`, headless ou `--attach` a um app rodando (`docs/mcp.md:17-18`) |
| Processo backend | Sidecar Bun compilado, **um por aba** (`src-tauri/src/main.rs:20`; `sidecar.mjs`) | Nenhum no desktop. `figcraft-server` só para colaboração (`docs/architecture.md:34`) |
| Processos medidos (1 aba, ocioso) | pena 50 MB + pena-server 94 MB + WebContent 1.423 MB + GPU 99 MB + Networking 10 MB ≈ **1,68 GB** (`footprint -p`) | Não medido (não executei o FigCraft, ver seção 5) |
| Artefato macOS | DMG arm64 de 47,5 MB; `.app` de 104 MB (pena-server 90 MB, pena 10 MB, canvaskit.wasm 7,3 MB) | DMG universal de 102,9 MB; `.app` de 225 MB (um binário universal de 235 MB, fontes craft-fonts embutidas) |
| Dependências | 9 diretas, 138 pacotes no `bun.lock`; 472 crates no `src-tauri/Cargo.lock` | 643 crates no `Cargo.lock` |

Sobre tamanho em disco: **o Pena é menor para baixar**. Os assets do `gh release view` são 47,5 MB contra 102,9 MB no DMG e 59,8 MB contra 95,5 MB no `.deb`. O binário do FigCraft é grande porque embute fontes, incluindo CJK (`crates/text/build.rs:1-5`; `/Applications/FigCraft.app/Contents/Resources/Licenses/OFL-noto-sans-cjk-sc.txt`). Ou seja, a sensação de leveza não vem do download.

## 3. Achados detalhados

### 3.1 Memória e topologia de processos

**Pena (medido com `footprint -p` no app instalado, uma aba, ocioso havia ~9 h):**

| Processo | Footprint | Pico |
|---|---|---|
| `pena` (Tauri/Rust) | 50 MB | 54 MB |
| `pena-server` (Bun, aba) | 94 MB | 750 MB |
| `com.apple.WebKit.WebContent` | **1.423 MB** | **5.327 MB** |
| `com.apple.WebKit.GPU` | 99 MB | 1.297 MB |
| `com.apple.WebKit.Networking` | 10 MB | 103 MB |

- Atribuí os processos WebKit ao Pena porque todos nasceram no mesmo segundo que o `pena` (`ps -o etime`). O `lsof` não mostra os sockets do WebContent (eles passam pelo processo Networking), então essa atribuição é por horário, não por prova direta.
- `vmmap --summary` do WebContent mostra **"WebKit Malloc" com 1,2 GB swapped** e só ~50 MB residentes sujos. É heap de JS e de objetos do WebKit que foi usado e foi para compressão/swap. As "JS VM Reservations" de 63,6 GB são só espaço de endereço reservado, não memória usada. Não fiz heap snapshot, então **não sei separar** quanto é CanvasKit (memória WASM) e quanto são strings JSON, entradas de undo, data-URLs de screenshot e DOM do chat. A memória WASM não encolhe: a API só tem `grow()` (MDN, `WebAssembly.Memory.prototype.grow`), então um pico de fontes ou imagens na CanvasKit fica alocado.
- O Pena sobe **um `pena-server` por aba** (`src-tauri/src/main.rs:20`: "One pena-server per tab"), e cada um é uma cópia do runtime Bun. Segundo a documentação do Bun, `--compile` gera um executável "along with a copy of the Bun runtime" (bun.sh/docs/bundler/executables). Cada aba também é um webview separado (`main.rs:175`).
- O documento existe em pelo menos duas cópias vivas: no heap do webview e no Bun (que faz `load(FILE)` a cada `execute`, em `doc.mjs:47`).
- **Agentes:** `runClaude` chama `query()` com `pathToClaudeCodeExecutable: settings.CLAUDE_BIN` (`server.mjs:274-290`), o que dispara o `claude` instalado como subprocesso. O MCP `pena` de cada sessão é outro processo (`server.mjs:38-41`, `settings.penaLaunch()`). Medi processos `claude` iguais (do Claude Code, não do Pena) em **~300 MB de footprint cada** e `pena-server mcp` em **22-24 MB**. `spawn_agents` multiplica isso por N (`server.mjs:666-713`). O Codex fica com um cliente em cache por chave (`server.mjs:381-399`).

**FigCraft:**
- É um processo único: eframe + wgpu (`apps/figcraft/src/main.rs:260`). "No Electron, no web view" (`README.md:76`).
- O documento é um `imbl::OrdMap<NodeId, Arc<Node>>` (`crates/doc/src/lib.rs:173`), com o conjunto de nós sujos rastreado no próprio documento (`lib.rs:174-176,268`). Undo = "`Arc` snapshots" com compartilhamento estrutural, "unlimited undo with one step per gesture" (`docs/architecture.md:30,45-46`). Copiar o documento é barato: só os nós alterados são novos.
- O cache de imagens decodificadas tem orçamento fixo: `MAX_DECODED_BYTES = 512 MiB`, `MAX_CACHED_BYTES = 512 MiB`, `MAX_CACHED_IMAGES = 256`, com remoção LRU (`crates/render/src/images.rs:19-30,50-54`).
- As fontes do sistema são indexadas sob demanda, "the first time text is laid out (a session that never touches text never pays for it)" (`docs/mcp.md:97-99`).
- Não há agente embutido. Os únicos hits de "anthropic/openai" no repositório são créditos (`crates/ui-egui/src/dialogs/credits/ui_tests.rs:34`, `contributors/contributors.json`).

### 3.2 Pipeline de renderização

**Pena** (`public/view.js`, `public/scene.js`). É melhor do que parece à primeira vista:
- A cena visível mais uma margem de 512 px é renderizada numa superfície GPU offscreen. Cada frame só desenha essa textura com o delta da câmera (`view.js:1-4,38-75,105-121`).
- O desenho é sob demanda: `frame()` agenda um único `requestAnimationFrame` (`view.js:128`). Não há loop rAF contínuo, exceto quando há overlay animado ou shaders `@time` (~30 fps só na janela com foco, `view.js:120-125`).
- Há SkPicture por root e tiles de 1024 px para roots grandes (`scene.js:762-800`). Existem LRUs de `Paragraph` e `Path` porque esses objetos "live in WASM memory" (`scene.js:63-93`). O cache GPU da Skia é limitado a 48 MB (`view.js:9,30`), e janelas em segundo plano liberam a GPU depois de 10 s (`view.js:77-91`). Existe dano parcial (`view.damage`, `view.js:146`).

Onde ele perde:
- **Tudo roda na thread principal.** Não há `Worker` nem `OffscreenCanvas` no render (o único `OffscreenCanvas` está em `editor.js:1437`, para imagens). `renderContent()` é síncrono dentro do rAF (`view.js:108`). Quando o pan sai da margem de 512 px, ou 200 ms depois de um zoom, o conteúdo visível inteiro é re-renderizado de uma vez (`view.js:93-103,136-141`), e é aí que aparece a "engasgada".
- **Arrastar e redimensionar invalida o conteúdo inteiro a cada frame.** `startMove` e `startResize` chamam `canvasView.invalidate()` (`editor.js:862,894`), que marca `dirty = true` (`view.js:144`) e faz `renderContent` limpar e redesenhar tudo o que está visível (`view.js:48-49`), em vez de usar `damage()` com a união das caixas antiga e nova. A gravação do root fica válida quando só um root se move (`scene.js:1076-1082`), mas o replay de todos os roots visíveis acontece em todo frame do drag.
- O hit-test de hover roda em todo `pointermove` sem coalescer em rAF (`editor.js:782-786`) e percorre os roots linearmente, sem índice espacial (`scene.js` `hitChain`). Com 1.213 roots, isso pesa.

**FigCraft** (`crates/ui-egui/src/canvas/render_worker.rs:1-13`; `docs/architecture.md:57-64`):
- O render acontece fora da UI thread. "The latest request wins (queued older ones are skipped)". O pan renderiza "only the uncovered strips" e a edição "only the areas of the layers that changed". Num render lento entra um preview 4× mais grosseiro (`PREVIEW_FACTOR`), disparado por um watchdog depois de 12 ms (`PREVIEW_AFTER_MS`). A conversão para textura também fica fora da UI thread (`render_worker.rs:56`).
- O renderer usa "banded in parallel; retained rendering of only what changed; levels of detail when zoomed out" (`docs/architecture.md:25`). Os overlays (seleção, handles) são desenhados pelo egui por cima, sem re-renderizar a cena (`architecture.md:59-63`).
- O egui "only repaints when there is interaction (e.g. mouse movement) or an animation, so if your app is idle, no CPU is wasted" (README do egui, via Context7 `/emilk/egui`). O FigCraft tem alguns repaints periódicos de 2 s na tela inicial e no painel de assets (`home_recents.rs:351,463`; `assets_panel.rs:33,41,297`), então também não é zero absoluto.

### 3.3 Hot spots no Pena, com arquivo e linha

Medi com Bun (JavaScriptCore, a mesma família do WKWebView) no documento aberto (`consumer.pen`: 23,9 MB, 1.213 roots, ~49.800 nós, 8,3 MB se compacto): `JSON.parse` 28 ms, `JSON.stringify(doc, null, 2)` 26 ms, snapshot por root 19 ms.

| # | Onde | O que acontece | Custo |
|---|---|---|---|
| 1 | `public/editor.js:179,193-200` | Todo salvamento (debounce de 300 ms, **0 ms se um agente está rodando**, `editor.js:191`) faz `snapshot(doc)`, que roda `JSON.stringify` em **todos** os roots, e depois `JSON.stringify(doc, null, 2)` do documento inteiro como body do PUT | ~45 ms de thread principal e 24 MB de upload por salvamento |
| 2 | `public/editor.js:186` | O diff `changes` vai na **query string** da URL | URLs enormes em edições grandes |
| 3 | `server.mjs:899-907` | O PUT faz `JSON.parse` do body e grava o arquivo inteiro (`writeFileSync`). Se teve merge, faz `load(FILE)` mais stringify indentado | ~25-55 ms no Bun por salvamento |
| 4 | `doc.mjs:47,64,72` | Cada `execute` do agente faz `load(file)` (parse de 24 MB + imports), cria um **novo contexto** com `vm.runInNewContext` e chama `save()`, que regrava 24 MB indentados | ~55 ms ou mais no Bun por chamada |
| 5 | `server.mjs:1089` | `fs.watchFile(FILE, { interval: 250 })`: polling de `stat` 4×/s por aba, **para sempre**, mesmo ocioso. É o único caminho pelo qual a escrita do agente chega ao editor. A doc do Node diz: "Using `fs.watch()` is more efficient than `fs.watchFile()`" (nodejs/node `doc/api/fs.md:5390`) | Até 250 ms de latência por edição do agente, mais wakeups ociosos |
| 6 | `public/editor.js:1988,2049-2080` | Evento SSE `doc`, depois `fetch('/doc')` (24 MB), `JSON.parse`, `snapshot(next)` e mais **dois** `JSON.stringify` por root para achar quais roots mudaram (`:2078,2080`), mais um para shaders (`:2083`) | ~85-100 ms de jank por escrita do agente |
| 7 | `public/editor.js:2020-2027` | Cada screenshot do agente força `reload()` (o item 6) antes de exportar, e o PNG volta como data-URL para o server via POST | Screenshot = recarga completa |
| 8 | `public/editor.js:144,1463-1474` | `schedulePreview` depois de **toda** edição: em 4 s exporta o maior frame como PNG e faz POST em `/api/preview` | Render extra periódico durante a edição |
| 9 | `public/editor.js:79-89,133-134` | Undo guarda `JSON.stringify` do root inteiro tocado, até 300 entradas. Um root de 150 KB editado 300 vezes ocupa ~45 MB de strings | Memória do heap JS |
| 10 | `public/editor.js:862-864,894-896` | Drag e resize: `invalidate()` (redesenho completo), `measure()` e `drawOverlay({remeasure:true})` a cada `pointermove` | Frames longos no drag em telas cheias |
| 11 | `public/editor.js:782-786` | Hover: `clickTarget`, depois `pick` e `hitChain` linear a cada `pointermove`, sem rAF | CPU ao mover o mouse |
| 12 | `server.mjs:329-332`, `public/chatlog.js:87,102` | Streaming: cada delta reenvia **o texto acumulado inteiro** (throttle de 60 ms, `server.mjs:570-578`), e o cliente refaz `innerHTML = md(texto)` da mensagem inteira | O(n²) em respostas longas, com relayout do painel do chat |
| 13 | `src-tauri/src/main.rs:20`, `:175` | Um webview e um processo Bun por aba | Memória multiplicada pelo número de abas |

Ao contrário do FigCraft, onde "Every user-visible behaviour is a command" e o MCP `--attach` executa os comandos **dentro** do app em memória (`docs/architecture.md:48-55`; `docs/mcp.md:18`), no Pena o agente e o editor conversam **pelo disco**.

### 3.4 Ocioso

- **Pena:** o polling de 250 ms por aba (item 5), os processos Bun e WebKit residentes e os CLIs de agente que ficam vivos enquanto a sessão existe. O canvas em si fica parado (rAF sob demanda) e libera a GPU em segundo plano (`view.js:77-91`). Medi 0,0-0,1% de CPU em todos os processos do Pena enquanto ocioso. **O custo ocioso do Pena está na memória, não na CPU.**
- **FigCraft:** repaint reativo do egui, mais timers de 2 s em algumas telas (seção 3.2). Não tem processo filho.

### 3.5 Práticas de código do FigCraft que valem copiar

- **Tudo é comando:** um registro único (`crates/engine/src/cmd/*`, `spec!`, 455 ids) serve menu, atalho, palette, CLI, control channel, MCP e plugins (`docs/architecture.md:48-55`; `AGENTS.md`). Comandos nunca abrem diálogo; eles só *pedem* UI. O `execute` com JS livre do Pena é o oposto disso: flexível, mas sem undo por comando nem validação.
- **Camadas verificadas por ferramenta:** `cargo xtask layers` impede que crates abaixo da L6 dependam de egui/winit, então "the UI crate is swappable" (`docs/architecture.md:11-13`).
- **"Never crash":** lints `unwrap_used`, `expect_used` e `panic` em deny, mais `unsafe_code = "forbid"` (`Cargo.toml:102-120`). Um guard transforma o panic de um comando em erro e faz rollback do documento (`docs/architecture.md:74-79`). Há também um sweep com parâmetros-lixo sobre todos os comandos.
- **Testes:** 3.851 `#[test]` em ~520 arquivos `*_tests.rs` dentro de `crates/`, mais nextest (`.config/nextest.toml`) e um gate único `cargo xtask ci` (fmt, clippy -D warnings, testes, camadas, assets, wasm). O Pena tem 10 arquivos `*.test.mjs` encadeados em `package.json`.
- **Orçamentos explícitos:** cache de imagem, tamanho de frame MCP (32 MiB, `docs/mcp.md:8-11`) e gate de tamanho do wasm web (`Cargo.toml:138-147`).
- **Acesso a arquivo por um único módulo**, com roots de leitura e escrita para o agente (`docs/mcp.md:35-93`). O Pena faz algo parecido com `canUseTool` e sandbox (`server.mjs:278-299`).

## 4. Recomendações para o Pena (fluidez e recursos)

Em ordem de impacto por esforço. As de 1 a 6 não exigem reescrita.

1. **Tirar o disco e o polling do caminho agente → editor** (impacto alto, esforço médio). Faça o `execute` rodar no server contra o documento **em memória** da aba e emitir um evento SSE `patch` com os roots alterados (o `touched` já existe em `tools.mjs:109-110`). Grave o arquivo com debounce, fora do caminho crítico. O editor aplica o patch sem `fetch('/doc')`. Isso elimina os itens 4, 5, 6 e 7. Troque `fs.watchFile` por `fs.watch` no diretório só para mudanças externas, ou mantenha o polling com intervalo bem maior.
2. **Salvar só o que mudou** (impacto alto, esforço baixo a médio). O PUT manda `{roots alterados, ordem, meta}` no body, não na query; o server aplica o merge na cópia em memória. Grave **JSON compacto** (24 → 8 MB) ou separe o arquivo em partes. Abandone o `snapshot()` completo a cada salvamento: o `commit` já sabe o conjunto `dirty` (`editor.js:80-88`), então guarde versões por root em vez de strings. Isso resolve os itens 1, 2, 3 e 6.
3. **Usar damage rect no drag e no resize** (impacto médio, esforço baixo). Troque `invalidate()` por `damage(união das caixas antiga e nova)` em `editor.js:862,894`. Coalesça o `pointermove` de hover e drag num único rAF. Adicione uma grade espacial ou R-tree simples dos roots para o `hitChain`.
4. **Reduzir processos** (impacto alto em memória, esforço médio). Use um `pena-server` só para todas as abas, já que o mapa por label existe em `main.rs:20`. Avalie também um webview único com abas virtuais. Encerre CLIs de agente ociosos depois de N minutos. Limite o paralelismo do `spawn_agents` por padrão, porque cada agente custa ~320 MB.
5. **Undo por patch** (impacto médio, esforço médio). Guarde só as props alteradas (inverso de `Update`) em vez da string do root inteiro, com limite em bytes e não em quantidade (`editor.js:134`).
6. **Streaming incremental no chat** (impacto baixo a médio, esforço baixo). Mande só o delta; no cliente, acrescente o texto cru e só renderize o markdown no `done`, ou a cada N ms com rAF.
7. **Render fora da thread principal** (impacto alto em fluidez, esforço alto). Mova `scene` e CanvasKit para um Worker com `OffscreenCanvas` (WebGL em worker). A CanvasKit aceita WebGL numa OffscreenCanvas, mas **não verifiquei** suporte e estabilidade no WKWebView da versão do macOS que vocês exigem (14.0), então isso precisa de um protótipo antes. É o equivalente direto do `render_worker` do FigCraft.
8. **Medir antes e depois:** já existem `performance.mark('pena:load-*')` e `__pena.view()` (`view.js:132`). Acrescente um heap snapshot do WebKit (Web Inspector do Tauri com a feature `devtools`, que já está ligada em `src-tauri/Cargo.toml`) para separar WASM, strings e DOM antes de decidir o item 7.

### Precisa reescrever?

Com base no que medi, **não para resolver o peso**. As causas raiz são:
- (a) o JSON de 24 MB re-serializado e transferido o tempo todo;
- (b) o disco e o polling como barramento entre agente e editor;
- (c) render e serialização na mesma thread do input;
- (d) N runtimes Bun mais N CLIs de agente.

Uma reescrita em Rust que mantenha a mesma arquitetura (arquivo como fonte da verdade, re-serializar tudo) continuaria pesada, e o custo dos agentes (d) não depende da linguagem.

O que o FigCraft prova é que **Rust + egui + wgpu + renderer CPU em thread separada** dá um processo único, com repaint reativo e documento persistente com compartilhamento estrutural. Mas o preço é alto: ~288 mil linhas de Rust, UI imediata desenhada à mão (ícones em código), sem HTML/CSS para o chat e os painéis, e o fork próprio do egui/winit (`Cargo.toml:149-167`).

Um caminho intermediário, coerente com o que já existe:
- manter o Tauri e a UI web;
- **eliminar o sidecar Bun** movendo o servidor de documento e o MCP para o Rust do Tauri (comandos Tauri e eventos no lugar de HTTP/SSE, com o documento em memória no Rust e serde);
- manter só o processo do CLI do agente, que é inevitável enquanto vocês usarem as assinaturas via `claude` e `codex`.

Isso tira ~90 MB do pacote e um processo por aba. **O ganho maior, porém, vem das recomendações 1-3, que funcionam na stack atual.** Só considere Rust/egui de ponta a ponta se, depois delas, o heap snapshot mostrar que o WebContent continua em GB por causa da própria CanvasKit/WebKit.

## 5. Perguntas em aberto e o que não verifiquei

- **Não executei o FigCraft**, nem o clone nem o `/Applications/FigCraft.app` instalado (regra: não rodar código dele). Então não tenho footprint, CPU ociosa nem tempo de startup dele. Para comparar de verdade: abrir o mesmo conteúdo nos dois e rodar `footprint -p` e `top -stats pid,mem,cpu`.
- **Não sei a composição dos 1,4 GB do WebContent** (WASM da CanvasKit, strings JSON, undo, DOM do chat, data-URLs). Precisa de um heap snapshot do Web Inspector.
- O pico de 5,3 GB pode ter vindo de import de `.fig`, de muitos screenshots de agente ou de agentes paralelos. Não reproduzi.
- A atribuição dos processos WebKit ao Pena se baseia no horário de início, não em PID pai.
- Os ~300 MB por `claude` CLI foram medidos em instâncias do Claude Code, não em uma sessão disparada pelo Pena. O binário é o mesmo (`settings.mjs:41`), mas a carga pode variar.
- As medidas de JSON foram feitas no Bun, não dentro do WKWebView. É o mesmo motor (JSC), mas o tempo pode variar.
- Não verifiquei WebGL em `OffscreenCanvas` dentro de Worker no WKWebView do macOS 14 (recomendação 7).
