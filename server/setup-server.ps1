[CmdletBinding()]
param(
  [ValidatePattern('^\d+\.\d+(\.\d+)?$')]
  [string]$Version = '1.21.1',

  [string]$Dir = $PSScriptRoot,

  [string]$JavaExe,

  [switch]$AcceptEula,

  [string]$PaperUserAgent = 'maincraft-local/1.0 (local Windows Paper setup)'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$commonPath = Join-Path $PSScriptRoot 'runtime-common.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) {
  throw "Runtime helper is missing: $commonPath"
}
. $commonPath

function Set-ServerProperties {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [hashtable]$Values
  )

  $lines = if (Test-Path -LiteralPath $Path -PathType Leaf) {
    [System.IO.File]::ReadAllLines([System.IO.Path]::GetFullPath($Path))
  } else {
    @()
  }

  $seen = @{}
  $result = New-Object 'System.Collections.Generic.List[string]'
  foreach ($line in $lines) {
    $match = [regex]::Match($line, '^\s*([^#!\s][^=:]*)\s*[=:]')
    if ($match.Success) {
      $key = $match.Groups[1].Value.Trim()
      if ($Values.ContainsKey($key)) {
        if (-not $seen.ContainsKey($key)) {
          [void]$result.Add("$key=$($Values[$key])")
          $seen[$key] = $true
        }
        continue
      }
    }
    [void]$result.Add($line)
  }

  foreach ($key in @($Values.Keys | Sort-Object)) {
    if (-not $seen.ContainsKey($key)) {
      [void]$result.Add("$key=$($Values[$key])")
    }
  }

  $content = ($result -join [Environment]::NewLine).TrimEnd() + [Environment]::NewLine
  Write-MaincraftTextFileAtomic -Path $Path -Content $content
}

if ([string]::IsNullOrWhiteSpace($PaperUserAgent) -or $PaperUserAgent -match '[\r\n]') {
  throw 'PaperUserAgent must be a non-empty single-line identifying User-Agent.'
}

$serverDir = [System.IO.Path]::GetFullPath($Dir)
if (-not (Test-Path -LiteralPath $serverDir -PathType Container)) {
  New-Item -ItemType Directory -Path $serverDir | Out-Null
}

$projectRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$javaInfo = Resolve-MaincraftJava21 -JavaExe $JavaExe -ProjectRoot $projectRoot
$resolvedJava = $javaInfo.Path

