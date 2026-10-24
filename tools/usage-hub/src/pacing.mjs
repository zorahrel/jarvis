// Pacing settimanale: ogni abbonamento deve arrivare al suo reset senza finire prima.
// Ritmo = % usata / % di settimana trascorsa (1 = in linea, >1 = consuma troppo in fretta).
// Il gate decide, per classe di lavoro, quale abbonamento usare oppure fino a quando aspettare.

const WEEK = 7 * 86400000;
const FAST = 1.3; // sopra questo ritmo il lavoro massivo si sposta altrove
const FIVE_HOUR_FULL = 95;
const DAY = 86400000;

// Classi di lavoro (Attilio 18/10): massivo e batch partono dal gratis, gusto solo Claude,
// interattivo (Attilio dal vivo) è l'unico che può mangiare la riserva.
export const CLASSES = {
  interattivo: ['claude', 'codex'],
  gusto: ['claude'],
  massivo: ['free', 'muse', 'codex', 'claude'],
  batch: ['free', 'muse', 'codex', 'claude'],
};

// Abbonamenti che restano nel gate anche quando la lettura salta: il limite lo fa rispettare il provider.
// Claude no: senza lettura non si vede la riserva di Attilio.
const READ_OPTIONAL = new Set(['codex', 'muse']);
const CARRY_MS = 2 * 3600000;

// Una riga per account con quota settimanale, dalla overview della tray.
export function buildPace(overview, { now = Date.now() } = {}) {
  const rows = [];
  for (const p of overview.providers || []) {
    // Sonda fallita (Codex: `codex app-server` in timeout col Mac carico, 24/10): senza riga il gate saltava
    // l'abbonamento e il lavoro meccanico finiva su Claude. Riga «ignota», come Muse col mint muto.
    if (!(p.accounts || []).length && p.error && READ_OPTIONAL.has(p.id)) {
      rows.push({ provider: p.id, account: p.id, active: true, unknown: true, used: null, elapsedPct: null, pace: null, perDay: null, resetsAt: null, last24h: null, history: [], fiveHour: null, status: 'ignota' });
      continue;
    }
    for (const a of p.accounts || []) {
      const week = (a.quotas || []).find((q) => q.key === '7d');
      // Account vivo senza lettura o senza ora di reset (Muse col mint muto, 21/10): una riga «ignota» e non il vuoto,
      // sennò il gate non trovava l'abbonamento e lo frenava del tutto.
      if (!week || !week.resetsAt) {
        if (a.active) rows.push({ provider: p.id, account: a.label || a.email || a.id || '?', active: true, unknown: true, used: null, elapsedPct: null, pace: null, perDay: null, resetsAt: null, last24h: null, history: [], fiveHour: null, status: 'ignota' });
        continue;
      }
      const five = (a.quotas || []).find((q) => q.key === '5h');
      const used = Number(week.usedPct ?? week.pct ?? 0);
      const resetMs = week.resetsAt * 1000;
      const leftMs = Math.max(resetMs - now, 0);
      const elapsed = Math.min(Math.max(1 - leftMs / WEEK, 0), 1);
      // Nelle prime ore della settimana il ritmo non dice niente: 2% usato su 1% trascorso non è un allarme.
      const pace = elapsed >= 0.05 ? used / (elapsed * 100) : null;
      const daysLeft = leftMs / 86400000;
      rows.push({
        provider: p.id,
        account: a.label || a.email || a.id || '?',
        active: !!a.active,
        used,
        elapsedPct: Math.round(elapsed * 100),
        pace: pace === null ? null : Math.round(pace * 100) / 100,
        perDay: Math.round(((100 - used) / Math.max(daysLeft, 1 / 24)) * 10) / 10,
        resetsAt: resetMs,
        last24h: usedLast24h(week.history, used, now),
        history: week.history || [],
        fiveHour: five ? { used: Number(five.usedPct ?? five.pct ?? 0), resetsAt: five.resetsAt * 1000 } : null,
        status: used >= 100 ? 'esaurito' : pace !== null && pace > FAST ? 'veloce' : 'ok',
        readAt: now,
      });
    }
  }
  return rows;
}

