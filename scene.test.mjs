import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import CanvasKitInit from 'canvaskit-wasm';
import { initSkia, CK } from './public/skia.js';
import { Scene, LOD_IN, LOD_OUT, useStandIn } from './public/scene.js';

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

// Level of detail: small roots become flat rects (hysteresis), real drawing above, exports never use them.
{
  assert.equal(useStandIn(false, LOD_IN - 1), true);
  assert.equal(useStandIn(false, LOD_IN + 1), false); // not yet a stand-in: stays real until it shrinks below LOD_IN
  assert.equal(useStandIn(true, LOD_OUT - 1), true); // already a stand-in: stays until it grows past LOD_OUT
  assert.equal(useStandIn(true, LOD_OUT + 1), false);
  const lodDoc = { children: [
    { id: 'flat', type: 'frame', layout: 'none', x: 0, y: 0, width: 1000, height: 1000, fill: '#FF0000', children: [{ id: 'dot', type: 'rectangle', x: 0, y: 0, width: 500, height: 1000, fill: '#0000FF' }] },
    { id: 'grad', type: 'frame', layout: 'none', x: 2000, y: 0, width: 1000, height: 1000, fill: { type: 'gradient', colors: [{ color: '#00FF00', position: 0 }, { color: '#00FF00', position: 1 }] } },
  ] };
  const lod = new Scene(lodDoc);
  lod.build(lodDoc.children);
  const paint = (zoom) => {
    const surface = ck.MakeSurface(100, 100), canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);
    canvas.scale(zoom, zoom);
    lod.draw(canvas, [0, 0, 100 / zoom, 100 / zoom], zoom);
    const image = surface.makeImageSnapshot();
    const px = [...image.readPixels(0, 0, { width: 100, height: 100, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }).slice(0, 4)];
    image.delete(); surface.delete();
    return px;
  };
  near(paint(0.04), [0, 0, 255, 255]); // 40 px, between LOD_IN and LOD_OUT but never was a stand-in: real drawing
  near(paint(0.01), [255, 0, 0, 255]); // 10 px: flat red, the blue child is not drawn
  assert.ok(!lod.byId.get('flat')._pic); // and its recording is dropped
  near(paint(0.04), [255, 0, 0, 255]); // was a stand-in: stays flat up to LOD_OUT (hysteresis)
  near(paint(0.06), [0, 0, 255, 255]); // 60 px: real again
  lod.draw(ck.MakeSurface(10, 10).getCanvas(), [2000, 0, 3000, 1000], 0.01); // gradient root: no stand-in
  assert.ok(!lod.byId.get('grad')._lod);
}
console.log('ok    level of detail (stand-in threshold, hysteresis, no recording, gradients keep real drawing)');
// What the stand-in shows: the opaque colour that covers the root, not just the root's own fill
{
  const cover = { children: [
    { id: 'wbg', type: 'frame', layout: 'none', x: 0, y: 0, width: 1000, height: 1000, fill: '#FFFFFF', children: [{ id: 'blue', type: 'rectangle', x: 0, y: 0, width: 1000, height: 1000, fill: '#0000FF' }] },
    { id: 'wrap', type: 'frame', layout: 'none', x: 2000, y: 0, width: 1000, height: 1000, fill: '#FFFFFF', children: [{ id: 'inner', type: 'frame', layout: 'none', x: 0, y: 0, width: 1000, height: 1000, children: [{ id: 'green', type: 'rectangle', x: 0, y: 0, width: 1000, height: 1000, fill: '#00FF00' }] }] },
    { id: 'img', type: 'frame', layout: 'none', x: 4000, y: 0, width: 1000, height: 1000, fill: '#FFFFFF', children: [{ id: 'grad2', type: 'rectangle', x: 0, y: 0, width: 1000, height: 1000, fill: { type: 'gradient', colors: [{ color: '#FF00FF', position: 0 }, { color: '#FF00FF', position: 1 }] } }] },
    { id: 'clear', type: 'frame', layout: 'none', x: 6000, y: 0, width: 1000, height: 1000, fill: '#00000000', children: [{ id: 'dot2', type: 'rectangle', x: 0, y: 0, width: 100, height: 100, fill: '#FF0000' }] },
  ] };
  const sc = new Scene(cover);
  sc.build(cover.children);
  sc.draw(ck.MakeSurface(10, 10).getCanvas(), [-100, -100, 7000, 1100], 0.005);
  assert.deepEqual([...sc.byId.get('wbg')._flat].map((v) => Math.round(v * 255)), [0, 0, 255, 255], 'a covering child decides the colour');
  assert.deepEqual([...sc.byId.get('wrap')._flat].map((v) => Math.round(v * 255)), [0, 255, 0, 255], 'through a see-through wrapper');
  assert.equal(sc.byId.get('img')._flat, null, 'a covering gradient has no stand-in');
  assert.equal(sc.byId.get('clear')._flat, null, 'a transparent root has no stand-in');
}
console.log('ok    level of detail: stand-in colour follows the covering child, not-opaque and image covers keep the real drawing');

