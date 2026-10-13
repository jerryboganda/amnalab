# Drives the real uninstall windows with UI Automation: opens Uninstall.exe, presses Remove, waits for the finish message and presses OK.
param(
  [string]$Dir = 'C:\AmnaLabLMS',
  [string]$Shots = ''
)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing

function Shoot([string]$name) {
  if (-not $Shots) { return }
  New-Item -ItemType Directory -Force $Shots | Out-Null
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $Shots "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
function FindWindow([string]$title, [int]$seconds) {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), $title
  for ($i = 0; $i -lt $seconds * 4; $i++) {
    $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) { return $w }
    Start-Sleep -Milliseconds 250
  }
  return $null
}
function Press($window, [string]$button) {
  $cond = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::NameProperty), $button
  $b = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if (-not $b) { return $false }
  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  return $true
}

$p = [Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo "$Dir\Uninstall.exe", '/uninstall'))
$confirm = FindWindow 'Remove Amna Lab LMS' 15
if (-not $confirm) { Write-Host 'FAIL  confirmation window did not appear'; exit 1 }
Write-Host 'PASS  confirmation window appeared'
Start-Sleep -Milliseconds 500
Shoot 'confirm'
if (-not (Press $confirm 'Remove')) { Write-Host 'FAIL  Remove button not found'; exit 1 }
$done = FindWindow 'Amna Lab LMS' 40
if (-not $done) { Write-Host 'FAIL  finish message did not appear'; exit 1 }
Write-Host 'PASS  finish message appeared'
Start-Sleep -Milliseconds 500
Shoot 'finished'
Press $done 'OK' | Out-Null
Start-Sleep -Seconds 4
$gone = -not (Test-Path "$Dir\runtime") -and -not (Test-Path "$Dir\AmnaLabLMS.exe")
Write-Host ("{0}  program files removed" -f $(if ($gone) { 'PASS' } else { 'FAIL' }))
Write-Host ("{0}  lab data kept" -f $(if (Test-Path "$Dir\data\lms.db") { 'PASS' } else { 'FAIL' }))
