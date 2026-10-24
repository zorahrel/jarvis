// Cosa leggono gli agenti sul Mac: file di avvio, skill nel listing, doppioni, regole con date vecchie.
// Sola lettura. Nel report finiscono misure e qualche riga mascherata, mai il contenuto dei file.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const DAY = 86400000;
const SKILL_LOADERS = ['Claude Code', 'Codex', 'jcode', 'OpenClaw'];
const OC_FILES = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md', 'MEMORY.md', 'BOOTSTRAP.md'];
const OC_ALL = 'OpenClaw · tutti gli agenti';
const OC_CLI = 'OpenClaw (via claude-cli)';

const tokensOf = (chars) => Math.ceil(chars / 4);

// Telefoni ed email non escono mai dal report.
export function mask(s) {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '…@…')
    .replace(/\+?\d[\d ]{8,}\d/g, '…');
}

async function readFile(p) {
  try {
    const [text, st] = await Promise.all([fs.readFile(p, 'utf8'), fs.stat(p)]);
    if (!st.isFile()) return null;
    return { text, mtime: st.mtimeMs, bytes: st.size };
  } catch { return null; }
}

async function readJson(p) {
  const f = await readFile(p);
  if (!f) return {};
  try { return JSON.parse(f.text) || {}; } catch { return {}; }
}

async function listDirs(dir) {
  let names;
  try { names = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const n of names.sort()) {
    try { if ((await fs.stat(path.join(dir, n))).isDirectory()) out.push(n); } catch { /* link rotto */ }
  }
  return out;
}

