// Screenshots and raster exports drawn in the server with the editor's own Skia code (public/scene.js on CanvasKit,
// CPU raster): no browser needed. What the browser gave the editor is filled in here: image decoding (CanvasKit),
// SVG rasterizing (resvg) and relative fetches (this server).
import path from 'node:path';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { expandDoc, isConnection } from './public/pen-core.js';

let ck, base, scene, mod, paint;
const assetUrl = (u) => (/^(https?:|data:|blob:)/.test(u) ? u : `/asset/${u.replace(/^\.\//, '')}`); // same as the editor's

// A "bitmap" here is { img: SkImage, width, height }; scene.js only passes it on to MakeLazyImageFromTextureSource.
const bitmap = (img) => ({ img, width: img.width(), height: img.height(), close: () => img.delete() });
const encoded = (bytes) => { const img = ck.MakeImageFromEncoded(bytes); if (!img) throw new Error('Cannot decode image'); return img; };
function scaled(img, w, h) {
  const s = ck.MakeSurface(w, h);
  s.getCanvas().drawImageRectOptions(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(0, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
  const out = s.makeImageSnapshot();
  s.delete();
  return out;
}
const svgPng = (svg, width) => new Resvg(svg, width ? { fitTo: { mode: 'width', value: Math.round(width) } } : {}).render();
class SvgImage { // the editor's `new Image()` only ever decodes SVGs (data: or blob: urls)
  async decode() { this.svg = await (await fetch(this.src)).text(); const r = svgPng(this.svg); this.width = r.width; this.height = r.height; }
}
async function createImageBitmap(src, { resizeWidth, resizeHeight } = {}) {
  if (src instanceof Blob) return bitmap(encoded(new Uint8Array(await src.arrayBuffer())));
  if (src.svg) return bitmap(encoded(svgPng(src.svg, resizeWidth).asPng()));
  return bitmap(scaled(src.img, resizeWidth ?? src.width, resizeHeight ?? src.height));
}

async function init(url) {
  base = url;
  if (mod) return;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, o) => realFetch(typeof u === 'string' && u.startsWith('/') ? base + u : u, o); // relative only: nothing else changes
  Object.assign(globalThis, { devicePixelRatio: 1, Image: SvgImage, createImageBitmap });
  const require = createRequire(import.meta.url);
  const dir = path.dirname(require.resolve('canvaskit-wasm/bin/canvaskit.wasm'));
  const CanvasKitInit = require('canvaskit-wasm');
  globalThis.CanvasKitInit = () => CanvasKitInit({ locateFile: (f) => path.join(dir, f) });
  const skia = await import('./public/skia.js');
  ck = await skia.initSkia();
  ck.MakeLazyImageFromTextureSource = (b) => b.img;
  paint = new ck.Paint();
  mod = { fonts: skia.fonts, ...(await import('./public/scene.js')) };
}

function draw(node, scale, format, quality) {
  const b = node.bounds(), [w, h] = [Math.max(1, Math.ceil(b.w * scale)), Math.max(1, Math.ceil(b.h * scale))];
  const s = ck.MakeSurface(w, h), c = s.getCanvas();
  c.clear(format === 'png' || format === 'webp' ? ck.TRANSPARENT : ck.WHITE);
  c.scale(scale, scale);
  c.translate(-b.x, -b.y);
  const pm = node.parent ? node.parent.worldMatrix() : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  c.concat(pm);
  scene.time = 0; // animated shaders export their first frame
  scene.drawNode(c, node, [b.x - 1e5, b.y - 1e5, b.x + 1e5, b.y + 1e5], scale, pm);
  const img = s.makeImageSnapshot();
  const bytes = img.encodeToBytes(ck.ImageFormat[{ jpeg: 'JPEG', jpg: 'JPEG', webp: 'WEBP' }[format] ?? 'PNG'], quality);
  img.delete(); s.delete();
  return bytes;
}
const shaderProblems = (root) => {
  const out = new Set();
  const walk = (n) => {
    for (const s of [...[].concat(n.src.fill ?? []), ...[].concat(n.src.effect ?? [])])
      if (s?.type === 'shader' && s.url) { const err = mod.shaderError(assetUrl(s.url)); if (err) out.add(`Shader ${s.url} (${n.id}): ${err}`); }
    n.children.forEach(walk);
  };
  walk(root);
  return [...out];
};

export const RASTER = /^(png|jpe?g|webp)$/;
// Same answer as the editor's render-result: [{ id, data: data url, warnings }].
// ponytail: lays out the whole document per call; cache the scene per store.seq if big files render slowly.
export async function render({ ids, format, options: { scale = 2, quality = 92 } = {} }, doc, url) {
  await init(url);
  const { Scene, fonts, refreshShaderSources, assetsSettled } = mod;
  fonts.setDocFonts(doc.fonts, assetUrl);
  scene ??= new Scene(doc, { assetUrl });
  scene.doc = doc;
  await refreshShaderSources();
  scene.build(expandDoc(doc).filter((n) => !isConnection(n)), { layout: false });
  await Promise.race([Promise.all(scene.fontsNeeded().map(([f, w, i]) => fonts.ensure(f, w, i))), new Promise((r) => setTimeout(r, 4000))]);
  scene.relayoutAll();
  const mime = `image/${format === 'jpg' ? 'jpeg' : format}`;
  const results = [];
  for (const id of ids) {
    const node = scene.node(id);
    if (!node) throw new Error(`Node not found on canvas: ${id}`);
    draw(node, scale, format, quality); // first pass requests the images, icons and shaders at this scale
    await assetsSettled();
    scene.touch();
    results.push({ id, data: `data:${mime};base64,${Buffer.from(draw(node, scale, format, quality)).toString('base64')}`, warnings: shaderProblems(node) });
  }
  return results;
}
