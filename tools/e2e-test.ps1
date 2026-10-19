# Test end-to-end: build di sviluppo + pagina finta di WhatsApp + server finto,
# il tutto in Firefox headless. Non tocca l'account WhatsApp reale.
#
# Uso: powershell -ExecutionPolicy Bypass -File tools/e2e-test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host '[e2e] build di sviluppo...'
node tools/dev-build.mjs | Out-Null

$mockLog = Join-Path $env:TEMP 'wa-tt-mock.log'
$webextLog = Join-Path $env:TEMP 'wa-tt-webext.log'

Write-Host '[e2e] server finto...'
$server = $null
$alreadyRunning = $false
try {
  Invoke-WebRequest -Uri 'http://localhost:8787/health' -TimeoutSec 3 -UseBasicParsing | Out-Null
  $alreadyRunning = $true
} catch {}
if (-not $alreadyRunning) {
  $server = Start-Process -FilePath 'node' -ArgumentList 'test/mock-server.mjs' -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $mockLog -RedirectStandardError (Join-Path $env:TEMP 'wa-tt-mock.err')
  Start-Sleep -Seconds 1
}
try { Invoke-WebRequest -Uri 'http://localhost:8787/result' -Method Post -Body '' -TimeoutSec 5 -UseBasicParsing | Out-Null } catch {}

Write-Host '[e2e] avvio Firefox headless con l''estensione...'
$webext = Start-Process -FilePath 'npx.cmd' -PassThru -WindowStyle Hidden `
  -ArgumentList @('--yes', 'web-ext', 'run', '--source-dir', 'build/dev', '--no-reload',
    '--start-url', 'http://localhost:8787/test/mock-whatsapp.html', '--args=--headless') `
  -RedirectStandardOutput $webextLog -RedirectStandardError (Join-Path $env:TEMP 'wa-tt-webext.err')

$result = $null
$last = ''
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 2
  try {
    $response = Invoke-WebRequest -Uri 'http://localhost:8787/result' -TimeoutSec 5 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
      $content = $response.Content.Trim()
      if ($content) {
        $last = $content
        if ($content -like 'TEST RIUSCITO*' -or $content -like 'FAIL*') {
          $result = $content
          break
        }
      }
    }
  } catch {}
}

Write-Host '[e2e] chiusura processi...'
Stop-Process -Id $webext.Id -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='firefox.exe'" |
  Where-Object { $_.CommandLine -like '*--headless*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }

if ($result) {
  Write-Host ''
  Write-Host ("RISULTATO: " + $result)
  if ($result -like 'TEST RIUSCITO*') { exit 0 } else { exit 1 }
}

Write-Host ''
Write-Host '[e2e] nessun risultato finale'
if ($last) { Write-Host ("[e2e] ultimo avanzamento: " + $last) }
Write-Host '[e2e] log web-ext'
Get-Content $webextLog -Tail 40 -ErrorAction SilentlyContinue
Write-Host '[e2e] log server finto'
Get-Content $mockLog -Tail 20 -ErrorAction SilentlyContinue
exit 1
