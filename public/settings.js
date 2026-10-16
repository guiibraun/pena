// Settings dialog, laid out like pen.dev's: Agents (provider status, live test, sign-in) and MCP
// (Pena inside other agents + extra MCP servers for Pena's own agents).
import { h, ic } from './ui.js';

const api = (url, body) => fetch(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(await r.text()))));
const badge = (kind, text) => h('span', { class: `st-badge ${kind}` }, h('i'), text);
const PROVIDERS = { claude: { icon: 'asterisk', models: 'claude' }, codex: { icon: 'bot', models: 'codex' } };

let root, section = 'agents', detail = null, cache = {};

export function openSettings(start = 'agents') {
  section = start; detail = null;
  root?.remove();
  root = h('div', { class: 'modal-bg settings-bg', onclick: (e) => e.target === root && close() },
    h('div', { class: 'settings' },
      h('nav', {},
        h('h3', {}, 'Configurações'),
        navItem('agents', 'sparkles', 'Agentes'),
        navItem('mcp', 'terminal', 'MCP')),
      h('main', { id: 'settings-main' }),
      h('button', { class: 'btn icon st-close', title: 'Fechar (Esc)', onclick: close }, ic('x'))));
  document.body.append(root);
  addEventListener('keydown', esc);
  render();
}
const close = () => { root?.remove(); root = null; removeEventListener('keydown', esc); };
const esc = (e) => e.key === 'Escape' && close();
const navItem = (id, icon, label) => h('button', { class: 'st-nav', 'data-s': id, onclick: () => { section = id; detail = null; render(); } }, ic(icon), label);

function render() {
  root.querySelectorAll('.st-nav').forEach((b) => b.classList.toggle('on', b.dataset.s === section));
  const main = root.querySelector('#settings-main');
  main.replaceChildren(h('div', { class: 'hint' }, 'Carregando…'));
  (section === 'agents' ? (detail ? providerDetail(detail) : agentsPage()) : mcpPage()).then((nodes) => main.replaceChildren(...nodes.filter((n) => n && n !== true))).catch((e) => main.replaceChildren(h('div', { class: 'st-error' }, e.message)));
}

// ---------------------------------------------------------------- Agents
const statusBadge = (p, probe) =>
  probe?.running ? badge('wait', 'Testando…')
    : probe ? (probe.status === 'connected' ? badge('ok', `Conectado · ${(probe.ms / 1000).toFixed(1)} s`) : badge('bad', 'Falhou no teste'))
      : !p.installed ? badge('bad', 'CLI indisponível')
        : p.connected ? badge('ok', 'Conectado') : badge('warn', 'Não conectado');

async function agentsPage() {
  cache.providers = await api('/api/settings/providers');
  cache.models ??= await api('/models').catch(() => ({}));
  return [
    h('h2', {}, 'Conecte seus provedores de IA'),
    h('p', { class: 'st-lead' }, 'O Pena usa os tokens das suas assinaturas: ele se conecta ao Claude Code e ao Codex já logados neste Mac. Nada de API key.'),
    h('h4', {}, 'Provedores'),
    ...Object.entries(cache.providers).map(([id, p]) => {
      const models = (cache.models[PROVIDERS[id].models] ?? []).filter((m) => m.id !== 'default').map((m) => m.name);
      return h('button', { class: 'st-row', onclick: () => { detail = id; render(); } },
        h('span', { class: 'st-icon' }, ic(PROVIDERS[id].icon, 18)),
        h('span', { class: 'st-text' }, h('b', {}, p.name), h('small', {}, models.slice(0, 4).join(' · ') || (p.connected ? 'Modelos da sua conta' : '—'))),
        statusBadge(p, cache.probe?.[id]),
        ic('chevron-right', 16));
    }),
  ];
}

