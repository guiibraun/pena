// Compile the server for this machine, named as Tauri's externalBin wants: binaries/pena-server-<target triple>[.exe]
import { execFileSync } from 'node:child_process';

const triple = /host: (\S+)/.exec(execFileSync('rustc', ['-vV'], { encoding: 'utf8' }))[1];
const out = `src-tauri/binaries/pena-server-${triple}${process.platform === 'win32' ? '.exe' : ''}`;
execFileSync(process.execPath, ['build', 'sidecar.mjs', '--compile', '--minify', '--outfile', out], { stdio: 'inherit' });
