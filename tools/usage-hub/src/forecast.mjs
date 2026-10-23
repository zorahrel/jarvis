// Previsione per abbonamento: fino a quando regge al ritmo attuale e se arriva al reset.
// Gli account dello stesso provider sono un serbatoio solo (vdm li alterna già): si simula il consumo
// a passi di 10 minuti, sempre dall'account che si azzera prima (lo stesso ordine del freno), con i reset
// che riempiono di nuovo. Un buco è un tratto in cui nessun account ha quota.
// Il ritmo è quello delle ultime 24 h, che già smussa i picchi di un'ora; i 3 giorni sono solo un dato in più.
// Non decidono il colore: un account a secco consuma zero per forza, e la media lo scambierebbe per calma
// (22/10: attilio esaurito fino al 21 abbassava la media e nascondeva il buco di sabato).

const DAY = 86400000, STEP = 600000, WEEK = 7 * DAY;
const TZ = 'Europe/Rome';
const NAMES = { claude: 'Claude', codex: 'Codex', muse: 'Muse' };

// Consumo di un account nella finestra [since, now], dallo storico dei campioni ({t in s, v = % settimanale}).
// Un calo è un reset: da lì il consumo riparte da zero, quindi conta il valore nuovo.
export function consumedSince(history, used, since, now) {
  const h = (history || []).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
  const pts = [...h.map((x) => ({ at: x.t * 1000, v: x.v })), { at: now, v: used }];
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].at <= since) continue;
    const d = pts[i].v >= pts[i - 1].v ? pts[i].v - pts[i - 1].v : pts[i].v;
    sum += d;
  }
  return sum;
}

// Ritmo del serbatoio in % di un account al giorno, su `days` giorni (accorciati allo storico che c'è).
export function poolRate(rows, days, now) {
  const first = Math.min(...rows.flatMap((r) => (r.history || []).map((x) => x.t * 1000)), now);
  const span = Math.min(days * DAY, Math.max(now - first, 0));
  if (span < DAY / 2) return null;
  return rows.reduce((s, r) => s + consumedSince(r.history, r.used, now - span, now), 0) / (span / DAY);
}

// Simulazione: quando il serbatoio resta vuoto la prima volta e quando torna a esserci quota.
export function simulate(rows, rate, now, horizon) {
  const accs = rows.map((r) => ({ account: r.account, left: Math.max(100 - r.used, 0), reset: r.resetsAt }));
  if (!rate || rate <= 0) return { runsOutAt: null, gapUntil: null };
  let runsOutAt = null;
  for (let t = now; t < horizon; t += STEP) {
    for (const a of accs) if (t >= a.reset) { a.left = 100; a.reset += WEEK; }
    const av = accs.filter((a) => a.left > 0).sort((x, y) => x.reset - y.reset)[0];
    if (!av) {
      if (runsOutAt == null) runsOutAt = t;
      continue;
    }
    if (runsOutAt != null) return { runsOutAt, gapUntil: t };
    av.left -= (rate * STEP) / DAY;
  }
  return { runsOutAt, gapUntil: runsOutAt != null ? horizon : null };
}

// 0 = arriva al reset · 1 = buco sotto le 24 h · 2 = buco di un giorno o più.
const levelOf = (s) => (s.runsOutAt == null ? 0 : s.gapUntil - s.runsOutAt < DAY ? 1 : 2);

