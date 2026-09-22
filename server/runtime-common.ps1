Set-StrictMode -Version Latest

function Invoke-MaincraftProcessCapture {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [string]$Arguments = ""
  )

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = $Arguments
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  try {
    if (-not $process.Start()) {
      throw "Failed to start process: $FilePath"
    }

    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    return [pscustomobject]@{
      ExitCode = $process.ExitCode
      StdOut = $stdout
      StdErr = $stderr
    }
  } finally {
    $process.Dispose()
  }
}

function Resolve-MaincraftExecutablePath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Candidate
  )

  $trimmed = $Candidate.Trim().Trim('"')
  if ([string]::IsNullOrWhiteSpace($trimmed)) {
    return $null
  }

  if (Test-Path -LiteralPath $trimmed -PathType Leaf) {
    return [System.IO.Path]::GetFullPath($trimmed)
  }

  $command = Get-Command -Name $trimmed -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -ne $command) {
    return $command.Source
  }

  return $null
}

function Get-MaincraftJavaInfo {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$JavaExe
  )

  $resolvedPath = Resolve-MaincraftExecutablePath -Candidate $JavaExe
  if ([string]::IsNullOrWhiteSpace($resolvedPath)) {
    throw "Java executable not found: $JavaExe"
  }

  $result = Invoke-MaincraftProcessCapture -FilePath $resolvedPath -Arguments "-version"
  $versionText = (($result.StdOut + [Environment]::NewLine + $result.StdErr).Trim())
  if ($result.ExitCode -ne 0) {
    throw "Java version check failed for '$resolvedPath' (exit $($result.ExitCode)): $versionText"
  }

  $match = [regex]::Match($versionText, 'version\s+"(?<version>[^"]+)"')
  if (-not $match.Success) {
    throw "Could not parse Java version from '$resolvedPath': $versionText"
  }

  $version = $match.Groups['version'].Value
  if ($version -match '^1\.(?<major>\d+)') {
    $major = [int]$Matches['major']
  } elseif ($version -match '^(?<major>\d+)') {
    $major = [int]$Matches['major']
  } else {
    throw "Could not parse Java major version '$version' from '$resolvedPath'."
  }

  return [pscustomobject]@{
    Path = $resolvedPath
    Major = $major
    Version = $version
    VersionText = $versionText
  }
}

function Resolve-MaincraftJava21 {
  [CmdletBinding()]
  param(
    [string]$JavaExe,

    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
  )

  $fullProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)

  if (-not [string]::IsNullOrWhiteSpace($JavaExe)) {
    $explicitInfo = Get-MaincraftJavaInfo -JavaExe $JavaExe
    if ($explicitInfo.Major -ne 21) {
      throw "Java 21 is required, but '$($explicitInfo.Path)' is Java $($explicitInfo.Version)."
    }
    return $explicitInfo
  }

  if (-not [string]::IsNullOrWhiteSpace($env:MAINCRAFT_JAVA)) {
    $environmentInfo = Get-MaincraftJavaInfo -JavaExe $env:MAINCRAFT_JAVA
    if ($environmentInfo.Major -ne 21) {
      throw "MAINCRAFT_JAVA points to Java $($environmentInfo.Version), but Java 21 is required."
    }
    return $environmentInfo
  }

  $candidates = New-Object 'System.Collections.Generic.List[string]'
  $portableExact = Join-Path $fullProjectRoot '.runtime\java-21\bin\java.exe'
  [void]$candidates.Add($portableExact)

  $runtimeDirectory = Join-Path $fullProjectRoot '.runtime'
  if (Test-Path -LiteralPath $runtimeDirectory -PathType Container) {
    $runtimeJavaFiles = @(Get-ChildItem -LiteralPath $runtimeDirectory -Filter 'java.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '[\\/]bin[\\/]java\.exe$' } |
      Sort-Object { $_.FullName.Length })
    foreach ($item in $runtimeJavaFiles) {
      [void]$candidates.Add($item.FullName)
    }
  }

  $patterns = @(
    (Join-Path $fullProjectRoot '.runtime\jdk-21*\bin\java.exe'),
    (Join-Path $fullProjectRoot 'runtime\java-21*\bin\java.exe'),
    (Join-Path $fullProjectRoot 'runtime\jdk-21*\bin\java.exe'),
    (Join-Path $fullProjectRoot 'java\bin\java.exe'),
    (Join-Path $fullProjectRoot 'jdk-21*\bin\java.exe')
  )

  foreach ($pattern in $patterns) {
    $matches = @(Get-Item -Path $pattern -ErrorAction SilentlyContinue)
    foreach ($item in $matches) {
      [void]$candidates.Add($item.FullName)
    }
  }

  if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
    [void]$candidates.Add((Join-Path $env:JAVA_HOME 'bin\java.exe'))
  }
  [void]$candidates.Add('java')

  $programFiles = [Environment]::GetFolderPath('ProgramFiles')
  if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
    $systemPatterns = @(
      (Join-Path $programFiles 'Eclipse Adoptium\jdk-21*\bin\java.exe'),
      (Join-Path $programFiles 'Microsoft\jdk-21*\bin\java.exe'),
      (Join-Path $programFiles 'Java\jdk-21*\bin\java.exe'),
      (Join-Path $programFiles 'Amazon Corretto\jdk21*\bin\java.exe'),
      (Join-Path $programFiles 'Zulu\zulu-21*\bin\java.exe'),
      (Join-Path $programFiles 'BellSoft\LibericaJDK-21*\bin\java.exe')
    )
    foreach ($pattern in $systemPatterns) {
      $matches = @(Get-Item -Path $pattern -ErrorAction SilentlyContinue)
      foreach ($item in $matches) {
        [void]$candidates.Add($item.FullName)
      }
    }
  }

  $seen = @{}
  $wrongVersions = New-Object 'System.Collections.Generic.List[string]'
  foreach ($candidate in $candidates) {
    $resolvedPath = Resolve-MaincraftExecutablePath -Candidate $candidate
    if ([string]::IsNullOrWhiteSpace($resolvedPath)) {
      continue
    }

    $key = $resolvedPath.ToLowerInvariant()
    if ($seen.ContainsKey($key)) {
      continue
    }
    $seen[$key] = $true

    try {
      $info = Get-MaincraftJavaInfo -JavaExe $resolvedPath
      if ($info.Major -eq 21) {
        return $info
      }
      [void]$wrongVersions.Add("$resolvedPath (Java $($info.Version))")
    } catch {
      [void]$wrongVersions.Add("$resolvedPath (unusable: $($_.Exception.Message))")
    }
  }

  $detail = if ($wrongVersions.Count -gt 0) {
    " Other Java installations found: " + ($wrongVersions -join '; ')
  } else {
    ""
  }
  throw "Java 21 was not found. Run install-java.ps1 or pass -JavaExe with a Java 21 executable.$detail"
}

