// Accounts: an extra login of a provider gets its own CLI config dir (env var), the defaults keep the CLI's own
// login, and the default account can't be removed. Runs in a throwaway HOME so it never touches ~/.pena.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pena-accounts-'));
const script = `
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accounts, addAccount, removeAccount } from './settings.mjs';
const ids = () => accounts().map((a) => a.id).join(' ');
assert.equal(ids(), 'claude codex opencode');
assert.deepEqual(accounts().map((a) => a.env), [{}, {}, {}]);

const work = addAccount('claude', 'Trabalho');
assert.equal(work.id, 'claude-2');
assert.equal(work.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), '.pena', 'accounts', 'claude-2'));
assert.ok(fs.existsSync(work.env.CLAUDE_CONFIG_DIR));

const personal = addAccount('codex', 'Pessoal');
assert.equal(personal.id, 'codex-2');
assert.equal(personal.env.CODEX_HOME, path.join(os.homedir(), '.pena', 'accounts', 'codex-2'));
assert.equal(addAccount('claude', '').id, 'claude-3');
assert.equal(accounts().find((a) => a.id === 'claude-3').name, 'Conta 3');

assert.throws(() => addAccount('opencode', 'x'), /único login/);
assert.throws(() => removeAccount('claude'), /padrão/);
removeAccount(work.id);
assert.equal(ids(), 'claude codex opencode codex-2 claude-3');
`;
try {
  execFileSync(process.execPath, ['-e', script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
console.log('ok    accounts');