// Frontmatter: name e description, su una riga (anche tra virgolette) o a blocco (> e |).
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out = {};
  const unquote = (v) => v.trim().replace(/^(["'])([\s\S]*)\1$/, '$2');
  for (let i = 0; i < lines.length; i++) {
    const k = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!k) continue;
    let v = k[2].trim();
    if (/^[>|][-+]?$/.test(v)) {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(' ');
    }
    out[k[1]] = unquote(v);
  }
  return out;
}

function normalizeLine(line) {
  return line
    .replace(/^\s*(?:[-*>#]+\s*|\d+[.)]\s+)+/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Righe fuori dai blocchi ``` con il loro numero (1-based).
function proseLines(text) {
  const out = [];
  let fence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (!fence) out.push({ line, n: i + 1 });
  });
  return out;
}

function findDates(line, now) {
  const year = new Date(now).getUTCFullYear();
  const found = [];
  const push = (y, mo, d, explicitYear) => {
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return;
    let ts = Date.UTC(y, mo - 1, d);
    if (!explicitYear && ts > now + DAY) ts = Date.UTC(y - 1, mo - 1, d);
    found.push(ts);
  };
  for (const m of line.matchAll(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?![\d/])/g)) {
    push(m[3] ? +m[3] : year, +m[2], +m[1], !!m[3]);
  }
  for (const m of line.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) push(+m[1], +m[2], +m[3], true);
  return found;
}

export function defaultDoctor() {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${process.env.PATH || ''}:${path.join(os.homedir(), 'bin')}` };
    execFile('agents-doctor', ['--fast'], { timeout: 30000, env, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) });
      // exit non zero = il doctor ha risposto; ENOENT o timeout = non ha risposto
      if (typeof err.code === 'number') return resolve({ code: err.code, stdout: String(stdout) });
      resolve({ code: null, stdout: String(stdout || ''), error: err.killed ? 'agents-doctor: timeout 30s' : err.message });
    });
  });
}

export async function contextReport({ home = os.homedir(), now = Date.now(), runDoctor = defaultDoctor } = {}) {
  const tilde = (p) => (p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
  const expand = (p) => (p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);

  const files = [];
  const texts = new Map(); // id -> testo, resta qui dentro
  const add = async (id, label, abs, group, loaders, extra = {}) => {
    const f = await readFile(abs);
    if (!f) return null;
    const chars = f.text.length;
    files.push({
      id, label, path: tilde(abs), group, loaders, bytes: f.bytes, chars, tokens: tokensOf(chars), mtime: f.mtime,
      note: '', includedBy: null, generatedFrom: null, ...extra,
    });
    texts.set(id, f.text);
    return f;
  };

  // 1. CLAUDE.md e inclusioni
  const claudeLoaders = ['Claude Code', OC_CLI];
  const cm = await add('claude-md', 'CLAUDE.md globale', path.join(home, '.claude/CLAUDE.md'), 'Claude Code', claudeLoaders);
  const includeIds = [];
  if (cm) {
    for (const line of cm.text.split(/\r?\n/)) {
      const m = line.match(/^@(\S+)/);
      if (!m || !/^[~/]/.test(m[1])) continue;
      const abs = expand(m[1]);
      const id = 'inc:' + path.basename(abs).toLowerCase();
      if (includeIds.includes(id)) continue;
      const ok = await add(id, path.basename(abs), abs, 'Claude Code', claudeLoaders, { includedBy: 'claude-md', note: 'incluso da CLAUDE.md' });
      if (ok) includeIds.push(id);
    }
  }

  // 2. AGENTS.md dell'hub (generato)
  await add('agents-md', "AGENTS.md dell'hub", path.join(home, '.agents/AGENTS.md'), 'Codex e jcode', ['Codex', 'jcode'], {
    generatedFrom: ['claude-md', ...includeIds],
    note: 'generato da agents-build da CLAUDE.md e inclusioni',
  });

  // 3. indice della memoria
  const memDir = '-' + home.slice(1).replace(/\//g, '-');
  await add('memory-index', 'Indice della memoria', path.join(home, '.claude/projects', memDir, 'memory/MEMORY.md'),
    'Claude Code', ['Claude Code (sessioni nate in ~)']);

  // 4. stile di output
  const settings = await readJson(path.join(home, '.claude/settings.json'));
  if (typeof settings.outputStyle === 'string' && settings.outputStyle) {
    const slug = settings.outputStyle.toLowerCase().replace(/\s+/g, '-');
    await add('style', `Stile di output: ${settings.outputStyle}`, path.join(home, '.claude/output-styles', slug + '.md'),
      'Claude Code', ['Claude Code']);
  }

  // 5-6. OpenClaw
  const ocConfig = await readJson(path.join(home, '.openclaw/openclaw.json'));
  const ocAgents = ocConfig.agents || {};
  const agentIds = await listDirs(path.join(home, '.openclaw/agents'));
  for (const agent of agentIds) {
    const entry = Array.isArray(ocAgents.list) ? ocAgents.list.find((a) => a && a.id === agent) : null;
    let ws = entry && entry.workspace;
    if (!ws && agent === 'main') ws = ocAgents.defaults && ocAgents.defaults.workspace;
    ws = ws ? expand(ws) : path.join(home, `.openclaw/workspace-${agent}`);
    for (const f of OC_FILES) {
      await add(`oc:${agent}:${f}`, `${f} · agente ${agent}`, path.join(ws, f), 'OpenClaw', [`OpenClaw · ${agent}`]);
    }
  }
  const hb = ocAgents.defaults && ocAgents.defaults.heartbeat && ocAgents.defaults.heartbeat.prompt;
  if (typeof hb === 'string' && hb) {
    const st = await fs.stat(path.join(home, '.openclaw/openclaw.json')).catch(() => null);
    files.push({
      id: 'oc:heartbeat', label: 'Prompt del battito (heartbeat)', path: '~/.openclaw/openclaw.json › agents.defaults.heartbeat.prompt',
      group: 'OpenClaw', loaders: [OC_ALL], bytes: Buffer.byteLength(hb), chars: hb.length, tokens: tokensOf(hb.length),
      mtime: st ? st.mtimeMs : 0, note: '', includedBy: null, generatedFrom: null,
    });
    texts.set('oc:heartbeat', hb);
  }

  // skill nel listing (descrizione tagliata a 180)
  const skillItems = [];
  const skillsDir = path.join(home, '.agents/skills');
  for (const dir of await listDirs(skillsDir)) {
    const p = path.join(skillsDir, dir, 'SKILL.md');
    const f = await readFile(p);
    if (!f) continue;
    const fm = parseFrontmatter(f.text);
    const name = fm.name || dir;
    const chars = name.length + Math.min((fm.description || '').length, 180) + 4;
    skillItems.push({ name, chars, tokens: tokensOf(chars), path: tilde(p) });
  }
  const skillTokens = skillItems.reduce((a, s) => a + s.tokens, 0);

  // totali per loader
  const byLoader = {};
  const bump = (k, n) => { byLoader[k] = (byLoader[k] || 0) + n; };
  for (const f of files) for (const l of f.loaders) bump(l, f.tokens);
  for (const l of ['Claude Code', 'Codex', 'jcode']) bump(l, skillTokens);
  const shared = files.filter((f) => f.loaders.includes(OC_ALL) || f.loaders.includes(OC_CLI));
  const sharedTokens = shared.reduce((a, f) => a + f.tokens, 0);
  for (const agent of agentIds) {
    const k = `OpenClaw · ${agent}`;
    bump(k, skillTokens + sharedTokens);
  }

  // doppioni e date vecchie (agents-md è generato: fuori da entrambi)
  const scan = files.filter((f) => f.id !== 'agents-md');
  const seen = new Map(); // norma -> { text, files }
  const oldRules = [];
  for (const f of scan) {
    for (const { line, n } of proseLines(texts.get(f.id))) {
      const norm = normalizeLine(line);
      if (norm.length >= 50) {
        let e = seen.get(norm);
        if (!e) seen.set(norm, (e = { text: line.trim(), files: [] }));
        if (!e.files.includes(f.id)) e.files.push(f.id);
      }
      const dates = findDates(line, now);
      if (!dates.length) continue;
      const oldest = Math.min(...dates);
      const days = Math.floor((now - oldest) / DAY);
      if (days > 45) {
        oldRules.push({ file: f.id, line: n, text: mask(line.trim()).slice(0, 200), date: new Date(oldest).toISOString().slice(0, 10), days });
      }
    }
  }
  const duplicates = [...seen.entries()]
    .filter(([, e]) => e.files.length >= 2)
    .sort((a, b) => b[0].length - a[0].length)
    .slice(0, 30)
    .map(([, e]) => ({ text: mask(e.text).slice(0, 200), files: e.files }));
  oldRules.sort((a, b) => b.days - a.days);

  // doctor
  let doctor;
  try {
    const res = (await runDoctor()) || {};
    const checks = [];
    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^(ok|FAIL)\s+(.*)$/);
      if (m) checks.push({ ok: m[1] === 'ok', text: mask(m[2].trim()) });
    }
    doctor = { ok: res.code === 0, checks, error: res.error ? String(res.error) : null };
  } catch (e) {
    doctor = { ok: false, checks: [], error: e.message };
  }

  return {
    at: now,
    files,
    skills: { count: skillItems.length, tokens: skillTokens, loaders: SKILL_LOADERS, items: skillItems },
    duplicates,
    oldRules: oldRules.slice(0, 40),
    doctor,
    totals: { byLoader },
  };
}
