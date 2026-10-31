#!/usr/bin/env -S python3 -I
# Dice a una sessione Claude Code appena aperta quali altre sessioni interattive sono
# attive sul Mac e dove lavorano, perché due sessioni sullo stesso sistema si dividano
# lo scope prima di lavorare invece di scoprirlo dopo.
#
# Perché esiste: il 22/10 «Riduzione rumore» e «Workflow monitoring» hanno studiato
# OpenClaw a 25 minuti di distanza, con conclusioni opposte («29 cron ok» contro
# un login che non salva mai la chiave), e la seconda ha lavorato nel checkout della
# Tray senza saperlo. Nessuna delle due sapeva dell'altra.
#
# Hook SessionStart (startup|resume). Solo per le sessioni interattive: i giri headless
# dei cron (`claude -p`) non ne hanno bisogno e pagherebbero i token a ogni giro.
# Elenca solo chi lavora nello stesso repo (worktree compresi): le altre sessioni non
# possono pestarle i piedi e nella nota sono solo rumore. Con nessuna vicina tace.
# Barra: setup/shared/session-neighbours-test.sh
import glob
import json
import os
import subprocess
import sys
import time

PROJECTS = os.environ.get("NEIGHBOURS_PROJECTS_DIR", os.path.expanduser("~/.claude/projects"))
WINDOW_MIN = 20
MAX_SHOWN = 6
INTERACTIVE = ("claude-desktop", "cli")
HOME = os.path.expanduser("~")


def tail_entries(path, size=131072):
    with open(path, "rb") as f:
        f.seek(max(0, os.path.getsize(path) - size))
        lines = f.read().decode(errors="replace").splitlines()
    for line in reversed(lines):
        try:
            yield json.loads(line)
        except ValueError:
            continue


def last_prompt(entry):
    """Testo di una richiesta vera dell'utente, o None (tool result, avvisi di sistema)."""
    if entry.get("type") != "user" or entry.get("isMeta"):
        return None
    c = entry.get("message", {}).get("content")
    text = c if isinstance(c, str) else next((b.get("text") for b in c or [] if b.get("type") == "text"), None)
    if not text or text.lstrip().startswith("<"):
        return None
    return " ".join(text.split())[:90]


def describe(path, sid):
    info = {"entrypoint": None, "cwd": None, "branch": None, "prompt": None}
    for e in tail_entries(path):
        for key, field in (("entrypoint", "entrypoint"), ("cwd", "cwd"), ("branch", "gitBranch")):
            if info[key] is None and e.get(field):
                info[key] = e[field]
        if info["prompt"] is None:
            info["prompt"] = last_prompt(e)
        if all(info.values()):
            break
    # Un turno lungo e autonomo riempie la coda di tool: allora vale la prima richiesta.
    info["prompt_kind"] = "ultima richiesta"
    if info["prompt"] is None:
        with open(path, errors="replace") as f:
            for _, line in zip(range(400), f):
                try:
                    info["prompt"] = last_prompt(json.loads(line))
                except ValueError:
                    continue
                if info["prompt"]:
                    info["prompt_kind"] = "prima richiesta"
                    break
    info["title"] = None
    for t in glob.glob(f"{PROJECTS}/*/{sid}/custom-title.json"):
        try:
            with open(t) as f:
                info["title"] = json.load(f).get("customTitle")
            break
        except (OSError, ValueError):
            continue
    return info


def repo_of(cwd, cache={}):
    """Chiave del repo: la git dir comune, uguale per il checkout e i suoi worktree."""
    if not cwd:
        return None
    if cwd not in cache:
        try:
            out = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
                capture_output=True, text=True, timeout=2,
            )
            cache[cwd] = os.path.realpath(out.stdout.strip() if out.returncode == 0 else cwd)
        except (OSError, subprocess.SubprocessError):
            cache[cwd] = os.path.realpath(cwd)
    return cache[cwd]


def where(cwd):
    if not cwd:
        return "cartella ignota"
    if "/scratch-workspaces/" in cwd:
        return "senza progetto"
    return cwd.replace(HOME, "~")


def main():
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT") not in INTERACTIVE:
        return
    try:
        hook_input = json.load(sys.stdin)
    except ValueError:
        hook_input = {}
    me = hook_input.get("session_id", "")
    my_repo = repo_of(hook_input.get("cwd") or os.getcwd())
    now = time.time()
    newest = {}
    for path in glob.glob(f"{PROJECTS}/*/*.jsonl"):
        sid = os.path.basename(path)[:-6]
        mtime = os.path.getmtime(path)
        if sid == me or now - mtime > WINDOW_MIN * 60:
            continue
        # Una sessione che cambia cartella lascia una trascrizione per cartella.
        if sid not in newest or mtime > newest[sid][1]:
            newest[sid] = (path, mtime)

    rows = []
    for sid, (path, mtime) in sorted(newest.items(), key=lambda x: -x[1][1]):
        info = describe(path, sid)
        if info["entrypoint"] not in INTERACTIVE or repo_of(info["cwd"]) != my_repo:
            continue
        name = f"«{info['title']}»" if info["title"] else f"senza titolo, {info['prompt_kind']}: «{info['prompt'] or '?'}»"
        branch = f" · {info['branch']}" if info["branch"] and info["branch"] != "HEAD" else ""
        rows.append(f"- {name} · {where(info['cwd'])}{branch} · {int((now - mtime) / 60)} min fa")
    if not rows:
        return
    hidden = len(rows) - MAX_SHOWN
    text = (
        f"Altre sessioni Claude Code attive nello stesso repo negli ultimi {WINDOW_MIN} minuti:\n"
        + "\n".join(rows[:MAX_SHOWN])
        + (f"\n- e altre {hidden}" if hidden > 0 else "")
        + "\nPrima di toccare i loro file o il loro branch, scrivile una volta con SendMessage "
        "(to = il nome che mostra ListAgents) per dividervi lo scope."
    )
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": text}}))


if __name__ == "__main__":
    # Una nota di contesto non vale un avvio rotto: qualunque errore e la sessione parte muta.
    try:
        main()
    except Exception:  # noqa: BLE001
        pass
