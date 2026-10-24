// Dashboard unica del hub. Il proxy VDM (account, impostazioni, sessioni) è raggiunto da /vdm/api/*; qui non c'è altra pagina.
const $ = (id) => document.getElementById(id);
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.body.classList.add('embed');

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleString('it-IT', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–');
const hhmm = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
const wk = (t) => new Date(t).toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const nfmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1).replace('.', ',') + ' G' : n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace('.', ',') + ' k' : String(Math.round(n)));
const pct = (v) => (v > 0 ? (v >= 10 ? Math.round(v) : v.toFixed(1).replace('.', ',')) + '%' : '–');
const dur = (ms) => { const m = Math.floor(ms / 60000); if (m < 1) return 'meno di 1 min'; if (m < 60) return m + ' min'; const h = Math.floor(m / 60); return h < 24 ? h + ' h' + (m % 60 && h < 10 ? ' ' + (m % 60) + ' min' : '') : Math.floor(h / 24) + ' g'; };
const ago = (t) => (Date.now() - t < 60000 ? 'ora' : dur(Date.now() - t) + ' fa');
const day = (t) => { const d = new Date(t); return d.getDate() + '/' + (d.getMonth() + 1); };
const cls = (v, hi, lo) => (v >= hi ? 'bad' : v >= lo ? 'warn' : '');
const short = (m) => String(m || '').replace(/^claude-/, '').replace(/-(\d)-(\d)$/, ' $1.$2').replace(/-/g, ' ');
const PROV = { claude: 'Claude', codex: 'Codex', muse: 'Muse' };
const CLASSES = { interattivo: 'Interattivo (sessioni aperte)', gusto: 'Di gusto (design, scrittura)', massivo: 'Massivo (codice meccanico)', batch: 'Batch (rimandabile)' };

// Le stesse icone della tray (SF Symbols): sparkle, code, waveform, hand.raised, gauge, tray, folder, play.circle, moon, chart.
const IC = {
  // Loghi veri (Anthropic, OpenAI, Meta) come maschera: il colore lo dà il CSS, OpenAI segue il tema.
  claude: '<span class="ic brand b-claude"></span>',
  codex: '<span class="ic brand b-codex"></span>',
  muse: '<span class="ic brand b-muse"></span>',
  check: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16 9.8"/></svg>',
  chip: '<svg class="ic" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/></svg>',
  hand: '<svg class="ic" viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 013 0V11M11 10.5V4a1.5 1.5 0 013 0v7M14 11V5.5a1.5 1.5 0 013 0V14a6 6 0 01-6 6h-.5a6 6 0 01-5-2.7L3.7 13.8a1.5 1.5 0 012.4-1.7L8 14"/></svg>',
  gauge: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 12l4-4M8 17.5a5.5 5.5 0 018 0"/></svg>',
  tray: '<svg class="ic" viewBox="0 0 24 24"><path d="M3 13l2.5-7h13L21 13v6H3zM3 13h5l1 2h6l1-2h5"/></svg>',
  folder: '<svg class="ic" viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 014.5 5h4l2 2.5h9A1.5 1.5 0 0121 9v9a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18z"/></svg>',
  play: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 8.5l5 3.5-5 3.5z"/></svg>',
  moon: '<svg class="ic" viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 019.5 4 8.5 8.5 0 1020 14.5z"/></svg>',
  chart: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 4v16h16M7 15l4-4 3 3 5-6"/></svg>',
};
const provIcon = (p) => IC[p] || '';

const j = (u, opt) => fetch(u, { signal: AbortSignal.timeout(60000), ...opt }).then((r) => r.json()).catch(() => null);
const vdm = (p, opt) => j('/vdm' + p, opt);
const post = (p, body, method = 'POST') => vdm(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
let toastT; const toast = (m) => { $('toast').textContent = m; $('toast').classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => $('toast').classList.remove('on'), 2800); };
const card = (title, body, open = true) => `<details class="card" ${open ? 'open' : ''}><summary>${title}</summary>${body}</details>`;
const empty = (t) => `<div class="mut small">${t}</div>`;

