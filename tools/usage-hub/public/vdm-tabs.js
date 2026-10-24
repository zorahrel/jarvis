// Schede che erano della pagina VDM (account, consumi, sessioni, attività, impostazioni). Caricato prima di app.js: usa i suoi helper a chiamata avvenuta.
// Il motore (proxy, rotazione, tetti) resta VDM: qui si legge e si scrive via /vdm/api/*.
let USD_EUR = 0.92;
const eur = (usd) => { const e = usd * USD_EUR; return e === 0 ? '€0' : e < 0.01 ? '<€0,01' : e < 100 ? '€' + e.toFixed(2).replace('.', ',') : '€' + Math.round(e).toLocaleString('it-IT'); };
const tok = (n) => (!n ? '0' : n >= 1e9 ? (n / 1e9).toFixed(1).replace('.0', '').replace('.', ',') + ' G' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '').replace('.', ',') + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n));
const hhmmss = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const left = (resetUnix) => { if (!resetUnix) return 'finestra mobile'; const d = resetUnix - Math.floor(Date.now() / 1000); if (d <= 0) return 'si azzera ora'; const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60); return h > 24 ? `${Math.floor(h / 24)} g ${h % 24} h` : h > 0 ? `${h} h ${m} min` : `${m} min`; };
const PLAN_FX = (sub, tier) => { const s = String(sub || '').toLowerCase(), t = String(tier || '').toLowerCase(); if (s === 'max' || t.includes('max')) { const m = t.match(/(\d+)x/); return m && Number(m[1]) >= 20 ? 200 : 100; } return s === 'pro' || t.includes('pro') ? 20 : 0; };
const planLabel = (sub, tier) => { const s = String(sub || 'free').toLowerCase(), t = String(tier || '').toLowerCase(); if (s === 'max' || t.includes('max')) { const m = t.match(/(\d+)x/); return m ? 'MAX ' + m[1] + 'x' : 'MAX'; } return s === 'pro' || t.includes('pro') ? 'PRO' : 'FREE'; };
const STRAT = { 'reset-first': ['Reset first', "Usa l'account la cui settimana si azzera prima, così la quota che resta non si butta."], priority: ['Priority', 'Sempre il più prioritario disponibile; al limite passa al successivo e torna appena il preferito si libera.'], sticky: ['Sticky', 'Resta sull\'account attuale finché non scatta un 429 o 401. Mai cambi proattivi.'], conserve: ['Conserve', 'Concentra l\'uso su account con finestre già attive; gli altri restano a riposo e le loro finestre non partono.'], 'round-robin': ['Round robin', 'A turno sull\'account meno usato, con un timer fisso.'], spread: ['Spread', 'A ogni richiesta l\'account con meno uso nelle 5 ore. Cambia spesso.'], 'drain-first': ['Drain first', 'Prima l\'account più usato nelle 5 ore, per finirlo.'], balance: ['Balance', 'Ripartisce le richieste in parallelo per numero di richieste in corso, con un massimo per account.'] };
const BLOCK = (p) => {
  const until = p.retryAfter && p.retryAfter > Date.now() ? ' Torna disponibile ' + wk(p.retryAfter) + '.' : '';
  return ({ 'quota-5h': 'Finestra 5 ore esaurita.', 'quota-7d': 'Finestra settimanale esaurita.', auth: 'Token scaduto: serve un nuovo login.', model: 'Limite sul singolo modello (di solito Opus) con le due finestre ancora libere.' }[p.blockKind] || 'Bloccato dal proxy.') + until;
};

