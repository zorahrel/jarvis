# Prova di fumo: un passo, un cancello, un passo. Innocua (solo echo). Ogni passo scrive in runs.jsonl.
name: smoke
steps:
  - id: uno
    command: $HOME/.openclaw/workflows/runlog.py smoke uno --first -- echo uno
  - id: via-uno
    command: echo cancello
    stdin: $uno.stdout
    approval: required
  - id: due
    command: $HOME/.openclaw/workflows/runlog.py smoke due --last -- echo due
    condition: $via-uno.approved
