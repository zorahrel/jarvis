// Layout check for the dashboard, across real viewport widths.
//
// NOT a node:test file — it drives a real browser, so the dashboard must be up:
//     node dashboard.mjs &
//     CSW_PORT=3333 node test/layout-check.mjs
//
// Playwright is not a dependency of this project (it would be a heavy one for a
// zero-dependency tool), so this script is opt-in: install it wherever you like
// and point PLAYWRIGHT_MODULE at it, or `npm i -g playwright` and let the plain
// import resolve.
//
// It fails on: clipped cards, overlapping siblings, elements past the viewport,
// horizontal page scroll, strip cells thinner than 2px, and any text block that
// wraps past two lines. Every one of those has caught a real defect here — the
// cap label overlapping the header at all 12 widths, and the tab row forcing a
// sideways scroll at 360px.

// A hardcoded absolute path made this runnable on exactly one machine.
const PLAYWRIGHT = process.env.PLAYWRIGHT_MODULE || 'playwright';
let chromium;
try {
  ({ chromium } = await import(PLAYWRIGHT));
} catch {
  console.error(`Cannot load Playwright from "${PLAYWRIGHT}".`);
  console.error('Install it (npm i -g playwright) or set PLAYWRIGHT_MODULE to its index.mjs.');
  process.exit(2);
}

const DASHBOARD_URL = process.env.VDM_URL || `http://127.0.0.1:${process.env.CSW_PORT || 3333}/`;
const WIDTHS = [1440, 1280, 1024, 900, 768, 700, 640, 560, 480, 414, 390, 360];
const browser = await chromium.launch();
const rows = [];
let problems = [];

