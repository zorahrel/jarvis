# ~/.agents — hub condiviso tra agenti

Unica fonte di verità per skill, istruzioni globali e stile di output. **Claude Code, Codex, jcode e
OpenClaw** leggono da qui. Barra: **`agents-doctor`** (exit 0 = tutto agganciato; `--fast` salta la
domanda a Codex). I conteggi non si scrivono nei doc: li stampa il doctor.

## Struttura
```
.agents/
├── AGENTS.md            GENERATO da bin/agents-build: CLAUDE.md + @import risolti + stile attention-span
├── bin/                 agents-build (generatore) · agents-doctor (barra); link in ~/bin
├── skills/              indice unico: symlink verso le sorgenti reali
├── skills-own/          → ~/.claude/setup/skills-own: skill mie e di terzi senza altra copia,
│                        versionate in ai-config e cifrate (dall'08/10)
├── skills-from-commands/ slash command → skill: SKILL.md è una COPIA di .source, rifatta da agents-build
├── vendor/              attention-span (clone upstream) + sync-attention-span.sh
├── plugins/             marketplace locale (threejs-object-sculptor)
└── backups/<data>/      config e .bak spostati dalle cartelle degli harness (700)
```

## Chi legge cosa
| Harness | Istruzioni | Skill | Stile |
|---|---|---|---|
| Claude Code (anche Topics, router, OpenClaw che lanciano `claude`) | `~/.claude/CLAUDE.md` | `~/.claude/skills` → hub | `outputStyle` in settings.json |
| Codex | `~/.codex/AGENTS.md` → `AGENTS.md` | **nativo** `~/.agents/skills` | dentro AGENTS.md |
| jcode | `~/.jcode/prompt-overlay.md` → `AGENTS.md` (niente `~/AGENTS.md`: Claude Code lo leggerebbe come doppione) | `~/.jcode/skills` → hub | dentro AGENTS.md |
| OpenClaw | via claude-cli (`--setting-sources user`); memoria = quella nativa di OpenClaw (`MEMORY.md`, `USER.md`, `memory/`, repo locale `memgit`), auto-memory di Claude Code spenta lì (`env.vars.CLAUDE_CODE_DISABLE_AUTO_MEMORY`) dal 02/10 | `~/.openclaw/skills` → hub | eredita settings.json |

**AGENTS.md non si modifica a mano.** `com.jarvis.agents-build` (launchd, WatchPaths su CLAUDE.md,
TOOLS.md, output-styles del vendor e sorgenti dei comandi) lo rigenera da solo; verificato il 15/09
aggiungendo una riga a TOOLS.md. Codex salta i SKILL.md che sono symlink (commit, recap, spec, vai
erano invisibili): per questo in `skills-from-commands` sono copie.

## Contesto per sessione (misurato 15/09/2026, `claude -p` + usage)
Prefisso Claude Code **100.275 → 43.001 token**: `ENABLE_TOOL_SEARCH` da `auto` a `true` (con 1M di
contesto la soglia `auto` è 100k e 52.587 token di schemi MCP restavano sempre caricati) e
CLAUDE.md + TOOLS.md da 11,2k a 6,3k (dettagli spostati nei cheatsheet `tools/*.md`, niente perso:
righe originali in coda a ciascuno). Lo stile Attention-kind costa ~2,6k, non i 650 del suo README.
Attenzione: il desktop app esporta `ENABLE_TOOL_SEARCH=auto` nell'ambiente, e l'ambiente vince sui
settings: le misure vanno fatte con `env -u ENABLE_TOOL_SEARCH`.

## Vendor: attention-span
Clone di github.com/alexgreensh/attention-span (AGPL-3.0). Claude Code: `~/.claude/output-styles/*.md`
e `commands/style.md` linkano qui. Skill `attention-kind`, `spartan`, `rundown`, `tldr`
(user-invoked, 0 token nel listing; Codex le mostra come `attention-span:*`). **Update a mano**:
`vendor/sync-attention-span.sh` mostra i commit nuovi, `--apply` tira e rigenera. Niente cron:
quel testo entra nel prompt di ogni agente.

**Direzione dei link, importante:** `~/.claude` è un repo git (`zorahrel/ai-config`, con
git-crypt). I file veri stanno lì e l'hub li linka, mai il contrario: un symlink versionato che
punta fuori dal repo si rompe al primo ripristino su un'altra macchina.

## Attico: uno solo, quello del gateway
`~/jarvis/skills-attic`, con `reason` e data in `attic.json`. Tool MCP:
`skills_list`, `skills_read`, `skills_restore`, `skills_park`. Gestisce directory reali, non
symlink: si parcheggia una skill del marketplace, non un link dell'hub.

## Aggiungere / togliere una skill
- Nuova mia: `skills-own/<nome>/SKILL.md` + `ln -s ../skills-own/<nome> skills/<nome>`.
- Dal marketplace: `ln -s ~/.claude/setup/marketplace/skills/<nome> ~/.agents/skills/<nome>`.
- Togliere dal listing: `rm` il symlink nell'hub (la sorgente resta), o `skills_park` se è del
  marketplace e vuoi che la motivazione resti scritta.

## MCP
`~/.jcode/mcp.json`: node_repl, computer-use, exa, context7, gateway. jcode parla solo stdio,
quindi gli HTTP passano da `npx -y mcp-remote@latest <url>`. Claude Code li usa nativi da
`~/.claude.json`.

