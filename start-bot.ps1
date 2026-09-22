[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Keep Russian console goals intact when PowerShell launches Node on Windows.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom
if (Get-Command -Name 'chcp.com' -CommandType Application -ErrorAction SilentlyContinue) {
  & chcp.com 65001 | Out-Null
}

$agentDir = Join-Path $PSScriptRoot 'agent'
$packagePath = Join-Path $agentDir 'package.json'
$lockPath = Join-Path $agentDir 'package-lock.json'
if (-not (Test-Path -LiteralPath $packagePath -PathType Leaf)) {
  throw "package.json is missing: $packagePath"
}
if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
  throw "package-lock.json is required for reproducible installation: $lockPath"
}

$node = Get-Command -Name 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $node) {
  throw 'Node.js was not found. Install Node.js 22 or newer.'
}

$nodeVersionText = (& $node.Source '--version').Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersionText -notmatch '^v(?<major>\d+)\.') {
  throw "Could not determine Node.js version from '$($node.Source)'."
}
$nodeMajor = [int]$Matches['major']
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required by the locked Mineflayer dependencies; found $nodeVersionText."
}

$npm = Get-Command -Name 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
if ($null -eq $npm) {
  throw 'npm.cmd was not found next to the Node.js installation.'
}

Push-Location $agentDir
try {
  if (-not (Test-Path -LiteralPath (Join-Path $agentDir 'node_modules') -PathType Container)) {
    Write-Host 'Installing locked dependencies with npm ci...' -ForegroundColor Yellow
    & $npm.Source 'ci'
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed with exit code $LASTEXITCODE."
    }
  }

  Write-Host "Starting Minecraft agent with Node $nodeVersionText..." -ForegroundColor Cyan
  & $npm.Source 'start'
  if ($LASTEXITCODE -ne 0) {
    throw "Minecraft agent exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
