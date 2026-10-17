// Figma import, ported from pen.dev (Pen.app 1.2.17): copy/paste from Figma and .fig files ("File > Save local copy").
// Both carry a "fig-kiwi" archive: an 8-byte prelude and a version, then chunks [schema, message], each deflate or zstd.
// The kiwi message's `nodeChanges` form the tree (guid + parentIndex); instances are expanded from their components
// with overrides and variables applied, and each page's layers become plain .pen nodes (no components, like pen.dev).
// A .fig is usually a zip: canvas.fig plus images/<sha1 hash>. Pasted layers come without images.
import { compileSchema, decodeBinarySchema } from 'kiwi-schema';
import { inflateSync, unzipSync } from 'fflate';
import { decompress as zstd } from 'fzstd';

const key = (g) => `${g.sessionID}:${g.localID}`;
const valid = (g) => g != null && g.sessionID !== 0xffffffff && g.localID !== 0xffffffff;
const same = (a, b) => a != null && b != null && a.sessionID === b.sessionID && a.localID === b.localID;
const refKey = (r) => r?.assetRef?.key || (valid(r?.guid) ? key(r.guid) : undefined);
const deg = (r) => (r * 180) / Math.PI;
const div = (a, b) => (b === 0 ? 0 : a / b);
const round = (v) => Math.round(v * 1000) / 1000;
const angle = (rad) => round((((-deg(rad)) % 360) + 360) % 360); // .pen: degrees CCW, 0 = up
const one = (list) => (list.length === 1 ? list[0] : list.length ? list : undefined);
const hex = (c, k = 1) => {
  if (!c) return;
  const s = [c.r, c.g, c.b, (c.a ?? 1) * k].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
  return `#${s.endsWith('ff') ? s.slice(0, 6) : s}`;
};
const lerpColor = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t });

// 2D affine matrix [a b c d tx ty]; rotate/scale/translate post-multiply (pen.dev's matrix class).
const M = (a, b, c, d, tx, ty) => ({ a, b, c, d, tx, ty });
const figMatrix = (t) => M(t.m00, t.m10, t.m01, t.m11, t.m02, t.m12);
const det = (m) => m.a * m.d - m.b * m.c;
const invert = (m) => { const k = det(m); return M(m.d / k, -m.b / k, -m.c / k, m.a / k, (m.c * m.ty - m.d * m.tx) / k, -(m.a * m.ty - m.b * m.tx) / k); };
const apply = (m, x, y) => ({ x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty });
const rotate = (m, r) => { const c = Math.cos(r), s = Math.sin(r); return M(m.a * c - m.b * s, m.a * s + m.b * c, m.c * c - m.d * s, m.c * s + m.d * c, m.tx * c - m.ty * s, m.tx * s + m.ty * c); };
const scale = (m, x, y) => M(m.a * x, m.b * y, m.c * x, m.d * y, m.tx * x, m.ty * y);
const matrixArray = (m) => { const v = [m.a, m.b, m.c, m.d, m.tx, m.ty].map((x) => Math.round(x * 1e6) / 1e6); return v.join() === '1,0,0,1,0,0' ? undefined : v; };

const BLEND = { DARKEN: 'darken', MULTIPLY: 'multiply', LINEAR_BURN: 'linearBurn', COLOR_BURN: 'colorBurn', LIGHTEN: 'light', SCREEN: 'screen', LINEAR_DODGE: 'linearDodge',
  COLOR_DODGE: 'colorDodge', OVERLAY: 'overlay', SOFT_LIGHT: 'softLight', HARD_LIGHT: 'hardLight', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue',
  SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity' };

// ------------------------------------------------------------------ archive
function decodeArchive(buf) {
  const prelude = new TextDecoder().decode(buf.subarray(0, 8));
  if (prelude !== 'fig-kiwi' && prelude !== 'fig-jam.') throw new Error('Não é um arquivo do Figma');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), chunks = [];
  for (let o = 12; o + 4 < buf.length;) { const n = dv.getUint32(o, true); chunks.push(buf.subarray(o + 4, o + 4 + n)); o += 4 + n; }
  const unpack = (b) => { try { return inflateSync(b); } catch (e) { try { return zstd(b); } catch { throw e; } } };
  return compileSchema(decodeBinarySchema(unpack(chunks[0]))).decodeMessage(unpack(chunks[1]));
}

const IMAGE_EXT = [[[0x89, 0x50, 0x4e, 0x47], 'png'], [[0xff, 0xd8, 0xff], 'jpg'], [[0x47, 0x49, 0x46], 'gif'], [[0x52, 0x49, 0x46, 0x46], 'webp']];
const imageExt = (b) => IMAGE_EXT.find(([sig]) => sig.every((v, i) => b[i] === v))?.[1] ?? 'png';

/**
 * bytes: a .fig file (zip or bare) or the clipboard buffer. saveImage(name, bytes) stores an image and returns its url.
 * Returns { pages: [{ name, nodes }] } with the .pen nodes of every page (top-level x/y in page coordinates).
 */
