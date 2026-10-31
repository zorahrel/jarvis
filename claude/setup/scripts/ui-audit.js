/*
 * ui-audit.js — audit deterministico del layout via DOM (niente vista/VLM).
 *
 * Misura la geometria reale (getBoundingClientRect + getComputedStyle) invece di
 * stimare i pixel da uno screenshot. Restituisce JSON compatto: numeri, non opinioni.
 *
 * USO (claude-in-chrome javascript_tool, nella tab da valutare):
 *   incolla il contenuto di questo file — l'ultima riga è `__uiAudit(opts)` e ritorna la stringa JSON.
 *
 * OPZIONI (opts, tutte opzionali):
 *   scope   : selettore CSS della radice da analizzare (default: 'body')
 *   tol     : tolleranza px per "near-miss" allineamenti (default 4)
 *   maxEls  : cap elementi analizzati (default 400)
 *   minTap  : lato minimo tap target px (default 44)
 *   limit   : max findings per categoria in output (default 25)
 *
 * OUTPUT: { viewport, counts, overflowX, findings:{ misalign, spacing, overlap, offscreen, tapTargets } }
 * Ogni finding porta un selettore leggibile + i numeri esatti → si ragiona sui numeri, non sui pixel.
 */
(function () {
  window.__uiAudit = function (opts) {
    opts = opts || {};
    var TOL = opts.tol == null ? 4 : opts.tol;
    var MAXELS = opts.maxEls || 400;
    var MINTAP = opts.minTap || 44;
    var LIMIT = opts.limit || 25;
    var root = document.querySelector(opts.scope || 'body') || document.body;

    var vw = window.innerWidth, vh = window.innerHeight;

    function sel(el) {
      if (!el || el.nodeType !== 1) return '?';
      if (el.id) return '#' + el.id;
      var p = el.tagName.toLowerCase();
      var cls = (el.className && el.className.toString) ? el.className.toString().trim().split(/\s+/).slice(0, 2).join('.') : '';
      if (cls) p += '.' + cls;
      // disambigua con nth se ci sono fratelli uguali
      var par = el.parentElement;
      if (par) {
        var same = Array.prototype.filter.call(par.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) p += ':nth(' + (same.indexOf(el) + 1) + ')';
      }
      return p;
    }
    function r(n) { return Math.round(n * 10) / 10; }

    // raccogli elementi visibili e "significativi"
    var all = root.querySelectorAll('*');
    var els = [];
    for (var i = 0; i < all.length && els.length < MAXELS; i++) {
      var el = all[i];
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
      var b = el.getBoundingClientRect();
      if (b.width < 1 || b.height < 1) continue;
      els.push({ el: el, b: b, cs: cs });
    }

    var findings = { misalign: [], spacing: [], overlap: [], offscreen: [], tapTargets: [] };

    // --- overflow orizzontale (causa #1 di layout rotto) ---
    var docW = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    var overflowX = { present: docW > vw + 1, docWidth: docW, viewport: vw, offenders: [] };
    if (overflowX.present) {
      for (var j = 0; j < els.length; j++) {
        var bb = els[j].b;
        if (bb.right > vw + 1) {
          overflowX.offenders.push({ el: sel(els[j].el), right: r(bb.right), width: r(bb.width), over: r(bb.right - vw) });
        }
      }
      overflowX.offenders.sort(function (a, c) { return c.over - a.over; });
      overflowX.offenders = overflowX.offenders.slice(0, LIMIT);
    }

    // --- fuori viewport / clipping negativo ---
    for (var k = 0; k < els.length; k++) {
      var b2 = els[k].b;
      if (b2.left < -1 || b2.top < -1) {
        findings.offscreen.push({ el: sel(els[k].el), left: r(b2.left), top: r(b2.top) });
      }
    }

    // --- tap target troppo piccoli (interattivi) ---
    var interactive = 'a,button,input,select,textarea,[role=button],[onclick],[tabindex]';
    for (var t = 0; t < els.length; t++) {
      if (!els[t].el.matches(interactive)) continue;
      var tb = els[t].b;
      if (tb.width < MINTAP || tb.height < MINTAP) {
        findings.tapTargets.push({ el: sel(els[t].el), w: r(tb.width), h: r(tb.height) });
      }
    }

    // --- allineamenti near-miss (edge condivisi ma off di 1..TOL px) ---
    // confronta solo elementi "fratelli visivi" (stesso parent) per limitare rumore
    var byParent = new Map();
    els.forEach(function (o) {
      var p = o.el.parentElement;
      if (!p) return;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(o);
    });
    var edges = [['left', 'left'], ['right', 'right'], ['top', 'top']];
    byParent.forEach(function (group) {
      if (group.length < 2 || group.length > 30) return;
      for (var a = 0; a < group.length; a++) {
        for (var c = a + 1; c < group.length; c++) {
          edges.forEach(function (e) {
            var d = Math.abs(group[a].b[e[0]] - group[c].b[e[0]]);
            if (d > 0.5 && d <= TOL) {
              findings.misalign.push({
                edge: e[0], off: r(d),
                a: sel(group[a].el), b: sel(group[c].el)
              });
            }
          });
        }
      }
    });

    // --- spaziature incoerenti tra fratelli consecutivi (asse dominante) ---
    byParent.forEach(function (group) {
      if (group.length < 3) return;
      // ordina per top; determina se stack verticale o orizzontale
      var vert = group.slice().sort(function (x, y) { return x.b.top - y.b.top; });
      var horiz = group.slice().sort(function (x, y) { return x.b.left - y.b.left; });
      var spanV = vert[vert.length - 1].b.top - vert[0].b.top;
      var spanH = horiz[horiz.length - 1].b.left - horiz[0].b.left;
      var seq = spanV >= spanH ? vert : horiz;
      var axis = spanV >= spanH ? 'v' : 'h';
      var gaps = [];
      for (var g = 0; g < seq.length - 1; g++) {
        var gap = axis === 'v'
          ? seq[g + 1].b.top - seq[g].b.bottom
          : seq[g + 1].b.left - seq[g].b.right;
        gaps.push(r(gap));
      }
      // flag se i gap variano oltre TOL rispetto alla mediana
      if (gaps.length >= 2) {
        var sorted = gaps.slice().sort(function (a, b) { return a - b; });
        var med = sorted[Math.floor(sorted.length / 2)];
        var bad = gaps.some(function (v) { return Math.abs(v - med) > TOL; });
        if (bad) {
          findings.spacing.push({
            parent: sel(seq[0].el.parentElement), axis: axis,
            gaps: gaps, median: med, n: seq.length
          });
        }
      }
    });

    // --- overlap non intenzionali (fratelli static che si sovrappongono) ---
    byParent.forEach(function (group) {
      if (group.length < 2 || group.length > 30) return;
      for (var a = 0; a < group.length; a++) {
        for (var c = a + 1; c < group.length; c++) {
          var A = group[a], B = group[c];
          if (A.cs.position !== 'static' || B.cs.position !== 'static') continue;
          var ib = A.b, jb = B.b;
          var ox = Math.min(ib.right, jb.right) - Math.max(ib.left, jb.left);
          var oy = Math.min(ib.bottom, jb.bottom) - Math.max(ib.top, jb.top);
          if (ox > 1 && oy > 1) {
            findings.overlap.push({ a: sel(A.el), b: sel(B.el), overlap: r(ox) + 'x' + r(oy) });
          }
        }
      }
    });

    // dedup + cap
    Object.keys(findings).forEach(function (kk) {
      var seen = {}, out = [];
      findings[kk].forEach(function (f) {
        var key = JSON.stringify(f);
        if (seen[key]) return; seen[key] = 1; out.push(f);
      });
      findings[kk] = out.slice(0, LIMIT);
    });

    return JSON.stringify({
      viewport: { w: vw, h: vh },
      counts: {
        analyzed: els.length,
        misalign: findings.misalign.length,
        spacing: findings.spacing.length,
        overlap: findings.overlap.length,
        offscreen: findings.offscreen.length,
        tapTargets: findings.tapTargets.length
      },
      overflowX: overflowX,
      findings: findings
    });
  };
  return window.__uiAudit(typeof __UIAUDIT_OPTS__ !== 'undefined' ? __UIAUDIT_OPTS__ : {});
})();
