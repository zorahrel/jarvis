#!/usr/bin/env python3
"""vis giuria: piu' modelli guardano lo stesso video alla cieca e scelgono da un elenco.

PERCHE'. Una lettura sola conferma quello che speri, per caso. Il 14-15/10 lo
stesso schiocco di dita e' stato letto «schiocco» una volta e «bla bla» cinque;
un pollice in su dato per buono, guardato grande, era una mano ad artiglio
girata. Il difetto non era il modello: era chiedergli una volta, con la
risposta gia' in bocca, e tenere la frase piu' bella.

Qui:
  - il lettore non sa cosa dovrebbe essere: descrive, poi sceglie UNA voce da
    un elenco rimescolato a ogni lettura (la posizione non conta);
  - ogni lettura la fa un modello diverso, e quando si puo' di piu' famiglie
    (Gemini guarda il video; tutti gli altri i fotogrammi con l'ora stampata:
    codex, modelli vision gratuiti OpenAI-compatibili `oai:<canale>/<modello>`
    su NIM / OpenRouter / Kilo, Muse `muse:`, e come ultima riserva Claude
    `claude:`, che non e' nell'elenco di default perche' consuma quota);
  - il controllo (--controllo, un video che NON e' il gesto) lo leggono gli
    stessi lettori con lo stesso elenco: se lo chiamano come l'atteso, la
    giuria tira a indovinare e il verdetto non vale;
  - il positivo (--positivo, il gesto senza dubbio, per esempio esagerato)
    pure: chi non riconosce nemmeno quello non vota, e se restano troppo
    pochi voti e' INCERTO, non ROSSO (i Flash-Lite non vedono i gesti fatti
    solo di movimento);
  - la stessa lettura dello stesso video non si rifa': e' in cache, cosi'
    rilanciare finche' esce verde non serve a niente.

Esce 0 VERDE, 1 ROSSO, 3 INCERTO (troppo pochi lettori vivi, o il controllo
letto come l'atteso), 64 uso sbagliato.

ESCE DALLA MACCHINA (Google, OpenAI): niente dati di persone vere.
"""
import argparse, base64, concurrent.futures as cf, datetime, hashlib, json, os, random, re
import shutil, subprocess, sys, tempfile, threading, time, urllib.error, urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

CACHE = Path.home() / ".cache" / "vis-giuria"
BASE = "https://generativelanguage.googleapis.com"
NONE_LABEL = "nessuno di questi, non si capisce"
# Prima i piu' forti e di famiglie diverse. Gli alias «latest» no: sono uno di
# questi con un altro nome, e due voti dello stesso modello non sono due voti.
# Ogni modello Gemini gratuito ha la sua quota del giorno (20 richieste i
# Flash, 500 i Flash-Lite): chi risponde 429 si salta fino al giorno dopo.
READERS = [
    "gemini-3.8-flash", "codex:gpt-6-luna",
    # senza Gemini bastano questi per 4 famiglie: openai, nvidia, meta, google (Gemma)
    "oai:nim/nvidia/nemotron-3.5-super-vl-120b-a12b", "oai:nim/meta/llama-3.2-90b-vision-instruct",
    "oai:nim/google/gemma-4-31b-it",
    "oai:or/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "oai:or/google/gemma-4-31b-it:free",
    "gemini-3.1-pro-preview", "gemini-3.7-flash",
    "gemini-robotics-er-2-preview", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview",
    "gemini-omni-1.1-flash", "gemma-4-31b-it", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
]
# muse: e' agentico e a volte risponde con un commento invece del JSON (15/10): esiste ma non e' nel default
# Entra da solo, dopo i gratuiti, se le famiglie vive sono meno di MIN_FAMILIES (consuma la quota Claude).
# Sonnet, non Haiku (Attilio, 15/10).
# Haiku 5.5 per primo (costa meno); Sonnet 5.5 solo se Haiku non risponde o non vede il positivo.
# Stessa famiglia «anthropic»: un voto solo.
AUTO_LAST = "claude:claude-haiku-5-5"
AUTO_SECOND = "claude:claude-sonnet-5-5"
MIN_FAMILIES = 4
# chi non legge il video intero: gli si danno i fotogrammi
FRAMES_ONLY = {"gemma-4-31b-it", "gemma-4-26b-a4b-it"}
# chi accetta UN'immagine sola (o la legge meglio cosi'): i fotogrammi vanno in un foglio unico
SHEET = ("oai:nim/meta/llama-3.2", "oai:or/nvidia/nemotron-3-nano-omni", "muse:", "claude:")
# canali OpenAI-compatibili: (base, dove sta la chiave). Mai in chiaro.
CHANNELS = {"nim": "https://integrate.api.nvidia.com/v1", "or": "https://openrouter.ai/api/v1",
            "kilo": "https://api.kilo.ai/api/gateway", "router": "http://127.0.0.1:18791/v1"}
