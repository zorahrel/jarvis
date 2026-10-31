# gateway — configurazione locale

Il gateway **non vive qui**. Il codice è il pacchetto `mcp-hot-gateway`
(`~/Projects/mcp-hot-gateway`, repo pubblico `zorahrel/mcp-hot-gateway`, MIT),
collegato in `node_modules/` da `npm install`. Questa cartella tiene solo ciò
che è specifico di questa macchina.

| File | Cos'è |
|------|-------|
| `gateway-config.json` | L'elenco dei figli. Percorsi come `${HOME}/...` per restare portabili. Non è nel repo pubblico: è la configurazione di questo Mac; per crearne una, `gateway-config.example.json` nel pacchetto. |
| `.env` | I segreti referenziati come `${VAR}` nella config. Gitignorato. |
| `start.sh` | Carica `.env`, pinna `MCP_GATEWAY_CONFIG` e `MCP_GATEWAY_REGISTRY`, lancia il pacchetto. |
| `com.jarvis.gateway.plist` | Il LaunchAgent del daemon (porta 23371). |
| `introspect.mjs` | Dump dei tool per la dashboard del router. **Non** fa parte del pacchetto. |

## Modificare il gateway

Si edita `~/Projects/mcp-hot-gateway`, non questa cartella. `node_modules` è un
symlink, quindi la modifica è attiva al riavvio successivo — nessun reinstall.

```bash
npm test --prefix ~/Projects/mcp-hot-gateway     # la barra: esce non-zero se rompe
launchctl kickstart -k gui/$(id -u)/com.jarvis.gateway
tail -f ~/.claude/jarvis/logs/gateway.err.log
```

Il gateway è condiviso da tutte le sessioni: al riavvio le chiamate in corso si
tagliano. Le sessioni si riconnettono da sole (sessione sconosciuta → 404 -32001,
dal 25/10); il riavvio si fa di notte, a Mac fermo e con `inFlight` a zero, come
fa `scripts/gateway-restart-tonight` (`--dry-run` dice se adesso si potrebbe).

## Aggiungere un figlio

A caldo, dalla sessione: `gateway_mount {name, transport, command|url, ...}` —
viene persistito da solo in `gateway-config.json`. Per parcheggiarlo (resta in
config ma non parte al boot): `gateway_unmount {name}`.
Un figlio parcheggiato montato al volo torna a riposo da solo dopo 15 min senza
chiamate (`GATEWAY_IDLE_PARK_MINUTES`), e una chiamata a un suo tool lo rimonta.
Soglia per figlio con `"idleParkMinutes"` (0 = mai): chrome-devtools è a 60 perché
pagina e login stanno nel processo e un agente che aspetta non li deve perdere, ma un
Chromium headless non resta acceso per sempre. 0 solo con un motivo scritto qui.

## Trappola

`start.sh` **deve** esportare `MCP_GATEWAY_CONFIG` esplicitamente. Il default del
pacchetto è relativo alla posizione del suo `index.mjs`, che ora è
`~/Projects/mcp-hot-gateway/` — senza quella riga il daemon parte con zero figli.
