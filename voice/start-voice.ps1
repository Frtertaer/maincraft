[CmdletBinding()]
param(
  [ValidateSet('tiny','base','small','medium','large-v3')]
  [string]$WhisperModel = 'small',

  [ValidateSet('edge','silero','sapi')]
  [string]$Tts = 'edge',

  # ru-RU-SvetlanaNeural (жен) | ru-RU-DmitryNeural (муж)
  [string]$EdgeVoice = 'ru-RU-SvetlanaNeural',

  [switch]$Cuda
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) {
  Write-Host 'venv missing — running install.ps1…' -ForegroundColor Yellow
  & (Join-Path $root 'install.ps1')
}

$env:WHISPER_MODEL = $WhisperModel
$env:TTS_ENGINE = $Tts
$env:EDGE_VOICE = $EdgeVoice
$env:VOICE_HOST = '127.0.0.1'
$env:VOICE_PORT = '8765'
if ($Cuda) {
  $env:WHISPER_DEVICE = 'cuda'
  $env:WHISPER_COMPUTE = 'float16'
} else {
  $env:WHISPER_DEVICE = 'cpu'
  $env:WHISPER_COMPUTE = 'int8'
}

Write-Host "Voice server | STT=faster-whisper:$WhisperModel | TTS=$Tts | voice=$EdgeVoice" -ForegroundColor Cyan
Set-Location $root
& $python server.py
