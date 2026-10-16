// .pen -> DOM renderer. pen.dev draws with Skia/WASM; we map the format onto HTML/CSS
// (flex layout is CSS flexbox), which also makes HTML export a serialization of this output.
import { resolveValue, themeDefaults, sizeNumber } from './pen-core.js';

const px = (v) => (typeof v === 'number' ? `${v}px` : v);
const JUSTIFY = { start: 'flex-start', end: 'flex-end', center: 'center', space_between: 'space-between', space_around: 'space-around' };
const ALIGN = { start: 'flex-start', end: 'flex-end', center: 'center' };
const svgNS = 'http://www.w3.org/2000/svg';

// Iconify serves every library pen.dev supports as plain SVG; the fill color comes through a CSS mask.
const ICON_SETS = {
  lucide: (i) => `lucide/${i}`,
  feather: (i) => `feather/${i}`,
  phosphor: (i) => `ph/${i}`,
  'Material Symbols Outlined': (i) => `material-symbols/${i.replaceAll('_', '-')}-outline`,
  'Material Symbols Rounded': (i) => `material-symbols/${i.replaceAll('_', '-')}-rounded`,
  'Material Symbols Sharp': (i) => `material-symbols/${i.replaceAll('_', '-')}-sharp`,
};
export const iconUrl = (library = 'lucide', icon = '') => `https://api.iconify.design/${(ICON_SETS[library] ?? ICON_SETS.lucide)(icon)}.svg`;

