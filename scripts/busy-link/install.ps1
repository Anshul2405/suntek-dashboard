# Installs the read-only Busy push on this PC. Run through INSTALL.cmd.
# Safe to run again at any time: it replaces the old copy and the old task.
# Busy is only ever read. The SQL login it uses is denied every write.

# Continue, not Stop: Windows PowerShell 5 turns any stderr line from
# schtasks, robocopy or sqlcmd into a fatal error under Stop.
$ErrorActionPreference = 'Continue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {}

$Source = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target = 'C:\SuntekBusy'
$TaskName = 'Suntek Busy Feed'
$ReaderVersion = 'suntek-busy-2026-10-16d'

function Say([string]$msg) { Write-Host $msg }
function Good([string]$msg) { Write-Host "  OK    $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  NOTE  $msg" -ForegroundColor Yellow }
function Bad([string]$msg) { Write-Host "  FAIL  $msg" -ForegroundColor Red }

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Bad 'Run INSTALL.cmd and click Yes when Windows asks.'; exit 1 }

Say ''
Say 'Suntek Busy push - install'
Say '=========================='

# ---------------------------------------------------------------- 1. old copies
Say ''
Say '1. Stopping any old Busy reader, push, or tunnel'
foreach ($name in @('Suntek Busy Feed', 'Suntek Busy Feed Boot', 'Suntek Busy Link', 'Suntek Busy', 'SuntekBusy')) {
  cmd /c "schtasks /End /TN `"$name`" >nul 2>&1"
  cmd /c "schtasks /Delete /TN `"$name`" /F >nul 2>&1"
}
try {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match 'push-busy\.ps1|keep-busy-link\.ps1') -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
} catch {}
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$lines = netstat -ano | Select-String ':3001\s+.*LISTENING'
foreach ($line in $lines) {
  $procId = ($line.ToString().Trim() -split '\s+')[-1]
  if ($procId -match '^\d+$' -and [int]$procId -gt 0) { Stop-Process -Id ([int]$procId) -Force -ErrorAction SilentlyContinue }
}
Start-Sleep -Seconds 2
Good 'old reader stopped'

# ---------------------------------------------------------------- 2. copy files
Say ''
Say "2. Copying the reader to $Target"
if ((Resolve-Path $Source).Path.TrimEnd('\') -ne $Target) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  # Keep the logs from an earlier install. Replace everything else.
  robocopy $Source $Target /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP /XF '*.log' '*.log.old' 'busy-feed.lock' | Out-Null
  if ($LASTEXITCODE -ge 8) { Bad "copy to $Target failed"; exit 1 }
}
Get-ChildItem -Path $Target -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Target 'busy-feed.lock') -ErrorAction SilentlyContinue
Good "files are in $Target"

# ---------------------------------------------------------------- 3. node
Say ''
Say '3. Checking Node'
$node = $null
foreach ($c in @((Join-Path $Target 'runtime\node.exe'), 'C:\Program Files\nodejs\node.exe', 'C:\Program Files (x86)\nodejs\node.exe')) {
  if (Test-Path $c) {
    $v = & $c -v 2>$null
    if ($LASTEXITCODE -eq 0 -and "$v" -match '^v\d+') { $node = $c; Good "Node $v at $c"; break }
  }
}
if (-not $node) { Bad 'No working node.exe. The bundled runtime\node.exe did not start.'; exit 1 }
Set-Content -Path (Join-Path $Target 'node.path') -Value $node

# ---------------------------------------------------------------- 4. settings
$envFile = Join-Path $Target '.env.server'
$cfg = @{}
foreach ($line in Get-Content $envFile) {
  if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
  $p = $line.Split('=', 2); $cfg[$p[0].Trim()] = $p[1].Trim().Trim('"').Trim("'")
}
foreach ($key in @('MSSQL_USER', 'MSSQL_PASSWORD', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'BUSY_LINK_SECRET')) {
  if (-not $cfg[$key]) { Bad "$key is missing from .env.server"; exit 1 }
}

