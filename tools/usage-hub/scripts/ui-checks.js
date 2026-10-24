// Usato da scripts/ui-bar.py: controlli sul disegno della pagina, iniettati e misurati nel DOM vero.
(function () {
  const vis = (e) => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
  const sel = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.classList.length ? '.' + [...e.classList].slice(0, 2).join('.') : '');
  const txt = (e) => (e.innerText || e.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40);

  // Ogni numero di una tabella di consumi dice di quale provider è: o la sua etichetta .pv è visibile,
  // o l'intestazione della sua colonna è visibile e ha un nome scritto (non solo il logo).
  window.__provLabels = function (root) {
    const out = [];
    for (const t of (root || document).querySelectorAll('.tab.on table.proj:not(.svc), .tab.on table.share')) {
      if (!vis(t)) continue;
      const ths = [...t.querySelectorAll('thead th')];
      for (const tr of t.querySelectorAll('tbody tr')) {
        [...tr.children].forEach((td, i) => {
          if (!td.matches('td.num') || !vis(td)) return;
          const pv = td.querySelector('.pv');
          if (pv && vis(pv) && pv.innerText.trim()) return;
          const th = ths[i];
          if (th && vis(th) && /[a-zà-ù]{3,}/i.test(th.innerText)) return;
          out.push((t.className || 'table') + ': «' + txt(td) + '» senza provider');
        });
      }
    }
    return out.slice(0, 8);
  };

  // Niente esce dalla sua card: ogni cella sta dentro la section/card che la contiene (i «Altri N» vanno aperti prima).
  window.__contained = function () {
    const out = [];
    for (const td of document.querySelectorAll('.tab.on td, .tab.on th')) {
      if (!vis(td)) continue;
      const box = td.closest('section, .card'); if (!box) continue;
      const b = box.getBoundingClientRect(), r = td.getBoundingClientRect();
      if (r.right > b.right + 1 || r.left < b.left - 1) out.push(sel(td) + ' «' + txt(td) + '» ' + Math.round(r.left) + '-' + Math.round(r.right) + ' fuori da ' + Math.round(b.left) + '-' + Math.round(b.right));
    }
    return out.slice(0, 6);
  };

  // Comandi alti almeno `min` px. I link dentro una frase sono esenti (WCAG 2.5.8): conta solo ciò che non è inline.
  window.__taps = function (min) {
    const out = [];
    for (const e of document.querySelectorAll('header button, .tab.on button, .tab.on select, .tab.on input:not([type=hidden]), .tab.on summary, .tab.on a[href], .tab.on [role=button]')) {
      if (!vis(e) || e.closest('[hidden], .sr, .au-sr')) continue;
      const cs = getComputedStyle(e);
      if (e.tagName === 'A' && cs.display === 'inline') continue;
      if (e.type === 'checkbox' || e.type === 'radio') { const l = e.closest('label, .sw'); if (l && l.getBoundingClientRect().height >= min) continue; }
      const r = e.getBoundingClientRect();
      if (r.height < min - 0.5) out.push(sel(e) + ' «' + txt(e) + '» ' + Math.round(r.height) + 'px');
    }
    return out;
  };

  // Il badge di «Ti aspetta» sta dentro il suo bottone della nav.
  window.__badge = function () {
    const b = document.getElementById('nwait'); if (!b || !vis(b)) return ['badge non visibile'];
    const r = b.getBoundingClientRect(), q = b.closest('button').getBoundingClientRect();
    return r.left >= q.left - 0.5 && r.right <= q.right + 0.5 && r.top >= q.top - 0.5 && r.bottom <= q.bottom + 0.5 ? []
      : ['badge ' + [r.left, r.right, r.top, r.bottom].map(Math.round).join(',') + ' fuori dal bottone ' + [q.left, q.right, q.top, q.bottom].map(Math.round).join(',')];
  };

  // Un comando si clicca davvero: al suo centro c'è lui, non qualcosa sopra (la fascia della demo copriva «Chiudi»).
  window.__onTop = function (selector) {
    const e = document.querySelector(selector); if (!e) return [selector + ' assente'];
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2, hit = document.elementFromPoint(x, y);
    return hit && (hit === e || e.contains(hit)) ? [] : [selector + ' coperto da ' + (hit ? sel(hit) : 'niente')];
  };
})();
