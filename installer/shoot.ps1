# Starts a program and saves a screenshot of the screen every couple of seconds (used to eyeball the installer windows).
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [string]$Arguments = '',
  [Parameter(Mandatory = $true)][string]$OutDir,
  [int]$Shots = 8,
  [int]$EverySeconds = 3
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
New-Item -ItemType Directory -Force $OutDir | Out-Null
$psi = New-Object Diagnostics.ProcessStartInfo $Exe
$psi.Arguments = $Arguments
$psi.UseShellExecute = $false
$p = [Diagnostics.Process]::Start($psi)
for ($i = 1; $i -le $Shots; $i++) {
  Start-Sleep -Seconds $EverySeconds
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $OutDir ("shot{0:D2}.png" -f $i)), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  if ($p.HasExited) { Write-Host "process exited after shot $i with code $($p.ExitCode)"; break }
}
if (-not $p.HasExited) { Write-Host "still running after $Shots shots" } else { Write-Host "exit code $($p.ExitCode)" }
