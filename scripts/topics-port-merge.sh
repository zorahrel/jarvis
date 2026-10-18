#!/bin/bash
# Porta nel checkout vivo di topics-app i file di UN commit mergiato, senza mergiare lì.
# Procedura della memoria (project_topics_merge_in_prod_checkout): si copiano solo i file
# del diff M^..M fuori da openspec/, tests/e2e/ e dalla config di Playwright (in produzione
# non gira nessun test, e il 15/10 una modifica locale lì fermava #331), e solo dove la copia viva è identica a
# M^:file (o, per un file nuovo, dove non esiste). Altrimenti è lavoro di qualcuno: stop.
# Uso: topics-port-merge.sh <sha-del-merge> [--apply]   (senza --apply è una prova a vuoto)
set -u
M="$1"; APPLY="${2:-}"
LIVE="${TOPICS_LIVE:-$HOME/Projects/topics-app}"
cd "$LIVE" || exit 2
git cat-file -e "$M^{commit}" || { echo "commit $M sconosciuto qui (git fetch?)"; exit 2; }

# package.json: la riga "version" la alza auto-bump su main a ogni merge e nel vivo non arriva
# mai, quindi si confronta senza quella riga e nel vivo resta la sua. Il 15/10 bloccava #320.
VERSION_LINE='^[[:space:]]*"version":'
norm() { if [ "$1" = package.json ]; then grep -v -E "$VERSION_LINE"; else cat; fi; }
same() { cmp -s <(git show "$1:$2" | norm "$2") <(norm "$2" < "$2"); }

files=()
while IFS= read -r f; do files+=("$f"); done < <(git diff --name-only "$M^" "$M" | grep -v -E '^(openspec/|tests/e2e/|playwright(\.[a-z]+)?\.config\.ts$)')
# Bash 3.2 con set -u: "${files[@]}" su un array vuoto e' una variabile non definita.
[ "${#files[@]}" -gt 0 ] || { echo "== niente da portare: il merge tocca solo openspec/ e tests/e2e/"; exit 0; }
blocked=0
for f in "${files[@]}"; do
  if ! git cat-file -e "$M:$f" 2>/dev/null; then
    # Tolto nel merge: si toglie anche dal vivo, con la stessa regola (vivo = M^).
    if [ ! -e "$f" ]; then echo "già   tolto: $f"
    elif same "$M^" "$f"; then echo "ok    da togliere (= M^): $f"
    else echo "STOP  da togliere ma diverso (lavoro di qualcuno): $f"; blocked=1; fi
  elif git cat-file -e "$M^:$f" 2>/dev/null; then
    if [ ! -f "$f" ]; then echo "STOP  manca nel vivo: $f"; blocked=1
    elif same "$M^" "$f"; then echo "ok    = M^: $f"
    elif same "$M" "$f"; then echo "già   = M: $f"
    else echo "STOP  diverso (lavoro di qualcuno): $f"; blocked=1; fi
  else
    if [ -e "$f" ]; then
      if same "$M" "$f"; then echo "già   nuovo e già uguale: $f"; else echo "STOP  nuovo ma esiste diverso: $f"; blocked=1; fi
    else echo "ok    nuovo: $f"; fi
  fi
done
[ "$blocked" -eq 0 ] || { echo "== porting FERMATO: niente copiato"; exit 1; }
[ "$APPLY" = "--apply" ] || { echo "== prova a vuoto: ${#files[@]} file portabili"; exit 0; }
for f in "${files[@]}"; do
  if git cat-file -e "$M:$f" 2>/dev/null; then
    mkdir -p "$(dirname "$f")"
    if [ "$f" = package.json ] && [ -f "$f" ]; then
      live_version="$(grep -m1 -E "$VERSION_LINE" "$f")"
      git show "$M:$f" | awk -v v="$live_version" -v re="$VERSION_LINE" \
        '!done && $0 ~ re { print v; done = 1; next } { print }' > "$f.port-tmp" && mv "$f.port-tmp" "$f"
    else
      git show "$M:$f" > "$f.port-tmp" && mv "$f.port-tmp" "$f"
    fi
    # Il file nuovo nasce 644: si rimette il modo del commit. Il 15/10 start-test-server.sh
    # e' arrivato in produzione senza bit di esecuzione.
    if [ "$(git ls-tree "$M" -- "$f" | cut -c1-6)" = "100755" ]; then chmod +x "$f"; else chmod -x "$f"; fi
  elif [ -e "$f" ]; then
    trash "$f"
  fi
done
echo "== copiati ${#files[@]} file da $M"
