<#
.SYNOPSIS
  One-shot launch for the full Opus AI companion stack:
    1) Paper Minecraft server (127.0.0.1:25565)
    2) Voice sidecar (Whisper STT + edge-tts)  http://127.0.0.1:8765
    3) Clean TLauncher GUI
    4) Opus companion bot (vision + chat + Mantella memory) in this window

  Double-click:  start-all.cmd
  Or:            .\start-all.ps1 -PlayerName Steve
#>
[CmdletBinding()]
param(
  [string]$PlayerName = 'Steve',
  [switch]$NoTLauncher,
  [switch]$NoVoice
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if (Get-Command chcp.com -ErrorAction SilentlyContinue) { & chcp.com 65001 | Out-Null }

$Root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = 'D:\maincraft' }

$LogDir = Join-Path $Root 'logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

function Test-PortOpen {
  param([string]$HostName, [int]$Port, [int]$TimeoutMs = 800)
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect($HostName, $Port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false) -and $c.Connected
    return [bool]$ok
  } catch {
    return $false
  } finally {
    try { $c.Close() } catch { }
  }
}

function Wait-Port {
  param([string]$HostName, [int]$Port, [int]$Seconds = 120, [string]$Label = 'port')
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortOpen -HostName $HostName -Port $Port -TimeoutMs 600) {
      Write-Host "OK  $Label  ${HostName}:${Port}" -ForegroundColor Green
      return $true
    }
    Start-Sleep -Seconds 2
    Write-Host "  ... waiting $Label ${HostName}:${Port}" -ForegroundColor DarkGray
  }
  Write-Host "FAIL $Label did not open in ${Seconds}s" -ForegroundColor Red
  return $false
}

function Test-HttpOk {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch {
    return $false
  }
}

Write-Host ''
Write-Host '================================================' -ForegroundColor Cyan
Write-Host '  MAINCRAFT ALL-IN-ONE' -ForegroundColor Cyan
Write-Host '  Paper + Voice + Opus companion + TLauncher' -ForegroundColor Cyan
Write-Host '================================================' -ForegroundColor Cyan
Write-Host "  Your nick (TLauncher):  $PlayerName" -ForegroundColor Yellow
Write-Host '  Bot nick:               Opus' -ForegroundColor White
Write-Host '  Server:                 127.0.0.1:25565' -ForegroundColor White
Write-Host '  Voice:                  http://127.0.0.1:8765' -ForegroundColor White
Write-Host '  Bot viewer:             http://127.0.0.1:3007' -ForegroundColor White
Write-Host '  Vision frame:           logs\vision_frame.jpg' -ForegroundColor White
Write-Host '================================================' -ForegroundColor Cyan
Write-Host ''

# ---------- 1) Paper ----------
$java = Join-Path $Root '.runtime\microsoft-jdk-21\jdk-21.0.12+8\bin\java.exe'
if (-not (Test-Path -LiteralPath $java)) {
  $found = Get-ChildItem (Join-Path $Root '.runtime') -Recurse -Filter 'java.exe' -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]bin[\\/]java\.exe$' } |
    Select-Object -First 1
  if ($found) { $java = $found.FullName }
}
if (-not (Test-Path -LiteralPath $java)) {
  throw "Java 21 not found under $Root\.runtime - run install-java.ps1 first"
}

$serverDir = Join-Path $Root 'server'
$paperJar = Join-Path $serverDir 'paper.jar'
if (-not (Test-Path -LiteralPath $paperJar)) {
  throw "paper.jar missing: $paperJar"
}

$mcUp = Test-PortOpen -HostName '127.0.0.1' -Port 25565 -TimeoutMs 500
if ($mcUp) {
  Write-Host 'Paper already listening on 25565 - reuse' -ForegroundColor Green
} else {
  Write-Host 'Starting Paper...' -ForegroundColor Yellow
  $serverOut = Join-Path $LogDir 'all-server.out.log'
  $serverErr = Join-Path $LogDir 'all-server.err.log'
  Start-Process -FilePath $java `
    -ArgumentList @('-Xms1G', '-Xmx3G', '-XX:+UseG1GC', '-jar', 'paper.jar', '--nogui') `
    -WorkingDirectory $serverDir `
    -WindowStyle Minimized `
    -RedirectStandardOutput $serverOut `
    -RedirectStandardError $serverErr `
    -PassThru | Out-Null
  if (-not (Wait-Port -HostName '127.0.0.1' -Port 25565 -Seconds 150 -Label 'Paper')) {
    Write-Host 'Server log tail:' -ForegroundColor Red
    $latest = Join-Path $serverDir 'logs\latest.log'
    if (Test-Path -LiteralPath $latest) {
      Get-Content -LiteralPath $latest -Tail 25
    }
    throw 'Paper failed to open port 25565'
  }
}

