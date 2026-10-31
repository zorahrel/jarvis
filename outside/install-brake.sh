#!/bin/bash
# Installa le parti del freno del Mac che stanno fuori dal repo. Da lanciare dalla Regia DOPO la verifica e dopo il merge
# di brake/side-sessions (l'hook chiama ~/Projects/claude-usage-hub/bin/mac-attention.mjs: prima del merge non c'è, e
# l'hook ripiega su «umano», cioè sul comportamento di prima). Ogni file sostituito lascia una copia .pre-freno accanto.
#   bash outside/install-brake.sh            installa file e patch, poi stampa il comando del cron
#   bash outside/install-brake.sh --cron     aggiunge anche il cron OpenClaw (serve il gateway acceso)
set -euo pipefail
O="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Guardia: i due file con versioni installate più nuove della copia del ramo non si sovrascrivono mai.
for f in .claude/hooks/offload-guard.sh bin/offload; do
  if [ -e "$HOME/$f" ] && ! cmp -s "$O/$f" "$HOME/$f"; then
    echo "da riallineare prima: il file installato è più nuovo (gabbia dei segnali 25/10, copia per repo 26/10): ~/$f" >&2
    exit 1
  fi
done
put() {  # percorso relativo a $HOME
  local src="$O/$1" dst="$HOME/$1"
  [ -e "$dst" ] && cp -p "$dst" "$dst.pre-freno"
  mkdir -p "$(dirname "$dst")" && cp -p "$src" "$dst" && echo "installato ~/$1"
}
for f in heavy.ere heavy-scan.pl offload-guard.sh offload-guard-test.sh offload-guard-launchers-test.sh offload-guard-cases.tsv; do put ".claude/hooks/$f"; done
mkdir -p "$HOME/.claude/hooks/offload-guard-fixtures" && cp -Rp "$O/.claude/hooks/offload-guard-fixtures/." "$HOME/.claude/hooks/offload-guard-fixtures/"
put bin/offload                 # ~/bin è ~/.claude/setup/bin
put bin/offload-slot-test.sh
patch -b -z .pre-freno "$HOME/.claude/setup/shared/TOOLS.md" < "$O/.claude/setup/shared/TOOLS.md.patch"
patch -b -z .pre-freno "$HOME/.claude/jarvis/tools/usage-hub/config.json" < "$O/.claude/jarvis/tools/usage-hub/config.json.patch"
echo "barre: bash ~/.claude/hooks/offload-guard-test.sh && bash ~/.claude/hooks/offload-guard-launchers-test.sh && bash ~/bin/offload-slot-test.sh"
echo "il hub legge shed.enabled solo all'avvio: va riavviato (launchctl kickstart -k gui/\$(id -u)/com.jarvis.usage-hub)"

# Cron quotidiano «Mac senza affanno», 09:30: zitto se verde (NO_REPLY), una riga se rosso o non misurato.
# La consegna (--channel/--to) va copiata da un cron che scrive già ad Attilio, es. il brief mattutino:
#   openclaw cron list --json | jq '.jobs[] | select(.name=="brief-mattutino") | .delivery'
NODE=$(command -v node || echo /opt/homebrew/bin/node)
ARGV=$(jq -cn --arg cc "$HOME/.openclaw/bin/cron-clean" --arg node "$NODE" --arg bar "$HOME/Projects/claude-usage-hub/bin/mac-strain.mjs" \
  '[$cc, "Mac senza affanno", $node, $bar, "--hours", "24", "--cron"]')
CRON=(openclaw cron add --name mac-senza-affanno --display-name "Mac senza affanno"
  --description "Barra del freno del Mac: minuti di affanno per colpa degli agenti nelle ultime 24 h; zitto se verde"
  --cron "30 9 * * *" --tz Europe/Rome --command-argv "$ARGV" --announce ${CRON_DELIVERY:-})
if [ "${1:-}" = --cron ]; then
  [ -n "${CRON_DELIVERY:-}" ] || { echo "CRON_DELIVERY vuoto: es. CRON_DELIVERY='--channel whatsapp --to <numero>'" >&2; exit 64; }
  "${CRON[@]}"
else
  printf 'cron da aggiungere: CRON_DELIVERY=%q bash %q --cron\n' '--channel … --to …' "$0"
fi