// ---------- Panoramica ----------
// Grafico dell'andamento accanto alla barra, come nella tray: scala 0–100 fissa, linea a gradini con l'area, punto sull'ultimo valore.
function spark(points, spanMs, tone = '') {
  const now = Date.now(), from = now - spanMs, pts = (points || []).filter((p) => p.t * 1000 >= from).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return '<span class="spk"></span>';
  const x = (t) => ((t * 1000 - from) / spanMs) * 120, y = (v) => 22 - (Math.min(Math.max(v, 0), 100) / 100) * 20;
  let d = `M${x(pts[0].t).toFixed(1)},${y(pts[0].v).toFixed(1)}`;
  for (let k = 1; k < pts.length; k++) d += `H${x(pts[k].t).toFixed(1)}V${y(pts[k].v).toFixed(1)}`;
  const last = pts[pts.length - 1], area = `${d}V22H${x(pts[0].t).toFixed(1)}Z`;
  return `<svg class="spk ${tone}" viewBox="0 0 120 24" preserveAspectRatio="none"><path class="a" d="${area}"/><path d="${d}"/><circle cx="${x(last.t).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="1.8"/></svg>`;
}
// Una riga: etichetta, barra con tacca, numero, grafico, nota breve.
const barRow = (label, frac, tone, value, mark, sp, note) => `<span>${label}</span><div class="track"><div class="fill ${tone}" style="width:${Math.min(100, Math.max(0, frac))}%"></div>${mark != null ? `<div class="mark" style="left:${Math.min(100, mark)}%"></div>` : ''}</div><b class="${tone}">${value}</b>${sp}<span class="mut">${note}</span>`;
const paceTone = (r) => (r >= 1.5 ? 'bad' : r >= 1.1 ? 'warn' : '');
const timesTxt = (x) => (x >= 10 ? 'oltre 10' : x.toFixed(1).replace('.', ',')) + '×';
function bars(a) {
  const ratio = a.elapsedPct >= 5 ? a.used / a.elapsedPct : 0, wt = a.used >= 90 ? 'bad' : paceTone(ratio);
  let h = barRow('Settimana', a.used, wt, Math.round(a.used) + '%', a.elapsedPct, spark(a.history, 7 * 86400000, wt), 'azzera ' + wk(a.resetsAt));
  if (a.fiveHour) { const t = a.fiveHour.used >= 95 ? 'bad' : a.fiveHour.used >= 80 ? 'warn' : ''; h += barRow('5 ore', a.fiveHour.used, t, Math.round(a.fiveHour.used) + '%', null, '<span class="spk"></span>', 'libera tra ' + dur(a.fiveHour.resetsAt - Date.now())); }
  // «Oggi» è un indicatore 0–2× con la tacca a 1× (la quota di un giorno): si legge senza fare conti.
  if (a.perDay > 0 && a.last24h != null) { const x = a.last24h / a.perDay, t = paceTone(x); h += barRow('Oggi', Math.min(x / 2, 1) * 100, t, timesTxt(x), 50, '<span class="spk"></span>', `${pct(a.last24h)} in 24 h · ok ${pct(a.perDay)}`); }
  return `<div class="bars">${h}</div>`;
}
// Perché un account aspetta e cosa lo sbloccherà, per esteso (stessa frase della tray).
function resumeText(w) {
  const at = w.until ? (new Date(w.until).toDateString() === new Date().toDateString() ? hhmm(w.until) : wk(w.until)) : '?', t = Math.round(w.target || 0);
  switch (w.kind) {
    case '5h': return `Finestra di 5 ore piena: il differibile riparte alle ${at}, quando si libera`;
    case 'riserva': return `Sotto il ${t}% la quota resta per le tue sessioni: il differibile riparte al reset, ${at}`;
    case 'ritmo': return `Più veloce del ritmo della settimana: riparte alle ${at}, quando il tempo trascorso arriva al ${t}% già usato (se non si consuma altro)`;
    case 'giorno': return `Ultime 24 ore oltre ${String(w.target).replace('.', ',')}% al giorno: riparte alle ${at}, quando quel consumo esce dalle 24 ore`;
    default: return 'Il differibile aspetta: ' + w.why;
  }
}
const untilShort = (t) => (new Date(t).toDateString() === new Date().toDateString() ? hhmm(t) : wk(t));
function stateOf(p, queue) {
  const n = p.agents ? p.agents.count : 0, q = queue.filter((x) => x.project === p.name && (x.status === 'queued' || x.status === 'running')).length;
  if (p.state === 'frenato') return { cls: 'warn', icon: 'hand', text: n ? `frenato · ${n}` : 'frenato' };
  if (n) return { cls: 'ok', icon: 'play', text: `${n} ${n === 1 ? 'agente' : 'agenti'} al lavoro` };
  if (q) return { cls: 'info', icon: 'tray', text: `in coda ${q}` };
  return { cls: 'mut', icon: 'moon', text: p.lastSeen ? 'fermo da ' + dur(Date.now() - p.lastSeen.at) : 'fermo' };
}
// «codex/a@x: …; claude/b@y: …» → «aspetta Codex a, Claude b»: il motivo per account sta nel suo blocco.
function brakeWho(why) {
  if (!why) return '';
  const who = why.split('; ').map((seg) => seg.match(/^(\w+)\/([^:]+):/)).filter(Boolean).map((m) => `${PROV[m[1]] || m[1]} ${m[2].split('@')[0]}`);
  return who.length ? 'aspetta ' + who.join(', ') : why;
}
function reason(p) {
  if (p.agents && p.agents.count) return '';
  if (p.state === 'frenato') return 'frenato: ' + (p.budgetPct != null && p.claude >= p.budgetPct ? `il budget Claude (${p.budgetPct}% della settimana) è finito` : (brakeWho(p.why) || 'i lavori rimandabili aspettano un abbonamento libero'));
  let s = 'fermo: nessun agente al lavoro ' + (p.lastSeen ? `da ${dur(Date.now() - p.lastSeen.at)}, ultima attività il ${day(p.lastSeen.at)} (${PROV[p.lastSeen.provider] || p.lastSeen.provider})` : 'da oltre 7 giorni');
  if (p.dirMissing) s += ' · la cartella era temporanea e non esiste più';
  return s;
}
function agentsHtml(p) {
  if (!p.agents && !(p.subgroups && p.subgroups.length)) return '';
  if (!p.agents) return `<details><summary>${p.members.length} cartelle</summary><div class="small mut">${p.subgroups.map((g) => `<div><b>${esc(g.path)}</b>: ${esc(g.members.join(', '))}</div>`).join('')}</div></details>`;
  const mix = p.agents.models.map((m) => `${m.n} ${m.model}`).join(' · ');
  const list = p.agents.list.map((g) => {
    const link = g.open ? ` <a href="${esc(g.open.url)}" title="Si apre in ${esc(g.open.via)}">apri</a>` : '';
    // sottoagenti rientrati sotto la sessione che li ha lanciati (depth 1), gli agenti di workflow un gradino in più
    const d = g.depth || 0;
    return `<div class="agent"${d ? ` style="margin-left:${d * 18}px"` : ''}>${d ? '<span class="mut">↳</span> ' : ''}<span>${provIcon(g.provider)}</span> <b>${esc(g.model)}</b> <span class="mut">${esc(g.kind)} · da ${dur(Date.now() - g.startedAt)} · ${ago(g.lastActivity)}${PagesView.useWords(g.use) ? ' · ' + PagesView.useWords(g.use) : ''}</span>${link}<span class="t">${esc(PagesView.humanTitle(g.title))}</span></div>`;
  }).join('');
  const opus = p.agents.opus > 0 && (p.claude >= 10 || p.agents.opusMs >= 2 * 3600000) ? `<div class="warnline">${p.agents.opus} Opus da ${dur(p.agents.opusMs)} su un progetto al ${pct(p.claude)} della settimana Claude: valuta Sonnet</div>` : '';
  const chats = p.topics && p.topics.length ? `<div class="small mut">Topics: ${p.topics.map((c) => `<a href="${esc(c.url)}">${esc(c.title || 'chat')}</a>`).join(' · ')}</div>` : '';
  const subs = p.subgroups && p.subgroups.length ? `<div class="small mut">${p.subgroups.map((g) => `<div><b>${esc(g.path)}</b> · ${g.members.length} cartelle${g.agents ? ` · ${g.agents} agenti` : ''}: ${esc(g.members.join(', '))}</div>`).join('')}</div>` : '';
  return `<details><summary>${esc(mix)}</summary>${subs}${list}${opus}${chats}</details>`;
}
function projectRows(live, items) {
  const ps = (live && live.projects) || [], alive = ps.filter((p) => !p.dead), dead = ps.filter((p) => p.dead);
  // Una colonna di soli «–» non dice niente: si mostra solo il provider che ha consumo su almeno un progetto.
  const cols = ['claude', 'codex', 'muse'].filter((k) => ps.some((p) => p[k] > 0));
  const row = (p, dim) => { const s = stateOf(p, items), r = reason(p);
    return `<tr class="${dim ? 'dim' : ''}"><td><b>${esc(p.title && p.title !== p.name ? p.title : PagesView.humanProject(p.name))}</b>${p.priority && p.priority !== 'normale' ? ` <span class="pill ${p.priority === 'alta' ? 'warn' : 'mut'}">priorità ${esc(p.priority)}</span>` : ''}<div class="small mut">${esc(p.what || '')}</div>${agentsHtml(p)}</td>` +
      // su telefono l'intestazione sparisce: ogni numero porta con sé icona e nome del provider
      cols.map((k) => `<td class="num ${p[k] > 0 ? '' : 'mut'}"><span class="pv">${IC[k]} ${PROV[k]}</span>${pct(p[k])}</td>`).join('') +
      `<td class="state ${s.cls}" title="${esc(r)}">${IC[s.icon]} ${esc(s.text)}</td></tr>`; };
  // l'intestazione dice icona e nome del provider, e si ripete nella tabella dei nascosti
  const head = `<thead><tr><th>Progetto${cols.length ? ' · % della settimana' : ''}</th>${cols.map((k) => `<th class="num"><span class="pvh">${IC[k]} ${PROV[k]}</span></th>`).join('')}<th>Stato</th></tr></thead>`;
  return `<table class="proj">${head}<tbody>${alive.map((p) => row(p, false)).join('')}</tbody></table>` +
    (dead.length ? `<details><summary>Nascosti dal menu (${dead.length}): fermi da 7 giorni o cartella sparita</summary><table class="proj">${head}<tbody>${dead.map((p) => row(p, true)).join('')}</tbody></table></details>` : '');
}

