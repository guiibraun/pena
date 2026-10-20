// Shaders (pen.dev's shader fills and effects): the GLSL -> SkSL rewrite, the annotations, and the rendered result.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { initSkia, CK } from './public/skia.js';
import { Scene, assetsSettled, shaderError } from './public/scene.js';
import { parseUniforms, controls, program, toSkSL } from './public/shader.js';
import { penAppFiles } from './library.mjs';
import { execute } from './doc.mjs';
import os from 'node:os';
import path from 'node:path';

globalThis.CanvasKitInit = () => CanvasKitInit({ locateFile: () => fileURLToPath(import.meta.resolve('canvaskit-wasm/bin/canvaskit.wasm')) });
await initSkia();
const ck = CK();

// ---- annotations
const us = parseUniforms(`
/** @resolution */ uniform vec2 u_resolution;
/**
 * @label Glow color
 * @color
 * @default #3444CB
 */
uniform vec3 u_glow;
/** @label Ragged edges @default 16 @range 0, 60 */
uniform float u_ragged, u_other;
uniform float u_plain; // not annotated
/** @content */
uniform sampler2D u_content;
/** @label Map @default ./map.png */
uniform sampler2D u_map;`);
assert.deepEqual(us.map((u) => u.name), ['u_resolution', 'u_glow', 'u_ragged', 'u_other', 'u_plain', 'u_content', 'u_map']);
assert.equal(us[1].label, 'Glow color'); assert.equal(us[1].color, true); assert.equal(us[1].default, '#3444CB');
assert.deepEqual([us[2].label, us[2].default, us[2].min, us[2].max], ['Ragged edges', 16, 0, 60]);
assert.equal(us[3].label, 'Ragged edges'); // one comment, two declarators
assert.equal(us[4].label, undefined);
assert.equal(us[5].role, 'pencil:object'); assert.equal(us[6].role, './map.png');
assert.deepEqual(controls(us).map((u) => u.name), ['u_glow', 'u_ragged', 'u_other', 'u_plain', 'u_map']);

