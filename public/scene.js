// Scene graph + layout + Skia drawing for .pen documents, modeled on pen.dev's own engine (recovered from its
// bundle): a small 5-pass layout solver in JS (fit/fill per axis, then positions), SkParagraph text, everything
// drawn with Skia paths/paints. The editor builds one scene per document and re-builds only edited roots.
import { resolveValue, themeDefaults } from './pen-core.js';
import { CK, fonts, weightOf } from './skia.js';
import { iconUrl, polygon, arc } from './render.js';

const H = 0, V = 1;
const FIXED = 0, FIT = 2, FILL = 3;
const JUSTIFY = { start: 0, center: 1, space_between: 2, space_around: 3, end: 4 };
const ALIGN = { start: 0, center: 1, end: 2 };
const effectPadding = (effect, value) => {
  const radius = Number(value(effect.radius ?? effect.blur)) || 0;
  const offset = Math.max(Math.abs(Number(value(effect.offset?.x)) || 0), Math.abs(Number(value(effect.offset?.y)) || 0));
  return 3 * radius + Math.abs(Number(value(effect.spread)) || 0) + offset;
};

// ---------------------------------------------------------------- values
const parseSize = (v, dflt) => {
  if (typeof v === 'number') return [FIXED, v];
  const m = /^(\w+)(?:\((-?[\d.]+)\))?$/.exec(String(v ?? ''));
  if (!m) return dflt;
  const n = Number(m[2] ?? 0);
  return m[1] === 'fill_container' ? [FILL, n] : m[1] === 'fit_content' ? [FIT, n] : dflt;
};
const padding = (p) => {
  if (p == null) return [0, 0, 0, 0];
  if (typeof p === 'number') return [p, p, p, p];
  const a = [].concat(p).map(Number);
  return [0, 1, 2, 3].map((i) => a[i % a.length] || 0); // [v,h] -> t,r,b,l
};
// Map as LRU: reads move the entry to the end, inserts past `max` evict the oldest (and free it).
const lruGet = (map, key) => { const v = map.get(key); if (v !== undefined) { map.delete(key); map.set(key, v); } return v; };
const lruSet = (map, key, v, max, free) => {
  map.set(key, v);
  while (map.size > max) { const [k, old] = map.entries().next().value; map.delete(k); free?.(old, k); }
};
const colorCache = new Map();
export function color(s, alpha = 1) {
  if (typeof s !== 'string') return null;
  const key = s + alpha;
  let c = lruGet(colorCache, key);
  if (c) return c;
  let r = 0, g = 0, b = 0, a = 1;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s.trim());
  if (hex) {
    let x = hex[1];
    if (x.length <= 4) x = [...x].map((ch) => ch + ch).join('');
    [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
    if (x.length === 8) a = parseInt(x.slice(6, 8), 16) / 255;
  } else {
    const m = /rgba?\(([^)]+)\)/.exec(s);
    if (m) [r, g, b, a = 1] = m[1].split(/[\s,/]+/).filter(Boolean).map((v, i) => (v.endsWith('%') ? (parseFloat(v) / 100) * (i < 3 ? 255 : 1) : Number(v)));
    else if (s === 'transparent') a = 0;
    else if (s === 'white') [r, g, b] = [255, 255, 255];
  }
  c = Float32Array.of(r / 255, g / 255, b / 255, a * alpha);
  lruSet(colorCache, key, c, 2000);
  return c;
}

// ---------------------------------------------------------------- shared caches (survive scene rebuilds)
const measureCache = new Map(); // text style+content+width -> [w, h]
const paraCache = new Map(); // text style+content -> Paragraph (LRU: shaped text lives in WASM memory)
const PARA_MAX = 600;
const MEASURE_MAX = 5000;
const paragraphWidths = new WeakMap();
const layoutParagraph = (p, width) => {
  if (paragraphWidths.get(p) === width) return;
  p.layout(width);
  paragraphWidths.set(p, width);
};
const pathCache = new Map(); // svg string -> Path (LRU: paths live in WASM memory)
const PATH_MAX = 1000;
const images = new Map(); // url or icon key -> { img } (LRU: images hold GPU textures)
const IMAGES_MAX = 400; // ponytail: entry count, not bytes; a byte budget if huge photos still pile up
// a drawing still on screen keeps its own reference (Skia refcounts), so freeing here is safe
const freeImage = (e, key) => {
  if (!e.img) return;
  const base = key.slice(0, key.lastIndexOf('|'));
  if (iconLatest.get(base) === e.img) iconLatest.delete(base);
  e.img.delete();
};
let fontVersion = -1;
const resetTextCaches = () => {
  for (const p of paraCache.values()) p.delete();
  paraCache.clear(); measureCache.clear();
};

function svgPath(d) {
  let p = lruGet(pathCache, d);
  if (p === undefined) { p = CK().Path.MakeFromSVGString(d) ?? null; lruSet(pathCache, d, p, PATH_MAX, (old) => old?.delete()); }
  return p;
}