for (const w of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: w, height: 1000 } });
  await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.card', { timeout: 10000 });
  await page.waitForTimeout(400);

  const r = await page.evaluate(() => {
    const probs = [];
    // Every var(--x) referenced in the stylesheet must actually be defined.
    const css = [...document.styleSheets].flatMap(s => {
      try { return [...s.cssRules].map(x => x.cssText); } catch { return []; }
    }).join('\n');
    const rootStyle = getComputedStyle(document.documentElement);
    for (const v of new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map(m => m[1])))
      if (rootStyle.getPropertyValue(v).trim() === '')
        probs.push('variabile CSS mai definita: ' + v);
    const cards = [...document.querySelectorAll('.card')];
    const c = cards[0];
    const g = (sel, root = c) => root.querySelector(sel);
    const rect = e => e ? e.getBoundingClientRect() : null;
    const lineH = 15;

    // Every card: clipping, overlap, offscreen
    for (const card of cards) {
      const nm = g('.card-name', card)?.textContent || '?';
      if (card.scrollHeight - Math.round(card.getBoundingClientRect().height) > 1)
        probs.push(nm + ': tagliato ' + (card.scrollHeight - Math.round(card.getBoundingClientRect().height)) + 'px');
      const kids = [...card.children];
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i-1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
        if (a.bottom - b.top > 1) probs.push(nm + ': "' + kids[i-1].className.split(' ')[0] + '" sovrappone "' + kids[i].className.split(' ')[0] + '" ' + (a.bottom-b.top).toFixed(1) + 'px');
      }
      for (const e of card.querySelectorAll('*')) {
        const b = e.getBoundingClientRect();
        if (b.width > 0 && (b.right > innerWidth + 1 || b.left < -1))
          { probs.push(nm + ': "' + (e.className||e.tagName) + '" fuori schermo'); break; }
      }
      // The cap tick overhangs the track by 3px; it must not reach the header line.
      const mk = card.querySelector('.cap-marker');
      if (mk) {
        const head = mk.closest('.rate-group')?.querySelector('.rate-head');
        if (head && head.getBoundingClientRect().bottom > mk.getBoundingClientRect().top + 0.5)
          probs.push(nm + ': tick del cap sovrappone l\'intestazione');
      }
      // Legend keys must be geometrically IDENTICAL — same size, radius, and
      // border. A border on only one of them shrinks its fill (border-box) so it
      // reads as a smaller, outlined, different kind of mark next to the solid
      // ones. That, not misalignment, is what made the row look wrong. Also: no
      // gradients, which on an 8px square render as one off-centre streak.
      // Selected by POSITION, not by class name: the swatch is the first child of
      // each legend item. A class-name selector silently finds nothing the day
      // someone renames it, and a guard that finds nothing never fails.
      const sws = [...card.querySelectorAll('.attr-legend .lg > span:first-child')];
      const shapes = new Set(sws.map(e => {
        const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return [b.width.toFixed(1), b.height.toFixed(1), cs.borderRadius,
                cs.borderWidth, cs.borderStyle, cs.borderColor, cs.boxSizing].join('|');
      }));
      if (shapes.size > 1)
        probs.push(nm + ': chiavi legenda non identiche (' + shapes.size + ' geometrie diverse)');
      if (sws.length !== 3)
        probs.push(nm + ': attese 3 chiavi legenda, trovate ' + sws.length +
          ' (classe rinominata? il selettore va tenuto allineato)');
      for (const sw of sws) {
        if (getComputedStyle(sw).backgroundImage !== 'none')
          probs.push(nm + ': campione legenda con gradiente (a 8px si vede storto)');
        // The defect that survived two rounds of "fixes": the swatch carried the
        // toggle-switch class, so `.sw::before` painted a 14px white circle on an
        // 8px square. Nothing in the markup or in a size check shows a pseudo-
        // element inherited from an unrelated component — only asking for it does.
        for (const pseudo of ['::before', '::after']) {
          if (getComputedStyle(sw, pseudo).content !== 'none')
            probs.push(nm + ': chiave legenda con pseudo-elemento ' + pseudo +
              ' dipinto sopra (ereditato da un altro componente?)');
        }
        const item = sw.closest('.lg');
        const sb = sw.getBoundingClientRect(), ib = item.getBoundingClientRect();
        const off = Math.abs((sb.top + sb.height / 2) - (ib.top + ib.height / 2));
        if (off > 1) probs.push(nm + ': campione legenda disallineato di ' + off.toFixed(1) + 'px');
      }

      // Nothing may resolve to an invisible colour. `--muted-foreground` and
      // `--surface` were referenced eight times between them and never defined,
      // so the OFF switch had a transparent knob and looked broken.
      for (const sel of ['.enable-sw', '.cap-pct', '.badge-off']) {
        for (const e of card.querySelectorAll(sel)) {
          const cs = getComputedStyle(e);
          for (const [prop, val] of [['color', cs.color], ['background', cs.backgroundColor]]) {
            if (val === 'rgba(0, 0, 0, 0)' && prop === 'color')
              probs.push(nm + ': "' + sel + '" ha testo invisibile (variabile CSS non definita?)');
          }
        }
      }
      // A switch whose knob cannot be told from its own track is not a switch.
      for (const sw of card.querySelectorAll('.enable-sw')) {
        const track = getComputedStyle(sw).backgroundColor;
        const knob = getComputedStyle(sw, '::after').backgroundColor;
        if (knob === 'rgba(0, 0, 0, 0)') { probs.push(nm + ': pallino dello switch invisibile'); continue; }
        const lum = c => { const [r,g,bl] = (c.match(/\d+/g)||[0,0,0]).map(Number)
          .map(v => { v/=255; return v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4; });
          return 0.2126*r + 0.7152*g + 0.0722*bl; };
        const L1 = lum(track), L2 = lum(knob);
        const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
        if (ratio < 1.4) probs.push(nm + ': pallino switch indistinguibile dalla pista (' + ratio.toFixed(2) + ')');
      }

      // The cap value now lives in the header — it must stay on that one line.
      for (const lab of card.querySelectorAll('.rate-cap')) {
        const lb = lab.getBoundingClientRect();
        const row = lab.closest('.rate-head').getBoundingClientRect();
        if (lb.height > 18) probs.push(nm + ': etichetta cap va a capo (' + lb.height.toFixed(0) + 'px)');
        if (lb.right > row.right + 0.5) probs.push(nm + ': etichetta cap esce dall\'intestazione');
      }
    }

    const legends = c.querySelectorAll('.attr-legend');
    const cell = g('.attr-cell');
    const figs = [...c.querySelectorAll('.attr-figure')];
    const grp = g('.rate-group');
    const bars = g('.rate-bars');
    const cols = getComputedStyle(bars).gridTemplateColumns.split(' ').length;
    return {
      cols,
      col: Math.round(rect(grp).width),
      legends: legends.length,
      legendH: Math.round(rect(legends[0]).height),
      legendLines: Math.round(rect(legends[0]).height / lineH),
      cellW: +rect(cell).width.toFixed(2),
      stripH: +rect(g('.attr-strip')).height.toFixed(1),
      figMaxLines: Math.max(...figs.map(f => Math.round(rect(f).height / lineH))),
      cardH: Math.round(rect(c).height),
      ovX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      probs,
    };
  });
  rows.push({ w, ...r });
  problems.push(...r.probs.map(p => `${w}px — ${p}`));
  if (r.ovX) problems.push(`${w}px — la pagina scrolla in orizzontale`);
  if (r.cellW < 2) problems.push(`${w}px — celle striscia ${r.cellW}px`);
  if (r.legendLines > 2) problems.push(`${w}px — legenda su ${r.legendLines} righe`);
  if (r.figMaxLines > 2) problems.push(`${w}px — riga cifre su ${r.figMaxLines} righe`);
  await page.close();
}
await browser.close();

console.log('largh  col  colonne legende legH(righe) cella  cifre-righe  cardH  ovfX');
for (const r of rows)
  console.log(String(r.w).padStart(5), String(r.col).padStart(4), String(r.cols).padStart(7),
    String(r.legends).padStart(7), String(r.legendH + 'px(' + r.legendLines + ')').padStart(11),
    String(r.cellW).padStart(6), String(r.figMaxLines).padStart(11), String(r.cardH).padStart(6),
    String(r.ovX).padStart(6));

const uniq = [...new Set(problems)];
console.log('\n' + (uniq.length ? 'PROBLEMI:\n  ' + uniq.join('\n  ') : 'Nessun problema di layout su nessuna larghezza.'));
process.exit(uniq.length ? 1 : 0);
