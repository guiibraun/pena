// Agents on the canvas, ported from pen.dev (@ha/shared agent-cursor.ts / agent-flash.ts): a colored cursor per
// agent that glides to the node it's working on, a flash ring + scan line on every node it writes or reads, and the
// "generating" glow on frames marked `placeholder: true`. Drawn with Skia over the content texture, in screen space.
import { CK, fonts } from './skia.js';

const CURSOR_PATH = 'M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z';
const SIZE = 24, TIP = [4, 5], PRESENCE = '#607dff';
const FADE_IN = 200, FADE_DELAY = 5000, FADE = 1500, DECAY = 2.5, WOBBLE = 4;
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);
const easeOutCubic = (t) => 1 - (1 - t) ** 3;
const backOut = (t, s = 2) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
const expDecay = (a, b, k, dt) => b + (a - b) * Math.exp(-k * dt);
const flashTiming = (longHold, heightPx) => {
  const hold = longHold ? 1500 : 400;
  return { attack: 200, hold, release: 300, total: 200 + hold + 300, scanDelay: 40, scan: longHold ? Math.min(2000, Math.max(300, (heightPx / 350) * 1000)) : 300, repeat: longHold ? 1.5 : 3 };
};
const rgb = (hex) => { const x = hex.replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255); };

class Cursor {
  constructor(name, color) { Object.assign(this, { name, color, x: 0, y: 0, tx: 0, ty: 0, appear: 0, last: performance.now(), wobble: 0, phase: Math.random() * 6.28, active: false }); }
  faded(now) { return this.appear === 0 || now - this.last > FADE_DELAY + FADE; }
  activate(tx, ty, now, spawn) {
    const was = this.faded(now);
    Object.assign(this, { tx, ty, last: now });
    if (was) { [this.x, this.y] = spawn ?? [tx, ty]; this.appear = now; }
    return was;
  }
  opacity(now) {
    const since = now - this.appear, idle = this.active ? 0 : now - this.last;
    if (since < FADE_IN) return easeOutCubic(clamp01(since / FADE_IN));
    if (idle > FADE_DELAY) return 1 - easeOutCubic(clamp01((idle - FADE_DELAY) / FADE));
    return 1;
  }
  advance(dt, now) {
    dt = Math.min(0.1, Math.max(0, dt));
    this.x = expDecay(this.x, this.tx, DECAY, dt); this.y = expDecay(this.y, this.ty, DECAY, dt);
    this.wobble = expDecay(this.wobble, now - this.last > 250 ? 1 : 0, 3, dt);
  }
}

