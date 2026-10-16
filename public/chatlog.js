// The chat while agents work, modeled on pen.dev's: streamed text, a collapsible "thinking" row, one card per tool
// call (label from the execute tool's description, animated ellipsis while running, check when done, expandable
// script/output, screenshots inline), the agent's plan pinned under the log, a header per agent with its color,
// a "planning next moves" line, a footer with duration and usage, and a strip with the running agents.
// The same renderer replays the saved history (finished items only).
import { h, ic, menu } from './ui.js';

const LABELS = { // pen.dev's kIe: [done, running]
  execute: ['Desenhou', 'Desenhando'], get_app_state: ['Leu o estado do editor', 'Lendo o estado do editor'],
  read_skill: ['Leu a skill', 'Lendo a skill'], spawn_agents: ['Iniciou agentes', 'Iniciando agentes'],
  get_style: ['Verificou estilos', 'Verificando estilos'], WebSearch: ['Pesquisou na web', 'Pesquisando na web'],
  web_search: ['Pesquisou na web', 'Pesquisando na web'], WebFetch: ['Leu uma página', 'Lendo uma página'],
  Read: ['Leu o anexo', 'Lendo o anexo'], shell: ['Rodou um comando', 'Rodando um comando'], ToolSearch: ['Preparou ferramentas', 'Preparando ferramentas'],
};
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
export const md = (s) => esc(s).replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code>$2</code></pre>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
const dur = (ms) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const num = (n) => (n == null ? '—' : n.toLocaleString('pt-BR'));
// a light highlighter for scripts (comments, strings, numbers, keywords), like pen.dev's
const highlight = (code) => esc(code).replace(/(\/\/[^\n]*)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b(const|let|var|function|return|if|else|for|of|in|new|await|async|true|false|null|undefined)\b/g,
  (m, c, s, n, k) => (c ? `<i class="c">${c}</i>` : s ? `<i class="s">${s}</i>` : n ? `<i class="n">${n}</i>` : `<i class="k">${k}</i>`));

