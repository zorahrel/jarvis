# Van Damme-o-Matic — Windows uninstaller
#
#     powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# Removes what install.ps1 added and nothing else. In particular it does NOT
# touch %USERPROFILE%\.claude\.credentials.json: those are Claude Code's own
# credentials, and deleting them would log the user out of a tool this script
# has no business signing out.
#
# Saved account profiles are kept unless -Purge is given, for the same reason:
# re-logging into several accounts by hand is exactly the pain this exists to
# avoid, and an uninstall is not a good moment to inflict it.

param(
  [switch]$Purge  # also delete saved profiles and the install directory
)

$ErrorActionPreference = 'Continue'

function Write-Ok($m)   { Write-Host "  [ok] $m" -ForegroundColor Green }
function Write-Skip($m) { Write-Host "  [--] $m" -ForegroundColor DarkGray }

Write-Host ""
Write-Host "  Van Damme-o-Matic - Windows uninstaller" -ForegroundColor White
Write-Host "  ------------------------------------------"
Write-Host ""

$installDir = Join-Path $env:USERPROFILE '.claude\account-switcher'
$binDir     = Join-Path $env:USERPROFILE '.local\bin'

# ── Stop the dashboard ──

$stopped = $false
foreach ($port in 3333, 3334) {
  $lines = netstat -ano -p TCP | Select-String ":$port\s" | Select-String 'LISTENING'
  foreach ($line in $lines) {
    $procId = ($line -split '\s+')[-1]
    if ($procId -match '^\d+$' -and [int]$procId -gt 0) {
      try { Stop-Process -Id ([int]$procId) -Force -ErrorAction Stop; $stopped = $true } catch { }
    }
  }
}
if ($stopped) { Write-Ok "Dashboard stopped" } else { Write-Skip "Dashboard was not running" }

# ── Logon task ──

# schtasks.exe for symmetry with install.ps1: the ScheduledTasks cmdlets need a
# principal that does not resolve on a machine using a Microsoft account.
& schtasks.exe /Delete /TN 'VanDammeOMatic' /F 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Write-Ok "Removed the logon task" }
else { Write-Skip "No logon task registered" }

# ── Environment ──
#
# Only clear ANTHROPIC_BASE_URL if it still points at our proxy: the user may
# have repointed it somewhere else on purpose.

$baseUrl = [Environment]::GetEnvironmentVariable('ANTHROPIC_BASE_URL', 'User')
if ($baseUrl -match 'localhost:3334|127\.0\.0\.1:3334') {
  [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
  Write-Ok "Cleared ANTHROPIC_BASE_URL (Claude Code goes straight to Anthropic again)"
} elseif ($baseUrl) {
  Write-Skip "ANTHROPIC_BASE_URL points elsewhere ($baseUrl) - left alone"
} else {
  Write-Skip "ANTHROPIC_BASE_URL was not set"
}

# ── CLI shim ──

$shim = Join-Path $binDir 'vdm.cmd'
if (Test-Path $shim) {
  Remove-Item $shim -Force
  Write-Ok "Removed the vdm command"
} else {
  Write-Skip "No vdm command found"
}

# ── Claude Code hooks ──

$helper = Join-Path $installDir 'vdm-helper.mjs'
$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
if ((Test-Path $helper) -and (Test-Path $settings)) {
  try {
    & node $helper hooks-uninstall $settings 3333
    Write-Ok "Removed the token-tracking hooks from settings.json"
  } catch { Write-Skip "Could not edit settings.json: $($_.Exception.Message)" }
}

# ── Files ──

if ($Purge) {
  if (Test-Path $installDir) {
    Remove-Item $installDir -Recurse -Force
    Write-Ok "Deleted $installDir, saved profiles included"
  }
} else {
  # Remove the code, keep the data.
  foreach ($f in 'vdm', 'vdm-helper.mjs', 'dashboard.mjs', 'lib.mjs', 'platform.mjs', 'install-hooks.sh', 'start-dashboard.vbs') {
    $p = Join-Path $installDir $f
    if (Test-Path $p) { Remove-Item $p -Force }
  }
  Write-Ok "Removed the program files"
  if (Test-Path (Join-Path $installDir 'accounts')) {
    Write-Skip "Kept your saved accounts in $installDir\accounts (re-run with -Purge to delete them)"
  }
}

Write-Host ""
Write-Host "  Done. Your Claude Code login is untouched." -ForegroundColor Green
Write-Host "  Open a new terminal for the environment change to apply."
Write-Host ""
