#!/usr/bin/env python3
# Aspetta lo stabile di OpenClaw che porta i 3 fix della memoria dei worker (card c4e3df18, upstream #181432):
# #171354, #174718, #179119. Gira ogni mattina dopo safe-update (04:20) da un cron OpenClaw dietro cron-clean.
# Tace finche' non c'e' niente da fare. Apre UNA card (board-card, chiave per versione) in due casi:
#  1) uno stabile coi 3 fix e' uscito da oltre 48 h ma qui non e' installato (safe-update non ce l'ha fatta);
#  2) e' installato e oc-memwatch ha una riga a pari uptime del riferimento: card col confronto, da chiudere a vista.
# Un fix e' "dentro" un tag se il suo commit (o un cherry-pick con lo stesso "(#N)") e' antenato del tag.
# uso: fix-memoria-stable.py [--dry-run]   exit 0 sempre se ha deciso; 1 se GitHub non risponde.
import json, os, re, subprocess, sys, time

PRS = (171354, 174718, 179119)
REPO = "openclaw/openclaw"
LOG = os.path.expanduser("~/.claude/jarvis/logs/oc-memwatch.log")
CARD = os.path.expanduser("~/.claude/jarvis/scripts/board-card")
# Riferimento sulla 10.5 (studio del 25/10): 2577-2607 MB di footprint a 8700-9300 s di uptime
RIF_UPTIME, RIF_MB = (8700, 9300), (2577, 2607)
DRY = "--dry-run" in sys.argv


def gh(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=60)
    if r.returncode:
        sys.exit(f"gh api {path}: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout)


def fix_in(tag, cache={}):
    """True se tutti e 3 i fix sono antenati del tag."""
    for n in PRS:
        if n not in cache:
            shas = {gh(f"repos/{REPO}/pulls/{n}")["merge_commit_sha"]}
            shas |= {i["sha"] for i in gh(f"search/commits?q=repo:{REPO}+%22%23{n}%22&per_page=20")["items"]}
            cache[n] = shas
        if not any(gh(f"repos/{REPO}/compare/{s}...{tag}")["status"] in ("ahead", "identical") for s in cache[n]):
            return False
    return True


def card(key, title, desc):
    if DRY:
        print(f"[dry-run] card {key}: {title}\n{desc}")
        return
    subprocess.run([CARD, "--key", key, "--title", title, "--desc", desc, "--board", "attilio-mn52yh"], check=True)


def main():
    stabili = [r for r in gh(f"repos/{REPO}/releases?per_page=15") if not r["prerelease"] and not r["draft"]]
    stabili.sort(key=lambda r: [int(x) for x in re.findall(r"\d+", r["tag_name"])], reverse=True)
    buono = next((r for r in stabili if fix_in(r["tag_name"])), None)
    if not buono:
        print(f"nessuno stabile coi fix (ultimo {stabili[0]['tag_name']})")
        return
    tag = buono["tag_name"]
    installata = subprocess.run(["openclaw", "--version"], capture_output=True, text=True).stdout
    ver = re.search(r"\d{4}\.\d+\.\d+(-\S+)?", installata).group(0)
    if not fix_in(f"v{ver}"):
        ore = (time.time() - time.mktime(time.strptime(buono["published_at"], "%Y-%m-%dT%H:%M:%SZ"))) / 3600
        if ore > 48:
            card(f"oc-fix-memoria-{tag}", f"OpenClaw {tag} porta i fix della memoria ma qui c'e' ancora la {ver}",
                 f"Lo stabile {tag} (uscito {buono['published_at']}) contiene #171354 #174718 #179119; safe-update "
                 f"non l'ha installato. Log: ~/.claude/jarvis/logs/openclaw-safe-update*. Card madre c4e3df18.")
        print(f"{tag} coi fix, installata {ver} senza, da {ore:.0f} h")
        return
    # Installata una versione coi fix: cerca la prima riga di oc-memwatch a pari uptime
    righe = [l.split("\t") for l in open(LOG) if l.count("\t") >= 7]
    pari = [r for r in righe if r[7] == ver and RIF_UPTIME[0] <= int(r[2]) <= RIF_UPTIME[1]]
    if not pari:
        print(f"{ver} installata, nessuna riga a {RIF_UPTIME[0]}-{RIF_UPTIME[1]} s ancora")
        return
    r = pari[0]
    mb = int(r[3])
    esito = "si e' appiattita" if mb < RIF_MB[0] - 300 else "NON si e' appiattita"
    card(f"oc-fix-memoria-confronto-{ver}", f"Memoria del gateway OpenClaw dopo i fix: {esito}",
         f"{ver} a {r[2]} s di uptime: {mb} MB di footprint (heap {r[4]}, worker {r[5]} MB in {r[6]} thread), "
         f"contro {RIF_MB[0]}-{RIF_MB[1]} MB della 10.5 a pari uptime. Riga: {r[0]} in {LOG}. "
         f"Se appiattita: chiudere la card c4e3df18 e togliere il cron 'Fix memoria OpenClaw nello stabile'. "
         f"Se no: riprendere il benchmark su gateway di prova (catalogo sessioni anthropic, cloni della config).")
    print(f"confronto: {mb} MB a {r[2]} s ({esito})")


main()
