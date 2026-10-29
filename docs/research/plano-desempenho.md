# Plano de desempenho do Pena, com medições

Medido em 2026-10-28 no `main` (`86c8c6b`, que já inclui a correção das conexões feita em outro agente). Complementa `figcraft.md`.

**Resumo:** com o seu documento real, o Pena fica liso perto de uma tela. Trava em quatro situações:
- ao arrastar na visão geral (~5 fps);
- ao salvar (frame de ~240 ms);
- quando o agente edita (~0,4–0,9 s até aparecer);
- no pan e zoom da visão geral.

Os protótipos das etapas 1 a 4 resolvem as três primeiras quase por completo, sem trocar de linguagem nem de stack.

## Como medi

- **Documento:** cópia do `consumer.pen` aberto no seu app (26,7 MB, 1.327 roots, 459 telas, 795 conexões) com a `starter.lib` e as imagens, em `/tmp/pena-bench`. Servidores de teste com `HOME` falso: não tocaram no seu arquivo, nos recentes nem no Pena aberto.
- **Motor:** WebKit do Playwright, o mesmo motor do WKWebView do app, com janela visível, viewport 1600×1000 @2x. Os eventos de mouse e roda são reais (Playwright), não chamadas internas.
- **Métricas por gesto (150 eventos):**
  - p50/p95/máx do intervalo entre frames;
  - frames lentos (> 25 ms);
  - **travada (jank)** = soma do tempo que passou de 16,7 ms em cada frame, que não depende da taxa da tela;
  - **CPU** = soma de todos os processos do navegador.
- **Cenários:**
  - **visão de trabalho:** uma tela mediana centralizada a 50%;
  - **visão geral:** `fit()`, o documento inteiro;
  - **salvar:** 5 edições, mediana;
  - **edição do agente:** `POST /tool/execute` como o MCP faz, até o editor ter a mudança; 5 vezes, mediana.
- **Rodadas:** atual e protótipo **intercalados**, 3 rodadas, mediana. A máquina estava em uso (seu Pena com agentes, este Claude), então os números variam bastante entre rodadas. Confie nas diferenças grandes, não nas de ±30%.
- **Scripts (ficam no repo para repetir):**
  - `scripts/bench-ui.mjs`: gestos, salvar, agente;
  - `scripts/bench-drag.mjs`: arrasto com página nova;
  - `scripts/bench-data.mjs`: custo dos caminhos de dados no Bun (JavaScriptCore, o mesmo motor do WebKit), atual contra corrigido.
- **Protótipo:** `docs/research/prototipo-desempenho.patch` (aplica limpo no `main` com `git apply`). Foi feito para medir, não para produção (ver "Limitações").

Memória do app real (o Pena aberto agora, `footprint`): WebContent **898–985 MB**, GPU do WebKit 68–72 MB, `pena-server` 71–76 MB e `pena` 42 MB, total de **~1,1–1,2 GB** para uma aba. A isso se somam 9 processos `pena-server mcp` (~26 MB no total) e os CLIs `claude` (~300 MB cada) enquanto há chats ativos.

## Etapa 0 (já feita): correção das conexões do outro agente

Commit `86c8c6b`: desenha só as conexões visíveis, redesenha o overlay uma vez por frame e usa um caminho SVG por estado. Comparação de `b91b8bf` (antes) com `86c8c6b` (depois), 3 rodadas cada:

| Gesto | Antes | Depois |
|---|---|---|
| Pan, visão de trabalho | travada 11.400 ms, 199 frames lentos, p50 47 ms | **travada 15 ms, 0 lentos** |
| Zoom, visão de trabalho | travada 12.684 ms | **2 ms** |
| Arrastar, visão de trabalho | p50 121 ms (8 fps) | **p50 6 ms** |
| Pan, visão geral | travada 11.350 ms | 926 ms |
| Zoom, visão geral | travada 14.786 ms | 1.403 ms |
| Carregar o documento | 3,3 s | 1,5 s |

Foi a maior melhora isolada. **A visão de trabalho já está lisa.** O que sobra está nas etapas abaixo.

## Etapa 1: salvar só o que mudou, com o documento em memória no servidor

