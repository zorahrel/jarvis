// Pagine nuove della dashboard: «Ti aspetta» (in Panoramica), Diario, Contesto. Dal dato all'HTML.
// Funzioni pure (niente rete, niente Date.now): le usano il browser e i test. Come automations-view.js: IIFE sul globale.
(function (root) {
  var TZ = 'Europe/Rome';
  function esc(s) {
    return String(s ?? '').replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function ic(name, cls) { return root.Icons ? root.Icons.svg(name, cls) : ''; }
  function parts(at) {
    var p = {};
    var f = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
    for (const x of f.formatToParts(new Date(at))) p[x.type] = x.value;
    return p;
  }
  function dayNum(at) { var p = parts(at); return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / 86400000; }
  function hm(at) { var p = parts(at); return p.hour + ':' + p.minute; }
  function dayLabel(at, now) {
    var d = dayNum(now) - dayNum(at), p = parts(at);
    if (d === 0) return 'Oggi';
    if (d === 1) return 'Ieri';
    return p.weekday.charAt(0).toUpperCase() + p.weekday.slice(1) + ' ' + p.day + '/' + p.month;
  }
  function ago(at, now) {
    var m = Math.round((now - at) / 60000);
    if (m < 1) return 'adesso';
    if (m < 60) return m + ' min fa';
    var h = Math.round(m / 60);
    if (h < 24) return h + (h === 1 ? ' ora fa' : ' ore fa');
    var g = Math.round(h / 24);
    return g + (g === 1 ? ' giorno fa' : ' giorni fa');
  }
  function num(n) { return Number(n || 0).toLocaleString('it-IT'); }
  function ktok(n) { return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? String(Math.round(n / 100) / 10).replace('.', ',') + 'k' : String(n || 0); }
  function pl(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // Stato con icona e parola, come i badge di Geist: mai solo un colore.
  var ST = {
    ok: ['circle-check', 'riuscito', 'ok'], error: ['circle-x', 'fallito', 'bad'], skipped: ['circle-dashed', 'saltato', 'warn'],
    running: ['loader-circle', 'in corso', 'run'], undelivered: ['triangle-alert', 'non consegnato', 'warn'], queued: ['circle-dot', 'in coda', 'mut'],
  };
  function stIcon(o) {
    var s = ST[o];
    if (!s) return '<span class="sti mut" aria-hidden="true">' + ic('circle-dot') + '</span>';
    return '<span class="sti ' + s[2] + '" title="' + s[1] + '">' + ic(s[0]) + '<span class="sr">' + s[1] + '</span></span>';
  }

  // Titolo di una sessione per un umano: i messaggi fra sessioni di OpenClaw arrivano come
  // «[Inter-session message] sourceSession=agent:main:discord:…», che non si mostra così.
  function humanTitle(t) {
    var s = String(t || '').trim();
    var m = /^\[Inter-session message\]\s*(.*)$/i.exec(s);
    if (m) {
      var via = /discord/i.test(m[1]) ? ' da Discord' : /whatsapp/i.test(m[1]) ? ' da WhatsApp' : /telegram/i.test(m[1]) ? ' da Telegram' : '';
      return 'Messaggio da un\'altra sessione' + via;
    }
    s = s.replace(/\b(sourceSession|sessionKey)=\S+/g, '').replace(/\bagent:[\w:-]+/g, '').replace(/\s+/g, ' ').trim();
    return s.length > 90 ? s.slice(0, 89).replace(/\s\S*$/, '') + '…' : s;
  }
  // Nome di un progetto o di una sessione per chi legge: le chiavi di OpenClaw (openclaw/cron:…, openclaw/wa:…),
  // le cartelle delle sessioni desktop (local_<uuid>) e ogni uuid diventano parole. Gli id non arrivano mai in pagina.
  var OC = { heartbeat: 'OpenClaw · battito', altro: 'OpenClaw · altro', 'whatsapp-diretta': 'WhatsApp diretto', 'eventi-di-sistema': 'OpenClaw · eventi di sistema',
    interattivo: 'OpenClaw · sessioni interattive', 'test-e-prove': 'OpenClaw · test e prove', 'riprese-sessione': 'OpenClaw · riprese di sessione', 'passaggi-da-altri-agenti': 'OpenClaw · passaggi da altri agenti' };
  var ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|@g\.us|@s\.whatsapp|<<<[^>]*>>>/i;
  function humanProject(n) {
    var s = String(n || '');
    if (/^local_[0-9a-f-]{8,}/i.test(s)) return 'Sessione di Claude desktop';
    if (/^wf_[0-9a-f-]{6,}/i.test(s)) return 'Giri di workflow';
    if (/^_sys_[0-9a-f]{6,}$/i.test(s)) return 'Cartella di sistema';
    var m = /^openclaw\/([a-z-]+)(?::(.*))?$/.exec(s);
    if (m) {
      var k = m[1], v = (m[2] || '').trim(), bad = !v || ID.test(v) || /^[0-9a-f]{8}$/i.test(v);
      if (OC[k] && !m[2]) return OC[k];
      if (k === 'cron') return bad || v === 'automazione senza nome' ? 'Automazione OpenClaw senza nome' : 'Automazione: ' + v.replace(/[-_]+/g, ' ');
      if (k === 'sub') return bad || v === 'senza-etichetta' ? 'Sottoagente OpenClaw senza etichetta' : 'Sottoagente: ' + v;
      if (k === 'wa') return bad || /^whatsapp:g-/.test(v) ? 'Gruppo WhatsApp' + (/^whatsapp:g-/.test(v) && !ID.test(v) ? ': ' + v.slice(11).replace(/-/g, ' ') : '') : 'WhatsApp: ' + v;
      if (k === 'discord') return 'Discord ' + (bad ? 'senza canale' : v);
      if (k === 'lavoro') return 'Lavoro OpenClaw: ' + v;
      return 'OpenClaw · ' + k.replace(/-/g, ' ') + (v && !bad ? ': ' + v : '');
    }
    return s.replace(ID, '').trim() || 'senza nome';
  }
  // Sessioni (proxy VDM): la cartella diventa un nome umano, i messaggi perdono canali, gruppi e marcatori interni.
  var noIds = function (t) { return (root.AutomationsView || {}).noIds ? root.AutomationsView.noIds(t) : String(t == null ? '' : t); };
  function sessionPlace(x) {
    if (x.repo) return noIds(humanProject(x.repo) + (x.branch ? '/' + x.branch : ''));
    if (!x.cwd) return '?';
    var base = String(x.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    return humanProject(base);
  }
  function sessionText(t) { return noIds(t); }
  // Consumo di una sessione: token letti dai suoi log e, dove l'hub la sa, la quota della settimana che pesa.
  function tokWords(n) {
    if (!(n > 0)) return '';
    if (n >= 1e6) return String(Math.round(n / 1e5) / 10).replace('.', ',').replace(/,0$/, '') + ' M token';
    if (n >= 1e3) return Math.round(n / 1e3) + ' k token';
    return n + ' token';
  }
  function useWords(u) {
    if (!u) return '';
    var t = tokWords(u.tokens);
    var p = u.pct > 0 ? (u.pct < 0.1 ? 'meno dello 0,1%' : String(Math.round(u.pct * 10) / 10).replace('.', ',') + '%') + ' della settimana' : '';
    return [t, p].filter(Boolean).join(', ');
  }

  // «Scrivi a Jarvis»: WhatsApp (o Discord) con il messaggio già scritto. Senza link in config, niente bottone.
  function jarvisHref(cfg, text) {
    var j = (cfg && cfg.jarvis) || {};
    if (j.whatsapp) return j.whatsapp + (j.whatsapp.indexOf('?') === -1 ? '?' : '&') + 'text=' + encodeURIComponent(text);
    return j.discord || null;
  }
  function jarvisBtn(cfg, text) {
    var h = jarvisHref(cfg, text);
    return h ? '<a class="btn" href="' + esc(h) + '" target="_blank" rel="noopener">' + ic('message-circle') + 'Scrivi a Jarvis</a>' : '';
  }

  // ---- Ti aspetta ----
  var TIPO = {
    decisione: ['split', 'Decisione'], spesa: ['euro', 'Spesa'], pubblico: ['megaphone', 'Va in pubblico'], vista: ['eye', 'Ok a vista'],
  };
  function attesaCard(it, cfg, now) {
    var t = TIPO[it.tipo] || TIPO.decisione;
    var open = it.link ? '<a class="btn pri" href="' + esc(it.link) + '"' + (/^https?:/.test(it.link) ? ' target="_blank" rel="noopener"' : '') + '>Apri</a>' : '';
    return '<article class="tile wait">' +
      '<div class="tile-h"><span class="tag t-' + esc(it.tipo) + '">' + ic(t[0]) + esc(t[1]) + '</span><span class="when">' + esc(ago(it.at, now)) + '</span></div>' +
      '<h3 class="tile-t">' + esc(it.title) + '</h3>' +
      (it.why ? '<p class="tile-p">' + esc(it.why) + '</p>' : '') +
      '<div class="tile-a">' + open + (it.auto ? '' : '<button class="btn" data-wait-done="' + esc(it.id) + '">' + ic('check') + 'Fatto</button>') + jarvisBtn(cfg, 'Su «' + it.title + '»: ') + '</div>' +
      (it.from ? '<p class="tile-f">da ' + esc(it.from) + '</p>' : '') + '</article>';
  }
  function attesaHtml(data, cfg, now) {
    var items = (data && data.items) || [];
    var head = '<div class="sec-h"><h2>Ti aspetta</h2>' + (items.length ? '<span class="count">' + items.length + '</span>' : '') + '</div>';
    if (!data) return '<section class="sec" data-sec="wait">' + head + '<div class="tile calm"><p class="tile-p">Non riesco a leggere le voci in attesa: l\'hub non risponde.</p></div></section>';
    if (!items.length) {
      return '<section class="sec" data-sec="wait">' + head + '<div class="tile calm"><span class="calm-ic">' + ic('circle-check') + '</span><div><h3 class="tile-t">Niente ti aspetta</h3>' +
        '<p class="tile-p">Qui compare solo ciò che tocca a te: una decisione, una spesa, qualcosa che va in pubblico, un ok a vista. Il resto lo sistemano gli agenti.</p></div></div></section>';
    }
    return '<section class="sec" data-sec="wait">' + head + '<div class="tiles">' + items.map(function (it) { return attesaCard(it, cfg, now); }).join('') + '</div></section>';
  }

  // ---- Diario ----
  var KINDS = [['all', 'Tutto'], ['auto', 'Automazioni'], ['agente', 'Agenti'], ['workflow', 'Workflow'], ['tu', 'Tu'], ['app', 'Computer e app'], ['pb', 'Problemi']];
  function jMatch(e, ui) {
    var f = ui.f || 'all';
    if (f === 'pb' && (e.kind === 'app' || (e.outcome !== 'error' && e.outcome !== 'undelivered'))) return false;
    if (f !== 'all' && f !== 'pb' && e.kind !== f) return false;
    var q = (ui.q || '').trim().toLowerCase();
    return !q || [e.title, e.what, e.who].join(' ').toLowerCase().indexOf(q) !== -1;
  }
  function jRow(e) {
    var inner = '<span class="jt">' + esc(hm(e.at)) + '</span>' + stIcon(e.outcome) +
      '<span class="jb"><span class="jtt">' + esc(e.title) + '</span><span class="jm">' + esc(e.who) + (e.what ? ' · ' + esc(e.what) : '') + '</span></span>' +
      (e.link ? '<span class="jgo" aria-hidden="true">' + ic('chevron-right') + '</span>' : '');
    return e.link ? '<a class="jr" href="' + esc(e.link) + '">' + inner + '</a>' : '<div class="jr">' + inner + '</div>';
  }
  function journalHtml(data, ui, now) {
    ui = ui || {};
    if (!data) return '<div class="tile calm"><p class="tile-p">Non riesco a leggere il diario: l\'hub non risponde.</p></div>';
    var all = data.items || [];
    var items = all.filter(function (e) { return jMatch(e, ui); });
    var cnt = function (k) { return all.filter(function (e) { return k === 'all' ? true : k === 'pb' ? (e.kind !== 'app' && (e.outcome === 'error' || e.outcome === 'undelivered')) : e.kind === k; }).length; };
    var tools = '<div class="tools"><div class="seg" role="group" aria-label="Filtro">' + KINDS.map(function (k) {
      return '<button data-j-f="' + k[0] + '" aria-pressed="' + ((ui.f || 'all') === k[0]) + '">' + k[1] + '<b>' + cnt(k[0]) + '</b></button>';
    }).join('') + '</div><label class="q">' + ic('search', 'qi') + '<span class="sr">Cerca nel diario</span><input type="search" data-j-q placeholder="Cerca: brief, Codex, fallito…" value="' + esc(ui.q || '') + '" autocomplete="off"></label></div>';
    var body = '';
    if (!items.length) {
      body = '<div class="tile calm"><p class="tile-p">' + (all.length ? 'Nessun evento con questo filtro. <button class="btn" data-j-clear="1">Togli il filtro</button>' : 'Negli ultimi ' + (data.days || 7) + ' giorni non risulta nessun giro.') + '</p></div>';
    } else {
      var groups = [], cur = null;
      for (const e of items) {
        var d = dayLabel(e.at, now);
        if (!cur || cur.d !== d) { cur = { d: d, rows: [] }; groups.push(cur); }
        cur.rows.push(e);
      }
      body = groups.map(function (g) {
        var bad = g.rows.filter(function (e) { return e.outcome === 'error'; }).length;
        return '<section class="jday"><h2 class="jd">' + esc(g.d) + '<span>' + g.rows.length + (g.rows.length === 1 ? ' evento' : ' eventi') + (bad ? ', <em>' + bad + (bad === 1 ? ' fallito' : ' falliti') + '</em>' : '') + '</span></h2><div class="list">' + g.rows.map(function (e) { return jRow(e); }).join('') + '</div></section>';
      }).join('');
    }
    return '<p class="lead">Cosa hanno fatto automazioni, workflow e agenti negli ultimi ' + (data.days || 7) + ' giorni, il più recente in cima. Un clic apre il dettaglio.</p>' + tools + body;
  }

  // ---- Contesto ----
  var GROUP_ORDER = ['Claude Code', 'Codex e jcode', 'OpenClaw'];
  function dateIt(ms) { var p = parts(ms); return p.day + '/' + p.month + '/' + p.year; }
  function contextHtml(r) {
    if (!r) return '<div class="tile calm"><p class="tile-p">Non riesco a leggere i file di contesto.</p></div>';
    var now = r.at;
    var files = r.files || [];
    var byId = {};
    for (const f of files) byId[f.id] = f;
    var name = function (id) { return byId[id] ? byId[id].label : id; };
    var loaders = Object.entries((r.totals && r.totals.byLoader) || {}).sort(function (a, b) { return b[1] - a[1]; });
    var doc = r.doctor || {};
    var dupN = (r.duplicates || []).length, oldN = (r.oldRules || []).length, contra = r.contradictions || {};
    var conN = (contra.items || []).length;
    // In cima: quanto pesa ogni harness, e il verdetto dei controlli.
    var top = '<div class="tiles stats">' + loaders.slice(0, 4).map(function (l) {
      return '<div class="tile stat"><span class="stat-n">' + ktok(l[1]) + '</span><span class="stat-l">token a sessione · ' + esc(l[0]) + '</span></div>';
    }).join('') + '</div>';
    var checks = '<div class="tiles">' +
      '<div class="tile chk ' + (doc.pending ? 'mut' : doc.ok ? 'ok' : 'bad') + '"><span class="chk-ic">' + ic(doc.pending ? 'loader-circle' : doc.ok ? 'circle-check' : 'circle-x') + '</span><div><h3 class="tile-t">agents-doctor ' + (doc.pending ? 'in corso' : doc.ok ? 'verde' : 'rosso') + '</h3><p class="tile-p">' +
        (doc.pending ? 'il risultato compare qui da solo' : doc.error ? esc(doc.error) : pl((doc.checks || []).length, 'controllo', 'controlli') + ', ' + pl((doc.checks || []).filter(function (c) { return !c.ok; }).length, 'fallito', 'falliti')) + '</p></div></div>' +
      '<div class="tile chk ' + (dupN ? 'warn' : 'ok') + '"><span class="chk-ic">' + ic(dupN ? 'triangle-alert' : 'circle-check') + '</span><div><h3 class="tile-t">' + (dupN ? pl(dupN, 'riga doppia', 'righe doppie') : 'Nessun doppione') + '</h3><p class="tile-p">la stessa regola in due file si paga due volte</p></div></div>' +
      '<div class="tile chk ' + (oldN ? 'warn' : 'ok') + '"><span class="chk-ic">' + ic(oldN ? 'clock' : 'circle-check') + '</span><div><h3 class="tile-t">' + (oldN ? pl(oldN, 'regola con una data vecchia', 'regole con date vecchie') : 'Nessuna data vecchia') + '</h3><p class="tile-p">più di 45 giorni: da riverificare</p></div></div>' +
      '<div class="tile chk ' + (contra.at ? (conN ? 'bad' : 'ok') : 'mut') + '"><span class="chk-ic">' + ic(contra.at ? (conN ? 'split' : 'circle-check') : 'circle-dashed') + '</span><div><h3 class="tile-t">' +
        (contra.running ? 'Controllo in corso…' : contra.at ? (conN ? pl(conN, 'contraddizione', 'contraddizioni') : 'Nessuna contraddizione') : 'Contraddizioni mai controllate') + '</h3><p class="tile-p">' +
        (contra.at ? 'letto da un agente il ' + dateIt(contra.at) : 'le legge un agente, su richiesta') + '</p><button class="btn" data-ctx-check="1"' + (contra.running ? ' disabled' : '') + '>' + ic('refresh-cw') + (contra.at ? 'Ricontrolla' : 'Controlla adesso') + '</button></div></div></div>';
    // I file, per chi li carica.
    var groups = GROUP_ORDER.concat(files.map(function (f) { return f.group; }).filter(function (g, i, a) { return GROUP_ORDER.indexOf(g) === -1 && a.indexOf(g) === i; }));
    var fileRow = function (f) {
      var days = Math.floor((now - f.mtime) / 86400000);
      return '<div class="fr"><span class="fb"><span class="ft">' + esc(f.label) + '</span><span class="fp">' + esc(f.path) + (f.note ? ' · ' + esc(f.note) : '') + '</span></span>' +
        '<span class="fl">' + (f.loaders || []).map(function (l) { return '<span class="chip">' + esc(l) + '</span>'; }).join('') + '</span>' +
        '<span class="fn" title="' + num(f.chars) + ' caratteri">' + ktok(f.tokens) + '</span><span class="fd' + (days > 60 ? ' old' : '') + '" title="ultima modifica">' + (days < 1 ? 'oggi' : days === 1 ? 'ieri' : days + ' g fa') + '</span></div>';
    };
    var lists = groups.map(function (g) {
      var fs = files.filter(function (f) { return f.group === g; });
      if (!fs.length) return '';
      var tot = fs.reduce(function (a, f) { return a + (f.tokens || 0); }, 0);
      return '<section class="tile flist"><div class="tile-h"><h3 class="tile-t">' + esc(g) + '</h3><span class="when">' + fs.length + ' file · ' + ktok(tot) + ' token</span></div>' +
        '<div class="list"><div class="fr fhd" aria-hidden="true"><span>File</span><span>Chi lo carica</span><span class="fn">Token</span><span class="fd">Modifica</span></div>' + fs.map(fileRow).join('') + '</div></section>';
    }).join('');
    var sk = r.skills || {};
    var skills = '<section class="tile flist"><div class="tile-h"><h3 class="tile-t">Skill nel listing</h3><span class="when">' + (sk.count || 0) + ' skill · ' + ktok(sk.tokens || 0) + ' token</span></div>' +
      '<p class="tile-p">Ogni harness elenca nome e descrizione (tagliata a 180 caratteri) di ogni skill: ' + esc((sk.loaders || []).join(', ')) + '.</p>' +
      ((sk.items || []).length ? '<details class="more"><summary>' + ic('chevron-right', 'chev') + (sk.items.length === 1 ? 'La skill' : 'Le ' + sk.items.length + ' skill, dalla più pesante') + '</summary><div class="list">' +
        sk.items.slice().sort(function (a, b) { return b.tokens - a.tokens; }).map(function (s) { return '<div class="fr sk"><span class="fb"><span class="ft">' + esc(s.name) + '</span></span><span class="fn">' + num(s.tokens) + '</span></div>'; }).join('') + '</div></details>' : '') + '</section>';
    // Problemi trovati: doppioni, contraddizioni, date vecchie.
    var dup = dupN ? '<section class="tile"><div class="tile-h"><h3 class="tile-t">Righe doppie</h3><span class="when">' + dupN + '</span></div><div class="list">' + r.duplicates.map(function (d) {
      return '<div class="pr"><p class="pq">' + esc(d.text) + '</p><p class="pm">in ' + d.files.map(name).map(esc).join(', ') + '</p></div>';
    }).join('') + '</div></section>' : '';
    var con = conN ? '<section class="tile"><div class="tile-h"><h3 class="tile-t">Contraddizioni</h3><span class="when">' + conN + '</span></div><div class="list">' + contra.items.map(function (c) {
      return '<div class="pr"><p class="pq">' + esc((c.a || {}).text) + '</p><p class="pm">' + esc((c.a || {}).file) + '</p><p class="pq vs">' + esc((c.b || {}).text) + '</p><p class="pm">' + esc((c.b || {}).file) + '</p><p class="pw">' + esc(c.why) + '</p></div>';
    }).join('') + '</div></section>' : '';
    var old = oldN ? '<section class="tile"><div class="tile-h"><h3 class="tile-t">Regole con date vecchie</h3><span class="when">' + oldN + '</span></div><div class="list">' + r.oldRules.map(function (o) {
      return '<div class="pr"><p class="pq">' + esc(o.text) + '</p><p class="pm">' + esc(name(o.file)) + ', riga ' + o.line + ' · ' + o.days + ' giorni</p></div>';
    }).join('') + '</div></section>' : '';
    var failed = (doc.checks || []).filter(function (c) { return !c.ok; });
    var docBox = failed.length ? '<section class="tile"><div class="tile-h"><h3 class="tile-t">Cosa dice agents-doctor</h3></div><div class="list">' + failed.map(function (c) { return '<div class="pr"><p class="pq bad">' + esc(c.text) + '</p></div>'; }).join('') + '</div></section>' : '';
    return '<p class="lead">Cosa leggono gli agenti a ogni sessione: istruzioni, memoria, stile, skill. Sola lettura; i token sono una stima (caratteri ÷ 4).</p>' +
      top + checks + docBox + con + '<div class="stack">' + lists + skills + '</div>' + dup + old;
  }

  var api = { humanTitle: humanTitle, humanProject: humanProject, sessionPlace: sessionPlace, sessionText: sessionText, useWords: useWords, tokWords: tokWords, attesaHtml: attesaHtml, journalHtml: journalHtml, contextHtml: contextHtml, jarvisHref: jarvisHref, jarvisBtn: jarvisBtn, stIcon: stIcon, dayLabel: dayLabel };
  root.PagesView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
