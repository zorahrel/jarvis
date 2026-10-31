#!/bin/bash
# jcode-vdm-gate.sh — fails (non-zero) if any jcode traffic escaped the vdm proxy.
#
# Three independent ways a session can end up talking straight to Anthropic; each
# is checked separately so the failure names itself:
#   1. a revoked-token 401  -> a session held its own copy of the OAuth token
#   2. a session created on a provider other than vdm
#   3. a stream attempt to an endpoint other than the proxy
#
# Usage: jcode-vdm-gate.sh [minutes]      (default: 30)
#        jcode-vdm-gate.sh 1440           (last 24h)

set -uo pipefail

WINDOW_MIN="${1:-30}"
LOG_DIR="$HOME/.jcode/logs"
PROXY_HOST="localhost:3336"
# Local model-catalog probes; they never carry Anthropic credentials.
ALLOWED_ENDPOINT_RE='localhost:(3336|1234|11434)'

log_file="$LOG_DIR/jcode-$(date '+%Y-%m-%d').log"
[ -r "$log_file" ] || { echo "GATE ERROR: no readable log at $log_file"; exit 2; }

cutoff="$(date -v-"${WINDOW_MIN}"M '+%Y-%m-%d %H:%M')"
window="$(awk -v c="[$cutoff" '$0 >= c' "$log_file")"

if [ -z "$window" ]; then
    echo "GATE ERROR: no log lines in the last ${WINDOW_MIN}m — nothing was measured."
    echo "A gate that inspects an empty window must not report success."
    exit 2
fi

fail=0
lines=$(printf '%s\n' "$window" | wc -l | tr -d ' ')
echo "jcode -> vdm gate | window ${WINDOW_MIN}m | ${lines} log lines"
echo

# --- 1. revoked-token 401s -----------------------------------------------------
revoked=$(printf '%s\n' "$window" | /usr/bin/grep -ac 'has been revoked' || true)
if [ "$revoked" -gt 0 ]; then
    echo "FAIL  revoked-token 401s: $revoked"
    printf '%s\n' "$window" | /usr/bin/grep -a 'has been revoked' \
        | /usr/bin/grep -aoE '^\[[0-9-]+ [0-9:]+|ses:session_[a-z]+' | paste - - | head -5 | sed 's/^/        /'
    fail=1
else
    echo "ok    revoked-token 401s: 0"
fi

# --- 2. sessions born outside vdm ----------------------------------------------
# jcode labels the openai-compatible transport "OpenRouter"/"openrouter" even when
# the endpoint is our proxy, so the vdm profile shows up under that name.
bad_create=$(printf '%s\n' "$window" | /usr/bin/grep -a 'ENV_SNAPSHOT' \
    | python3 -c '
import sys, json, re
bad = []
for line in sys.stdin:
    m = re.search(r"ENV_SNAPSHOT (\{.*)", line)
    if not m:
        continue
    try:
        d = json.loads(m.group(1))
    except Exception:
        continue
    if d.get("reason") != "create":
        continue
    if (d.get("provider") or "").lower() not in ("openrouter", "vdm"):
        bad.append((line[1:20], d.get("provider"), (d.get("session_id") or "")[:32]))
for b in bad[:5]:
    print("        %s  provider=%s  %s" % b)
print("COUNT=%d" % len(bad))
')
n_create="${bad_create##*COUNT=}"
if [ "${n_create:-0}" -gt 0 ]; then
    echo "FAIL  sessions created outside vdm: $n_create"
    printf '%s\n' "$bad_create" | /usr/bin/grep -v '^COUNT='
    fail=1
else
    echo "ok    sessions created outside vdm: 0"
fi

# --- 3a. stream attempts to a non-proxy endpoint --------------------------------
stray=$(printf '%s\n' "$window" | /usr/bin/grep -aoE 'endpoint: https?://[^ ,)]+' \
    | sort | uniq -c | /usr/bin/grep -avE "$ALLOWED_ENDPOINT_RE" || true)
if [ -n "$stray" ]; then
    echo "FAIL  stream attempts to a foreign endpoint:"
    printf '%s\n' "$stray" | sed 's/^/        /'
    fail=1
else
    echo "ok    stream attempts to a foreign endpoint: 0"
fi

# --- 3b. live calls on the native Anthropic path --------------------------------
# The endpoint check above cannot see these: only the openai-compatible path logs
# an "endpoint:", so native Anthropic traffic leaves no URL in the log at all and
# 3a is green by construction. The native path identifies itself by provider name
# on the stream lifecycle event instead.
native=$(printf '%s\n' "$window" \
    | /usr/bin/grep -aE 'phase=stream_opened|API call starting' \
    | /usr/bin/grep -aoE 'ses:session_[a-z]+_[0-9]+\|prv:(Claude|Anthropic)' \
    | sort -u || true)
n_native=$(printf '%s' "$native" | /usr/bin/grep -ac . || true)
proxy_calls=$(printf '%s\n' "$window" | /usr/bin/grep -ac "endpoint: http://$PROXY_HOST" || true)
if [ "${n_native:-0}" -gt 0 ]; then
    echo "FAIL  sessions calling Anthropic natively (bypassing vdm): $n_native"
    printf '%s\n' "$native" | sed 's/^/        /' | head -8
    fail=1
else
    echo "ok    sessions calling Anthropic natively: 0  (${proxy_calls} calls through vdm)"
fi

echo
if [ "$fail" -eq 0 ]; then
    echo "GATE GREEN — all jcode traffic in the last ${WINDOW_MIN}m went through vdm."
else
    echo "GATE RED — jcode reached Anthropic without going through vdm."
fi
exit "$fail"
