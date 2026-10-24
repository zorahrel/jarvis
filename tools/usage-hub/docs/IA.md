# IA dell'hub (giro 11)

Una sola fonte: nomi, stati e testi brevi li calcola `src/board.mjs` e li espone `GET /api/board`.
Pagine dell'hub e tray leggono da lì e non ricompongono frasi. Lunghezze massime in caratteri: oltre si tronca con «…».

Riferimenti bento:
- Stephen Few, *With Dashboards, Formatting and Layout Definitely Matter*, 2008. La griglia simmetrica rigida è un errore: dimensione = importanza.
- Datadog dashboards: griglia a 12 colonne, il riquadro dà il segnale e il dettaglio si apre col clic.
- Synmek, *Bento design*, 2024: l'ordine del DOM è l'ordine di lettura, e su telefono una colonna nello stesso ordine.

## Panoramica a bento

Griglia a 12 colonne, gap 16, righe di uguale altezza (36 px) dentro ogni riquadro.

```
1440×900                                       375
[Ti aspetta  L 7][Quote e ritmo M 5]           Ti aspetta
[Lavori in corso M 7][Mac      S 5]            Quote e ritmo
[                   ][PC       S 5]            Lavori in corso
[                   ][Automaz. S 5]            Mac · PC · Automazioni
[Progetti M 12                       ]          Progetti
```

Sopra la piega a 1440×900: Ti aspetta, Quote e ritmo, Lavori in corso, Mac, PC.
Spariscono il banner di stato («Tutto in linea», «Codex … frenati»), il riquadro «Come funziona il freno» (va dentro Quote e ritmo) e la Coda (diventa righe «in coda» in Lavori).

| Riquadro | Contiene | Riga chiusa (max) | Aperta |
|---|---|---|---|
| Ti aspetta (L) | decisioni, spese, cose pubbliche, ok a vista, e i compiti che toccano ad Attilio | titolo 60 · perché 80 | link all'azione |
| Quote e ritmo (M) | una riga per account: tachimetro, % usata, badge | `Claude · attilio` 24 · badge 28 | motivo del freno 120, barre 7 g, «come funziona» |
| Lavori in corso (M) | max 5 righe in corso o in pausa, poi «altri N» → pagina Lavori | titolo 50 · stato 32 · durata 8 | – |
| Mac (S) | una riga | «Mac: sotto sforzo da 12 min» 40 | CPU, RAM, chi pesa |
| PC (S) | una riga | «PC: dorme» 40 | lavori in corso sul PC |
| Automazioni (S) | una riga | «2 da sistemare» o «tutte regolari» 32 + token 24 h | link a Automazioni |
| Progetti (M) | una riga per progetto, nome dal display | nome 32 · stato 24 · quota 6 | – |

## Tachimetro del ritmo (uno per account)

`value = max(ritmo settimana, ritmo giorno)`, dove 1 vuol dire in linea:
- ritmo settimana = % usata / % di settimana trascorsa;
- ritmo giorno = ultime 24 h / quota giornaliera sostenibile.

Sono le stesse due soglie del freno del lavoro rimandabile, quindi la zona rossa del quadrante coincide col freno.
Scala da 0 a 2, con la lancetta fermata a 2.

| Zona | Quando | Testo (max 28) |
|---|---|---|
| `sotto` | value < 0,85 | «sotto ritmo» |
| `in_linea` | 0,85 ≤ value ≤ 1 | «al ritmo» |
| `sopra` | value > 1 e nessun freno (ultimo giorno usa-o-perdi, override) | «sopra ritmo» / «libero fino alle 18:00» |
| `frenato` | il gate blocca il lavoro rimandabile su questo account (ritmo, giorno, riserva, 5h, esaurito) | «frenato fino a dom 17:49» / «esaurito, torna lun 09:00» |
| `ignoto` | quota non letta, o meno del 5% di settimana trascorsa e niente 24 h | «ritmo non ancora misurabile» |

