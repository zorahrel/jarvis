// La scheda Automazioni: legge le fonti, applica livelli e feedback, tiene la copia per 60 s.
// Le fonti lente (GitHub, PC) girano solo in background: finché il loro primo giro non è finito valgono «?».
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readOpenclaw } from './sources/openclaw.mjs';
import { readLaunchd, watchRuns, parseRuns } from './sources/launchd.mjs';
import { readDesktop } from './sources/claude-desktop.mjs';
import { readWorkflows } from './sources/workflows.mjs';
import { createGithubSource } from './sources/github.mjs';
import { createPcSource } from './sources/pc.mjs';
import { readCounted } from './sources/counted.mjs';
import { buildModel } from './model.mjs';
import { readAll, buildState, append, openItems } from './feedback.mjs';
import { weighUsage } from '../usage.mjs';

const HOME = os.homedir();
const exp = (p) => String(p).replace(/^~(?=\/|$)/, HOME);
export const descriptionsFile = () => process.env.USAGE_HUB_AUTOMATIONS_DESC || path.join(HOME, '.claude/jarvis/private/automazioni/descrizioni.json');
// cron-health (cron OpenClaw delle 8:45) scrive qui i suoi findings: l'hub li legge senza rifare decine di chiamate alla CLI.
export const healthFile = () => process.env.USAGE_HUB_HEALTH_FILE || path.join(HOME, '.cache/claude-usage-hub/cron-health.json');

const sh = (cmd, args, timeout = 10000) => new Promise((resolve, reject) => execFile(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 16 << 20 }, (err, out) => (err ? reject(err) : resolve(out))));

// I plist cambiano di rado: plutil (un processo a file, secondi col Mac carico) solo se l'mtime è cambiato, e in parallelo.
const plistCache = new Map();
async function readPlists(dir) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.plist')); } catch { return; }
  await Promise.all(files.map(async (f) => {
    const file = path.join(dir, f);
    let mtime; try { mtime = fs.statSync(file).mtimeMs; } catch { return; }
    if (plistCache.get(file)?.mtime === mtime) return;
    try { plistCache.set(file, { mtime, data: JSON.parse(await sh('plutil', ['-convert', 'json', '-o', '-', file])) }); } catch { plistCache.set(file, { mtime, data: null }); }
  }));
}
const cachedPlutil = (file) => { const c = plistCache.get(file); if (!c || !c.data) throw new Error('plist illeggibile: ' + path.basename(file)); return c.data; };

// Ultima lettura buona delle fonti lente, su disco: un riavvio con la macchina carica non deve svuotarle.
const LAST_GOOD_SOURCES = ['launchd', 'github', 'pc'];
const LAST_GOOD_MS = 24 * 3600000;
function readLastGood(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' ? j : {}; } catch { return {}; }
}
function writeLastGood(file, data) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(`${file}.tmp`, JSON.stringify(data)); fs.renameSync(`${file}.tmp`, file); } catch { /* senza disco resta in memoria */ }
}

