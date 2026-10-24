// Usato da scripts/ui-bar.py: controlli sul disegno della pagina, iniettati e misurati nel DOM vero.
(function () {
  const vis = (e) => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const sel = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
  const txt = (e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);

  // Ogni numero di una tabella dice di quale provider è: o la sua etichetta .pv è visibile, o la colonna ha
  // un'intestazione visibile con un nome scritto E il provider è nominato nell'intestazione della tabella o nella riga.
  // Il logo da solo non basta («% sett.» passava), e nemmeno il titolo della card.
  const PROV = /\b(claude|codex|muse|gemini|openai|chatgpt|copilot|grok|kimi|glm)\b/i;
  const tabs = '#t-overview, #t-projects, #t-usage';
  // testo che si vede: senza le etichette solo per lettori di schermo (un «Claude» nascosto non dice niente a chi guarda)
  const seen = (e) => { const c = e.cloneNode(true); c.querySelectorAll('.sr, .au-sr, [hidden]').forEach((x) => x.remove()); c.querySelectorAll('*').forEach((x) => x.append(' ')); return c.textContent.replace(/\s+/g, ' ').trim(); };
  window.__provLabels = function (root) {
    const out = [];
    for (const t of (root || document).querySelectorAll(tabs.split(', ').map((x) => x + '.on table:not(.svc)').join(', '))) {
      if (!vis(t)) continue;
      const ths = [...t.querySelectorAll('thead th')], headTxt = ths.map(seen).join(' ');
      for (const tr of t.querySelectorAll('tbody tr')) {
        [...tr.children].forEach((td, i) => {
          if (!td.matches('td.num') || !vis(td)) return;
          const pv = td.querySelector('.pv');
          if (pv && vis(pv) && PROV.test(pv.innerText)) return;
          const th = ths[i];
          if (th && vis(th) && /[a-zà-ù]{3,}/i.test(seen(th)) && (PROV.test(headTxt) || PROV.test(seen(tr)))) return;
          out.push((t.className || 'tabella') + ' in ' + (t.closest('details.card, section') ? txt(t.closest('details.card, section').querySelector('summary, h2, h3') || t) : '?') + ': «' + txt(td) + '» senza provider');
        });
      }
      // un'intestazione vuota (axe empty-table-header) non dice cosa c'è nella colonna
      for (const th of ths) if (vis(th) && !(th.textContent || '').trim()) out.push((t.className || 'tabella') + ': intestazione vuota');
    }
    for (const g of (root || document).querySelectorAll('#t-usage.on .trl')) {
      if (!vis(g) || !g.querySelector('details.tr')) continue;
      const h = g.querySelector('.trh');
      if (!h || !vis(h)) { out.push('griglia ' + txt(g.closest('details.card, section').querySelector('summary, h2, h3') || g) + ': senza intestazione'); continue; }
      if (!PROV.test(seen(h))) out.push('griglia ' + txt(g.closest('details.card, section').querySelector('summary, h2, h3') || g) + ': intestazione senza provider visibile');
    }
    return out.slice(0, 8);
  };

  // Una colonna chiamata «Quota» è la quota della settimana: deve dire lo stesso numero di /api/pace per quell'account.
  // Chiamare «Quota» la parte dei token del proxy faceva leggere 47% un account esaurito (giro 8).
  window.__usageQuota = function (pace) {
    const out = [];
    for (const t of document.querySelectorAll('#t-usage.on table')) {
      const ths = [...t.querySelectorAll('thead th')], qi = ths.findIndex((h) => /quota/i.test(seen(h)));
      if (qi < 0) continue;
      for (const tr of t.querySelectorAll('tbody tr')) {
        const name = seen(tr.children[0]), got = seen(tr.children[qi]);
        const r = pace.find((x) => x.provider === 'claude' && x.account === name);
        const want = r && r.used != null ? r.used + '%' : '–';
        if (got !== want) out.push(name + ': «' + got + '» invece di «' + want + '» (pace)');
      }
    }
    return out.slice(0, 6);
  };

  // Ogni campo ha un nome vero: aria-label, aria-labelledby, <label for> o un <label> che lo contiene con del testo.
  // Il placeholder non conta: axe lo accetta, ma WebKit legge il campo come «spinbutton» senza nome (giro 8).
  window.__names = function () {
    const out = [];
    for (const e of document.querySelectorAll('.tab.on input:not([type=hidden]), .tab.on select, .tab.on textarea, .cx-panel input:not([type=hidden]), .cx-panel select')) {
      if (e.closest('[hidden]')) continue;
      const lab = e.getAttribute('aria-label') || (e.getAttribute('aria-labelledby') || '').split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ')
        || (e.id && [...document.querySelectorAll('label[for="' + e.id + '"]')].map((l) => l.textContent).join(' ')) || (e.closest('label') ? e.closest('label').textContent : '');
      if (!String(lab).trim()) out.push(sel(e) + (e.dataset.k ? '[data-k=' + e.dataset.k + ']' : '') + ' senza nome');
    }
    return out.slice(0, 8);
  };

  // Niente esce dalla sua card: ogni elemento visibile sta dentro la section/card che lo contiene, celle e non
  // (in Progetti un nome di cartella lungo senza spazi usciva da un div). Esenti i contenitori che scorrono.
  window.__contained = function () {
    const out = [];
    const scrolls = (e, box) => { for (let p = e.parentElement; p && p !== box; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; return false; };
    for (const e of document.querySelectorAll('.tab.on section *, .tab.on .card *')) {
      if (!vis(e) || e.closest('.sr, .au-sr, [hidden]')) continue;
      const box = e.closest('section, .card'); if (!box || scrolls(e, box)) continue;
      const b = box.getBoundingClientRect(), r = e.getBoundingClientRect();
      if (r.right > b.right + 1 || r.left < b.left - 1) out.push(sel(e) + ' «' + txt(e) + '» ' + Math.round(r.left) + '-' + Math.round(r.right) + ' fuori da ' + Math.round(b.left) + '-' + Math.round(b.right));
    }
    return out.slice(0, 6);
  };

  // Comandi di almeno `min`×`min` px (WCAG 2.5.5): logo, nav, comandi della tab e del pannello. I link dentro una
  // frase sono esenti (2.5.8): conta solo ciò che non è inline. Prima si guardava solo l'altezza dei bottoni dell'header.
  window.__taps = function (min, scope) {
    const out = [];
    for (const e of (scope ? [...document.querySelectorAll(scope)].flatMap((r) => [...r.querySelectorAll('button, a[href], summary, select, input:not([type=hidden]), [role=button]')]) : document.querySelectorAll('header a[href], header button, .tab.on button, .tab.on select, .tab.on input:not([type=hidden]), .tab.on summary, .tab.on a[href], .tab.on [role=button], .cx-panel button, .cx-panel a[href], .cx-panel summary'))) {
      if (!vis(e) || e.closest('[hidden], .sr, .au-sr')) continue;
      const cs = getComputedStyle(e);
      if (e.tagName === 'A' && cs.display === 'inline') continue;
      if (e.type === 'checkbox' || e.type === 'radio') { const l = e.closest('label, .sw'); if (l && l.getBoundingClientRect().height >= min) continue; }
      const r = e.getBoundingClientRect();
      if (r.height < min - 0.5 || r.width < min - 0.5) out.push(sel(e) + ' «' + txt(e) + '» ' + Math.round(r.width) + '×' + Math.round(r.height) + 'px');
    }
    return out;
  };

  // Il badge di «Ti aspetta» sta dentro il suo bottone della nav.
  window.__badge = function () {
    const b = document.getElementById('nwait'); if (!b || !vis(b)) return ['badge non visibile'];
    const r = b.getBoundingClientRect(), btn = b.closest('button'), q = btn.getBoundingClientRect();
    const out = r.left >= q.left - 0.5 && r.right <= q.right + 0.5 && r.top >= q.top - 0.5 && r.bottom <= q.bottom + 0.5 ? []
      : ['badge ' + [r.left, r.right, r.top, r.bottom].map(Math.round).join(',') + ' fuori dal bottone ' + [q.left, q.right, q.top, q.bottom].map(Math.round).join(',')];
    // e non tocca l'etichetta («Panoramica»): almeno 2 px d'aria fra le due
    const lab = [...btn.children].find((c) => c.tagName === 'SPAN' && c !== b);
    if (lab) { const l = lab.getBoundingClientRect(); if (l.right > r.left - 2 && l.top < r.bottom && l.bottom > r.top) out.push('badge attaccato all\'etichetta (' + Math.round(r.left - l.right) + ' px)'); }
    return out;
  };

  // Un comando si clicca davvero: al suo centro c'è lui, non qualcosa sopra (la fascia della demo copriva «Chiudi»).
  window.__onTop = function (selector) {
    const e = document.querySelector(selector); if (!e) return [selector + ' assente'];
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [] : [selector + ' coperto da ' + (hit ? sel(hit) : 'niente')];
  };
  // Un link dentro una frase si distingue dal testo intorno: sottolineato, o almeno 3:1 di contrasto (WCAG 1.4.1).
  // axe lo segna solo se è sicuro; qui si misura sempre («apri» delle righe agente era 2,1:1 in scuro).
  const rgb = (c) => { const n = (c.match(/[\d.]+/g) || []).map(Number); return /^color\(/.test(c) ? n.slice(0, 3).map((v) => v * 255) : n.slice(0, 3); };
  const lum = (c) => { const [r, g, b] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  window.__inlineLinks = function () {
    const out = [];
    for (const a of document.querySelectorAll('.tab.on a[href]')) {
      if (!vis(a)) continue;
      const cs = getComputedStyle(a); if (cs.display !== 'inline') continue;
      const p = a.parentElement; if (![...p.childNodes].some((n) => n !== a && (n.textContent || '').trim())) continue;
      if (/underline/.test(cs.textDecorationLine)) continue;
      const r = ratio(cs.color, getComputedStyle(p).color);
      if (r < 3) out.push(sel(p) + ' > a «' + txt(a) + '» senza sottolineatura, ' + r.toFixed(2) + ':1 col testo');
    }
    return out.slice(0, 6);
  };

  // La fascia ESEMPIO della demo: c'è, è in cima allo schermo e nessuno la copre (anche dopo aver scorso e col
  // pannello aperto). Senza fascia la demo sembrerebbe l'hub vero.
  window.__band = function () {
    const b = document.querySelector('.demo-band'); if (!b) return ['fascia assente'];
    if (!vis(b)) return ['fascia invisibile'];
    const r = b.getBoundingClientRect();
    if (r.top < -0.5 || r.bottom > innerHeight || r.top > 1) return ['fascia fuori schermo (top ' + Math.round(r.top) + ')'];
    const hit = document.elementFromPoint(Math.min(innerWidth - 2, r.left + r.width / 2), r.top + r.height / 2);
    return hit && (hit === b || b.contains(hit)) ? [] : ['fascia coperta da ' + (hit ? sel(hit) : 'niente')];
  };

  // Testo interno arrivato in pagina: messaggi di servizio di OpenClaw, orari fra parentesi, nomi mcp__, percorsi
  // assoluti, cartelle con un id. Legge il testo visibile della tab attiva con i <details> aperti.
  window.__internal = () => {
    const t = (document.querySelector('.tab.on') || document.body).innerText;
    const re = /(?:^|\n)\s*(?:I(?:'m|'ve| am| appreciate| need| cannot| can't| can )|You(?:'re|'ve)? |Could you|If you)|Strumento di|\bexec: |ESITO:|resumed (?:this |the )?(?:CLI )?session|Anthropic|\/private\/|\/tmp\/|\/var\/folders|-Users-|Application Support|I acknowledge|inter-session|routing data|\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2}|GMT[+-]\d|mcp__\w|\/Users\/|\/home\/|local_[0-9a-f]{8}|_sys_[0-9a-f]{6}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/g;
    return [...new Set(t.match(re) || [])].map((m) => { const i = t.indexOf(m); return m + ' in «' + t.slice(Math.max(0, i - 25), i + m.length + 25).replace(/\s+/g, ' ') + '»'; });
  };
  // Ogni tabella con più di una riga dice cosa c'è nelle colonne: <thead> con un <th> che ha testo per colonna.
  window.__tableHeads = () => [...document.querySelectorAll('.tab.on table')].filter((tb) => tb.rows.length > 1 && tb.offsetParent).filter((tb) => {
    const h = tb.tHead && tb.tHead.rows[0];
    return !h || [...h.cells].some((c) => c.tagName !== 'TH' || !c.textContent.trim());
  }).map((tb) => sel(tb) + ' «' + (tb.closest('section,.card') || tb).innerText.split('\n')[0].slice(0, 30) + '»');
})();
