// Vista «quasi live» per tray e gate: progetti della settimana su Claude, Codex e Muse, con budget e priorità.
// Il report costa CPU (legge i log locali, zero token): il server lo ricalcola in background, la tray legge la copia.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { budgetsFile } from './budgets.mjs';

// Nomi umani dei progetti: le chiavi grezze (cartelle, bucket di OpenClaw) non dicono cosa sono. Una chiave senza voce resta com'è.
export function loadLabels(file = path.join(os.homedir(), '.config', 'claude-usage-hub', 'project-labels.json')) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

export const PRIORITIES = ['alta', 'normale', 'bassa'];

// Nomi dei sottoagenti OpenClaw a volte sporchi (marcatori del contesto interno): si raccolgono in un gruppo solo.
export function cleanName(name) {
  const n = String(name || '?');
  if (n.includes('<<<') || n.includes('>>>')) return 'openclaw/sottoagenti';
  return n.startsWith('openclaw/sub:') ? 'openclaw/sottoagenti' : n;
}

// Nome leggibile: la mappa manuale vince; le cartelle scratch-AAAA-MM-GG-xxxx si spiegano da sole.
// I bucket di OpenClaw sono chiavi tecniche (openclaw/discord:#canale): nella tray si leggono come «Jarvis · …».
const OC_FIXED = {
  'whatsapp-diretta': ['WhatsApp', 'Chat diretta con Jarvis su WhatsApp'],
  heartbeat: ['heartbeat', 'Controlli periodici di Jarvis'],
  altro: ['altro', 'Sessioni OpenClaw senza un canale riconosciuto'],
  'passaggi-da-altri-agenti': ['passaggi', 'Lavori passati a Jarvis da altri agenti'],
  'test-e-prove': ['prove', 'Sessioni di prova di OpenClaw'],
  'riprese-sessione': ['riprese', 'Sessioni OpenClaw riprese a mano'],
  interattivo: ['interattivo', 'Sessioni OpenClaw aperte a mano'],
  'eventi-di-sistema': ['eventi di sistema', 'Eventi di sistema di OpenClaw'],
};
export function openclawLabel(name) {
  const m = /^openclaw\/(.+)$/.exec(name || ''); if (!m || m[1] === 'sottoagenti') return null;
  const k = m[1], f = OC_FIXED[k];
  if (f) return { label: `Jarvis · ${f[0]}`, what: f[1] };
  let r;
  if ((r = /^discord:(.+)$/.exec(k))) return { label: `Jarvis · Discord ${r[1]}`, what: `Canale Discord ${r[1]}` };
  if ((r = /^wa:(?:whatsapp:)?(?:g-)?(.+)$/.exec(k))) { const g = r[1].replace(/-/g, ' '); return { label: `Jarvis · ${g}`, what: `Gruppo WhatsApp «${g}»` }; }
  if ((r = /^cron:(.+)$/.exec(k))) return { label: `Jarvis · ${r[1]}`, what: `Lavoro pianificato «${r[1]}»` };
  if ((r = /^sub:(.+)$/.exec(k))) return { label: `Jarvis · ${r[1]}`, what: 'Sottoagente delegato dal gateway OpenClaw' };
  if ((r = /^lavoro:(.+)$/.exec(k))) return { label: `Jarvis · ${r[1]}`, what: `Lavoro di Jarvis sul repo ${r[1]}` };
  return { label: `Jarvis · ${k}`, what: null };
}

export function labelFor(name, labels = {}) {
  if (labels[name]) return { label: labels[name].label || null, what: labels[name].what || null };
  const m = /^scratch-(\d{4})-(\d{2})-(\d{2})-/.exec(name);
  if (m) return { label: `Prova del ${m[3]}/${m[2]}`, what: 'Cartella temporanea di una sessione Claude' };
  const oc = openclawLabel(name); if (oc) return oc;
  return { label: null, what: null };
}

export function projectSummary(report, budgets = {}, { top = 8, labels = {} } = {}) {
  const by = new Map();
  const add = (provider, list) => {
    for (const p of list || []) {
      const pct = Number(p.weekPct);
      if (!Number.isFinite(pct) || pct <= 0) continue;
      const name = cleanName(p.name);
      const row = by.get(name) || { name, claude: 0, codex: 0, muse: 0 };
      row[provider] = Math.round((row[provider] + pct) * 10) / 10;
      by.set(name, row);
    }
  };
  add('claude', report.projects);
  add('codex', report.codex?.projects);
  add('muse', report.muse?.projects);
  // I budget esistono anche per progetti fermi questa settimana: compaiono comunque, a zero.
  for (const name of Object.keys(budgets)) if (!by.has(name)) by.set(name, { name, claude: 0, codex: 0, muse: 0 });
  return [...by.values()]
    .map((r) => {
      const b = budgets[r.name] || {};
      return { ...r, total: Math.round((r.claude + r.codex + r.muse) * 10) / 10, budgetPct: Number.isFinite(b.budgetPct) ? b.budgetPct : null, priority: PRIORITIES.includes(b.priority) ? b.priority : 'normale', label: b.label || null, title: labelFor(r.name, labels).label || b.label || r.name, what: labelFor(r.name, labels).what || null };
    })
    .sort((a, b) => (b.budgetPct !== null) - (a.budgetPct !== null) || b.total - a.total)
    .slice(0, top);
}

