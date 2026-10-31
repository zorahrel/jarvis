// cron-close: una card che nomina «cron <id8>» si chiude da sola quando quel cron di OpenClaw ha un run consegnato,
// e viene segnalata (una riga) se l'ora passa senza run. Gira come ultimo passo di task-sync, senza daemon nuovi.
//
// Il cron si legge dal database di OpenClaw (cron_jobs, cron_run_receipts) in sola lettura: funziona anche a gateway
// spento, ed è proprio allora che serve. «Consegnato» = ricevuta ok con delivery_attempt_state = started.
// L'ora attesa si fissa alla prima volta che la card si vede: per un cron «at» è l'orario, per uno ricorrente il
// prossimo giro (così un run di ieri non chiude la card di oggi).
//   cron-close.mjs [--dry-run]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GRACE_MS = 20 * 60e3; // oltre questo ritardo senza run ok si segnala
const REF = /\bcron[\s:]+([0-9a-f]{8})\b/gi;

export const refsOf = (card) => [...new Set([...`${card.title} ${card.text}`.matchAll(REF)].map((m) => m[1].toLowerCase()))];

// Il punto critico: dalle card, i cron e le ricevute alle operazioni. Pura.
//   cards: [{id, board, title, text, cls}] · jobs: [{id, at?, nextRunAtMs?}] · receipts: [{job_id, status, started_at_ms, delivered}]
//   watch: { [cardId]: { cron, dueMs, alerted? } } (stato tra un giro e l'altro)
export function decide({ cards, jobs, receipts, watch, now }) {
  const ops = [], next = { ...watch };
  const live = new Set();
  for (const c of cards) {
    if (c.cls === 'done') continue;
    const refs = refsOf(c);
    if (!refs.length) continue;
    live.add(c.id);
    const w = { ...(next[c.id] || {}) };
    const proofs = [];
    let missing = null, late = null;
    for (const ref of refs) {
      const job = jobs.find((j) => j.id.startsWith(ref));
      // Un cron «at» con deleteAfterRun sparisce dopo il run ma lascia la ricevuta: l'ora attesa l'abbiamo già fissata.
      const due = (w.dues ||= {})[ref] ??= job ? (job.at ? Date.parse(job.at) : job.nextRunAtMs ?? now) : undefined;
      if (due === undefined) { missing = ref; continue; }
      const ok = receipts.filter((r) => r.job_id.startsWith(ref) && r.status === 'ok' && r.delivered && r.started_at_ms >= due - 60e3)
        .sort((a, b) => b.started_at_ms - a.started_at_ms)[0];
      if (!ok && !job) { missing = ref; continue; }
      if (ok) proofs.push(`cron ${ref}: run ok e consegnato il ${new Date(ok.started_at_ms).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
      else if (now > due + GRACE_MS) late = { ref, due };
    }
    if (proofs.length === refs.length) {
      ops.push({ op: 'close', cid: c.id, board: c.board, comment: `Prova: ${proofs.join('; ')} (chiusa da cron-close)`, what: c.title });
      delete next[c.id];
      continue;
    }
    if (missing && !w.missingAlerted) {
      w.missingAlerted = true;
      ops.push({ op: 'alert', cid: c.id, board: c.board, text: `cron ${missing} non esiste più, la card aspetta invano: ${c.title}` });
    }
    if (late && !w.alerted) {
      w.alerted = true;
      ops.push({ op: 'alert', cid: c.id, board: c.board, text: `cron ${late.ref} doveva girare alle ${new Date(late.due).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })} e non ha un run consegnato: ${c.title}` });
    }
    next[c.id] = w;
  }
  for (const id of Object.keys(next)) if (!live.has(id) && !ops.some((o) => o.cid === id)) delete next[id]; // card chiusa a mano
  return { ops, watch: next };
}

// ── I lati veri ──────────────────────────────────────────────────────────────

export const DB = process.env.CRON_CLOSE_DB || path.join(os.homedir(), '.openclaw/state/openclaw.sqlite');
const sql = (q) => JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', DB, q], { encoding: 'utf8', timeout: 20000 }) || '[]');

// 26/10: la ricevuta dice solo che la consegna è stata tentata («started»); un cron (e5738f4e) risultava consegnato e
// il testo era stato soppresso (no_visible_result), la card si chiuse a torto. «Consegnato» è quello che dice il
// registro dei run del gateway; se il gateway non risponde nessun run vale come consegnato e la card resta aperta.
export function deliveredRuns(jobId, bin = process.env.OPENCLAW_BIN || 'openclaw') {
  try {
    const out = JSON.parse(execFileSync(bin, ['cron', 'runs', '--id', jobId, '--limit', '20'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/^[^{]*/, ''));
    return (out.entries || []).filter((e) => e.action === 'finished' && e.delivered === true).map((e) => e.runAtMs);
  } catch { return []; }
}

export function readCron(refs = [], runs = deliveredRuns) {
  const jobs = sql("select job_id as id, json_extract(job_json,'$.schedule.at') as at, json_extract(state_json,'$.nextRunAtMs') as nextRunAtMs from cron_jobs");
  const rows = sql("select job_id, status, started_at_ms from cron_run_receipts where status = 'ok' and delivery_attempt_state = 'started' and started_at_ms > (strftime('%s','now') - 14*86400) * 1000");
  const delivered = new Map();
  const receipts = rows.map((r) => {
    if (!refs.some((ref) => r.job_id.startsWith(ref))) return { ...r, delivered: false };
    if (!delivered.has(r.job_id)) delivered.set(r.job_id, runs(r.job_id));
    return { ...r, delivered: delivered.get(r.job_id).some((t) => Math.abs(t - r.started_at_ms) < 60e3) };
  });
  return { jobs, receipts };
}

export const WATCH_FILE = path.join(process.env.TASK_SYNC_STATE || path.join(os.homedir(), '.claude/jarvis/state/task-sync'), 'cron-watch.json');

// Un giro: legge le card aperte (qualunque board), decide, scrive. `topics` è il lato Topics di task-sync.
export async function closeRound({ topics, read = readCron, now = Date.now(), file = WATCH_FILE, dry = false, log = console.log, notify = null }) {
  const cards = await topics.openCards();
  let watch = {};
  try { watch = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const { jobs, receipts } = read([...new Set(cards.flatMap(refsOf))]);
  const res = decide({ cards, jobs, receipts, watch, now });
  for (const o of res.ops) {
    if (o.op === 'alert') {
      log(`⏰ ${o.text}`);
      // L'avviso deve arrivare dove si legge: commento sulla card e, se c'è, una riga su WhatsApp (prima era solo il log).
      if (!dry) {
        await topics.comment(o.board, o.cid, `⏰ ${o.text}`).catch((e) => log(`cron-close: commento non scritto: ${e.message}`));
        if (notify) await Promise.resolve(notify(o.text)).catch((e) => log(`cron-close: avviso WhatsApp non partito: ${e.message}`));
      }
      continue;
    }
    log(`chiusa con prova: ${o.what}`);
    if (!dry) { await topics.comment(o.board, o.cid, o.comment); await topics.patch(o.board, o.cid, { status: 'done' }); }
  }
  if (!dry) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(res.watch, null, 1)); }
  return res;
}

async function main() {
  const { topicsSide } = await import('./task-sync.mjs');
  let token = '';
  try { token = execFileSync('security', ['find-generic-password', '-s', 'topics', '-a', 'agent-token', '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  const wa = process.env.TASK_SYNC_WA;
  const notify = wa ? (text) => execFileSync('openclaw', ['message', 'send', '--channel', 'whatsapp', '--target', wa, '-m', `⏰ ${text}`], { stdio: 'ignore', timeout: 60000 }) : null;
  try { await closeRound({ topics: topicsSide({ token }), dry: process.argv.includes('--dry-run'), notify }); }
  catch (e) { console.error(`cron-close: ${e.message}`); process.exitCode = 2; }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
