#!/bin/bash
# jcode-vdm-lockdown.sh — make the vdm proxy the only path jcode can take.
#
# jcode keeps its own copy of the Anthropic OAuth token in ~/.jcode/auth.json,
# refreshed from vdm's keychain every 60s. That copy is what lets a session talk
# straight to api.anthropic.com — and it is also what gets revoked whenever vdm
# rotates the account underneath it (12 x 401 on 2026-08-17, 37 the day before).
#
# Lockdown removes the copy and stops the sync that recreates it. With no native
# credentials, a session physically cannot leave the proxy: fail-closed.
#
# Pairs with [provider].cross_provider_failover = "countdown", which moves a
# failing session to another provider on its own after 3s. On its own that
# automation is symmetric: it carries sessions toward vdm when the native path
# 401s, but equally away from vdm the moment the proxy has a bad minute. Lockdown
# is what makes it one-way — with no native credentials there is nowhere to fail
# over to, so the only direction left is into the proxy.
#
# Caveat, straight from the binary: "Automatic countdown switching is only
# available in local sessions right now." Non-local sessions still need the key.
#
#   on      remove credentials + stop the sync   (RESTART jcode sessions after)
#   off     restore both                          (back to fail-open)
#   status  report which mode is active
#
# Reversible: auth.json is moved, never deleted.

set -uo pipefail

AUTH="$HOME/.jcode/auth.json"
STASH="$HOME/.jcode/auth.json.lockdown-stash"
SYNC_LABEL="com.jarvis.jcode-auth-sync"
SYNC_PLIST="$HOME/Library/LaunchAgents/$SYNC_LABEL.plist"
GATE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jcode-vdm-gate.sh"

sync_loaded() { launchctl list 2>/dev/null | /usr/bin/grep -q "$SYNC_LABEL"; }

cmd_status() {
    echo "jcode -> vdm lockdown"
    if [ -f "$AUTH" ]; then
        echo "  credentials : PRESENT ($AUTH) — a session can bypass vdm"
    elif [ -f "$STASH" ]; then
        echo "  credentials : stashed ($STASH) — native path unavailable"
    else
        echo "  credentials : absent, and no stash — 'off' cannot restore anything"
    fi
    if sync_loaded; then
        echo "  auth sync   : RUNNING — will recreate credentials within 60s"
    else
        echo "  auth sync   : stopped"
    fi
    if [ ! -f "$AUTH" ] && ! sync_loaded; then
        echo "  mode        : FAIL-CLOSED (vdm is the only path)"
    else
        echo "  mode        : fail-open (native Anthropic path reachable)"
    fi
    echo
    echo "  live sessions still on the native path:"
    if [ -x "$GATE" ]; then
        # Report the gate's verdict without adopting its exit code: status
        # describes the switch, the gate is what passes or fails.
        "$GATE" 10 2>/dev/null | /usr/bin/grep -aE 'natively|GATE' | sed 's/^/    /'
    else
        echo "    (gate not found at $GATE)"
    fi
    return 0
}

cmd_on() {
    # Order matters: stop the sync first, or it recreates auth.json under us.
    if sync_loaded; then
        launchctl bootout "gui/$(id -u)/$SYNC_LABEL" 2>/dev/null
        # bootout is asynchronous; wait for it to actually leave the list.
        for _ in $(seq 1 20); do sync_loaded || break; sleep 0.25; done
        if sync_loaded; then
            echo "ABORT: auth sync did not stop; it would recreate the credentials."
            exit 1
        fi
        echo "stopped $SYNC_LABEL"
    else
        echo "$SYNC_LABEL already stopped"
    fi

    if [ -f "$AUTH" ]; then
        mv "$AUTH" "$STASH"
        echo "stashed credentials -> $STASH"
    else
        echo "no credentials to stash"
    fi

    echo
    echo "FAIL-CLOSED. Sessions started from now on can only reach Anthropic via vdm."
    echo "Sessions already running keep the token they loaded at startup: restart them,"
    echo "or they will keep bypassing the proxy until they end."
}

cmd_off() {
    if [ -f "$STASH" ] && [ ! -f "$AUTH" ]; then
        mv "$STASH" "$AUTH"
        echo "restored credentials -> $AUTH"
    fi
    if [ -f "$SYNC_PLIST" ] && ! sync_loaded; then
        launchctl bootstrap "gui/$(id -u)" "$SYNC_PLIST" 2>/dev/null \
            && echo "restarted $SYNC_LABEL" \
            || echo "WARNING: could not restart $SYNC_LABEL — check it by hand"
    fi
    echo "fail-open restored."
}

case "${1:-status}" in
    on)     cmd_on ;;
    off)    cmd_off ;;
    status) cmd_status ;;
    *)      echo "usage: $(basename "$0") [on|off|status]"; exit 2 ;;
esac
