// The canvas view, modeled on pen.dev's SkiaRenderer: the visible scene (plus a 512px margin) is rendered once into
// an offscreen GPU surface; every frame just draws that texture with the camera delta. Pan costs one textured rect;
// the content re-renders after edits, when the viewport leaves the rendered area, or 200 ms after zooming stops.
import { CK } from './skia.js';
import { assetsSettled } from './scene.js';

const PAD = 512; // device px of margin rendered around the viewport
const CACHE_BYTES = 96 * 1024 * 1024;

export function createView(canvasEl, scene, { background = [0.094, 0.094, 0.106, 1], overlay } = {}) {
  const ck = CK();
  let damage = null; // world rect to redraw on the next frame (edits), when the rest of the content is still valid
  let gr, surface, content, snapshot, rendered = null, dirty = true, raf = 0, zoomTimer = 0;
  let cam = { x: 0, y: 0, z: 1 };
  const dpr = () => devicePixelRatio || 1;

  function resize() {
    const r = canvasEl.getBoundingClientRect();
    canvasEl.width = Math.max(1, Math.round(r.width * dpr()));
    canvasEl.height = Math.max(1, Math.round(r.height * dpr()));
    snapshot?.delete(); snapshot = null;
    content?.delete(); content = null;
    surface?.delete();
    if (!gr) {
      const handle = ck.GetWebGLContext(canvasEl, { antialias: 0, alpha: 1, preserveDrawingBuffer: 0 });
      gr = ck.MakeWebGLContext(handle);
      gr.setResourceCacheLimitBytes(CACHE_BYTES); // Skia's default lets glyph atlases/textures grow to 256 MB+
    }
    surface = ck.MakeOnScreenGLSurface(gr, canvasEl.width, canvasEl.height, ck.ColorSpace.SRGB);
    dirty = true;
    frame();
  }

  // Render the scene into the content surface for the current camera.
  function renderContent() {
    const W = canvasEl.width + 2 * PAD, H = canvasEl.height + 2 * PAD;
    if (!content || content.width() !== W || content.height() !== H) {
      content?.delete();
      content = surface.makeSurface({ width: W, height: H, alphaType: ck.AlphaType.Premul, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB });
    }
    const c = content.getCanvas();
    const d = dpr();
    // partial: same camera as the last render, only a damaged area changed
    const partial = damage && !dirty && rendered && rendered.x === cam.x && rendered.y === cam.y && rendered.z === cam.z;
    if (!partial) c.clear(ck.TRANSPARENT);
    c.save();
    c.translate(PAD, PAD);
    c.scale(d, d);
    c.translate(cam.x, cam.y);
    c.scale(cam.z, cam.z);
    // world-space cull rect of the content surface
    let cull = [(-PAD / d - cam.x) / cam.z, (-PAD / d - cam.y) / cam.z, ((canvasEl.width + PAD) / d - cam.x) / cam.z, ((canvasEl.height + PAD) / d - cam.y) / cam.z];
    if (partial) {
      const m = 2 / (cam.z * d); // 2 device px of slack for anti-aliased edges
      cull = [damage[0] - m, damage[1] - m, damage[2] + m, damage[3] + m];
      c.clipRect(ck.LTRBRect(...cull), ck.ClipOp.Intersect, false);
      c.clear(ck.TRANSPARENT);
    }
    damage = null;
    const t = performance.now();
    scene.draw(c, cull, cam.z * d, { partial });
    c.restore();
    snapshot?.delete();
    snapshot = content.makeImageSnapshot();
    rendered = { ...cam };
    dirty = false;
    view.lastRenderMs = performance.now() - t;
  }

  function needsRender() {
    if (dirty || !rendered || damage) return true;
    const k = cam.z / rendered.z;
    if (k > 3 || k < 1 / 3) return true;
    // does the viewport still fit inside the rendered area?
    const d = dpr();
    const dx = (cam.x - rendered.x * k) * d, dy = (cam.y - rendered.y * k) * d; // offset of rendered origin (scaled)
    const left = dx - PAD * k, top = dy - PAD * k;
    const right = left + (canvasEl.width + 2 * PAD) * k, bottom = top + (canvasEl.height + 2 * PAD) * k;
    return left > 0 || top > 0 || right < canvasEl.width || bottom < canvasEl.height;
  }

  function draw() {
    raf = 0;
    if (!surface) return;
    if (needsRender()) renderContent();
    const c = surface.getCanvas();
    c.clear(Float32Array.from(background));
    const k = cam.z / rendered.z, d = dpr();
    c.save();
    // content pixel u maps to screen device px: (cam.x - k*rendered.x)*d + k*(u - PAD)
    c.translate((cam.x - k * rendered.x) * d - k * PAD, (cam.y - k * rendered.y) * d - k * PAD);
    c.scale(k, k);
    if (k === 1) c.drawImage(snapshot, 0, 0, null);
    else c.drawImageOptions(snapshot, 0, 0, ck.FilterMode.Linear, ck.MipmapMode.None, null);
    c.restore();
    overlay?.(c, cam, d);
    surface.flush();
  }
  const frame = () => { if (!raf) raf = requestAnimationFrame(draw); };

  const view = {
    lastRenderMs: 0,
    setCamera(next) {
      const zoomed = next.z !== cam.z;
      cam = { ...next };
      if (zoomed) { clearTimeout(zoomTimer); zoomTimer = setTimeout(() => { dirty = true; frame(); }, 200); }
      frame();
    },
    invalidate() { dirty = true; frame(); },
    // redraw only a world-space area [x0, y0, x1, y1] (falls back to a full render if the camera moved)
    damage(r) { damage = damage ? [Math.min(damage[0], r[0]), Math.min(damage[1], r[1]), Math.max(damage[2], r[2]), Math.max(damage[3], r[3])] : [...r]; frame(); },
    renderNow() { dirty = true; draw(); },
    resize,
    // render a node (or the whole scene) to PNG/JPEG/WebP bytes at a scale, on a CPU surface
    async exportImage(node, scale = 2, format = 'png', quality = 92) {
      view.drawExport(node, scale, format, quality); // first pass requests the images/icons at this scale
      await assetsSettled();
      return view.drawExport(node, scale, format, quality);
    },
    drawExport(node, scale, format, quality) {
      const b = node.bounds(), [w, h] = [Math.max(1, Math.ceil(b.w * scale)), Math.max(1, Math.ceil(b.h * scale))];
      // GPU surface: images are textures; reading the result back works on it
      const s = surface.makeSurface({ width: w, height: h, alphaType: ck.AlphaType.Premul, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB });
      const c = s.getCanvas();
      if (format !== 'png' && format !== 'webp') c.clear(ck.WHITE); else c.clear(ck.TRANSPARENT);
      c.scale(scale, scale);
      c.translate(-b.x, -b.y);
      const pm = node.parent ? node.parent.worldMatrix() : [1, 0, 0, 0, 1, 0, 0, 0, 1];
      c.concat(pm);
      scene.drawNode(c, node, [b.x - 1e5, b.y - 1e5, b.x + 1e5, b.y + 1e5], scale, pm);
      const img = s.makeImageSnapshot();
      const bytes = img.encodeToBytes(ck.ImageFormat[{ png: 'PNG', jpeg: 'JPEG', jpg: 'JPEG', webp: 'WEBP' }[format] ?? 'PNG'], quality);
      img.delete(); s.delete();
      return bytes;
    },
  };
  new ResizeObserver(resize).observe(canvasEl);
  resize();
  return view;
}
