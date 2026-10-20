// Shaders in pen.dev's format: shader fills and the `shader` effect point to a GLSL ES fragment shader whose uniforms
// carry `/** @directive */` annotations (observed in pen.dev's bundle with REA). Skia runs SkSL, not GLSL, so the source
// is rewritten here the way pen.dev does it: uniforms stay, every sampler2D becomes a child shader read through one
// helper (texture2D(t, uv) samples child t at uv * its size), gl_FragCoord/gl_FragColor become globals and main()
// returns the color. The annotations describe the panel controls and the uniforms bound automatically:
//   @resolution  vec2  size of the shaded area, in px        @time   float  seconds (0 in exports)
//   @mouse       vec2  center of the area                    @color  vec3/vec4 from a hex color
//   @content     sampler2D  the node itself, rendered (`pencil:object`, transparent outside)
//   @backdrop    sampler2D  what is behind the node (`pencil:background`, mirrored at the edges)
//   @sdf         sampler2D  signed distance to the shape: r = px (positive inside), gb = inward normal, y up
//   @label @default @range a, b  (@min @max)  @mipmap      controls only
// Like GLSL, gl_FragCoord has its origin at the bottom-left; texture coordinates have v up.
import { CK } from './skia.js';

// ---------------------------------------------------------------- annotations
const FLAGS = ['color', 'resolution', 'time', 'mouse', 'sdf', 'content', 'backdrop'];
const QUAL = '(?:(?:lowp|mediump|highp)\\s+)?';
const UNIFORM = new RegExp(`\\buniform\\s+${QUAL}(\\w+)\\s+([^;]+);`, 'g');

function directives(comment) {
  const out = {};
  for (const line of comment.replace(/^\/\*\*|\*\/$/g, '').split('\n')) {
    const s = line.replace(/^\s*\*\s?/, '').trim();
    if (!s.startsWith('@')) continue; // plain description
    for (const [, key, raw] of s.matchAll(/@(\w+)\s*([^@]*)/g)) {
      const arg = raw.trim().replace(/^\((.*)\)$/, '$1').trim();
      const nums = () => arg.split(',').map((x) => Number(x.trim()));
      if (FLAGS.includes(key)) out[key] = true;
      else if (key === 'label') out.label = arg;
      else if (key === 'range') [out.min, out.max] = nums();
      else if (key === 'min' || key === 'max') out[key] = Number(arg);
      else if (key === 'mipmap') out.mipmap = arg !== 'false';
      else if (key === 'default') {
        const list = nums();
        out.default = arg === 'true' ? true : arg === 'false' ? false : arg.startsWith('#') || list.some(Number.isNaN) ? arg : list.length === 1 ? list[0] : list;
      }
    }
  }
  return out;
}

// The shader's uniforms with their annotations: [{ name, type, label?, default?, min?, max?, color?, time?, ... }].
// `role` tells what a sampler reads: 'pencil:object' | 'pencil:background' | 'sdf' | an image url | undefined.
export function parseUniforms(src) {
  const out = [];
  let doc = null, docEnd = -1;
  for (const m of src.matchAll(new RegExp(`/\\*[\\s\\S]*?\\*/|//[^\\n]*|${UNIFORM.source}`, 'g'))) {
    if (m[0].startsWith('/*')) { doc = m[0].startsWith('/**') ? m[0] : null; docEnd = m.index + m[0].length; continue; }
    if (m[0].startsWith('//')) continue;
    const notes = doc && !src.slice(docEnd, m.index).trim() ? directives(doc) : {};
    doc = null;
    for (const d of m[2].split(',')) {
      const name = /^\s*(\w+)/.exec(d)?.[1];
      if (!name) continue;
      const u = { name, type: m[1], ...notes };
      if (u.type === 'sampler2D') u.role = u.content ? 'pencil:object' : u.backdrop ? 'pencil:background' : u.sdf ? 'sdf' : typeof u.default === 'string' ? u.default : undefined;
      out.push(u);
    }
  }
  return out;
}
// uniforms the user sets (everything not bound automatically)
export const controls = (uniforms) => uniforms.filter((u) => !u.resolution && !u.time && !u.mouse && !u.sdf && !u.content && !u.backdrop);
export const isAnimated = (uniforms) => uniforms.some((u) => u.time);

