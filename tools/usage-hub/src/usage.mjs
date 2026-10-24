// Scansiona i log di Claude Code e attribuisce i token pesati a ogni progetto.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from './lines.mjs';
import { listDir } from './dirs.mjs';

// Pesi di prezzo relativi all'input: output 5x, scrittura cache 1.25x, lettura cache 0.1x.
export const DEFAULT_WEIGHTS = { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 };

export function defaultRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

export function weighUsage(u, w = DEFAULT_WEIGHTS) {
  return (u.input_tokens || 0) * w.input
    + (u.output_tokens || 0) * w.output
    + (u.cache_creation_input_tokens || 0) * w.cacheWrite
    + (u.cache_read_input_tokens || 0) * w.cacheRead;
}

// Nome progetto: prima i gruppi configurati (match su cwd o nome cartella), poi l'ultimo segmento del cwd.
export function projectName(dirName, cwd, groups = []) {
  for (const g of groups) {
    if ((g.match || []).some((m) => (cwd && cwd.includes(m)) || dirName.includes(m))) return g.name;
  }
  if (cwd) return humanDirName(path.basename(cwd.replace(/[\\/]+$/, '')) || cwd);
  return dirName;
}

// Cartelle con un id al posto del nome (sessioni desktop, giri di workflow, cartelle di sistema): diventano parole
// già qui, così nessuna API (/api/projects, /api/live) porta l'id in pagina. Più cartelle dello stesso tipo si sommano.
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function humanDirName(base) {
  if (/^local_[0-9a-f-]{8,}$/i.test(base)) return 'Sessioni di Claude desktop';
  if (/^wf_[0-9a-f-]{6,}/i.test(base)) return 'Giri di workflow';
  if (/^_sys_[0-9a-f]{6,}$/i.test(base)) return 'Cartella di sistema';
  if (UUID.test(base)) return base.replace(UUID, '').replace(/^[-_]+|[-_]+$/g, '') || 'Cartella senza nome';
  return base;
}

