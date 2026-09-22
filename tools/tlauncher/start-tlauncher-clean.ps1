<#
.SYNOPSIS
  Clean TLauncher start — JAR only, no Windows installer adware.

  IMPORTANT: must use javaw.exe (GUI). Using java.exe only runs a headless
  "starter" bootstrap that often never shows a window for the user.
#>
[CmdletBinding()]
param(
  [switch]$Wait  # keep console open while TL runs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($root)) {
  $root = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($root)) {
  $root = 'D:\maincraft\tools\tlauncher'
}
$jar = Join-Path $root 'clean\TLauncher.jar'
if (-not (Test-Path -LiteralPath $jar)) {
  # try extract from wrapper zip once
  $wrapper = Join-Path $root 'TLauncher.jar'
  $cleanDir = Join-Path $root 'clean'
  if (Test-Path -LiteralPath $wrapper) {
    New-Item -ItemType Directory -Path $cleanDir -Force | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($wrapper, $cleanDir)
  }
}
if (-not (Test-Path -LiteralPath $jar)) {
  throw "Clean jar missing: $jar"
}

function Find-MaincraftJava {
  $candidates = New-Object System.Collections.Generic.List[string]
  [void]$candidates.Add('D:\maincraft\.runtime\microsoft-jdk-21\jdk-21.0.12+8\bin\javaw.exe')
  [void]$candidates.Add('D:\maincraft\.runtime\microsoft-jdk-21\jdk-21.0.12+8\bin\java.exe')
  if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
    [void]$candidates.Add((Join-Path $env:JAVA_HOME 'bin\javaw.exe'))
    [void]$candidates.Add((Join-Path $env:JAVA_HOME 'bin\java.exe'))
  }
  # portable JDKs under project .runtime
  $runtime = 'D:\maincraft\.runtime'
  if (Test-Path -LiteralPath $runtime) {
    Get-ChildItem -LiteralPath $runtime -Recurse -Filter 'javaw.exe' -ErrorAction SilentlyContinue |
      Select-Object -First 5 |
      ForEach-Object { [void]$candidates.Add($_.FullName) }
  }
  foreach ($c in $candidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  $cmd = Get-Command javaw -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $cmd = Get-Command java -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

$java = Find-MaincraftJava
if (-not $java) {
  throw 'Java not found. Need JDK with javaw.exe (project .runtime or PATH).'
}

# Prefer javaw even if we found java.exe in same folder
$javaw = $java -replace '[/\\]java\.exe$', '\javaw.exe'
if ($java -match 'java\.exe$' -and (Test-Path -LiteralPath $javaw)) {
  $java = $javaw
}

$work = Join-Path $env:USERPROFILE '.maincraft-tlauncher-clean'
New-Item -ItemType Directory -Path $work -Force | Out-Null

Write-Host '=== CLEAN TLauncher ===' -ForegroundColor Green
Write-Host "Java: $java"
Write-Host "Jar:  $jar"
Write-Host "Work: $work"
Write-Host ''
Write-Host 'Server: 127.0.0.1:25565 | Version: 1.21.1' -ForegroundColor Cyan
Write-Host 'Nick must match: start-bot-companion.ps1 -PlayerName YourNick' -ForegroundColor Cyan
Write-Host 'Starting GUI...' -ForegroundColor Yellow

# Detached GUI process — do NOT use java.exe console bootstrap
$argList = @(
  '-Xms256M',
  '-Xmx1024M',
  '-Dfile.encoding=UTF-8',
  '-jar',
  $jar
)

$p = Start-Process -FilePath $java `
  -ArgumentList $argList `
  -WorkingDirectory $work `
  -PassThru `
  -WindowStyle Normal

Start-Sleep -Seconds 3
$alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
if (-not $alive) {
  Write-Host 'ERROR: process exited immediately.' -ForegroundColor Red
  Write-Host "Check log: $env:APPDATA\.tlauncher\logs\starter\" -ForegroundColor Red
  Write-Host 'Try: right-click this script -> Run with PowerShell' -ForegroundColor Yellow
  if (-not $Wait) { pause }
  exit 1
}

Write-Host ("OK - TLauncher PID {0}. Look for window titled TLauncher." -f $p.Id) -ForegroundColor Green
Write-Host 'If you still see nothing: Alt+Tab or check the taskbar.' -ForegroundColor Yellow

if ($Wait) {
  Write-Host 'Waiting until TLauncher exits...'
  Wait-Process -Id $p.Id
} else {
  # brief pause so double-click users can read the message
  Start-Sleep -Seconds 2
}
