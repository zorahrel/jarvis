// GitHub Actions via `gh`: fonte lenta, mai nel percorso di una richiesta. Cache + refresh in sottofondo.
import { execFile } from 'node:child_process';

const ghOutcome = (r) => {
  if (r.status === 'in_progress' || r.status === 'queued') return 'running';
  switch (r.conclusion) {
    case 'success': return 'ok';
    case 'failure': case 'timed_out': case 'startup_failure': return 'error';
    case 'cancelled': case 'skipped': case 'neutral': return 'skipped';
    default: return null;
  }
};

function defaultRun(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { encoding: 'utf8', timeout: 30000 }, (err, out) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function splitKey(key) {
  const [owner, repo, ...file] = String(key).replace(/^gh:/, '').split('/');
  return { repo: owner + '/' + repo, file: file.join('/') };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function whenWords(everyMs) {
  if (everyMs == null) return 'quando parte su GitHub';
  if (Math.abs(everyMs - 86400000) < 3600000) return 'ogni giorno';
  if (Math.abs(everyMs - 7 * 86400000) < 86400000) return 'ogni settimana';
  const h = Math.round(everyMs / 3600000);
  return h >= 1 ? `ogni ${h} ore` : `ogni ${Math.max(1, Math.round(everyMs / 60000))} minuti`;
}

function toItem(key, e, nowMs) {
  const runs = e.runs.map((r) => ({ at: r.createdAt ? Date.parse(r.createdAt) || null : null, outcome: ghOutcome(r) }));
  const [first] = runs;
  const sched = e.runs
    .filter((r) => r.event === 'schedule')
    .map((r) => (r.createdAt ? Date.parse(r.createdAt) || null : null))
    .filter((x) => x != null)
    .sort((a, b) => b - a);
  const gaps = [];
  for (let i = 0; i + 1 < sched.length; i++) gaps.push(sched[i] - sched[i + 1]);
  const everyMs = gaps.length ? median(gaps) : null;
  const lastAt = first ? first.at : null;
  let ce = 0;
  for (const r of runs) { if (r.outcome === 'error') ce++; else break; }
  const day = new Date(nowMs).toDateString();
  return {
    key,
    provider: 'github',
    name: e.repo + ' · ' + e.file,
    enabled: true,
    everyMs,
    when: whenWords(everyMs),
    next: lastAt != null && everyMs != null ? lastAt + everyMs : null,
    nextApprox: true, // GitHub ritarda anche di ore
    expectedLast: lastAt,
    last: { at: lastAt, outcome: first ? first.outcome : null, delivered: null, error: null },
    runs: runs.slice(0, 10),
    consecutiveErrors: ce,
    runsToday: runs.filter((r) => r.at != null && new Date(r.at).toDateString() === day).length,
    who: 'GitHub Actions',
    reportsTo: 'GitHub',
    tech: { schedule: null, exit: null, command: null, prompt: null, label: e.file, url: (e.runs[0] && e.runs[0].url) || null },
  };
}

export function createGithubSource({ targets = [], run = defaultRun, now = () => Date.now(), ttlMs = 30 * 60000 } = {}) {
  let cache = null; // { at, data: Map(key -> { ok, repo, file, runs? , error? }) }
  let inFlight = null;

  const doRefresh = async () => {
    const data = new Map();
    await Promise.all(targets.map(async (t) => {
      const { repo, file } = splitKey(t.key);
      try {
        const list = await run(['run', 'list', '-R', repo, '--workflow', file, '--limit', '5', '--json', 'conclusion,createdAt,event,status,url']);
        data.set(t.key, { ok: true, repo, file, runs: Array.isArray(list) ? list : [] });
      } catch (e) { data.set(t.key, { ok: false, repo, file, error: String((e && e.message) || e) }); }
    }));
    cache = { at: now(), data };
  };

  const kick = () => {
    if (!inFlight) inFlight = doRefresh().catch(() => {}).finally(() => { inFlight = null; });
  };

  function build() {
    const items = [];
    let ok = true;
    for (const t of targets) {
      const e = cache.data.get(t.key);
      if (!e || !e.ok) { if (e && !e.ok) ok = false; continue; } // un target in errore esce, gli altri restano
      items.push(toItem(t.key, e, cache.at));
    }
    return { ok, pending: false, at: cache.at, items };
  }

  function read() {
    if (!cache) return { ok: false, pending: true, at: null, items: [] };
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