// Il Mac come un account: una barra per misura con la tacca alla soglia di «impegnato» e il grafico delle 24 h.
const MAC_LIMIT = { cpu: 85, mem: 80, gpu: 80, disk: 85 };
function macHtml(m) {
  const e = m && m.effort; if (!e) return '';
  const c = ['', 'warn', 'bad'][e.level] || '';
  // Il grafico copre i dati che ci sono (lo storico vive in memoria nell'hub): 15 minuti su 24 ore sarebbero una riga invisibile.
  const first = Math.min(...Object.values(m.history || {}).flat().map((x) => x.t * 1000), Date.now());
  const span = Math.min(86400000, Math.max(600000, Date.now() - first));
  const rows = e.parts.filter((p) => p.pct != null).map((p) => {
    const t = ['', 'warn', 'bad'][p.level] || '', hist = (m.history && m.history[p.key]) || [];
    let note = `picco ${Math.max(p.pct, ...hist.map((x) => x.v))}%`;
    // accanto alla % la quantità vera, come nella tray: core occupati, GB usati, GB liberi
    const gb = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace('.', ',') + ' GB';
    if (p.key === 'cpu') note = p.load >= 1 ? `${String(p.load).replace('.', ',')} in fila per core` : `${(p.pct / 100 * m.cores).toFixed(1).replace('.', ',')} di ${m.cores} core occupati`;
    if (p.key === 'mem' && m.mem) note = `usati ${gb(m.mem.usedGB)} di ${gb(m.mem.totalGB)}`;
    if (p.key === 'disk' && m.disk) note = `${gb(m.disk.freeGB)} liberi di ${gb(m.disk.totalGB)}`;
    // «RAM» come i riquadri della tray; il nome «memoria» resta per le frasi dell'hub (WhatsApp, motivi del freno)
    const label = p.key === 'mem' ? 'RAM' : p.name[0].toUpperCase() + p.name.slice(1);
    return barRow(esc(label), p.pct, t, p.pct + '%', MAC_LIMIT[p.key], spark(hist, span, t), note);
  }).join('');
  const lines = [];
  if (e.level > 0) lines.push((e.why ? e.why[0].toUpperCase() + e.why.slice(1) + ' · ' : '') + 'pesa di più: ' + (m.hogs || []).slice(0, 3).map((h) => `${h.name} ${(h.memMB / 1024).toFixed(1).replace('.', ',')} GB`).join(', '));
  if (m.paused && m.paused.length) lines.push('In pausa finché respira: ' + m.paused.map((p) => p.label).join(', '));
  const tip = 'Conta la misura più vicina alla sua soglia (la tacca): CPU 85/97% o oltre 1/1,5 processi in fila per core, memoria 80/92% o swap sostenuta, GPU 80/95%, disco 85/95%. Sotto sforzo gli agenti in background di priorità bassa vanno in pausa; le sessioni aperte non si fermano mai.';
  const g1 = (x) => (x >= 100 ? x.toFixed(0) : x.toFixed(1)).replace('.', ',') + ' GB';
  // la swap di macOS cresce a file da 1 GB e sta sempre quasi piena: avvisa solo se rilegge davvero da disco (come la tray)
  const swapFull = m.swapSustained;
  const ram = m.mem ? `<div class="small mut" style="margin:6px 0 0 26px" title="App = memoria dei programmi; wired = del sistema; compressa = già compressa per far posto; cache = file tenuti in memoria che macOS libera quando serve.">RAM: app ${g1(m.mem.appGB)} · wired ${g1(m.mem.wiredGB)} · compressa ${g1(m.mem.compressedGB)} · cache ${g1(m.mem.cachedGB)} · libera ${g1(m.mem.freeGB)} · <span class="${swapFull ? 'warn' : ''}">swap ${g1(m.swapUsedGB || 0)} di ${g1(m.swapTotalGB || 0)}${m.swapSustained ? ', rilegge da disco' : ''}</span></div>` : '';
  return `<section class="acct block ${c ? 'lv-' + c : ''}" title="${tip}"><div class="head">${IC.chip}<span>Mac</span><span class="mut small">${m.cores} core · ${span < 86400000 ? 'da ' + dur(span) : 'ultime 24 h'}</span><span class="pill ${c || 'ok'}">${esc(e.label)}</span></div>${lines.map((l) => `<div class="brake ${c}">${esc(l)}</div>`).join('')}<div class="bars">${rows}</div>${ram}</section>`;
}