VENDOR_FAMILY = {"nvidia": "nvidia", "meta": "meta", "meta-llama": "meta", "google": "google", "qwen": "alibaba",
                 "mistralai": "mistral", "z-ai": "zai", "zai-org": "zai", "thinkingmachines": "thinkingmachines"}


def family(reader):
    """due modelli della stessa famiglia non sono due voti indipendenti"""
    if reader.startswith("codex:"):
        return "openai"
    if reader.startswith("muse:"):
        return "meta"  # Muse Spark e' di Meta, come Llama
    if reader.startswith("claude:"):
        return "anthropic"
    if reader.startswith("oai:"):
        vendor = reader.split("/", 1)[1].split("/", 1)[0] if "/" in reader else ""
        return VENDOR_FAMILY.get(vendor, vendor or "oai")
    return "google"


def external(reader):
    """true se il lettore non passa dalla chiave Gemini"""
    return reader.startswith(("codex:", "oai:", "muse:", "claude:"))


def die(msg, code=64):
    print(f"vis giuria: {msg}", file=sys.stderr)
    sys.exit(code)


def labels_arg(v):
    """«a; b; c» oppure @file con una voce per riga"""
    if v.startswith("@"):
        return [l.strip() for l in Path(v[1:]).read_text().splitlines() if l.strip() and not l.startswith("#")]
    return [x.strip() for x in v.split(";") if x.strip()]


# --- la quota: chi ha risposto 429 oggi (il giorno di Google, a Los Angeles) ---
_state_lock = threading.Lock()


def _today():
    return datetime.datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()


def exhausted():
    f = CACHE / "esauriti.json"
    try:
        return set(json.loads(f.read_text()).get(_today(), []))
    except (OSError, ValueError):
        return set()


def mark_exhausted(reader):
    with _state_lock:
        f = CACHE / "esauriti.json"
        try:
            d = json.loads(f.read_text())
        except (OSError, ValueError):
            d = {}
        d = {_today(): sorted(set(d.get(_today(), [])) | {reader})}
        f.write_text(json.dumps(d))


# --- il video e i fotogrammi ---
def duration(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        die(f"non leggo la durata di {path}", 1)


def motion(path):
    """quanto cambia al massimo un fotogramma dal primo, in livelli di grigio medi (0-255) a 64x64"""
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", path, "-vf", "scale=64:64,format=gray", "-f", "rawvideo", "-"],
                         capture_output=True, stdin=subprocess.DEVNULL).stdout
    n = 64 * 64
    if len(raw) < 2 * n:
        return 0.0
    first = raw[:n]
    return max(sum(abs(a - b) for a, b in zip(first, raw[i:i + n])) / n for i in range(n, len(raw) - n + 1, n))


def frames(path, n, tmp):
    """n fotogrammi in fila su tutta la durata, almeno 448 px di lato, con l'ora stampata"""
    d = duration(path)
    files = []
    for i in range(n):
        t = round(d * (i + 0.5) / n, 2)
        f = Path(tmp) / f"f{i:02d}.png"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(t), "-i", path, "-frames:v", "1",
                        "-vf", "scale='max(448,iw)':-2:flags=lanczos", str(f)], stdin=subprocess.DEVNULL)
        if not f.exists():
            continue
        # l'ora aiuta a leggere il movimento; senza font il fotogramma va lo stesso
        subprocess.run(["magick", str(f), "-font", "/System/Library/Fonts/Supplemental/Arial.ttf", "-gravity", "NorthWest",
                        "-fill", "yellow", "-undercolor", "black", "-pointsize", "18", "-annotate", "+4+4", f"t={t}s", str(f)],
                       stderr=subprocess.DEVNULL)
        files.append((t, f))
    return files


