import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const sidecarDir = join(root, "sidecar");

const platformId = platform();
let cmd = null;
let args = [];

if (platformId === "win32") {
  cmd = "powershell";
  args = ["-ExecutionPolicy", "Bypass", "-File", join(sidecarDir, "build_sidecar.ps1")];
}

if (!cmd) {
  console.error(`Unsupported platform for sidecar build: ${platformId}`);
  process.exit(1);
}

const result = spawnSync(cmd, args, { stdio: "inherit" });
process.exit(result.status ?? 1);
