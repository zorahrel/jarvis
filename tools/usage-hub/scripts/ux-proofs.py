#!/usr/bin/env python3
"""Prove UI dell'hub per Attilio: screenshot e video del giro, scattati solo a pagina caricata.

  python3 scripts/ux-proofs.py OUTDIR [--video]

Pagine vere dal hub che gira (:3360, solo GET), alle tre larghezze e nei due temi; poi la Panoramica e il
giro in video su un serve --demo a parte, dove l'hub stesso mette la fascia «ESEMPIO» su ogni vista.
Esce 1 se una pagina resta sullo scheletro di caricamento (oltre 60 s nelle foto, oltre 4 s nel video).
"""
import json, os, pathlib, shutil, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOADING = "!!document.querySelector('.tab.on .au-skl, .tab.on [aria-busy=true], .tab.on [data-loading]')"
LIVE = 'http://127.0.0.1:3360'
bad = []


def wait_loaded(pg, name, secs):
    t = time.time()
    while time.time() - t < secs:
        if not pg.evaluate(LOADING):
            return time.time() - t
        pg.wait_for_timeout(150)
    bad.append(f'{name}: ancora sullo scheletro dopo {secs} s')
    return None


def demo_server(d):
    s = socket.socket(); s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]; s.close()
    now = int(time.time() * 1000)
    with open(d / 'attesa.jsonl', 'w') as f:
        f.write(json.dumps({'kind': 'apri', 'id': 'es1', 'tipo': 'spesa', 'title': 'Rinnovare un piano a pagamento', 'why': 'Spesa di prova: 19 dollari al mese.', 'from': 'demo', 'at': now - 3 * 3600000}) + '\n')
        f.write(json.dumps({'kind': 'apri', 'id': 'es2', 'tipo': 'vista', 'title': 'Guarda una pagina nuova', 'why': 'Ok a vista di prova.', 'link': '#journal', 'from': 'demo', 'at': now - 40 * 60000}) + '\n')
    env = dict(os.environ, USAGE_HUB_DEMO_AUTOMATIONS='problemi', USAGE_HUB_FEEDBACK_DIR=str(d / 'fb'), USAGE_HUB_QUEUE=str(d / 'q.json'),
               USAGE_HUB_QUEUE_LOG=str(d / 'q.log'), USAGE_HUB_ATTESA=str(d / 'attesa.jsonl'), USAGE_HUB_CONTEXT_CHECK=str(d / 'c.json'),
               USAGE_HUB_DIARIO=str(d / 'diario'))
    p = subprocess.Popen(['node', 'bin/usage-hub.mjs', 'serve', '--demo', '--port', str(port)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}'
    for _ in range(150):
        try: urllib.request.urlopen(url + '/api/automations', timeout=2); break
        except Exception: time.sleep(0.2)
    # a caldo prima di registrare: le prime risposte (diario, contesto, quote) sono le lente
    for u in ('/api/diario?days=7', '/api/contesto', '/api/automations', '/api/live', '/api/gates', '/api/pace', '/api/mac', '/api/attesa'):
        try: urllib.request.urlopen(url + u, timeout=90).read()
        except Exception: pass
    return p, url


def shots(b, url, tabs, widths, schemes, prefix, out):
    for w in widths:
        for sc in schemes:
            pg = b.new_context(viewport={'width': w, 'height': 900}, color_scheme=sc).new_page(); pg.set_default_timeout(120000)
            for t in tabs:
                name = f'{prefix}{t}-{w}-{sc}.png'
                pg.goto(url + '/#' + t, wait_until='domcontentloaded'); pg.wait_for_timeout(400)
                wait_loaded(pg, name, 60); pg.wait_for_timeout(500)
                pg.screenshot(path=str(out / name), full_page=True)
            pg.context.close()


def live_extras(b, out):
    # tabella progetti (consumo per progetto e sessione, prime tre sessioni aperte) e sezione «Computer e app», dal vivo
    for w in (1440, 375):
        pg = b.new_context(viewport={'width': w, 'height': 900}).new_page(); pg.set_default_timeout(120000)
        pg.goto(LIVE + '/#overview', wait_until='domcontentloaded'); wait_loaded(pg, f'progetti {w}', 60)
        pg.wait_for_selector('table.proj')
        pg.evaluate("document.querySelectorAll('table.proj details').forEach((d, i) => { if (i < 3) d.open = true })"); pg.wait_for_timeout(500)
        pg.locator('table.proj').first.screenshot(path=str(out / f'r5-progetti-consumo-{w}.png'))
        pg.context.close()
    pg = b.new_context(viewport={'width': 1440, 'height': 900}).new_page(); pg.set_default_timeout(120000)
    pg.goto(LIVE + '/#automations', wait_until='domcontentloaded'); wait_loaded(pg, 'computer e app', 60)
    pg.wait_for_selector('[data-area="computer-app"]'); pg.locator('[data-area="computer-app"]').screenshot(path=str(out / 'r5-computer-app-live.png'))
    pg.context.close()


def tour(b, url, out, d):
    vid = d / 'vid'
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, record_video_dir=str(vid), record_video_size={'width': 1440, 'height': 900})
    pg = ctx.new_page(); pg.set_default_timeout(90000)
    step = lambda name: wait_loaded(pg, 'video ' + name, 4)
    pg.goto(url + '/#overview', wait_until='domcontentloaded'); step('panoramica'); pg.wait_for_timeout(2500)
    pg.locator('[data-wait-done="es1"]').click(); pg.wait_for_timeout(2000)
    pg.locator('#nav button[data-t=journal]').click(); step('diario'); pg.wait_for_timeout(1800)
    pg.locator('[data-j-f=pb]').click(); pg.wait_for_timeout(1400)
    pg.locator('input[data-j-q]').type('prova', delay=90); pg.wait_for_timeout(800)
    pg.locator('input[data-j-q]').fill(''); pg.locator('[data-j-f=all]').click(); pg.wait_for_timeout(600)
    pg.locator('#nav button[data-t=automations]').click(); step('automazioni'); pg.wait_for_timeout(1500)
    pg.locator('#t-automations .cx-row[data-cx]:not(.cx-hdr)').first.click(); pg.wait_for_selector('.cx-panel'); pg.wait_for_timeout(2500)
    pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
    pg.mouse.wheel(0, 900); pg.wait_for_timeout(1500); pg.mouse.wheel(0, -900); pg.wait_for_timeout(600)
    pg.locator('#nav button[data-t=context]').click(); step('contesto'); pg.wait_for_timeout(2500)
    pg.mouse.wheel(0, 900); pg.wait_for_timeout(1800)
    ctx.close()
    shutil.copy(sorted(vid.glob('*.webm'))[-1], out / 'r5-giro.webm')


def main():
    out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
    d = pathlib.Path(tempfile.mkdtemp(prefix='ux-proofs-'))
    with sync_playwright() as pw:
        b = pw.webkit.launch()
        shots(b, LIVE, ['overview', 'journal', 'automations', 'context'], [1440, 700, 375], ['light', 'dark'], 'r5-', out)
        live_extras(b, out)
        p, url = demo_server(d)
        try:
            shots(b, url, ['overview'], [1440, 375], ['light'], 'r5-esempio-', out)
            if '--video' in sys.argv: tour(b, url, out, d)
        finally:
            p.kill()
        b.close()
    print('\n'.join(bad) or 'nessuno scheletro')
    sys.exit(1 if bad else 0)


if __name__ == '__main__':
    main()