**Hoje.** Todo salvamento roda `snapshot()` (stringify de cada root) e mais um `JSON.stringify(doc, null, 2)` do documento inteiro, na thread da UI (`public/editor.js:179,193-200`). Depois manda **26,7 MB** num PUT. O servidor faz o parse e regrava o arquivo inteiro indentado (`server.mjs:899-907`).

**Mudança (protótipo):**
- o `commit()` e o undo anotam os roots alterados;
- o PUT manda só esses roots, a ordem e o meta;
- o servidor mantém o documento em memória, troca os roots e grava o arquivo 300 ms depois da última mudança. O protótipo gravou JSON compacto; **na versão real o arquivo continua indentado** (os `.pen` ficam em repositórios git, e uma linha de 9 MB estragaria o diff). Indentado custa ~30 ms no servidor, fora do caminho da edição.

| | Hoje | Protótipo | Ganho |
|---|---|---|---|
| Travada da UI por salvamento | 465 ms | **75 ms** | −84% |
| Pior frame ao salvar | 236 ms | **63 ms** | −73% |
| CPU por salvamento | 0,79 s | 0,25 s | −68% |
| Trabalho de JS antes de enviar (Bun/JSC) | 33,5 ms | 0,2 ms | ~150× |
| Tamanho do PUT | 26,7 MB | 17 KB | ~1.500× |
| Gravação do arquivo no servidor | 30,6 ms, no caminho do salvamento | ~30 ms indentado, mas **fora** do caminho da edição (8,2 ms se fosse compacto) | sai do caminho crítico |

Também deixa de existir o `base` (o snapshot de todos os roots guardado para sempre), que segura **9 MB de strings** no heap.

**Esforço:** baixo a médio. **Risco:** o merge com escritas externas (outro app gravando o `.pen`) precisa continuar existindo, pelo `fs.watch`, como hoje.

## Etapa 2: o agente edita a memória e o editor recebe um patch

**Hoje.** Cada `execute`:
- lê e faz o parse dos 26,7 MB, roda o snippet e regrava o arquivo inteiro (`doc.mjs:47,72`);
- o editor só fica sabendo pelo `fs.watchFile` a cada 250 ms (`server.mjs:1089`);
- aí ele baixa os 26,7 MB, faz parse, `snapshot` e stringify de cada root para achar a diferença (`public/editor.js:2076-2116`);
- todo screenshot do agente força essa recarga antes (`public/editor.js:2050`).

**Mudança (protótipo):**
- o `execute` roda no documento em memória do servidor;
- o servidor emite um evento SSE `patch` só com os roots alterados;
- o editor troca esses roots e chama `update()`, sem download e sem diff.

| | Hoje | Protótipo | Ganho |
|---|---|---|---|
| Edição do agente até aparecer no canvas | 914 ms (rodada isolada: 383 ms) | **85 ms** (isolada: 76 ms) | **5–10×** |
| Execução no servidor | 352 ms (isolada: 133 ms) | **19 ms** | 7–18× |
| Travada da UI por edição do agente | 639 ms | **182 ms** | −72% |
| Pior frame | 479 ms | 104 ms | −78% |
| CPU por edição | 1,28 s | 0,61 s | −52% |
| `execute` no Bun, sem rede (`bench-data`) | 154 ms | 8,6 ms | 18× |
| Recarga no editor, só o JS (`bench-data`) | 155 ms | ~0 ms | — |

Com 4 agentes em paralelo (`spawn_agents`), o custo de hoje se multiplica por 4 na mesma thread da UI. É aqui que "o app engasga enquanto o agente trabalha".

**Esforço:** médio. **Risco:** hoje o snippet roda numa cópia e "nada é salvo se der erro". Na memória, é preciso desfazer: guardar os roots tocados antes, como o `commit()` do editor já faz.

## Etapa 3: arrastar redesenha só a área do que se move

**Hoje.** Cada `pointermove` do arrasto chama `canvasView.invalidate()` (`public/editor.js:879`; o resize faz o mesmo em `:911`), que redesenha **toda** a cena visível. Isso é barato perto de uma tela e muito caro na visão geral.

**Mudança (protótipo):** `canvasView.damage()` com a área antiga e a nova de cada nó arrastado (a `view.damage` já existe, `public/view.js:147`).

