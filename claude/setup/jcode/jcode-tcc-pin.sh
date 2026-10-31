#!/bin/bash
# Keep jcode's macOS privacy grants (Documents, Downloads, Photos, "data from
# other apps"...) across jcode updates.
#
# Why this exists: TCC files a command-line binary's grants under its *path*
# plus its code signature. The jcode server runs builds/shared-server/jcode, a
# symlink into builds/versions/<version>/jcode, and release builds are ad-hoc
# signed (designated requirement = bare cdhash). Every update moves the path
# AND changes the hash, so macOS asked for every permission again (tccd,
# 2026-09-15: subject=/Users/zorahrel/.jcode/builds/versions/0.84.0/jcode).
#
# Fix: the server runs from one fixed path, ~/.jcode/signed/jcode, a copy of
# the shared-server version re-signed with the local "Mosaic Dev" identity and
# a fixed identifier. Path and designated requirement both survive updates.
# Trade-off accepted on 2026-09-15: a tampered jcode release would inherit the
# grants without a new dialog.
#
# Dal 25/10 il server lo avvia il client (TUI, `jcode acp` di Topics), e un figlio
# eredita il *responsabile* TCC del padre: i permessi della copia firmata non
# valevano più. Il canale allora punta al lanciatore ~/.jcode/signed/server-launch
# (~/.claude/setup/jcode/server-launch), che fa partire la copia responsabile di sé
# come la faceva la guardia. Il suo mtime segue quello della copia: jcode confronta
# canale e binario in esecuzione per mtime (server/util.rs, server_has_newer_binary)
# e un lanciatore più nuovo della copia sembrerebbe un aggiornamento per sempre.
#
#   sync  launchd, at load and whenever jcode rewrites shared-server-version:
#         refresh the signed copy; once armed, re-point the channel at it (at the
#         launcher, when there is one) and move the running server onto it with a
#         graceful reload.
#   arm   only while no server is running: point the channel at the signed
#         copy. (Era la guardia ad armarlo; ritirata il 25/10, server a
#         richiesta: già armato, `arm` resta per un riarmo a mano a server spento.) Arming with a server up would let jcode
#         exec-reload that server into the copy, and TCC keeps attributing an
#         exec'd process to the path it was *spawned* from: its old grants would
#         stop matching and the dialogs would come back one extra time.
#
# Undo (solo il lanciatore: ln -sfn ~/.jcode/signed/jcode ~/.jcode/builds/shared-server/jcode;
#   trash ~/.jcode/signed/server-launch).
# Undo: launchctl bootout gui/$(id -u)/com.jarvis.jcode-tcc-pin; trash ~/.jcode/signed;
#   ln -sfn ~/.jcode/builds/versions/$(cat ~/.jcode/builds/shared-server-version)/jcode ~/.jcode/builds/shared-server/jcode

set -u

# Overridable only so the update path can be exercised on a fake tree.
JCODE_HOME="${JCODE_TCC_PIN_HOME:-$HOME/.jcode}"
RUNTIME_DIR="${JCODE_TCC_PIN_RUNTIME:-$(getconf DARWIN_USER_TEMP_DIR)}"

BUILDS="$JCODE_HOME/builds"
SIGNED="$JCODE_HOME/signed"
SLOT="$SIGNED/jcode"
LAUNCH="$SIGNED/server-launch"
STAMP="$SIGNED/jcode.source"
ARMED="$SIGNED/armed"
CHANNEL="$BUILDS/shared-server/jcode"
LOG="$JCODE_HOME/logs/tcc-pin.log"

# "Mosaic Dev", self-signed, login keychain, valid until 2036. Pinned by hash so
# another certificate with the same name can never change the requirement.
IDENTITY="BBDCC8CF715D68CE471F3A2AABC02A67B17A511D"
IDENTIFIER="dev.jcode.signed"

# Created up front: codesign output is appended to $LOG before log() ever runs.
mkdir -p "${LOG%/*}"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG"; }

# Make $SLOT a signed copy of the binary the shared-server channel names.
ensure_slot() {
  local version src stamp tmp
  version="$(tr -d '[:space:]' <"$BUILDS/shared-server-version" 2>/dev/null)"
  src="$BUILDS/versions/$version/jcode"
  if [[ -z "$version" || ! -f "$src" || -L "$src" ]]; then
    log "no installed binary for shared-server version '$version'; leaving jcode alone"
    return 1
  fi
  # Releases for other platforms ship a wrapper script plus a .bin payload;
  # copying only the wrapper would leave the server nothing to exec.
  case "$(head -c 4 "$src" | xxd -p)" in
    cffaedfe | cafebabe) ;;
    *)
      log "$src is not a Mach-O binary; leaving jcode alone"
      return 1
      ;;
  esac
  stamp="$version $(stat -f '%z %m' "$src")"
  if [[ -x "$SLOT" && "$(cat "$STAMP" 2>/dev/null)" == "$stamp" ]]; then
    return 0
  fi
  mkdir -p "$SIGNED"
  tmp="$SIGNED/.jcode.$$"
  if ! cp "$src" "$tmp" \
    || ! /usr/bin/codesign --force --sign "$IDENTITY" --identifier "$IDENTIFIER" "$tmp" >>"$LOG" 2>&1 \
    || ! "$tmp" version --json >/dev/null 2>&1; then
    rm -f "$tmp"
    log "signing a copy of $src failed; leaving jcode alone"
    return 1
  fi
  # Rename, never write in place: a server still running the previous copy
  # keeps its own inode instead of paging in a half-written file.
  mv -f "$tmp" "$SLOT" && echo "$stamp" >"$STAMP"
  log "signed copy refreshed from $src"
}

point_channel() {
  local target="$SLOT"
  if [[ -x "$LAUNCH" ]]; then
    target="$LAUNCH"
    touch -r "$SLOT" "$LAUNCH"
  fi
  [[ "$(readlink "$CHANNEL")" == "$target" ]] && return 0
  local tmp="${CHANNEL%/*}/.jcode-tcc-pin.$$"
  ln -s "$target" "$tmp" && mv -f "$tmp" "$CHANNEL" && log "shared-server channel -> $target"
}

# After an update jcode reloads the server into builds/versions/<new> by
# itself, which is ad-hoc signed again. Compare inodes, not paths: a server
# still executing the previous signed copy reports the same path.
move_server() {
  local pid inode
  pid="$(lsof -t "${RUNTIME_DIR%/}/jcode-daemon.lock" 2>/dev/null | head -1)"
  [[ -n "$pid" ]] || return 0
  inode="$(lsof -a -p "$pid" -d txt -Fi 2>/dev/null | sed -n 's/^i//p' | head -1)"
  [[ "$inode" == "$(stat -f %i "$SLOT")" ]] && return 0
  log "server $pid is not running the signed copy; graceful reload"
  (cd "$HOME" && "$SLOT" server reload --force >>"$LOG" 2>&1) || log "server reload failed"
}

case "${1:-sync}" in
  arm)
    ensure_slot && point_channel && touch "$ARMED"
    ;;
  sync)
    ensure_slot || exit 0
    [[ -f "$ARMED" ]] || exit 0
    point_channel && move_server
    ;;
  *)
    echo "usage: ${0##*/} [sync|arm]" >&2
    exit 2
    ;;
esac
