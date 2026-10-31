#!/usr/bin/env bash
# Barra di offload: gira sul PC vero (deve essere acceso o svegliabile). exit 0 = tutto verde.
set -u
# Dati del PC: solo da ~/.config/winfleet/config.env (fuori da ogni repo). Se il file o la variabile
# mancano si esce con 3 e un messaggio, invece di proseguire con un host vuoto.
wfconf() {
  local v; v="$(set +eu; . "$HOME/.config/winfleet/config.env" >/dev/null 2>&1; printf '%s' "${!1:-}")"
  [ -n "$v" ] || { echo "${0##*/}: manca $1 in ~/.config/winfleet/config.env" >&2; return 3; }
  printf '%s' "$v"
}
# Prima delle cartelle temporanee: l'uscita 3 per configurazione mancante non deve lasciarne senza trap.
HOST="${OFFLOAD_HOST:-$(wfconf HOST_SSH)}" || exit 3; SCH='C:\winfleet\schermo'
T=$(mktemp -d)
# la copia sul PC ha lo stesso nome che le dà offload (una per repository, non per cartella): si toglie a fine giro
(cd "$T" && git init -q) 2>/dev/null
N=$(offload key -C "$T")
R=$(mktemp -d); MUT=""; KEYS=()
pcx() { ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "$1" 2>/dev/null | tr -d '\r'; }
# i casi dello schermo scrivono nel vero C:\winfleet\schermo: a fine prova si tolgono le loro tracce
pulisci_schermo() { pcx "findstr /v /c:\"offload-test\" $SCH\\esiti.jsonl > $SCH\\esiti.tmp 2>nul & move /y $SCH\\esiti.tmp $SCH\\esiti.jsonl >nul 2>&1" >/dev/null; }
fine() {
  local k cmd="rmdir /s /q E:\\offload\\$N & rmdir /s /q E:\\offload-test"
  for k in ${KEYS[@]+"${KEYS[@]}"}; do cmd="$cmd & rmdir /s /q E:\\offload\\$k & cmd /c \"for /d %d in (E:\\offload\\${k}_r*) do rmdir /s /q %d\""; done
  # Il for di cmd.exe dentro un suo cmd /c: nudo si mangiava il resto della riga, e senza
  # copie _r* la seconda fixture restava sul PC a ogni giro (trovato dalla verifica del 26/10).
  rm -rf "$T" "$R" ${MUT:+"$MUT"}; ssh -o BatchMode=yes -o ConnectTimeout=5 "$HOST" "$cmd" >/dev/null 2>&1; pulisci_schermo
}
trap fine EXIT
cd "$T" && git init -q && echo 'SECRET=boom' > .env
echo 'const fs=require("fs");fs.mkdirSync("out",{recursive:true});fs.writeFileSync("out/r.txt","os="+process.platform+" env="+fs.existsSync(".env"));process.exit(Number(process.argv[2]||0))' > job.js
git add job.js
F=0; ok() { echo "ok   $1"; }; ko() { echo "FAIL $1"; F=1; }
offload --pc --get out -- node job.js 0 2>/dev/null; [ $? = 0 ] && ok "giro sul PC, exit 0" || ko "giro sul PC"
r=$(cat out/r.txt 2>/dev/null); [ "${r%% *}" = os=win32 ] && ok "ha girato su Windows" || ko "piattaforma: $r"
[ "${r##* }" = env=false ] && ok ".env rimasto sul Mac" || ko "il segreto è arrivato sul PC: $r"
offload --pc -- node job.js 3 >/dev/null 2>&1; [ $? = 3 ] && ok "exit code del PC riportato" || ko "exit code perso"
o=$(OFFLOAD_MAX_MAC=999 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null); [ "$o" = mac ] && ok "Mac libero: resta qui" || ko "Mac libero ma: $o"
o=$(OFFLOAD_MAX_MAC=0 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null | tr -d '\r '); [ "$o" = pc ] && ok "Mac carico: va sul PC" || ko "Mac carico ma: $o"
o=$(OFFLOAD_MAX_MAC=0 OFFLOAD_HOST=utente@192.0.2.1 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null | tail -1); [ "$o" = mac ] && ok "PC irraggiungibile: resta qui" || ko "PC irraggiungibile ma: $o"
# 27/10: dalla home (fuori da git, ~1 milione di file) offload copiava tutto per 9 ore. Fuori da git oltre il tetto non si copia.
G=$(mktemp -d); for i in $(seq 1 25); do : > "$G/f$i"; done
o=$(cd "$G" && OFFLOAD_MAX_FILES=20 OFFLOAD_MAX_MAC=0 offload --mac-cmd "echo mac" -- "echo pc" 2>/dev/null); [ "$o" = mac ] && ok "cartella grande fuori da git: non copia, resta qui" || ko "cartella grande fuori da git ma: $o"
(cd "$G" && OFFLOAD_MAX_FILES=20 offload --pc -- "echo pc" >/dev/null 2>&1); [ $? = 64 ] && ok "cartella grande con --pc: esce 64" || ko "cartella grande con --pc: copiata"
rm -rf "$G"

