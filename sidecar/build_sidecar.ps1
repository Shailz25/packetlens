$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $root "dist"

if (-not (Test-Path $dist)) {
  New-Item -ItemType Directory -Path $dist | Out-Null
}

python -m pip install --upgrade pip | Out-Null
python -m pip install -r (Join-Path $root "requirements.txt") | Out-Null
python -m pip install pyinstaller | Out-Null

python -m PyInstaller --onefile --name packetlens-sidecar (Join-Path $root "proxy_service.py") --distpath $dist --workpath (Join-Path $root "build") --specpath $root | Out-Null
Write-Output "Sidecar built at $dist\\packetlens-sidecar.exe"