// ---------- Account ----------
function sparkline(hist, key, windowMs, hours) {
  const W = 320, H = 44, pt = 1, ph = 31, now = Date.now(), t0 = now - windowMs;
  let svg = '';
  const step = hours ? 3 * 3600000 : 86400000, first = new Date(t0);
  first.setMinutes(0, 0, 0); if (!hours) first.setHours(0);
  for (let t = Math.ceil(first.getTime() / step) * step; t <= now; t += step) {
    const x = ((t - t0) / windowMs) * W, d = new Date(t);
    svg += `<line x1="${x.toFixed(1)}" y1="${pt}" x2="${x.toFixed(1)}" y2="${pt + ph}" stroke="currentColor" opacity=".15" stroke-width=".5"/>`;
    if (!hours || d.getHours() % 6 === 0) svg += `<text x="${x.toFixed(1)}" y="${H - 1}" fill="currentColor" opacity=".5" font-size="7" text-anchor="middle">${hours ? d.getHours() + ':00' : d.toLocaleDateString('it-IT', { weekday: 'short' })}</text>`;
  }
  let pts = (hist || []).filter((h) => h.ts >= t0 && h.ts <= now);
  const filled = []; pts.forEach((p, i) => { filled.push(p); if (i < pts.length - 1 && pts[i + 1].ts - p.ts > 600000) filled.push({ ts: p.ts + 600000, [key]: 0 }); });
  pts = filled;
  if (pts.length) {
    const X = (t) => (((t - t0) / windowMs) * W).toFixed(1), Y = (p) => ((p[key] || 0) > 0 ? pt : pt + ph);
    let d = `M${X(pts[0].ts)},${pt + ph}`, e = '';
    pts.forEach((p, i) => { d += ` L${X(p.ts)},${Y(p)}`; e += `${i ? ' L' : 'M'}${X(p.ts)},${Y(p)}`; if (i < pts.length - 1) { d += ` L${X(pts[i + 1].ts)},${Y(p)}`; e += ` L${X(pts[i + 1].ts)},${Y(p)}`; } });
    svg += `<path d="${d} L${X(pts[pts.length - 1].ts)},${pt + ph} Z" fill="var(--info)" opacity=".25"/><path d="${e}" fill="none" stroke="var(--info)" stroke-width="1"/>`;
  }
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${svg}</svg>`;
}
function attrStrip(win) {
  if (!win || !win.bands || !win.bands.length) return '';
  const peak = win.bands.reduce((m, b) => Math.max(m, b.myTokens), 0);
  return '<div class="strip">' + win.bands.map((b) => {
    const w = new Date(b.to).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    let c, t;
    if (b.myTokens > 0) { c = 'mine'; t = `${w}: interno, ${tok(b.myTokens)} token passati dal proxy (${b.requests} richieste, ${eur(b.myCostUsd)})`; }
    else if (b.deltaUtil === null) { c = 'unk'; t = `${w}: nessuna misura, non so se l'account si è mosso`; }
    else if (b.deltaUtil > 0) { c = 'ext'; t = `${w}: +${Math.round(b.deltaUtil * 100)}% di quota senza traffico dal proxy: esterno`; }
    else { c = 'idle'; t = `${w}: fermo`; }
    return `<i class="${c}" ${c === 'mine' && peak ? `style="opacity:${(0.35 + 0.65 * b.myTokens / peak).toFixed(2)}"` : ''} title="${esc(t)}"></i>`;
  }).join('') + '</div>';
}
// Interno = passato da questo proxy. Esterno = quota consumata che il proxy non ha visto (claude.ai, altre app, altri computer).
function attrFigures(win, period) {
  if (!win) return '';
  const b = win.tokenBreakdown || {}, direct = (b.inputTokens || 0) + (b.outputTokens || 0), cache = (b.cacheReadTokens || 0) + (b.cacheCreationTokens || 0), share = win.externalShare;
  let verdict;
  if (share === null || share === undefined) verdict = '<span class="mut">quota esterna non misurata</span>';
  else if (win.coverage < 0.25) verdict = `<span class="mut">misurato sul ${Math.round(win.coverage * 100)}% del periodo: circa ${Math.round(share * 100)}% esterno</span>`;
  else verdict = `<b>${Math.round((1 - share) * 100)}% interno</b> <span class="mut">· ${Math.round(share * 100)}% esterno</span>`;
  const tip = `${win.requests} richieste misurate dal proxy${win.coverage > 0 ? `, esterno calcolato sul ${Math.round(win.coverage * 100)}% del periodo` : ''}. Interno: traffico passato da questo proxy. Esterno: quota consumata fuori dal proxy (claude.ai, altre app, altri computer).`;
  return `<div class="small" title="${esc(tip)}">${tok(win.myTokens)} token interni <span class="mut">· ${eur(win.myCostUsd)} a listino · ${period}</span></div>` +
    (win.myTokens > 0 ? `<div class="small mut" title="I/O = input e output; cache = token letti o creati nella cache, contati a ogni richiesta">${tok(direct)} I/O · ${tok(cache)} cache</div>` : '') + `<div class="small" title="${esc(tip)}">${verdict}</div>`;
}
const capMark = (c, over) => (c == null ? '' : `<div class="capmark ${over ? 'hit' : ''}" style="left:${Math.min(c, 100)}%" title="Tetto ${c}%: oltre, il proxy smette di scegliere questo account"></div>`);

