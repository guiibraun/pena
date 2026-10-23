const translations = new Map();
const add = (english, portuguese, ...sources) => {
  for (const source of new Set([english, portuguese, ...sources])) translations.set(source, [english, portuguese]);
};

// Both spellings are accepted so the same UI can be switched repeatedly without losing its source text.
[
  ['Settings', 'Configurações', 'Configuração'],
  ['General', 'Geral'],
  ['Agents', 'Agentes'],
  ['MCP', 'MCP'],
  ['Language', 'Idioma'],
  ['Interface language', 'Idioma da interface'],
  ['Automatic (system language)', 'Automático (idioma do sistema)'],
  ['English', 'English'],
  ['Português (Brasil)', 'Português (Brasil)'],
  ['The app follows your system language. You can choose a language here at any time.', 'O app acompanha o idioma principal do sistema. Você pode escolher um idioma aqui a qualquer momento.'],
  ['Language changes are saved on this device.', 'A escolha de idioma fica salva neste dispositivo.'],
  ['Close (Esc)', 'Fechar (Esc)'],
  ['Settings (⌘,)', 'Configurações (⌘,)'],
  ['Close', 'Fechar'],
  ['Loading…', 'Carregando…'],
  ['Dashboard', 'Dashboard', 'Painel'],
  ['Recent', 'Recentes'],
  ['Drafts', 'Rascunhos'],
  ['Templates', 'Templates', 'Modelos'],
  ['Design Systems', 'Design Systems'],
  ['Open file', 'Abrir arquivo'],
  ['Open file…', 'Abrir arquivo…'],
  ['Open', 'Abrir'],
  ['New file', 'Novo arquivo'],
  ['New file…', 'Novo arquivo…'],
  ['Open recent', 'Abrir recente'],
  ['Remove from recent', 'Remover dos recentes'],
  ['No recent files', 'Nenhum arquivo recente'],
  ['No drafts yet — start with the prompt above.', 'Nenhum rascunho ainda — comece pelo prompt acima.'],
  ['No recent files.', 'Nenhum arquivo recente.'],
  ['Last used ⌄', 'Último uso ⌄'],
  ['Created', 'Criado'],
  ['Name', 'Nome'],
  ['Grid', 'Grade'],
  ['List', 'Lista'],
  ['Import from Figma', 'Importar do Figma'],
  ['Import image', 'Importar imagem'],
  ['Recreate a screenshot', 'Recriar um screenshot'],
  ['Open .pen file', 'Abrir arquivo .pen'],
  ['Choose a .fig file…', 'Escolher arquivo .fig…'],
  ['Create new file', 'Criar arquivo novo'],
  ['Home', 'Início'],
  ['No .pen folders or files here', 'Nenhuma pasta ou arquivo .pen aqui'],
  ['Open a design system file (.pen with reusable components) — for example, the pen.dev libraries in /Applications/Pen.app — or ask the agent to create one.', 'Abra um arquivo de design system (.pen com componentes reutilizáveis) — por exemplo, as bibliotecas do pen.dev em /Applications/Pen.app — ou peça ao agente para criar um.'],
  ['Draw anything… (/ for skills)', 'Desenhe qualquer coisa… (/ para skills)'],
  ['A landing page for ', 'Uma landing page para '],
  ['Mobile app screens for ', 'Telas de app mobile para '],
  ['A web app (functional dashboard) for ', 'Um web app (dashboard funcional) para '],
  ['A slide presentation about ', 'Uma apresentação de slides sobre '],
  ['A metrics dashboard for ', 'Um dashboard de métricas para '],
  ['Something else…', 'Outra coisa…'],
  ['Landing page', 'Landing page', 'Página de destino'],
  ['Mobile app', 'App mobile', 'Aplicativo móvel'],
  ['Web app', 'Web app', 'Aplicativo web'],
  ['Slides', 'Slides', 'Apresentação'],
  ['Other…', 'Outra coisa…'],
  ['Create a design using the attached skill.', 'Crie um design usando a skill anexada.'],
  ['Recreate this screenshot as an editable design.', 'Recrie este screenshot como um design editável.'],
  ['1) Copy and paste:', '1) Copiar/colar:'],
  ['copy any layer or frame in Figma and paste it onto the canvas. Images are not included.', 'copie qualquer camada ou frame no Figma e cole no canvas. As imagens não vêm junto.'],
  ['2) .fig file:', '2) Arquivo .fig:'],
  ['to import everything, including images, export a .fig from Figma (File → Save local copy) and choose it below or drag it onto the canvas.', 'para importar tudo, com imagens, exporte um .fig no Figma (File → Save local copy) e escolha-o abaixo ou arraste-o para o canvas.'],
  ['Some advanced graphic features are not supported yet. If the file has multiple pages, you can choose which one to import.', 'Alguns recursos gráficos avançados ainda não são suportados. Em arquivos com várias páginas, você escolhe qual importar.'],
  ['No draft yet — start with the prompt above.', 'Nenhum rascunho ainda — comece pelo prompt acima.'],
  ['Settings', 'Configurações'],
  ['Agent', 'Agente'],
  ['Layers', 'Camadas'],
  ['Components', 'Componentes'],
  ['Conversation', 'Conversa'],
  ['New agent', 'Novo agente'],
  ['New', 'Nova'],
  ['Attach files (any type)', 'Anexar arquivos (qualquer tipo)'],
  ['Attach image', 'Anexar imagem'],
  ['Parallel agents', 'Agentes em paralelo'],
  ['Drag to resize · double-click to reset', 'Arraste para redimensionar · duplo clique para voltar'],
  ['Model reasoning (effort): how much it thinks before answering', 'Raciocínio do modelo (effort): quanto ele pensa antes de responder'],
  ['Model', 'Modelo'],
  ['Send', 'Enviar'],
  ['Send (Enter)', 'Enviar (Enter)'],
  ['Stop', 'Parar'],
  ['Move (V)', 'Mover (V)'],
  ['Frame (F)', 'Frame (F)', 'Quadro (F)'],
  ['Rectangle (R)', 'Retângulo (R)'],
  ['Ellipse (O)', 'Elipse (O)'],
  ['Line (L)', 'Linha (L)'],
  ['Text (T)', 'Texto (T)'],
  ['Icon (I)', 'Ícone (I)'],
  ['Note (N)', 'Nota (N)'],
  ['Prompt (P)', 'Prompt (P)'],
  ['Web page (W)', 'Página web (W)'],
  ['Hand (H / space)', 'Mão (H / espaço)'],
  ['Image', 'Imagem'],
  ['Insert component', 'Inserir componente'],
  ['Preview selected frame', 'Pré-visualizar frame selecionado'],
  ['Export', 'Exportar'],
  ['Preview theme', 'Pré-visualizar tema'],
  ['Properties panel', 'Painel de propriedades'],
  ['Chat panel', 'Painel do chat'],
  ['Decrease zoom (⌘-)', 'Diminuir zoom (⌘-)'],
  ['Increase zoom (⌘+)', 'Aumentar zoom (⌘+)'],
  ['Show/hide panels (⌘\\)', 'Mostrar/ocultar painéis (⌘\\)'],
  ['Show/hide', 'Mostrar/ocultar'],
  ['File', 'Arquivo'],
  ['AI providers', 'Provedores de IA'],
  ['Connect your AI providers', 'Conecte seus provedores de IA'],
  ['Pena uses the tokens from your subscriptions: it connects to Claude Code, Codex, and OpenCode already signed in on this Mac. No API key needed. Claude and Codex accept several accounts, each with its own login.', 'O Pena usa os tokens das suas assinaturas: ele se conecta ao Claude Code, ao Codex e ao OpenCode já logados neste Mac. Nada de API key. Claude e Codex aceitam várias contas, cada uma com o seu próprio login.'],
  ['Providers', 'Provedores'],
  ['Accounts', 'Contas'],
  ['Type', 'Tipo'],
  ['Add account', 'Adicionar conta'],
  ['Account name (e.g. Work)', 'Nome da conta (ex.: Trabalho)'],
  ['Claude and Codex accept several accounts.', 'Claude e Codex aceitam várias contas.'],
  ['Account name', 'Nome da conta'],
  ['Remove account', 'Remover conta'],
  ['Remove this account? The CLI login stays in ~/.pena/accounts.', 'Remover esta conta? O login do CLI continua em ~/.pena/accounts.'],
  ['Connection', 'Conexão'],
  ['Status', 'Status'],
  ['Method', 'Método'],
  ['Plan', 'Plano'],
  ['Account', 'Conta'],
  ['Organization', 'Organização'],
  ['CLI', 'CLI'],
  ['Logged in', 'Logado'],
  ['Not logged in', 'Não logado'],
  ['Not connected', 'Não conectado'],
  ['Connected', 'Conectado'],
  ['Not installed', 'Não instalado'],
  ['CLI unavailable', 'CLI indisponível'],
  ['Not found', 'Não encontrado'],
  ['Testing…', 'Testando…'],
  ['Test failed', 'Falhou no teste'],
  ['Active', 'Ativo'],
  ['Out of date', 'Desatualizado'],
  ['Off', 'Desligado'],
  ['Test connection now (makes a minimal model call)', 'Testar conexão agora (faz uma chamada mínima ao modelo)'],
  ['Switch account in Terminal', 'Trocar de conta no Terminal'],
  ['Sign in in Terminal', 'Fazer login no Terminal'],
  ['Check again', 'Verificar de novo'],
  ['Available models', 'Modelos disponíveis'],
  ['No models — check your login.', 'Nenhum modelo — verifique o login.'],
  ['No servers added. Pena agents use only design tools.', 'Nenhum servidor extra. Os agentes do Pena usam só as ferramentas de design.'],
  ['Use Pena in other agents', 'Usar o Pena em outros agentes'],
  ['Register Pena’s MCP server in your tools so they can draw in the file open here. Claude Code and Codex are configured by their own CLIs; other clients get a backup before their first edit.', 'Registra o MCP do Pena nas suas ferramentas, para que elas desenhem no arquivo aberto aqui. Claude Code e Codex são configurados pelos próprios CLIs; os outros recebem um backup antes da primeira edição.'],
  ['MCP servers for Pena agents', 'Servidores MCP para os agentes do Pena'],
  ['Give canvas agents tools from your own MCP servers (same format as Claude Code: command/args or url).', 'Dá aos agentes do canvas ferramentas dos seus próprios servidores MCP (mesmo formato do Claude Code: command/args ou url).'],
  ['Popular', 'Populares'],
  ['Undo', 'Desfazer'],
  ['Save', 'Salvar'],
  ['Invalid JSON', 'JSON inválido'],
  ['Remove Pena from this client', 'Remover o Pena deste cliente'],
  ['Register Pena with this client', 'Registrar o Pena neste cliente'],
  ['Point to this app', 'Apontar para este app'],
  ['Update', 'Atualizar'],
  ['Test', 'Testar'],
  ['Test connection', 'Testar conexão'],
  ['Connecting…', 'Conectando…'],
  ['No skill found', 'Nenhuma skill encontrada'],
  ['Add skill…', 'Adicionar skill…'],
  ['Path to a skill folder (or SKILL.md):', 'Caminho de uma pasta de skill (ou do SKILL.md):'],
  ['One agent', 'Um agente'],
  ['{count} parallel variations', 'variações em paralelo'],
  ['Up to {count} agents sharing the task', 'Até agentes dividindo a tarefa'],
  ['1x — one agent', '1x — um agente'],
  ['With more than one agent', 'Com mais de um agente'],
  ['Split the task between them', 'Dividir a tarefa entre eles'],
  ['Side-by-side variations', 'Variações lado a lado'],
  ['Continue with this one', 'Continuar com esta'],
  ['Wait for every variation to finish.', 'Espere todas as variações terminarem.'],
  ['This round of variations is no longer active.', 'Essa rodada de variações não está mais ativa.'],
  ['No results found', 'Nada encontrado'],
  ['Search models…', 'Buscar modelos…'],
  ['This model has no reasoning levels', 'Este modelo não tem níveis de raciocínio'],
  ['Reasoning', 'Raciocínio'],
  ['None', 'Nenhum'],
  ['Minimal', 'Mínimo'],
  ['Low', 'Baixo'],
  ['Medium', 'Médio'],
  ['High', 'Alto'],
  ['Very high', 'Muito alto'],
  ['Maximum', 'Máximo'],
  ['default', 'padrão'],
  ['Default', 'Padrão'],
  ['Position', 'Posição'],
  ['Dimensions', 'Dimensões'],
  ['Appearance', 'Aparência'],
  ['Typography', 'Tipografia'],
  ['Fill', 'Preenchimento'],
  ['Stroke', 'Traço'],
  ['Effects', 'Efeitos'],
  ['Flex Layout', 'Layout Flex'],
  ['Arc', 'Arco'],
  ['Polygon', 'Polígono'],
  ['Web page', 'Página web'],
  ['Code', 'Código'],
  ['Export layer', 'Exportar camada'],
  ['Document', 'Documento'],
  ['Context', 'Contexto'],
  ['Alignment', 'Alinhamento'],
  ['Top', 'Topo'],
  ['Middle', 'Meio'],
  ['Bottom', 'Base'],
  ['Left', 'Esquerda'],
  ['Center', 'Centro'],
  ['Right', 'Direita'],
  ['Justify', 'Justificar'],
  ['Sides', 'Lados'],
  ['Zoom', 'Zoom'],
  ['Text color', 'Cor do texto'],
  ['No fill', 'Sem preenchimento'],
  ['No image', 'Sem imagem'],
  ['Solid color', 'Cor sólida'],
  ['Gradient', 'Gradiente'],
  ['Linear gradient', 'Gradiente linear'],
  ['Radial gradient', 'Gradiente radial'],
  ['Angular gradient', 'Gradiente angular'],
  ['Fill', 'Preencher'],
  ['Fit', 'Ajustar'],
  ['Stretch', 'Esticar'],
  ['Replace', 'Trocar'],
  ['Remove', 'Remover'],
  ['Opacity', 'Opacidade'],
  ['Corner radius', 'Raio dos cantos'],
  ['Radius per corner', 'Raio por canto'],
  ['Clip content', 'Recortar conteúdo'],
  ['Visible', 'Visível'],
  ['Rotation (counterclockwise)', 'Rotação (anti-horária)'],
  ['Rotate 90°', 'Girar 90°'],
  ['Flip horizontal', 'Espelhar horizontal'],
  ['Flip vertical', 'Espelhar vertical'],
  ['Absolute position (ignores layout)', 'Posição absoluta (ignora o layout)'],
  ['Positioned by the parent Flex Layout.', 'Posicionado pelo Flex Layout do pai.'],
  ['Fill width', 'Preencher largura', 'Fill Width'],
  ['Fill height', 'Preencher altura', 'Fill Height'],
  ['Hug width', 'Ajustar à largura do conteúdo', 'Hug Width'],
  ['Hug height', 'Ajustar à altura do conteúdo', 'Hug Height'],
  ['Auto (no wrap)', 'Auto (não quebra)'],
  ['Fixed width (wrap)', 'Largura fixa (quebra)'],
  ['Fixed size', 'Tamanho fixo'],
  ['Inside', 'Dentro'],
  ['Outside', 'Fora'],
  ['Solid', 'Sólida'],
  ['Variable', 'Variável'],
  ['Use variable', 'Usar variável'],
  ['Variables', 'Variáveis'],
  ['Unlink variable', 'Desvincular variável'],
  ['No variable of this type', 'Nenhuma variável deste tipo'],
  ['Add variable', 'Adicionar variável'],
  ['New color variable', 'Nova variável de cor'],
  ['Variable name (e.g. primary):', 'Nome da variável (ex.: primary):'],
  ['Value depends on theme', 'Valor depende do tema'],
  ['No variables. Ask the agent: “create light and dark color variables”.', 'Sem variáveis. Peça ao agente: “crie variáveis de cor para claro e escuro”.'],
  ['Themes come from variables with values per theme (e.g. Mode: Light/Dark).', 'Temas surgem de variáveis com valores por tema (ex.: Mode: Light/Dark).'],
  ['Themes', 'Temas'],
  ['Theme', 'Tema'],
  ['File fonts', 'Fontes do arquivo'],
  ['Primary component', 'Componente principal'],
  ['Instance', 'Instância'],
  ['Undo', 'Desfazer'],
  ['Component', 'Componente'],
  ['Unlink', 'Desvincular'],
  ['Open library', 'Abrir biblioteca'],
  ['The component lives in another file (library): edit it there', 'O componente vem de outro arquivo (biblioteca): edite-o lá'],
  ['Detach instance', 'Transforma a instância em nós normais'],
  ['Reset overrides', 'Resetar overrides'],
  ['Create component', 'Criar componente'],
  ['Notes for the agent about this element', 'Notas para o agente sobre este elemento'],
  ['Hide panel', 'Ocultar painel'],
  ['Spacing', 'Espaçamento'],
  ['Simple', 'Simples'],
  ['Per side', 'Por lado'],
  ['Vertical', 'Vertical'],
  ['Horizontal', 'Horizontal'],
  ['Free (no layout)', 'Livre (sem layout)'],
  ['Space Between', 'Espaço entre'],
  ['Space Around', 'Espaço ao redor'],
  ['Add effect', 'Adicionar efeito'],
  ['Shadow', 'Sombra'],
  ['Inner shadow', 'Sombra interna'],
  ['Blur', 'Desfoque'],
  ['Background blur', 'Desfoque de fundo'],
  ['Shader library', 'Biblioteca de shaders'],
  ['None', 'Nenhuma'],
  ['Load .glsl…', 'Carregar .glsl…'],
  ['Search shaders', 'Buscar shader'],
  ['Loading shader…', 'Carregando shader…'],
  ['Shader not found', 'Shader não encontrado'],
  ['This layer', 'Esta camada'],
  ['Backdrop', 'Fundo'],
  ['Shadows, blurs and shaders', 'Sombras, desfoques e shaders'],
  ['Line height (× size)', 'Altura da linha (× tamanho)'],
  ['Letter spacing', 'Espaçamento entre letras'],
  ['Italic', 'Itálico'],
  ['Underline', 'Sublinhado'],
  ['Strikethrough', 'Tachado'],
  ['Link (optional)', 'Link (opcional)'],
  ['Icon name', 'nome do ícone'],
  ['Browse icons ↗', 'Procurar ícones ↗'],
  ['Copy HTML', 'Copiar HTML'],
  ['HTML copied', 'HTML copiado'],
  ['Export HTML', 'Exportar HTML'],
  ['Copy link for the agent', 'Copiar link para o agente'],
  ['Paste the link in Claude Code/Codex: “implement this link in Next.js”.', 'Cole o link no Claude Code/Codex: “implemente este link em Next.js”.'],
  ['Advanced JSON', 'JSON avançado'],
  ['Override JSON', 'JSON dos overrides'],
  ['Per-side widths (JSON)', 'Larguras por lado (JSON)'],
  ['Component instance changes become overrides for this instance only.', 'Dentro de uma instância: alterações viram overrides só desta instância.'],
  ['No components. Select a frame and click “Create component” in the properties panel (⌘⌥K).', 'Nenhum componente. Selecione um frame e clique em “Criar componente” no painel de propriedades (⌘⌥K).'],
  ['No components in this file', 'Nenhum componente no arquivo'],
  ['Insert instance', 'Inserir instância'],
  ['Search variables', 'Buscar variáveis'],
  ['Look up variable', 'Usar variável'],
  ['Frame', 'Frame', 'Quadro'],
  ['Group', 'Grupo'],
  ['Rectangle', 'Retângulo'],
  ['Ellipse', 'Elipse'],
  ['Vector', 'Vetor'],
  ['Icon', 'Ícone'],
  ['Line', 'Linha'],
  ['Note', 'Nota'],
  ['Browser page', 'Página web'],
  ['Script', 'Script'],
  ['No components.', 'Nenhum componente.'],
  ['Create a reusable component', 'Criar componente'],
  ['Fit all (⇧1)', 'Ajustar tudo (⇧1)'],
  ['Zoom to selection (⇧2)', 'Zoom na seleção (⇧2)'],
  ['Select a Figma page to import', 'Página do Figma para importar'],
  ['Imported Figma page “{name}”', 'Importada a página “{name}” do Figma'],
  ['This file has no themes', 'Este arquivo não tem temas'],
  ['Preview', 'Pré-visualização'],
  ['Export selection…', 'Exportar seleção…'],
  ['Export “{name}”', 'Exportar “{name}”'],
  ['Whole document', 'documento inteiro'],
  ['Nothing to export', 'Nada para exportar'],
  ['File could not be saved — is the app still running?', 'Falha ao salvar — o app ainda está rodando?'],
  ['Page URL:', 'URL da página:'],
  ['Drag onto another screen to link them', 'Arraste até outra tela para conectar'],
  ['These layers are already linked', 'Essas camadas já estão conectadas'],
  ['Describe the interaction (e.g. on click, after submit):', 'Descreva a interação (ex.: ao clicar, depois de enviar):'],
  ['Double-click to describe · Delete removes', 'Duplo clique para descrever · Delete remove'],
  ['Open file…', 'Abrir arquivo…'],
  ['Ask it to draw anything', 'Peça para desenhar qualquer coisa'],
  ['Generate code', 'Gerar código'],
  ['Ask the agent to implement the design in React, Tailwind, Next.js, or your preferred stack. For HTML, select a frame and use “Export HTML” in the properties panel.', 'Peça ao agente para implementar o design em React, Tailwind, Next.js ou a stack que preferir. Para um HTML, selecione um frame e use “Exportar HTML” no painel de propriedades.'],
  ['Attach context', 'Anexar contexto'],
  ['Drag any file (HTML, PDF, images, code, CSV…) to the composer, paste with ⌘V, or attach it with +.', 'Arraste qualquer arquivo (HTML, PDF, imagens, código, CSV…) para o compositor, cole com ⌘V no campo ou anexe pelo +.'],
  ['Press Enter to queue · ⌘Enter to steer now', 'Enter põe na fila · ⌘Enter redireciona agora'],
  ['Send now (steer the agent)', 'Enviar agora (redireciona o agente)'],
  ['Remove from queue', 'Tirar da fila'],
  ['Current selection will be sent with the message', 'Seleção atual vai junto com a mensagem'],
  ['Selected layer, sent with the message', 'Camada selecionada, enviada junto'],
  ['Conversations in this file', 'Conversas deste arquivo'],
  ['Delete current conversation', 'Apagar a conversa atual'],
  ['Delete this conversation?', 'Apagar esta conversa?'],
  ['No saved conversations yet', 'Nenhuma conversa salva ainda'],
  ['Copied link', 'Link copiado'],
  ['Could not copy: {error}', 'Não foi possível copiar: {error}'],
  ['Plan', 'Plano'],
  ['Thinking', 'Pensando'],
  ['Working', 'Trabalhando'],
  ['Thought', 'Pensou'],
  ['Planning next steps', 'Planejando próximos passos'],
  ['Done', 'Concluído'],
  ['Stopped', 'Interrompido'],
  ['Oops, something went wrong with {provider}!', 'Ops, algo deu errado com o {provider}!'],
  ['Open {provider} in Terminal', 'Abrir o {provider} no Terminal'],
  ['Cost (API equivalent)', 'Custo (equivalente na API)'],
  ['Input tokens', 'Tokens de entrada'],
  ['Output tokens', 'Tokens de saída'],
  ['Cache read', 'Cache lido'],
  ['Cache written', 'Cache escrito'],
  ['Turns', 'Turnos'],
  ['Result', 'Resultado'],
  ['Input', 'Entrada'],
  ['Edits', 'Edições'],
  ['Drawn', 'Desenhou'],
  ['Drawing', 'Desenhando'],
  ['Read editor state', 'Leu o estado do editor'],
  ['Reading editor state', 'Lendo o estado do editor'],
  ['Read the skill', 'Leu a skill'],
  ['Reading the skill', 'Lendo a skill'],
  ['Started agents', 'Iniciou agentes'],
  ['Starting agents', 'Iniciando agentes'],
  ['Checked styles', 'Verificou estilos'],
  ['Checking styles', 'Verificando estilos'],
  ['Searched the web', 'Pesquisou na web'],
  ['Searching the web', 'Pesquisando na web'],
  ['Read a page', 'Leu uma página'],
  ['Reading a page', 'Lendo uma página'],
  ['Read the attachment', 'Leu o anexo'],
  ['Reading the attachment', 'Lendo o anexo'],
  ['Ran a command', 'Rodou um comando'],
  ['Running a command', 'Rodando um comando'],
  ['Prepared tools', 'Preparou ferramentas'],
  ['Preparing tools', 'Preparando ferramentas'],
  ['Settings', 'Configurações'],
  ['Recent', 'Recentes'],
  ['Created', 'Criado'],
  ['No fill', 'Sem preenchimento'],
  ['Auto', 'Auto'],
  ['Apply', 'Aplicar'],
  ['Select a folder', 'Selecione uma pasta'],
  ['Choose file', 'Escolher arquivo'],
  ['Import image/SVG/Figma…', 'Importar imagem/SVG/Figma…'],
  ['Open all files', 'Abrir todos os arquivos'],
  ['Show in Finder', 'Mostrar no Finder'],
  ['Show in Explorer', 'Mostrar no Explorador'],
  ['Could not configure', 'Não configurado'],
  ['Not configured', 'Não configurado'],
  ['MCP server not found', 'Servidor não encontrado'],
  ['Not logged in to Claude Code', 'Não está logado no Claude Code'],
  ['Not logged in to Codex', 'Não está logado no Codex'],
  ['Free models from OpenCode Zen', 'Modelos grátis da OpenCode Zen'],
  ['OpenCode not found (install from opencode.ai)', 'OpenCode não encontrado (instale em opencode.ai)'],
  ['Authentication required (OAuth/token)', 'Precisa de autenticação (OAuth/token)'],
  ['The selected path does not contain a SKILL.md', 'O caminho escolhido não tem um SKILL.md'],
  ['“pena” is reserved for Pena’s own server', '“pena” é reservado para o servidor do próprio Pena'],
  ['There was an error saving the file. Is the app still running?', 'Falha ao salvar — o app ainda está rodando?'],
  ['for skills', 'para skills'],
  ['Edited', 'Editado'],
  ['Opened', 'Aberto'],
  ['Resize selected frame', 'Redimensionar frame selecionado'],
  ['In', 'Dentro', 'Inner'],
  ['Radius', 'Raio'],
  ['Main axis', 'Eixo principal'],
  ['Cross axis', 'Eixo transversal'],
  ['End', 'Fim'],
  ['Start', 'Início'],
  ['Fixed', 'Fixo'],
  ['Fit content', 'Ajustar ao conteúdo'],
  ['Inherited', 'Herdado'],
  ['Add fill', 'Adicionar preenchimento'],
  ['Add stroke', 'Adicionar traço'],
  ['Preencher', 'Preencher'],
  ['Thin', 'Fino'],
  ['Extra Light', 'Extra leve'],
  ['Light', 'Leve'],
  ['Regular', 'Regular'],
  ['Medium', 'Médio'],
  ['Semi Bold', 'Seminegrito'],
  ['Bold', 'Negrito'],
  ['Extra Bold', 'Extra negrito'],
  ['Black', 'Preto'],
  ['Signing in opens Claude Code in Terminal; run /login there. Pena uses the same sign-in (claude.ai, Pro/Max).', 'O login abre o Claude Code no Terminal; use /login lá dentro. O Pena lê o mesmo login (claude.ai, Pro/Max).'],
  ['Signing in opens codex login in Terminal and connects your ChatGPT account.', 'O login abre codex login no Terminal, que entra com sua conta ChatGPT.'],
  ['Signing in opens opencode auth login in Terminal: OpenCode Zen/Go, OpenRouter, OpenAI, and others. Zen free models work without signing in.', 'O login abre opencode auth login no Terminal: OpenCode Zen/Go, OpenRouter, OpenAI e outros. Os modelos grátis da Zen funcionam sem login.'],
  ['Signing in opens `codex login` in Terminal and connects your ChatGPT account.', 'O login abre `codex login` no Terminal, que entra com sua conta ChatGPT.'],
  ['Signing in opens `opencode auth login` in Terminal: OpenCode Zen/Go, OpenRouter, OpenAI, and others. Zen free models work without signing in.', 'O login abre `opencode auth login` no Terminal: OpenCode Zen/Go, OpenRouter, OpenAI e outros. Os modelos grátis da Zen funcionam sem login.'],
  ['Choose a language', 'Escolha um idioma'],
  ['System language', 'Idioma do sistema'],
  ['No components. Select a frame and click “Create component” in the properties panel (⌘⌥K).', 'Nenhum componente. Selecione um frame e clique em “Criar componente” no painel de propriedades (⌘⌥K).'],
  ['Insert a component', 'Inserir componente'],
  ['Select all', 'Selecionar tudo'],
  ['Export whole document', 'Exportar documento inteiro'],
  ['Could not update', 'Não deu para atualizar'],
  ['System language', 'Idioma do sistema'],
  ['Provider list', 'Lista de provedores'],
  ['All models', 'Todos os modelos'],
  ['Connected to account', 'Conectado à conta'],
  ['Account models', 'Modelos da sua conta'],
  ['Connected', 'Conectado'],
  ['Live test failed', 'Falhou no teste'],
  ['Login in Terminal', 'Fazer login no Terminal'],
  ['Switch account in Terminal', 'Trocar de conta no Terminal'],
  ['Check again', 'Verificar de novo'],
  ['Model not found', 'Modelo não encontrado'],
  ['No models — check your login.', 'Nenhum modelo — verifique o login.'],
  ['Close (Esc)', 'Fechar (Esc)'],
  ['Test connection now (makes a minimal model call)', 'Testar conexão agora (faz uma chamada mínima ao modelo)'],
  ['A landing page for ', 'Uma landing page para '],
  ['Mobile app screens for ', 'Telas de app mobile para '],
  ['A web app (functional dashboard) for ', 'Um web app (dashboard funcional) para '],
  ['A slide presentation about ', 'Uma apresentação de slides sobre '],
  ['A metrics dashboard for ', 'Um dashboard de métricas para '],
  ['Draw anything… (/ for skills)', 'Desenhe qualquer coisa… (/ para skills)'],
  ['Copy', 'Copiar'],
  ['Copied', 'Copiado'],
  ['Search models…', 'Buscar modelos…'],
  ['Search variables', 'Buscar variáveis'],
  ['Nothing found', 'Nada encontrado'],
  ['No results found', 'Nada encontrado'],
  ['Find models', 'Buscar modelos'],
  ['Your subscription', 'Sua assinatura'],
  ['Your providers', 'Seus provedores'],
  ['Providers', 'Provedores'],
  ['No components. Select a frame and click “Create component” in the properties panel (⌘⌥K).', 'Nenhum componente. Selecione um frame e clique em “Criar componente” no painel de propriedades (⌘⌥K).'],
  ['No components in this file', 'Nenhum componente no arquivo'],
  ['Component', 'Componente'],
  ['Detach', 'Desvincular'],
  ['File', 'Arquivo'],
  ['Document', 'Documento'],
  ['Text', 'Texto'],
  ['Text label', 'Rótulo de texto'],
  ['Color', 'Cor'],
  ['Fill', 'Preenchimento'],
  ['Stroke', 'Traço'],
  ['Effects', 'Efeitos'],
  ['Gap', 'Espaçamento'],
  ['Padding', 'Espaçamento interno'],
  ['Clip Content', 'Recortar conteúdo'],
  ['Layers', 'Camadas'],
  ['Components', 'Componentes'],
  ['Skill', 'Skill'],
  ['Skills', 'Skills'],
  ['JSON advanced', 'JSON avançado'],
  ['Advanced JSON', 'JSON avançado'],
  ['Invalid JSON', 'JSON inválido'],
  ['Something went wrong', 'Algo deu errado'],
  ['Average response time', 'Tempo médio de resposta'],
  ['No conversation saved yet', 'Nenhuma conversa salva ainda'],
  ['No conversations saved yet', 'Nenhuma conversa salva ainda'],
  ['No components found', 'Nenhum componente encontrado'],
  ['Loading…', 'Carregando…'],
  ['Image', 'Imagem'],
  ['Text (T)', 'Texto (T)'],
  ['Header', 'Cabeçalho'],
  ['Footer', 'Rodapé'],
  ['Name', 'Nome'],
  ['No image', 'Sem imagem'],
  ['Remove from recent', 'Remover dos recentes'],
  ['Recent files', 'Arquivos recentes'],
  ['No draft yet — start with the prompt above.', 'Nenhum rascunho ainda — comece pelo prompt acima.'],
  ['No recent file.', 'Nenhum arquivo recente.'],
  ['English language', 'Idioma inglês'],
  ['The agent is working', 'O agente está trabalhando'],
  ['A new file', 'Um novo arquivo'],
  ['Show/hide properties', 'Mostrar/ocultar propriedades'],
  ['Hide properties panel', 'Ocultar painel de propriedades'],
  ['Insert a component instance', 'Inserir instância'],
  ['Clip content', 'Recortar conteúdo'],
  ['Show or hide', 'Mostrar/ocultar'],
  ['Space between', 'Espaço entre'],
  ['Space around', 'Espaço ao redor'],
  ['Start a design from the prompt above.', 'Comece um design pelo prompt acima.'],
  ['Open a .pen file', 'Abrir arquivo .pen'],
  ['Could not save the file — is the app still running?', 'Falha ao salvar — o app ainda está rodando?'],
  ['This file has no themes', 'Este arquivo não tem temas'],
  ['No themes in this file', 'Este arquivo não tem temas'],
  ['Some features are not supported yet.', 'Alguns recursos ainda não são suportados.'],
  ['No file selected', 'Nenhum arquivo selecionado'],
  ['No components yet', 'Nenhum componente ainda'],
  ['Expand', 'Expandir'],
  ['Collapse', 'Recolher'],
  ['Shadows and blurs', 'Sombras e desfoques'],
  ['High-contrast real-time trading terminal', 'Terminal de trading em tempo real, alto contraste'],
  ['Retro-futuristic landing page for a private space station', 'Landing page retrô-futurista para uma estação espacial privada'],
  ['A fun matcha cake ordering app', 'App divertido de pedidos para bolos de matcha'],
  ['A soft neumorphic meditation app', 'App de meditação neumórfico suave'],
  ['Editorial portfolio for an avant-garde fashion brand', 'Portfólio editorial para uma marca de moda de vanguarda'],
  ['A cozy mobile app for taking care of plants', 'App mobile aconchegante para cuidar de plantas'],
  ['Describe what the agent should create here…', 'Descreva o que o agente deve criar aqui…'],
  ['Your language choice is saved on this device.', 'A escolha de idioma fica salva neste dispositivo.'],
  ['The app follows your system language. You can choose a language here at any time.', 'O app acompanha o idioma principal do sistema. Você pode escolher um idioma aqui a qualquer momento.'],
  ['Settings', 'Configurações'],
  ['Choose a .pen file', 'Escolha um arquivo .pen'],
  ['No document open', 'Nenhum documento aberto'],
  ['Wait for the agent to finish before switching conversations', 'Espere o agente terminar para trocar de conversa'],
  ['Only PNG, JPG, WebP, GIF and SVG images are supported', 'Somente imagens PNG, JPG, WebP, GIF e SVG são aceitas', 'Only png, jpg, webp, gif and svg images'],
  ['Choose a .fig file', 'Escolha um arquivo .fig'],
  ['Not a Figma file', 'Não é um arquivo do Figma'],
  ['canvas.fig was not found in the .fig file', 'canvas.fig não encontrado no arquivo .fig'],
  ['Conversation not found', 'Conversa não encontrada'],
  ['The JSON must have an "mcpServers" object', 'O JSON precisa ter um objeto "mcpServers"'],
  ['"pena" is reserved for Pena’s own server', '"pena" é reservado para o servidor do próprio Pena'],
  ['Timed out (20 s)', 'Tempo esgotado (20 s)'],
  ['claude mcp add failed', 'claude mcp add falhou'],
  ['codex mcp add failed', 'codex mcp add falhou'],
  ['Select an element', 'Selecione um elemento'],
  ['Nothing to import from Figma', 'Nada para importar do Figma'],
  ['Importing from Figma…', 'Importando do Figma…'],
  ['Context handoff', 'Contexto transferido'],
  ['Context handoff pending', 'Contexto será transferido'],
  ['New session for this agent: context will be transferred', 'Nova sessão deste agente: o contexto será transferido'],
  ['The next message takes the conversation’s context to this agent', 'A próxima mensagem leva o contexto da conversa para este agente'],
  ['The previous session is gone: new session with the whole conversation', 'A sessão anterior não existe mais: nova sessão com a conversa inteira'],
  ['New session: got the conversation so far', 'Nova sessão: recebeu a conversa até aqui'],
  ['Got what other agents did since its last turn', 'Recebeu o que outros agentes fizeram desde a última vez'],
  ['Text sent to the agent', 'Texto enviado ao agente'],
].forEach(([en, pt, ...aliases]) => add(en, pt, ...aliases));

