// Coda dei lavori frenati: `delegate` accoda invece di perderli, il server li riprova ogni pochi minuti.
// Un file JSON, un lavoro alla volta per provider, ordine = priorità del progetto poi anzianità.
import { appendDiary } from './journal.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';

export const queueFile = () => process.env.USAGE_HUB_QUEUE || path.join(os.homedir(), '.cache', 'claude-usage-hub', 'queue.json');
export const logFile = () => process.env.USAGE_HUB_QUEUE_LOG || path.join(os.homedir(), '.claude', 'jarvis', 'logs', 'delegate-queue.log');
const RANK = { alta: 0, normale: 1, bassa: 2 };

export function loadQueue(file = queueFile()) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).items || []; } catch { return []; }
}
function save(items, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ items }, null, 1));
  fs.renameSync(tmp, file);
}

// ref: la voce dell'hub a cui il lavoro si riferisce (es. la chiave di un'automazione per «Risolvi tu»).
export function enqueue({ task, dir, project, cls, priority, waitUntil, ref, writer, night }, { file = queueFile(), now = Date.now() } = {}) {
  if (!task || typeof task !== 'string') throw new Error('task mancante');
  if (priority && !(priority in RANK)) throw new Error('priorità: alta, normale, bassa');
  const items = loadQueue(file);
  const item = { id: crypto.randomBytes(3).toString('hex'), task, dir: dir || os.homedir(), project: project || '', cls: cls || null,
    priority: priority || null, status: 'queued', createdAt: now, waitUntil: waitUntil || null, ...(ref ? { ref: String(ref) } : {}), ...(writer ? { writer } : {}), ...(night ? { night: true } : {}) };
  save([...items, item], file);
  return item;
}

export function cancel(id, file = queueFile()) {
  const items = loadQueue(file);
  const keep = items.filter((i) => !(i.id === id && i.status === 'queued'));
  if (keep.length === items.length) return false;
  save(keep, file);
  return true;
}

// Lavoro notturno (bin/board-notte): parte solo fra l'1 e le 7, ora del Mac. Di giorno resta in coda e aspetta la notte dopo.
export const isNight = (now = Date.now()) => { const h = new Date(now).getHours(); return h >= 1 && h < 7; };
// Log di un lavoro venuto da una card: suo, così board-notte ne legge le righe finali senza pescarle dal log comune.
export const cardLogFile = (id) => path.join(path.dirname(queueFile()), 'logs', `${id}.log`);

const rankOf = (item, projectInfo) => RANK[item.priority || projectInfo?.priority || 'normale'] ?? 1;

// Un giro: per ogni lavoro in attesa (priorità poi anzianità) chiede al router se può partire; se sì e il suo
// provider è libero lo lancia. `routeFn(item)` → {go, provider, waitUntil}; `launch(item, done)` avvia `delegate`.
export async function tick({ routeFn, launch, projectOf = () => null, notify = () => {}, file = queueFile(), now = Date.now() }) {
  let items = loadQueue(file);
  const busy = new Set(items.filter((i) => i.status === 'running').map((i) => i.provider));
  const waiting = items.filter((i) => i.status === 'queued')
    .sort((a, b) => rankOf(a, projectOf(a.project)) - rankOf(b, projectOf(b.project)) || a.createdAt - b.createdAt);
  const started = [];
  for (const item of waiting) {
    if (item.night && !isNight(now)) continue;
    let d;
    try { d = await routeFn(item); } catch { continue; }
    item.waitUntil = d.go ? null : d.waitUntil || null;
    if (!d.go || busy.has(d.provider)) continue;
    busy.add(d.provider);
    Object.assign(item, { status: 'running', provider: d.provider, startedAt: now });
    started.push(item);
  }
  save(items, file);
  for (const item of started) {
    launch(item, (code) => {
      const cur = loadQueue(file);
      const it = cur.find((i) => i.id === item.id);
      if (!it) return;
      // Exit 10 = il gate si è richiuso fra il router e delegate: torna in coda, non è un fallimento.
      if (code === 10) Object.assign(it, { status: 'queued', provider: null });
      else Object.assign(it, { status: code === 0 ? 'done' : 'failed', exit: code, endedAt: Date.now() });
      save(cur, file);
      // su WhatsApp solo i fallimenti: partenze e fine le racconta chi ha delegato (Attilio 19/10)
      if (code !== 10 && code !== 0) notify(`${code === 0 ? 'finito' : `fallito (exit ${code})`} ${item.id}: ${short(item.task)}`);
    });
  }
  return started;
}

const short = (t) => (t.length > 60 ? `${t.slice(0, 57)}...` : t);

// Al riavvio del server un lavoro «running» non ha più il suo processo: torna in coda.
export function recoverRunning(file = queueFile()) {
  const items = loadQueue(file);
  let n = 0;
  for (const i of items) if (i.status === 'running') { i.status = 'queued'; i.provider = null; n++; }
  if (n) save(items, file);
  return n;
}

export function launchDelegate(item, done, { bin, log = item.ref?.startsWith('card:') ? cardLogFile(item.id) : logFile() } = {}) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] ${item.id} ${item.provider} ${item.project}: ${item.task}\n`);
  const args = ['-C', item.dir, '--no-queue', ...(item.cls ? ['--class', item.cls] : []), ...(item.writer ? ['--writer', item.writer] : []), item.task];
  const child = spawn(bin, args, { stdio: ['ignore', out, out], env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.HOME}/bin:${process.env.PATH}` } });
  child.on('exit', (code) => { fs.writeSync(out, `[${new Date().toISOString()}] ${item.id} exit ${code}\n`); fs.closeSync(out); done(code ?? 1); });
  child.on('error', () => done(1));
}

// Eventi della coda delega («in coda», «finito», «fallito», «Risolvi tu»): vanno nel diario dell'hub, non su WhatsApp.
// Attilio 24/10: su WhatsApp solo righe umane in italiano, niente id né compiti; questi sono dettagli da consultare.
// send resta nella firma per chi lo passa ancora, ma non si usa.
export function createNotifier({ diary = (r) => appendDiary(r) } = {}) {
  return {
    push: (line) => diary({ source: 'delega', kind: 'coda', text: String(line), outcome: /^fallito/.test(line) ? 'error' : 'ok' }),
    flush: () => false,
    get pending() { return 0; },
  };
}

// Il numero è un dato personale e il repo diventa pubblico: nessun destinatario nel codice.
// Si legge da env, altrimenti dal config locale; senza nessuno dei due non si manda niente.
function whatsappTarget(explicit) {
  if (explicit) return explicit;
  if (process.env.USAGE_HUB_WHATSAPP_TO) return process.env.USAGE_HUB_WHATSAPP_TO;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'claude-usage-hub', 'notify.json'), 'utf8'));
    if (cfg.whatsapp) return cfg.whatsapp;
  } catch { /* nessun destinatario configurato */ }
  return null;
}

export function sendWhatsApp(text, target = whatsappTarget()) {
  if (!target) return;
  execFile('openclaw', ['message', 'send', '--channel', 'whatsapp', '-t', target, '-m', text], { timeout: 60000 }, () => {});
}
