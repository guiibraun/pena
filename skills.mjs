// Skills you can attach to a message with "/" (like pen.dev's skill picker). A skill is a folder with a SKILL.md
// whose frontmatter has `name` and `description`; the chosen skill's content rides along with the message.
// Sources: Pena's own guides, ~/.pena/skills, your Claude Code skills, skills pen.dev installed on this Mac
// (read-only), plus any SKILL.md you add by path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const HOME = os.homedir();
const CONFIG = path.join(HOME, '.pena', 'config.json');
const SOURCES = [
  { id: 'pena', label: 'Pena', dir: path.join(HOME, '.pena', 'skills') },
  { id: 'claude', label: 'Claude Code', dir: path.join(HOME, '.claude', 'skills') },
  { id: 'pen', label: 'pen.dev', dir: path.join(HOME, '.pencil', 'skills') },
];
const GUIDES = fileURLToPath(new URL('./skills/pena/guide/', import.meta.url));

const config = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; } };
const saveConfig = (c) => (fs.mkdirSync(path.dirname(CONFIG), { recursive: true }), fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2)));

function frontmatter(content) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  try { return parseYaml(m[1]) ?? {}; } catch { return {}; }
}
const firstLine = (content) => content.replace(/^---[\s\S]*?---/, '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';

function read(file, source, fallbackName) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const fm = frontmatter(content);
    return { name: String(fm.name ?? fallbackName), description: String(fm.description ?? firstLine(content)).trim(), source, path: file };
  } catch {
    return null;
  }
}

export function listSkills() {
  const out = [];
  // Pena's built-in design guides (also readable by the agent through read_skill)
  for (const f of fs.existsSync(GUIDES) ? fs.readdirSync(GUIDES) : [])
    if (f.endsWith('.md')) out.push(read(path.join(GUIDES, f), 'Pena · guia', f.replace(/\.md$/, '')));
  for (const s of SOURCES) {
    if (!fs.existsSync(s.dir)) continue;
    for (const d of fs.readdirSync(s.dir, { withFileTypes: true }))
      if ((d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.')) out.push(read(path.join(s.dir, d.name, 'SKILL.md'), s.label, d.name));
  }
  for (const p of config().customSkills ?? []) out.push(read(p, 'Adicionada', path.basename(path.dirname(p))));
  const seen = new Set();
  return out.filter((s) => s && !seen.has(`${s.source}:${s.name}`) && seen.add(`${s.source}:${s.name}`));
}

export function skillContent(name, source) {
  const s = listSkills().find((x) => x.name === name && (!source || x.source === source)) ?? listSkills().find((x) => x.name === name);
  if (!s) throw new Error(`Skill não encontrada: ${name}`);
  return { ...s, content: fs.readFileSync(s.path, 'utf8') };
}

export function addSkill(p) {
  p = path.resolve(p.replace(/^~(?=\/)/, HOME));
  if (path.basename(p) !== 'SKILL.md') p = path.join(p, 'SKILL.md');
  if (!fs.existsSync(p)) throw new Error('O caminho escolhido não tem um SKILL.md');
  const c = config();
  c.customSkills = [...new Set([...(c.customSkills ?? []), p])];
  saveConfig(c);
  return read(p, 'Adicionada', path.basename(path.dirname(p)));
}

export function removeSkill(p) {
  const c = config();
  c.customSkills = (c.customSkills ?? []).filter((x) => x !== p);
  saveConfig(c);
}
