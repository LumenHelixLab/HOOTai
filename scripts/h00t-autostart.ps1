<#
  h00t-autostart.ps1 - start the h00t server at Windows logon, keep it running,
  and open it in Chrome once it answers.

  Installed to %LOCALAPPDATA%\H00T by install-h00t-autostart.ps1 and launched by
  the "H00T Autostart" scheduled task. Safe to run by hand:
    powershell -ExecutionPolicy Bypass -File h00t-autostart.ps1 -Root D:\projects\HootAi

  Logs: %LOCALAPPDATA%\H00T\autostart.log, server.log, server.err.log
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$Port = 7777,
  [int]$ReadyTimeoutSeconds = 90,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Continue'
$stateDir = Join-Path $env:LOCALAPPDATA 'H00T'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$log = Join-Path $stateDir 'autostart.log'
$url = "http://127.0.0.1:$Port"

function Write-Log([string]$msg) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date -Format o), $msg)
}

function Test-PortOpen([int]$p) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $p); return $true }
  catch { return $false }
  finally { $client.Close() }
}

function Wait-Ready([int]$timeoutSec) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -lt 500) { return $true }
    } catch {
      # Any HTTP answer (401 with auth on, 404, ...) means the server is up.
      if ($_.Exception.Response) { return $true }
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Open-Chrome {
  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  $chrome = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if ($chrome) {
    Start-Process -FilePath $chrome -ArgumentList '--new-window', $url
    Write-Log "opened Chrome at $url"
  } else {
    Start-Process $url
    Write-Log "Chrome not found; opened default browser at $url"
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.js'))) {
  Write-Log "ERROR: no server.js in $Root"
  exit 1
}

$env:HOOT_ROOT = $Root
$env:AGENTDOCK_HOST = '127.0.0.1'
Write-Log "autostart root=$Root port=$Port"

if (Test-PortOpen $Port) {
  Write-Log "port $Port already in use; not starting a second server"
  if (-not $NoBrowser) { Open-Chrome }
  exit 0
}

$node = (Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node -and (Test-Path -LiteralPath "$env:ProgramFiles\nodejs\node.exe")) {
  $node = "$env:ProgramFiles\nodejs\node.exe"
}
if (-not $node) {
  Write-Log 'ERROR: node.exe not found on PATH or in Program Files\nodejs'
  exit 1
}

$out = Join-Path $stateDir 'server.log'
$err = Join-Path $stateDir 'server.err.log'
$browserDone = $false
$quickExits = 0

# Watchdog: restart node whenever it exits; back off if it keeps crashing.
while ($true) {
  Write-Log "starting $node server.js"
  $started = Get-Date
  $p = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $Root `
    -WindowStyle Hidden -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
  $null = $p.Handle  # cache the handle so ExitCode is readable later

  if (-not $browserDone) {
    if (Wait-Ready $ReadyTimeoutSeconds) {
      if (-not $NoBrowser) { Open-Chrome }
    } else {
      Write-Log "server not answering after $ReadyTimeoutSeconds s; see $err"
    }
    $browserDone = $true
  }

  $p.WaitForExit()
  $ranFor = ((Get-Date) - $started).TotalSeconds
  if ($ranFor -lt 20) { $quickExits++ } else { $quickExits = 0 }
  $delay = 5
  if ($quickExits -ge 5) { $delay = 60 }
  Write-Log ("node exited pid={0} code={1} after {2:N0}s; restarting in {3}s" -f $p.Id, $p.ExitCode, $ranFor, $delay)
  Start-Sleep -Seconds $delay
}