# --- schermo del PC: file del lavoro mentre gira, riga in esiti.jsonl quando finisce ---------------
# Un giro vero sul PC (exit 3 apposta: prova anche che l'exit code arriva nell'esito). Controlla:
#   1) mentre gira esiste lavoro-<pid>.json con cosa/progetto/chi/da;
#   2) a fine giro il PC ha scritto fine-<pid>.json e wf-autosleep l'ha trasformato in una riga
#      di esiti.jsonl con esito "fallito" (rc 3), togliendo il file del lavoro.
# schermo_giro <offload> <cosa> <fasi: lavoro|tutto> <attesa-esiti-s>  ->  exit 0 solo se tutte le fasi vanno.
schermo_giro() {
  local bin=$1 cosa=$2 fasi=$3 attesa=$4 pid lav="" rc i r=0 riga=""
  OFFLOAD_PROGETTO=offload-test "$bin" --pc --cosa "$cosa" -- "ping -n 9 127.0.0.1 >nul & cmd /c exit 3" >/dev/null 2>&1 &
  pid=$!
  for i in $(seq 1 30); do
    lav=$(pcx "type $SCH\\lavoro-$pid.json"); [ -n "$lav" ] && break
    kill -0 $pid 2>/dev/null || break; sleep 0.5
  done
  echo "$lav" | jq -e --arg c "$cosa" '.cosa==$c and .progetto=="offload-test" and (.chi|length>0) and (.da|test("^20[0-9-]+T[0-9:]+[+-][0-9:]+$"))' >/dev/null 2>&1 \
    || { echo "     lavoro-$pid.json assente o sbagliato (letto: ${lav:-niente})"; r=1; }
  wait $pid; rc=$?
  [ "$rc" = 3 ] || { echo "     exit code del giro $rc, atteso 3"; r=1; }
  if [ "$fasi" = tutto ]; then
    for ((i=0; i<attesa; i+=3)); do
      riga=$(pcx "type $SCH\\esiti.jsonl" | jq -c --arg c "$cosa" 'select(.cosa==$c)' 2>/dev/null | tail -1)
      [ -n "$riga" ] && break; sleep 3
    done
    echo "$riga" | jq -e '.esito=="fallito" and .progetto=="offload-test" and (.secondi|type=="number") and (.fine|length>0)' >/dev/null 2>&1 \
      || { echo "     nessuna riga giusta in esiti.jsonl entro ${attesa}s (letta: ${riga:-niente})"; r=1; }
    [ -z "$(pcx "dir /b $SCH\\lavoro-$pid.json 2>nul")" ] || { echo "     lavoro-$pid.json non tolto a fine giro"; r=1; }
  fi
  pcx "del /q $SCH\\lavoro-$pid.json $SCH\\fine-$pid.json 2>nul" >/dev/null
  return $r
}
OFF=$(command -v offload); MUT=$(mktemp -d)
schermo_giro "$OFF" "prova offload-test reale" tutto 100 && ok "schermo: file del lavoro e riga in esiti.jsonl" || ko "schermo: lavoro/esiti"