// Un abbonamento letto fino a poco fa e ora senza lettura tiene la sua ultima riga per due ore (stale: true):
// una sonda in timeout non deve cambiare la decisione del gate da un minuto all'altro. Poi resta «ignota».
export function carryLastReading(rows, last = [], { now = Date.now() } = {}) {
  const out = [...rows];
  for (const id of new Set((last || []).map((r) => r.provider))) {
    if (out.some((r) => r.provider === id && !r.unknown)) continue;
    const prev = last.filter((r) => r.provider === id && !r.unknown && r.readAt && now - r.readAt <= CARRY_MS);
    if (!prev.length) continue;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].provider === id) out.splice(i, 1);
    out.push(...prev.map((r) => ({ ...r, stale: true })));
  }
  return out;
}

// Consumo delle ultime 24h dallo storico dei campioni della tray ({t in secondi, v = % settimanale}).
// Finestra mobile e non «dall'inizio della giornata»: a mezzanotte non si azzera e non apre un buco.
// Un campione più alto dell'attuale è di prima del reset settimanale: la base riparte da zero.
export function usedLast24h(history, used, now) {
  const h = (history || []).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  if (!h.length) return null;
  const before = h.filter((x) => x.t * 1000 <= now - DAY).pop();
  const base = before ? before.v : h[0].v;
  return Math.round(Math.max(used - (base > used ? 0 : base), 0) * 10) / 10;
}

// Quando il consumo delle 24h rientra nella quota giornaliera, se da ora non si consuma altro.
export function dayOkAt(history, used, perDay, now) {
  const h = (history || []).filter((x) => x.t * 1000 > now - DAY).sort((a, b) => a.t - b.t);
  for (const s of h) {
    const prev = (history || []).filter((x) => x.t < s.t).sort((a, b) => b.t - a.t)[0];
    const at = s.t * 1000 + DAY;
    if (used - (prev && prev.v <= used ? prev.v : 0) <= perDay) return at;
  }
  return now + 6 * 3600000;
}

// Quando il ritmo torna sotto il limite: l'istante in cui la % trascorsa raggiunge la % usata / limite.
export function paceOkAt(row, limit = 1) {
  return row.resetsAt - WEEK + (row.used / 100 / limit) * WEEK;
}

