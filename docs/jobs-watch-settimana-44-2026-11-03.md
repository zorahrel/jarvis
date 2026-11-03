# jobs-watch, settimana 44: 33 note + 48 mai partiti

Card Topics `2ea13038` (nota del conteggio domenicale, 01/11). Riclassificate
tutte le note sui transcript veri; sei cure applicate a `~/.openclaw/bin/`,
ognuna legata a casi misurati. Patch reversibile in
`state/jobs-watch-patch-2026-11-03.diff` (`patch -R` verificato a secco).

## Promesse: 33 note

Rilette una per una (conteggio domenicale: 10 NO_REPLY; oggi 8, due sessioni
sono sparite nel frattempo):

- 11 rilanci o stati presi in carico (veri positivi);
- 8 falsi allarmi (Jarvis ha risposto NO_REPLY, niente da fare):
  - 2 su messaggi che iniziano con ✅ ma contengono una frase da promessa
    («…dimmi tu se lo faccio», «…Lo faccio?»): il controllo del ✅ veniva
    dopo il COMMIT nello stesso messaggio;
  - 1 sulla riga propria di fermo («❌ … Jarvis lo riprende»), tornata nel
    transcript come messaggio assistant e passata per COMMIT;
  - 1 sul participio passato («è tutto ripreso e consegnato»);
  - 3 su domande all'utente («…i dati fiscali della ditta?», «…Lo faccio?»),
    che aspettano un ok per costruzione;
  - 2 su promesse già esaudite nel turno senza ✅ né sottoagente
    («Fatto, il tuo canale è…») — la scansione risale oltre l'esito.
- 14 «senza risposta»: le 7 sessioni non sono più nei DB (0 eventi in
  entrambi gli agent DB), non è Jarvis che tace.

Cure in `jobs-watch.py`: il ✅ chiude prima del COMMIT (riga ~684); le righe
proprie `❌ …Jarvis lo riprende` si saltano (~691); `ripresa` resta nome da
promessa ma `ripreso` no (~44); i messaggi che finiscono con `?` si saltano
(~695). Nel settimanale (`jobs-watch-weekly.py:33`): le sessioni sparite si
contano a parte («sessioni sparite»), non come «senza risposta».

## Mai partiti: 48 undelivered

- 16 sottofigli (giudici, verifiche) che rispondono al padre, non al canale:
  OpenClaw li marca `intentional_non_delivery`, nessun risultato perso.
  Ora esclusi come `delivered`/`not_required` (`jobs-watch.py:471`).
- 7 poi consegnati davvero (transitori, ok), 15 guasti veri
  (`permanent_failure` + `retryable`, tenuti).
- 10 non più verificabili: 8 run usciti da `subagent_runs`, 2 chiavi
  `undelivered:announce:requester-settle:…` di un formato vecchio.

## Non fatto (e perché)

- «Non preparo bozze finché non mi dici di riprendere» (1 caso): negazione,
  nessuna regola deterministica pulita.
- Bozza di email col verbo «riprendere» dentro (1 caso): testo citato, non
  impegno sul canale; distinguerlo vuole un giudizio, non una regex.
- «Fatto…» senza ✅ (2 casi): allargare la chiusura oltre ✅ è pericoloso
  («Fatto salvo…» nega, non consegna).

## Prova

- `tests/jobs-watch-test.py`: VERDE, exit 0, 48 mutanti presi (5 nuovi per
  queste cure; i replay sui transcript veri passano invariati).
- Nuovo `tests/jobs-watch-weekly-test.py`: VERDE (1+1+1+1 conteggiati,
  card via stub, silenzio senza note).
- Settimanale sui dati veri con stub al posto di board-card: exit 0,
  «67 mandate + 86 undelivered… senza risposta 0, sessioni sparite 30».
- `jobs-watch.py --dry-run` sui DB veri: exit 0.
- Giro launchd dopo la cura (03/11 05:34:02): `jobs-watch: 0 righe inviate`,
  nessun traceback nel log.