# ---------------------------------------------------------------- 5. SQL login
Say ''
Say '4. Read-only SQL login'
function Find-Sqlcmd {
  $cmd = Get-Command sqlcmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $found = Get-ChildItem -Path 'C:\Program Files\Microsoft SQL Server', 'C:\Program Files (x86)\Microsoft SQL Server' -Filter sqlcmd.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($found) { return $found.FullName }
  return $null
}

function Test-Busy {
  Push-Location $Target
  try { $out = & $node 'server/check.js' 2>&1 } finally { Pop-Location }
  return @{ ok = ($LASTEXITCODE -eq 0); lines = @($out) }
}

$sqlcmd = Find-Sqlcmd
if ($sqlcmd) {
  # Same password as .env.server. Read on every Busy company file, denied every
  # write, and allowed to open next year's files when Busy creates them.
  $pw = $cfg['MSSQL_PASSWORD'].Replace("'", "''")
  $user = $cfg['MSSQL_USER']
  $sqlText = @"
SET NOCOUNT ON;
IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'$user')
  CREATE LOGIN [$user] WITH PASSWORD = N'$pw', CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF, DEFAULT_DATABASE = master;
ELSE
  ALTER LOGIN [$user] WITH PASSWORD = N'$pw', CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF;
ALTER LOGIN [$user] ENABLE;
BEGIN TRY EXEC (N'GRANT CONNECT ANY DATABASE TO [$user]'); PRINT 'future year files: can open'; END TRY BEGIN CATCH PRINT 'future year files: not on this SQL version'; END CATCH
BEGIN TRY EXEC (N'GRANT SELECT ALL USER SECURABLES TO [$user]'); PRINT 'future year files: can read'; END TRY BEGIN CATCH PRINT 'future year files: read grant not on this SQL version'; END CATCH
DECLARE @db sysname, @s nvarchar(max);
DECLARE c CURSOR LOCAL FAST_FORWARD FOR
  SELECT name FROM sys.databases WHERE name LIKE 'BusyComp[0-9][0-9][0-9][0-9][_]db1%' AND state = 0;
OPEN c; FETCH NEXT FROM c INTO @db;
WHILE @@FETCH_STATUS = 0
BEGIN
  SET @s = N'USE ' + QUOTENAME(@db) + N';
    IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N''$user'') CREATE USER [$user] FOR LOGIN [$user];
    ALTER ROLE db_datareader ADD MEMBER [$user];
    ALTER ROLE db_denydatawriter ADD MEMBER [$user];';
  BEGIN TRY EXEC (@s); PRINT 'read-only on ' + @db; END TRY
  BEGIN CATCH PRINT 'skipped ' + @db + ': ' + ERROR_MESSAGE(); END CATCH
  FETCH NEXT FROM c INTO @db;
END
CLOSE c; DEALLOCATE c;
SELECT CASE SERVERPROPERTY('IsIntegratedSecurityOnly') WHEN 1 THEN 'LOGIN MODE: WINDOWS ONLY' ELSE 'LOGIN MODE: SQL logins allowed' END;
"@
  $tmp = Join-Path $env:TEMP ('busy-login-' + [guid]::NewGuid().ToString('N') + '.sql')
  Set-Content -Path $tmp -Value $sqlText -Encoding UTF8
  $applied = $false
  foreach ($server in @('localhost', '.', '(local)', '.\SQLEXPRESS', 'localhost\SQLEXPRESS')) {
    $out = & $sqlcmd -S $server -E -b -l 15 -i $tmp 2>&1
    if ($LASTEXITCODE -eq 0) {
      $applied = $true
      Good "login checked on SQL Server '$server'"
      foreach ($l in $out) { if ("$l".Trim()) { Say "        $l" } }
      break
    }
  }
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  if (-not $applied) { Warn 'sqlcmd could not log in with Windows sign-in. Using the login that already exists.' }
} else {
  Warn 'sqlcmd is not on this PC. Using the login that already exists.'
}

