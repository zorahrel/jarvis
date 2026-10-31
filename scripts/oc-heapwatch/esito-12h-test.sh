#!/bin/sh
# Barra di esito-12h.mjs. Ogni caso gira con HOME in una cartella temporanea: launchctl, board-card e openclaw
# sono finti, e openclaw viene sostituito anche nella copia dello script (il percorso assoluto di /opt/homebrew),
# così nessun messaggio parte davvero. Per provare il vecchio codice: ESITO=<copia del vecchio> sh esito-12h-test.sh
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ESITO=${ESITO:-$HERE/esito-12h.mjs}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
FAIL=0
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

mkdir -p "$T/bin"
cat > "$T/bin/launchctl" <<'EOF'
#!/bin/sh
echo "$*" >> "$LOG"
if [ "$1" = list ]; then
  printf 'PID\tStatus\tLabel\n'
  if [ -n "$FAKE_GATEWAY_PID" ]; then printf '%s\t1\tai.openclaw.gateway\n' "$FAKE_GATEWAY_PID"; else printf -- '-\t1\tai.openclaw.gateway\n'; fi
  printf -- '-\t0\tcom.jarvis.oc-misura12h\n'
fi
exit 0
EOF
cat > "$T/bin/openclaw" <<'EOF'
#!/bin/sh
echo "$*" >> "$WA_LOG"
[ "$1" = cron ] && echo 'whatsapp:+390000000000'
exit 0
EOF
cat > "$T/board-card" <<'EOF'
#!/bin/sh
echo "$*" >> "$BC_LOG"
echo oc-card-1
EOF
chmod +x "$T/bin/launchctl" "$T/bin/openclaw" "$T/board-card"

# gen PID N MBH BASE START: N finestre da 15 min, footprint = BASE + MBH × ore dalla prima finestra
gen() {
  node -e '
    const [pid, n, mbh, base, start] = process.argv.slice(1);
    const pad = (x) => String(x).padStart(2, "0");
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const t0 = Date.parse(start);
    for (let i = 0; i < +n; i++) {
      const s = t0 + i * 900e3, e = s + 900e3;
      const fp = Math.round(+base + +mbh * ((e - t0) / 3600e3));
      console.log(JSON.stringify({ start: fmt(new Date(s)), ver: "2026.10.5", end: fmt(new Date(e)), file: "x.json",
        pid, footprint: `${fp} MB`, buildsBefore: 0, buildsAfter: 0 }));
    }' "$@"
}

# new_case NOME: cartella del caso con repo jarvis (git), vecchio checkout col file di ricerca, plist
new_case() {
  C=$T/$1; H=$C/home; LOG=$C/launchctl.log; BC_LOG=$C/board-card.log; WA_LOG=$C/openclaw.log
  R=$H/.claude/jarvis; RESULTS=$R/tools/usage-hub/docs/oc-memoria-12h.md
  mkdir -p "$R/scripts" "$H/vecchio-checkout/claude-usage-hub/research" "$H/.cache/oc-heapwatch/cont" \
    "$H/Library/LaunchAgents/disabled" "$C/run"
  cp "$T/board-card" "$R/scripts/board-card"
  git -C "$R" init -q && git -C "$R" commit -q --allow-empty -m init
  git -C "$H/vecchio-checkout/claude-usage-hub" init -q
  echo "# vecchio file di ricerca" > "$H/vecchio-checkout/claude-usage-hub/research/2026-10-21-unificare-alleggerire.md"
  git -C "$H/vecchio-checkout/claude-usage-hub" add -A && git -C "$H/vecchio-checkout/claude-usage-hub" commit -q -m init
  echo '<plist/>' > "$H/Library/LaunchAgents/com.jarvis.oc-misura12h.plist"
  ACTIVE=$H/Library/LaunchAgents/com.jarvis.oc-misura12h.plist
  PARKED=$H/Library/LaunchAgents/disabled/com.jarvis.oc-misura12h.plist
  GW=27462
}

