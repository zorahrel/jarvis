// Il Mac e i suoi agenti, misurati: un campione ogni 30 s per la swap, la tabella dei processi a richiesta (cache 20 s).
import os from 'node:os';
import path from 'node:path';
import { openclawKind, cliSessionId, memBreakdown, readMac, swapVerdict, strain, processTable, classify, treeStats, descendants, footprintMap, cwdOf, startTime, topHogs, readExtras, effort, MAX_LOAD_PER_CORE } from './mac.mjs';
import { keyFor } from './agents.mjs';

// openclawResolve: async () => (idSessione) → bucket di OpenClaw; senza, nessun figlio del gateway è pausabile.
export function createMacWatch({ groups = [], priorityOf = () => 'normale', getShed = () => null, openclawResolve = async () => null } = {}) {
  let samples = [];
  let snap = { at: 0, v: null };
  // Le quattro misure delle ultime 24 h, un punto al minuto, per i grafici della tray. In memoria:
  // dopo un riavvio dell'hub il grafico riparte vuoto, accettabile per «com'è andata oggi».
  let ring = [];
  const ocRoot = path.join(os.homedir(), '.openclaw');

  const sample = async () => {
    const s = await readMac();
    samples = [...samples.filter((x) => s.at - x.at < 180000), s];
    return s;
  };

  // Radici degli agenti: ogni processo claude/codex/muse con la sua cartella, il progetto, CPU e memoria dell'albero.
  async function trees(table, withFootprint = true) {
    const all = table.filter((r) => classify(r) !== 'altro');
    const ids = new Set(all.map((r) => r.pid));
    const roots = all.filter((r) => !ids.has(r.ppid)); // un claude figlio di un altro claude è lo stesso agente
    const cwds = await cwdOf(roots.map((r) => r.pid));
    let resolve = null; if (roots.some((r) => classify(r) === 'sottoagente')) { try { resolve = await openclawResolve(); } catch { /* resta null */ } }
    const out = roots.map((r) => {
      const cwd = cwds.get(r.pid) || '';
      const st = treeStats(table, r.pid);
      const k = classify(r), kind = k === 'sottoagente' ? openclawKind(r, resolve) : k;
      // una chat di Jarvis porta il suo bucket (whatsapp-diretta, discord:#…), lo stesso della lista agenti e dei consumi
      let project = keyFor(cwd, '', { groups, ocRoot });
      if (kind === 'chat-openclaw' && resolve) { try { project = resolve(cliSessionId(r.command)) || project; } catch { /* resta la cartella */ } }
      return { pid: r.pid, kind, cwd, project, cpu: st.cpu, memMB: st.rssMB, pids: st.pids, memReal: false };
    });
    if (withFootprint) {
      const top = [...out].sort((a, b) => b.memMB - a.memMB).slice(0, 8);
      const fps = await footprintMap(top.flatMap((t) => t.pids));
      for (const t of top) {
        const fp = t.pids.reduce((sum, p) => sum + (fps.get(p) || 0), 0); if (fp) { t.memMB = fp; t.memReal = true; }
      }
    }
    return out;
  }

  const probe = {
    maxLoad: MAX_LOAD_PER_CORE,
    mac: sample,
    verdict: () => swapVerdict(samples),
    strain,
    table: processTable,
    startTime,
    tree: (table, pid) => descendants(table, pid).map((r) => r.pid),
    candidates: async (table) => (await trees(table, true)).map((t) => ({ ...t, priority: priorityOf(t.project), cls: t.kind === 'sottoagente' ? null : 'batch' })),
  };

  return {
    probe,
    // Per /api/mac: carico, memoria, chi pesa, albero di ogni agente, pause in corso.
    async snapshot() {
      if (Date.now() - snap.at < 20000 && snap.v) return snap.v;
      // due richieste insieme (tray e dashboard) facevano due giri interi, con due `footprint` in parallelo
      if (snap.pending) return snap.pending;
      snap.pending = this.build().finally(() => { snap.pending = null; });
      return snap.pending;
    },
    async build() {
      const [mac, table] = await Promise.all([samples.length ? samples[samples.length - 1] : sample(), processTable()]);
      const verdict = swapVerdict(samples);
      const st = strain(mac, verdict);
      const [tr, hogs, extras] = await Promise.all([trees(table), topHogs(table, 3), readExtras()]);
      const eff = effort(mac, verdict, extras);
      const t = Math.floor(Date.now() / 1000);
      if (!ring.length || t - ring[ring.length - 1].t >= 60) {
        ring.push({ t, ...Object.fromEntries(eff.parts.map((p) => [p.key, p.pct])) });
        while (ring.length && t - ring[0].t > 86400) ring.shift();
      }
      const v = {
        at: Date.now(), cores: mac.cores, load1: mac.load1, loadPerCore: mac.loadPerCore, maxLoadPerCore: MAX_LOAD_PER_CORE,
        swapUsedGB: mac.swapUsedMB != null ? mac.swapUsedMB / 1024 : null, swapTotalGB: mac.swapTotalMB != null ? mac.swapTotalMB / 1024 : null,
        swapSustained: verdict.sustained, pagesReadBackPerS: verdict.pagesReadBackPerS, debtGBPerMin: verdict.debtGBPerMin,
        strained: st.strained, reason: st.reason, hogs, effort: eff, history: macHistory(ring),
        // quantità vere accanto alle %: la RAM per voci, il disco in GB (decimali, come il Finder)
        mem: memBreakdown(mac), disk: extras.diskFreeGB != null ? { freeGB: extras.diskFreeGB, totalGB: extras.diskTotalGB } : null,
        trees: tr.map(({ pids, ...t }) => ({ ...t, n: pids.length })),
        paused: getShed() ? getShed().paused.map((e) => ({ pid: e.pid, project: e.project, kind: e.kind, label: e.label, since: e.since, reason: e.reason })) : [],
        note: getShed() ? getShed().status.note : '',
      };
      snap = { at: Date.now(), v };
      return v;
    },
  };
}