# ---------- 2) Voice ----------
if (-not $NoVoice) {
  if (Test-HttpOk -Url 'http://127.0.0.1:8765/health' -TimeoutSec 2) {
    Write-Host 'Voice already up - reuse' -ForegroundColor Green
  } else {
    $voicePy = Join-Path $Root 'voice\.venv\Scripts\python.exe'
    $voiceServer = Join-Path $Root 'voice\server.py'
    if (-not (Test-Path -LiteralPath $voicePy)) {
      Write-Host 'Voice venv missing - run voice\install.ps1 later. Continuing without voice.' -ForegroundColor Yellow
    } elseif (-not (Test-Path -LiteralPath $voiceServer)) {
      Write-Host 'voice\server.py missing - skip voice' -ForegroundColor Yellow
    } else {
      Write-Host 'Starting voice (Whisper + edge-tts)...' -ForegroundColor Yellow
      $voiceBat = Join-Path $LogDir 'start-voice-hidden.cmd'
      $lines = @(
        '@echo off'
        'set VOICE_PRELOAD=0'
        'set WHISPER_MODEL=base'
        'set TTS_ENGINE=edge'
        'set EDGE_VOICE=ru-RU-SvetlanaNeural'
        'set VOICE_HOST=127.0.0.1'
        'set VOICE_PORT=8765'
        "cd /d `"$Root\voice`""
        "`"$voicePy`" server.py"
      )
      Set-Content -LiteralPath $voiceBat -Value $lines -Encoding ASCII
      Start-Process -FilePath $voiceBat -WindowStyle Minimized
      $deadline = (Get-Date).AddSeconds(90)
      $up = $false
      while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk -Url 'http://127.0.0.1:8765/health' -TimeoutSec 2) {
          $up = $true
          break
        }
        Start-Sleep -Seconds 2
        Write-Host '  ... waiting voice :8765' -ForegroundColor DarkGray
      }
      if ($up) {
        Write-Host 'OK  Voice  http://127.0.0.1:8765' -ForegroundColor Green
      } else {
        Write-Host 'WARN Voice did not start - companion works, no TTS/STT' -ForegroundColor Yellow
      }
    }
  }
} else {
  Write-Host 'Voice skipped (-NoVoice)' -ForegroundColor DarkGray
}

# ---------- 3) TLauncher (clean) ----------
if (-not $NoTLauncher) {
  $tl = Join-Path $Root 'tools\tlauncher\start-tlauncher-clean.ps1'
  if (Test-Path -LiteralPath $tl) {
    Write-Host 'Starting clean TLauncher...' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $tl) `
      -WindowStyle Normal
  } else {
    Write-Host 'TLauncher clean script missing - skip' -ForegroundColor Yellow
  }
} else {
  Write-Host 'TLauncher skipped (-NoTLauncher)' -ForegroundColor DarkGray
}

# ---------- 4) Companion (this window) ----------
$companion = Join-Path $Root 'start-bot-companion.ps1'
if (-not (Test-Path -LiteralPath $companion)) {
  throw "Missing $companion"
}

Write-Host ''
Write-Host 'Starting Opus AI companion (vision ON) in THIS window...' -ForegroundColor Green
Write-Host "In TLauncher: nick = $PlayerName , server 127.0.0.1:25565" -ForegroundColor Yellow
Write-Host 'Close this window = stop bot only (server/voice keep running).' -ForegroundColor DarkGray
Write-Host ''

& $companion -PlayerName $PlayerName
$exit = $LASTEXITCODE
if ($exit -ne 0) {
  Write-Host "Companion exited with code $exit" -ForegroundColor Red
  if ($Host.Name -eq 'ConsoleHost') {
    Write-Host 'Press Enter to close...'
    [void][Console]::ReadLine()
  }
  exit $exit
}