export function importFigma(bytes, saveImage = () => undefined) {
  let canvas = bytes, files = {};
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) { // "PK": zip
    files = unzipSync(bytes);
    canvas = files['canvas.fig'];
    if (!canvas) throw new Error('canvas.fig não encontrado no .fig');
  }
  const saved = new Map();
  const image = (hash) => {
    if (!saved.has(hash)) { const b = files[`images/${hash}`]; saved.set(hash, b ? saveImage(`${hash}.${imageExt(b)}`, b) : undefined); }
    return saved.get(hash);
  };
  const msg = decodeArchive(canvas), changes = msg.nodeChanges ?? [];
  const nodes = new Map();
  for (const p of changes) if (p.guid) nodes.set(key(p.guid), { props: p, children: null, parent: null });
  for (const n of nodes.values()) {
    const parent = n.props.parentIndex && nodes.get(key(n.props.parentIndex.guid));
    if (parent) (parent.children ??= []).push(n), (n.parent = parent);
  }
  // topmost first (descending position); the converter walks them backwards so .pen children paint bottom → top
  const pos = (n) => n.props.parentIndex?.position;
  for (const n of nodes.values()) n.children?.sort((a, b) => (pos(a) < pos(b)) - (pos(a) > pos(b)));
  const root = nodes.get('0:0');
  if (!root?.children) return { pages: [] };
  const c = new Converter(nodes, msg.blobs, image);
  for (const p of changes) {
    if (p.type !== 'VARIABLE_SET' || !p.variableSetModes?.[0]?.id) continue;
    const mode = key(p.variableSetModes[0].id);
    for (const k of [refKey(p.variableSetID) || (p.guid && key(p.guid)), p.guid && key(p.guid), p.variableSetID?.assetRef?.key, p.key]) if (k) c.defaultModes.set(k, mode);
  }
  for (const p of changes) {
    const k = p.key || (p.guid && key(p.guid));
    if (p.type === 'VARIABLE' && p.variableDataValues?.entries && k && !c.variables.has(k)) c.variables.set(k, { setId: refKey(p.variableSetID), entries: p.variableDataValues.entries });
  }
  for (const n of nodes.values()) { if (n.props.key) c.styles.set(n.props.key, n.props); if (n.props.guid) c.styles.set(key(n.props.guid), n.props); }
  const pages = root.children.filter((p) => p.props.visible).reverse();
  return { pages: pages.map((p) => ({ name: p.props.name ?? 'Página', nodes: (p.children ?? []).toReversed().map((n) => c.convert(n)).filter(Boolean) })) };
}