# --- la domanda ---
def prompt(options, context, as_frames, n_frames=0):
    head = (f"You are shown {n_frames} frames taken in time order from one short clip (the time is printed top left). "
            "Look only at these images, do not search for files." if as_frames else "You are shown a short video clip.")
    letters = "\n".join(f"{chr(65 + i)}) {o}" for i, o in enumerate(options))
    return f"""{head}
{context}
Do not guess what it is meant to be: judge only what is visible.
1. Describe precisely what you see, in Italian, in one or two sentences: which fingers are extended and which are curled, where the thumb points, how the shape and the position change over time.
2. Choose the ONE option that best names what the clip shows. If none fits, choose the option that says so.
3. Report, in Italian, anything that looks wrong or unnatural (parts passing through each other, sudden jumps, impossible bends, a pose that looks broken or crooked). Leave it empty if nothing.
Options:
{letters}
Reply with JSON only: {{"descrizione": "...", "scelta": "<letter>", "seconda": "<letter or empty>", "sicurezza": <0-100>, "difetti": "..."}}"""


SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "descrizione": {"type": "STRING"}, "scelta": {"type": "STRING"}, "seconda": {"type": "STRING"},
        "sicurezza": {"type": "INTEGER"}, "difetti": {"type": "STRING"},
    },
    "required": ["descrizione", "scelta", "sicurezza", "difetti"],
}


class Skip(Exception):
    """questo lettore non c'e' (quota, modello assente, errore): si passa al prossimo"""


def parse(text):
    m = re.search(r"\{.*\}", text or "", re.S)
    if not m:
        raise Skip(f"risposta senza JSON: {(text or '')[:120]!r}")
    try:
        return json.loads(m.group(0))
    except ValueError:
        raise Skip(f"JSON rotto: {m.group(0)[:120]!r}")


def gemini(model, key, parts, use_schema=True):
    gen = {"temperature": 0.7}
    if use_schema:
        gen |= {"responseMimeType": "application/json", "responseSchema": SCHEMA}
    body = json.dumps({"contents": [{"parts": parts}], "generationConfig": gen}).encode()
    for attempt in range(2):
        rq = urllib.request.Request(f"{BASE}/v1beta/models/{model}:generateContent?key={key}", body,
                                    {"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(rq, timeout=240) as r:
                d = json.loads(r.read())
            return "".join(p.get("text", "") for p in d["candidates"][0]["content"]["parts"] if not p.get("thought"))
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors="replace")[:300]
            if e.code in (429, 404):
                mark_exhausted(model)
                raise Skip(f"{e.code}: quota finita o modello assente")
            if e.code == 400 and use_schema and re.search(r"json|schema|mime", msg, re.I):
                return gemini(model, key, parts, use_schema=False)
            if e.code == 400 and re.search(r"video|mime|unsupported", msg, re.I):
                raise Skip("NOVIDEO")
            if e.code in (500, 503) and attempt == 0:
                time.sleep(6)
                continue
            raise Skip(f"HTTP {e.code}: {msg[:160]}")
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError) as e:
            raise Skip(f"{type(e).__name__}: {str(e)[:160]}")
    raise Skip("occupato")


def channel_key(ch):
    """chiave del canale: Keychain, altrimenti il file env di jcode per NIM. Mai stampata."""
    if ch == "or":
        return subprocess.run(["security", "find-generic-password", "-s", "openrouter", "-w"],
                              capture_output=True, text=True).stdout.strip()
    if ch == "nim":
        k = subprocess.run(["security", "find-generic-password", "-s", "nvidia-nim", "-w"],
                           capture_output=True, text=True).stdout.strip()
        if k:
            return k
        env = Path.home() / "Library/Application Support/jcode/openai-compatible.env"
        try:
            for l in env.read_text().splitlines():
                if l.startswith("OPENAI_COMPAT_API_KEY="):
                    return l.split("=", 1)[1].strip().strip('"')
        except OSError:
            pass
    return ""