export function createPresence(scene, { wake }) {
  const cursors = new Map(), flashes = [], pending = [];
  let lastT = performance.now(), cursorPath, labelCache = new Map(), running = new Set();
  // the name pill's font: nothing else may load Inter 500 (a document without it), and without it the pill has no glyphs
  fonts.ensure('Inter', 500)?.then(wake);

  // world point inside a node, biased to its middle (so repeated reads don't stack)
  const pick = (b) => { const tri = () => (Math.random() + Math.random()) / 2; return [b.x + b.w * tri(), b.y + b.h * tri()]; };
  const cursorFor = (name, color) => {
    let c = cursors.get(name);
    if (!c) cursors.set(name, (c = new Cursor(name, color ?? '#808080')));
    if (color) c.color = color;
    return c;
  };
  function resolve(now, cam) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const found = p.nodes.filter((n) => scene.node(n.id));
      if (!found.length && now - p.t < 3000) continue; // the edit's document reload hasn't arrived yet
      pending.splice(i, 1);
      if (!found.length) continue;
      const c = cursorFor(p.agent, p.color);
      const first = scene.node(found[0].id).bounds();
      const center = [(innerWidth / 2 - cam.x) / cam.z, (innerHeight / 2 - cam.y) / cam.z];
      const spawned = c.activate(...pick(first), now, [center[0] + ((Math.random() - 0.5) * 1000) / cam.z, center[1] + ((Math.random() - 0.5) * 1000) / cam.z]);
      const delay = spawned ? 0 : 300; // the cursor gets there first
      found.forEach((n, i) => flashes.push({ id: n.id, color: p.color ?? PRESENCE, long: n.kind === 'read', width: n.kind === 'insert' ? 1 : 2, start: now + delay + Math.random() * 50 + Math.min(i, 20) * 25 }));
    }
  }

  function drawFlash(c, f, now, cam, d) {
    const n = scene.node(f.id);
    if (!n) return false;
    const b = n.bounds(), t = now - f.start;
    const T = flashTiming(f.long, b.h * cam.z);
    if (t < 0) return true;
    if (t > T.total) return false;
    let expand, alpha;
    if (t < T.attack) { const k = backOut(t / T.attack); expand = 30 + (5 - 30) * k; alpha = clamp01(t / T.attack); }
    else if (t < T.attack + T.hold) { expand = 5; alpha = 1; }
    else { const k = easeOutCubic((t - T.attack - T.hold) / T.release); expand = 5 + 3 * k; alpha = 1 - k; }
    const ck = CK(), [r, g, bl] = rgb(f.color);
    const x = (cam.x + b.x * cam.z - expand) * d, y = (cam.y + b.y * cam.z - expand) * d, w = (b.w * cam.z + 2 * expand) * d, h = (b.h * cam.z + 2 * expand) * d;
    const rad = (b.w * cam.z < 20 || b.h * cam.z < 20 ? 0 : 3) * d;
    const rr = ck.RRectXY(ck.XYWHRect(x, y, w, h), rad, rad);
    // scan line: a band sweeping down, transparent -> agent color at 40%
    const st = t - T.scanDelay;
    if (st > 0 && st < T.scan * T.repeat) {
      const pos = (st % T.scan) / T.scan, bandH = Math.max(8 * d, h * 0.35), by = y - bandH + (h + bandH) * pos;
      const p = new ck.Paint();
      p.setShader(ck.Shader.MakeLinearGradient([0, by], [0, by + bandH], [Float32Array.of(r, g, bl, 0), Float32Array.of(r, g, bl, 0.4 * alpha)], [0, 1], ck.TileMode.Clamp));
      c.save(); c.clipRRect(rr, ck.ClipOp.Intersect, true);
      c.drawRect(ck.XYWHRect(x, by, w, bandH), p);
      c.restore(); p.delete();
    }
    const p = new ck.Paint();
    p.setAntiAlias(true); p.setStyle(ck.PaintStyle.Stroke); p.setStrokeWidth(f.width * d); p.setColor(Float32Array.of(r, g, bl, alpha));
    c.drawRRect(rr, p); p.delete();
    return true;
  }

  function label(cur, d) {
    const key = `${cur.name}|${cur.color}|${d}|${fonts.version}`; // rebuilt when a font arrives
    let l = labelCache.get(key);
    if (l) return l;
    for (const [k, old] of labelCache) if (k.startsWith(`${cur.name}|`)) old.para.delete(), labelCache.delete(k);
    const ck = CK(), [r, g, b] = rgb(cur.color);
    const dark = 0.299 * r + 0.587 * g + 0.114 * b > 0.6;
    const style = new ck.ParagraphStyle({ textStyle: { color: dark ? ck.BLACK : ck.WHITE, fontFamilies: [fonts.alias('Inter', 500) ?? 'Inter'], fontSize: 11 * d, fontStyle: { weight: { value: 500 } }, fontVariations: [{ axis: 'wght', value: 500 }] } });
    const pb = ck.ParagraphBuilder.MakeFromFontCollection(style, fonts.collection);
    pb.addText(cur.name); const para = pb.build(); pb.delete(); para.layout(1e6);
    l = { para, w: para.getMaxIntrinsicWidth(), h: para.getHeight() };
    labelCache.set(key, l);
    return l;
  }
  function drawCursor(c, cur, now, cam, d) {
    const o = cur.opacity(now);
    if (o <= 0.01) return;
    const ck = CK();
    cursorPath ??= ck.Path.MakeFromSVGString(CURSOR_PATH);
    const wob = WOBBLE * cur.wobble;
    const sx = (cam.x + cur.x * cam.z + Math.cos(now * 0.003 + cur.phase) * wob) * d, sy = (cam.y + cur.y * cam.z + Math.sin(now * 0.0023 + cur.phase) * wob) * d;
    const k = (SIZE / 24) * d, [r, g, b] = rgb(cur.color);
    c.save();
    c.translate(sx - TIP[0] * k, sy - TIP[1] * k);
    c.scale(k, k);
    const p = new ck.Paint(); p.setAntiAlias(true);
    p.setColor(Float32Array.of(0, 0, 0, 0.85 * o)); p.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, 3.5 / 2, true));
    c.save(); c.translate(0, 1); c.drawPath(cursorPath, p); c.restore();
    p.setMaskFilter(null);
    p.setStyle(ck.PaintStyle.Stroke); p.setStrokeWidth(3); p.setStrokeJoin(ck.StrokeJoin.Round); p.setColor(Float32Array.of(1, 1, 1, o));
    c.drawPath(cursorPath, p);
    p.setStyle(ck.PaintStyle.Fill); p.setColor(Float32Array.of(r, g, b, o));
    c.drawPath(cursorPath, p);
    c.restore();
    // name pill
    const l = label(cur, d), px = sx + 18 * d - TIP[0] * k, py = sy + 18 * d - TIP[1] * k, pad = [2 * d, 5 * d];
    const box = ck.RRectXY(ck.XYWHRect(px, py, l.w + pad[1] * 2, l.h + pad[0] * 2), 2 * d, 2 * d);
    p.setColor(Float32Array.of(0, 0, 0, 0.25 * o)); p.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, 2 * d, true));
    c.drawRRect(box, p); p.setMaskFilter(null);
    p.setColor(Float32Array.of(r, g, b, o)); c.drawRRect(box, p);
    if (o > 0.98) c.drawParagraph(l.para, px + pad[1], py + pad[0]);
    p.delete();
  }

  // frames with `placeholder: true`: two blurred blue blobs orbiting inside, and a blue outline (always blue, like pen.dev)
  let phVersion = -1, placeholders = [];
  function drawPlaceholders(c, now, cam, d) {
    if (phVersion !== scene.version) { phVersion = scene.version; placeholders = [...scene.byId.values()].filter((n) => n.src.placeholder); }
    const ck = CK();
    for (const n of placeholders) {
      if (!scene.node(n.id)) continue;
      const b = n.bounds(), x = (cam.x + b.x * cam.z) * d, y = (cam.y + b.y * cam.z) * d, w = b.w * cam.z * d, h = b.h * cam.z * d;
      if (x > innerWidth * d || y > innerHeight * d || x + w < 0 || y + h < 0) continue;
      const rr = ck.RRectXY(ck.XYWHRect(x, y, w, h), 5 * d, 5 * d), m = Math.max(w, h), cx = x + w / 2, cy = y + h / 2, a = now / 2000;
      const p = new ck.Paint(); p.setAntiAlias(true);
      if (running.size) {
        c.save(); c.clipRRect(rr, ck.ClipOp.Intersect, true);
        p.setColor(Float32Array.of(96 / 255, 125 / 255, 1, 0.5)); p.setMaskFilter(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, Math.max(1, m * 0.2), true));
        for (const off of [0, Math.PI]) c.drawCircle(cx + Math.cos(a + off) * m * 0.5, cy + Math.sin(a + off) * m * 0.5, m * 0.4, p);
        p.setMaskFilter(null); c.restore();
      }
      p.setStyle(ck.PaintStyle.Stroke); p.setStrokeWidth(2 * d); p.setColor(ck.parseColorString('#607dff'));
      c.drawRRect(rr, p); p.delete();
    }
    return running.size > 0 && placeholders.length > 0;
  }

  return {
    // an agent wrote/read nodes (server `agent-nodes` event)
    nodes(ev) { pending.push({ ...ev, t: performance.now() }); wake(); },
    // agent run events keep its cursor alive while it works
    agent(ev) {
      if (ev.kind === 'start') running.add(ev.agent);
      if (ev.kind === 'end') running.delete(ev.agent);
      const c = cursors.get(ev.agent);
      if (c) { c.active = running.has(ev.agent); if (c.active) c.last = performance.now(); }
      wake();
    },
    // draw on the screen canvas; returns true while something is animating
    draw(c, cam, d) {
      const now = performance.now(), dt = (now - lastT) / 1000;
      lastT = now;
      resolve(now, cam);
      let anim = pending.length > 0;
      anim = drawPlaceholders(c, now, cam, d) || anim;
      for (let i = flashes.length - 1; i >= 0; i--) if (drawFlash(c, flashes[i], now, cam, d)) anim = true; else flashes.splice(i, 1);
      for (const [name, cur] of cursors) {
        cur.active = running.has(name);
        cur.advance(dt, now);
        if (!cur.active && cur.appear && now - cur.last > FADE_DELAY + FADE) { cursors.delete(name); continue; }
        if (cur.appear) { drawCursor(c, cur, now, cam, d); anim = true; }
      }
      return anim;
    },
  };
}