// ------------------------------------------------------------------ paints, effects, strokes
function paints(list, size, image) {
  const out = [];
  for (const p of list ?? []) {
    const enabled = p.visible === true, blendMode = BLEND[p.blendMode];
    const extra = { ...(!enabled && { enabled: false }), ...(blendMode && { blendMode }) };
    switch (p.type) {
      case 'SOLID': {
        const color = hex(p.color, p.opacity ?? 1);
        if (color) out.push(enabled && !blendMode ? color : { type: 'color', color, ...extra });
        break;
      }
      case 'IMAGE': {
        const hash = p.image?.hash && Array.from(p.image.hash, (b) => b.toString(16).padStart(2, '0')).join('');
        const f = { type: 'image', url: hash ? image(hash) : undefined, mode: p.imageScaleMode === 'FIT' ? 'contain' : 'cover', ...extra };
        if (p.opacity && p.opacity !== 1) f.opacity = p.opacity;
        if (p.imageScaleMode === 'STRETCH') {
          f.mode = 'stretch';
          if (p.transform && size) { const m = figMatrix(p.transform); if (det(m) !== 0) f.transform = matrixArray(invert(m)); }
        }
        // rotated cover/contain images: bake the fit and the rotation into a stretch transform
        const r = p.rotation ?? 0, w = p.originalImageWidth, h = p.originalImageHeight;
        if (r !== 0 && size && w && h && f.mode !== 'stretch') {
          const [u, v] = Math.round(r / 90) % 2 !== 0 ? [h, w] : [w, h];
          const k = (f.mode === 'cover' ? Math.max : Math.min)(div(size.x, u), div(size.y, v));
          let m = scale(rotate(M(w, 0, 0, h, -w / 2, -h / 2), (-r * Math.PI) / 180), k, k);
          m = scale({ ...m, tx: m.tx + size.x / 2, ty: m.ty + size.y / 2 }, div(1, size.x), div(1, size.y));
          f.mode = 'stretch', (f.transform = matrixArray(m));
        }
        if (!f.url) delete f.url;
        if (!f.transform) delete f.transform;
        out.push(f);
        break;
      }
      case 'GRADIENT_LINEAR': case 'GRADIENT_RADIAL': case 'GRADIENT_ANGULAR': {
        if (!p.transform || !p.stops) break;
        let stops = p.stops.map((s) => ({ position: s.position, color: s.color ?? { r: 0, g: 0, b: 0, a: 1 } }));
        const m = invert(figMatrix(p.transform)), c = apply(m, p.type === 'GRADIENT_LINEAR' ? 0 : 0.5, 0.5), x1 = apply(m, 1, 0.5);
        const g = { type: 'gradient', gradientType: p.type.slice(9).toLowerCase(), ...extra };
        if ((p.opacity ?? 1) !== 1) g.opacity = p.opacity;
        let center, size;
        if (p.type === 'GRADIENT_LINEAR') {
          const y1 = apply(m, 0, 1);
          let gx = y1.x - c.x, gy = y1.y - c.y;
          const len = Math.hypot(gx, gy);
          if (len !== 0) gx /= len, gy /= len;
          let l = -gy * (x1.x - c.x) + gx * (x1.y - c.y), a = Math.atan2(gx, -gy) + Math.PI / 2;
          if (l < 0) l = -l, a += Math.PI;
          g.rotation = angle(a), (center = [(c.x + x1.x) / 2, (c.y + x1.y) / 2]), (size = { height: l });
        } else if (p.type === 'GRADIENT_RADIAL') {
          const y1 = apply(m, 0.5, 1), v = [x1.x - c.x, y1.x - c.x, x1.y - c.y, y1.y - c.y];
          const A = v[0] * v[0] + v[1] * v[1], B = v[0] * v[2] + v[1] * v[3], C = v[2] * v[2] + v[3] * v[3], s = A + C, root = Math.sqrt(s * s - 4 * (A * C - B * B));
          const big = (s + root) / 2, small = (s - root) / 2;
          g.rotation = angle(Math.atan2(big - A, B) + Math.PI / 2), (center = [c.x, c.y]), (size = { width: Math.sqrt(small) * 2, height: Math.sqrt(big) * 2 });
        } else {
          const y1 = apply(m, 0.5, 1), dir = (y1.x - c.x) * (x1.y - c.y) - (y1.y - c.y) * (x1.x - c.x) > 0 ? -1 : 1;
          g.rotation = angle(Math.atan2(x1.y - c.y, x1.x - c.x) + Math.PI / 2), (center = [c.x, c.y]);
          size = { width: dir * Math.hypot(y1.x - c.x, y1.y - c.y) * 2, height: Math.hypot(x1.x - c.x, x1.y - c.y) * 2 };
          if (stops.length >= 2) { // close the loop: the color where the last stop wraps around to the first
            stops = stops.toSorted((a, b) => a.position - b.position);
            const first = stops[0], last = stops.at(-1);
            if (first.position !== 0 || last.position !== 1) {
              const color = lerpColor(first.color, last.color, div(first.position, first.position + (1 - last.position)));
              if (first.position !== 0) stops.unshift({ position: 0, color });
              if (last.position !== 1) stops.push({ position: 1, color });
            }
          }
        }
        g.size = size, (g.colors = stops.map((s) => ({ color: hex(s.color), position: s.position })));
        if (center[0] !== 0.5 || center[1] !== 0.5) g.center = { ...(center[0] !== 0.5 && { x: center[0] }), ...(center[1] !== 0.5 && { y: center[1] }) };
        out.push(g);
        break;
      }
      // GRADIENT_DIAMOND, EMOJI, VIDEO, PATTERN, NOISE: not supported (pen.dev skips them too)
    }
  }
  return out.length ? out : undefined;
}

function effects(list) {
  const out = [];
  for (const e of list ?? []) {
    const radius = (e.radius ?? 0) * 0.875, off = e.visible === true ? {} : { enabled: false };
    if (e.type === 'FOREGROUND_BLUR') out.push({ type: 'blur', radius, ...off });
    else if (e.type === 'BACKGROUND_BLUR') out.push({ type: 'background_blur', radius, ...off });
    else if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      out.push({ type: 'shadow', shadowType: e.type === 'DROP_SHADOW' ? 'outer' : 'inner', ...off, color: hex(e.color ?? { r: 0, g: 0, b: 0, a: 0 }),
        ...((e.offset?.x || e.offset?.y) && { offset: { x: e.offset.x ?? 0, y: e.offset.y ?? 0 } }), ...(radius && { blur: radius }), ...(BLEND[e.blendMode] && { blendMode: BLEND[e.blendMode] }) });
    }
  }
  return one(out);
}