function Assert-MaincraftPathUnderRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [string]$Root
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
  $prefix = $fullRoot + [System.IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing operation outside '$fullRoot': $fullPath"
  }

  return $fullPath
}

function Move-MaincraftFileAtomic {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Source,

    [Parameter(Mandatory = $true)]
    [string]$Destination
  )

  $sourcePath = [System.IO.Path]::GetFullPath($Source)
  $destinationPath = [System.IO.Path]::GetFullPath($Destination)
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Atomic move source does not exist: $sourcePath"
  }

  $sourceDirectory = [System.IO.Path]::GetDirectoryName($sourcePath)
  $destinationDirectory = [System.IO.Path]::GetDirectoryName($destinationPath)
  if (-not [string]::Equals($sourceDirectory, $destinationDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Atomic replacement requires source and destination in the same directory."
  }

  $backupPath = Join-Path $destinationDirectory ('.' + [System.IO.Path]::GetFileName($destinationPath) + '.' + [guid]::NewGuid().ToString('N') + '.backup')
  try {
    if (Test-Path -LiteralPath $destinationPath -PathType Leaf) {
      [System.IO.File]::Replace($sourcePath, $destinationPath, $backupPath, $true)
    } else {
      [System.IO.File]::Move($sourcePath, $destinationPath)
    }
  } finally {
    if (Test-Path -LiteralPath $sourcePath -PathType Leaf) {
      Remove-Item -LiteralPath $sourcePath -Force
    }
    if (Test-Path -LiteralPath $backupPath -PathType Leaf) {
      Remove-Item -LiteralPath $backupPath -Force
    }
  }
}

function Write-MaincraftTextFileAtomic {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,

    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Content
  )

  $destinationPath = [System.IO.Path]::GetFullPath($Path)
  $destinationDirectory = [System.IO.Path]::GetDirectoryName($destinationPath)
  if (-not (Test-Path -LiteralPath $destinationDirectory -PathType Container)) {
    throw "Destination directory does not exist: $destinationDirectory"
  }

  $tempPath = Join-Path $destinationDirectory ('.' + [System.IO.Path]::GetFileName($destinationPath) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($tempPath, $Content, $utf8NoBom)
  Move-MaincraftFileAtomic -Source $tempPath -Destination $destinationPath
}

function Test-MaincraftEulaAccepted {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $false
  }

  $content = [System.IO.File]::ReadAllText([System.IO.Path]::GetFullPath($Path))
  return [regex]::IsMatch($content, '(?im)^\s*eula\s*=\s*true\s*$')
}

function Set-MaincraftEulaAccepted {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
    $content = [System.IO.File]::ReadAllText($fullPath)
    if ([regex]::IsMatch($content, '(?im)^\s*eula\s*=\s*(true|false)\s*$')) {
      $content = [regex]::Replace($content, '(?im)^\s*eula\s*=\s*(true|false)\s*$', 'eula=true')
    } else {
      $content = $content.TrimEnd() + [Environment]::NewLine + 'eula=true' + [Environment]::NewLine
    }
  } else {
    $content = '# Accepted explicitly with -AcceptEula. See https://aka.ms/MinecraftEULA' + [Environment]::NewLine +
      'eula=true' + [Environment]::NewLine
  }

  Write-MaincraftTextFileAtomic -Path $fullPath -Content $content
}
