// Usato da scripts/ui-bar.py: iniettato nella pagina, `__clip()` elenca i testi nascosti.
// Trova testo nascosto: elementi che tagliano (overflow hidden/clip, ellipsis, line-clamp) e il cui contenuto eccede.
window.__clip = function (root) {
  const out = [];
  const sel = (e) => { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; if (e.classList.length) s += '.' + [...e.classList].slice(0, 2).join('.'); const p = e.parentElement; return (p && p.classList.length ? '.' + p.classList[0] + '>' : '') + s; };
  for (const e of (root || document.body).querySelectorAll('*')) {
    if (e.closest('.sr,.au-sr,svg,script,style,[hidden]')) continue;
    const cs = getComputedStyle(e);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const clipX = /hidden|clip/.test(cs.overflowX) || cs.textOverflow === 'ellipsis';
    const clipY = /hidden|clip/.test(cs.overflowY) || cs.webkitLineClamp !== 'none' && cs.webkitLineClamp;
    const scrollX = /auto|scroll/.test(cs.overflowX), scrollY = /auto|scroll/.test(cs.overflowY);
    const ox = e.scrollWidth > e.clientWidth + 1, oy = e.scrollHeight > e.clientHeight + 1;
    const txt = (e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 70);
    if (!txt && !e.children.length) continue;
    if ((clipX && ox) || (clipY && oy)) out.push({ k: 'clip', s: sel(e), t: txt, w: [e.clientWidth, e.scrollWidth], h: [e.clientHeight, e.scrollHeight] });
    // scroll orizzontale non voluto (pre e logbox scorrono apposta)
    else if (scrollX && ox && !/^(PRE|TEXTAREA)$/.test(e.tagName) && !e.classList.contains('logbox')) out.push({ k: 'hscroll', s: sel(e), t: txt, w: [e.clientWidth, e.scrollWidth] });
    // fuori dallo schermo a destra
    if (r.right > innerWidth + 1 && r.left < innerWidth && !e.closest('[style*="overflow"],nav')) out.push({ k: 'offscreen', s: sel(e), t: txt, x: [Math.round(r.left), Math.round(r.right)] });
  }
  return out;
};
