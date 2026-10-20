// pen.dev's browser extension ("copy to Pen"): it puts a DOM snapshot of the selected element on the clipboard under
// `web application/vnd.pen.dev.browser-import+json` = { version: 1, snapshot: { url, root, ... }, images: [{ url,
// contentType, base64 }], fonts }. Each snapshot node has `tag`, `rect` (page coordinates), computed `style`
// (camelCase strings), `children`, and optionally `text`/`textRect`, `imageSrc`, `svgSource`.
// The desktop webview (WebKit) can't read Chrome's custom clipboard types, so the server reads the macOS pasteboard.
import { execFile } from 'node:child_process';

export const BROWSER_MIME = 'vnd.pen.dev.browser-import+json';

// Every Chrome custom-data type on the pasteboard, base64: `setData` writes a pickle (org.chromium.web-custom-data),
// the async clipboard API a JSON map (custom type → pasteboard type) plus one pasteboard type per entry.
const JXA = `ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard, out = {};
for (const t of ObjC.deepUnwrap(pb.types) ?? []) if (/custom/i.test(t)) { const d = pb.dataForType(t); if (!d.isNil()) out[t] = ObjC.unwrap(d.base64EncodedStringWithOptions(0)); }
JSON.stringify(out)`;

// ponytail: macOS only (osascript); Windows/Linux need their own pasteboard reader
export function readBrowserClipboard() {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise((ok) => execFile('osascript', ['-l', 'JavaScript', '-e', JXA], { maxBuffer: 512 << 20 }, (err, stdout) => {
    if (err) return ok(null);
    try { ok(findPayload(Object.fromEntries(Object.entries(JSON.parse(stdout)).map(([k, v]) => [k, Buffer.from(v, 'base64')])))); } catch { ok(null); }
  }));
}

export function findPayload(types) {
  const pickle = types['org.chromium.web-custom-data'];
  if (pickle) for (const [k, v] of readPickle(pickle)) if (k.includes(BROWSER_MIME)) return v;
  for (const [t, data] of Object.entries(types)) {
    if (!/map/i.test(t)) continue;
    let map;
    try { map = JSON.parse(data.toString('utf8')); } catch { continue; }
    const target = Object.entries(map).find(([k]) => k.includes(BROWSER_MIME))?.[1];
    const hit = target && Object.keys(types).find((k) => k !== t && (k === target || k.endsWith(target)));
    if (hit) return types[hit].toString('utf8');
  }
  return null;
}

// Chromium pickle: uint32 payload size, uint32 count, then (type, data) string16 pairs (uint32 length + UTF-16LE, 4-byte aligned)
export function readPickle(b) {
  let o = 4;
  const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const str = () => { const n = u32(), s = b.toString('utf16le', o, o + n * 2); o += (n * 2 + 3) & ~3; return s; };
  const out = [];
  for (let n = u32(); n--;) out.push([str(), str()]);
  return out;
}