Gateway (`~/.claude/jarvis/mcp-servers/gateway/gateway-config.json`). `wigolo` e
`viaggi` sono lenti al primo avvio (~10s) e possono apparire in timeout: `gateway_mount {name}`
li rimonta. Rimosso `qlik`, puntava a uno scratchpad `/private/tmp` sparito.

---

## Cronologia decisioni (2026-08-16)

**Hook.** Rimosso solo `read-image-to-moondream`: chiave Moondream 401 dall'8 agosto, quindi
falliva e ricadeva sul Read nativo pagando 47ms per ogni lettura. Con lui `moondream-env` (575 MB).
Verificati vivi e mantenuti (26): `topics-hooks` regge la state machine delle fasi sessione,
`block-coauthor` applica la regola no-trailer a livello harness, `jarvis-control-status` alimenta
il dashboard del router, account-switcher :3335 attribuisce i token ai 5 account Claude — **non
è un duplicato**, toglierlo avrebbe rotto la contabilità.

**Plugin `jarvis-custom-skills` disabilitato.** La sua cache era ferma al 2 luglio: 34 skill
contro le 18 del marketplace vivo. Le 19 in più erano quelle parcheggiate a fine luglio nel
gateway attic con motivazioni scritte (tdd, qa, verifica-profonda, write-a-skill...): il plugin
le resuscitava nel listing di ogni sessione, quindi l'attico non aveva alcun effetto da 45 giorni.
Disabilitarlo basta per Claude Code; jcode legge comunque la cartella cache, che è stata rimossa.

**Skill orfane recuperate:** `gauntlet-loop`, `master`, `jarvis-config` erano versionate in
`setup/marketplace/skills/` ma mai installate, invisibili a tutti e tre. AGENTS.md cita
`/gauntlet-loop`, quindi l'istruzione globale puntava al vuoto.

**Subagent: non sono skill.** oracle/scout/verifier (`~/.claude/agents/`) sono processi separati
con modello ed effort propri. Una skill è testo letto nel contesto corrente, dallo stesso modello:
`verifier` come skill si auto-valuterebbe, che è il bug che esiste per prevenire. jcode →
`~/.jcode/swarm-prompt.md`; OpenClaw li eredita perché gira sul runtime `claude-cli`.

**`.claude/projects` non contiene progetti** ma transcript e memorie di progetto (`memory/*.md`).
Misurato: dei 2.9 GB, zero file superano i 60 giorni. Non c'è nulla da archiviare.

**Risultato:** listing skill da 4538 a ~1330 token per sessione, su ogni sessione di ogni harness.

## Bug trovato: `allowed-tools` in lista YAML (2026-08-16)
Il parser di jcode **scarta la skill** se il frontmatter ha `allowed-tools` come lista YAML
multilinea (`- Read` a capo). `browser-learn`, `humanizer`, `reel-factory`, `trend-research`,
`watch-reel` erano installate e funzionanti su Claude Code ma invisibili a jcode (37 vs 41).
Fix: stessa lista in sintassi inline `allowed-tools: Read, Write, Edit`. Letta correttamente da
entrambi (verificato). `description: |` multilinea invece va bene, non era quella la causa.

**Regola per skill nuove:** `allowed-tools` sempre inline, se serve.

## Pulizia disco (2026-08-16): 8.9 → 7.3 GB
Ogni voce verificata prima di toccarla, tutto in `trash`:
- `jobs/*/tmp` dei job in stato done/failed (587 MB). `timeline.jsonl` e `state.json` restano.
- `media-archive` (294 MB, 1635 png): cache del hook moondream rimosso, ultimo scritto 9 luglio,
  nessun codice la referenzia.
- `thedotmack/plugin/node_modules` (186 MB): marketplace claude-mem senza plugin abilitati,
  ripristinabile con `npm install` dal repo git.
- 10 versioni obsolete in `plugins/cache` non referenziate da `installed_plugins.json`.
- `moondream-env` (575 MB), 191 eventi jarvis >30gg, 33 security_warnings, 13 backup settings.

**Non toccato perché vivo:** `jarvis/router` + `omega-env` (processo 934), `dashboard`,
`browser-profiles` (sessioni loggate), `.claude/projects` (2.9 GB, ma zero file oltre i 60 giorni
e contiene le `memory/*.md` di progetto).

## Cos'e' `.claude/projects/` (il nome inganna)
Non contiene progetti: e' lo **storage per-cwd di Claude Code**, chiave = la directory dove hai
lanciato l'agente, con "/" sostituito da "-". Dentro, quattro cose diverse:
- `<uuid>.jsonl` -- la trascrizione di ogni sessione. E' cio' che rende possibile `/resume`.
- `memory/*.md` -- **le memorie di progetto** (878 file, 3.6 MB in tutto). La parte preziosa.
- `<uuid>/subagents/` e `tool-results/` -- scratch degli agenti spawnati. La parte pesante (890 MB).
- `sessions-index.json` -- indice con titolo e riassunto per il picker.

Il nome giusto sarebbe `sessions/` o `workspaces/`, ma e' deciso da Anthropic: rinominarlo rompe
`/resume` e il picker. Il codice vero sta in ~/Sites e ~/Projects.

Cestinate 45 cartelle subagents di sessioni ferme da oltre 14 giorni (148 MB). Trascrizioni e
memorie intatte: `claude --resume` verificato funzionante dopo.
