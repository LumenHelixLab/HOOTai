<#
  install-h00t-autostart.ps1 - start h00t automatically at Windows logon and open
  it in Chrome.

  What it does:
    1. Picks the h00t copy to run. With no -Root, it looks at every known copy
       (D:\projects\HootAi, D:\projects\h00t, D:\projects\Hoot, C:\projects\HOOTai)
       and chooses the one whose source files were edited most recently.
    2. Copies h00t-autostart.ps1 to %LOCALAPPDATA%\H00T.
    3. Registers a per-user scheduled task "H00T Autostart" that runs at logon
       (hidden window, no admin rights needed). If Task Scheduler refuses, it
       falls back to a shortcut in your Startup folder.

  Usage (PowerShell, from the repo folder):
    powershell -ExecutionPolicy Bypass -File .\scripts\install-h00t-autostart.ps1
    powershell -ExecutionPolicy Bypass -File .\scripts\install-h00t-autostart.ps1 -Root D:\projects\HootAi
    powershell -ExecutionPolicy Bypass -File .\scripts\install-h00t-autostart.ps1 -WhatIf
    powershell -ExecutionPolicy Bypass -File .\scripts\install-h00t-autostart.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Root,
  [int]$Port = 7777,
  [int]$DelaySeconds = 20,
  [switch]$WhatIf,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$taskName = 'H00T Autostart'
$stateDir = Join-Path $env:LOCALAPPDATA 'H00T'
$runner = Join-Path $stateDir 'h00t-autostart.ps1'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'H00T Autostart.lnk'

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
  }
  if (Test-Path -LiteralPath $startupLnk) {
    Remove-Item -LiteralPath $startupLnk
    Write-Host 'Removed Startup-folder shortcut.'
  }
  Write-Host 'Uninstalled. A server that is already running keeps running until you stop it.'
  return
}

# Newest hand-edited source file under $dir, skipping dependencies, build output,
# runtime state and logs so that simply running h00t does not count as "work".
function Get-LatestWork([string]$dir) {
  $skipDirs = @('node_modules', 'dist', '.git', 'state', 'logs', 'diary', 'bin', 'tmp', 'temp',
                '.venv', 'venv', '__pycache__', '.pytest_cache', 'coverage')
  $skipFiles = @('package-lock.json', 'memory.md')
  $exts = @('.js', '.cjs', '.mjs', '.ts', '.tsx', '.py', '.md', '.json', '.ps1', '.css', '.html')
  $best = $null
  $stack = New-Object System.Collections.Stack
  $stack.Push((Get-Item -LiteralPath $dir))
  while ($stack.Count -gt 0) {
    $d = $stack.Pop()
    foreach ($e in (Get-ChildItem -LiteralPath $d.FullName -Force -ErrorAction SilentlyContinue)) {
      if ($e.PSIsContainer) {
        if ($skipDirs -notcontains $e.Name) { $stack.Push($e) }
      } elseif (($exts -contains $e.Extension) -and ($skipFiles -notcontains $e.Name)) {
        if (-not $best -or $e.LastWriteTime -gt $best.LastWriteTime) { $best = $e }
      }
    }
  }
  return $best
}

if ($Root) {
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'server.js'))) {
    throw "No server.js in $Root - is that an h00t folder?"
  }
  $Root = (Get-Item -LiteralPath $Root).FullName
} else {
  $known = @('D:\projects\HootAi', 'D:\projects\h00t', 'D:\projects\Hoot', 'C:\projects\HOOTai')
  if ($PSScriptRoot) { $known += (Split-Path $PSScriptRoot -Parent) }
  $copies = $known |
    Where-Object { $_ -and (Test-Path -LiteralPath (Join-Path $_ 'server.js')) } |
    ForEach-Object { (Get-Item -LiteralPath $_).FullName } |
    Sort-Object -Unique
  if (-not $copies) { throw 'No h00t copy found. Re-run with -Root <folder>.' }

  Write-Host 'h00t copies found (newest source edit):'
  $ranked = foreach ($c in $copies) {
    $f = Get-LatestWork $c
    $when = if ($f) { $f.LastWriteTime } else { [datetime]::MinValue }
    $file = if ($f) { $f.FullName.Substring($c.Length).TrimStart('\') } else { '-' }
    [pscustomobject]@{ Root = $c; LastEdit = $when; File = $file }
  }
  $ranked = $ranked | Sort-Object LastEdit -Descending
  $ranked | Format-Table -AutoSize | Out-String | Write-Host
  $Root = $ranked[0].Root
}
Write-Host "Using: $Root"

$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`" -Root `"$Root`" -Port $Port"

if ($WhatIf) {
  Write-Host "WhatIf: would copy runner to $runner"
  Write-Host "WhatIf: would register '$taskName' at logon (+$DelaySeconds s): $psExe $taskArgs"
  return
}

New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'h00t-autostart.ps1') -Destination $runner -Force

$user = "$env:USERDOMAIN\$env:USERNAME"
try {
  $action = New-ScheduledTaskAction -Execute $psExe -Argument $taskArgs -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $trigger.Delay = 'PT{0}S' -f $DelaySeconds
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Start h00t from $Root at logon and open it in Chrome." -Force | Out-Null
  if (Test-Path -LiteralPath $startupLnk) { Remove-Item -LiteralPath $startupLnk }
  Write-Host "Installed scheduled task '$taskName' (runs $DelaySeconds s after you log in)."
  Write-Host "Test it now:  Start-ScheduledTask -TaskName '$taskName'"
} catch {
  Write-Warning "Task Scheduler refused ($($_.Exception.Message)). Using a Startup-folder shortcut instead."
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($startupLnk)
  $lnk.TargetPath = $psExe
  $lnk.Arguments = $taskArgs
  $lnk.WorkingDirectory = $Root
  $lnk.WindowStyle = 7
  $lnk.Save()
  Write-Host "Installed Startup shortcut: $startupLnk"
}
Write-Host "Logs: $stateDir\autostart.log, server.log, server.err.log"
Write-Host 'Remove later with: -Uninstall'