// ---------------------------------------------------------------- snapshot → .pen nodes
// ponytail: absolute positions only (no flex/grid → auto layout, no gradients, no web fonts): pen.dev's converter does those
export function importBrowserSnapshot(payload, saveImage) {
  const { snapshot, images = [] } = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (!snapshot?.root) throw new Error('Clipboard has no browser snapshot');
  const abs = (u) => { try { return new URL(u, snapshot.url).href; } catch { return u; } };
  const bytes = new Map(images.map((i) => [abs(i.url), i]));
  const saved = new Map();
  const image = (src) => {
    if (!src) return;
    src = abs(src);
    if (saved.has(src)) return saved.get(src);
    let data, ext;
    const m = /^data:image\/([\w+]+)(;base64)?,(.*)$/s.exec(src);
    if (m) (ext = m[1]), (data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])));
    else if (bytes.has(src)) (ext = bytes.get(src).contentType.split('/')[1]), (data = Buffer.from(bytes.get(src).base64, 'base64'));
    const url = data ? saveImage(`web-${saved.size + 1}.${ext.replace('svg+xml', 'svg').replace('jpeg', 'jpg')}`, data) : /^https?:/.test(src) ? src : undefined;
    saved.set(src, url);
    return url;
  };
  const svg = (source) => saveImage(`web-svg-${saved.size + 1}.svg`, Buffer.from(source.includes('xmlns=') ? source : source.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')));

  const root = snapshot.root;
  const walk = (d, parent, scale = 1) => {
    if (d.enabled === false) return [];
    scale = d.styleScale > 0 ? d.styleScale : scale;
    const s = d.style ?? {}, r = d.rect;
    if (s.display === 'none' || s.visibility === 'hidden' || r.w <= 0 && r.h <= 0 && !d.children?.length) return [];
    const px = (v) => (v && /px$/.test(v) ? parseFloat(v) * scale : 0);
    const pos = (rect) => ({ x: round(rect.x - parent.x), y: round(rect.y - parent.y) });
    const out = [];
    const radius = cornerRadius(s, r, px), opacity = s.opacity && s.opacity !== '1' ? round(+s.opacity) : undefined;

    if (d.svgSource || d.imageSrc) {
      const url = d.svgSource ? svg(d.svgSource) : image(d.imageSrc);
      if (url) out.push({ type: 'rectangle', name: d.tag.toLowerCase(), ...pos(r), width: round(r.w), height: round(r.h),
        fill: { type: 'image', url, mode: d.svgSource ? 'contain' : { contain: 'contain', fill: 'stretch' }[s.objectFit] ?? 'cover' },
        ...(radius !== undefined && { cornerRadius: radius }), ...(opacity !== undefined && { opacity }) });
      return out;
    }

    const fills = [];
    const bg = color(s.backgroundColor);
    if (bg) fills.push(bg);
    const bgUrl = /url\(["']?([^"')]+)["']?\)/.exec(s.backgroundImage ?? '')?.[1];
    if (bgUrl && image(bgUrl)) fills.push({ type: 'image', url: image(bgUrl), mode: s.backgroundSize === 'contain' ? 'contain' : 'cover' });
    const frame = { type: 'frame', name: d.componentName ?? d.htmlId ?? d.tag.toLowerCase(), ...pos(r), width: round(r.w), height: round(r.h), layout: 'none' };
    if (fills.length) frame.fill = fills.length === 1 ? fills[0] : fills;
    if (radius !== undefined) frame.cornerRadius = radius;
    if (opacity !== undefined) frame.opacity = opacity;
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((k) => ((s[`border${k}Style`] ?? 'none') !== 'none' ? px(s[`border${k}Width`]) : 0));
    const borderColor = ['Top', 'Right', 'Bottom', 'Left'].map((k, i) => sides[i] && color(s[`border${k}Color`])).find(Boolean);
    if (borderColor && sides.some(Boolean)) {
      frame.stroke = borderColor, (frame.strokeAlignment = 'inner');
      frame.strokeWidth = sides.every((v) => v === sides[0]) ? sides[0] : Object.fromEntries(['top', 'right', 'bottom', 'left'].map((k, i) => [k, sides[i]]).filter(([, v]) => v));
    }
    const shadow = boxShadow(s.boxShadow, px);
    if (shadow) frame.effect = shadow;
    if ([s.overflow, s.overflowX, s.overflowY].some((v) => v === 'hidden' || v === 'clip')) frame.clip = true;

    // a box with nothing to draw is just a wrapper: its children go straight into the nearest drawn ancestor
    const visible = d === root || fills.length || frame.stroke || frame.effect || frame.clip;
    const here = visible ? r : parent, kids = visible ? (frame.children = []) : out;
    if (d.text?.trim()) kids.push(textNode(d, s, px, d.textRect ?? r, here));
    for (const c of d.children ?? []) kids.push(...walk(c, here, scale));
    if (visible) out.push(frame);
    if (visible && !frame.children.length) delete frame.children;
    return out;
  };
  const [node] = walk(root, root.rect);
  if (!node) throw new Error('The snapshot produced no layers');
  if (node.type === 'frame') {
    node.clip = true;
    if (!node.fill && color(snapshot.pageBackground)) node.fill = color(snapshot.pageBackground);
    if (['html', 'body'].includes(node.name)) node.name = new URL(snapshot.url).hostname;
  }
  return { pages: [{ name: snapshot.url, nodes: [node] }], fonts: [] };
}

function textNode(d, s, px, rect, parent) {
  const fontSize = px(s.fontSize) || 16, lh = px(s.lineHeight);
  let content = /^pre/.test(s.whiteSpace ?? '') ? d.text : d.text.replace(/\s+/g, ' ').trim();
  if (s.textTransform === 'uppercase') content = content.toUpperCase();
  else if (s.textTransform === 'lowercase') content = content.toLowerCase();
  const t = {
    type: 'text', content, x: round(rect.x - parent.x), y: round(rect.y - parent.y),
    textGrowth: 'fixed-width', width: round(rect.w + 1), // +1: the browser's rounding must not wrap the last word
    fontFamily: (s.fontFamily ?? 'Inter').split(',')[0].trim().replace(/^["']|["']$/g, ''), fontSize: round(fontSize),
  };
  const fill = color(s.color);
  if (fill) t.fill = fill;
  if (s.fontWeight && s.fontWeight !== '400' && s.fontWeight !== 'normal') t.fontWeight = s.fontWeight === 'bold' ? '700' : String(s.fontWeight);
  if (s.fontStyle === 'italic') t.fontStyle = 'italic';
  if (lh) t.lineHeight = round(lh / fontSize);
  if (px(s.letterSpacing)) t.letterSpacing = round(px(s.letterSpacing));
  const align = { center: 'center', right: 'right', end: 'right', justify: 'justify' }[s.textAlign];
  if (align) t.textAlign = align;
  if (/underline/.test(s.textDecorationLine ?? s.textDecoration ?? '')) t.underline = true;
  if (/line-through/.test(s.textDecorationLine ?? s.textDecoration ?? '')) t.strikethrough = true;
  return t;
}

function cornerRadius(s, r, px) {
  const v = ['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].map((k) => {
    const raw = s[`border${k}Radius`] ?? '';
    return round(Math.min(/%$/.test(raw) ? (parseFloat(raw) / 100) * Math.min(r.w, r.h) : px(raw.split(' ')[0]), Math.min(r.w, r.h) / 2));
  });
  if (v.every((x) => !x)) return;
  return v.every((x) => x === v[0]) ? v[0] : v;
}

// Chrome's computed form: "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, ..." (first shadow only)
function boxShadow(v, px) {
  if (!v || v === 'none') return;
  const first = v.split(/,(?![^(]*\))/)[0], c = color(/^(\w+\([^)]*\)|#\w+)/.exec(first.trim())?.[1]);
  const [x = 0, y = 0, blur = 0, spread = 0] = (first.match(/-?[\d.]+px/g) ?? []).map(px);
  if (!c) return;
  return { type: 'shadow', shadowType: /inset/.test(first) ? 'inner' : 'outer', color: c, ...((x || y) && { offset: { x, y } }), ...(blur && { blur }), ...(spread && { spread }) };
}

// CSS color → #rrggbb[aa]: rgb()/rgba(), oklch(), oklab(), color(srgb ...), #hex. Fully transparent → undefined.
export function color(v) {
  if (!v || v === 'transparent' || v === 'none') return;
  if (v[0] === '#') return v.length === 4 ? `#${[...v.slice(1)].map((c) => c + c).join('')}` : v;
  const m = /^([\w-]+)\((.*)\)$/.exec(v.trim());
  if (!m) return;
  const parts = m[2].replace(/[,/]/g, ' ').split(/\s+/).filter(Boolean).filter((p) => p !== 'srgb');
  const num = (p, scale = 1) => (p.endsWith('%') ? (parseFloat(p) / 100) * scale : parseFloat(p));
  const a = parts[3] !== undefined ? num(parts[3]) : 1;
  let rgb;
  if (/^rgba?$/.test(m[1])) rgb = parts.slice(0, 3).map((p) => num(p, 255) / 255);
  else if (m[1] === 'color' && /srgb/.test(m[2])) rgb = parts.slice(0, 3).map((p) => num(p));
  else if (m[1] === 'oklch') { const l = num(parts[0]), c = num(parts[1], 0.4), h = (parseFloat(parts[2]) || 0) * Math.PI / 180; rgb = oklab(l, c * Math.cos(h), c * Math.sin(h)); }
  else if (m[1] === 'oklab') rgb = oklab(num(parts[0]), num(parts[1], 0.4), num(parts[2], 0.4));
  if (!rgb || !(a > 0)) return;
  const s = [...rgb, a].map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('');
  return `#${s.endsWith('ff') ? s.slice(0, 6) : s}`;
}

function oklab(L, a, b) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
}

const round = (v) => Math.round(v * 100) / 100;