function stroke(out, p, image) {
  const fills = paints(p.strokePaints, p.size, image);
  if (!fills) return;
  out.stroke = one(fills);
  const w = p.borderStrokeWeightsIndependent ? [p.borderTopWeight ?? 0, p.borderRightWeight ?? 0, p.borderBottomWeight ?? 0, p.borderLeftWeight ?? 0] : p.strokeWeight ? Array(4).fill(p.strokeWeight) : null;
  if (w) {
    const width = w.every((v) => v === w[0]) ? w[0] : Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k, i) => [k, w[i]]).filter(([, v]) => v));
    if (width) out.strokeWidth = width;
  }
  const align = { INSIDE: 'inner', OUTSIDE: 'outer' }[p.strokeAlign], join = { BEVEL: 'bevel', ROUND: 'round' }[p.strokeJoin], cap = { ROUND: 'round', SQUARE: 'square' }[p.strokeCap];
  if (align) out.strokeAlignment = align;
  if (join) out.strokeLinejoin = join;
  if (cap) out.strokeLinecap = cap;
}

function radius(p) {
  const r = [p.rectangleTopLeftCornerRadius ?? 0, p.rectangleTopRightCornerRadius ?? 0, p.rectangleBottomRightCornerRadius ?? 0, p.rectangleBottomLeftCornerRadius ?? 0];
  const v = r.some(Boolean) ? r : p.cornerRadius != null ? Array(4).fill(p.cornerRadius) : null;
  if (!v || v.every((x) => x === 0)) return;
  return v.every((x) => x === v[0]) ? v[0] : v;
}

// Auto layout sizing of `n` along an axis ("H"/"V"): fill, fit or fixed.
const axis = (mode) => (mode === 'VERTICAL' ? 'V' : mode === 'HORIZONTAL' ? 'H' : null);
function sizing(n, ax) {
  const cross = ax === 'H' ? 'V' : 'H', parent = axis(n.parent?.props.stackMode), own = axis(n.props.stackMode), p = n.props;
  if ((parent === cross && p.stackChildAlignSelf === 'STRETCH') || (parent === ax && p.stackChildPrimaryGrow)) return 'fill';
  if (own === cross && p.stackCounterSizing === 'RESIZE_TO_FIT_WITH_IMPLICIT_SIZE') return 'fit';
  if (own === ax && p.stackPrimarySizing === 'FIXED') return 'fixed';
  return own === ax ? 'fit' : 'fixed';
}
const sizeValue = (kind, value, dflt) => (kind === 'fixed' ? round(value) : kind === dflt ? undefined : kind === 'fill' ? 'fill_container' : 'fit_content');

const WEIGHTS = [['Thin', '100'], ['ExtraLight', '200'], ['Extra Light', '200'], ['Light', '300'], ['Regular', null], ['SemiBold', '600'], ['Semi Bold', '600'],
  ['ExtraBold', '800'], ['Extra Bold', '800'], ['ExtraBlack', '950'], ['Extra Black', '950'], ['Black', '900'], ['Bold', '700'], ['Medium', '500']];

// Vector network blob: vertices, segments (cubic handles) and regions (loops of segment indices with a winding rule).
function parseNetwork(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 12) return;
  const [nv, ns, nr] = [0, 4, 8].map((o) => dv.getUint32(o, true));
  let o = 12;
  const vertices = [], segments = [], regions = [];
  for (let i = 0; i < nv; i++, o += 12) { if (o + 12 > b.length) return; vertices.push({ x: dv.getFloat32(o + 4, true), y: dv.getFloat32(o + 8, true) }); }
  for (let i = 0; i < ns; i++, o += 28) {
    if (o + 28 > b.length) return;
    const s = dv.getUint32(o + 4, true), e = dv.getUint32(o + 16, true);
    if (s >= nv || e >= nv) return;
    segments.push({ start: { vertex: s, dx: dv.getFloat32(o + 8, true), dy: dv.getFloat32(o + 12, true) }, end: { vertex: e, dx: dv.getFloat32(o + 20, true), dy: dv.getFloat32(o + 24, true) } });
  }
  for (let i = 0; i < nr; i++) {
    if (o + 8 > b.length) return;
    const winding = dv.getUint32(o, true) & 1 ? 'NONZERO' : 'ODD', nl = dv.getUint32(o + 4, true), loops = [];
    o += 8;
    for (let j = 0; j < nl; j++) {
      if (o + 4 > b.length) return;
      const n = dv.getUint32(o, true), segs = [];
      if ((o += 4) + n * 4 > b.length) return;
      for (let k = 0; k < n; k++, o += 4) { const s = dv.getUint32(o, true); if (s >= ns) return; segs.push(s); }
      loops.push(segs);
    }
    regions.push({ winding, loops });
  }
  return { vertices, segments, regions };
}

