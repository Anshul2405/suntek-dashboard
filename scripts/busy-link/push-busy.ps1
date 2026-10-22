# Pushes a read-only copy of Busy from this PC to the dashboard every 3 minutes.
# Nothing is ever written to Busy. No tunnel. No open port: the reader only
# listens on this PC and the push goes out to Supabase.
#
# The scheduled task starts this at boot and every 10 minutes if it has stopped.
# Reads SUPABASE_URL, SUPABASE_ANON_KEY and BUSY_LINK_SECRET from .env.server.
# Does not log those values.

$ErrorActionPreference = 'Continue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$App = Split-Path -Parent $MyInvocation.MyCommand.Path
$Lock = Join-Path $App 'busy-feed.lock'
$Log = Join-Path $App 'busy-feed.log'
$ReaderVersion = 'suntek-busy-2026-10-16d'

function Roll([string]$path) {
  try {
    if ((Test-Path $path) -and (Get-Item $path).Length -gt 5MB) {
      Move-Item -Path $path -Destination "$path.old" -Force
    }
  } catch {}
}

function Log([string]$msg) {
  try {
    Roll $Log
    Add-Content -Path $Log -Value ('{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg)
  } catch {}
}

function Read-EnvFile([string]$path) {
  $map = @{}
  if (-not (Test-Path $path)) { return $map }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    $map[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
  }
  return $map
}

function Test-Node([string]$p) {
  if (-not $p -or -not (Test-Path $p)) { return $false }
  try {
    $v = & $p -v 2>$null
    return ($LASTEXITCODE -eq 0 -and "$v" -match '^v\d+')
  } catch { return $false }
}

# Bundled Node first, so a missing or updated system Node cannot stop the reader.
function Find-Node {
  $candidates = @(
    (Join-Path $App 'runtime\node.exe'),
    'C:\Program Files\nodejs\node.exe',
    'C:\Program Files (x86)\nodejs\node.exe'
  )
  $saved = Join-Path $App 'node.path'
  if (Test-Path $saved) { $candidates += (Get-Content $saved -Raw).Trim() }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $candidates += $cmd.Source }
  foreach ($c in $candidates) { if (Test-Node $c) { return $c } }
  return $null
}

function Get-Local([string]$path, [int]$timeout = 120) {
  try {
    return Invoke-WebRequest -UseBasicParsing -TimeoutSec $timeout "http://127.0.0.1:3001$path"
  } catch {
    return $null
  }
}

