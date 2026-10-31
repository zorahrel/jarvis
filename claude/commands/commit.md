---
name: commit
description: Analizza le modifiche e scrive un commit che spiega il perche', non il cosa
---

Analizza tutte le modifiche non ancora committate (staged e unstaged, inclusi file untracked) e procedi con questo flusso:

## 1. Analisi e raggruppamento per feature

- Esegui `git status` e `git diff` per capire tutte le modifiche pendenti.
- Raggruppa i file modificati in **commit logici separati per feature/scopo** (es. "refactor sidebar", "add agent spawn card", "fix connection status", ecc.).
- Ogni gruppo deve avere senso come unità atomica di cambiamento.
- Se un file ha modifiche che appartengono a più feature, segnalalo all'utente.

## 2. Pulizia

- Identifica file che non dovrebbero essere committati: screenshot di debug, file temporanei, build artifact, `.DS_Store`, ecc.
- Mostra la lista dei file da eliminare e **chiedi conferma** prima di rimuoverli.
- Usa `trash` se disponibile, altrimenti `rm`.

## 3. Presentazione del piano

Mostra all'utente il piano dei commit proposti, in ordine, con:
- Nome/descrizione breve del commit
- Lista dei file inclusi
- Eventuali problemi trovati nel codice di quel gruppo (code quality, bug, pattern inconsistenti, import mancanti, codice morto, ecc.)

**Chiedi conferma** prima di procedere. L'utente può:
- Approvare tutto
- Chiedere di unire o separare gruppi
- Chiedere di fixare problemi specifici prima di committare
- Escludere file o gruppi

## 4. Fix dei problemi

Per ogni gruppo, **prima di committare**, correggi automaticamente i problemi trovati:
- Import inutilizzati o mancanti
- Codice morto o variabili unused
- Pattern inconsistenti rispetto al resto del codebase
- Bug evidenti o errori di tipo

Se ci sono problemi ambigui o che richiedono una decisione, **chiedi all'utente** prima di intervenire.

## 5. Commit sequenziali

Per ogni gruppo approvato, in ordine:
1. Applica i fix necessari
2. Fai `git add` solo dei file di quel gruppo
3. Committa con un messaggio chiaro e conciso in inglese
4. Verifica che il commit sia andato a buon fine

## Regole

- Messaggi di commit in inglese, concisi, che spiegano il "perché" non il "cosa"
- Non pushare — solo commit locali
- Non includere file sensibili (.env, credentials, ecc.)
- NON aggiungere co-author o trailer ai messaggi di commit
