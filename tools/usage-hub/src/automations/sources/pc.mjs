// Task schedulati del PC di casa via schtasks: fonte lenta e mai offload (una query sveglia il PC).
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const home = () => os.homedir();
// pc-state è uno script che stampa una riga JSON ({"pc":"dorme|acceso|lavora",…}): si esegue, non si legge.
const defaultPcState = () => new Promise((resolve, reject) => {
  execFile(path.join(home(), 'bin', 'pc-state'), [], { encoding: 'utf8', timeout: 20000 },
    (err, out) => { if (err) return reject(err); try { resolve(JSON.parse(out.trim().split('\n').pop())); } catch (e) { reject(e); } });
});
const defaultQuery = () => new Promise((resolve, reject) => {
  execFile(path.join(home(), '.openclaw', 'bin', 'pcrun.sh'), ['schtasks /query /fo csv /v'],
    { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 },
    (err, out) => (err ? reject(err) : resolve(out)));
});

// Una riga CSV con campi tra virgolette: le virgole dentro i campi non separano, "" è una virgoletta.
function splitCsv(line) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseTable(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const head = splitCsv(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line);
    if (cols.length === head.length && cols.every((c, i) => c === head[i])) continue; // intestazione ripetuta
    const o = {};
    head.forEach((h, i) => { o[h] = cols[i] ?? ''; });
    rows.push(o);
  }
  return rows;
}

// Date di schtasks: 'dd/MM/yyyy HH:mm:ss' oppure 'M/d/yyyy h:mm:ss AM'. Null se illeggibile.
function parseWhen(s) {
  const t = String(s || '').trim();
  if (!t || /^n\/a$/i.test(t)) return null;
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ([AP]M)$/i);
  if (m) {
    let h = +m[4] % 12;
    if (/pm/i.test(m[7])) h += 12;
    return Date.UTC(+m[3], +m[1] - 1, +m[2], h, +m[5], +m[6]);
  }
  return null;
}

function toItem(row) {
  const name = String(row.TaskName || '').replace(/^\\+/, '');
  const exitRaw = String(row['Last Result'] ?? '').trim();
  const exit = /^-?\d+$/.test(exitRaw) ? Number(exitRaw) : null;
  const outcome = exit == null ? null : (exit === 0 ? 'ok' : 'error');
  const lastAt = parseWhen(row['Last Run Time']);
  const st = String(row['Schedule Type'] || '').trim();
  const stim = String(row['Start Time'] || '').trim();
  const when = st + (stim && !/^n\/a$/i.test(stim) ? ' alle ' + stim : '');
  return {
    key: 'pc:' + name,
    provider: 'pc',
    name,
    enabled: String(row.Status || '').toLowerCase() !== 'disabled',
    everyMs: null,
    when: when || null,
    next: parseWhen(row['Next Run Time']),
    nextApprox: false,
    expectedLast: null,
    last: { at: lastAt, outcome, delivered: null, error: null },
    runs: lastAt != null ? [{ at: lastAt, outcome }] : [],
    consecutiveErrors: 0,
    runsToday: 0,
    who: 'PC di casa',
    reportsTo: 'nessun messaggio',
    tech: { schedule: null, exit, command: row['Task To Run'] || null, prompt: null, label: name, url: null },
  };
}

export function createPcSource({ pcState = defaultPcState, query = defaultQuery, now = () => Date.now(), ttlMs = 30 * 60000 } = {}) {
  let cache = null; // { at, asleep } | { at, asleep:false, rows } | { at, error }
  let inFlight = null;

  const doRefresh = async () => {
    let st;
    try { st = await pcState(); } catch (e) { cache = { at: now(), error: String((e && e.message) || e) }; return; }
    const pc = typeof st === 'string' ? st : st && st.pc;
    if (pc === 'dorme') { cache = { at: now(), asleep: true }; return; } // spento: niente query
    // «sconosciuto» non è «dorme»: la fonte va a «?» e dopo 2 ore diventa una card, invece di tacere per sempre
    if (pc !== 'acceso' && pc !== 'lavora') { cache = { at: now(), error: `stato del PC ${pc || 'non letto'}` }; return; }
    let out;
    try { out = await query(); } catch (e) { cache = { at: now(), error: String((e && e.message) || e) }; return; }
    const rows = parseTable(out).filter((r) => String(r.TaskName || '').includes('wf-')).map(toItem);
    cache = { at: now(), asleep: false, rows };
  };

  const kick = () => {
    if (!inFlight) inFlight = doRefresh().catch(() => {}).finally(() => { inFlight = null; });
  };

  function build() {
    if (cache.error) return { ok: false, at: cache.at, items: [], error: cache.error };
    if (cache.asleep) return { ok: true, asleep: true, at: cache.at, items: [] };
    return { ok: true, asleep: false, at: cache.at, items: cache.rows };
  }

  function read() {
    if (!cache) return { ok: false, pending: true, items: [] };
    if (now() - cache.at > ttlMs) kick(); // cache vecchia: si ritorna lei, il refresh gira dietro
    return build();
  }

  async function refresh() {
    if (!inFlight) inFlight = doRefresh().catch(() => {}).finally(() => { inFlight = null; });
    await inFlight;
    return build();
  }

  return { read, refresh };
}