# run: esegue lo script sotto test con la HOME del caso; codice d'uscita in $CODE
run() {
  sed "s#/opt/homebrew/bin/openclaw#$T/bin/openclaw#" "$ESITO" > "$C/run/esito.mjs"
  env HOME="$H" PATH="$T/bin:$PATH" LOG="$LOG" BC_LOG="$BC_LOG" WA_LOG="$WA_LOG" FAKE_GATEWAY_PID="$GW" \
    node "$C/run/esito.mjs" > "$C/run/out" 2>&1
  CODE=$?
}

# expect DESCRIZIONE COMANDO...: PASS se il comando riesce
expect() {
  d=$1; shift
  if "$@"; then echo "PASS $d"; else echo "FAIL $d"; FAIL=1; fi
}

# A: il processo corrente deriva → card, nessun WhatsApp
new_case A; GW=27462
{ gen 24649 20 0 1900 "2026-10-24T05:06:30"; gen 27462 12 100 1000 "2026-10-24T14:48:20"; } > "$H/.cache/oc-heapwatch/cont/windows.jsonl"
run
expect "A: card aperta per la deriva del processo corrente" grep -q -- "--key oc-memoria-deriva" "$BC_LOG"
expect "A: card con pid e file dell'esito" grep -q "processo 27462.*oc-memoria-12h.md" "$BC_LOG"
expect "A: nessun messaggio WhatsApp" test ! -s "$WA_LOG"
expect "A: uscita 0" test "$CODE" = 0

# B: deriva solo su un pid vecchio, il corrente è piatto → nessuna card, il corrente è giudicato e il plist parcheggiato
new_case B; GW=27462
{ gen 24649 20 100 1900 "2026-10-24T05:06:30"; gen 27462 12 0 1000 "2026-10-24T14:48:20"; } > "$H/.cache/oc-heapwatch/cont/windows.jsonl"
run
expect "B: nessuna card per un pid vecchio" test ! -s "$BC_LOG"
expect "B: nessun WhatsApp" test ! -s "$WA_LOG"
expect "B: plist parcheggiato in disabled/" test -f "$PARKED" -a ! -f "$ACTIVE"
expect "B: uscita 0" test "$CODE" = 0

# C: file di esito mancante → creato e committato da solo, senza altri file in staging
new_case C; GW=27462
{ gen 27462 12 0 1000 "2026-10-24T14:48:20"; } > "$H/.cache/oc-heapwatch/cont/windows.jsonl"
echo x > "$R/other.txt"; git -C "$R" add other.txt
run
expect "C: file creato con titolo" sh -c "head -1 '$RESULTS' | grep -q '^# '"
expect "C: commit con il solo file di esito" test "$(git -C "$R" show --name-only --format= HEAD)" = "tools/usage-hub/docs/oc-memoria-12h.md"
expect "C: other.txt resta in staging" sh -c "git -C '$R' diff --cached --name-only | grep -q other.txt"
expect "C: nessuna riga Co-Authored-By o Generated" sh -c "! git -C '$R' log -1 --format=%B | grep -q -e 'Co-Authored-By' -e 'Generated with'"
expect "C: uscita 0" test "$CODE" = 0

# D: processo corrente con poche finestre → non giudicato, plist non parcheggiato, nessuna card
new_case D; GW=27462
{ gen 24649 20 0 1900 "2026-10-24T05:06:30"; gen 27462 4 100 1000 "2026-10-24T14:48:20"; } > "$H/.cache/oc-heapwatch/cont/windows.jsonl"
run
expect "D: plist non parcheggiato" test -f "$ACTIVE" -a ! -f "$PARKED"
expect "D: nessuna card" test ! -s "$BC_LOG"
expect "D: esito dice non giudicato" grep -q "non ancora giudicato" "$RESULTS"
expect "D: uscita 0" test "$CODE" = 0

if [ "$FAIL" = 0 ]; then echo "tutti i casi PASS"; else echo "ci sono FAIL"; fi
exit "$FAIL"
