# End-to-end test of an installed Amna Lab LMS: backup, crash recovery, upgrade, port conflict, startup mode,
# uninstall (keeping data) and full removal.  Run AFTER a first install made by the Setup exe, with the smoke
# data in place (SMOKE_URL=http://127.0.0.1:8080 node scripts/smoke.mjs).
#   powershell -ExecutionPolicy Bypass -File installer\test-installer.ps1 -Setup <path-to-Setup.exe>
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [string]$Dir = 'C:\AmnaLabLMS',
  [string]$Url = 'http://127.0.0.1:8080'
)
$ErrorActionPreference = 'Stop'
$script:failed = 0
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { Write-Host "PASS  $name" -ForegroundColor Green }
  else { Write-Host "FAIL  $name   $detail" -ForegroundColor Red; $script:failed++ }
}
function Up([int]$seconds = 45) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    try { if ((Invoke-RestMethod "$Url/api/health" -TimeoutSec 2).status -eq 'ok') { return $true } } catch { }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function Down([int]$seconds = 15) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    try { Invoke-RestMethod "$Url/api/health" -TimeoutSec 1 | Out-Null } catch { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
function RuntimeNode { Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$Dir\runtime\node.exe" } }
function Launcher { Get-Process AmnaLabLMS -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$Dir\AmnaLabLMS.exe" } }
function Session {
  $s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $h = @{ 'X-Requested-With' = 'lms' }
  Invoke-RestMethod "$Url/api/auth/login" -Method Post -Headers $h -WebSession $s -ContentType 'application/json' `
    -Body (@{ username = 'admin'; password = 'Admin-Pass-2026' } | ConvertTo-Json) | Out-Null
  return $s
}
function Api([string]$method, [string]$path, $session, $body = $null) {
  $args = @{ Uri = "$Url$path"; Method = $method; Headers = @{ 'X-Requested-With' = 'lms' }; WebSession = $session }
  if ($body) { $args.Body = ($body | ConvertTo-Json -Depth 6); $args.ContentType = 'application/json' }
  Invoke-RestMethod @args
}
# Runs the setup exe and waits for the setup process only (Start-Process -Wait would also wait for the launcher it starts).
function RunSetup([string[]]$arguments, [int]$timeoutSec = 180) {
  $psi = New-Object Diagnostics.ProcessStartInfo $Setup
  $psi.Arguments = ($arguments -join ' ')
  $psi.UseShellExecute = $false
  $p = [Diagnostics.Process]::Start($psi)
  if (-not $p.WaitForExit($timeoutSec * 1000)) { $p.Kill(); return -999 }
  return $p.ExitCode
}

Write-Host "=== 1. state before: installed copy is serving the smoke data"
Check 'server healthy' (Up 5)
$s = Session
$before = (Api 'GET' '/api/patients' $s).Count
Check "patients present ($before)" ($before -ge 1)
$cfgHash = (Get-FileHash "$Dir\data\config.json").Hash
$dbHash0 = (Get-Item "$Dir\data\lms.db").Length

Write-Host "=== 2. backup works with no manual setup (installer generated the password)"
$h = Api 'GET' '/api/ops/health' $s
Check 'backup configured' ($h.backup.configured -eq $true)
Check 'database check ok' ($h.dbCheck -eq 'ok')
$b = Api 'POST' '/api/ops/backup' $s
Check 'backup created' ($b.size -gt 1000 -and (Test-Path $b.file))
Check 'backup stored under the install folder' ($b.file.StartsWith("$Dir\backups", [StringComparison]::OrdinalIgnoreCase)) $b.file

Write-Host "=== 3. crash recovery: kill the server, the launcher brings it back"
$pid1 = (RuntimeNode | Select-Object -First 1).Id
Stop-Process -Id $pid1 -Force
Check 'server went down' (Down 10)
Check 'server came back by itself' (Up 40)
$pid2 = (RuntimeNode | Select-Object -First 1).Id
Check "new server process ($pid1 -> $pid2)" ($pid2 -and $pid2 -ne $pid1)
$s = Session
Check 'data intact after crash' ((Api 'GET' '/api/patients' $s).Count -eq $before)
Check 'previous log kept' (Test-Path "$Dir\data\server.prev.log")

Write-Host "=== 3b. one-click restore from inside the program"
$s = Session
$bk = Api 'POST' '/api/ops/backup' $s
$branch = (Api 'GET' '/api/branches' $s)[0].id
$extra = Api 'POST' '/api/patients' $s @{ branchId = $branch; fullName = 'Added After Backup'; gender = 'M'; dob = '1990-01-01'; phone = '0301 5550001'; consent = @{ whatsapp = $false; email = $false; sms = $false } }
Check 'patient added after the backup' ((Api 'GET' '/api/patients' $s).Count -eq $before + 1)
$dl = Join-Path $env:TEMP 'lms-download.lmsbak'
Invoke-WebRequest "$Url/api/ops/backups/$($bk.id)/download" -WebSession $s -OutFile $dl
Check 'backup can be downloaded' ((Get-Item $dl).Length -eq (Get-Item $bk.file).Length)
Remove-Item $dl -Force
$backupsBefore = @(Get-ChildItem "$Dir\backups\*.lmsbak").Count
$r = Api 'POST' '/api/ops/restore' $s @{ backupId = $bk.id }
Check 'restore accepted' ($r.ok -eq $true)
Check 'server restarted for the restore' (Down 15)
Check 'server back up by itself' (Up 60)
$s = Session
Check 'data is back to the backup (extra patient gone)' ((Api 'GET' '/api/patients' $s).Count -eq $before)
Check 'safety backup of the data before restoring' (@(Get-ChildItem "$Dir\backups\*.lmsbak").Count -gt $backupsBefore)
Check 'old database kept' (@(Get-ChildItem "$Dir\backups" -Filter 'pre-restore-*.db').Count -ge 1)
$bad = $false
try { Api 'POST' '/api/ops/restore' $s @{ fileBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('not a backup')) } | Out-Null } catch { $bad = $true }
Check 'a damaged file is refused and nothing changes' ($bad -and (Api 'GET' '/api/patients' $s).Count -eq $before)

Write-Host "=== 4. second launch does not start a second server"
$n = @(RuntimeNode).Count
Start-Process "$Dir\AmnaLabLMS.exe" -ArgumentList '/background'
Start-Sleep -Seconds 4
Check 'still exactly one server' (@(RuntimeNode).Count -eq $n -and $n -eq 1)
Check 'still exactly one launcher' (@(Launcher).Count -eq 1)

Write-Host "=== 5. update over the existing install keeps data, settings and backups"
$code = RunSetup @('/S')
Check "setup exit code 0 ($code)" ($code -eq 0)
Check 'server up after update' (Up 60)
$s = Session
Check 'patients kept' ((Api 'GET' '/api/patients' $s).Count -eq $before)
Check 'config.json untouched (same backup password)' ((Get-FileHash "$Dir\data\config.json").Hash -eq $cfgHash)
Check 'earlier backup kept' (@(Get-ChildItem "$Dir\backups\*.lmsbak").Count -ge 1)
Check 'pre-update database copy made' (@(Get-ChildItem "$Dir\backups" -Directory -Filter 'pre-update-*').Count -ge 1)
Check 'one launcher and one server' (@(Launcher).Count -eq 1 -and @(RuntimeNode).Count -eq 1)

Write-Host "=== 6. backup file really restores into a clean folder (restore tool from the install)"
$bk = Get-ChildItem "$Dir\backups\*.lmsbak" | Sort-Object LastWriteTime | Select-Object -Last 1
$rr = Join-Path $env:TEMP 'lms-installer-restore'
Remove-Item $rr -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$rr\data" | Out-Null
Copy-Item "$Dir\data\config.json" "$rr\data\config.json"
$env:LMS_ROOT = $rr
$restoreOut = & "$Dir\runtime\node.exe" "$Dir\dist\server\restore.js" $bk.FullName 2>&1
Remove-Item Env:\LMS_ROOT
Check 'restore tool ran' ($restoreOut -match 'Restored') ($restoreOut -join ' ')
Check 'restored database present' (Test-Path "$rr\data\lms.db")
Remove-Item $rr -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "=== 7. port already used by another program: clear message, nothing broken"
# Stop the LMS, occupy the port with a plain listener, start the launcher and read its log.
Get-Process AmnaLabLMS -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$Dir\AmnaLabLMS.exe" } | Stop-Process -Force
RuntimeNode | Stop-Process -Force
Check 'LMS stopped' (Down 10)
$listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Parse('127.0.0.1')), 8080
$listener.Start()
$lp = Start-Process "$Dir\AmnaLabLMS.exe" -ArgumentList '/background' -PassThru
Start-Sleep -Seconds 8
$log = Get-Content "$Dir\data\server.log" -Raw
Check 'log explains the busy port' ($log -match 'already in use') $log
Get-Process AmnaLabLMS -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq "$Dir\AmnaLabLMS.exe" } | Stop-Process -Force
Get-Process -Name 'msg' -ErrorAction SilentlyContinue | Out-Null
$listener.Stop()
RuntimeNode | Stop-Process -Force -ErrorAction SilentlyContinue

Write-Host "=== 8. start-with-Windows shortcut starts it quietly (no browser)"
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Amna Lab LMS.lnk'
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($startup)
Start-Process $lnk.TargetPath -ArgumentList $lnk.Arguments -WorkingDirectory $lnk.WorkingDirectory
Check 'server up from the startup shortcut' (Up 45)
$s = Session
Check 'data still there' ((Api 'GET' '/api/patients' $s).Count -eq $before)

Write-Host "=== 9. uninstall keeps the lab data"
$code = RunSetup @('/uninstall', '/S')
Start-Sleep -Seconds 8
Check "uninstall exit code 0 ($code)" ($code -eq 0)
Check 'server stopped' (Down 20)
Check 'program files removed' (-not (Test-Path "$Dir\runtime") -and -not (Test-Path "$Dir\dist") -and -not (Test-Path "$Dir\AmnaLabLMS.exe"))
Check 'data kept' (Test-Path "$Dir\data\lms.db")
Check 'backups kept' (@(Get-ChildItem "$Dir\backups\*.lmsbak").Count -ge 1)
Check 'desktop shortcut removed' (-not (Test-Path (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Amna Lab LMS.lnk')))
Check 'startup shortcut removed' (-not (Test-Path $startup))
Check 'registry entry removed' (-not (Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AmnaLabLMS'))

Write-Host "=== 10. reinstall finds the kept data and starts with it"
$code = RunSetup @('/S')
Check "setup exit code 0 ($code)" ($code -eq 0)
Check 'server up' (Up 60)
$s = Session
Check 'patients are back' ((Api 'GET' '/api/patients' $s).Count -eq $before)

Write-Host "=== 11. uninstall with /purge removes everything"
$code = RunSetup @('/uninstall', '/S', '/purge')
Start-Sleep -Seconds 8
Check "uninstall exit code 0 ($code)" ($code -eq 0)
Check 'server stopped' (Down 20)
Check 'install folder gone' (-not (Test-Path $Dir))
Check 'no leftover processes' (@(RuntimeNode).Count -eq 0 -and @(Launcher).Count -eq 0)

Write-Host ""
if ($script:failed -eq 0) { Write-Host "ALL CHECKS PASSED" -ForegroundColor Green; exit 0 }
Write-Host "$($script:failed) CHECK(S) FAILED" -ForegroundColor Red
exit 1