function Stop-Reader {
  $lines = netstat -ano | Select-String ':3001\s+.*LISTENING'
  foreach ($line in $lines) {
    $procId = ($line.ToString().Trim() -split '\s+')[-1]
    if ($procId -match '^\d+$' -and [int]$procId -gt 0) {
      Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-Reader {
  $node = Find-Node
  if (-not $node) { Log 'reader is down and no working node.exe was found'; return }
  Log "starting reader with $node"
  Stop-Reader
  Start-Sleep -Seconds 2
  $out = Join-Path $App 'reader.out.log'
  $err = Join-Path $App 'reader.err.log'
  Roll $out
  Roll $err
  if (Test-Path $out) { Add-Content -Path "$out.old" -Value (Get-Content $out -Raw) -ErrorAction SilentlyContinue }
  if (Test-Path $err) { Add-Content -Path "$err.old" -Value (Get-Content $err -Raw) -ErrorAction SilentlyContinue }
  Start-Process -FilePath $node -ArgumentList 'server/index.js' -WorkingDirectory $App -WindowStyle Hidden `
    -RedirectStandardOutput $out -RedirectStandardError $err
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 2
    if (Get-Local '/api/health' 30) { return }
  }
  Log 'reader did not answer within 30 seconds'
}

# Current-year files. Chlorides already includes Delhi, Ganjam and Rehla.
$companies = @('0007', '0009', '0010', '0012')

function Add-Company([string]$path, [string]$code) {
  if ($path -match '\?') { return "$path&company=$code" }
  return "$path`?company=$code"
}

function Is-Good([string]$content) {
  if (-not $content) { return $false }
  # A backup file served while SQL was down must never replace a real read.
  if ($content -match '"_fallback"\s*:\s*true') { return $false }
  if ($content -match '^\s*\{\s*"error"\s*:') { return $false }
  return $true
}

# One call per screen. The body goes as UTF-8 bytes so Hindi and the rupee
# sign arrive intact on Windows PowerShell 5.
function Publish([hashtable]$cfg, $items) {
  if (-not $items -or $items.Count -eq 0) { return }
  $secret = $cfg['BUSY_LINK_SECRET'] | ConvertTo-Json -Compress
  $parts = @()
  foreach ($it in $items) {
    $pathJson = $it.path | ConvertTo-Json -Compress
    $parts += "{`"path`":$pathJson,`"payload`":$($it.payload)}"
  }
  $body = "{`"p_secret`":$secret,`"p_items`":[" + ($parts -join ',') + ']}'
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  $headers = @{
    apikey        = $cfg['SUPABASE_ANON_KEY']
    Authorization = "Bearer $($cfg['SUPABASE_ANON_KEY'])"
  }
  Invoke-RestMethod -Method Post -TimeoutSec 120 -Uri "$($cfg['SUPABASE_URL'].TrimEnd('/'))/rest/v1/rpc/publish_busy_feed" `
    -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null
}

function Publish-Screen([hashtable]$cfg, [string]$path) {
  $items = @()
  foreach ($code in $companies) {
    $full = Add-Company $path $code
    $res = Get-Local $full
    if (-not $res -or $res.StatusCode -ne 200 -or -not (Is-Good $res.Content)) {
      $script:skipped++
      $script:skippedPaths += $full
      continue
    }
    $items += @{ path = $full; payload = $res.Content }
    # Older site builds ask for Chlorides with no company on the path.
    if ($code -eq '0007') { $items += @{ path = $path; payload = $res.Content } }
  }
  if ($items.Count -eq 0) { return }
  try {
    Publish $cfg $items
    $script:pushed += $items.Count
  } catch {
    $script:failedPublish++
    Log "publish failed ${path}: $($_.Exception.Message)"
  }
}

function Publish-Heartbeat([hashtable]$cfg, [string]$status, [string]$note) {
  try {
    $beat = @{
      status    = $status
      note      = $note
      at        = (Get-Date).ToUniversalTime().ToString('o')
      pushed    = $script:pushed
      skipped   = $script:skipped
      reader    = $ReaderVersion
      computer  = $env:COMPUTERNAME
      readOnly  = $true
    } | ConvertTo-Json -Compress
    Publish $cfg @(@{ path = '/api/heartbeat'; payload = $beat })
  } catch {
    Log "heartbeat failed: $($_.Exception.Message)"
  }
}

if (Test-Path $Lock) {
  $age = (Get-Date) - (Get-Item $Lock).LastWriteTime
  if ($age.TotalMinutes -lt 10) { exit 0 }
}
Set-Content -Path $Lock -Value $PID

$paths = @(
  '/api/health',
  '/api/kpis/overview',
  '/api/kpis/revenue-trend',
  '/api/customers/top?limit=1',
  '/api/customers/top?limit=3',
  '/api/customers/top?limit=5',
  '/api/customers/outstanding',
  '/api/customers/list',
  '/api/sales/mtd',
  '/api/sales/sites',
  '/api/sales/contracts',
  '/api/movements/recent?days=3',
  '/api/purchases/recent',
  '/api/analytics/kpis',
  '/api/anomaly/scan',
  '/api/anomaly/analytics',
  '/api/anomaly/metrics'
)

try {
  $cfg = Read-EnvFile (Join-Path $App '.env.server')
  foreach ($key in @('SUPABASE_URL', 'SUPABASE_ANON_KEY', 'BUSY_LINK_SECRET', 'MSSQL_PASSWORD')) {
    if (-not $cfg[$key]) { Log "missing $key in .env.server"; exit 1 }
  }
  Log 'push started'
  $notConnected = 0

  while ($true) {
    try {
      Set-Content -Path $Lock -Value $PID
      $script:pushed = 0
      $script:skipped = 0
      $script:failedPublish = 0
      $script:skippedPaths = @()

      $health = Get-Local '/api/health' 60
      if (-not $health) {
        Start-Reader
        $health = Get-Local '/api/health' 60
      } elseif ($health.Content -notmatch [regex]::Escape($ReaderVersion)) {
        Log 'an older reader is running, replacing it'
        Start-Reader
        $health = Get-Local '/api/health' 60
      }

      $connected = $health -and $health.StatusCode -eq 200 -and $health.Content -match '"status"\s*:\s*"connected"'
      if (-not $connected) {
        $notConnected++
        Log 'Busy SQL is not answering. The dashboard keeps the last good copy.'
        # A stuck reader can hold a dead SQL connection. Restart it now and then.
        if ($notConnected % 5 -eq 0) { Start-Reader }
        Publish-Heartbeat $cfg 'waiting' 'Busy SQL is not answering'
      } else {
        $notConnected = 0
        foreach ($path in $paths) {
          Set-Content -Path $Lock -Value $PID
          Publish-Screen $cfg $path
        }

        # Every chart series the anomaly screen can open: each metric at each grain.
        $metrics = Get-Local '/api/anomaly/metrics?company=0007'
        if ($metrics -and $metrics.StatusCode -eq 200) {
          try {
            $catalog = $metrics.Content | ConvertFrom-Json
            $grains = @($catalog.grains)
            if ($grains.Count -eq 0) { $grains = @('daily', 'weekly', 'monthly') }
            foreach ($m in @($catalog.metrics)) {
              if (-not $m.key) { continue }
              foreach ($g in $grains) {
                Set-Content -Path $Lock -Value $PID
                Publish-Screen $cfg "/api/anomaly/timeseries?metric=$($m.key)&grain=$g"
              }
            }
          } catch {
            Log "series failed: $($_.Exception.Message)"
          }
        }

        if ($script:skipped -gt 0) { Log ("skipped " + (($script:skippedPaths | Select-Object -First 8) -join ', ')) }
        Log "pushed $($script:pushed) screens, skipped $($script:skipped)"
        $state = $(if ($script:failedPublish -gt 0) { 'partial' } else { 'ok' })
        Publish-Heartbeat $cfg $state ''
      }
    } catch {
      Log "cycle failed, trying again: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 180
  }
} finally {
  Remove-Item $Lock -ErrorAction SilentlyContinue
}
