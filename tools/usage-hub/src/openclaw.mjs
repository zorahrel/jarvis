// Divide il consumo "openclaw" (sessioni Claude/Muse lanciate da OpenClaw con cwd = root) per lavoro vero.
// Fonti locali: indice sessioni (SQLite), elenco cron, e per le sessioni non indicizzate il primo messaggio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const OTHER = 'openclaw/altro';

export function openclawDefaults(cfg = {}) {
  const root = cfg.root || path.join(os.homedir(), '.openclaw');
  return {
    root,
    db: cfg.db || path.join(root, 'agents', 'main', 'agent', 'openclaw-agent.sqlite'),
    labels: cfg.labels || {},
    other: cfg.other || OTHER,
  };
}

// Dalla chiave di sessione OpenClaw al tipo di lavoro.
export function describeKey(key, label) {
  const k = String(key || '');
  if (/:heartbeat$/.test(k)) return { kind: 'heartbeat' };
  let m;
  if ((m = k.match(/:whatsapp:direct:/))) return { kind: 'wa-direct' };
  if ((m = k.match(/:whatsapp:group:([^:]+)/))) return { kind: 'wa-group', ref: m[1] };
  if ((m = k.match(/:discord:channel:([^:]+)/))) return { kind: 'discord', ref: m[1] };
  if (/:discord:direct:/.test(k)) return { kind: 'discord', ref: 'direct' };
  if ((m = k.match(/:cron:([0-9a-f-]{36})/))) return { kind: 'cron', ref: m[1] };
  if (/:subagent:/.test(k)) return { kind: 'sub', ref: label || '' };
  return { kind: 'other' };
}

