# Amna Lab LMS launcher for Windows.
# Starts the local server hidden, opens the app in the browser, and keeps a tray icon with Open / Stop.
# Double-click the desktop shortcut made by install-shortcut.ps1, or run this file directly.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 8080
$url = "http://127.0.0.1:$port"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Test-Up {
  try {
    Invoke-WebRequest -UseBasicParsing -Uri "$url/api/health" -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  [System.Windows.Forms.MessageBox]::Show('Node.js is not installed. Install Node.js 22 or newer, then try again.', 'Amna Lab LMS') | Out-Null
  exit 1
}

if (-not (Test-Path (Join-Path $root 'dist\server\index.js'))) {
  [System.Windows.Forms.MessageBox]::Show("The app is not built yet. Run 'npm install' and 'npm run build' in:`n$root", 'Amna Lab LMS') | Out-Null
  exit 1
}

$script:proc = $null
$script:stopping = $false
$dataDir = Join-Path $root 'data'

function Start-Server {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  # Keep the previous run's log so a crash can be diagnosed after the automatic restart.
  foreach ($n in 'server.log', 'server.err.log') {
    $p = Join-Path $dataDir $n
    if (Test-Path $p) { Move-Item -Force $p ($p -replace '.log$', '.prev.log') }
  }
  $script:proc = Start-Process -FilePath $node -ArgumentList 'dist/server/index.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server.err.log')
}

if (-not (Test-Up)) {
  Start-Server
  for ($i = 0; $i -lt 40 -and -not (Test-Up); $i++) { Start-Sleep -Milliseconds 250 }
}

Start-Process $url

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Text = 'Amna Lab LMS'
$icon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('Open LMS')
$openItem.add_Click({ Start-Process $url })
$stopItem = $menu.Items.Add('Stop LMS and exit')
$stopItem.add_Click({
  $script:stopping = $true
  if ($script:proc -and -not $script:proc.HasExited) {
    Stop-Process -Id $script:proc.Id -Force
  } else {
    # The server was started by an earlier launcher: stop it by its command line.
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object { $_.CommandLine -like '*dist*server*index.js*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  }
  $icon.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process $url })

# Watchdog: if the server process dies (crash, killed by antivirus), bring it back within 15 seconds.
$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 15000
$watch.add_Tick({
  if (-not $script:stopping -and $script:proc -and $script:proc.HasExited) { Start-Server }
})
$watch.Start()

[System.Windows.Forms.Application]::Run()
