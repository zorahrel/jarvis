# Proposta: il lavoro pesante va sul PC da solo (hook `offload-guard`)

## Stato

**Approvata e attiva dal 23/10** (Attilio: «ma tutto anche muse no?»): Claude Code, Codex, Muse e jcode usano lo stesso script. Dove sta ogni riga: `~/.claude/setup/shared/tools/pc-offload.md`.

## Perché un hook e non una riga in più

La riga su `offload` c'è in `TOOLS.md` (e quindi in `~/.agents/AGENTS.md`) dal 16/10. Il 23/10 alle 02:15 il Mac era a 4 per core e il PC acceso all'1%: gli agenti la leggono e non la applicano, perché nel momento in cui lanciano una suite non guardano il carico. Un hook lo guarda per loro, una volta per comando.

`delegate` non è la leva: decide *quale modello* fa un compito, non *dove* gira un comando.

## Cosa fa

`~/.claude/hooks/offload-guard.sh`, PreToolUse su Bash:

- Mac sotto la soglia di `offload` (1,5 per core, `OFFLOAD_MAX_MAC`) → passa, costo 41 ms.
- Mac sopra e comando pesante (`playwright test`, `vitest`, `jest`, `cypress run`, `pnpm|npm|yarn|bun test|e2e|build`, `spec-flow`, `pytest`, `cargo test|build`, `go test`) → blocca e dice all'agente come rilanciarlo con `offload` (cmd.exe, `--mac-cmd`, `--get`, prima installazione).
- Guarda anche **dentro lo script** lanciato (`bash barra.sh`, `./x.sh`): le suite girano quasi sempre dentro una barra.
- Lascia passare i comandi con `offload` e quelli con `OFFLOAD=local` davanti (servizi locali, Xcode, codex/moondream, build il cui output serve sul Mac).

## Misura

- **Unità** (JSON finto sullo stdin, 23/10): 12 casi su 12. Bloccati `npx playwright test`, `cd app && pnpm test`, `pnpm run test:e2e`, `npx vitest run`, `bash barra.sh` e `./barra.sh` con Playwright dentro; passano `bash leggero.sh`, `offload -- …`, `OFFLOAD=local npm run build`, `git status`, `grep vitest.config`, e tutto a Mac scarico.
- **End-to-end** (`claude -p --model sonnet --settings <solo questo hook>`, repo con `npm test` che stampa la piattaforma, soglia forzata a 0): il primo `npm test` viene bloccato, l'agente rilancia da solo `offload --mac-cmd "npm test" -- "npm test & ver & node -v"`, il PC dormiva e `offload` l'ha svegliato, risposta finale `platform=win32`, exit 0.
- **Costo**: 41 ms a comando a Mac scarico (un sysctl e un awk), ~140 ms a Mac carico (jq e grep).

## Le righe da incollare

`~/.claude/settings.json`, dentro `hooks.PreToolUse`, accanto a `block-coauthor`:

```json
{
  "matcher": "Bash",
  "hooks": [{ "type": "command", "command": "/Users/zorahrel/.claude/hooks/offload-guard.sh", "timeout": 5 }]
}
```

`~/.codex/hooks.json`, dentro `hooks`:

```json
"PreToolUse": [
  { "matcher": "Bash", "hooks": [{ "type": "command", "command": "/Users/zorahrel/.claude/hooks/offload-guard.sh", "timeout": 5 }] }
]
```

## Fuori

OpenClaw non ha un hook sui comandi con questo protocollo: per lui resta la riga dell'hub. Muse e jcode invece ce l'hanno (Muse legge gli hook nel formato di Claude, jcode ha `[hooks] pre_tool` con exit 2), e sono stati accesi anche loro. Il router di delega non si tocca.
