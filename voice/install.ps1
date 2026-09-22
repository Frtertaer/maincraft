[CmdletBinding()]
param(
  [switch]$WithTorch  # Silero offline TTS
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$venv = Join-Path $root '.venv'
$py = Get-Command python.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $py) { throw 'python.exe not found. Install Python 3.12+.' }

Write-Host "Creating venv at $venv" -ForegroundColor Cyan
& $py.Source -m venv $venv
$pip = Join-Path $venv 'Scripts\pip.exe'
$python = Join-Path $venv 'Scripts\python.exe'

& $python -m pip install --upgrade pip
& $pip install -r (Join-Path $root 'requirements.txt')

if ($WithTorch) {
  Write-Host 'Installing torch CPU for Silero…' -ForegroundColor Yellow
  & $pip install torch --index-url https://download.pytorch.org/whl/cpu
}

Write-Host @'

DONE. Start:
  cd D:\maincraft\voice
  .\.venv\Scripts\Activate.ps1
  python server.py

Or:
  .\start-voice.ps1

Test:
  curl http://127.0.0.1:8765/health
'@ -ForegroundColor Green
