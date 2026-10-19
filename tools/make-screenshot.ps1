# Genera images/screenshot.png: build di sviluppo + pagina finta, Firefox
# visibile con l'estensione al lavoro, cattura della finestra.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

node tools/dev-build.mjs | Out-Null

$server = $null
$webext = $null
$out = Join-Path $root 'images\screenshot.png'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $out) | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Shot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
[Win32Shot]::SetProcessDPIAware() | Out-Null

try {
  $serverRunning = $false
  try {
    Invoke-WebRequest -Uri 'http://localhost:8787/health' -TimeoutSec 2 -UseBasicParsing | Out-Null
    $serverRunning = $true
  } catch {}
  if (-not $serverRunning) {
    $server = Start-Process -FilePath 'node' -ArgumentList 'test/mock-server.mjs' -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $root 'build\shot-server.log') `
      -RedirectStandardError (Join-Path $root 'build\shot-server.err')
    Start-Sleep -Seconds 1
  }
  try { Invoke-WebRequest -Uri 'http://localhost:8787/result' -Method Post -Body '' -TimeoutSec 5 -UseBasicParsing | Out-Null } catch {}

  $webext = Start-Process -FilePath 'npx.cmd' -PassThru -WindowStyle Hidden `
    -ArgumentList @('--yes', 'web-ext', 'run', '--source-dir', 'build/dev',
      '--start-url', 'http://localhost:8787/demo') `
    -RedirectStandardOutput (Join-Path $root 'build\shot-webext.log') `
    -RedirectStandardError (Join-Path $root 'build\shot-webext.err')

  Write-Host 'Attendo che la demo finisca le trascrizioni...'
  $ready = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 1
    try {
      $res = Invoke-WebRequest -Uri 'http://localhost:8787/result' -TimeoutSec 2 -UseBasicParsing
      if ($res.Content -match 'SCREENSHOT PRONTO') { $ready = $true; break }
    } catch {}
  }
  if (-not $ready) { throw 'La demo non ha segnalato il completamento.' }

  $procInfo = Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" |
    Where-Object { $_.CommandLine -like '*-start-debugger-server*' } |
    Select-Object -First 1
  if (-not $procInfo) { throw 'Finestra Firefox non trovata.' }

  $ff = Get-Process -Id $procInfo.ProcessId
  for ($i = 0; $i -lt 30 -and $ff.MainWindowHandle -eq 0; $i++) {
    Start-Sleep -Milliseconds 300
    $ff.Refresh()
  }
  if ($ff.MainWindowHandle -eq 0) { throw 'La finestra Firefox non ha un handle.' }

  $hwnd = $ff.MainWindowHandle
  [Win32Shot]::ShowWindow($hwnd, 9) | Out-Null
  [Win32Shot]::MoveWindow($hwnd, 60, 40, 1180, 840, $true) | Out-Null
  [Win32Shot]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 1200

  $rect = New-Object Win32Shot+RECT
  [Win32Shot]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $w = $rect.Right - $rect.Left
  $h = $rect.Bottom - $rect.Top
  if ($w -le 0 -or $h -le 0) { throw 'Dimensioni finestra non valide.' }

  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  $printed = [Win32Shot]::PrintWindow($hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc)
  $g.Dispose()

  $black = $true
  foreach ($pt in @(@(20, 20), @([int]($w / 2), [int]($h / 2)), @(($w - 20), ($h - 20)))) {
    $c = $bmp.GetPixel($pt[0], $pt[1])
    if (($c.R + $c.G + $c.B) -gt 30) { $black = $false; break }
  }
  if (-not $printed -or $black) {
    Write-Host 'PrintWindow non ha funzionato, uso la cattura dello schermo.'
    $bmp.Dispose()
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
  }

  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Screenshot salvato in $out ($w x $h)."
}
finally {
  if ($webext) { Stop-Process -Id $webext.Id -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*web-ext*' -and $_.CommandLine -like '*build/dev*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" |
    Where-Object { $_.CommandLine -like '*-start-debugger-server*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
}