async function renderAccounts() {
  const [pf, st] = await Promise.all([vdm('/api/profiles'), vdm('/api/settings')]);
  if (!pf) { $('t-accounts').innerHTML = `<section>${empty('Il proxy VDM non risponde.')}</section>`; return; }
  if (st && st.usdEur) USD_EUR = st.usdEur;
  const ps = pf.probeStats, q = pf.queueStats;
  const head = [`${pf.profiles.length} account`, (STRAT[pf.rotationStrategy] || [pf.rotationStrategy])[0], ps && ps.probeCount7d ? `${nfmt(ps.probeCount7d)} sonde in 7 giorni · circa ${nfmt(ps.inputTokens + ps.outputTokens)} token di overhead` : '',
    q && q.balanceMode && (q.balanceInflight || q.balanceWaiting) ? `Balance: ${q.balanceInflight} in corso${q.balanceWaiting ? `, ${q.balanceWaiting} in attesa di uno slot` : ''}` : q && !q.balanceMode && (q.inflight || q.queued) ? `Coda: ${q.inflight} in corso, ${q.queued} in fila` : ''].filter(Boolean).join(' · ');
  if (cur === 'accounts') $('sub').textContent = head;
  const banner = pf.allExhausted ? `<section class="status bad">${IC.hand}<div><b>Tutti gli account sono esauriti</b><span class="mut small">Il primo si libera: ${esc(pf.earliestReset || 'sconosciuto')}</span></div></section>` : '';
  const cards = pf.profiles.map((p) => {
    const n = esc(p.name), rl = p.rateLimits, off = !!p.disabled, cap = p.cap || { override: {}, effective: {} }, ov = cap.override || {}, ef = cap.effective || {};
    const own = ov.fiveH != null || ov.sevenD != null, attr = p.attribution || {};
    const extra = p.blockKind === 'extra-usage', perm = p.blockKind === 'permission', rateBlocked = !!p.limited && !off && !extra && !perm;
    const stale = !p.isActive && (p.expired || p.refreshFailed || (p.expiresAt && p.expiresAt < Date.now()));
    const badges = [`<span class="pill info">${planLabel(p.subscriptionType, p.rateLimitTier)}</span>`, cap.over ? '<span class="pill warn">tetto raggiunto</span>' : '', off ? '<span class="pill mut">spento</span>' : '', extra ? '<span class="pill bad">extra usage esaurito</span>' : '', perm ? '<span class="pill bad">OAuth non consentito</span>' : '', rateBlocked ? '<span class="pill bad">non selezionabile</span>' : '', p.isActive ? '<span class="pill ok">attivo</span>' : ''].join('');
    let vel = ''; if (p.isActive && p.minutesToLimit != null) { const m = p.minutesToLimit; vel = m <= 0 ? '<span class="pill bad" title="Stima del tempo al limite 5 ore dal ritmo attuale">al limite</span>' : m < 300 ? `<span class="pill bad" title="Stima del tempo al limite 5 ore dal ritmo attuale">limite tra circa ${Math.round(m / 10) * 10 < 60 ? Math.max(5, Math.round(m / 10) * 10) + ' min' : Math.floor(Math.round(m / 10) * 10 / 60) + ' h ' + (Math.round(m / 10) * 10 % 60) + ' min'}</span>` : '<span class="pill ok" title="Stima del tempo al limite 5 ore dal ritmo attuale">oltre 5 h al limite</span>'; }
    let bars;
    if (rl) {
      const win = (label, w, a, period, hist, key, ms, hours, capv, over) => { const u = Math.round(w.utilization * 100); return `<div><div class="small" style="display:flex;justify-content:space-between"><span class="mut" title="Finestra del piano Claude, non l'extra usage">${label}${capv != null ? ` <span class="${over ? 'warn' : 'mut'}">· tetto ${capv}%</span>` : ''}</span><b class="${cls(u, 90, 70)}">${u}%</b></div><div class="track">${'<div class="fill ' + cls(u, 90, 70) + '" style="width:' + Math.min(100, u) + '%"></div>'}${capMark(capv, over)}</div><div class="small mut">si libera tra ${left(w.reset)}</div>${attrStrip(a)}${attrFigures(a, period)}${sparkline(hist, key, ms, hours)}</div>`; };
      bars = `<div class="two">${win('5 ore', rl.fiveH, attr.fiveH, 'ultime 5 ore', p.utilizationHistory, 'u5h', 86400000, true, ef.fiveH, cap.over5h)}${win('Settimana', rl.sevenD, attr.sevenD, 'ultimi 7 giorni', p.weeklyHistory, 'u7d', 7 * 86400000, false, ef.sevenD, cap.over7d)}</div><div class="legend small mut"><span><i class="mine"></i>interno (passato dal proxy)</span><span><i class="ext"></i>esterno (fuori dal proxy)</span><span><i class="unk"></i>non misurato</span></div>`;
    } else bars = p.dormant ? '<div class="small info">Dormiente: la finestra è conservata</div>' : '<div class="small mut">Limiti non disponibili</div>';
    const msg = (t, c) => `<div class="msg ${c || ''}">${t}</div>`;
    const msgs = (extra ? msg('Extra usage esaurito. Le barre 5 ore e settimana sono limiti del piano, non l\'extra usage di terze parti.') : '') + (perm ? msg('Anthropic rifiuta OAuth per l\'organizzazione di questo account (403). Non passa da solo: un admin deve consentire Claude Code, oppure si rimuove l\'account.') : '') + (rateBlocked ? msg(esc(BLOCK(p))) : '') +
      ((p.modelBlocks || []).length && !off ? msg('In pausa solo per ' + p.modelBlocks.map((b) => esc(b.label) + ' fino a ' + wk(b.until)).join(', ') + '. Gli altri modelli continuano su questo account.') : '') + (off ? msg('Escluso dalla rotazione: il proxy non sceglierà questo account.') : '') +
      (stale ? msg(p.refreshFailed && !p.refreshFailed.retriable ? 'Token scaduto. Premi Aggiorna token oppure rifai il login.' : 'Token scaduto: il rinnovo automatico riprova a breve.', 'bad') : '');
    const capBody = own ? `<input type="number" min="1" max="99" value="${ov.fiveH ?? ''}" placeholder="${ef.fiveH ?? 'off'}" data-act="capv" data-n="${n}" data-w="fiveH" title="Tetto sulla finestra 5 ore (%). Vuoto = ereditato"> <input type="number" min="1" max="99" value="${ov.sevenD ?? ''}" placeholder="${ef.sevenD ?? 'off'}" data-act="capv" data-n="${n}" data-w="sevenD" title="Tetto sulla settimana (%). Vuoto = ereditato">` : `<span class="mut small">${ef.fiveH != null || ef.sevenD != null ? `eredita il globale (${ef.fiveH != null ? '5 ore ' + ef.fiveH + '%' : ''}${ef.fiveH != null && ef.sevenD != null ? ' · ' : ''}${ef.sevenD != null ? 'settimana ' + ef.sevenD + '%' : ''})` : 'nessun tetto'}</span>`;
    return `<div class="card acard ${p.isActive ? 'active' : ''}" style="${off ? 'opacity:.75' : ''}"><div class="head">${provIcon('claude')}<span>${esc(p.label || p.name)}</span>${vel}<span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">${badges}</span></div><div style="margin-left:26px">${bars}${msgs}</div>
      <div class="row" style="margin-top:8px"><span class="mut small" title="Più alto = preferito. Conta con la strategia Priority">Priorità</span><button class="b" data-act="prio" data-n="${n}" data-v="${(p.priority || 0) - 1}">−</button><b>${p.priority || 0}</b><button class="b" data-act="prio" data-n="${n}" data-v="${(p.priority || 0) + 1}">+</button>
        <span class="mut small" style="margin-left:10px" title="Oltre il tetto il proxy smette di scegliere questo account, e riprende quando la finestra si azzera">Tetto</span><label class="sw"><input type="checkbox" data-act="cap" data-n="${n}" data-own="${own ? 1 : 0}" ${own ? 'checked' : ''}><i></i></label>${capBody}
        <span class="grow"></span><span class="mut small">${off ? 'spento' : 'acceso'}</span><label class="sw"><input type="checkbox" data-act="enabled" data-n="${n}" ${off ? '' : 'checked'}><i></i></label></div>
      ${p.isActive ? '' : `<div class="row">${stale ? `<button class="b" data-act="refresh" data-n="${n}">Aggiorna token</button>` : off ? '' : `<button class="b" data-act="switch" data-n="${n}">Usa questo account</button>`}<span class="grow"></span><button class="b danger" data-act="remove" data-n="${n}" data-l="${esc(p.label)}">Rimuovi</button></div>`}</div>`;
  }).join('');
  const api = (pf.apiProfiles || []).length ? `<section><h2>Account API (di riserva)</h2><p class="small mut">Per le richieste API native. I crediti promozionali Max/Team non coprono le richieste interattive di Claude Code.</p>${pf.apiProfiles.map((a) => `<div class="row"><span class="grow">${esc(a.label)}${a.disabled ? ' <span class="mut small">· spento</span>' : ''}${a.balance != null ? ` <span class="mut small">· saldo ${esc(typeof a.balance === 'number' ? '$' + a.balance.toFixed(2) : JSON.stringify(a.balance))}</span>` : ''}${a.usage5h != null ? ` <span class="mut small">· 5 ore ${Math.round(a.usage5h * (a.usage5h <= 1 ? 100 : 1))}%</span>` : ''}${a.usage7d != null ? ` <span class="mut small">· settimana ${Math.round(a.usage7d * (a.usage7d <= 1 ? 100 : 1))}%</span>` : ''}</span><span class="mut small">Priorità</span><input type="number" min="-1000" max="1000" value="${a.priority}" id="ap-${esc(a.name)}"><button class="b" data-act="apiprio" data-n="${esc(a.name)}">Salva</button><button class="b" data-act="apidis" data-n="${esc(a.name)}" data-v="${a.disabled ? 0 : 1}">${a.disabled ? 'Attiva' : 'Disattiva'}</button></div>`).join('')}</section>` : '';
  const stt = pf.stats;
  const statsHtml = stt ? (() => {
    const mu = Object.values(stt.modelUsage || {}), tt = mu.reduce((s, m) => s + (m.inputTokens || 0) + (m.outputTokens || 0), 0), cr = mu.reduce((s, m) => s + (m.cacheReadInputTokens || 0), 0);
    const tm = {}; (stt.dailyModelTokens || []).forEach((d) => { tm[d.date] = Object.values(d.tokensByModel || {}).reduce((s, v) => s + v, 0); });
    const daily = (stt.dailyActivity || []).slice(-14), mxm = Math.max(1, ...daily.map((d) => d.messageCount || 0)), mxt = Math.max(1, ...daily.map((d) => tm[d.date] || 0));
    return card('Attività Claude Code (14 giorni)', `<div class="grid"><div class="kpi"><b>${nfmt(stt.totalSessions || 0)}</b><span>sessioni</span></div><div class="kpi"><b>${nfmt(stt.totalMessages || 0)}</b><span>messaggi</span></div><div class="kpi"><b>${nfmt(tt)}</b><span>token</span></div><div class="kpi"><b>${nfmt(cr)}</b><span>cache lette</span></div></div><div class="bars14">${daily.map((d) => `<div title="${esc(d.date)}: ${d.messageCount || 0} messaggi, ${nfmt(tm[d.date] || 0)} token"><i style="height:${Math.max(3, (d.messageCount || 0) / mxm * 80)}px"></i><i class="b2" style="height:${Math.max(3, (tm[d.date] || 0) / mxt * 80)}px"></i><span>${esc(d.date.slice(5))}</span></div>`).join('')}</div>`, false);
  })() : '';
  $('t-accounts').innerHTML = banner + cards + api + statsHtml;
}