// Lettura incrementale: per ogni file si ricorda fin dove si è letto e le righe utili già trovate (orario, cwd, token),
// così il giro successivo legge solo i byte aggiunti. Pesi, gruppi e nomi OpenClaw si applicano dopo, in aggregate():
// cambiarli non richiede di rileggere niente. Il hub tiene un tracker vivo; CLI e test ne usano uno nuovo a ogni chiamata.
const KEEP_MS = 8 * 86400000;
export function createClaudeTracker() {
  const files = new Map(); // percorso → { dirName, sub, offset, rows: [[ts, cwd, input, output, cacheWrite, cacheRead]] }
  // Righe dell'assistente con "usage", lette a blocchi (vedi lines.mjs); il parse serve a riconoscere message.usage.
  const readFile = (file, st, e, keepSince) => {
    if (st.size < e.offset) { e.offset = 0; e.rows = []; e.ids = new Map(); } // file riscritto da capo
    if (st.size === e.offset) return;
    e.offset = forEachLine(file, ['"usage"'], (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      const ts = Date.parse(m.timestamp);
      const u = m.message && m.message.usage;
      if (!Number.isFinite(ts) || ts < keepSince || !u) return;
      // Claude Code scrive una riga per blocco di contenuto (testo, tool_use…) dello stesso messaggio: contarle tutte
      // gonfiava token e richieste di circa 2 volte (24/10: 1763 righe per 842 messaggi). Una per id, e vale l'ULTIMA:
      // fino alla 2.1.304 le righe intermedie hanno output_tokens parziali (9 contro 689), solo l'ultima è il conto finale.
      const id = m.message.id;
      const vals = [u.input_tokens || 0, u.output_tokens || 0, u.cache_creation_input_tokens || 0, u.cache_read_input_tokens || 0];
      const prev = id && e.ids.get(id);
      if (prev) { prev.splice(2, 4, ...vals); return; } // stessa riga, orario del primo blocco
      const row = [ts, m.cwd, ...vals];
      if (id) e.ids.set(id, row);
      e.rows.push(row);
    }, { from: e.offset, size: st.size });
  };
  return {
    files,
    // Legge i byte nuovi di ogni file toccato da sinceMs in poi. updateAsync fa lo stesso cedendo il loop ogni 20 file:
    // nel hub il primo giro legge una settimana intera e non deve bloccare le API.
    update(opts) { const it = this.steps(opts); while (!it.next().done); },
    async updateAsync(opts) { const it = this.steps(opts); let n = 0; while (!it.next().done) if (++n % 20 === 0) await new Promise((r) => setImmediate(r)); },
    *steps({ root = defaultRoot(), sinceMs, now = Date.now() }) {
      const keepSince = Math.min(sinceMs, now - KEEP_MS);
      const list = [];
      if (fs.existsSync(root)) {
        for (const dirName of fs.readdirSync(root)) {
          const dir = path.join(root, dirName);
          for (const f of listDir(dir)) {
            const file = path.join(dir, f);
            if (f.endsWith('.jsonl')) { list.push([file, dirName, false]); continue; }
            // <sessione>/subagents/*.jsonl: lavoro dei subagent. Quasi tutte le sessioni non ne hanno.
            if (!listDir(file).includes('subagents')) continue;
            for (const sf of listDir(path.join(file, 'subagents'))) if (sf.endsWith('.jsonl')) list.push([path.join(file, 'subagents', sf), dirName, true]);
            // e un livello in più per i workflow: subagents/workflows/<wf>/agent-*.jsonl (prima non si leggevano mai)
            for (const wf of listDir(path.join(file, 'subagents', 'workflows'))) for (const sf of listDir(path.join(file, 'subagents', 'workflows', wf))) if (sf.endsWith('.jsonl')) list.push([path.join(file, 'subagents', 'workflows', wf, sf), dirName, true]);
          }
        }
      }
      const seen = new Set();
      for (const [file, dirName, sub] of list) {
        let st; try { st = fs.statSync(file); } catch { continue; }
        if (st.mtimeMs < sinceMs) continue;
        seen.add(file);
        const e = files.get(file) || { dirName, sub, offset: 0, rows: [], ids: new Map() };
        files.set(file, e);
        try { readFile(file, st, e, keepSince); } catch { /* illeggibile: si salta */ }
        yield;
      }
      for (const f of files.keys()) if (!seen.has(f)) files.delete(f);
      for (const e of files.values()) if (e.rows.length && e.rows[0][0] < keepSince) e.rows = e.rows.filter((r) => r[0] >= keepSince);
    },
    aggregate({ sinceMs, weights = DEFAULT_WEIGHTS, groups = [], openclaw: oc }) {
      const out = {};
      for (const [file, e] of files) {
        const sessionId = path.basename(file, '.jsonl');
        for (const [ts, cwd, input, output, cacheWrite, cacheRead] of e.rows) {
          if (ts < sinceMs) continue;
          let name = projectName(e.dirName, cwd, groups);
          // Sessioni lanciate da OpenClaw con cwd = root: si dividono per lavoro vero (chat, cron, sottoagenti...).
          if (oc && cwd === oc.root && name === path.basename(oc.root)) name = oc.resolve(sessionId, file);
          const p = (out[name] ||= { tokens: 0, requests: 0, lastAt: 0 });
          const w = weighUsage({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead }, weights);
          p.tokens += w;
          p.requests += 1;
          // I subagent contano nel progetto del padre (stesso cwd); qui si tiene a parte quanto pesano.
          if (e.sub) { p.subTokens = (p.subTokens || 0) + w; p.subRequests = (p.subRequests || 0) + 1; }
          if (ts > p.lastAt) p.lastAt = ts;
        }
      }
      return out;
    },
  };
}

// Una scansione completa con un tracker nuovo: stessa API di sempre per CLI e test.
export function scanProjects({ root = defaultRoot(), sinceMs, weights = DEFAULT_WEIGHTS, groups = [], openclaw }) {
  const t = createClaudeTracker();
  t.update({ root, sinceMs });
  return t.aggregate({ sinceMs, weights, groups, openclaw });
}