async function renderOverview() {
  // «Ti aspetta» compare subito; quote, Mac e progetti (lenti sotto carico) arrivano dopo, sotto.
  let done = false;
  const waitP = attesaSection();
  waitP.then((w) => { if (!done && !$('t-overview').querySelector('[data-sec=wait]')) $('t-overview').innerHTML = w + '<p class="mut small" data-loading>Carico quote, agenti e Mac…</p>'; });
  // I progetti (agenti vivi, la lettura più lenta a freddo) arrivano per ultimi nel loro riquadro: il resto non li aspetta.
  const liveP = j('/api/live', { signal: AbortSignal.timeout(20000) });
  let [wait, gates, queue, pace, heavy, alerts, mac] = await Promise.all([waitP, ...['/api/gates', '/api/queue', '/api/pace', '/api/heavy', '/api/alerts', '/api/mac'].map((u) => j(u, { signal: AbortSignal.timeout(u === '/api/gates' ? 8000 : 20000) }))]);
  done = true;
  // Sotto carico il freno può metterci 30 s: la Panoramica non lo aspetta oltre 8 s, il resto non oltre 20.
  // un errore dell'hub arriva come oggetto {error}: per quote e ritmo vale «nessun dato», non un crash
  if (!Array.isArray(pace)) pace = null;
  if (gates && !gates.classes) gates = null;
  const items = (queue && queue.items) || [], waiting = items.filter((x) => x.status === 'queued' || x.status === 'running');
  const over = (heavy && heavy.over) || [], braked = Object.entries((gates && gates.providers) || {}).filter(([, v]) => v.state === 'frenato').map(([k]) => PROV[k]);
  // Stesso verdetto della tray: si nomina l'account, perché un provider può correre su un account ed essere libero su un altro.
  const times = (x) => (x >= 10 ? 'oltre 10' : x.toFixed(1).replace('.', ',')) + '×';
  const overTxt = [...over].sort((a, b) => b.last24h / Math.max(b.perDay, 0.1) - a.last24h / Math.max(a.perDay, 0.1)).map((o) => `${PROV[o.provider]} ${String(o.account).split('@')[0]} ${times(o.last24h / Math.max(o.perDay, 0.1))} la quota di oggi`);
  const bg = gates && gates.classes && gates.classes.batch, deferred = bg ? (bg.go ? 'rimandabili su ' + (bg.provider === 'free' ? 'canali gratis' : PROV[bg.provider] || bg.provider) : 'rimandabili fermi') : '';
  const qtxt = waiting.length ? `in coda ${waiting.length}` : '';
  let st;
  if (!gates) st = ['warn', 'Freno non letto', 'il motore della delega non ha risposto in 8 s: riprovo tra un minuto'];
  else if (braked.length) st = ['bad', Object.entries(gates.providers).filter(([, v]) => v.state === 'frenato').map(([k, v]) => PROV[k] + (v.waitUntil ? ' fino alle ' + untilShort(v.waitUntil) : '')).join(' · ') + (braked.length > 1 ? ' frenati' : ' frenato'), [overTxt[0], deferred, qtxt].filter(Boolean).join(' · ')];
  else if (overTxt.length) st = ['warn', overTxt[0], [overTxt[1], deferred, qtxt].filter(Boolean).join(' · ')];
  else st = ['', 'Tutto in linea', ['nessun freno', qtxt].filter(Boolean).join(' · ')];
  const firing = (alerts && alerts.firing) || [];
  const accounts = (pace || []).map((a) => {
    const s = (gates && gates.providers && gates.providers[a.provider]) || {}, ex = a.used >= 100;
    // Frenato = questo account ha un motivo suo; l'ora è la sua, non quella del provider.
    const w = s.state === 'frenato' ? (s.accounts || []).find((x) => x.account === a.account) : null;
    const badge = ex ? '<span class="pill bad">esaurito</span>' : w ? `<span class="pill warn">frenato${w.until ? ' fino alle ' + untilShort(w.until) : ''}</span>` : s.override ? `<span class="pill ok" title="${esc('override di ' + s.override.by + ': ' + s.override.reason)}">libero fino alle ${hhmm(s.override.until)}</span>` : a.used >= 90 ? `<span class="pill warn" title="Il provider è libero, ma questo account ha quasi finito la settimana: il lavoro va sugli altri">quasi finito</span>` : '<span class="pill ok">libero</span>';
    const body = ex ? `<div class="small bad" style="margin-left:26px">esaurito · torna ${wk(a.resetsAt)}</div>`
      : a.unknown ? '<div class="small mut" style="margin-left:26px">quota non letta adesso: il lavoro ci va lo stesso, al limite rifiuta il provider</div>'
      : bars(a);
    return `<div class="acct ${w ? 'block lv-warn' : ''}"><div class="head">${provIcon(a.provider)}<span>${PROV[a.provider] || a.provider} · ${esc(String(a.account).split('@')[0])}</span>${badge}</div>${w ? `<div class="brake warn">${esc(resumeText(w))}</div>` : ''}${body}</div>`;
  }).join('') || empty('Nessun dato di quota');
  const brake = gates ? `<table><thead><tr><th>Classe di lavoro</th><th>Va su</th><th>Perché</th></tr></thead><tbody>${Object.entries(gates.classes).map(([k, v]) => `<tr><td>${CLASSES[k] || k}</td><td class="${v.go ? 'ok' : 'warn'}">${v.go ? (v.provider === 'free' ? 'canali gratis' : PROV[v.provider] || v.provider) : 'fermo'}</td><td class="mut small">${esc(v.reason)}</td></tr>`).join('')}</tbody></table><p class="small mut">Le sessioni aperte non vengono mai bloccate: si ferma solo il lavoro rimandabile.</p>` : '';
  const queueHtml = waiting.length ? `<table><tbody>${waiting.map((x) => `<tr><td>${esc(x.task.slice(0, 90))}</td><td>${esc(x.project || '–')}</td><td class="${x.status === 'running' ? 'ok' : 'info'}">${x.status === 'running' ? 'in corso' : 'in attesa' + (x.waitUntil ? ' fino alle ' + hhmm(x.waitUntil) : '')}</td></tr>`).join('')}</tbody></table>` : empty('Nessun lavoro in attesa.');
  $('t-overview').innerHTML = wait +
    `<section class="status ${st[0]}">${st[0] ? IC.hand : IC.check}<div><b>${st[1]}</b><span class="mut small">${st[2]}</span></div></section>` +
    macHtml(mac) +
    (firing.length ? `<section>${firing.map((e) => `<div class="bad small">${esc(e.message)}</div>`).join('')}</section>` : '') +
    `<section>${accounts}<div id="acc-missing"></div></section>` +
    card(`${IC.gauge} Come funziona il freno <span class="mut small">${braked.length ? 'frenati: ' + braked.join(', ') : 'nessun freno'}</span>`, brake, false) +
    card(`${IC.tray} Coda <span class="mut small">${waiting.length ? waiting.length + ' in attesa' : 'vuota'}</span>`, queueHtml, false) +
    `<section data-sec="proj"><p class="mut small" data-loading>Carico progetti e agenti…</p></section>`;
  liveP.then((live) => { const el = $('t-overview').querySelector('[data-sec=proj]'); if (el) el.innerHTML = projectRows(live, items); });
  if (cur === 'overview') $('sub').textContent = 'aggiornato alle ' + hhmm(Date.now());
  // Un abbonamento che non risponde non sparisce senza dirlo, come nella tray. L'overview è lenta: arriva dopo, senza bloccare.
  j('/api/overview').then((ov) => {
    const seen = new Set((pace || []).map((a) => a.provider)), el = $('acc-missing');
    if (!ov || !el) return;
    el.innerHTML = (ov.providers || []).filter((p) => !seen.has(p.id) && PROV[p.id]).map((p) => `<div class="acct"><div class="head">${provIcon(p.id)}<span>${esc(p.name || PROV[p.id])} ${p.error ? 'non raggiungibile' : '· quota non letta'}</span></div><div class="small mut" style="margin-left:26px" title="${esc(String(p.error || ''))}">${p.error ? 'numeri e freno ignoti finché non risponde' : 'il ritmo non ha numeri adesso: il lavoro ci va lo stesso, al limite rifiuta il provider'}</div></div>`).join('');
  }).catch(() => {});
}