# Mutanti: lo stesso controllo, su una copia di offload rotta apposta, DEVE diventare rosso.
mutante() {  # nome  espressione-sed  fasi
  local m="$MUT/$1"
  sed "$2" "$OFF" > "$m"; chmod +x "$m"
  if cmp -s "$m" "$OFF"; then ko "mutante $1: il sed non ha cambiato niente, il test non prova nulla"; return; fi
  if schermo_giro "$m" "prova offload-test mutante $1" "$3" 30 >/dev/null 2>&1; then ko "mutante $1: il test e' rimasto VERDE"; else ok "mutante $1: il test diventa rosso"; fi
}
mutante lavoro-non-scritto  's/lavoro-\$\$\.json/lavoroX-$$.json/' lavoro
mutante fine-non-scritta    's/fine-\$\$\.json/fineX-$$.json/g' tutto
mutante exit-code-perso     's/{\\"rc\\":%^RC%}/{\\"rc\\":0}/' tutto
# --- git sul PC, una copia per repository, due giri insieme, pulizia delle copie vecchie -------------------
# Fixture piccole (mai topics-app): repo con origin locale, secondo worktree, stato sporco (modificato, in stage,
# non tracciato, segreto). Il PC deve vedere lo stesso git del Mac, senza token e senza remote.
mkfix() {  # nome -> cartella del worktree principale
  local d="$R/$1" g=(git -c user.name=t -c user.email=t@t.t -c core.hooksPath=/dev/null)
  mkdir -p "$d" && git init -q --bare "$d/origin.git" && git init -q -b main "$d/main" || return 1
  ( cd "$d/main" && git remote add origin "$d/origin.git"
    printf 'node_modules/\n' > .gitignore; echo a > a.txt; echo b > b.txt
    git add . && "${g[@]}" commit -qm uno && "${g[@]}" push -q --no-verify -u origin main 2>/dev/null
    echo c > c.txt && git add c.txt && "${g[@]}" commit -qm due
    git worktree add -q "$d/wt2" -b other
    echo more >> a.txt; echo n > staged-new.txt; git add staged-new.txt; echo u > untracked.txt
    echo 'SECRET=1' > .env; echo solo > only-wt1.txt ) >/dev/null 2>&1
  echo "$d/main"
}
GITCMD='echo ==ls& git ls-files& echo ==st& git status --porcelain& echo ==sha& git rev-parse HEAD origin/main& echo ==diff& git diff origin/main --name-only& echo ==rem& git remote -v'
# git_check <offload> <cartella> <tag>: un giro sul PC; CK_<voce>=0 se uguale al Mac. Ritorna 0 solo se tutte uguali.
git_check() {
  local bin=$1 d=$2 raw="$R/$3.raw" r=0
  ( cd "$d" && "$bin" --pc -- "$GITCMD" 2>/dev/null | tr -d '\r' > "$raw" )
  sect() { awk -v s="==$1" '/^==/{on=($0==s);next} on' "$raw"; }
  CK_ls=1; CK_st=1; CK_sha=1; CK_diff=1; CK_rem=1
  local m
  m=$(git -C "$d" ls-files | sort); [ -n "$m" ] && [ "$(sect ls | sort)" = "$m" ] && CK_ls=0
  m=$(git -C "$d" status --porcelain | /usr/bin/grep -v '\.env$' | sort); [ "$(sect st | sort)" = "$m" ] && CK_st=0
  m=$(git -C "$d" rev-parse HEAD origin/main); [ "$(sect sha)" = "$m" ] && CK_sha=0
  m=$(git -C "$d" diff origin/main --name-only | sort); [ -n "$m" ] && [ "$(sect diff | sort)" = "$m" ] && CK_diff=0
  [ -z "$(sect rem)" ] && CK_rem=0
  [ $CK_ls$CK_st$CK_sha$CK_diff$CK_rem = 00000 ]
}
pcrun() {  # cartella comando [env...] -> stdout senza CR
  local d=$1 c=$2; shift 2
  ( cd "$d" && env "$@" "$OFF" --pc -- "$c" 2>/dev/null | tr -d '\r' )
}

