---
name: senior-pass
description: |
  Una passata completa da ingegnere senior su un progetto esistente: misura la barra, mappa
  l'architettura, spazza 11 assi (architettura, audit, debug, performance, refactor, dati,
  affidabilità, frontend, sicurezza, deploy/CI-CD, decisioni tecniche), triaga per impatto/costo,
  applica TUTTI i fix che sopravvivono al triage e li dimostra uno per uno. Usa questa skill
  quando l'utente dice "/senior-pass", "passata da senior", "migliora questo progetto",
  "audita e sistema", "portalo a livello produzione", "fai tutto quello che serve".
  NON usarla per scrivere una feature nuova, né per un fix banale (typo, one-liner): lì si
  aggiusta e basta. NON usarla su un repo vuoto: serve codice da leggere.
hooks:
  Stop:
    - hooks:
        - type: prompt
          timeout: 30
          prompt: |
            Decidi se Claude può chiudere il turno. Dati del turno (JSON): $ARGUMENTS
            Giudica solo last_assistant_message.
            Rispondi {"ok": true} se vale una di queste: non dichiara lavoro finito (è una domanda o un aggiornamento intermedio); ogni cosa data per fatta ha accanto la sua prova (comando con exit code, misura letta, percorso di screenshot o video); nomina un blocco specifico (comando, file o errore preciso); chiede ad Attilio una decisione su spesa, pubblico, cose irreversibili o dati di persone vere.
            Rispondi {"ok": false, "reason": "<cosa manca, una riga>"} se dichiara fatto, risolto, funziona o verde senza la prova accanto, oppure chiude con passi che Claude poteva fare da solo («prossimi passi», «puoi lanciare», «se vuoi faccio»).
            Se stop_hook_active è true e il messaggio ora spiega perché la prova manca, {"ok": true}.
            Solo il JSON, niente altro.
---

# senior-pass

Il prompt in un blocco solo, copiabile in qualunque harness: `PROMPT.md`. Questa pagina è
come si esegue.

## Le due regole che la rendono diversa da "act as a senior engineer"

**1. Un giudizio senza misura è un'opinione.** Ogni affermazione della passata si attacca a
una delle tre prove, o non entra nel rapporto:

| Prova | Forma |
|---|---|
| **Comando** | un comando che oggi esce non-zero (o non esiste) e domani esce zero |
| **Numero** | una misura letta due volte, prima e dopo, con lo stesso metodo |
| **Riga** | `file:riga` più la condizione che la fa sbagliare |

«Il codice è poco manutenibile», «l'architettura non scala», «ci sono rischi di sicurezza»
non sono reperti: sono aggettivi. Se non riesci ad ancorarli, cadono.

**2. Si finisce.** Non c'è un tetto di fix. Il criterio di stop è **la lista vuota**: ogni
reperto è o *aggiustato con la sua prova*, o *scritto nel rapporto con il motivo per cui non
lo è*. Finire il tempo, i tentativi o le idee è il motivo per cui ti sei fermato, non la
prova che il lavoro è fatto. Undici assi chiesti = undici consegnati, anche quelli con
risposta «qui non si applica, ecco perché».

## Sequenza

**0 · Barra.** Prima di leggere una riga di logica: trova i comandi che dicono se il progetto
è sano (script di `package.json`, `Makefile`, CI). Eseguili e registra lo stato di partenza —
verde, rosso o assente. Da qui in poi *ciò che è verde resta verde*: la barra si riesegue
identica dopo ogni fix.
**Se non esiste barra, il primo deliverable è la barra**, non i fix: senza, non puoi
dimostrare di non aver rotto niente e la passata diventa un rischio invece di un miglioramento.
Se l'albero git è sporco, fermati e dillo: si lavora su un albero pulito.

**1 · Mappa.** Reverse-engineering: entry point, flusso dati, confini dei moduli, dove vivono
stato e persistenza, cosa gira davvero in produzione. Output: 10-20 righe. Serve a te per il
passo 2, non all'utente.

**2 · Sweep sugli 11 assi.** Ognuno è un mestiere diverso: cambia la domanda che ti fai, non
solo il vocabolario. Per ognuno cerca *reperti ancorati*, non impressioni.