def oai(reader, images, q):
    """un modello vision dietro un endpoint OpenAI-compatibile: oai:<canale>/<modello>"""
    ch, _, model = reader[4:].partition("/")
    if ch not in CHANNELS or not model:
        raise Skip(f"canale sconosciuto: {ch!r}")
    key = channel_key(ch)
    if not key and ch in ("or", "nim"):
        raise Skip(f"nessuna chiave per {ch}")
    content = [{"type": "text", "text": q}] + [
        {"type": "image_url", "image_url": {"url": "data:image/" + ("jpeg" if str(f).endswith(".jpg") else "png") + ";base64," + base64.b64encode(Path(f).read_bytes()).decode()}}
        for f in images]
    # i modelli che ragionano consumano token prima di rispondere: tetto largo
    body = json.dumps({"model": model, "max_tokens": 6000, "temperature": 0.7,
                       "messages": [{"role": "user", "content": content}]}).encode()
    hdr = {"Content-Type": "application/json"} | ({"Authorization": f"Bearer {key}"} if key else {})
    rq = urllib.request.Request(CHANNELS[ch] + "/chat/completions", body, hdr)
    try:
        with urllib.request.urlopen(rq, timeout=240) as r:
            d = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise Skip(f"HTTP {e.code}: {e.read().decode(errors='replace')[:120]}")
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise Skip(f"{type(e).__name__}: {str(e)[:120]}")
    try:
        m = d["choices"][0]["message"]
        # a volte il modello che ragiona lascia la risposta solo nel ragionamento
        return m.get("content") or m.get("reasoning_content") or m.get("reasoning") or ""
    except (KeyError, IndexError, TypeError):
        raise Skip(f"risposta senza testo: {str(d)[:120]}")


FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def small(fr, tmp, width=640):
    """fotogrammi piu' leggeri per le API: i video sono spesso 1920 px e 20 PNG superano i 25 MB di NIM"""
    out = []
    for t, f in fr:
        g = Path(tmp) / (f.stem + ".jpg")
        p = subprocess.run(["magick", str(f), "-resize", f"{width}x", "-quality", "85", str(g)],
                           capture_output=True, stdin=subprocess.DEVNULL)
        out.append(g if p.returncode == 0 and g.exists() else f)
    return out


def sheet(fr, tmp):
    """tutti i fotogrammi in un foglio unico (per chi accetta una sola immagine)"""
    out = Path(tmp) / "foglio.jpg"
    cols = 4 if len(fr) > 9 else 3
    p = subprocess.run(["magick", "montage"] + [str(f) for _, f in fr] + ["-font", FONT, "-tile", f"{cols}x", "-geometry", "448x+3+3",
                        "-background", "black", "-quality", "85", str(out)], capture_output=True, stdin=subprocess.DEVNULL)
    if p.returncode != 0 or not out.exists():
        raise Skip("montage fallito")
    return out