export function when(ms, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  const day = (x) => x.toLocaleDateString('it-IT', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric' });
  const hm = d.toLocaleTimeString('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  if (day(d) === day(n)) return `oggi alle ${hm}`;
  if (day(d) === day(new Date(now + DAY))) return `domani alle ${hm}`;
  const wd = d.toLocaleDateString('it-IT', { timeZone: TZ, weekday: 'short' }).replace('.', '');
  return ms - now < 6 * DAY ? `${wd} alle ${hm}` : `${wd} ${d.toLocaleDateString('it-IT', { timeZone: TZ, day: 'numeric', month: 'numeric' })}`;
}
const span = (ms) => { const h = Math.round(ms / 3600000); return h < 24 ? `${h} ${h === 1 ? 'ora' : 'ore'}` : `${Math.floor(h / 24)} g ${h % 24 ? (h % 24) + ' h' : ''}`.trim(); };

// Una voce per provider: stato, testi pronti (tray e dashboard li usano uguali) ed eccezione per la barra.
export function forecast(rows, { now = Date.now() } = {}) {
  const out = [];
  for (const id of [...new Set(rows.map((r) => r.provider))]) {
    const all = rows.filter((r) => r.provider === id);
    const known = all.filter((r) => !r.unknown);
    const name = NAMES[id] || id;
    if (!known.length) { out.push({ id, status: 'ignota', right: 'quota non letta', sub: `${name} non manda la quota adesso: il lavoro ci va lo stesso`, exception: null }); continue; }
    const horizon = Math.max(...known.map((r) => r.resetsAt));
    const r24 = poolRate(known, 1, now) ?? known.reduce((s, r) => s + (r.last24h || 0), 0);
    const r3 = poolRate(known, 3, now) ?? r24;
    const s24 = simulate(known, r24, now, horizon);
    const level = levelOf(s24);
    const left = known.reduce((s, r) => s + Math.max(100 - r.used, 0), 0) / known.length;
    const evenLeft = known.reduce((s, r) => s + Math.max(0, Math.min(100, ((r.resetsAt - now) / WEEK) * 100)), 0) / known.length;
    const accounts = known.length > 1 ? `${known.length} account · ` : '';
    let right, sub;
    if (s24.runsOutAt == null) {
      right = 'arriva al reset';
      sub = `${accounts}al ritmo di oggi (${Math.round(r24)}% al giorno) regge fino al reset, ${when(horizon, now)}`;
    } else {
      right = (s24.runsOutAt - now < DAY ? 'finisce ' : 'fino a ') + when(s24.runsOutAt, now);
      sub = `${accounts}al ritmo di oggi (${Math.round(r24)}% al giorno), poi ${span(s24.gapUntil - s24.runsOutAt)} senza, fino a ${when(s24.gapUntil, now)}`;
    }
    // Eccezione per la barra: solo ciò che ti tocca entro 12 ore.
    // La finestra di 5 ore conta quando è piena su tutti gli account che hanno ancora quota settimanale.
    let exception = null;
    const usable = known.filter((r) => r.used < 100);
    const fiveFull = usable.length > 0 && usable.every((r) => r.fiveHour && r.fiveHour.used >= 95 && r.fiveHour.resetsAt > now);
    if (fiveFull) {
      const at = Math.min(...usable.map((r) => r.fiveHour.resetsAt));
      exception = { at, text: `${name} 5 ore piena fino alle ${new Date(at).toLocaleTimeString('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}` };
    }
    if (s24.runsOutAt != null && s24.runsOutAt - now < 12 * 3600000 && level > 0 && (!exception || s24.runsOutAt < exception.at)) {
      exception = { at: s24.runsOutAt, text: `${name} finisce alle ${new Date(s24.runsOutAt).toLocaleTimeString('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })}` };
    }
    out.push({
      id, status: ['ok', 'stretto', 'corto'][level], level, left: Math.round(left), evenLeft: Math.round(evenLeft),
      rate24: Math.round(r24 * 10) / 10, rate3: Math.round(r3 * 10) / 10,
      runsOutAt: s24.runsOutAt, gapUntil: s24.gapUntil, horizon, right, sub, exception,
    });
  }
  return out;
}

// Frase in cima al menu: la cosa più vicina che ti tocca, poi una rassicurazione.
export function headline(fc, now = Date.now()) {
  const bad = fc.filter((f) => f.level > 0).sort((a, b) => a.runsOutAt - b.runsOutAt);
  const ok = fc.filter((f) => f.level === 0).map((f) => NAMES[f.id] || f.id);
  if (!bad.length) return { title: 'Ti basta tutto fino al reset', sub: ok.length ? `${ok.join(', ')} arrivano al reset al ritmo di oggi` : '' };
  const first = bad[0], name = NAMES[first.id] || first.id;
  const title = first.runsOutAt - now < DAY ? `${name} finisce ${when(first.runsOutAt, now)}` : `${name} regge fino a ${when(first.runsOutAt, now)}`;
  const rest = bad.slice(1).map((f) => `${NAMES[f.id] || f.id} fino a ${when(f.runsOutAt, now)}`).concat(ok.length ? [`${ok.join(', ')} ok`] : []);
  return { title, sub: [...rest, 'le tue sessioni non si fermano'].join(' · ') };
}