// ---------- Consumi ----------
const PRICE = { 'claude-fable-5': [10, 50], 'claude-mythos-5': [10, 50], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25], 'claude-opus-4-5': [5, 25], 'claude-sonnet-5': [3, 15], 'claude-sonnet-4-6': [3, 15], 'claude-sonnet-4-5': [3, 15], 'claude-haiku-4-5': [1, 5] };
const costOf = (e) => { let k = null; for (const x of Object.keys(PRICE)) if (String(e.model || '').startsWith(x) && (!k || x.length > k.length)) k = x; const [i, o] = k ? PRICE[k] : [5, 25]; return ((e.inputTokens || 0) / 1e6) * i + ((e.outputTokens || 0) / 1e6) * o + (((e.cacheReadTokens || 0) / 1e6) * i * 0.1) + (((e.cacheCreationTokens || 0) / 1e6) * i * 1.25); };
const COLORS = ['#60a5fa', '#a78bfa', '#22d3ee', '#4ade80', '#fbbf24', '#f87171', '#f472b6'];
const USAGE = { raw: [], f: { days: 7, model: '', account: '', repo: '' }, plan: 0, open: {} };
const repoName = (r) => String(r || '').split('/').pop() || '(senza cartella)';
function usageFiltered() { const f = USAGE.f; return USAGE.raw.filter((e) => (!f.model || e.model === f.model) && (!f.account || e.account === f.account) && (!f.repo || repoName(e.repo) === f.repo)); }
function drawUsage() {
  const data = usageFiltered(), f = USAGE.f;
  const tot = { i: 0, o: 0, c: 0, n: data.length }, by = { model: {}, account: {}, repo: {}, day: {} };
  for (const e of data) {
    const c = costOf(e), t = (e.inputTokens || 0) + (e.outputTokens || 0); tot.i += e.inputTokens || 0; tot.o += e.outputTokens || 0; tot.c += c;
    const add = (m, k, br) => { const x = (m[k] ||= { t: 0, c: 0, n: 0, br: {} }); x.t += t; x.c += c; x.n++; if (br) { const y = (x.br[br] ||= { t: 0, c: 0 }); y.t += t; y.c += c; } };
    add(by.model, e.model || '?'); add(by.account, e.account || '?'); add(by.repo, repoName(e.repo), e.branch || '(senza ramo)');
    const d = new Date(e.ts).toISOString().slice(0, 10), x = (by.day[d] ||= { t: 0, c: 0 }); x.t += t; x.c += c;
  }
  const total = tot.i + tot.o, planDay = USAGE.plan / 30, days = f.days;
  const rows = (m, colored) => { const es = Object.entries(m).sort((a, b) => b[1].t - a[1].t); return es.length ? (colored ? `<div class="stack">${es.map(([k, v], i) => `<i style="width:${total ? v.t / total * 100 : 0}%;background:${COLORS[i % 7]}"></i>`).join('')}</div>` : '') + `<table><tbody>${es.map(([k, v], i) => `<tr><td>${colored ? `<i class="dot" style="background:${COLORS[i % 7]}"></i>` : ''}${esc(colored === 'm' ? short(k) : k)}</td><td class="num mut">${tok(v.t)}</td><td class="num mut hide-s">${eur(v.c)}</td><td class="num">${total ? Math.round(v.t / total * 100) : 0}%</td></tr>`).join('')}</tbody></table>` : empty('Nessun dato.'); };
  const repoRows = Object.entries(by.repo).sort((a, b) => b[1].t - a[1].t).map(([k, v]) => `<details class="tr" ${USAGE.open[k] ? 'open' : ''} data-k="${esc(k)}"><summary><span>${esc(k)}</span><span class="num mut">${tok(v.t)}</span><span class="num mut hide-s">${eur(v.c)}</span><span class="num">${total ? Math.round(v.t / total * 100) : 0}%</span></summary>${Object.entries(v.br).sort((a, b) => b[1].t - a[1].t).map(([b, x]) => `<div class="br"><span>${esc(b)}</span><span class="num mut">${tok(x.t)}</span><span class="num mut hide-s">${eur(x.c)}</span></div>`).join('')}</details>`).join('');
  const dkeys = Object.keys(by.day).sort(), mx = Math.max(1, ...dkeys.map((d) => by.day[d].t));
  const dchart = dkeys.length ? `<div class="bars14 wide">${dkeys.map((d) => `<div title="${esc(d)}: ${tok(by.day[d].t)} token · ${eur(by.day[d].c)}"><i style="height:${Math.max(3, by.day[d].t / mx * 90)}px"></i><span>${esc(d.slice(5))}</span></div>`).join('')}</div>` : empty('Nessun dato.');
  let cum = 0, plan = 0; const pts = dkeys.map((d, i) => { cum += by.day[d].c; plan = planDay * (i + 1); return [cum, plan]; });
  const top = Math.max(1, ...pts.map((p) => Math.max(p[0], p[1]))), W = 600, H = 120;
  const line = (k) => pts.map((p, i) => `${i ? 'L' : 'M'}${(i / Math.max(1, pts.length - 1) * W).toFixed(1)},${(H - p[k] / top * (H - 8) - 2).toFixed(1)}`).join(' ');
  const saving = pts.length ? `<svg viewBox="0 0 ${W} ${H}" class="spark" style="height:120px"><path d="${line(0)}" fill="none" stroke="var(--info)" stroke-width="2"/><path d="${line(1)}" fill="none" stroke="currentColor" opacity=".5" stroke-dasharray="4 3"/></svg><div class="small mut"><span style="color:var(--info)">▬</span> equivalente a listino API (${eur(tot.c)}) <span>┅</span> costo del piano (${eur(plan)}) · risparmio nel periodo: <b class="ok">${eur(Math.max(0, tot.c - plan))}</b></div>` : empty('Nessun dato.');
  const opt = (vals, cur, all) => `<option value="">${all}</option>` + vals.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
  const uniq = (fn) => [...new Set(USAGE.raw.map(fn))].filter(Boolean).sort();
  $('usage-main').innerHTML = `<div class="row" style="border:0"><select data-u="repo">${opt(uniq((e) => repoName(e.repo)), f.repo, 'Tutte le cartelle')}</select><select data-u="model">${opt(uniq((e) => e.model), f.model, 'Tutti i modelli')}</select><select data-u="account">${opt(uniq((e) => e.account), f.account, 'Tutti gli account')}</select><select data-u="days">${[1, 7, 30].map((d) => `<option value="${d}" ${d === days ? 'selected' : ''}>${d === 1 ? 'Oggi' : d + ' giorni'}</option>`).join('')}</select><span class="grow"></span><button class="b" data-u="csv">Esporta CSV</button></div>
    <div class="grid"><div class="kpi"><b>${tok(total)}</b><span>token totali</span></div><div class="kpi"><b>${tok(tot.i)}</b><span>input</span></div><div class="kpi"><b>${tok(tot.o)}</b><span>output</span></div><div class="kpi"><b>${nfmt(tot.n)}</b><span>richieste</span></div><div class="kpi"><b>${eur(tot.c)}</b><span>equivalente a listino API</span></div></div>
    ${USAGE.plan ? `<p class="small mut">Il tuo piano (${eur(USAGE.plan)}/mese) ti fa risparmiare circa <b class="ok">${eur(Math.max(0, tot.c / days - planDay))}/giorno</b> rispetto alle tariffe API (${eur(planDay)}/giorno di piano contro ${eur(tot.c / days)}/giorno di API).</p>` : ''}
    ${card('Token al giorno', dchart, false)}${card('Risparmio rispetto all\'API', saving, false)}${card('Per modello', rows(by.model, 'm'))}${card('Per account', rows(by.account, 'a'))}${card('Per cartella e ramo', `<div class="trl">${repoRows || empty('Nessun dato.')}</div>`, false)}`;
}
async function renderUsage() {
  $('t-usage').innerHTML = '<div id="usage-main"><section>' + empty('Carico…') + '</section></div><div id="usage-extra"></div>';
  const [pf, st, tu] = await Promise.all([vdm('/api/profiles'), vdm('/api/settings'), vdm('/api/token-usage?days=' + USAGE.f.days)]);
  if (st && st.usdEur) USD_EUR = st.usdEur;
  USAGE.raw = Array.isArray(tu) ? tu : [];
  USAGE.plan = ((pf && pf.profiles) || []).reduce((s, p) => s + PLAN_FX(p.subscriptionType, p.rateLimitTier), 0);
  drawUsage();
  const [report, overview] = await Promise.all([j('/api/projects'), j('/api/overview')]);
  $('usage-extra').innerHTML = extraPanels(report, overview);
}
document.addEventListener('change', (e) => {
  const k = e.target.dataset && e.target.dataset.u; if (!k) return;
  if (k === 'days') { USAGE.f.days = Number(e.target.value); renderUsage(); } else { USAGE.f[k] = e.target.value; drawUsage(); }
});
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-u="csv"]'); if (c) {
    const d = usageFiltered(); if (!d.length) return toast('Niente da esportare');
    const q = (s) => '"' + String(s || '').replace(/"/g, '""') + '"';
    const csv = ['timestamp,repo,branch,model,account,input_tokens,output_tokens', ...d.map((x) => [new Date(x.ts).toISOString(), q(x.repo), q(x.branch), q(x.model), q(x.account), x.inputTokens || 0, x.outputTokens || 0].join(','))].join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'consumi-' + new Date().toISOString().slice(0, 10) + '.csv'; a.click(); URL.revokeObjectURL(a.href);
  }
  const t = e.target.closest('details.tr'); if (t) setTimeout(() => { USAGE.open[t.dataset.k] = t.open; }, 0);
});

