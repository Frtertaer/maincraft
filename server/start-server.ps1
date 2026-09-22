[CmdletBinding()]
param(
  [string]$JavaExe,

  [ValidatePattern('^[1-9]\d*[KMGkmg]$')]
  [string]$Xmx = '4G',

  [ValidatePattern('^[1-9]\d*[KMGkmg]$')]
  [string]$Xms = '2G',

  [switch]$AcceptEula
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commonPath = Join-Path $PSScriptRoot 'runtime-common.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) {
  throw "Runtime helper is missing: $commonPath"
}
. $commonPath

function ConvertTo-MemoryBytes {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Value
  )

  $match = [regex]::Match($Value, '^(?<number>[1-9]\d*)(?<unit>[KMG])$', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if (-not $match.Success) {
    throw "Invalid JVM memory value: $Value"
  }

  $number = [int64]$match.Groups['number'].Value
  switch ($match.Groups['unit'].Value.ToUpperInvariant()) {
    'K' { return $number * 1KB }
    'M' { return $number * 1MB }
    'G' { return $number * 1GB }
    default { throw "Invalid JVM memory unit in: $Value" }
  }
}

function Get-ServerPropertyValue {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  foreach ($line in [System.IO.File]::ReadAllLines([System.IO.Path]::GetFullPath($Path))) {
    $match = [regex]::Match($line, '^\s*([^#!\s][^=:]*)\s*[=:]\s*(.*)$')
    if ($match.Success -and $match.Groups[1].Value.Trim() -eq $Name) {
      return $match.Groups[2].Value.Trim()
    }
  }
  return $null
}

$xmsBytes = ConvertTo-MemoryBytes -Value $Xms
$xmxBytes = ConvertTo-MemoryBytes -Value $Xmx
if ($xmsBytes -gt $xmxBytes) {
  throw "Xms ($Xms) cannot be greater than Xmx ($Xmx)."
}

$jarPath = Join-Path $PSScriptRoot 'paper.jar'
if (-not (Test-Path -LiteralPath $jarPath -PathType Leaf)) {
  throw 'paper.jar is missing. Run .\setup-server.ps1 first.'
}
if ((Get-Item -LiteralPath $jarPath).Length -le 0) {
  throw "paper.jar is empty: $jarPath"
}

$propertiesPath = Join-Path $PSScriptRoot 'server.properties'
if (-not (Test-Path -LiteralPath $propertiesPath -PathType Leaf)) {
  throw 'server.properties is missing. Run .\setup-server.ps1 first.'
}
$serverIp = Get-ServerPropertyValue -Path $propertiesPath -Name 'server-ip'
if ($serverIp -ne '127.0.0.1') {
  throw "Refusing to start an offline-mode server not bound to localhost. Expected server-ip=127.0.0.1, got '$serverIp'."
}

$eulaPath = Join-Path $PSScriptRoot 'eula.txt'
if ($AcceptEula) {
  Set-MaincraftEulaAccepted -Path $eulaPath
  Write-Host 'Minecraft EULA accepted explicitly via -AcceptEula.' -ForegroundColor Green
}
if (-not (Test-MaincraftEulaAccepted -Path $eulaPath)) {
  throw 'Minecraft EULA is not accepted. Review https://aka.ms/MinecraftEULA, then rerun with -AcceptEula.'
}

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$javaInfo = Resolve-MaincraftJava21 -JavaExe $JavaExe -ProjectRoot $projectRoot

Push-Location $PSScriptRoot
try {
  Write-Host "Starting Paper on 127.0.0.1 | Java $($javaInfo.Version) | -Xms$Xms -Xmx$Xmx" -ForegroundColor Cyan
  & $javaInfo.Path "-Xms$Xms" "-Xmx$Xmx" '-XX:+UseG1GC' '-jar' $jarPath '--nogui'
  if ($LASTEXITCODE -ne 0) {
    throw "Paper exited with code $LASTEXITCODE."
  }
} finally {
  Pop-Location
}
