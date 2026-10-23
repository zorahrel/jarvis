#!/bin/sh
# Barra traccia 1: i repo vecchi non devono avere copie dei moduli, solo symlink verso l'hub.
# Exit 1 se un file tracciato (a parte .gitignore, che git non segue se symlink) è un file vero.
fail=0
for repo in "$HOME/Projects/claude-usage-tray" "$HOME/Projects/vdm-fork"; do
  for f in $(git -C "$repo" ls-files | grep -Ev '^assets/|^docs/|^\.git(ignore|attributes)$'); do
    [ -L "$repo/$f" ] || { echo "copia: $repo/$f"; fail=1; }
  done
done
exit $fail