// ---------------------------------------------------------------- GLSL -> SkSL
const SIZE = (i) => `pena_size${i}`;
export function toSkSL(src) {
  // comments out, newlines kept so compile errors point at the right line
  let code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
  let v300 = false;
  const defines = [];
  code = code.replace(/^[ \t]*#[ \t]*(\w+)(.*)$/gm, (_, dir, rest) => {
    if (dir === 'version') { v300 = parseInt(rest, 10) >= 300; return ''; }
    if (dir === 'extension' || dir === 'pragma') return '';
    if (dir !== 'define') throw new Error(`#${dir} is not supported (only #define NAME value)`);
    const m = /^\s+(\w+)(\()?\s*(.*)$/.exec(rest);
    if (!m || m[2]) throw new Error('Only object-like macros are supported: #define NAME value');
    defines.push([m[1], m[3].trim()]);
    return '';
  });
  const expand = (s, list) => list.reduce((acc, [name, value]) => acc.replace(new RegExp(`\\b${name}\\b`, 'g'), value), s);
  defines.forEach((d, i) => (d[1] = expand(d[1], defines.slice(0, i))));
  code = expand(code, defines).replace(/\bprecision\s+\w+\s+\w+\s*;/g, '');
  if (/\b(varying|attribute)\b/.test(code) || /(^|[;}])\s*in\s+\w+\s+\w+\s*;/m.test(code)) throw new Error('The shader can only use gl_FragCoord and uniforms (no varyings).');

  const decls = [], samplers = [], bools = new Map();
  code = code.replace(UNIFORM, (all, type, list) => {
    for (const d of list.split(',')) {
      const name = /^\s*(\w+)/.exec(d)[1], rest = d.trim().slice(name.length);
      if (type === 'sampler2D') { samplers.push(name); decls.push(`uniform shader ${name};`); }
      // SkSL has no bool uniforms: an int, read back as a bool wherever it is used
      else if (/^(bool|bvec[234])$/.test(type)) { bools.set(name, type === 'bool' ? `(${name} != 0)` : `bool${type.slice(-1)}(${name})`); decls.push(`uniform ${type === 'bool' ? 'int' : `int${type.slice(-1)}`} ${name}${rest};`); }
      else decls.push(`uniform ${type} ${name}${rest};`);
    }
    return all.replace(/[^\n]/g, ''); // keep the line count, so errors point at the source's lines
  });
  let color = null;
  code = code.replace(new RegExp(`(^|[;}\\s])out\\s+${QUAL}vec4\\s+(\\w+)\\s*;`), (_, pre, name) => ((color = name), pre));
  if (!color && /\bgl_FragColor\b/.test(code)) color = 'pena_color';
  if (!color) throw new Error('No color output found: write gl_FragColor (or `out vec4` with #version 300 es).');
  const sampler = new Map(samplers.map((s, i) => [s, String(i)]));
  const rename = { gl_FragColor: 'pena_color', gl_FragCoord: 'pena_coord', texture2D: 'pena_tex', texture2DLod: 'pena_tex', textureSize: 'pena_texSize', sampler2D: 'int', ...(v300 && { texture: 'pena_tex', textureLod: 'pena_tex' }) };
  code = code.replace(/(\.\s*)?\b[A-Za-z_]\w*\b/g, (id, dot) => (dot ? id : rename[id] ?? sampler.get(id) ?? bools.get(id) ?? id));

  const head = /\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{/.exec(code);
  if (!head) throw new Error('main() is missing!');
  let depth = 0, end = -1;
  for (let i = head.index + head[0].length - 1; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error('main() is not closed');
  const body = code.slice(head.index + head[0].length, end).replace(/\breturn\s*;/g, `return ${color};`);
  code = `${code.slice(0, head.index)}float4 main(float2 pena_p) { pena_coord = float4(pena_p, 0.0, 1.0);${body}\nreturn ${color};\n}${code.slice(end + 1)}`;

  const helpers = [
    ...samplers.map((_, i) => `uniform float2 ${SIZE(i)};`),
    `float4 pena_coord;`, `float4 ${color};`,
    `float4 pena_tex(int pena_t, float2 pena_uv) {\n${samplers.map((s, i) => `  if (pena_t == ${i}) return ${s}.eval(pena_uv * ${SIZE(i)});\n`).join('')}  return float4(0.0);\n}`,
    `float4 pena_tex(int pena_t, float2 pena_uv, float pena_lod) { return pena_tex(pena_t, pena_uv); }`,
    `int2 pena_texSize(int pena_t) {\n${samplers.map((_, i) => `  if (pena_t == ${i}) return int2(${SIZE(i)});\n`).join('')}  return int2(1);\n}`,
    `int2 pena_texSize(int pena_t, int pena_lod) { return pena_texSize(pena_t); }`,
  ];
  const prelude = `${v300 ? '#version 300\n' : ''}${decls.join('\n')}\n${helpers.join('\n')}\n`;
  return { sksl: prelude + code, samplers, firstLine: prelude.split('\n').length };
}

// ---------------------------------------------------------------- programs
// Compiled once per source; { effect, uniforms, samplers, sizes, floats, animated } or { error }.
const programs = new Map();
export function program(src) {
  let p = programs.get(src);
  if (p) return p;
  try {
    const { sksl, samplers, firstLine } = toSkSL(src);
    let error = '';
    const effect = CK().RuntimeEffect.Make(sksl, (e) => (error = e));
    // "13: unknown identifier 'x'\n<code>\n^^^" -> "line 3: unknown identifier 'x'" (source lines)
    if (!effect) throw new Error(error.split('\n').filter((l) => /^(error: )?\d+: /.test(l)).map((l) => l.replace(/^(?:error: )?(\d+): /, (_, n) => `line ${Math.max(1, n - firstLine + 1)}: `)).join('\n') || 'The shader does not compile');
    const slots = new Map();
    for (let i = 0; i < effect.getUniformCount(); i++) slots.set(effect.getUniformName(i), effect.getUniform(i));
    const uniforms = parseUniforms(src);
    p = {
      effect, uniforms, floats: effect.getUniformFloatCount(), animated: isAnimated(uniforms),
      samplers: samplers.map((name) => uniforms.find((u) => u.name === name)),
      sizes: samplers.map((_, i) => slots.get(SIZE(i))),
      slots,
    };
  } catch (e) {
    p = { error: String(e.message ?? e) };
  }
  if (programs.size > 200) { const [k, old] = programs.entries().next().value; programs.delete(k); old.effect?.delete(); }
  programs.set(src, p);
  return p;
}

const hexColor = (s, n) => {
  let x = String(s ?? '').replace('#', '');
  if (x.length <= 4) x = [...x].map((c) => c + c).join('');
  const v = [0, 2, 4, 6].map((i) => (x.length > i ? parseInt(x.slice(i, i + 2), 16) / 255 : 1));
  return v.slice(0, n).map((c) => (Number.isFinite(c) ? c : 0));
};
// The uniform buffer: user values (already resolved from variables) over the defaults, plus the automatic ones.
// auto: { resolution: [w, h], time, mouse: [x, y] }; sizes: [w, h] of each sampler, in the order of p.samplers.
export function uniformData(p, values, auto, sizes) {
  const f = new Float32Array(Math.max(1, p.floats)), ints = new Int32Array(f.buffer);
  const put = (slot, v) => {
    if (!slot) return;
    const list = [].concat(v ?? 0).map((x) => (typeof x === 'boolean' ? Number(x) : Number(x) || 0));
    // ponytail: uniform arrays get their first element only (CanvasKit reports no array length)
    for (let k = 0; k < slot.columns * slot.rows; k++) slot.isInteger ? (ints[slot.slot + k] = Math.round(list[k] ?? 0)) : (f[slot.slot + k] = list[k] ?? 0);
  };
  for (const u of p.uniforms) {
    const slot = p.slots.get(u.name);
    if (!slot || u.type === 'sampler2D') continue;
    if (u.resolution) put(slot, auto.resolution);
    else if (u.time) put(slot, auto.time ?? 0);
    else if (u.mouse) put(slot, auto.mouse);
    else {
      const v = values?.[u.name] ?? u.default;
      if (u.color) put(slot, hexColor(typeof v === 'string' ? v : '#ffffff', u.type.endsWith('4') ? 4 : 3));
      else put(slot, v);
    }
  }
  sizes.forEach((s, i) => put(p.sizes[i], s));
  return f;
}

// ---------------------------------------------------------------- signed distance fields
// Rectangles (rounded) and ellipses: exact, computed per pixel. In local px, y down; output y up like GLSL.
let rrectSDF, ovalSDF;
export function shapeSDF(kind, w, h, radii, localMatrix) {
  const ck = CK();
  rrectSDF ??= ck.RuntimeEffect.Make(`
    uniform float4 size; uniform float4 radii; // tl tr br bl
    half4 main(float2 p) {
      float2 b = size.xy * 0.5, q0 = p - b;
      float r = q0.x < 0.0 ? (q0.y < 0.0 ? radii.x : radii.w) : (q0.y < 0.0 ? radii.y : radii.z);
      float2 q = abs(q0) - b + r;
      float d; float2 u;
      if (q.x > 0.0 && q.y > 0.0) { float l = length(q); d = r - l; u = q / l; }
      else { d = r - max(q.x, q.y); u = q.x > q.y ? float2(1.0, 0.0) : float2(0.0, 1.0); }
      float2 n = -sign(q0) * u;
      return half4(d, n.x, -n.y, 1.0);
    }`);
  ovalSDF ??= ck.RuntimeEffect.Make(`
    uniform float4 size;
    half4 main(float2 p) {
      float2 ab = max(size.xy * 0.5, float2(0.001)), pc = p - ab;
      float k0 = length(pc / ab), k1 = length(pc / (ab * ab));
      float d = k1 > 0.0 ? -k0 * (k0 - 1.0) / k1 : min(ab.x, ab.y);
      float2 n = length(pc) > 0.0 ? -normalize(pc / (ab * ab)) : float2(0.0, -1.0);
      return half4(d, n.x, -n.y, 1.0);
    }`);
  return kind === 'oval' ? ovalSDF.makeShader([w, h, 0, 0], localMatrix) : rrectSDF.makeShader([w, h, 0, 0, ...radii], localMatrix);
}

// Anything else (paths, text, a whole rendered node): from the picture's coverage, with a Euclidean distance transform
// (Felzenszwalb & Huttenlocher) on a small CPU raster. Returns { image, scale } with texels covering `box` (local px).
const SDF_TEXELS = 384;
export function pictureSDF(pic, box) {
  const ck = CK(), W = box[2] - box[0], H = box[3] - box[1];
  const k = Math.min(2, SDF_TEXELS / Math.max(W, H, 1)), tw = Math.max(2, Math.ceil(W * k)), th = Math.max(2, Math.ceil(H * k));
  const surface = ck.MakeSurface(tw, th);
  if (!surface) return null;
  const c = surface.getCanvas();
  c.clear(ck.TRANSPARENT); c.scale(k, k); c.translate(-box[0], -box[1]); c.drawPicture(pic);
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: tw, height: th, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
  img.delete(); surface.delete();
  const n = tw * th, inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = px[i * 4 + 3] >= 128 ? 1 : 0;
  const toOut = edt(inside, tw, th, 0), toIn = edt(inside, tw, th, 1);
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = (inside[i] ? Math.sqrt(toOut[i]) - 0.5 : 0.5 - Math.sqrt(toIn[i])) / k;
  const out = new Float32Array(n * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const i = y * tw + x;
    const gx = d[y * tw + Math.min(tw - 1, x + 1)] - d[y * tw + Math.max(0, x - 1)];
    const gy = d[Math.min(th - 1, y + 1) * tw + x] - d[Math.max(0, y - 1) * tw + x];
    const l = Math.hypot(gx, gy) || 1;
    out.set([d[i], gx / l, -gy / l, 1], i * 4);
  }
  const image = ck.MakeImage({ width: tw, height: th, colorType: ck.ColorType.RGBA_F32, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }, new Uint8Array(out.buffer), tw * 16);
  return image && { image, scale: k };
}
// squared distance from each pixel to the nearest pixel whose `inside` equals `target`
function edt(inside, w, h, target) {
  const INF = 1e20, g = new Float64Array(w * h), n = Math.max(w, h);
  const f = new Float64Array(n), out = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let i = 0; i < w * h; i++) g[i] = inside[i] === target ? 0 : INF;
  const pass = (len, get, set) => {
    for (let q = 0; q < len; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s;
      while ((s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])) <= z[k]) k--;
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]; }
    for (let q = 0; q < len; q++) set(q, out[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => g[y * w + x], (y, val) => (g[y * w + x] = val));
  for (let y = 0; y < h; y++) pass(w, (x) => g[y * w + x], (x, val) => (g[y * w + x] = val));
  return g;
}
