# Credenziali per gli strumenti cloud: l'account loggato (Portachiavi) oppure, con
# CLOUD_ACCOUNT=auto-N, un altro account di vdm. Il token di quel file lo rinnova vdm da solo
# (ogni 5 minuti, un'ora prima della scadenza), quindi va riletto a ogni uso. Mai stampato.
import json, os, subprocess, urllib.request

def oauth():
    acct = os.environ.get("CLOUD_ACCOUNT")
    if acct:
        return json.load(open(os.path.expanduser(f"~/.claude/account-switcher/accounts/{acct}.json")))["claudeAiOauth"]
    raw = subprocess.run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], capture_output=True, text=True)
    if raw.returncode != 0:
        raise SystemExit("voce «Claude Code-credentials» assente nel Portachiavi")
    return json.loads(raw.stdout)["claudeAiOauth"]

_org = None
_profilo = None

def org():
    # ~/.claude.json descrive solo l'account loggato: per un altro account l'org la dice il profilo.
    global _org
    if _org is None:
        if os.environ.get("CLOUD_ACCOUNT"):
            h = {"Authorization": "Bearer " + oauth()["accessToken"], "anthropic-version": "2023-06-01",
                 "anthropic-beta": "oauth-2025-04-20", "User-Agent": "cloud-conto/1"}
            req = urllib.request.Request("https://api.anthropic.com/api/oauth/profile", headers=h)
            global _profilo
            _profilo = json.load(urllib.request.urlopen(req, timeout=20))
            _org = _profilo["organization"]["uuid"]
        else:
            _org = json.load(open(os.path.expanduser("~/.claude.json")))["oauthAccount"]["organizationUuid"]
    return _org

def cli_env(trust=()):
    # La CLI per un altro account: config isolata (niente hook né plugin dell'account loggato)
    # e il token di quell'account, che vince sul Portachiavi. `trust`: le cartelle già fidate
    # sull'account loggato; senza, la finestra di fiducia parte su «No, exit» e il lancio si ferma.
    env = dict(os.environ)
    acct = env.get("CLOUD_ACCOUNT")
    if acct:
        d = os.path.expanduser(f"~/.claude/cloud-accounts/{acct}")
        os.makedirs(d, mode=0o700, exist_ok=True)
        cfg = os.path.join(d, ".claude.json")
        conf = json.load(open(cfg)) if os.path.exists(cfg) else {"hasCompletedOnboarding": True, "theme": "dark"}
        # Col token da variabile d'ambiente la CLI non chiede il profilo: senza org si ferma con
        # «Unable to get organization UUID».
        org()
        a, o = _profilo["account"], _profilo["organization"]
        conf["oauthAccount"] = {"accountUuid": a.get("uuid"), "emailAddress": a.get("email"),
                                "organizationUuid": o.get("uuid"), "organizationName": o.get("name")}
        env["CLAUDE_CODE_ORGANIZATION_UUID"] = o["uuid"]
        for t in trust:
            conf.setdefault("projects", {}).setdefault(t, {})["hasTrustDialogAccepted"] = True
        with open(cfg, "w") as f: json.dump(conf, f)
        env["CLAUDE_CONFIG_DIR"] = d
        env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth()["accessToken"]
    return env
