// The chat while agents work, modeled on pen.dev's: streamed text, a collapsible "thinking" row, one card per tool
// call (label from the execute tool's description, animated ellipsis while running, check when done, expandable
// script/output, screenshots inline), the agent's plan pinned under the log, a header per agent with its color,
// a "planning next moves" line, a footer with duration and usage, and a strip with the running agents.
// The same renderer replays the saved history (finished items only).
import { h, ic, menu, loadModels } from './ui.js';
import { getLocale, t } from './i18n.js';
import { brandIcon } from './brands.js';

const LABELS = { // pen.dev's kIe: [done, running]
  execute: ['Desenhou', 'Desenhando'], get_app_state: ['Leu o estado do editor', 'Lendo o estado do editor'],
  read_skill: ['Leu a skill', 'Lendo a skill'], spawn_agents: ['Iniciou agentes', 'Iniciando agentes'],
  get_style: ['Verificou estilos', 'Verificando estilos'], WebSearch: ['Pesquisou na web', 'Pesquisando na web'],
  web_search: ['Pesquisou na web', 'Pesquisando na web'], WebFetch: ['Leu uma página', 'Lendo uma página'],
  Read: ['Leu o anexo', 'Lendo o anexo'], shell: ['Rodou um comando', 'Rodando um comando'], ToolSearch: ['Preparou ferramentas', 'Preparando ferramentas'],
  code: ['Rodou um script', 'Rodando um script'],
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
export const md = (s) => esc(s).replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
// hover button that copies a message's raw text (markdown as written, not the rendered HTML)
export const copyBtn = (get) => h('button', { class: 'copy-msg', title: t('Copy'), onclick: async () => {
  const b = e.currentTarget;
  await navigator.clipboard.writeText(get());
  b.replaceChildren(ic('check', 12));
  setTimeout(() => b.replaceChildren(ic('copy', 12)), 1200);
} }, ic('copy', 12));
const dur = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const num = (n) => (n == null ? '—' : n.toLocaleString(getLocale()));
// a light highlighter for scripts (comments, strings, numbers, keywords), like pen.dev's
const highlight = (code) => esc(code).replace(/(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|of|in|new|await|async|true|false|null|undefined)\b/g,
  (m, c, s, n, k) => (c ? `<i class="c">${c}</i>` : s ? `<i class="s">${s}</i>` : n ? `<i class="n">${n}</i>` : `<i class="k">${k}</i>`));

// Context handoffs (handoff.mjs), shown like T3 Code's: which agents' turns went to which agent.
const SHORT = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
function runChip({ provider, model, label }) {
  const brand = provider.split('-')[0], who = label ?? SHORT[brand] ?? provider;
  const name = h('span', { 'data-i18n-ignore': true }, model && model !== 'default' ? `${who} · ${model}` : who);
  // the model's name from your account's catalog (OpenCode's already says the provider)
  loadModels().then((all) => { const m = all[provider]?.find((x) => x.id === model); if (m) name.textContent = brand === 'opencode' ? m.name : `${who} · ${m.name}`; });
  return h('span', { class: 'run-chip' }, brandIcon(brand, 12), name);
}
export const handoffRoute = (d) => h('span', { class: 'handoff-route' }, ...d.from.flatMap((r, i) => [i ? ',' : null, runChip(r)]), d.from.length ? ic('arrow-right', 11) : null, runChip(d.to));

export function createChatLog({ log, strip, todosEl, onRunning = () => {}, onStop = () => {}, onLogin = () => {}, onReconnect = () => {}, onPickVariation = async () => ({}) }) {
  const items = new Map(); // id -> { el, data }
  const agents = new Map(); // name -> { color, model, running, t0 }
  let lastWho = null, status = null, stripTimer = 0;

  const scroll = () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = 1e9; };
  const add = (el) => { log.querySelector('.empty-chat')?.remove(); status?.remove(); log.append(el); if (status && running()) log.append(status); scroll(); return el; };
  const running = () => [...agents.values()].some((a) => a.running);
  const runningCount = () => [...agents.values()].filter((a) => a.running).length;
  const header = (who) => {
    if (lastWho === who) return;
    lastWho = who;
    const a = agents.get(who) ?? {};
    add(h('div', { class: 'agent-head', 'data-who': who }, h('i', { style: { background: a.color ?? '#607dff' } }), h('b', {}, who), a.model && h('span', {}, a.model)));
  };
  function setStatus(live) {
    status?.remove();
    if (!live || !running()) { status = null; return; }
    const lastEl = log.lastElementChild, thinking = lastEl?.classList.contains('thinking') && lastEl.classList.contains('streaming');
    status = h('div', { class: 'run-status' }, h('span', { class: 'ellipsis' }, thinking ? 'Pensando' : 'Planejando próximos passos'));
    if (lastEl?.classList.contains('streaming') && !thinking) return (status = null);
    log.append(status);
    scroll();
  }
  function renderStrip() {
    clearTimeout(stripTimer);
    const list = [...agents.entries()];
    const live = list.filter(([, a]) => a.running);
    if (!list.length) return strip.replaceChildren();
    const dots = h('span', { class: 'dots' }, ...list.map(([n, a]) => h('i', { title: n, 'data-i18n-ignore-attrs': true, class: a.running ? 'on' : '', style: { background: a.color } })));
    strip.replaceChildren(h('button', { class: 'agent-strip', onclick: (e) => menu(e.currentTarget, [
      ...list.map(([n, a]) => ({ label: `${n}${a.model ? ` · ${a.model}` : ''}${a.running ? ` — ${t(a.queued ? 'Queued' : 'Working')}` : ''}`, raw: true, run: () => log.querySelector(`.agent-head[data-who="${CSS.escape(n)}"]`)?.scrollIntoView({ block: 'center' }) })),
      ...(live.length ? ['sep', { label: live.length > 1 ? `Parar os ${live.length} agentes` : 'Parar', icon: 'square', run: onStop }] : []),
    ]) }, dots, live.length ? h('span', { class: 'ellipsis' }, live.length === 1
      ? h('span', {}, h('span', { 'data-i18n-ignore': true }, live[0][0]), ' ', 'Working')
      : `${live.length}/${list.length} agentes trabalhando`) : h('span', {}, ic('check', 12), 'Concluído')));
    if (!live.length) stripTimer = setTimeout(() => { strip.replaceChildren(); agents.clear(); }, 6000);
  }

  function text(d) {
    let it = items.get(d.id);
    if (!it) { header(d.agent); it = { el: add(h('div', { class: 'msg text' })) }; if (d.id) items.set(d.id, it); }
    it.raw = d.text ?? '';
    it.el.innerHTML = md(it.raw);
    it.el.append(copyBtn(() => it.raw));
    it.el.classList.toggle('streaming', !d.done);
    scroll();
  }
  function thinking(d, live) {
    let it = items.get(d.id);
    if (!it) {
      header(d.agent);
      const body = h('div', { class: 'think-body' });
      const label = h('span', {});
      const el = add(h('div', { class: 'msg thinking' }, h('button', { class: 'think-toggle', onclick: () => el.classList.toggle('open') }, label, ic('chevron-down', 12)), body));
      it = { el, label, body, t0: Date.now() };
      items.set(d.id, it);
    }
    it.body.innerHTML = md(d.text ?? '');
    const done = d.done || !live;
    it.el.classList.toggle('streaming', !done);
    it.label.className = done ? '' : 'ellipsis';
    it.label.textContent = t(done ? (live ? `Pensou por ${dur(Date.now() - it.t0)}` : 'Pensou') : 'Pensando');
  }
  function tool(d, live) {
    let it = items.get(d.id);
    if (!it) {
      header(d.agent);
      const label = h('span', { class: 'label' }), mark = h('span', { class: 'mark' }), details = h('div', { class: 'tool-details' }), shots = h('div', { class: 'tool-shots' });
      const el = add(h('div', { class: 'tool-card' }, h('button', { class: 'tool-head', onclick: () => el.classList.toggle('open') }, label, mark, ic('chevron-down', 12)), details, shots));
      it = { el, label, mark, details, shots, data: {} };
      items.set(d.id, it);
    }
    const c = (it.data = { ...it.data, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) });
    const done = c.status === 'done' || c.status === 'error' || (!live && c.status !== 'running');
    const [doneLabel, runLabel] = LABELS[c.name] ?? [c.name, c.name];
    const desc = c.label ?? c.input?.description ?? (c.name === 'WebSearch' || c.name === 'web_search' ? c.input?.query : c.name === 'WebFetch' ? c.input?.url : null);
    if (desc) it.label.dataset.i18nIgnore = '';
    else it.label.removeAttribute('data-i18n-ignore');
    it.label.textContent = desc ?? t(done ? doneLabel : runLabel);
    it.label.classList.toggle('ellipsis', !done);
    it.el.classList.toggle('error', c.status === 'error');
    it.mark.replaceChildren(done ? ic('check', 13) : '');
    // details: the script (execute) or the input, then the output
    const script = typeof c.input?.input === 'string' ? c.input.input : null;
    const input = script ?? (c.input && Object.keys(c.input).length ? JSON.stringify(c.input, null, 2) : null);
    it.details.replaceChildren(
      ...(input ? [h('div', { class: 'td-title' }, script ? 'Script' : c.input?.edits ? 'Edições' : 'Entrada'), h('pre', { class: 'code', innerHTML: highlight(input) })] : []),
      ...(c.output ? [h('div', { class: 'td-title' }, 'Resultado'), h('pre', { class: 'out' }, c.output)] : []));
    if (Array.isArray(c.images) && c.images.length) it.shots.replaceChildren(...c.images.map((src) => h('img', { src, onload: (e) => (e.target.style.width = `${e.target.naturalWidth / devicePixelRatio}px`) })));
    scroll();
  }
  function handoff(d) {
    const el = add(h('div', { class: 'handoff' },
      h('button', { class: 'handoff-head', onclick: () => el.classList.toggle('open') }, ic('arrow-right-left', 12), h('b', {}, 'Contexto transferido'), ic('chevron-down', 12)),
      handoffRoute(d),
      h('div', { class: 'handoff-body' },
        h('div', { class: 'td-title' }, d.replaced ? 'A sessão anterior não existe mais: nova sessão com a conversa inteira' : d.fresh ? 'Nova sessão: recebeu a conversa até aqui' : 'Recebeu o que outros agentes fizeram desde a última vez',
          ` · #${d.range[0]}–#${d.range[1]} · `, `${d.included} itens inteiros`, d.omitted ? ` · ${d.omitted} de fora (o agente lê com read_chat)` : ''),
        h('div', { class: 'td-title' }, 'Texto enviado ao agente'),
        h('pre', { 'data-i18n-ignore': true }, d.text ?? ''))));
  }
  function todos(d) {
    const items = d.items ?? [];
    if (!items.length) return todosEl.replaceChildren();
    const doneN = items.filter((t) => t.status === 'completed').length;
    const icon = (s) => (s === 'completed' ? ic('circle-check', 13) : s === 'in_progress' ? ic('loader', 13) : ic('circle', 13));
    todosEl.replaceChildren(h('div', { class: 'todo-panel' + (todosEl.dataset.closed ? ' closed' : '') },
      h('button', { class: 'todo-head', onclick: () => { todosEl.dataset.closed = todosEl.dataset.closed ? '' : '1'; todosEl.firstChild.classList.toggle('closed'); } }, h('b', {}, 'Plano'), h('span', {}, `${doneN}/${items.length}`), ic('chevron-down', 12)),
      h('div', { class: 'todo-list' }, ...items.map((t) => h('div', { class: `todo ${t.status}` }, icon(t.status), h('span', { 'data-i18n-ignore': true }, t.text))))));
  }
  function end(d, live) {
    const a = agents.get(d.agent);
    if (a) a.running = false;
    if (d.reason === 'stopped') add(h('div', { class: 'run-note' }, 'Interrompido'));
    else if (d.reason === 'failed') {
      const who = { codex: 'Codex', opencode: 'OpenCode' }[d.provider?.split('-')[0]] ?? 'Claude Code';
      add(h('div', { class: 'run-error' }, h('b', {}, d.tools ? 'As ferramentas de design não conectaram' : `Ops, algo deu errado com o ${who}!`), h('div', {}, d.message ?? ''),
        d.tools && h('button', { class: 'btn solid', onclick: () => onReconnect() }, ic('refresh-cw', 13), 'Reconectar as ferramentas'),
        /login|auth|credential|401|403|subscription/i.test(d.message ?? '') && h('button', { class: 'btn solid', onclick: () => onLogin(d.provider) }, ic('terminal', 13), `Abrir o ${who} no Terminal`)));
    } else if (d.ms != null) {
      const u = d.usage ?? {};
      const rows = [['Custo (equivalente na API)', u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : null], ['Tokens de entrada', num(u.input)], ['Tokens de saída', num(u.output)], ['Cache lido', num(u.cacheRead)], ['Cache escrito', num(u.cacheWrite)], ['Turnos', num(u.turns)]].filter(([, v]) => v && v !== '—');
      const el = add(h('div', { class: 'run-foot' }, h('button', { onclick: () => el.classList.toggle('open') }, `${d.agent} trabalhou por ${dur(d.ms)}`, rows.length ? ic('chevron-down', 12) : ''),
        h('div', { class: 'run-usage' }, ...rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('span', {}, v))))));
      // side-by-side: keep this variation, delete the others and keep chatting with its agent
      if (live && d.variation) el.append(h('button', { class: 'btn pick-variation', onclick: async () => {
        const r = await onPickVariation(d.agent);
        if (r.error) return alert(t(r.error));
        log.querySelectorAll('.pick-variation').forEach((b) => b.remove());
        add(h('div', { class: 'run-note' }, `Continuando com a variação ${d.variation}`));
      } }, ic('check', 12), 'Continuar com esta'));
    }
    if (live && !running()) notify(d);
  }
  function notify(d) {
    renderStrip();
    if (document.hasFocus() || typeof Notification === 'undefined' || localStorage['pena-notifications'] === 'false') return;
    const names = [...agents.keys()];
    const body = d.reason === 'failed' ? `${d.agent} parou com um erro` : names.length > 1 ? `${names[0]} e mais ${names.length - 1} terminaram` : `${d.agent} terminou`;
    const go = () => new Notification('Pena', { body: t(body) });
    Notification.permission === 'granted' ? go() : Notification.permission !== 'denied' && Notification.requestPermission().then((p) => p === 'granted' && go());
  }

  return {
    // one agent event (live from the server, or replayed from the history)
    event(d, { live = true } = {}) {
      switch (d.kind) {
        case 'start':
          agents.set(d.agent, { color: d.color, model: d.model, running: live, queued: live && d.queued, t0: Date.now() });
          if (live) onRunning(runningCount(), d);
          break;
        case 'model': { const a = agents.get(d.agent); if (a) a.model = d.model, a.queued = false; const hd = log.querySelector(`.agent-head[data-who="${CSS.escape(d.agent)}"] span`); if (hd) hd.textContent = d.model; break; }
        case 'text': text(d); break;
        case 'thinking': thinking(d, live); break;
        case 'tool': tool(d, live); break;
        case 'todos': todos(d); break;
        case 'handoff': handoff(d); break;
        case 'end': end(d, live); if (live) onRunning(runningCount(), d); break;
        case 'error': add(h('div', { class: 'msg error' }, t(d.text ?? ''))); break;
        default: return false;
      }
      if (live) { renderStrip(); setStatus(true); }
      return true;
    },
    // a user message starts a new turn: the next agent output gets its header again
    newTurn() { lastWho = null; },
    // agents still running in this conversation, from the server (the UI must show them after a switch)
    setRunning(list = []) {
      for (const a of list) agents.set(a.agent, { color: a.color, model: a.model, running: true, queued: a.queued, t0: a.t0 ?? Date.now() });
      renderStrip();
      setStatus(true);
      onRunning(runningCount(), list[0]);
    },
    clear() { items.clear(); agents.clear(); lastWho = null; status = null; strip.replaceChildren(); todosEl.replaceChildren(); onRunning(0); },
  };
}