// ---------- Sessioni ----------
async function renderSessions() {
  const s = await vdm('/api/sessions');
  if (!s) { $('t-sessions').innerHTML = `<section>${empty('Il proxy VDM non risponde.')}</section>`; return; }
  const proj = (x) => x.repo ? x.repo + (x.branch ? '/' + x.branch : '') : x.cwd || '?';
  const tl = (x) => (x.timeline || []).map((t) => `<div class="small ${t.type === 'input' ? '' : 'mut'}" style="${t.type === 'input' ? 'font-weight:600' : 'padding-left:12px'}">${esc(t.text)}</div>`).join('');
  const act = (s.active || []).map((x) => {
    const idle = Date.now() - x.lastActiveAt, waiting = idle > 120000;
    return `<div class="card acard ${waiting ? '' : 'active'}"><div class="head">${provIcon('claude')}<span>${esc(x.account)} · ${esc(proj(x))}</span><span class="mut small" style="margin-left:auto">${dur(Date.now() - x.startedAt)}${waiting ? ` · in attesa di input da ${dur(idle)}` : ''}</span></div>${x.currentActivity ? `<div class="small" style="margin-left:26px">${esc(x.currentActivity)}</div>` : ''}<details><summary>cronologia</summary>${tl(x)}</details><div class="small mut" style="margin-left:26px">${esc(short(x.model))} · ${x.requestCount} richieste · ${nfmt(x.totalInputTokens + x.totalOutputTokens)} token</div></div>`;
  }).join('');
  const rec = (s.recent || []).map((x) => `<details class="card"><summary><span style="color:var(--fg)">${ago(x.completedAt || x.startedAt)} · <b>${esc(x.account)}</b> · ${esc(proj(x))}</span> <span class="mut small">· ${dur(x.duration || 0)} · circa ${eur(costOf({ model: x.model, inputTokens: x.totalInputTokens, outputTokens: x.totalOutputTokens }))} · ${x.requestCount || 0} richieste · ${nfmt((x.totalInputTokens || 0) + (x.totalOutputTokens || 0))} token</span></summary>${tl(x)}</details>`).join('');
  const conf = (s.conflicts || []).length ? `<section class="status warn">${IC.hand}<div>${s.conflicts.map((c) => `<div>${c.count} sessioni modificano ${esc(c.file)}</div>`).join('')}</div></section>` : '';
  const oh = s.overhead && s.overhead.inputTokens + s.overhead.outputTokens > 0 ? `<p class="small mut">Overhead del riassunto delle sessioni: ${nfmt(s.overhead.inputTokens + s.overhead.outputTokens)} token (Haiku)</p>` : '';
  $('t-sessions').innerHTML = conf + (!(s.active || []).length && !(s.recent || []).length ? `<section>${empty(s.enabled ? 'Nessuna sessione: avviane una con il proxy acceso.' : 'Il monitor sessioni è spento: accendilo in Impostazioni.')}</section>` : (act ? '<h2>Attive</h2>' + act : '') + (rec ? '<h2>Recenti</h2>' + rec : '')) + oh;
  $('nsess').hidden = !(s.active || []).length; $('nsess').textContent = (s.active || []).length;
}

