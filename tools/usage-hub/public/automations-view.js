// Scheda «Automazioni» della dashboard: dal modello all'HTML.
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

  // Giorno di Roma come numero, per calcolare «ieri» e «lunedì».
  function romeDay(at) {
    var p = rome(at);
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000;
  }

  // «15:02», ore senza zero iniziale come nel resto della scheda.
  function hm(at) {
    var p = rome(at);
    return p.hour + ':' + p.minute;
  }

  // «12/10» da un ISO o da ms, in ora di Roma.
  function dm(at) {
    var p = rome(at);
    return p.day + '/' + p.month;
  }

  // Quando è successo l'ultimo giro, in parole. Mai solo un pallino.
  function lastWords(last, now) {
    var at = last && last.at;
    if (at == null) return 'mai partito';
    var n = now ?? Date.now();
    var p = rome(at);
    var h = p.hour + ':' + p.minute;
    var diff = romeDay(n) - romeDay(at);
    if (diff <= 0) return (Number(p.hour) < 6 ? 'stanotte alle ' : 'alle ') + h;
    if (diff === 1) return 'ieri alle ' + h;
    if (diff <= 6) return p.weekday + ' alle ' + h;
    return 'il ' + p.day + '/' + p.month + ' alle ' + h;
  }

  // Come ti è arrivato l'ultimo messaggio, in parole. Niente se non era richiesto.
  function deliveredWords(d) {
    if (d === 'delivered') return 'ti è arrivato';
    if (d === 'failed') return 'non ti è arrivato';
    return '';
  }

  var OUTCOME = { ok: 'riuscito', error: 'fallito', skipped: 'saltato', running: 'in corso' };
  function outcomeWord(o) {
    return OUTCOME[o] || 'stato ignoto';
  }

  // «· prossimo domani alle 4:32» (o «· verso le 3:30» se la data è una stima).
  function nextPart(c, now) {
    if (c.next == null) return '';
    if (c.nextApprox) {
      var diff = romeDay(c.next) - romeDay(now);
      if (diff <= 1) return ' · verso le ' + hm(c.next);
      return ' · verso ' + lastWords({ at: c.next }, now);
    }
    var d = romeDay(c.next) - romeDay(now);
    if (d <= 0) return ' · prossimo oggi alle ' + hm(c.next);
    if (d === 1) return ' · prossimo domani alle ' + hm(c.next);
    return ' · prossimo ' + lastWords({ at: c.next }, now);
  }

  function lastLine(c, now) {
    var l = c.last || {};
    // atUnknown: launchd dice l'esito ma non l'ora (il job non scrive a ogni giro); atApprox: ora vista dall'hub.
    var s = l.at == null
      ? (l.atUnknown ? 'Ultimo giro: ' + outcomeWord(l.outcome) + ', ora non registrata' : 'Ultimo giro: mai partito')
      : 'Ultimo giro: ' + (l.atApprox ? 'verso ' : '') + lastWords(l, now) + ', ' + outcomeWord(l.outcome);
    var d = deliveredWords(l.delivered);
    if (d) s += ' · ' + d;
    s += nextPart(c, now);
    return s;
  }

  var VOTE_WORD = { ok: 'va bene', cambia: 'da cambiare' };
  function voteWord(v) {
    return VOTE_WORD[v] || v;
  }

  // Le righe «Hai detto…», «È cambiata…», «Silenziata…», «N note aperte».
  function feedbackLines(fb) {
    var out = [];
    var v = fb && fb.vote;
    if (v) {
      var s = 'Hai detto: ' + voteWord(v.v) + (v.at ? ', ' + dm(v.at) : '');
      if (v.note) s += ' — «' + v.note + '»';
      out.push(s);
    }
    if (fb && fb.changedSinceVote) out.push(v ? 'È cambiata dopo il tuo ' + voteWord(v.v) : 'È cambiata dopo il tuo voto');
    var m = fb && fb.mute;
    if (m) {
      out.push(m.until
        ? 'Silenziata fino al ' + dm(m.until) + (m.why ? ': ' + m.why : '')
        : 'Silenziata per sempre' + (m.why ? ': ' + m.why : ''));
    }
    if (fb && fb.open > 0) out.push(fb.open === 1 ? '1 nota aperta' : fb.open + ' note aperte');
    return out;
  }

  var LEVEL_WORD = { va: 'ok', te: 'ti aspetta', rotto: 'rotto', nascosto: 'nascosto' };

  function techHtml(c, now) {
    var t = c.tech || {};
    var rows = [];
    if (c.key) rows.push('<div>Chiave: ' + esc(c.key) + '</div>');
    if (t.schedule) rows.push('<div>Quando: ' + esc(String(t.schedule)) + '</div>');
    if (t.exit != null) rows.push('<div>Uscita: codice ' + esc(String(t.exit)) + '</div>');
    var cmd = t.command || t.prompt;
    if (cmd) rows.push('<pre>' + esc(cmd) + '</pre>');
    var srcs = c.sources || [];
    if (srcs.length > 1) {
      rows.push('<div>Fonti:</div><ul>' + srcs.map(function (s) {
        return '<li>' + esc(s.key) + ' — ' + esc(LEVEL_WORD[s.level] || s.level) +
          ' — ultimo ' + esc(lastWords(s.last, now)) + '</li>';
      }).join('') + '</ul>');
    }
    if (t.url) rows.push('<div><a href="' + esc(t.url) + '">Apri in OpenClaw</a></div>');
    if (!rows.length) return '';
    return '<details class="tech"><summary>Dettagli tecnici</summary>' + rows.join('') + '</details>';
  }

  // La card intera, usata nelle sezioni in alto e dentro le righe dei gruppi.
  function card(c, ui, now) {
    var fb = c.feedback || {};
    var h = '<article class="au-card lv-' + esc(c.level || 'va') + '" tabindex="0" data-key="' + esc(c.key) + '"' +
      (c.fp ? ' data-fp="' + esc(c.fp) + '"' : '') + '>';
    h += '<h4>' + esc(c.title) + ((c.sources || []).length > 1 ? ' <span class="pill">vista da ' + c.sources.length + ' fonti</span>' : '') + '</h4>';
    if ((c.level === 'te' || c.level === 'rotto') && c.reason) h += '<p class="au-why">' + esc(c.reason) + '</p>';
    if (c.cosa) h += '<p class="au-what" title="Tocca per leggere tutto">' + esc(c.cosa) + '</p>';
    if (c.means) h += '<div class="small mut">Ti scrive: ' + esc(c.means) + '</div>';
    if (c.who) h += '<div class="small mut">Esegue: ' + esc(c.who) + '</div>';
    h += '<div class="au-last">' + esc(lastLine(c, now)) + '</div>';
    if (c.proof && !(c.proof.ok === false && c.reason && c.reason.indexOf(c.proof.words) !== -1)) {
      h += '<div class="au-proof' + (c.proof.ok === false ? ' bad' : '') + '">Prova: ' + esc(c.proof.words || '') + '</div>';
    }
    for (const line of feedbackLines(fb)) h += '<div class="au-fb small">' + esc(line) + '</div>';
    var pressed = function (v) {
      return fb.vote && fb.vote.v === v ? ' aria-pressed="true"' : ' aria-pressed="false"';
    };
    h += '<div class="au-act">' +
      '<button class="b" data-fb="ok" aria-keyshortcuts="v"' + pressed('ok') + '>Va bene</button>' +
      '<button class="b" data-fb="cambia" aria-keyshortcuts="c"' + pressed('cambia') + '>Da cambiare</button>' +
      '<button class="b" data-fb="nota" aria-keyshortcuts="n">Nota</button>' +
      '<button class="b" data-fb="segnala" aria-keyshortcuts="s">Segnala</button>' +
      '<button class="b" data-fb="muta" aria-keyshortcuts="m">Non avvisarmi più</button></div>';
    h += techHtml(c, now);
    return h + '</article>';
  }

  function verdictHtml(model, now) {
    var v = model.verdict;
    var cls = '';
    var title;
    var sub = (v.runsToday || 0) + ((v.runsToday || 0) === 1 ? ' giro oggi' : ' giri oggi') +
      ' · controllato alle ' + hm(model.checkedAt);
    if (!v.needsYou && !v.broken) {
      title = 'Tutto a posto';
    } else {
      var p = [];
      if (v.needsYou) p.push(v.needsYou + (v.needsYou === 1 ? ' ti aspetta' : ' ti aspettano'));
      if (v.broken) p.push(v.broken + (v.broken === 1 ? ' rotta' : ' rotte'));
      title = p.join(' · ');
      cls = v.broken ? 'bad' : 'warn';
    }
    if (model.feedbackOpen > 0) sub += ' · ' + model.feedbackOpen + (model.feedbackOpen === 1 ? ' richiesta aperta agli agenti' : ' richieste aperte agli agenti');
    if (model.stale) sub += " · dati di alle " + hm(model.checkedAt) + ", l'ultima lettura non è riuscita";
    return '<section class="au-sec status' + (cls ? ' ' + cls : '') + '" data-sec="verdict"><div><b>' +
      esc(title) + '</b><span class="mut small">' + esc(sub) + '</span></div></section>';
  }

  function sinceHtml(model, ui) {
    var seen = (ui && ui.seen) || {};
    var news = seen.newKeys || [];
    var changed = seen.changedKeys || [];
    if (!news.length && !changed.length) return '';
    var p = [];
    if (news.length) p.push(news.length + (news.length === 1 ? ' nuova' : ' nuove'));
    if (changed.length) p.push(changed.length + (changed.length === 1 ? ' cambiata' : ' cambiate'));
    var titles = news.concat(changed).map(function (k) {
      return (model.cards && model.cards[k] && model.cards[k].title) || k;
    });
    return '<section class="au-sec" data-sec="since"><h3>Da ieri: ' + esc(p.join(', ')) +
      '</h3><div class="small mut">' + titles.map(esc).join(' · ') + '</div></section>';
  }

  function listHtml(sec, heading, cards, emptyTxt, ui, now, extra) {
    if (!cards.length) return '<section class="au-sec au-quiet" data-sec="' + sec + '"><div class="au-empty">' + esc(emptyTxt) + '</div></section>';
    return '<section class="au-sec' + (extra ? ' ' + extra : '') + '" data-sec="' + sec + '"><h3>' +
      esc(heading) + '</h3>' + cards.map(function (c) { return card(c, ui, now); }).join('') + '</section>';
  }

  function worksHtml(model, ui, now) {
    var gs = (model.groups || []).map(function (g) {
      var n = (g.cards || []).length;
      var summary = n
        ? esc(g.title) + ' · ' + n + groupLast(g, now)
        : '<span class="au-none">' + esc(g.title) + ' · nessuna automazione</span>';
      var inner = (g.cards || []).map(function (c) {
        return '<details class="au-row" data-key="' + esc(c.key) + '"><summary><span>' + esc(c.title) +
          '</span><span class="mut">' + esc(lastWords(c.last, now)) + '</span></summary>' +
          card(c, ui, now) + '</details>';
      }).join('');
      return '<details class="au-group"><summary>' + summary + '</summary>' + inner + '</details>';
    }).join('');
    return '<section class="au-sec" data-sec="works"><h3>Funzionano</h3>' + gs + '</section>';
  }

  // L'ultimo giro più recente del gruppo, a destra del titolo.
  function groupLast(g, now) {
    var m = 0;
    for (const c of g.cards || []) if (c.last && c.last.at && c.last.at > m) m = c.last.at;
    if (!m) return '';
    return ' <span class="mut">ultimo ' + esc(lastWords({ at: m }, now)) + '</span>';
  }

  function phaseDots(ph) {
    var total = ph.total || 0;
    var done = Math.min(ph.done || 0, total);
    var failed = Math.min(ph.failed || 0, total - done);
    var idle = Math.max(total - done - failed, 0);
    return '<span class="au-ph">' + esc(ph.title || '') + ' ' +
      '<span class="ok">' + '●'.repeat(done) + '</span>' +
      '<span class="bad">' + '✕'.repeat(failed) + '</span>' +
      '<span class="mut">' + '○'.repeat(idle) + '</span></span>';
  }

  function durWords(ms) {
    if (ms == null) return '';
    var s = Math.round(ms / 1000);
    if (s < 60) return s + ' s';
    return Math.round(s / 60) + ' min';
  }

  function costHtml(runId, ui) {
    var c = ui && ui.costs && ui.costs[runId];
    if (c && c.weekPct != null) {
      return '<span class="mut">· ≈ ' + esc(String(c.weekPct).replace('.', ',')) + '% della settimana (stima)</span>';
    }
    if (c) return '<span class="mut">· costo non stimabile</span>';
    return '<button class="b" data-cost="' + esc(runId) + '">Costo</button>';
  }

  function runRow(r, now, ui) {
    var bits = ['ultimo ' + lastWords({ at: r.at }, now) + ', ' + outcomeWord(r.outcome)];
    if (r.durationMs != null) bits.push(durWords(r.durationMs));
    if (r.agents != null) bits.push(r.agents + (r.agents === 1 ? ' agente' : ' agenti'));
    if (r.summary) bits.push(r.summary);
    return '<div class="au-run">' + esc(bits.join(' · ')) + ' ' + costHtml(r.runId, ui) + '</div>';
  }

  function workflowsHtml(model, ui, now) {
    var wf = model.workflows || { days: 7, total: 0, failed: 0, byName: [] };
    var summary = !wf.total
      ? 'Workflow · nessuno in ' + wf.days + ' giorni'
      : 'Workflow · ' + wf.total + ' in ' + wf.days + ' giorni · ' +
        (wf.failed
          ? '<span class="bad">' + wf.failed + (wf.failed === 1 ? ' fallito' : ' falliti') + '</span>'
          : 'nessuno fallito');
    var inner = (wf.byName || []).map(function (w) {
      var last = (w.runs || [])[0];
      var line = last ? 'ultimo ' + lastWords({ at: last.at }, now) + ', ' + outcomeWord(last.outcome) : 'mai partito';
      var phases = last && last.phases ? ' ' + last.phases.map(phaseDots).join(' ') : '';
      var hist = '<details class="au-hist"><summary>Storia · ' + (w.runs || []).length +
        ((w.runs || []).length === 1 ? ' giro' : ' giri') + '</summary>' +
        (w.runs || []).map(function (r) { return runRow(r, now, ui); }).join('') + '</details>';
      return '<div class="au-wfrow"><div><b>' + esc(w.name) + '</b> <span class="mut small">' + esc(line) + '</span></div>' +
        (phases ? '<div class="au-phases small">' + phases + '</div>' : '') + hist + '</div>';
    }).join('');
    if (!inner) inner = '<div class="au-empty">Nessun giro negli ultimi ' + wf.days + ' giorni.</div>';
    return '<section class="au-sec" data-sec="workflows"><details class="au-wf"><summary>' + summary +
      '</summary>' + inner + '</details></section>';
  }

  function reviewHtml(model, ui) {
    var rev = model.review || {};
    var unc = rev.unconfirmed || [];
    if (!unc.length) return '';
    var n = unc.length;
    var mins = Math.max(Math.ceil((n * 7) / 60), 1);
    var summary = n + (n === 1 ? ' mai confermata' : ' mai confermate') +
      ' · <button class="b" data-review="start">Ripassale (≈' + mins + ' min)</button>';
    var body = '';
    if (ui && ui.review && ui.review.open) {
      var key = unc.indexOf(ui.review.key) !== -1 ? ui.review.key : unc[0];
      var at = unc.indexOf(key) + 1;
      var c = model.cards && model.cards[key];
      body = '<div class="au-rev-now"><div class="small mut">' + at + '/' + n + '</div>' +
        (c ? card(c, ui, (ui && ui.now) || model.checkedAt) : '') +
        '<div class="au-act"><button class="b" data-review="prev">Indietro</button>' +
        '<button class="b" data-review="next">Dopo</button>' +
        '<button class="b" data-review="close">Chiudi</button></div></div>';
    }
    // Niente <details>: un pulsante dentro un summary è un controllo dentro un controllo (axe, nested-interactive).
    return '<section class="au-sec" data-sec="review"><div class="au-rev-head">' + summary + '</div>' + body + '</section>';
  }

  function footerHtml(model) {
    var f = model.footer || {};
    var srcs = (f.sources || []).map(function (s) {
      if (s.note && s.note !== '?') return esc(s.note);
      if (s.at) return esc(s.label) + ' ' + hm(s.at);
      var t = s.pending ? 'primo giro in corso' : 'non risponde';
      return esc(s.label) + ' <span class="au-q" title="' + esc(t) + '">?</span>';
    }).join(' · ');
    var extra = [];
    var hid = f.hidden || {};
    if (hid.count > 0) {
      extra.push('<details class="au-hid"><summary>nascosti: ' + hid.count + '</summary><ul>' +
        (hid.why || []).map(function (w) {
          return '<li>' + esc(w.title) + ' — ' + esc(w.reason) + '</li>';
        }).join('') + '</ul></details>');
    }
    var counts = f.counts || {};
    for (const k of Object.keys(counts)) {
      if (counts[k] > 0) extra.push('<span>' + esc(k[0].toUpperCase() + k.slice(1)) + ': ' + counts[k] +
        (counts[k] === 1 ? ' automazione' : ' automazioni') + '</span>');
    }
    if (model.health) {
      extra.push('<span class="au-health"' + (model.health.stale ? ' title="l\u2019ultimo controllo non \u00e8 riuscito"' : '') +
        '>Controllo di salute delle ' + hm(model.health.at) + '</span>');
    }
    return '<section class="au-sec" data-sec="footer"><div class="small mut">' + srcs + '</div>' +
      (extra.length ? '<div class="small mut au-extra">' + extra.join(' · ') + '</div>' : '') + '</section>';
  }

  function render(model, ui) {
    ui = ui || {};
    var now = (ui.now != null) ? ui.now : model.checkedAt;
    return verdictHtml(model, now) +
      sinceHtml(model, ui) +
      listHtml('needs', 'Ti aspettano', model.needsYou || [], 'Niente ti aspetta.', ui, now, 'au-needs') +
      listHtml('broken', 'Rotte, possono aspettare', model.broken || [], 'Niente di rotto.', ui, now, 'au-broken') +
      worksHtml(model, ui, now) +
      workflowsHtml(model, ui, now) +
      reviewHtml(model, ui) +
      footerHtml(model);
  }

  var api = { render: render, lastWords: lastWords, deliveredWords: deliveredWords, esc: esc, card: card };
  // Sempre sul globale: così il test con createRequire trova tutto anche se `module.exports` non esce.
  root.AutomationsView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
