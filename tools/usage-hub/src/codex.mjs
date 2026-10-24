// Scansiona le sessioni Codex (~/.codex/sessions) e divide l'uso per progetto (cwd).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from './lines.mjs';
import { projectName } from './usage.mjs';

// Stessa idea di Claude: input non in cache 1, cache 0.1, output (ragionamento incluso) 5.
export const CODEX_WEIGHTS = { input: 1, output: 5, cacheRead: 0.1 };

export function defaultCodexRoot() {
  return path.join(os.homedir(), '.codex', 'sessions');
}

export function weigh(u, w) {
  const cached = u.cached_input_tokens || 0;
  return Math.max(0, (u.input_tokens || 0) - cached) * w.input + cached * w.cacheRead + (u.output_tokens || 0) * w.output;
}

function walk(dir, sinceMs, files) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, sinceMs, files);
    else if (e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs) files.push([p, st]); } catch { /* sparito */ }
    }
  }
}

// Lettura incrementale, come createClaudeTracker in usage.mjs: per file si ricordano offset, cwd, ultimo totale
// cumulativo e le righe utili [ts, delta, input, cached, output]. Nomi, gruppi e pesi si applicano in aggregate().
const KEEP_MS = 8 * 86400000;
export function createCodexTracker() {
  const files = new Map();
  const readFile = (file, st, e, keepSince) => {
    if (st.size < e.offset) Object.assign(e, { offset: 0, cwd: undefined, prevTotal: 0, rows: [] });
    if (st.size === e.offset) return;
    // A blocchi, solo le righe di metadata e di conteggio token (vedi lines.mjs).
    e.offset = forEachLine(file, ['"session_meta"', '"token_count"'], (line) => {
      const isMeta = line.includes('"session_meta"');
      if (!isMeta && !line.includes('"token_count"')) return;
      let doc;
      try { doc = JSON.parse(line); } catch { return; }
      if (isMeta && doc.type === 'session_meta') {
        if (e.cwd === undefined && typeof doc.payload?.cwd === 'string') e.cwd = doc.payload.cwd;
        return;
      }
      const info = doc.payload?.type === 'token_count' ? doc.payload.info : null;
      const total = info?.total_token_usage;
      if (!total || !Number.isFinite(total.total_tokens)) return;
      // Il totale è cumulativo: conta solo l'incremento, così gli eventi ripetuti non si sommano due volte.
      const delta = total.total_tokens - e.prevTotal;
      if (delta <= 0) return;
      const last = info.last_token_usage || total;
      e.prevTotal = total.total_tokens;
      const ts = Date.parse(doc.timestamp);
      if (!Number.isFinite(ts) || ts < keepSince) return;
      e.rows.push([ts, delta, last.input_tokens || 0, last.cached_input_tokens || 0, last.output_tokens || 0]);
    }, { from: e.offset, size: st.size });
  };
  return {
    files,
    update(opts) { const it = this.steps(opts); while (!it.next().done); },
    async updateAsync(opts) { const it = this.steps(opts); let n = 0; while (!it.next().done) if (++n % 20 === 0) await new Promise((r) => setImmediate(r)); },
    *steps({ root = defaultCodexRoot(), sinceMs = 0, now = Date.now() }) {
      const keepSince = Math.min(sinceMs, now - KEEP_MS);
      const list = [];
      if (fs.existsSync(root)) walk(root, sinceMs, list);
      const seen = new Set();
      for (const [file, st] of list) {
        seen.add(file);
        const e = files.get(file) || { offset: 0, cwd: undefined, prevTotal: 0, rows: [] };
        files.set(file, e);
        try { readFile(file, st, e, keepSince); } catch { /* sessione illeggibile: si salta */ }
        yield;
      }
      for (const f of files.keys()) if (!seen.has(f)) files.delete(f);
      for (const e of files.values()) if (e.rows.length && e.rows[0][0] < keepSince) e.rows = e.rows.filter((r) => r[0] >= keepSince);
    },
    aggregate({ sinceMs = 0, weights = CODEX_WEIGHTS, groups = [], openclaw: oc } = {}) {
      const out = {};
      for (const [file, e] of files) {
        let sessionName = null;
        for (const [ts, delta, input, cached, output] of e.rows) {
          if (ts < sinceMs) continue;
          if (sessionName === null) {
            const dirName = typeof e.cwd === 'string' ? e.cwd.replace(/[/.]/g, '-') : path.basename(path.dirname(file));
            sessionName = projectName(dirName, e.cwd, groups);
            if (oc && e.cwd === oc.root && sessionName === path.basename(oc.root)) sessionName = oc.resolve(path.basename(file, '.jsonl'), file);
          }
          const p = (out[sessionName] ||= { tokens: 0, rawTokens: 0, requests: 0, lastAt: 0 });
          p.tokens += weigh({ input_tokens: input, cached_input_tokens: cached, output_tokens: output }, weights);
          p.rawTokens += delta;
          p.requests += 1;
          if (ts > p.lastAt) p.lastAt = ts;
        }
      }
      return out;
    },
  };
}

export function scanCodex({ root = defaultCodexRoot(), sinceMs = 0, weights = CODEX_WEIGHTS, groups = [], openclaw } = {}) {
  const t = createCodexTracker();
  t.update({ root, sinceMs });
  return t.aggregate({ sinceMs, weights, groups, openclaw });
}

// Divide la % settimanale globale di Codex per progetto, in proporzione ai token pesati.
// La somma delle quote dà la % globale (arrotondamenti a parte): è la barra della traccia.
export function splitCodex(raw, quotaPct) {
  const total = Object.values(raw).reduce((s, p) => s + p.tokens, 0) || 1;
  return Object.entries(raw)
    .map(([name, p]) => ({
      name,
      tokens: Math.round(p.tokens),
      share: p.tokens / total,
      weekPct: quotaPct == null ? null : Math.round((p.tokens / total) * quotaPct * 100) / 100,
      requests: p.requests,
      lastAt: p.lastAt,
    }))
    .sort((a, b) => b.tokens - a.tokens);
}
