// Properties panel (right island), sectioned like pen.dev: component, context, alignment, position, flex layout,
// dimensions, appearance, typography, fill, stroke, effects, theme, code, export. Edits go through the document API,
// so on component instances they become overrides automatically.
import { h, ic, menu } from './ui.js';
import { resolveValue, themeDefaults, indexNodes } from './pen-core.js';
import { iconUrl } from './render.js';

let ctx, id, n, raw, el, update;
const collapsed = new Set(JSON.parse(localStorage.getItem('pena.collapsed') ?? '[]'));

export function renderProps(c) {
  ctx = c;
  const root = document.getElementById('props');
  const scroll = root.scrollTop;
  if (root.contains(document.activeElement) && document.activeElement.matches('input, textarea')) return; // don't steal focus mid-edit
  root.replaceChildren(...(c.selected && c.info(c.selected) ? nodePanel() : docPanel()));
  root.scrollTop = scroll;
}

// ---------------------------------------------------------------- small controls
const isVar = (v) => typeof v === 'string' && v.startsWith('$');
const res = (v) => resolveValue(ctx.doc, v, { ...themeDefaults(ctx.doc), ...ctx.theme });
const round = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);

function num(label, value, set, { min, max, step = 1, scale = 1, suffix = '', title } = {}) {
  const lbl = h('span', { class: 'lbl', style: { cursor: 'ew-resize' }, title }, typeof label === 'string' ? label : label);
  if (isVar(value)) {
    return h('div', { class: 'field', title }, lbl, h('span', { class: 'var', title: `${value} = ${res(value)}`, onclick: (e) => varMenu(e.currentTarget, 'number', set, value) }, value.slice(1)));
  }
  const shown = typeof value === 'number' ? round(value * scale) : '';
  const input = h('input', { value: shown, placeholder: typeof value === 'string' ? value.replace('_container', '').replace('_content', '') : '—', inputmode: 'decimal' });
  const parse = (s) => {
    if (s.trim() === '') return undefined;
    // simple math like pen.dev/Figma fields: "12*2", "100-8"
    const v = Number(/^[\d\s.+\-*/()]+$/.test(s) ? Function(`return (${s})`)() : NaN);
    if (!Number.isFinite(v)) return null;
    return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v / scale));
  };
  input.onchange = () => { const v = parse(input.value); if (v !== null) set(v); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const cur = Number(input.value) || 0, d = (e.shiftKey ? 10 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
      input.value = round(cur + d); set(parse(input.value));
    }
  };
  // drag the label to scrub the value
  lbl.onpointerdown = (e) => {
    const x0 = e.clientX, v0 = Number(input.value) || 0;
    const move = (ev) => (input.value = round(Math.min((max ?? Infinity) * scale, Math.max((min ?? -Infinity) * scale, v0 + Math.round((ev.clientX - x0) / 2) * step))));
    addEventListener('pointermove', move);
    addEventListener('pointerup', () => { removeEventListener('pointermove', move); if (Number(input.value) !== v0) set(parse(input.value)); }, { once: true });
  };
  return h('div', { class: 'field', title }, lbl, input, suffix && h('span', { class: 'lbl' }, suffix));
}
const text = (label, value, set, attrs = {}) => {
  const input = h('input', { value: value ?? '', ...attrs });
  input.onchange = () => set(input.value);
  input.onkeydown = (e) => e.key === 'Enter' && input.blur();
  return h('div', { class: 'field' }, label && h('span', { class: 'lbl' }, label), input);
};
const select = (value, options, set, label) =>
  h('div', { class: 'field' }, label && h('span', { class: 'lbl' }, label),
    h('select', { onchange: (e) => set(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
const seg = (value, options, set) => h('div', { class: 'seg' }, options.map(([v, icon, title]) => h('button', { class: `btn${v === value ? ' on' : ''}`, title, onclick: () => set(v) }, ic(icon))));
const check = (label, on, set) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!on, onchange: (e) => set(e.target.checked) }), label);
const iconBtn = (icon, title, run, on) => h('button', { class: `btn icon${on ? ' on' : ''}`, title, onclick: run }, ic(icon));

function section(key, title, body, actions = []) {
  const isCollapsed = collapsed.has(key);
  const toggle = () => { isCollapsed ? collapsed.delete(key) : collapsed.add(key); localStorage.setItem('pena.collapsed', JSON.stringify([...collapsed])); renderProps(ctx); };
  return h('div', { class: `sec${isCollapsed ? ' collapsed' : ''}` },
    h('div', { class: 't' }, h('span', { style: { cursor: 'pointer' }, onclick: toggle }, title), h('span', { style: { display: 'flex', gap: '2px' } }, ...actions, h('button', { class: 'btn', title: isCollapsed ? 'Expandir' : 'Recolher', onclick: toggle }, ic(isCollapsed ? 'chevron-down' : 'chevron-up', 14)))),
    !isCollapsed && body);
}

function varMenu(anchor, type, set, current) {
  const vars = Object.entries(ctx.doc.variables ?? {}).filter(([, d]) => d.type === type);
  menu(anchor, [
    { head: 'Variáveis' },
    ...vars.map(([name]) => ({ label: name, on: current === `$${name}`, run: () => set(`$${name}`) })),
    ...(current ? ['sep', { label: 'Desvincular variável', icon: 'unlink', run: () => set(res(current)) }] : []),
    ...(!vars.length ? [{ head: 'Nenhuma variável deste tipo' }] : []),
  ]);
}

// ---------------------------------------------------------------- colors
const toHex = (c) => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : '#000000');
function splitHex(c) {
  let x = toHex(c).slice(1);
  if (x.length <= 4) x = [...x].map((ch) => ch + ch).join('');
  return { rgb: `#${x.slice(0, 6).toUpperCase()}`, alpha: x.length === 8 ? parseInt(x.slice(6), 16) / 255 : 1 };
}
const joinHex = (rgb, alpha) => (alpha >= 1 ? rgb.toUpperCase() : rgb.toUpperCase() + Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase());

