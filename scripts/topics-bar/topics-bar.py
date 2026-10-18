#!/usr/bin/env python3
"""topics-bar — Topics e' meglio o peggio dell'app nativa di Claude Code? Una barra, sempre uguale.

Solo lettura: transcript di Claude Code, DB di Topics (mode=ro), processi, disco. Esce col numero
di goal falliti (0 = tutto verde). Le soglie sono scritte qui sotto una volta sola: cambiarle e'
una decisione, non una correzione.

Uso: topics-bar.py [--days 14] [--json OUT]
"""
import argparse, glob, json, os, re, sqlite3, statistics as st, subprocess, sys, time
from collections import Counter
from datetime import datetime, timedelta, timezone
from multiprocessing import Pool

HOME = os.path.expanduser('~')
TOPICS_DIR = os.environ.get('TOPICS_APP_DIR', f'{HOME}/Projects/topics-app')
DATA_DIR = os.environ.get('TOPICS_DATA_DIR', f'{TOPICS_DIR}/data')
DB = f'{DATA_DIR}/topics.db'
PROJECTS = f'{HOME}/.claude/projects'
HOME_SLUG = HOME.replace('/', '-')

# Soglie (14/10/2026). Il riferimento nativo e' misurato nella stessa finestra, non scritto a mano.
TOKEN_COST_MAX_RATIO = 1.02      # costo per 1k token di contesto (solo Opus): Topics <= nativo +2%
CACHE_READ_MIN_DELTA = -0.5      # punti percentuali di cache letta rispetto al nativo
PREAMBLE_WASTE_MAX_PCT = 0.5     # costo dei <context> ri-iniettati, in % del costo delle chat
ONESHOT_PREFIX_MAX = 6000        # token di prefisso mediano di un completamento usa-e-getta
ONESHOT_DAY_MAX = 200            # oltre e' un giro impazzito (09-12/10: fino a 388 card al giorno)
STACK_RAM_MAX_MB = 1200          # Claude.app misurata il 14/10: 1.156 MB su 15 processi
DATA_DIR_MAX_RATIO = 3.0         # cartella dati <= 3x il DB vivo (il 14/10: 25x, 7,7 GB di backup)
ORPHAN_MAX = 0                   # processi orfani (ppid 1, > 24 h) legati a Topics o alla CLI

# Costo in "unita' input": stessi rapporti su tutti i modelli Claude (scrittura 5m 1,25x, 1h 2x,
# lettura 0,1x, output 5x). Confronta classi senza dipendere dal listino.
def cost(u):
    cc = u.get('cache_creation_input_tokens') or 0
    c1 = (u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens') or 0
    return ((u.get('input_tokens') or 0) + (cc - c1) * 1.25 + c1 * 2
            + (u.get('cache_read_input_tokens') or 0) * 0.1 + (u.get('output_tokens') or 0) * 5)

CTX = re.compile(r'<context[\s>].*?</context>', re.S)


def topics_session_ids():
    c = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    ids = set()
    for sid, p in c.execute('select claude_session_id, jsonl_path from claude_code_sessions'):
        if sid: ids.add(sid)
        if p: ids.add(os.path.basename(p)[:-6])
    pty = {r[0] for r in c.execute('select claude_session_id from terminal_sessions where claude_session_id is not null')}
    return ids, pty


def scan(args):
    """Una sessione top-level: classe, chiamate API (dedup per message.id), preamboli, compattazioni."""
    path, since, tids, ptyids = args
    sid = os.path.basename(path)[:-6]
    proj = os.path.basename(os.path.dirname(path))
    ep = None; topics_mcp = False; seen = {}
    calls = []; events = []; first_prompt = None; first_ts = None
    try:
        fh = open(path, 'r', errors='replace')
    except OSError:
        return None
    with fh:
        for l in fh:
            # i tool mcp__topics__ compaiono nell'elenco dei tool differiti solo se Topics ha lanciato la sessione
            if not topics_mcp and '"deferred_tools_delta"' in l and 'mcp__topics__' in l:
                topics_mcp = True
            if '"compact_boundary"' in l:
                try:
                    d = json.loads(l)
                    if d.get('type') == 'system' and d.get('subtype') == 'compact_boundary':
                        events.append(('compact', d.get('timestamp') or ''))
                except Exception: pass
                continue
            if '"type":"user"' in l:
                try: d = json.loads(l)
                except Exception: continue
                ep = ep or d.get('entrypoint')
                if d.get('type') != 'user' or d.get('isMeta') or d.get('isCompactSummary'): continue
                c = (d.get('message') or {}).get('content')
                if isinstance(c, list):
                    if any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in c): continue
                    txt = ''.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('type') == 'text')
                else: txt = c or ''
                if not txt: continue
                if first_prompt is None: first_prompt, first_ts = txt[:80], d.get('timestamp') or ''
                m = CTX.search(txt)
                events.append(('turn', d.get('timestamp') or '', len(m.group(0)) if m else 0))
                continue
            if '"usage"' not in l: continue
            try: d = json.loads(l)
            except Exception: continue
            ep = ep or d.get('entrypoint')
            if d.get('type') != 'assistant': continue
            msg = d.get('message') or {}; u = msg.get('usage')
            if not u or msg.get('model') == '<synthetic>': continue
            mid = msg.get('id') or d.get('requestId')
            if mid in seen: continue
            seen[mid] = 1
            ts = d.get('timestamp') or ''
            ctx = (u.get('input_tokens') or 0) + (u.get('cache_creation_input_tokens') or 0) + (u.get('cache_read_input_tokens') or 0)
            calls.append(dict(ts=ts, model=msg.get('model', ''), ctx=ctx, cr=u.get('cache_read_input_tokens') or 0,
                              cost=cost(u)))
            events.append(('call', ts, cost(u)))
    if not calls: return None
    if 'topics-worktrees' in proj: k = 'topics-board'
    elif sid in tids: k = 'topics-chat'
    elif sid in ptyids or (ep == 'cli' and topics_mcp): k = 'topics-pty'
    elif topics_mcp: k = 'topics-chat'
    elif ep == 'cli': k = 'native-cli'
    elif ep == 'sdk-cli' and proj == HOME_SLUG and len(calls) <= 3: k = 'oneshot-home'
    else: k = 'other'
    win = [c for c in calls if c['ts'] >= since]
    if not win: return None
    return dict(k=k, calls=win, events=events if k == 'topics-chat' else None,
                first_ts=first_ts, first_prompt=first_prompt)