Say ''
Say '5. Opening each Busy company with the read-only login'
$test = Test-Busy
foreach ($l in $test.lines) { Say "        $l" }
if ($test.ok) { Good 'all four companies open, read-only' }
else { Warn 'not every company opened. The push still starts and keeps trying every 3 minutes.' }

# ---------------------------------------------------------------- 6. task
Say ''
Say '6. Startup task (no time limit, restarts itself)'
$script = Join-Path $Target 'push-busy.ps1'
$arg = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`""
$xmlPath = Join-Path $Target 'busy-feed-task.xml'
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Reads Busy (read-only) and pushes a copy to the Suntek dashboard. Never writes to Busy.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT1M</Delay>
    </BootTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT10M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>$arg</Arguments>
      <WorkingDirectory>$Target</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
Set-Content -Path $xmlPath -Value $xml -Encoding Unicode
cmd /c "schtasks /Delete /TN `"$TaskName Boot`" /F >nul 2>&1"
schtasks /Create /TN $TaskName /XML $xmlPath /F | Out-Null
if ($LASTEXITCODE -ne 0) {
  # Plain tasks still keep it alive: Windows may stop a run after 72 hours,
  # and the 10-minute task starts it again.
  Warn 'detailed task was refused, using a plain 10-minute task and a boot task'
  schtasks /Create /TN $TaskName /TR "powershell.exe $arg" /SC MINUTE /MO 10 /RU SYSTEM /RL HIGHEST /F | Out-Null
  if ($LASTEXITCODE -ne 0) { Bad 'could not create the startup task'; exit 1 }
  schtasks /Create /TN "$TaskName Boot" /TR "powershell.exe $arg" /SC ONSTART /RU SYSTEM /RL HIGHEST /F | Out-Null
}
schtasks /Run /TN $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) { Bad 'could not start the startup task'; exit 1 }
Good "task '$TaskName' created and started"

# ---------------------------------------------------------------- 7. confirm
Say ''
Say '7. Waiting for the first push (up to 8 minutes)'
$log = Join-Path $Target 'busy-feed.log'
$startedAt = Get-Date
$done = $false
for ($i = 0; $i -lt 96 -and -not $done; $i++) {
  Start-Sleep -Seconds 5
  if (Test-Path $log) {
    $recent = Get-Content $log -Tail 40 | Where-Object {
      $stamp = $_.Substring(0, [Math]::Min(19, $_.Length))
      try { [datetime]::ParseExact($stamp, 'yyyy-MM-dd HH:mm:ss', $null) -ge $startedAt.AddSeconds(-5) } catch { $false }
    }
    if ($recent | Where-Object { $_ -match 'pushed \d+ screens' }) { $done = $true }
    elseif ($recent | Where-Object { $_ -match 'not answering' }) { $done = $true }
  }
  if ($i % 6 -eq 5) { Write-Host '.' -NoNewline }
}
Say ''
if (Test-Path $log) {
  Get-Content $log -Tail 6 | ForEach-Object { Say "        $_" }
}

$health = $null
try { $health = Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 'http://127.0.0.1:3001/api/health' } catch {}
Say ''
if ($health -and $health.Content -match '"status"\s*:\s*"connected"' -and $health.Content -match [regex]::Escape($ReaderVersion)) {
  Write-Host 'DONE. Busy is being read (read-only) and pushed every 3 minutes.' -ForegroundColor Green
  Write-Host 'It starts by itself after a reboot. Nothing needs to stay open. You can close this window.' -ForegroundColor Green
} elseif ($health) {
  Write-Host 'INSTALLED, but Busy SQL is not answering yet. The push keeps trying every 3 minutes by itself.' -ForegroundColor Yellow
  Write-Host 'Send a photo of this window.' -ForegroundColor Yellow
} else {
  Write-Host 'INSTALLED, but the reader has not answered yet. It is retried every 10 minutes by itself.' -ForegroundColor Yellow
  Write-Host "Send a photo of this window and of $Target\reader.err.log" -ForegroundColor Yellow
}
Say "Check at any time: double-click $Target\CHECK.cmd"
