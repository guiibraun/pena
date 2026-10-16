// Where public/, skills/ and canvaskit live: this folder in a checkout; Pena.app/Contents/Resources (PENA_ROOT,
// set by the desktop app) when running as the compiled sidecar (`bun build --compile`).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COMPILED = import.meta.url.includes('/$bunfs/');
export const ROOT = process.env.PENA_ROOT ?? (COMPILED ? path.join(path.dirname(process.execPath), '..', 'Resources') : path.dirname(fileURLToPath(import.meta.url)));
