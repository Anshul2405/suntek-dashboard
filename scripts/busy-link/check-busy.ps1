# Shows whether the read-only Busy push is alive. Changes nothing.
$ErrorActionPreference = 'Continue'
$App = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = 'Suntek Busy Feed'

Write-Host ''
Write-Host 'Suntek Busy push - check'
Write-Host '========================'

Write-Host ''
Write-Host 'Task:'
$q = schtasks /Query /TN $TaskName /V /FO LIST 2>$null
if ($LASTEXITCODE -ne 0) { Write-Host '  FAIL  task is not installed. Run INSTALL.cmd.' -ForegroundColor Red }
else { $q | Select-String 'Status:|Last Run Time:|Last Result:|Next Run Time:' | ForEach-Object { Write-Host "  $($_.ToString().Trim())" } }

Write-Host ''
Write-Host 'Reader on this PC:'
try {
  $h = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 'http://127.0.0.1:3001/api/health'
  $j = $h.Content | ConvertFrom-Json
  $color = $(if ($j.status -eq 'connected') { 'Green' } else { 'Yellow' })
  Write-Host "  status $($j.status), reader $($j.reader), read-only $($j.readOnly)" -ForegroundColor $color
  foreach ($c in @($j.companies)) {
    if ($c.error) { Write-Host "  FAIL  $($c.name)  $($c.database)  $($c.error)" -ForegroundColor Red }
    else { Write-Host "  OK    $($c.name)  $($c.database)  read-only $($c.readOnly)" -ForegroundColor Green }
  }
} catch {
  Write-Host '  FAIL  reader is not answering. The task starts it again within 10 minutes.' -ForegroundColor Red
}

Write-Host ''
Write-Host 'Busy login test:'
$node = $null
$saved = Join-Path $App 'node.path'
if (Test-Path $saved) { $node = (Get-Content $saved -Raw).Trim() }
if (-not $node -or -not (Test-Path $node)) { $node = Join-Path $App 'runtime\node.exe' }
Push-Location $App
& $node 'server/check.js' 2>&1 | ForEach-Object { Write-Host "  $_" }
Pop-Location

Write-Host ''
Write-Host 'Last lines of busy-feed.log:'
$log = Join-Path $App 'busy-feed.log'
if (Test-Path $log) { Get-Content $log -Tail 12 | ForEach-Object { Write-Host "  $_" } }
else { Write-Host '  (no log yet)' }

$err = Join-Path $App 'reader.err.log'
if ((Test-Path $err) -and (Get-Item $err).Length -gt 0) {
  Write-Host ''
  Write-Host 'Last reader errors:'
  Get-Content $err -Tail 8 | ForEach-Object { Write-Host "  $_" }
}
Write-Host ''
Write-Host 'A good result: task Running, status connected, four OK lines, and "pushed ... screens" within the last few minutes.'
