# IDEA: kanban di Topics su pipeline Lobster (solo idea, mezza pagina)

Oggi la kanban di Topics dispaccia task a agenti liberi; il lavoro vero (build,
test, review, land) resta una sequenza di chiamate orchestrate dal modello, che
si perde a ogni riavvio. Con Lobster ogni colonna che avanza da sola diventa un
passo di pipeline: `build → test → review → land`, con un cancello di
approvazione prima di `land` (equivale all'odierna review umana) e un cancello
di input quando l'agente fa una domanda (oggi si blocca la sessione, domani
risponde al checkpoint e la pipeline riprende).

Ogni task in `todo` genera un file `.lobster` parametrico
(`args: repo, worktree, branch`); i resume token stanno in `~/.lobster/state`,
quindi un riavvio del gateway riprende dal cancello senza rifare build e test.
La board resta la vista umana (stato = ultimo checkpoint raggiunto), Lobster il
motore sotto. Unico limite noto: nel runner embedded `openclaw.invoke` verso
altri tool non è affidabile — i passi devono restare comandi shell/CLI
(`topics-board` via CLI dove c'è, altrimenti script), non chiamate a tool
OpenClaw annidati. Prima di migrare: una sola board pilota con `board_land`
sostituito da merge shell, e la dashboard di verifica già prevista per il PoP.