async function providerDetail(id) {
  cache.providers ??= await api('/api/settings/providers');
  const p = cache.providers[id];
  const models = (cache.models?.[PROVIDERS[id].models] ?? []).filter((m) => m.id !== 'default');
  const probe = cache.probe?.[id];
  const runProbe = async () => {
    (cache.probe ??= {})[id] = { running: true };
    render();
    cache.probe[id] = await api('/api/settings/probe', { provider: id }).catch((e) => ({ status: 'not-connected', error: e.message, ms: 0 }));
    if (detail === id) render();
  };
  const row = (k, v) => v && h('div', { class: 'st-kv' }, h('span', {}, k), h('span', {}, v));
  return [
    h('button', { class: 'st-back', onclick: () => { detail = null; render(); } }, ic('arrow-left', 14), 'Provedores'),
    h('div', { class: 'st-head' },
      h('span', { class: 'st-icon big' }, ic(PROVIDERS[id].icon, 26)),
      h('div', { class: 'st-text' }, h('h2', {}, p.name), h('small', {}, models.slice(0, 5).map((m) => m.name).join(' · '))),
      statusBadge(p, probe),
      h('button', { class: 'btn icon', title: 'Testar conexão agora (faz uma chamada mínima ao modelo)', onclick: runProbe }, ic('refresh-cw', 15))),
    probe && !probe.running && h('div', { class: `st-probe ${probe.status === 'connected' ? 'ok' : 'bad'}` },
      probe.status === 'connected'
        ? `Teste ao vivo ok em ${(probe.ms / 1000).toFixed(1)} s${probe.model ? ` com ${probe.model}` : ''}${probe.reply ? ` — respondeu “${probe.reply}”` : ''}.`
        : `O teste falhou${probe.error ? `: ${probe.error}` : '.'}`),
    h('h4', {}, 'Conexão'),
    h('div', { class: 'st-card' },
      row('Status', p.connected ? 'Logado' : p.detail ?? 'Não logado'),
      row('Método', p.method),
      row('Plano', p.plan && p.plan.toUpperCase()),
      row('Conta', p.account),
      row('Organização', p.org),
      row('CLI', p.installed ? `${id === 'claude' ? 'Claude Code' : 'Codex'} ${p.version} (embutido no Pena)` : 'Não encontrado')),
    h('div', { class: 'st-actions' },
      h('button', { class: `btn ${p.connected ? 'solid' : 'primary'}`, onclick: async () => { await api('/api/settings/login', { provider: id }); } }, ic('log-in', 14), p.connected ? 'Trocar de conta no Terminal' : 'Fazer login no Terminal'),
      h('button', { class: 'btn solid', onclick: () => { cache.providers = null; render(); } }, ic('rotate-cw', 14), 'Verificar de novo')),
    h('p', { class: 'hint' }, id === 'claude'
      ? 'O login abre o Claude Code no Terminal; use /login lá dentro. O Pena lê o mesmo login (claude.ai, Pro/Max).'
      : 'O login abre `codex login` no Terminal, que entra com sua conta ChatGPT.'),
    h('h4', {}, `Modelos disponíveis (${models.length})`),
    h('div', { class: 'st-card' }, models.length
      ? models.map((m) => h('div', { class: 'st-kv' }, h('span', {}, m.name), h('span', { class: 'st-chips' }, ...(m.efforts ?? []).map((e) => h('i', { class: e === m.defaultEffort ? 'on' : '' }, e)))))
      : h('div', { class: 'hint' }, 'Nenhum modelo — verifique o login.')),
  ];
}

