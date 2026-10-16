// Small UI helpers shared by the dashboard and the editor.
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

// Lucide icons (same set pen.dev uses), drawn with CSS masks so they take the text color.
export const ic = (name, size = 16) => {
  const i = document.createElement('i');
  i.className = 'ic';
  i.style.setProperty('--i', `url("https://api.iconify.design/lucide/${name}.svg")`);
  if (size !== 16) i.style.width = i.style.height = `${size}px`;
  return i;
};
export const hydrateIcons = (root = document) => {
  for (const el of $$('[data-icon]', root)) {
    el.prepend(ic(el.dataset.icon, Number(el.dataset.size ?? 16)));
    delete el.dataset.icon;
  }
};

export const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
};

// Popup menu anchored to an element: items = [{ label, icon?, on?, run }] | 'sep' | { head }.
let openMenu;
export function menu(anchor, items, { align = 'left', above = false } = {}) {
  openMenu?.remove();
  const m = h('div', { class: 'menu' },
    items.map((it) =>
      it === 'sep' ? h('div', { class: 'sep' })
        : it.head ? h('div', { class: 'head' }, it.head)
        : h('button', { class: `item${it.on ? ' on' : ''}`, onclick: () => (m.remove(), it.run()) }, it.icon && ic(it.icon), it.label, it.on && h('span', { style: { marginLeft: 'auto' } }, ic('check', 14)))));
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, align === 'right' ? r.right - m.offsetWidth : r.left)}px`;
  m.style.top = `${above ? r.top - m.offsetHeight - 6 : r.bottom + 6}px`;
  if (m.getBoundingClientRect().bottom > innerHeight) m.style.top = `${Math.max(8, r.top - m.offsetHeight - 6)}px`;
  openMenu = m;
  setTimeout(() => addEventListener('pointerdown', function close(e) { if (!m.contains(e.target)) m.remove(), removeEventListener('pointerdown', close); }), 0);
  return m;
}

export const timeAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'ontem';
  return `há ${Math.floor(s / 86400)} dias`;
};
export const date = (ms) => new Date(ms).toLocaleDateString('pt-BR');

// Model picker shared by the dashboard prompt and the editor composer (lists come from your accounts).
export const PROVIDERS = { claude: 'Claude', codex: 'Codex / ChatGPT' };
let modelsPromise;
export const loadModels = () => (modelsPromise ??= fetch('/models').then((r) => r.json()).catch(() => ({ claude: [], codex: [] })));
export const pref = () => {
  const provider = localStorage.getItem('pena.provider') ?? 'claude';
  return { provider, ...JSON.parse(localStorage.getItem(`pena.${provider}`) ?? '{}') };
};
export const savePref = ({ provider, model, effort }) => {
  localStorage.setItem('pena.provider', provider);
  localStorage.setItem(`pena.${provider}`, JSON.stringify({ model, effort }));
};
// First run: default to the account's first concrete model (not the "default" alias) and its default effort.
export async function ensurePref() {
  const p = pref(), models = await loadModels();
  const list = models[p.provider] ?? [];
  if (list.some((x) => x.id === p.model)) return p;
  const m = list.find((x) => x.id !== 'default') ?? list[0];
  if (m) savePref({ provider: p.provider, model: m.id, effort: m.defaultEffort ?? m.efforts[0] });
  return pref();
}
export async function modelLabel() {
  const p = await ensurePref(), models = await loadModels();
  const m = models[p.provider]?.find((x) => x.id === p.model);
  return m?.name ?? (p.provider === 'claude' ? 'Claude' : 'Codex');
}
export async function pickModel(anchor, onChange) {
  const models = await loadModels(), p = pref();
  const items = [];
  for (const [provider, title] of Object.entries(PROVIDERS)) {
    items.push({ head: `${title} · sua assinatura` });
    for (const m of models[provider] ?? [])
      items.push({ label: m.name, on: p.provider === provider && p.model === m.id, run: () => {
        const effort = m.efforts.includes(p.effort) ? p.effort : m.defaultEffort ?? m.efforts[0];
        savePref({ provider, model: m.id, effort }); onChange?.();
      } });
  }
  menu(anchor, items, { above: true, align: 'right' });
}
export async function pickEffort(anchor, onChange) {
  const models = await loadModels(), p = pref();
  const m = models[p.provider]?.find((x) => x.id === p.model);
  const efforts = m?.efforts ?? [];
  if (!efforts.length) return menu(anchor, [{ head: 'Este modelo não tem effort' }], { above: true });
  menu(anchor, [{ head: 'Effort' }, ...efforts.map((e) => ({ label: e, on: e === p.effort, run: () => (savePref({ ...p, effort: e }), onChange?.()) }))], { above: true });
}