// ---------- Progetti ----------
async function renderProjects() {
  const [live, queue] = await Promise.all([j('/api/live'), j('/api/queue')]);
  $('t-projects').innerHTML = `<section>${projectRows(live, (queue && queue.items) || [])}</section>`;
}

// ---------- Account: azioni (le schede sono in vdm-tabs.js) ----------
const bar = (v, color) => `<div class="track"><div class="fill ${color || cls(v, 90, 70)}" style="width:${Math.min(100, v)}%"></div></div>`;
// Pulsanti che scrivono: la richiesta la costruisce actionRequest (actions.js), qui si invia e si mostra l'esito.
const WRITE_ACTS = new Set(['prio', 'switch', 'refresh', 'remove', 'apiprio', 'apidis', 'enabled', 'cap', 'capv']);
async function doAction(t) {
  const a = t.dataset.act, req = actionRequest(a, t.dataset, { value: t.value, checked: t.checked, apiPriority: $('ap-' + t.dataset.n) && $('ap-' + t.dataset.n).value });
  if (!req) return;
  if (req.error) return toast(req.error);
  if (a === 'remove' && !confirm('Rimuovere ' + t.dataset.l + '?')) return;
  const r = await post(req.path, req.body, req.method);
  toast(r && r.ok !== false ? req.msg : 'Non riuscito: ' + ((r && r.error) || 'proxy non risponde'));
  renderAccounts();
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]'); if (!t || t.tagName === 'INPUT' || !WRITE_ACTS.has(t.dataset.act)) return;
  doAction(t);
});
document.addEventListener('change', async (e) => {
  const t = e.target; const a = t.dataset && t.dataset.act; if (!a) return;
  if (WRITE_ACTS.has(a)) return doAction(t);
  if (a === 'setting') { const v = t.type === 'checkbox' ? t.checked : t.type === 'number' ? (t.value === '' ? null : Number(t.value)) : t.value; const r = await post('/api/settings', { [t.dataset.k]: t.dataset.num ? Number(v) : v }); toast(r ? 'Salvato' : 'Non salvato'); if (['rotationStrategy', 'serializeRequests'].includes(t.dataset.k)) renderSettings(); }
});

