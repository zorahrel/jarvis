// Scheda «Automazioni» della dashboard: dal modello all'HTML, come una console.
// Tabella per scopo (mai per motore), pannello di dettaglio laterale, workflow come schema a passi.
// Funzione pura (niente Date.now, niente rete): la usano il browser e i test.
// Come actions.js: IIFE; in node `module.exports`, nel browser `root.AutomationsView`.
(function (root) {
  var TZ = 'Europe/Rome';

  // Via i caratteri che rompono l'HTML.
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

  // ---- Scopo: ciò che le automazioni fanno per Attilio ----
  var AREAS = [
    { id: 'posta-avvisi', title: 'Posta e avvisi' },
    { id: 'clienti', title: 'Clienti' },
    { id: 'sviluppo-topics', title: 'Sviluppo' },
    { id: 'jarvis-agenti', title: 'Jarvis e agenti' },
    { id: 'manutenzione', title: 'Manutenzione' },
    { id: 'backup-sicurezza', title: 'Backup e sicurezza' },
  ];
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
    if (c.level === 'te') return '<span class="cx-g te" aria-hidden="true"></span><span class="sr">Ti aspetta</span>';
    if (c.level === 'rotto') return '<span class="cx-g rotto" aria-hidden="true"></span><span class="sr">Rotta</span>';
    var bad = c.last && c.last.outcome === 'error';
    return '<span class="cx-g ' + (bad ? 'err' : 'ok') + '" aria-hidden="true"></span><span class="sr">' + (bad ? 'ultimo giro fallito' : 'regolare') + '</span>';
  }
  function rowHtml(c, ui, now) {
    var nx = c.next ? (c.nextApprox ? '~' : '') + short(c.next, now) : '—';
    return '<div class="cx-row' + (ui.sel === c.key ? ' sel' : '') + '" role="button" tabindex="0" data-cx="' + esc(c.key) + '">' + glyph(c) +
      '<span class="cx-t">' + esc(c.title) + (isProblem(c) && c.reason ? '<small>' + esc(c.reason) + '</small>' : '') + '</span>' +
      '<span class="cx-c' + (c.last && c.last.at ? '' : ' dim') + '">' + esc(short(c.last && c.last.at, now)) + '</span>' +
      '<span class="cx-c nx dim">' + esc(nx) + '</span><span class="cx-c rt dim">' + (c.runsToday || 0) + '</span></div>';
  }
  function wfRowHtml(w, ui, now) {
    var run = (w.runs || [])[0] || {};
    var t = runTokens(run);
    var bad = run.outcome === 'error';
    return '<div class="cx-row' + (ui.sel === 'wf:' + w.name ? ' sel' : '') + '" role="button" tabindex="0" data-cx="wf:' + esc(w.name) + '">' +
      '<span class="cx-g ' + (bad ? 'rotto' : 'ok') + '" aria-hidden="true"></span><span class="sr">' + (bad ? 'fallito' : 'riuscito') + '</span>' +
      '<span class="cx-t">' + esc(wfTitle(w.name)) + '</span><span class="cx-c">' + esc(short(run.at, now)) + '</span>' +
      '<span class="cx-c nx dim">' + esc(durWords(run.durationMs) || '—') + '</span><span class="cx-c rt' + (t && !t.saved ? ' claude' : ' dim') + '">' + esc(t ? tok(t.total) : '—') + '</span></div>';
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
    if (model.stale) fresh = "ultima lettura fallita · dati delle " + hm(model.checkedAt);
    if (ui.offline) fresh = 'hub muto · dati delle ' + hm(model.checkedAt) + ' <button class="cx-btn" data-au-retry="1">Riprova</button>';
    var srcs = (model.footer || {}).sources || [];
    var srcOk = srcs.filter(function (s) { return s.ok; }).length;
    var pb = cards.filter(isProblem).length;
    var seg = [['all', 'Tutte', cards.length], ['pb', 'Problemi', pb], ['ok', 'Ok', cards.length - pb]];
    var f = ui.filter || 'all';
    return '<section class="cx-head" data-sec="verdict"><div class="cx-state ' + tone + '"><span class="cx-sq" aria-hidden="true"></span><h2>' + esc(title) + '</h2><span class="cx-fresh">' + fresh + '</span></div>' +
      '<div class="cx-stats"><div><b>' + num(cards.length) + '</b><span>automazioni</span></div>' +
      '<div><b class="' + (v.needsYou ? 'te' : '') + '">' + (v.needsYou || 0) + '</b><span>ti aspettano</span></div>' +
      '<div><b class="' + (v.broken ? 'bad' : '') + '">' + (v.broken || 0) + '</b><span>rotte</span></div>' +
      '<div><b>' + num(v.runsToday || 0) + '</b><span>giri oggi · ' + srcOk + '/' + srcs.length + ' fonti</span></div></div>' +
      '<div class="cx-tools"><div class="cx-seg" role="group" aria-label="Filtro">' + seg.map(function (s) {
        return '<button data-au-filter="' + s[0] + '" aria-pressed="' + (f === s[0]) + '">' + s[1] + '<b>' + s[2] + '</b></button>';
      }).join('') + '</div><label class="cx-q"><span class="sr">Cerca</span><input type="search" data-au-q placeholder="Cerca per nome, scopo, chi la esegue" value="' + esc(ui.q || '') + '" autocomplete="off"><kbd aria-hidden="true">/</kbd></label></div></section>';
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

  function tableHtml(model, ui, now) {
    var cards = allCards(model).filter(function (c) { return matches(c, ui); });
    var searching = !!(ui.q || '').trim() || (ui.filter && ui.filter !== 'all');
    var h = '<div class="cx-row cx-hdr" aria-hidden="true"><span></span><span>Nome</span><span class="cx-c">Ultimo</span><span class="cx-c nx">Prossimo</span><span class="cx-c rt">Oggi</span></div>';
    var shown = 0;
    var pbs = cards.filter(isProblem);
    if (pbs.length) {
      h += '<div class="cx-gh att">Richiede attenzione<span class="cx-cnt">' + pbs.length + '</span></div>';
      for (const c of pbs) h += rowHtml(c, ui, now);
      shown += pbs.length;
    }
    var areas = (model.areas && model.areas.length ? model.areas : AREAS);
    for (const a of areas) {
      var all = allCards(model).filter(function (c) { return areaOf(c) === a.id; });
      var rest = cards.filter(function (c) { return !isProblem(c) && areaOf(c) === a.id; });
      if (!rest.length) continue;
      var te = all.filter(function (c) { return c.level === 'te'; }).length;
      var ro = all.filter(function (c) { return c.level === 'rotto'; }).length;
      h += '<div class="cx-gh">' + esc(a.title) + '<span class="cx-cnt"><span>' + (all.length - te - ro) + ' ok</span>' +
        (te ? '<span class="te">' + te + ' ▲</span>' : '') + (ro ? '<span class="bad">' + ro + ' ✕</span>' : '') + '</span></div>';
      for (const c of rest) h += rowHtml(c, ui, now);
      shown += rest.length;
    }
    var ws = ((model.workflows || {}).byName || []).filter(function (w) {
      var q = (ui.q || '').trim().toLowerCase();
      if (ui.filter === 'pb') return w.runs && w.runs[0] && w.runs[0].outcome === 'error';
      return !q || (wfTitle(w.name) + ' ' + ((w.runs[0] || {}).summary || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (ws.length) {
      var wf = model.workflows || {};
      h += '<div class="cx-gh">Workflow · ' + wf.days + ' giorni<span class="cx-cnt"><span>' + wf.total + ' giri</span>' +
        (wf.failed ? '<span class="bad">' + wf.failed + ' ✕</span>' : '') + '</span></div>';
      for (const w of ws) h += wfRowHtml(w, ui, now);
    }
    if (!shown && searching && !ws.length) {
      h += '<div class="cx-empty"><b>Niente da mostrare</b>' + ((ui.q || '').trim() ? 'Nessuna automazione contiene «' + esc(ui.q.trim()) + '».' : 'Nessuna voce con questo filtro.') + ' <button class="b" data-au-clear="1">Togli il filtro</button></div>';
    }
    if (!allCards(model).length) h += '<div class="cx-empty"><b>Nessuna automazione letta</b>Le fonti non hanno ancora risposto.</div>';
    return '<section class="cx-tbl" data-sec="table">' + h + '</section>';
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
    rows.push('<dt>Chiave</dt><dd>' + esc(c.key) + '</dd>');
    if (t.schedule) rows.push('<dt>Quando</dt><dd>' + esc(String(t.schedule)) + '</dd>');
    if (t.exit != null) rows.push('<dt>Uscita</dt><dd>codice ' + esc(String(t.exit)) + '</dd>');
    var srcs = c.sources || [];
    if (srcs.length > 1) rows.push('<dt>Fonti</dt><dd>' + srcs.map(function (s) { return esc(s.key); }).join('<br>') + '</dd>');
    var cmd = t.command || t.prompt;
    return '<details class="tech"><summary>Dettagli tecnici</summary><dl class="cx-dl">' + rows.join('') + '</dl>' +
      (cmd ? '<pre>' + esc(cmd) + '</pre>' : '') + (t.url ? '<a href="' + esc(t.url) + '">Apri in OpenClaw</a>' : '') + '</details>';
  }

  var LEVEL = { te: 'Ti aspetta', rotto: 'Rotta' };
  // Barra in cima al pannello, come in A: stato, sistema, chiudi.
  function panelHead(chipCls, chip, sys) {
    return '<div class="cx-ph"><span class="cx-chip ' + chipCls + '">' + esc(chip) + '</span><span class="cx-sys">' + esc(sys) + '</span>' +
      '<button class="cx-x" data-cx-close="1" aria-label="Chiudi">✕</button></div>';
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
    facts.push('<dt>Se si rompe</dt><dd' + (br ? '' : ' class="dim"') + '>' + esc(br || 'non scritto') + '</dd>');
    if (c.who) facts.push('<dt>Esegue</dt><dd>' + esc(c.who) + '</dd>');
    if (c.means) facts.push('<dt>Ti scrive</dt><dd>' + esc(c.means) + '</dd>');
    facts.push('<dt>Area</dt><dd>' + esc(area ? area.title : '') + (c.purpose && c.purpose.area ? '' : ' (area stimata)') + '</dd>');
    var pressed = function (v) { return fb.vote && fb.vote.v === v ? ' aria-pressed="true"' : ' aria-pressed="false"'; };
    return '<article class="au-card lv-' + esc(c.level || 'va') + '" tabindex="-1" data-key="' + esc(c.key) + '"' + (c.fp ? ' data-fp="' + esc(c.fp) + '"' : '') + '>' +
      panelHead(c.level === 'te' || c.level === 'rotto' ? c.level : 'va', LEVEL[c.level] || 'Ok', (SYS[c.provider] || c.provider || '—') + ((c.sources || []).length > 1 ? ' · ' + c.sources.length + ' fonti' : '')) +
      '<div class="cx-pb"><h3 id="cx-pt">' + esc(c.title) + '</h3>' +
      (isProblem(c) && c.reason ? '<p class="au-why ' + esc(c.level) + '">' + esc(c.reason) + '</p>' : '') +
      (forYou(c) ? '<p class="cx-desc">' + esc(forYou(c)) + '</p>' : '') +
      '<dl class="cx-dl">' + facts.join('') + '</dl>' +
      feedbackLines(fb).map(function (s) { return '<div class="cx-fbl">' + esc(s) + '</div>'; }).join('') +
      '<div class="au-act"><button class="cx-btn pri" data-fb="ok" aria-keyshortcuts="v"' + pressed('ok') + '>Va bene <kbd>V</kbd></button>' +
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
    for (var i = 0; i < 8; i++) r += '<div class="cx-row cx-hdr"><span class="au-skl" style="width:10px;height:10px"></span><span class="au-skl" style="width:' + (35 + (i * 13) % 40) + '%"></span><span class="au-skl"></span><span class="au-skl nx"></span><span class="au-skl rt"></span></div>';
    return '<div role="status"><span class="sr">Carico le automazioni…</span><section class="cx-head" data-sec="verdict" aria-busy="true"><div class="au-skl" style="width:220px;height:20px"></div>' +
      '<div class="au-skl" style="width:160px;height:11px;margin:10px 0 14px"></div><div class="au-skl" style="height:58px;border-radius:10px"></div></section><section class="cx-tbl">' + r + '</section></div>';
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

  var api = { render: render, skeleton: skeleton, errorHtml: errorHtml, lastWords: lastWords, deliveredWords: deliveredWords, esc: esc, card: card, areaOf: areaOf, runTokens: runTokens, flowHtml: flowHtml };
  // Sempre sul globale: così il test con createRequire trova tutto anche se `module.exports` non esce.
  root.AutomationsView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