// gate(classe): { go, provider, account, reason, waitUntil }. reserve = % di Claude lasciata ad Attilio;
// skip = provider da saltare (es. 'free' quando il lavoro ha bisogno dei tool di Muse o Claude).
// provider = chiede solo per quel provider (il freno davanti a museagent e codexagent), con le regole della classe.
// project = { name, priority: alta|normale|bassa, claude, budgetPct } da /api/live: la priorità sposta le soglie
// di ritmo, il budget sforato ferma il lavoro non interattivo di quel progetto. Il budget è in % della settimana
// Claude (come quello di PoP dal 14/10): Codex e Muse hanno unità diverse e non si sommano.
// overrides = elenco degli override attivi (src/overrides.mjs): tolgono solo i freni di ritmo e di giorno.
export function gate(rows, cls, { now = Date.now(), reserve = 10, skip = [], provider = null, project = null, overrides = [] } = {}) {
  if (project && cls !== 'interattivo' && project.budgetPct != null && (project.claude || 0) >= project.budgetPct) {
    const claude = rows.filter((r) => r.provider === 'claude').sort((x, y) => x.resetsAt - y.resetsAt)[0];
    return { go: false, provider: null, account: null, reason: `${project.name}: ${project.claude}% della settimana Claude, budget ${project.budgetPct}%`, waitUntil: claude ? claude.resetsAt : null };
  }
  // Stop dei lavori nuovi in background (dal menu della tray quando il Mac soffre): vale per massivo e batch, su ogni provider.
  const hold = (cls === 'massivo' || cls === 'batch') && overrides.find((o) => o.hold && o.until > now);
  if (hold) return { go: false, provider: null, account: null, reason: `lavori in background fermi a mano (${hold.reason})`, waitUntil: hold.until, hold: true };
  const order = (CLASSES[cls] ? (provider ? [provider] : CLASSES[cls]) : null)?.filter((p) => !skip.includes(p));
  if (!order) throw new Error(`classe sconosciuta: ${cls} (${Object.keys(CLASSES).join(', ')})`);
  const waits = [];
  for (const provider of order) {
    if (provider === 'free') return { go: true, provider: 'free', account: null, reason: 'canali gratis, nessuna quota' };
    const accounts = byMargin(rows.filter((r) => r.provider === provider));
    for (const r of accounts) {
      const why = blocker(r, cls, { now, reserve, priority: project?.priority || 'normale' });
      if (!why) return { go: true, provider, account: r.account, reason: reasonFor(r, now) };
      const ov = why.pacing && overrides.find((o) => !o.hold && o.provider === provider && o.until > now && (!o.class || o.class === cls));
      if (ov) return { go: true, provider, account: r.account, reason: `${reasonFor(r, now)}; freno tolto da override (${why.why})`, override: ov };
      waits.push({ ...why, provider, account: r.account });
    }
  }
  const soonest = waits.filter((w) => w.until).sort((x, y) => x.until - y.until)[0];
  return {
    go: false, provider: null, account: null,
    reason: waits.map((w) => `${w.provider}/${w.account}: ${w.why}`).join('; ') || 'nessun abbonamento per questa classe',
    waitUntil: soonest ? soonest.until : null,
    // Per account: perché aspetta e a quale condizione riparte (la tray lo scrive nel blocco dell'account).
    waits: waits.map(({ provider, account, kind, why, until, target }) => ({ provider, account, kind, why, until, ...(target != null ? { target } : {}) })),
  };
}

// Dentro un provider prima l'account con più margine rispetto al reset: % che resta al giorno fino al reset (perDay).
// Sopra 100/7 l'account è indietro sul suo ritmo, sotto corre: chi ha più margine non è mai uno oltre il ritmo
// finché un altro è in linea, e a poche ore dal reset la quota avanzata pesa di più (usa-o-perdi).
// Prima (fino al 24/10) vinceva chi si azzera prima, e un account oltre il ritmo prendeva tutto.
// L'account attivo di VDM vale un quarto in più: la stessa isteresi del proxy (modules/vdm/lib.mjs, strategia
// margin), così il gate nomina l'account che userà davvero `claude -p` e un cambio non fa perdere la cache per poco.
export const MARGIN_HYSTERESIS = 1.25;
function byMargin(accounts) {
  const score = (r) => (r.perDay ?? -1) * (r.active ? MARGIN_HYSTERESIS : 1);
  return accounts.sort((x, y) => (score(y) - score(x)) || ((x.resetsAt ?? Infinity) - (y.resetsAt ?? Infinity)));
}

// Soglie di ritmo per priorità del progetto: l'alta corre di più, la bassa si ferma prima.
const PACE_LIMIT = { batch: { alta: FAST, normale: 1, bassa: 0.8 }, massivo: { alta: 1.6, normale: FAST, bassa: 1 } };