| # | Asse | La domanda |
|---|---|---|
| 1 | **Architettura** | quali confini esistono davvero, e quali sono solo nei nomi delle cartelle? |
| 2 | **Audit da nuovo arrivato** | cosa fa perdere mezza giornata a chi entra oggi: logica duplicata, decisioni non scritte, magia implicita? |
| 3 | **Correttezza / debug** | race, errori ingoiati, `catch` vuoti, stato non invalidato, edge case. Traccia la causa vera, non la riga che esplode. |
| 4 | **Performance** | N+1, lavoro nel loop caldo, render inutili, allocazioni in path caldi, leak. **Misurata, non annusata**: numero prima → numero dopo. |
| 5 | **Refactor / modularità** | funzioni che fanno cinque cose, accoppiamenti che costringono a toccare N file per una modifica, dead code, nomi che mentono. |
| 6 | **Dati** | lo schema mente? Stati impossibili rappresentabili, migrazioni non reversibili, indici mancanti sulle query reali. |
| 7 | **Affidabilità** | cosa succede quando la rete cade, il disco è pieno, il processo muore a metà: retry senza backoff, timeout assenti, scritture non atomiche. |
| 8 | **Frontend** | loading/empty/error assenti, layout shift, tap target, a11y e contrasto. Misura il DOM o usa gli snapshot Playwright: **mai un VLM per la geometria fine**. |
| 9 | **Sicurezza** | segreti in chiaro, injection, authz mancante sugli endpoint, dati sensibili nei log, dipendenze note-vulnerabili. Per i segreti usa `/usr/bin/grep`, mai `grep` (qui è ugrep: salta `.env` e i path in `.gitignore`). |
| 10 | **Deploy / CI-CD** | come ci si arriva in produzione: pipeline, rollback, monitoring, log utili, healthcheck, deploy manuale, check che non ha mai visto rosso, build lenta, `README` che non basta per partire. |
| 11 | **Decisioni tecniche** | dove il progetto sta pagando una scelta sbagliata, cosa costerà fra un anno, quale complessità va tolta invece che gestita. Qui non si aggiusta: si scrive il tradeoff. |

Un asse non pertinente si salta **dichiarandolo** («niente frontend in questo repo»), mai in
silenzio: un asse saltato senza dirlo si legge come un asse pulito.

**3 · Triage.** Ordina per `impatto ÷ costo`. Poi taglia:
- **Un check che non ha mai visto rosso non è un check.** Se non riesci a far *fallire* il test che difende un fix, il fix non è dimostrato.
- Ciò che costa lavoro vero e non è verificato va rifiutato *prima* di scriverlo, non dopo. Chi verifica non è chi ha scritto: manda un subagent `verifier` a **refutare** il reperto, uno alla volta.
- Quello che sopravvive si fa tutto. Se la lista è lunga, si lavora a ondate (asse per asse), non si accorcia.

**4 · Fix.** Uno alla volta, ognuno con la sua prova, ognuno col suo commit.
**Non cambiare il comportamento del prodotto.** Se un fix richiede di cambiarlo, non è un fix:
è una proposta e va nella lista finale (asse 11).
Dopo ogni fix: la barra intera, non solo il test nuovo. Un rosso nuovo si risolve subito o si
annulla il fix — non si accumula debito dentro la passata stessa.

**5 · Rapporto.** Corto, e in questo ordine:
- **Fatto** — cosa è cambiato, con la prova accanto (comando + esito, o numero prima→dopo).
- **Trovato e non fatto** — reperto, dove, perché è stato lasciato (costo, rischio, fuori scope). Motivi specifici: «serve un blocco sull'API di Stripe», non «serve approfondire».
- **Rifiutato** — cosa sembrava un problema e non lo era. Questa sezione vale quanto le altre: dice che hai guardato.
- **Assi saltati** — quali e perché.
- **Prossimi passi** — 1-3, numerati, il tuo consigliato per primo e marcato `(consigliato)`.

## Uso

```
/senior-pass                    # tutti gli 11 assi, tutti i fix che sopravvivono al triage
/senior-pass perf security      # solo quegli assi, stessa regola: si finiscono
/senior-pass src/api            # recinta la passata a un sottoalbero
/senior-pass --dry              # si ferma al passo 3: reperti e triage, nessuna modifica
```

## Quando NON usarla

- **Repo che non è tuo da toccare**: gira `--dry`.
- **Prima di una demo o di un rilascio**: una passata tocca codice funzionante. Il momento giusto è dopo un rilascio, non due ore prima.
- **Al posto di una spec**: se il progetto ha `openspec/`, i cambiamenti di comportamento passano di lì. Questa skill migliora l'esistente, non decide il prodotto.
- **Su una feature nuova**: qui non c'è niente da misurare prima.
