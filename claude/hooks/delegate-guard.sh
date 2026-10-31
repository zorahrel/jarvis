#!/bin/bash
# PostToolUse(Agent|Task|Workflow) per Claude Code: il lavoro meccanico va a `delegate`
# (gratis -> Muse -> Codex, Claude solo in fondo), non a un subagent Claude. Non blocca mai (Attilio, 23/10:
# «per il futuro, non blocchiamo»): dopo la chiamata aggiunge un promemoria al contesto (additionalContext), exit 0.
# Perche' un hook: «prima Muse» stava nel CLAUDE.md, e il 23/10 la regia ha lanciato uno studio di 9 agenti
# tutti Claude, con un account all'86% (ritmo 2,5) e l'altro esaurito, mentre Muse era al 46%.
# Agent: segnala i tipi generici (Explore, scout, general-purpose, worker, claude, nessun tipo); i tipi di
# giudizio (verifier, oracle, Plan, fork...) e `delegate` passano.
# Workflow: segnala lo script se nessun agent() usa agentType 'delegate'.
# Via d'uscita quando serve davvero Claude: [claude] nel description o nel prompt, o nello script.
IFS= read -r -d '' in || true
tool=$(printf %s "$in" | jq -r '.tool_name // empty')
case "$tool" in
  Agent|Task)
    t=$(printf %s "$in" | jq -r '.tool_input.subagent_type // ""')
    case "$t" in ""|Explore|scout|general-purpose|worker|claude) ;; *) exit 0 ;; esac
    printf %s "$in" | jq -r '(.tool_input.description // "") + " " + (.tool_input.prompt // "")' | grep -qF '[claude]' && exit 0
    msg="subagent_type ${t:-general-purpose} e' un agente Claude"
    ;;
  Workflow)
    s=$(printf %s "$in" | jq -r '.tool_input.script // empty')
    p=$(printf %s "$in" | jq -r '.tool_input.scriptPath // empty')
    [ -z "$s" ] && [ -f "$p" ] && s=$(cat "$p")
    # un workflow salvato chiamato per nome si legge altrove: lo si lascia passare
    [ -n "$s" ] || exit 0
    printf %s "$s" | grep -q 'agent(' || exit 0
    printf %s "$s" | grep -qE "agentType:[[:space:]]*['\"]delegate['\"]|\[claude\]" && exit 0
    msg="nessuno stadio del workflow passa da delegate"
    ;;
  *) exit 0 ;;
esac
jq -n --arg m "delegate-guard: $msg. Per le prossime chiamate: il lavoro meccanico (letture, inventari, estrazioni, codice su specifica) va a Muse, cioe' Agent con subagent_type \"delegate\" o, in un workflow, agent(prompt, {agentType: 'delegate'}). Claude resta per sintesi, critica e verifica. Se serviva davvero Claude, la prossima volta metti [claude] nel description o nello script, con il perche'." \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $m}}'
exit 0