function colorRow(value, set, { remove, toggle, enabled = true, varType = 'color' } = {}) {
  if (isVar(value)) {
    const c = res(value);
    return h('div', { class: 'paint' },
      h('div', { class: 'field' }, h('span', { class: 'sw', style: { background: c } }), h('span', { class: 'var', title: `${value} = ${c}`, onclick: (e) => varMenu(e.currentTarget, varType, set, value) }, value.slice(1))),
      toggle && iconBtn(enabled ? 'eye' : 'eye-off', 'Mostrar/ocultar', toggle), remove && iconBtn('minus', 'Remover', remove));
  }
  const { rgb, alpha } = splitHex(value);
  const picker = h('input', { type: 'color', value: rgb.toLowerCase(), onchange: (e) => set(joinHex(e.target.value, alpha)) });
  return h('div', { class: 'paint' },
    h('div', { class: 'field' }, h('span', { class: 'sw', style: { background: value } }, picker),
      h('input', { value: rgb.slice(1), onchange: (e) => { const v = e.target.value.replace('#', ''); if (/^[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v)) set(joinHex(`#${v.length === 3 ? [...v].map((x) => x + x).join('') : v}`, alpha)); }, onkeydown: (e) => e.key === 'Enter' && e.target.blur() }),
      h('button', { class: 'btn icon', style: { width: '20px', height: '20px' }, title: 'Usar variável', onclick: (e) => varMenu(e.currentTarget, varType, set) }, ic('braces', 12))),
    h('div', { class: 'field pct' }, h('input', { value: Math.round(alpha * 100), onchange: (e) => set(joinHex(rgb, Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100)) }), h('span', { class: 'lbl' }, '%')),
    toggle && iconBtn(enabled ? 'eye' : 'eye-off', 'Mostrar/ocultar', toggle), remove && iconBtn('minus', 'Remover', remove));
}