// ---------- Consumi ----------
function extraPanels(report, overview) {
  const rp = (report && report.projects) || [], mx = Math.max(1, ...rp.map((x) => x.weekPct));
  const shareRow = (x) => `<tr><td>${esc(PagesView.humanProject(x.name))}</td><td>${bar(x.weekPct / mx * 100, x.weekPct > 80 ? 'bad' : x.weekPct > 50 ? 'warn' : '')}</td><td class="num">${pct(x.weekPct)}</td><td class="num hide-s">${x.requests}</td><td class="num hide-s">${x.subWeekPct != null ? pct(x.subWeekPct) + ' · ' + x.subRequests : '–'}</td><td class="num hide-s">${nfmt(x.tokens || 0)}</td><td class="hide-s mut small">${when(x.lastAt)}</td></tr>`;
  // «Altri N» ripete l'intestazione: aperto, ogni colonna dice ancora cosa conta
  const shareHead = '<thead><tr><th>Cartella</th><th><span class="sr">Barra della quota</span></th><th class="num"><span class="pvh">' + IC.claude + ' Claude % sett.</span></th><th class="num hide-s">Rich.</th><th class="num hide-s" title="la parte lanciata da sottoagenti">di cui sottoagenti</th><th class="num hide-s">Token</th><th class="hide-s">Ultima</th></tr></thead>';
  const share = rp.length ? `<table class="share">${shareHead}<tbody>${rp.slice(0, 15).map(shareRow).join('')}</tbody></table>${rp.length > 15 ? `<details><summary>Altri ${rp.length - 15}</summary><table class="share">${shareHead}<tbody>${rp.slice(15).map(shareRow).join('')}</tbody></table></details>` : ''}` : empty('Report non ancora pronto: riprova tra poco.');
  const mu = report && report.muse;
  const muse = mu ? `${mu.quota ? `<p class="small mut">${esc(mu.quota.label)}: <b>${mu.quota.weekPct}%</b> della settimana (azzera ${when(mu.quota.weekResetsAt)}) · 5 ore ${mu.quota.fiveHourPct}%</p>` : ''}${mu.projects && mu.projects.length ? `<table class="share m"><thead><tr><th>Cartella</th><th class="num"><span class="pvh">${IC.muse || ''} Muse % sett.</span></th><th class="num hide-s">Rich.</th><th class="num hide-s">Token</th><th class="hide-s">Ultima</th></tr></thead><tbody>${mu.projects.map((p) => `<tr><td>${esc(PagesView.humanProject(p.name))}</td><td class="num">${pct(p.weekPct)}</td><td class="num hide-s">${p.requests} rich.</td><td class="num hide-s">${nfmt(p.tokens || 0)}</td><td class="hide-s mut small">${when(p.lastAt)}</td></tr>`).join('')}</tbody></table>` : empty('Nessuna attività Muse.')}` : empty('Dato Muse non disponibile.');
  const px = report && report.proxy;
  const proxyRow = (p) => `<tr><td>${esc(PagesView.humanProject(p.name))}</td><td class="num">${p.requests}</td><td class="num hide-s">${nfmt(p.tokens || 0)}</td><td class="small ${p.needsLogs ? 'warn' : 'mut'}">${p.needsLogs ? 'dai log di sessione' : 'dal proxy'}</td></tr>`;
  const proxyHead = '<thead><tr><th>Cartella</th><th class="num"><span class="pvh">' + IC.claude + ' Claude rich.</span></th><th class="num hide-s">Token</th><th>Fonte</th></tr></thead>';
  const proxy = !px ? empty('Proxy non configurato.') : !px.available ? empty(esc(px.note)) : `<p class="small mut">${px.requests} richieste dal ${when(px.coverage && px.coverage.from)} al ${when(px.coverage && px.coverage.to)} · ${px.blindSessions} sessioni senza cartella · ${px.withoutCwd} richieste senza cartella</p><table>${proxyHead}<tbody>${(px.projects || []).slice(0, 10).map(proxyRow).join('')}</tbody></table>${(px.projects || []).length > 10 ? `<details><summary>Altre ${px.projects.length - 10}</summary><table>${proxyHead}<tbody>${px.projects.slice(10).map(proxyRow).join('')}</tbody></table></details>` : ''}`;
  const accs = ((overview && overview.providers) || []).flatMap((p) => (p.accounts || []).map((a) => ({ p, a })));
  const trayq = !accs.length ? empty('Il server della tray non risponde.') : `<table><thead><tr><th>Provider e account</th><th>Finestra</th><th class="num">Usata</th></tr></thead><tbody>${accs.flatMap(({ p, a }) => (a.quotas || []).map((q) => `<tr><td>${provIcon(p.id)} ${esc(p.name || p.id)} · ${esc(a.code || a.label)}</td><td>${esc(q.key)}</td><td class="num">${q.usedPct != null ? q.usedPct + '%' : '–'}</td></tr>`)).join('')}</tbody></table>`;
  return card('Per progetto · quota settimanale Claude', share, false) + card(`${provIcon('muse')} Muse questa settimana`, muse, false) + card('Attribuzione del proxy', proxy, false) + card('Quote lette dalla tray', trayq, false);
}