function blocker(r, cls, { now, reserve, priority = 'normale' }) {
  if (r.used >= 100) return { kind: 'esaurito', why: 'esaurito', until: r.resetsAt };
  if (r.fiveHour && r.fiveHour.used >= FIVE_HOUR_FULL && r.fiveHour.resetsAt > now) return { kind: '5h', why: `finestra 5h al ${r.fiveHour.used}%`, until: r.fiveHour.resetsAt };
  if (cls === 'interattivo') return null;
  if (r.provider === 'claude' && 100 - r.used <= reserve) return { kind: 'riserva', why: `restano ${100 - r.used}%, riserva ${reserve}% per Attilio`, until: r.resetsAt, target: reserve };
  // Usa-o-perdi: a meno di un giorno dal reset la quota avanzata va spesa, ritmo o no.
  const lastDay = r.resetsAt - now < 86400000;
  const limit = PACE_LIMIT[cls]?.[priority];
  if (limit && !lastDay && r.pace !== null && r.pace > limit) {
    // target = la % di settimana trascorsa a cui il ritmo rientra, se da ora non si consuma altro.
    return { pacing: true, kind: 'ritmo', target: Math.round(r.used / limit), why: `consuma ${String(r.pace).replace('.', ',')} volte il previsto per la settimana (limite ${String(limit).replace('.', ',')}, priorità ${priority})${cls === 'batch' ? ', il differibile aspetta' : ''}`, until: paceOkAt(r, limit) };
  }
  // Freno sul giorno: se nelle ultime 24h è andato più della quota giornaliera sostenibile (residuo / giorni al reset)
  // il differibile aspetta, il gusto solo per i progetti a priorità bassa. Interattivo è già uscito sopra.
  const stops = cls === 'massivo' || cls === 'batch' || (cls === 'gusto' && priority === 'bassa');
  if (stops && !lastDay && r.last24h != null && r.last24h > r.perDay) {
    return { pacing: true, kind: 'giorno', target: r.perDay, why: `ultime 24h ${r.last24h}% oltre la quota giornaliera ${r.perDay}%`, until: dayOkAt(r.history, r.used, r.perDay, now) };
  }
  return null;
}

function reasonFor(r, now) {
  if (r.unknown) return 'quota non letta: si usa, il limite lo fa rispettare il provider';
  const lastDay = r.resetsAt - now < 86400000;
  return `${r.used}% usato, ${r.perDay}%/giorno fino al reset${r.pace !== null ? `, ritmo ${r.pace}` : ''}${lastDay ? ', ultimo giorno: usa-o-perdi' : ''}`;
}

// Stato di ogni abbonamento per il lavoro rimandabile: la fonte unica del «frenato» in tray (/api/gates).
export function providerStates(rows, { now = Date.now(), overrides = [] } = {}) {
  const out = {};
  for (const id of [...new Set(rows.map((r) => r.provider))]) {
    const mine = rows.filter((r) => r.provider === id);
    if (mine.every((r) => r.used >= 100)) { out[id] = { state: 'esaurito', reason: 'quota settimanale finita', waitUntil: Math.min(...mine.map((r) => r.resetsAt)) }; continue; }
    const g = gate(rows, 'batch', { provider: id, now, overrides: overrides.filter((o) => !o.hold) }); // lo stop a mano non è uno stato della quota
    out[id] = g.go ? { state: 'libero', reason: g.reason, waitUntil: null, ...(g.override ? { override: g.override } : {}) } : { state: 'frenato', reason: g.reason, waitUntil: g.waitUntil, accounts: g.waits };
  }
  return out;
}

// Stato di un progetto: frenato se nessun abbonamento può prendere per lui il lavoro rimandabile con strumenti
// (budget finito, priorità, ritmo, giorno), in coda se ha lavori nella coda, attivo se ha consumato questa settimana.
export function projectState(rows, project, queue = [], { now = Date.now() } = {}) {
  const g = gate(rows, 'massivo', { project, skip: ['free'], now });
  if (!g.go) return { state: 'frenato', why: g.reason, waitUntil: g.waitUntil };
  const queued = queue.filter((q) => q.project === project.name && (q.status === 'queued' || q.status === 'running')).length;
  if (queued) return { state: 'in coda', why: `${queued} ${queued === 1 ? 'lavoro' : 'lavori'} in attesa di partire`, waitUntil: null };
  return project.total > 0 ? { state: 'attivo', why: '', waitUntil: null } : { state: 'fermo', why: '', waitUntil: null };
}