def agent_cli(reader, fr, tmp, q):
    """muse: (Muse Spark 1.3 via OpenCode Zen) e claude: leggono il foglio dei fotogrammi da una cartella vuota"""
    sh = sheet(fr, tmp)
    q = (q.replace("Look only at these images, do not search for files.", "")
         + f"\nThe frames are tiled in time order in ONE image file, {sh.resolve()}: "
           "read that file, and nothing else. Your final message must be the JSON object and nothing else: no comments before or after it.")
    if reader.startswith("muse:"):
        exe = shutil.which("opencode") or "/opt/homebrew/bin/opencode"
        # l'abbonamento Muse e' a quota: si usa il canale gratuito di Zen, quello della riserva di museagent
        args = [exe, "run", "-m", "opencode/" + reader[5:] + "-contributor-free", q]
    else:
        exe = shutil.which("claude")
        if not exe:
            raise Skip("claude non installato")
        # --add-dir e --allowedTools sono variadici: il prompt va prima, o se li mangiano
        args = [exe, "-p", q, "--model", reader[7:], "--allowedTools", "Read", "--add-dir", str(tmp)]
    p = subprocess.run(args, cwd=tmp, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
    if p.returncode != 0 or not p.stdout.strip():
        raise Skip(f"{reader.split(':')[0]} esce {p.returncode}: {(p.stderr or p.stdout or '')[-160:]}")
    return p.stdout


def read_once(reader, video, options, context, fps, n_frames, key):
    """una lettura: (risposta grezza in dict). Solleva Skip se il lettore non c'e'."""
    as_frames = external(reader) or reader in FRAMES_ONLY
    with tempfile.TemporaryDirectory(prefix="giuria-") as tmp:
        if as_frames:
            fr = frames(video, n_frames, tmp)
            if not fr:
                raise Skip("nessun fotogramma")
            q = prompt(options, context, True, len(fr))
            if reader.startswith("codex:"):
                if not shutil.which("codex"):
                    raise Skip("codex non installato")
                args = ["codex", "exec", "-m", reader.split(":", 1)[1], "--skip-git-repo-check", "-s", "read-only"]
                for _, f in fr:
                    args += ["-i", str(f)]
                out = Path(tmp) / "out.txt"
                # in una cartella vuota: altrimenti codex va a frugare nel repo da cui lo si chiama
                p = subprocess.run(args + ["-o", str(out), q], cwd=tmp, stdin=subprocess.DEVNULL,
                                   capture_output=True, text=True, timeout=600)
                if p.returncode != 0 or not out.exists():
                    raise Skip(f"codex esce {p.returncode}: {(p.stderr or '')[-160:]}")
                return parse(out.read_text())
            if reader.startswith("oai:"):
                imgs = [sheet(fr, tmp)] if reader.startswith(SHEET) else small(fr, tmp)
                return parse(oai(reader, imgs, q))
            if reader.startswith(("muse:", "claude:")):
                return parse(agent_cli(reader, fr, tmp, q))
            parts = []
            for t, f in fr:
                parts += [{"text": f"t={t}s"}, {"inline_data": {"mime_type": "image/png", "data": base64.b64encode(f.read_bytes()).decode()}}]
            return parse(gemini(reader, key, parts + [{"text": q}]))
        data = Path(video).read_bytes()
        if len(data) > 18 * 1024 * 1024:
            raise Skip("video oltre 18 MB: accorcialo o abbassa la qualita'")
        mime = "video/webm" if video.endswith(".webm") else "video/mp4"
        part = {"inline_data": {"mime_type": mime, "data": base64.b64encode(data).decode()}, "video_metadata": {"fps": fps}}
        try:
            return parse(gemini(reader, key, [part, {"text": prompt(options, context, False)}]))
        except Skip as e:
            if str(e) != "NOVIDEO":
                raise
            FRAMES_ONLY.add(reader)
            return read_once(reader, video, options, context, fps, n_frames, key)


def reading(reader, video, options, context, fps, n_frames, key, seed, cache):
    """una lettura con l'elenco rimescolato dal seme: dict con la voce scelta, o None"""
    if reader in os.environ.get("VIS_GIURIA_FALLISCI", "").split(","):
        raise Skip("fallito apposta (VIS_GIURIA_FALLISCI, per provare)")
    opts = options[:]
    random.Random(seed).shuffle(opts)
    h = hashlib.sha256(Path(video).read_bytes()).hexdigest()[:16]
    k = hashlib.sha256(json.dumps([h, reader, opts, context, fps, n_frames]).encode()).hexdigest()[:24]
    cf_ = CACHE / f"{k}.json"
    if cache and cf_.exists():
        r = json.loads(cf_.read_text())
        r["cache"] = True
        return r
    t0 = time.time()
    raw = read_once(reader, video, opts, context, fps, n_frames, key)
    letter = str(raw.get("scelta", "")).strip().upper()[:1]
    second = str(raw.get("seconda", "") or "").strip().upper()[:1]
    idx = ord(letter) - 65 if letter else -1
    if not 0 <= idx < len(opts):
        raise Skip(f"scelta fuori elenco: {raw.get('scelta')!r}")
    r = {"lettore": reader, "voce": opts[idx], "seconda": opts[ord(second) - 65] if second and 0 <= ord(second) - 65 < len(opts) else "",
         "sicurezza": raw.get("sicurezza"), "descrizione": str(raw.get("descrizione", "")).strip(),
         "difetti": str(raw.get("difetti", "") or "").strip(), "secondi": round(time.time() - t0, 1), "seme": seed}
    cf_.write_text(json.dumps(r, ensure_ascii=False))
    return r


def jury(video, options, context, fps, n_frames, key, n, readers, cache, pairs=None, log=None):
    """n letture da lettori diversi. Con pairs [(lettore, seme)] rifa' quelle (il controllo)."""
    lock = threading.Lock()
    queue = [r for r in readers if r not in exhausted()]
    if not key:
        queue = [r for r in queue if external(r)]

    def take():
        with lock:
            return queue.pop(0) if queue else None

    def one(seed):
        while True:
            r = take()
            if r is None:
                return None
            try:
                return reading(r, video, options, context, fps, n_frames, key, seed, cache)
            except (Skip, subprocess.TimeoutExpired) as e:
                if log:
                    log(f"  {r}: salto ({e})")

    def again(pair):
        r, seed = pair
        try:
            return reading(r, video, options, context, fps, n_frames, key, seed, cache)
        except (Skip, subprocess.TimeoutExpired) as e:
            if log:
                log(f"  {r} sul controllo: salto ({e})")
            return None

    with cf.ThreadPoolExecutor(max_workers=4) as ex:
        res = list(ex.map(again, pairs)) if pairs is not None else list(ex.map(one, range(n)))
    return [r for r in res if r]


def main():
    ap = argparse.ArgumentParser(prog="vis giuria", description=__doc__.split("\n\n")[0],
                                 epilog="VIS_GIURIA_SENZA_GEMINI=1: come --senza-gemini. Exit: 0 VERDE, 1 ROSSO, 3 INCERTO, 64 uso.")
    ap.add_argument("video")
    ap.add_argument("--atteso", required=True, help="la voce giusta («a; b» se ne vanno bene piu' d'una)")
    ap.add_argument("--scelte", required=True, help="l'elenco, separato da ; oppure @file (una voce per riga)")
    ap.add_argument("--controllo", action="append", default=[], help="video che NON e' l'atteso (ripetibile)")
    ap.add_argument("--positivo", action="append", default=[],
                    help="video che E' l'atteso senza dubbio (es. esagerato): chi non lo riconosce non vota (ripetibile)")
    ap.add_argument("--contesto", default="", help="cosa c'e' nel video, senza dire cosa dovrebbe fare")
    ap.add_argument("--letture", type=int, default=4)
    ap.add_argument("--soglia", type=float, default=0.75, help="quota di letture sull'atteso per il VERDE")
    ap.add_argument("--min", type=int, default=3, help="letture valide minime per un verdetto")
    ap.add_argument("--fps", type=float, default=10, help="fotogrammi al secondo letti da Gemini")
    ap.add_argument("--fotogrammi", type=int, default=20, help="quanti ne vede chi legge i fotogrammi (max 24)")
    ap.add_argument("--lettori", default="", help="lettori in ordine, separati da virgola. Prefissi: "
                    "codex:MODELLO · oai:CANALE/MODELLO (canali nim, or, kilo, router: modelli vision gratuiti, es. "
                    "oai:nim/nvidia/nemotron-3.5-super-vl-120b-a12b) · muse:muse-spark-1.3 (Zen gratuito) · "
                    "claude:claude-haiku-5-5 (entra da solo in fondo se le famiglie vive sono meno di 4, Sonnet 5.5 se Haiku salta o non vede il positivo; consuma quota Claude). Senza prefisso = Gemini. "
                    "Una famiglia = un voto: Llama e Muse sono Meta, Gemma e Gemini Google")
    ap.add_argument("--senza-gemini", action="store_true",
                    help="toglie i lettori Gemini/Gemma-via-Google dall'elenco (anche con VIS_GIURIA_SENZA_GEMINI=1)")
    ap.add_argument("--json", default="", help="scrive tutte le letture in questo file")
    ap.add_argument("--senza-cache", action="store_true")
    ap.add_argument("--statico", action="store_true", help="il video puo' restare fermo (una posa, non un gesto)")
    a = ap.parse_args()

    for v in [a.video] + a.controllo + a.positivo:
        if not Path(v).is_file():
            die(f"file non trovato: {v}")
    # il video stesso come positivo toglierebbe il voto proprio a chi lo legge male
    same = lambda p: Path(p).read_bytes() == Path(a.video).read_bytes()
    if any(same(p) for p in a.positivo):
        die("il positivo e' lo stesso video: deve essere il gesto senza dubbio, un altro video")
    # Un video fermo non si giudica: il 15/10 un registratore che inquadrava
    # l'angolo sbagliato della pagina ha dato nove ROSSO su nove a gesti mai
    # visti. Quello e' un guasto di chi registra, non un verdetto.
    if not a.statico:
        m = motion(a.video)
        if m < 0.5:
            print(f"INCERTO: {Path(a.video).name} non si muove (cambia al massimo di {m:.2f} livelli su 255): "
                  "il soggetto e' nell'inquadratura? (--statico per una posa ferma)")
            sys.exit(3)
    options = labels_arg(a.scelte)
    expected = labels_arg(a.atteso)
    for e in expected:
        if e not in options:
            options.append(e)
    if not any("nessun" in o.lower() for o in options):
        options.append(NONE_LABEL)
    if len(options) > 26:
        die("al massimo 26 voci")
    CACHE.mkdir(parents=True, exist_ok=True)
    key = os.environ.get("GEMINI_API_KEY") or subprocess.run(
        ["security", "find-generic-password", "-s", "gemini", "-a", "api-key", "-w"], capture_output=True, text=True).stdout.strip()
    readers = [r.strip() for r in a.lettori.split(",") if r.strip()] or READERS
    if a.senza_gemini or os.environ.get("VIS_GIURIA_SENZA_GEMINI", "").lower() not in ("", "0", "no", "false"):
        readers = [r for r in readers if external(r)]
    ctx = a.contesto.strip()
    nf = max(4, min(24, a.fotogrammi))
    log = lambda s: print(s, file=sys.stderr)

    print(f"giuria: {Path(a.video).name} · atteso «{'» o «'.join(expected)}» · {len(options)} voci · {a.letture} letture")
    res = jury(a.video, options, ctx, a.fps, nf, key, a.letture, readers, not a.senza_cache, log=log)
    # meno di 4 famiglie vive: Claude entra come lettore normale (famiglia a parte)
    auto = not a.lettori and len({family(r["lettore"]) for r in res}) < MIN_FAMILIES
    if auto:
        log(f"  famiglie vive {len({family(r['lettore']) for r in res})} < {MIN_FAMILIES}: entra {AUTO_LAST}")
        # un solo lettore Claude: se Haiku salta, la lista passa a Sonnet da sola
        res += jury(a.video, options, ctx, a.fps, nf, key, 1, [AUTO_LAST, AUTO_SECOND], not a.senza_cache, log=log)
    for i, r in enumerate(res, 1):
        mark = "✓" if r["voce"] in expected else "✗"
        print(f"  {mark} {r['lettore'][:28]:<28} {r['voce'][:34]:<34} ({r['sicurezza']}){' [cache]' if r.get('cache') else ''}")
        print(f"      {r['descrizione'][:220]}")
    defects = [r["difetti"] for r in res if r["difetti"] and not re.match(r"^(nessun|niente|none|-)", r["difetti"].strip(), re.I)]
    if defects:
        print(f"  difetti segnalati da {len(defects)} su {len(res)}:")
        for d in defects:
            print(f"      - {d[:200]}")

    controls = []
    for c in a.controllo:
        cr = jury(c, options, ctx, a.fps, nf, key, 0, readers, not a.senza_cache,
                  pairs=[(r["lettore"], r["seme"]) for r in res], log=log)
        ch = sum(r["voce"] in expected for r in cr)
        seen = {}
        for r in cr:
            seen[r["voce"]] = seen.get(r["voce"], 0) + 1
        print(f"controllo {Path(c).name}: letto come l'atteso {ch} su {len(cr)} ("
              + ", ".join(f"{k} {v}" for k, v in sorted(seen.items(), key=lambda x: -x[1])) + ")")
        controls.append({"video": c, "letture": cr, "come_atteso": ch})

    # Il positivo: lo stesso gesto, senza dubbio. Il 15/10 un saluto esagerato
    # (40 gradi, otto oscillazioni, a occhio un «ciao» pieno) e' stato letto
    # «tamburellare» e «girare la mano di lato» dai due Flash-Lite: chi non
    # riconosce nemmeno quello non vede questo tipo di gesto, e il suo voto
    # sul video vero non dice niente del video.
    positives, blind, unread = [], set(), set()
    for p in a.positivo:
        pr = jury(p, options, ctx, a.fps, nf, key, 0, readers, not a.senza_cache,
                  pairs=[(r["lettore"], r["seme"]) for r in res], log=log)
        ok = {(r["lettore"], r["seme"]) for r in pr if r["voce"] in expected}
        # chi non ha letto il positivo (quota finita) non si sa se ci vede: non vota
        unread |= {(r["lettore"], r["seme"]) for r in res} - {(r["lettore"], r["seme"]) for r in pr}
        blind |= {(r["lettore"], r["seme"]) for r in res} - ok
        miss = [f"{r['lettore'].replace('gemini-', '')} {r['voce']}" for r in pr if r["voce"] not in expected]
        print(f"positivo {Path(p).name}: letto come l'atteso {len(ok)} su {len(pr)}"
              + (f" ({', '.join(miss)})" if miss else ""))
        positives.append({"video": p, "letture": pr, "come_atteso": len(ok)})
    # Haiku non vede il positivo: al suo posto Sonnet (stessa famiglia, un voto solo)
    hk = [r for r in res if r["lettore"] == AUTO_LAST and (r["lettore"], r["seme"]) in blind | unread]
    if auto and hk and a.positivo:
        log(f"  {AUTO_LAST} non vede il positivo: provo {AUTO_SECOND}")
        sn = jury(a.video, options, ctx, a.fps, nf, key, 1, [AUTO_SECOND], not a.senza_cache, log=log)
        if sn:
            pk = (sn[0]["lettore"], sn[0]["seme"])
            seen = [jury(p, options, ctx, a.fps, nf, key, 0, [AUTO_SECOND], not a.senza_cache, pairs=[pk], log=log) for p in a.positivo]
            if all(x and x[0]["voce"] in expected for x in seen):
                res = [r for r in res if r is not hk[0]] + sn
                blind -= {(hk[0]["lettore"], hk[0]["seme"])}
                unread -= {(hk[0]["lettore"], hk[0]["seme"])}
    for r in res:
        r["cieco"] = (r["lettore"], r["seme"]) in blind
    # i due casi si dicono separati: il 15/10 un Gemini che aveva letto giusto
    # con 100 e poi preso un 429 sul positivo risultava «non lo riconosce»
    if blind - unread:
        print("  non votano, non riconoscono il positivo: "
              + ", ".join(sorted({l.replace('gemini-', '') for l, _ in blind - unread})))
    if unread:
        print("  non votano, non hanno letto il positivo (quota o errore): "
              + ", ".join(sorted({l.replace('gemini-', '') for l, _ in unread})))
    votes = [r for r in res if not r["cieco"]]
    hits = sum(r["voce"] in expected for r in votes)
    wrong = {}
    for r in votes:
        if r["voce"] not in expected:
            wrong[r["voce"]] = wrong.get(r["voce"], 0) + 1

    if a.json:
        Path(a.json).write_text(json.dumps({"video": a.video, "atteso": expected, "voci": options, "letture": res,
                                            "controlli": controls, "positivi": positives}, ensure_ascii=False, indent=1))
    fams = {family(r["lettore"]) for r in votes}
    share = hits / len(votes) if votes else 0
    tail = f"{hits} su {len(votes)} ({share:.0%}, soglia {a.soglia:.0%}), lettori di {len(fams)} famiglie"
    conf = (" · scambiato per: " + ", ".join(f"{k} {v}" for k, v in sorted(wrong.items(), key=lambda x: -x[1]))) if wrong else ""
    if len(votes) < a.min:
        why = (f"{len(blind - unread)} lettori non riconoscono nemmeno il positivo, {len(unread)} non l'hanno letto;"
               f" serve un lettore piu' forte (esauriti oggi: {', '.join(sorted(exhausted())) or 'nessuno'})"
               if blind else f"esauriti oggi: {', '.join(sorted(exhausted())) or 'nessuno'}")
        print(f"INCERTO: solo {len(votes)} letture valide (minimo {a.min}); {why} · {tail}{conf}")
        sys.exit(3)
    if any(c["come_atteso"] for c in controls):
        print(f"INCERTO: il controllo e' stato letto come l'atteso, la giuria non distingue · {tail}{conf}")
        sys.exit(3)
    if share >= a.soglia:
        print(f"VERDE: {tail}{conf}")
        sys.exit(0)
    print(f"ROSSO: {tail}{conf}")
    sys.exit(1)


if __name__ == "__main__":
    main()
