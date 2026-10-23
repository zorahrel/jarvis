# Swapping the live services to the integrated hub

Nothing here has been executed. The live services (VDM :3335/:3336, tray server :3337) still run from their original folders.
The integrated dashboard runs on a trial port: `node bin/usage-hub.mjs serve` (port from `config.json`, default 3350).

## What changes
- VDM runs from `modules/vdm/dashboard.mjs`; its state stays in `~/.claude/account-switcher` through `VDM_STATE_DIR`.
- The tray server runs from `modules/tray/server/server.mjs`. The API-spend line needs `~/.config/claude-usage-hub/local.json`
  (`{"api": {"account": "...", "org": "...", "keychainAccount": "..."}}`, chmod 600) or `USAGE_LOCAL_CONFIG`.
- The Swift tray app is unchanged; rebuild with `modules/tray/install.sh` only if you want it from the hub.

## Swap (launchd)
```sh
H=$HOME/Projects/claude-usage-hub
cd ~/Library/LaunchAgents
cp com.jarvis.vdm.plist /tmp/com.jarvis.vdm.plist.bak
cp com.jarvis.usage-server.plist /tmp/com.jarvis.usage-server.plist.bak
# 1. VDM: new code path + state dir
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $H/modules/vdm/dashboard.mjs" com.jarvis.vdm.plist
/usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:VDM_STATE_DIR string $HOME/.claude/account-switcher" com.jarvis.vdm.plist
# 2. tray server: new code path
/usr/libexec/PlistBuddy -c "Set :ProgramArguments:1 $H/modules/tray/server/server.mjs" com.jarvis.usage-server.plist
launchctl kickstart -k gui/$(id -u)/com.jarvis.vdm
launchctl kickstart -k gui/$(id -u)/com.jarvis.usage-server
```
Check `ProgramArguments` first with `/usr/libexec/PlistBuddy -c Print <plist>`: index 1 assumes `node` is index 0.

## Rollback
```sh
cd ~/Library/LaunchAgents
cp /tmp/com.jarvis.vdm.plist.bak com.jarvis.vdm.plist
cp /tmp/com.jarvis.usage-server.plist.bak com.jarvis.usage-server.plist
launchctl kickstart -k gui/$(id -u)/com.jarvis.vdm
launchctl kickstart -k gui/$(id -u)/com.jarvis.usage-server
```

## Notes
- If the originals change after the import: `git subtree pull --prefix=modules/vdm <path-to-vdm-fork> <branch>` (same for the tray).
- The subtree history contains personal strings from the originals. Do not push the hub to a public remote without rewriting it.
- The VDM proxy keeps about 5.7 days of requests and cannot split the OpenClaw root by work; that split comes from the session logs.
