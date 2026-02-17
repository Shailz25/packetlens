param(
  [string]$Repo = "Shailz25/packetlens",
  [string]$VersionDate = (Get-Date -Format "yyyy.MM.dd"),
  [string]$MsiDir = "src-tauri/target/release/bundle/msi",
  [string]$PortableSlimDir = "dist-portable/PacketLensPortable-Slim",
  [switch]$Build
)

$ErrorActionPreference = "Stop"

function Require-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command '$Name' is not available in PATH."
  }
}

Require-Command git
Require-Command npm

$ghCmd = Get-Command gh -ErrorAction SilentlyContinue
if (-not $ghCmd) {
  $ghFallback = "C:\Program Files\GitHub CLI\gh.exe"
  if (Test-Path $ghFallback) {
    $ghCmd = @{ Source = $ghFallback }
  } else {
    throw "GitHub CLI (gh) is required. Install it first."
  }
}

function Invoke-Gh {
  param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
  )
  & $ghCmd.Source @Arguments
}

if ($Build) {
  Write-Host "Building release artifacts (MSI + portable slim)..."
  npm run tauri:build
  npm run tauri:portable:slim
}

Invoke-Gh auth status | Out-Null

$tag = "v$VersionDate"
$releaseTitle = "PacketLens $tag"

if (-not (Test-Path $MsiDir)) {
  throw "MSI directory not found: $MsiDir"
}

$msiFile = Get-ChildItem -Path $MsiDir -Filter "*.msi" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $msiFile) {
  throw "No MSI file found in: $MsiDir"
}

if (-not (Test-Path $PortableSlimDir)) {
  throw "Portable slim directory not found: $PortableSlimDir"
}

$releaseAssetsDir = "release-assets"
if (-not (Test-Path $releaseAssetsDir)) {
  New-Item -ItemType Directory -Path $releaseAssetsDir | Out-Null
}

$portableZip = Join-Path $releaseAssetsDir "PacketLensPortable-Slim-$tag.zip"
$msiReleaseFile = Join-Path $releaseAssetsDir "PacketLens-Installer-$tag.msi"
$portableZipLatest = Join-Path $releaseAssetsDir "PacketLensPortable-Slim-latest.zip"
$msiReleaseFileLatest = Join-Path $releaseAssetsDir "PacketLens-Installer-latest.msi"

if (Test-Path $portableZip) {
  Remove-Item $portableZip -Force
}
if (Test-Path $portableZipLatest) {
  Remove-Item $portableZipLatest -Force
}

Write-Host "Packaging portable ZIP: $portableZip"
Compress-Archive -Path "$PortableSlimDir/*" -DestinationPath $portableZip -Force
Copy-Item $portableZip $portableZipLatest -Force

Write-Host "Preparing installer asset: $msiReleaseFile"
Copy-Item $msiFile.FullName $msiReleaseFile -Force
Copy-Item $msiReleaseFile $msiReleaseFileLatest -Force

$notes = @"
Release version format: vYYYY.MM.DD

Assets:
- Installer (MSI)
- Portable package (ZIP)

Use MSI for standard install, or extract ZIP and run portable mode.
"@

$releaseExists = $true
try {
  Invoke-Gh release view $tag --repo $Repo | Out-Null
} catch {
  $releaseExists = $false
}

if ($releaseExists) {
  Write-Host "Release $tag exists. Uploading/replacing assets..."
  Invoke-Gh release upload $tag $msiReleaseFile $portableZip $msiReleaseFileLatest $portableZipLatest --repo $Repo --clobber
} else {
  Write-Host "Creating release $tag..."
  Invoke-Gh release create $tag $msiReleaseFile $portableZip $msiReleaseFileLatest $portableZipLatest --repo $Repo --title $releaseTitle --notes $notes
}

Write-Host ""
Write-Host "Release published: https://github.com/$Repo/releases/tag/$tag"