def preamble_waste(events, since):
    """Costo composto dei <context> oltre il primo turno e quelli dopo una compattazione."""
    free = True; waste = 0.0
    for i, e in enumerate(events):
        if e[0] == 'compact': free = True; continue
        if e[0] != 'turn': continue
        if e[1] < since:
            if e[2]: free = False
            continue
        if not e[2]: continue
        if free: free = False; continue
        tok = e[2] / 4
        after = 0
        for f in events[i + 1:]:
            if f[0] == 'compact': break
            if f[0] == 'call': after += 1
        waste += tok * 1.25 + tok * 0.1 * after
    return waste


def footprint_mb(pid):
    try:
        out = subprocess.run(['/usr/bin/footprint', '-p', str(pid)], capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return 0.0
    m = re.search(r'Footprint: ([\d.]+) (KB|MB|GB)', out)
    if not m: return 0.0
    v = float(m.group(1)); return v / 1024 if m.group(2) == 'KB' else v * 1024 if m.group(2) == 'GB' else v


def topics_stack_pids():
    """App Tauri + i suoi processi WebKit (lsappinfo li nomina «Topics …») + server, bridge, MCP."""
    pids = set()
    try:
        out = subprocess.run(['lsappinfo', 'list'], capture_output=True, text=True, timeout=20).stdout
        for block in re.split(r'\n(?=\s*\d+\) ")', out):
            name = re.match(r'\s*\d+\) "([^"]+)"', block)
            pid = re.search(r'pid = (\d+)', block)
            if name and pid and (name.group(1).startswith('Topics') or name.group(1) == 'AutoFill (Topics)'):
                pids.add(int(pid.group(1)))
    except Exception: pass
    for pat in ('topics-app/server.ts', 'server/ai-bridge.mjs', 'server/pty-bridge.mjs', 'topics-mcp-server.ts', 'topics-host'):
        r = subprocess.run(['pgrep', '-f', pat], capture_output=True, text=True)
        pids |= {int(x) for x in r.stdout.split()}
    return pids


def claude_app_mb():
    r = subprocess.run(['pgrep', '-f', '/Applications/Claude.app/'], capture_output=True, text=True)
    pids = [int(x) for x in r.stdout.split()]
    return (sum(footprint_mb(p) for p in pids), len(pids)) if pids else (None, 0)


def topics_tracked_pids():
    """I processi che Topics dichiara suoi (pannello Processi): staccati apposta, non orfani."""
    try:
        tok = json.load(open(f'{HOME}/.topics/daemon-state.json')).get('token', '')
        out = subprocess.run(['curl', '-sk', '--max-time', '5', '-H', f'Authorization: Bearer {tok}',
                              'https://127.0.0.1:3333/api/scripts'], capture_output=True, text=True).stdout
        return {int(s['pid']) for s in json.loads(out).get('scripts', []) if s.get('pid')}
    except Exception:
        return set()


def stdout_of(pid):
    """(tipo, nome) del fd 1 secondo lsof: 'unix'/'PIPE' con '->(none)' = chi leggeva e' morto."""
    out = subprocess.run(['lsof', '-a', '-p', str(pid), '-d', '1', '-F', 'tn'], capture_output=True, text=True).stdout
    t = re.search(r'^t(.*)$', out, re.M); n = re.search(r'^n(.*)$', out, re.M)
    return (t.group(1) if t else ''), (n.group(1) if n else '')


def dead_reader(pgid):
    """Il gruppo e' una pipeline che non legge piu' nessuno: un pezzo scrive su un socket o una pipe senza
    l'altro capo, oppure su un file nello scratchpad di una sessione il cui transcript tace da oltre 24 h."""
    members = subprocess.run(['pgrep', '-g', str(pgid)], capture_output=True, text=True).stdout.split()
    for m in members:
        typ, name = stdout_of(m)
        if typ in ('unix', 'PIPE') and name.endswith('(none)'):
            return True
        sess = re.search(r'/private/tmp/claude-\d+/[^/]+/([0-9a-f-]{36})/', name)
        if typ == 'REG' and sess:
            tr = glob.glob(f'{PROJECTS}/*/{sess.group(1)}.jsonl')
            if not tr or time.time() - max(os.path.getmtime(p) for p in tr) > 86400:
                return True
    return False


def orphans():
    """ppid 1, piu' di 24 h, comando che parla di Topics o pezzo della CLI (ugrep, tail, log stream dei Monitor),
    e nessuno legge piu' quello che scrive. I demoni dichiarati e i processi tracciati da Topics restano fuori."""
    daemons = ('server.ts', 'ai-bridge.mjs', 'pty-bridge.mjs', 'topics-host', 'start-prod.sh', 'server-watch',
               'Topics.app', 'fswatch')
    tracked = topics_tracked_pids()
    out = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,etime=,command='], capture_output=True, text=True).stdout
    found = []
    for line in out.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 5 or parts[1] != '1': continue
        pid, _, pgid, etime, cmd = parts
        if '-' not in etime or int(pid) in tracked: continue  # meno di un giorno, o Topics lo sa
        topical = re.search(r'topics|/claude/versions/|\.local/bin/claude\b|^ugrep |^tail -|^/usr/bin/log stream', cmd, re.I)
        if topical and not any(d in cmd for d in daemons) and dead_reader(pgid):
            found.append(f'{pid} {etime} {cmd[:110]}')
    return found


def du_bytes(path):
    try:
        out = subprocess.run(['du', '-sk', path], capture_output=True, text=True, timeout=120).stdout
        return int(out.split()[0]) * 1024
    except Exception:
        return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=14)
    ap.add_argument('--json')
    a = ap.parse_args()
    since_dt = datetime.now(timezone.utc) - timedelta(days=a.days)
    since = since_dt.strftime('%Y-%m-%dT%H:%M:%S')
    tids, ptyids = topics_session_ids()
    files = [p for p in glob.glob(f'{PROJECTS}/*/*.jsonl') if os.path.getmtime(p) >= since_dt.timestamp()]
    t0 = time.time()
    with Pool(4) as pool:
        recs = [r for r in pool.imap_unordered(scan, [(p, since, tids, ptyids) for p in files], chunksize=8) if r]
    by = {}
    for r in recs: by.setdefault(r['k'], []).append(r)

    def opus(klasses):
        cs = [c for k in klasses for r in by.get(k, []) for c in r['calls'] if 'opus' in c['model'].lower()]
        if len(cs) < 50: return None
        tot_ctx = sum(c['ctx'] for c in cs)
        return dict(calls=len(cs), cost_per_1k=1000 * sum(c['cost'] for c in cs) / max(1, tot_ctx),
                    read_pct=100 * sum(c['cr'] for c in cs) / max(1, tot_ctx))

    goals = []
    def goal(gid, label, ok, value, bar):
        goals.append(dict(id=gid, label=label, ok=ok, value=value, bar=bar))

    nat, top = opus(['native-cli']), opus(['topics-chat', 'topics-pty'])
    if nat and top:
        ratio = top['cost_per_1k'] / nat['cost_per_1k']
        goal('G1', 'token: costo per 1k di contesto (Opus) Topics vs CLI nativa', ratio <= TOKEN_COST_MAX_RATIO,
             f"{top['cost_per_1k']:.1f} vs {nat['cost_per_1k']:.1f} ({ratio:.3f}x)", f'<= {TOKEN_COST_MAX_RATIO}x')
        d = top['read_pct'] - nat['read_pct']
        goal('G1b', 'token: cache letta Topics vs CLI nativa', d >= CACHE_READ_MIN_DELTA,
             f"{top['read_pct']:.1f}% vs {nat['read_pct']:.1f}% ({d:+.1f} pp)", f'>= {CACHE_READ_MIN_DELTA:+} pp')
    else:
        goal('G1', 'token: confronto Topics vs CLI nativa', False, 'campione < 50 chiamate Opus per classe', 'servono dati')

    chats = by.get('topics-chat', [])
    w = sum(preamble_waste(r['events'], since) for r in chats)
    tot = sum(c['cost'] for r in chats for c in r['calls'])
    pct = 100 * w / max(1, tot)
    goal('G2', 'token: <context> ri-iniettati nelle chat', pct <= PREAMBLE_WASTE_MAX_PCT, f'{pct:.2f}% del costo chat',
         f'<= {PREAMBLE_WASTE_MAX_PCT}%')

    one = by.get('oneshot-home', [])
    if one:
        pre = st.median(c['ctx'] for r in one for c in r['calls'])
        per_day = Counter((r['first_ts'] or '')[:10] for r in one)
        peak_day, peak = per_day.most_common(1)[0]
        goal('G3', 'one-shot (titoli, giudici): prefisso mediano', pre <= ONESHOT_PREFIX_MAX, f'{int(pre):,} token, {len(one)} chiamate',
             f'<= {ONESHOT_PREFIX_MAX:,}')
        goal('G3b', 'one-shot: picco al giorno (giro impazzito)', peak <= ONESHOT_DAY_MAX, f'{peak} il {peak_day}', f'<= {ONESHOT_DAY_MAX}')

    pids = topics_stack_pids()
    stack = sum(footprint_mb(p) for p in pids)
    capp, cn = claude_app_mb()
    ref = f' (Claude.app adesso: {capp:,.0f} MB su {cn} processi)' if capp else ''
    goal('G4', 'RAM: stack Topics (app, WebKit, server, bridge, MCP)', 0 < stack <= STACK_RAM_MAX_MB,
         f'{stack:,.0f} MB su {len(pids)} processi{ref}', f'<= {STACK_RAM_MAX_MB:,} MB')

    db_live = sum(os.path.getsize(f) for f in (DB, DB + '-wal') if os.path.exists(f))
    data = du_bytes(DATA_DIR)
    r = data / max(1, db_live)
    goal('G5', 'disco: cartella dati vs DB vivo', r <= DATA_DIR_MAX_RATIO, f'{data/1e9:.1f} GB vs {db_live/1e9:.2f} GB ({r:.0f}x)',
         f'<= {DATA_DIR_MAX_RATIO:.0f}x')

    orph = orphans()
    goal('G6', 'processi orfani > 24 h (Topics o pezzi della CLI)', len(orph) <= ORPHAN_MAX, f'{len(orph)}', f'<= {ORPHAN_MAX}')

    print(f'topics-bar · finestra {a.days} giorni da {since[:10]} · {len(files)} transcript in {time.time()-t0:.0f}s')
    for g in goals:
        print(f"  {'OK  ' if g['ok'] else 'FAIL'} {g['id']:4} {g['label']:58} {g['value']}  [barra {g['bar']}]")
    for o in orph[:8]: print(f'       orfano: {o}')
    info = {k: dict(sessioni=len(v), chiamate=sum(len(r['calls']) for r in v)) for k, v in sorted(by.items())}
    print('  classi: ' + ' · '.join(f"{k} {v['sessioni']}s/{v['chiamate']}c" for k, v in info.items()))
    if a.json:
        os.makedirs(os.path.dirname(os.path.abspath(a.json)), exist_ok=True)
        json.dump(dict(at=datetime.now().isoformat(timespec='seconds'), days=a.days, goals=goals, classes=info,
                       orphans=orph), open(a.json, 'w'), indent=1, ensure_ascii=False)
    fails = sum(1 for g in goals if not g['ok'])
    sys.exit(min(fails, 125))


if __name__ == '__main__':
    main()