// ---------- Log ----------
// ---------- Servizi ----------
// Tutto ciò che fa girare le AI sul Mac, da services.json: vivo, fermo, memoria vera, link. Calcolato a scheda aperta.
const mbTxt = (mb) => (mb == null ? '–' : mb >= 1024 ? (mb / 1024).toFixed(1).replace('.', ',') + ' GB' : mb + ' MB');
async function renderServices() {
  if (!$('t-services').innerHTML) $('t-services').innerHTML = empty('Leggo launchd, processi e porte…');
  const r = await j('/api/services');
  if (!r) { $('t-services').innerHTML = empty('Hub non raggiungibile'); return; }
  const tone = { vivo: 'ok', 'in attesa': 'info', fermo: 'warn', spento: 'bad' };
  const bad = r.services.filter((x) => x.problem || x.state === 'fermo' || x.state === 'spento');
  // Le app di Attilio (hub, tray, Topics, Darkroom) in cima; i lavori a orario stanno nella scheda Automazioni.
  const apps = r.services.filter((x) => x.app);
  const groups = [...new Set(r.services.filter((x) => !x.app).map((x) => x.group))];
  const row = (x) => `<tr><td><b>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}</b><div class="small mut">${esc(x.what)}</div></td>` +
    `<td><span class="pill ${tone[x.state]}">${x.state}</span>${x.problem ? `<div class="small bad">${esc(x.problem)}</div>` : ''}</td>` +
    `<td class="num">${mbTxt(x.mb)}${x.treeMb != null && x.treeMb > x.mb ? `<div class="small mut" title="Processi lanciati da questo servizio: agenti, browser, server MCP">con ${x.children} figli ${mbTxt(x.treeMb)}</div>` : ''}</td>` +
    `<td class="small mut">${x.port ? ':' + x.port + (x.listening === false ? ' chiusa' : '') : ''}${x.label ? `<div>${esc(x.label)}</div>` : ''}</td></tr>`;
  $('t-services').innerHTML =
    `<section class="status ${bad.length ? 'warn' : ''}">${bad.length ? IC.hand : IC.check}<div><b>${bad.length ? bad.length + ' servizi da guardare' : 'Tutti i servizi sono su'}</b><span class="mut small">${r.services.filter((x) => x.state === 'vivo').length} vivi su ${r.services.length} · letto alle ${hhmm(r.at)}</span></div></section>` +
    `<p class="small mut">Vivo = processo acceso. In attesa = parte da solo alla prima richiesta. Fermo = caricato in launchd ma senza processo. Spento = non caricato. La memoria è quella vera (footprint); «con i figli» somma agenti, browser e MCP che il servizio ha lanciato.</p>` +
    [['Le tue app', apps], ...groups.map((g) => [g, r.services.filter((x) => !x.app && x.group === g)])].filter(([, xs]) => xs.length)
      .map(([g, xs]) => `<section><h3>${esc(g)}</h3><table class="proj svc"><thead><tr><th>Servizio</th><th>Stato</th><th class="num">Memoria</th><th>Porta · job</th></tr></thead><tbody>${xs.map(row).join('')}</tbody></table></section>`).join('') +
    `<p class="small mut">I lavori che partono a orario (launchd, OpenClaw, Claude desktop, GitHub) sono nella scheda <a href="#automations">Automazioni</a>.</p>`;
}

