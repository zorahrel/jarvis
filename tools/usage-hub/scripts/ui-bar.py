#!/usr/bin/env python3
# Barra della UI su un `serve --demo` a parte (il :3360 vivo non si tocca). Esce 1 al primo rosso.
#   python3 scripts/ui-bar.py [--shots DIR]
# Controlla, a 1440, 700 e 375 px:
#   1. l'header non perde la navigazione cambiando tab, nemmeno con un sottotitolo lunghissimo
#      (il baco del 24/10: il sottotitolo di Account schiacciava la nav a larghezza 0);
#   2. nessun testo tagliato (overflow, ellipsis, clip) e niente scroll orizzontale, su tutte le tab;
#   3. ui-audit a 0 per misalign, overflow e overlap sulla scheda Automazioni, chiusa e col pannello aperto;
#   4. axe senza violazioni serie o critiche su ogni tab, in chiaro e in scuro;
#   5. ogni numero di consumo dice il suo provider, niente cella fuori dalla sua card, comandi alti 44 px a 375;
#   6. il badge di «Ti aspetta» dentro il suo bottone (600 e 900 px), «Chiudi» del pannello non coperto;
#   7. la Panoramica con /api/attesa lenta 6 s e /api/live lenta 12 s: la barra aspetta la pagina vera, non il segnaposto.
import atexit, shutil, os, pathlib, socket, subprocess, sys, tempfile, time, urllib.request, json
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
HOME = pathlib.Path.home()
# L'interno di un'icona SVG (path, circle) è disegno, non layout: ui-audit lo misurerebbe come elementi
# «disallineati». Lo salto sulla copia che inietto, senza toccare lo script condiviso.
AUDIT_JS = (HOME / '.claude/jarvis/scripts/ui-audit.js').read_text().replace(
    'var el = all[i];', 'var el = all[i]; if (el.ownerSVGElement) continue;', 1)