export function renderDoc(doc, nodes, { theme = {}, selected, assetUrl = (u) => u, onElement, parent, inheritedTheme } = {}) {
  const baseTheme = { ...themeDefaults(doc), ...theme };
  const fonts = new Set();

  function node(n, parent, theme) {
    if (n.enabled === false) return null;
    theme = n.theme ? { ...theme, ...n.theme } : theme;
    const V = (v) => resolveValue(doc, v, theme);
    const P = (k) => V(n[k]);
    const el = document.createElement(n.type === 'text' && n.href ? 'a' : 'div');
    const s = el.style;
    el.dataset.id = n.id;
    el.dataset.k = n.type; // lets the editor drop detail (text, icons) when zoomed far out
    onElement?.(n.id, el); // lets the editor keep an id -> element map instead of querying the DOM
    if (n._ref) el.dataset.instance = n._ref;
    if (n.reusable) el.dataset.component = '1';

    const parentLayout = parent?.type === 'frame' ? parent.layout ?? 'horizontal' : 'none';
    const inFlow = parentLayout !== 'none' && n.layoutPosition !== 'absolute';
    s.position = inFlow ? 'relative' : 'absolute';
    s.flexShrink = '0';
    s.boxSizing = 'border-box';
    if (!inFlow) Object.assign(s, { left: px(n.x ?? 0), top: px(n.y ?? 0) });

    // sizing
    const hasKids = n.children?.length > 0;
    for (const [prop, axis] of [['width', 'horizontal'], ['height', 'vertical']]) {
      const v = P(prop);
      if (typeof v === 'number') s[prop] = `${v}px`;
      else if (String(v).startsWith('fill_container')) {
        if (!inFlow) s[prop] = String(v).includes('(') ? `${sizeNumber(v)}px` : '100%';
        else if (parentLayout === axis) Object.assign(s, { flex: '1 1 0', [axis === 'horizontal' ? 'minWidth' : 'minHeight']: '0' });
        else s.alignSelf = 'stretch';
      } else if (String(v).startsWith('fit_content') && !hasKids && String(v).includes('(')) s[prop] = `${sizeNumber(v)}px`;
      else if (n.type !== 'text' || v === undefined) s[prop] = 'fit-content';
    }

    // transform: rotation is degrees CCW around the top-left corner
    const t = [];
    if (P('rotation')) t.push(`rotate(${-P('rotation')}deg)`);
    if (P('flipX')) t.push('scaleX(-1)');
    if (P('flipY')) t.push('scaleY(-1)');
    if (t.length) Object.assign(s, { transform: t.join(' '), transformOrigin: P('rotation') ? '0 0' : 'center' });
    if (n.opacity != null) s.opacity = P('opacity');
    if (n.cornerRadius != null) s.borderRadius = [].concat(P('cornerRadius')).map((c) => px(V(c))).join(' ');

    // fills: arrays paint bottom-to-top, CSS backgrounds list top-first
    const layers = [].concat(n.fill ?? []).map((f) => paint(f, V)).filter(Boolean).reverse();
    const effects = [].concat(n.effect ?? []).filter((e) => e && V(e.enabled) !== false);
    const shadows = effects.filter((e) => e.type === 'shadow').map((e) =>
      `${e.shadowType === 'inner' ? 'inset ' : ''}${V(e.offset?.x) ?? 0}px ${V(e.offset?.y) ?? 0}px ${V(e.blur) ?? 0}px ${V(e.spread) ?? 0}px ${V(e.color) ?? '#00000040'}`);
    const filters = effects.filter((e) => e.type === 'blur').map((e) => `blur(${V(e.radius) ?? 0}px)`);
    const backdrop = effects.find((e) => e.type === 'background_blur');
    if (backdrop) s.backdropFilter = `blur(${V(backdrop.radius) ?? 0}px)`;
    const stroke = solid(n.stroke, V);
    const sw = P('strokeWidth') ?? 1;

    switch (n.type) {
      case 'text': {
        const color = solid(n.fill, V) ?? '#000000';
        if (n.fontFamily) fonts.add(P('fontFamily'));
        Object.assign(s, {
          color, fontFamily: `${P('fontFamily') ? `"${P('fontFamily')}", ` : ''}Inter, system-ui, sans-serif`,
          fontSize: px(P('fontSize') ?? 14), fontWeight: P('fontWeight') ?? '400', fontStyle: P('fontStyle') ?? 'normal',
          lineHeight: P('lineHeight') ?? 'normal', letterSpacing: px(P('letterSpacing') ?? 0), textAlign: n.textAlign ?? 'left',
          textDecoration: [P('underline') && 'underline', P('strikethrough') && 'line-through'].filter(Boolean).join(' ') || 'none',
          whiteSpace: (n.textGrowth ?? 'auto') === 'auto' ? 'pre' : 'pre-wrap', overflowWrap: 'break-word',
        });
        if (n.textAlignVertical) Object.assign(s, { display: 'flex', flexDirection: 'column', justifyContent: { top: 'flex-start', middle: 'center', bottom: 'flex-end' }[n.textAlignVertical] });
        if (n.href) Object.assign(el, { href: n.href, target: '_blank' });
        if (shadows.length) filters.push(...effects.filter((e) => e.type === 'shadow').map((e) => `drop-shadow(${V(e.offset?.x) ?? 0}px ${V(e.offset?.y) ?? 0}px ${V(e.blur) ?? 0}px ${V(e.color) ?? '#00000040'})`));
        el.textContent = P('content') ?? '';
        break;
      }
      case 'path':
      case 'polygon':
      case 'line':
      case 'ellipse': {
        const vector = n.type !== 'ellipse' || (P('innerRadius') ?? 0) > 0 || Math.abs(P('sweepAngle') ?? 360) < 360;
        if (!vector) {
          s.borderRadius = '50%';
          paintBox();
          break;
        }
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.cssText = 'overflow:visible;display:block';
        const path = document.createElementNS(svgNS, 'path');
        const fill = solid(n.fill, V);
        path.setAttribute('fill', n.type === 'line' ? 'none' : fill ?? 'none');
        path.setAttribute('fill-rule', n.fillRule ?? 'nonzero');
        if (stroke) {
          for (const [a, v] of [['stroke', stroke], ['stroke-width', sw], ['stroke-linecap', n.strokeLinecap ?? 'butt'], ['stroke-linejoin', n.strokeLinejoin ?? 'miter']]) path.setAttribute(a, v);
          path.setAttribute('vector-effect', 'non-scaling-stroke');
        }
        if (n.type === 'path') {
          path.setAttribute('d', n.geometry ?? '');
          if (n.viewBox) svg.setAttribute('viewBox', n.viewBox.join(' '));
          else svg.dataset.fitViewbox = '1';
        } else {
          svg.setAttribute('viewBox', '0 0 100 100');
          path.setAttribute('d', n.type === 'line' ? 'M0 0L100 100' : n.type === 'polygon' ? polygon(P('polygonCount') ?? 3) : arc(P('innerRadius') ?? 0, P('startAngle') ?? 0, P('sweepAngle') ?? 360));
          if (n.type === 'line' && !sizeNumber(n.height)) path.setAttribute('d', 'M0 0L100 0');
        }
        svg.append(path);
        el.append(svg);
        break;
      }
      case 'icon': {
        const color = solid(n.fill, V) ?? '#000000';
        Object.assign(s, { backgroundColor: color, maskImage: `url(${iconUrl(P('library'), P('icon'))})`, maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center' });
        s.webkitMaskImage = s.maskImage;
        if (!n.width) s.width = s.height = '24px';
        break;
      }
      case 'note':
      case 'prompt':
      case 'context': {
        const look = { note: ['#FFF4B3', '#5C4A00'], prompt: ['#EDE7FF', '#3B1F8F'], context: ['#E8EEF5', '#22324A'] }[n.type];
        Object.assign(s, { background: look[0], color: look[1], padding: '14px 16px', borderRadius: '10px', font: `${P('fontSize') ?? 15}px/1.45 Inter, system-ui, sans-serif`, whiteSpace: 'pre-wrap', boxShadow: '0 2px 8px #0000001a' });
        el.textContent = (n.type === 'prompt' ? `✦ ${n.model ?? 'prompt'}\n` : '') + (P('content') ?? '');
        break;
      }
      case 'browser': {
        Object.assign(s, { background: '#fff', border: '1px solid #ccc', overflow: 'hidden' });
        if (n.url) el.innerHTML = `<iframe src="${encodeURI(n.url)}" style="border:0;width:${100 / (n.zoom ?? 1)}%;height:${100 / (n.zoom ?? 1)}%;transform:scale(${n.zoom ?? 1});transform-origin:0 0;pointer-events:none"></iframe>`;
        break;
      }
      case 'script':
        Object.assign(s, { border: '1px dashed #999', background: '#f6f6f6' });
        el.textContent = `script: ${n.scriptUri ?? ''}`;
        break;
      default: // frame, group, rectangle, ref leftovers
        paintBox();
        if (n.type === 'frame') {
          const layout = n.layout ?? 'horizontal';
          if (layout !== 'none')
            Object.assign(s, { display: 'flex', flexDirection: layout === 'vertical' ? 'column' : 'row', gap: px(P('gap') ?? 0),
              justifyContent: JUSTIFY[n.justifyContent ?? 'start'], alignItems: ALIGN[n.alignItems ?? 'start'] });
          if (n.padding != null) s.padding = [].concat(P('padding')).map((p) => px(V(p))).join(' ');
          if (V(n.clip)) s.overflow = 'hidden';
        }
        for (const c of n.children ?? []) {
          const child = node(c, n, theme);
          if (child) el.append(child);
        }
    }
    if (filters.length) s.filter = filters.join(' ');
    if (n.id === selected) el.classList.add('sel');
    return el;

    function paintBox() {
      if (layers.length) s.background = layers.join(', ');
      if (n.fill?.type === 'image' || [].concat(n.fill ?? []).some((f) => f?.type === 'image'))
        Object.assign(s, { backgroundSize: [].concat(n.fill).reverse().map((f) => (f?.type === 'image' ? { contain: 'contain', stretch: '100% 100%' }[f.mode] ?? 'cover' : 'auto')).join(', '), backgroundPosition: 'center', backgroundRepeat: 'no-repeat' });
      if (shadows.length) s.boxShadow = shadows.join(', ');
      if (stroke) {
        const w = typeof sw === 'object' ? sw : null;
        if (w) for (const side of ['top', 'right', 'bottom', 'left']) s[`border${side[0].toUpperCase() + side.slice(1)}`] = `${V(w[side]) ?? 0}px solid ${stroke}`;
        else {
          const align = n.strokeAlignment ?? 'inner';
          Object.assign(s, { outline: `${sw}px solid ${stroke}`, outlineOffset: `${align === 'inner' ? -sw : align === 'center' ? -sw / 2 : 0}px` });
        }
      }
    }
  }

  function paint(f, V) {
    if (f == null) return null;
    if (typeof f === 'string') return (f = V(f)) ? `linear-gradient(${f}, ${f})` : null;
    if (V(f.enabled) === false) return null;
    if (f.type === 'color') return paint(f.color, V);
    if (f.type === 'image') return f.url ? `url("${assetUrl(f.url)}")` : null;
    if (f.type === 'gradient') {
      const stops = (f.colors ?? []).map((c) => `${V(c.color)} ${(V(c.position) ?? 0) * 100}%`).join(', ');
      const rot = V(f.rotation) ?? 0;
      if (f.gradientType === 'radial') return `radial-gradient(ellipse at ${(f.center?.x ?? 0.5) * 100}% ${(f.center?.y ?? 0.5) * 100}%, ${stops})`;
      if (f.gradientType === 'angular') return `conic-gradient(from ${-rot}deg at ${(f.center?.x ?? 0.5) * 100}% ${(f.center?.y ?? 0.5) * 100}%, ${stops})`;
      return `linear-gradient(${(360 - rot) % 360}deg, ${stops})`; // pen: CCW from up; css: CW from up
    }
    if (f.type === 'mesh_gradient') return `linear-gradient(135deg, ${(f.colors ?? []).map(V).join(', ')})`; // ponytail: approximated
    return null;
  }

  const solid = (f, V) => {
    for (const x of [].concat(f ?? []).reverse()) {
      if (typeof x === 'string') return V(x);
      if (x?.type === 'color' && V(x.enabled) !== false) return V(x.color);
      if (x?.type === 'gradient') return V(x.colors?.[0]?.color);
    }
  };

  // `parent`/`inheritedTheme` let the editor re-render one subtree in place (its layout context and theme).
  const elements = nodes.map((n) => node(n, parent ?? null, inheritedTheme ? { ...baseTheme, ...inheritedTheme } : baseTheme)).filter(Boolean);
  return { elements, fonts };
}

export const polygon = (count) => {
  const pts = Array.from({ length: count }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    return `${50 + 50 * Math.cos(a)} ${50 + 50 * Math.sin(a)}`;
  });
  return `M${pts.join('L')}Z`;
};

export function arc(inner, start, sweep) {
  const pt = (r, deg) => [50 + r * Math.cos((-deg * Math.PI) / 180), 50 + r * Math.sin((-deg * Math.PI) / 180)];
  const full = Math.abs(sweep) >= 360;
  if (full) sweep = 359.99;
  const end = start + sweep, large = Math.abs(sweep) > 180 ? 1 : 0, dir = sweep > 0 ? 0 : 1, ri = 50 * inner;
  const [x1, y1] = pt(50, start), [x2, y2] = pt(50, end);
  let d = `M${x1} ${y1}A50 50 0 ${large} ${dir} ${x2} ${y2}`;
  if (ri > 0) {
    const [x3, y3] = pt(ri, end), [x4, y4] = pt(ri, start);
    d += `L${x3} ${y3}A${ri} ${ri} 0 ${large} ${1 - dir} ${x4} ${y4}Z`;
  } else d += full ? 'Z' : 'L50 50Z';
  return d;
}

// After the elements are in the DOM: fit path geometry without a viewBox to its bounding box.
// Bounding boxes of the same geometry are cached: big files repeat icons/vectors many times, and getBBox forces layout.
const bboxCache = new Map();
export function fitPathViewBoxes(root) {
  const pending = [...root.querySelectorAll('svg[data-fit-viewbox]')];
  if (root.matches?.('svg[data-fit-viewbox]')) pending.push(root);
  for (const svg of pending) {
    const d = svg.firstElementChild.getAttribute('d') ?? '';
    let vb = bboxCache.get(d);
    if (!vb) {
      const b = svg.firstElementChild.getBBox();
      vb = `${b.x} ${b.y} ${b.width || 1} ${b.height || 1}`;
      if (b.width || b.height) bboxCache.set(d, vb);
    }
    svg.setAttribute('viewBox', vb);
    delete svg.dataset.fitViewbox;
  }
}

// Fonts: the file's own @font-face entries, then Google Fonts for every family the render used.
// Returns a promise that settles when the stylesheets added by this call have loaded (the rasterizer waits on it).
export const loadedFonts = new Set();
const loadedFaces = new Set();
export function loadDocFonts(doc, fonts, assetUrl = (u) => u) {
  const waits = [];
  const add = (tag, props) => {
    const el = Object.assign(document.createElement(tag), props);
    if (tag === 'link') waits.push(new Promise((r) => (el.onload = el.onerror = r)));
    document.head.append(el);
  };
  for (const f of doc.fonts ?? []) {
    const key = JSON.stringify(f);
    if (!f.url || loadedFaces.has(key)) continue;
    loadedFaces.add(key);
    const weight = Array.isArray(f.weight) ? f.weight.join(' ') : f.weight ?? 'normal';
    add('style', { textContent: `@font-face{font-family:"${f.name}";src:url("${assetUrl(f.url)}");font-style:${f.style ?? 'normal'};font-weight:${weight}}` });
    loadedFonts.add(f.name);
  }
  for (const f of fonts) {
    if (!f || loadedFonts.has(f)) continue;
    loadedFonts.add(f);
    // Variable-weight request first; the plain one covers static fonts that reject the range.
    for (const q of [':ital,wght@0,100..900;1,100..900', ''])
      add('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f)}${q}&display=swap` });
  }
  return Promise.all(waits);
}