export function createChatLog({ log, strip, todosEl, onRunning = () => {}, onStop = () => {}, onLogin = () => {} }) {
  const items = new Map(); // id -> { el, data }
  const agents = new Map(); // name -> { color, model, running, t0 }
  let lastWho = null, status = null, stripTimer = 0;

  const scroll = () => { if (log.scrollHeight - log.scrollTop - log.clientHeight < 160) log.scrollTop = 1e9; };
  const add = (el) => { log.querySelector('.empty-chat')?.remove(); status?.remove(); log.append(el); if (status && running()) log.append(status); scroll(); return el; };
  const running = () => [...agents.values()].some((a) => a.running);
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
    const dots = h('span', { class: 'dots' }, ...list.map(([n, a]) => h('i', { title: n, class: a.running ? 'on' : '', style: { background: a.color } })));
    strip.replaceChildren(h('button', { class: 'agent-strip', onclick: (e) => menu(e.currentTarget, [
      ...list.map(([n, a]) => ({ label: `${n}${a.model ? ` · ${a.model}` : ''}${a.running ? ' — trabalhando' : ''}`, run: () => log.querySelector(`.agent-head[data-who="${CSS.escape(n)}"]`)?.scrollIntoView({ block: 'center' }) })),
      ...(live.length ? ['sep', { label: live.length > 1 ? `Parar os ${live.length} agentes` : 'Parar', icon: 'square', run: onStop }] : []),
    ]) }, dots, live.length ? h('span', { class: 'ellipsis' }, live.length === 1 ? `${live[0][0]} trabalhando` : `${live.length}/${list.length} agentes trabalhando`) : h('span', {}, ic('check', 12), ' Concluído')));
    if (!live.length) stripTimer = setTimeout(() => { strip.replaceChildren(); agents.clear(); }, 6000);
  }

  function text(d) {
    let it = items.get(d.id);
    if (!it) { header(d.agent); it = { el: add(h('div', { class: 'msg text' })) }; if (d.id) items.set(d.id, it); }
    it.el.innerHTML = md(d.text ?? '');
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
    it.label.textContent = done ? (live ? `Pensou por ${dur(Date.now() - it.t0)}` : 'Pensou') : 'Pensando';
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
    const t = (it.data = { ...it.data, ...Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)) });
    const done = t.status === 'done' || t.status === 'error' || (!live && t.status !== 'running');
    const [doneLabel, runLabel] = LABELS[t.name] ?? [t.name, t.name];
    const desc = t.label ?? t.input?.description ?? (t.name === 'WebSearch' || t.name === 'web_search' ? t.input?.query : t.name === 'WebFetch' ? t.input?.url : null);
    it.label.textContent = desc ?? (done ? doneLabel : runLabel);
    it.label.classList.toggle('ellipsis', !done);
    it.el.classList.toggle('error', t.status === 'error');
    it.mark.replaceChildren(done ? ic('check', 13) : '');
    // details: the script (execute) or the input, then the output
    const script = typeof t.input?.input === 'string' ? t.input.input : null;
    const input = script ?? (t.input && Object.keys(t.input).length ? JSON.stringify(t.input, null, 2) : null);
    it.details.replaceChildren(
      ...(input ? [h('div', { class: 'td-title' }, script ? 'Script' : t.input?.edits ? 'Edições' : 'Entrada'), h('pre', { class: 'code', innerHTML: highlight(input) })] : []),
      ...(t.output ? [h('div', { class: 'td-title' }, 'Resultado'), h('pre', { class: 'out' }, t.output)] : []));
    if (Array.isArray(t.images) && t.images.length) it.shots.replaceChildren(...t.images.map((src) => h('img', { src, onload: (e) => (e.target.style.width = `${e.target.naturalWidth / devicePixelRatio}px`) })));
    scroll();
  }
  function todos(d) {
    const items = d.items ?? [];
    if (!items.length) return todosEl.replaceChildren();
    const doneN = items.filter((t) => t.status === 'completed').length;
    const icon = (s) => (s === 'completed' ? ic('circle-check', 13) : s === 'in_progress' ? ic('loader', 13) : ic('circle', 13));
    todosEl.replaceChildren(h('div', { class: 'todo-panel' + (todosEl.dataset.closed ? ' closed' : '') },
      h('button', { class: 'todo-head', onclick: () => { todosEl.dataset.closed = todosEl.dataset.closed ? '' : '1'; todosEl.firstChild.classList.toggle('closed'); } }, h('b', {}, 'Plano'), h('span', {}, `${doneN}/${items.length}`), ic('chevron-down', 12)),
      h('div', { class: 'todo-list' }, ...items.map((t) => h('div', { class: `todo ${t.status}` }, icon(t.status), h('span', {}, t.text))))));
  }
  function end(d, live) {
    const a = agents.get(d.agent);
    if (a) a.running = false;
    if (d.reason === 'stopped') add(h('div', { class: 'run-note' }, 'Interrompido'));
    else if (d.reason === 'failed') {
      const who = { codex: 'Codex', opencode: 'OpenCode' }[d.provider] ?? 'Claude Code';
      add(h('div', { class: 'run-error' }, h('b', {}, `Ops, algo deu errado com o ${who}!`), h('div', {}, d.message ?? ''),
        /login|auth|credential|401|403|subscription/i.test(d.message ?? '') && h('button', { class: 'btn solid', onclick: () => onLogin(d.provider) }, ic('terminal', 13), `Abrir o ${who} no Terminal`)));
    } else if (d.ms != null) {
      const u = d.usage ?? {};
      const rows = [['Custo (equivalente na API)', u.costUsd != null ? `$${u.costUsd.toFixed(4)}` : null], ['Tokens de entrada', num(u.input)], ['Tokens de saída', num(u.output)], ['Cache lido', num(u.cacheRead)], ['Cache escrito', num(u.cacheWrite)], ['Turnos', num(u.turns)]].filter(([, v]) => v && v !== '—');
      const el = add(h('div', { class: 'run-foot' }, h('button', { onclick: () => el.classList.toggle('open') }, `${d.agent} trabalhou por ${dur(d.ms)}`, rows.length ? ic('chevron-down', 12) : ''),
        h('div', { class: 'run-usage' }, ...rows.map(([k, v]) => h('div', {}, h('span', {}, k), h('span', {}, v))))));
    }
    if (live && !running()) notify(d);
  }
  function notify(d) {
    renderStrip();
    if (document.hasFocus() || typeof Notification === 'undefined' || localStorage['pena-notifications'] === 'false') return;
    const names = [...agents.keys()];
    const body = d.reason === 'failed' ? `${d.agent} parou com um erro` : names.length > 1 ? `${names[0]} e mais ${names.length - 1} terminaram` : `${d.agent} terminou`;
    const go = () => new Notification('Pena', { body });
    Notification.permission === 'granted' ? go() : Notification.permission !== 'denied' && Notification.requestPermission().then((p) => p === 'granted' && go());
  }

  return {
    // one agent event (live from the server, or replayed from the history)
    event(d, { live = true } = {}) {
      switch (d.kind) {
        case 'start':
          agents.set(d.agent, { color: d.color, model: d.model, running: live, t0: Date.now() });
          if (live) onRunning(1, d);
          break;
        case 'model': { const a = agents.get(d.agent); if (a) a.model = d.model; const hd = log.querySelector(`.agent-head[data-who="${CSS.escape(d.agent)}"] span`); if (hd) hd.textContent = d.model; break; }
        case 'text': text(d); break;
        case 'thinking': thinking(d, live); break;
        case 'tool': tool(d, live); break;
        case 'todos': todos(d); break;
        case 'end': end(d, live); if (live) onRunning(-1); break;
        case 'error': add(h('div', { class: 'msg error' }, d.text ?? '')); break;
        default: return false;
      }
      if (live) { renderStrip(); setStatus(true); }
      return true;
    },
    // a user message starts a new turn: the next agent output gets its header again
    newTurn() { lastWho = null; },
    clear() { items.clear(); agents.clear(); lastWho = null; status = null; strip.replaceChildren(); todosEl.replaceChildren(); },
  };
}