Push-Location $serverDir
try {
  Write-Host "Paper setup | Minecraft $Version | Java $($javaInfo.Version)" -ForegroundColor Cyan
  Write-Host "Java: $resolvedJava"

  $headers = @{ 'User-Agent' = $PaperUserAgent }
  $escapedVersion = [uri]::EscapeDataString($Version)
  $buildsApi = "https://fill.papermc.io/v3/projects/paper/versions/$escapedVersion/builds"

  try {
    $buildResponse = Invoke-RestMethod -Uri $buildsApi -Headers $headers -TimeoutSec 30
    $builds = @($buildResponse)
  } catch {
    throw "Failed to query Paper stable builds for Minecraft $Version at '$buildsApi': $($_.Exception.Message)"
  }

  $build = $builds |
    Where-Object { $_.channel -eq 'STABLE' } |
    Sort-Object { [int]$_.id } -Descending |
    Select-Object -First 1
  if ($null -eq $build) {
    throw "Paper has no STABLE build for Minecraft $Version."
  }

  $assetProperty = $build.downloads.PSObject.Properties['server:default']
  if ($null -eq $assetProperty) {
    throw "Paper build $($build.id) has no server:default download."
  }
  $asset = $assetProperty.Value
  $downloadUri = [uri]$asset.url
  $expectedHash = ([string]$asset.checksums.sha256).ToLowerInvariant()
  $expectedSize = [int64]$asset.size
  if ($downloadUri.Scheme -ne 'https') {
    throw "Refusing non-HTTPS Paper download URL: $downloadUri"
  }
  if ($expectedHash -notmatch '^[a-f0-9]{64}$') {
    throw "Paper build $($build.id) returned an invalid SHA-256 checksum."
  }
  if ($expectedSize -le 0) {
    throw "Paper build $($build.id) returned an invalid file size."
  }

  $jarPath = Join-Path $serverDir 'paper.jar'
  $needDownload = $true
  if (Test-Path -LiteralPath $jarPath -PathType Leaf) {
    $installedHash = (Get-FileHash -LiteralPath $jarPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installedHash -eq $expectedHash) {
      $needDownload = $false
      Write-Host "Paper build $($build.id) is already installed and verified." -ForegroundColor Green
    }
  }

  if ($needDownload) {
    $tempJar = Join-Path $serverDir ('.paper.' + [guid]::NewGuid().ToString('N') + '.download')
    try {
      Write-Host "Downloading Paper $Version build $($build.id)..." -ForegroundColor Cyan
      Invoke-WebRequest -Uri $downloadUri -Headers $headers -OutFile $tempJar -UseBasicParsing -TimeoutSec 600

      $downloaded = Get-Item -LiteralPath $tempJar
      if ($downloaded.Length -ne $expectedSize) {
        throw "Paper download size mismatch: got $($downloaded.Length), expected $expectedSize."
      }

      $actualHash = (Get-FileHash -LiteralPath $tempJar -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualHash -ne $expectedHash) {
        throw "Paper SHA-256 mismatch: got $actualHash, expected $expectedHash."
      }

      Move-MaincraftFileAtomic -Source $tempJar -Destination $jarPath
    } finally {
      if (Test-Path -LiteralPath $tempJar -PathType Leaf) {
        Remove-Item -LiteralPath $tempJar -Force
      }
    }
    Write-Host "Installed and verified: $jarPath" -ForegroundColor Green
  }

  Write-Host 'Creating Paper settings without generating a world...' -ForegroundColor Cyan
  & $resolvedJava '-Xms1G' '-Xmx2G' '-jar' $jarPath '--initSettings' '--nogui'
  if ($LASTEXITCODE -ne 0) {
    throw "Paper --initSettings failed with exit code $LASTEXITCODE."
  }

  $propertiesPath = Join-Path $serverDir 'server.properties'
  $propertyValues = @{
    'difficulty' = 'normal'
    'enforce-secure-profile' = 'false'
    'gamemode' = 'survival'
    'max-players' = '10'
    'motd' = 'Opus 5 Lab'
    'online-mode' = 'false'
    'server-ip' = '127.0.0.1'
    'simulation-distance' = '6'
    'view-distance' = '8'
    'white-list' = 'false'
  }
  Set-ServerProperties -Path $propertiesPath -Values $propertyValues
  Write-Host 'server.properties is restricted to 127.0.0.1 and configured for the offline bot.' -ForegroundColor Green

  $eulaPath = Join-Path $serverDir 'eula.txt'
  if ($AcceptEula) {
    Set-MaincraftEulaAccepted -Path $eulaPath
    Write-Host 'Minecraft EULA accepted explicitly via -AcceptEula.' -ForegroundColor Green
  } elseif (Test-MaincraftEulaAccepted -Path $eulaPath) {
    Write-Host 'Minecraft EULA was already accepted in eula.txt.' -ForegroundColor Green
  } else {
    if (-not (Test-Path -LiteralPath $eulaPath -PathType Leaf)) {
      $pendingEula = '# Review https://aka.ms/MinecraftEULA before accepting.' + [Environment]::NewLine +
        'eula=false' + [Environment]::NewLine
      Write-MaincraftTextFileAtomic -Path $eulaPath -Content $pendingEula
    }
    Write-Warning 'EULA is not accepted. Review https://aka.ms/MinecraftEULA, then run .\start-server.ps1 -AcceptEula.'
  }

  $opsNote = '# After joining, run this in the server console:' + [Environment]::NewLine +
    '# op YourNick' + [Environment]::NewLine
  Write-MaincraftTextFileAtomic -Path (Join-Path $serverDir 'README-OPS.txt') -Content $opsNote

  Write-Host 'Setup complete.' -ForegroundColor Green
  if (Test-MaincraftEulaAccepted -Path $eulaPath) {
    Write-Host 'Start: .\start-server.ps1' -ForegroundColor Cyan
  } else {
    Write-Host 'Start after review: .\start-server.ps1 -AcceptEula' -ForegroundColor Yellow
  }
  Write-Host 'Join locally: 127.0.0.1' -ForegroundColor Cyan
} finally {
  Pop-Location
}