| Arrastar na visão geral (120 movimentos) | Hoje | Protótipo |
|---|---|---|
| Frame p50 | 196 ms (~5 fps) | **48 ms** (~20 fps) |
| Frame p95 | 286–532 ms | 50–143 ms |
| Travada total | 19,7–23,0 s | 3,2–6,1 s |

Na visão de trabalho fica igual (já era liso). **A correção é de duas linhas.** Os 48 ms que sobram são das conexões, na etapa 4.

**Achado para investigar na implementação:** em 2 de 3 rodadas, o protótipo teve **um** frame de ~360–395 ms no começo do arrasto na visão de trabalho, com as conexões visíveis. Com as conexões ocultas, isso não aparece.

## Etapa 4: conexões leves na visão geral

**Hoje.** Mesmo depois da etapa 0, na visão geral as 795 conexões estão na tela. A cada frame de pan, zoom ou arrasto, `measureLinks()` + `drawLinks()` + `curve()` reconstroem o SVG e as etiquetas no DOM. No perfil, `drawLinks` e `curve` são o maior custo de JS no pan da visão geral.

**Teto do ganho, medido com as conexões ocultas (⇧L):**

| Visão geral | Conexões visíveis | Conexões ocultas |
|---|---|---|
| Zoom: travada | 1.403 ms, 55 frames lentos | **80 ms, 1 lento** |
| Pan: travada | 926 ms, 34 lentos | 438 ms, 4 lentos |
| Hover: travada | 15 ms | 0 ms |
| Arrastar (com a etapa 3): frame p50 | 48 ms | **6 ms** (liso), travada 12–40 ms |
| Arrastar (sem a etapa 3): frame p50 | 196 ms | 126–183 ms |

As etapas 3 e 4 juntas levam o arrasto na visão geral de **~5 fps para a taxa da tela**.

**Mudança (não prototipada):** abaixo de um zoom, desenhar as conexões no próprio canvas Skia, junto do conteúdo, como uma camada que só é refeita quando elas mudam. Em vez disso, também dá para não montar etiquetas nem caminhos de clique. Durante o arrasto, re-medir só as conexões que tocam o nó arrastado (`connectionsTouching` já existe em `pen-core.js:205`). O ganho real fica entre o medido com as conexões visíveis e o medido com elas ocultas. **Esforço:** médio.

## Etapa 5: pan e zoom da visão geral sem engasgar

Com as etapas 1 a 4, o que sobra na visão geral, com as conexões ocultas, é **pan com 4 frames lentos (pico de ~150 ms)** e zoom quase liso. São as re-renderizações completas quando o pan sai da margem de 512 px ou quando o zoom termina (`public/view.js:93-103,136-141`). Elas rodam na thread da UI e desenham ~1.300 roots.

**Opções:**
- **(a) Nível de detalhe:** abaixo de um zoom, desenhar cada root a partir de uma imagem em cache, em vez de reproduzir a picture inteira. Esforço médio.
- **(b) Render em Worker com OffscreenCanvas**, como o render worker do FigCraft. Esforço alto, e precisa de um protótipo no WKWebView do macOS 14.

**Não prototipei.** O ganho máximo é eliminar esses ~4 frames lentos por gesto, que já é pouco depois da etapa 4. Faça só se ainda incomodar.

## Etapa 6: memória

| Item | Hoje | Depois |
|---|---|---|
| `base` (snapshot de todos os roots, sempre vivo) | 9 MB de strings | 0 (etapa 1) |
| Body do PUT e cópias para o diff na recarga | 26,7 MB por evento, mais as strings do diff | KB (etapas 1 e 2) |
| Undo (string do root inteiro por edição, até 300) | até 4,9 MB numa tela mediana, **até 40,6 MB** na maior | patch por propriedade, com limite em bytes |
| Heap WASM da CanvasKit | 134 MB (não encolhe) | — |
| Processos do navegador de teste (RSS, mediana) | ~695 MB | ~467 MB com as etapas 1–3 (−230 MB, ruidoso) |
| Por aba aberta | 1 `pena-server` (~75 MB) + 1 WebContent | 1 servidor para todas as abas: −75 MB por aba extra |
| Por chat ou agente ativo | 1 `claude` CLI (~300 MB) + 1 `pena-server mcp` | encerrar CLIs ociosos depois de N min; limitar `spawn_agents` |

