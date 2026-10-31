---
name: vai
description: Procedi autonomamente su tutto — solido e pulito, verifica, committa, riporta a fine
argument-hint: [scope opzionale, es. "solo il bug X"]
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

Procedi autonomamente e fino in fondo su tutto il lavoro pendente o implicito $ARGUMENTS. Regole:

- **Solido e pulito**: fai la cosa giusta, non la minima. Se una cosa va fatta meglio, falla meglio. Niente scorciatoie, niente TODO lasciati indietro.
- **Autonomo**: non chiedere conferma per passi reversibili (edit, refactor, test, commit locali, kickstart). Decidi e agisci. Chiedi SOLO per azioni irreversibili o verso l'esterno (push forzati distruttivi, invio email/messaggi, delete permanenti, pagamenti, cambi di permessi).
- **Verifica sempre**: prima di dire "fatto" fai girare typecheck, lint e i test rilevanti (unit + eventuali e2e mirati). Se qualcosa è rosso, leggilo e fixalo — non consegnare rosso, non nascondere fallimenti.
- **Il comando decide, non il tuo giudizio**: "fatto" si dice solo dopo che un comando è uscito zero o una misura è stata letta. Finire i tentativi, il tempo o le idee è il motivo per cui ti sei fermato, non la prova che funziona: in quel caso scrivi cosa resta non verificato e perché. Un test che non hai mai visto fallire non è un test — se aggiungi un check, verifica almeno una volta che sappia diventare rosso.
- **Non ripetere un tentativo identico**: se un fix non ha cambiato nulla nell'albero e l'errore è lo stesso di prima, fermati e cambia approccio invece di rilanciare lo stesso giro.
- **Commit**: committa il lavoro a step logici. Messaggi in italiano, imperativi. MAI trailer `Co-Authored-By:` né righe "Generated with Claude Code". `trash` > `rm`.
- **Deploy**: per modifiche server applica via `launchctl kickstart -k` (mai bootout).
- **Riporta a fine**: max 600 caratteri fuori dal codice, niente liste annidate. Riga 1: com'è finita. Poi un esito per riga con la sua prova (run, exit code, misura), mai l'elenco dei passi: la completezza la prova il comando. Se resta qualcosa che dipende da me (secret, push, merge, decisione), 1-3 punti numerati col consigliato per primo. Una decisione aperta si incolla, una riga per scelta con «ok / ok ma 2 no», mai «rileggi il file». Notificami quando è finito o se sei davvero bloccato.

Non fermarti a metà per chiedere "vado avanti?" — vai avanti.