Con freno di riserva, 5h o esaurito la lancetta va a 2, anche se il ritmo è basso.

API, per account: `{ id, provider, label, gauge: { value, week, day, zone, until, kind, short, reason } }`.
`short` è il badge. `reason` (max 120) si legge solo aperto, per esempio «consuma 1,4 volte il previsto, riparte quando la settimana arriva al 61%».
Sulla tray: un mini-tachimetro di 16 px nella riga dell'account, con lo stesso `short` accanto.

## Freno in linea

Il freno compare in due posti soltanto:
- nella riga dell'account frenato: badge `short` e, aperto, `reason`;
- nelle righe dei lavori che ferma davvero: «in pausa: Codex frenato» (max 32), con l'ora di ripartenza nel tooltip.

Nessun avviso generico altrove.
«Come funziona il freno» (le classi di lavoro, chi va dove) sta in fondo a Quote e ritmo, chiuso di default.

## Lavori (nuova pagina, sotto Agenti)

Comprende sessioni vive, workflow lanciati dalle sessioni, subagenti e coda delega. Esce da Automazioni.

| Colonna | Max | Note |
|---|---|---|
| Titolo | 60 | solo italiano; se il titolo è inglese o un id si usa «Lavoro su <progetto>» |
| Tipo | 10 | sessione · workflow · subagente · delega |
| Progetto | 24 | il display dell'hub |
| Stato | 32 | `in corso` · `in coda` · `in pausa: <Provider> frenato` · `finito` · `fallito` |
| Durata | 8 | «12 min», «2 h 05» |
| Agenti | 3 | numero |
| Token | 7 | «1,2 M», allineati a destra |

Righe in corso prima, poi finite delle ultime 24 h. In Panoramica vanno le prime 5 in corso o in pausa.

## Automazioni

- **Consumi.** In testa il totale per provider su 24 h e 7 g («Claude 1,2 M · 8,4 M token»). Ogni riga ha la colonna Consumo (24 h / 7 g), che può valere:
  - i token dei giri OpenClaw, letti da `task_runs.detail_json.usage` (con modello e provider);
  - i token dei passi, per i workflow;
  - «solo script» per i cron a riga di comando e i launchd senza modello;
  - «non misurato» per i launchd che chiamano un modello senza riceverne il conto. Queste righe si contano in testa a parte, mai come zero.
- **Da sistemare** contiene un'automazione solo se il suo ULTIMO giro è fallito. «2 errori in 24 h» con l'ultimo ok non ci entra.
- **Compiti** (`"tipo": "compito"` in `descrizioni.json`, per esempio aws-case-check, «Conferma del rimborso AWS») escono da Automazioni:
  - se tocca ad Attilio vanno in Ti aspetta (`tipo: decisione`, ref = id del cron);
  - altrimenti diventano una card della board (`board-card --key <id del cron>`).
  - Senza il campo `tipo` vale `automazione`.

## Compatto

- Righe di uguale altezza.
- Numeri in `tabular-nums`, allineati a destra.
- Una barra solo dove il confronto conta (le barre 7 g aperte), altrove il numero.
- Nessun testo ripetuto fra riquadri: il freno sta sull'account e sul lavoro, non anche in un banner.

## Barra del giro

- `vis affianca` prima e dopo, sia vivo sia demo, a 1440×900 e a 375.
- Controlli DOM:
  - i cinque riquadri sopra la piega;
  - nessun testo «frenat» fuori da `.acct` e `.job.paused`;
  - «Lavori lanciati» assente in Automazioni;
  - ogni riga di automazione con il consumo.
- Tachimetro: un caso per zona.
- Mutanti, tutti attesi rossi:
  - zone invertite;
  - banner del freno rimesso;
  - «Da sistemare» sul conteggio errori invece che sull'ultimo giro.

## Non ancora specificato

- Quali launchd chiamano un modello: per ora «non misurato». Per misurarli serve che passino dal proxy VDM con un'etichetta.
