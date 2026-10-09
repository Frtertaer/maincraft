[CmdletBinding()]
param(
  # off | jev | laya | local — fast per-tick controller driving bounded verbs
  # while Opus plans asynchronously every controller.plannerEveryTicks ticks.
  [ValidateSet('jev', 'laya', 'local')]
  [string]$Controller = 'jev',
  [int]$TickMs = 1500
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
$agentDir = Join-Path $root 'agent'
$configPath = Join-Path $agentDir 'config.controller.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "config.controller.json is missing: $configPath"
}

# Load agent/.env into the process env (KEY=VALUE lines). Real env wins.
$envFile = Join-Path $agentDir '.env'
if (Test-Path -LiteralPath $envFile -PathType Leaf) {
  foreach ($line in Get-Content -LiteralPath $envFile) {
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $name = $Matches[1]
      $value = $Matches[2].Trim().Trim('"').Trim("'")
      if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($name, 'Process'))) {
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
      }
    }
  }
}

if ($Controller -eq 'jev' -and -not $env:TYPESAFE_API_KEY) {
  Write-Warning 'TYPESAFE_API_KEY is not set; the agent will fall back to the local controller.'
}
if ($Controller -eq 'laya') {
  $layaHealth = 'http://127.0.0.1:8091/health'
  try {
    $null = Invoke-RestMethod -Uri $layaHealth -TimeoutSec 3
    Write-Host 'Laya sidecar is up.' -ForegroundColor Green
  } catch {
    Write-Warning "Laya sidecar not reachable at $layaHealth. Start it first: python agent/tools/laya_server.py (after: pip install laya). Falling back to local controller."
  }
}

# Inject chosen controller type + tick into a temp copy of the config so the
# checked-in example stays a template.
$cfg = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$cfg.controller.type = $Controller
$cfg.agent.tickMs = $TickMs
$tmpConfig = Join-Path $env:TEMP "maincraft-config-controller-$Controller.json"
$cfg | ConvertTo-Json -Depth 32 | Set-Content -LiteralPath $tmpConfig -Encoding utf8

$env:MAINCRAFT_CONFIG = $tmpConfig
Write-Host "Controller=$Controller tickMs=$TickMs config=$tmpConfig" -ForegroundColor Cyan

& (Join-Path $root 'start-bot.ps1')
