[CmdletBinding()]
param(
  [ValidateSet('Auto', 'System', 'Portable')]
  [string]$Mode = 'Auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot)
$commonPath = Join-Path $projectRoot 'server\runtime-common.ps1'
if (-not (Test-Path -LiteralPath $commonPath -PathType Leaf)) {
  throw "Runtime helper is missing: $commonPath"
}
. $commonPath

function Get-ExistingJava21 {
  if (-not [string]::IsNullOrWhiteSpace($env:MAINCRAFT_JAVA)) {
    return Resolve-MaincraftJava21 -ProjectRoot $projectRoot
  }

  try {
    return Resolve-MaincraftJava21 -ProjectRoot $projectRoot
  } catch {
    return $null
  }
}

function Install-SystemJava21 {
  $winget = Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $winget) {
    throw "winget.exe is not available. Run this script with -Mode Portable."
  }

  Write-Host 'Installing Eclipse Temurin JDK 21 with winget...' -ForegroundColor Cyan
  $arguments = @(
    'install',
    '--id', 'EclipseAdoptium.Temurin.21.JDK',
    '-e',
    '--accept-package-agreements',
    '--accept-source-agreements'
  )
  $process = Start-Process -FilePath $winget.Source -ArgumentList $arguments -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) {
    throw "winget failed with exit code $($process.ExitCode). Run with -Mode Portable to avoid a system install."
  }

  return Resolve-MaincraftJava21 -ProjectRoot $projectRoot
}

function Install-PortableJava21 {
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'The portable Java installer currently supports 64-bit Windows only.'
  }

  $runtimeRoot = Join-Path $projectRoot '.runtime'
  $portableRoot = Join-Path $runtimeRoot 'java-21'
  $portableJava = Join-Path $portableRoot 'bin\java.exe'

  if (Test-Path -LiteralPath $portableRoot) {
    if (Test-Path -LiteralPath $portableJava -PathType Leaf) {
      return Resolve-MaincraftJava21 -JavaExe $portableJava -ProjectRoot $projectRoot
    }
    throw "Portable Java directory already exists but is incomplete: $portableRoot"
  }

  if (-not (Test-Path -LiteralPath $runtimeRoot -PathType Container)) {
    New-Item -ItemType Directory -Path $runtimeRoot | Out-Null
  }

  $runtimeRoot = [System.IO.Path]::GetFullPath($runtimeRoot)
  $downloadPath = Assert-MaincraftPathUnderRoot `
    -Path (Join-Path $runtimeRoot ('temurin21-' + [guid]::NewGuid().ToString('N') + '.zip')) `
    -Root $runtimeRoot
  $stagingPath = Assert-MaincraftPathUnderRoot `
    -Path (Join-Path $runtimeRoot ('temurin21-' + [guid]::NewGuid().ToString('N'))) `
    -Root $runtimeRoot

  $headers = @{
    'User-Agent' = 'maincraft-local-runtime/1.0 (https://api.adoptium.net)'
  }
  $assetApi = 'https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&heap_size=normal&image_type=jdk&jvm_impl=hotspot&os=windows&vendor=eclipse'

  try {
    Write-Host 'Querying Adoptium for the latest Temurin 21 portable JDK...' -ForegroundColor Cyan
    $assetResponse = Invoke-RestMethod -Uri $assetApi -Headers $headers -TimeoutSec 30
    $assets = @($assetResponse)
    $asset = $assets | Where-Object {
      $null -ne $_.binary -and
      $null -ne $_.binary.package -and
      -not [string]::IsNullOrWhiteSpace($_.binary.package.link) -and
      $_.binary.package.checksum -match '^[a-fA-F0-9]{64}$'
    } | Select-Object -First 1
    if ($null -eq $asset) {
      throw 'Adoptium returned no usable Windows x64 JDK 21 package.'
    }

    $package = $asset.binary.package
    $downloadUri = [uri]$package.link
    if ($downloadUri.Scheme -ne 'https') {
      throw "Refusing non-HTTPS Java download URL: $downloadUri"
    }

    Write-Host "Downloading $($package.name)..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $downloadUri -Headers $headers -OutFile $downloadPath -UseBasicParsing -TimeoutSec 600

    $downloadedFile = Get-Item -LiteralPath $downloadPath
    if ([int64]$package.size -gt 0 -and $downloadedFile.Length -ne [int64]$package.size) {
      throw "Java archive size mismatch: got $($downloadedFile.Length), expected $($package.size)."
    }

    $actualHash = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $expectedHash = ([string]$package.checksum).ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
      throw "Java archive SHA-256 mismatch: got $actualHash, expected $expectedHash."
    }

    New-Item -ItemType Directory -Path $stagingPath | Out-Null
    Expand-Archive -LiteralPath $downloadPath -DestinationPath $stagingPath

    $javaCandidates = @(Get-ChildItem -LiteralPath $stagingPath -Filter 'java.exe' -File -Recurse |
      Where-Object { $_.FullName -match '[\\/]bin[\\/]java\.exe$' } |
      Sort-Object { $_.FullName.Length })
    if ($javaCandidates.Count -eq 0) {
      throw 'The downloaded Java archive does not contain bin\java.exe.'
    }

    $stagedJava = $javaCandidates[0].FullName
    $stagedInfo = Get-MaincraftJavaInfo -JavaExe $stagedJava
    if ($stagedInfo.Major -ne 21) {
      throw "Downloaded archive contains Java $($stagedInfo.Version), not Java 21."
    }

    $jdkRoot = Split-Path -Parent (Split-Path -Parent $stagedJava)
    [void](Assert-MaincraftPathUnderRoot -Path $jdkRoot -Root $stagingPath)
    Move-Item -LiteralPath $jdkRoot -Destination $portableRoot

    return Resolve-MaincraftJava21 -JavaExe $portableJava -ProjectRoot $projectRoot
  } finally {
    if (Test-Path -LiteralPath $downloadPath -PathType Leaf) {
      Remove-Item -LiteralPath $downloadPath -Force
    }
    if (Test-Path -LiteralPath $stagingPath -PathType Container) {
      [void](Assert-MaincraftPathUnderRoot -Path $stagingPath -Root $runtimeRoot)
      Remove-Item -LiteralPath $stagingPath -Recurse -Force
    }
  }
}

$existing = $null
if ($Mode -ne 'Portable') {
  $existing = Get-ExistingJava21
}

if ($null -ne $existing) {
  Write-Host "Java 21 is already available: $($existing.Path)" -ForegroundColor Green
  Write-Host $existing.VersionText
  Write-Host 'Review the Minecraft EULA: https://aka.ms/MinecraftEULA' -ForegroundColor Yellow
  Write-Host 'Next: .\server\setup-server.ps1 -AcceptEula' -ForegroundColor Yellow
  exit 0
}

$selectedMode = $Mode
if ($selectedMode -eq 'Auto') {
  $winget = Get-Command -Name 'winget.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $selectedMode = if ($null -ne $winget) { 'System' } else { 'Portable' }
}

$javaInfo = if ($selectedMode -eq 'System') {
  Install-SystemJava21
} else {
  Install-PortableJava21
}

Write-Host "Java 21 ready: $($javaInfo.Path)" -ForegroundColor Green
Write-Host $javaInfo.VersionText
Write-Host 'Review the Minecraft EULA: https://aka.ms/MinecraftEULA' -ForegroundColor Yellow
Write-Host 'Next: .\server\setup-server.ps1 -AcceptEula' -ForegroundColor Yellow
