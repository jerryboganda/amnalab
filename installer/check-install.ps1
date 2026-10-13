# Prints what an Amna Lab LMS installation looks like on this PC (used by the installer end-to-end test).
param([string]$Dir = 'C:\AmnaLabLMS')

Write-Host "--- config.json bytes (a 239 187 191 start would be a BOM, which breaks Node):"
$bytes = [System.IO.File]::ReadAllBytes("$Dir\data\config.json")
($bytes[0..2] -join ' ')
Get-Content "$Dir\data\config.json" -Raw | ConvertFrom-Json | ConvertTo-Json -Compress

Write-Host "--- shortcuts"
$desk = [Environment]::GetFolderPath('DesktopDirectory')
$start = [Environment]::GetFolderPath('Startup')
$prog = [Environment]::GetFolderPath('Programs')
$sh = New-Object -ComObject WScript.Shell
foreach ($p in "$desk\Amna Lab LMS.lnk", "$start\Amna Lab LMS.lnk", "$prog\Amna Lab LMS\Amna Lab LMS.lnk", "$prog\Amna Lab LMS\Uninstall Amna Lab LMS.lnk") {
  $ok = Test-Path $p
  Write-Host ("{0,-6} {1}" -f $ok, $p)
  if ($ok) {
    $s = $sh.CreateShortcut($p)
    Write-Host ("       -> {0} {1}  [{2}]" -f $s.TargetPath, $s.Arguments, $s.WorkingDirectory)
  }
}

Write-Host "--- registry (Apps and features entry)"
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AmnaLabLMS'
if (Test-Path $k) { Get-ItemProperty $k | Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation, UninstallString | Format-List } else { Write-Host "none" }

Write-Host "--- folder"
"{0:N0} MB in {1} files" -f ((Get-ChildItem $Dir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), (Get-ChildItem $Dir -Recurse -File).Count
(Get-ChildItem $Dir | ForEach-Object { $_.Name }) -join ', '

Write-Host "--- processes from the install folder"
Get-Process | Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "{0} (pid {1}) {2}" -f $_.Name, $_.Id, $_.Path }