// ---------------------------------------------------------------- MCP
const POPULAR = {
  'Chrome DevTools': { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
  Context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
  Linear: { url: 'https://mcp.linear.app/mcp' },
  Notion: { url: 'https://mcp.notion.com/mcp' },
};

async function mcpPage() {
  const [{ clients, launch }, { text }] = await Promise.all([api('/api/settings/integrations'), api('/api/settings/agent-mcp')]);
  const editor = h('textarea', { class: 'input st-json', spellcheck: false });
  editor.value = text;
  const msg = h('span', { class: 'hint' });
  const servers = (() => { try { return Object.keys(JSON.parse(text).mcpServers ?? {}); } catch { return []; } })();
  const tests = h('div', { class: 'st-card' }, servers.length
    ? servers.map((name) => serverRow(name))
    : h('div', { class: 'hint' }, 'Nenhum servidor extra. Os agentes do Pena usam só as ferramentas de design.'));

  return [
    h('h2', {}, 'MCP'),
    h('h4', {}, 'Usar o Pena em outros agentes'),
    h('p', { class: 'st-lead small' }, 'Registra o MCP do Pena nas suas ferramentas, para que elas desenhem no arquivo aberto aqui. Claude Code e Codex são configurados pelos próprios CLIs; os outros recebem um backup antes da primeira edição.'),
    h('div', { class: 'st-card' }, clients.map((c) => clientRow(c))),
    h('p', { class: 'hint mono' }, `Comando registrado: ${launch.command.split('/').slice(-3).join('/')} ${launch.args.map((a) => a.split('/').pop()).join(' ')}`),
    h('h4', {}, 'Servidores MCP para os agentes do Pena'),
    h('p', { class: 'st-lead small' }, 'Dá aos agentes do canvas ferramentas dos seus próprios servidores MCP (mesmo formato do Claude Code: command/args ou url).'),
    editor,
    h('div', { class: 'st-actions' },
      h('span', { class: 'hint' }, 'Populares'),
      ...Object.entries(POPULAR).map(([name, conf]) => h('button', { class: 'btn solid', onclick: () => {
        try { const d = JSON.parse(editor.value); d.mcpServers ??= {}; d.mcpServers[name.toLowerCase().replace(/\s+/g, '-')] = conf; editor.value = JSON.stringify(d, null, 2); } catch (e) { msg.textContent = `JSON inválido: ${e.message}`; }
      } }, ic('plus', 13), name)),
      h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn', onclick: () => (editor.value = text) }, 'Desfazer'),
      h('button', { class: 'btn primary', onclick: async () => {
        try { JSON.parse(editor.value); await api('/api/settings/agent-mcp', { text: editor.value }); render(); } catch (e) { msg.textContent = e.message; }
      } }, 'Salvar')),
    msg,
    tests,
  ];
}

function clientRow(c) {
  const state = !c.present ? badge('off', 'Não instalado') : c.registered ? (c.current ? badge('ok', 'Ativo') : badge('warn', 'Desatualizado')) : badge('off', 'Desligado');
  const toggle = h('input', { type: 'checkbox', class: 'st-switch', checked: c.registered, disabled: !c.present, title: c.registered ? 'Remover o Pena deste cliente' : 'Registrar o Pena neste cliente',
    onchange: async (e) => {
      e.target.disabled = true;
      try { await api('/api/settings/integrations', { id: c.id, on: e.target.checked }); } catch (err) { alert(err.message); }
      render();
    } });
  const result = h('span', { class: 'hint' });
  return h('div', { class: 'st-line' },
    h('span', { class: 'st-text' }, h('b', {}, c.name), h('small', { title: c.file }, c.file.replace(/^\/Users\/[^/]+/, '~'))),
    result,
    state,
    c.registered && !c.current && h('button', { class: 'btn solid', title: 'Apontar para este app', onclick: async () => { await api('/api/settings/integrations', { id: c.id, on: true }); render(); } }, 'Atualizar'),
    c.registered && h('button', { class: 'btn solid', onclick: async (e) => {
      e.target.disabled = true; result.textContent = 'Testando…';
      const r = await api('/api/settings/integrations/test', { id: c.id });
      result.textContent = r.ok ? `✓ ${r.tools.length} ferramentas · ${r.ms} ms` : `✗ ${r.error}`;
      e.target.disabled = false;
    } }, 'Testar'),
    toggle);
}

function serverRow(name) {
  const result = h('span', { class: 'hint' });
  return h('div', { class: 'st-line' },
    h('span', { class: 'st-text' }, h('b', {}, name)),
    result,
    h('button', { class: 'btn solid', onclick: async (e) => {
      e.target.disabled = true; result.textContent = 'Conectando…';
      const r = await api('/api/settings/agent-mcp/test', { name });
      result.replaceChildren(r.ok ? badge('ok', `${r.tools.length} ferramentas`) : badge('bad', r.error));
      e.target.disabled = false;
    } }, 'Testar conexão'));
}
