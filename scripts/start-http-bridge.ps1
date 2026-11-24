param(
    [int]$Port = 39881
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ServerScript = Join-Path $Root 'src\server.mjs'
$NodeExe = 'C:\Program Files\nodejs\node.exe'

if (-not (Test-Path $NodeExe)) {
    $NodeExe = (Get-Command node -ErrorAction Stop).Source
}

Write-Host "Starting Antigravity Admin Terminal HTTP bridge on http://127.0.0.1:$Port/mcp ..." -ForegroundColor Cyan
Write-Host "Keep this window open when using Streamable HTTP mode. Press Ctrl+C to stop." -ForegroundColor Yellow

& $NodeExe $ServerScript --http --port $Port
