#!/usr/bin/env python3
"""Suno via API autenticata — senza browser, senza UI, senza captcha.

Schema verificato il 20/08 h22 intercettando la richiesta vera della UI
(capture_payload.py, POST abortita: zero crediti):
  host      studio-api-prod.suno.com      <- trattino, non 'studio-api.prod'
  endpoint  POST /api/generate/v2-web/
  body      PIATTO: prompt/tags/title/negative_tags/mv + generation_type:'TEXT'
  captcha   token: null  -> nessun Turnstile su questa via
  headers   browser-token = base64({"timestamp": ms}), device-id = uuid stabile

Il JWT di Clerk dura ~60 s e si conia dai cookie __client (nessun jbrowser):
  GET  clerk.suno.com/v1/client            -> session id
  POST clerk.suno.com/v1/client/sessions/<sid>/tokens -> jwt

Uso:  suno_api.py brief.json [--dry]
"""
import json, sys, os, time, base64, uuid, pathlib, urllib.request, urllib.error

BASE = pathlib.Path(__file__).resolve().parent
# uno stato e UN SOLO device-id per tutte le sessioni: tre id diversi sullo stesso
# account sono esattamente cio' che fa scattare i controlli anti-abuso
STATE = pathlib.Path(os.environ.get('SUNO_STATE',
    os.path.expanduser('~/.claude/jarvis/state/browser-states/sunostate.json')))
DEVICE = pathlib.Path(os.environ.get('SUNO_DEVICE_ID_FILE',
    os.path.expanduser('~/.claude/jarvis/state/suno-device-id')))
GEN = 'https://studio-api-prod.suno.com/api/generate/v2-web/'
FEED = 'https://studio-api-prod.suno.com/api/feed/v2?page=0'
CLERK = 'https://clerk.suno.com/v1'
CV = '__clerk_api_version=2021-02-05&_clerk_js_version=5.35.1'


def _cookie_header():
    ck = json.load(open(STATE))['cookies']
    return '; '.join(f"{c['name']}={c['value']}" for c in ck if c['name'].startswith('__client'))


def _open(req, timeout=60):
    for k in range(5):
        try:
            return json.load(urllib.request.urlopen(req, timeout=timeout))
        except urllib.error.HTTPError as e:
            if e.code == 429 and k < 4:      # oltre ~6 chiamate Suno rallenta: si aspetta
                time.sleep(8 * (k + 1)); continue
            raise


def token():
    """JWT fresco. Va richiamato prima di OGNI chiamata: vive ~60 s."""
    ch = _cookie_header()
    h = {'Cookie': ch, 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://suno.com'}
    d = _open(urllib.request.Request(f'{CLERK}/client?{CV}', headers=h), 30)
    sess = (d.get('response') or {}).get('sessions') or []
    active = [s for s in sess if s.get('status') == 'active']
    if not active:
        sys.exit('nessuna sessione Clerk attiva: rifai import-chrome / login su Suno')
    sid = active[0]['id']
    t = _open(urllib.request.Request(f'{CLERK}/client/sessions/{sid}/tokens?{CV}',
                                     data=b'', headers=h), 30)
    return t.get('jwt') or (t.get('response') or {}).get('jwt')


def device_id():
    if not DEVICE.exists():
        DEVICE.write_text(str(uuid.uuid4()))
    return DEVICE.read_text().strip()


# La UI manda anche user-agent completo e client hints. Replicarli e' emulazione del
# client ufficiale: si fa SOLO sul proprio account e con via libera esplicita dell'utente
# (Attilio, 21/08). Vedi la nota "quando risponde 422" in SKILL.md.
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36')
CH = {'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
      'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"'}
USER_TIER = os.environ.get('SUNO_USER_TIER', '3eaebef3-ef46-446a-931c-3d50cd1514f1')


def headers():
    # browser-token: JSON COMPATTO come lo manda il browser, non con gli spazi di json.dumps
    inner = base64.b64encode(json.dumps({'timestamp': int(time.time() * 1000)},
                                        separators=(',', ':')).encode()).decode()
    h = {'Authorization': f'Bearer {token()}', 'content-type': 'application/json',
         'accept': '*/*', 'accept-language': 'en', 'User-Agent': UA,
         'Origin': 'https://suno.com', 'Referer': 'https://suno.com/',
         'device-id': device_id(),
         'browser-token': json.dumps({'token': inner}, separators=(',', ':'))}
    h.update(CH)
    return h


def feed():
    return _open(urllib.request.Request(FEED, headers=headers()))


def generate(brief):
    """Corpo identico a quello della UI, campo per campo: i None espliciti e i campi
    'inutili' fanno parte dello schema che il server valida."""
    body = {'token': None, 'generation_type': 'TEXT',
            'title': brief['title'], 'tags': brief['tags'],
            'negative_tags': brief.get('negative_tags', ''),
            'mv': brief.get('mv', 'chirp-fenix'), 'prompt': brief['prompt'],
            'make_instrumental': bool(brief.get('make_instrumental', False)),
            'user_uploaded_images_b64': None,
            'metadata': {'web_client_pathname': '/create', 'is_max_mode':
                         bool(brief.get('max_mode', False)), 'is_mumble': False,
                         'create_mode': 'custom', 'user_tier': USER_TIER,
                         'create_session_token': str(uuid.uuid4()),
                         'disable_volume_normalization': False},
            'override_fields': [], 'cover_clip_id': None, 'cover_start_s': None,
            'cover_end_s': None, 'persona_id': None, 'artist_clip_id': None,
            'artist_start_s': None, 'artist_end_s': None, 'continue_clip_id': None,
            'continued_aligned_prompt': None, 'continue_at': None,
            'transaction_uuid': str(uuid.uuid4()), 'token_provider': None,
            'lyrics_project_id': brief.get('lyrics_project_id')}
    req = urllib.request.Request(GEN, data=json.dumps(body).encode(), headers=headers())
    return _open(req)


def wait_and_download(ids, outdir=None, every=15, tries=60):
    outdir = pathlib.Path(outdir or os.environ.get('SUNO_OUT') or BASE)
    outdir.mkdir(parents=True, exist_ok=True)
    for _ in range(tries):
        time.sleep(every)
        clips = {c['id']: c for c in feed().get('clips', []) if c['id'] in ids}
        st = [clips.get(i, {}).get('status', '?') for i in ids]
        print('  stato:', st, flush=True)
        if all(s in ('complete', 'error') for s in st) and '?' not in st:
            break
    done = []
    for i in ids:
        c = clips.get(i, {})
        if c.get('status') != 'complete':
            continue
        url = c.get('audio_url') or f'https://cdn1.suno.ai/{i}.mp3'
        dst = pathlib.Path(outdir) / f'{i}.mp3'
        urllib.request.urlretrieve(url, dst)
        print('  scaricato', dst.name, dst.stat().st_size // 1024, 'KB', flush=True)
        done.append(str(dst))
    return done


if __name__ == '__main__':
    if '--dry' in sys.argv:                      # solo lettura: verifica auth, non spende
        d = feed()
        cl = d.get('clips', [])
        print(f'auth ok · {len(cl)} clip in feed')
        for c in cl[:5]:
            print(f"  {c['created_at'][:16]}  {c['status']:<9} {c.get('title')}")
        sys.exit()
    brief = json.load(open(sys.argv[1]))
    out = sys.argv[2] if len(sys.argv) > 2 else None
    r = generate(brief)
    ids = [c['id'] for c in r['clips']]
    print('generazione avviata:', ids, flush=True)
    wait_and_download(ids, out)
