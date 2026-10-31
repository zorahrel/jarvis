---
name: tool-forge
description: Stai pilotando a mano un sito o API (≥3 browser_eval o fetch uguali)? Proponi e crea la bozza di un tool (distillato o MCP) in _drafts, testata. Promozione umana.
---

# Tool forge — dal lavoro a mano a un tool

Il distiller settimanale (`~/.claude/jarvis/agents/distiller`) trova i pattern a posteriori, dalla
memoria. Questa skill è la stessa cosa **dal vivo**: te ne accorgi mentre lavori, lo dici e crei la bozza.

## Quando scatta
Una qualunque, nella stessa sessione:
- la **stessa operazione su un sito ≥3 volte** a mano (stessa URL con parametri diversi, stesso selettore);
- **browser_eval / open_browser_pane in serie** per estrarre dati (caso di scuola: una ricerca di
  viaggio fatta con centinaia di browser_eval sugli stessi siti di prenotazione);
- un calcolo ricostruito a mano da fonti fisse (tariffe, distanze, orari) che rifaresti la prossima volta.

Prima di proporre, **controlla che non esista già**: `gateway_list` (figli parcheggiati compresi),
`ls ~/.claude/jarvis/distilled ~/.claude/jarvis/distilled/_drafts`, cheatsheet
`~/.claude/jarvis/memory/tools/{travel,shopping,mcp-gateway}.md`. Esiste ma è rotto o incompleto?
Si **estende quello** (es. un tool in più in `~/Projects/viaggi-mcp`), non se ne fa un secondo.

## Cosa dire (una riga, poi lo fai)
«Sto pilotando <sito> a mano per la N-esima volta: ne faccio una bozza di tool `<nome>` in _drafts,
la promozione resta tua.» Creare la bozza è reversibile e gratis: non chiedere il permesso per quella.
Finisci prima la risposta all'utente se è urgente, poi la bozza.

## Quale forma
1. **API JSON/GraphQL raggiungibile con curl** (guarda le richieste di rete della pagina) → distillato
   `run` in zsh/node/python. È la strada più leggera e la più stabile.
2. **Serve JS ma non c'è anti-bot pesante** → distillato con Playwright **webkit** headless, chiuso a
   fine run (`playwright-core` è in `~/Projects/viaggi-mcp/node_modules`). Mai Chromium se WebKit regge.
3. **Più operazioni sullo stesso dominio, o stato condiviso** (browser riusato) → tool in un MCP
   esistente del dominio (`viaggi-mcp`, `shopping-mcp`), o MCP nuovo montato come figlio del gateway
   con `autoMount:false`. Per l'uso da terminale: `mcporter generate-cli --command "<cmd>"`.
4. Richiede giudizio a ogni passo → non è un tool, è una skill: annotalo e basta.

## La bozza di un distillato
`~/.claude/jarvis/distilled/_drafts/<nome>/` (nome `^[a-z0-9][a-z0-9_-]{0,63}$`):
- `manifest.json` → `{ "name", "description", "inputSchema", "timeoutMs" }`. Descrizione in una riga:
  cosa fa, input, output, limiti. `timeoutMs` ≤ 55000 se deve passare dal gateway (taglia a 60 s).
- `run` eseguibile: argomenti JSON su **stdin**, risultato su stdout (JSON compatto), exit ≠ 0 con
  messaggio chiaro se fallisce. Output piccolo: filtra lato server, niente HTML grezzo.
- `RATIONALE.md`: pattern visto (sessione/topic, quante volte), esempio di chiamata, cosa può rompersi.
- **Segreti solo dal Keychain**: `security find-generic-password -s <servizio> -a <uso> -w` dentro `run`.
- **Niente spesa**: API solo a pagamento → non si fa, si annota nel cheatsheet.

## Barra (si esegue, non si descrive)
```sh
D=~/.claude/jarvis/distilled/_drafts/<nome>
echo '<input reale del caso che ti ha fatto partire>' | $D/run; echo "exit=$?"   # 0 e dati veri
echo '{}' | $D/run; echo "exit=$?"                                            # ≠0 con errore leggibile
skillspector scan $D --no-llm                                                  # punteggio nel RATIONALE
```
Salva l'output reale in `RATIONALE.md`. Una bozza mai vista funzionare sul caso vero non è una bozza.

## Dopo
- Usa subito la bozza via CLI (`echo '{...}' | .../run`) per finire il lavoro in corso.
- Una riga nel cheatsheet del dominio (`~/.claude/jarvis/memory/tools/<dominio>.md`): nome, cosa fa,
  stato «bozza, in attesa di approve.sh».
- Nel resoconto: «Bozza `<nome>` pronta, per attivarla: `~/.claude/jarvis/mcp-servers/distilled/approve.sh <nome>`».
- **Mai promuovere da solo**: `approve.sh` lo lancia Attilio. Un tool aggiunto a un MCP esistente
  non passa da approve.sh, ma resta parcheggiato (`autoMount:false`) e si dice nel resoconto.