// Chain segments head to tail (flip the ones stored backwards), then draw them as SVG path data.
function chain(segs) {
  if (segs.length < 2) return segs;
  const s = structuredClone(segs), flip = (x) => ([x.start, x.end] = [x.end, x.start]);
  if (s[0].end.vertex !== s[1].start.vertex && s[0].end.vertex !== s[1].end.vertex) flip(s[0]);
  for (let i = 1; i < s.length; i++) if (s[i - 1].end.vertex !== s[i].start.vertex) flip(s[i]);
  return s;
}
function draw(vertices, segs) {
  let d = '', first, last;
  const pt = (x, y) => `${round(x)} ${round(y)}`;
  for (const s of segs) {
    const a = vertices[s.start.vertex], b = vertices[s.end.vertex];
    if (last !== s.start.vertex) (d += `M${pt(a.x, a.y)}`), (first = s.start.vertex);
    d += !s.start.dx && !s.start.dy && !s.end.dx && !s.end.dy ? `L${pt(b.x, b.y)}` : `C${pt(a.x + s.start.dx, a.y + s.start.dy)} ${pt(b.x + s.end.dx, b.y + s.end.dy)} ${pt(b.x, b.y)}`;
    last = s.end.vertex;
    if (first != null && last === first) (d += 'Z'), (first = last = undefined);
  }
  return d;
}

// Variable fields that bind a float to one or more node properties.
const CORNERS = ['rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius', 'rectangleBottomLeftCornerRadius', 'rectangleBottomRightCornerRadius'];
const FLOAT_FIELDS = {
  OPACITY: ['opacity'], CORNER_RADIUS: ['cornerRadius', ...CORNERS], RECTANGLE_TOP_LEFT_CORNER_RADIUS: [CORNERS[0]], RECTANGLE_TOP_RIGHT_CORNER_RADIUS: [CORNERS[1]],
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: [CORNERS[2]], RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: [CORNERS[3]], STROKE_WEIGHT: ['strokeWeight'], STACK_SPACING: ['stackSpacing'],
  STACK_PADDING_LEFT: ['stackHorizontalPadding'], STACK_PADDING_TOP: ['stackVerticalPadding'], STACK_PADDING_RIGHT: ['stackPaddingRight'], STACK_PADDING_BOTTOM: ['stackPaddingBottom'],
  BORDER_TOP_WEIGHT: ['borderTopWeight'], BORDER_BOTTOM_WEIGHT: ['borderBottomWeight'], BORDER_LEFT_WEIGHT: ['borderLeftWeight'], BORDER_RIGHT_WEIGHT: ['borderRightWeight'],
  STACK_COUNTER_SPACING: ['stackCounterSpacing'], FONT_SIZE: ['fontSize'],
};
const keepColorVars = (now, before) => now?.forEach((p, i) => { if (!p.colorVar && before?.[i]?.colorVar) p.colorVar = before[i].colorVar; });
const splitOverrides = (list, guid) => {
  const own = [], deeper = [];
  for (const o of list) {
    const g = o.guidPath?.guids;
    if (!g?.length || !same(g[0], guid)) continue;
    if (g.length > 1) deeper.push({ ...o, guidPath: { guids: g.slice(1) } });
    else own.push(o);
  }
  return [own, deeper];
};

// ------------------------------------------------------------------ nodes
class Converter {
  variables = new Map(); defaultModes = new Map(); styles = new Map();
  constructor(nodes, blobs, image) { this.nodes = nodes; this.blobs = blobs; this.image = image; }

  style(ref) { const k = refKey(ref); return k && this.styles.get(k); }
  applyStyles(p, node = null) {
    const fill = this.style(p.styleIdForFill), line = this.style(p.styleIdForStrokeFill), fx = this.style(p.styleIdForEffect), text = this.style(p.styleIdForText);
    if (fill?.fillPaints !== undefined) p.fillPaints = this.resolvePaints(fill.fillPaints, node);
    if (line?.fillPaints !== undefined) p.strokePaints = this.resolvePaints(line.fillPaints, node);
    if (fx?.effects !== undefined) p.effects = fx.effects;
    if (text) for (const k of ['fontName', 'textCase', 'fontSize', 'textDecoration', 'letterSpacing', 'lineHeight', 'paragraphSpacing']) if (text[k] !== undefined) p[k] = text[k];
  }

