// CanvasKit (Skia compiled to WASM, the same engine pen.dev ships in pencil.wasm) plus the font store.
// Skia shapes text itself, so it needs the font files: the .pen file's own fonts first, then Google Fonts
// (proxied as TTF by the server). Fonts load on demand; `onFont` fires when a new one is ready so text re-measures.

let ck;
export async function initSkia() {
  if (ck) return ck;
  if (!globalThis.CanvasKitInit)
    await new Promise((ok, fail) => document.head.append(Object.assign(document.createElement('script'), { src: '/vendor/canvaskit.js', onload: ok, onerror: fail })));
  ck = await globalThis.CanvasKitInit({ locateFile: (f) => `/vendor/${f}` });
  fonts.init();
  return ck;
}
export const CK = () => ck;

const parseWeight = (w) => (w == null ? [400, 400] : String(w).split(/\s+/).map(Number).concat(Number(String(w).split(/\s+/)[0])).slice(0, 2));
const WEIGHTS = { thin: 100, extralight: 200, light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
export const weightOf = (w) => (typeof w === 'number' ? w : WEIGHTS[String(w ?? '').toLowerCase().replace(/[\s_-]/g, '')] ?? (Number(w) || 400));

export const fonts = {
  provider: null,
  collection: null,
  loaded: new Set(), // "family|weight|italic" requests that are settled (loaded or failed)
  pending: new Map(), // key -> promise
  families: new Map(), // family -> promise of faces [{ weight:[lo,hi], style, url }]
  docFaces: [], // the document's own @font-face entries
  listeners: new Set(),
  version: 0, // bumps whenever a font is registered: cached paragraphs are rebuilt
  init() {
    this.provider = ck.TypefaceFontProvider.Make();
    this.rebuild();
  },
  rebuild() {
    this.collection?.delete();
    this.collection = ck.FontCollection.Make();
    this.collection.setDefaultFontManager(this.provider);
    this.collection.enableFontFallback();
    this.version++;
  },
  setDocFonts(list = [], assetUrl) {
    const before = JSON.stringify(this.docFaces);
    this.docFaces = list.filter((f) => f.url).map((f) => ({ family: f.name, weight: parseWeight(Array.isArray(f.weight) ? f.weight.join(' ') : f.weight), style: f.style ?? 'normal', url: assetUrl(f.url) }));
    // the document now brings its own files for these families (e.g. an import): forget what was resolved before
    if (JSON.stringify(this.docFaces) !== before) {
      const own = new Set(this.docFaces.map((f) => f.family));
      for (const k of [...this.loaded, ...this.aliases.keys()]) if (own.has(k.split('|')[0])) this.loaded.delete(k), this.aliases.delete(k);
    }
  },
  faces(family) {
    const own = this.docFaces.filter((f) => f.family === family);
    if (own.length) return Promise.resolve(own);
    if (!this.families.has(family))
      this.families.set(family, fetch(`/fonts/faces?family=${encodeURIComponent(family)}`).then((r) => r.json()).then((l) => l.map((f) => ({ ...f, weight: parseWeight(f.weight) }))).catch(() => []));
    return this.families.get(family);
  },
  closest(faces, weight, italic) {
    const style = italic ? 'italic' : 'normal';
    const pool = faces.filter((f) => f.style === style).length ? faces.filter((f) => f.style === style) : faces;
    const dist = (f) => (weight < f.weight[0] ? f.weight[0] - weight : weight > f.weight[1] ? weight - f.weight[1] : 0);
    return [...pool].sort((a, b) => dist(a) - dist(b))[0];
  },
  aliases: new Map(), // "family|weight|italic" -> registered alias of the chosen face
  urlAlias: new Map(), // face url -> promise of its alias (each font file is registered once under its own name, like pen.dev)
  // the registered alias for a request, or null if not loaded (yet)
  alias(family, weight = 400, italic = false) { return this.aliases.get(`${family}|${weight}|${italic}`) ?? null; },
  // Load the closest face of a family; resolves when done (also on failure). Already-settled requests are free.
  ensure(family, weight = 400, italic = false) {
    if (!family) return null;
    const key = `${family}|${weight}|${italic}`;
    if (this.loaded.has(key)) return null;
    if (this.pending.has(key)) return this.pending.get(key);
    const p = this.faces(family).then(async (faces) => {
      const face = this.closest(faces, weight, italic);
      if (!face) return;
      if (!this.urlAlias.has(face.url)) {
        // named now, not when the file arrives: by then other faces are in the map and they'd all share one alias
        // (one family with every weight: Skia then picks the wrong one, e.g. Roboto 500 drawn as 700)
        const alias = `${family}#${this.urlAlias.size}`;
        this.urlAlias.set(face.url, fetch(face.url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null).then((bytes) => {
          if (!bytes) return null;
          this.provider.registerFont(bytes, alias);
          this.rebuild();
          return alias;
        }));
      }
      const alias = await this.urlAlias.get(face.url);
      if (alias) this.aliases.set(key, alias);
    }).finally(() => {
      this.loaded.add(key);
      this.pending.delete(key);
      for (const fn of this.listeners) fn(family);
    });
    this.pending.set(key, p);
    return p;
  },
};
