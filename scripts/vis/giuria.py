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
  - ogni lettura la fa un modello diverso, e quando si puo' di due famiglie
    (Gemini guarda il video, codex i fotogrammi con l'ora stampata);
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
    "gemini-3.8-flash", "codex:gpt-6-luna", "gemini-3.1-pro-preview", "gemini-3.7-flash",
    "gemini-robotics-er-2-preview", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview",
    "gemini-omni-1.1-flash", "gemma-4-31b-it", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite",
    "gemini-2.5-flash-lite",
]
# chi non legge il video intero: gli si danno i fotogrammi
FRAMES_ONLY = {"gemma-4-31b-it", "gemma-4-26b-a4b-it"}


def family(reader):
    return "openai" if reader.startswith("codex:") else "google"


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


def read_once(reader, video, options, context, fps, n_frames, key):
    """una lettura: (risposta grezza in dict). Solleva Skip se il lettore non c'e'."""
    as_frames = reader.startswith("codex:") or reader in FRAMES_ONLY
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
        queue = [r for r in queue if r.startswith("codex:")]

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
    ap = argparse.ArgumentParser(prog="vis giuria", description=__doc__.split("\n\n")[0])
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
    ap.add_argument("--lettori", default="", help="lettori in ordine, separati da virgola (codex:MODELLO per codex)")
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
    ctx = a.contesto.strip()
    nf = max(4, min(24, a.fotogrammi))
    log = lambda s: print(s, file=sys.stderr)

    print(f"giuria: {Path(a.video).name} · atteso «{'» o «'.join(expected)}» · {len(options)} voci · {a.letture} letture")
    res = jury(a.video, options, ctx, a.fps, nf, key, a.letture, readers, not a.senza_cache, log=log)
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
    positives, blind = [], set()
    for p in a.positivo:
        pr = jury(p, options, ctx, a.fps, nf, key, 0, readers, not a.senza_cache,
                  pairs=[(r["lettore"], r["seme"]) for r in res], log=log)
        ok = {(r["lettore"], r["seme"]) for r in pr if r["voce"] in expected}
        # chi non ha letto il positivo (quota finita) non si sa se ci vede: non vota
        blind |= {(r["lettore"], r["seme"]) for r in res} - ok
        miss = [f"{r['lettore'].replace('gemini-', '')} {r['voce']}" for r in pr if r["voce"] not in expected]
        print(f"positivo {Path(p).name}: letto come l'atteso {len(ok)} su {len(pr)}"
              + (f" ({', '.join(miss)})" if miss else ""))
        positives.append({"video": p, "letture": pr, "come_atteso": len(ok)})
    for r in res:
        r["cieco"] = (r["lettore"], r["seme"]) in blind
    if blind:
        print("  non votano, non riconoscono il positivo: "
              + ", ".join(sorted({l.replace('gemini-', '') for l, _ in blind})))
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
        why = (f"{len(res) - len(votes)} lettori non riconoscono nemmeno il positivo, serve un lettore piu' forte"
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