// ---- rewrite: defines, bool uniforms, samplers passed to functions, early return, out vec4
const ok = (src) => { const p = program(src); assert.equal(p.error, undefined, p.error); return p; };
ok(`precision mediump float;
#define TAU 6.2831853
#define HALF (TAU * 0.25)
uniform bool u_on; uniform sampler2D a; uniform sampler2D b;
vec4 pick(sampler2D s, vec2 uv) { return texture2D(s, uv); }
void main() { if (!u_on) { gl_FragColor = vec4(0.0); return; } gl_FragColor = pick(b, gl_FragCoord.xy * HALF) + texture2D(a, vec2(0.5)) * float(textureSize(a, 0).x); }`);
ok(`#version 300 es
precision highp float; uniform sampler2D t; out vec4 color;
void main() { color = texture(t, gl_FragCoord.xy); }`);
assert.throws(() => toSkSL('varying vec2 v; void main() { gl_FragColor = vec4(v, 0.0, 1.0); }'), /no varyings/);
assert.throws(() => toSkSL('void f() { gl_FragColor = vec4(1.0); }'), /main\(\) is missing/);
assert.throws(() => toSkSL('#ifdef X\n#endif\nvoid main() { gl_FragColor = vec4(1.0); }'), /#ifdef is not supported/);
assert.match(program('precision highp float;\nuniform float a,\n  b;\nvoid main() {\n  gl_FragColor = vec4(undefinedThing);\n}').error, /^line 5: unknown identifier 'undefinedThing'$/); // source lines

// every bundled shader compiles and labels its controls
const lib = JSON.parse(fs.readFileSync('public/shaders/library.json', 'utf8'));
for (const { name } of lib) {
  const src = fs.readFileSync(`public/shaders/${name}.glsl`, 'utf8');
  ok(src);
  for (const u of controls(parseUniforms(src))) assert.ok(u.label, `${name}: ${u.name} has no @label`);
}
for (const f of fs.readdirSync('examples/shaders')) assert.equal(fs.readFileSync(`examples/shaders/${f}`, 'utf8'), fs.readFileSync(`public/shaders/${f}`, 'utf8'), `examples/shaders/${f} is a copy of the library`);
// pen.dev's built-in library (from your local Pen install; skipped without one) compiles too
const goodies = penAppFiles(/^out\/editor\/goodies\/.*\.glsl$/);
for (const [file, bytes] of goodies) assert.equal(program(bytes.toString('utf8')).error, undefined, file);
console.log(`ok    ${lib.length} bundled shaders, ${goodies.length} pen.dev shaders compile`);

// ---- rendering
const shaders = {
  // content mirrored left-right, kept as is otherwise
  'mirror.glsl': `/** @resolution */ uniform vec2 r; /** @content */ uniform sampler2D c;
    void main() { vec2 uv = gl_FragCoord.xy / r; gl_FragColor = texture2D(c, vec2(1.0 - uv.x, uv.y)); }`,
  // GL orientation: the bottom 10 px green
  'bottom.glsl': `/** @resolution */ uniform vec2 r; void main() { gl_FragColor = gl_FragCoord.y < 10.0 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(0.0, 0.0, 0.0, 1.0); }`,
  // inverted backdrop
  'invert.glsl': `/** @resolution */ uniform vec2 r; /** @backdrop */ uniform sampler2D b;
    void main() { vec4 c = texture2D(b, gl_FragCoord.xy / r); gl_FragColor = vec4(vec3(1.0) - c.rgb, 1.0); }`,
  // white deeper than 10 px inside the shape, black elsewhere
  'sdf.glsl': `/** @resolution */ uniform vec2 r; /** @sdf */ uniform sampler2D s;
    void main() { float d = texture2D(s, gl_FragCoord.xy / r).r; gl_FragColor = d > 10.0 ? vec4(1.0) : vec4(0.0, 0.0, 0.0, 1.0); }`,
  // user uniforms over defaults, color uniforms, @time present
  'color.glsl': `/** @time */ uniform float t; /** @label Color @color @default #FF0000 */ uniform vec3 col; /** @label Mix @default 1 */ uniform float k;
    void main() { gl_FragColor = vec4(col * k, 1.0); }`,
};
const assetUrl = (u) => `data:text/plain,${encodeURIComponent(shaders[u.replace('./', '')] ?? '')}`;
const rect = (id, x, y, w, h, fill, extra = {}) => ({ id, type: 'rectangle', x, y, width: w, height: h, fill, ...extra });
const doc = { variables: { amount: { type: 'number', value: 0.5 } }, children: [
  // content effect: red left half, blue right half, mirrored by the effect
  { id: 'card', type: 'frame', layout: 'none', x: 0, y: 0, width: 100, height: 40, effect: { type: 'shader', url: './mirror.glsl' }, children: [
    rect('l', 0, 0, 50, 40, '#FF0000'), rect('r', 50, 0, 50, 40, '#0000FF')] },
  rect('gl', 120, 0, 40, 40, { type: 'shader', url: './bottom.glsl' }),
  // backdrop fill over a red parent: cyan
  { id: 'bg', type: 'frame', layout: 'none', x: 0, y: 60, width: 100, height: 60, fill: '#FF0000', children: [rect('glass', 20, 10, 60, 40, { type: 'shader', url: './invert.glsl' })] },
  rect('sdfbox', 120, 60, 60, 60, { type: 'shader', url: './sdf.glsl' }),
  rect('tint', 200, 0, 20, 20, { type: 'shader', url: './color.glsl', uniforms: { col: '#00FF00', k: '$amount' } }),
  rect('broken', 200, 30, 20, 20, { type: 'shader', url: './missing.glsl' }),
  // two effects chain: mirrored twice is the original
  { id: 'twice', type: 'frame', layout: 'none', x: 0, y: 125, width: 20, height: 4, effect: [{ type: 'shader', url: './mirror.glsl' }, { type: 'shader', url: './mirror.glsl' }], children: [
    rect('tl', 0, 0, 10, 4, '#FF0000'), rect('tr', 10, 0, 10, 4, '#0000FF')] },
  // effect @sdf comes from the rendered content (a circle inside a fill-less frame): distance transform
  { id: 'blob', type: 'frame', layout: 'none', x: 180, y: 60, width: 60, height: 60, effect: { type: 'shader', url: './sdf.glsl' }, children: [
    { id: 'dot', type: 'ellipse', x: 0, y: 0, width: 60, height: 60, fill: '#000000' }] },
] };
const scene = new Scene(doc, { assetUrl });
scene.build(doc.children);
function render() {
  const surface = ck.MakeSurface(240, 130), canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  scene.touch();
  scene.draw(canvas, [0, 0, 240, 130], 1);
  const img = surface.makeImageSnapshot();
  const px = img.readPixels(0, 0, { width: 240, height: 130, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
  img.delete(); surface.delete();
  return (x, y) => [...px.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 4)];
}
render(); // requests the shader sources
await assetsSettled();
const at = render();
const near = (a, e, why) => assert.ok(a.every((v, i) => Math.abs(v - e[i]) <= 3), `${why}: ${a} != ${e}`);
near(at(10, 20), [0, 0, 255, 255], 'content effect mirrors the right half to the left');
near(at(90, 20), [255, 0, 0, 255], 'and the left half to the right');
near(at(140, 35), [0, 255, 0, 255], 'gl_FragCoord.y starts at the bottom');
near(at(140, 5), [0, 0, 0, 255], 'top is not the bottom');
near(at(50, 90), [0, 255, 255, 255], 'backdrop sees the red parent behind');
near(at(10, 90), [255, 0, 0, 255], 'parent itself drawn once');
near(at(150, 90), [255, 255, 255, 255], 'sdf: center is deep inside');
near(at(124, 90), [0, 0, 0, 255], 'sdf: 4 px from the edge');
near(at(5, 127), [255, 0, 0, 255], 'two chained effects');
near(at(210, 90), [255, 255, 255, 255], 'content sdf: circle center');
near(at(183, 90), [0, 0, 0, 255], 'content sdf: 3 px inside the circle');
near(at(210, 10), [0, 128, 0, 255], 'user color uniform, number variable resolved');
assert.ok(scene.animated.has('tint'), '@time shaders animate their root');
assert.ok(!scene.animated.has('card'));
assert.match(shaderError(assetUrl('./missing.glsl')), /No color output/); // reported to the panel, not thrown
near(at(210, 40), [0, 0, 0, 0], 'a broken shader draws nothing');
console.log('ok    shader fills and effects render');

// ---- agents: library shaders and their own, next to the .pen
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-shader-')), file = path.join(dir, 'a.pen');
const run = (input) => execute(file, { input }).text;
const listed = JSON.parse(run('return ListShaders()'));
assert.ok(listed.find((s) => s.name === 'glass' && s.kind === 'fill' && s.uniforms.some((u) => u.name === 'u_refraction' && u.label)));
assert.equal(run('return UseShader("pixelate")'), './shaders/pixelate.glsl');
assert.equal(fs.readFileSync(path.join(dir, 'shaders/pixelate.glsl'), 'utf8'), fs.readFileSync('public/shaders/pixelate.glsl', 'utf8'));
assert.equal(run('return WriteShader("mine", "void main() { gl_FragColor = vec4(1.0); }")'), './shaders/mine.glsl');
assert.throws(() => run('WriteShader("bad", "void f() {}")'), /No color output|main/);
assert.throws(() => run('UseShader("../x")'), /Unknown shader/);
fs.rmSync(dir, { recursive: true });
console.log('ok    agent shader api');
