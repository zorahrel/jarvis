// Quanto consuma una sessione viva: token del giro attuale e dell'ultima ora, letti dai tracker che l'hub tiene già
// per i progetti (nessuna lettura in più). Per Claude anche la quota settimanale, con lo stesso peso dei progetti.
import { DEFAULT_WEIGHTS, weighUsage } from './usage.mjs';
import { CODEX_WEIGHTS, weigh } from './codex.mjs';

// Una riga del tracker → [ms, token nuovi, token pesati o null]. Ogni provider tiene le sue colonne.
const rowOf = {
  // [ts, cwd, input, output, cacheWrite, cacheRead]: la lettura dalla cache non è lavoro nuovo, conta solo nel peso
  claude: (r, w) => [r[0], r[2] + r[3] + r[4], weighUsage({ input_tokens: r[2], output_tokens: r[3], cache_creation_input_tokens: r[4], cache_read_input_tokens: r[5] }, w)],
  // [ts, delta, input, cached, output]
  // il peso è lo stesso dei progetti di Codex (input, cache, output), così la quota si divide allo stesso modo
  codex: (r) => [r[0], r[1], weigh({ input_tokens: r[2], cached_input_tokens: r[3], output_tokens: r[4] }, CODEX_WEIGHTS)],
  // [ts, input, output, reasoning, contati o null, wonder]
  // il peso di Muse è il conteggio riportato dal servizio, lo stesso con cui l'hub divide la quota fra i progetti
  muse: (r) => [r[0], r[4] ?? (r[1] + r[2] + r[3]), r[4]],
};

const RUN_GAP = 30 * 60000; // come runStart di agents.mjs: un buco oltre 30 minuti chiude il giro

// agent: { provider, file, startedAt }; trackers: { claude, codex, muse } con files: Map(percorso → { rows }).
// → { tokens, hourTokens, pct, hourPct } oppure null se il transcript non è (ancora) nel tracker.
// weekShare(pesati) vale per Claude; shareFor(provider, pesati) per tutti, se c'è (il hub la passa per Codex e Muse).
export function sessionUse(agent, trackers, { now = Date.now(), weights = DEFAULT_WEIGHTS, weekShare = () => null, shareFor = null } = {}) {
  const read = rowOf[agent.provider];
  const e = agent.file && read && trackers?.[agent.provider]?.files?.get(agent.file);
  if (!e || !e.rows || !e.rows.length) return null;
  const hour = now - 3600000;
  // Inizio del giro attuale dalle righe del tracker (tutto il file, non i 128 KB di coda che legge agents.mjs):
  // con la coda piena di lavoro continuo l'inizio scivolava avanti e la quota copriva solo gli ultimi minuti.
  const times = e.rows.map((r) => r[0]).sort((a, b) => a - b);
  let start = times[times.length - 1];
  for (let i = times.length - 2; i >= 0 && start - times[i] <= RUN_GAP; i--) start = times[i];
  const from = Math.min(agent.startedAt || Infinity, start);
  let tokens = 0, hourTokens = 0, w = 0, hw = 0, any = false, weighed = false;
  for (const r of e.rows) {
    const [ts, t, wt] = read(r, weights);
    if (ts < from) continue;
    any = true; tokens += t; w += wt || 0; if (wt != null) weighed = true;
    if (ts >= hour) { hourTokens += t; hw += wt || 0; }
  }
  if (!any) return null;
  // senza nessun peso (Muse senza conteggio riportato) la quota non si stima: null, non zero
  const share = (x) => (!weighed ? null : shareFor ? shareFor(agent.provider, x) : agent.provider === 'claude' ? weekShare(x) : null);
  const pct = share(w);
  const hourPct = share(hw);
  // tre cifre significative, non decimali: una sessione piccola pesa decimillesimi di settimana e a tre decimali era zero
  const round = (v) => (v == null ? null : v > 0 ? Number(v.toPrecision(3)) : 0);
  return { tokens, hourTokens, pct: round(pct), hourPct: round(hourPct), startedAt: from };
}

// Quota della settimana di un costo pesato, con la stessa divisione dei progetti: token pesati sul totale pesato
// della settimana di quel provider nel report, per la % usata dell'abbonamento. Muse solo se conta in token.
export function shareFromReport(r, provider, weighted) {
  if (!r || !(weighted > 0)) return null;
  const part = (ps, q) => { const tot = (ps || []).reduce((a, p) => a + (p.tokens || 0), 0); return tot && q && q.weekPct != null ? (weighted / tot) * q.weekPct : null; };
  if (provider === 'claude') return part(r.projects, r.account);
  if (provider === 'codex') return part(r.codex && r.codex.projects, r.codex && r.codex.quota);
  if (provider === 'muse') { const ps = (r.muse && r.muse.projects) || []; return ps.length && ps[0].unit === 'tokens' ? part(ps, r.muse.quota) : null; }
  return null;
}

// Barra della quota per sessione sull'hub vivo (scripts/measure-automations.mjs --live). Rosso se:
// una sessione di Claude, Codex o Muse con un file non ha il consumo (tolte quelle partite da meno di 6 minuti: il
// tracker si aggiorna ogni 5), se una con token non ha la quota, o se la somma delle quote di un provider supera
// la % usata del suo abbonamento più carico (un peso sbagliato, ×100, non passa).
export function checkSessionUse(projects, paceRows, { now = Date.now() } = {}) {
  const fail = [], lines = [];
  const sess = (projects || []).flatMap((p) => ((p.agents && p.agents.list) || []));
  for (const prov of ['claude', 'codex', 'muse']) {
    const all = sess.filter((a) => a.provider === prov && a.kind !== 'coda' && !(now - a.startedAt < 6 * 60000));
    if (!all.length) continue;
    const used = all.filter((a) => a.use), withTok = used.filter((a) => a.use.tokens > 0), withPct = withTok.filter((a) => a.use.pct != null);
    const sum = withPct.reduce((x, a) => x + a.use.pct, 0);
    const acct = Math.max(0, ...(paceRows || []).filter((r) => r.provider === prov && Number.isFinite(r.used)).map((r) => r.used));
    lines.push(`sessioni ${prov}: ${used.length} su ${all.length} col consumo, ${withPct.length} su ${withTok.length} con la quota, somma ${Math.round(sum * 100) / 100}% su ${acct}% usato`);
    if (used.length < all.length) fail.push(`${prov}: ${all.length - used.length} sessioni su ${all.length} senza consumo (${all.filter((a) => !a.use).slice(0, 3).map((a) => a.kind + ' ' + (a.title || '').slice(0, 30)).join('; ')})`);
    if (withPct.length < withTok.length) fail.push(`${prov}: ${withTok.length - withPct.length} sessioni con token ma senza quota della settimana`);
    if (acct > 0 && sum > acct + 1) fail.push(`${prov}: le sessioni sommano ${Math.round(sum)}% della settimana, più del ${acct}% usato dall'abbonamento`);
  }
  return { fail, lines };
}
