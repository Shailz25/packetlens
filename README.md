## PacketLens

PacketLens is a lightweight and portable debugging proxy designed for developers and testers.
It focuses on simplicity and isolation: instead of applying a proxy across your entire system, PacketLens attaches the proxy only to the browser session it opens.

This makes it easier to debug traffic in a controlled environment without interfering with other applications.

## Features
- Portable and lightweight.
- Session-isolated proxy browser flow.
- Leaves global proxy settings untouched.
- Focused on practical debugging workflows.

## Download and Install
Download from GitHub Releases and choose one of these assets:
- **Installer (MSI)**: `PacketLens_<version>_x64_en-US.msi`
- **Portable (ZIP)**: `PacketLensPortable-Slim-<version>.zip`

Release tags follow this version format:
- `vYYYY.MM.DD` (example: `v2026.02.17`)

## Getting Started
1. Download the latest release assets.
2. Install via MSI, or extract and run the portable package.
3. Launch PacketLens and start debugging in the dedicated browser session.

## Development
```bash
npm install
npm run tauri:dev
```

## Windows Build
This project is configured to be self-contained on Windows:
- **WebView2**: bundle mode can embed runtime.
- **Sidecar**: mitmproxy sidecar is bundled as a standalone binary.

Build:
```bash
npm run sidecar:build
npm run tauri:build
```

Portable builds:
```bash
npm run tauri:portable
```

Or separately:
```bash
npm run tauri:portable:full
npm run tauri:portable:slim
```

## Notes
- The sidecar binary is bundled from `sidecar/dist/packetlens-sidecar.exe`.
- This repository is currently packaged and supported for Windows.
- Sidecar build uses PyInstaller; dependencies are in `sidecar/requirements.txt`.

## Contributing
Contributions are welcome. Open issues or submit pull requests.

## License
This project is licensed under the MIT License.
