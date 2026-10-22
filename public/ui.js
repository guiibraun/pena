// Small UI helpers shared by the dashboard and the editor.
import { getLocale, localizedTextNode, t } from './i18n.js';
import { brandIcon } from './brands.js';

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
// Blocking overlay for long work (imports): busy('Importando…') → { done(), fail(message) }.
export function busy(text) {
  const box = h('div', { class: 'busy-box' }, h('span', { class: 'spinner' }), text);
  const bg = h('div', { class: 'modal-bg' }, box);
  document.body.append(bg);
  return { done: () => bg.remove(), fail: (msg) => box.replaceChildren(h('span', {}, msg), h('button', { class: 'btn', onclick: () => bg.remove() }, 'OK')) };
}

export const hydrateIcons = (root = document) => {
  for (const el of $$('[data-icon]', root)) {
    el.prepend(ic(el.dataset.icon, Number(el.dataset.size ?? 16)));
    delete el.dataset.icon;
  }
};

export const h = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined) continue; // `el.innerHTML = undefined` would print "undefined"
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'innerHTML' || k === 'textContent' || k === 'value' || (k in el && typeof v !== 'string')) el[k] = v; // these are properties, not attributes
    else if (v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false).map((c) => typeof c === 'string' ? localizedTextNode(el, c) : c));
  return el;
};