O WebContent do app real (~0,9–1 GB) é o maior bloco. Com 134 MB de WASM e um heap de JS na casa de 250 MB (medido no Chrome), sobra uma parte que não sei atribuir sem um heap snapshot do Web Inspector. Faça esse snapshot depois das etapas 1 e 2, porque elas tiram as maiores fontes de strings temporárias.

## Ordem recomendada

| # | Etapa | Ganho medido | Esforço |
|---|---|---|---|
| 1 | Arrasto com damage (etapa 3) | arrasto na visão geral 196 → 48 ms/frame | **2 linhas** |
| 2 | Salvar só o que mudou + doc em memória (etapa 1) | travada ao salvar −84%, PUT 26,7 MB → 17 KB | baixo/médio |
| 3 | Agente na memória + patch SSE (etapa 2) | edição do agente 5–10× mais rápida, travada −72% | médio |
| 4 | Conexões leves na visão geral (etapa 4) | zoom da visão geral −94%, arrasto 48 → 6 ms | médio |
| 5 | Memória: undo por patch, 1 servidor por app, CLIs ociosos | dezenas a centenas de MB | médio |
| 6 | LOD ou worker no render (etapa 5) | ~4 frames lentos por gesto | médio/alto |

## E a v2?

As medições confirmam o relatório anterior: **os gargalos estão no desenho dos dados e no que roda a cada frame, não na linguagem.**
- Três dos quatro pontos de travada caem de 5× a 30× com mudanças locais no código atual.
- A visão de trabalho já está na taxa da tela.
- Uma reescrita em Rust que mantivesse "arquivo como fonte da verdade, re-serializar tudo, redesenhar tudo no arrasto" teria os mesmos problemas.

Faça as etapas 1 a 4 e meça de novo com os scripts. Só considere a v2 se o WebContent continuar na casa de 1 GB depois disso, e o heap snapshot mostrar que a causa é a própria CanvasKit/WebKit.

## Limitações

- **Ruído:** a máquina estava em uso, e a taxa de frames do WebKit do Playwright variou entre rodadas (6, 14 e 17 ms). Por isso a travada é medida contra 16,7 ms. Diferenças abaixo de ~30% não são conclusivas. Os ganhos das etapas 1 a 4 são de 3× a 30× e se repetiram em todas as rodadas.
- **Motor:** o WebKit do Playwright é o mesmo motor do WKWebView, mas não é o app empacotado. O app real não deu para dirigir por script.
- **Pan e zoom da visão geral:** saíram um pouco piores no protótipo (travada de 2,1 s contra 2,6 s no pan, e 2,0 s contra 5,2 s no zoom). O protótipo não mexe nesse código, e a ordem se inverteu entre as rodadas, então tratei como ruído.
- **O protótipo não é produção:**
  - o `touched` do `execute` não registra `Delete` dentro de um root;
  - um erro no snippet recarrega o documento do disco, em vez de desfazer os roots tocados;
  - o merge com escritas externas foi simplificado;
  - o pico de ~380 ms no começo de um arrasto com conexões visíveis precisa ser entendido.
- Não medi a memória do FigCraft rodando (ver `figcraft.md`).

## Como repetir

```sh
# servidor de teste isolado com uma cópia do documento
HOME=/tmp/pena-bench/home PORT=4600 bun server.mjs /tmp/pena-bench/proj/consumer/consumer.pen
# gestos, salvar e agente (WebKit, 3 rodadas, restaura o documento a cada rodada)
bun scripts/bench-ui.mjs webkit http://127.0.0.1:4600 3 /tmp/pena-bench/pristine.pen
LINKS_HIDDEN=1 bun scripts/bench-ui.mjs webkit http://127.0.0.1:4600 3 /tmp/pena-bench/pristine.pen
# arrasto (página nova a cada vez)
bun scripts/bench-drag.mjs http://127.0.0.1:4600 /tmp/pena-bench/pristine.pen
# caminhos de dados no JavaScriptCore (escreve só <arquivo>.bench, apagado no fim)
bun scripts/bench-data.mjs /tmp/pena-bench/pristine.pen 21
```

Os scripts de navegador usam o `playwright-core` e os navegadores já instalados em `~/node_modules` e `~/Library/Caches/ms-playwright`. Eles não são dependência do Pena.
