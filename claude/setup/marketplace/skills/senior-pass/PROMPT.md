# senior-pass — il prompt in un blocco solo

Copia da qui in giù e incollalo in qualunque agente, dentro il progetto da migliorare.

---

Fai una passata da ingegnere senior su questo progetto. Non sei un generatore di codice:
decidi tu cosa vale la pena cambiare, lo cambi, e lo dimostri.

**GOAL** — lasciare il progetto misurabilmente migliore di come l'hai trovato, senza
cambiarne il comportamento.
**FUORI** — feature nuove, riscritture totali, cambi di stack, dipendenze nuove senza un
perché scritto, riformattazioni di massa che seppelliscono il diff.

**Due regole, non negoziabili.**
(a) *Ogni cosa che affermi si attacca a una prova, o non la dici*: un comando che oggi esce
non-zero e domani esce zero, un numero misurato due volte con lo stesso metodo, oppure
`file:riga` più la condizione che lo fa sbagliare. «Poco manutenibile», «non scala»,
«ci sono rischi» sono aggettivi, non reperti.
(b) *Si finisce*: non c'è un tetto di fix. Ogni reperto è o aggiustato con la sua prova, o
scritto nel rapporto col motivo specifico per cui non lo è. Finire il tempo o le idee è il
motivo per cui ti sei fermato, non la prova che il lavoro è fatto.

**0 · Barra.** Prima di leggere la logica: trova i comandi che dicono se il progetto è sano
(script di `package.json`, `Makefile`, CI). Eseguili e scrivi lo stato di partenza. Da qui in
poi ciò che è verde resta verde, e la barra si riesegue **intera** dopo ogni fix.
Se una barra non esiste, il primo deliverable è la barra, non i fix.
Se l'albero git è sporco, fermati e dimmelo.

**1 · Mappa.** Reverse-engineering in 10-20 righe: entry point, flusso dati, confini dei
moduli, dove vivono stato e persistenza, cosa gira davvero in produzione.

**2 · Sweep.** Undici assi, ognuno un mestiere diverso. Cambia la domanda che ti fai, non
solo il vocabolario. Un asse non pertinente si salta **dichiarandolo** («niente frontend
qui»), mai in silenzio.

1. **Architettura** — quali confini esistono davvero e quali sono solo nei nomi delle cartelle?
2. **Audit da nuovo arrivato** — cosa fa perdere mezza giornata a chi entra oggi: logica duplicata, decisioni non scritte, magia implicita?
3. **Correttezza / debug** — race, errori ingoiati, `catch` vuoti, stato non invalidato, edge case. Traccia la causa vera, non la riga che esplode.
4. **Performance** — N+1, lavoro nel loop caldo, render inutili, leak. Misurata, non annusata: numero prima → numero dopo.
5. **Refactor / modularità** — funzioni che fanno cinque cose, accoppiamenti che costringono a toccare N file per una modifica, dead code, nomi che mentono.
6. **Dati** — lo schema mente? Stati impossibili rappresentabili, migrazioni non reversibili, indici mancanti sulle query reali.
7. **Affidabilità** — rete che cade, disco pieno, processo che muore a metà: retry senza backoff, timeout assenti, scritture non atomiche.
8. **Frontend** — loading/empty/error assenti, layout shift, tap target, a11y e contrasto. Misura il DOM o usa gli snapshot; niente giudizi a occhio sulla geometria fine.
9. **Sicurezza** — segreti in chiaro, injection, authz mancante sugli endpoint, dati sensibili nei log, dipendenze vulnerabili.
10. **Deploy / CI-CD** — come ci si arriva in produzione: pipeline, rollback, monitoring, log utili, healthcheck, deploy manuale, check che non ha mai visto rosso, build lenta, README che non basta per partire.
11. **Decisioni tecniche** — dove il progetto sta pagando una scelta sbagliata, cosa costerà fra un anno, quale complessità va tolta invece che gestita. Qui non aggiusti: scrivi il tradeoff e sfida le assunzioni, comprese le mie.

**3 · Triage.** Ordina per impatto ÷ costo, poi taglia:
- se non riesci a far **fallire** il test che difende un fix, quel fix non è dimostrato;
- ciò che costa lavoro vero va refutato *prima* di scriverlo: rileggi il reperto cercando la ragione per cui è sbagliato, o fallo verificare a chi non l'ha scritto;
- quello che sopravvive si fa **tutto**. Lista lunga = si lavora a ondate, asse per asse; non si accorcia.

**4 · Fix.** Uno alla volta, ognuno con la sua prova e il suo commit. Il comportamento del
prodotto non cambia: se un fix lo cambierebbe, non è un fix, è una proposta e va nell'asse 11.
Dopo ogni fix rilancia la barra intera, non solo il test nuovo: un rosso nuovo si risolve
subito o si annulla il fix. Commenti e identificatori in inglese, anche se parliamo italiano.

**5 · Rapporto.** Corto, in questo ordine:
- **Fatto** — cosa è cambiato, con la prova accanto (comando + esito, o numero prima→dopo).
- **Trovato e non fatto** — reperto, dove, perché lasciato. Motivi specifici: «serve un blocco sull'API di Stripe», non «serve approfondire».
- **Rifiutato** — cosa sembrava un problema e non lo era (questa sezione dice che hai guardato).
- **Assi saltati** — quali e perché.
- **Prossimi passi** — 1-3, numerati, il tuo consigliato per primo e marcato `(consigliato)`.

Non chiedermi il permesso per leggere, misurare, provare o aggiustare: fallo. Chiedi solo se
un bivio cambia davvero il lavoro, e proponi tu la risposta che consigli.
