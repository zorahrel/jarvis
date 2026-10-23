// Quanto consuma una sessione viva: token del giro attuale e dell'ultima ora, letti dai tracker che l'hub tiene già
// per i progetti (nessuna lettura in più). Per Claude anche la quota settimanale, con lo stesso peso dei progetti.
import { DEFAULT_WEIGHTS, weighUsage } from './usage.mjs';

// Una riga del tracker → [ms, token nuovi, token pesati o null]. Ogni provider tiene le sue colonne.
const rowOf = {
  // [ts, cwd, input, output, cacheWrite, cacheRead]: la lettura dalla cache non è lavoro nuovo, conta solo nel peso
  claude: (r, w) => [r[0], r[2] + r[3] + r[4], weighUsage({ input_tokens: r[2], output_tokens: r[3], cache_creation_input_tokens: r[4], cache_read_input_tokens: r[5] }, w)],
  // [ts, delta, input, cached, output]
  codex: (r) => [r[0], r[1], null],
  // [ts, input, output, reasoning, contati o null, wonder]
  muse: (r) => [r[0], r[4] ?? (r[1] + r[2] + r[3]), null],
};

// agent: { provider, file, startedAt }; trackers: { claude, codex, muse } con files: Map(percorso → { rows }).
// → { tokens, hourTokens, pct, hourPct } oppure null se il transcript non è (ancora) nel tracker.
export function sessionUse(agent, trackers, { now = Date.now(), weights = DEFAULT_WEIGHTS, weekShare = () => null } = {}) {
  const read = rowOf[agent.provider];
  const e = agent.file && read && trackers?.[agent.provider]?.files?.get(agent.file);
  if (!e || !e.rows || !e.rows.length) return null;
  const hour = now - 3600000;
  let tokens = 0, hourTokens = 0, w = 0, hw = 0, any = false;
  for (const r of e.rows) {
    const [ts, t, wt] = read(r, weights);
    if (ts < agent.startedAt) continue;
    any = true; tokens += t; w += wt || 0;
    if (ts >= hour) { hourTokens += t; hw += wt || 0; }
  }
  if (!any) return null;
  const pct = agent.provider === 'claude' ? weekShare(w) : null;
  const hourPct = agent.provider === 'claude' ? weekShare(hw) : null;
  const round = (v) => (v == null ? null : Math.round(v * 100) / 100);
  return { tokens, hourTokens, pct: round(pct), hourPct: round(hourPct) };
}
