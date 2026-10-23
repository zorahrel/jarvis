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

  function n(x) {
    return (x || 0).toLocaleString('it-IT');
  }

  root.HubV = { esc: esc, hm: hm, when: when, short: short, ago: ago, sys: sys, outcome: outcome, level: level, all: all, systems: systems, runs: runs, load: load, send: send, vote: vote, line: line, verdict: verdict, n: n, down: down };
})(globalThis);
