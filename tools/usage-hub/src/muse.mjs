// Scansiona le sessioni di Muse e attribuisce richieste e token a ogni progetto.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forEachLine } from './lines.mjs';
import { projectName } from './usage.mjs';

const DAY_MS = 86400000;

export function defaultMuseRoot() {
  return path.join(os.homedir(), '.local', 'share', 'muse', 'sessions');
}

// Un modello wonder conta solo se inizia per muse-wonder e non contiene full.
function isWonder(model) {
  if (typeof model !== 'string') return false;
  if (model.startsWith('muse-wonder-1.0')) return !model.includes('full');
  return model.startsWith('muse-wonder') && !model.includes('full');
}

// Conta gli input e output, usando gli altri campi solo quando mancano entrambi.
function usageTokenCount(usage = {}) {
  const number = (key) => typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : null;
  const input = number('input_tokens');
  const output = number('output_tokens');
  if (input !== null || output !== null) return (input || 0) + (output || 0);
  for (const key of ['total_tokens', 'reasoning_tokens', 'cached_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    const value = number(key);
    if (value !== null) return value;
  }
  return null;
}

// Converte YYYY/MM/DD in millisecondi UTC di inizio giorno, NaN se non valido.
function dayStartMs(y, m, d) {
  const yi = Number(y);
  const mi = Number(m);
  const di = Number(d);
  if (!Number.isInteger(yi) || !Number.isInteger(mi) || !Number.isInteger(di)) return NaN;
  if (mi < 1 || mi > 12 || di < 1 || di > 31) return NaN;
  return Date.UTC(yi, mi - 1, di);
}

// Lettura incrementale, come createClaudeTracker in usage.mjs: per file offset, cwd dal metadata e righe utili
// [ts, input, output, reasoning, token contati o null, wonder]. Nomi e gruppi si applicano in aggregate().
const KEEP_MS = 8 * DAY_MS;
export function createMuseTracker() {
  const files = new Map();
  const readFile = (file, st, e, keepSince) => {
    if (st.size < e.offset) Object.assign(e, { offset: 0, cwd: undefined, rows: [] });
    if (st.size === e.offset) return;
    // A blocchi, solo le righe di metadata e di model_completed (vedi lines.mjs).
    e.offset = forEachLine(file, ['model_completed', 'runtime.session.metadata'], (line) => {
      let doc;
      try { doc = JSON.parse(line); } catch { return; }
      if (doc?.payload_type === 'runtime.session.metadata') {
        const root = doc?.payload?.record?.workspace_root;
        if (typeof root === 'string' && root && e.cwd === undefined) e.cwd = root;
        return;
      }
      if (doc?.payload_type !== 'runtime.session') return;
      const ev = doc?.payload?.event;
      if (ev?.kind !== 'model_completed') return;
      const recordedAt = doc?.recorded_at;
      if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt)) return;
      const ts = Math.floor(recordedAt / 1000);
      if (ts < keepSince) return;
      const usage = ev?.usage || {};
      e.rows.push([ts, Number(usage.input_tokens) || 0, Number(usage.output_tokens) || 0, Number(usage.reasoning_tokens) || 0, usageTokenCount(usage), isWonder(ev?.model)]);
    }, { from: e.offset, size: st.size });
  };
  return {
    files,
    update(opts) { const it = this.steps(opts); while (!it.next().done); },
    async updateAsync(opts) { const it = this.steps(opts); let n = 0; while (!it.next().done) if (++n % 20 === 0) await new Promise((r) => setImmediate(r)); },
    *steps({ root = defaultMuseRoot(), sinceMs = 0, now = Date.now() } = {}) {
      const keepSince = Math.min(sinceMs, now - KEEP_MS);
      const seen = new Set();
      for (const [file, st] of listSessionFiles(root, Math.min(sinceMs, keepSince))) {
        seen.add(file);
        const e = files.get(file) || { offset: 0, cwd: undefined, rows: [] };
        files.set(file, e);
        try { readFile(file, st, e, keepSince); } catch { /* sessione illeggibile: si salta */ }
        yield;
      }
      for (const f of files.keys()) if (!seen.has(f)) files.delete(f);
      for (const e of files.values()) if (e.rows.length && e.rows[0][0] < keepSince) e.rows = e.rows.filter((r) => r[0] >= keepSince);
    },
    aggregate({ sinceMs = 0, groups = [], openclaw: oc } = {}) {
      const out = {};
      for (const [file, e] of files) {
        let name = null;
        for (const [ts, input, output, reasoning, tokens, wonder] of e.rows) {
          if (ts < sinceMs) continue;
          if (name === null) {
            const dirName = typeof e.cwd === 'string' ? e.cwd.replace(/[/.]/g, '-') : path.basename(path.dirname(file));
            name = projectName(dirName, e.cwd, groups);
            if (oc && e.cwd === oc.root && name === path.basename(oc.root)) name = oc.resolve(path.basename(path.dirname(file)), file);
          }
          const p = (out[name] ||= { requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, reportedTokens: 0, tokenCountEvents: 0, wonderRequests: 0, lastAt: 0 });
          p.requests += 1;
          p.inputTokens += input;
          p.outputTokens += output;
          p.reasoningTokens += reasoning;
          if (tokens !== null) { p.reportedTokens += tokens; p.tokenCountEvents += 1; }
          if (wonder) p.wonderRequests += 1;
          if (ts > p.lastAt) p.lastAt = ts;
        }
      }
      return out;
    },
  };
}

export function scanMuse({ root = defaultMuseRoot(), sinceMs, groups = [], openclaw } = {}) {
  const t = createMuseTracker();
  t.update({ root, sinceMs: sinceMs ?? 0 });
  return t.aggregate({ sinceMs: sinceMs ?? 0, groups, openclaw });
}

// Le session.jsonl nelle cartelle anno/mese/giorno che possono contenere eventi da sinceMs in poi.
function listSessionFiles(root, sinceMs) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  let years;
  try {
    years = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const yEnt of years) {
    if (!yEnt.isDirectory() || !/^\d{4}$/.test(yEnt.name)) continue;
    const yDir = path.join(root, yEnt.name);
    let months;
    try {
      months = fs.readdirSync(yDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const mEnt of months) {
      if (!mEnt.isDirectory() || !/^\d{2}$/.test(mEnt.name)) continue;
      const mDir = path.join(yDir, mEnt.name);
      let days;
      try {
        days = fs.readdirSync(mDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dEnt of days) {
        if (!dEnt.isDirectory() || !/^\d{2}$/.test(dEnt.name)) continue;
        const start = dayStartMs(yEnt.name, mEnt.name, dEnt.name);
        if (Number.isFinite(start) && start + DAY_MS < sinceMs - DAY_MS) continue;
        const dDir = path.join(mDir, dEnt.name);
        let sessions;
        try {
          sessions = fs.readdirSync(dDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const sEnt of sessions) {
          if (!sEnt.isDirectory()) continue;
          const file = path.join(dDir, sEnt.name, 'session.jsonl');
          try {
            const st = fs.statSync(file);
            if (st.mtimeMs >= sinceMs) out.push([file, st]);
          } catch {
            // Sessione sparita o senza log: si salta.
          }
        }
      }
    }
  }
  return out;
}
