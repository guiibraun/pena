// Google Fonts for the Skia canvas: Skia needs the font files themselves, and the browser only gets WOFF2 subsets
// split by unicode-range. Asked without a browser user agent, Google returns whole TTFs (variable when possible),
// which we cache in ~/.pena/fonts so fonts work offline after the first use.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { unzipSync } from 'fflate';
import { PENA_DIR } from './library.mjs';

const DIR = path.join(PENA_DIR, 'fonts');
const UA = 'pena'; // anything that isn't a browser gets TTF

const cached = (key, make) => {
  const file = path.join(DIR, key);
  if (fs.existsSync(file)) return fs.promises.readFile(file);
  return make().then((buf) => (fs.mkdirSync(DIR, { recursive: true }), fs.writeFileSync(file, buf), buf));
};
const get = async (url) => {
  const r = await fetch(url, { headers: { 'user-agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
};

// -> [{ weight: '100 900' | '400', style: 'normal' | 'italic', url: '/fonts/file/<key>' }]
export async function faces(family) {
  const key = `${crypto.createHash('sha1').update(family).digest('hex')}.css`;
  const css = (await cached(key, async () => {
    for (const q of [':ital,wght@0,100..900;1,100..900', ':wght@100..900', ':ital,wght@0,400;0,700;1,400;1,700', ''])
      try { return await get(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}${q}`); } catch {}
    return Buffer.from('');
  })).toString();
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, b]) => {
    const src = /url\((https:[^)]+)\)/.exec(b)?.[1];
    return src && {
      weight: /font-weight:\s*([^;]+);/.exec(b)?.[1].trim() ?? '400',
      style: /font-style:\s*([^;]+);/.exec(b)?.[1].trim() ?? 'normal',
      url: `/fonts/file/${Buffer.from(src).toString('base64url')}`,
    };
  }).filter(Boolean);
}

export async function file(token) {
  const src = Buffer.from(token, 'base64url').toString();
  if (!/^https:\/\/fonts\.gstatic\.com\//.test(src)) throw new Error('not a Google font');
  return cached(`${crypto.createHash('sha1').update(src).digest('hex')}${path.extname(src)}`, () => get(src));
}

// Lato as design tools have it: Figma uses Lato 2.0 (nine weights, wider spacing); Google Fonts still serves Lato 1
// (five weights), so imported Figma text set in Lato would wrap differently and lose Medium/Semibold. Downloaded once
// (SIL OFL, latofonts.com) into the font cache.
const LATO2 = 'https://www.latofonts.com/files/Lato2OFL.zip';
const LATO2_NAMES = { 100: 'Hairline', 200: 'Thin', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Heavy', 900: 'Black' };
let lato2Zip;
// -> { file: 'Lato-Medium.ttf', bytes } for the closest weight
export async function lato2(weight = 400, italic = false) {
  const w = Math.min(900, Math.max(100, Math.round(weight / 100) * 100));
  const file = `Lato-${LATO2_NAMES[w]}${italic ? 'Italic' : ''}.ttf`.replace('RegularItalic', 'Italic');
  const bytes = await cached(`lato2-${file}`, async () => {
    lato2Zip ??= get(LATO2).then((zip) => unzipSync(new Uint8Array(zip)));
    const entry = Object.entries(await lato2Zip).find(([name]) => name.endsWith(`/${file}`));
    if (!entry) throw new Error(`${file} not in Lato 2.0`);
    return Buffer.from(entry[1]);
  });
  return { file, bytes };
}