// Popup menu anchored to an element: items = [{ label, icon?, on?, run, sub? }] | 'sep' | { head }.
// `sub` opens a submenu on hover; `search` (a placeholder) adds a filter box that matches item and section names.
let openMenu;
export function menu(anchor, items, { align = 'left', above = false, search } = {}) {
  openMenu?.remove();
  let sub;
  const closeSub = () => (sub?.remove(), (sub = null));
  const row = (it, nested) =>
    it === 'sep' ? h('div', { class: 'sep' })
      : it.head ? h('div', { class: 'head' }, it.icon && ic(it.icon), it.brand && brandIcon(it.brand, 13), it.raw ? h('span', { 'data-i18n-ignore': true }, it.head) : it.head)
      : h('button', { class: `item${it.on ? ' on' : ''}`, onclick: () => (m.remove(), it.run()), onpointerenter: nested ? undefined : (e) => { closeSub(); if (it.sub?.length) sub = submenu(e.currentTarget, it.sub); } },
        it.icon && ic(it.icon), it.raw ? h('span', { 'data-i18n-ignore': true }, it.label) : it.label,
        (it.on || it.sub?.length || it.note) && h('span', { class: 'trail' }, it.note && h('span', { class: 'note' }, it.note), it.on && ic('check', 14), it.sub?.length && ic('chevron-right', 14)));
  const submenu = (el, list) => {
    const s = h('div', { class: 'menu' }, list.map((it) => row(it, true)));
    m.append(s); // inside the menu: closes with it, and clicks in it aren't "outside"
    const r = el.getBoundingClientRect();
    s.style.left = `${r.right + s.offsetWidth + 4 > innerWidth ? r.left - s.offsetWidth - 4 : r.right + 4}px`;
    s.style.top = `${Math.max(8, Math.min(r.top - 6, innerHeight - s.offsetHeight - 8))}px`;
    return s;
  };
  const list = h('div', {}, items.map((it) => row(it)));
  const empty = h('div', { class: 'head', hidden: true }, 'Nada encontrado');
  const filter = () => {
    const q = input.value.trim().toLowerCase();
    closeSub();
    let head, any = false;
    for (const el of list.children) {
      if (el.classList.contains('head')) (head = el).hidden = !!q;
      else if (el.classList.contains('sep')) el.hidden = !!q;
      else {
        el.hidden = !!q && !`${head?.textContent ?? ''} ${el.textContent}`.toLowerCase().includes(q);
        if (!el.hidden) { any = true; if (head) head.hidden = false; }
      }
    }
    empty.hidden = any;
  };
  const input = search && h('input', { class: 'menu-search', placeholder: search, oninput: filter, onkeydown: (e) => {
    e.stopPropagation(); // the editor's shortcuts
    if (e.key === 'Enter') list.querySelector('.item:not([hidden])')?.click();
    if (e.key === 'Escape') m.remove();
  } });
  const m = h('div', { class: 'menu' }, input, list, empty);
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, align === 'right' ? r.right - m.offsetWidth : r.left)}px`;
  let up = above;
  if (!up && r.bottom + 6 + m.offsetHeight > innerHeight) up = true;
  // above the anchor: pinned by its bottom, so it stays attached while the search shrinks it
  if (up) m.style.bottom = `${Math.max(8, innerHeight - r.top + 6)}px`;
  else m.style.top = `${r.bottom + 6}px`;
  input?.focus();
  openMenu = m;
  setTimeout(() => addEventListener('pointerdown', function close(e) { if (!m.contains(e.target)) m.remove(), removeEventListener('pointerdown', close); }), 0);
  return m;
}

export const timeAgo = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (getLocale() === 'en') {
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    if (s < 172800) return 'yesterday';
    return `${Math.floor(s / 86400)} days ago`;
  }
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 172800) return 'ontem';
  return `há ${Math.floor(s / 86400)} dias`;
};
export const date = (ms) => new Date(ms).toLocaleDateString(getLocale());

// Model picker shared by the dashboard prompt and the editor composer (lists come from your accounts).
export const PROVIDERS = { claude: 'Claude', codex: 'Codex / ChatGPT', opencode: 'OpenCode' };
let modelsPromise;
export const loadModels = () => (modelsPromise ??= fetch('/models').then((r) => r.json()).catch(() => ({ accounts: [], claude: [], codex: [], opencode: [] })));
export const clearModels = () => (modelsPromise = undefined);
export const pref = () => {
  const provider = localStorage.getItem('pena.provider') ?? 'claude';
  return { provider, ...JSON.parse(localStorage.getItem(`pena.${provider}`) ?? '{}') };
};
export const savePref = ({ provider, model, effort }) => {
  localStorage.setItem('pena.provider', provider);
  localStorage.setItem(`pena.${provider}`, JSON.stringify({ model, effort }));
};
// Models switched off in Settings › Agents › account stay out of the chat picker ("account model-id").
export const hiddenModels = () => new Set(JSON.parse(localStorage.getItem('pena.hiddenModels') ?? '[]'));
export const setHiddenModels = (set) => localStorage.setItem('pena.hiddenModels', JSON.stringify([...set]));
// The picker's groups: one per account (default accounts keep the provider's id).
const accountList = (models) => models.accounts?.length ? models.accounts : Object.entries(PROVIDERS).map(([id, name]) => ({ id, provider: id, name }));
// First run: default to the account's first concrete model (not the "default" alias) and its default effort.
// An account removed in Settings falls back to the first account that still has models.
export async function ensurePref() {
  const p = pref(), models = await loadModels();
  const list = models[p.provider] ?? [];
  if (list.some((x) => x.id === p.model)) return p;
  const provider = list.length ? p.provider : accountList(models).map((a) => a.id).find((id) => (models[id] ?? []).some((x) => x.id !== 'default')) ?? p.provider;
  const m = (models[provider] ?? []).find((x) => x.id !== 'default') ?? (models[provider] ?? [])[0];
  if (m) savePref({ provider, model: m.id, effort: m.defaultEffort ?? m.efforts[0] });
  return pref();
}
export async function modelLabel() {
  const p = await ensurePref(), models = await loadModels();
  const m = models[p.provider]?.find((x) => x.id === p.model);
  return m?.name ?? accountList(models).find((a) => a.id === p.provider)?.name ?? PROVIDERS[p.provider] ?? 'Claude';
}
// Reasoning effort levels as shown to you (the ids are what the CLIs take).
export const EFFORT_LABEL = { none: 'Nenhum', minimal: 'Mínimo', low: 'Baixo', medium: 'Médio', high: 'Alto', xhigh: 'Muito alto', max: 'Máximo' };
const effortItems = (m, p, onChange, provider = p.provider) => (m?.efforts ?? []).map((e) => ({
  label: `${t(EFFORT_LABEL[e] ?? e)}${e === m.defaultEffort ? ` (${t('Padrão')})` : ''}`, icon: 'zap',
  on: p.provider === provider && p.model === m.id && e === p.effort,
  run: () => (savePref({ provider, model: m.id, effort: e }), onChange?.()),
}));
// every model of your accounts, searchable; each one's reasoning levels in a submenu
export async function pickModel(anchor, onChange) {
  const models = await loadModels(), p = pref(), hidden = hiddenModels();
  const items = [];
  for (const a of accountList(models)) {
    const list = (models[a.id] ?? []).filter((m) => !hidden.has(`${a.id} ${m.id}`));
    if (!list.length) continue;
    const title = PROVIDERS[a.provider] ?? a.provider;
    items.push({ head: a.provider === 'opencode' ? `${title} · seus provedores` : a.id === a.provider ? `${title} · sua assinatura` : `${title} · ${a.name}`, brand: a.provider });
    for (const m of list)
      items.push({ label: m.name, raw: true, on: p.provider === a.id && p.model === m.id, sub: effortItems(m, p, onChange, a.id), run: () => {
        const effort = m.efforts.includes(p.effort) ? p.effort : m.defaultEffort ?? m.efforts[0];
        savePref({ provider: a.id, model: m.id, effort }); onChange?.();
      } });
  }
  menu(anchor, items, { above: true, align: 'right', search: 'Buscar modelos…' });
}
export async function pickEffort(anchor, onChange) {
  const models = await loadModels(), p = pref();
  const m = models[p.provider]?.find((x) => x.id === p.model);
  const efforts = m?.efforts ?? [];
  if (!efforts.length) return menu(anchor, [{ head: 'Este modelo não tem níveis de raciocínio' }], { above: true });
  menu(anchor, [{ head: `Raciocínio · ${m.name}` }, ...effortItems(m, p, onChange)], { above: true });
}
