// Document library for the dashboard: recents, drafts, previews and a small file browser.
// Pena keeps its own state in ~/.pena and also reads (never writes) pen.dev's recents and previews,
// so files you used in pen.dev show up here too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const HOME = os.homedir();
export const PENA_DIR = path.join(HOME, '.pena');
const RECENT = path.join(PENA_DIR, 'recent.json');
export const DRAFTS = path.join(PENA_DIR, 'documents');
const PREVIEWS = path.join(PENA_DIR, 'previews');
// pen.dev locations (read-only)
const PEN_RECENT = path.join(HOME, 'Library', 'Application Support', 'Pen', 'recent-documents.json');
const PEN_DRAFTS = path.join(HOME, '.pencil', 'documents');
const PEN_PREVIEWS = path.join(HOME, '.pencil', 'previews');

const readJson = (f, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fallback;
  }
};
const isDraft = (file) => [DRAFTS, PEN_DRAFTS].some((d) => file.startsWith(d + path.sep));
// Same id scheme as pen.dev: drafts use their folder uuid, other files a sha256 of the path.
const previewId = (file) => (isDraft(file) ? path.basename(path.dirname(file)) : crypto.createHash('sha256').update(file).digest('hex').slice(0, 32));

export function previewFile(file) {
  for (const dir of [PREVIEWS, PEN_PREVIEWS]) {
    const f = path.join(dir, `${previewId(file)}.png`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function savePreview(file, png) {
  fs.mkdirSync(PREVIEWS, { recursive: true });
  fs.writeFileSync(path.join(PREVIEWS, `${previewId(file)}.png`), png);
}

export function recordOpened(file) {
  const list = readJson(RECENT, []).filter((r) => r.path !== file);
  list.unshift({ path: file, openedAt: Date.now() });
  fs.mkdirSync(PENA_DIR, { recursive: true });
  fs.writeFileSync(RECENT, JSON.stringify(list.slice(0, 200), null, 1));
}

export function forget(file) {
  fs.writeFileSync(RECENT, JSON.stringify(readJson(RECENT, []).filter((r) => r.path !== file), null, 1));
}

const describe = (file, openedAt, source) => {
  const st = fs.statSync(file);
  const draft = isDraft(file);
  return {
    path: file,
    name: path.basename(file),
    folder: draft ? (file.startsWith(PEN_DRAFTS) ? 'Rascunho do Pen' : 'Rascunho') : path.basename(path.dirname(file)),
    openedAt: openedAt || st.mtimeMs,
    modifiedAt: st.mtimeMs,
    createdAt: st.birthtimeMs || st.ctimeMs,
    hasPreview: !!previewFile(file),
    source,
  };
};

export function recents() {
  const pena = readJson(RECENT, []).map((r) => ({ path: r.path, openedAt: r.openedAt, source: 'pena' }));
  const pen = (readJson(PEN_RECENT, {}).documents ?? []).map((d) => {
    try {
      return { path: decodeURIComponent(new URL(d.uri).pathname), openedAt: d.openedAt, source: 'pen' };
    } catch {
      return null;
    }
  });
  const seen = new Map();
  for (const r of [...pena, ...pen].filter(Boolean)) {
    if (!r.path.endsWith('.pen') || !fs.existsSync(r.path) || isDraft(r.path)) continue;
    const prev = seen.get(r.path);
    if (!prev || r.openedAt > prev.openedAt) seen.set(r.path, r);
  }
  return [...seen.values()].map((r) => describe(r.path, r.openedAt, r.source)).sort((a, b) => b.openedAt - a.openedAt);
}

export function drafts() {
  return [DRAFTS, PEN_DRAFTS]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) =>
      fs.readdirSync(d).flatMap((id) => {
        const dir = path.join(d, id);
        if (!fs.statSync(dir).isDirectory()) return [];
        return fs.readdirSync(dir).filter((f) => f.endsWith('.pen')).map((f) => describe(path.join(dir, f), 0, d === DRAFTS ? 'pena' : 'pen'));
      }),
    )
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function newDraft() {
  const dir = path.join(DRAFTS, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'untitled.pen');
}

// Minimal file browser for the browser build (the desktop app uses native dialogs).
export function browse(dir = path.join(HOME, 'Documents')) {
  dir = path.resolve(dir);
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || e.name.endsWith('.pen')))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), kind: e.isDirectory() ? 'dir' : 'pen' }))
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  return { dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, home: HOME, entries };
}
