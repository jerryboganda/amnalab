# Creates a desktop shortcut that starts the Amna Lab LMS launcher (no console window).
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'Amna Lab LMS.lnk'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = (Get-Command powershell.exe).Source
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$root\scripts\launch-lms.ps1`""
$lnk.WorkingDirectory = $root
$lnk.Description = 'Start Amna Lab LMS'
$lnk.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$lnk.Save()
Write-Host "Desktop shortcut created: $lnkPath"
