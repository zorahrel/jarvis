# Giro PoP wallrun come pipeline Lobster (PILOTA — non lanciare: giro in corso sul PC)
#
# Esecuzione (quando il PC è libero), dal tool lobster:
#   { "action": "run", "pipeline": "workflows/pop-wallrun.lobster",
#     "cwd": "workspace/pop-demo", "timeoutMs": 1800000 }
# NB: `cwd` deve restare dentro la cartella del gateway; i passi usano percorsi relativi a pop-demo.
# Ogni passo di lavoro è seguito da un cancello di approvazione: il token di resume
# riparte dal cancello senza rifare i passi già eseguiti (lo stato sta in
# ~/.lobster/state e sopravvive ai riavvii del gateway). Mai approvare un passo
# --quick come se fosse il giro completo: la barra verde vale solo sul giro intero.
name: pop-wallrun
args:
  stazione:
    default: "wallrun"
  lettori:
    default: ""
steps:
  - id: sync
    command: $HOME/.openclaw/workflows/runlog.py pop-wallrun sync --first -- tools/pc sync
  - id: via-sync
    command: echo "sync ok, prosegui con la build"
    stdin: $sync.stdout
    approval: required
  - id: build
    command: $HOME/.openclaw/workflows/runlog.py pop-wallrun build -- tools/pc build
    condition: $via-sync.approved
  - id: via-build
    command: echo "build ok, prosegui con i test"
    stdin: $build.stdout
    approval: required
  - id: test
    command: $HOME/.openclaw/workflows/runlog.py pop-wallrun test -- tools/pc test
    condition: $via-build.approved
  - id: via-test
    command: echo "test ok, prosegui con la clip"
    stdin: $test.stdout
    approval: required
  - id: clip
    command: $HOME/.openclaw/workflows/runlog.py pop-wallrun clip -- tools/pc clip $LOBSTER_ARG_STAZIONE
    condition: $via-test.approved
  - id: via-clip
    command: echo "clip ok, prosegui con la barra"
    stdin: $clip.stdout
    approval: required
  - id: barra
    command: $HOME/.openclaw/workflows/runlog.py pop-wallrun barra -- tools/wallrun-bar
    condition: $via-clip.approved
  - id: via-barra
    command: echo "barra ok, prosegui con la giuria (render + 5 assi)"
    stdin: $barra.stdout
    approval: required
  - id: giuria
    command: $HOME/.openclaw/workflows/runlog.py pop-wallrun giuria --last -- tools/wallrun-bar --giuria
    condition: $via-barra.approved