translations.set('Fill', ['Fill', 'Preenchimento']);
translations.set('Preencher', ['Fill', 'Preencher']);

const patterns = [
  [/^Continuando com a variação (\d+)$/, (_, i) => `Continuing with variation ${i}`],
  [/^Componente principal · (\d+) instância(s?)$/, (_, count) => `Main component · ${count} instance${count === '1' ? '' : 's'}`],
  [/^Instância de “(.+)”$/, (_, name) => `Instance of “${name}”`],
  [/^“(.+)” é um componente da biblioteca: abra (.+) para editar$/, (_, name, file) => `“${name}” is a library component: open ${file} to edit it`],
  [/^Formato \.pen (.+) · (\d+) itens no topo · (\d+) nós$/, (_, version, items, nodes) => `.pen format ${version} · ${items} top-level items · ${nodes} nodes`],
  [/^Conectado · ([\d.,]+) s$/, (_, seconds) => `Connected · ${seconds} s`],
  [/^✓ (\d+) ferramentas · (\d+) ms$/, (_, tools, ms) => `✓ ${tools} tools · ${ms} ms`],
  [/^Pensou por (.+)$/, (_, duration) => `Thought for ${duration}`],
  [/^(\d+) itens inteiros$/, (_, count) => `${count} whole item${count === '1' ? '' : 's'}`],
  [/^ · (\d+) de fora \(o agente lê com read_chat\)$/, (_, count) => ` · ${count} left out (the agent reads them with read_chat)`],
  [/^(.+) trabalhou por (.+)$/, (_, name, duration) => `${name} worked for ${duration}`],
  [/^Até (\d+) agentes dividindo a tarefa$/, (_, count) => `Up to ${count} agents sharing the task`],
  [/^(\d+) variações em paralelo$/, (_, count) => `${count} parallel variations`],
  [/^Importada a página “(.+)” do Figma$/, (_, name) => `Imported Figma page “${name}”`],
  [/^Não foi possível copiar: (.+)$/, (_, error) => `Could not copy: ${error}`],
  [/^JSON inválido: (.+)$/, (_, error) => `Invalid JSON: ${error}`],
  [/^Teste ao vivo ok em ([\d.,]+) s(?: com (.+))?(?: — respondeu “(.+)”)?\.$/, (_, seconds, model, reply) =>
    'Live test succeeded in ' + seconds + ' s' + (model ? ' with ' + model : '') + (reply ? ' — replied “' + reply + '”' : '') + '.'],
  [/^O teste falhou(?:: (.+))?\.?$/, (_, error) => 'The test failed' + (error ? ': ' + error : '.')],
  [/^(\d+) inst\.$/, (_, count) => count + (count === '1' ? ' instance' : ' instances')],
  [/^Editado (.+)$/, (_, ago) => 'Edited ' + ago],
  [/^Aberto (.+)$/, (_, ago) => 'Opened ' + ago],
  [/^Variáveis(?: \((\d+)\))?$/, (_, count) => 'Variables' + (count ? ' (' + count + ')' : '')],
  [/^Parar os (\d+) agentes$/, (_, count) => 'Stop ' + count + ' agents'],
  [/^(.+) terminou$/, (_, name) => name + ' finished'],
  [/^(.+) parou com um erro$/, (_, name) => name + ' stopped with an error'],
  [/^(.+) e mais (\d+) terminaram$/, (_, name, count) => name + ' and ' + count + ' more finished'],
  [/^Ops, algo deu errado com o (.+)!$/, (_, provider) => 'Oops, something went wrong with ' + provider + '!'],
  [/^Abrir o (.+) no Terminal$/, (_, provider) => 'Open ' + provider + ' in Terminal'],
  [/^Adicionar (.+)$/, (_, name) => 'Add ' + name],
  [/^Exportar “(.+)”$/, (_, name) => 'Export “' + name + '”'],
  [/^Modelos disponíveis \((\d+)\)$/, (_, count) => 'Available models (' + count + ')'],
  [/^(.+) · seus provedores$/, (_, name) => name + ' · your providers'],
  [/^(.+) · sua assinatura$/, (_, name) => name + ' · your subscription'],
  [/^Raciocínio · (.+)$/, (_, name) => 'Reasoning · ' + name],
  [/^(.+) trabalhando$/, (_, name) => name + ' working'],
  [/^Importando (.+)…$/, (_, name) => 'Importing ' + name + '…'],
  [/^Inserindo “(.+)”…$/, (_, name) => 'Inserting “' + name + '”…'],
  [/^Cliente desconhecido: (.+)$/, (_, id) => 'Unknown client: ' + id],
  [/^Skill não encontrada: (.+)$/, (_, name) => 'Skill not found: ' + name],
  [/^(.+): maior que 30 MB$/, (_, name) => name + ': larger than 30 MB'],
  [/^(.+) \(edite no JSON avançado\)$/, (_, type) => type + ' (edit in Advanced JSON)'],
  [/^(\d+)\/(\d+) agentes trabalhando$/, (_, active, total) => active + '/' + total + ' agents working'],
  [/^(\d+) agentes trabalhando$/, (_, count) => count + ' agents working'],
  [/^(\d+) camadas$/, (_, count) => count + ' layers'],
  [/^(\d+) ferramentas$/, (_, count) => count + ' tools'],
  [/^Comando registrado: (.+)$/, (_, command) => 'Registered command: ' + command],
];

