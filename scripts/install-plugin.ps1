param(
    [switch]$Http,
    [int]$Port = 39881,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$PluginName = 'antigravity-admin-terminal'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$PluginTemplateDir = Join-Path $RepoRoot 'plugin'
$TargetDir = Join-Path $HOME ".gemini\config\plugins\$PluginName"

if ($Uninstall) {
    if (Test-Path $TargetDir) {
        Remove-Item -Path $TargetDir -Recurse -Force
        Write-Host "Removed plugin from $TargetDir" -ForegroundColor Yellow
    } else {
        Write-Host "Plugin is not installed at $TargetDir" -ForegroundColor DarkGray
    }
    exit 0
}

$ServerScript = (Join-Path $RepoRoot 'src\server.mjs') -replace '\\', '/'
if (-not (Test-Path $ServerScript)) {
    throw "Cannot locate server entrypoint: $ServerScript"
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
$NodeExe = if ($NodeCmd) { $NodeCmd.Source } elseif (Test-Path 'C:\Program Files\nodejs\node.exe') { 'C:\Program Files\nodejs\node.exe' } else { $null }
if (-not $NodeExe) {
    throw "Node.js (>= 20) was not found. Install Node.js first."
}

$GsudoCmd = Get-Command gsudo -ErrorAction SilentlyContinue
$GsudoExists = [bool]$GsudoCmd -or (Test-Path 'C:\Program Files\gsudo\Current\gsudo.exe')
if (-not $GsudoExists) {
    Write-Warning "gsudo.exe was not found. Install it first: winget install gerardog.gsudo"
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $TargetDir 'rules') | Out-Null

Copy-Item -Path (Join-Path $PluginTemplateDir 'plugin.json') -Destination (Join-Path $TargetDir 'plugin.json') -Force
Copy-Item -Path (Join-Path $PluginTemplateDir 'rules\AGENTS.md') -Destination (Join-Path $TargetDir 'rules\AGENTS.md') -Force

$mcpConfig = if ($Http) {
    @{
        mcpServers = @{
            admin = @{
                url = "http://127.0.0.1:$Port/mcp"
            }
        }
    }
} else {
    @{
        mcpServers = @{
            admin = @{
                command = $NodeExe
                args    = @($ServerScript)
            }
        }
    }
}

$mcpJson = $mcpConfig | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText(
    (Join-Path $TargetDir 'mcp_config.json'),
    $mcpJson + "`n",
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Installed Antigravity plugin to: $TargetDir" -ForegroundColor Green
if ($Http) {
    Write-Host "Transport: Streamable HTTP (http://127.0.0.1:$Port/mcp)" -ForegroundColor Cyan
    Write-Host "Run scripts\start-http-bridge.ps1 in an external terminal before using admin tools." -ForegroundColor Yellow
} else {
    Write-Host "Transport: Stdio ($NodeExe -> $ServerScript)" -ForegroundColor Cyan
}
Write-Host "Next: Refresh MCP Servers in Antigravity (or open a new conversation) to activate." -ForegroundColor Cyan