  // Overrides travel down the instance tree by guid path; each node takes the ones addressed to it.
  applyOverrides(n, overrides, derived) {
    const id = n.props.overrideKey || n.props.guid;
    const [own, deeper] = splitOverrides(overrides, id), [ownDerived, deeperDerived] = splitOverrides(derived, id);
    let name;
    if (n.props.type === 'INSTANCE') {
      const swap = own.find((o) => valid(o.overriddenSymbolID));
      if (swap) (name = n.props.name), this.replaceInstanceProps(n, swap.overriddenSymbolID);
    }
    for (const o of own) {
      this.applyStyles(o, n);
      const p = n.props, { componentPropAssignments: assigned, fillPaints, strokePaints, styleIdForFill, styleIdForStrokeFill, variableModeBySetMap: modes } = p;
      Object.assign(p, o);
      if (modes && !p.variableModeBySetMap) p.variableModeBySetMap = modes;
      if (o.componentPropAssignments && assigned) for (const w of assigned) if (!o.componentPropAssignments.some((k) => same(k.defID, w.defID))) p.componentPropAssignments?.push(w);
      delete p.guidPath;
      keepColorVars(p.fillPaints, fillPaints), keepColorVars(p.strokePaints, strokePaints);
      if (o.fillPaints) { const s = this.style(styleIdForFill); if (s?.fillPaints) p.fillPaints = this.resolvePaints(s.fillPaints, n); }
      if (o.strokePaints) { const s = this.style(styleIdForStrokeFill); if (s?.fillPaints) p.strokePaints = this.resolvePaints(s.fillPaints, n); }
      if (p.fillPaints) p.fillPaints = this.resolvePaints(p.fillPaints, n);
      if (p.strokePaints) p.strokePaints = this.resolvePaints(p.strokePaints, n);
      if (valid(o.overriddenSymbolID)) (p.symbolData ??= {}).symbolID = o.overriddenSymbolID;
      this.resolveNodeVariables(n, o.variableConsumptionMap?.entries || o.parameterConsumptionMap?.entries);
    }
    if (name) n.props.name = name;
    for (const o of ownDerived) {
      for (const [k, v] of Object.entries(o)) if (k !== 'guidPath' && v != null) n.props[k] = v;
      for (const k of ['styleIdForFill', 'styleIdForStrokeFill', 'styleIdForEffect', 'styleIdForText']) delete n.props[k];
    }
    if (n.props.type === 'INSTANCE') {
      ((n.props.symbolData ??= {}).symbolOverrides ??= []).push(...deeper);
      (n.props.derivedSymbolData ??= []).push(...deeperDerived);
    } else for (const c of n.children ?? []) this.applyOverrides(c, [...overrides, ...deeper], [...derived, ...deeperDerived]);
  }

  // Instance swap: take the other component's props, keep the instance's own placement and bindings.
  replaceInstanceProps(n, symbolId) {
    const sym = this.nodes.get(key(symbolId));
    if (!sym) return;
    const p = n.props, keep = ['guid', 'parentIndex', 'overrideKey', 'size', 'transform', 'visible', 'parameterConsumptionMap', 'componentPropAssignments', 'symbolData', 'derivedSymbolData', 'variableModeBySetMap'];
    n.props = structuredClone(sym.props);
    n.props.type = 'INSTANCE';
    for (const k of keep) if (k === 'guid' || k === 'parentIndex' || k === 'overrideKey' ? true : p[k] != null) n.props[k] = p[k];
  }

  findModeForSet(n, setId) {
    for (let x = n; x; x = x.parent) for (const s of x.props.variableModeBySetMap?.entries ?? []) if (refKey(s.variableSetID) === setId && s.variableModeID) return key(s.variableModeID);
    return this.defaultModes.get(setId);
  }
  resolveVariable(n, data) {
    if (!data?.value) return;
    if (data.dataType !== 'ALIAS') return data.value;
    const v = this.variables.get(refKey(data.value.alias));
    if (!v) return;
    if (v.entries.length > 1 && v.setId) {
      const mode = this.findModeForSet(n, v.setId), hit = mode && v.entries.find((e) => e.modeID && key(e.modeID) === mode);
      if (hit) return this.resolveVariable(n, hit.variableData);
    }
    return this.resolveVariable(n, v.entries[0]?.variableData);
  }
  resolveColor(n, data) { if (data?.resolvedDataType === 'COLOR') return this.resolveVariable(n, data)?.colorValue; }
  resolvePaints(list, n = null) {
    return list.map((p) => {
      if (p.stops) return { ...p, stops: p.stops.map((s, i) => { const c = this.resolveColor(n, s.colorVar ?? p.stopsVar?.[i]?.colorVar); return c ? { ...s, color: c } : s; }) };
      const c = this.resolveColor(n, p.colorVar);
      return c ? { ...p, color: c, opacity: 1 } : p;
    });
  }
  // Component properties: a reference resolves to the nearest ancestor's assignment.
  resolvePropRef(n, data) {
    const def = data?.value?.propRefValue?.defId;
    if (!def) return data;
    for (let x = n; x; x = x.parent) for (const a of x.props.componentPropAssignments ?? []) if (same(def, a.defID)) return this.resolvePropRef(x, a.varValue);
    return data;
  }
  resolveNodeVariables(n, entries) {
    for (const e of entries ?? []) {
      const field = e.variableField;
      if (!field) continue;
      const v = this.resolveVariable(n, this.resolvePropRef(n, e.variableData)), p = n.props;
      if (field === 'TEXT_DATA') { if (v?.textDataValue) p.textData = v.textDataValue; else if (v?.textValue != null) p.textData = { characters: v.textValue }; }
      else if (field === 'VISIBLE') { if (v?.boolValue != null) p.visible = v.boolValue; }
      else if (field === 'OVERRIDDEN_SYMBOL_ID') { if (valid(v?.symbolIdValue?.guid)) p.overriddenSymbolID = v.symbolIdValue.guid; }
      else if (v?.floatValue != null) {
        if (FLOAT_FIELDS[field]) for (const k of FLOAT_FIELDS[field]) p[k] = v.floatValue;
        else if (field === 'WIDTH') p.size = { x: v.floatValue, y: p.size?.y ?? 0 };
        else if (field === 'HEIGHT') p.size = { x: p.size?.x ?? 0, y: v.floatValue };
      }
    }
  }