// ---------- Attività ----------
const EVT = { 'auto-switch': ['info', (e) => `Cambio automatico da <b>${esc(e.from || '?')}</b> a <b>${esc(e.to || '?')}</b>`], 'proactive-switch': ['info', (e) => `Cambio proattivo a <b>${esc(e.to || '?')}</b>`], 'manual-switch': ['info', (e) => `Cambio manuale a <b>${esc(e.to || '?')}</b>`], 'rate-limited': ['warn', (e) => `<b>${esc(e.account || '?')}</b> rate limit${e.retryAfter ? ` (${Math.round(e.retryAfter / 60)} min)` : ''}`], 'auth-expired': ['bad', (e) => `<b>${esc(e.account || '?')}</b> token scaduto`], 'all-exhausted': ['bad', () => 'Tutti gli account esauriti'], 'account-discovered': ['ok', (e) => `Trovato <b>${esc(e.label || e.name || '?')}</b>`], 'account-renamed': ['mut', (e) => `<b>${esc(e.name || '?')}</b> rinominato in <b>${esc(e.label || '?')}</b>`], 'account-enabled': ['mut', (e) => `<b>${esc(e.name || '?')}</b> ${e.enabled ? 'riacceso' : 'spento: escluso dalla rotazione'}`], 'settings-changed': ['mut', () => 'Impostazioni cambiate'], upgrade: ['ok', (e) => `Aggiornato a <b>${esc(e.to || '?')}</b>`], 'refresh-failed': ['bad', (e) => `<b>${esc(e.account || '?')}</b> rinnovo fallito: ${esc(e.error || 'sconosciuto')}`], 'token-refreshed': ['ok', (e) => `<b>${esc(e.account || '?')}</b> token rinnovato`], overloaded_error: ['warn', (e) => `<b>${esc(e.account || '?')}</b> Anthropic sovraccarico (tentativo ${e.attempt})`] };
async function renderActivity() {
  const a = await vdm('/api/activity'), log = (a && a.log) || [];
  $('t-activity').innerHTML = `<section>${log.length ? `<table><tbody>${log.map((e) => { const [c, f] = EVT[e.type] || ['mut', () => esc(e.type)]; return `<tr><td class="mut small" style="width:120px">${when(e.ts)} ${hhmmss(e.ts).slice(-8, -3) ? '' : ''}</td><td style="width:14px"><i class="dot ${c}" style="background:currentColor"></i></td><td>${f(e)}</td></tr>`; }).join('')}</tbody></table>` : empty('Ancora nessuna attività.')}</section>`;
}

