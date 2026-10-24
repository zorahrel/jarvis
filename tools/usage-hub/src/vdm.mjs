// Attribuzione dal proxy VDM: richieste per progetto dal suo registro, dove il proxy vede il cwd.
// Dove non lo vede (cwd "_sys_<hash>") o dove il cwd è la root di OpenClaw, la divisione viene dai log.
import { weighUsage, projectName } from './usage.mjs';

// USAGE_HUB_VDM_URL: la barra isolata la punta a una porta chiusa, così nessun test arriva al proxy vero
export const DEFAULT_VDM_URL = process.env.USAGE_HUB_VDM_URL || 'http://127.0.0.1:3335';

async function getJson(fetchImpl, url, ms = 4000) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

const isPath = (p) => typeof p === 'string' && /^([/\\]|[A-Za-z]:)/.test(p);

// records: voci di /api/token-usage ({ts, repo, inputTokens, ...}); sessions: /api/sessions ({active, recent}).
export function attributeProxy({ records = [], sessions = {} }, { sinceMs = 0, weights, groups = [], openclawRoot } = {}) {
  const projects = {};
  let seen = 0, noCwd = 0, firstTs = Infinity, lastTs = 0;
  for (const r of records) {
    if (!(r.ts >= sinceMs)) continue;
    seen++;
    if (r.ts < firstTs) firstTs = r.ts;
    if (r.ts > lastTs) lastTs = r.ts;
    if (!isPath(r.repo)) { noCwd++; continue; }
    const name = projectName('', r.repo, groups);
    const w = weighUsage({
      input_tokens: r.inputTokens, output_tokens: r.outputTokens,
      cache_creation_input_tokens: r.cacheCreationTokens, cache_read_input_tokens: r.cacheReadTokens,
    }, weights);
    const e = (projects[name] ||= { tokens: 0, requests: 0, lastAt: 0, needsLogs: false });
    e.tokens += w; e.requests++;
    if (r.ts > e.lastAt) e.lastAt = r.ts;
    // Il proxy vede solo la root: il lavoro vero dentro (chat, cron, sottoagenti) lo dicono i log.
    if (openclawRoot && r.repo.replace(/[\\/]+$/, '') === openclawRoot) e.needsLogs = true;
  }
  const all = [...(sessions.active || []), ...(sessions.recent || [])];
  const blindSessions = all.filter((s) => !isPath(s.cwd)).length;
  const list = Object.entries(projects).map(([name, p]) => ({ name, ...p, tokens: Math.round(p.tokens) }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    available: true,
    requests: seen,
    withoutCwd: noCwd,
    blindSessions,
    coverage: seen ? { from: firstTs, to: lastTs } : null,
    projects: list,
    note: noCwd || blindSessions || list.some((p) => p.needsLogs)
      ? 'proxy does not see the cwd for part of the traffic: those requests are attributed from the session logs'
      : 'proxy sees the cwd for all requests',
  };
}

// feed (facoltativo, il hub ne tiene uno vivo): ricorda i record già ricevuti e chiede solo quelli dall'ultimo in poi,
// invece dei ~12 MB di JSON dell'intero registro ogni 5 minuti. Un minuto di sovrapposizione, doppioni tolti per chiave.
const OVERLAP_MS = 60000;
const recKey = (r) => `${r.ts}|${r.account}|${r.repo}|${r.inputTokens}|${r.outputTokens}|${r.cacheReadTokens}|${r.cacheCreationTokens}`;
export function createProxyFeed() { return { records: [], lastTs: 0 }; }

export async function fetchProxy(url = DEFAULT_VDM_URL, fetchImpl = fetch, opts = {}) {
  const { feed } = opts;
  try {
    const since = feed && feed.lastTs ? feed.lastTs - OVERLAP_MS : opts.sinceMs;
    const [got, sessions] = await Promise.all([
      getJson(fetchImpl, since ? `${url}/api/token-usage?since=${since}` : `${url}/api/token-usage`),
      getJson(fetchImpl, `${url}/api/sessions`).catch(() => ({})),
    ]);
    let records = Array.isArray(got) ? got : [];
    if (feed) {
      const tailKeys = new Set(feed.records.filter((r) => r.ts >= since).map(recKey));
      for (const r of records) if (!tailKeys.has(recKey(r))) feed.records.push(r);
      for (const r of records) if (r.ts > feed.lastTs) feed.lastTs = r.ts;
      if (opts.sinceMs) feed.records = feed.records.filter((r) => r.ts >= opts.sinceMs);
      records = feed.records;
    }
    return attributeProxy({ records, sessions }, opts);
  } catch (err) {
    return { available: false, error: err.message, note: 'proxy not reachable: attribution comes from the session logs only' };
  }
}
