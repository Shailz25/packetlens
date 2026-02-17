param(
  [ValidateSet("full", "slim")]
  [string]$Variant = "full"
)
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $projectRoot

$releaseExe = Join-Path $projectRoot "src-tauri\target\release\app.exe"
$sidecarExe = Join-Path $projectRoot "sidecar\dist\packetlens-sidecar.exe"
$portableRoot = Join-Path $projectRoot "dist-portable"
$portableName = if ($Variant -eq "full") { "PacketLensPortable-Full" } else { "PacketLensPortable-Slim" }
$portableDir = Join-Path $portableRoot $portableName
$webviewRuntimeDir = Join-Path $portableDir "WebView2Runtime"

function Prepare-PortableDirectory {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RequestedPath
  )

  if (Test-Path $RequestedPath) {
    try {
      Remove-Item -Recurse -Force $RequestedPath
    } catch {
      $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $fallback = "$RequestedPath-$stamp"
      Write-Warning "Could not clean '$RequestedPath' (likely file lock). Using '$fallback' instead."
      $script:portableDir = $fallback
      $script:webviewRuntimeDir = Join-Path $script:portableDir "WebView2Runtime"
    }
  }

  New-Item -ItemType Directory -Path $script:portableDir -Force | Out-Null
}

function Resolve-WebView2RuntimeSource {
  $override = $env:WEBVIEW2_FIXED_RUNTIME_PATH
  if ($override -and (Test-Path $override)) {
    return $override
  }

  $base = "C:\Program Files (x86)\Microsoft\EdgeWebView\Application"
  if (-not (Test-Path $base)) {
    throw "Fixed WebView2 runtime source not found at '$base'. Install WebView2 runtime on build machine or set WEBVIEW2_FIXED_RUNTIME_PATH."
  }

  $candidates = Get-ChildItem -Path $base -Directory |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object {
      $parts = $_.Name.Split(".") | ForEach-Object { [int]$_ }
      [Version]::new($parts[0], $parts[1], $parts[2], $parts[3])
    } -Descending

  if (-not $candidates -or $candidates.Count -eq 0) {
    throw "No versioned WebView2 runtime folders found under '$base'."
  }

  return $candidates[0].FullName
}

if (-not (Test-Path $releaseExe)) {
  throw "Release executable not found at $releaseExe. Run tauri build first."
}
if (-not (Test-Path $sidecarExe)) {
  throw "Sidecar executable not found at $sidecarExe. Run sidecar build first."
}

Prepare-PortableDirectory -RequestedPath $portableDir

Copy-Item $releaseExe (Join-Path $portableDir "PacketLens.exe")
Copy-Item $sidecarExe (Join-Path $portableDir "packetlens-sidecar.exe")

if ($Variant -eq "full") {
  $webviewSource = Resolve-WebView2RuntimeSource
  New-Item -ItemType Directory -Path $webviewRuntimeDir | Out-Null
  Copy-Item -Path (Join-Path $webviewSource "*") -Destination $webviewRuntimeDir -Recurse -Force

  if (-not (Test-Path (Join-Path $webviewRuntimeDir "msedgewebview2.exe"))) {
    throw "Copied WebView2 runtime is invalid: msedgewebview2.exe not found in '$webviewRuntimeDir'."
  }
}

$howToUsePath = Join-Path (Split-Path -Parent $projectRoot) "HOW_TO_USE.txt"
if (Test-Path $howToUsePath) {
  Copy-Item $howToUsePath (Join-Path $portableDir "HOW_TO_USE.txt")
}

$launcherFull = @'
@echo off
setlocal
set "APP_DIR=%~dp0"
set "WEBVIEW2_USER_DATA_FOLDER=%APP_DIR%webview2-data"
if not exist "%APP_DIR%WebView2Runtime\msedgewebview2.exe" (
  echo Required local WebView2Runtime is missing from:
  echo   %APP_DIR%WebView2Runtime
  echo PacketLens portable cannot start without bundled runtime.
  pause
  exit /b 1
)
set "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER=%APP_DIR%WebView2Runtime"
start "" "%APP_DIR%PacketLens.exe"
endlocal
'@
$launcherSlim = @'
@echo off
setlocal
set "APP_DIR=%~dp0"
set "WEBVIEW2_USER_DATA_FOLDER=%APP_DIR%webview2-data"
start "" "%APP_DIR%PacketLens.exe"
endlocal
'@
Set-Content -Path (Join-Path $portableDir "Launch PacketLens.cmd") -Value ($(if ($Variant -eq "full") { $launcherFull } else { $launcherSlim })) -Encoding ASCII

$readmeFull = @'
PacketLens Portable (Windows only)
=================================

Contents:
- PacketLens.exe
- packetlens-sidecar.exe
- WebView2Runtime\ (bundled fixed runtime)
- Launch PacketLens.cmd
- HOW_TO_USE.txt

How to run:
1) Double-click "Launch PacketLens.cmd" (recommended), or run PacketLens.exe directly.
2) The launcher forces the bundled ".\WebView2Runtime\" so it does not rely on PC-installed WebView2.

Notes:
- Keep PacketLens.exe and packetlens-sidecar.exe in the same folder.
- This portable package is intended for Windows only.
'@
$readmeSlim = @'
PacketLens Portable Slim (Windows only)
======================================

Contents:
- PacketLens.exe
- packetlens-sidecar.exe
- Launch PacketLens.cmd
- HOW_TO_USE.txt

How to run:
1) Double-click "Launch PacketLens.cmd" (recommended), or run PacketLens.exe directly.
2) This slim package relies on WebView2 runtime on the target PC.

Notes:
- Keep PacketLens.exe and packetlens-sidecar.exe in the same folder.
- This portable package is intended for Windows only.
'@
Set-Content -Path (Join-Path $portableDir "README_PORTABLE.txt") -Value ($(if ($Variant -eq "full") { $readmeFull } else { $readmeSlim })) -Encoding ASCII

Write-Output "Portable package created at: $portableDir"
