<#
.SYNOPSIS
  AI-спутник Minecraft (как «нейро-Скайрим» / Mantella):
  чат, память, hybrid brain (Opus), dig/craft/goto, combat-reflex.

  Твой ник в TLauncher = -PlayerName (по умолчанию Steve).
  Ник бота = Opus.

  Запуск: двойной клик start-bot-companion.cmd
          или: .\start-bot-companion.ps1 -PlayerName Steve
#>
[CmdletBinding()]
param(
  [string]$PlayerName = 'Steve',
  [string]$HostName = '127.0.0.1',
  [int]$Port = 25565,
  [switch]$WithVoice   # check voice server on 8765
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
  $root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($root)) {
  $root = 'D:\maincraft'
}

$agentDir = Join-Path $root 'agent'
$configPath = Join-Path $agentDir 'config.companion.json'
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
  throw "Missing companion config: $configPath"
}

if ($PlayerName -notmatch '^[A-Za-z0-9_]{1,16}$') {
  throw "PlayerName must be Minecraft nick: 1-16 Latin letters/digits/_ (got: $PlayerName)"
}

# Always sync nick + host into config (so Steve default also written)
try {
  $json = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $json.agent.controllerUsers = @($PlayerName)
  $json.agent.chatUsers = @($PlayerName)
  $json.agent.allowPlayerChat = $true
  $json.agent.companionMode = $true
  $json.agent.mode = 'hybrid'
  $json.minecraft.host = $HostName
  $json.minecraft.port = $Port
  if (-not $json.mantella) {
    $json | Add-Member -NotePropertyName mantella -NotePropertyValue ([pscustomobject]@{})
  }
  $json.mantella.enabled = $true
  # Mantella pc_to_npc: LLM only when player speaks (no tick monologue)
  try { $json.mantella.turnBased = $true } catch { $json.mantella | Add-Member turnBased $true -Force }
  $json.agent.idleWhenNoGoal = $true
  # UTF8 *without* BOM — BOM breaks JSON.parse in Node unless stripped
  $jsonText = $json | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($configPath, $jsonText, $utf8NoBom)
} catch {
  throw "Failed to update config.companion.json: $($_.Exception.Message)"
}

$node = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $node) {
  throw 'Node.js not found. Install Node.js 22+.'
}

# Optional: voice health
if ($WithVoice) {
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 3
    if ($h.ok) {
      Write-Host 'Voice server: OK (Whisper/edge-tts)' -ForegroundColor Green
    } else {
      Write-Host 'Voice server responded but not ok — TTS/STT may fail' -ForegroundColor Yellow
    }
  } catch {
    Write-Host 'Voice server OFF — start D:\maincraft\voice\start-voice.ps1 for speech' -ForegroundColor Yellow
  }
}

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host '  OPUS AI COMPANION (Minecraft Mantella)' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host "  Bot nick:     Opus" -ForegroundColor White
Write-Host "  Your nick:    $PlayerName  (TLauncher must match!)" -ForegroundColor Yellow
Write-Host "  Server:       ${HostName}:${Port}" -ForegroundColor White
Write-Host "  Viewer:       http://127.0.0.1:3007" -ForegroundColor White
Write-Host "  Vision:       ON (viewer POV -> logs\vision_frame.jpg every 2 ticks)" -ForegroundColor Green
Write-Host "  Chat:         just type in game chat" -ForegroundColor White
Write-Host "  Commands:     !follow  !come  !goal ...  !listen  !summary  !vision on/off" -ForegroundColor White
Write-Host '========================================' -ForegroundColor Cyan
Write-Host 'Need Paper running first (start-server.ps1)' -ForegroundColor Yellow
Write-Host 'Smoke vision:  cd agent; node src/vision-smoke.js --config=config.companion.json' -ForegroundColor DarkGray
Write-Host ''

Push-Location $agentDir
try {
  if (-not (Test-Path -LiteralPath (Join-Path $agentDir 'node_modules'))) {
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($npm) {
      Write-Host 'Installing deps (npm ci)...' -ForegroundColor Yellow
      & $npm.Source 'ci'
      if ($LASTEXITCODE -ne 0) { throw "npm ci failed: $LASTEXITCODE" }
    }
  }

  Write-Host 'Starting Opus companion...' -ForegroundColor Green
  & $node.Source '--max-old-space-size=4096' 'src/index.js' "--config=$configPath"
  $code = $LASTEXITCODE
  if ($code -ne 0) {
    Write-Host "Bot exited with code $code" -ForegroundColor Red
    Write-Host 'Is Paper up? Is API key on Desktop (opus4.8api.txt)?' -ForegroundColor Yellow
    exit $code
  }
} finally {
  Pop-Location
}
