// Varianti della scheda Automazioni: dati e parole in comune, niente stile.
// Ogni variante disegna a modo suo; qui solo lettura dell'API, orari in parole e feedback.
(function (root) {
  var TZ = 'Europe/Rome';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function parts(at) {
    var p = {};
    var f = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
    for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
    return p;
  }
  function day(at) {
    var p = parts(at);
    return Date.UTC(+p.year, +p.month - 1, +p.day) / 86400000;
  }
  function hm(at) {
    var p = parts(at);
    return p.hour + ':' + p.minute;
  }

  // «alle 14:00», «ieri alle 9:30», «martedì alle 9:00», «il 12/10 alle 4:32».
  function when(at, now) {
    if (at == null) return 'mai';
    var p = parts(at);
    var d = day(now) - day(at);
    var h = p.hour + ':' + p.minute;
    if (d < 0) return d === -1 ? 'domani alle ' + h : p.weekday + ' alle ' + h;
    if (d === 0) return (+p.hour < 6 ? 'stanotte alle ' : 'alle ') + h;
    if (d === 1) return 'ieri alle ' + h;
    if (d <= 6) return p.weekday + ' alle ' + h;
    return 'il ' + p.day + '/' + p.month + ' alle ' + h;
  }

  // Versione corta per tabelle e tile: «14:00», «ieri 9:30», «mar 9:00», «12/10».
  function short(at, now) {
    if (at == null) return '—';
    var p = parts(at);
    var d = day(now) - day(at);
    var h = p.hour + ':' + p.minute;
    if (d === 0) return h;
    if (d === 1) return 'ieri ' + h;
    if (d === -1) return 'domani ' + h;
    if (Math.abs(d) <= 6) return p.weekday.slice(0, 3) + ' ' + h;
    return p.day + '/' + p.month;
  }

  // Quanto tempo fa, per «controllato 2 min fa».
  function ago(at, now) {
    var m = Math.round((now - at) / 60000);
    if (m < 1) return 'adesso';
    if (m < 60) return m + ' min fa';
    var h = Math.round(m / 60);
    return h + (h === 1 ? ' ora fa' : ' ore fa');
  }

  var SYS = {
    openclaw: { name: 'OpenClaw', what: 'cron degli agenti' },
    launchd: { name: 'Mac', what: 'lavori a orario del Mac' },
    desktop: { name: 'Claude desktop', what: 'task programmati' },
    lobster: { name: 'Workflow', what: 'flussi in più passi' },
    workflow: { name: 'Workflow', what: 'flussi in più passi' },
    github: { name: 'GitHub', what: 'controlli dei repo' },
    pc: { name: 'PC di casa', what: 'task di Windows' },
  };
  var SYS_ORDER = ['OpenClaw', 'Mac', 'Claude desktop', 'Workflow', 'GitHub', 'PC di casa'];
  function sys(p) {
    return SYS[p] || { name: p || 'Altro', what: '' };
  }

  var OUT = { ok: 'riuscito', error: 'fallito', skipped: 'saltato', running: 'in corso' };
  function outcome(o) {
    return OUT[o] || (o ? o : 'mai partito');
  }

  // Stato in parole, sempre accanto al colore.
  var LEVEL = { te: 'Ti aspetta', rotto: 'Rotta', va: 'Ok', nascosto: 'Nascosta' };
  function level(l) {
    return LEVEL[l] || 'Ok';
  }

  // Tutte le card visibili, una volta sola ciascuna.
  function all(model) {
    var seen = {};
    var out = [];
    var list = (model.needsYou || []).concat(model.broken || []);
    for (const g of model.groups || []) list = list.concat(g.cards || []);
    for (const c of list) {
      if (seen[c.key] || c.level === 'nascosto') continue;
      seen[c.key] = 1;
      out.push(c);
    }
    return out;
  }

  // Un gruppo per sistema, nell'ordine fisso; dentro, prima chi ha problemi.
  function systems(model) {
    var map = {};
    var rank = { te: 0, rotto: 1, va: 2 };
    for (const c of all(model)) {
      var n = sys(c.provider).name;
      var g = map[n] || (map[n] = { name: n, what: sys(c.provider).what, cards: [], te: 0, rotto: 0, ok: 0, last: 0, runsToday: 0 });
      g.cards.push(c);
      if (c.level === 'te') g.te++; else if (c.level === 'rotto') g.rotto++; else g.ok++;
      if (c.last && c.last.at > g.last) g.last = c.last.at;
      g.runsToday += c.runsToday || 0;
    }
    var out = [];
    for (const n of SYS_ORDER) if (map[n]) out.push(map[n]);
    for (const n of Object.keys(map)) if (SYS_ORDER.indexOf(n) === -1) out.push(map[n]);
    for (const g of out) g.cards.sort(function (a, b) { return (rank[a.level] ?? 2) - (rank[b.level] ?? 2) || (b.last && b.last.at || 0) - (a.last && a.last.at || 0); });
    // Fonti che non rispondono: il sistema compare lo stesso, con «?».
    for (const s of ((model.footer || {}).sources || [])) {
      var nm = sys(s.name).name;
      var g2 = out.find(function (x) { return x.name === nm; });
      if (g2) g2.source = s;
      else if (SYS[s.name]) out.push({ name: nm, what: sys(s.name).what, cards: [], te: 0, rotto: 0, ok: 0, last: 0, runsToday: 0, source: s });
    }
    return out;
  }

  // Esiti degli ultimi giri, se l'API li manda; altrimenti solo l'ultimo.
  function runs(c) {
    if (c.history && c.history.length) return c.history.slice(-12);
    return c.last && c.last.outcome ? [c.last.outcome] : [];
  }

  async function load() {
    try {
      var r = await fetch('/api/automations', { signal: AbortSignal.timeout(60000) });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    }
  }

  // Scrive nello stesso feedback della pagina principale (append-only, in private/automazioni).
  async function send(body) {
    try {
      var r = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) {
      return null;
    }
  }
  function vote(c, v, note) {
    var b = { kind: 'vote', key: c.key, fp: c.fp, v: v };
    if (note) b.note = note;
    return send(b);
  }

  // Ciò che la card dice di sé in una riga: il motivo se c'è un problema, altrimenti l'ultimo giro.
  function line(c, now) {
    if ((c.level === 'te' || c.level === 'rotto') && c.reason) return c.reason;
    var l = c.last || {};
    return l.at ? 'ultimo ' + when(l.at, now) + ', ' + outcome(l.outcome) : 'non ha ancora girato';
  }

  function verdict(model) {
    var v = model.verdict || {};
    if (!v.needsYou && !v.broken) return { tone: 'ok', text: 'Tutto a posto' };
    var p = [];
    if (v.needsYou) p.push(v.needsYou + (v.needsYou === 1 ? ' ti aspetta' : ' ti aspettano'));
    if (v.broken) p.push(v.broken + (v.broken === 1 ? ' rotta' : ' rotte'));
    return { tone: v.needsYou ? 'te' : 'bad', text: p.join(' · ') };
  }

  // Fonte che non risponde o non ha ancora finito il primo giro: mai contata come «a posto».
  function down(src) {
    return !!src && !src.ok && (!src.note || src.note === '?');
  }


  // ---- Scopo: le aree sono ciò che le automazioni fanno per Attilio, mai il motore che le esegue ----
  var AREAS = [
    { id: 'posta-avvisi', title: 'Posta e avvisi', lede: 'Ti arriva ciò che deve, quando deve.' },
    { id: 'clienti', title: 'Clienti', lede: 'Fatture, report e consegne per chi lavora con te.' },
    { id: 'sviluppo-topics', title: 'Sviluppo', lede: 'Topics e i prodotti restano verificati.' },
    { id: 'jarvis-agenti', title: 'Jarvis e agenti', lede: 'Gli agenti lavorano, le quote reggono.' },
    { id: 'manutenzione', title: 'Manutenzione', lede: 'Mac e PC respirano da soli.' },
    { id: 'backup-sicurezza', title: 'Backup e sicurezza', lede: 'I dati sono copiati e al sicuro.' },
  ];
  // Finché l'API non manda purpose, l'area si stima dal gruppo vecchio (stessa tabella di purpose.mjs).
  var FROM_GROUP = { arriva: 'posta-avvisi', dati: 'backup-sicurezza', quote: 'jarvis-agenti', macchine: 'manutenzione', prodotti: 'sviluppo-topics' };
  function areaOf(c) {
    var p = c.purpose || {};
    return p.area || FROM_GROUP[c.group] || 'manutenzione';
  }
  function areaGuessed(c) {
    return !(c.purpose && c.purpose.area);
  }
  function forYou(c) {
    return (c.purpose && c.purpose.cosaFaPerTe) || c.cosa || '';
  }
  function ifBroken(c) {
    return (c.purpose && c.purpose.seSiRompe) || null;
  }
  function areas(model) {
    var map = {};
    for (const a of AREAS) map[a.id] = { id: a.id, title: a.title, lede: a.lede, cards: [], te: 0, rotto: 0, ok: 0, last: 0, runsToday: 0, guessed: 0 };
    for (const c of all(model)) {
      var g = map[areaOf(c)] || map.manutenzione;
      g.cards.push(c);
      if (c.level === 'te') g.te++; else if (c.level === 'rotto') g.rotto++; else g.ok++;
      if (c.last && c.last.at > g.last) g.last = c.last.at;
      g.runsToday += c.runsToday || 0;
      if (areaGuessed(c)) g.guessed++;
    }
    var rank = { te: 0, rotto: 1 };
    return AREAS.map(function (a) {
      var g = map[a.id];
      g.cards.sort(function (x, y) { return (rank[x.level] ?? 2) - (rank[y.level] ?? 2) || x.title.localeCompare(y.title, 'it'); });
      return g;
    });
  }
  // Una parola sola sullo stato dell'area.
  function areaWord(g) {
    if (g.te) return g.te === 1 ? '1 ti aspetta' : g.te + ' ti aspettano';
    if (g.rotto) return g.rotto === 1 ? '1 rotta' : g.rotto + ' rotte';
    if (!g.cards.length) return 'niente qui';
    return 'regolare';
  }
  // Ultimi giri dell'area, dal più vecchio al più recente, uno per voce e giro (max n).
  function areaRuns(g, n) {
    var out = [];
    for (const c of g.cards) for (const h of c.history || []) out.push(h);
    out.sort(function (a, b) { return a.at - b.at; });
    return out.slice(-(n || 40));
  }
  function cardRuns(c, n) {
    var h = (c.history || []).slice().sort(function (a, b) { return a.at - b.at; });
    if (!h.length && c.last && c.last.at) h = [{ at: c.last.at, outcome: c.last.outcome }];
    return h.slice(-(n || 14));
  }

  // ---- Workflow: passi, esecutori, token ----
  var EXEC = {
    free: { name: 'Gratis', note: 'modelli gratuiti' },
    muse: { name: 'Muse', note: 'quota fissa' },
    codex: { name: 'Codex', note: 'quota ChatGPT' },
    claude: { name: 'Claude', note: 'quota Claude' },
  };
  function execName(e) { return (EXEC[e] || { name: 'Ignoto' }).name; }

  function wfTitle(name) {
    var s = String(name || '').replace(/[-_]+/g, ' ').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : 'Workflow';
  }

  // Esempio deterministico: chi farebbe cosa secondo la regola della delega (meccanico fuori da Claude, giudizio a Claude).
  function examplePhases(run) {
    var JUDGE = /verif|sintesi|verify|review|giudiz|decid/i;
    var READ = /ricerca|mappa|leggi|indagine|diagnos|raccogli|scan/i;
    return (run.phases || []).map(function (p, i) {
      var ex = JUDGE.test(p.title) ? 'claude' : READ.test(p.title) ? 'free' : (i % 2 ? 'muse' : 'codex');
      var per = ex === 'claude' ? 9000 : ex === 'free' ? 14000 : 22000;
      return { title: p.title, agents: p.total || 1, executor: ex, tokens: (p.total || 1) * per, outcome: p.failed ? 'error' : (p.done >= p.total ? 'ok' : null), failed: p.failed || 0 };
    });
  }
  // Passi veri se l'API li ha (con token), altrimenti l'esempio marcato.
  function wfPhases(run) {
    var steps = (run.steps || []).filter(function (s) { return s.tokens != null && s.executor; });
    if (!steps.length) return { example: true, phases: examplePhases(run) };
    var byEx = {};
    for (const s of steps) { var b = byEx[s.executor] || (byEx[s.executor] = { title: execName(s.executor), agents: 0, executor: s.executor, tokens: 0, outcome: 'ok', failed: 0 }); b.agents++; b.tokens += s.tokens; if (s.outcome === 'error') { b.failed++; b.outcome = 'error'; } }
    var exs = Object.keys(byEx), only = exs.length === 1 ? exs[0] : null;
    return { example: false, phases: (run.phases || []).length ? (run.phases || []).map(function (p) { return { title: p.title, agents: p.total, executor: only, tokens: null, outcome: p.failed ? 'error' : 'ok', failed: p.failed || 0 }; }) : Object.values(byEx), byExecutor: Object.values(byEx) };
  }
  // Token per esecutore e risparmio rispetto a fare tutto con Claude.
  function wfTokens(ph) {
    var tot = 0, by = { free: 0, muse: 0, codex: 0, claude: 0 };
    for (const p of ph.byExecutor || ph.phases) if (p.tokens != null && p.executor) { by[p.executor] = (by[p.executor] || 0) + p.tokens; tot += p.tokens; }
    var saved = tot - by.claude;
    return { total: tot, by: by, saved: saved, pct: tot ? Math.round(saved / tot * 100) : 0 };
  }
  // Il risparmio in due righe. Con niente delegato non mostra «0%»: dice che è tutto su Claude.
  function saveWords(t) {
    if (!t.total) return { big: '—', small: 'token non registrati' };
    if (!t.saved) return { big: tok(t.total), small: 'token, tutti su Claude: nessun passo delegato', none: true };
    return { big: t.pct + '%', small: 'dei token fuori da Claude · ' + tok(t.saved) + ' risparmiati su ' + tok(t.total) };
  }
  function tok(n) {
    if (n == null) return '—';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.', ',') + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k';
    return String(n);
  }
  function dur(ms) {
    if (ms == null) return '';
    var m = Math.round(ms / 60000);
    if (m < 1) return Math.round(ms / 1000) + ' s';
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function workflows(model) {
    var wf = model.workflows || {};
    return (wf.byName || []).map(function (w) {
      var run = (w.runs || [])[0] || {};
      return { name: w.name, title: wfTitle(w.name), runs: w.runs || [], last: run, total: w.total || (w.runs || []).length, failed: w.failed || 0 };
    }).sort(function (a, b) { return (b.last.at || 0) - (a.last.at || 0); });
  }


  // Diagramma a passi di un giro: HTML puro, ogni variante lo veste col suo CSS (classi fl-*).
  // In cima il motivo per cui il workflow esiste: quanti token non sono passati da Claude.
  function flowHtml(w, now, opts) {
    opts = opts || {};
    var run = w.last || {};
    var ph = wfPhases(run), t = wfTokens(ph);
    var h = '<div class="fl' + (ph.example ? ' fl-ex' : '') + '">';
    if (ph.example) h += '<div class="fl-flag">Esecutori e token di esempio: l’hub non li registra ancora per questo workflow.</div>';
    if (t.total) {
      var sw = saveWords(t);
      h += '<div class="fl-save"><div class="fl-save-n' + (sw.none ? ' none' : '') + '"><b>' + sw.big + '</b><span>' + sw.small + '</span></div>' +
        '<div class="fl-bar" role="img" aria-label="' + esc(['free', 'muse', 'codex', 'claude'].filter(function (k) { return t.by[k]; }).map(function (k) { return execName(k) + ' ' + tok(t.by[k]); }).join(', ')) + '">' +
        ['free', 'muse', 'codex', 'claude'].map(function (k) { return t.by[k] ? '<i class="x-' + k + '" style="flex:' + t.by[k] + '"></i>' : ''; }).join('') + '</div>' +
        '<div class="fl-leg">' + ['free', 'muse', 'codex', 'claude'].filter(function (k) { return t.by[k]; }).map(function (k) { return '<span><i class="x-' + k + '"></i>' + execName(k) + ' ' + tok(t.by[k]) + '</span>'; }).join('') + '</div></div>';
    }
    h += '<ol class="fl-steps">' + ph.phases.map(function (p, i) {
      var st = p.outcome === 'error' ? 'err' : p.outcome === 'ok' ? 'ok' : 'run';
      var meta = [];
      if (p.agents) meta.push(p.agents === 1 ? '1 agente' : p.agents + ' agenti');
      if (p.executor) meta.push('<span class="fl-ex x-' + p.executor + '">' + execName(p.executor) + '</span>');
      if (p.tokens != null) meta.push(tok(p.tokens) + ' token');
      if (p.failed) meta.push('<span class="fl-bad">' + p.failed + (p.failed === 1 ? ' fallito' : ' falliti') + '</span>');
      return '<li class="fl-n ' + st + '"><span class="fl-dot" aria-hidden="true"></span><div class="fl-b"><b>' + esc(p.title) + '</b><span>' + meta.join(' · ') + '</span></div>' +
        '<span class="fl-o">' + (st === 'ok' ? 'riuscito' : st === 'err' ? 'fallito' : 'in corso') + '</span></li>';
    }).join('') + '</ol></div>';
    return h;
  }

  function n(x) {
    return (x || 0).toLocaleString('it-IT');
  }

  root.HubV = { esc: esc, hm: hm, when: when, short: short, ago: ago, sys: sys, outcome: outcome, level: level, all: all, systems: systems, runs: runs, load: load, send: send, vote: vote, line: line, verdict: verdict, n: n, down: down, AREAS: AREAS, areaOf: areaOf, areaGuessed: areaGuessed, forYou: forYou, ifBroken: ifBroken, areas: areas, areaWord: areaWord, areaRuns: areaRuns, cardRuns: cardRuns, EXEC: EXEC, execName: execName, wfTitle: wfTitle, wfPhases: wfPhases, wfTokens: wfTokens, tok: tok, dur: dur, workflows: workflows, flowHtml: flowHtml, saveWords: saveWords };
})(globalThis);
