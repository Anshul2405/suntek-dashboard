# Stops the Busy push and removes its task. Leaves Busy and the SQL login alone.
$ErrorActionPreference = 'Continue'
cmd /c "schtasks /End /TN `"Suntek Busy Feed`" >nul 2>&1"
cmd /c "schtasks /Delete /TN `"Suntek Busy Feed`" /F >nul 2>&1"
cmd /c "schtasks /Delete /TN `"Suntek Busy Feed Boot`" /F >nul 2>&1"
try {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'push-busy\.ps1' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
$lines = netstat -ano | Select-String ':3001\s+.*LISTENING'
foreach ($line in $lines) {
  $procId = ($line.ToString().Trim() -split '\s+')[-1]
  if ($procId -match '^\d+$' -and [int]$procId -gt 0) { Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue }
}
Write-Host 'Stopped. The dashboard keeps the last copy it received. Run INSTALL.cmd to start again.'