// Scrive budget e/o priorità di un progetto nel file unico dei budget, senza toccare gli altri campi.
// budgetPct null = toglie il budget; un progetto nuovo prende come match il suo nome.
export function saveProjectSetting(name, { budgetPct, priority } = {}, file = budgetsFile()) {
  if (!name || typeof name !== 'string') throw new Error('nome progetto mancante');
  if (priority !== undefined && !PRIORITIES.includes(priority)) throw new Error(`priorità: ${PRIORITIES.join(', ')}`);
  if (budgetPct !== undefined && budgetPct !== null && !(Number(budgetPct) > 0 && Number(budgetPct) <= 100)) throw new Error('budgetPct fra 1 e 100, o null');
  let doc = {};
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* file nuovo */ }
  doc.projects = doc.projects || {};
  const cur = doc.projects[name] || { match: [name] };
  if (budgetPct === null) delete cur.budgetPct;
  else if (budgetPct !== undefined) cur.budgetPct = Number(budgetPct);
  if (priority !== undefined) cur.priority = priority;
  doc.projects[name] = cur;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
  return cur;
}

// Dove lavora un progetto, in breve: ~ al posto della home, /private/tmp come /tmp.
export function shortDir(dir, home = os.homedir()) {
  if (!dir) return null;
  const d = dir.replace(/^\/private\/tmp\//, '/tmp/');
  return d === home ? '~' : d.startsWith(home + '/') ? '~' + d.slice(home.length) : d;
}
// /tmp è un link a /private/tmp: Codex scrive l'uno, Claude e Muse l'altro. Si normalizza, sennò due gruppi per la stessa cartella.
const norm = (dir) => (dir || '').replace(/^\/private\/(tmp|var)\//, '/$1/');
const TEMP = /^(\/tmp|\/var\/folders\/[^/]+\/[^/]+\/T)\/([^/]+)/;
// La prima cartella dentro la radice temporanea: /tmp/zgen/vg/j/r2/pair/Y8-K31 → /tmp/zgen. Le cartelle di mkdtemp
// (judge-a8Xk2p, giuria-3fQ9) stanno subito sotto la radice, una per prova: si raccolgono per prefisso (/tmp/judge-*).
const tempTop = (dir) => {
  const m = TEMP.exec(norm(dir)); if (!m) return null;
  const pre = /^(.+?)[-_.][A-Za-z0-9]{6,}$/.exec(m[2]);
  return pre && norm(dir) === `${m[1]}/${m[2]}` ? `${m[1]}/${pre[1]}-*` : `${m[1]}/${m[2]}`;
};

// Il nome da mostrare (24/10, «i nomi dicono il lavoro»): quello dell'elenco Progetti. Un worktree prende il nome del suo repo
// (git common dir: il file .git del worktree punta a <repo>/.git/worktrees/<nome>), una cartella temporanea il lavoro della sessione.
export function mainRepoOf(abs) {
  if (!abs) return null;
  try { const g = fs.readFileSync(path.join(abs, '.git'), 'utf8'); const m = /^gitdir:\s*(.+?)\/\.git\/worktrees\//m.exec(g); if (m) return m[1]; } catch { /* non è un worktree */ }
  const r = /^(.*)\/\.claude\/worktrees\/[^/]+/.exec(abs);
  return r ? r[1] : null;
}
export function displayNames(projects, { labels = {}, home = os.homedir() } = {}) {
  const byAbs = new Map(projects.filter((p) => p._abs).map((p) => [p._abs, p]));
  return projects.map((p) => {
    let display = p.title || p.name;
    const main = mainRepoOf(p._abs || (p.dir && p.dir.replace(/^~/, home)));
    if (main) { const base = path.basename(main); display = byAbs.get(main)?.title || labelFor(base, labels).label || base; }
    else if (/^Cartella temporanea/.test(p.what || '')) { // la sessione partita per prima è quella che ha aperto la cartella: le altre ci sono nate dentro
      const w = (p.agents?.list || []).filter((a) => a.work && !a.depth).sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0))[0]?.work; if (w) display = w; }
    return { ...p, display };
  });
}

// Un nome come «Y8-K31» non dice niente: ogni progetto porta la sua cartella, e senza descrizione la cartella fa da descrizione.
// Le cartelle temporanee che stanno sotto la stessa cartella di /tmp (una prova a coppie ne apre decine, su più livelli)
// diventano una riga sola, con dentro un sottogruppo per cartella madre.
export function explainProjects(projects, cwdOf, { home = os.homedir(), minGroup = 3 } = {}) {
  const withDir = projects.map((p) => {
    const dir = cwdOf(p) || null;
    return { ...p, dir: shortDir(dir, home), what: p.what || (dir ? `cartella ${shortDir(dir, home)}` : p.what), _abs: dir };
  });
  const byTop = new Map();
  // un progetto con budget o priorità sua resta da solo: raggruppato, la sua scelta sparirebbe dentro una riga «normale»
  for (const p of withDir) { const t = tempTop(p._abs); if (t && !(p.budgetPct > 0) && (p.priority || 'normale') === 'normale') byTop.set(t, [...(byTop.get(t) || []), p]); }
  const grouped = new Set([...byTop.values()].filter((g) => g.length >= minGroup).flat());
  const out = [];
  for (const p of withDir) {
    if (!grouped.has(p)) { out.push(p); continue; }
    const top = tempTop(p._abs);
    if (out.some((o) => o.name === `tmp:${top}`)) continue;
    out.push(mergeGroup(top, byTop.get(top), home));
  }
  return out.map(({ _abs, ...p }) => p);
}

function mergeGroup(parent, ms, home) {
  const sum = (k) => Math.round(ms.reduce((s, m) => s + (m[k] || 0), 0) * 10) / 10;
  const withAgents = ms.filter((m) => m.agents);
  const models = {};
  for (const m of withAgents) for (const x of m.agents.models) { const k = `${x.provider}|${x.model}`; models[k] = (models[k] || 0) + x.n; }
  const agents = withAgents.length ? {
    count: withAgents.reduce((s, m) => s + m.agents.count, 0),
    models: Object.entries(models).map(([k, n]) => ({ provider: k.split('|')[0], model: k.split('|')[1], n })),
    opus: withAgents.reduce((s, m) => s + m.agents.opus, 0),
    opusMs: Math.max(0, ...withAgents.map((m) => m.agents.opusMs)),
    list: withAgents.flatMap((m) => m.agents.list.map((a) => ({ ...a, title: a.title ? `${m.name}: ${a.title}` : m.name }))),
  } : null;
  const seen = ms.map((m) => m.lastSeen).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
  const dir = shortDir(parent, home);
  const names = ms.map((m) => m.name);
  // sottogruppi per cartella madre, relativa alla cima: «vg/j/r2/pair» con i suoi membri
  const subs = new Map();
  // relativa alla cima; un membro che è la cima stessa, o una cartella mkdtemp (cima «prefisso-*»), sta in «.»
  const base = parent.endsWith('-*') ? path.dirname(parent) : parent;
  for (const m of ms) { const d = norm(m._abs), rel = d === parent || parent.endsWith('-*') ? '.' : path.relative(base, path.dirname(d)) || '.'; subs.set(rel, [...(subs.get(rel) || []), m]); }
  const subgroups = [...subs].map(([rel, xs]) => ({ path: rel, members: xs.map((x) => x.name), agents: xs.reduce((s, x) => s + (x.agents?.count || 0), 0),
    claude: Math.round(xs.reduce((s, x) => s + (x.claude || 0), 0) * 10) / 10, codex: Math.round(xs.reduce((s, x) => s + (x.codex || 0), 0) * 10) / 10, muse: Math.round(xs.reduce((s, x) => s + (x.muse || 0), 0) * 10) / 10 }))
    .sort((a, b) => b.members.length - a.members.length);
  return {
    name: `tmp:${parent}`, claude: sum('claude'), codex: sum('codex'), muse: sum('muse'), total: sum('total'),
    budgetPct: null, priority: 'normale', label: null, dir, members: names, subgroups,
    title: `${ms.length} cartelle temporanee`,
    what: subgroups.length > 1 ? `in ${dir}: ${subgroups.map((g) => `${g.members.length} in ${g.path}`).join(', ')}` : `in ${subgroups[0].path === '.' ? dir : `${dir}/${subgroups[0].path}`}: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ` e altre ${names.length - 4}` : ''}`,
    // lo stato più serio dei membri: frenato > in coda > il resto
    ...(() => { const r = ['frenato', 'in coda'], m = ms.find((x) => x.state === r[0]) || ms.find((x) => x.state === r[1]) || withAgents[0] || ms[0]; return { state: m.state, why: m.why, waitUntil: m.waitUntil || null }; })(),
    agents, lastSeen: seen, dirMissing: ms.every((m) => m.dirMissing), dead: ms.every((m) => m.dead),
    topics: ms.flatMap((m) => m.topics || []), lastJob: ms.map((m) => m.lastJob).filter(Boolean).sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0] || null,
  };
}
