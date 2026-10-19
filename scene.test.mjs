import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { initSkia, CK } from './public/skia.js';
import { Scene } from './public/scene.js';

globalThis.CanvasKitInit = () => CanvasKitInit({ locateFile: () => fileURLToPath(import.meta.resolve('canvaskit-wasm/bin/canvaskit.wasm')) });
await initSkia();
const ck = CK();
const doc = { children: [{ id: 'page', type: 'frame', layout: 'none', x: 30, y: 40, width: 400, height: 6000, fill: '#FFFFFF', opacity: 0.8, children: [
  { id: 'block', type: 'rectangle', x: 20, y: 980, width: 300, height: 120, fill: '#FF0000', opacity: 0.5 },
  { id: 'below', type: 'rectangle', x: 20, y: 4000, width: 300, height: 100, fill: '#0000FF' },
  { id: 'detail', type: 'rectangle', x: 200, y: 1024, width: 1, height: 1, fill: '#0000FF' },
] }] };
const scene = new Scene(doc);
scene.build(doc.children);

function render(top, zoom = 1, partial = false, options = {}) {
  const surface = ck.MakeSurface(800, 600), canvas = surface.getCanvas();
  canvas.clear(ck.TRANSPARENT);
  canvas.scale(zoom, zoom);
  canvas.translate(0, -top);
  const pending = scene.draw(canvas, [0, top, 800 / zoom, top + 600 / zoom], zoom, { partial, ...options });
  const image = surface.makeImageSnapshot();
  const pixels = image.readPixels(0, 0, { width: 800, height: 600, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
  image.delete(); surface.delete();
  const sample = (x, y) => [...pixels.slice((Math.floor((y - top) * zoom) * 800 + Math.floor(x * zoom)) * 4, (Math.floor((y - top) * zoom) * 800 + Math.floor(x * zoom)) * 4 + 4)];
  sample.pending = pending;
  return sample;
}
const near = (actual, expected) => {
  assert.equal(actual.length, 4);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= 1, `${actual} != ${expected}`));
};

// A translucent block straddles the recording boundary: no missing/doubled strip.
for (const [top, zoom, partial] of [[900, 1, false], [1000, 1, false], [1000, 1.3, true], [1000, 2, false], [900, 1, false]]) {
  const pixel = render(top, zoom, partial);
  for (const y of [1063, 1064, 1065]) near(pixel(60, y), [255, 128, 128, 204]);
  near(pixel(20, 1080), [0, 0, 0, 0]);
  near(pixel(360, 1080), [255, 255, 255, 204]);
}

// Moving a page keeps its content aligned with the page, including cached areas.
scene.previewMove('page', 30, 163);
near(render(1123)(60, 1187), [255, 128, 128, 204]);
near(render(4000)(60, 4200), [0, 0, 255, 204]);

// Editing a page replaces old recordings, even after partial drawing and zooming.
doc.children[0].children[0].fill = '#00FF00';
scene.rebuild(doc.children, new Set(['page']));
near(render(1000)(60, 1064), [128, 255, 128, 204]);
scene.touch();

// Zoom previews reuse visible content, then restore fine detail as the budget allows.
render(0, 0.01);
near(render(1000, 1, false, { interactive: true })(230, 1064), [128, 255, 128, 204]);
const deferred = render(1000, 1, false, { budgetMs: 0 });
assert.equal(deferred.pending, true);
near(deferred(230, 1064), [128, 255, 128, 204]);
const refined = render(1000);
assert.equal(refined.pending, false);
near(refined(230, 1064), [0, 0, 255, 204]);
scene.touch();

// Small refinement budgets must still make progress past already-refined pages.
for (const [id, x] of [['second', 500], ['third', 650]]) doc.children.push({
  id, type: 'frame', layout: 'none', x, y: 40, width: 100, height: 6000, fill: '#FFFFFF',
  children: [{ id: `${id}-detail`, type: 'rectangle', x: 20, y: 1024, width: 1, height: 1, fill: '#0000FF' }],
});
scene.build(doc.children);
render(0, 0.01);
let completed;
for (let i = 0; i < 3; i++) completed = render(1000, 1, false, { budgetMs: Number.MIN_VALUE });
assert.equal(completed.pending, false);
near(completed(520, 1064), [0, 0, 255, 255]);
near(completed(670, 1064), [0, 0, 255, 255]);
scene.touch();
console.log('ok    scene rendering (tile boundaries, opacity, pan, zoom preview/refinement, move, edits)');