const PROVIDER_OF = { interattivo: 'claude', sottoagente: 'claude', 'chat-openclaw': 'claude', 'claude-job': 'claude', 'codex-exec': 'codex', 'muse-job': 'muse' };

// CPU e memoria dell'albero di ogni agente. Se in un progetto c'è un solo agente per programma la misura è sua; se sono di più
// non si può dire quale processo sia quale, e ognuno porta la somma del gruppo con `shared`: meglio dirlo che inventare una ripartizione.
export function attachResources(agents, trees) {
  const key = (project, provider) => project + '|' + provider;
  const g = new Map();
  for (const t of trees) { const p = PROVIDER_OF[t.kind]; if (p) (g.get(key(t.project, p)) || g.set(key(t.project, p), { trees: [], agents: [] }).get(key(t.project, p))).trees.push(t); }
  // un sottoagente gira dentro il processo della sua sessione: niente albero suo, non deve dividere quello della madre
  for (const a of agents) { if (a.parent) continue; const e = g.get(key(a.project, a.provider)); if (e) e.agents.push(a); }
  for (const { trees: ts, agents: as } of g.values()) {
    const cpu = ts.reduce((s, t) => s + t.cpu, 0), memMB = ts.reduce((s, t) => s + t.memMB, 0);
    for (const a of as) a.res = as.length === 1 && ts.length === 1 ? { cpu, memMB } : { cpu, memMB, shared: Math.max(as.length, ts.length) };
  }
  return agents;
}

// Una serie per misura, al massimo 120 punti (un grafico largo 120 px): in ogni fetta il picco, non la media,
// perché il grafico serve a vedere quando il Mac ha sofferto.
export function macHistory(ring, maxPoints = 120) {
  if (!ring.length) return {};
  const span = Math.max(1, Math.ceil(ring.length / maxPoints));
  const out = {};
  for (const key of ['cpu', 'mem', 'gpu', 'disk']) {
    const pts = [];
    for (let i = 0; i < ring.length; i += span) {
      const slice = ring.slice(i, i + span).filter((x) => x[key] != null);
      if (slice.length) pts.push({ t: slice[slice.length - 1].t, v: Math.max(...slice.map((x) => x[key])) });
    }
    out[key] = pts;
  }
  return out;
}