  clone(n) {
    const c = { props: structuredClone(n.props), children: null, parent: null };
    if (n.children) c.children = n.children.map((x) => Object.assign(this.clone(x), { parent: c }));
    return c;
  }

  convert(src) {
    const n = { props: structuredClone(src.props), children: src.children, parent: src.parent };
    if (n.props.type === 'INSTANCE') {
      const swapped = valid(n.props.overriddenSymbolID);
      this.resolveNodeVariables(n, n.props.parameterConsumptionMap?.entries);
      for (const r of n.props.componentPropRefs ?? []) if (r.defID && r.componentPropNodeField) this.resolveNodeVariables(n, [{ variableField: r.componentPropNodeField, variableData: { value: { propRefValue: { defId: r.defID } } } }]);
      const symbolId = valid(n.props.overriddenSymbolID) ? n.props.overriddenSymbolID : n.props.symbolData?.symbolID;
      const sym = symbolId && this.nodes.get(key(symbolId));
      if (sym) {
        const copy = this.clone(sym);
        for (const c of copy.children ?? []) (c.parent = n), this.applyOverrides(c, n.props.symbolData?.symbolOverrides || [], n.props.derivedSymbolData || []);
        n.children = copy.children;
        if (!swapped && valid(n.props.overriddenSymbolID)) {
          const { name, fillPaints, strokePaints } = n.props;
          this.replaceInstanceProps(n, n.props.overriddenSymbolID);
          Object.assign(n.props, { name, fillPaints, strokePaints });
        }
        n.props.type = 'FRAME';
      }
    }
    this.resolveNodeVariables(n, n.props.parameterConsumptionMap?.entries);
    const p = n.props;
    this.applyStyles(p, n);

    const out = { type: 'frame' };
    if (p.name) out.name = p.name;
    const inLayout = axis(n.parent?.props.stackMode) && p.stackPositioning !== 'ABSOLUTE';
    if (p.stackPositioning === 'ABSOLUTE' && axis(n.parent?.props.stackMode)) out.layoutPosition = 'absolute';
    if (p.transform) {
      // position, rotation (degrees CCW, around the top-left corner) and flips from the 2x3 matrix
      const { m00: a, m10: b, m01: c, m11: d } = p.transform, mirrored = a * d - b * c < 0;
      const sx = Math.hypot(a, b) * (mirrored ? -1 : 1), sy = Math.hypot(c, d), r = mirrored ? Math.atan2(-b, -a) : Math.atan2(b, a);
      const cos = Math.cos(r), sin = Math.sin(r), eps = 1e-6;
      if (!inLayout) (out.x = round(p.transform.m02)), (out.y = round(p.transform.m12));
      if (Math.abs(r) > eps) out.rotation = round(-deg(r));
      if (Math.abs(a - Math.abs(sx) * cos) > eps || Math.abs(b - Math.abs(sx) * sin) > eps) out.flipX = true;
      if (Math.abs(c + Math.abs(sy) * sin) > eps || Math.abs(d - Math.abs(sy) * cos) > eps) out.flipY = true;
    }
    if (p.visible === false) out.enabled = false;
    if (p.opacity != null && p.opacity !== 1) out.opacity = p.opacity;
    const fill = one(paints(p.fillPaints, p.size, this.image) ?? []), effect = effects(p.effects);
    const size = (dflt) => {
      const w = sizeValue(sizing(n, 'H'), p.size?.x ?? 0, dflt), h = sizeValue(sizing(n, 'V'), p.size?.y ?? 0, dflt);
      if (w !== undefined) out.width = w;
      if (h !== undefined) out.height = h;
    };
    const graphics = (dflt = 'fixed') => { size(dflt); if (fill) out.fill = fill; stroke(out, p, this.image); };

    switch (p.type) {
      case 'SYMBOL': case 'SECTION': case 'FRAME':
        if (p.resizeToFit) { out.type = 'group'; break; } // Figma groups are frames that hug their children
        if (!(p.frameMaskDisabled ?? false)) out.clip = true;
        graphics('fit');
        if (radius(p) !== undefined) out.cornerRadius = radius(p);
        {
          const mode = axis(p.stackMode);
          if (mode !== 'H') out.layout = mode === 'V' ? 'vertical' : 'none';
          if (mode) {
            if (p.stackSpacing) out.gap = p.stackSpacing;
            let pad = [p.stackVerticalPadding ?? 0, p.stackPaddingRight ?? 0, p.stackPaddingBottom ?? 0, p.stackHorizontalPadding ?? 0];
            if (pad[0] === pad[2] && pad[1] === pad[3]) pad = pad[0] === pad[1] ? pad[0] : [pad[0], pad[1]];
            if (pad !== 0) out.padding = pad;
            const justify = { CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space_between', SPACE_EVENLY: 'space_between' }[p.stackPrimaryAlignItems];
            const align = { CENTER: 'center', MAX: 'end' }[p.stackCounterAlignItems];
            if (justify) out.justifyContent = justify;
            if (align) out.alignItems = align;
            if (p.bordersTakeSpace) out.layoutIncludeStroke = true;
          }
        }
        break;
      case 'BOOLEAN_OPERATION': out.type = 'group'; break;
      case 'VECTOR': {
        out.type = 'path';
        graphics();
        const blob = p.vectorData?.vectorNetworkBlob != null && this.blobs?.[p.vectorData.vectorNetworkBlob];
        const net = blob && parseNetwork(blob.bytes);
        if (net) {
          let winding;
          out.geometry = net.regions.length
            ? net.regions.map((r) => ((winding = r.winding), r.loops.filter((l) => l.length).map((l) => draw(net.vertices, chain(l.map((i) => net.segments[i])))).join(''))).join('')
            : draw(net.vertices, chain(net.segments));
          if (winding === 'ODD') out.fillRule = 'evenodd';
          // network coordinates are in the layer's own box (pen.dev leaves this out and fits the path's bounds instead)
          if (p.size) out.viewBox = [0, 0, round(p.size.x) || 1, round(p.size.y) || 1];
        } else out.geometry = '';
        break;
      }
      case 'TEXT': {
        out.type = 'text';
        if (fill) out.fill = fill;
        const growth = { WIDTH_AND_HEIGHT: 'auto', HEIGHT: 'fixed-width' }[p.textAutoResize ?? 'NONE'] ?? 'fixed-width-height';
        if (growth !== 'auto') {
          out.textGrowth = growth;
          out.width = sizeValue(sizing(n, 'H'), p.size?.x ?? 0, 'fixed') ?? 0;
          if (growth === 'fixed-width-height') out.height = sizeValue(sizing(n, 'V'), p.size?.y ?? 0, 'fixed');
        }
        if (p.textData?.characters) out.content = p.textData.characters;
        const fs = p.fontSize ?? 1;
        if (p.lineHeight?.units === 'RAW') out.lineHeight = p.lineHeight.value;
        else if (p.lineHeight?.units === 'PIXELS') out.lineHeight = round(p.lineHeight.value / fs);
        const align = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }[p.textAlignHorizontal], valign = { CENTER: 'middle', BOTTOM: 'bottom' }[p.textAlignVertical];
        if (align) out.textAlign = align;
        if (valign) out.textAlignVertical = valign;
        if (p.fontName?.family != null) {
          out.fontFamily = p.fontName.family;
          const style = p.fontName.style ?? '', weight = WEIGHTS.find(([w]) => style.includes(w));
          if (weight?.[1]) out.fontWeight = weight[1];
          if (style.includes('Italic')) out.fontStyle = 'italic';
        }
        if (p.fontSize != null) out.fontSize = p.fontSize;
        const ls = p.letterSpacing?.units === 'PERCENT' ? ((p.letterSpacing.value ?? 0) / 100) * fs : (p.letterSpacing?.value ?? 0);
        if (ls) out.letterSpacing = round(ls);
        if (p.textDecoration === 'UNDERLINE') out.underline = true;
        if (p.textDecoration === 'STRIKETHROUGH') out.strikethrough = true;
        break;
      }
      case 'RECTANGLE': case 'ROUNDED_RECTANGLE': case 'LINE': case 'ELLIPSE': case 'REGULAR_POLYGON': {
        out.type = { LINE: 'line', ELLIPSE: 'ellipse', REGULAR_POLYGON: 'polygon' }[p.type] ?? 'rectangle';
        graphics();
        const r = radius(p);
        if (out.type === 'rectangle' && r !== undefined) out.cornerRadius = r;
        if (out.type === 'polygon') { if (p.count != null) out.polygonCount = p.count; if (r) out.cornerRadius = Array.isArray(r) ? r[0] : r; }
        if (out.type === 'ellipse' && p.arcData) {
          const { innerRadius, startingAngle, endingAngle } = p.arcData;
          if (innerRadius) out.innerRadius = innerRadius;
          if (startingAngle) out.startAngle = round(-deg(startingAngle));
          if (endingAngle != null) { const sweep = round(deg(startingAngle ?? 0) - deg(endingAngle)); if (Math.abs(sweep) !== 360) out.sweepAngle = sweep; }
        }
        break;
      }
      default: return null; // STAR, STICKY, CONNECTOR, ...: not supported (pen.dev skips them too)
    }
    if (out.type === 'group') delete out.fill;
    if (p.mask) delete out.fill, delete out.stroke;
    if (effect) out.effect = effect;
    if (n.children && (out.type === 'frame' || out.type === 'group')) {
      out.children = [];
      for (let i = n.children.length - 1; i >= 0; i--) { const c = this.convert(n.children[i]); if (c) out.children.push(c); }
    }
    return out;
  }
}
