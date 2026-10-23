// Quali sessioni Claude hanno consumato di più oggi, dai transcript ~/.claude/projects/*/*.jsonl.
// Costo: la prima lettura passa i file modificati oggi; poi si leggono solo i byte aggiunti (offset per file).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = () => process.env.USAGE_HUB_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const CHUNK = 4 * 1024 * 1024;
const USAGE = Buffer.from('"usage"'), CWD = Buffer.from('"cwd":"');
const TS = /"timestamp":"([^"]+)"/;
const CACHE_READ = /"cache_read_input_tokens":(\d+)/, CACHE_WRITE = /"cache_creation_input_tokens":(\d+)/, OUTPUT = /"output_tokens":(\d+)/;
const num = (line, re) => { const m = line.match(re); return m ? Number(m[1]) : 0; };
const midnight = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

// state = { day, files: Map(path → { offset, tokens, cwd }) }, tenuto dal chiamante fra una scansione e l'altra.
export function newState() { return { day: 0, files: new Map() }; }

export async function scanToday(state, { now = Date.now(), dir = root(), chunk = CHUNK } = {}) {
  const start = midnight(now);
  if (state.day !== start) { state.day = start; state.files = new Map(); }
  let dirs = [];
  try { dirs = fs.readdirSync(dir); } catch { return []; }
  let buf = Buffer.allocUnsafe(chunk);
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, d)).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      const f = path.join(dir, d, n);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < start) continue;
      const cur = state.files.get(f) || { offset: 0, tokens: 0, cwd: '' };
      if (st.size <= cur.offset) continue;
      // Un solo buffer da 4 MB per tutta la scansione, riusato file dopo file: un transcript lungo pesa centinaia di MB e
      // letto intero (buffer + stringa + righe) portava il hub a 2,4 GB; un buffer nuovo per file lasciava comunque ~500 MB
      // all'allocatore. La riga a metà resta in testa al buffer e il blocco dopo si legge subito dietro.
      const fh = await fs.promises.open(f, 'r');
      try {
        let base = cur.offset, filled = 0;
        while (base + filled < st.size) {
          if (filled === buf.length) { const bigger = Buffer.allocUnsafe(buf.length * 2); buf.copy(bigger, 0, 0, filled); buf = bigger; } // riga più lunga del buffer
          const { bytesRead } = await fh.read(buf, filled, Math.min(buf.length - filled, st.size - base - filled), base + filled);
          if (!bytesRead) break;
          filled += bytesRead;
          const cut = buf.lastIndexOf(10, filled - 1) + 1; // una riga a metà (o a metà scrittura) aspetta il blocco dopo
          if (!cut) continue;
          // Si cerca "usage" nei byte e si converte in testo solo quella riga: trasformare ogni blocco in stringa e spezzarlo
          // in righe lasciava ~250 MB di memoria al processo, anche se il risultato serve solo da poche righe.
          const view = buf.subarray(0, cut);
          if (!cur.cwd) { const k = view.indexOf(CWD); if (k >= 0) cur.cwd = view.toString('utf8', k + CWD.length, view.indexOf(34, k + CWD.length)); }
          for (let i = view.indexOf(USAGE); i !== -1; i = view.indexOf(USAGE, i)) {
            const ls = view.lastIndexOf(10, i) + 1, le = view.indexOf(10, i);
            const line = view.toString('utf8', ls, le);
            i = le + 1;
            if (!line.includes('"message":')) continue;
            // Tre numeri e un orario con le regex, senza JSON.parse: le righe con output di tool e immagini pesano MB.
            // Stesso totale del parse sulle 16.879 righe vere del 21/10.
            const ts = (line.match(TS) || [])[1];
            if (!ts || Date.parse(ts) < start) continue;
            cur.tokens += num(line, CACHE_READ) + num(line, CACHE_WRITE) + num(line, OUTPUT);
          }
          buf.copy(buf, 0, cut, filled); filled -= cut; base += cut; cur.offset = base;
        }
      } finally { await fh.close(); }
      state.files.set(f, cur);
    }
  }
  return top(state);
}

// Per progetto (non per uuid): un progetto con più sessioni aperte pesa la somma.
export function top(state, n = 5) {
  const by = new Map();
  for (const [f, v] of state.files) {
    if (v.tokens <= 0) continue;
    const project = v.cwd ? path.basename(v.cwd) : path.basename(path.dirname(f));
    const r = by.get(project) || { project, sessions: 0, tokens: 0 };
    r.sessions++; r.tokens += v.tokens;
    by.set(project, r);
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens).slice(0, n);
}
