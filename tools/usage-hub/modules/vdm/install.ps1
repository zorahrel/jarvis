# Van Damme-o-Matic — Windows installer
#
# Run from a normal PowerShell window (no admin needed):
#
#     powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# What this does differently from install.sh, and why:
#
#   * Credentials. On macOS Claude Code keeps them in the Keychain; on Windows
#     it keeps them in %USERPROFILE%\.claude\.credentials.json. platform.mjs
#     handles both, so nothing here has to.
#   * Auto-start. There is no ~/.zshrc to append to. A logon scheduled task
#     starts the dashboard, and ANTHROPIC_BASE_URL is set as a persistent user
#     environment variable so every future terminal inherits it.
#   * The `vdm` CLI is bash. Git for Windows ships bash, so a small .cmd shim
#     forwards to it. Everything else is Node, which is required anyway.

$ErrorActionPreference = 'Stop'

function Write-Step($msg)  { Write-Host "  $msg" }
function Write-Ok($msg)    { Write-Host "  [ok] $msg"   -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "  [!]  $msg"   -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "  [x]  $msg"   -ForegroundColor Red }

Write-Host ""
Write-Host "  Van Damme-o-Matic - Windows installer" -ForegroundColor White
Write-Host "  ----------------------------------------"
Write-Host ""

# ── Prerequisites ──

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Err "Node.js is required. Install it from https://nodejs.org/ (LTS) and re-run."
  exit 1
}
# `node -v` normally prints "v22.1.0", but not always: nvm-windows with no
# version selected prints "No node.js version selected.", and a broken install
# can print nothing at all. Casting that to [int] threw a PowerShell type error
# and buried the actual problem under a stack trace — the first thing a new user
# would see, and unactionable.
$nodeVersionRaw = (& node -v 2>&1 | Out-String).Trim()
if ($nodeVersionRaw -match 'v?(\d+)\.(\d+)\.(\d+)') {
  $nodeMajor = [int]$Matches[1]
  $nodeVersion = "$($Matches[1]).$($Matches[2]).$($Matches[3])"
  if ($nodeMajor -lt 18) {
    Write-Err "Node.js 18+ required (found v$nodeVersion)."
    exit 1
  }
} else {
  Write-Err "``node -v`` did not report a version. It said:"
  Write-Host "    $nodeVersionRaw"
  Write-Step "If you use nvm-windows, pick a version first:  nvm use 22"
  Write-Step "Otherwise reinstall Node.js from https://nodejs.org/"
  exit 1
}

# Git for Windows gives us both git and the bash the `vdm` CLI runs under.
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
  Write-Err "Git for Windows is required. Install it from https://git-scm.com/download/win and re-run."
  exit 1
}

# `where.exe bash` can find the WSL stub, which is a different world entirely:
# it would look at Linux paths and a Linux home. Resolve bash next to git.exe.
$gitDir = Split-Path (Split-Path $git.Source -Parent) -Parent
$bash = Join-Path $gitDir 'bin\bash.exe'
if (-not (Test-Path $bash)) {
  $bash = Join-Path $gitDir 'usr\bin\bash.exe'
}
if (-not (Test-Path $bash)) {
  Write-Err "Could not find Git's bash.exe next to $($git.Source). Reinstall Git for Windows."
  exit 1
}

Write-Ok "Prerequisites OK (Node v$nodeVersion, Git, bash)"

# ── Install files ──

$installDir = Join-Path $env:USERPROFILE '.claude\account-switcher'
$sourceDir  = $PSScriptRoot

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $installDir 'accounts') | Out-Null

$codeFiles = @('vdm', 'vdm-helper.mjs', 'dashboard.mjs', 'lib.mjs', 'platform.mjs', 'install-hooks.sh')
foreach ($f in $codeFiles) {
  $src = Join-Path $sourceDir $f
  if (-not (Test-Path $src)) {
    Write-Err "Missing $f in $sourceDir - is this a complete checkout?"
    exit 1
  }
  Copy-Item $src (Join-Path $installDir $f) -Force
}

# Never overwrite an existing config: it holds the user's caps and strategy.
$configFile = Join-Path $installDir 'config.json'
if (-not (Test-Path $configFile)) {
  Copy-Item (Join-Path $sourceDir 'config.example.json') $configFile
}

# Version marker, for `vdm upgrade` and the dashboard footer.
try {
  Push-Location $sourceDir
  $version = (& git describe --tags --abbrev=0 2>$null)
  if (-not $version) { $version = (& git rev-parse --short HEAD 2>$null) }
  if ($version) { Set-Content -Path (Join-Path $installDir '.version') -Value $version -NoNewline -Encoding ascii }
  Pop-Location
} catch { Write-Warn2 "Could not record the version marker (harmless)." }

Write-Ok "Installed to $installDir"

