# PacketLens Tauri

Windows-only PacketLens desktop app built with Tauri + React.

## Development

```bash
npm install
npm run tauri:dev
```

## Fully Self-Contained Builds

This project is configured to be self-contained on Windows:
- **WebView2**: Bundles use `offlineInstaller` mode to embed the runtime.
- **Sidecar**: The mitmproxy sidecar is bundled as a standalone binary.

Build steps:

```bash
npm run sidecar:build
npm run tauri:build
```

## Portable Folder Builds (Windows)

To generate both portable variants (full + slim):

```bash
npm run tauri:portable
```

Output:

- `dist-portable/PacketLensPortable-Full/` (includes `WebView2Runtime/`, larger)
- `dist-portable/PacketLensPortable-Slim/` (no bundled runtime, smaller)

You can build variants separately:

```bash
npm run tauri:portable:full
npm run tauri:portable:slim
```

The **full** portable launcher forces bundled runtime and does not depend on WebView2 installed on the user PC.
The **slim** portable launcher relies on WebView2 installed on the target PC.

To source the full runtime from a custom location during packaging, set:

- `WEBVIEW2_FIXED_RUNTIME_PATH=<path-to-fixed-runtime-folder>`

The sidecar build uses PyInstaller and requires Python. See `sidecar/requirements.txt`.

## Notes

- The sidecar binary is bundled from `sidecar/dist/packetlens-sidecar.exe`.
- This repository is packaged and supported for Windows only.