let preference = readPreference();
let locale = resolveLocale(preference);
let preferenceRevision = 0;
const originalText = new WeakMap();
const originalAttributes = new WeakMap();
const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'aria-description'];

function readPreference() {
  try {
    const saved = localStorage.getItem('pena.language');
    return ['auto', 'en', 'pt-BR'].includes(saved) ? saved : 'auto';
  } catch { return 'auto'; }
}
function systemLocale() {
  const primary = navigator.languages?.[0] ?? navigator.language ?? 'en';
  return /^pt-br(?:-|$)/i.test(primary) ? 'pt-BR' : 'en';
}
function resolveLocale(choice) { return choice === 'auto' ? systemLocale() : choice; }
const ignored = (el) => el?.closest?.('#canvas, [data-i18n-ignore], .msg, .agent-head, .dynamic-content, .row .nm, #docname span, title');
const ignoredAttributes = (el) => el?.closest?.('[data-i18n-ignore-attrs]');

export function getLocale() { return locale; }
export function getLanguagePreference() { return preference; }

export function t(value) {
  const source = String(value ?? '');
  const pair = translations.get(source);
  if (pair) return pair[locale === 'pt-BR' ? 1 : 0];
  if (locale === 'en') {
    for (const [pattern, translate] of patterns) {
      const match = source.match(pattern);
      if (match) return translate(...match);
    }
  }
  return source;
}