// Dal primo messaggio utente di una sessione non indicizzata.
export function sniffFirstMessage(text) {
  const t = String(text || '');
  let m = t.match(/Conversation info:[^\n]*\n```json\n(\{[^\n]*\})/);
  if (m) {
    try {
      const j = JSON.parse(m[1]);
      const id = String(j.chat_id || '');
      if (id.startsWith('channel:')) return { kind: 'discord', ref: id.slice(8), subject: j.group_subject };
      if (id.endsWith('@g.us')) return { kind: 'wa-group', ref: id, subject: j.group_subject };
      return { kind: 'wa-direct' };
    } catch { return { kind: 'other' }; }
  }
  if ((m = t.match(/^\[cron:([0-9a-f-]{36})/m))) return { kind: 'cron', ref: m[1] };
  if (/Subagent Context/.test(t.slice(0, 400))) {
    // Senza etichetta indicizzata, la prima riga del compito fa da etichetta.
    const task = t.match(/\[Subagent Task\]\s*\n+\s*(?:Contesto:\s*)?([^\n]{4,})/);
    return { kind: 'sub', ref: task ? task[1].trim() : '' };
  }
  if (/heartbeat monitor|compiti vivi nello scratch/i.test(t.slice(0, 400))) return { kind: 'heartbeat' };
  if (/^(Chat history since last reply|Discord channel metadata)/.test(t)) return { kind: 'discord', ref: '' };
  // Messaggio da un'altra sessione: il lavoro conta per la sessione di origine.
  if ((m = t.slice(0, 300).match(/Inter-session message\] sourceSession=(\S+)/))) return describeKey(m[1]);
  const head = t.slice(0, 600);
  if (/passato da Claude Code|lanciato da Claude Code|COMPITO da jcode/.test(head)) return { kind: 'handoff' };
  if (/\bTest (tecnico|A\/B|isolato)|guardrail/i.test(head)) return { kind: 'test' };
  if (/^Continue this conversation using the OpenClaw transcript/.test(t)) return { kind: 'resume' };
  if ((m = head.match(/(?:Lavori (?:nel repository|su)|Repo:|Progetto:|Lavora in)\s*`?(\/[^\s`,()]+)/))) return { kind: 'repo', ref: path.basename(m[1]) };
  if (/^System: \[|\[System\]|An async command you ran earlier/.test(head)) return { kind: 'system' };
  return { kind: 'other' };
}

const tail = (s) => String(s).replace(/[^0-9a-z]/gi, '').slice(-4);

// Nome del bucket. Le etichette leggibili stanno nel config locale (labels: ref -> nome).
export function bucketName(desc, ctx = {}) {
  const labels = ctx.labels || {};
  const subjects = ctx.subjects || {};
  desc = { ...desc, subject: desc.subject || subjects[desc.ref] };
  const pick = (ref, fallback) => labels[ref] || fallback;
  switch (desc.kind) {
    case 'heartbeat': return 'openclaw/heartbeat';
    case 'wa-direct': return `openclaw/${pick('wa-direct', 'whatsapp-diretta')}`;
    case 'wa-group': return `openclaw/wa:${pick(desc.ref, desc.subject || `gruppo-${tail(desc.ref)}`)}`;
    case 'discord': return `openclaw/discord:${pick(desc.ref, desc.subject || (desc.ref ? `canale-${tail(desc.ref)}` : 'senza-canale'))}`;
    case 'cron': {
      const name = (ctx.cronNames || {})[desc.ref];
      return /^heartbeat/.test(name || '') ? 'openclaw/heartbeat' : `openclaw/cron:${pick(desc.ref, name || desc.ref.slice(0, 8))}`;
    }
    case 'sub': return `openclaw/sub:${String(desc.ref || 'senza-etichetta').slice(0, 40)}`;
    case 'handoff': return 'openclaw/passaggi-da-altri-agenti';
    case 'test': return 'openclaw/test-e-prove';
    case 'resume': return 'openclaw/riprese-sessione';
    case 'repo': return `openclaw/lavoro:${desc.ref}`;
    case 'manual': return 'openclaw/interattivo';
    case 'system': return 'openclaw/eventi-di-sistema';
    default: return ctx.other || OTHER;
  }
}

// rows: [{ session_key, label, entry }]. byCliId: id sessione CLI (claude/muse) -> descrittore; subjects: ref -> nome noto.
export function buildIndex(rows) {
  const byCliId = new Map();
  const subjects = {};
  for (const r of rows) {
    const e = r.entry || {};
    const d = describeKey(r.session_key, r.label || e.label);
    d.subject = e.groupChannel || e.displayName || undefined;
    if (d.ref && d.subject) subjects[d.ref] = d.subject;
    const ids = new Set(Object.values(e.cliSessionIds || {}));
    for (const b of Object.values(e.cliSessionBindings || {})) {
      if (b && typeof b === 'object') for (const v of Object.values(b)) if (typeof v === 'string' && v.length === 36) ids.add(v);
    }
    for (const id of ids) if (typeof id === 'string') byCliId.set(id, d);
  }
  return { byCliId, subjects };
}

// I/O: righe dall'indice SQLite (sola lettura). Se manca il modulo o il file, l'indice resta vuoto.
export async function readSessionRows(db) {
  if (!fs.existsSync(db)) return [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const conn = new DatabaseSync(db, { readOnly: true });
    try {
      // Solo i campi che servono a buildIndex, estratti da SQLite: entry_json intero sono ~50 MB di testo da
      // convertire in oggetti a ogni giro del report, ed era il picco di memoria del hub ogni 5 minuti.
      return conn.prepare(`select session_key, label,
          json_extract(entry_json, '$.label') as elabel, json_extract(entry_json, '$.groupChannel') as groupChannel,
          json_extract(entry_json, '$.displayName') as displayName,
          json_extract(entry_json, '$.cliSessionIds') as ids, json_extract(entry_json, '$.cliSessionBindings') as bindings
        from session_nodes where json_valid(entry_json)`).all()
        .map((r) => ({ session_key: r.session_key, label: r.label, entry: {
          label: r.elabel ?? undefined, groupChannel: r.groupChannel ?? undefined, displayName: r.displayName ?? undefined,
          cliSessionIds: r.ids ? safeJson(r.ids) : undefined, cliSessionBindings: r.bindings ? safeJson(r.bindings) : undefined,
        } }));
    } finally { conn.close(); }
  } catch { return []; }
}

// `openclaw cron list` costa ~1,3 s di CLI: si chiede in modo asincrono e si tiene 10 minuti
// (i cron cambiano di rado; un nome nuovo nel frattempo finisce al più in "altro" per un giro).
let cronCache = null;
export function readCronNames({ maxAgeMs = 10 * 60000 } = {}) {
  if (cronCache && Date.now() - cronCache.at < maxAgeMs) return cronCache.names;
  const names = new Promise((resolve) => {
    execFile('openclaw', ['cron', 'list', '--all', '--json'], { encoding: 'utf8', timeout: 15000 }, (err, out) => {
      if (err) { cronCache = null; return resolve({}); } // OpenClaw giù: si riprova al giro dopo
      try { resolve(Object.fromEntries((JSON.parse(out).jobs || []).map((j) => [j.id, j.name]))); } catch { resolve({}); }
    });
  });
  cronCache = { at: Date.now(), names };
  return names;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

// Primo messaggio utente di un jsonl Claude: legge solo l'inizio del file.
export function firstUserText(file, bytes = 262144) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    const lines = buf.toString('utf8', 0, n).split('\n');
    for (const line of lines) {
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'user') continue;
      const c = d.message && d.message.content;
      return Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : String(c || '');
    }
  } catch { /* file illeggibile: nessun indizio */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return '';
}

// Primo messaggio utente di una sessione Muse (session.jsonl): evento runtime.user_intent.accepted.
export function museFirstText(file, bytes = 524288) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('user_intent.accepted')) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      const blocks = (d.payload && d.payload.refill_blocks) || [];
      return blocks.map((b) => (b && b.text) || '').join(' ');
    }
  } catch { /* sessione illeggibile */ } finally { if (fd !== undefined) fs.closeSync(fd); }
  return '';
}

// Il primo messaggio di una sessione non cambia: letto una volta per file e tenuto finché il hub vive.
// Prima ogni giro del report rileggeva 256 KB da ogni sessione OpenClaw non indicizzata (~1 s di CPU ogni 5 minuti).
const sniffed = new Map();
function sniffFile(file) {
  let s = sniffed.get(file);
  if (!s) {
    const muse = path.basename(file) === 'session.jsonl';
    s = sniffFirstMessage(muse ? museFirstText(file) : firstUserText(file));
    // Una sessione Muse senza tracce di OpenClaw è lavoro a mano nella cartella.
    if (muse && s.kind === 'other') s.kind = 'manual';
    sniffed.set(file, s);
  }
  return { ...s };
}

// Costruisce il risolutore: (idSessione, fileJsonl?) -> nome bucket. `rows` e `cronNames` iniettabili per i test.
export async function makeResolver(cfg = {}, { rows, cronNames } = {}) {
  const c = openclawDefaults(cfg);
  const { byCliId, subjects } = buildIndex(rows || await readSessionRows(c.db));
  const ctx = { labels: c.labels, subjects, cronNames: cronNames || await readCronNames(), other: c.other };
  const memo = new Map();
  const resolve = (sessionId, file) => {
    if (memo.has(sessionId)) return memo.get(sessionId);
    let d = byCliId.get(sessionId);
    // Voce indicizzata ma generica (sessione esplicita, sottoagente senza etichetta): il primo messaggio dice di più.
    if ((!d || d.kind === 'other' || (d.kind === 'sub' && !d.ref)) && file) {
      const s = sniffFile(file);
      if (!d || !['other', 'sub'].includes(s.kind)) d = s;
    }
    d ||= { kind: 'other' };
    const name = bucketName(d, ctx);
    memo.set(sessionId, name);
    return name;
  };
  return { root: c.root, resolve, other: c.other };
}
