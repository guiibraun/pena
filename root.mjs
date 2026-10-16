// Where public/, skills/ and canvaskit live: this folder in a checkout; Pena.app/Contents/Resources (PENA_ROOT,
// set by the desktop app) when running as the compiled sidecar (`bun build --compile`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPILED = /\/(\$bunfs|~BUN)\//.test(import.meta.url); // bun's virtual fs: /$bunfs/ (macOS), B:/~BUN/ (Windows)
export const ROOT = process.env.PENA_ROOT ?? (COMPILED ? (process.platform === 'win32' ? path.dirname(process.execPath) : path.join(path.dirname(process.execPath), '..', 'Resources')) : path.dirname(fileURLToPath(import.meta.url)));