FIX=$(mkfix A) || ko "fixture git non creata"
K1=$(offload key -C "$FIX"); K2=$(offload key -C "$FIX/../wt2"); KEYS+=("$K1")
git_check "$OFF" "$FIX" g1 \
  && ok "git ls-files works on the PC copy (ls-files, status, origin/main, diff, nessun remote)" \
  || { ko "git ls-files works on the PC copy"; echo "     ls=$CK_ls status=$CK_st sha=$CK_sha diff=$CK_diff remote=$CK_rem (0 = uguale al Mac); letto: $(head -c 400 "$R/g1.raw" | tr '\n' '|')"; }

[ -n "$K1" ] && [ "$K1" = "$K2" ] && ok "due worktree dello stesso repo: stessa cartella sul PC ($K1)" || ko "chiavi diverse fra worktree: $K1 / $K2"
K3=$(offload key -C "$T"); [ "$K3" != "$K1" ] && ok "repo diverso: cartella diversa" || ko "repo diversi con la stessa chiave: $K3"
P1=$(pcrun "$FIX" "cd"); P2=$(pcrun "$FIX/../wt2" "cd")
[ -n "$P1" ] && [ "$P1" = "$P2" ] && ok "i due worktree girano nella stessa cartella del PC ($P1)" || ko "cartelle sul PC: '$P1' / '$P2'"

# il secondo worktree trova git allineato a se' stesso e non i file del primo (tolti dal manifest)
git_check "$OFF" "$FIX/../wt2" g2 && ok "secondo worktree: git e working tree uguali al suo, file del primo spariti" \
  || { ko "secondo worktree: ls=$CK_ls status=$CK_st sha=$CK_sha diff=$CK_diff remote=$CK_rem"; head -c 300 "$R/g2.raw" | tr '\n' '|'; echo; }
o=$(pcrun "$FIX/../wt2" "git rev-parse --abbrev-ref HEAD & if exist only-wt1.txt (echo si) else (echo no)" | tr '\n' ' ')
[ "$o" = "other no " ] && ok "branch del secondo worktree e file del primo tolto" || ko "branch/file: $o"

# node_modules sopravvive al cambio di worktree
pcrun "$FIX" "mkdir node_modules\\x & echo 1 > node_modules\\x\\f" >/dev/null
o=$(pcrun "$FIX/../wt2" "if exist node_modules\\x\\f (echo si) else (echo no)")
[ "$o" = si ] && ok "node_modules sopravvive fra worktree diversi" || ko "node_modules perso: $o"

# lock di un giro morto: si toglie e il giro usa la copia condivisa
mkdir -p ~/.cache/offload/locks/"$K1".lock && echo 999999 > ~/.cache/offload/locks/"$K1".lock/pid
o=$(pcrun "$FIX" "cd" OFFLOAD_LOCK_WAIT=0)
[ "$o" = "$P1" ] && [ ! -d ~/.cache/offload/locks/"$K1".lock ] && ok "lock di un giro morto tolto, copia condivisa usata e lock rilasciato" || ko "lock morto: '$o' lock=$(ls ~/.cache/offload/locks 2>/dev/null | tr '\n' ' ')"

