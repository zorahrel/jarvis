// Scheda «Automazioni» della dashboard: dal modello all'HTML, come una console.
// Tabella per scopo (mai per motore), pannello di dettaglio laterale, workflow come schema a passi.
// Funzione pura (niente Date.now, niente rete): la usano il browser e i test.
// Come actions.js: IIFE; in node `module.exports`, nel browser `root.AutomationsView`.
(function (root) {
  var TZ = 'Europe/Rome';

  // Via i caratteri che rompono l'HTML.
  // Testo libero senza id: gruppi WhatsApp, canali Discord, uuid e marcatori interni di OpenClaw (anche troncati)
  // diventano niente. Vale per descrizioni scritte a mano e per i messaggi delle sessioni.
  function noIds(t, keepSpace) {
    var r = String(t == null ? '' : t)
      .replace(/<<<[A-Z_]*(?:>>>|…|\.\.\.)?/g, '')
      .replace(/\s*\((?:canale|channel|gruppo|group|chat|id)\s+[\d@a-z.:-]*\d{6,}[\d@a-z.:-]*\)/gi, '')
      .replace(/\s+(?:con id|with id|channel|canale|chat|id)\s+\d{6,}(?:@[a-z.]+)?/gi, '')
      .replace(/\b\d{12,}(?:@[a-z.]+)?/gi, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
      .replace(/\b(account|conto|chat|utente|user)\s+\d{9,}/gi, '$1')
      .replace(/\(\s*\)/g, '');
    // nei <pre> (comandi, domande, errori) spazi e a capo restano com'erano
    return keepSpace ? r : r.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:)])/g, '$1').trim();
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Parti di una data in ora di Roma.
  function rome(at) {
    var p = {};
    var f = new Intl.DateTimeFormat('it-IT', {
      timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
    });
    for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
    return p;
  }
  function romeDay(at) {
    var p = rome(at);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
  }
  function hm(at) {
    var p = rome(at);
    return p.hour + ':' + p.minute;
  }
  function dm(at) {
    var p = rome(at);
    return p.day + '/' + p.month;
  }

  // Quando è successo, in parole. Mai solo un pallino.
  function lastWords(last, now) {
    var at = last && last.at;
    if (at == null) return 'mai partito';
    var n = now ?? Date.now();
    var p = rome(at);
    var h = p.hour + ':' + p.minute;
    var diff = romeDay(n) - romeDay(at);
    if (diff < 0) return diff === -1 ? 'domani alle ' + h : p.weekday + ' alle ' + h;
    if (diff === 0) return (Number(p.hour) < 6 ? 'stanotte alle ' : 'alle ') + h;
    if (diff === 1) return 'ieri alle ' + h;
    if (diff <= 6) return p.weekday + ' alle ' + h;
    return 'il ' + p.day + '/' + p.month + ' alle ' + h;
  }

  // Per le colonne: «14:00», «ieri 9:30», «mar 9:00», «12/10».
  function short(at, now) {
    if (at == null) return '—';
    var p = rome(at);
    var d = romeDay(now) - romeDay(at);
    var h = p.hour + ':' + p.minute;
    if (d === 0) return h;
    if (d === 1) return 'ieri ' + h;
    if (d === -1) return 'domani ' + h;
    if (Math.abs(d) <= 6) return p.weekday.slice(0, 3) + ' ' + h;
    return p.day + '/' + p.month;
  }

  function deliveredWords(d) {
    if (d === 'delivered') return 'ti è arrivato';
    if (d === 'failed') return 'non ti è arrivato';
    return '';
  }

  var OUTCOME = { ok: 'riuscito', error: 'fallito', skipped: 'saltato', running: 'in corso' };
  function outcomeWord(o) {
    return OUTCOME[o] || 'stato ignoto';
  }

  // Icone da un solo set (public/icons.js, Lucide). Senza il modulo (test in node) niente icona, mai un'emoji al posto.
  function ic(name, cls) {
    return root.Icons ? root.Icons.svg(name, cls) : '';
  }

  // ---- Scopo: ciò che le automazioni fanno per Attilio ----
  var AREAS = [
    { id: 'posta-avvisi', title: 'Posta e avvisi', icon: 'inbox' },
    { id: 'clienti', title: 'Clienti', icon: 'briefcase-business' },
    { id: 'sviluppo-topics', title: 'Sviluppo', icon: 'code-xml' },
    { id: 'jarvis-agenti', title: 'Jarvis e agenti', icon: 'bot' },
    { id: 'manutenzione', title: 'Manutenzione', icon: 'wrench' },
    { id: 'backup-sicurezza', title: 'Backup e sicurezza', icon: 'shield-check' },
    { id: 'computer-app', title: 'Computer e app', icon: 'monitor-smartphone', own: true },
  ];
  function areaIcon(id) {
    var a = AREAS.find(function (x) { return x.id === id; });
    return a ? a.icon : 'calendar-clock';
  }
  // Senza purpose (modello vecchio o fixture) l'area si stima dal gruppo, come fa purpose.mjs.
  var FROM_GROUP = { arriva: 'posta-avvisi', dati: 'backup-sicurezza', quote: 'jarvis-agenti', macchine: 'manutenzione', prodotti: 'sviluppo-topics' };
  function areaOf(c) {
    return (c.purpose && c.purpose.area) || FROM_GROUP[c.group] || 'manutenzione';
  }
  function forYou(c) {
    return (c.purpose && c.purpose.cosaFaPerTe) || c.cosa || '';
  }
  function ifBroken(c) {
    return (c.purpose && c.purpose.seSiRompe) || '';
  }

  // Il motore che la esegue: solo nel pannello, mai come gruppo.
  var SYS = { openclaw: 'OpenClaw', launchd: 'Mac (launchd)', desktop: 'Claude desktop', lobster: 'Lobster', workflow: 'Workflow', github: 'GitHub', pc: 'PC di casa' };

  function isProblem(c) {
    return c.level === 'te' || c.level === 'rotto';
  }

  // Tutte le card visibili, una volta sola.
  function allCards(model) {
    var seen = {};
    var out = [];
    var list = (model.needsYou || []).concat(model.broken || []);
    for (const g of model.groups || []) list = list.concat(g.cards || []);
    for (const c of list) {
      if (!c || seen[c.key] || c.level === 'nascosto') continue;
      seen[c.key] = 1;
      out.push(c);
    }
    return out;
  }

  // ---- Workflow: passi, esecutori, token ----
  var EXEC = { free: 'Gratis', muse: 'Muse', codex: 'Codex', claude: 'Claude' };
  var EXEC_ORDER = ['free', 'muse', 'codex', 'claude'];
  function wfTitle(name) {
    var s = String(name || '').replace(/[-_]+/g, ' ').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : 'Workflow';
  }
  function num(n) {
    return Number(n || 0).toLocaleString('it-IT');
  }
  function tok(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k';
    return String(n);
  }
  function durWords(ms) {
    if (ms == null) return '';
    var m = Math.round(ms / 60000);
    if (m < 1) return Math.round(ms / 1000) + ' s';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  // Token per esecutore dell'ultimo giro, dai passi che li hanno. Niente passi con token: null, mai zero inventati.
  function runTokens(run) {
    var by = { free: 0, muse: 0, codex: 0, claude: 0 }, total = 0, known = 0;
    for (const s of (run && run.steps) || []) {
      if (s.tokens == null || !s.executor) continue;
      by[s.executor] = (by[s.executor] || 0) + s.tokens;
      total += s.tokens;
      known++;
    }
    if (!known) return null;
    var saved = run.tokensSavedVsClaude != null ? run.tokensSavedVsClaude : total - by.claude;
    return { by: by, total: total, saved: saved, pct: total ? Math.round(saved / total * 100) : 0 };
  }
  // Fasi del giro con l'esecutore se è uno solo (i passi non dicono a che fase appartengono).
  function runPhases(run) {
    var exs = {};
    for (const s of (run && run.steps) || []) if (s.executor) exs[s.executor] = 1;
    var only = Object.keys(exs).length === 1 ? Object.keys(exs)[0] : null;
    var ph = (run && run.phases) || [];
    if (ph.length) {
      return ph.map(function (p) {
        return { title: p.title, agents: p.total, executor: only, failed: p.failed || 0, outcome: p.failed ? 'error' : (p.done >= p.total ? 'ok' : null) };
      });
    }
    return ((run && run.steps) || []).map(function (s) {
      return { title: s.label || s.id || 'passo', agents: 1, executor: s.executor, tokens: s.tokens, failed: s.outcome === 'error' ? 1 : 0, outcome: s.outcome };
    });
  }
  function saveWords(t) {
    if (!t) return { big: '—', small: 'token non registrati per questo giro', cls: 'none' };
    if (!t.saved) return { big: tok(t.total), small: 'token, tutti su Claude: nessun passo delegato', cls: 'claude' };
    return { big: t.pct + '%', small: 'dei token fuori da Claude · ' + tok(t.saved) + ' risparmiati su ' + tok(t.total), cls: '' };
  }
  function flowHtml(run) {
    var t = runTokens(run), sw = saveWords(t);
    var h = '<div class="cx-fl"><div class="cx-save ' + sw.cls + '"><b>' + esc(sw.big) + '</b><span>' + esc(sw.small) + '</span></div>';
    if (t) {
      var on = EXEC_ORDER.filter(function (k) { return t.by[k]; });
      h += '<div class="cx-bar" role="img" aria-label="' + esc(on.map(function (k) { return EXEC[k] + ' ' + tok(t.by[k]); }).join(', ')) + '">' +
        on.map(function (k) { return '<i class="x-' + k + '" style="flex:' + t.by[k] + '"></i>'; }).join('') + '</div>' +
        '<div class="cx-leg">' + on.map(function (k) { return '<span class="x-' + k + '"><i></i>' + EXEC[k] + ' ' + tok(t.by[k]) + '</span>'; }).join('') + '</div>';
    }
    h += '<ol class="cx-steps">' + runPhases(run).map(function (p) {
      var st = p.outcome === 'error' ? 'err' : p.outcome === 'ok' ? 'ok' : 'run';
      var meta = [];
      if (p.agents) meta.push(p.agents === 1 ? '1 agente' : p.agents + ' agenti');
      meta.push(p.executor ? '<span class="cx-ex x-' + p.executor + '">' + EXEC[p.executor] + '</span>' : 'esecutore non registrato');
      if (p.tokens != null) meta.push(tok(p.tokens) + ' token');
      if (p.failed) meta.push('<span class="bad">' + p.failed + (p.failed === 1 ? ' fallito' : ' falliti') + '</span>');
      return '<li class="cx-n ' + st + '"><span class="cx-nd" aria-hidden="true"></span><div><b>' + esc(p.title) + '</b><span>' + meta.join(' · ') + '</span></div>' +
        '<span class="cx-no">' + (st === 'ok' ? 'riuscito' : st === 'err' ? 'fallito' : 'in corso') + '</span></li>';
    }).join('') + '</ol></div>';
    return h;
  }

  // ---- Righe della tabella ----
  function glyph(c) {
    if (c.level === 'te') return '<span class="cx-g te">' + ic('hand') + '</span><span class="sr">Ti aspetta</span>';
    if (c.level === 'rotto') return '<span class="cx-g rotto">' + ic('circle-x') + '</span><span class="sr">Rotta</span>';
    var bad = c.last && c.last.outcome === 'error';
    return '<span class="cx-g ' + (bad ? 'err' : 'ok') + '" aria-hidden="true"></span><span class="sr">' + (bad ? 'ultimo giro fallito' : 'regolare') + '</span>';
  }

  // ---- Da sistemare: le automazioni ferme. Chi decide (un cancello di workflow) sta in «Ti aspetta», in Panoramica. ----
  function isGate(c) {
    return c.level === 'te' && /passo «[^»]+»/.test(c.reason || '');
  }
  // Fallimenti di fila dalla storia: una lista solo se sono più di uno.
  function failStreak(c) {
    var h = (c.history || []).slice().sort(function (a, b) { return b.at - a.at; });
    var out = [];
    for (const x of h) { if (x.outcome !== 'error') break; out.push(x.at); }
    return out;
  }
  // «Scrivi a Jarvis»: il link viene dalla config locale (ui.cfg), il testo dice già di cosa si parla.
  function jarvisLink(ui, c) {
    var j = (ui && ui.cfg && ui.cfg.jarvis) || {};
    var text = 'Automazione «' + c.title + '» (' + c.key + '): ' + (c.reason || '');
    var h = j.whatsapp ? j.whatsapp + (j.whatsapp.indexOf('?') === -1 ? '?' : '&') + 'text=' + encodeURIComponent(text) : j.discord || null;
    return h ? '<a class="btn" href="' + esc(h) + '" target="_blank" rel="noopener">' + ic('message-circle') + 'Scrivi a Jarvis</a>' : '';
  }
  // «Risolvi tu»: manda un agente; se ce n'è già uno sulla voce, lo dice invece del bottone.
  function fixBtn(ui, c) {
    var f = ui && ui.fixing && ui.fixing[c.key];
    if (f) return '<span class="tag t-run">' + ic('loader-circle') + (f === 'running' ? 'Un agente ci lavora' : 'Agente in coda') + '</span>';
    return '<button class="btn pri" data-fix="' + esc(c.key) + '">' + ic('wand-sparkles') + 'Risolvi tu</button>';
  }
  function fixRow(c, ui, now) {
    var streak = c.level === 'rotto' ? failStreak(c) : [];
    var url = c.provider === 'github' && c.tech && c.tech.url;
    return '<div class="fx">' +
      '<span class="fx-ic ' + (c.level === 'rotto' ? 'bad' : 'warn') + '">' + ic(c.level === 'rotto' ? 'circle-x' : 'triangle-alert') + '</span>' +
      '<div class="fx-b"><button class="fx-t" data-cx="' + esc(c.key) + '">' + esc(c.title) + '</button>' +
      '<p class="fx-w">' + esc(c.reason || '') + (streak.length > 1 ? ' · fallita le ultime ' + streak.length + ' volte' : '') + '</p>' +
      (ifBroken(c) ? '<p class="fx-s">' + esc(ifBroken(c).replace(/^Attilio potrebbe/, 'Finché resta così potresti')) + '</p>' : '') + '</div>' +
      '<div class="fx-a">' + fixBtn(ui, c) + jarvisLink(ui, c) +
      (url ? '<a class="btn ghost" href="' + esc(url) + '" target="_blank" rel="noopener">GitHub' + ic('external-link') + '</a>' : '') + '</div></div>';
  }
  function fixHtml(model, ui, now) {
    var items = allCards(model).filter(function (c) { return isProblem(c) && !isGate(c); })
      .sort(function (a, b) { return (a.level === 'rotto' ? 0 : 1) - (b.level === 'rotto' ? 0 : 1) || (b.since || 0) - (a.since || 0); });
    var gates = allCards(model).filter(isGate).length;
    var note = gates ? '<p class="bx-d">' + gates + (gates === 1 ? ' decisione aspetta' : ' decisioni aspettano') + ' te: sono in <a href="#overview">Panoramica</a>.</p>' : '';
    if (!items.length) return '<article class="bx calm b-4"><h3 class="bx-t">' + ic('circle-check') + 'Niente da sistemare</h3><p>Nessuna automazione è ferma.</p>' + note + '</article>';
    return '<article class="bx fix b-12"><header class="bx-h"><span class="cx-ghi">' + ic('wrench') + '</span><h3 class="bx-t">Da sistemare</h3>' +
      '<span class="cx-cnt"><span>' + items.length + '</span></span></header>' +
      '<p class="bx-d">«Risolvi tu» manda un agente con tutto il contesto della voce; parte quando freno e ritmo lo permettono, e l\'esito arriva nel Diario.</p>' + note +
      '<div class="bx-list">' + items.map(function (c) { return fixRow(c, ui, now); }).join('') + '</div></article>';
  }
  // Striscia delle 24 ore (stile Cronitor): finestra da 22 h fa a 2 h avanti, un segno per quarto d'ora
  // con giri, colorato per l'esito peggiore; linea dell'ora attuale; il prossimo giro come segno vuoto.
  var STRIP_W = 120, STRIP_H = 16, BACK = 22 * 3600000, AHEAD = 2 * 3600000, SLOT = 900000;
  var WORST = { error: 3, skipped: 2, running: 1, ok: 0 };
  function stripHtml(day, next, now) {
    var span = BACK + AHEAD, x0 = now - BACK;
    var x = function (t) { return ((t - x0) / span * STRIP_W).toFixed(1); };
    var slots = {}, n = 0, bad = 0;
    for (const r of day || []) {
      var at = r[0], o = r[1];
      if (at < x0 || at > now) continue;
      n++; if (o === 'error') bad++;
      var k = Math.floor((at - x0) / SLOT);
      if (slots[k] == null || WORST[o] > WORST[slots[k]]) slots[k] = o;
    }
    var marks = Object.keys(slots).map(function (k) {
      var t = x0 + (Number(k) + 0.5) * SLOT;
      return '<rect class="s-' + slots[k] + '" x="' + (x(t) - 0.75) + '" y="3" width="1.5" height="' + (STRIP_H - 6) + '" rx=".5"/>';
    }).join('');
    var nx = next && next > now && next < now + AHEAD ? '<rect class="s-next" x="' + (x(next) - 1.25) + '" y="4" width="2.5" height="' + (STRIP_H - 8) + '" rx=".8"/>' : '';
    var label = n ? n + (n === 1 ? ' giro' : ' giri') + ' nelle ultime 22 ore' + (bad ? ', ' + bad + (bad === 1 ? ' fallito' : ' falliti') : '') : 'nessun giro nelle ultime 22 ore';
    return '<span class="cx-strip" title="' + esc(label) + '"><svg viewBox="0 0 ' + STRIP_W + ' ' + STRIP_H + '" width="' + STRIP_W + '" height="' + STRIP_H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<line class="s-base" x1="0" y1="' + (STRIP_H / 2) + '" x2="' + STRIP_W + '" y2="' + (STRIP_H / 2) + '"/>' + marks + nx +
      '<line class="s-now" x1="' + x(now) + '" y1="0" x2="' + x(now) + '" y2="' + STRIP_H + '"/></svg><span class="sr">' + esc(label) + '</span></span>';
  }

  // Riga di automazione: il titolo va a capo invece di troncarsi, il motivo sta sotto.
  function rowHtml(c, ui, now) {
    var nx = c.next ? (c.nextApprox ? '~' : '') + short(c.next, now) : '—';
    return '<div class="cx-row' + (ui.sel === c.key ? ' sel' : '') + '" role="button" tabindex="0" data-cx="' + esc(c.key) + '">' + glyph(c) +
      '<span class="cx-t"><span class="cx-tt">' + esc(c.title) + '</span>' + (isProblem(c) && c.reason ? '<small class="' + esc(c.level) + '">' + esc(c.reason) + '</small>' : '') + '</span>' +
      stripHtml(c.day || (c.history || []).map(function (h) { return [h.at, h.outcome]; }), c.next, now) +
      '<span class="cx-c' + (c.last && c.last.at ? '' : ' dim') + '">' + esc(short(c.last && c.last.at, now)) + '</span>' +
      '<span class="cx-c nx dim">' + esc(nx) + '</span></div>';
  }
  // Riga di un lavoro lanciato da una sessione: niente orario né «prossimo», ma quando, quanto, quanti agenti e token.
  function wfRowHtml(w, ui, now) {
    var run = (w.runs || [])[0] || {};
    var t = runTokens(run);
    var bad = run.outcome === 'error';
    return '<div class="cx-row wr' + (ui.sel === 'wf:' + w.name ? ' sel' : '') + '" role="button" tabindex="0" data-cx="wf:' + esc(w.name) + '">' +
      (bad ? '<span class="cx-g rotto">' + ic('circle-x') + '</span>' : '<span class="cx-g ok" aria-hidden="true"></span>') + '<span class="sr">' + (bad ? 'fallito' : 'riuscito') + '</span>' +
      '<span class="cx-t"><span class="cx-tt">' + esc(wfTitle(w.name)) + '</span>' + (run.summary ? '<small>' + esc(run.summary) + '</small>' : '') + '</span>' +
      '<span class="cx-c">' + esc(short(run.at, now)) + '</span>' +
      '<span class="cx-c du dim">' + esc(durWords(run.durationMs) || '—') + '</span>' +
      '<span class="cx-c ag dim">' + (run.agents != null ? run.agents : '—') + '</span>' +
      '<span class="cx-c rt' + (t && !t.saved ? ' claude' : ' dim') + '">' + esc(t ? tok(t.total) : '—') + '</span></div>';
  }

  // Una ricerca o un filtro decidono quali righe restano.
  function matches(c, ui) {
    var f = ui.filter || 'all';
    if (f === 'pb' && !isProblem(c)) return false;
    if (f === 'ok' && isProblem(c)) return false;
    var q = (ui.q || '').trim().toLowerCase();
    if (!q) return true;
    return [c.title, forYou(c), c.who, c.means, SYS[c.provider]].join(' ').toLowerCase().indexOf(q) !== -1;
  }

  // ---- Sezioni ----
  function verdictHtml(model, ui) {
    var v = model.verdict || {};
    var cards = allCards(model);
    var tone = !v.needsYou && !v.broken ? 'ok' : v.needsYou ? 'te' : 'bad';
    var title;
    if (tone === 'ok') title = 'Tutto a posto';
    else {
      var p = [];
      if (v.needsYou) p.push(v.needsYou + (v.needsYou === 1 ? ' ti aspetta' : ' ti aspettano'));
      if (v.broken) p.push(v.broken + (v.broken === 1 ? ' rotta' : ' rotte'));
      title = p.join(' · ');
    }
    var fresh = 'controllato alle ' + hm(model.checkedAt);
    if (model.stale) fresh = 'ultima lettura fallita, dati delle ' + hm(model.checkedAt);
    if (ui.offline) fresh = 'hub muto, dati delle ' + hm(model.checkedAt) + ' <button class="cx-btn" data-au-retry="1">Riprova</button>';
    var srcs = (model.footer || {}).sources || [];
    var srcOk = srcs.filter(function (s) { return s.ok; }).length;
    var line = num(cards.length) + ' automazioni, ' + num(v.runsToday || 0) + ' giri oggi. ' + (srcOk === srcs.length ? 'Tutte le ' + srcs.length + ' fonti rispondono' : srcOk + ' fonti su ' + srcs.length + ' rispondono') + ', ' + fresh + '.';
    return '<section class="cx-head" data-sec="verdict"><div class="cx-state ' + tone + '"><span class="cx-mk">' + ic('hub') + '</span><div><h2>' + esc(title) + '</h2><p class="cx-line">' + line + '</p></div></div></section>';
  }
  // Filtro e ricerca: stanno con la tabella che filtrano, non in cima alla pagina.
  function toolsHtml(model, ui) {
    var cards = allCards(model);
    var pb = cards.filter(isProblem).length;
    var seg = [['all', 'Tutte', cards.length], ['pb', 'Problemi', pb], ['ok', 'Ok', cards.length - pb]];
    var f = ui.filter || 'all';
    return '<div class="cx-tools"><div class="cx-seg" role="group" aria-label="Filtro">' + seg.map(function (s) {
      return '<button data-au-filter="' + s[0] + '" aria-pressed="' + (f === s[0]) + '">' + s[1] + '<b>' + s[2] + '</b></button>';
    }).join('') + '</div><label class="cx-q">' + ic('search', 'cx-qi') + '<span class="sr">Cerca</span><input type="search" data-au-q placeholder="Cerca per nome, scopo, chi la esegue" value="' + esc(ui.q || '') + '" autocomplete="off"><kbd aria-hidden="true">/</kbd></label></div>';
  }

  function sinceHtml(model, ui) {
    var seen = (ui && ui.seen) || {};
    var news = seen.newKeys || [];
    var changed = seen.changedKeys || [];
    if (!news.length && !changed.length) return '';
    var p = [];
    if (news.length) p.push(news.length + (news.length === 1 ? ' nuova' : ' nuove'));
    if (changed.length) p.push(changed.length + (changed.length === 1 ? ' cambiata' : ' cambiate'));
    var titles = news.concat(changed).map(function (k) { return (model.cards && model.cards[k] && model.cards[k].title) || k; });
    return '<section class="cx-since" data-sec="since"><b>Da ieri: ' + esc(p.join(', ')) + '</b> <span>' + titles.map(esc).join(' · ') + '</span></section>';
  }

  // ---- Griglia bento: da fare, automazioni per scopo, lavori delle sessioni ----
  // La misura dice l'importanza: chi chiede una mossa e le aree con più voci prendono più spazio;
  // gli elenchi stanno solo dentro le card che ne hanno bisogno.
  // Un'area grande occupa tutta la riga con l'elenco su due colonne: una card alta accanto a una bassa lascerebbe un buco.
  function sizeFor(n) {
    return n >= 12 ? 'b-12' : n >= 7 ? 'b-6' : 'b-4';
  }
  function countsHtml(all) {
    var te = all.filter(function (c) { return c.level === 'te'; }).length;
    var ro = all.filter(function (c) { return c.level === 'rotto'; }).length;
    return '<span class="cx-cnt"><span>' + (all.length - te - ro) + ' ok</span>' +
      (te ? '<span class="te">' + te + ' ti ' + (te === 1 ? 'aspetta' : 'aspettano') + '</span>' : '') + (ro ? '<span class="bad">' + ro + (ro === 1 ? ' rotta' : ' rotte') + '</span>' : '') + '</span>';
  }
  function areaCard(a, all, rows, ui, now) {
    var hdr = '<div class="cx-row cx-hdr" aria-hidden="true"><span></span><span>Nome</span><span class="cx-strip">ultime 24 ore</span><span class="cx-c">Ultimo</span><span class="cx-c nx">Prossimo</span></div>';
    var size = sizeFor(all.length);
    var list = function (rs) { return '<div class="bx-list">' + hdr + rs.map(function (c) { return rowHtml(c, ui, now); }).join('') + '</div>'; };
    var half = Math.ceil(rows.length / 2);
    var body = size === 'b-12' && rows.length > 6 ? '<div class="bx-cols">' + list(rows.slice(0, half)) + list(rows.slice(half)) + '</div>' : list(rows);
    return '<article class="bx area ' + size + '" data-area="' + esc(a.id) + '"><header class="bx-h"><span class="cx-ghi">' + ic(a.icon || areaIcon(a.id)) + '</span>' +
      '<h3 class="bx-t">' + esc(a.title) + '</h3>' + countsHtml(all) + '</header>' + body + '</article>';
  }
  // Mac, PC e app di Attilio: una sezione a parte, solo da guardare. Non conta nei problemi, quindi col filtro Problemi sparisce.
  function ownCard(model, ui, now) {
    var all = model.own || [];
    if (!all.length || ui.filter === 'pb') return '';
    var rows = all.filter(function (c) { return matches(c, ui); });
    if (!rows.length) return '';
    var off = all.filter(isProblem).length;
    var hdr = '<div class="cx-row cx-hdr" aria-hidden="true"><span></span><span>Nome</span><span class="cx-strip">ultime 24 ore</span><span class="cx-c">Ultimo</span><span class="cx-c nx">Prossimo</span></div>';
    return '<article class="bx area own b-12" data-area="computer-app"><header class="bx-h"><span class="cx-ghi">' + ic('monitor-smartphone') + '</span>' +
      '<h3 class="bx-t">Computer e app</h3><span class="cx-cnt"><span>' + all.length + (all.length === 1 ? ' voce' : ' voci') + '</span>' + (off ? '<span>' + off + (off === 1 ? ' ferma' : ' ferme') + '</span>' : '') + '</span></header>' +
      '<p class="bx-d">Il tuo Mac, il PC e le tue app. Le vedi qui, ma non contano tra i problemi di Jarvis e non finiscono in «Ti aspetta».</p>' +
      '<div class="bx-list">' + hdr + rows.map(function (c) { return rowHtml(c, ui, now); }).join('') + '</div></article>';
  }
  function jobsCard(model, ui, now) {
    var wf = model.workflows || {};
    var q = (ui.q || '').trim().toLowerCase();
    var ws = (wf.byName || []).filter(function (w) {
      if (ui.filter === 'pb') return w.runs && w.runs[0] && w.runs[0].outcome === 'error';
      if (ui.filter === 'ok') return !(w.runs && w.runs[0] && w.runs[0].outcome === 'error');
      return !q || (wfTitle(w.name) + ' ' + ((w.runs[0] || {}).summary || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (!ws.length) return '';
    var h = '<div class="cx-row wr cx-hdr" aria-hidden="true"><span></span><span>Lavoro</span><span class="cx-c">Quando</span><span class="cx-c du">Durata</span><span class="cx-c ag">Agenti</span><span class="cx-c rt">Token</span></div>';
    for (const w of ws) h += wfRowHtml(w, ui, now);
    return '<article class="bx jobs b-12"><header class="bx-h"><span class="cx-ghi">' + ic('workflow') + '</span><h3 class="bx-t">Lavori lanciati dalle sessioni</h3>' +
      '<span class="cx-cnt"><span>' + (wf.total || 0) + (wf.total === 1 ? ' giro' : ' giri') + '</span>' + (wf.failed ? '<span class="bad">' + wf.failed + (wf.failed === 1 ? ' fallito' : ' falliti') + '</span>' : '') + '</span></header>' +
      '<p class="bx-d">Workflow a più agenti partiti a mano da una sessione di Claude Code negli ultimi ' + (wf.days || 7) + ' giorni. Non hanno un orario e non ripartono.</p>' +
      '<div class="bx-list">' + h + '</div></article>';
  }
  // Impagina su 12 colonne: ogni riga somma a 12. Se la card dopo non entra, prima cerca più avanti
  // una che entri nel resto; se non c'è, allarga l'ultima della riga. Così non restano buchi.
  function packRows(html) {
    var items = html.split(/(?=<article class="bx )/).filter(Boolean);
    var span = function (it) { var m = /class="bx [^"]*\bb-(\d+)/.exec(it); return m ? Number(m[1]) : 12; };
    var setSpan = function (it, n) { return it.replace(/(class="bx [^"]*\b)b-\d+/, '$1b-' + n); };
    var out = [], row = [], used = 0;
    var close = function () {
      if (row.length && used < 12) row[row.length - 1] = setSpan(row[row.length - 1], span(row[row.length - 1]) + 12 - used);
      out = out.concat(row); row = []; used = 0;
    };
    while (items.length) {
      var it = items.shift(), n = span(it);
      if (used + n > 12) {
        var k = items.findIndex(function (x) { return used + span(x) <= 12; });
        if (k !== -1) { items.unshift(it); it = items.splice(k + 1, 1)[0]; n = span(it); } else close();
      }
      row.push(it); used += n;
      if (used === 12) close();
    }
    close();
    return out.join('');
  }
  function tableHtml(model, ui, now) {
    var cards = allCards(model).filter(function (c) { return matches(c, ui); });
    var searching = !!(ui.q || '').trim() || (ui.filter && ui.filter !== 'all');
    var areas = (model.areas && model.areas.length ? model.areas : AREAS).map(function (a) {
      var all = allCards(model).filter(function (c) { return areaOf(c) === a.id; });
      var rows = cards.filter(function (c) { return areaOf(c) === a.id; }).sort(function (x, y) { return (isProblem(y) ? 1 : 0) - (isProblem(x) ? 1 : 0); });
      return { a: a, all: all, rows: rows, pb: all.filter(isProblem).length };
    }).filter(function (x) { return x.rows.length && !x.a.own; })
      // Le aree con un problema vengono prima, poi le più grandi.
      .sort(function (x, y) { return (y.pb ? 1 : 0) - (x.pb ? 1 : 0) || y.all.length - x.all.length; });
    var h = packRows((searching ? '' : fixHtml(model, ui, now)) + areas.map(function (x) { return areaCard(x.a, x.all, x.rows, ui, now); }).join('') + jobsCard(model, ui, now) + ownCard(model, ui, now));
    if (!areas.length && searching) {
      h += '<div class="bx cx-empty b-12"><b>Niente da mostrare</b>' + ((ui.q || '').trim() ? 'Nessuna automazione contiene «' + esc(ui.q.trim()) + '».' : 'Nessuna voce con questo filtro.') + ' <button class="cx-btn" data-au-clear="1">Togli il filtro</button></div>';
    }
    if (!allCards(model).length) h += '<div class="bx cx-empty b-12"><b>Nessuna automazione letta</b>Le fonti non hanno ancora risposto.</div>';
    return '<section class="cx-sec" data-sec="table">' + toolsHtml(model, ui) + '<div class="bento">' + h + '</div></section>';
  }

  var VOTE_WORD = { ok: 'va bene', cambia: 'da cambiare' };
  function feedbackLines(fb) {
    var out = [];
    var v = fb && fb.vote;
    if (v) out.push('Hai detto: ' + (VOTE_WORD[v.v] || v.v) + (v.at ? ', ' + dm(v.at) : '') + (v.note ? ' — «' + v.note + '»' : ''));
    if (fb && fb.changedSinceVote) out.push('È cambiata dopo il tuo voto');
    var m = fb && fb.mute;
    if (m) out.push(m.until ? 'Silenziata fino al ' + dm(m.until) + (m.why ? ': ' + m.why : '') : 'Silenziata per sempre' + (m.why ? ': ' + m.why : ''));
    if (fb && fb.open > 0) out.push(fb.open === 1 ? '1 nota aperta' : fb.open + ' note aperte');
    return out;
  }

  function ticks(c) {
    var h = (c.history || []).slice().sort(function (a, b) { return a.at - b.at; }).slice(-20);
    if (h.length < 2) return '';
    var bad = h.filter(function (x) { return x.outcome === 'error'; }).length;
    return '<span class="cx-ticks" aria-hidden="true">' + h.map(function (x) { return '<i class="' + (x.outcome === 'error' ? 'err' : x.outcome === 'ok' ? 'ok' : '') + '"></i>'; }).join('') + '</span> ' +
      '<span class="m' + (bad ? ' bad' : '') + '">' + (h.length - bad) + '/' + h.length + '</span>';
  }

  function techHtml(c) {
    var t = c.tech || {};
    var rows = [];
    // niente chiavi né uuid in pagina: il sistema per nome, le fonti per sistema
    rows.push('<dt>Sistema</dt><dd>' + esc(SYS[c.provider] || c.provider || '–') + '</dd>');
    if (t.schedule) rows.push('<dt>Quando</dt><dd>' + esc(String(t.schedule)) + '</dd>');
    if (t.exit != null) rows.push('<dt>Uscita</dt><dd>codice ' + esc(String(t.exit)) + '</dd>');
    var srcs = c.sources || [];
    if (srcs.length > 1) rows.push('<dt>Fonti</dt><dd>' + srcs.map(function (s) { return esc(SYS[s.provider] || s.provider || 'altra fonte'); }).join('<br>') + '</dd>');
    var cmd = t.command || t.prompt;
    return '<details class="tech"><summary>Dettagli tecnici</summary><dl class="cx-dl">' + rows.join('') + '</dl>' +
      (cmd ? '<pre>' + esc(noIds(String(cmd).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '…'), true)) + '</pre>' : '') + (t.url && c.provider === 'github' ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener">Vedi il giro su GitHub</a>' : '') + '</details>';
  }

  // ---- Chi risponde: il nodo modello raccontato in parole ----
  // «muse-spark-1.3» → «Muse Spark 1.3», «claude-sonnet-5-5» → «Sonnet 5.5», «gpt-5.6-sol» → «GPT-5.6 Sol».
  function prettyModel(name, model) {
    var m = String(model || '').replace(/^[a-z-]+\//, '');
    var p = m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/^gpt-/, 'GPT-')
      .split('-').map(function (w, i) { return i === 0 && /^GPT/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1); }).join(' ')
      .replace(/^GPT (\d)/, 'GPT-$1');
    if (!p) return name || 'modello';
    if (!name || p.toLowerCase().indexOf(String(name).toLowerCase()) === 0) return p;
    return name + ' ' + p;
  }
  // L'account conta solo quando la fila ripete lo stesso modello su account diversi.
  function accountWord(o, opts) {
    if (!o.account) return '';
    var same = opts.filter(function (x) { return x.model === o.model; }).length > 1;
    if (!same) return '';
    var a = String(o.account).replace(/^anthropic-?/, '');
    return a ? ' sull\'account ' + a : ' sull\'account principale';
  }
  var DID = { ok: 'ha risposto', error: 'è fallito', skipped: 'è stato saltato', unused: 'non è servito' };
  function modelStory(n) {
    var opts = n.options || [];
    var nm = function (o) { return prettyModel(o.name, o.model) + accountWord(o, opts); };
    var won = -1;
    for (var i = 0; i < opts.length; i++) if (opts[i].outcome === 'ok') { won = i; break; }
    var unknownWho = !!(n.note && /non registra/.test(n.note));
    var head, why = '', next = '';
    if (won === -1) {
      var tried = opts.filter(function (o) { return o.outcome === 'error' || o.outcome === 'skipped'; });
      head = tried.length ? 'Nessun modello ha risposto.' : opts.length ? 'Il giro non dice quale modello ha lavorato.' : 'Nessun modello registrato.';
      if (tried.length) why = tried.map(function (o) { return nm(o) + ' ' + DID[o.outcome] + (o.note ? ' (' + o.note + ')' : ''); }).join(', ') + '.';
    } else if (unknownWho) {
      head = 'Ha risposto quasi certamente ' + nm(opts[won]) + '.';
      why = 'Il giro è riuscito e OpenClaw prova sempre per primo il primo della fila, ma non registra chi ha risposto davvero.';
    } else {
      head = 'Ha risposto ' + nm(opts[won]) + (opts[won].ms != null ? ', in ' + durWords(opts[won].ms) : '') + '.';
      var before = opts.slice(0, won);
      why = won === 0 ? (opts.length > 1 ? 'È il primo della fila e ha funzionato, quindi gli altri non sono serviti.' : 'È l\'unico modello previsto.')
        : 'Prima ' + before.map(function (o) { return nm(o) + ' ' + (DID[o.outcome] || 'non ha risposto') + (o.note ? ' (' + o.note + ')' : ''); }).join(', poi ') + '.';
    }
    var w = won === -1 ? 0 : won;
    var after = opts.slice(w + 1);
    if (won !== -1) next = after.length ? 'Se ' + nm(opts[w]) + ' non avesse risposto, il lavoro sarebbe passato a ' + after.map(nm).join(', poi a ') + '.'
      : opts.length > 1 ? 'Era l\'ultimo della fila: se falliva anche lui, falliva il giro.' : 'Non c\'è un ripiego: se fallisce, fallisce il giro.';
    return { head: head, why: why, next: next };
  }
  var QWORD = { ok: 'ha risposto', error: 'fallito', skipped: 'saltato', unused: 'non serviva' };
  function modelBody(n) {
    var opts = n.options || [];
    var s = modelStory(n);
    var unknownWho = !!(n.note && /non registra/.test(n.note));
    return '<div class="gstory"><p class="gwhy">' + esc(s.why) + '</p>' + (s.next ? '<p class="gnext">' + esc(s.next) + '</p>' : '') + '</div>' +
      (opts.length > 1 ? '<ol class="gqueue" aria-label="Fila dei modelli">' + opts.map(function (o) {
        var st = unknownWho && o.outcome === 'ok' ? 'probabile' : (QWORD[o.outcome] || (unknownWho ? 'non registrato' : 'non provato'));
        return '<li class="' + esc(o.outcome || 'none') + (o.exec ? ' x-' + esc(o.exec) : '') + '"><span class="gqn">' + esc(prettyModel(o.name, o.model) + accountWord(o, opts)) + '</span>' +
          '<span class="gqs">' + esc(st) + (o.ms != null ? ', ' + esc(durWords(o.ms)) : '') + (o.tokens != null ? ', ' + esc(tok(o.tokens)) + ' token' : '') + '</span></li>';
      }).join('') + '</ol>' : '');
  }

  // ---- Schema a passi (grafo) di una voce, ricavato dall'hub da definizione, script e log ----
  var KIND = { trigger: 'Quando', sources: 'Legge', step: 'Passo', model: 'Risponde', deliver: 'Consegna' };
  var GOUT = { ok: 'ok', error: 'fallito', skipped: 'saltato', unused: 'non usato' };
  function gStatus(o, inferred, ms) {
    var w = o == null ? '—' : GOUT[o] || o;
    return '<span class="gs ' + (o || 'none') + (inferred ? ' inf' : '') + '"' + (inferred ? ' title="dedotto dall\'esito del giro"' : '') + '>' + esc(w) + '</span>' +
      (ms != null ? '<span class="gt">' + esc(durWords(ms)) + '</span>' : '');
  }
  function gNode(n) {
    var body = '';
    if (n.kind === 'sources') {
      body = '<div class="gsrc">' + (n.items || []).map(function (x) { return '<span title="' + esc(x.detail || '') + '">' + esc(x.label) + '</span>'; }).join('') + '</div>';
    } else if (n.kind === 'model') {
      body = modelBody(n);
    }
    var label = n.kind === 'model' ? modelStory(n).head : n.label;
    var head = '<span class="gk">' + esc(KIND[n.kind] || n.kind) + '</span><span class="gl">' + esc(label) + '</span>' +
      (n.kind === 'model' ? ''
        : n.kind === 'deliver' ? '<span class="gmeta">' + gStatus(n.outcome, false, null) + (n.at ? '<span class="gt">alle ' + esc(hm(n.at)) + '</span>' : '') + '</span>'
        : n.kind !== 'sources' && n.kind !== 'trigger' ? '<span class="gmeta">' + gStatus(n.outcome, n.inferred, n.ms) + '</span>' : '');
    var io = n.io || {};
    // Il dettaglio tecnico è una riga: sempre visibile. Si apre solo ciò che è lungo (domanda, risposta, errore).
    var more = (io.in ? '<div class="gio"><span>Cosa gli è stato chiesto</span><pre tabindex="0">' + esc(noIds(io.in, true)) + '</pre></div>' : '') +
      (io.out ? '<div class="gio"><span>Cosa ha risposto <i>' + esc(io.outFrom || '') + '</i></span><pre tabindex="0">' + esc(noIds(io.out, true)) + '</pre></div>'
        : n.kind === 'model' ? '<div class="gio"><span>Cosa ha risposto</span><p>Il testo di questo giro non è stato registrato.</p></div>' : '') +
      (n.error ? '<div class="gio bad"><span>Errore</span><pre tabindex="0">' + esc(noIds(n.error, true)) + '</pre></div>' : '');
    var openLbl = n.kind === 'model' ? 'Mostra domanda e risposta' : 'Mostra l\'errore';
    return '<li class="gn ' + esc(n.kind) + '"><div class="gh2">' + head + '</div>' + (n.detail && n.kind !== 'sources' ? '<div class="gd">' + esc(noIds(n.detail)) + '</div>' : '') + body + (more
      ? '<details class="gmore"><summary>' + ic('chevron-right', 'gchev') + openLbl + '</summary>' + more + '</details>' : '') + '</li>';
  }
  function graphHtml(g, now) {
    if (g === 'loading') return '<div class="cx-graph"><div class="cx-h4">Schema</div><div class="au-skl" style="height:120px;border-radius:8px"></div></div>';
    if (!g || g === 'none' || !g.nodes) return '';
    var r = g.run || {};
    var bits = ['ultimo giro ' + (r.at ? lastWords({ at: r.at }, now) : 'mai')];
    if (r.ms != null) bits.push(durWords(r.ms));
    if (r.outcome) bits.push(outcomeWord(r.outcome));
    return '<div class="cx-graph"><div class="cx-h4">Schema <span>' + esc(bits.join(' · ')) + '</span></div>' +
      '<ol class="gflow">' + g.nodes.map(gNode).join('') + '</ol>' +
      (g.nodes.some(function (n) { return n.kind === 'step' && n.inferred; }) ? '<p class="gfrom">Dei passi dello script il log non registra testo né tempi: il loro «ok» viene dall\'esito del giro.</p>' : '') +
      '<div class="gfrom">ricavato da ' + (g.from || []).map(esc).join(' · ') + '</div></div>';
  }

  var LEVEL = { te: 'Ti aspetta', rotto: 'Rotta' };
  // Barra in cima al pannello, come in A: stato, sistema, chiudi.
  function panelHead(chipCls, chip, sys) {
    return '<div class="cx-ph"><span class="cx-chip ' + chipCls + '">' + esc(chip) + '</span><span class="cx-sys">' + esc(sys) + '</span>' +
      '<button class="cx-x" data-cx-close="1" aria-label="Chiudi">' + ic('x') + '</button></div>';
  }

  // La card del pannello: qui stanno i pulsanti di feedback (automations.js li gestisce su article.au-card).
  function card(c, ui, now) {
    var l = c.last || {};
    var fb = c.feedback || {};
    var area = AREAS.find(function (a) { return a.id === areaOf(c); });
    var facts = [];
    facts.push('<dt>Ultimo giro</dt><dd>' + esc(l.at == null ? (l.atUnknown ? outcomeWord(l.outcome) + ', ora non registrata' : 'mai partito') : (l.atApprox ? 'verso ' : '') + lastWords(l, now) + ', ' + outcomeWord(l.outcome)) + '</dd>');
    facts.push('<dt>Prossimo</dt><dd>' + esc(c.next ? (c.nextApprox ? 'verso ' : '') + lastWords({ at: c.next }, now) : '—') + '</dd>');
    facts.push('<dt>Giri oggi</dt><dd class="m">' + (c.runsToday || 0) + '</dd>');
    var tk = ticks(c);
    if (tk) facts.push('<dt>Ultimi giri</dt><dd>' + tk + '</dd>');
    var dw = deliveredWords(l.delivered);
    if (dw) facts.push('<dt>Consegna</dt><dd class="' + (l.delivered === 'failed' ? 'bad' : '') + '">' + dw + '</dd>');
    if (c.proof && !(c.proof.ok === false && c.reason && c.reason.indexOf(c.proof.words) !== -1)) facts.push('<dt>Prova</dt><dd class="' + (c.proof.ok === false ? 'bad' : '') + '">' + esc(c.proof.words || '') + '</dd>');
    var br = ifBroken(c);
    facts.push('<dt>Se si rompe</dt><dd' + (br ? '' : ' class="dim"') + '>' + esc(noIds(br) || 'non scritto') + '</dd>');
    if (c.who) facts.push('<dt>Esegue</dt><dd>' + esc(noIds(c.who)) + '</dd>');
    if (c.means) facts.push('<dt>Ti scrive</dt><dd>' + esc(noIds(c.means)) + '</dd>');
    facts.push('<dt>Area</dt><dd>' + esc(area ? area.title : '') + (c.purpose && c.purpose.area ? '' : ' (area stimata)') + '</dd>');
    var pressed = function (v) { return fb.vote && fb.vote.v === v ? ' aria-pressed="true"' : ' aria-pressed="false"'; };
    return '<article class="au-card lv-' + esc(c.level || 'va') + '" tabindex="-1" data-key="' + esc(c.key) + '"' + (c.fp ? ' data-fp="' + esc(c.fp) + '"' : '') + '>' +
      panelHead(c.level === 'te' || c.level === 'rotto' ? c.level : 'va', LEVEL[c.level] || 'Ok', (SYS[c.provider] || c.provider || '—') + ((c.sources || []).length > 1 ? ' · ' + c.sources.length + ' fonti' : '')) +
      '<div class="cx-pb"><h3 id="cx-pt">' + esc(c.title) + '</h3>' +
      (isProblem(c) && c.reason ? '<p class="au-why ' + esc(c.level) + '">' + esc(noIds(c.reason)) + '</p>' : '') +
      (forYou(c) ? '<p class="cx-desc">' + esc(noIds(forYou(c))) + '</p>' : '') +
      graphHtml(ui && ui.graphs && ui.graphs[c.key], now) +
      '<dl class="cx-dl">' + facts.join('') + '</dl>' +
      feedbackLines(fb).map(function (s) { return '<div class="cx-fbl">' + esc(s) + '</div>'; }).join('') +
      (isProblem(c) && !isGate(c) ? '<div class="cx-fixa">' + fixBtn(ui, c) + jarvisLink(ui, c) + '</div>' : (isGate(c) ? '' : '<div class="cx-fixa">' + jarvisLink(ui, c) + '</div>')) +
      '<div class="au-act"><button class="cx-btn' + (isProblem(c) && !isGate(c) ? '' : ' pri') + '" data-fb="ok" aria-keyshortcuts="v"' + pressed('ok') + '>Va bene <kbd>V</kbd></button>' +
      '<button class="cx-btn" data-fb="cambia" aria-keyshortcuts="c"' + pressed('cambia') + '>Da cambiare <kbd>C</kbd></button>' +
      '<button class="cx-btn" data-fb="nota" aria-keyshortcuts="n">Nota <kbd>N</kbd></button>' +
      '<button class="cx-btn" data-fb="segnala" aria-keyshortcuts="s">Segnala <kbd>S</kbd></button>' +
      '<button class="cx-btn" data-fb="muta" aria-keyshortcuts="m">Non avvisarmi più <kbd>M</kbd></button></div>' +
      techHtml(c) + '</div></article>';
  }

  function costHtml(runId, ui) {
    var c = ui && ui.costs && ui.costs[runId];
    if (c && c.weekPct != null) return '<span class="mut">≈ ' + esc(String(c.weekPct).replace('.', ',')) + '% della settimana (stima)</span>';
    if (c) return '<span class="mut">costo non stimabile</span>';
    return '<button class="b" data-cost="' + esc(runId) + '">Costo</button>';
  }

  function wfPanel(w, ui, now) {
    var run = (w.runs || [])[0] || {};
    var bits = [lastWords({ at: run.at }, now), outcomeWord(run.outcome)];
    if (run.durationMs != null) bits.push(durWords(run.durationMs));
    if (run.agents != null) bits.push(run.agents + (run.agents === 1 ? ' agente' : ' agenti'));
    var prev = (w.runs || []).slice(1, 8).map(function (r) {
      return '<li><span>' + esc(short(r.at, now)) + '</span><span class="' + (r.outcome === 'error' ? 'bad' : '') + '">' + esc(outcomeWord(r.outcome)) + '</span><span>' + esc(durWords(r.durationMs)) + '</span></li>';
    }).join('');
    return '<div class="cx-wf">' + panelHead(run.outcome === 'error' ? 'rotto' : 'va', outcomeWord(run.outcome), 'Workflow') +
      '<div class="cx-pb"><h3 id="cx-pt">' + esc(wfTitle(w.name)) + '</h3>' + (run.summary ? '<p class="cx-desc">' + esc(run.summary) + '</p>' : '') +
      '<p class="cx-bits">' + esc(bits.join(' · ')) + ' ' + (run.runId ? costHtml(run.runId, ui) : '') + '</p>' +
      flowHtml(run) + (prev ? '<h4 class="cx-h4">Giri precedenti</h4><ul class="cx-prev">' + prev + '</ul>' : '') + '</div></div>';
  }

  function panelHtml(model, ui, now) {
    var sel = ui.sel;
    if (!sel) return '';
    var body = '';
    if (sel.indexOf('wf:') === 0) {
      var w = ((model.workflows || {}).byName || []).find(function (x) { return 'wf:' + x.name === sel; });
      if (w) body = wfPanel(w, ui, now);
    } else {
      var c = allCards(model).find(function (x) { return x.key === sel; });
      if (c) body = card(c, ui, now);
    }
    if (!body) return '';
    return '<div class="cx-scrim" data-cx-close="1"></div><aside class="cx-panel" role="dialog" aria-modal="true" aria-labelledby="cx-pt">' + body + '</aside>';
  }

  function reviewHtml(model, ui) {
    var unc = (model.review && model.review.unconfirmed) || [];
    if (!unc.length) return '';
    var n = unc.length;
    var mins = Math.max(Math.ceil((n * 7) / 60), 1);
    var body = '';
    if (ui.review && ui.review.open) {
      var key = unc.indexOf(ui.review.key) !== -1 ? ui.review.key : unc[0];
      var c = model.cards && model.cards[key];
      body = '<div class="au-rev-now"><div class="cx-sub">' + (unc.indexOf(key) + 1) + '/' + n + '</div>' + (c ? card(c, ui, ui.now || model.checkedAt) : '') +
        '<div class="au-act"><button class="b" data-review="prev">Indietro</button><button class="b" data-review="next">Dopo</button><button class="b" data-review="close">Chiudi</button></div></div>';
    }
    return '<section class="cx-rev" data-sec="review"><div class="au-rev-head">' + n + (n === 1 ? ' mai confermata' : ' mai confermate') +
      ' · <button class="b" data-review="start">Ripassale (≈' + mins + ' min)</button></div>' + body + '</section>';
  }

  function footerHtml(model) {
    var f = model.footer || {};
    var srcs = (f.sources || []).map(function (s) {
      if (s.note && s.note !== '?') return '<span>' + esc(s.note) + '</span>';
      return '<span>' + esc(s.label) + ' ' + (s.at ? hm(s.at) : '<span class="cx-qm" title="' + (s.pending ? 'primo giro in corso' : 'non risponde') + '">?</span>') + '</span>';
    });
    var hid = f.hidden || {};
    if (hid.count > 0) srcs.push('<span title="' + esc((hid.why || []).map(function (w) { return w.title + ': ' + w.reason; }).join('\n')) + '">nascoste ' + hid.count + '</span>');
    return '<section class="cx-foot" data-sec="footer">' + srcs.join('<span aria-hidden="true">·</span>') + '</section>';
  }

  // Segnaposto al primo caricamento: stessa forma della tabella vera.
  function skeleton() {
    var r = '';
    for (var i = 0; i < 8; i++) r += '<div class="cx-row cx-hdr"><span class="au-skl" style="width:10px;height:10px"></span><span class="au-skl" style="width:' + (35 + (i * 13) % 40) + '%"></span><span class="au-skl cx-strip"></span><span class="au-skl"></span><span class="au-skl nx"></span><span class="au-skl rt"></span></div>';
    return '<div role="status"><span class="sr">Carico le automazioni…</span><section class="cx-head" data-sec="verdict" aria-busy="true"><div class="au-skl" style="width:220px;height:20px"></div>' +
      '<div class="au-skl" style="width:260px;height:11px;margin:10px 0 24px"></div></section><section class="cx-sec"><div class="cx-tbl">' + r + '</div></section></div>';
  }

  function errorHtml(msg) {
    return '<section class="cx-tbl" data-sec="error" role="alert"><div class="cx-empty"><b>Non riesco a leggere le automazioni</b>' +
      esc(msg || "L'hub non risponde. Se il Mac è sotto carico può metterci un minuto.") + ' <button class="b" data-au-retry="1">Riprova</button></div></section>';
  }

  function render(model, ui) {
    ui = ui || {};
    var now = (ui.now != null) ? ui.now : model.checkedAt;
    return verdictHtml(model, ui) + tableHtml(model, ui, now) + footerHtml(model) + panelHtml(model, ui, now);
  }

  var api = { noIds: noIds, packRows: packRows, modelStory: modelStory, prettyModel: prettyModel, fixHtml: fixHtml, isGate: isGate, render: render, skeleton: skeleton, errorHtml: errorHtml, lastWords: lastWords, deliveredWords: deliveredWords, esc: esc, card: card, graphHtml: graphHtml, stripHtml: stripHtml, areaOf: areaOf, runTokens: runTokens, flowHtml: flowHtml };
  // Sempre sul globale: così il test con createRequire trova tutto anche se `module.exports` non esce.
  root.AutomationsView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