// Prova esterna di un giro, distinta dal suo log: oggi solo «c'è un commit nel repo dentro la finestra» (private-backup).
// Finestra = l'ultima già chiusa; se siamo dentro, quella del giorno prima.
export function proofWindow(window, now) {
  const at = (d, hm) => { const [h, m] = hm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
  let start = at(now, window[0]), end = at(now, window[1]);
  if (end > now) { start -= 86400000; end -= 86400000; }
  return { start, end };
}
async function checkProof(def, now, run = sh) {
  const { start, end } = proofWindow(def.window, now);
  const hm = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  try {
    const out = (await run('git', ['-C', exp(def.git), 'log', '-1', '--format=%cI', `--since=${new Date(start).toISOString()}`, `--until=${new Date(end).toISOString()}`])).trim();
    const at = out ? Date.parse(out) : null;
    return at ? { ok: true, at, words: `${def.words} alle ${hm(at)}` } : { ok: false, at: null, words: `manca la prova: nessun ${def.words} tra le ${def.window[0]} e le ${def.window[1]}` };
  } catch (e) { return { ok: null, at: null, words: 'prova non leggibile: ' + String(e.message).split('\n')[0].slice(0, 80) }; }
}

export function createAutomations(opts = {}) {
  const o = {
    now: () => Date.now(),
    agentsDir: path.join(HOME, 'Library/LaunchAgents'),
    launchctlList: () => sh('launchctl', ['list']),
    launchctlRuns: (label) => sh('launchctl', ['print', `gui/${process.getuid()}/${label}`], 5000).then(parseRuns),
    openclaw: (now) => readOpenclaw({ now }),
    desktop: (now) => readDesktop({ now }),
    workflows: (now) => readWorkflows({ now }),
    counted: () => readCounted(),
    readHealth: () => JSON.parse(fs.readFileSync(healthFile(), 'utf8')),
    readDescriptions: () => JSON.parse(fs.readFileSync(descriptionsFile(), 'utf8')),
    feedbackDir: undefined,
    proofRun: sh,
    lastGoodFile: process.env.USAGE_HUB_LAST_GOOD || path.join(HOME, '.cache/claude-usage-hub/automations-last-good.json'),
    ttlMs: 60000,
    background: true,
    ...opts,
  };
  let desc = {}; try { desc = o.readDescriptions(); } catch { /* senza descrizioni le schede escono col nome tecnico e «descrizione mancante» */ }
  const ghTargets = Object.keys(desc).filter((k) => k.startsWith('gh:')).map((key) => ({ key }));
  const github = o.github || createGithubSource({ targets: ghTargets });
  const pc = o.pc || createPcSource();
  // Primo giro delle fonti lente subito, dietro: read() poi rinfresca da sola quando la copia scade.
  if (o.background) { github.refresh().catch(() => {}); pc.refresh().catch(() => {}); }
  // Da quando una fonte non risponde: dopo 2 ore diventa una scheda «ti aspetta».
  const downSince = {};
  const mark = (name, s) => { if (s && s.ok === false && !s.pending) downSince[name] ||= o.now(); else delete downSince[name]; return s ? { ...s, downSince: downSince[name] || null } : s; };
  let cache = null, lastGood = null, inflight = null;
  const proofCache = new Map();
  const lastGoodSrc = readLastGood(o.lastGoodFile);
  // Contatori dei giri di launchd: letti al massimo ogni 5 minuti, ricordati per vedere i giri saltati.
  const runMemo = new Map();
  let runCounts = new Map(), runCountsAt = 0;

  // Una fonte che oggi non risponde (carico alto, cache vuota dopo un riavvio) non svuota le sue voci: vale l'ultima buona, segnata come tale.
  function keepLastGood(sources, now) {
    let fresh = false;
    for (const n of LAST_GOOD_SOURCES) {
      const s = sources[n];
      if (s.ok && !s.pending) { lastGoodSrc[n] = { at: now, items: s.items, asleep: !!s.asleep }; fresh = true; continue; }
      const good = lastGoodSrc[n];
      if (good && now - good.at < LAST_GOOD_MS) sources[n] = { ...s, ok: false, pending: false, items: good.items, asleep: good.asleep, stale: true, staleSince: good.at };
    }
    if (fresh) writeLastGood(o.lastGoodFile, lastGoodSrc);
  }

  async function build() {
    const now = o.now();
    try { desc = o.readDescriptions(); } catch { /* resta l'ultima letta */ }
    let lc = null;
    try { lc = await o.launchctlList(); } catch { /* launchd ignoto: la fonte va a «?» */ }
    await readPlists(o.agentsDir);
    const safe = (f) => { try { return f(); } catch (e) { return { ok: false, at: now, items: [], error: e.message }; } };
    const launchd = lc == null ? { ok: false, at: now, items: [], error: 'launchctl non risponde' } : safe(() => readLaunchd({ dir: o.agentsDir, launchctlList: lc, now, plutil: cachedPlutil }));
    if (launchd.ok) {
      if (now - runCountsAt >= 5 * 60000) {
        const timed = launchd.items.filter((it) => it.enabled && it.everyMs);
        const got = await Promise.all(timed.map((it) => o.launchctlRuns(it.name).catch(() => null)));
        runCounts = new Map(timed.map((it, i) => [it.name, got[i]]));
        runCountsAt = now;
      }
      watchRuns(launchd.items, runCounts, runCountsAt, runMemo); // l'ora è quella della lettura dei contatori
    }
    let counted = { ok: false, at: now, counts: {} };
    try { counted = await o.counted(); } catch { /* conteggi ignoti: non si mostrano */ }
    let findings = null;
    try { const h = o.readHealth(); findings = { at: h.at, items: h.findings || [], stale: now - h.at > 26 * 3600000 }; } catch { /* cron-health non ha ancora scritto */ }
    const proofs = {};
    await Promise.all(Object.entries(desc).filter(([, d]) => d && d.proof).map(async ([key, d]) => {
      const c = proofCache.get(key);
      if (c && now - c.t < 5 * 60000) { proofs[key] = c.v; return; }
      const v = await checkProof(d.proof, now, o.proofRun); proofCache.set(key, { t: now, v }); proofs[key] = v;
    }));
    // Il gateway OpenClaw è vivo se launchctl gli dà un PID: senza, ogni cron è in pausa per la stessa causa.
    const gw = lc ? String(lc).split('\n').find((l) => l.endsWith('\tai.openclaw.gateway')) : null;
    const gateway = { up: lc == null ? null : !!(gw && /^\d+/.test(gw)) };
    const sources = {
      openclaw: mark('openclaw', safe(() => o.openclaw(now))),
      launchd: mark('launchd', launchd),
      desktop: mark('desktop', safe(() => o.desktop(now))),
      workflows: mark('workflows', safe(() => o.workflows(now))),
      github: mark('github', github.read()),
      pc: mark('pc', pc.read()),
      counted,
    };
    keepLastGood(sources, now);
    const feedback = buildState(readAll({ dir: o.feedbackDir }).rows, { now });
    const model = buildModel({ now, sources, descriptions: desc, feedback, findings, gateway, proofs });
    model.health = findings ? { at: findings.at, stale: findings.stale } : null;
    model.feedbackOpen = openItems(feedback).length;
    return model;
  }

  // Copia di 60 s; un giro che fallisce non cancella l'ultimo buono, che resta visibile 10 minuti con la sua ora.
  async function model({ fresh = false } = {}) {
    const now = o.now();
    if (!fresh && cache && now - cache.at < o.ttlMs) return cache.model;
    inflight ||= build().then((m) => { cache = { at: o.now(), model: m }; lastGood = cache; return m; })
      .catch((e) => { if (lastGood && o.now() - lastGood.at < 10 * 60000) return { ...lastGood.model, stale: true, error: e.message }; throw e; })
      .finally(() => { inflight = null; });
    return inflight;
  }

  async function summary() {
    const m = await model();
    return { needsYou: m.verdict.needsYou, broken: m.verdict.broken, ok: m.verdict.ok, hidden: m.verdict.hidden, runsToday: m.verdict.runsToday,
      checkedAt: m.checkedAt, sources: m.footer.sources.map((s) => ({ name: s.name, ok: s.ok, at: s.at, pending: !!s.pending })) };
  }

  // Un voto, una nota, un silenzio: si scrive, si butta la copia, la prossima lettura li vede.
  function feedback(row) { const r = append(row, { dir: o.feedbackDir }); cache = null; return r; }
  function openFeedback() { return openItems(buildState(readAll({ dir: o.feedbackDir }).rows, { now: o.now() })); }

  return { model, summary, feedback, openFeedback, github, pc };
}

// Costo di un giro di workflow, aperto a richiesta: token pesati dei suoi agenti (stessi pesi della quota)
// in % della settimana. È una stima: il limitatore vero non è pubblicato.
export function workflowRunCost(runFile, weekShare) {
  const dir = path.join(path.dirname(path.dirname(runFile)), 'subagents', 'workflows', path.basename(runFile, '.json'));
  let weighted = 0, agents = 0;
  // una usage per message.id, l'ULTIMA: le righe intermedie di un messaggio hanno l'output parziale (come in usage.mjs)
  const byId = new Map();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f)); } catch { return { ok: false, error: 'trascrizioni degli agenti non trovate' }; }
  for (const f of files) {
    agents++;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      try { const j = JSON.parse(line); if (!j.message?.usage) continue; const id = j.message.id; if (id) byId.set(f + '|' + id, j.message.usage); else weighted += weighUsage(j.message.usage); } catch { /* riga troncata */ }
    }
  }
  for (const u of byId.values()) weighted += weighUsage(u);
  const pct = weekShare ? weekShare(weighted) : null;
  return { ok: true, agents, weighted: Math.round(weighted), weekPct: pct == null ? null : Math.round(pct * 100) / 100, estimate: true };
}

export function findRunFile(runId, projectsDir = path.join(HOME, '.claude/projects')) {
  if (!/^wf_[\w-]+$/.test(runId)) return null;
  for (const a of fs.readdirSync(projectsDir)) {
    let sessions = []; try { sessions = fs.readdirSync(path.join(projectsDir, a)); } catch { continue; }
    for (const s of sessions) {
      for (const sub of ['workflows', 'subagents/workflows']) {
        const f = path.join(projectsDir, a, s, sub, runId + '.json');
        if (fs.existsSync(f)) return f;
      }
    }
  }
  return null;
}

