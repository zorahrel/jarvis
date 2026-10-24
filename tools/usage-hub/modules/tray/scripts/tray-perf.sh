#!/usr/bin/env bash
# Barra di velocità della tray, senza toccare schermo né mouse: un processo a parte (ClaudeUsage --perf-bench)
# carica i dati veri dell'hub e percorre il codice del clic fuori schermo.
#   tray-perf.sh [--mutate] [giri]
# Esce 1 se l apertura supera 150 ms (mediana a muro o CPU del main), un evento di hover o il riempimento del
# sottomenu processi 50 ms di CPU del main. Il primo giro scalda il processo e non conta.
# --mutate compila con una lettura di rete bloccante nel clic (clickWork) e deve uscire 1.
# Dentro la tray vera le stesse misure si accendono con ~/.cache/claude-usage-tray/perf (log in perf.log).
set -uo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC=(ClaudeUsage.swift ProviderIcon.swift MacStats.swift ProcessWindow.swift main.swift)
FLAG=(); [ "${1:-}" = --mutate ] && { FLAG=(-D TRAY_PERF_MUTATE); shift; }
BIN="$DIR/ClaudeUsage.bench"
(cd "$DIR" && swiftc -O "${FLAG[@]+"${FLAG[@]}"}" "${SRC[@]}" -o "$BIN") || exit 70
"$BIN" --perf-bench "${1:-5}"; rc=$?
rm -f "$BIN"
exit $rc
