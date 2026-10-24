#!/usr/bin/env python3
# Barra della UI su un `serve --demo` a parte (il :3360 vivo non si tocca). Esce 1 al primo rosso.
#   python3 scripts/ui-bar.py [--shots DIR]
# Controlla, a 1440, 700 e 375 px:
#   1. l'header non perde la navigazione cambiando tab, nemmeno con un sottotitolo lunghissimo
#      (il baco del 24/10: il sottotitolo di Account schiacciava la nav a larghezza 0);
#   2. nessun testo tagliato (overflow, ellipsis, clip) e niente scroll orizzontale, su tutte le tab;
#   3. ui-audit a 0 per misalign, overflow e overlap sulla scheda Automazioni, chiusa e col pannello aperto;
#   4. axe senza violazioni serie o critiche.
import os, pathlib, socket, subprocess, sys, tempfile, time, urllib.request, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path.home()
# L'interno di un'icona SVG (path, circle) è disegno, non layout: ui-audit lo misurerebbe come elementi
# «disallineati». Lo salto sulla copia che inietto, senza toccare lo script condiviso.
AUDIT_JS = (HOME / '.claude/jarvis/scripts/ui-audit.js').read_text().replace(
    'var el = all[i];', 'var el = all[i]; if (el.ownerSVGElement) continue;', 1)
assert 'ownerSVGElement' in AUDIT_JS, 'ui-audit.js è cambiato: il filtro delle icone non si applica più'
CLIP_JS = (ROOT / 'scripts/ui-clip.js').read_text()
TABS = ['overview', 'journal', 'automations', 'sessions', 'projects', 'activity', 'context', 'accounts', 'usage', 'services', 'settings', 'logs']
WIDTHS = (1440, 700, 375)
LONG = 'sottotitolo di prova lunghissimo ' * 14
red = []


def axe_js():
    # axe-core non è una dipendenza dell'hub: lo prendo dalla prima copia locale che trovo.
    pats = ['.bun/install/cache/axe-core@4*/axe.min.js', 'Projects/*/node_modules/axe-core/axe.min.js', 'Projects/*/*/node_modules/axe-core/axe.min.js']
    for p in pats:
        for f in sorted(HOME.glob(p)):
            return f.read_text()
    return None