// Images (fills, icons) load asynchronously; `onReady` re-renders. SVGs go through the browser's rasterizer.
const assetLoaded = (entry) => { entry.waiters.forEach((ready) => ready()); entry.waiters.clear(); };
const pendingAssets = new Set();
const track = (p) => { pendingAssets.add(p); p.finally(() => pendingAssets.delete(p)); return p; };
// resolves once every image/icon requested so far has loaded (exports draw twice: request, then final)
export const assetsSettled = async () => { while (pendingAssets.size) await Promise.allSettled([...pendingAssets]); };
const iconLatest = new Map(); // icon without size -> last loaded image (shown while a sharper size loads)
const decodeImg = async (url) => { const im = new Image(); im.src = url; await im.decode(); return im; };
// Images become GPU textures (not WASM memory), capped like pen.dev's base texture.
const MAX_IMG = 2048;
async function rasterize(src, w, h) {
  const k = Math.min(1, MAX_IMG / Math.max(w, h));
  const bmp = await createImageBitmap(src, { resizeWidth: Math.max(1, Math.round(w * k)), resizeHeight: Math.max(1, Math.round(h * k)), resizeQuality: 'high' });
  return CK().MakeLazyImageFromTextureSource(bmp);
}
function image(url, ready) {
  let e = lruGet(images, url);
  if (e) { if (!e.img) e.waiters.add(ready); return e.img; }
  lruSet(images, url, (e = { img: null, waiters: new Set([ready]) }), IMAGES_MAX, freeImage);
  track((async () => {
    const blob = await (await fetch(url)).blob();
    const src = /svg/.test(blob.type) || /\.svg($|\?)/i.test(url) ? await decodeImg(URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' }))) : await createImageBitmap(blob);
    const img = await rasterize(src, src.naturalWidth || src.width || 512, src.naturalHeight || src.height || 512);
    src.close?.();
    if (images.get(url) !== e) return img.delete(); // evicted while loading
    e.img = img;
    assetLoaded(e);
  })().catch(() => { e.waiters.clear(); }));
  return null;
}
const iconSvg = new Map();
function icon(library, name, fill, px, ready) {
  const size = Math.min(512, Math.max(32, 2 ** Math.ceil(Math.log2(px))));
  const base = `${library}|${name}|${fill}`, key = `${base}|${size}`;
  let e = lruGet(images, key);
  if (e) { if (!e.img) e.waiters.add(ready); return e.img ?? iconLatest.get(base) ?? null; }
  lruSet(images, key, (e = { img: null, waiters: new Set([ready]) }), IMAGES_MAX, freeImage);
  track((async () => {
    const url = iconUrl(library, name);
    if (!iconSvg.has(url)) iconSvg.set(url, fetch(url).then((r) => (r.ok ? r.text() : '')));
    let svg = await iconSvg.get(url);
    if (!svg) { e.waiters.clear(); return; }
    svg = svg.replaceAll('currentColor', fill);
    if (!/<svg[^>]*\sfill=/.test(svg)) svg = svg.replace('<svg', `<svg fill="${fill}"`);
    svg = svg.replace(/\swidth="[^"]*"/, ` width="${size}"`).replace(/\sheight="[^"]*"/, ` height="${size}"`);
    const img = await rasterize(await decodeImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`), size, size);
    if (images.get(key) !== e) return img.delete(); // evicted while loading
    e.img = img;
    iconLatest.set(base, e.img);
    assetLoaded(e);
  })().catch(() => { e.waiters.clear(); }));
  return iconLatest.get(base) ?? null;
}

// ---------------------------------------------------------------- nodes
class Node {
  constructor(src, parent, scene, theme) {
    this.src = src; this.parent = parent; this.scene = scene;
    this.id = src.id; this.type = src.type;
    this.assetReady = parent?.assetReady ?? (() => scene.assetReady(this.id));
    theme = src.theme ? { ...theme, ...src.theme } : theme;
    this.theme = theme;
    const doc = scene.doc;
    const P = (k) => resolveValue(doc, src[k], theme);
    this.enabled = P('enabled') !== false;
    this.abs = src.layoutPosition === 'absolute';
    const isFrame = this.type === 'frame';
    const layout = isFrame ? src.layout ?? 'horizontal' : 'none';
    this.dir = layout === 'vertical' ? V : layout === 'horizontal' ? H : null;
    const dflt = isFrame ? [FIT, 0] : [FIXED, 0];
    const sw = parseSize(P('width'), dflt), sh = parseSize(P('height'), dflt);
    this.sizing = [sw[0], sh[0]];
    this.w = sw[1]; this.h = sh[1];
    if (this.type === 'icon' && src.width == null) this.w = this.h = 24;
    this.x = Number(P('x')) || 0; this.y = Number(P('y')) || 0;
    this.rot = Number(P('rotation')) || 0;
    this.flipX = !!P('flipX'); this.flipY = !!P('flipY');
    this.gap = Number(P('gap')) || 0;
    this.pad = padding(Array.isArray(src.padding) ? src.padding.map((p) => resolveValue(doc, p, theme)) : P('padding'));
    this.justify = JUSTIFY[src.justifyContent] ?? 0;
    this.align = ALIGN[src.alignItems] ?? 0;
    this.clip = !!P('clip');
    this.opacity = src.opacity == null ? 1 : Number(P('opacity'));
    this.children = (src.children ?? []).map((c) => new Node(c, this, scene, theme));
    const effects = [].concat(src.effect ?? []).filter((e) => e && resolveValue(doc, e.enabled, theme) !== false);
    const ownPad = effects.reduce((pad, e) => Math.max(pad, effectPadding(e, (v) => resolveValue(doc, v, theme))), 0);
    this.drawPad = Math.max(64, ...this.children.map((c) => c.drawPad)) + ownPad;
    scene.byId.set(this.id, this);
  }
  P(k) { return resolveValue(this.scene.doc, this.src[k], this.theme); }
  affects() { return this.enabled && !this.abs; }
  // ---- text
  textKey() {
    if (this._textKey) return this._textKey;
    const P = (k) => this.P(k), s = this.src;
    const style = this.textStyle ??= {
      family: P('fontFamily') || 'Inter', size: Number(P('fontSize')) || 14, weight: weightOf(P('fontWeight')),
      italic: P('fontStyle') === 'italic', lh: Number(P('lineHeight')) || 0, ls: Number(P('letterSpacing')) || 0,
      align: s.textAlign ?? 'left', under: !!P('underline'), strike: !!P('strikethrough'),
      color: solidFill(s.fill, (v) => resolveValue(this.scene.doc, v, this.theme)) ?? '#000000',
      content: Array.isArray(s.content) ? s.content : String(P('content') ?? ''), // spans: [{ content, ...style }]
      ps: Number(P('paragraphSpacing')) || 0, // Pena's (from Figma): space between paragraphs
    };
    return this._textKey = JSON.stringify(style);
  }
  para() {
    const key = this.textKey();
    let p = lruGet(paraCache, key);
    if (p) return p;
    p = buildParagraph(this.textStyle);
    lruSet(paraCache, key, p, PARA_MAX, (old) => old.delete());
    return p;
  }
  // [w, h] of the text box for a wrap width (Infinity = auto growth)
  measure(width) {
    if (this.measureVersion !== fonts.version) { this.measureVersion = fonts.version; this.measurements = new Map(); }
    const measured = lruGet(this.measurements, width);
    if (measured) return measured;
    const key = this.textKey() + '|' + width;
    let m = lruGet(measureCache, key);
    if (!m) {
      const p = this.para();
      if (width === Infinity) { layoutParagraph(p, 1e9); const w = Math.ceil(p.getMaxIntrinsicWidth()); m = [w, Math.ceil(p.getHeight())]; }
      else { layoutParagraph(p, Math.ceil(width)); m = [width, Math.ceil(p.getHeight())]; }
      lruSet(measureCache, key, m, MEASURE_MAX);
    }
    lruSet(this.measurements, width, m, 3);
    return m;
  }
  dims() {
    if (this.type === 'text') {
      const g = this.src.textGrowth ?? 'auto';
      if (g === 'auto') return this.measure(Infinity);
      if (g === 'fixed-width') return [this.w, this.measure(this.w)[1]];
    }
    if (this.type === 'note' || this.type === 'prompt' || this.type === 'context') {
      const m = this.measure(Math.max(1, this.w - 32));
      return [this.w, Math.max(this.h, m[1] + 28)];
    }
    return [this.w, this.h];
  }
  // axis-aligned size of the rotated box, and the offset of its top-left from the node origin
  outer() {
    const [w, h] = this.dims();
    if (!this.rot) return [w, h, 0, 0];
    const a = (-this.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const xs = [0, w * c, -h * s, w * c - h * s], ys = [0, w * s, h * c, w * s + h * c];
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    return [Math.max(...xs) - x0, Math.max(...ys) - y0, x0, y0];
  }
  // local-space box of this node and everything drawn by its subtree (cached until the next layout)
  extent() {
    if (this._ext) return this._ext;
    const [w, h] = this.dims();
    const e = [0, 0, w, h];
    if (!this.clip) for (const c of this.children) {
      if (!c.enabled) continue;
      const ce = c.extent(), o = c.rot ? c.outer() : null;
      if (o) { e[0] = Math.min(e[0], c.x + o[2]); e[1] = Math.min(e[1], c.y + o[3]); e[2] = Math.max(e[2], c.x + o[2] + o[0]); e[3] = Math.max(e[3], c.y + o[3] + o[1]); continue; }
      e[0] = Math.min(e[0], c.x + ce[0]); e[1] = Math.min(e[1], c.y + ce[1]); e[2] = Math.max(e[2], c.x + ce[2]); e[3] = Math.max(e[3], c.y + ce[3]);
    }
    return (this._ext = e);
  }
  // world rect [x0, y0, x1, y1] of a root's drawing, with room for shadows/strokes (roots only)
  extentWorld() { const e = this.extent(), p = 64; return [this.x + e[0] - p, this.y + e[1] - p, this.x + e[2] + p, this.y + e[3] + p]; }
  commitSize(ax, v) { if (ax === H) this.w = v; else this.h = v; }
  commitPosition(px, py) { const o = this.outer(); this.x = px - o[2]; this.y = py - o[3]; }
  // local 3x3 matrix (row-major): translate, rotate around the top-left, flips around the center
  matrix() {
    if (!this.rot && !this.flipX && !this.flipY) return [1, 0, this.x, 0, 1, this.y, 0, 0, 1];
    const [w, h] = this.dims();
    let m = CK().Matrix.translated(this.x, this.y);
    if (this.rot) m = CK().Matrix.multiply(m, CK().Matrix.rotated((-this.rot * Math.PI) / 180));
    if (this.flipX || this.flipY) m = CK().Matrix.multiply(m, CK().Matrix.scaled(this.flipX ? -1 : 1, this.flipY ? -1 : 1, w / 2, h / 2));
    return m;
  }
  worldMatrix() {
    const m = this.matrix();
    return this.parent ? CK().Matrix.multiply(this.parent.worldMatrix(), m) : m;
  }
  // world-space axis-aligned bounds
  bounds() {
    const [w, h] = this.dims(), m = this.worldMatrix();
    const pts = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
}

function solidFill(fill, V) {
  for (const x of [].concat(fill ?? []).reverse()) {
    if (typeof x === 'string') return V(x);
    if (x?.type === 'color' && V(x.enabled) !== false) return V(x.color);
    if (x?.type === 'gradient') return V(x.colors?.[0]?.color);
  }
}

// ---------------------------------------------------------------- text (pen.dev's mapping, see lrn in its bundle)
const ALIGNS = { left: 'Left', center: 'Center', right: 'Right', justify: 'Justify' };
// Paragraph spacing: Skia has none, so one paragraph per line break, stacked with the gap. Same calls as a Paragraph.
class ParagraphStack {
  constructor(parts, gap) { this.parts = parts; this.gap = gap; }
  layout(w) { for (const p of this.parts) p.layout(w); }
  getHeight() { return this.parts.reduce((h, p) => h + p.getHeight(), 0) + this.gap * (this.parts.length - 1); }
  getMaxIntrinsicWidth() { return Math.max(...this.parts.map((p) => p.getMaxIntrinsicWidth())); }
  unresolvedCodepoints() { return this.parts.flatMap((p) => [...p.unresolvedCodepoints()]); }
  draw(canvas, x, y) { for (const p of this.parts) canvas.drawParagraph(p, x, y), (y += p.getHeight() + this.gap); }
  delete() { this.parts.forEach((p) => p.delete()); }
}
const drawPara = (canvas, p, x, y) => (p instanceof ParagraphStack ? p.draw(canvas, x, y) : canvas.drawParagraph(p, x, y));
// split text (string or spans) at line breaks
function paragraphs(content) {
  if (!Array.isArray(content)) return content.split('\n');
  const out = [[]];
  for (const sp of content) String(sp.content ?? '').split('\n').forEach((piece, i) => { if (i) out.push([]); if (piece) out.at(-1).push({ ...sp, content: piece }); });
  return out;
}
function buildParagraph(t) {
  const ck = CK();
  if (t.ps && paragraphs(t.content).length > 1) return new ParagraphStack(paragraphs(t.content).map((c) => buildParagraph({ ...t, ps: 0, content: c })), t.ps);
  const families = [fonts.alias(t.family, t.weight, t.italic) ?? t.family, fonts.alias('Inter', t.weight, false), fonts.alias('Noto Color Emoji')].filter(Boolean);
  const lh = t.lh ? Math.round(t.lh * t.size) / t.size : undefined;
  const textStyle = {
    color: color(t.color) ?? ck.BLACK, fontFamilies: families, fontSize: t.size,
    fontStyle: { weight: { value: t.weight }, slant: t.italic ? ck.FontSlant.Italic : ck.FontSlant.Upright },
    fontVariations: [{ axis: 'wght', value: t.weight }], letterSpacing: t.ls,
    ...(lh && { heightMultiplier: lh, halfLeading: true }),
    decoration: (t.under ? ck.UnderlineDecoration : 0) | (t.strike ? ck.LineThroughDecoration : 0),
  };
  // spans with their own size/line height: each line is as tall as its tallest run (Figma), so no forced strut
  const mixed = Array.isArray(t.content) && t.content.some((sp) => sp.fontSize != null || sp.lineHeight != null);
  const style = new ck.ParagraphStyle({
    textStyle, textAlign: ck.TextAlign[ALIGNS[t.align] ?? 'Left'], applyRoundingHack: false, replaceTabCharacters: true,
    ...(lh && !mixed && { strutStyle: { strutEnabled: true, forceStrutHeight: true, fontFamilies: families.slice(0, 1), fontSize: t.size, heightMultiplier: lh, halfLeading: true } }),
  });
  fonts.ensure(t.family, t.weight, t.italic);
  fonts.ensure('Inter', t.weight, false);
  const b = ck.ParagraphBuilder.MakeFromFontCollection(style, fonts.collection);
  if (!Array.isArray(t.content)) b.addText(t.content);
  else for (const sp of t.content) { // styled spans: each overrides the text's own style (and color: `fill`, Pena's)
    const family = sp.fontFamily ?? t.family, weight = sp.fontWeight != null ? weightOf(sp.fontWeight) : t.weight, italic = sp.fontStyle ? sp.fontStyle === 'italic' : t.italic;
    if (family !== t.family || weight !== t.weight || italic !== t.italic) fonts.ensure(family, weight, italic);
    const under = sp.underline ?? t.under, strike = sp.strikethrough ?? t.strike;
    const size = Number(sp.fontSize) || t.size, spLh = sp.lineHeight != null ? Number(sp.lineHeight) : t.lh;
    b.pushStyle(new ck.TextStyle({
      ...textStyle, fontFamilies: [fonts.alias(family, weight, italic) ?? family, ...families.slice(1)], fontSize: size,
      ...(spLh && { heightMultiplier: Math.round(spLh * size) / size, halfLeading: true }),
      color: color(solidFill(sp.fill, (v) => v)) ?? textStyle.color, letterSpacing: sp.letterSpacing ?? t.ls,
      fontStyle: { weight: { value: weight }, slant: italic ? ck.FontSlant.Italic : ck.FontSlant.Upright }, fontVariations: [{ axis: 'wght', value: weight }],
      decoration: (under ? ck.UnderlineDecoration : 0) | (strike ? ck.LineThroughDecoration : 0),
    }));
    b.addText(String(sp.content ?? ''));
    b.pop();
  }
  const p = b.build();
  b.delete();
  p.layout(1e9);
  if (p.unresolvedCodepoints().length) fonts.ensure('Noto Color Emoji');
  return p;
}

// ---------------------------------------------------------------- layout (pen.dev's solver, 5 passes)
function fit(n, ax) {
  for (const c of n.children) fit(c, ax);
  if (n.type === 'group') { // a group hugs its children
    let max = 0;
    for (const c of n.children) if (c.enabled) { const o = c.outer(); max = Math.max(max, (ax === H ? c.x + o[2] : c.y + o[3]) + o[ax]); }
    n.commitSize(ax, max);
    return;
  }
  if (n.dir == null || n.sizing[ax] !== FIT) return;
  let sum = 0, cnt = 0;
  for (const c of n.children) {
    if (!c.affects() || c.sizing[ax] === FILL) continue;
    cnt++;
    const s = c.outer()[ax];
    sum = n.dir === ax ? sum + s : Math.max(sum, s);
  }
  if (!cnt) return;
  if (n.dir === ax) sum += n.gap * (cnt - 1);
  n.commitSize(ax, sum + (ax === H ? n.pad[1] + n.pad[3] : n.pad[0] + n.pad[2]));
}
function fill(n, ax) {
  if (n.dir != null) {
    const [w, h] = n.dims();
    const inner = [w - n.pad[3] - n.pad[1], h - n.pad[0] - n.pad[2]];
    let size;
    if (n.dir === ax) {
      let k = 0, nFill = 0;
      for (const c of n.children) if (c.affects()) { k++; if (c.sizing[ax] === FILL) nFill++; else inner[ax] -= c.outer()[ax]; }
      inner[ax] -= Math.max(0, k - 1) * n.gap;
      size = nFill ? inner[ax] / nFill : 0;
    } else size = inner[ax];
    size = Math.max(1, size);
    for (const c of n.children) if (c.affects() && c.sizing[ax] === FILL) c.commitSize(ax, size);
  } else if (!n.parent || n.parent.dir == null) {
    // fill_container outside a layout keeps its fallback size (pen.dev: hasFixedSize)
  }
  for (const c of n.children) fill(c, ax);
}
function place(n) {
  const kids = n.children;
  if (n.dir != null && kids.length) {
    const m = n.dir, x = m === V ? H : V;
    const [w, h] = n.dims();
    const inner = [w - n.pad[3] - n.pad[1], h - n.pad[0] - n.pad[2]];
    const cur = [n.pad[3], n.pad[0]], free = [...inner];
    let k = 0;
    for (const c of kids) if (c.affects()) { k++; const o = c.outer(); free[0] -= o[0]; free[1] -= o[1]; }
    let gap = n.gap;
    if (k > 0) switch (n.justify) {
      case 4: cur[m] += free[m] - n.gap * (k - 1); break;
      case 1: cur[m] += (free[m] - n.gap * (k - 1)) / 2; break;
      case 2: gap = k > 1 ? free[m] / (k - 1) : 0; break;
      case 3: gap = free[m] / k; cur[m] += gap / 2; break;
    }
    for (const c of kids) if (c.affects()) {
      const p = [...cur], o = c.outer();
      if (n.align === 2) p[x] += inner[x] - o[x];
      else if (n.align === 1) p[x] += (inner[x] - o[x]) / 2;
      c.commitPosition(p[0], p[1]);
      cur[m] += o[m] + gap;
    }
  }
  for (const c of kids) place(c);
}
const clearExtents = (n) => { n._ext = null; n.children.forEach(clearExtents); };
export function layoutRoot(n) { fit(n, H); fill(n, H); fit(n, V); fill(n, V); place(n); clearExtents(n); }

// ---------------------------------------------------------------- drawing
const P_ = {}; // reusable paints
function paints() {
  if (P_.fill) return P_;
  const ck = CK();
  P_.fill = new ck.Paint(); P_.fill.setAntiAlias(true);
  P_.stroke = new ck.Paint(); P_.stroke.setAntiAlias(true); P_.stroke.setStyle(ck.PaintStyle.Stroke);
  P_.img = new ck.Paint(); P_.img.setAntiAlias(true);
  P_.layer = new ck.Paint();
  return P_;
}
const radii = (n, w, h) => {
  const r = n.src.cornerRadius;
  if (r == null) return null;
  const a = [].concat(n.P('cornerRadius')).map((v) => Number(resolveValue(n.scene.doc, v, n.theme)) || 0);
  const [tl, tr = tl, br = tl, bl = tr] = a.length === 2 ? [a[0], a[1], a[0], a[1]] : a;
  const max = Math.min(w, h) / 2;
  return [tl, tr, br, bl].map((v) => Math.min(v, max));
};
const rrect = (x, y, w, h, r) => {
  const ck = CK();
  if (!r || r.every((v) => !v)) return ck.XYWHRect(x, y, w, h);
  return Float32Array.of(x, y, x + w, y + h, r[0], r[0], r[1], r[1], r[2], r[2], r[3], r[3]);
};
const inset = (rr, d) => {
  const out = Float32Array.from(rr);
  out[0] += d; out[1] += d; out[2] -= d; out[3] -= d;
  for (let i = 4; i < out.length; i++) out[i] = Math.max(0, out[i] - d);
  return out;
};

function shapePath(n, w, h) {
  const ck = CK();
  const P = (k) => n.P(k);
  if (n.type === 'ellipse') {
    const vector = (P('innerRadius') ?? 0) > 0 || Math.abs(P('sweepAngle') ?? 360) < 360;
    if (!vector) return { oval: ck.XYWHRect(0, 0, w, h) };
  }
  let d, vb;
  if (n.type === 'path') { d = n.src.geometry ?? ''; vb = n.src.viewBox; }
  else if (n.type === 'polygon') { d = polygon(P('polygonCount') ?? 3); vb = [0, 0, 100, 100]; }
  else if (n.type === 'ellipse') { d = arc(P('innerRadius') ?? 0, P('startAngle') ?? 0, P('sweepAngle') ?? 360); vb = [0, 0, 100, 100]; }
  else if (n.type === 'line') return { line: true };
  const base = svgPath(d);
  if (!base) return null;
  if (!vb) { const b = base.getBounds(); vb = [b[0], b[1], (b[2] - b[0]) || 1, (b[3] - b[1]) || 1]; }
  const pb = new ck.PathBuilder(base);
  pb.transform(ck.Matrix.multiply(ck.Matrix.scaled(w / (vb[2] || 1), h / (vb[3] || 1)), ck.Matrix.translated(-vb[0], -vb[1])));
  if (n.src.fillRule === 'evenodd') pb.setFillType(ck.FillType.EvenOdd);
  return { path: pb.detachAndDelete() };
}

function setFillPaint(paint, f, n, w, h, alpha) {
  const ck = CK(), V = (v) => resolveValue(n.scene.doc, v, n.theme);
  paint.setShader(null);
  if (typeof f === 'string') { const c = color(V(f), alpha); if (!c) return false; paint.setColor(c); return true; }
  if (!f || V(f.enabled) === false) return false;
  const a = alpha * (f.opacity == null ? 1 : Number(V(f.opacity)));
  if (f.type === 'color') { const c = color(V(f.color), a); if (!c) return false; paint.setColor(c); return true; }
  if (f.type === 'gradient' || f.type === 'mesh_gradient') {
    const stops = f.type === 'mesh_gradient' ? (f.colors ?? []).map((c, i, all) => ({ color: c, position: i / Math.max(1, all.length - 1) })) : f.colors ?? [];
    if (!stops.length) return false;
    const cols = stops.map((s) => color(V(s.color), a) ?? ck.TRANSPARENT), pos = stops.map((s) => Number(V(s.position)) || 0);
    const cx = (f.center?.x ?? 0.5) * w, cy = (f.center?.y ?? 0.5) * h, rot = f.type === 'mesh_gradient' ? 225 : Number(V(f.rotation)) || 0;
    let sh;
    if (f.gradientType === 'radial') {
      const rx = Math.max(f.center?.x ?? 0.5, 1 - (f.center?.x ?? 0.5)) * w * Math.SQRT2, ry = Math.max(f.center?.y ?? 0.5, 1 - (f.center?.y ?? 0.5)) * h * Math.SQRT2;
      sh = ck.Shader.MakeRadialGradient([0, 0], 1, cols, pos, ck.TileMode.Clamp, ck.Matrix.multiply(ck.Matrix.translated(cx, cy), ck.Matrix.scaled(rx || 1, ry || 1)));
    } else if (f.gradientType === 'angular') {
      sh = ck.Shader.MakeSweepGradient(cx, cy, cols, pos, ck.TileMode.Clamp, ck.Matrix.rotated(((-rot - 90) * Math.PI) / 180, cx, cy));
    } else {
      const ang = (((360 - rot) % 360) * Math.PI) / 180, dx = Math.sin(ang), dy = -Math.cos(ang);
      const len = Math.abs(w * dx) + Math.abs(h * dy);
      sh = ck.Shader.MakeLinearGradient([w / 2 - (dx * len) / 2, h / 2 - (dy * len) / 2], [w / 2 + (dx * len) / 2, h / 2 + (dy * len) / 2], cols, pos, ck.TileMode.Clamp);
    }
    paint.setColor(ck.BLACK);
    paint.setShader(sh);
    sh.delete(); // the paint keeps its own reference
    return true;
  }
  return false;
}

// paint blend modes (.pen names → Skia; linear burn/dodge have no Skia mode: closest ones)
const BLENDS = { darken: 'Darken', multiply: 'Multiply', linearBurn: 'Multiply', colorBurn: 'ColorBurn', light: 'Lighten', screen: 'Screen', linearDodge: 'Plus',
  colorDodge: 'ColorDodge', overlay: 'Overlay', softLight: 'SoftLight', hardLight: 'HardLight', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue',
  saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity' };
const blendOf = (f) => CK().BlendMode[BLENDS[f?.blendMode] ?? 'SrcOver'];
// Image adjustments (Pena's `adjust`, from Figma's image filters, -1..1) as one color matrix. Calibrated against
// Figma's own renders; highlights/shadows (tonal curves) are not a matrix and are left out.
function adjustMatrix({ exposure = 0, contrast = 0, saturation = 0, temperature = 0, tint = 0 }) {
  const e = 2 ** (exposure * 1.5), c = 1 + contrast * (contrast > 0 ? 1 : 0.5), s = 1 + saturation;
  const lr = 0.2126 * (1 - s), lg = 0.7152 * (1 - s), lb = 0.0722 * (1 - s);
  const sat = [lr + s, lg, lb, lr, lg + s, lb, lr, lg, lb + s];
  const k = e * c, off = 0.5 * (1 - c), wr = 1 + temperature * 0.1, wb = 1 - temperature * 0.1, wg = 1 - tint * 0.1;
  const rows = [wr, wg, wb];
  const m = [];
  for (let r = 0; r < 3; r++) m.push(sat[r * 3] * k * rows[r], sat[r * 3 + 1] * k * rows[r], sat[r * 3 + 2] * k * rows[r], 0, off);
  m.push(0, 0, 0, 1, 0);
  return m;
}

function drawFills(canvas, n, geo, w, h) {
  const ck = CK(), { fill: paint, img: ip } = paints();
  for (const f of [].concat(n.src.fill ?? [])) {
    paint.setBlendMode(blendOf(f));
    if (f && typeof f === 'object' && f.type === 'image') {
      if (resolveValue(n.scene.doc, f.enabled, n.theme) === false || !f.url) continue;
      const img = image(n.scene.assetUrl(f.url), n.assetReady);
      if (!img) { paint.setShader(null); paint.setColor(Float32Array.of(0.5, 0.5, 0.5, 0.15)); drawGeo(canvas, geo, paint); continue; }
      const iw = img.width(), ih = img.height();
      const mode = f.mode ?? 'fill';
      let dw = w, dh = h;
      if (mode !== 'stretch') { const s = (mode === 'fit' || mode === 'contain' ? Math.min : Math.max)(w / iw, h / ih); dw = iw * s; dh = ih * s; }
      canvas.save();
      clipGeo(canvas, geo);
      ip.setAlphaf(f.opacity == null ? 1 : Number(f.opacity));
      ip.setBlendMode(blendOf(f));
      const cf = f.adjust && ck.ColorFilter.MakeMatrix(adjustMatrix(f.adjust));
      ip.setColorFilter(cf || null);
      // stretch + transform [a b c d tx ty]: maps the image's unit square into the layer's (crops; Figma imports)
      const t = mode === 'stretch' && Array.isArray(f.transform) && f.transform.length === 6 && f.transform;
      if (t) canvas.concat(ck.Matrix.multiply(ck.Matrix.scaled(w, h), [t[0], t[2], t[4], t[1], t[3], t[5], 0, 0, 1]));
      const dst = t ? ck.XYWHRect(0, 0, 1, 1) : ck.XYWHRect((w - dw) / 2, (h - dh) / 2, dw, dh);
      canvas.drawImageRectOptions(img, ck.XYWHRect(0, 0, iw, ih), dst, ck.FilterMode.Linear, ck.MipmapMode.None, ip);
      if (cf) ip.setColorFilter(null), cf.delete();
      ip.setBlendMode(ck.BlendMode.SrcOver);
      canvas.restore();
      continue;
    }
    if (setFillPaint(paint, f, n, w, h, 1)) drawGeo(canvas, geo, paint);
  }
  paint.setBlendMode(ck.BlendMode.SrcOver);
  paint.setShader(null);
}
const ovalPath = (r) => { const pb = new (CK().PathBuilder)(); pb.addOval(r); return pb.detachAndDelete(); };
function drawGeo(canvas, geo, paint) {
  if (geo.rect) geo.rect.length === 4 ? canvas.drawRect(geo.rect, paint) : canvas.drawRRect(geo.rect, paint);
  else if (geo.oval) canvas.drawOval(geo.oval, paint);
  else if (geo.path) canvas.drawPath(geo.path, paint);
}
function clipGeo(canvas, geo) {
  const ck = CK();
  if (geo.rect) geo.rect.length === 4 ? canvas.clipRect(geo.rect, ck.ClipOp.Intersect, true) : canvas.clipRRect(geo.rect, ck.ClipOp.Intersect, true);
  else if (geo.oval) { const p = ovalPath(geo.oval); canvas.clipPath(p, ck.ClipOp.Intersect, true); p.delete(); }
  else if (geo.path) canvas.clipPath(geo.path, ck.ClipOp.Intersect, true);
}

function drawStroke(canvas, n, geo, w, h) {
  const ck = CK(), V = (v) => resolveValue(n.scene.doc, v, n.theme);
  const col = color(solidFill(n.src.stroke, V));
  if (!col || !geo) return;
  const paint = paints().stroke;
  paint.setColor(col);
  const sw = n.src.strokeWidth;
  if (sw && typeof sw === 'object') { // per-side widths: inner bands, clipped to the shape
    const t = Number(V(sw.top)) || 0, r = Number(V(sw.right)) || 0, b = Number(V(sw.bottom)) || 0, l = Number(V(sw.left)) || 0;
    const fp = paints().fill;
    fp.setShader(null); fp.setColor(col);
    canvas.save(); clipGeo(canvas, geo);
    if (t) canvas.drawRect(ck.XYWHRect(0, 0, w, t), fp);
    if (b) canvas.drawRect(ck.XYWHRect(0, h - b, w, b), fp);
    if (l) canvas.drawRect(ck.XYWHRect(0, 0, l, h), fp);
    if (r) canvas.drawRect(ck.XYWHRect(w - r, 0, r, h), fp);
    canvas.restore();
    return;
  }
  const width = Number(V(sw ?? 1)) || 0;
  if (!width) return;
  paint.setStrokeWidth(width);
  paint.setStrokeCap(ck.StrokeCap[{ round: 'Round', square: 'Square' }[n.src.strokeLinecap] ?? 'Butt']);
  paint.setStrokeJoin(ck.StrokeJoin[{ round: 'Round', bevel: 'Bevel' }[n.src.strokeLinejoin] ?? 'Miter']);
  const align = geo.line || n.type === 'path' || n.type === 'line' ? 'center' : n.src.strokeAlignment ?? 'inner';
  if (geo.line) { canvas.drawLine(0, 0, w, h, paint); return; }
  if (geo.rect && align !== 'center') { canvas.drawRRect(inset(geo.rect.length === 4 ? rrect(0, 0, w, h, [0, 0, 0, 0]) : geo.rect, align === 'inner' ? width / 2 : -width / 2), paint); return; }
  if (align === 'center') { drawGeo(canvas, geo, paint); return; }
  // inner/outer on arbitrary shapes: double-width stroke clipped to inside/outside
  paint.setStrokeWidth(width * 2);
  canvas.save();
  const p = geo.path ?? ovalPath(geo.oval);
  canvas.clipPath(p, align === 'inner' ? ck.ClipOp.Intersect : ck.ClipOp.Difference, true);
  canvas.drawPath(p, paint);
  canvas.restore();
  if (!geo.path) p.delete();
}

function shadows(n, kind) {
  const V = (v) => resolveValue(n.scene.doc, v, n.theme);
  return [].concat(n.src.effect ?? []).filter((e) => e && V(e.enabled) !== false && e.type === 'shadow' && (e.shadowType === 'inner') === (kind === 'inner'))
    .map((e) => ({ x: Number(V(e.offset?.x)) || 0, y: Number(V(e.offset?.y)) || 0, blur: Number(V(e.blur)) || 0, spread: Number(V(e.spread)) || 0, color: color(V(e.color) ?? '#00000040') }));
}
const blurPaint = (s) => {
  const ck = CK(), p = paints().fill;
  p.setShader(null); p.setColor(s.color);
  p.setMaskFilter(s.blur > 0 ? ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, s.blur / 2, true) : null);
  return p;
};
const hasFill = (n) => [].concat(n.src.fill ?? []).some((f) => f && (typeof f === 'string' || resolveValue(n.scene.doc, f.enabled, n.theme) !== false));
const contentShadow = (n) => (n.type === 'group' || (n.type === 'frame' && !hasFill(n) && n.children.length)) && shadows(n, 'outer').some((s) => s.color);
function drawOuterShadows(canvas, n, geo) {
  if (contentShadow(n)) return; // drawn as a layer filter in drawNode
  for (const s of shadows(n, 'outer')) {
    if (!s.color) continue;
    const p = blurPaint(s);
    canvas.save();
    canvas.translate(s.x, s.y);
    if (geo.rect) canvas.drawRRect(inset(geo.rect.length === 4 ? rrect(geo.rect[0], geo.rect[1], geo.rect[2] - geo.rect[0], geo.rect[3] - geo.rect[1], [0, 0, 0, 0]) : geo.rect, -s.spread), p);
    else drawGeo(canvas, geo, p);
    canvas.restore();
    p.setMaskFilter(null);
  }
}
function drawInnerShadows(canvas, n, geo, w, h) {
  const list = shadows(n, 'inner');
  if (!list.length || !geo.rect) return;
  const ck = CK();
  const base = geo.rect.length === 4 ? rrect(0, 0, w, h, [0, 0, 0, 0]) : geo.rect;
  for (const s of list) {
    if (!s.color) continue;
    const p = blurPaint(s);
    canvas.save();
    clipGeo(canvas, geo);
    const hole = inset(base, s.spread);
    hole[0] += s.x; hole[2] += s.x; hole[1] += s.y; hole[3] += s.y;
    const big = s.blur * 2 + Math.abs(s.x) + Math.abs(s.y) + 10;
    canvas.drawDRRect(Float32Array.of(-big, -big, w + big, h + big, 0, 0, 0, 0, 0, 0, 0, 0), hole, p);
    canvas.restore();
    p.setMaskFilter(null);
  }
  void ck;
}

const NOTE_LOOK = { note: ['#FFF4B3', '#5C4A00'], prompt: ['#EDE7FF', '#3B1F8F'], context: ['#E8EEF5', '#22324A'] };

// ---------------------------------------------------------------- scene
export class Scene {
  constructor(doc, { theme = {}, assetUrl = (u) => u, onChange = () => {} } = {}) {
    this.doc = doc; this.themeOverride = theme; this.assetUrl = assetUrl;
    this.byId = new Map(); this.roots = []; this.hidden = new Set();
    // Coalesce arrivals, invalidating only roots that requested the asset.
    const pendingRoots = new Set();
    let at = 0;
    this.assetReady = (id) => {
      pendingRoots.add(id);
      clearTimeout(at);
      at = setTimeout(() => { for (const root of pendingRoots) this.touch(root); pendingRoots.clear(); onChange(); }, 120);
    };
    // fonts arrive one by one: coalesce them into one re-measure + layout
    let t = 0;
    fonts.listeners.add(() => {
      clearTimeout(t);
      t = setTimeout(() => { if (fontVersion !== fonts.version) { this.relayoutAll(); this.onLayout?.(); onChange(); } }, 60);
    });
  }
  baseTheme() { return { ...themeDefaults(this.doc), ...this.themeOverride }; }
  build(expandedRoots, { layout = true } = {}) {
    this.touch();
    this.version = (this.version ?? 0) + 1;
    this.byId.clear();
    this.roots = expandedRoots.map((r) => new Node(r, null, this, this.baseTheme()));
    if (layout) this.relayoutAll();
  }
  // replace the given roots (by id) with freshly expanded versions; `order` is the full expanded list
  rebuild(expandedRoots, ids) {
    this.version = (this.version ?? 0) + 1;
    const old = new Map(this.roots.map((r) => [r.id, r]));
    const forget = (n) => { this.byId.delete(n.id); n.children.forEach(forget); };
    for (const id of ids) if (old.has(id)) { this.touch(id); forget(old.get(id)); }
    this.roots = expandedRoots.map((r) => {
      if (!ids.has(r.id) && old.has(r.id)) return old.get(r.id);
      const n = new Node(r, null, this, this.baseTheme());
      layoutRoot(n);
      return n;
    });
  }
  relayoutAll() {
    if (fontVersion !== fonts.version) { fontVersion = fonts.version; resetTextCaches(); }
    this.touch();
    for (const r of this.roots) layoutRoot(r);
  }
  // every font the document needs (to load before the first layout)
  fontsNeeded(rootIds = null) {
    const out = new Set();
    const visit = (n) => { if (n.type === 'text' || NOTE_LOOK[n.type]) { n.textKey(); const t = n.textStyle; out.add(JSON.stringify([t.family, t.weight, t.italic])); } };
    if (rootIds) { const walk = (n) => { visit(n); n.children.forEach(walk); }; for (const id of rootIds) { const r = this.byId.get(id); if (r) walk(r); } }
    else for (const n of this.byId.values()) visit(n);
    return [...out].map((s) => JSON.parse(s));
  }

  // ---- drawing
  // Each root is recorded once into an SkPicture (per zoom octave: icon resolution and sub-pixel culling depend on
  // zoom) and replayed afterwards, so re-rendering after a pan/zoom/edit only re-records the roots that changed.
  draw(canvas, cull, zoom, { partial = false, interactive = false, budgetMs = Infinity } = {}) {
    paints();
    const ck = CK(), octave = 2 ** Math.round(Math.log2(zoom));
    let remainingMs = budgetMs;
    let pending = false;
    for (const r of this.roots) {
      if (!r.enabled) continue;
      const e = r.extent(), pad = r.drawPad;
      if (r.x + e[2] + pad < cull[0] || r.y + e[3] + pad < cull[1] || r.x + e[0] - pad > cull[2] || r.y + e[1] - pad > cull[3]) {
        if (!partial && !interactive) this.touch(r.id); // keep recordings for the duration of a zoom gesture
        continue;
      }
      // Keep the current detail and tile grid during zoom; refine once the gesture ends.
      const reuse = interactive || (remainingMs <= 0 && (r._pic || r._tiles?.size));
      const previewDetail = interactive && zoom < 0.125 ? Math.min(octave, 1 / 64) : octave;
      const detail = reuse && r._picZoom ? r._picZoom : previewDetail;
      if (!interactive && detail !== octave) pending = true;
      if (Math.max(e[2] - e[0], e[3] - e[1]) * detail > 4096 && !r.rot) {
        r._pic?.delete(); r._pic = null;
        if (r._picZoom !== detail) this.touch(r.id);
        r._picZoom = detail;
        const tiles = r._tiles ??= new Map(), used = new Set(), size = 1024 / detail;
        const area = [Math.max(e[0] - pad, cull[0] - r.x), Math.max(e[1] - pad, cull[1] - r.y), Math.min(e[2] + pad, cull[2] - r.x), Math.min(e[3] + pad, cull[3] - r.y)];
        canvas.save(); canvas.translate(r.x, r.y);
        for (let y = Math.floor(area[1] / size); y < Math.ceil(area[3] / size); y++) {
          for (let x = Math.floor(area[0] / size); x < Math.ceil(area[2] / size); x++) {
            const key = `${x},${y}`, box = [x * size, y * size, (x + 1) * size, (y + 1) * size];
            used.add(key);
            let pic = tiles.get(key);
            if (!pic) {
              const start = performance.now();
              const rec = new ck.PictureRecorder(), c = rec.beginRecording(ck.LTRBRect(box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad));
              c.translate(-r.x, -r.y);
              this.drawNode(c, r, [box[0] + r.x - pad, box[1] + r.y - pad, box[2] + r.x + pad, box[3] + r.y + pad], detail, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
              pic = rec.finishRecordingAsPicture(); rec.delete(); tiles.set(key, pic);
              remainingMs -= performance.now() - start;
            }
            canvas.save(); canvas.clipRect(ck.LTRBRect(...box), ck.ClipOp.Intersect, false);
            canvas.drawPicture(pic); canvas.restore();
          }
        }
        canvas.restore();
        if (!partial && !interactive) for (const [key, pic] of tiles) if (!used.has(key)) { pic.delete(); tiles.delete(key); }
        continue;
      }
      if (r._tiles?.size) this.touch(r.id);
      if (!r._pic || r._picZoom !== detail) {
        const start = performance.now();
        r._pic?.delete();
        const rec = new ck.PictureRecorder();
        // recorded relative to the root's position, so moving a root keeps its recording
        const c = rec.beginRecording(ck.LTRBRect(e[0] - 4096, e[1] - 4096, e[2] + 4096, e[3] + 4096));
        c.translate(-r.x, -r.y);
        this.drawNode(c, r, [-1e9, -1e9, 1e9, 1e9], detail, [1, 0, 0, 0, 1, 0, 0, 0, 1]);
        r._pic = rec.finishRecordingAsPicture();
        r._picZoom = detail;
        rec.delete();
        remainingMs -= performance.now() - start;
      }
      canvas.save();
      canvas.translate(r.x, r.y);
      canvas.drawPicture(r._pic);
      canvas.restore();
    }
    return pending;
  }
  // drop the recording of the root containing `id` (or of every root)
  touch(id) {
    const drop = (r) => { r._pic?.delete(); r._pic = null; r._tiles?.forEach((pic) => pic.delete()); r._tiles?.clear(); };
    if (id == null) return this.roots.forEach(drop);
    const n = this.byId.get(id);
    if (n) drop(this.rootOf(n));
  }
  drawNode(canvas, n, cull, zoom, pm) {
    if (!n.enabled || n.opacity <= 0) return;
    const [w, h] = n.dims();
    const lm = n.matrix();
    const m = pm[1] === 0 && pm[3] === 0 && lm[1] === 0 && lm[3] === 0
      ? [pm[0] * lm[0], 0, pm[0] * lm[2] + pm[2], 0, pm[4] * lm[4], pm[4] * lm[5] + pm[5], 0, 0, 1]
      : CK().Matrix.multiply(pm, lm);
    // cull with the world AABB of the whole subtree (+ room for shadows/strokes)
    const e = n.extent(), pad = n.drawPad;
    const cx = [e[0], e[2]].map((x) => m[0] * x), cy = [e[1], e[3]].map((y) => m[4] * y);
    let x0 = m[2] + Math.min(...cx), x1 = m[2] + Math.max(...cx), y0 = m[5] + Math.min(...cy), y1 = m[5] + Math.max(...cy);
    if (m[1] || m[3]) { const r = Math.hypot(e[2] - e[0], e[3] - e[1]); x0 = m[2] - r; x1 = m[2] + r; y0 = m[5] - r; y1 = m[5] + r; }
    if (x1 + pad < cull[0] || y1 + pad < cull[1] || x0 - pad > cull[2] || y0 - pad > cull[3]) return;
    if (Math.max(x1 - x0, y1 - y0) * zoom < 0.4) return; // sub-pixel
    const count = canvas.save();
    canvas.concat(lm);
    const effects = [].concat(n.src.effect ?? []).filter((e) => e && resolveValue(this.doc, e.enabled, n.theme) !== false);
    if (n.opacity < 1) { const p = paints().layer; p.setAlphaf(n.opacity); p.setImageFilter(null); canvas.saveLayer(p); }
    const blur = effects.find((e) => e.type === 'blur');
    if (blur) { const r = Number(resolveValue(this.doc, blur.radius, n.theme)) || 0; const p = paints().layer; p.setAlphaf(1); const f = CK().ImageFilter.MakeBlur(r / 2, r / 2, CK().TileMode.Decal, null); p.setImageFilter(f); canvas.saveLayer(p); p.setImageFilter(null); f.delete(); }
    // groups and fill-less frames: the shadow follows the drawn content (Figma), not a box. One shadow per layer.
    // ponytail: a single drop shadow; stack more layers if multi-shadow groups show up
    if (contentShadow(n)) {
      const s = shadows(n, 'outer')[0], p = paints().layer, ck = CK();
      const f = ck.ImageFilter.MakeDropShadow(s.x, s.y, s.blur / 2, s.blur / 2, s.color, null);
      p.setAlphaf(1); p.setImageFilter(f); canvas.saveLayer(p); p.setImageFilter(null); f.delete();
    }
    this.content(canvas, n, w, h, effects, cull, zoom, m);
    canvas.restoreToCount(count);
  }
  content(canvas, n, w, h, effects, cull, zoom, m) {
    const ck = CK();
    switch (n.type) {
      case 'group':
        for (const c of n.children) this.drawNode(canvas, c, cull, zoom, m);
        return;
      case 'text': {
        if (this.hidden.has(n.id)) return;
        const g = n.src.textGrowth ?? 'auto';
        n.textKey();
        const ts = n.textStyle;
        if (ts.size * zoom < 2.5) { // unreadably small: one bar per line instead of shaping text (Figma-style greeking)
          const lh = (ts.lh || 1.2) * ts.size, lines = Math.max(1, Math.round(h / lh)), p = paints().fill;
          p.setShader(null); p.setColor(color(ts.color, 0.45) ?? ck.BLACK);
          const bw = Math.min(w, n.measure(Infinity)[0]);
          for (let i = 0; i < lines; i++) canvas.drawRect(ck.XYWHRect(0, i * lh + lh * 0.25, i === lines - 1 && lines > 1 ? bw * 0.6 : bw, lh * 0.5), p);
          return;
        }
        const para = n.para();
        layoutParagraph(para, g === 'auto' ? n.measure(Infinity)[0] : Math.ceil(w));
        let dy = 0;
        if (g !== 'auto' && n.src.textAlignVertical && n.src.textAlignVertical !== 'top') {
          const free = h - para.getHeight();
          dy = n.src.textAlignVertical === 'middle' ? free / 2 : free;
        }
        const sh = shadows(n, 'outer');
        if (sh.length) {
          for (const s of sh) { canvas.save(); canvas.translate(s.x, s.y); const p = blurPaint(s); canvas.saveLayer(p); drawPara(canvas, para, -(n.textStyle.ls / 2), dy); canvas.restore(); canvas.restore(); p.setMaskFilter(null); }
        }
        drawPara(canvas, para, -(n.textStyle.ls / 2), dy);
        return;
      }
      case 'icon': {
        const V = (v) => resolveValue(this.doc, v, n.theme);
        const fillColor = solidFill(n.src.fill, V) ?? '#000000';
        const img = icon(n.P('library') ?? 'lucide', n.P('icon') ?? '', fillColor, Math.max(w, h) * zoom * devicePixelRatio, n.assetReady);
        if (img) canvas.drawImageRectOptions(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(0, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, paints().img);
        return;
      }
      case 'note': case 'prompt': case 'context': {
        const [bg] = NOTE_LOOK[n.type];
        const geo = { rect: rrect(0, 0, w, h, [10, 10, 10, 10]) };
        const p = paints().fill; p.setShader(null); p.setColor(color(bg));
        canvas.drawRRect(geo.rect, p);
        if (this.hidden.has(n.id)) return;
        const para = n.para(); layoutParagraph(para, Math.max(1, w - 32));
        canvas.drawParagraph(para, 16, 14);
        return;
      }
      default: break;
    }
    // frames, rectangles, ellipses, paths, polygons, lines, browser/script placeholders
    let geo;
    if (n.type === 'frame' || n.type === 'rectangle' || n.type === 'browser' || n.type === 'script' || !['ellipse', 'path', 'polygon', 'line'].includes(n.type)) geo = { rect: rrect(0, 0, w, h, radii(n, w, h)) };
    else geo = shapePath(n, w, h);
    if (!geo) return;
    drawOuterShadows(canvas, n, geo);
    const bg = effects.find((e) => e.type === 'background_blur');
    if (bg) {
      const r = Number(resolveValue(this.doc, bg.radius, n.theme)) || 0;
      canvas.save(); clipGeo(canvas, geo);
      const f = ck.ImageFilter.MakeBlur(r / 2, r / 2, ck.TileMode.Clamp, null);
      canvas.saveLayer(null, null, f); canvas.restore(); canvas.restore();
      f.delete();
    }
    if (n.type === 'browser') { const p = paints().fill; p.setShader(null); p.setColor(ck.WHITE); drawGeo(canvas, geo, p); }
    if (!geo.line) drawFills(canvas, n, geo, w, h);
    drawInnerShadows(canvas, n, geo, w, h);
    if (n.children.length) {
      if (n.clip) { canvas.save(); clipGeo(canvas, geo); }
      for (const c of n.children) this.drawNode(canvas, c, n.clip ? clipCull(cull, m, w, h) : cull, zoom, m);
      if (n.clip) canvas.restore();
    }
    drawStroke(canvas, n, geo, w, h);
    if (geo.path) geo.path.delete();
  }

  // ---- live previews while dragging (committed edits rebuild the root instead)
  rootOf(n) { while (n?.parent) n = n.parent; return n; }
  previewMove(id, x, y) {
    const n = this.byId.get(id);
    if (!n) return;
    n.x = x; n.y = y;
    for (let p = n; p; p = p.parent) p._ext = null;
    if (n.parent) this.touch(id); // a root just moves: its recording stays valid
  }
  previewSize(id, { width, height, x, y }) {
    const n = this.byId.get(id);
    if (!n) return;
    if (width != null) { n.sizing[0] = FIXED; n.w = width; }
    if (height != null) { n.sizing[1] = FIXED; n.h = height; }
    if (n.type === 'text' && width != null) n.src = { ...n.src, textGrowth: height != null ? 'fixed-width-height' : 'fixed-width' };
    if (x != null) n.x = x;
    if (y != null) n.y = y;
    layoutRoot(this.rootOf(n));
    this.touch(id);
  }

  // ---- queries
  node(id) { return this.byId.get(id); }
  bounds(id) { return this.byId.get(id)?.bounds() ?? null; }
  // ids from root to the deepest node under a world point (pen.dev: reverse z-order walk, clipped frames gate their children)
  hitChain(wx, wy) {
    for (let i = this.roots.length - 1; i >= 0; i--) {
      const chain = hit(this.roots[i], wx, wy);
      if (chain) return chain;
    }
    return [];
  }
}
const clipCull = (cull, m, w, h) => (m[1] || m[3] ? cull : [Math.max(cull[0], m[2]), Math.max(cull[1], m[5]), Math.min(cull[2], m[2] + m[0] * w), Math.min(cull[3], m[5] + m[4] * h)]);

function hit(n, px, py) {
  if (!n.enabled) return null;
  // into local coordinates
  let lx = px - n.x, ly = py - n.y;
  if (n.rot || n.flipX || n.flipY) {
    const inv = CK().Matrix.invert(n.matrix());
    if (!inv) return null;
    lx = inv[0] * px + inv[1] * py + inv[2]; ly = inv[3] * px + inv[4] * py + inv[5];
  }
  const [w, h] = n.dims();
  const inside = lx >= 0 && ly >= 0 && lx <= w && ly <= h;
  if (n.clip && !inside) return null;
  for (let i = n.children.length - 1; i >= 0; i--) {
    const c = hit(n.children[i], lx, ly);
    if (c) return [n.id, ...c];
  }
  if (n.type === 'group') return null;
  return inside ? [n.id] : null;
}