// A list of paints (fill or stroke): solid colors, variables, gradients, images.
function paints(key, label) {
  const list = [].concat(n[key] ?? []);
  const setList = (next) => update({ [key]: next.length === 0 ? undefined : next.length === 1 && typeof next[0] === 'string' ? next[0] : next });
  const rows = list.map((p, i) => {
    const replace = (v) => setList(list.map((x, j) => (j === i ? v : x)));
    const remove = () => setList(list.filter((_, j) => j !== i));
    const enabled = typeof p !== 'object' || p.enabled !== false;
    const toggle = () => replace(typeof p === 'string' ? { type: 'color', color: p, enabled: false } : { ...p, enabled: !enabled });
    if (typeof p === 'string') return colorRow(p, replace, { remove, toggle });
    if (p.type === 'color') return colorRow(p.color, (c) => replace({ ...p, color: c }), { remove, toggle, enabled });
    if (p.type === 'gradient') {
      const stops = p.colors ?? [];
      return h('div', { class: 'stack', style: { marginBottom: '8px' } },
        h('div', { class: 'paint' },
          select(p.gradientType ?? 'linear', [['linear', 'Gradiente linear'], ['radial', 'Gradiente radial'], ['angular', 'Gradiente angular']], (v) => replace({ ...p, gradientType: v })),
          iconBtn(enabled ? 'eye' : 'eye-off', 'Mostrar/ocultar', toggle), iconBtn('minus', 'Remover', remove)),
        num(ic('rotate-cw', 12), p.rotation ?? 0, (v) => replace({ ...p, rotation: v }), { suffix: '°' }),
        ...stops.map((s, j) => h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
          h('div', { style: { flex: 1 } }, colorRow(s.color, (c) => replace({ ...p, colors: stops.map((x, k) => (k === j ? { ...x, color: c } : x)) }))),
          h('div', { style: { width: '56px', marginBottom: '6px' } }, num('', Math.round((s.position ?? 0) * 100), (v) => replace({ ...p, colors: stops.map((x, k) => (k === j ? { ...x, position: v / 100 } : x)) }), { min: 0, max: 100, suffix: '%' })))));
    }
    if (p.type === 'image')
      return h('div', { class: 'stack', style: { marginBottom: '8px' } },
        h('div', { class: 'paint' }, h('div', { class: 'field' }, ic('image', 14), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--fg-strong)' }, title: p.url }, p.url || 'Sem imagem')),
          iconBtn(enabled ? 'eye' : 'eye-off', 'Mostrar/ocultar', toggle), iconBtn('minus', 'Remover', remove)),
        h('div', { class: 'g2' },
          select(p.mode ?? 'cover', [['cover', 'Preencher'], ['contain', 'Ajustar'], ['stretch', 'Esticar']], (v) => replace({ ...p, mode: v })),
          h('button', { class: 'btn solid', onclick: () => pickImage((url) => replace({ ...p, url })) }, ic('upload', 14), 'Trocar')));
    return h('div', { class: 'hint' }, `${p.type} (edite no JSON avançado)`);
  });
  const add = (e) => menu(e.currentTarget, [
    { label: 'Cor sólida', icon: 'square', run: () => setList([...list, key === 'stroke' ? '#000000' : '#D9D9D9']) },
    { label: 'Gradiente', icon: 'blend', run: () => setList([...list, { type: 'gradient', gradientType: 'linear', rotation: 180, colors: [{ color: '#FFFFFF', position: 0 }, { color: '#000000', position: 1 }] }]) },
    ...(key === 'fill' && n.type !== 'text' && n.type !== 'icon' ? [{ label: 'Imagem', icon: 'image', run: () => pickImage((url) => setList([...list, { type: 'image', url, mode: 'cover' }])) }] : []),
  ], { align: 'right' });
  return { rows, add: h('button', { class: 'btn', title: `Adicionar ${label.toLowerCase()}`, onclick: add }, ic('plus', 14)) };
}
function pickImage(done) {
  const input = h('input', { type: 'file', accept: 'image/*' });
  input.onchange = async () => {
    const f = input.files[0];
    const r = await fetch(`/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
    if (r.ok) done((await r.json()).url);
  };
  input.click();
}

// ---------------------------------------------------------------- node panel
const FONTS = ['Inter', 'Geist', 'Manrope', 'DM Sans', 'Plus Jakarta Sans', 'Space Grotesk', 'Poppins', 'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Work Sans', 'Outfit', 'Sora', 'Figtree', 'Instrument Sans', 'Playfair Display', 'Fraunces', 'Instrument Serif', 'DM Serif Display', 'Libre Baskerville', 'IBM Plex Mono', 'JetBrains Mono', 'Space Mono'];
const WEIGHTS = [['100', 'Thin'], ['200', 'Extra Light'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semi Bold'], ['700', 'Bold'], ['800', 'Extra Bold'], ['900', 'Black']];
const TYPE_LABEL = { frame: 'Frame', group: 'Grupo', text: 'Texto', rectangle: 'Retângulo', ellipse: 'Elipse', path: 'Vetor', icon: 'Ícone', polygon: 'Polígono', line: 'Linha', note: 'Nota', prompt: 'Prompt', context: 'Contexto', browser: 'Página web', script: 'Script' };

function nodePanel() {
  id = ctx.selected;
  ({ node: n } = ctx.info(id));
  const parent = ctx.info(id).parent;
  raw = ctx.isPath(id) ? null : indexNodes(ctx.doc).get(id)?.node;
  el = ctx.elOf(id);
  update = (props) => ctx.commit((api) => api.Update(id, props));
  const inPath = ctx.isPath(id);
  const isInstance = !!n._ref && !inPath;
  const parentLayout = parent?.type === 'frame' ? parent.layout ?? 'horizontal' : 'none';
  const inFlow = parentLayout !== 'none' && n.layoutPosition !== 'absolute';
  const out = [];

  // header
  const nameInput = h('input', { value: n.name ?? '', placeholder: TYPE_LABEL[n.type] ?? n.type, onchange: (e) => update({ name: e.target.value }), onkeydown: (e) => e.key === 'Enter' && e.target.blur() });
  out.push(h('div', { class: 'p-head' }, ic(n.reusable ? 'component' : n._ref ? 'diamond' : 'frame', 15), nameInput, iconBtn('panel-right-close', 'Ocultar painel', () => document.body.classList.add('no-props'))));

  // component / instance
  const comp = [];
  if (n.reusable && !inPath) {
    let count = 0;
    indexNodes(ctx.doc).forEach(({ node }) => node.type === 'ref' && node.ref === id && count++);
    comp.push(h('div', { class: 'hint', style: { marginBottom: '8px' } }, `Componente principal · ${count} instância${count === 1 ? '' : 's'}`),
      h('div', { class: 'g2' }, h('button', { class: 'btn solid', onclick: () => ctx.commit((api) => api.Insert('document', { type: 'ref', ref: id, name: n.name, x: (n.x ?? 0) + (el?.offsetWidth ?? 100) + 40, y: n.y ?? 0 }), { select: (nid) => nid }) }, ic('plus', 14), 'Instância'),
        h('button', { class: 'btn solid', onclick: () => update({ reusable: false }) }, ic('unlink', 14), 'Desfazer')));
  } else if (isInstance) {
    const source = indexNodes(ctx.doc).get(n._ref)?.node;
    comp.push(h('div', { class: 'hint', style: { marginBottom: '8px' } }, `Instância de “${source?.name ?? n._ref}”`),
      h('div', { class: 'g2' }, h('button', { class: 'btn solid', onclick: () => ctx.select(n._ref) }, ic('component', 14), 'Componente'),
        h('button', { class: 'btn solid', title: 'Transforma a instância em nós normais', onclick: () => detach() }, ic('unlink', 14), 'Desvincular')));
  } else if (inPath) {
    const [inst, ...rest] = id.split('/');
    const has = !!indexNodes(ctx.doc).get(inst)?.node.descendants?.[rest.join('/')];
    comp.push(h('div', { class: 'hint', style: { marginBottom: has ? '8px' : 0 } }, 'Dentro de uma instância: alterações viram overrides só desta instância.'),
      has && h('button', { class: 'btn solid', onclick: () => ctx.commit((api) => { const node = indexNodes(ctx.doc).get(inst).node; const d = { ...node.descendants }; delete d[rest.join('/')]; api.Update(inst, { descendants: undefined }); node.descendants = d; }) }, ic('rotate-ccw', 14), 'Resetar overrides'));
  } else if (!['note', 'prompt', 'context'].includes(n.type)) {
    comp.push(h('button', { class: 'btn solid', style: { width: '100%' }, onclick: () => update({ reusable: true }) }, ic('component', 14), 'Criar componente'));
  }
  if (comp.length) out.push(h('div', { class: 'sec' }, ...comp));

  // context (notes for the agent)
  out.push(section('context', 'Contexto', h('textarea', { class: 'input', rows: 2, placeholder: 'Notas para o agente sobre este elemento', value: n.context ?? '', onchange: (e) => update({ context: e.target.value || undefined }) })));

  // alignment within parent (free nodes only)
  if (parent && !inFlow && !inPath && el) {
    const pr = ctx.elOf(parent.id)?.getBoundingClientRect(), r = el.getBoundingClientRect(), z = r.width / el.offsetWidth || 1;
    const pw = pr ? pr.width / z : 0, ph = pr ? pr.height / z : 0, w = el.offsetWidth, hh = el.offsetHeight;
    out.push(section('align', 'Alinhamento', h('div', { class: 'g2' },
      h('div', { class: 'seg' }, iconBtn('align-start-vertical', 'Esquerda', () => update({ x: 0 })), iconBtn('align-center-vertical', 'Centro', () => update({ x: Math.round((pw - w) / 2) })), iconBtn('align-end-vertical', 'Direita', () => update({ x: Math.round(pw - w) }))),
      h('div', { class: 'seg' }, iconBtn('align-start-horizontal', 'Topo', () => update({ y: 0 })), iconBtn('align-center-horizontal', 'Meio', () => update({ y: Math.round((ph - hh) / 2) })), iconBtn('align-end-horizontal', 'Base', () => update({ y: Math.round(ph - hh) }))))));
  }

  // position
  out.push(section('position', 'Posição', h('div', { class: 'stack' },
    inFlow ? h('div', { class: 'hint' }, 'Posicionado pelo Flex Layout do pai.') : h('div', { class: 'g2' }, num('X', n.x ?? 0, (v) => update({ x: v })), num('Y', n.y ?? 0, (v) => update({ y: v }))),
    h('div', { class: 'g2' }, num(ic('rotate-cw', 12), n.rotation ?? 0, (v) => update({ rotation: v || undefined }), { suffix: '°', title: 'Rotação (anti-horária)' }),
      h('div', { class: 'seg' }, iconBtn('rotate-ccw-square', 'Girar 90°', () => update({ rotation: ((typeof n.rotation === 'number' ? n.rotation : 0) + 90) % 360 })), iconBtn('flip-horizontal-2', 'Espelhar horizontal', () => update({ flipX: !n.flipX || undefined }), n.flipX), iconBtn('flip-vertical-2', 'Espelhar vertical', () => update({ flipY: !n.flipY || undefined }), n.flipY))),
    parentLayout !== 'none' && !inPath && check('Posição absoluta (ignora o layout)', n.layoutPosition === 'absolute', (on) => update({ layoutPosition: on ? 'absolute' : undefined })))));

  // flex layout
  if (n.type === 'frame') out.push(layoutSection());

  // dimensions
  if (!['group'].includes(n.type)) {
    const dim = (k) => {
      const v = n[k];
      const measured = el ? (k === 'width' ? el.offsetWidth : el.offsetHeight) : 0;
      return num(k === 'width' ? 'W' : 'H', typeof v === 'number' || isVar(v) ? v : measured, (val) => update({ [k]: val }), { min: 0 });
    };
    const mode = (k) => (String(n[k]).startsWith('fill_container') ? 'fill' : String(n[k] ?? (n.type === 'frame' ? 'fit_content' : '')).startsWith('fit_content') ? 'hug' : 'fixed');
    const set = (k, m, on) => update({ [k]: on ? (m === 'fill' ? 'fill_container' : 'fit_content') : el ? (k === 'width' ? el.offsetWidth : el.offsetHeight) : 100 });
    out.push(section('size', 'Dimensões', h('div', { class: 'stack' },
      h('div', { class: 'g2' }, dim('width'), dim('height')),
      h('div', { class: 'g2' }, check('Fill Width', mode('width') === 'fill', (on) => set('width', 'fill', on)), check('Fill Height', mode('height') === 'fill', (on) => set('height', 'fill', on))),
      ['frame', 'text', 'ref'].includes(n.type) && h('div', { class: 'g2' }, check('Hug Width', mode('width') === 'hug', (on) => set('width', 'hug', on)), check('Hug Height', mode('height') === 'hug', (on) => set('height', 'hug', on))),
      n.type === 'text' && select(n.textGrowth ?? 'auto', [['auto', 'Auto (não quebra)'], ['fixed-width', 'Largura fixa (quebra)'], ['fixed-width-height', 'Tamanho fixo']], (v) => update({ textGrowth: v }), 'Texto'))));
  }

  // appearance
  const radiusAll = Array.isArray(n.cornerRadius);
  out.push(section('appearance', 'Aparência', h('div', { class: 'stack' },
    h('div', { class: 'g3' },
      num(ic('blend', 12), typeof n.opacity === 'number' ? n.opacity : n.opacity ?? 1, (v) => update({ opacity: v >= 1 ? undefined : v }), { scale: 100, min: 0, max: 1, suffix: '%', title: 'Opacidade' }),
      ['frame', 'rectangle', 'polygon', 'browser', 'ref'].includes(n.type) && !radiusAll ? num(ic('square-round-corner', 12), n.cornerRadius ?? 0, (v) => update({ cornerRadius: v || undefined }), { min: 0, title: 'Raio dos cantos' }) : h('span'),
      ['frame', 'rectangle', 'ref'].includes(n.type) ? iconBtn('scan', 'Raio por canto', () => update({ cornerRadius: radiusAll ? n.cornerRadius[0] : Array(4).fill(n.cornerRadius ?? 0) }), radiusAll) : iconBtn(n.enabled === false ? 'eye-off' : 'eye', 'Visível', () => update({ enabled: n.enabled === false ? undefined : false }))),
    radiusAll && h('div', { class: 'g2' }, ...['↖', '↗', '↘', '↙'].map((l, i) => num(l, n.cornerRadius[i], (v) => update({ cornerRadius: n.cornerRadius.map((x, j) => (j === i ? v : x)) }), { min: 0 }))),
    n.type === 'frame' && check('Clip Content', n.clip === true, (on) => update({ clip: on || undefined })))));

  // typography
  if (n.type === 'text' || n.type === 'note' || n.type === 'prompt') out.push(typeSection());
  if (n.type === 'icon') out.push(iconSection());
  if (n.type === 'ellipse') out.push(section('arc', 'Arco', h('div', { class: 'g3' }, num('In', Math.round((n.innerRadius ?? 0) * 100), (v) => update({ innerRadius: v / 100 || undefined }), { min: 0, max: 100, suffix: '%' }), num('∠', n.startAngle ?? 0, (v) => update({ startAngle: v || undefined }), { suffix: '°' }), num('↻', n.sweepAngle ?? 360, (v) => update({ sweepAngle: v === 360 ? undefined : v }), { suffix: '°' }))));
  if (n.type === 'polygon') out.push(section('poly', 'Polígono', num('Lados', n.polygonCount ?? 3, (v) => update({ polygonCount: Math.max(3, Math.round(v)) }), { min: 3 })));
  if (n.type === 'browser') out.push(section('browser', 'Página web', h('div', { class: 'stack' }, text('URL', n.url, (v) => update({ url: v })), num('Zoom', (n.zoom ?? 1) * 100, (v) => update({ zoom: v / 100 }), { suffix: '%' }))));

  // fill / stroke / effects
  if (!['group', 'note', 'prompt', 'context', 'script'].includes(n.type)) {
    const fill = paints('fill', 'Fill');
    out.push(section('fill', n.type === 'text' ? 'Cor do texto' : 'Fill', fill.rows.length ? fill.rows : h('div', { class: 'hint' }, 'Sem preenchimento'), [fill.add]));
    if (n.type !== 'text' && n.type !== 'icon') {
      const stroke = paints('stroke', 'Stroke');
      out.push(section('stroke', 'Stroke', h('div', { class: 'stack' }, ...stroke.rows,
        n.stroke != null && h('div', { class: 'g2' }, typeof n.strokeWidth === 'object' ? h('div', { class: 'hint' }, 'Larguras por lado (JSON)') : num(ic('minus', 12), n.strokeWidth ?? 1, (v) => update({ strokeWidth: v }), { min: 0 }),
          select(n.strokeAlignment ?? 'inner', [['inner', 'Dentro'], ['center', 'Centro'], ['outer', 'Fora']], (v) => update({ strokeAlignment: v })))), [stroke.add]));
    }
  }
  out.push(effectsSection());

  // theme
  const axes = Object.entries(ctx.doc.themes ?? {});
  if (axes.length && !inPath)
    out.push(section('theme', 'Tema', h('div', { class: 'stack' }, axes.map(([axis, values]) =>
      select(n.theme?.[axis] ?? '', [['', `Herdado`], ...values.map((v) => [v, v])], (v) => { const t = { ...n.theme }; if (v) t[axis] = v; else delete t[axis]; update({ theme: Object.keys(t).length ? t : undefined }); }, axis)))));

  // code + export
  out.push(section('code', 'Código', h('div', { class: 'stack' },
    h('div', { class: 'g2' },
      h('button', { class: 'btn solid', onclick: async () => { await navigator.clipboard.writeText(await ctx.exportNode(id, 'html-css', { includeHtmlScaffold: false })); ctx.toast('HTML copiado'); } }, 'Copiar HTML'),
      h('button', { class: 'btn solid', onclick: () => ctx.download(id, 'html-css') }, 'Exportar HTML')),
    h('button', { class: 'btn solid', title: '⌘L', onclick: () => ctx.copyLink(id) }, 'Copiar link para o agente'),
    h('div', { class: 'hint' }, 'Cole o link no Claude Code/Codex: “implemente este link em Next.js”.'))));
  let scale = 2, format = 'png';
  out.push(section('export', 'Exportar', h('div', { class: 'stack' },
    h('div', { class: 'g2' }, select('2', [['0.5', '0.5x'], ['1', '1x'], ['2', '2x'], ['3', '3x'], ['4', '4x']], (v) => (scale = Number(v))), select('png', [['png', 'PNG'], ['jpeg', 'JPEG'], ['webp', 'WebP'], ['pdf', 'PDF']], (v) => (format = v))),
    h('button', { class: 'btn solid', onclick: () => ctx.download(id, format, scale) }, 'Exportar camada'))));

  // raw JSON (everything the format supports, including what has no control yet)
  const json = inPath ? JSON.stringify(indexNodes(ctx.doc).get(id.split('/')[0])?.node.descendants?.[id.split('/').slice(1).join('/')] ?? {}, null, 2) : JSON.stringify((({ children, ...rest }) => rest)(raw ?? n), null, 2);
  out.push(h('div', { class: 'sec' }, h('details', { class: 'adv' }, h('summary', {}, inPath ? 'JSON dos overrides' : 'JSON avançado'),
    h('textarea', { class: 'input', spellcheck: false, value: json, onchange: (e) => {
      let v;
      try { v = JSON.parse(e.target.value); } catch (err) { return ctx.toast(`JSON inválido: ${err.message}`); }
      if (inPath) return update(v);
      ctx.commit((api) => { api.touch(id); const node = indexNodes(ctx.doc).get(id).node; for (const k of Object.keys(node)) if (k !== 'children' && k !== 'id') delete node[k]; Object.assign(node, v, { id }); });
    } }))));
  return out;
}

function detach() {
  // Replace the instance with a plain copy of its resolved tree.
  ctx.commit((api) => {
    const parentId = ctx.info(id).parent?.id ?? 'document';
    const siblings = ctx.info(id).parent?.children ?? null;
    const index = siblings ? siblings.findIndex((c) => c.id === id) : ctx.doc.children.findIndex((c) => c.id === id);
    const copy = api.Copy(id, parentId);
    api.Delete(id);
    api.Move(copy, parentId, index);
    const node = indexNodes(ctx.doc).get(copy).node;
    const strip = (x) => { delete x._ref; delete x.reusable; (x.children ?? []).forEach(strip); };
    strip(node);
    return copy;
  }, { select: (cid) => cid });
}

function layoutSection() {
  const layout = n.layout ?? 'horizontal';
  const body = [seg(layout, [['none', 'layout-grid', 'Livre (sem layout)'], ['vertical', 'arrow-down', 'Vertical'], ['horizontal', 'arrow-right', 'Horizontal']], (v) => update({ layout: v }))];
  if (layout !== 'none') {
    const J = n.justifyContent ?? 'start', A = n.alignItems ?? 'start';
    const pos = ['start', 'center', 'end'];
    const spaced = J === 'space_between' || J === 'space_around';
    const cells = [];
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) {
        const [main, cross] = layout === 'horizontal' ? [pos[col], pos[row]] : [pos[row], pos[col]];
        const on = cross === A && (spaced || main === J);
        cells.push(h('button', { class: on ? 'on' : '', title: `${main} / ${cross}`, onclick: () => update(spaced ? { alignItems: cross === 'start' ? undefined : cross } : { justifyContent: main === 'start' ? undefined : main, alignItems: cross === 'start' ? undefined : cross }) }));
      }
    const pad = n.padding;
    const pads = pad == null ? [0, 0, 0, 0] : !Array.isArray(pad) ? [pad, pad, pad, pad] : pad.length === 2 ? [pad[0], pad[1], pad[0], pad[1]] : pad;
    const perSide = Array.isArray(pad) && pad.length === 4;
    const setPad = (p) => update({ padding: p.every((x) => x === p[0]) ? p[0] || undefined : p[0] === p[2] && p[1] === p[3] ? [p[0], p[1]] : p });
    body.push(
      h('div', { class: 'g2', style: { marginTop: '10px', alignItems: 'start' } },
        h('div', {}, h('div', { class: 'sub', style: { marginTop: 0 } }, 'Alinhamento'), h('div', { class: 'align9' }, cells)),
        h('div', {}, h('div', { class: 'sub', style: { marginTop: 0 } }, 'Gap'),
          h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'gapmode', checked: !spaced, onchange: () => update({ justifyContent: undefined }) }), num(ic('space', 12), n.gap ?? 0, (v) => update({ gap: v || undefined }), { min: 0 })),
          h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'gapmode', checked: J === 'space_between', onchange: () => update({ justifyContent: 'space_between' }) }), 'Space Between'),
          h('label', { class: 'radio' }, h('input', { type: 'radio', name: 'gapmode', checked: J === 'space_around', onchange: () => update({ justifyContent: 'space_around' }) }), 'Space Around'))),
      h('div', { class: 'sub' }, 'Padding'),
      perSide
        ? h('div', { class: 'g2' }, ...['↑', '→', '↓', '←'].map((l, i) => num(l, pads[i], (v) => setPad(pads.map((x, j) => (j === i ? v : x))), { min: 0 })), h('button', { class: 'btn solid', onclick: () => setPad([pads[0], pads[1], pads[0], pads[1]]) }, 'Simples'))
        : h('div', { class: 'g3' }, num(ic('move-vertical', 12), pads[0], (v) => setPad([v, pads[1], v, pads[1]]), { min: 0, title: 'Vertical' }), num(ic('move-horizontal', 12), pads[1], (v) => setPad([pads[0], v, pads[0], v]), { min: 0, title: 'Horizontal' }), iconBtn('square-dashed', 'Por lado', () => update({ padding: [...pads] }))),
    );
  }
  return section('layout', 'Flex Layout', body);
}

function typeSection() {
  const family = n.fontFamily ?? 'Inter';
  const list = h('datalist', { id: 'fonts-list' }, FONTS.map((f) => h('option', { value: f })));
  return section('type', 'Tipografia', h('div', { class: 'stack' },
    list,
    text(ic('type', 12), isVar(family) ? family : family, (v) => update({ fontFamily: v }), { list: 'fonts-list' }),
    h('div', { class: 'g2' }, select(String(n.fontWeight ?? '400'), WEIGHTS, (v) => update({ fontWeight: v })), num(ic('a-large-small', 12), n.fontSize ?? 14, (v) => update({ fontSize: v }), { min: 1 })),
    h('div', { class: 'g2' }, num(ic('baseline', 12), n.lineHeight ?? '', (v) => update({ lineHeight: v }), { step: 0.05, title: 'Altura da linha (× tamanho)' }), num(ic('move-horizontal', 12), n.letterSpacing ?? 0, (v) => update({ letterSpacing: v || undefined }), { step: 0.1, title: 'Espaçamento entre letras' })),
    n.type === 'text' && h('div', { class: 'g2' },
      seg(n.textAlign ?? 'left', [['left', 'align-left', 'Esquerda'], ['center', 'align-center', 'Centro'], ['right', 'align-right', 'Direita'], ['justify', 'align-justify', 'Justificar']], (v) => update({ textAlign: v === 'left' ? undefined : v })),
      seg(n.textAlignVertical ?? 'top', [['top', 'arrow-up-to-line', 'Topo'], ['middle', 'fold-vertical', 'Meio'], ['bottom', 'arrow-down-to-line', 'Base']], (v) => update({ textAlignVertical: v === 'top' ? undefined : v }))),
    n.type === 'text' && h('div', { class: 'seg' },
      iconBtn('italic', 'Itálico', () => update({ fontStyle: n.fontStyle === 'italic' ? undefined : 'italic' }), n.fontStyle === 'italic'),
      iconBtn('underline', 'Sublinhado', () => update({ underline: !n.underline || undefined }), n.underline),
      iconBtn('strikethrough', 'Tachado', () => update({ strikethrough: !n.strikethrough || undefined }), n.strikethrough)),
    n.type === 'text' && text(ic('link', 12), n.href, (v) => update({ href: v || undefined }), { placeholder: 'Link (opcional)' }),
    n.type === 'prompt' && text('Modelo', n.model, (v) => update({ model: v || undefined }))));
}

function iconSection() {
  const libs = [['lucide', 'Lucide'], ['feather', 'Feather'], ['phosphor', 'Phosphor'], ['Material Symbols Outlined', 'Material Outlined'], ['Material Symbols Rounded', 'Material Rounded'], ['Material Symbols Sharp', 'Material Sharp']];
  return section('icon', 'Ícone', h('div', { class: 'stack' },
    select(n.library ?? 'lucide', libs, (v) => update({ library: v })),
    h('div', { class: 'paint' }, h('span', { class: 'sw', style: { width: '32px', height: '32px', background: 'var(--fg-strong)', WebkitMask: `url(${iconUrl(n.library, n.icon)}) center / 70% no-repeat` } }),
      text('', n.icon, (v) => update({ icon: v.trim() }), { placeholder: 'nome do ícone' })),
    h('a', { class: 'hint', href: n.library?.startsWith('Material') ? 'https://fonts.google.com/icons' : `https://icon-sets.iconify.design/${{ phosphor: 'ph', feather: 'feather' }[n.library] ?? 'lucide'}/`, target: '_blank' }, 'Procurar ícones ↗')));
}

function effectsSection() {
  const list = [].concat(n.effect ?? []);
  const setList = (next) => update({ effect: next.length ? (next.length === 1 ? next[0] : next) : undefined });
  const rows = list.map((e, i) => {
    const replace = (v) => setList(list.map((x, j) => (j === i ? v : x)));
    const remove = () => setList(list.filter((_, j) => j !== i));
    const enabled = e.enabled !== false;
    const head = h('div', { class: 'paint' },
      select(e.type === 'shadow' ? (e.shadowType === 'inner' ? 'inner' : 'shadow') : e.type, [['shadow', 'Sombra'], ['inner', 'Sombra interna'], ['blur', 'Desfoque'], ['background_blur', 'Desfoque de fundo']], (v) =>
        replace(v === 'shadow' || v === 'inner' ? { type: 'shadow', shadowType: v === 'inner' ? 'inner' : 'outer', offset: e.offset ?? { x: 0, y: 4 }, blur: e.blur ?? 12, color: e.color ?? '#00000026' } : { type: v, radius: e.radius ?? 8 })),
      iconBtn(enabled ? 'eye' : 'eye-off', 'Mostrar/ocultar', () => replace({ ...e, enabled: enabled ? false : undefined })), iconBtn('minus', 'Remover', remove));
    if (e.type !== 'shadow') return h('div', { class: 'stack', style: { marginBottom: '8px' } }, head, num('Raio', e.radius ?? 0, (v) => replace({ ...e, radius: v }), { min: 0 }));
    return h('div', { class: 'stack', style: { marginBottom: '8px' } }, head,
      h('div', { class: 'g3' }, num('X', e.offset?.x ?? 0, (v) => replace({ ...e, offset: { x: v, y: e.offset?.y ?? 0 } })), num('Y', e.offset?.y ?? 0, (v) => replace({ ...e, offset: { x: e.offset?.x ?? 0, y: v } })), num('B', e.blur ?? 0, (v) => replace({ ...e, blur: v }), { min: 0, title: 'Desfoque' })),
      colorRow(e.color ?? '#00000040', (c) => replace({ ...e, color: c })));
  });
  return section('effects', 'Effects', rows.length ? rows : h('div', { class: 'hint' }, 'Sombras e desfoques'), [h('button', { class: 'btn', title: 'Adicionar efeito', onclick: () => setList([...list, { type: 'shadow', shadowType: 'outer', offset: { x: 0, y: 4 }, blur: 12, color: '#00000026' }]) }, ic('plus', 14))]);
}

// ---------------------------------------------------------------- document panel (nothing selected)
function docPanel() {
  const d = ctx.doc;
  const vars = Object.entries(d.variables ?? {});
  const themeNow = { ...themeDefaults(d), ...ctx.theme };
  const setVar = (name, def) => ctx.commit((api) => api.SetVariables({ [name]: def }));
  const out = [h('div', { class: 'p-head' }, ic('file', 15), h('span', { style: { flex: 1 } }, 'Documento'), iconBtn('panel-right-close', 'Ocultar painel', () => document.body.classList.add('no-props')))];
  out.push(section('doc-vars', `Variáveis${vars.length ? ` (${vars.length})` : ''}`,
    vars.length
      ? h('div', { class: 'vars' }, vars.map(([name, def]) => {
        const value = resolveValue(d, `$${name}`, themeNow);
        const themed = Array.isArray(def.value);
        return h('div', { class: 'v', title: themed ? 'Valor depende do tema' : '' },
          def.type === 'color' ? h('span', { class: 'sw', style: { background: value } }, !themed && h('input', { type: 'color', value: splitHex(value).rgb.toLowerCase(), onchange: (e) => setVar(name, { ...def, value: joinHex(e.target.value, splitHex(value).alpha) }) })) : ic({ number: 'hash', string: 'quote', boolean: 'toggle-left' }[def.type] ?? 'braces', 14),
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, name), h('span', { class: 'val' }, `${value ?? ''}${themed ? ' ◐' : ''}`));
      }))
      : h('div', { class: 'hint' }, 'Sem variáveis. Peça ao agente: “crie variáveis de cor para claro e escuro”.'),
    [h('button', { class: 'btn', title: 'Nova variável de cor', onclick: () => { const name = prompt('Nome da variável (ex.: primary):'); if (name) setVar(name.trim(), { type: 'color', value: '#3B82F6' }); } }, ic('plus', 14))]));
  const axes = Object.entries(d.themes ?? {});
  out.push(section('doc-themes', 'Temas', axes.length
    ? h('div', { class: 'stack' }, axes.map(([axis, values]) => h('div', { class: 'hint' }, h('b', { style: { color: 'var(--fg-strong)' } }, axis), ': ', values.join(' · '))))
    : h('div', { class: 'hint' }, 'Temas surgem de variáveis com valores por tema (ex.: Mode: Light/Dark).')));
  if (d.fonts?.length) out.push(section('doc-fonts', 'Fontes do arquivo', h('div', { class: 'stack' }, d.fonts.map((f) => h('div', { class: 'hint' }, `${f.name} — ${f.url}`)))));
  let count = 0;
  indexNodes(d).forEach(() => count++);
  out.push(section('doc-info', 'Arquivo', h('div', { class: 'hint' }, `Formato .pen ${d.version} · ${d.children.length} itens no topo · ${count} nós`)));
  return out;
}
