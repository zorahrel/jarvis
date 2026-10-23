# Parità con la vecchia pagina VDM

La pagina VDM (`modules/vdm/dashboard.mjs`, tolta in ec631dd) è sostituita dalla dashboard del hub (`:3360`). Elenco ricavato da `git show ec631dd^:modules/vdm/dashboard.mjs`.
Prova automatica: `node --test test/dashboard-parity.test.mjs` (campi dati in `test/fixtures/vdm-page-fields.json`, deve leggerli tutti `public/*.js`; esce non zero se ne manca uno).
Colonna «Era mancante»: sì = persa in ec631dd e ripristinata dopo.

| Voce della vecchia pagina | Era mancante | Dove sta ora | Prova |
|---|---|---|---|
| Interno/esterno per finestra (`externalShare`, `coverage`, «% mio · % da fuori»), con periodo e spiegazione | sì | Account → `attrFigures` (vdm-tabs.js) | screenshot Account, riga «misurato sul 15% del periodo…» |
| Striscia a fasce (interno / esterno / non misurato, `bands`, `deltaUtil`) e legenda | sì | Account → `attrStrip`, legenda in `renderAccounts` | screenshot Account |
| Token interni, € a listino, I/O e cache (`myTokens`, `myCostUsd`, `tokenBreakdown`) | sì | Account → `attrFigures` | screenshot Account |
| Grafico d'uso 24 h e 7 giorni (`utilizationHistory`, `weeklyHistory`) | sì | Account → `sparkline` | screenshot Account |
| Tetto sulla barra (marcatore) e «tetto N%», «tetto raggiunto» (`cap.effective`, `over5h`, `over7d`) | sì | Account → `capMark`, `renderAccounts` | `grep capMark public/vdm-tabs.js` |
| Piano con moltiplicatore (MAX 20x, `rateLimitTier`) | sì | Account → `planLabel` | screenshot Account |
| Stima del tempo al limite (`minutesToLimit`) | sì | Account → pillola «limite tra…» | `grep minutesToLimit public/vdm-tabs.js` |
| Motivo del blocco (`blockKind`: quota 5h/7d, token, modello, extra usage, OAuth 403) e pausa per modello (`modelBlocks`) | sì | Account → `BLOCK`, messaggi in `renderAccounts` | test di parità |
| Token scaduto / rinnovo fallito (`expired`, `refreshFailed`, `retriable`, `expiresAt`) con pulsante Aggiorna | sì | Account → messaggio «Token scaduto…» | test di parità |
| Account dormiente (`dormant`), spento (`disabled`) | sì | Account | test di parità |
| Banner «tutti esauriti» e primo reset (`allExhausted`, `earliestReset`) | sì | Account → banner in cima | test di parità |
| Intestazione: strategia, sonde 7 giorni, overhead (`probeStats`), coda e Balance (`queueStats`) | sì | Account → riga in alto a destra | screenshot Account |
| Account API: priorità, attiva/disattiva, saldo e uso (`balance`, `usage5h`, `usage7d`) | sì (saldo/uso) | Account → sezione «Account API» | test di parità |
| Statistiche Claude Code a 14 giorni (`stats`, `dailyActivity`, `modelUsage`) | sì | Account → riquadro chiuso (appare se VDM ha la cache) | test di parità |
| Priorità ±, tetto per account (interruttore e due caselle), acceso/spento, cambia account, rimuovi, aggiorna token | no | Account → `renderAccounts` + azioni in app.js | clic sui pulsanti non provato (solo lettura verificata) |
| Cambio automatico, proxy attivo, notifiche | no | Impostazioni | screenshot Impostazioni |
| Tetti globali 5h e 7g, attesa massima (`usageCapHoldMin`), cambio USD→EUR (`usdEur`) | in parte | Impostazioni | screenshot Impostazioni |
| Strategia di rotazione con descrizione, intervallo (`rotationIntervalMin`), richieste in parallelo (`maxConcurrentPerAccount`) | sì (intervallo, parallelo, descrizioni) | Impostazioni → `renderSettings` | test di parità |
| Richieste in fila e pausa (`serializeRequests`, `serializeDelayMs`), token nei commit (`commitTokenUsage`), monitor sessioni (`sessionMonitor`) | sì | Impostazioni → sezione Beta | test di parità |
| Consumi: filtri cartella/modello/account/periodo, token totali/input/output/richieste/€ listino | sì (filtri) | Consumi → `drawUsage` | screenshot Consumi |
| Risparmio del piano al giorno, grafico del risparmio, token al giorno | sì | Consumi → `drawUsage` | screenshot Consumi |
| Per modello, per account, per cartella e ramo (espandibile), esporta CSV | sì (ramo, CSV) | Consumi | screenshot Consumi |
| Sessioni: attive con cronologia, in attesa di input, attività corrente, recenti con costo, conflitti, overhead del riassunto | sì (attesa, costo, conflitti, overhead, cronologia) | Sessioni → `renderSessions` | test di parità |
| Attività: 14 tipi di evento (cambi, rate limit, token, scoperta, rinomina, spento…) | sì (11 tipi su 14) | Attività → `EVT` | `grep "auth-expired" public/vdm-tabs.js` |
| Log in diretta | no | Log → `renderLogs` (app.js) | screenshot Log |
| Pannelli del hub di 52b3845: consumo per progetto, Muse, attribuzione proxy, quote tray | no (già ripristinati) | Consumi → `extraPanels` (app.js) | screenshot Consumi |
| «Lavori a orario» della scheda Servizi (job launchd a orario con l'ultimo codice d'uscita) | no (spostati) | Automazioni → gruppi per esito, insieme a OpenClaw, Claude desktop, workflow, GitHub e PC; Servizi tiene «Le tue app» in cima | `python3 scripts/prova-automazioni.py`, `docs/automations-*.png` |

## Non portato (di proposito)
- Animazione di ingresso delle schede e «braille» che gira sulle sessioni in elaborazione.
- Copia della cronologia negli appunti (pulsante nella sessione).
