<#
.SYNOPSIS
  One-click BERSERK bot — combat-reflex kills all living mobs nearby.
  Same style as start-tlauncher-clean: double-click / simple path.

  Nick of bot: Berserk
  Your nick (commands): Steve by default, or -PlayerName
#>
[CmdletBinding()]
param(
  [string]$PlayerName = 'Steve',
  [string]$HostName = '127.0.0.1',
  [int]$Port = 25565
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if (Get-Command -Name 'chcp.com' -CommandType Application -ErrorAction SilentlyContinue) {
  & chcp.com 65001 | Out-Null
}

$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) {
  $root = 'D:\maincraft'
}
$agentDir = Join-Path $root 'agent'
$configPath = Join-Path $agentDir 'config.berserk.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing config: $configPath"
}

if ($PlayerName -and $PlayerName -match '^[A-Za-z0-9_]{1,16}$') {
  $raw = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8
  $json = $raw | ConvertFrom-Json
  $json.agent.controllerUsers = @($PlayerName)
  if (-not $json.agent.PSObject.Properties['chatUsers']) {
    $json.agent | Add-Member -NotePropertyName chatUsers -NotePropertyValue @($PlayerName)
  } else {
    $json.agent.chatUsers = @($PlayerName)
  }
  $json.minecraft.host = $HostName
  $json.minecraft.port = $Port
  $json | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $configPath -Encoding UTF8
  Write-Host "Controller / chat nick: $PlayerName" -ForegroundColor Green
} else {
  Write-Host "Using existing controllerUsers in config.berserk.json" -ForegroundColor Yellow
}

$node = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $node) {
  throw 'Node.js not found. Install Node 22+.'
}

Write-Host ''
Write-Host '=== BERSERK BOT ===' -ForegroundColor Red
Write-Host 'Attacks: hostiles + animals + villagers + golems (not players).' -ForegroundColor Yellow
Write-Host "Bot nick: Berserk | Server: ${HostName}:${Port}" -ForegroundColor Cyan
Write-Host 'Viewer: http://127.0.0.1:3008' -ForegroundColor Cyan
Write-Host 'Need: Paper running (start-server.ps1)' -ForegroundColor Yellow
Write-Host ''

Push-Location $agentDir
try {
  if (-not (Test-Path -LiteralPath (Join-Path $agentDir 'node_modules'))) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npm) {
      Write-Host 'npm ci...' -ForegroundColor Yellow
      & $npm.Source 'ci'
    }
  }
  & $node.Source '--max-old-space-size=4096' 'src/index.js' "--config=$configPath"
  if ($LASTEXITCODE -ne 0) {
    throw "Bot exited with code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
