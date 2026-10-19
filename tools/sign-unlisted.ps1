# Firma "non in elenco" (unlisted) su addons.mozilla.org: produce un .xpi
# firmato che si installa in modo permanente nel Firefox normale, senza
# comparire nel negozio.
#
# Prerequisiti:
#   1. Account su https://addons.mozilla.org (gratuito) con verifica in due passaggi.
#   2. Chiave API (JWT issuer + JWT secret) da:
#      https://addons.mozilla.org/developers/addon/api/key/
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File tools/sign-unlisted.ps1
#
# Le credenziali vengono chieste in input e passate a web-ext tramite variabili
# d'ambiente, così non finiscono nella cronologia dei comandi.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$env:WEB_EXT_API_KEY = Read-Host 'Chiave API AMO (JWT issuer)'
$secure = Read-Host 'Segreto API AMO (JWT secret)' -AsSecureString
$env:WEB_EXT_API_SECRET = [System.Net.NetworkCredential]::new('', $secure).Password

if (-not $env:WEB_EXT_API_KEY -or -not $env:WEB_EXT_API_SECRET) {
  Write-Host 'Chiave o segreto mancanti: firma annullata.'
  exit 1
}

Write-Host 'Firma in corso su addons.mozilla.org...'
New-Item -ItemType Directory -Force -Path 'web-ext-artifacts' | Out-Null
$log = Join-Path 'web-ext-artifacts' 'sign.log'
$errLog = Join-Path 'web-ext-artifacts' 'sign.err.log'

# Start-Process evita che PowerShell interpreti i messaggi di npm su stderr
# come errori che interrompono lo script.
$proc = Start-Process -FilePath 'npx.cmd' -NoNewWindow -Wait -PassThru `
  -RedirectStandardOutput $log -RedirectStandardError $errLog `
  -ArgumentList @(
    '--yes', 'web-ext', 'sign', '--channel=unlisted', '--source-dir', '.',
    '--ignore-files', 'build/**', 'test/**', 'tools/**', 'web-ext-artifacts/**'
  )

if ($proc.ExitCode -ne 0) {
  Write-Host ''
  Write-Host ('Firma non riuscita (codice ' + $proc.ExitCode + '). Ultime righe:')
  Get-Content $log -Tail 20 -ErrorAction SilentlyContinue
  Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
  exit $proc.ExitCode
}

Write-Host ''
Write-Host 'Fatto: il file .xpi firmato è in web-ext-artifacts/:'
Get-ChildItem 'web-ext-artifacts\*.xpi' | Select-Object -ExpandProperty Name
Write-Host 'Installalo da about:addons -> ingranaggio -> "Installa componente da file...".'
