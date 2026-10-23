# Crea un'attivita' pianificata che esegue "usage-hub check" ogni 10 minuti.
$dir = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$dir\bin\usage-hub.mjs`" check" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName "claude-usage-hub-check" -Action $action -Trigger $trigger -Force | Out-Null
Write-Host "task claude-usage-hub-check registered"
