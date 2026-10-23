# Dove far girare i lavori lunghi e il coordinamento

## Da decidere

1. **Consigliata: Claude Code, con Discord come porta d'ingresso.** Jarvis lancia i lavori lunghi con `claude -p` (la via che OpenClaw usa già), lo stato va nel thread Discord, la Regia resta in Claude Code desktop. Perché: è l'unica via con una misura buona su lavori lunghi (85% arriva in fondo in 7 giorni), mentre Topics in quella settimana ha avviato 1 sola tab Claude: non c'è niente da misurare.
2. Alternativa: lavori lunghi e Regia in Topics. Più leggero di 1,5 GB fissi, ma oggi si riavvia a ogni modifica del suo codice (11 volte in 6 giorni) e ha perso un transcript il 22/10.

ok / ok ma 2 no

## Misure

**Arrivo in fondo, 17–23/10, lavori sopra i 15 minuti**
- `claude -p` da OpenClaw: 87 lavori, 74 finiti (85%), 8 timeout, 3 falliti, 2 orfani.
- Muse: 5 su 5.
- Correzione del 24/10: i «32 orfani senza modello» (37 in 14 giorni) non sono lavori muti. Sono record ridotti alla sola notifica per il padre (`parentCompletion`), che hanno perso i dati di esecuzione: in 4 casi su 6 controllati il transcript Claude è completo. I lavori davvero rimasti senza fine in 7 giorni sono 3.
- Topics: 1 tab Claude creata, 0 tentativi di card, 59 risposte complete contro 5 errori del provider e 6 timeout (poi recuperati). Server riavviato 11 volte (sempre exit 0, dopo una modifica al sorgente), 0 crash dell'app, 1 transcript perso il 22/10.

**Peso (footprint, non RSS), 24/10 ore 01**
- «topics-host ×97, 8,1 GB» non sono le tab di Topics. Sono i processi lanciati dai suoi terminali: 24 node di ChatGPT (computer use), 27 python orfani, i server di sviluppo di armonia-site (1,7 GB) e una sessione Claude riaperta 4 giorni fa (1,2 GB). 37 di questi processi hanno launchd come padre.
- Topics da solo pesa 0,54 GB (server 229 MB e host 310 MB). Claude desktop pesa 2,1 GB, più circa 120 MB per ogni sessione CLI (13 aperte).
- Il processo dell'agente è lo stesso `claude` CLI in tutti e due: la differenza è circa 1,5 GB fissi, non qualcosa per sessione.

**Quota**: uguale nelle due vie, perché gira lo stesso CLI. Quello che conta è il modello: niente Opus nei subagent, che sui lavori lunghi fallisce nel 33% dei casi contro il 20% di Sonnet.

## Il minimo perché Jarvis usi Claude Code per i lavori lunghi (fatto il 24/10)

- Mai Opus nei subagent: il router (`openclaw-delegate-router` 383fe97) porta a Sonnet ogni Opus, chiesto o scelto dal hub, anche col hub giù. Opus è tolto anche dalle riserve in `openclaw.json`. Entra in funzione al prossimo riavvio del gateway (`oc-restart --wait-idle` già in attesa). Muse resta il primo motore per il lavoro meccanico.
- Stato nel thread: lo fa già `lavori-watch` (15/45/90, fallimenti, promesse, «nessun segnale da 20 min»). Gli id restano fuori dal canale.
- Presa in mano dal telefono: `~/.openclaw/bin/lavori-ripresa.py` (bdba452) elenca i lavori in corso o caduti con `cd … && claude --resume <id>`, ricavato dal transcript. La Regia, aperta con Remote Control, lo lancia e riprende la sessione.
- Il punto sugli orfani a 30 minuti cade: gli orfani muti erano un errore di misura (vedi sopra).

## Spostare tutto il coordinamento in Topics

Topics ha già board, task, `spawn_agent` (tab visibile, in background, sveglia la chat madre col risultato), `session_send`/`session_read`, topic archiviabili e `move_session_to_project`. Rispetto agli strumenti CCD mancano: proposte di sessione da accettare con un clic, la nota viva delle sessioni collegate, il resoconto che risveglia chi le ha avviate tra sessioni non figlie, lo split view, il worktree per sessione. Non stimo il lavoro: il confronto oggi non lo fa vincere.

## Misura che gira da sola

Una riga in `mac-health --weekly` (il cron del lunedì alle 10 c'è già): per Topics e Claude Code, lavori lunghi avviati e finiti, riavvii del server, transcript persi, GB fissi, orfani sotto topics-host. Avvisa su WhatsApp se Topics arriva in fondo meno di Claude Code, si riavvia più di 3 volte a settimana o ha più di 10 orfani. Quando Topics avrà almeno 20 lavori lunghi in una settimana, la riga dice se il sorpasso è avvenuto.