// ---------- Impostazioni ----------
async function renderSettings() {
  const s = await vdm('/api/settings');
  if (!s) { $('t-settings').innerHTML = `<section>${empty('Il proxy VDM non risponde.')}</section>`; return; }
  if (s.usdEur) USD_EUR = s.usdEur;
  const sw = (k, label, hint, v) => `<div class="row"><div class="grow">${label}<div class="small mut">${hint}</div></div><label class="sw"><input type="checkbox" data-act="setting" data-k="${k}" ${v ? 'checked' : ''}><i></i></label></div>`;
  const num = (k, label, hint, v) => `<div class="row"><div class="grow">${label}<div class="small mut">${hint}</div></div><input type="number" data-act="setting" data-k="${k}" min="1" max="99" value="${v ?? ''}" placeholder="off"> %</div>`;
  const sel = (k, label, hint, vals, cur, fmt) => `<div class="row"><div class="grow">${label}<div class="small mut">${hint}</div></div><select data-act="setting" data-num="1" data-k="${k}">${vals.map((v) => `<option value="${v}" ${Number(cur) === v ? 'selected' : ''}>${fmt(v)}</option>`).join('')}</select></div>`;
  const hold = (m) => (m === 0 ? 'nessuna' : m < 60 ? m + ' min' : m / 60 + (m === 60 ? ' ora' : ' ore'));
  const hv = [0, 1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440], cur = s.usageCapHoldMin ?? 10;
  if (!hv.includes(cur)) hv.push(cur);
  const strat = STRAT[s.rotationStrategy] || [s.rotationStrategy, ''];
  $('t-settings').innerHTML = `<section><h2>Proxy</h2>${sw('proxyEnabled', 'Proxy attivo', 'Le chiamate di Claude Code passano dal proxy locale', s.proxyEnabled)}${sw('autoSwitch', 'Cambio automatico al limite', 'Passa a un altro account su 429 o 401', s.autoSwitch)}${sw('notifications', 'Notifiche', 'Avvisi macOS su cambi, limiti ed errori', s.notifications !== false)}</section>
    <section><h2>Tetti globali</h2>${num('usageCap5h', 'Finestra 5 ore', 'Oltre questa % l\'account non viene scelto; vuoto = nessun tetto', s.usageCap5h)}${num('usageCap7d', 'Finestra settimanale', 'Idem sui 7 giorni: a 100% mette fuori gioco l\'account per giorni', s.usageCap7d)}${sel('usageCapHoldMin', 'Attesa massima quando sono tutti fermi', 'Se nessun account è utilizzabile le richieste aspettano invece di fallire; scaduto il tempo rispondono 429', hv.sort((a, b) => a - b), cur, hold)}
    <div class="row"><div class="grow">Cambio dollaro → euro<div class="small mut">Serve solo a mostrare in euro il valore a listino</div></div><input type="number" step="0.01" data-act="setting" data-num="1" data-k="usdEur" value="${s.usdEur ?? 0.92}" style="width:72px"></div></section>
    <section><h2>Rotazione</h2><div class="row"><div class="grow">Strategia<div class="small mut">${esc(strat[1])}</div></div><select data-act="setting" data-k="rotationStrategy">${Object.entries(STRAT).map(([k, v]) => `<option value="${k}" ${k === s.rotationStrategy ? 'selected' : ''}>${esc(v[0])}</option>`).join('')}</select></div>
    ${s.rotationStrategy === 'round-robin' ? sel('rotationIntervalMin', 'Intervallo di rotazione', 'Ogni quanto passa all\'account successivo', [15, 30, 60, 120], s.rotationIntervalMin || 60, (v) => (v >= 60 ? v / 60 + ' h' : v + ' min')) : ''}
    ${s.rotationStrategy === 'balance' ? sel('maxConcurrentPerAccount', 'Richieste in parallelo per account', 'Oltre questo numero passa al successivo', [2, 4, 6, 8, 12, 16], s.maxConcurrentPerAccount || 8, String) : ''}</section>
    <section><h2>Beta</h2>${sw('serializeRequests', 'Richieste in fila', 'Mette in coda le richieste in parallelo per evitare i 429', s.serializeRequests)}${s.serializeRequests ? sel('serializeDelayMs', 'Pausa tra le richieste', 'Millisecondi tra una richiesta e la successiva', [0, 100, 200, 500, 1000], s.serializeDelayMs ?? 200, (v) => v + ' ms') : ''}${sw('commitTokenUsage', 'Token nei commit', 'Aggiunge ai commit il consumo di token', s.commitTokenUsage)}${sw('sessionMonitor', 'Monitor sessioni', 'Riassume le sessioni attive (usa Haiku, vedi overhead in Sessioni)', s.sessionMonitor)}</section>`;
}
