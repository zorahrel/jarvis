# jarvis-restart precmd hook
# Sourced from ~/.zshrc. When /restart writes the flag file, the next shell
# prompt after claude exits reads it, optionally runs `claude update`, and
# re-execs `claude -c` so the TTY is reused and the session is resumed.

_jarvis_restart_flag=~/.jarvis-restart

_jarvis_restart_check() {
  [[ -f $_jarvis_restart_flag ]] || return
  local action="$(<$_jarvis_restart_flag 2>/dev/null)"
  local target_cwd="${action#*|}"
  action="${action%%|*}"
  rm -f $_jarvis_restart_flag

  if [[ -n $target_cwd && -d $target_cwd ]]; then
    cd "$target_cwd" || return
  fi

  print -P "%F{yellow}[jarvis-restart]%f action=$action cwd=$PWD"

  if [[ $action == update ]]; then
    claude update || print -P "%F{red}[jarvis-restart] update failed, continuing with current version%f"
  fi

  exec claude -c
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd _jarvis_restart_check