let logSrc;
function renderLogs() {
  if (logSrc) return;
  $('t-logs').innerHTML = '<section><div class="logbox" id="logbox"></div></section>';
  logSrc = new EventSource('/vdm/api/logs/stream');
  logSrc.onmessage = (m) => { try { const d = JSON.parse(m.data), b = $('logbox'), near = b.scrollTop + b.clientHeight >= b.scrollHeight - 40; b.append(document.createTextNode((d.line || d.msg || '') + '\n')); while (b.childNodes.length > 400) b.removeChild(b.firstChild); if (near) b.scrollTop = b.scrollHeight; } catch { /* riga non leggibile */ } };
}

// ---------- tab ----------
const TABS = { overview: renderOverview, journal: renderJournal, context: renderContext, projects: renderProjects, accounts: renderAccounts, usage: renderUsage, sessions: renderSessions, activity: renderActivity, settings: renderSettings, services: renderServices, automations: renderAutomations, logs: renderLogs };
let cur;
function show(h) {
  // «#automations/<chiave>» apre la scheda con il pannello di quella voce (link del Diario e di «Ti aspetta»).
  let [t, sel] = String(h || '').split(/\/(.*)/s);
  if (!TABS[t]) { t = 'overview'; sel = ''; }
  if (sel && t === 'automations') auUi.sel = decodeURIComponent(sel);
  cur = t; if (location.hash.slice(1) !== h) history.replaceState(null, '', '#' + t);
  const btn = document.querySelector(`#nav button[data-t="${t}"] span`);
  $('ptitle').textContent = btn ? btn.textContent : '';
  // Il sottotitolo è della tab: cambiando tab si azzera, e sta fuori dall'header, così non può schiacciare la nav.
  if (document.body.dataset.tab !== t) $('sub').textContent = '';
  document.body.dataset.tab = t;
  document.querySelectorAll('#nav button').forEach((b) => { b.classList.toggle('on', b.dataset.t === t); if (b.dataset.t === t) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  document.querySelectorAll('.tab').forEach((d) => d.classList.toggle('on', d.id === 't-' + t));
  TABS[t]();
  if (sel && t === 'automations') auGraph(auUi.sel);
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.t); });
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t !== cur) show(t); });
if (EMBED) { const post_ = () => parent.postMessage({ hubHeight: document.documentElement.scrollHeight + 8 }, '*'); new ResizeObserver(post_).observe(document.body); }
show(location.hash.slice(1) || 'overview');
setInterval(() => { if (['overview', 'journal', 'projects', 'accounts', 'sessions', 'activity', 'automations'].includes(cur) && !document.activeElement.matches('input,select')) TABS[cur](); }, 60000);
// il numero accanto a Sessioni: le sessioni vive dell'hub (/api/live), come la pagina
j('/api/live').then((lv) => { const n = ((lv && lv.projects) || []).reduce((t, p) => t + ((p.agents && p.agents.list) || []).length, 0); $('nsess').hidden = !n; $('nsess').textContent = n; });