# ── `vdm` shim on PATH ──
#
# The CLI is a bash script. A .cmd shim lets `vdm ...` work from PowerShell and
# cmd.exe alike. -l is deliberately omitted: a login shell would source the
# user's profile and can rewrite PATH in ways that hide node.

$binDir = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

$vdmUnix = ($installDir -replace '\\', '/') + '/vdm'
# chcp 65001 first: the CLI draws its tables with box-drawing characters and
# arrows, and an Italian (or any non-US) console defaults to cp850, which
# renders them as "ÔöÇÔöÇÔöÇ". The old code page is restored on the way out so the
# shim does not leave the user's console reconfigured behind it.
$shim = @"
@echo off
REM Van Damme-o-Matic CLI shim - forwards to the bash script under Git for Windows.
setlocal
for /f "tokens=2 delims=:" %%a in ('chcp') do set "_VDM_CP=%%a"
chcp 65001 >nul
"$bash" "$vdmUnix" %*
set "_VDM_EXIT=%ERRORLEVEL%"
chcp %_VDM_CP% >nul 2>nul
endlocal & exit /b %_VDM_EXIT%
"@
Set-Content -Path (Join-Path $binDir 'vdm.cmd') -Value $shim -Encoding ascii
Write-Ok "Linked vdm into $binDir"

# Add to the persistent user PATH if missing. [Environment] writes the registry;
# $env: alone would last only for this window.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$binDir*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$binDir", 'User')
  Write-Ok "Added $binDir to your PATH (restart your terminal to pick it up)"
} else {
  Write-Step "$binDir is already on your PATH"
}

# ── Point Claude Code at the proxy ──

[Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', 'http://localhost:3334', 'User')
$env:ANTHROPIC_BASE_URL = 'http://localhost:3334'
Write-Ok "ANTHROPIC_BASE_URL set to http://localhost:3334"

# ── Auto-start the dashboard at logon ──
#
# A scheduled task, not a Startup shortcut: it runs without a console window and
# survives the shell being closed. wscript's hidden-window trick avoids the
# black cmd box that a plain `node` task would flash on every logon.

$vbsPath = Join-Path $installDir 'start-dashboard.vbs'
$nodeExe = $node.Source
$dashboardPath = Join-Path $installDir 'dashboard.mjs'
$logPath = Join-Path $installDir 'dashboard.log'
$vbs = @"
' Starts the VDM dashboard with no visible window.
' 0 = hidden, False = do not wait for it to exit.
Set sh = CreateObject("WScript.Shell")
sh.Run """$nodeExe"" ""$dashboardPath""", 0, False
"@
Set-Content -Path $vbsPath -Value $vbs -Encoding ascii

$taskName = 'VanDammeOMatic'

# schtasks.exe, not Register-ScheduledTask.
#
# The cmdlet needs a principal, and `New-ScheduledTaskPrincipal -UserId
# "$env:USERDOMAIN\$env:USERNAME"` fails outright on a machine whose user is a
# Microsoft account: "No mapping between account names and security IDs was
# done". That is a common setup, not an exotic one, and it would silently cost
# the user their auto-start. schtasks defaults to the invoking user and asks no
# questions.
$taskRun = 'wscript.exe "' + $vbsPath + '"'
& schtasks.exe /Create /TN $taskName /TR $taskRun /SC ONLOGON /RL LIMITED /F 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Ok "Dashboard will start automatically at logon"
} else {
  Write-Warn2 "Could not register the logon task (exit $LASTEXITCODE)"
  Write-Step  "Start it by hand with: vdm dashboard"
}

# ── Token tracking hooks ──

try {
  & $bash -c "cd '$($installDir -replace '\\', '/')' && . ./install-hooks.sh && install_beta_hooks" 2>&1 | Out-Null
  Write-Ok "[BETA] Token tracking hooks installed"
} catch {
  Write-Warn2 "Hook installation skipped: $($_.Exception.Message)"
}

# ── Start it now ──

$already = Test-NetConnection -ComputerName 127.0.0.1 -Port 3333 -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $already) {
  Start-Process wscript.exe -ArgumentList "`"$vbsPath`"" -WindowStyle Hidden
  Start-Sleep -Seconds 3
}

Write-Host ""
Write-Host "  Installation complete." -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Open a NEW terminal (so PATH and ANTHROPIC_BASE_URL apply)"
Write-Host "    2. claude auth login     <- log in to the first account"
Write-Host "    3. vdm list              <- it is saved automatically"
Write-Host "       claude auth status    <- which account am I on right now"
Write-Host "    4. claude auth logout + claude auth login for each further account"
Write-Host ""
Write-Host "  Dashboard:  http://localhost:3333"
Write-Host "  API proxy:  http://localhost:3334"
Write-Host ""