export function localizedTextNode(parent, source) {
  const node = document.createTextNode(source);
  setTextNode(node, source, parent);
  return node;
}

function setTextNode(node, source, context = node.parentElement) {
  let state = originalText.get(node);
  if (!state || node.nodeValue !== state.translated) originalText.set(node, (state = { source, translated: source }));
  const next = ignored(context) ? state.source : t(state.source);
  state.translated = next;
  if (node.nodeValue !== next) node.nodeValue = next;
}
function setAttribute(el, name, source) {
  if (ignoredAttributes(el)) return;
  let values = originalAttributes.get(el);
  if (!values) originalAttributes.set(el, (values = new Map()));
  let state = values.get(name);
  if (!state || source !== state.translated) values.set(name, (state = { source, translated: source }));
  const next = ignored(el) ? state.source : t(state.source);
  state.translated = next;
  if (el.getAttribute(name) !== next) el.setAttribute(name, next);
}

export function applyTranslations(root = document) {
  const doc = root.ownerDocument ?? document;
  const start = root.nodeType === Node.ELEMENT_NODE ? root : doc.documentElement;
  if (start.matches?.('input[data-i18n-value]')) start.value = t(start.defaultValue);
  start.querySelectorAll?.('input[data-i18n-value]').forEach((el) => { el.value = t(el.defaultValue); });

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (ignored(node.parentElement)) continue;
    setTextNode(node, node.nodeValue);
  }
  const elements = [];
  if (root.nodeType === Node.ELEMENT_NODE) elements.push(root);
  elements.push(...(root.querySelectorAll?.('*') ?? []));
  for (const el of elements) for (const name of ATTRIBUTES) {
    const value = el.getAttribute(name);
    if (value != null) setAttribute(el, name, value);
  }
}

