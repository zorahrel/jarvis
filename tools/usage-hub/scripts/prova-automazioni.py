#!/usr/bin/env python3
# PROVA della scheda Automazioni: screenshot e video in docs/, audit del layout a 375 px.
# Due `serve --demo` su porte libere (fixture «ok» e «problemi»), feedback e coda in una cartella di prova:
# il :3360 vivo e il feedback vero non si toccano. Esce 1 al primo controllo rosso.
#   python3 scripts/prova-automazioni.py
import atexit, json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / 'docs'
AUDIT_JS = pathlib.Path.home() / '.claude/jarvis/scripts/ui-audit.js'
AXE_JS = next(pathlib.Path.home().glob('.bun/install/cache/axe-core@4*/axe.min.js'))
TMP = pathlib.Path(tempfile.mkdtemp(prefix='prova-automazioni-'))
atexit.register(shutil.rmtree, TMP, True)  # la cartella di lavoro non resta in $TMPDIR
red = []


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


def serve(fixture):
    port = free_port()
    d = TMP / fixture
    env = dict(os.environ, USAGE_HUB_DEMO_AUTOMATIONS=fixture, USAGE_HUB_FEEDBACK_DIR=str(d / 'feedback'),
               USAGE_HUB_QUEUE=str(d / 'queue.json'), USAGE_HUB_QUEUE_LOG=str(d / 'queue.log'))
    proc = subprocess.Popen(['node', 'bin/usage-hub.mjs', 'serve', '--demo', '--port', str(port)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}'
    for _ in range(100):
        try:
            urllib.request.urlopen(url + '/api/automations', timeout=5).read()
            return proc, url, d
        except Exception:
            time.sleep(0.3)
    proc.terminate(); proc.wait(15)
    sys.exit(f'serve --demo {fixture} non risponde')


def open_tab(page, url):
    page.goto(url + '/#automations')
    page.wait_for_selector('#t-automations [data-sec="footer"]')


def audit(page, label):
    # ui-audit misura il DOM (sovrapposizioni, overflow, tap target); axe guarda contrasto e accessibilità.
    page.add_script_tag(content=AUDIT_JS.read_text())
    res = json.loads(page.evaluate("window.__uiAudit({scope:'#t-automations', minTap:32, maxEls:800})"))
    page.add_script_tag(content=AXE_JS.read_text())
    axe = page.evaluate("""async () => { const r = await axe.run('#t-automations', { runOnly: ['wcag2a', 'wcag2aa'] });
      return r.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => ({ id: v.id, n: v.nodes.length, t: v.nodes[0].target })); }""")
    f = res['findings']
    check(len(f.get('overlap', [])) == 0, f'{label}: 0 sovrapposizioni (trovate {len(f.get("overlap", []))})')
    check(not res['overflowX']['present'], f'{label}: niente scroll orizzontale (pagina {res["overflowX"]["docWidth"]} px su {res["overflowX"]["viewport"]})')
    check(len(axe) == 0, f'{label}: 0 problemi gravi di accessibilità e contrasto ({axe})')
    return {'uiAudit': res, 'axeSerious': axe}


def main():
    DOCS.mkdir(exist_ok=True)
    ok_proc, ok_url, ok_dir = serve('ok')
    pb_proc, pb_url, pb_dir = serve('problemi')
    report = {}
    try:
        with sync_playwright() as p:
            b = p.webkit.launch()

            # 1. Sistema sano: verdetto verde, nessuna card aperta.
            pg = b.new_page(viewport={'width': 1280, 'height': 900})
            open_tab(pg, ok_url)
            pg.screenshot(path=str(DOCS / 'automations-ok.png'), full_page=True)
            check(pg.locator('#t-automations [data-sec="verdict"]').inner_text().startswith('Tutto a posto'), 'ok: verdetto «Tutto a posto»')
            check(pg.locator('#t-automations article.au-card:visible').count() == 0, 'ok: nessuna card aperta')
            pg.close()

            # 2. Problemi, chiaro e scuro.
            for scheme, name in (('light', 'automations-problemi.png'), ('dark', 'automations-problemi-scuro.png')):
                pg = b.new_page(viewport={'width': 1280, 'height': 900}, color_scheme=scheme)
                open_tab(pg, pb_url)
                pg.screenshot(path=str(DOCS / name), full_page=True)
                if scheme == 'light':
                    check('2 ti aspettano' in pg.locator('#t-automations [data-sec="verdict"]').inner_text(), 'problemi: «2 ti aspettano» nel verdetto')
                pg.close()

            # 3. Telefono, 375 px: audit da chiuso e con tutto aperto (i dettagli tecnici sono i più larghi).
            pg = b.new_page(viewport={'width': 375, 'height': 812}, device_scale_factor=2)
            open_tab(pg, pb_url)
            pg.screenshot(path=str(DOCS / 'automations-375.png'), full_page=True)
            report['375-chiuso'] = audit(pg, '375 px')
            pg.evaluate("document.querySelectorAll('#t-automations details').forEach(d => d.open = true)")
            report['375-aperto'] = audit(pg, '375 px, tutto aperto')
            pg.close()

            # 4. Video: «Da cambiare» con la nota, Invio, ricarico la pagina e il voto è ancora lì.
            vdir = TMP / 'video-fb'
            ctx = b.new_context(viewport={'width': 1100, 'height': 760}, record_video_dir=str(vdir), record_video_size={'width': 1100, 'height': 760})
            pg = ctx.new_page()
            open_tab(pg, pb_url)
            card = pg.locator('#t-automations [data-sec="needs"] article.au-card').first
            title = card.locator('h4').inner_text().strip()
            pg.wait_for_timeout(800)
            card.locator('[data-fb="cambia"]').click()
            pg.wait_for_timeout(400)
            pg.keyboard.type('Avvisami solo se fallisce due volte di fila', delay=35)
            pg.keyboard.press('Enter')
            pg.wait_for_selector('#toast.on')
            check('un agente se ne occupa' in pg.locator('#toast').inner_text(), 'video: toast «un agente se ne occupa»')
            pg.wait_for_timeout(1500)
            pg.reload()
            pg.wait_for_selector('#t-automations [data-sec="footer"]')
            again = pg.locator('#t-automations article.au-card', has=pg.locator('h4', has_text=title)).first
            check('Hai detto: da cambiare' in again.inner_text(), 'video: dopo il ricarico la card dice «Hai detto: da cambiare»')
            pg.wait_for_timeout(1500)
            ctx.close()
            shutil.move(str(next(vdir.glob('*.webm'))), DOCS / 'automations-feedback.webm')

            rows = [json.loads(l) for f in sorted((pb_dir / 'feedback').glob('*.jsonl')) for l in f.read_text().splitlines() if l.strip()]
            last = rows[-1] if rows else {}
            check(last.get('kind') == 'vote' and last.get('v') == 'cambia' and last.get('note', '').startswith('Avvisami'), 'feedback: ultima riga del JSONL = voto «cambia» con la nota')
            queue = json.loads((pb_dir / 'queue.json').read_text()).get('items', []) if (pb_dir / 'queue.json').exists() else []
            qi = queue[-1] if queue else {}
            check(qi.get('project') == 'automazioni' and last.get('id', '?') in qi.get('task', ''), 'coda: un lavoro per gli agenti con il riferimento della richiesta')

            # 5. Video: ripasso di 3 card solo con la tastiera (Tab fino a «Ripassale», Invio, poi v v v).
            vdir = TMP / 'video-rip'
            ctx = b.new_context(viewport={'width': 1100, 'height': 760}, record_video_dir=str(vdir), record_video_size={'width': 1100, 'height': 760})
            pg = ctx.new_page()
            open_tab(pg, ok_url)
            pg.wait_for_timeout(600)
            for _ in range(200):
                if pg.evaluate("document.activeElement && document.activeElement.dataset.review === 'start'"):
                    break
                pg.keyboard.press('Alt+Tab')  # in WebKit, come in Safari, Tab da solo salta i pulsanti
            check(pg.evaluate("document.activeElement.dataset.review === 'start'"), 'ripasso: «Ripassale» raggiunto con la tastiera')
            pg.keyboard.press('Enter')
            pg.wait_for_selector('.au-rev-now article.au-card')
            start = pg.locator('.au-rev-now .small.mut').first.inner_text()
            for _ in range(3):
                pg.wait_for_timeout(900)
                pg.keyboard.press('v')
            pg.wait_for_timeout(1200)
            end = pg.locator('.au-rev-now .small.mut').first.inner_text()
            ctx.close()
            shutil.move(str(next(vdir.glob('*.webm'))), DOCS / 'automations-ripasso.webm')
            votes = [json.loads(l) for f in sorted((ok_dir / 'feedback').glob('*.jsonl')) for l in f.read_text().splitlines() if l.strip()]
            n0, n1 = int(start.split('/')[0]), int(end.split('/')[0])
            check(n1 == n0 + 3 and len([v for v in votes if v.get('kind') == 'vote' and v.get('v') == 'ok']) == 3,
                  f'ripasso: da {start} a {end} con 3 voti salvati')
            b.close()
    finally:
        # SIGTERM: la demo toglie la sua cartella (SIGKILL ne lasciava 2 a giro in $TMPDIR)
        for pr in (ok_proc, pb_proc): pr.terminate(); pr.wait(15)
    (DOCS / 'automations-audit.json').write_text(json.dumps(report, ensure_ascii=False, indent=1))
    if red:
        print(f'ROSSO: {len(red)} controlli')
        sys.exit(1)
    print('PROVA VERDE')


main()