# due giri insieme sullo stesso repo: il secondo, senza attesa, lavora su una copia sua; con attesa aspetta e usa la condivisa
( cd "$FIX" && "$OFF" --pc -- "cd & ping -n 45 127.0.0.1 >nul" 2>/dev/null | tr -d '\r' > "$R/long.out" ) &
LP=$!
for i in $(seq 1 60); do [ -d ~/.cache/offload/locks/"$K1".lock ] && break; sleep 1; done
o=$(pcrun "$FIX/../wt2" "cd & git rev-parse --abbrev-ref HEAD & if exist only-wt1.txt (echo si) else (echo no)" OFFLOAD_LOCK_WAIT=0 | tr '\n' '|')
case "$o" in "E:\\offload\\${K1}_r"*"|other|no|") ok "giro gemello senza attesa: copia privata, git e file suoi ($o)" ;; *) ko "giro gemello: $o" ;; esac
t0=$(date +%s); o=$(pcrun "$FIX/../wt2" "cd" OFFLOAD_LOCK_WAIT=120); t1=$(date +%s)
wait $LP; L=$(head -1 "$R/long.out")
[ "$o" = "$P1" ] && [ "$L" = "$P1" ] && ok "giro gemello con attesa: ha aspettato ($((t1 - t0)) s) e usa la copia condivisa" || ko "attesa: '$o' / '$L' / '$P1'"
for i in $(seq 1 20); do [ -z "$(pcx "dir /b E:\\offload\\${K1}_r* 2>nul")" ] && break; sleep 2; done
[ -z "$(pcx "dir /b E:\\offload\\${K1}_r* 2>nul")" ] && ok "copia privata tolta dal PC a fine giro" || ko "copia privata rimasta sul PC"

# offload clean: radice di prova E:\offload-test, una copia ferma da 30 giorni e una di oggi
pcx "mkdir E:\\offload-test\\zzold & mkdir E:\\offload-test\\zznew" >/dev/null
ssh -o BatchMode=yes "$HOST" "powershell -NoProfile -NonInteractive -Command -" >/dev/null 2>&1 <<'PS'
(Get-Item 'E:\offload-test\zzold').LastWriteTime = (Get-Date).AddDays(-30)
PS
o=$(OFFLOAD_ROOT_PC=E:/offload-test offload clean 2>/dev/null)
[ -n "$(pcx "dir /b E:\\offload-test\\zzold 2>nul & if exist E:\\offload-test\\zzold echo si")" ] && echo "$o" | /usr/bin/grep -q 'zzold.*da togliere' && echo "$o" | /usr/bin/grep -q 'zznew.*recente' \
  && ok "clean a secco: elenca la vecchia 'da togliere', la nuova 'recente', non toglie niente" || ko "clean a secco: $o"
OFFLOAD_ROOT_PC=E:/offload-test offload clean --apply >/dev/null 2>&1
[ "$(pcx "if exist E:\\offload-test\\zzold (echo si) else (echo no)")" = no ] && [ "$(pcx "if exist E:\\offload-test\\zznew (echo si) else (echo no)")" = si ] \
  && ok "clean --apply: toglie la ferma da 30 giorni, tiene quella di oggi" || ko "clean --apply"

# Mutanti: tolto il passo git (niente bundle) e chiave per cartella invece che per repository: i casi DEVONO diventare rossi.
FIXB=$(mkfix B); KEYS+=("$(offload key -C "$FIXB")")
mut="$MUT/senza-bundle"; sed 's/bundle create "\$META\/repo.bundle"/: bundle create "$META\/repo.bundle"/' "$OFF" > "$mut"; chmod +x "$mut"
if cmp -s "$mut" "$OFF"; then ko "mutante senza-bundle: il sed non ha cambiato niente"
elif git_check "$mut" "$FIXB" gm >/dev/null 2>&1; then ko "mutante senza-bundle: 'git ls-files works on the PC copy' e' rimasto VERDE"
else ok "mutante senza-bundle: 'git ls-files works on the PC copy' diventa rosso (ls=$CK_ls sha=$CK_sha diff=$CK_diff)"; fi
mut="$MUT/chiave-per-cartella"; sed 's|^  top=\$(git -C "\$d" rev-parse --show-toplevel|  id=$d; top=$(git -C "$d" rev-parse --show-toplevel|' "$OFF" > "$mut"; chmod +x "$mut"
if cmp -s "$mut" "$OFF"; then ko "mutante chiave-per-cartella: il sed non ha cambiato niente"
elif [ "$("$mut" key -C "$FIX")" != "$("$mut" key -C "$FIX/../wt2")" ]; then ok "mutante chiave-per-cartella: i due worktree finiscono in cartelle diverse (il caso diventa rosso)"
else ko "mutante chiave-per-cartella: ancora la stessa cartella"; fi
exit $F