assert 'ownerSVGElement' in AUDIT_JS, 'ui-audit.js è cambiato: il filtro delle icone non si applica più'
CLIP_JS = (ROOT / 'scripts/ui-clip.js').read_text()
CHECKS_JS = (ROOT / 'scripts/ui-checks.js').read_text()
TABS = ['overview', 'journal', 'automations', 'sessions', 'projects', 'activity', 'context', 'accounts', 'usage', 'services', 'settings', 'logs']
WIDTHS = (1440, 860, 700, 375)  # 860: la fascia 761-959 dove la nav diventa griglia
GRAPH_DELAY_MS = int(os.environ.get('UI_BAR_GRAPH_DELAY', '2500'))
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
    atexit.register(shutil.rmtree, d, True)  # HOME finta e file della prova: non restano in $TMPDIR
    # come le prove: HOME finto e --no-live, la demo inventa da sé «Ti aspetta», diario, quote e Mac
    (d / 'home').mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith('USAGE_HUB_')}
    env.update(HOME=str(d / 'home'), USAGE_HUB_DEMO_AUTOMATIONS='problemi', USAGE_HUB_CONTEXT_CHECK=str(d / 'check.json'))
    proc = subprocess.Popen(['node', 'bin/usage-hub.mjs', 'serve', '--demo', '--no-live', '--port', str(port)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f'http://127.0.0.1:{port}'
    for _ in range(150):
        try:
            urllib.request.urlopen(url + '/api/automations', timeout=2)
            return proc, url
        except Exception:
            time.sleep(0.2)
    proc.terminate(); proc.wait(15)  # SIGTERM: la demo toglie la sua cartella
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

# Una tab ancora sullo scheletro non è una prova: si aspetta che sparisca, e se non sparisce è rosso.
LOADING_JS = "!!document.querySelector('.tab.on .au-skl, .tab.on [aria-busy=true], .tab.on [data-loading]')"


def wait_loaded(pg, secs=40):
    for _ in range(secs * 4):
        if not pg.evaluate(LOADING_JS):
            return True
        pg.wait_for_timeout(250)
    return False


AXE_RUN = "async () => [...(await axe.run(document, {runOnly: ['wcag2a', 'wcag2aa']})).violations.filter(v => ['serious', 'critical'].includes(v.impact)), ...(await axe.run(document, {runOnly: {type: 'rule', values: ['empty-table-header', 'th-has-data-cells', 'td-has-header']}})).violations].map(v => v.id + ':' + v.nodes.slice(0, 2).map(n => n.target).join('|'))"
AXE_TABS = ['overview', 'journal', 'automations', 'context', 'usage', 'projects', 'accounts', 'sessions', 'activity', 'services', 'settings', 'logs']


def goto_tab(pg, t):
    pg.evaluate(f"location.hash='{t}'")
    pg.wait_for_timeout(300)
    return wait_loaded(pg)


# La demo non ha progetti fermi né righe di log: senza, contrasto delle righe «.dim» e scorrimento di #logbox
# non si misurano. Un progetto di /api/live diventa fermo, e il log riceve 120 righe come da logSrc.
DEAD_JS = """(() => { const f = window.fetch; window.fetch = async (u, o) => { const r = await f(u, o);
  if (!String(u).endsWith('/api/live')) return r;
  const j = await r.clone().json(); const p = (j.projects || []).filter(x => !((x.agents && x.agents.list) || []).length).pop();
  if (p) { p.dead = true; p.agents = null; }
  return new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } }); }; })()"""
FILL_LOG = "(() => { const b = document.getElementById('logbox'); if (!b) return 0; for (let i = 0; i < 120; i++) b.append(document.createTextNode('09:' + String(i % 60).padStart(2, '0') + ' riga di prova del log ' + i + '\\n')); return b.scrollHeight; })()"


# UI_BAR_CLOCK=2026-10-24T23:30:00+02:00: ogni pagina parte da quell'ora e poi scorre (la sparkline era rossa solo
# dopo le ~10:55, giro 9: la barra deve poter provare un'ora diversa da quella in cui gira)
CLOCK = os.environ.get('UI_BAR_CLOCK')


def new_ctx(b, **kw):
    c = b.new_context(**kw)
    if CLOCK:
        c.clock.install(time=CLOCK)
    return c


def axe_tabs(pg, axe, tabs):
    bad = []
    for t in tabs:
        goto_tab(pg, t)
        if t == 'logs':
            pg.evaluate(FILL_LOG)
        # axe misura solo ciò che è aperto: righe spente in «Nascosti dal menu», «Altri N», rami delle cartelle
        pg.evaluate("document.querySelectorAll('.tab.on details').forEach(d => d.open = true); document.querySelectorAll('.tab.on tr.brr').forEach(r => r.hidden = false)")
        pg.add_script_tag(content=axe)
        bad += [t + ':' + x for x in pg.evaluate(AXE_RUN)]
    return bad


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
                pg = new_ctx(b, viewport={'width': w, 'height': 900}).new_page()
                # lo schema del pannello arriva dopo 2,5 s (UI_BAR_GRAPH_DELAY per provare che oltre 4 s è rosso): il pannello deve mostrare lo scheletro nel frattempo
                pg.add_init_script("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/automations/graph') ? new Promise((r) => setTimeout(r, %d)).then(() => f(u, o)) : f(u, o); })()" % GRAPH_DELAY_MS)
                pg.add_init_script(DEAD_JS)
                pg.set_default_timeout(90000)
                errs = []
                pg.on('pageerror', lambda e: errs.append(str(e)[:160]))
                if w == WIDTHS[0]:
                    # 0. il badge delle sessioni all'apertura, PRIMA di passare da Sessioni (che lo riscrive): conta
                    # /api/live, non le sessioni del proxy (mutante U5 del giro 9, invisibile se si guarda dopo Sessioni)
                    pg.goto(url + '/#overview', wait_until='domcontentloaded')
                    wait_loaded(pg)
                    bd = pg.evaluate("""async () => { const d = await (await fetch('/api/live')).json();
                      const n = (d.projects || []).reduce((t, p) => t + ((p.agents && p.agents.list) || []).length, 0);
                      for (let i = 0; i < 40 && document.getElementById('nsess').textContent === ''; i++) await new Promise((r) => setTimeout(r, 100));
                      return { n, badge: document.getElementById('nsess').textContent, seen: [...document.querySelectorAll('#nav button.on')].map((b) => b.dataset.t) }; }""")
                    check(bd['n'] >= 3 and bd['badge'] == str(bd['n']) and bd['seen'] == ['overview'], f"badge Sessioni all'apertura della Panoramica = {bd['n']} sessioni di /api/live (badge {bd['badge']!r}, tab {bd['seen']})")
                    # i nomi dei progetti: quelli che l'hub dà in display (worktree → il suo repo), mai la cartella del worktree
                    nm = pg.evaluate("""async () => { const d = await (await fetch('/api/live')).json();
                      const rows = [...document.querySelectorAll('#t-overview tr td:first-child > b')].map((b) => b.textContent.trim());
                      const wt = (d.projects || []).filter((p) => p.display && p.display !== (p.title || p.name));
                      return { wt: wt.map((p) => [p.name, p.display]), shown: wt.every((p) => rows.includes(p.display)), raw: wt.filter((p) => rows.includes(p.name)).map((p) => p.name) }; }""")
                    check(len(nm['wt']) >= 1 and nm['shown'] and not nm['raw'], f"Panoramica: il worktree ha il nome del repo, non la cartella {nm['wt']} (cartella in pagina: {nm['raw']})")
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
                cuts, stuck = [], []
                for t in TABS:
                    pg.evaluate(f"location.hash='{t}'")
                    pg.wait_for_timeout(300)
                    if not wait_loaded(pg):
                        stuck.append(t)
                    pg.add_script_tag(content=CLIP_JS)
                    cuts += [t + ':' + x['k'] + ' ' + x['s'] for x in pg.evaluate('__clip()')]
                    if pg.evaluate('document.documentElement.scrollWidth > innerWidth'):
                        cuts.append(t + ': scroll orizzontale')
                check(not stuck, f'{w}px ogni tab finisce di caricare entro 40 s {stuck}')
                check(not cuts, f'{w}px nessun testo tagliato su {len(TABS)} tab {cuts[:4]}')
                # 5. provider, card, comandi: Panoramica, Progetti e Consumi con i «Altri N» aperti
                prov, out, taps, leak, heads, names, cuts_open = [], [], [], [], [], [], []
                for t in TABS:
                    goto_tab(pg, t)
                    # tutto aperto: details e rami delle cartelle (giro 9: «Parte dei t» tagliata si vedeva solo a card aperta)
                    pg.evaluate("document.querySelectorAll('.tab.on details').forEach(d => d.open = true); document.querySelectorAll('.tab.on tr.brr').forEach(r => r.hidden = false)")
                    pg.wait_for_timeout(150)
                    pg.add_script_tag(content=CLIP_JS)
                    cuts_open += [t + ':' + x['k'] + ' ' + x['s'] for x in pg.evaluate('__clip()')]
                    pg.add_script_tag(content=CHECKS_JS)
                    prov += [t + ': ' + x for x in pg.evaluate('__provLabels()')]
                    out += [t + ': ' + x for x in pg.evaluate('__contained()')]
                    leak += [t + ': ' + x for x in pg.evaluate('__internal()')]
                    names += [t + ': ' + x for x in pg.evaluate('__names()')]
                    heads += [t + ': ' + x for x in pg.evaluate('__tableHeads()')]
                    if w <= 560:
                        taps += [t + ': ' + x for x in pg.evaluate('__taps(44)')]
                check(not cuts_open, f'{w}px nessun testo tagliato né card che scorre con tutto aperto {cuts_open[:4]}')
                # 8. la fascia della demo resta in vista dopo aver scorso fino in fondo
                band = []
                for t in ('overview', 'automations', 'usage'):
                    goto_tab(pg, t)
                    pg.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)'); pg.wait_for_timeout(200)
                    pg.add_script_tag(content=CHECKS_JS)
                    band += [t + ': ' + x for x in pg.evaluate('__band()')]
                    pg.evaluate('window.scrollTo(0, 0)')
                check(not band, f'{w}px fascia ESEMPIO in vista dopo lo scorrimento {band}')
                check(not prov, f'{w}px ogni numero di consumo ha il suo provider {prov[:4]}')
                check(not out, f'{w}px nessuna cella fuori dalla sua card {out[:4]}')
                check(not leak, f'{w}px nessun testo interno (OpenClaw, mcp__, percorsi, id) su {len(TABS)} tab {leak[:4]}')
                check(not heads, f'{w}px ogni tabella ha le intestazioni delle colonne {heads[:4]}')
                check(not names, f'{w}px ogni campo ha un nome vero (non il placeholder) {names[:4]}')
                dimn = pg.evaluate("location.hash='overview', new Promise(r => setTimeout(() => r(document.querySelectorAll('#t-overview tr.dim, #t-projects tr.dim').length), 1500))")
                check(dimn >= 1, f'{w}px c\'è un progetto fermo da misurare ({dimn} righe .dim)')
                pg.add_script_tag(content=CHECKS_JS)
                dc = pg.evaluate('__dimContrast(4.5)')
                check(dc['n'] >= 1 and not dc['bad'], f"{w}px righe spente (.dim): contrasto misurato almeno 4,5:1 su {dc['n']} testi {dc['bad']}")
                # Sessioni e Consumi disegnati con i dati del proxy finto, non vuoti
                goto_tab(pg, 'sessions')
                ns = pg.evaluate("document.querySelectorAll('#t-sessions .card').length")
                check(ns >= 3, f'{w}px Sessioni disegnata con dati ({ns} schede)')
                pg.add_script_tag(content=CHECKS_JS)
                st = pg.evaluate('__sessionTexts()')
                check(not st['bad'] and st['it'] >= 2 and st['na'] >= 1, f"{w}px Sessioni: ogni riassunto è italiano, gli altri «non disponibile» ({st['it']} italiani, {st['na']} non disponibili) {st['bad'][:4]}")
                # Attive = sessioni vive dell'hub (/api/live), badge compreso; il luogo è il titolo, non la cartella
                sv = pg.evaluate("""async () => { const lv = await (await fetch('/api/live')).json();
                  const n = lv.projects.reduce((t, p) => t + ((p.agents && p.agents.list) || []).length, 0);
                  const h = [...document.querySelectorAll('#t-sessions h2')].map(x => x.textContent).find(x => /^Attive/.test(x)) || '';
                  const t = document.getElementById('t-sessions').innerText;
                  return { n, h, badge: document.getElementById('nsess').textContent, title: t.includes('Prova del 22/10'), raw: /scratch-\\d{4}/.test(t) }; }""")
                check(sv['n'] >= 3 and sv['h'] == f"Attive ({sv['n']})" and sv['badge'] == str(sv['n']), f"{w}px Sessioni: Attive e badge contano le {sv['n']} sessioni di /api/live ({sv['h']!r}, badge {sv['badge']!r})")
                # Attività: nessuna chiave grezza del proxy (priority-set, account-cap, upstream-retry…)
                goto_tab(pg, 'activity'); pg.wait_for_selector('#t-activity table', timeout=20000)
                raw = pg.evaluate("[...new Set((document.getElementById('t-activity').innerText.match(/\\b[a-z]+(?:[-_][a-z0-9]+)+\\b/g) || []))]")
                # nessun nome interno di profilo (prof-a, auto-2) dove c'è un'etichetta: la pagina mostra l'email
                inner = pg.evaluate("""async () => { const pr = await (await fetch('/vdm/api/profiles')).json();
                  const t = document.getElementById('t-activity').innerText;
                  return { names: pr.profiles.filter(p => p.label && p.label !== p.name).length, hit: pr.profiles.filter(p => p.label && p.label !== p.name && t.includes(p.name)).map(p => p.name) }; }""")
                check(inner['names'] >= 1 and not inner['hit'], f"{w}px Attività: account per etichetta, nessun nome interno del profilo ({inner['names']} profili con etichetta) {inner['hit']}")
                check(not raw, f'{w}px Attività: eventi in italiano, nessuna chiave grezza {raw[:4]}')
                gen = pg.evaluate("(document.getElementById('t-activity').innerText.match(/Evento del proxy[^\\n]*/g) || []).slice(0, 3)")
                check(not gen, f'{w}px Attività: ogni evento della demo ha la sua frase, nessuno ricade su «Evento del proxy» {gen}')
                check(sv['title'] and not sv['raw'], f"{w}px Sessioni: il luogo è il titolo («Prova del 22/10»), non la cartella scratch-… (titolo {sv['title']}, grezzo {sv['raw']})")
                goto_tab(pg, 'usage'); pg.wait_for_selector('#usage-main table', timeout=20000)
                nu = pg.evaluate("document.querySelectorAll('#usage-main table tbody tr').length")
                check(nu >= 4, f'{w}px Consumi disegnata con dati ({nu} righe)')
                pg.add_script_tag(content=CHECKS_JS)
                uq = pg.evaluate("async () => __usageQuota(await (await fetch('/api/pace')).json())")
                nq = pg.evaluate("[...document.querySelectorAll('#t-usage th')].filter(h => /quota della settimana/i.test(h.textContent)).length")
                check(not uq and nq >= 1, f'{w}px Consumi: «Quota della settimana» per account uguale a pace ({nq} colonne) {uq}')
                # un indirizzo email sta su una riga (a 375 «attilio@guedado.i / t» si spezzava a metà, giro 9)
                split = pg.evaluate("""[...document.querySelectorAll('#t-usage td, #t-usage th[scope=row]')].filter(td => /@/.test(td.textContent)).map(td => {
                  // solo il testo dell'indirizzo: il pallino colorato accanto ha un'altra altezza e non è un a capo
                  const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT); let n, bad = false;
                  while ((n = w.nextNode())) { if (!/@/.test(n.data)) continue; const r = document.createRange(); r.selectNodeContents(n);
                    const tops = [...r.getClientRects()].filter(x => x.width > 1).map(x => x.top); if (tops.length && Math.max(...tops) - Math.min(...tops) > 4) bad = true; }
                  return bad ? td.textContent.trim().slice(0, 40) : null; }).filter(Boolean)""")
                check(not split, f'{w}px Consumi: ogni email su una riga {split[:3]}')
                if w <= 560:
                    check(not taps, f'{w}px comandi alti almeno 44 px ({len(taps)} sotto) {taps[:5]}')
                if axe:
                    v = axe_tabs(pg, axe, AXE_TABS)
                    check(not v, f'{w}px axe su {len(AXE_TABS)} tab in chiaro: nessuna violazione seria {v[:4]}')
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
                        skl = pg.evaluate("!!document.querySelector('.cx-panel .cx-graph .au-skl')")
                        check(skl, f'{w}px pannello: mentre lo schema arriva c\'è il suo scheletro (non un pannello che sembra finito)')
                        check(wait_loaded(pg, 4), f'{w}px pannello: lo schema arriva entro 4 s (non 40)')
                        drawn = pg.evaluate("document.querySelectorAll('.cx-panel .cx-graph .gflow li').length")
                        check(drawn >= 3, f'{w}px pannello: lo schema della voce è disegnato ({drawn} passi)')
                        pg.wait_for_timeout(300)
                        pg.add_script_tag(content=CHECKS_JS)
                        cov = pg.evaluate("__onTop('.cx-panel [data-cx-close]')")
                        check(not cov, f'{w}px pannello: «Chiudi» si clicca, niente sopra {cov}')
                        pg.evaluate("(document.querySelector('.cx-panel') || {}).scrollTop = 99999"); pg.wait_for_timeout(150)
                        bp = pg.evaluate('__band()')
                        check(not bp, f'{w}px pannello aperto: fascia ESEMPIO in vista {bp}')
                        if w <= 560:
                            pt = pg.evaluate("__taps(44, '.cx-panel')")
                            ng = pg.evaluate("document.querySelectorAll('.cx-panel details.gmore > summary').length")
                            check(ng >= 1, f'{w}px pannello: c\'è un «Mostra domanda e risposta» da misurare ({ng})')
                            check(not pt, f'{w}px pannello: comandi di almeno 44×44 px {pt[:5]}')
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
                # 4. in scuro: contrasto e il resto di axe
                if axe:
                    pd = new_ctx(b, viewport={'width': w, 'height': 900}, color_scheme='dark').new_page()
                    pd.add_init_script(DEAD_JS)
                    pd.set_default_timeout(90000)
                    pd.goto(url + '/#overview', wait_until='domcontentloaded')
                    v = axe_tabs(pd, axe, AXE_TABS)
                    check(not v, f'{w}px axe su {len(AXE_TABS)} tab in scuro: nessuna violazione seria {v[:4]}')
                    provd = []
                    for t in ('overview', 'projects', 'usage'):
                        goto_tab(pd, t); pd.evaluate("document.querySelectorAll('.tab.on details').forEach(d => d.open = true)"); pd.add_script_tag(content=CHECKS_JS)
                        provd += [t + ': ' + x for x in pd.evaluate('__provLabels()')]
                    check(not provd, f'{w}px in scuro ogni numero di consumo ha il suo provider {provd[:4]}')
                    dimd = pd.evaluate("location.hash='overview', new Promise(r => setTimeout(r, 1500))") or []
                    pd.add_script_tag(content=CHECKS_JS)
                    dcd = pd.evaluate('__dimContrast(4.5)')
                    check(dcd['n'] >= 1 and not dcd['bad'], f"{w}px in scuro righe spente (.dim): contrasto misurato almeno 4,5:1 su {dcd['n']} testi {dcd['bad']}")
                    links = []
                    for t in ('overview', 'projects', 'journal', 'services'):
                        goto_tab(pd, t); pd.add_script_tag(content=CHECKS_JS)
                        links += [t + ': ' + x for x in pd.evaluate('__inlineLinks()')]
                    check(not links, f'{w}px in scuro i link nel testo si distinguono (sottolineati o 3:1) {links[:3]}')
                    # e il pannello aperto in scuro (il chip «Rotta» perdeva contrasto solo lì)
                    goto_tab(pd, 'automations')
                    pd.locator('#t-automations .cx-row[data-cx]:not(.cx-hdr)').first.click(); pd.wait_for_selector('.cx-panel'); wait_loaded(pd)
                    pd.evaluate("document.querySelectorAll('.cx-panel .cx-chip').forEach(c => { const r = c.cloneNode(true); r.className = 'cx-chip rotto'; const t = c.cloneNode(true); t.className = 'cx-chip te'; c.after(r, t); })")
                    pd.add_script_tag(content=axe)
                    vp = pd.evaluate(AXE_RUN)
                    check(not vp, f'{w}px axe sul pannello aperto in scuro (chip Ok, Ti aspetta, Rotta): nessuna violazione seria {vp[:4]}')
                    pd.context.close()
            # 6. badge dentro il bottone dove la nav è una griglia
            for w in (328, 520, 560, 700, 820, 959):   # dove la griglia della nav stringe i bottoni al minimo (328: il badge a 3 cifre sporge di 6 px)
                pg = new_ctx(b, viewport={'width': w, 'height': 900}).new_page()
                pg.goto(url + '/#overview', wait_until='domcontentloaded')
                pg.wait_for_selector('#nwait:not([hidden])', timeout=60000)
                pg.add_script_tag(content=CHECKS_JS)
                for n in ('3', '88', '188'):   # anche con 2 e 3 cifre
                    pg.evaluate(f"document.getElementById('nwait').textContent = '{n}'"); pg.wait_for_timeout(50)
                    bb = pg.evaluate('__badge()')
                    check(not bb, f'{w}px badge «{n}» di «Ti aspetta» dentro il bottone {bb}')
                pg.context.close()
            # 7. Panoramica lenta: la barra deve aspettare la pagina vera, non fotografare il segnaposto
            pg = new_ctx(b, viewport={'width': 1440, 'height': 900}).new_page()
            pg.set_default_timeout(90000)
            # ritardo nella pagina, non in Python: un route che dorme blocca Playwright e la barra guarderebbe a dati arrivati
            pg.add_init_script("(() => { const f = window.fetch; window.fetch = (u, o) => { const s = String(u), ms = s.includes('/api/attesa') ? 6000 : s.includes('/api/live') ? 12000 : 0;"
                               " return ms ? new Promise((r) => setTimeout(r, ms)).then(() => f(u, o)) : f(u, o); }; })()")
            pg.goto(url + '/#overview', wait_until='domcontentloaded')
            done = wait_loaded(pg, 60)
            real = pg.evaluate("!!document.querySelector('#t-overview section.status') && !/Carico quote/.test(document.getElementById('t-overview').innerText)")
            check(done and real, f'Panoramica lenta (attesa +6 s, live +12 s): la barra aspetta la pagina vera (caricata {done}, vera {real})')
            pg.context.close()
            # 7b. Mac lento a freddo (+8 s): il resto della Panoramica c'è entro 3 s, il Mac arriva nel suo riquadro
            pg = new_ctx(b, viewport={'width': 1440, 'height': 900}).new_page()
            pg.add_init_script("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/mac') ? new Promise((r) => setTimeout(r, 8000)).then(() => f(u, o)) : f(u, o); })()")
            pg.goto(url + '/#overview', wait_until='domcontentloaded'); pg.wait_for_timeout(3000)
            early = pg.evaluate("({ status: !!document.querySelector('#t-overview section.status'), mac: !!document.querySelector('#t-overview [data-sec=mac] [data-loading]') })")
            check(early['status'] and early['mac'], f'Panoramica col Mac lento (+8 s): a 3 s c\'è già lo stato, il Mac ha il suo segnaposto {early}')
            macok = wait_loaded(pg, 20) and pg.evaluate("!!document.querySelector('#t-overview [data-sec=mac] section, #t-overview [data-sec=mac] .mac, #t-overview [data-sec=mac] *:not(p)')")
            check(macok, f'Panoramica col Mac lento: il blocco Mac arriva ({macok})')
            pg.context.close()
            # 7c. «Ti aspetta» lenta a freddo (+26 s, come sul vivo al giro 9): il resto c'è entro 3 s, poi arrivano TUTTE
            # le voci di /api/attesa, una tessera per voce con il suo titolo (un mutante che ne mostra una sola cade)
            pg = new_ctx(b, viewport={'width': 1440, 'height': 900}).new_page()
            pg.add_init_script("(() => { const f = window.fetch; window.fetch = (u, o) => String(u).includes('/api/attesa') ? new Promise((r) => setTimeout(r, 26000)).then(() => f(u, o)) : f(u, o); })()")
            pg.goto(url + '/#overview', wait_until='domcontentloaded'); pg.wait_for_timeout(3000)
            early = pg.evaluate("({ status: !!document.querySelector('#t-overview section.status'), wait: !!document.querySelector('#t-overview [data-sec=wait] [data-loading]') })")
            check(early['status'] and early['wait'], f'Panoramica con «Ti aspetta» lenta (+26 s): a 3 s c\'è già lo stato, «Ti aspetta» ha il suo segnaposto {early}')
            arrived = wait_loaded(pg, 40)
            tiles = pg.evaluate("""async () => { const d = await new Promise((r) => { const x = new XMLHttpRequest(); x.open('GET', '/api/attesa'); x.onload = () => r(JSON.parse(x.responseText)); x.send(); });
              const shown = [...document.querySelectorAll('#t-overview [data-sec=wait] article.tile.wait .tile-t')].map(h => h.textContent.trim());
              return { api: d.items.length, shown: shown.length, missing: d.items.map(i => i.title).filter(t => !shown.includes(t)).slice(0, 3) }; }""")
            check(arrived and tiles['api'] >= 2 and tiles['shown'] == tiles['api'] and not tiles['missing'], f"«Ti aspetta» mostra tutte le voci di /api/attesa ({tiles['shown']} su {tiles['api']}) {tiles['missing']}")
            pg.context.close()
            b.close()
    finally:
        proc.terminate(); proc.wait(15)  # SIGTERM: la demo toglie la sua cartella
    print('UI ROSSA: ' + '; '.join(red) if red else 'UI VERDE')
    sys.exit(1 if red else 0)


if __name__ == '__main__':
    main()