function syncNativeLocale() {
  try { window.__TAURI__?.core?.invoke?.('set_locale', { locale, preference })?.catch?.(() => {}); } catch {}
}
function updateLocale(next) {
  if (locale !== next) {
    locale = next;
    document.documentElement.lang = locale;
    applyTranslations();
  }
  window.dispatchEvent(new CustomEvent('pena:languagechange', { detail: { locale, preference } }));
}
export function setLanguagePreference(choice) {
  preference = ['auto', 'en', 'pt-BR'].includes(choice) ? choice : 'auto';
  preferenceRevision++;
  try { localStorage.setItem('pena.language', preference); } catch {}
  updateLocale(resolveLocale(preference));
  syncNativeLocale();
}

window.penaApplyLanguage = (nextLocale, nextPreference) => {
  preference = ['auto', 'en', 'pt-BR'].includes(nextPreference) ? nextPreference : 'auto';
  preferenceRevision++;
  try { localStorage.setItem('pena.language', preference); } catch {}
  updateLocale(nextLocale === 'pt-BR' ? 'pt-BR' : 'en');
};

document.documentElement.lang = locale;
applyTranslations();
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'characterData') {
      const node = record.target;
      if (ignored(node.parentElement)) continue;
      setTextNode(node, node.nodeValue);
    } else if (record.type === 'attributes') {
      const el = record.target, name = record.attributeName;
      if (!ignoredAttributes(el)) setAttribute(el, name, el.getAttribute(name));
    } else {
      record.addedNodes.forEach((node) => node.nodeType === Node.TEXT_NODE
        ? !ignored(node.parentElement) && setTextNode(node, node.nodeValue)
        : node.nodeType === Node.ELEMENT_NODE && applyTranslations(node));
    }
  }
}).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });

window.addEventListener('languagechange', () => {
  if (preference === 'auto') {
    updateLocale(resolveLocale(preference));
    syncNativeLocale();
  }
});
if (window.__TAURI__?.core?.invoke) {
  const revision = preferenceRevision;
  window.__TAURI__.core.invoke('get_language_preference').then((saved) => {
    if (revision !== preferenceRevision) return;
    preference = ['auto', 'en', 'pt-BR'].includes(saved) ? saved : 'auto';
    try { localStorage.setItem('pena.language', preference); } catch {}
    updateLocale(resolveLocale(preference));
    syncNativeLocale();
  }).catch(() => syncNativeLocale());
}
