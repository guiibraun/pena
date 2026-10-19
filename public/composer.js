// Composer extras shared by the editor and the dashboard (pen.dev parity):
//  - "/" opens a skill picker; picked skills ride along with the message
//  - "Nx" sets how many agents work in parallel: split the task, or N variations side by side
import { h, ic, menu } from './ui.js';
import { t } from './i18n.js';

// ---------------------------------------------------------------- parallel agents
export const agentsPref = () => ({
  agents: Number(localStorage.getItem('pena.agents') ?? 1),
  parallel: localStorage.getItem('pena.parallel') ?? 'split',
});
export function agentsButton(btn, onChange = () => {}) {
  const paint = () => {
    const { agents, parallel } = agentsPref();
    btn.replaceChildren(ic(parallel === 'side-by-side' && agents > 1 ? 'columns-2' : 'layout-grid', 12), `${agents}x`);
    btn.title = agents === 1 ? 'Um agente' : parallel === 'side-by-side' ? `${agents} variações em paralelo` : `Até ${agents} agentes dividindo a tarefa`;
  };
  btn.onclick = () => {
    const { agents, parallel } = agentsPref();
    const set = (k, v) => (localStorage.setItem(k, v), paint(), onChange());
    menu(btn, [
      { head: 'Agentes em paralelo' },
      ...[1, 2, 3, 4].map((n) => ({ label: n === 1 ? '1x — um agente' : `${n}x`, on: agents === n, run: () => set('pena.agents', n) })),
      'sep',
      { head: 'Com mais de um agente' },
      { label: 'Dividir a tarefa entre eles', icon: 'split', on: parallel === 'split', run: () => set('pena.parallel', 'split') },
      { label: 'Variações lado a lado', icon: 'columns-2', on: parallel === 'side-by-side', run: () => set('pena.parallel', 'side-by-side') },
    ], { above: true, align: 'right' });
  };
  paint();
}

// ---------------------------------------------------------------- "/" skills
let skillsCache;
const loadSkills = (fresh) => (fresh || !skillsCache ? (skillsCache = fetch('/api/skills').then((r) => r.json()).catch(() => [])) : skillsCache);

// Attach the "/" picker to a textarea. `onPick(skill)` receives the chosen skill; the "/query" text is removed.
export function slashSkills(textarea, onPick) {
  let pop = null, items = [], active = 0, start = -1;
  const close = () => { pop?.remove(); pop = null; start = -1; };
  const query = () => {
    const upto = textarea.value.slice(0, textarea.selectionStart);
    const m = /(^|\s)\/([\w.-]*)$/.exec(upto);
    return m ? { q: m[2].toLowerCase(), at: upto.length - m[2].length - 1 } : null;
  };
  const pick = (s) => {
    const end = textarea.selectionStart;
    textarea.value = textarea.value.slice(0, start) + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start;
    close();
    onPick(s);
    textarea.dispatchEvent(new Event('input'));
    textarea.focus();
  };
  async function open() {
    const qs = query();
    if (!qs) return close();
    start = qs.at;
    const all = await loadSkills();
    const words = qs.q.split(/[-_.]/).filter(Boolean);
    items = all
      .map((s) => ({ s, score: !qs.q ? 0 : s.name.toLowerCase().startsWith(qs.q) ? 0 : s.name.toLowerCase().includes(qs.q) ? 1 : words.every((w) => `${s.name} ${s.description}`.toLowerCase().includes(w)) ? 2 : 9 }))
      .filter((x) => x.score < 9)
      .sort((a, b) => a.score - b.score || a.s.name.localeCompare(b.s.name))
      .slice(0, 60)
      .map((x) => x.s);
    active = Math.min(active, Math.max(0, items.length - 1));
    render();
  }
  function render() {
    pop?.remove();
    const r = textarea.getBoundingClientRect();
    pop = h('div', { class: 'menu skill-pop', style: { left: `${r.left}px`, bottom: `${innerHeight - r.top + 8}px`, width: `${Math.max(340, r.width)}px`, maxHeight: '340px' } },
      h('div', { class: 'head' }, 'Skills'),
      items.length ? items.map((s, i) => h('button', { class: `item skill${i === active ? ' on' : ''}`, onmousedown: (e) => { e.preventDefault(); pick(s); }, onmouseenter: () => { active = i; mark(); } },
        ic(s.source.startsWith('Pena') ? 'feather' : s.source === 'pen.dev' ? 'pen-tool' : s.source === 'Claude Code' ? 'sparkles' : 'file-text', 14),
        h('span', { class: 'sk' }, h('b', { 'data-i18n-ignore': true }, s.name), h('small', { 'data-i18n-ignore': true }, s.description)),
        h('span', { class: 'src', 'data-i18n-ignore': true }, s.source)))
        : h('div', { class: 'head', style: { textTransform: 'none' } }, 'Nenhuma skill encontrada'),
      h('div', { class: 'sep' }),
      h('button', { class: 'item', onmousedown: async (e) => {
        e.preventDefault();
        const p = prompt(t('Path to a skill folder (or SKILL.md):'));
        if (!p) return;
        const r = await fetch('/api/skills/add', { method: 'POST', body: JSON.stringify({ path: p }) });
        if (!r.ok) return alert(t(await r.text()));
        await loadSkills(true); open();
      } }, ic('plus', 14), 'Adicionar skill…'));
    document.body.append(pop);
    pop.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
  const mark = () => pop?.querySelectorAll('.skill').forEach((el, i) => el.classList.toggle('on', i === active));
  textarea.addEventListener('input', open);
  textarea.addEventListener('click', open);
  // Only close when focus moves elsewhere in the app; switching windows (Cmd+Tab) keeps the picker open.
  textarea.addEventListener('blur', () => setTimeout(() => document.hasFocus() && document.activeElement !== textarea && close(), 120));
  // Capture phase so Enter/arrows reach the picker before the composer's own handlers.
  textarea.addEventListener('keydown', (e) => {
    if (!pop) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); active = (active + 1) % Math.max(1, items.length); mark(); pop.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); active = (active - 1 + items.length) % Math.max(1, items.length); mark(); pop.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
    else if ((e.key === 'Enter' || e.key === 'Tab') && items[active]) { e.preventDefault(); e.stopImmediatePropagation(); pick(items[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
}