def check(ok, what):
    print(('ok    ' if ok else 'ROSSO ') + what)
    if not ok:
        red.append(what)


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def serve():
    port = free_port()
    d = pathlib.Path(tempfile.mkdtemp(prefix='ui-bar-'))
    env = dict(os.environ, USAGE_HUB_DEMO_AUTOMATIONS='problemi', USAGE_HUB_FEEDBACK_DIR=str(d / 'feedback'),
               USAGE_HUB_QUEUE=str(d / 'queue.json'), USAGE_HUB_QUEUE_LOG=str(d / 'queue.log'),
               USAGE_HUB_ATTESA=str(d / 'ti-aspetta.jsonl'), USAGE_HUB_CONTEXT_CHECK=str(d / 'check.json'), USAGE_HUB_DIARIO=str(d / 'diario'))
    proc = subprocess.Popen(['node', 'bin/usage-hub.mjs', 'serve', '--demo', '--port', str(port)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}'
    for _ in range(150):
        try:
            urllib.request.urlopen(url + '/api/automations', timeout=2)
            return proc, url
        except Exception:
            time.sleep(0.2)
    proc.kill()
    sys.exit('ROSSO serve --demo non parte')


# La nav è intera se ogni bottone sta dentro lo schermo e dentro la nav, con larghezza vera.
NAV_JS = """() => {
  const n = document.getElementById('nav'), r = n.getBoundingClientRect(), bad = [];
  if (r.width < 100 || r.height < 20) bad.push('nav ' + Math.round(r.width) + 'x' + Math.round(r.height));
  for (const b of n.querySelectorAll('button')) {
    const q = b.getBoundingClientRect();
    if (q.width < 30 || q.left < r.left - 1 || q.right > r.right + 1 || q.right > innerWidth + 1 || q.left < 0) bad.push(b.dataset.t + ' ' + Math.round(q.left) + '-' + Math.round(q.right));
  }
  return bad;
}"""


def main():
    shots = None
    if '--shots' in sys.argv:
        shots = pathlib.Path(sys.argv[sys.argv.index('--shots') + 1])
        shots.mkdir(parents=True, exist_ok=True)
    axe = axe_js()
    check(axe is not None, 'axe-core trovato in locale')
    proc, url = serve()
    try:
        with sync_playwright() as p:
            b = p.webkit.launch()
            for w in WIDTHS:
                pg = b.new_context(viewport={'width': w, 'height': 900}).new_page()
                pg.set_default_timeout(90000)
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)[:160]))
                pg.goto(url + '/#automations', wait_until='domcontentloaded')
                pg.wait_for_selector('#t-automations [data-sec=table]', timeout=60000)
                # 1. nav: a ogni cambio di tab, poi col sottotitolo più lungo possibile
                navbad = []
                for t in TABS + TABS[::-1]:
                    try:
                        pg.locator(f'#nav button[data-t={t}]').click(timeout=4000)
                    except Exception:
                        navbad.append(t + ': il bottone non si può cliccare')
                        pg.evaluate(f"location.hash='{t}'")
                    pg.wait_for_timeout(250)
                    for x in pg.evaluate(NAV_JS):
                        navbad.append(t + ':' + x)
                    pg.evaluate('t => { document.getElementById("sub").textContent = t; }', LONG)
                    for x in pg.evaluate(NAV_JS):
                        navbad.append(t + '+sub:' + x)
                    on = pg.evaluate("document.querySelector('#nav button.on')?.dataset.t")
                    if on != t:
                        navbad.append(t + ': attiva ' + str(on))
                check(not navbad, f'{w}px header: nav intera su {len(TABS)} tab, avanti e indietro {navbad[:4]}')
                # 2. tagli e scroll orizzontale su tutte le tab
                cuts = []
                for t in TABS:
                    pg.evaluate(f"location.hash='{t}'")
                    pg.wait_for_timeout(1200)
                    pg.add_script_tag(content=CLIP_JS)
                    cuts += [t + ':' + x['k'] + ' ' + x['s'] for x in pg.evaluate('__clip()')]
                    if pg.evaluate('document.documentElement.scrollWidth > innerWidth'):
                        cuts.append(t + ': scroll orizzontale')
                check(not cuts, f'{w}px nessun testo tagliato su {len(TABS)} tab {cuts[:4]}')
                # 3-4. Automazioni chiusa e col pannello aperto
                pg.evaluate("location.hash='automations'")
                pg.wait_for_selector('#t-automations [data-sec=table]')
                pg.wait_for_timeout(500)
                if shots:
                    pg.screenshot(path=str(shots / f'automazioni-{w}.png'), full_page=True)
                for case in ('chiusa', 'pannello'):
                    if case == 'pannello':
                        pg.locator('#t-automations .cx-row[data-cx]:not(.cx-hdr)').first.click()
                        pg.wait_for_selector('.cx-panel')
                        pg.wait_for_timeout(1500)
                        pg.evaluate("document.querySelectorAll('.cx-panel details').forEach(d => d.open = true)")
                        if shots:
                            pg.screenshot(path=str(shots / f'pannello-{w}.png'))
                    pg.add_script_tag(content=AUDIT_JS.replace('return window.__uiAudit(', 'void (').strip())
                    r = json.loads(pg.evaluate("window.__uiAudit({scope:'#t-automations', maxEls:3000, minTap:24})"))
                    c = r['counts']
                    bad = {k: c[k] for k in ('misalign', 'overlap') if c[k]}
                    if r['overflowX']['present']:
                        bad['overflowX'] = r['overflowX']['offenders'][:3]
                    check(not bad, f'{w}px ui-audit {case}: misalign, overlap, overflow a 0 {bad} {[r["findings"][k][:3] for k in bad if k in r["findings"]]}')
                    if axe:
                        pg.add_script_tag(content=axe)
                        v = pg.evaluate("async () => (await axe.run(document, {runOnly: ['wcag2a', 'wcag2aa']})).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id + ':' + v.nodes.slice(0, 2).map(n => n.target).join('|'))")
                        check(not v, f'{w}px axe {case}: nessuna violazione seria {v}')
                check(not errs, f'{w}px nessun errore JS {errs[:2]}')
                pg.context.close()
            b.close()
    finally:
        proc.kill()
    print('UI ROSSA: ' + '; '.join(red) if red else 'UI VERDE')
    sys.exit(1 if red else 0)


if __name__ == '__main__':
    main()
